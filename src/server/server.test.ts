import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import argon2 from 'argon2'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeKyc, FakeOutbox, FakeScanner, FakeSignature, LocalStorage, MemoryStorage, selectAdapters, type Mailer } from '../adapters/index.ts'
import { parsePack, type RegimePack } from '../lib/regimePack.ts'
import { codeAt, stepOf } from '../lib/totp.ts'
import { appendAudit, chainHead, checkHead, verifyAudit } from '../store/audit.ts'
import { tx } from '../store/db.ts'
import { ensureInstance, readBuiltInPacks } from '../store/packs.ts'
import { migrate } from '../store/migrate.ts'
import { createTestDb, PASSWORDS, TEST_URL, type TestDb } from '../store/testdb.ts'
import { bootstrapAdmin, createUser, grantRole } from './auth.ts'
import { ACCOUNTABLE_LABEL, buildServer, CSP, PACK_FORMAT_PASSED, parseTrustProxy, SANDBOX_BANNER, SWITCH_WARNING } from './app.ts'

let t: TestDb
let app: FastifyInstance
const paymentDir = mkdtempSync(join(tmpdir(), 'bulma-pay-'))
const paymentFile = join(paymentDir, 'payment.json')
const PAYMENT = [{ currency: 'GBP', account_fields: { sort_code: '11-22-33', account_number: '12345678' }, holder: 'Example Client Money Ltd', holder_capacity: 'Regulated client money provider', holder_frn: '123456', asserted_client_money: true, your_money_text_key: 'your_money', refund_days: 10, receipt_check_note: 'Checked on the statement.' }]
writeFileSync(paymentFile, JSON.stringify(PAYMENT))

/** Every form net.Socket.connect takes: (port, host), ({ port, host }), and the internal ([{ port, host }, cb]). */
function connectTarget(args: unknown[]): { host: string; port: number } | null {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof a === 'number' || typeof a === 'string') return { port: Number(a), host: typeof args[1] === 'string' ? args[1] : 'localhost' }
  const o = a as { port?: number | string; host?: string; path?: string } | undefined
  return o?.port === undefined ? null : { port: Number(o.port), host: o.host ?? 'localhost' }
}
const isDatabase = (t: { host: string; port: number }, host: string, port: number) => t.host === host && t.port === port

const SEED_EMAIL = 'seed.person@example.test'
const SEED_NAME = 'Seeded Person Name'
const PW = 'a-long-enough-password'

interface Client { cookie: string; csrf: string; id: string }

async function call(method: string, url: string, who?: Client, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: method as 'GET', url,
    headers: { ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
}

const MFA_SECRET = Buffer.alloc(20, 7)
async function setMfa(id: string, db = t) {
  const e = db.keyring.encrypt(MFA_SECRET)
  await db.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [id, e.ciphertext, e.keyId, e.wrappedDek])
}

async function signIn(email: string, password: string, ip = '10.0.0.1'): Promise<Client> {
  await t.owner.query('UPDATE user_account SET mfa_last_step = NULL WHERE lower(email) = lower($1)', [email]) // several sign-ins in one 30-second step
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password, code: codeAt(MFA_SECRET, stepOf(Date.now())) }, remoteAddress: ip })
  expect(r.statusCode).toBe(200)
  const body = r.json()
  return { cookie: `bulma_session=${r.cookies.find((c) => c.name === 'bulma_session')!.value}`, csrf: body.csrf, id: body.user.id }
}

const passwordFrom = (ip: string, who: Client, current: string, next: string) =>
  app.inject({ method: 'POST', url: '/api/password', remoteAddress: ip, headers: { cookie: who.cookie, 'x-csrf-token': who.csrf }, payload: { current, next } })

/** A signed-in person with a real password, created directly. */
async function person(email: string, roles: Array<'admin' | 'reviewer' | 'approver'>, db = t, mfa = true): Promise<Client> {
  const id = await tx(db.app, async (c) => {
    const u = await createUser(c, db.keyring, { email, name: `Name of ${email}`, password: PW, by: null })
    await c.query('UPDATE user_account SET must_change_password = false WHERE id = $1', [u])
    for (const r of roles) await grantRole(c, db.keyring, u, r, null)
    return u
  })
  if (mfa) await setMfa(id, db)
  const c = await signIn(email, PW)
  return { ...c, id }
}

const fullPack = (key: string): RegimePack => {
  const p = readBuiltInPacks().find((x) => x.key === 'uk-fpo-template')!
  return {
    ...p, key,
    legal_texts: p.legal_texts.map((x) => ({ ...x, is_placeholder: false, body: x.body.replace(/\*\*PLACEHOLDER\*\*.*/s, '**PLACEHOLDER** kept word, operator text.').replace(/^.*not legal text.*$/is, `Operator wording for ${x.text_key}.`) })),
    assessment: { ...p.assessment, questions: p.assessment.questions.map((q) => ({ ...q, is_placeholder: false, prompt: `Operator question ${q.id}?`, options: ['Option one', 'Option two', 'Option three'] })) },
  }
}

const SWITCH = { regulatory_status: 'authorised_firm', accountable_person: 'Accountable Example', accountable_confirmed_on: '2026-11-01' }
const auditCount = async (action: string) => Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit WHERE action LIKE $1', [`${action}%`])).rows[0]!.n)

let first: Client
let second: Client
let reviewer: Client

beforeAll(async () => {
  t = await createTestDb()
  app = await buildServer({ db: t.app, k: t.keyring, paymentFile, secureCookies: false })
  await bootstrapAdmin(t.app, t.keyring, 'first@example.test', PW)
  first = await signIn('first@example.test', PW)
})
afterAll(async () => {
  await app?.close()
  await t?.drop()
})

