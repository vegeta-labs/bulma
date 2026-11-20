import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './testdb.ts'

let t: TestDb
let lead: string
let n = 0

const code = () => {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'
  n++
  return `ZZZ${letters[Math.floor(n / 23 / 23) % 23]}${letters[Math.floor(n / 23) % 23]}${letters[n % 23]}`
}
const newDeal = async () => {
  const id = randomUUID()
  await t.app.query('INSERT INTO deal (id, lead_user, public_code) VALUES ($1, $2, $3)', [id, lead, code()])
  return id
}
const newVersion = async (deal: string) =>
  t.app.query(`INSERT INTO deal_version (deal_id, n, snapshot, sha256, kind) VALUES ($1, 1, '{"name":"Original"}', 'abc', 'submitted')`, [deal])

beforeAll(async () => {
  t = await createTestDb()
  lead = randomUUID()
  await t.app.query(`INSERT INTO user_account (id, email, name) VALUES ($1, 'lead@example.test', 'Lead')`, [lead])
})
afterAll(async () => t.drop())

describe('D2 schema', () => {
  it('TC-PUB-01 a stored snapshot cannot be changed or removed, even by the database owner', async () => {
    const deal = await newDeal()
    await newVersion(deal)
    for (const db of [t.app, t.owner]) {
      await expect(db.query(`UPDATE deal_version SET snapshot = '{"name":"Changed"}' WHERE deal_id = $1`, [deal])).rejects.toThrow()
      await expect(db.query('DELETE FROM deal_version WHERE deal_id = $1', [deal])).rejects.toThrow()
    }
    const r = await t.app.query<{ snapshot: { name: string } }>('SELECT snapshot FROM deal_version WHERE deal_id = $1', [deal])
    expect(r.rows[0]!.snapshot.name).toBe('Original')
  })

  it('TC-PUB-02 a stored contact or carry recipient version cannot be changed by the application', async () => {
    const id = randomUUID()
    await t.app.query(`INSERT INTO person_version (id, fields) VALUES ($1, '{"email":"old@example.test"}')`, [id])
    await expect(t.app.query(`UPDATE person_version SET fields = '{}' WHERE id = $1`, [id])).rejects.toThrow()
    await expect(t.app.query('DELETE FROM person_version WHERE id = $1', [id])).rejects.toThrow()
  })

  it('TC-REV-01 review history cannot be rewritten', async () => {
    const deal = await newDeal()
    await t.app.query(
      `INSERT INTO review_event (id, deal_id, from_state, to_state, event, internal_note) VALUES ($1, $2, 'in_review', 'approved', 'approve', 'note')`,
      [randomUUID(), deal],
    )
    await expect(t.app.query(`UPDATE review_event SET internal_note = 'x' WHERE deal_id = $1`, [deal])).rejects.toThrow()
    await expect(t.app.query('DELETE FROM review_event WHERE deal_id = $1', [deal])).rejects.toThrow()
  })

  it('TC-SYN-01 a deal outside draft must have its syndicate; a draft has none', async () => {
    const deal = await newDeal()
    const row = await t.app.query<{ syndicate_id: string | null }>('SELECT syndicate_id FROM deal WHERE id = $1', [deal])
    expect(row.rows[0]!.syndicate_id).toBeNull()
    await expect(t.app.query(`UPDATE deal SET state = 'in_review' WHERE id = $1`, [deal])).rejects.toThrow(/submitted_has_syndicate/)
  })

  it('TC-DEAL-01 the database refuses a live deal with no pack, and a state outside the list', async () => {
    const deal = await newDeal()
    // everything else a live deal needs is there, so this can fail only for the pack; references are switched off for this one transaction
    const c = await t.owner.connect()
    try {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await expect(
        c.query(
          `UPDATE deal SET state = 'live', syndicate_id = $2, fee_config_id = $3, approved_at = now(), approved_version = 1, went_live_at = now() WHERE id = $1`,
          [deal, randomUUID(), randomUUID()],
        ),
      ).rejects.toThrow(/live_is_bound/)
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
    await expect(t.app.query(`UPDATE deal SET state = 'nonsense' WHERE id = $1`, [deal])).rejects.toThrow()
  })

  it('TC-SYN-03 the application can only revoke a link and only mark a company as checked', async () => {
    for (const sql of [
      "UPDATE member_invite SET role = 'admin'",
      "UPDATE member_invite SET token_hmac = 'x'",
      "UPDATE investee_link SET token_hmac = 'x'",
      'UPDATE investee_link SET expires_at = now()',
      "UPDATE investee_company SET legal_name = 'x'",
      'UPDATE carry_recipient SET share_bps = 1',
      'UPDATE deal SET lead_user = id',
      "UPDATE deal SET public_code = 'ZZZZZZ'",
      'UPDATE investee SET deal_id = id',
      'UPDATE syndicate SET created_by = id',
      'UPDATE syndicate_member SET user_id = user_id',
      'UPDATE deal_member SET deal_id = deal_id',
    ])
      await expect(t.app.query(sql), sql).rejects.toThrow(/permission denied/)
    await expect(t.app.query('UPDATE member_invite SET revoked_at = now() WHERE false')).resolves.toBeDefined()
    await expect(t.app.query('UPDATE investee_link SET revoked_at = now() WHERE false')).resolves.toBeDefined()
    await expect(t.app.query('UPDATE investee_company SET verified_at = now() WHERE false')).resolves.toBeDefined()
  })

  it.each([['AB-7K2'], ['abcdef'], ['ABCDE0'], ['ABCDEI'], ['ABCDE']])('TC-DRF-01 a public code of %s is refused', async (bad) => {
    await expect(t.app.query('INSERT INTO deal (id, lead_user, public_code) VALUES ($1, $2, $3)', [randomUUID(), lead, bad])).rejects.toThrow()
  })

  it('TC-DEAL-01 operator settings start from the documented defaults', async () => {
    const r = await t.app.query<{
      launch_confirm_days: number
      min_commitment_floor_minor: string
      content_approval_in_sandbox: boolean
      embed_hosts: string[]
    }>('SELECT * FROM deal_config')
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ launch_confirm_days: 30, min_commitment_floor_minor: '100000', content_approval_in_sandbox: false, embed_hosts: [] })
  })

  it('TC-DRF-03 the application cannot rewrite a folder, and a deal file must say who uploaded it', async () => {
    const deal = await newDeal()
    const folder = randomUUID()
    await t.app.query("INSERT INTO doc_folder (id, deal_id, name) VALUES ($1, $2, 'F')", [folder, deal])
    await expect(t.app.query("UPDATE doc_folder SET name = 'G' WHERE id = $1", [folder])).rejects.toThrow()
    await expect(
      t.app.query(
        "INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key) VALUES ($1, 'deal_shared', $2, 'legal', 'a', 'x', 'x', 1, 'clean', 'k', 'k1', '\\x00')",
        [randomUUID(), deal],
      ),
    ).rejects.toThrow(/stored_file_has_uploader/)
  })

  it('TC-PUB-01 a deal cannot point at an approved version that does not exist', async () => {
    const deal = await newDeal()
    await expect(t.app.query('UPDATE deal SET approved_version = 99 WHERE id = $1', [deal])).rejects.toThrow(/deal_approved_version_exists/)
  })
})
