import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEMO_PACK_TEXTS } from '../lib/demo.ts'
import { parsePack, placeholderTexts, type RegimePack } from '../lib/regimePack.ts'
import { codeAt, stepOf } from '../lib/totp.ts'
import { verifyAudit } from '../store/audit.ts'
import { tx } from '../store/db.ts'
import { insertPack } from '../store/packs.ts'
import { createTestDb, type TestDb } from '../store/testdb.ts'
import { buildServer } from './app.ts'
import { demoOnStart, demoSeedRefusals, seedDemo } from './demoSeed.ts'
import { PART_SINCE } from './d4Panel.ts'
import { pdfText } from './pdfText.ts'
import { createSession, createUser, currentStaff, grantRole } from './auth.ts'
import { addDemoAccounts, beginDemoRun, demoStepAllowed, endDemoRun, recoverDemoRun, runDemo, type DemoAccounts } from './demo.ts'
import { changeRole, currentBlockers, DEMO_PACK_NOT_CURRENT } from './requests.ts'

let t: TestDb
let app: FastifyInstance
beforeAll(async () => {
  t = await createTestDb()
  app = await buildServer({ db: t.app, k: t.keyring, secureCookies: false })
}, 60_000)
afterAll(async () => {
  await app?.close()
  await t?.drop()
})

let ip = 0
const post = (url: string, payload: object, cookie?: string) =>
  app.inject({ method: 'POST', url, payload, remoteAddress: `10.44.0.${(ip++ % 250) + 1}`, headers: cookie ? { cookie } : {} })
const signIn = (email: string, password: string, code?: string) => post('/api/login', { email, password, ...(code ? { code } : {}) })
const cookieOf = (r: Awaited<ReturnType<typeof post>>) => `bulma_session=${r.cookies.find((c) => c.name === 'bulma_session')!.value}`
const me = (cookie: string) => app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })

const mark = async () => (await t.owner.query<{ demo_adding: string | null }>('SELECT demo_adding FROM instance_profile WHERE id = 1')).rows[0]!.demo_adding
const runs = async () =>
  (await t.owner.query<{ id: string; state: string; failure: string | null; via: string }>('SELECT id, state, failure, via FROM demo_run ORDER BY started_at'))
    .rows
const actions = async (entity: string) =>
  (await t.owner.query<{ action: string }>('SELECT action FROM audit WHERE entity_id = $1 ORDER BY seq', [entity])).rows.map((r) => r.action)
const blockerCodes = async () => {
  const row = (
    await t.app.query('SELECT mode, regulatory_status, accountable_person, accountable_confirmed_on::text, active_pack_id FROM instance_profile WHERE id = 1')
  ).rows[0]
  return (await currentBlockers(t.app, row, undefined)).map((b) => b.code)
}
// a retired or failed run frees the "only once" rule; an added one does not, so each test starts from none
const clearRuns = () => t.owner.query("UPDATE demo_run SET state = 'retired', finished_at = clock_timestamp() WHERE state <> 'retired'")