describe('sign-in and sessions', () => {
  it('TC-ACC-02 a temporary password can only change the password', async () => {
    expect((await call('GET', '/api/instance', first)).statusCode).toBe(403)
    expect((await call('GET', '/api/session', first)).statusCode).toBe(200)
    expect((await call('POST', '/api/password', first, { current: 'wrong-wrong-wrong', next: 'another-long-password' })).statusCode).toBe(400)
    expect((await call('POST', '/api/password', first, { current: PW, next: 'short' })).statusCode).toBe(400)
    expect((await call('POST', '/api/password', first, { current: PW, next: PW })).statusCode).toBe(400)
    expect((await call('POST', '/api/password', first, { current: PW, next: 'first-admin-password-2' })).statusCode).toBe(200)
    // TC-ACC-02: an admin without two-step sign-in cannot act
    expect((await call('GET', '/api/instance', first)).statusCode).toBe(403)
    await setMfa(first.id)
    expect((await call('GET', '/api/instance', first)).statusCode).toBe(200)
  })
  it('a password change ends other sessions', async () => {
    const p = await person('session.user@example.test', [])
    const other = await signIn('session.user@example.test', PW)
    expect((await call('POST', '/api/password', p, { current: PW, next: 'session-user-password-2' })).statusCode).toBe(200)
    expect((await call('GET', '/api/session', other)).statusCode).toBe(401)
    expect((await call('GET', '/api/session', p)).statusCode).toBe(200)
  })
  it('a session stops at once if the credential version moves or the account is disabled, even with the session row still there', async () => {
    const a = await person('version.bump@example.test', [])
    await t.owner.query('UPDATE user_account SET credential_version = credential_version + 1 WHERE id = $1', [a.id])
    expect((await call('GET', '/api/session', a)).statusCode).toBe(401)
    const b = await person('disabled.direct@example.test', [])
    await t.owner.query('UPDATE user_account SET disabled_at = now() WHERE id = $1', [b.id])
    expect((await t.owner.query('SELECT 1 FROM app_session WHERE user_id = $1', [b.id])).rowCount).toBe(1)
    expect((await call('GET', '/api/session', b)).statusCode).toBe(401)
  })
  it('no session, a bad cookie and a missing CSRF token are refused', async () => {
    expect((await call('GET', '/api/instance')).statusCode).toBe(401)
    expect((await call('GET', '/api/instance', { cookie: 'bulma_session=forged', csrf: '', id: '' })).statusCode).toBe(401)
    expect((await call('POST', '/api/logout', { ...first, csrf: 'wrong' })).statusCode).toBe(403)
    expect((await call('POST', '/api/logout', { ...first, csrf: '' })).statusCode).toBe(403)
  })
  it('wrong password, unknown email and hostile bodies get the same plain refusal', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'first@example.test', password: 'nope-nope-nope' }, remoteAddress: '10.9.0.1' })
    const b = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'nobody@example.test', password: 'nope-nope-nope' }, remoteAddress: '10.9.0.2' })
    expect(a.statusCode).toBe(401)
    expect(b.statusCode).toBe(401)
    expect(a.json()).toEqual(b.json())
    for (const payload of [{}, { email: 1, password: 2 }, { email: 'x', password: 'y', extra: 1 }, { email: 'x', password: 'y'.repeat(5000) }]) {
      expect((await app.inject({ method: 'POST', url: '/api/login', payload, remoteAddress: '10.9.0.3' })).statusCode).toBe(400)
    }
    const broken = await app.inject({ method: 'POST', url: '/api/login', payload: '{not json', headers: { 'content-type': 'application/json' }, remoteAddress: '10.9.0.3' })
    expect(broken.statusCode).toBe(400)
  })
  it('sign-in locks after ten failures for that email, even with the right password', async () => {
    await person('locked@example.test', [], t, false)
    for (let i = 0; i < 9; i++) await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'locked@example.test', password: 'wrong-password-x' }, remoteAddress: `10.8.0.${i}` })
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'locked@example.test', password: PW }, remoteAddress: '10.8.1.1' })).statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'locked@example.test', password: 'wrong-password-x' }, remoteAddress: '10.8.1.2' })
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'locked@example.test', password: PW }, remoteAddress: '10.8.1.3' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'LOCKED@example.test ', password: PW }, remoteAddress: '10.8.1.4' })).statusCode).toBe(401)
  })
  it('parallel guesses cannot outrun the limit, and refused attempts add nothing to the audit log or the password work', async () => {
    await person('parallel@example.test', [])
    const verify = vi.spyOn(argon2, 'verify')
    const guess = (i: number, password = 'wrong-password-x') => app.inject({ method: 'POST', url: '/api/login', payload: { email: 'parallel@example.test', password }, remoteAddress: `10.6.${i}.1` })
    try {
      await Promise.all(Array.from({ length: 40 }, (_, i) => guess(i)))
      expect(verify.mock.calls.length).toBeLessThanOrEqual(10)
    } finally {
      verify.mockRestore()
    }
    const before = await auditCount('user.login_failed')
    expect((await guess(99)).statusCode).toBe(401)
    expect((await guess(98, PW)).statusCode).toBe(401)
    expect(await auditCount('user.login_failed')).toBe(before)
  })
  it('from one address, changing the email cannot grow the throttle table once that address is over its limit', async () => {
    const count = async () => Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM login_throttle')).rows[0]!.n)
    const attempt = (i: number) => app.inject({ method: 'POST', url: '/api/login', payload: { email: `grow${i}@example.test`, password: 'wrong-password-x' }, remoteAddress: '10.4.0.1' })
    for (let i = 0; i < 11; i++) await attempt(i)
    const full = await count()
    for (let i = 11; i < 20; i++) expect((await attempt(i)).statusCode).toBe(401)
    expect(await count()).toBe(full)
    await t.owner.query("UPDATE login_throttle SET window_started_at = now() - interval '1 hour'")
    await attempt(99)
    expect(await count()).toBe(2)
  })
  it('TRUST_PROXY takes an address or CIDR and refuses anything else', () => {
    expect(parseTrustProxy(undefined)).toBe(false)
    expect(parseTrustProxy(' ')).toBe(false)
    expect(parseTrustProxy('172.30.0.1')).toBe('172.30.0.1')
    expect(parseTrustProxy('10.0.0.0/8, ::1')).toBe('10.0.0.0/8, ::1')
    for (const bad of ['true', '1', 'yes', '*']) expect(() => parseTrustProxy(bad), bad).toThrow(/address or CIDR/)
  })
  it('the password-change route cannot be used to guess: after the limit, no password work and the right one fails too', async () => {
    const p = await person('reauth@example.test', [])
    const verify = vi.spyOn(argon2, 'verify')
    try {
      for (let i = 0; i < 15; i++) expect((await passwordFrom('10.3.0.1', p, `wrong-guess-number-${i}`, 'a-new-long-password')).statusCode).toBe(400)
      expect(verify.mock.calls.length).toBeLessThanOrEqual(10)
    } finally {
      verify.mockRestore()
    }
    // the limit is by account as well: another address does not help, and the right password fails too
    expect((await passwordFrom('10.3.0.2', p, PW, 'a-new-long-password')).statusCode).toBe(400)
    // and by address: guesses at many accounts from one place stop as well
    const other = await person('reauth.other@example.test', [])
    expect((await passwordFrom('10.3.0.1', other, PW, 'a-new-long-password')).statusCode).toBe(400)
    expect((await passwordFrom('10.3.0.3', other, PW, 'a-new-long-password')).statusCode).toBe(200)
  })
  it('a session ending while the password change waits for the row stops it; so does one expiring during a wait', async () => {
    const p = await person('queued.password@example.test', [])
    const hold = await t.owner.connect()
    const waiting = async () => {
      for (let i = 0; i < 200; i++) {
        const w = await t.owner.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()")
        if (w.rowCount) return
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    try {
      await hold.query('BEGIN')
      await hold.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [p.id])
      const pending = passwordFrom('10.3.0.4', p, PW, 'never-becomes-the-password')
      await waiting()
      await t.owner.query('DELETE FROM app_session WHERE user_id = $1', [p.id])
      await hold.query('COMMIT')
      expect((await pending).statusCode).toBe(400)
    } finally {
      hold.release()
    }
    expect((await signIn('queued.password@example.test', PW)).id).toBe(p.id)
    // natural expiry, against the instance lock: the clock is read after the wait
    const a = await person('expiring.admin@example.test', ['admin'])
    const h2 = await t.owner.connect()
    try {
      await h2.query('BEGIN')
      await h2.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
      await t.owner.query("UPDATE app_session SET expires_at = now() + interval '700 milliseconds' WHERE user_id = $1", [a.id])
      const pending = call('POST', '/api/fee-config', a, { rate_bps: 1, min_minor: '0', max_minor: '0', surcharge_threshold_minor: '0', surcharge_bps: 0 })
      await waiting()
      await new Promise((r) => setTimeout(r, 900))
      await h2.query('COMMIT')
      const r = await pending
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toMatch(/session has ended/)
    } finally {
      h2.release()
    }
    expect((await t.owner.query('SELECT 1 FROM fee_config')).rowCount).toBe(0)
    await t.owner.query('DELETE FROM role_grant WHERE user_id = $1', [a.id]) // later tests count the admins
  })
  it('signing out ends the session and is audited', async () => {
    const p = await person('logout.user@example.test', [])
    expect((await call('POST', '/api/logout', p)).statusCode).toBe(200)
    expect((await call('GET', '/api/session', p)).statusCode).toBe(401)
    expect((await t.owner.query("SELECT 1 FROM audit WHERE action = 'user.logout' AND entity_id = $1", [p.id])).rowCount).toBe(1)
  })
  it('a NUL character is refused plainly, not a server error', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a\u0000b@example.test', password: 'x' }, remoteAddress: '10.5.0.1' })).statusCode).toBe(400)
    expect((await call('POST', '/api/requests/profile', first, { ...SWITCH, accountable_person: 'a\u0000b' })).statusCode).toBe(400)
    expect((await call('POST', '/api/requests/profile', first, { ...SWITCH, accountable_confirmed_on: '0000-01-01' })).statusCode).toBe(400)
  })
  it('security headers are on every response', async () => {
    const r = await call('GET', '/api/health')
    expect(r.headers['content-security-policy']).toBe(CSP)
    expect(r.headers['x-frame-options']).toBe('DENY')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cache-control']).toBe('no-store')
  })
})

