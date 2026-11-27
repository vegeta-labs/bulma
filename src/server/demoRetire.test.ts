// R-DEMO-06 (plan 05 §4.5): approving the switch to the real mode retires the demo deal in the same transaction. Its own
// database and a server with a payment details file, so the switch goes through the real request and approval routes.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RegimePack } from '../lib/regimePack.ts'
import { codeAt, stepOf } from '../lib/totp.ts'
import { verifyAudit } from '../store/audit.ts'
import { tx } from '../store/db.ts'
import { readBuiltInPacks } from '../store/packs.ts'
import { createTestDb, type TestDb } from '../store/testdb.ts'
import { buildServer } from './app.ts'
import { createUser, grantRole } from './auth.ts'
import { DEMO_RUN_LOCK } from './demo.ts'
import { seedDemo } from './demoSeed.ts'
import { RETIRED_DEMO_ACCOUNT } from './requests.ts'

const PAYMENT = [
  {
    currency: 'GBP',
    account_fields: { sort_code: '11-22-33', account_number: '12345678' },
    holder: 'Example Client Money Ltd',
    holder_capacity: 'Regulated client money provider',
    holder_frn: '123456',
    asserted_client_money: true,
    your_money_text_key: 'your_money',
    refund_days: 10,
    receipt_check_note: 'Checked on the statement.',
  },
]
const PW = 'a-long-enough-password'
const SECRET = Buffer.alloc(20, 9)
/** Words only the demo's records carry: none may reach a staff screen once it is retired. */
const DEMO_WORDS = ['Senzu', 'Capsule Angels', 'Kame House', 'Dragon Radar', 'Korin', '.demo.invalid']

let t: TestDb
/** Mail the real mode would send: a reset for a retired account must not be among it. */
const sent: string[] = []
let app: Awaited<ReturnType<typeof buildServer>>
let ip = 0
type Headers = Record<string, string>
const send = (method: string, url: string, headers: Headers = {}, payload?: object) =>
  app.inject({ method: method as 'GET', url, headers, remoteAddress: `127.0.66.${++ip % 250}`, ...(payload ? { payload } : {}) })
const one = async <T>(sql: string, args: unknown[] = []) => (await t.owner.query(sql, args)).rows[0] as T
const ids = async (sql: string, args: unknown[] = []) => (await t.owner.query<{ id: string }>(sql, args)).rows.map((r) => r.id)

async function staff(email: string, roles: Array<'admin' | 'reviewer' | 'approver'>): Promise<{ id: string; h: Headers }> {
  const id = await tx(t.app, async (c) => {
    const u = await createUser(c, t.keyring, { email, name: email.split('@')[0]!, password: PW, by: null })
    for (const r of roles) await grantRole(c, t.keyring, u, r, null)
    return u
  })
  const e = t.keyring.encrypt(SECRET)
  await t.owner.query(
    'UPDATE user_account SET must_change_password = false, mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1',
    [id, e.ciphertext, e.keyId, e.wrappedDek],
  )
  return { id, h: await signedIn(email, PW, true) }
}