describe('demo run and the switch to the real mode', () => {
  it('TC-DEMO-04 a run marks the instance; a second run at the same time is refused; the switch names the run as a blocker', async () => {
    await clearRuns()
    const run = await beginDemoRun(t.app, t.keyring, { by: null, via: 'env' })
    expect(await mark()).toBe(run.id)
    await expect(beginDemoRun(t.app, t.keyring, { by: null, via: 'button' })).rejects.toThrow('A demo deal is being added.')
    expect(await blockerCodes()).toContain('demo_adding')
    // the database refuses the real mode while the mark is set, whatever path tries it
    await expect(t.owner.query("UPDATE instance_profile SET mode = 'real' WHERE id = 1")).rejects.toThrow(/demo_adding_sandbox_only|real_mode_profile/)
    await tx(t.app, (c) => demoStepAllowed(c, run.id))
    await expect(tx(t.app, (c) => demoStepAllowed(c, 'b0000000-0000-4000-8000-000000000000'))).rejects.toThrow('no longer being added')
    await endDemoRun(t.app, t.keyring, run, { ok: true })
    expect(await mark()).toBeNull()
    expect(await blockerCodes()).not.toContain('demo_adding')
    expect((await runs()).at(-1)).toMatchObject({ id: run.id, state: 'added', failure: null, via: 'env' })
    expect(await actions(run.id)).toEqual(['demo.started.env', 'demo.added'])
    await expect(beginDemoRun(t.app, t.keyring, { by: null, via: 'button' })).rejects.toThrow('already been added')
    expect(await verifyAudit(t.owner, t.keyring)).toMatchObject({ ok: true })
  })

  it('TC-DEMO-04 two runs started together: exactly one goes ahead', async () => {
    await clearRuns()
    const out = await Promise.allSettled([1, 2, 3].map(() => beginDemoRun(t.app, t.keyring, { by: null, via: 'button' })))
    const ok = out.filter((o) => o.status === 'fulfilled')
    expect(ok).toHaveLength(1)
    for (const o of out) if (o.status === 'rejected') expect(String(o.reason)).toMatch(/being added|already been added/)
    await endDemoRun(t.app, t.keyring, (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof beginDemoRun>>>).value, { ok: true })
  })

  it('TC-DEMO-04 a step that fails retires the run and clears the mark; the next run has a new id', async () => {
    await clearRuns()
    const seen: string[] = []
    const err = await runDemo(t.app, t.keyring, { by: null, via: 'button' }, [
      async (id) => void seen.push(id),
      async () => {
        throw new Error('step 2 broke')
      },
      async (id) => void seen.push(`never ${id}`),
    ]).catch((e: Error) => e)
    expect(String(err)).toContain('step 2 broke')
    expect(seen).toHaveLength(1)
    expect(await mark()).toBeNull()
    const failed = (await runs()).find((r) => r.id === seen[0])!
    expect(failed).toMatchObject({ state: 'retired', failure: 'step 2 broke' })
    expect(await actions(failed.id)).toEqual(['demo.started.button', 'demo.data_cleared', 'demo.failed'])
    const again = await runDemo(t.app, t.keyring, { by: null, via: 'button' }, [async () => {}])
    expect(again).not.toBe(failed.id)
    expect((await runs()).find((r) => r.id === again)!.state).toBe('added')
  })

  it('TC-DEMO-04 a run whose last commit fails is retired at once: the mark does not wait for a restart', async () => {
    await clearRuns()
    // the closing commit fails, as a lost connection would make it
    await t.owner.query(`CREATE FUNCTION test_no_added() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'closing failed'; END $$`)
    await t.owner.query("CREATE TRIGGER test_no_added BEFORE UPDATE ON demo_run FOR EACH ROW WHEN (NEW.state = 'added') EXECUTE FUNCTION test_no_added()")
    let id = ''
    try {
      const err = await runDemo(t.app, t.keyring, { by: null, via: 'button' }, [async (r) => void (id = r)]).catch((e: Error) => e)
      expect(String(err)).toContain('closing failed')
    } finally {
      await t.owner.query('DROP TRIGGER test_no_added ON demo_run; DROP FUNCTION test_no_added()')
    }
    expect(await mark()).toBeNull()
    expect((await runs()).find((r) => r.id === id)).toMatchObject({ state: 'retired', failure: 'interrupted' })
    expect(await blockerCodes()).not.toContain('demo_adding')
  })

  it('TC-DEMO-04 a failed run whose retiring commit fails too is retired at once, not left live until a restart', async () => {
    await clearRuns()
    // the first retiring commit fails, as a lost connection would make it; the start-up's own retiring is let through
    await t.owner.query(`CREATE FUNCTION test_no_retire() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retiring failed'; END $$`)
    await t.owner.query(
      "CREATE TRIGGER test_no_retire BEFORE UPDATE ON demo_run FOR EACH ROW WHEN (NEW.state = 'retired' AND NEW.failure IS DISTINCT FROM 'interrupted') EXECUTE FUNCTION test_no_retire()",
    )
    let id = ''
    const dropped: string[][] = []
    try {
      const err = await runDemo(t.app, t.keyring, { by: null, via: 'button', drop: async (k) => void dropped.push([...k]) }, [
        async (r) => void (id = r),
        async () => {
          throw new Error('step 2 broke')
        },
      ]).catch((e: Error) => e)
      expect(String(err)).toContain('step 2 broke')
    } finally {
      await t.owner.query('DROP TRIGGER test_no_retire ON demo_run; DROP FUNCTION test_no_retire()')
    }
    expect(await mark()).toBeNull()
    expect((await runs()).find((r) => r.id === id)).toMatchObject({ state: 'retired', failure: 'interrupted' })
    expect(await actions(id)).toEqual(['demo.started.button', 'demo.data_cleared', 'demo.interrupted'])
    expect(dropped).toEqual([[]])
    expect(await blockerCodes()).not.toContain('demo_adding')
  })

  it('TC-DEMO-04 a run cut off part-way: a starting process leaves it while held, retires it once nobody holds it', async () => {
    await clearRuns()
    const run = await beginDemoRun(t.app, t.keyring, { by: null, via: 'env' })
    // another process starting while this one still adds: not an interruption
    expect(await recoverDemoRun(t.app, t.keyring)).toBeNull()
    expect(await mark()).toBe(run.id)
    // the process dies: its connection, and with it the session lock, ends without the run being ended
    run.hold.release(true)
    expect(await recoverDemoRun(t.app, t.keyring)).toBe(run.id)
    expect(await mark()).toBeNull()
    expect((await runs()).find((r) => r.id === run.id)).toMatchObject({ state: 'retired', failure: 'interrupted' })
    expect(await actions(run.id)).toEqual(['demo.started.env', 'demo.data_cleared', 'demo.interrupted'])
    // nothing left: a second start-up does nothing
    expect(await recoverDemoRun(t.app, t.keyring)).toBeNull()
    // the dead run cannot end itself any more, and no step of it goes on
    await expect(tx(t.app, (c) => demoStepAllowed(c, run.id))).rejects.toThrow('no longer being added')
  })

  it('TC-DEMO-04 the real mode refuses a run', async () => {
    await clearRuns()
    const admin = await tx(t.app, (c) =>
      createUser(c, t.keyring, { email: 'demo-admin@example.test', name: 'Admin', password: 'a long enough password 1', by: null }),
    )
    await t.owner.query(
      "UPDATE instance_profile SET mode = 'real', regulatory_status = 'authorised_firm', accountable_person = 'A Person', accountable_confirmed_on = '2026-11-01', approved_by = $1 WHERE id = 1",
      [admin],
    )
    try {
      await expect(beginDemoRun(t.app, t.keyring, { by: admin, via: 'button' })).rejects.toThrow('sandbox only')
      expect(await mark()).toBeNull()
    } finally {
      await t.owner.query(
        "UPDATE instance_profile SET mode = 'sandbox', regulatory_status = NULL, accountable_person = NULL, accountable_confirmed_on = NULL, approved_by = NULL WHERE id = 1",
      )
    }
  })
})