describe('routes', () => {
  it('TC-AUTHZ-07 a route with no gate stops the server starting, and the CI check fails on it', async () => {
    const stub = { db: t.app, k: t.keyring }
    await expect(buildServer({ ...stub, extraRoutes: (a) => a.get('/api/oops', async () => ({})) })).rejects.toThrow(/declares no gate/)
    await expect(buildServer({ ...stub, extraRoutes: (a) => a.get('/api/oops', { config: { gate: 'nonsense' as 'public' } }, async () => ({})) })).rejects.toThrow(/declares no gate/)
    await expect(buildServer({ ...stub, extraRoutes: (a) => a.get('/api/oops', { config: { gate: 'public' } }, async () => ({})) })).rejects.toThrow(/not listed in PUBLIC_ROUTES/)
    const node = ['--experimental-strip-types', '--no-warnings', 'scripts/check-routes.ts']
    expect(spawnSync('node', node).status).toBe(0)
    const bad = spawnSync('node', [...node, '--with-bad-example'], { encoding: 'utf8' })
    expect(bad.status).toBe(1)
    expect(bad.stdout).toContain('/api/forgot-to-declare')
  })
  it('TC-AUTHZ-07 every route has a gate, and only the listed ones are public', async () => {
    const a = app as FastifyInstance & { routeTable: Array<{ url: string; gate: string }> }
    expect(a.routeTable.length).toBeGreaterThan(10)
    expect(new Set(a.routeTable.filter((r) => r.gate === 'public').map((r) => r.url))).toEqual(new Set(['/api/health', '/api/instance/notice', '/api/login', '/api/register', '/api/verify-email', '/api/password/forgot', '/api/password/reset', '/api/account/email/confirm', '/api/party-links/confirm', '/api/kyc/webhook/:provider', '/api/investee/view', '/api/investee/files', '/api/investee/files/remove', '/api/investee/submit', '/api/invite/open', '/api/invite/pending', '/api/instructions/verify', '/api/complaints/channel']))
  })
  it('the static route serves the page, refuses a path outside its folder and never answers for the API', async () => {
    const web = mkdtempSync(join(tmpdir(), 'bulma-web-'))
    writeFileSync(join(web, 'index.html'), '<title>page</title>')
    writeFileSync(join(web, 'a.js'), 'x')
    const s = await buildServer({ db: t.app, k: t.keyring, webRoot: web, secureCookies: false })
    const get = (url: string) => s.inject({ method: 'GET', url })
    expect((await get('/')).body).toContain('page')
    expect((await get('/a.js')).body).toBe('x')
    expect((await get('/deep/link')).body).toContain('page')
    expect((await get('/..%2f..%2f..%2fetc%2fpasswd')).body).toContain('page')
    expect((await get('/%E0%A4%A')).statusCode).toBe(400)
    expect((await get('/api/nothing')).statusCode).toBe(404)
    expect((await get('/api/instance')).statusCode).toBe(401)
    await s.close()
  })
  it('TC-AUTHZ-01 an unsigned caller gets nothing from any non-public route; a non-admin nothing from an admin route', async () => {
    const a = app as FastifyInstance & { routeTable: Array<{ method: string; url: string; gate: string }> }
    const plain = await person('plain@example.test', [])
    for (const r of a.routeTable.filter((x) => x.gate !== 'public')) {
      const url = r.url.replace(':id', '00000000-0000-4000-8000-000000000000').replace(':role', 'admin').replace(':currency', 'GBP').replace(':party', '00000000-0000-4000-8000-000000000000')
      for (const method of r.method.split(',')) {
        expect((await call(method, url)).statusCode, `${method} ${url}`).toBe(401)
        if (r.gate === 'canAdministerInstance' || r.gate === 'canReadAudit' || r.gate === 'canRunOperations' || r.gate === 'canReviewKyc') expect((await call(method, url, plain)).statusCode, `${method} ${url}`).toBe(403)
      }
    }
  })
})

describe('sandbox', () => {
  it('TC-OP-01 starts as a sandbox with a banner; fictional payment details only; nothing accepts payment details', async () => {
    const n = (await call('GET', '/api/instance/notice')).json()
    expect(n.mode).toBe('sandbox')
    expect(n.banner).toBe(SANDBOX_BANNER)
    const p = (await call('GET', '/api/sandbox/payment-instruction/GBP', first)).json()
    expect(p.fictional).toBe(true)
    expect((await call('GET', '/api/sandbox/payment-instruction/XYZ', first)).statusCode).toBe(400)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const url of ['/api/sandbox/payment-instruction/GBP', '/api/payment-instructions', '/api/payment-instruction']) {
        expect((await call(method, url, first, method === 'DELETE' ? undefined : PAYMENT[0])).statusCode, `${method} ${url}`).toBe(404)
      }
    }
    const a = app as FastifyInstance & { routeTable: Array<{ method: string; url: string }> }
    expect(a.routeTable.filter((r) => /payment/i.test(r.url) && r.method !== 'GET' && r.method !== 'HEAD' && r.method !== 'GET,HEAD')).toEqual([])
    expect((await t.owner.query('SELECT 1 FROM payment_instruction')).rowCount).toBe(0)
  })
  it('TC-OP-01 the sandbox uses fakes even when real adapters are configured; its mail stays in the database', async () => {
    let sent = 0
    const real: Mailer = { send: async () => (sent++, { delivered: true }) }
    const a = selectAdapters('sandbox', t.app, { mailer: real, storage: new LocalStorage(paymentDir) })
    expect(a.mailer).toBeInstanceOf(FakeOutbox)
    expect(a.kyc).toBeInstanceOf(FakeKyc)
    expect(a.signature).toBeInstanceOf(FakeSignature)
    expect(a.storage).toBeInstanceOf(MemoryStorage)
    expect(a.scanner).toBeInstanceOf(FakeScanner)
    expect(await a.mailer.send({ to: 'x@example.test', subject: 's', body: 'b' })).toEqual({ delivered: false })
    expect(sent).toBe(0)
    expect((await t.owner.query('SELECT 1 FROM sandbox_outbox')).rowCount).toBe(1)
    expect(selectAdapters('real', t.app, { mailer: real }).mailer).toBe(real)
    expect(() => selectAdapters('real', t.app).mailer.send({ to: '', subject: '', body: '' })).toThrow(/no mail adapter/)
  })
  it('TC-OP-01 adapters: fakes behave, and local storage stays inside its folder', async () => {
    const s = new LocalStorage(paymentDir)
    await s.put('a/b.txt', Buffer.from('x'))
    expect((await s.get('a/b.txt'))!.toString()).toBe('x')
    await s.delete('a/b.txt')
    expect(await s.get('a/b.txt')).toBeNull()
    await expect(s.put('../escape', Buffer.from('x'))).rejects.toThrow(/outside/)
    await expect(s.get('../../etc/passwd')).rejects.toThrow(/outside/)
    const m = new MemoryStorage()
    await m.put('k', Buffer.from('v'))
    expect((await m.get('k'))!.toString()).toBe('v')
    await m.delete('k')
    expect(await m.get('k')).toBeNull()
    const f = new FakeKyc()
    expect((await f.start('e')).ref).toBe('fake-e')
    const hook = (o: unknown) => ({ rawBody: Buffer.from(JSON.stringify(o)), headers: {} })
    expect(f.parseWebhook(hook({ ref: 'r', answer: 'GREEN' }))).toEqual({ ref: 'r', answer: 'GREEN' })
    expect(f.parseWebhook(hook({ ref: 'r', answer: 'RED', rejectType: 'FINAL' }))).toEqual({ ref: 'r', answer: 'RED', rejectType: 'FINAL' })
    expect(() => f.parseWebhook(hook({ ref: 'r', answer: 'maybe' }))).toThrow()
    expect(() => f.parseWebhook(hook({ answer: 'GREEN' }))).toThrow()
    const g = new FakeSignature()
    const { ref } = await g.start('a'.repeat(64), 'u')
    expect(await g.status(ref)).toBe('pending')
    g.sign(ref)
    expect(await g.status(ref)).toBe('signed')
    expect(await new FakeScanner().scan(Buffer.from('fine'))).toEqual({ clean: true })
    expect(await new FakeScanner().scan(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))).toEqual({ clean: false, signature: 'Fake.EICAR' })
  })
  it('TC-OP-06 serving and signing in opens no connection except to the database; the static checks pass and fail correctly', async () => {
    const seen: string[] = []
    const original = net.Socket.prototype.connect
    const db = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x@localhost:55433/')
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      const target = connectTarget(args)
      if (target && !isDatabase(target, db.hostname, Number(db.port))) seen.push(`${target.host}:${target.port}`)
      return (original as (...a: unknown[]) => net.Socket).apply(this, args)
    } as typeof net.Socket.prototype.connect
    const fetched: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (u: string) => {
      fetched.push(String(u))
      throw new Error('no outside request allowed')
    }) as typeof fetch
    try {
      await call('GET', '/api/health')
      await call('GET', '/api/instance/notice')
      await call('GET', '/api/instance', first)
      await call('GET', '/api/packs', first)
      await signIn('first@example.test', 'first-admin-password-2')
    } finally {
      net.Socket.prototype.connect = original
      globalThis.fetch = realFetch
    }
    expect(seen).toEqual([])
    expect(fetched).toEqual([])
    // the watcher itself: another host on the database's port is outside, in every call form
    expect(connectTarget([5432, 'outside.example'])).toEqual({ port: 5432, host: 'outside.example' })
    expect(connectTarget([{ port: 5432, host: 'outside.example' }])).toEqual({ port: 5432, host: 'outside.example' })
    expect(connectTarget([[{ port: '5432', host: 'outside.example' }, null]])).toEqual({ port: 5432, host: 'outside.example' })
    expect(connectTarget([{ path: '/tmp/x.sock' }])).toBeNull()
    expect(isDatabase({ host: 'outside.example', port: Number(db.port) }, db.hostname, Number(db.port))).toBe(false)
    expect(isDatabase({ host: db.hostname, port: 1 }, db.hostname, Number(db.port))).toBe(false)
    expect(isDatabase({ host: db.hostname, port: Number(db.port) }, db.hostname, Number(db.port))).toBe(true)
    expect(execFileSync('node', ['scripts/check-outbound.mjs'], { encoding: 'utf8' })).toContain('outbound check passed')
    const { scan, scanPackages } = await import('../../scripts/check-outbound.mjs' as string)
    expect(scan('src/server/x.ts', "await fetch('https://telemetry.example.com')").length).toBe(2)
    expect(scan('src/server/x.ts', "import http from 'node:https'").length).toBe(1)
    expect(scan('src/web/x.tsx', 'navigator.sendBeacon(u)').length).toBe(1)
    expect(scan('src/x.ts', 'http://localhost.evil.example/a').length).toBe(1)
    expect(scan('src/x.ts', "'http://localhost:8080/a'")).toEqual([])
    expect(scanPackages({ dependencies: { '@sentry/node': '1' } }).length).toBe(1)
    expect(scanPackages({ dependencies: { pg: '1' } })).toEqual([])
  })
})