async function signedIn(email: string, password: string, mfa = false): Promise<Headers> {
  const r = await send('POST', '/api/login', {}, { email, password, ...(mfa ? { code: codeAt(SECRET, stepOf(Date.now())) } : {}) })
  expect(r.statusCode).toBe(200)
  return { cookie: `bulma_session=${r.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': (r.json() as { csrf: string }).csrf }
}

/** The shipped pack with its placeholders replaced, as an operator would before the real mode. */
function finalPack(): RegimePack {
  const p = readBuiltInPacks().find((x) => x.key === 'uk-fpo-template')!
  return {
    ...p,
    key: 'operator-final',
    legal_texts: p.legal_texts.map((x) => ({
      ...x,
      is_placeholder: false,
      body: x.body
        .replace(/\*\*PLACEHOLDER\*\*.*/s, '**PLACEHOLDER** kept word, operator text.')
        .replace(/^.*not legal text.*$/is, `Operator wording for ${x.text_key}.`),
    })),
    assessment: {
      ...p.assessment,
      questions: p.assessment.questions.map((q) => ({
        ...q,
        is_placeholder: false,
        prompt: `Operator question ${q.id}?`,
        options: ['Option one', 'Option two', 'Option three'],
      })),
    },
  }
}

beforeAll(async () => {
  t = await createTestDb()
  const dir = mkdtempSync(join(tmpdir(), 'bulma-demo-pay-'))
  writeFileSync(join(dir, 'payment.json'), JSON.stringify(PAYMENT))
  app = await buildServer({
    db: t.app,
    k: t.keyring,
    paymentFile: join(dir, 'payment.json'),
    secureCookies: false,
    real: { mailer: { send: async (m) => (sent.push(m.to), { delivered: true }) } },
  })
}, 60_000)
afterAll(async () => {
  await app?.close()
  await t?.drop()
})

describe('the demo deal at the switch to the real mode (R-DEMO-06)', () => {
  it('TC-DEMO-06 approving the switch retires the demo: no sign-in, no session, no reset; deals, files and tokens gone from every route; rows and the audit chain kept', async () => {
    const first = await staff('first.admin@example.test', ['admin'])
    const second = await staff('second.admin@example.test', ['admin', 'approver'])
    const reviewer = await staff('ordinary.reviewer@example.test', ['reviewer'])
    const s = await seedDemo(app, t.app, t.keyring, { by: first.id, via: 'button' })
    const run = s.runId
    const lead = await signedIn(s.accounts.lead.email, s.accounts.lead.password)
    expect((await send('GET', '/api/session', lead)).statusCode).toBe(200)

    // what the demo made, read as the owner before the switch: every id a route might be handed
    const demoUsers = await ids('SELECT id FROM user_account WHERE demo_run = $1', [run])
    const files = (
      await t.owner.query<{ id: string; storage_key: string }>(
        `SELECT f.id, f.storage_key FROM stored_file f WHERE f.owner_id IN (SELECT e.id FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.demo_run = $1)
         OR f.owner_id IN (SELECT id FROM deal WHERE demo_run = $1) OR f.owner_id IN (SELECT i.id FROM investee i JOIN deal d ON d.id = i.deal_id WHERE d.demo_run = $1)`,
        [run],
      )
    ).rows
    expect(files.length).toBeGreaterThanOrEqual(12) // three sample PDFs for each of four investors
    for (const f of files) expect(await app.sandboxStorage.get(f.storage_key)).not.toBeNull()
    const deals = await ids('SELECT id FROM deal WHERE demo_run = $1', [run])
    expect(deals).toEqual(expect.arrayContaining([s.deals.live, s.deals.draft, s.deals.inReview]))
    const D = 'SELECT id FROM deal WHERE demo_run = $1'
    const P = `SELECT id FROM participation WHERE deal_id IN (${D})`
    const E = 'SELECT e.id FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.demo_run = $1'
    const demoIds = [
      ...deals,
      ...demoUsers,
      ...files.map((f) => f.id),
      ...(await ids('SELECT id FROM syndicate WHERE demo_run = $1', [run])),
      ...(await ids('SELECT id FROM investee_company WHERE demo_run = $1', [run])),
      ...(await ids(`SELECT id FROM investee WHERE deal_id IN (${D})`, [run])),
      ...(await ids(P, [run])),
      ...(await ids(`SELECT id FROM deal_invitation WHERE deal_id IN (${D})`, [run])),
      ...(await ids(`SELECT id FROM invite_link WHERE deal_id IN (${D})`, [run])),
      ...(await ids(`SELECT id FROM receipt WHERE participation_id IN (${P})`, [run])),
      ...(await ids(`SELECT id FROM issued_instruction WHERE participation_id IN (${P})`, [run])),
      ...(await ids(`SELECT id FROM signature_record WHERE participation_id IN (${P})`, [run])),
      ...(await ids(E, [run])),
      ...(await ids(`SELECT id FROM kyc_case WHERE entity_id IN (${E})`, [run])),
      ...(await ids(`SELECT id FROM entity_party WHERE entity_id IN (${E})`, [run])),
      ...(await ids(`SELECT id::text FROM doc_folder WHERE deal_id IN (${D})`, [run])),
    ]
    const codes = (await t.owner.query<{ c: string }>(`SELECT public_code AS c FROM deal WHERE demo_run = $1 AND public_code IS NOT NULL`, [run])).rows.map(
      (r) => r.c,
    )
    const ordinaryDeals = Number((await one<{ n: string }>('SELECT count(*) AS n FROM deal WHERE demo_run IS NULL')).n)
    const live = {
      party: `SELECT count(*) AS n FROM entity_party WHERE verify_token_hmac IS NOT NULL AND entity_id IN (${E})`,
      investee: `SELECT count(*) AS n FROM investee_link WHERE revoked_at IS NULL AND investee_id IN (SELECT id FROM investee WHERE deal_id IN (${D}))`,
      member: 'SELECT count(*) AS n FROM member_invite WHERE revoked_at IS NULL AND syndicate_id IN (SELECT id FROM syndicate WHERE demo_run = $1)',
      targeted: `SELECT count(*) AS n FROM targeted_invite WHERE revoked_at IS NULL AND consumed_at IS NULL AND deal_id IN (${D})`,
    }
    // each kind of link the demo can hand out, open at the switch: the syndicate and the targeted one through the lead's
    // routes; a party confirmation link written as a fixture (the seed's entities name no parties)
    const syndicateId = (await one<{ id: string }>('SELECT id FROM syndicate WHERE demo_run = $1', [run])).id
    expect((await send('POST', `/api/syndicates/${syndicateId}/invites`, lead, { role: 'deal_member' })).statusCode).toBe(200)
    const linkId = (await one<{ id: string }>("SELECT id FROM invite_link WHERE deal_id = $1 AND kind = 'open'", [s.deals.live])).id
    const targeted = await send('POST', `/api/deals/${s.deals.live}/targeted`, lead, { email: 'friend@example.test', link_id: linkId })
    expect(targeted.statusCode).toBe(200)
    const entity = await one<{ id: string; v: number }>(`SELECT id, current_version AS v FROM legal_entity WHERE id IN (${E}) LIMIT 1`, [run])
    await t.owner.query(
      "INSERT INTO entity_party (id, entity_id, entity_version, name, email, kind, verify_token_hmac) VALUES (gen_random_uuid(), $1, $2, 'A Party', 'party@example.test', 'owner', 'fixture-token-hmac')",
      [entity.id, entity.v],
    )
    for (const q of Object.values(live)) expect(Number((await one<{ n: string }>(q, [run])).n)).toBeGreaterThan(0)
    // an ordinary person who opened the demo link before the switch, and a ledger staff named for the demo deal (the seed
    // makes neither)
    const person = await staff('ordinary.person@example.test', [])
    const pending = () =>
      t.owner.query(
        "INSERT INTO pending_invite (id, browser_hmac, invite_link, user_id, expires_at) VALUES (gen_random_uuid(), 'fixture-browser', $1, $2, now() + interval '30 days')",
        [linkId, person.id],
      )
    await pending()
    await t.owner.query("INSERT INTO goten_ledger (id, deal_id, name, created_by) VALUES (gen_random_uuid(), $1, 'Senzu ledger', $2)", [s.deals.live, first.id])
    // what hangs off the demo's deals, participations, entities, syndicate and investees, by the parents' ids
    const parents = {
      deal: deals,
      participation: await ids(P, [run]),
      entity: await ids(E, [run]),
      syndicate: await ids('SELECT id FROM syndicate WHERE demo_run = $1', [run]),
      investee: await ids(`SELECT id FROM investee WHERE deal_id IN (${D})`, [run]),
    }
    const children: Array<[string, string, keyof typeof parents]> = [
      ['goten_ledger', 'deal_id', 'deal'],
      ['deal_version', 'deal_id', 'deal'],
      ['carry_recipient', 'deal_id', 'deal'],
      ['review_event', 'deal_id', 'deal'],
      ['participation_event', 'participation_id', 'participation'],
      ['legal_entity_version', 'entity_id', 'entity'],
      ['syndicate_member', 'syndicate_id', 'syndicate'],
      ['investee_link', 'investee_id', 'investee'],
    ]
    const childCount = async (db: typeof t.app, [tbl, col, parent]: (typeof children)[number]) =>
      Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${tbl} WHERE ${col} = ANY($1::uuid[])`, [parents[parent]])).rows[0]!.n)
    for (const c of children) expect([c[0], (await childCount(t.app, c)) > 0]).toEqual([c[0], true])
    const tokensBefore = Number((await one<{ n: string }>('SELECT count(*) AS n FROM account_token WHERE user_id = ANY($1::uuid[])', [demoUsers])).n)

    // requests asked before the switch, one about a demo account and one about an ordinary one (Codex r2 #2)
    const investor = s.accounts.investors[0]!
    await t.owner.query('UPDATE user_account SET mfa_enabled_at = now() WHERE id = ANY($1::uuid[]) AND mfa_enabled_at IS NULL', [[investor.id, reviewer.id]])
    const demoAsk = await send('POST', `/api/users/${investor.id}/mfa-reset`, first.h, {})
    expect(demoAsk.statusCode, demoAsk.body).toBe(200)
    const plainAsk = await send('POST', `/api/users/${reviewer.id}/mfa-reset`, first.h, {})
    expect(plainAsk.statusCode, plainAsk.body).toBe(200)

    // the operator gets ready for the real mode: final wording, then the switch, asked by one admin and approved by the other
    const packId = (await send('POST', '/api/packs', first.h, finalPack())).json().id
    const activate = (await send('POST', '/api/requests/pack-activate', first.h, { pack_id: packId })).json().id
    expect((await send('POST', `/api/requests/${activate}/approve`, second.h)).statusCode).toBe(200)
    const asked = await send('POST', '/api/requests/mode-switch', first.h, {
      regulatory_status: 'authorised_firm',
      accountable_person: 'Accountable Example',
      accountable_confirmed_on: '2026-11-01',
    })
    expect(asked.statusCode).toBe(200)
    // R-DEMO-04 through the routes: while a run is being added (its mark and its lock, as a run in progress holds them) a new
    // request and the approval of the one already made are both refused with the reason, and nothing is retired. A mark
    // with no lock held is a stuck run, which these routes retire first (Codex r2 #3)
    const holder = await t.owner.connect()
    await holder.query('SELECT pg_advisory_lock($1)', [DEMO_RUN_LOCK])
    await t.owner.query('UPDATE instance_profile SET demo_adding = $1 WHERE id = 1', [run])
    try {
      const again = await send('POST', '/api/requests/mode-switch', second.h, {
        regulatory_status: 'authorised_firm',
        accountable_person: 'Accountable Example',
        accountable_confirmed_on: '2026-11-01',
      })
      expect(again.statusCode).toBe(409)
      expect(again.body).toContain('A demo deal is being added.')
      const early = await send('POST', `/api/requests/${asked.json().id}/approve`, second.h)
      expect(early.statusCode).toBe(409)
      expect(early.body).toContain('A demo deal is being added.')
      expect((await one<{ state: string }>('SELECT state FROM demo_run WHERE id = $1', [run])).state).toBe('added')
    } finally {
      await t.owner.query('UPDATE instance_profile SET demo_adding = NULL WHERE id = 1')
      await holder.query('SELECT pg_advisory_unlock($1)', [DEMO_RUN_LOCK])
      holder.release()
    }
    expect((await send('POST', `/api/requests/${asked.json().id}/approve`, second.h)).statusCode).toBe(200)
    expect((await send('GET', '/api/instance/notice')).json()).toMatchObject({ mode: 'real' })

    // accounts: no sign-in, the old session is dead, a reset issues nothing
    for (const u of [s.accounts.lead, ...s.accounts.investors])
      expect((await send('POST', '/api/login', {}, { email: u.email, password: u.password })).statusCode).toBe(401)
    expect((await send('GET', '/api/session', lead)).statusCode).toBe(401)
    expect((await send('POST', '/api/password/forgot', {}, { email: s.accounts.lead.email })).statusCode).toBe(200)
    await new Promise((r) => setImmediate(r))
    expect(sent.filter((to) => to.endsWith('.demo.invalid'))).toEqual([])
    expect((await one<{ n: string }>("SELECT count(*) AS n FROM notification_outbox WHERE to_address LIKE '%.demo.invalid' AND status = 'queued'")).n).toBe('0')
    expect(
      Number((await one<{ n: string }>('SELECT count(*) AS n FROM account_token WHERE user_id = ANY($1::uuid[]) AND consumed_at IS NULL', [demoUsers])).n),
    ).toBe(0)
    expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM account_token WHERE user_id = ANY($1::uuid[])', [demoUsers])).n)).toBe(tokensBefore)
    expect(
      (
        await one<{ n: string }>(
          'SELECT count(*) AS n FROM user_account WHERE demo_run = $1 AND (password_hash IS NOT NULL OR mfa_secret IS NOT NULL OR disabled_at IS NULL)',
          [run],
        )
      ).n,
    ).toBe('0')
    expect((await one<{ n: string }>('SELECT count(*) AS n FROM role_grant WHERE user_id = ANY($1::uuid[])', [demoUsers])).n).toBe('0')

    // party, investee, syndicate and targeted links all spent
    for (const [k, q] of Object.entries(live)) expect([k, (await one<{ n: string }>(q, [run])).n]).toEqual([k, '0'])

    // files: rows and keys gone, the stored bytes queued, the sandbox's in-memory copies dropped
    expect((await one<{ n: string }>('SELECT count(*) AS n FROM stored_file WHERE id = ANY($1::uuid[])', [files.map((f) => f.id)])).n).toBe('0')
    expect((await one<{ n: string }>('SELECT count(*) AS n FROM file_deletion WHERE storage_key = ANY($1::text[])', [files.map((f) => f.storage_key)])).n).toBe(
      String(files.length),
    )
    for (const f of files) expect(await app.sandboxStorage.get(f.storage_key)).toBeNull()

    // kept: the fictional rows (seen by the owner), the chain, and one "demo data cleared"; the app's own role sees none of it
    expect(await ids(D, [run])).toHaveLength(deals.length)
    expect((await one<{ state: string }>('SELECT state FROM demo_run WHERE id = $1', [run])).state).toBe('retired')
    expect((await one<{ n: string }>("SELECT count(*) AS n FROM audit WHERE action = 'demo.data_cleared' AND entity_id = $1", [run])).n).toBe('1')
    expect((await verifyAudit(t.app, t.keyring)).ok).toBe(true)
    expect((await t.app.query('SELECT id FROM deal WHERE demo_run = $1', [run])).rowCount).toBe(0)
    expect((await t.app.query(`SELECT 1 FROM participation WHERE deal_id = ANY($1::uuid[])`, [deals])).rowCount).toBe(0)
    // the demo people's entities and checks too, under whatever route may come later
    expect((await t.app.query('SELECT 1 FROM legal_entity WHERE owner_user = ANY($1::uuid[])', [demoUsers])).rowCount).toBe(0)
    expect(
      (await t.app.query('SELECT 1 FROM kyc_case WHERE entity_id IN (SELECT id FROM legal_entity WHERE owner_user = ANY($1::uuid[]))', [demoUsers])).rowCount,
    ).toBe(0)
    expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM legal_entity WHERE owner_user = ANY($1::uuid[])', [demoUsers])).n)).toBeGreaterThan(0)
    expect(Number((await t.app.query<{ n: string }>('SELECT count(*) AS n FROM deal')).rows[0]!.n)).toBe(ordinaryDeals)
    // nothing new can be joined to it either, even past the routes
    await expect(t.app.query('INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, $3)', [s.deals.live, reviewer.id, 'member'])).rejects.toThrow()
    const syndicate = (await one<{ id: string }>('SELECT id FROM syndicate WHERE demo_run = $1', [run])).id
    await expect(
      t.app.query('INSERT INTO syndicate_member (syndicate_id, user_id, role) VALUES ($1, $2, $3)', [syndicate, reviewer.id, 'deal_member']),
    ).rejects.toThrow('demo and ordinary records stay apart')

    // the tables hanging off them too, though the rows stay for the owner
    for (const c of children) {
      expect([c[0], await childCount(t.app, c)]).toEqual([c[0], 0])
      expect([c[0], (await childCount(t.owner, c)) > 0]).toEqual([c[0], true])
    }
    // the run a record belongs to cannot be changed, so no record can be moved across the line or out of hiding
    await expect(t.app.query('UPDATE user_account SET demo_run = $2 WHERE id = $1', [person.id, run])).rejects.toThrow('run a record belongs to cannot change')
    await expect(t.owner.query('UPDATE user_account SET demo_run = NULL WHERE id = $1', [demoUsers[0]])).rejects.toThrow(
      'run a record belongs to cannot change',
    )
    // the link opened before the switch went with it; one left behind anyway is dropped at accepting, never a server error
    expect((await one<{ n: string }>('SELECT count(*) AS n FROM pending_invite WHERE invite_link = $1', [linkId])).n).toBe('0')
    await pending()
    // the switch asked this role-less account to prove its address again (R-OP-02): it does, and signs in afresh
    await t.owner.query('UPDATE user_account SET email_verified_at = now() WHERE id = $1', [person.id])
    const accepted = await send('POST', '/api/invite/accept', await signedIn('ordinary.person@example.test', PW, true), {})
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({ results: [] })
    expect((await one<{ n: string }>('SELECT count(*) AS n FROM pending_invite WHERE invite_link = $1', [linkId])).n).toBe('0')

    // the admin actions on one account, with bodies they accept: a retired account is no one, and no request names it (Codex r1 #3)
    const requestsBefore = (await one<{ n: string }>('SELECT count(*) AS n FROM admin_request')).n
    const holdsBefore = (await one<{ n: string }>("SELECT count(*) AS n FROM audit WHERE action LIKE 'retention.hold%'")).n
    for (const u of demoUsers) {
      for (const [method, url, body] of [
        ['POST', `/api/users/${u}/retention-hold`, { hold: false }],
        ['POST', `/api/users/${u}/retention-hold`, { hold: true }],
        ['POST', `/api/users/${u}/mfa-reset`, {}],
        ['POST', `/api/users/${u}/disable`, {}],
        ['PUT', `/api/users/${u}/roles/reviewer`, {}],
        ['DELETE', `/api/users/${u}/roles/reviewer`, undefined],
      ] as const) {
        const res = await send(method, url, first.h, body)
        expect([url, res.statusCode, res.json().error]).toEqual([url, 409, 'No such user.'])
      }
    }
    expect((await one<{ n: string }>('SELECT count(*) AS n FROM admin_request')).n).toBe(requestsBefore)
    expect((await one<{ n: string }>("SELECT count(*) AS n FROM audit WHERE action LIKE 'retention.hold%'")).n).toBe(holdsBefore)
    const queue = (await send('GET', '/api/requests', first.h)).body
    expect(DEMO_WORDS.filter((w) => queue.includes(w))).toEqual([])

    // every route, as each kind of staff, handed every demo id: never a server error, never a demo record
    const params = (url: string, id: string) =>
      url.replace(/:(\w+)/g, (_m, name: string) =>
        name === 'n' || name === 'version'
          ? '1'
          : name === 'currency'
            ? 'GBP'
            : name === 'role'
              ? 'reviewer'
              : name === 'key'
                ? 'your_money'
                : name === 'code'
                  ? (codes[0] ?? id)
                  : id,
      )
    const skip = new Set(['/api/logout', '/api/requests/mode-switch'])
    const failures: string[] = []
    const seen: Record<string, number> = {}
    for (const who of [first.h, reviewer.h]) {
      for (const r of app.routeTable) {
        if (skip.has(r.url) || r.url.includes('*')) continue
        for (const method of r.method.split(',')) {
          if (method === 'HEAD' || method === 'OPTIONS') continue
          const urls = r.url.includes(':') ? [...demoIds, ...codes].map((id) => params(r.url, id)) : method === 'GET' ? [r.url] : []
          for (const url of urls) {
            const res = await send(method, url, who, method === 'GET' || method === 'DELETE' ? undefined : {})
            seen[res.statusCode] = (seen[res.statusCode] ?? 0) + 1
            if (res.statusCode >= 500) failures.push(`${method} ${url} → ${res.statusCode}`)
            // handed a demo id, a route answers as for an id it never saw: two lists answer empty for any id that is not theirs
            const emptyForAnyId =
              (r.url === '/api/review/deals/:id/ledgers' && res.body === '{"ledgers":[]}') ||
              (r.url === '/api/review/users/:id/evidence' && !demoUsers.some((u) => url.includes(u)) && !/"[a-z_]+":\[\{/.test(res.body))
            if (res.statusCode < 300 && r.url.includes(':') && !emptyForAnyId) failures.push(`${method} ${url} → ${res.statusCode}`)
            // the audit chain is kept on purpose, names and all
            if (res.statusCode < 300 && !r.url.startsWith('/api/audit')) {
              const word = DEMO_WORDS.find((w) => res.body.includes(w))
              if (word) failures.push(`${method} ${url} shows "${word}"`)
            }
          }
        }
      }
    }
    expect(Object.values(seen).reduce((a, b) => a + b, 0)).toBeGreaterThan(10_000)
    expect(failures).toEqual([])

    // the request asked about a demo account before the switch names no one now, cannot be approved, and can be rejected;
    // the ordinary one beside it is shown and approved as before (Codex r2 #2)
    const listed = (await send('GET', '/api/requests', first.h)).json().requests as Array<{ id: string; details: Array<{ value: string }> }>
    const values = (id: string) => listed.find((r) => r.id === id)!.details.map((d) => d.value)
    expect(values(demoAsk.json().requestId)).toContain(RETIRED_DEMO_ACCOUNT)
    expect(values(plainAsk.json().requestId).some((v) => v.includes('ordinary.reviewer@example.test'))).toBe(true)
    const refused = await send('POST', `/api/requests/${demoAsk.json().requestId}/approve`, second.h)
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'No such user.'])
    expect((await send('POST', `/api/requests/${demoAsk.json().requestId}/reject`, second.h)).statusCode).toBe(200)
    expect((await send('POST', `/api/requests/${plainAsk.json().requestId}/approve`, second.h)).statusCode).toBe(200)
    expect((await one<{ on: boolean }>('SELECT mfa_enabled_at IS NOT NULL AS on FROM user_account WHERE id = $1', [reviewer.id])).on).toBe(false)
  }, 600_000)
})