describe('demo accounts (R-DEMO-08)', () => {
  const everyAccount = (a: DemoAccounts) => [a.lead, ...a.investors, a.reviewer]

  it('TC-DEMO-08 an account is demo only from its making by a run being added; an existing account is never moved into a run', async () => {
    await clearRuns()
    const run = await beginDemoRun(t.app, t.keyring, { by: null, via: 'button' })
    try {
      const plain = await tx(t.app, (c) =>
        createUser(c, t.keyring, { email: 'not-demo@example.test', name: 'Plain Person', password: 'a long enough password 1', by: null }),
      )
      // a fresh-looking timestamp proves nothing: the run cannot be given later, in any transaction, by either role
      await expect(
        tx(t.app, async (c) => {
          await c.query('UPDATE user_account SET created_at = now() WHERE id = $1', [plain])
          await c.query('UPDATE user_account SET demo_run = $2 WHERE id = $1', [plain, run.id])
        }),
      ).rejects.toThrow('run a record belongs to cannot change')
      const made = await tx(t.app, (c) =>
        createUser(c, t.keyring, { email: 'made-demo@example.test', name: 'Made Demo', password: 'a long enough password 1', by: null, demoRun: run.id }),
      )
      await expect(tx(t.app, (c) => c.query('UPDATE user_account SET demo_run = NULL WHERE id = $1', [made]))).rejects.toThrow('cannot change')
      expect((await t.owner.query('SELECT demo_run, must_change_password FROM user_account WHERE id = $1', [made])).rows[0]).toEqual({
        demo_run: run.id,
        must_change_password: false,
      })
    } finally {
      await endDemoRun(t.app, t.keyring, run, { ok: true })
    }
    // made against a run that is no longer being added: refused
    await expect(
      tx(t.app, (c) =>
        createUser(c, t.keyring, { email: 'late-demo@example.test', name: 'Late Demo', password: 'a long enough password 1', by: null, demoRun: run.id }),
      ),
    ).rejects.toThrow('made only by a run being added')
  })

  it('TC-DEMO-06 a run only moves forward: a retired run never comes back, an added one never goes back to adding', async () => {
    await clearRuns()
    const run = await beginDemoRun(t.app, t.keyring, { by: null, via: 'button' })
    await endDemoRun(t.app, t.keyring, run, { ok: true })
    await expect(t.app.query("UPDATE demo_run SET state = 'adding', finished_at = NULL WHERE id = $1", [run.id])).rejects.toThrow('only moves forward')
    await clearRuns()
    for (const db of [t.app, t.owner]) {
      await expect(db.query("UPDATE demo_run SET state = 'added' WHERE id = $1", [run.id])).rejects.toThrow('only moves forward')
      await expect(db.query("UPDATE demo_run SET failure = 'x' WHERE id = $1", [run.id])).rejects.toThrow('only moves forward')
    }
    expect((await runs()).find((r) => r.id === run.id)!.state).toBe('retired')
  })

  it('TC-DEMO-08 the run makes its accounts: random passwords kept nowhere, no staff, the reviewer alone has a role and two-step', async () => {
    await clearRuns()
    const admin = await tx(t.app, (c) =>
      createUser(c, t.keyring, { email: 'demo-acc-admin@example.test', name: 'Admin', password: 'a long enough password 1', by: null }),
    )
    const run = await beginDemoRun(t.app, t.keyring, { by: admin, via: 'button' })
    const a = await addDemoAccounts(t.app, t.keyring, run.id, admin)
    try {
      expect(a.investors.map((x) => x.name)).toEqual(['Son Goku', 'Yamcha', 'Krillin', 'Tien'])
      const rows = (
        await t.owner.query<{
          id: string
          email: string
          demo_run: string
          must_change_password: boolean
          verified: boolean
          mfa: boolean
          hash: string
          roles: string[]
        }>(
          `SELECT u.id, u.email, u.demo_run, u.must_change_password, u.email_verified_at IS NOT NULL AS verified, u.mfa_enabled_at IS NOT NULL AS mfa, u.password_hash AS hash,
                  coalesce((SELECT array_agg(g.role) FROM role_grant g WHERE g.user_id = u.id), '{}') AS roles
             FROM user_account u WHERE u.demo_run = $1`,
          [run.id],
        )
      ).rows
      expect(rows).toHaveLength(6)
      const passwords = everyAccount(a).map((x) => x.password)
      expect(new Set(passwords).size).toBe(6)
      for (const x of everyAccount(a)) {
        const row = rows.find((r) => r.id === x.id)!
        expect(row).toMatchObject({
          demo_run: run.id,
          must_change_password: false,
          verified: true,
          mfa: x === a.reviewer,
          roles: x === a.reviewer ? ['reviewer'] : [],
        })
        expect(x.email).toContain(`run-${run.id.slice(0, 8)}.demo.invalid`)
        expect(x.password.length).toBeGreaterThanOrEqual(20)
        expect(row.hash).not.toContain(x.password)
      }
      // the passwords are nowhere in the database: not in the audit, its details or the outbox
      const dump =
        JSON.stringify((await t.owner.query('SELECT a.*, d.* FROM audit a LEFT JOIN audit_detail d ON d.audit_seq = a.seq')).rows) +
        JSON.stringify((await t.owner.query('SELECT * FROM sandbox_outbox')).rows)
      for (const pw of passwords) expect(dump).not.toContain(pw)
      // the audit names the admin who started it
      const made = (
        await t.owner.query<{ actor: string }>("SELECT actor_id AS actor FROM audit WHERE action = 'user.created' AND entity_id = ANY($1)", [
          rows.map((r) => r.id),
        ])
      ).rows
      expect(made.map((m) => m.actor)).toEqual(Array(6).fill(admin))
      // never staff: not counted, cannot take a role through the screens, and the database refuses admin and approver anyway
      expect((await currentStaff(t.app)).map((s) => s.userId)).not.toContain(a.reviewer.id)
      await t.owner.query("INSERT INTO role_grant (user_id, role) VALUES ($1, 'admin')", [admin])
      const token = await createSession(t.app, t.keyring, admin, 1)
      const who = { id: admin, sessionHmac: t.keyring.hmac(`session\0${token}`) }
      for (const role of ['reviewer', 'approver', 'admin'] as const) {
        await expect(changeRole({ db: t.app, k: t.keyring } as never, who, a.lead.id, role, true)).rejects.toThrow('A demo account cannot take a role.')
      }
      for (const role of ['admin', 'approver'] as const) {
        await expect(tx(t.app, (c) => grantRole(c, t.keyring, a.reviewer.id, role, null))).rejects.toThrow('a demo account cannot take this role')
      }
      // the lead signs in with the password shown once; the reviewer needs the run's code as well
      expect((await signIn(a.lead.email, a.lead.password)).statusCode).toBe(200)
      expect((await signIn(a.reviewer.email, a.reviewer.password)).statusCode).toBe(401)
      expect((await signIn(a.reviewer.email, a.reviewer.password, codeAt(a.reviewer.mfaSecret, stepOf(Date.now())))).statusCode).toBe(200)
    } finally {
      await endDemoRun(t.app, t.keyring, run, { ok: true })
    }
  })

  it('TC-DEMO-08 the reviewer is retired when the run ends: no sign-in, old session dead, no reset; the others stay', async () => {
    await clearRuns()
    const run = await beginDemoRun(t.app, t.keyring, { by: null, via: 'env' })
    const a = await addDemoAccounts(t.app, t.keyring, run.id, null)
    const r = a.reviewer
    const live = await signIn(r.email, r.password, codeAt(r.mfaSecret, stepOf(Date.now())))
    expect(live.statusCode).toBe(200)
    const cookie = cookieOf(live)
    expect((await me(cookie)).statusCode).toBe(200)
    // a reset link asked for while the run was live
    expect((await post('/api/password/forgot', { email: r.email })).statusCode).toBe(200)
    const link = (await t.owner.query<{ body: string }>('SELECT body FROM sandbox_outbox WHERE to_address = $1', [r.email])).rows[0]!.body
    const token = /token=([^\s&]+)/.exec(link)![1]!
    const leadLive = cookieOf(await signIn(a.lead.email, a.lead.password))
    await endDemoRun(t.app, t.keyring, run, { ok: true })

    expect((await me(cookie)).statusCode).toBe(401)
    expect((await signIn(r.email, r.password, codeAt(r.mfaSecret, stepOf(Date.now()) + 1))).statusCode).toBe(401)
    expect((await post('/api/password/reset', { token, password: 'a brand new password 123' })).statusCode).not.toBe(200)
    const before = (await t.owner.query('SELECT 1 FROM account_token WHERE user_id = $1', [r.id])).rowCount
    expect((await post('/api/password/forgot', { email: r.email })).statusCode).toBe(200)
    expect((await t.owner.query('SELECT 1 FROM account_token WHERE user_id = $1', [r.id])).rowCount).toBe(before)
    const row = (await t.owner.query('SELECT password_hash, mfa_secret, mfa_enabled_at, disabled_at FROM user_account WHERE id = $1', [r.id])).rows[0]
    expect(row).toMatchObject({ password_hash: null, mfa_secret: null, mfa_enabled_at: null })
    expect(row.disabled_at).not.toBeNull()
    expect((await t.owner.query('SELECT 1 FROM role_grant WHERE user_id = $1', [r.id])).rowCount).toBe(0)
    expect((await t.owner.query('SELECT 1 FROM mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL', [r.id])).rowCount).toBe(0)
    expect(await actions(r.id)).toContain('demo.account_retired')
    // the lead and the investors go on: the deal is theirs to try
    expect((await me(leadLive)).statusCode).toBe(200)
    expect((await signIn(a.investors[0]!.email, a.investors[0]!.password)).statusCode).toBe(200)
    expect(await verifyAudit(t.owner, t.keyring)).toMatchObject({ ok: true })
  })

  it('TC-DEMO-08 a failed run retires every account it made; the next run makes new ones', async () => {
    await clearRuns()
    let made: DemoAccounts | undefined
    await expect(
      runDemo(t.app, t.keyring, { by: null, via: 'button' }, [
        async (id) => void (made = await addDemoAccounts(t.app, t.keyring, id, null)),
        async () => {
          throw new Error('later step broke')
        },
      ]),
    ).rejects.toThrow('later step broke')
    for (const x of everyAccount(made!)) expect((await signIn(x.email, x.password)).statusCode).toBe(401)
    const left = (
      await t.owner.query('SELECT 1 FROM user_account WHERE id = ANY($1) AND (disabled_at IS NULL OR password_hash IS NOT NULL)', [
        everyAccount(made!).map((x) => x.id),
      ])
    ).rowCount
    expect(left).toBe(0)
    let again: DemoAccounts | undefined
    await runDemo(t.app, t.keyring, { by: null, via: 'button' }, [async (id) => void (again = await addDemoAccounts(t.app, t.keyring, id, null))])
    expect(again!.lead.email).not.toBe(made!.lead.email)
    expect(again!.lead.id).not.toBe(made!.lead.id)
  })
})