describe('switching to the real mode', () => {
  let packId: string

  it('TC-OP-03 the page carries the warning; TC-OP-02 the labels are the agreed ones', async () => {
    const i = (await call('GET', '/api/instance', first)).json()
    expect(i.switch_warning).toBe(SWITCH_WARNING)
    expect(SWITCH_WARNING).toMatch(/does not make anyone compliant/)
    expect(SWITCH_WARNING).toMatch(/get its own legal advice/)
    expect(i.accountable_label).toBe(ACCOUNTABLE_LABEL)
    expect(ACCOUNTABLE_LABEL).toBe('Operator accountable person')
    expect((await call('GET', '/api/packs', first)).json().format_passed).toBe(PACK_FORMAT_PASSED)
  })
  it('TC-OP-02 refused and every gap listed; TC-OP-03 the refusal is audited', async () => {
    const before = await auditCount('instance.switch_refused')
    const r = await call('POST', '/api/requests/mode-switch', first, SWITCH)
    expect(r.statusCode).toBe(409)
    const got = r.json().blockers.map((b: { code: string }) => b.code)
    expect(got).toEqual(expect.arrayContaining(['placeholder_texts', 'approver', 'separation']))
    expect(await auditCount('instance.switch_refused')).toBe(before + 1)
    expect((await call('GET', '/api/instance', first)).json().mode).toBe('sandbox')
  })
  it('TC-OP-02 an appointed representative cannot switch but can be chosen in the sandbox', async () => {
    const r = await call('POST', '/api/requests/mode-switch', first, { ...SWITCH, regulatory_status: 'appointed_representative' })
    expect(r.json().blockers.map((b: { code: string }) => b.code)).toContain('appointed_representative')
    const req = await call('POST', '/api/requests/profile', first, { ...SWITCH, regulatory_status: 'appointed_representative' })
    expect(req.statusCode).toBe(200)
    expect((await call('POST', `/api/requests/${req.json().id}/approve`, first)).statusCode).toBe(200)
    expect((await call('GET', '/api/instance', first)).json().regulatory_status).toBe('appointed_representative')
    expect(await auditCount('instance.profile_changed')).toBe(1)
  })
  it('hostile request bodies are refused', async () => {
    for (const body of [{}, { ...SWITCH, extra: 1 }, { ...SWITCH, regulatory_status: 'martian' }, { ...SWITCH, accountable_confirmed_on: '2026-02-30' }, { ...SWITCH, accountable_person: 'x'.repeat(201) }, null]) {
      expect((await call('POST', '/api/requests/mode-switch', first, body ?? undefined)).statusCode).toBe(400)
    }
    expect((await call('POST', '/api/requests/not-a-uuid/approve', first)).statusCode).toBe(400)
    expect((await call('POST', '/api/requests/00000000-0000-4000-8000-000000000000/approve', first)).statusCode).toBe(409)
    expect((await call('PUT', `/api/users/${first.id}/roles/superuser`, first)).statusCode).toBe(400)
  })
  it('TC-OP-04 a new pack is format-checked, does nothing until approved, and a second admin must approve once there are two', async () => {
    const bad = await call('POST', '/api/packs', first, { ...fullPack('bad-pack'), terminal_can_see_promotion: true })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().errors.join()).toContain('d:')
    expect((await call('POST', '/api/packs', first, fullPack('uk-fpo-template'))).statusCode).toBe(409)
    expect((await call('POST', '/api/packs', first, { ...fullPack('uk-new-template'), key: 'uk-new-template' })).json().error).toMatch(/kept for packs shipped/)
    const cobs = readBuiltInPacks().find((p) => p.key === 'uk-cobs-template')!
    expect((await call('POST', '/api/packs', first, fullPack('regime-moves'))).statusCode).toBe(200)
    const moved = await call('POST', '/api/packs', first, { ...cobs, key: 'regime-moves', version: 3 })
    expect(moved.statusCode).toBe(409)
    expect(moved.json().error).toMatch(/cannot change regime/)
    const added = await call('POST', '/api/packs', first, fullPack('operator-pack'))
    expect(added.statusCode).toBe(200)
    expect(added.json().format_passed).toBe(PACK_FORMAT_PASSED)
    packId = added.json().id
    expect((await call('POST', '/api/packs', first, fullPack('operator-pack'))).statusCode).toBe(409)
    expect((await call('GET', '/api/instance', first)).json().active_pack).toContain('uk-fpo-template')

    second = await person('second@example.test', ['admin', 'approver'])
    const req = (await call('POST', '/api/requests/pack-activate', first, { pack_id: packId })).json().id
    const shown = (await call('GET', '/api/requests', second)).json().requests.find((r: { id: string }) => r.id === req)
    expect(JSON.stringify(shown.details)).toContain('operator-pack version 2')
    // the wording itself is shown, and the whole pack can be read
    expect(JSON.stringify(shown.details)).toContain('Operator wording for commitment_effect.')
    expect(JSON.stringify(shown.details)).toContain('Changed text commitment_effect/default')
    const whole = (await call('GET', `/api/packs/${packId}`, second)).json()
    expect(whole.content.key).toBe('operator-pack')
    expect(whole.content.legal_texts.length).toBeGreaterThan(3)
    expect((await call('GET', '/api/packs/00000000-0000-4000-8000-000000000000', second)).statusCode).toBe(404)
    const refusedBefore = await auditCount('request.approval_refused')
    const self = await call('POST', `/api/requests/${req}/approve`, first)
    expect(self.statusCode).toBe(409)
    expect(self.json().error).toMatch(/second admin/)
    expect(await auditCount('request.approval_refused')).toBe(refusedBefore + 1)
    expect((await call('GET', '/api/instance', first)).json().active_pack).toContain('uk-fpo-template')
    expect((await call('POST', `/api/requests/${req}/approve`, second)).statusCode).toBe(200)
    expect((await call('GET', '/api/instance', first)).json().active_pack).toContain('operator-pack')
    expect((await call('POST', `/api/requests/${req}/approve`, second)).statusCode).toBe(409)
    expect((await call('POST', '/api/requests/pack-activate', first, { pack_id: packId })).statusCode).toBe(409)
  })
  it('TC-OP-02 a stale request is refused: it was asked of an instance that has since changed', async () => {
    const older = (await call('POST', '/api/requests/profile', first, { ...SWITCH, accountable_person: 'Older Answer' })).json().id
    const newer = (await call('POST', '/api/requests/profile', first, { ...SWITCH, accountable_person: 'Newer Answer' })).json().id
    expect((await call('POST', `/api/requests/${newer}/approve`, second)).statusCode).toBe(200)
    const stale = await call('POST', `/api/requests/${older}/approve`, second)
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatch(/changed after this was asked/)
    expect((await call('GET', '/api/instance', first)).json().accountable_person).toBe('Newer Answer')
  })
  it('TC-OP-02 a pack flipping its placeholder flag with the shipped words still in it cannot reach the real mode', async () => {
    const p = readBuiltInPacks().find((x) => x.key === 'uk-fpo-template')!
    const sly = { ...p, key: 'sly-pack', legal_texts: p.legal_texts.map((x) => ({ ...x, is_placeholder: false })), assessment: { ...p.assessment, questions: p.assessment.questions.map((q) => ({ ...q, is_placeholder: false })) } }
    const id = (await call('POST', '/api/packs', first, sly)).json().id
    const asked = (await call('POST', '/api/requests/pack-activate', first, { pack_id: id })).json().id
    expect((await call('POST', `/api/requests/${asked}/approve`, second)).statusCode).toBe(200)
    const r = await call('POST', '/api/requests/mode-switch', first, SWITCH)
    expect(r.json().blockers.map((b: { code: string }) => b.code)).toContain('placeholder_texts')
    const back = (await call('GET', '/api/packs', first)).json().packs.find((x: { key: string }) => x.key === 'operator-pack').id
    const undo = (await call('POST', '/api/requests/pack-activate', first, { pack_id: back })).json().id
    expect((await call('POST', `/api/requests/${undo}/approve`, second)).statusCode).toBe(200)
  })
  it('TC-OP-04 a pack stored under older rules is judged by today\'s rules on activation and on the switch', async () => {
    const p = fullPack('old-rules')
    const id = '11111111-1111-4111-8111-111111111111'
    const weak = { ...p, steps: p.steps.map((x) => ({ ...x, qualifying: false })) }
    await t.owner.query("INSERT INTO regime_pack (id, key, version, regime, content, content_sha256) VALUES ($1, 'old-rules', 1, 'uk-fpo', $2, 'x')", [id, JSON.stringify(weak)])
    const r = await call('POST', '/api/requests/pack-activate', first, { pack_id: id })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/no longer passes the format check/)
  })
  it('TC-OP-02 payment file: a broken one says so, and a missing one says configure', async () => {
    writeFileSync(paymentFile, '{broken')
    expect((await call('GET', '/api/instance', first)).json().blockers.map((b: { message: string }) => b.message).join()).toMatch(/documented format/)
    writeFileSync(paymentFile, JSON.stringify([{ ...PAYMENT[0], holder: '' }]))
    expect((await call('GET', '/api/instance', first)).json().blockers.map((b: { message: string }) => b.message).join()).toMatch(/documented format/)
    writeFileSync(paymentFile, JSON.stringify(PAYMENT))
    const none = await buildServer({ db: t.app, k: t.keyring, paymentFile: join(paymentDir, 'absent.json') })
    const res = await none.inject({ method: 'GET', url: '/api/instance', headers: { cookie: first.cookie } })
    expect(res.json().blockers.map((b: { message: string }) => b.message).join()).toMatch(/Configure the payment instructions/)
    await none.close()
  })
  it('TC-OP-04 two uploads at once cannot give one pack two regimes', async () => {
    const cobs = readBuiltInPacks().find((p) => p.key === 'uk-cobs-template')!
    const rs = await Promise.all([
      call('POST', '/api/packs', first, fullPack('same-pack')),
      call('POST', '/api/packs', first, { ...cobs, key: 'same-pack', version: 2 }),
    ])
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(new Set((await t.owner.query<{ regime: string }>("SELECT regime FROM regime_pack WHERE key = 'same-pack'")).rows.map((r) => r.regime)).size).toBe(1)
  })
  it('TC-STAT-03 a "your money" panel only under an unreachable variant does not count', async () => {
    const p = fullPack('hidden-panel')
    const hidden = { ...p, legal_texts: p.legal_texts.map((x) => (x.text_key === 'your_money' ? { ...x, variant: 'unreachable' } : x)) }
    const id = (await call('POST', '/api/packs', first, hidden)).json().id
    const asked = (await call('POST', '/api/requests/pack-activate', first, { pack_id: id })).json().id
    expect((await call('POST', `/api/requests/${asked}/approve`, second)).statusCode).toBe(200)
    expect((await call('GET', '/api/instance', first)).json().blockers.map((b: { code: string }) => b.code)).toContain('your_money')
    const back = (await call('GET', '/api/packs', first)).json().packs.find((x: { key: string }) => x.key === 'operator-pack').id
    const undo = (await call('POST', '/api/requests/pack-activate', first, { pack_id: back })).json().id
    expect((await call('POST', `/api/requests/${undo}/approve`, second)).statusCode).toBe(200)
  })
  it('TC-OP-04 stored pack rows cannot change', async () => {
    await expect(t.app.query("UPDATE regime_pack SET key = 'x'")).rejects.toThrow()
    await expect(t.owner.query("UPDATE regime_pack SET key = 'x'")).rejects.toThrow(/only takes new rows/)
    await expect(t.owner.query("UPDATE legal_text SET body = 'x'")).rejects.toThrow(/only takes new rows/)
    await expect(t.owner.query('DELETE FROM assessment_question')).rejects.toThrow(/only takes new rows/)
  })
  it('TC-OP-02 the same person cannot be two of the three', async () => {
    const both = await person('both@example.test', ['admin', 'reviewer'])
    await call('DELETE', `/api/users/${first.id}/roles/admin`, second)
    const r = await call('POST', '/api/requests/mode-switch', second, SWITCH)
    expect(r.json().blockers.map((b: { code: string }) => b.code)).toContain('separation')
    await call('PUT', `/api/users/${first.id}/roles/admin`, second)
    await call('DELETE', `/api/users/${both.id}/roles/reviewer`, second)
    await call('POST', `/api/users/${both.id}/disable`, second)
  })
  it('TC-OP-02 / TC-OP-03 with everything in place: asked once, second admin approves, audited, details stored', async () => {
    reviewer = await person('reviewer@example.test', ['reviewer'])
    expect((await call('GET', '/api/instance', first)).json().blockers).toEqual([])
    const asked = await call('POST', '/api/requests/mode-switch', first, SWITCH)
    expect(asked.statusCode).toBe(200)
    const id = asked.json().id
    // the approver sees the account, holder and capacity before approving
    const shown = JSON.stringify((await call('GET', '/api/requests', second)).json().requests.find((r: { id: string }) => r.id === id).details)
    for (const part of ['12345678', '11-22-33', 'Example Client Money Ltd', 'Regulated client money provider', '123456', 'Accountable Example', 'authorised_firm', 'GBP refund days', '10', 'Checked on the statement.', 'Operator wording for your_money.']) expect(shown).toContain(part)
    expect((await call('GET', '/api/instance/notice')).json().mode).toBe('sandbox')
    const self = await call('POST', `/api/requests/${id}/approve`, first)
    expect(self.statusCode).toBe(409)
    expect((await call('POST', `/api/requests/${id}/approve`, reviewer)).statusCode).toBe(403)

    // something needed went away after the request: refused and listed, nothing moves
    await call('DELETE', `/api/users/${second.id}/roles/approver`, first)
    const gone = await call('POST', `/api/requests/${id}/approve`, second)
    expect(gone.statusCode).toBe(409)
    expect(gone.json().blockers.map((b: { code: string }) => b.code)).toEqual(['approver'])
    await call('PUT', `/api/users/${second.id}/roles/approver`, first)

    // payment details changed after the request: refused, nothing moves
    writeFileSync(paymentFile, JSON.stringify([{ ...PAYMENT[0], holder: 'Someone Else Ltd' }]))
    const changed = await call('POST', `/api/requests/${id}/approve`, second)
    expect(changed.statusCode).toBe(409)
    expect(changed.json().error).toMatch(/payment details changed/)
    expect(JSON.stringify((await call('GET', '/api/requests', second)).json().requests.find((r: { id: string }) => r.id === id).details)).toContain('file has changed')
    writeFileSync(paymentFile, JSON.stringify(PAYMENT))

    expect((await call('POST', `/api/requests/${id}/approve`, second)).statusCode).toBe(200)
    expect((await call('GET', '/api/instance/notice')).json()).toMatchObject({ mode: 'real', banner: null })
    expect(await auditCount('instance.switched_to_real.authorised_firm')).toBe(1)
    const row = (await t.owner.query('SELECT prepared_by, approved_by, holder FROM payment_instruction')).rows
    expect(row).toEqual([{ prepared_by: first.id, approved_by: second.id, holder: 'Example Client Money Ltd' }])
    expect((await call('GET', '/api/sandbox/payment-instruction/GBP', first)).statusCode).toBe(404)
  })
  it('TC-OP-02 in the real mode: no way back in through self-approval, a profile that breaks the rules, or a placeholder pack', async () => {
    expect((await call('POST', '/api/requests/mode-switch', first, SWITCH)).statusCode).toBe(409)
    const ar = await call('POST', '/api/requests/profile', first, { ...SWITCH, regulatory_status: 'appointed_representative' })
    expect(ar.statusCode).toBe(409)
    expect((await call('POST', '/api/requests/profile', first, { ...SWITCH, accountable_person: ' ' })).statusCode).toBe(409)
    const ok = await call('POST', '/api/requests/profile', first, { ...SWITCH, regulatory_status: 'unauthorised_relying_on_exemption' })
    expect(ok.statusCode).toBe(200)
    expect((await call('POST', `/api/requests/${ok.json().id}/approve`, first)).statusCode).toBe(409)
    expect((await call('POST', `/api/requests/${ok.json().id}/approve`, second)).statusCode).toBe(200)
    const packs = (await call('GET', '/api/packs', first)).json().packs
    const placeholder = packs.find((p: { key: string }) => p.key === 'uk-cobs-template')
    const refused = await call('POST', '/api/requests/pack-activate', first, { pack_id: placeholder.id })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/placeholder/)
    await expect(t.owner.query("UPDATE instance_profile SET regulatory_status = 'appointed_representative'")).rejects.toThrow(/real_mode_profile/)
  })
  it('TC-OP-02 in the real mode: the separation cannot be undone, and every role change needs a second admin', async () => {
    const rolesOf = async (id: string) => (await call('GET', '/api/users', first)).json().users.find((u: { id: string }) => u.id === id).roles
    expect((await call('DELETE', `/api/users/${reviewer.id}/roles/reviewer`, first)).statusCode).toBe(409)
    expect((await call('POST', `/api/users/${reviewer.id}/disable`, first)).statusCode).toBe(409)
    expect((await call('DELETE', `/api/users/${second.id}/roles/approver`, first)).statusCode).toBe(409)
    expect((await call('DELETE', `/api/users/${second.id}/roles/admin`, first)).statusCode).toBe(409)
    const sock = await person('sock.puppet@example.test', [])
    for (const role of ['admin', 'reviewer', 'approver']) {
      const g = await call('PUT', `/api/users/${sock.id}/roles/${role}`, first)
      expect(g.json().requestId, role).toBeTruthy()
      expect(await rolesOf(sock.id)).toEqual([])
      expect((await call('POST', `/api/requests/${g.json().requestId}/approve`, first)).statusCode, role).toBe(409)
      expect(await rolesOf(sock.id)).toEqual([])
      const shown = JSON.stringify((await call('GET', '/api/requests', second)).json().requests.find((r: { id: string }) => r.id === g.json().requestId).details)
      expect(shown).toContain('sock.puppet@example.test')
      expect(shown).toContain(role)
      expect((await call('POST', `/api/requests/${g.json().requestId}/reject`, second)).statusCode).toBe(200)
    }
    const g2 = await call('PUT', `/api/users/${sock.id}/roles/admin`, first)
    expect((await call('POST', `/api/requests/${g2.json().requestId}/approve`, second)).statusCode).toBe(200)
    expect(await rolesOf(sock.id)).toEqual(['admin'])
    // a revoke waits too, and is judged again when approved
    const r1 = await call('DELETE', `/api/users/${sock.id}/roles/admin`, first)
    expect(await rolesOf(sock.id)).toEqual(['admin'])
    expect((await call('POST', `/api/requests/${r1.json().requestId}/approve`, second)).statusCode).toBe(200)
    expect(await rolesOf(sock.id)).toEqual([])
    const r2 = await call('PUT', `/api/users/${sock.id}/roles/reviewer`, first)
    await call('POST', `/api/requests/${r2.json().requestId}/approve`, second)
    const dropReal = await call('DELETE', `/api/users/${reviewer.id}/roles/reviewer`, first)
    const dropSock = await call('DELETE', `/api/users/${sock.id}/roles/reviewer`, first)
    expect((await call('POST', `/api/requests/${dropReal.json().requestId}/approve`, second)).statusCode).toBe(200)
    const late = await call('POST', `/api/requests/${dropSock.json().requestId}/approve`, second)
    expect(late.statusCode).toBe(409)
    expect(late.json().error).toMatch(/three different/)
    const restore = await call('PUT', `/api/users/${reviewer.id}/roles/reviewer`, first)
    await call('POST', `/api/requests/${restore.json().requestId}/approve`, second)
  })
  it('TC-OP-02 in the real mode, disabling someone with a role waits for a second admin; someone with no role goes at once', async () => {
    const extra = await person('extra.reviewer@example.test', [])
    const g = await call('PUT', `/api/users/${extra.id}/roles/reviewer`, first)
    await call('POST', `/api/requests/${g.json().requestId}/approve`, second)
    const client = await signIn('extra.reviewer@example.test', PW)
    const asked = await call('POST', `/api/users/${extra.id}/disable`, first)
    expect(asked.statusCode).toBe(200)
    const id = asked.json().requestId
    expect(id).toBeTruthy()
    expect((await call('GET', '/api/session', client)).statusCode).toBe(200)
    expect(JSON.stringify((await call('GET', '/api/requests', second)).json().requests.find((r: { id: string }) => r.id === id).details)).toContain('extra.reviewer@example.test')
    expect((await call('POST', `/api/requests/${id}/approve`, first)).statusCode).toBe(409)
    expect((await call('GET', '/api/session', client)).statusCode).toBe(200)
    expect((await call('POST', `/api/requests/${id}/approve`, second)).statusCode).toBe(200)
    expect((await call('GET', '/api/session', client)).statusCode).toBe(401)
    // judged again on approval: every reviewer asked out while there were spares, and the last one cannot go
    const a = await person('spare.reviewer@example.test', [])
    const g2 = await call('PUT', `/api/users/${a.id}/roles/reviewer`, first)
    await call('POST', `/api/requests/${g2.json().requestId}/approve`, second)
    const users = (await call('GET', '/api/users', first)).json().users as Array<{ id: string; roles: string[]; disabled_at: string | null }>
    const reviewers = users.filter((u) => u.roles.includes('reviewer') && !u.disabled_at)
    expect(reviewers.length).toBeGreaterThan(1)
    const asks = await Promise.all(reviewers.map(async (u) => (await call('POST', `/api/users/${u.id}/disable`, first)).json().requestId as string))
    const results: number[] = []
    let lastError = ''
    for (const ask of asks) {
      const r = await call('POST', `/api/requests/${ask}/approve`, second)
      results.push(r.statusCode)
      if (r.statusCode !== 200) lastError = r.json().error
    }
    expect(results).toEqual([...reviewers.slice(1).map(() => 200), 409])
    expect(lastError).toMatch(/three different/)
    const none = await person('no.role@example.test', [])
    const direct = await call('POST', `/api/users/${none.id}/disable`, first)
    expect(direct.json().requestId).toBeUndefined()
    expect((await call('GET', '/api/session', none)).statusCode).toBe(401)
  })
  it('TC-OP-02 an older role request cannot undo a newer decision', async () => {
    const c = await person('role.target@example.test', [])
    const rolesOf = async () => (await call('GET', '/api/users', first)).json().users.find((u: { id: string }) => u.id === c.id).roles
    const older = (await call('PUT', `/api/users/${c.id}/roles/admin`, first)).json().requestId
    const newer = (await call('PUT', `/api/users/${c.id}/roles/admin`, first)).json().requestId
    const otherRole = (await call('PUT', `/api/users/${c.id}/roles/approver`, first)).json().requestId
    expect((await call('POST', `/api/requests/${newer}/approve`, second)).statusCode).toBe(200)
    const removal = (await call('DELETE', `/api/users/${c.id}/roles/admin`, first)).json().requestId
    expect((await call('POST', `/api/requests/${removal}/approve`, second)).statusCode).toBe(200)
    const again = await call('POST', `/api/requests/${older}/approve`, second)
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toMatch(/already been decided/)
    expect(await rolesOf()).toEqual([])
    expect(await auditCount('request.superseded.role_change')).toBeGreaterThanOrEqual(1)
    // a request about another role is untouched
    expect((await call('POST', `/api/requests/${otherRole}/reject`, second)).statusCode).toBe(200)
  })
  it('TC-OP-02 an admin removed before the lock cannot act; parallel approvals of one request give one success', async () => {
    const gone = await person('gone@example.test', [])
    const g = await call('PUT', `/api/users/${gone.id}/roles/admin`, first)
    const results = await Promise.all([1, 2, 3].map(() => call('POST', `/api/requests/${g.json().requestId}/approve`, second)))
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409])
    const client = await signIn('gone@example.test', PW)
    const asked = await call('POST', '/api/requests/profile', client, SWITCH)
    expect(asked.statusCode).toBe(200)
    const out = await call('DELETE', `/api/users/${gone.id}/roles/admin`, first)
    await call('POST', `/api/requests/${out.json().requestId}/approve`, second)
    const r = await call('POST', `/api/requests/${asked.json().id}/approve`, second)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/no longer an admin/)
    await call('POST', `/api/users/${gone.id}/disable`, first)
    expect((await call('GET', '/api/session', client)).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'gone@example.test', password: PW }, remoteAddress: '10.7.0.1' })).statusCode).toBe(401)
  })
  it('TC-OP-02 a request cannot be rewritten by the application role, and what was asked is fixed in the audit chain', async () => {
    const asked = (await call('POST', '/api/requests/profile', first, { ...SWITCH, accountable_person: 'Fixed Answer' })).json().id
    await expect(t.app.query("UPDATE admin_request SET payload = '{}' WHERE id = $1", [asked])).rejects.toThrow(/cannot be rewritten/)
    await expect(t.app.query('UPDATE admin_request SET requested_by = $2 WHERE id = $1', [asked, second.id])).rejects.toThrow(/cannot be rewritten/)
    expect((await call('POST', `/api/requests/${asked}/approve`, second)).statusCode).toBe(200)
    await expect(t.app.query("UPDATE admin_request SET status = 'rejected' WHERE id = $1", [asked])).rejects.toThrow(/cannot be rewritten/)
    await expect(t.app.query("UPDATE admin_request SET decided_at = now() WHERE id = $1", [asked])).rejects.toThrow(/cannot be rewritten/)
    await expect(t.app.query('DELETE FROM admin_request WHERE id = $1', [asked])).rejects.toThrow()
    const d = (await t.owner.query<{ detail: string; detail_hmac: string }>("SELECT d.detail, a.detail_hmac FROM audit a JOIN audit_detail d ON d.audit_seq = a.seq WHERE a.action = 'request.created.profile_change' AND a.entity_id = $1", [asked])).rows[0]!
    expect(d.detail).toContain('Fixed Answer')
    expect(d.detail_hmac).toBe(t.keyring.hmac(`audit-detail\0${d.detail}`))
  })
  it('TC-OP-02 an admin removed while a change waits for the lock cannot complete it', async () => {
    const late = await person('late.admin@example.test', ['admin'])
    const base = { rate_bps: 1, min_minor: '0', max_minor: '0', surcharge_threshold_minor: '0', surcharge_bps: 0 }
    const attempts: Array<[string, unknown]> = [['/api/fee-config', base], ['/api/users', { email: 'made.late@example.test', name: 'x', password: PW }], ['/api/packs', fullPack('late-pack')]]
    for (const [url, body] of attempts) {
      await t.owner.query('INSERT INTO role_grant (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING', [late.id, 'admin'])
      const hold = await t.owner.connect()
      try {
        await hold.query('BEGIN')
        await hold.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
        const pending = call('POST', url, late, body)
        for (let i = 0; i < 200; i++) {
          const w = await t.owner.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%instance_profile%'")
          if (w.rowCount) break
          await new Promise((r) => setTimeout(r, 10))
        }
        await hold.query('DELETE FROM role_grant WHERE user_id = $1', [late.id])
        await hold.query('COMMIT')
        const r = await pending
        expect(r.statusCode, url).toBe(409)
        expect(r.json().error, url).toMatch(/Only an admin/)
      } finally {
        hold.release()
      }
    }
    expect((await t.owner.query("SELECT 1 FROM user_account WHERE email = 'made.late@example.test'")).rowCount).toBe(0)
    expect((await t.owner.query("SELECT 1 FROM regime_pack WHERE key = 'late-pack'")).rowCount).toBe(0)
    expect((await t.owner.query('SELECT 1 FROM fee_config')).rowCount).toBe(0)
  })
  it('TC-OP-02 a session that ends while a change waits for the lock cannot complete it', async () => {
    const admin2 = await person('session.ends@example.test', ['admin'])
    const hold = await t.owner.connect()
    try {
      await hold.query('BEGIN')
      await hold.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
      const pending = call('POST', '/api/fee-config', admin2, { rate_bps: 1, min_minor: '0', max_minor: '0', surcharge_threshold_minor: '0', surcharge_bps: 0 })
      for (let i = 0; i < 200; i++) {
        const w = await t.owner.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%instance_profile%' AND pid <> pg_backend_pid()")
        if (w.rowCount) break
        await new Promise((r) => setTimeout(r, 10))
      }
      await t.owner.query('UPDATE user_account SET credential_version = credential_version + 1 WHERE id = $1', [admin2.id])
      await hold.query('COMMIT')
      const r = await pending
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toMatch(/session has ended/)
    } finally {
      hold.release()
    }
    expect((await t.owner.query('SELECT 1 FROM fee_config')).rowCount).toBe(0)
    await t.owner.query('DELETE FROM role_grant WHERE user_id = $1', [admin2.id])
  })
  it('TC-OP-02 / TC-OP-05 the database itself refuses an approval by the person who asked, and payment details prepared and approved by one person', async () => {
    const r = await t.owner.query<{ id: string; requested_by: string }>("SELECT id, requested_by FROM admin_request WHERE status = 'pending' LIMIT 1")
    await expect(t.owner.query("UPDATE admin_request SET status = 'approved', decided_by = requested_by WHERE id = $1", [r.rows[0]!.id])).rejects.toThrow(/second_person/)
    await expect(t.owner.query(
      "INSERT INTO payment_instruction (id, currency, version, account_fields, holder, holder_capacity, asserted_client_money, your_money_text_key, refund_days, receipt_check_note, prepared_by, approved_by) VALUES (gen_random_uuid(), 'USD', 1, '{}', 'h', 'c', false, 'k', 1, 'n', $1, $1)",
      [first.id],
    )).rejects.toThrow(/second_person/)
    await expect(t.owner.query('UPDATE payment_instruction SET holder = $1', ['x'])).rejects.toThrow(/only takes new rows/)
  })
})

describe('fee configuration', () => {
  it('TC-FEE-10 through the API: refused and accepted, versioned, audited, no built-in price', async () => {
    expect((await call('GET', '/api/fee-config', first)).json().fee_config).toBeNull()
    const base = { rate_bps: 0, min_minor: '0', max_minor: '0', surcharge_threshold_minor: '0', surcharge_bps: 0 }
    const bad = await call('POST', '/api/fee-config', first, { ...base, min_minor: '2', max_minor: '1' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/minimum fee/)
    expect((await call('POST', '/api/fee-config', first, { ...base, rate_bps: 2.5 })).statusCode).toBe(400)
    expect((await call('POST', '/api/fee-config', first, { ...base, min_minor: '-1' })).statusCode).toBe(400)
    expect((await call('POST', '/api/fee-config', first, { ...base, min_minor: '1e5' })).statusCode).toBe(400)
    expect((await call('POST', '/api/fee-config', first, { ...base, max_minor: '9223372036854775808' })).statusCode).toBe(400)
    expect((await call('POST', '/api/fee-config', first, base)).json().version).toBe(1)
    expect((await call('POST', '/api/fee-config', first, { ...base, rate_bps: 250, max_minor: '9223372036854775807' })).json().version).toBe(2)
    const now = (await call('GET', '/api/fee-config', first)).json().fee_config
    expect(now).toMatchObject({ version: 2, rate_bps: 250, max_minor: '9223372036854775807' })
    expect(await auditCount('fee_config.changed')).toBe(2)
    await expect(t.owner.query('UPDATE fee_config SET rate_bps = 1')).rejects.toThrow(/only takes new rows/)
  })
})

describe('audit', () => {
  it('TC-CMP-04 every event records the software and pack versions', async () => {
    const pkg = JSON.parse((await import('node:fs')).readFileSync('package.json', 'utf8'))
    const r = (await call('GET', '/api/audit/recent?limit=200', first)).json().records
    expect(r.length).toBeGreaterThan(5)
    for (const x of r) {
      expect(x.software_version).toBe(pkg.version)
      // only the first start's own pack records come before any pack is active
      if (x.action === 'pack.added' && x.actor_id === 'system') continue
      expect(x.pack_version).toMatch(/^(uk-fpo-template|operator-pack|sly-pack|hidden-panel)@2$/)
    }
    expect((await call('GET', '/api/audit/recent?limit=0', first)).statusCode).toBe(400)
    expect((await call('GET', '/api/audit/recent?limit=abc', first)).statusCode).toBe(400)
  })
  it('TC-AUD-01 changes refused, chain verifies, head exports, no personal data in the audit row', async () => {
    const id = await tx(t.app, (c) => createUser(c, t.keyring, { email: SEED_EMAIL, name: SEED_NAME, password: PW, by: first.id }))
    expect(id).toBeTruthy()
    for (const db of [t.app, t.owner]) {
      await expect(db.query("UPDATE audit SET action = 'x' WHERE seq = 1")).rejects.toThrow()
      await expect(db.query('DELETE FROM audit WHERE seq = 1')).rejects.toThrow()
      await expect(db.query('TRUNCATE audit CASCADE')).rejects.toThrow()
    }
    await expect(t.maintenance.query("UPDATE audit SET action = 'x'")).rejects.toThrow()
    await expect(t.app.query('DELETE FROM audit_detail')).rejects.toThrow()
    const raw = JSON.stringify((await t.owner.query('SELECT * FROM audit')).rows)
    expect(raw).not.toContain(SEED_EMAIL)
    expect(raw).not.toContain(SEED_NAME)
    expect(raw).not.toContain('Accountable Example')
    const detail = JSON.stringify((await t.owner.query('SELECT * FROM audit_detail')).rows)
    expect(detail).toContain(SEED_EMAIL)
    expect(await verifyAudit(t.app, t.keyring)).toMatchObject({ ok: true })
    expect((await call('GET', '/api/audit/verify', first)).json().ok).toBe(true)
    const head = (await call('GET', '/api/audit/head', first)).json().head
    expect(head.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(head).toEqual(await chainHead(t.app))
    expect(await checkHead(t.app, head)).toBe('ok')
    expect(await checkHead(t.app, { seq: head.seq, hash: '0'.repeat(64) })).toBe('changed')
    expect(await checkHead(t.app, { seq: head.seq + 1000, hash: head.hash })).toBe('truncated')
    // audit detail can go when its retention ends, and the chain still verifies
    await expect(t.owner.query("UPDATE audit_detail SET detail = 'x'")).rejects.toThrow(/only takes new rows/)
    const c = await t.owner.connect()
    try {
      const row = (await c.query<{ audit_seq: string; detail: string }>('SELECT audit_seq, detail FROM audit_detail ORDER BY audit_seq LIMIT 1')).rows[0]!
      await c.query('ALTER TABLE audit_detail DISABLE TRIGGER audit_detail_no_update')
      await c.query("UPDATE audit_detail SET detail = '{\"changed\":true}' WHERE audit_seq = $1", [row.audit_seq])
      expect(await verifyAudit(t.app, t.keyring)).toEqual({ ok: false, badSeq: Number(row.audit_seq) })
      await c.query('UPDATE audit_detail SET detail = $2 WHERE audit_seq = $1', [row.audit_seq, row.detail])
      await c.query('ALTER TABLE audit_detail ENABLE TRIGGER audit_detail_no_update')
    } finally {
      c.release()
    }
    expect(await verifyAudit(t.app, t.keyring)).toMatchObject({ ok: true })
    await t.maintenance.query('DELETE FROM audit_detail')
    expect(await verifyAudit(t.app, t.keyring)).toMatchObject({ ok: true })
    await Promise.all(Array.from({ length: 20 }, () => tx(t.app, (x) => appendAudit(x, t.keyring, { actor: 'system', action: 'parallel.test' }))))
    expect(await verifyAudit(t.app, t.keyring)).toMatchObject({ ok: true })
  })
  it('TC-AUD-01 changing a row behind the triggers is found', async () => {
    const c = await t.owner.connect()
    try {
      await c.query('ALTER TABLE audit DISABLE TRIGGER audit_only_new')
      // every stored column, one at a time, put back after each
      const original = (await c.query('SELECT * FROM audit WHERE seq = 3')).rows[0]
      for (const column of ['at', 'actor_id', 'action', 'entity_id', 'detail_hmac', 'software_version', 'pack_version', 'prev_hash', 'hash']) {
        await c.query(`UPDATE audit SET ${column} = 'tampered' WHERE seq = 3`)
        expect((await verifyAudit(t.app, t.keyring)).ok, column).toBe(false)
        await c.query(`UPDATE audit SET ${column} = $1 WHERE seq = 3`, [original[column]])
      }
      expect((await verifyAudit(t.app, t.keyring)).ok).toBe(true)
      await c.query('UPDATE audit SET seq = 3000000 WHERE seq = 3')
      expect((await verifyAudit(t.app, t.keyring)).ok).toBe(false)
      await c.query('UPDATE audit SET seq = 3 WHERE seq = 3000000')
      await c.query("UPDATE audit SET action = 'forged' WHERE seq = 3")
      await c.query('ALTER TABLE audit ENABLE TRIGGER audit_only_new')
    } finally {
      c.release()
    }
    expect(await verifyAudit(t.app, t.keyring)).toEqual({ ok: false, badSeq: 3 })
    expect((await call('GET', '/api/audit/verify', first)).json()).toEqual({ ok: false, badSeq: 3 })
  })
  it('role grants: the application role cannot touch what it must not', async () => {
    await expect(t.app.query('DELETE FROM user_account')).rejects.toThrow()
    await expect(t.app.query('DELETE FROM instance_profile')).rejects.toThrow()
    await expect(t.app.query('DELETE FROM admin_request')).rejects.toThrow()
    await expect(t.app.query('UPDATE role_grant SET role = $1', ['admin'])).rejects.toThrow()
    await expect(t.maintenance.query("INSERT INTO sandbox_outbox VALUES (gen_random_uuid(), 'a', 'b', 'c')")).rejects.toThrow()
    await expect(t.maintenance.query('SELECT * FROM payment_instruction')).rejects.toThrow(/permission denied/)
    await expect(t.maintenance.query('SELECT password_hash FROM user_account')).rejects.toThrow(/permission denied/)
    await expect(t.maintenance.query('SELECT mfa_secret FROM user_account')).rejects.toThrow(/permission denied/)
  })
})

describe('start-up', () => {
  it('TC-OP-04 restart keeps the active pack; a stored built-in version cannot change; a broken built-in stops the start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulma-packs-'))
    const active = (await t.owner.query('SELECT active_pack_id FROM instance_profile')).rows[0]
    await ensureInstance(t.app, t.keyring)
    expect((await t.owner.query('SELECT active_pack_id FROM instance_profile')).rows[0]).toEqual(active)
    const p = readBuiltInPacks().find((x) => x.key === 'uk-fpo-template')!
    mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'a', 'pack.json'), JSON.stringify({ ...p, thresholds: { ...p.thresholds, hnw_income_minor: '1', hnw_net_assets_minor: '1' } }))
    await expect(ensureInstance(t.app, t.keyring, dir)).rejects.toThrow(/changed; a stored version cannot change/)
    writeFileSync(join(dir, 'a', 'pack.json'), JSON.stringify({ ...p, terminal_can_see_promotion: true }))
    await expect(ensureInstance(t.app, t.keyring, dir)).rejects.toThrow(/does not load/)
    expect(parsePack(p).pack).not.toBeNull()
  })
  it('roles-only prepares a fresh server without touching the schema', async () => {
    const fresh = await createTestDb()
    try {
      const url = new URL(TEST_URL)
      url.pathname = `/${fresh.name}`
      expect(await migrate(url.toString(), PASSWORDS, { rolesOnly: true })).toEqual([])
      expect(await migrate(url.toString(), PASSWORDS)).toEqual([])
    } finally {
      await fresh.drop()
    }
  })
  it('TC-OP-02 the first admin needs the deployment secret and is created once; a new instance starts in the sandbox', async () => {
    const fresh = await createTestDb()
    try {
      await expect(bootstrapAdmin(fresh.app, fresh.keyring, undefined, undefined)).rejects.toThrow(/required on first start/)
      expect(await bootstrapAdmin(fresh.app, fresh.keyring, 'a@example.test', PW)).toBe('created')
      expect(await bootstrapAdmin(fresh.app, fresh.keyring, 'b@example.test', PW)).toBe('exists')
      const rows = (await fresh.owner.query("SELECT u.must_change_password, g.role FROM user_account u JOIN role_grant g ON g.user_id = u.id")).rows
      expect(rows).toEqual([{ must_change_password: true, role: 'admin' }])
      expect((await fresh.owner.query('SELECT mode FROM instance_profile')).rows).toEqual([{ mode: 'sandbox' }])
    } finally {
      await fresh.drop()
    }
  })
})