describe('demo seed', () => {
  const one = async <T>(sql: string, args: unknown[] = []) => (await t.owner.query(sql, args)).rows[0] as T
  let admin: string
  beforeAll(async () => {
    admin = await tx(t.app, async (c) => {
      const u = await createUser(c, t.keyring, { email: 'seed.admin@example.test', name: 'Seed Admin', password: 'a-long-enough-password', by: null })
      await grantRole(c, t.keyring, u, 'admin', null)
      return u
    })
  })

  it('TC-DEMO-03 one click adds the scenario through the routes: three deals at their stops, four investors at their steps, totals as worked by hand', async () => {
    await clearRuns()
    expect((await t.owner.query('SELECT 1 FROM fee_config')).rowCount).toBe(0)
    // an operator asking for every company field: the seed fills them (fictional), it is not stopped by them
    await t.owner.query("UPDATE deal_config SET required_company_fields = '{registration_number,address}' WHERE id = 1")
    const s = await seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' }).finally(() =>
      t.owner.query("UPDATE deal_config SET required_company_fields = '{}' WHERE id = 1"),
    )
    expect((await runs()).at(-1)).toMatchObject({ id: s.runId, state: 'added', failure: null })
    // the operator never set a platform fee: a sample one, audited as the demo's (owner 2026-11-23)
    expect(s.sampleFee).toBe(true)
    expect(await actions(s.runId)).toEqual(['demo.started.button', 'demo.accounts_added', 'demo.sample_fee', 'demo.added'])
    // three deals of one lead, in the one syndicate, all on the demo side
    const deals = (
      await t.owner.query<{ id: string; state: string; name: string; demo_run: string; syndicate: string }>(
        "SELECT d.id, d.state, d.draft->'company'->>'legal_name' AS name, d.demo_run, s.name AS syndicate FROM deal d JOIN syndicate s ON s.id = coalesce(d.syndicate_id, (d.draft->'basics'->'syndicate'->>'id')::uuid) WHERE d.lead_user = $1 ORDER BY d.created_at",
        [s.accounts.lead.id],
      )
    ).rows
    expect(deals.map((d) => [d.name, d.state, d.syndicate, d.demo_run])).toEqual([
      ['Senzu Labs Ltd', 'live', 'Capsule Angels', s.runId],
      ['Dragon Radar Ltd', 'draft', 'Capsule Angels', s.runId],
      ['Kame House Ltd', 'in_review', 'Capsule Angels', s.runId],
    ])
    const link = await one<{ label: string; carry_bps: number; fee_kind: string; fee_bps: number; fee_mode: string }>(
      'SELECT label, carry_bps, fee_kind, fee_bps, fee_mode FROM invite_link WHERE deal_id = $1 AND NOT is_default',
      [s.deals.live],
    )
    expect(link).toEqual({ label: 'Senzu lead fee', carry_bps: 2000, fee_kind: 'percent', fee_bps: 200, fee_mode: 'on_top' })
    // each investor, by hand: 2% on top of the commitment
    const parts = (
      await t.owner.query<{ name: string; commitment: string; due: string; kyc: string; signed: boolean; issued: boolean; received: string }>(
        `SELECT u.name, p.commitment_minor::text AS commitment, p.cash_due_minor::text AS due,
                (SELECT k.status FROM kyc_case k WHERE k.entity_id = p.entity_id ORDER BY k.created_at DESC LIMIT 1) AS kyc,
                EXISTS (SELECT 1 FROM signature_record r WHERE r.participation_id = p.id) AS signed,
                EXISTS (SELECT 1 FROM issued_instruction i WHERE i.participation_id = p.id AND i.voided_at IS NULL) AS issued,
                (SELECT coalesce(sum(r.amount_minor), 0)::text FROM receipt r WHERE r.participation_id = p.id) AS received
           FROM participation p JOIN user_account u ON u.id = p.user_id WHERE p.deal_id = $1 AND p.outcome = 'active' ORDER BY array_position(ARRAY['Son Goku', 'Yamcha', 'Krillin', 'Tien'], u.name)`,
        [s.deals.live],
      )
    ).rows
    expect(parts).toEqual([
      { name: 'Son Goku', commitment: '1000000', due: '1020000', kyc: 'approved', signed: true, issued: true, received: '0' },
      { name: 'Yamcha', commitment: '2500000', due: '2550000', kyc: 'approved', signed: false, issued: false, received: '0' },
      { name: 'Krillin', commitment: '500000', due: '510000', kyc: 'pending_review', signed: false, issued: false, received: '0' },
      { name: 'Tien', commitment: '1500000', due: '1530000', kyc: 'approved', signed: true, issued: true, received: '1530000' },
    ])
    expect(parts.reduce((n, p) => n + BigInt(p.commitment), 0n)).toBe(5_500_000n)
    expect(parts.reduce((n, p) => n + BigInt(p.received), 0n)).toBe(1_530_000n)
    // the companies are on the demo side too, and the run's reviewer was never in the syndicate, a team or the carry (plan §4.4)
    expect(
      (
        await t.owner.query('SELECT DISTINCT c.demo_run FROM investee i JOIN investee_company c ON c.id = i.company_id WHERE i.deal_id = ANY($1)', [
          [s.deals.live, s.deals.inReview],
        ])
      ).rows,
    ).toEqual([{ demo_run: s.runId }])
    const rv = s.accounts.reviewer
    expect(
      (await t.owner.query('SELECT 1 FROM syndicate_member WHERE user_id = $1 UNION ALL SELECT 1 FROM deal_member WHERE user_id = $1', [rv.id])).rowCount,
    ).toBe(0)
    expect(
      (await t.owner.query("SELECT 1 FROM deal WHERE lead_user = $1 AND draft::text ILIKE '%' || $2 || '%'", [s.accounts.lead.id, rv.email])).rowCount,
    ).toBe(0)
    expect((await one<{ disabled: boolean }>('SELECT disabled_at IS NOT NULL AS disabled FROM user_account WHERE id = $1', [rv.id])).disabled).toBe(true)
    // the whole audit chain still holds, and mail went only to the sandbox outbox
    expect((await verifyAudit(t.owner, t.keyring)).ok).toBe(true)
    expect((await t.owner.query("SELECT 1 FROM notification_outbox WHERE mode <> 'sandbox'")).rowCount).toBe(0)
    expect(
      (await t.owner.query('SELECT 1 FROM sandbox_outbox WHERE to_address LIKE $1', [`%@run-${s.runId.slice(0, 8)}.demo.invalid`])).rowCount,
    ).toBeGreaterThan(0)
    // every file the seed made says on each page that it is a fictional sample
    const tien = s.accounts.investors[3]!
    const signedIn = await signIn(tien.email, tien.password)
    expect(signedIn.statusCode).toBe(200)
    // the lead pays the platform fee, so Tien's screen shows the whole commitment invested, with no fee share taken off
    const view = (await app.inject({ method: 'GET', url: `/api/my/deals/${s.deals.live}`, headers: { cookie: cookieOf(signedIn) } })).json()
    expect(view.participations[0]).toMatchObject({ payer: 'lead', expected_minor: '1500000' })
    const files = (
      await t.owner.query<{ id: string }>(
        "SELECT f.id FROM stored_file f JOIN legal_entity e ON e.id = f.owner_id WHERE f.scope = 'entity_kyc' AND e.owner_user = $1",
        [tien.id],
      )
    ).rows
    expect(files).toHaveLength(3)
    for (const f of files) {
      const r = await app.inject({ method: 'GET', url: `/api/files/${f.id}`, headers: { cookie: cookieOf(signedIn) } })
      expect(r.statusCode).toBe(200)
      // the mark is drawn once on each page
      const pages = (await PDFDocument.load(r.rawPayload)).getPageCount()
      expect(pages).toBeGreaterThan(0)
      expect((await pdfText(r.rawPayload)).filter((line) => line.includes('SAMPLE — fictional'))).toHaveLength(pages)
    }
  }, 120_000)

  it("TC-DEMO-09 the seed walks each investor to their stop alone, longest in their step first: nothing later moves an earlier one's days", async () => {
    await clearRuns()
    const walked: Array<{ name: string; at: Date }> = []
    const s = await seedDemo(app, t.app, t.keyring, {
      by: admin,
      via: 'button',
      beforeInvestor: async (x) => {
        walked.push({ name: x.name, at: (await one<{ at: Date }>('SELECT clock_timestamp() AS at')).at })
        // as the export's clock moved by a day does: every session of the run has ended and the reviewer's code is a new one
        await t.owner.query('UPDATE app_session SET expires_at = clock_timestamp() WHERE user_id IN (SELECT id FROM user_account WHERE demo_run IS NOT NULL)')
        await t.owner.query('UPDATE user_account SET mfa_last_step = NULL WHERE demo_run IS NOT NULL')
      },
    })
    expect((await runs()).at(-1)).toMatchObject({ id: s.runId, state: 'added', failure: null })
    expect(walked.map((w) => w.name)).toEqual(['Yamcha', 'Tien', 'Krillin', 'Son Goku'])
    const since = async (name: string) =>
      (
        await one<{ since: Date }>(`${PART_SINCE.replace('WHERE p.id = $1', 'JOIN user_account u ON u.id = p.user_id WHERE p.deal_id = $1 AND u.name = $2')}`, [
          s.deals.live,
          name,
        ])
      ).since
    // each one's last change is inside their own walk: after it started and before the next one's
    for (const [i, w] of walked.entries()) {
      const at = await since(w.name)
      expect(at.getTime()).toBeGreaterThanOrEqual(w.at.getTime())
      if (walked[i + 1]) expect(at.getTime()).toBeLessThan(walked[i + 1]!.at.getTime())
    }
    // the lead's list keeps the scenario's order: they came in through the link in that order before anyone was walked
    const came = (
      await t.owner.query<{ name: string }>(
        'SELECT u.name FROM deal_invitation i JOIN user_account u ON u.id = i.user_id WHERE i.deal_id = $1 ORDER BY i.created_at, i.id',
        [s.deals.live],
      )
    ).rows.map((r) => r.name)
    expect(came).toEqual(['Son Goku', 'Yamcha', 'Krillin', 'Tien'])
  }, 120_000)

  it('TC-DEMO-03 a second add is refused while the first stands, with the reason', async () => {
    await expect(seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' })).rejects.toThrow(/demo deal/i)
  })

  it.each([
    { perLink: false, generic: true, why: 'do not allow a link with terms of its own' },
    { perLink: true, generic: false, why: 'do not allow links that anyone holding them can open' },
  ])('TC-DEMO-03 operator settings that cannot carry the lead-fee link refuse before anything is made ($why)', async ({ perLink, generic, why }) => {
    await clearRuns()
    const policy = (a: boolean, b: boolean) =>
      t.owner.query(
        "INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, changed_by) VALUES ((SELECT coalesce(max(version), 0) + 1 FROM operator_policy), $1, $2, true, '{admin,reviewer}', 2, $3)",
        [a, b, admin],
      )
    const before = Number((await one<{ n: string }>('SELECT count(*) AS n FROM user_account')).n)
    await policy(perLink, generic)
    try {
      await expect(seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' })).rejects.toThrow(why)
      expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM user_account')).n)).toBe(before)
    } finally {
      // the table only takes new rows: a newer version allows both again
      await policy(true, true)
    }
  })

  it.each([
    { set: "enabled_structures = '{}'", undo: "enabled_structures = '{uk_bare_trust}'", why: 'do not allow the UK bare trust structure' },
    { set: 'min_commitment_floor_minor = 500001', undo: 'min_commitment_floor_minor = 100000', why: 'minimum commitment is above £5,000.00' },
    { set: 'content_approval_in_sandbox = true', undo: 'content_approval_in_sandbox = false', why: 'promotion approval before launch in the sandbox' },
    { set: 'link_fee_max_bps = 199', undo: 'link_fee_max_bps = 2500', why: "cap a link's lead fee below 2.00%" },
  ])('TC-DEMO-03 deal settings the scenario cannot meet refuse before anything is made ($why)', async ({ set, undo, why }) => {
    await clearRuns()
    const before = Number((await one<{ n: string }>('SELECT count(*) AS n FROM user_account')).n)
    const deals = Number((await one<{ n: string }>('SELECT count(*) AS n FROM deal')).n)
    await t.owner.query(`UPDATE deal_config SET ${set} WHERE id = 1`)
    try {
      await expect(seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' })).rejects.toThrow(why)
      expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM user_account')).n)).toBe(before)
      expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM deal')).n)).toBe(deals)
    } finally {
      await t.owner.query(`UPDATE deal_config SET ${undo} WHERE id = 1`)
    }
  })
  // the investors walk the current pack's own steps: another threshold, no assessment, or a step the seed cannot walk (Codex r1 #5)
  const withPack = async <T>(change: (p: Record<string, unknown>) => void, fn: () => Promise<T>): Promise<T> => {
    const was = (await one<{ active_pack_id: string; content: Record<string, unknown> }>(
      'SELECT i.active_pack_id, p.content FROM instance_profile i JOIN regime_pack p ON p.id = i.active_pack_id WHERE i.id = 1',
    ))
    const next = structuredClone(was.content)
    change(next)
    next.version = Number((await one<{ v: number }>('SELECT max(version) AS v FROM regime_pack WHERE key = $1', [next.key])).v) + 1
    const parsed = parsePack(next)
    expect(parsed.errors).toEqual([])
    const id = await tx(t.owner, (c) => insertPack(c, parsed.pack!, { builtIn: false, by: null }))
    await t.owner.query('UPDATE instance_profile SET active_pack_id = $1 WHERE id = 1', [id])
    try {
      return await fn()
    } finally {
      await t.owner.query('UPDATE instance_profile SET active_pack_id = $1 WHERE id = 1', [was.active_pack_id])
    }
  }

  it('TC-DEMO-03 a pack with a higher income threshold, written zero-padded, and no assessment: the investors walk its steps and qualify', async () => {
    await clearRuns()
    const s = await withPack(
      (p) => {
        // the same £200,000.00 written to the pack's 18 digits: the statement takes the amount, not the padding (Codex r2 #4)
        ;(p.thresholds as Record<string, string>).hnw_income_minor = '000000000020000000'
        ;(p.assessment as Record<string, unknown>).enabled = false
        p.steps = (p.steps as Array<{ kind: string }>).filter((x) => x.kind !== 'assessment')
      },
      () => seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' }),
    )
    const people = s.accounts.investors.map((i) => i.id)
    const said = await t.owner.query<{ answers: { high_net_worth: { income: { amount_minor: string } } } }>(
      'SELECT answers FROM eligibility_statement WHERE user_id = ANY($1::uuid[])',
      [people],
    )
    expect(said.rows.map((r) => r.answers.high_net_worth.income.amount_minor)).toEqual(people.map(() => '20000000'))
    expect((await t.owner.query('SELECT 1 FROM assessment_attempt WHERE user_id = ANY($1::uuid[])', [people])).rowCount).toBe(0)
    await clearRuns()
  }, 120_000)

  it('TC-DEMO-03 a pack with a step before the deal the seed does not walk refuses before anything is made', async () => {
    await clearRuns()
    const before = Number((await one<{ n: string }>('SELECT count(*) AS n FROM user_account')).n)
    await withPack(
      (p) => void (p.steps as Array<{ kind: string }>).unshift({ kind: 'capture_full_name' }),
      () => expect(seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' })).rejects.toThrow('steps before the deal that the demo deal does not walk: capture_full_name'),
    )
    expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM user_account')).n)).toBe(before)
  })

  it('TC-DEMO-03 an income threshold longer than a statement takes is refused before anything is made; one exactly as long is not', async () => {
    await clearRuns()
    const before = Number((await one<{ n: string }>('SELECT count(*) AS n FROM user_account')).n)
    const threshold = (v: string) => (p: Record<string, unknown>) => void ((p.thresholds as Record<string, string>).hnw_income_minor = v)
    const longer = "The current rules pack's income threshold is longer than a statement's amount can be, so the demo investors cannot sign at it."
    await withPack(threshold('1000000000000000'), () => expect(seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' })).rejects.toThrow(longer))
    expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM user_account')).n)).toBe(before)
    await withPack(threshold('000999999999999999'), async () => expect(await tx(t.app, (c) => demoSeedRefusals(c))).toEqual([]))
  })

  it('TC-DEMO-03 at the edges the settings are met: a floor of exactly £5,000.00 and a cap of exactly 2.00% refuse nothing', async () => {
    await t.owner.query('UPDATE deal_config SET min_commitment_floor_minor = 500000, link_fee_max_bps = 200 WHERE id = 1')
    try {
      expect(await tx(t.app, (c) => demoSeedRefusals(c))).toEqual([])
    } finally {
      await t.owner.query('UPDATE deal_config SET min_commitment_floor_minor = 100000, link_fee_max_bps = 2500 WHERE id = 1')
    }
  })

  it('TC-DEMO-04 a whole seed whose closing commit fails: retired at once, and the copies of its uploaded files leave memory too', async () => {
    await clearRuns()
    const queued = async () => (await t.owner.query<{ storage_key: string }>('SELECT storage_key FROM file_deletion')).rows.map((r) => r.storage_key)
    const before = new Set(await queued())
    await t.owner.query(`CREATE FUNCTION test_no_added() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'closing failed'; END $$`)
    await t.owner.query("CREATE TRIGGER test_no_added BEFORE UPDATE ON demo_run FOR EACH ROW WHEN (NEW.state = 'added') EXECUTE FUNCTION test_no_added()")
    try {
      await expect(seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' })).rejects.toThrow('closing failed')
    } finally {
      await t.owner.query('DROP TRIGGER test_no_added ON demo_run; DROP FUNCTION test_no_added()')
    }
    expect(await mark()).toBeNull()
    expect((await runs()).at(-1)).toMatchObject({ state: 'retired', failure: 'interrupted' })
    const keys = (await queued()).filter((k) => !before.has(k))
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(await (app as unknown as { sandboxStorage: { get(k: string): Promise<unknown> } }).sandboxStorage.get(k)).toBeNull()
  }, 120_000)

  // an admin as the instance page signs in: two-step on, the password not a temporary one
  const adminCaller = async (email: string, roles: string[]) => {
    const secret = Buffer.alloc(20, 7)
    const id = await tx(t.app, async (c) => {
      const u = await createUser(c, t.keyring, { email, name: 'Page Admin', password: 'a-long-enough-password', by: null })
      for (const r of roles) await grantRole(c, t.keyring, u, r as 'admin', null)
      return u
    })
    const e = t.keyring.encrypt(secret)
    await t.owner.query(
      'UPDATE user_account SET must_change_password = false, mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1',
      [id, e.ciphertext, e.keyId, e.wrappedDek],
    )
    const r = await signIn(email, 'a-long-enough-password', codeAt(secret, stepOf(Date.now())))
    expect(r.statusCode).toBe(200)
    const headers = { cookie: cookieOf(r), 'x-csrf-token': (r.json() as { csrf: string }).csrf }
    return {
      call: (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) }),
      add: () => app.inject({ method: 'POST', url: '/api/demo-deal', headers }),
      instance: async () => (await app.inject({ method: 'GET', url: '/api/instance', headers })).json() as { demo: string | null },
    }
  }
  const toReal = () =>
    t.owner.query(
      "UPDATE instance_profile SET mode = 'real', regulatory_status = 'authorised_firm', accountable_person = 'A Person', accountable_confirmed_on = '2026-11-01', approved_by = $1 WHERE id = 1",
      [admin],
    )
  const toSandbox = () =>
    t.owner.query(
      "UPDATE instance_profile SET mode = 'sandbox', regulatory_status = NULL, accountable_person = NULL, accountable_confirmed_on = NULL, approved_by = NULL WHERE id = 1",
    )

  it('TC-DEMO-03 the instance page: only an admin adds it, the sign-ins come back once and uncached, then the button is gone', async () => {
    await clearRuns()
    const page = await adminCaller('page.admin@example.test', ['admin'])
    const reviewerOnly = await adminCaller('page.reviewer@example.test', ['reviewer'])
    expect((await page.instance()).demo).toBe('none')
    expect((await reviewerOnly.add()).statusCode).toBe(403)
    const r = await page.add()
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    const body = r.json() as { sign_ins: Array<{ as: string; name: string; email: string; password: string }> }
    // the lead and the four investors; never the run's reviewer, already retired
    expect(body.sign_ins.map((x) => [x.as, x.name])).toEqual([
      ['Lead', 'Bulma Briefs'],
      ['Investor', 'Son Goku'],
      ['Investor', 'Yamcha'],
      ['Investor', 'Krillin'],
      ['Investor', 'Tien'],
    ])
    const run = (await runs()).at(-1)!
    expect(run).toMatchObject({ state: 'added', via: 'button' })
    for (const x of body.sign_ins) expect(x.email.endsWith(`@run-${run.id.slice(0, 8)}.demo.invalid`)).toBe(true)
    expect((await signIn(body.sign_ins[0]!.email, body.sign_ins[0]!.password)).statusCode).toBe(200)
    const dump =
      JSON.stringify((await t.owner.query('SELECT a.*, d.* FROM audit a LEFT JOIN audit_detail d ON d.audit_seq = a.seq')).rows) +
      JSON.stringify((await t.owner.query('SELECT * FROM sandbox_outbox')).rows)
    for (const x of body.sign_ins) expect(dump).not.toContain(x.password)
    expect((await page.instance()).demo).toBe('added')
    const again = await page.add()
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: 'The demo deal has already been added.' })
  }, 120_000)

  it('TC-DEMO-04 a failed run whose clean-up fails throughout is retired once the database is back: at the switch request, an approval or the next press, no restart', async () => {
    const page = await adminCaller('outage.admin@example.test', ['admin'])
    // every retiring fails while the run ends and right after, as a database away throughout would make it (Codex r2 #3)
    const stuck = async () => {
      await clearRuns()
      await t.owner.query(`CREATE FUNCTION test_no_retire() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retiring failed'; END $$`)
      await t.owner.query("CREATE TRIGGER test_no_retire BEFORE UPDATE ON demo_run FOR EACH ROW WHEN (NEW.state = 'retired') EXECUTE FUNCTION test_no_retire()")
      let id = ''
      try {
        const err = await runDemo(t.app, t.keyring, { by: null, via: 'button' }, [
          async (r) => void (id = r),
          async () => {
            throw new Error('step 2 broke')
          },
        ]).catch((e: Error) => e)
        expect(String(err)).toContain('step 2 broke')
        expect(await mark()).toBe(id)
      } finally {
        await t.owner.query('DROP TRIGGER test_no_retire ON demo_run; DROP FUNCTION test_no_retire()')
      }
      return id
    }
    const retired = async (id: string) => {
      expect(await mark()).toBeNull()
      expect((await runs()).find((r) => r.id === id)).toMatchObject({ state: 'retired', failure: 'interrupted' })
    }
    let id = await stuck()
    await page.call('POST', '/api/requests/mode-switch', {})
    await retired(id)
    id = await stuck()
    const none = await page.call('POST', '/api/requests/b0000000-0000-4000-8000-000000000000/approve')
    expect(none.json().error).toBe('No such request.')
    await retired(id)
    id = await stuck()
    const added = await page.add()
    expect(added.statusCode, added.body).toBe(200)
    await retired(id)
    expect((await runs()).filter((r) => r.state === 'added')).toHaveLength(1)
  }, 120_000)

  it('TC-DEMO-03 the real mode: no button, the route refuses, the start-up flag is ignored with a log line', async () => {
    await clearRuns()
    const page = await adminCaller('real.admin@example.test', ['admin'])
    const dir = await mkdtemp(join(tmpdir(), 'bulma-demo-'))
    const before = (await runs()).length
    await toReal()
    try {
      expect((await page.instance()).demo).toBeNull()
      const r = await page.add()
      expect(r.statusCode).toBe(409)
      expect(r.json()).toMatchObject({ error: 'A demo deal can only be added in the sandbox.' })
      const line = await demoOnStart(app, t.app, t.keyring, { flag: '1', file: join(dir, 'sign-ins.txt') })
      expect(line).toBe('BULMA_DEMO_DEAL is ignored: A demo deal can only be added in the sandbox.')
      await expect(stat(join(dir, 'sign-ins.txt'))).rejects.toThrow()
      expect((await runs()).length).toBe(before)
    } finally {
      await toSandbox()
    }
  })

  it('TC-DEMO-03 BULMA_DEMO_DEAL=1 adds it at start-up: sign-ins in a private file, the log names only the file, a restart adds nothing', async () => {
    await clearRuns()
    const dir = await mkdtemp(join(tmpdir(), 'bulma-demo-'))
    const file = join(dir, 'sign-ins.txt')
    // a file an earlier run left, readable by anyone: replaced, not reused
    await writeFile(file, 'old\n', { mode: 0o644 })
    expect(await demoOnStart(app, t.app, t.keyring, { flag: undefined, file })).toBeNull()
    expect(await demoOnStart(app, t.app, t.keyring, { flag: '0', file })).toBeNull()
    expect(await readFile(file, 'utf8')).toBe('old\n')
    const line = await demoOnStart(app, t.app, t.keyring, { flag: '1', file })
    expect(line).toBe(`BULMA_DEMO_DEAL: the demo deal was added; the sign-ins are in ${file}`)
    const run = (await runs()).at(-1)!
    expect(run).toMatchObject({ state: 'added', via: 'env' })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const rows = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split('\t'))
    expect(rows.map((x) => x[1])).toEqual(['Bulma Briefs', 'Son Goku', 'Yamcha', 'Krillin', 'Tien'])
    for (const x of rows) expect(line).not.toContain(x[3])
    expect((await signIn(rows[4]![2]!, rows[4]![3]!)).statusCode).toBe(200)
    // started by no admin: the audit says the system
    expect((await one<{ actor: string }>("SELECT actor_id AS actor FROM audit WHERE action = 'demo.started.env' AND entity_id = $1", [run.id])).actor).toBe(
      'system',
    )
    // a restart with the flag still set adds nothing and leaves the file as it was
    const kept = await readFile(file, 'utf8')
    expect(await demoOnStart(app, t.app, t.keyring, { flag: '1', file })).toBe('BULMA_DEMO_DEAL is ignored: The demo deal has already been added.')
    expect(await readFile(file, 'utf8')).toBe(kept)
    expect((await runs()).filter((x) => x.state !== 'retired')).toHaveLength(1)
  }, 120_000)
  it('TC-DEMO-07 the demo rules pack: placeholders still, a kept name, never the current pack, bound only to demo deals, named in the launch audit', async () => {
    await clearRuns()
    const first = await adminCaller('pack.first@example.test', ['admin'])
    const second = await adminCaller('pack.second@example.test', ['admin'])
    const s = await seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' })
    const active = await one<{ id: string; v: string }>(
      "SELECT p.id, p.key || '@' || p.version AS v FROM instance_profile i JOIN regime_pack p ON p.id = i.active_pack_id",
    )
    const demo = await one<{ id: string; v: string; content: RegimePack; built_in: boolean; added_by: string }>(
      "SELECT p.id, p.key || '@' || p.version AS v, p.content, p.built_in, p.added_by FROM demo_run r JOIN regime_pack p ON p.id = r.pack_id WHERE r.id = $1 AND p.demo_only",
      [s.runId],
    )
    expect(demo.v).toMatch(/^uk-fpo-demo-template@\d+$/)
    expect(demo).toMatchObject({ built_in: false, added_by: admin })
    // the three texts are short sample sentences, still placeholders, so a real-mode check refuses them as it does the template
    const texts = demo.content.legal_texts.filter((x) => ['promotion_warning', 'sender_name', 'your_money'].includes(x.text_key))
    expect(texts.length).toBeGreaterThanOrEqual(3)
    for (const x of texts) {
      expect(x.is_placeholder).toBe(true)
      expect(Object.values(DEMO_PACK_TEXTS)).toContain(x.body)
    }
    expect(placeholderTexts(demo.content)).toEqual(expect.arrayContaining(['promotion_warning', 'sender_name', 'your_money']))
    // an upload cannot take the kept name
    const { pack: template } = await one<{ pack: RegimePack }>('SELECT content AS pack FROM regime_pack WHERE id = $1', [active.id])
    const upload = await first.call('POST', '/api/packs', { ...template, key: 'uk-fpo-demo-template', version: 99 })
    expect(upload.statusCode).toBe(409)
    expect(upload.json().error).toMatch(/kept for packs shipped/)
    // the pack page names it and offers no activation; asking is refused
    expect((await first.call('GET', '/api/packs')).json().packs.find((p: { id: string }) => p.id === demo.id)).toMatchObject({ demo_only: true, active: false })
    const ask = await first.call('POST', '/api/requests/pack-activate', { pack_id: demo.id })
    expect(ask.statusCode).toBe(409)
    expect(ask.json().error).toBe(DEMO_PACK_NOT_CURRENT)
    // a request already made is refused at approval too, and the current pack stays
    const updated = (await one<{ u: string }>('SELECT updated_at::text AS u FROM instance_profile WHERE id = 1')).u
    const old = await one<{ id: string }>(
      "INSERT INTO admin_request (id, kind, payload, requested_by) VALUES (gen_random_uuid(), 'pack_activate', $1, (SELECT id FROM user_account WHERE email = 'pack.first@example.test')) RETURNING id",
      [JSON.stringify({ pack_id: demo.id, base: updated })],
    )
    const approve = await second.call('POST', `/api/requests/${old.id}/approve`)
    expect(approve.statusCode).toBe(409)
    expect(approve.json().error).toBe(DEMO_PACK_NOT_CURRENT)
    expect((await one<{ id: string }>('SELECT active_pack_id AS id FROM instance_profile WHERE id = 1')).id).toBe(active.id)
    await expect(t.owner.query('UPDATE instance_profile SET active_pack_id = $1 WHERE id = 1', [demo.id])).rejects.toThrow(/never the current pack/)
    // bound to the demo deal at launch; the audit row keeps the instance's pack and the detail names the demo one
    expect((await one<{ pack_id: string }>('SELECT pack_id FROM deal WHERE id = $1', [s.deals.live])).pack_id).toBe(demo.id)
    expect(
      await one('SELECT a.pack_version, d.detail::jsonb AS detail FROM audit a JOIN audit_detail d ON d.audit_seq = a.seq WHERE a.action = $1 AND a.entity_id = $2', [
        'deal.launched',
        s.deals.live,
      ]),
    ).toEqual({ pack_version: active.v, detail: { demo_pack: demo.v } })
    // the demo investors confirmed the demo warning, the one the deal asks for (owner 2026-11-24)
    const acks = await t.owner.query<{ pack_id: string }>("SELECT DISTINCT pack_id FROM warning_ack WHERE kind = 'warning_block' AND user_id = ANY($1)", [
      s.accounts.investors.map((i) => i.id),
    ])
    expect(acks.rows).toEqual([{ pack_id: demo.id }])
    // only a demo deal, only in the sandbox, whatever path tries
    // a deal keeps the run it was made with, and an insert naming a run of its own gets its lead's (none) before the check
    await expect(t.owner.query('UPDATE deal SET demo_run = NULL WHERE id = $1', [s.deals.live])).rejects.toThrow(/run a record belongs to cannot change/)
    await expect(
      t.owner.query('INSERT INTO deal (id, lead_user, public_code, demo_run, pack_id) VALUES (gen_random_uuid(), $1, $2, $3, $4)', [
        admin,
        'BU-ZZDEMO1',
        s.runId,
        demo.id,
      ]),
    ).rejects.toThrow(/only to a demo deal in the sandbox/)
    await toReal()
    try {
      await expect(t.owner.query('UPDATE deal SET pack_id = $2 WHERE id = $1', [s.deals.draft, demo.id])).rejects.toThrow(/only to a demo deal in the sandbox/)
    } finally {
      await toSandbox()
    }
    // a later run with the same current pack takes the same demo pack, so retries do not pile up versions
    await clearRuns()
    const demoPacks = (await t.owner.query('SELECT 1 FROM regime_pack WHERE demo_only')).rowCount
    const again = await seedDemo(app, t.app, t.keyring, { by: admin, via: 'button' })
    expect((await one<{ pack_id: string }>('SELECT pack_id FROM demo_run WHERE id = $1', [again.runId])).pack_id).toBe(demo.id)
    expect((await t.owner.query('SELECT 1 FROM regime_pack WHERE demo_only')).rowCount).toBe(demoPacks)
  }, 120_000)
})
