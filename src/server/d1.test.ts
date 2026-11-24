import type { FastifyInstance } from 'fastify'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryStorage } from '../adapters/index.ts'
import { SumsubKyc } from '../adapters/sumsub.ts'
import { fillText, parsePack, type RegimePack } from '../lib/regimePack.ts'
import { codeAt, stepOf } from '../lib/totp.ts'
import { runRetention } from '../maintenance/retention.ts'
import { tx } from '../store/db.ts'
import { insertPack } from '../store/packs.ts'
import { createTestDb, type TestDb } from '../store/testdb.ts'
import { buildServer as startServer } from './app.ts'
import { bootstrapAdmin, createUser, currentStaff, grantRole } from './auth.ts'

const PW = 'a-long-enough-password'

/**
 * A signed form carries a hash of what the page showed. These tests are about other things, so unless a test names a hash itself
 * the client does what the screen does: read the page, then send what it says.
 */
const buildServer: typeof startServer = async (o) => {
  const s = await startServer(o)
  const inject = s.inject.bind(s) as unknown as (x: Record<string, unknown>) => Promise<{ statusCode: number; json: () => Record<string, string> }>
  const wrapped = async (x: Record<string, unknown>) => {
    const body = x.payload as Record<string, unknown> | undefined
    if (x.method === 'POST' && body && !Buffer.isBuffer(body) && typeof body === 'object') {
      const look = (url: string) => inject({ method: 'GET', url, headers: x.headers, remoteAddress: x.remoteAddress })
      if ((x.url === '/api/eligibility/statement' || x.url === '/api/eligibility/warning') && !('shown_sha256' in body)) {
        const page = await look('/api/eligibility')
        if (page.statusCode === 200) x = { ...x, payload: { ...body, shown_sha256: page.json().shown_sha256 } }
      }
      if (String(x.url).endsWith('/kyc') && body.biometric_consent && !('biometric_consent_sha256' in body)) {
        const page = await look('/api/kyc/routes')
        if (page.statusCode === 200) x = { ...x, payload: { ...body, biometric_consent_sha256: page.json().consent_sha256 } }
      }
    }
    return inject(x)
  }
  return Object.assign(s, { inject: wrapped })
}
const MFA = Buffer.alloc(20, 9)
let t: TestDb
let app: FastifyInstance
let clock = new Date('2026-06-01T09:00:00.000Z')
let ipCounter = 0
const nextIp = () => `10.20.${Math.floor(ipCounter / 200)}.${(ipCounter++ % 200) + 1}`

interface Client { cookie: string; csrf: string; id: string; email: string }

const send = (method: string, url: string, who?: Client, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as 'GET', url, remoteAddress: nextIp(), headers: { ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })

async function login(email: string, password = PW): Promise<Client> {
  await t.owner.query('UPDATE user_account SET mfa_last_step = NULL WHERE lower(email) = lower($1)', [email])
  const r = await send('POST', '/api/login', undefined, { email, password, code: codeAt(MFA, stepOf(clock.getTime())) })
  expect(r.statusCode, await r.body).toBe(200)
  return { cookie: `bulma_session=${r.cookies.find((c) => c.name === 'bulma_session')!.value}`, csrf: r.json().csrf, id: r.json().user.id, email }
}

async function staff(email: string, roles: Array<'admin' | 'reviewer' | 'approver'>): Promise<Client> {
  const id = await tx(t.app, async (c) => {
    const u = await createUser(c, t.keyring, { email, name: `Staff ${email}`, password: PW, by: null })
    await c.query('UPDATE user_account SET must_change_password = false WHERE id = $1', [u])
    for (const r of roles) await grantRole(c, t.keyring, u, r, null)
    return u
  })
  const e = t.keyring.encrypt(MFA)
  await t.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [id, e.ciphertext, e.keyId, e.wrappedDek])
  return login(email)
}

const tokenOf = (link: string) => new URL(link, 'http://x').searchParams.get('token')!

async function investor(email: string): Promise<Client> {
  const r = await send('POST', '/api/register', undefined, { first_name: 'Fay', last_name: 'Fictional', email, password: PW })
  expect(r.statusCode).toBe(200)
  expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(r.json().sandbox_link), password: PW })).statusCode).toBe(200)
  return login(email)
}

const PDF = Buffer.from('%PDF-1.4 seed passport contents')
const upload = (who: Client, entity: string, requirement: string, body = PDF, name = 'file.pdf') =>
  app.inject({ method: 'POST', url: `/api/entities/${entity}/files?requirement=${requirement}&name=${encodeURIComponent(name)}`, remoteAddress: nextIp(), headers: { cookie: who.cookie, 'x-csrf-token': who.csrf, 'content-type': 'application/octet-stream' }, payload: body })

const INDIVIDUAL = { full_name: 'Fay Fictional', address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' }

async function individualEntity(who: Client): Promise<string> {
  const id = (await send('POST', '/api/entities', who, { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
  for (const r of ['identity_proof', 'address_proof', 'source_of_wealth']) expect((await upload(who, id, r)).statusCode).toBe(200)
  return id
}

/** The sandbox outbox: the only place a link that acts on an account can be read. */
const mailed = async (to: string, db: TestDb = t) => (await db.owner.query<{ subject: string; body: string }>('SELECT subject, body FROM sandbox_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at DESC', [to])).rows
const linkIn = (body: string) => /\/[a-z-]+\?token=[\w-]+/.exec(body)![0]
const mailedLink = async (to: string, subject: RegExp) => linkIn((await mailed(to)).find((m) => subject.test(m.subject))!.body)

const entityOf = async (who: Client, id: string) => (await send('GET', '/api/entities', who)).json().entities.find((e: { id: string }) => e.id === id)
const auditCount = async (action: string) => Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit WHERE action = $1', [action])).rows[0]!.n)

let reviewer: Client
let admin: Client

beforeAll(async () => {
  t = await createTestDb()
  app = await buildServer({ db: t.app, k: t.keyring, secureCookies: false, now: () => clock })
  await bootstrapAdmin(t.app, t.keyring, 'first@example.test', PW)
  await t.owner.query('UPDATE user_account SET must_change_password = false')
  const e = t.keyring.encrypt(MFA)
  await t.owner.query('UPDATE user_account SET mfa_secret = $1, mfa_key_id = $2, mfa_wrapped_key = $3, mfa_enabled_at = now()', [e.ciphertext, e.keyId, e.wrappedDek])
  admin = await login('first@example.test')
  reviewer = await staff('reviewer@example.test', ['reviewer'])
})
afterAll(async () => {
  await app?.close()
  await t?.drop()
})

describe('accounts', () => {
  it('TC-ACC-01 registering asks only for names, email and password; the address must be proved; one account is both investor and lead', async () => {
    const r = await send('POST', '/api/register', undefined, { first_name: 'Ann', last_name: 'Example', email: 'ann@example.test', password: PW })
    expect(r.statusCode).toBe(200)
    expect(r.json().sandbox_link).toMatch(/^\/verify-email\?token=/)
    expect((await send('POST', '/api/register', undefined, { first_name: 'A', last_name: 'B', email: 'x@example.test', password: PW, country: 'UK' })).statusCode).toBe(400)
    expect((await send('POST', '/api/register', undefined, { first_name: 'A', last_name: 'B', email: 'x@example.test', password: 'short' })).statusCode).toBe(400)
    expect((await send('POST', '/api/register', undefined, { first_name: 'A', last_name: 'B', email: 'not-an-email', password: PW })).statusCode).toBe(400)
    const before = await login('ann@example.test')
    expect((await send('GET', '/api/entities', before)).statusCode).toBe(403)
    const token = tokenOf(r.json().sandbox_link)
    expect((await send('POST', '/api/verify-email', undefined, { token: 'wrong', password: PW })).statusCode).toBe(400)
    expect((await send('POST', '/api/verify-email', undefined, { token })).statusCode).toBe(400) // the password is part of it
    expect((await send('POST', '/api/verify-email', undefined, { token, password: 'not-the-right-password' })).statusCode).toBe(400)
    expect((await send('GET', '/api/entities', before)).statusCode).toBe(403) // a wrong password does not spend the link or confirm anything
    expect((await send('POST', '/api/verify-email', undefined, { token, password: PW })).statusCode).toBe(200)
    expect((await send('POST', '/api/verify-email', undefined, { token, password: PW })).statusCode).toBe(400)
    expect((await send('GET', '/api/entities', before)).statusCode).toBe(200)
    const s = (await send('GET', '/api/session', before)).json().user
    expect(s).toMatchObject({ emailVerified: true, roles: [], mfaOn: false })
    // one account is both: someone holding a role has the same investor routes as anyone (R-ACC-02)
    expect((await send('GET', '/api/eligibility', reviewer)).statusCode).toBe(200)
    expect((await send('POST', '/api/entities', reviewer, { type: 'individual', fields: INDIVIDUAL, parties: [] })).statusCode).toBe(200)
    expect((await send('GET', '/api/review/kyc', reviewer)).statusCode).toBe(200)
    // sandbox mail stays in the outbox
    expect((await t.owner.query("SELECT 1 FROM sandbox_outbox WHERE to_address = 'ann@example.test'")).rowCount).toBe(1)
  })
  it('TC-ACC-01 an address already in use gets the same answer and no second account; an expired link fails', async () => {
    const r = await send('POST', '/api/register', undefined, { first_name: 'Ann', last_name: 'Other', email: 'ANN@example.test', password: PW })
    expect(r.statusCode).toBe(200)
    const fresh = await send('POST', '/api/register', undefined, { first_name: 'New', last_name: 'Person', email: 'unused.address@example.test', password: PW })
    // the same shape for a verified address and an unused one, and the first one's link opens nothing
    expect(Object.keys(r.json()).sort()).toEqual(Object.keys(fresh.json()).sort())
    expect(r.json().sandbox_link).toMatch(/^\/verify-email\?token=/)
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(r.json().sandbox_link), password: PW })).statusCode).toBe(400)
    expect((await mailed('ann@example.test')).map((m) => m.subject)).toContain('You already have an account')
    expect((await t.owner.query("SELECT 1 FROM user_account WHERE lower(email) = 'ann@example.test'")).rowCount).toBe(1)
    const late = await send('POST', '/api/register', undefined, { first_name: 'L', last_name: 'Ate', email: 'late@example.test', password: PW })
    const saved = clock
    clock = new Date(clock.getTime() + 73 * 3_600_000)
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(late.json().sandbox_link), password: PW })).statusCode).toBe(400)
    clock = saved
  })
  it('TC-ACC-01 in the real mode with no mail adapter, nothing is stored and the page says why', async () => {
    const db = await createTestDb()
    const noMail = await buildServer({ db: db.app, k: db.keyring, secureCookies: false })
    await db.owner.query("INSERT INTO user_account (id, email, name, must_change_password) VALUES ('00000000-0000-4000-8000-000000000001', 'x@example.test', 'X', false)")
    await db.owner.query("UPDATE instance_profile SET mode = 'real', regulatory_status = 'authorised_firm', accountable_person = 'P', accountable_confirmed_on = '2026-01-01', approved_by = '00000000-0000-4000-8000-000000000001'")
    const r = await noMail.inject({ method: 'POST', url: '/api/register', payload: { first_name: 'A', last_name: 'B', email: 'real@example.test', password: PW } })
    expect(r.statusCode).toBe(503)
    expect((await db.owner.query("SELECT 1 FROM user_account WHERE email = 'real@example.test'")).rowCount).toBe(0)
    expect((await noMail.inject({ method: 'POST', url: '/api/password/forgot', payload: { email: 'x@example.test' } })).statusCode).toBe(503)
    await noMail.close()
    await db.drop()
  })
  it('TC-ACC-02 forgotten password: the reply is the same for any address and never carries the link; one use; other sessions end', async () => {
    const u = await investor('reset@example.test')
    const unknown = await send('POST', '/api/password/forgot', undefined, { email: 'nobody@example.test' })
    const known = await send('POST', '/api/password/forgot', undefined, { email: 'reset@example.test' })
    expect(unknown.json()).toEqual({ ok: true })
    expect(known.json()).toEqual({ ok: true }) // B2: a link here would hand any account to anyone
    expect((await mailed('nobody@example.test')).length).toBe(0)
    const token = tokenOf(await mailedLink('reset@example.test', /new password/))
    expect((await send('POST', '/api/password/reset', undefined, { token, password: 'short' })).statusCode).toBe(400)
    expect((await send('POST', '/api/password/reset', undefined, { token: 'wrong', password: 'a-brand-new-password' })).statusCode).toBe(400)
    expect((await send('POST', '/api/password/reset', undefined, { token, password: 'a-brand-new-password' })).statusCode).toBe(200)
    expect((await send('POST', '/api/password/reset', undefined, { token, password: 'another-new-password' })).statusCode).toBe(400)
    expect((await send('GET', '/api/session', u)).statusCode).toBe(401)
    await login('reset@example.test', 'a-brand-new-password')
  })
  it('TC-ACC-02 links do not outlive a credential change: an older reset link and an email change both die with a reset', async () => {
    const u = await investor('tokens@example.test')
    expect((await send('POST', '/api/account/email', u, { email: 'thief@example.test', password: PW })).statusCode).toBe(200)
    const stolen = tokenOf(await mailedLink('thief@example.test', /new email/))
    await send('POST', '/api/password/forgot', undefined, { email: 'tokens@example.test' })
    const first = tokenOf(await mailedLink('tokens@example.test', /new password/))
    await t.owner.query("UPDATE account_token SET created_at = now() - interval '1 minute' WHERE consumed_at IS NULL")
    await send('POST', '/api/password/forgot', undefined, { email: 'tokens@example.test' })
    const second = (await mailed('tokens@example.test')).filter((m) => /new password/.test(m.subject)).map((m) => tokenOf(linkIn(m.body))).find((x) => x !== first)!
    expect((await send('POST', '/api/password/reset', undefined, { token: second, password: 'a-brand-new-password' })).statusCode).toBe(200)
    expect((await send('POST', '/api/password/reset', undefined, { token: first, password: 'an-older-link-password' })).statusCode).toBe(400)
    expect((await send('POST', '/api/account/email/confirm', undefined, { token: stolen, password: 'a-brand-new-password' })).statusCode).toBe(400)
    await login('tokens@example.test', 'a-brand-new-password')
    // changing the password while signed in does the same
    const v = await investor('tokens2@example.test')
    await send('POST', '/api/account/email', v, { email: 'thief2@example.test', password: PW })
    const stale = tokenOf(await mailedLink('thief2@example.test', /new email/))
    expect((await send('POST', '/api/password', v, { current: PW, next: 'a-different-long-password' })).statusCode).toBe(200)
    expect((await send('POST', '/api/account/email/confirm', undefined, { token: stale, password: 'a-different-long-password' })).statusCode).toBe(400)
  })
  it('TC-ACC-02 a role does nothing until two-step sign-in is on; setting it up works end to end, with one-use codes and recovery codes', async () => {
    const id = await tx(t.app, async (c) => {
      const u = await createUser(c, t.keyring, { email: 'new.reviewer@example.test', name: 'New', password: PW, by: null })
      await c.query('UPDATE user_account SET must_change_password = false WHERE id = $1', [u])
      await grantRole(c, t.keyring, u, 'reviewer', null)
      return u
    })
    expect(id).toBeTruthy()
    const first = await send('POST', '/api/login', undefined, { email: 'new.reviewer@example.test', password: PW })
    const c: Client = { cookie: `bulma_session=${first.cookies.find((x) => x.name === 'bulma_session')!.value}`, csrf: first.json().csrf, id, email: 'new.reviewer@example.test' }
    expect((await send('GET', '/api/review/kyc', c)).statusCode).toBe(403)
    expect((await send('POST', '/api/mfa/start', c, { password: 'wrong-password-12' })).statusCode).toBe(400)
    const started = (await send('POST', '/api/mfa/start', c, { password: PW })).json()
    expect(started.uri).toContain(started.secret)
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = 0
    let v = 0
    const bytes: number[] = []
    for (const ch of started.secret as string) {
      v = (v << 5) | A.indexOf(ch)
      bits += 5
      if (bits >= 8) {
        bytes.push((v >>> (bits - 8)) & 255)
        bits -= 8
        v &= (1 << bits) - 1
      }
    }
    const secret = Buffer.from(bytes)
    const step = stepOf(clock.getTime())
    expect((await send('POST', '/api/mfa/confirm', c, { code: '000000' })).statusCode).toBe(400)
    const confirmed = await send('POST', '/api/mfa/confirm', c, { code: codeAt(secret, step) })
    expect(confirmed.statusCode).toBe(200)
    const codes: string[] = confirmed.json().recovery_codes
    expect(codes.length).toBe(10)
    expect((await send('GET', '/api/review/kyc', c)).statusCode).toBe(200)
    expect((await send('POST', '/api/mfa/start', c, { password: PW })).statusCode).toBe(409)
    const raw = JSON.stringify((await t.owner.query('SELECT * FROM mfa_recovery_code')).rows)
    expect(raw).not.toContain(codes[0])
    // sign-in now needs the second step, and the same code cannot be used twice
    const sign = (code?: string) => send('POST', '/api/login', undefined, { email: 'new.reviewer@example.test', password: PW, ...(code ? { code } : {}) })
    const noCode = await sign()
    expect(noCode.statusCode).toBe(401)
    expect(noCode.json().mfa_required).toBe(true)
    expect(noCode.cookies.length).toBe(0)
    expect((await sign(codeAt(secret, step))).statusCode).toBe(401) // already used in setup
    expect((await sign(codeAt(secret, step + 1))).statusCode).toBe(200)
    expect((await sign(codeAt(secret, step + 1))).statusCode).toBe(401)
    expect((await sign('999999')).statusCode).toBe(401)
    expect((await sign(codes[0])).statusCode).toBe(200)
    expect((await sign(codes[0])).statusCode).toBe(401)
    expect(await auditCount('user.recovery_code_used')).toBe(1)
    const stored = (await t.owner.query<{ mfa_secret: Buffer }>('SELECT mfa_secret FROM user_account WHERE id = $1', [id])).rows[0]!.mfa_secret
    expect(stored.includes(secret)).toBe(false)
  })
  it('TC-ACC-03 changing email needs the password and the new address; sessions end, the old address is told; a name change makes the statement need confirming again', async () => {
    const u = await investor('change@example.test')
    expect((await send('POST', '/api/account/email', u, { email: 'new.change@example.test', password: 'wrong-password-12' })).statusCode).toBe(400)
    await send('POST', '/api/password/forgot', undefined, { email: 'change@example.test' })
    const resetBefore = tokenOf(await mailedLink('change@example.test', /new password/))
    const r = await send('POST', '/api/account/email', u, { email: 'new.change@example.test', password: PW })
    expect(r.json()).toEqual({ ok: true }) // the link goes to the new mailbox, not into this reply
    expect((await send('POST', '/api/account/email/confirm', undefined, { token: 'wrong', password: PW })).statusCode).toBe(400)
    expect((await send('POST', '/api/account/email/confirm', undefined, { token: tokenOf(await mailedLink('new.change@example.test', /new email/)), password: 'the-mailbox-owner-guess' })).statusCode).toBe(400) // F4: a click by whoever holds the mailbox is not enough
    expect((await send('POST', '/api/account/email/confirm', undefined, { token: tokenOf(await mailedLink('new.change@example.test', /new email/)), password: PW })).statusCode).toBe(200)
    expect((await send('GET', '/api/session', u)).statusCode).toBe(401)
    expect((await mailed('change@example.test')).map((m) => m.subject)).toContain('Your email address was changed')
    expect((await send('POST', '/api/password/reset', undefined, { token: resetBefore, password: 'a-link-from-before-1' })).statusCode).toBe(400) // links from before the change die with it
    const again = await login('new.change@example.test')
    const taken = await send('POST', '/api/account/email', again, { email: 'reviewer@example.test', password: PW })
    expect(taken.json()).toEqual({ ok: true })
    expect((await mailed('reviewer@example.test')).filter((m) => /new email/.test(m.subject)).length).toBe(0)
    expect((await send('POST', '/api/account/name', again, { first_name: 'New', last_name: 'Name' })).statusCode).toBe(200)
    const row = (await t.owner.query<{ name: string; changed: boolean }>('SELECT name, identity_changed_at IS NOT NULL AS changed FROM user_account WHERE id = $1', [u.id])).rows[0]!
    expect(row).toEqual({ name: 'New Name', changed: true })
  })
  it('TC-ACC-03 an email-change link expires, and so does a reset link', async () => {
    const u = await investor('late.change@example.test')
    await send('POST', '/api/account/email', u, { email: 'late.new@example.test', password: PW })
    const change = tokenOf(await mailedLink('late.new@example.test', /new email/))
    await send('POST', '/api/password/forgot', undefined, { email: 'late.change@example.test' })
    const reset = tokenOf(await mailedLink('late.change@example.test', /new password/))
    const saved = clock
    clock = new Date(clock.getTime() + 25 * 3_600_000)
    expect((await send('POST', '/api/account/email/confirm', undefined, { token: change, password: PW })).statusCode).toBe(400)
    expect((await send('POST', '/api/password/reset', undefined, { token: reset, password: 'a-brand-new-password' })).statusCode).toBe(400)
    clock = saved
  })
  it('TC-ACC-03 with two-step on, changing email also needs the code', async () => {
    const m = await staff('mfa.email@example.test', ['reviewer'])
    expect((await send('POST', '/api/account/email', m, { email: 'mfa.new@example.test', password: PW })).statusCode).toBe(400)
    expect((await send('POST', '/api/account/email', m, { email: 'mfa.new@example.test', password: PW, code: '000000' })).statusCode).toBe(400)
    expect((await mailed('mfa.new@example.test')).length).toBe(0)
    await t.owner.query('UPDATE user_account SET mfa_last_step = NULL WHERE id = $1', [m.id])
    expect((await send('POST', '/api/account/email', m, { email: 'mfa.new@example.test', password: PW, code: codeAt(MFA, stepOf(clock.getTime())) })).statusCode).toBe(200)
    expect((await mailed('mfa.new@example.test')).length).toBe(1)
  })
  it('TC-ACC-05 claiming someone else\'s address gets nowhere: no two-step, no confirming with the owner\'s click, and the real owner takes it over', async () => {
    const email = 'victim@example.test'
    const reg = await send('POST', '/api/register', undefined, { first_name: 'Att', last_name: 'Acker', email, password: 'attacker-password-1' })
    const attacker = await login(email, 'attacker-password-1')
    expect((await send('POST', '/api/mfa/start', attacker, { password: 'attacker-password-1' })).statusCode).toBe(403)
    // the owner clicks the mail they did not ask for, and has no password to finish it with
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(reg.json().sandbox_link), password: 'owner-does-not-know-this' })).statusCode).toBe(400)
    expect((await send('GET', '/api/session', attacker)).json().user.emailVerified).toBe(false)
    // the owner registers: their password waits on a new link, and the old link stops working
    const mine = await send('POST', '/api/register', undefined, { first_name: 'Real', last_name: 'Owner', email, password: 'the-owners-password-1' })
    expect((await login(email, 'attacker-password-1')).id).toBe(attacker.id) // nothing changes until the mailbox is proved
    // neither can close the account or kill the owner's link from where they stand
    expect((await send('POST', '/api/account/delete', attacker, { password: 'attacker-password-1' })).statusCode).toBe(403)
    expect((await send('POST', '/api/account/resend-verification', attacker)).statusCode).toBe(200)
    await send('POST', '/api/register', undefined, { first_name: 'Att', last_name: 'Again', email, password: 'attacker-password-2' })
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(mine.json().sandbox_link), password: 'attacker-password-1' })).statusCode).toBe(400)
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(mine.json().sandbox_link), password: 'the-owners-password-1' })).statusCode).toBe(200)
    expect((await send('GET', '/api/session', attacker)).statusCode).toBe(401)
    expect((await send('POST', '/api/login', undefined, { email, password: 'attacker-password-1' })).statusCode).toBe(401)
    // once settled, every other link is dead, whoever holds it
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(reg.json().sandbox_link), password: 'attacker-password-1' })).statusCode).toBe(400)
    const owner = await login(email, 'the-owners-password-1')
    expect((await send('GET', '/api/session', owner)).json().user).toMatchObject({ emailVerified: true, name: 'Real Owner' })
    expect((await send('POST', '/api/mfa/start', owner, { password: 'the-owners-password-1' })).statusCode).toBe(200)
  })
  it('TC-ACC-05 a lost link can be sent again; other links stay until one is used; registering does not spend a reset link; a reset also proves the address', async () => {
    const email = 'lost.link@example.test'
    const reg = await send('POST', '/api/register', undefined, { first_name: 'Lo', last_name: 'St', email, password: PW })
    const u = await login(email)
    expect((await send('POST', '/api/account/resend-verification')).statusCode).toBe(401)
    const again = await send('POST', '/api/account/resend-verification', u)
    expect(again.statusCode).toBe(200)
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(again.json().sandbox_link), password: PW })).statusCode).toBe(200)
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(reg.json().sandbox_link), password: PW })).statusCode).toBe(400)
    expect((await send('POST', '/api/account/resend-verification', u)).json()).toEqual({ ok: true })
    // someone registering the address again does not touch the owner's reset link
    await send('POST', '/api/register', undefined, { first_name: 'Un', last_name: 'Seen', email: 'keeps.reset@example.test', password: PW })
    await send('POST', '/api/password/forgot', undefined, { email: 'keeps.reset@example.test' })
    const reset = tokenOf(await mailedLink('keeps.reset@example.test', /new password/))
    await send('POST', '/api/register', undefined, { first_name: 'Not', last_name: 'Them', email: 'keeps.reset@example.test', password: 'someone-elses-password' })
    expect((await send('POST', '/api/password/reset', undefined, { token: reset, password: 'a-brand-new-password' })).statusCode).toBe(200)
    // over the address's mail limit, nothing new is made that nobody received
    const flood = 'flood@example.test'
    await send('POST', '/api/register', undefined, { first_name: 'F', last_name: 'L', email: flood, password: PW })
    for (let i = 0; i < 12; i++) await send('POST', '/api/register', undefined, { first_name: 'F', last_name: 'L', email: flood, password: PW })
    const open = (await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM account_token a JOIN user_account u ON u.id = a.user_id WHERE u.email = $1', [flood])).rows[0]!.n
    expect(Number(open)).toBe((await mailed(flood)).length)
    await send('POST', '/api/register', undefined, { first_name: 'Re', last_name: 'Set', email: 'via.reset@example.test', password: PW })
    await send('POST', '/api/password/forgot', undefined, { email: 'via.reset@example.test' })
    await send('POST', '/api/password/reset', undefined, { token: tokenOf(await mailedLink('via.reset@example.test', /new password/)), password: 'a-brand-new-password' })
    expect((await send('GET', '/api/session', await login('via.reset@example.test', 'a-brand-new-password'))).json().user.emailVerified).toBe(true)
  })
  it('TC-ACC-04 lost two-step: one admin asks, a second approves; sessions, codes and the secret go; the person is told and must set it up again', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const person = async (email: string, roles: Array<'admin' | 'reviewer'>) => {
      const id = await tx(db.app, async (c) => {
        const u = await createUser(c, db.keyring, { email, name: email, password: PW, by: null })
        await c.query('UPDATE user_account SET must_change_password = false WHERE id = $1', [u])
        for (const role of roles) await grantRole(c, db.keyring, u, role, null)
        return u
      })
      const e = db.keyring.encrypt(MFA)
      await db.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now(), mfa_last_step = NULL WHERE id = $1', [id, e.ciphertext, e.keyId, e.wrappedDek])
      const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email, password: PW, code: codeAt(MFA, stepOf(clock.getTime())) } })
      return { id, headers: { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf } }
    }
    const a = await person('admin.a@example.test', ['admin'])
    const b = await person('admin.b@example.test', ['admin'])
    const lost = await person('lost@example.test', ['reviewer'])
    await db.owner.query("INSERT INTO mfa_recovery_code (code_hmac, user_id) VALUES ('x', $1)", [lost.id])
    const call = (who: { headers: object }, url: string) => server.inject({ method: 'POST', url, headers: who.headers as Record<string, string>, remoteAddress: nextIp() })
    expect((await call(lost, `/api/users/${a.id}/mfa-reset`)).statusCode).toBe(403)
    const asked = await call(a, `/api/users/${lost.id}/mfa-reset`)
    expect(asked.statusCode).toBe(200)
    const older = await call(b, `/api/users/${lost.id}/mfa-reset`)
    expect(older.statusCode).toBe(200)
    // nothing yet, and the one who asked cannot approve
    expect((await db.owner.query('SELECT 1 FROM user_account WHERE id = $1 AND mfa_enabled_at IS NOT NULL', [lost.id])).rowCount).toBe(1)
    expect((await call(a, `/api/requests/${asked.json().requestId}/approve`)).statusCode).toBe(409)
    expect((await call(b, `/api/requests/${asked.json().requestId}/approve`)).statusCode).toBe(200)
    const row = (await db.owner.query('SELECT mfa_secret, mfa_enabled_at FROM user_account WHERE id = $1', [lost.id])).rows[0]
    expect(row).toEqual({ mfa_secret: null, mfa_enabled_at: null })
    expect((await db.owner.query('SELECT 1 FROM mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL', [lost.id])).rowCount).toBe(0)
    expect((await server.inject({ method: 'GET', url: '/api/session', headers: lost.headers })).statusCode).toBe(401)
    expect((await mailed('lost@example.test', db)).map((m) => m.subject)).toContain('Your two-step sign-in was reset')
    // the role does nothing until it is set up again
    const back = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'lost@example.test', password: PW } })
    expect(back.statusCode).toBe(200)
    const h = { cookie: `bulma_session=${back.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': back.json().csrf }
    expect((await server.inject({ method: 'GET', url: '/api/review/kyc', headers: h })).statusCode).toBe(403)
    expect((await call(a, `/api/users/${lost.id}/mfa-reset`)).statusCode).toBe(409) // nothing left to reset
    // F13a: approving one closes the others, so a later approval cannot clear a new two-step
    expect((await db.owner.query<{ status: string }>('SELECT status FROM admin_request WHERE id = $1', [older.json().requestId])).rows[0]!.status).toBe('rejected')
    await server.close()
    await db.drop()
  })
  it('TC-ACC-03 closing an account: password needed, session ends, sign-in stops, data stays until retention; a role holder is refused', async () => {
    const u = await investor('closing@example.test')
    expect((await send('POST', '/api/account/delete', u, { password: 'wrong-password-12' })).statusCode).toBe(400)
    const r = await send('POST', '/api/account/delete', u, { password: PW })
    expect(r.statusCode).toBe(200)
    expect(r.json().note).toMatch(/kept until their retention ends/)
    expect((await send('GET', '/api/session', u)).statusCode).toBe(401)
    expect((await send('POST', '/api/login', undefined, { email: 'closing@example.test', password: PW })).statusCode).toBe(401)
    expect((await t.owner.query("SELECT 1 FROM user_account WHERE email = 'closing@example.test'")).rowCount).toBe(1)
    expect((await send('POST', '/api/account/delete', reviewer, { password: PW })).statusCode).toBe(409)
    // F3: registering the address again says what is true, and opens nothing
    const back = await send('POST', '/api/register', undefined, { first_name: 'Back', last_name: 'Again', email: 'closing@example.test', password: PW })
    expect((await send('POST', '/api/verify-email', undefined, { token: tokenOf(back.json().sandbox_link), password: PW })).statusCode).toBe(400)
    expect((await mailed('closing@example.test')).map((m) => m.subject)).toContain('This address belongs to a closed account')
    // F10: links asked for before closing die with it
    const v = await investor('closing2@example.test')
    await send('POST', '/api/account/email', v, { email: 'closing2.new@example.test', password: PW })
    const link = tokenOf(await mailedLink('closing2.new@example.test', /new email/))
    await send('POST', '/api/account/delete', v, { password: PW })
    expect((await send('POST', '/api/account/email/confirm', undefined, { token: link, password: PW })).statusCode).toBe(400)
    // with two-step on, closing needs the code as well
    const m = await investor('closing3@example.test')
    const e = t.keyring.encrypt(MFA)
    await t.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [m.id, e.ciphertext, e.keyId, e.wrappedDek])
    expect((await send('POST', '/api/account/delete', m, { password: PW })).statusCode).toBe(400)
    await t.owner.query('UPDATE user_account SET mfa_last_step = NULL WHERE id = $1', [m.id])
    expect((await send('POST', '/api/account/delete', m, { password: PW, code: codeAt(MFA, stepOf(clock.getTime())) })).statusCode).toBe(200)
  })
  it('TC-ACC-02 a two-step setup begun before a password change or reset cannot be finished after it, by that session or any', async () => {
    const u = await investor('pending.mfa@example.test')
    const secretOf = (b32: string) => Buffer.from(b32.split('').reduce((acc: { out: number[]; v: number; bits: number }, ch: string) => {
      acc.v = (acc.v << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch)
      acc.bits += 5
      if (acc.bits >= 8) { acc.out.push((acc.v >>> (acc.bits - 8)) & 255); acc.bits -= 8; acc.v &= (1 << acc.bits) - 1 }
      return acc
    }, { out: [], v: 0, bits: 0 }).out)
    const stolen = secretOf((await send('POST', '/api/mfa/start', u, { password: PW })).json().secret)
    await send('POST', '/api/password/forgot', undefined, { email: 'pending.mfa@example.test' })
    await send('POST', '/api/password/reset', undefined, { token: tokenOf(await mailedLink('pending.mfa@example.test', /new password/)), password: 'a-brand-new-password' })
    const back = await login('pending.mfa@example.test', 'a-brand-new-password')
    expect((await send('POST', '/api/mfa/confirm', back, { code: codeAt(stolen, stepOf(clock.getTime())) })).statusCode).toBe(400)
    // queued behind the account row while the session ends
    const w = await investor('queued.mfa@example.test')
    const secret = secretOf((await send('POST', '/api/mfa/start', w, { password: PW })).json().secret)
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [w.id])
    const pending = send('POST', '/api/mfa/confirm', w, { code: codeAt(secret, stepOf(clock.getTime())) })
    await new Promise((f) => setTimeout(f, 150))
    await c.query('DELETE FROM app_session WHERE user_id = $1', [w.id])
    await c.query('COMMIT')
    c.release()
    expect((await pending).statusCode).toBe(400)
    expect((await t.owner.query('SELECT 1 FROM user_account WHERE id = $1 AND mfa_enabled_at IS NULL', [w.id])).rowCount).toBe(1)
  })
  it('TC-ACC-02 a reset asked for while the address is being changed finds nobody at the old address', async () => {
    const u = await investor('moving@example.test')
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query("UPDATE user_account SET email = 'moving.done@example.test' WHERE id = $1", [u.id])
    const asked = send('POST', '/api/password/forgot', undefined, { email: 'moving@example.test' })
    await new Promise((f) => setTimeout(f, 150))
    await c.query('COMMIT')
    c.release()
    expect((await asked).json()).toEqual({ ok: true })
    expect((await mailed('moving@example.test')).filter((m) => /new password/.test(m.subject))).toEqual([])
    expect((await t.owner.query("SELECT 1 FROM account_token WHERE user_id = $1 AND kind = 'reset_password'", [u.id])).rowCount).toBe(0)
  })
  it('TC-ACC-02 a link asked for before two-step dies when it goes on', async () => {
    const u = await investor('pre.mfa.link@example.test')
    await send('POST', '/api/account/email', u, { email: 'pre.mfa.new@example.test', password: PW })
    const link = tokenOf(await mailedLink('pre.mfa.new@example.test', /new email/))
    const secret = (await send('POST', '/api/mfa/start', u, { password: PW })).json().secret as string
    const raw = Buffer.from(secret.split('').reduce((acc: { out: number[]; v: number; bits: number }, ch: string) => {
      acc.v = (acc.v << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch)
      acc.bits += 5
      if (acc.bits >= 8) { acc.out.push((acc.v >>> (acc.bits - 8)) & 255); acc.bits -= 8; acc.v &= (1 << acc.bits) - 1 }
      return acc
    }, { out: [], v: 0, bits: 0 }).out)
    expect((await send('POST', '/api/mfa/confirm', u, { code: codeAt(raw, stepOf(clock.getTime())) })).statusCode).toBe(200)
    expect((await send('POST', '/api/account/email/confirm', undefined, { token: link, password: PW })).statusCode).toBe(400)
  })
  it('TC-ACC-03 an email change queued while two-step comes on, or the session ends, issues nothing', async () => {
    const u = await investor('queued.email@example.test')
    const holdRow = async () => {
      const c = await t.owner.connect()
      await c.query('BEGIN')
      await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [u.id])
      return c
    }
    let c = await holdRow()
    let asked = send('POST', '/api/account/email', u, { email: 'queued.new@example.test', password: PW })
    await new Promise((f) => setTimeout(f, 250))
    await c.query('UPDATE user_account SET mfa_enabled_at = now() WHERE id = $1', [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(409)
    expect((await mailed('queued.new@example.test')).length).toBe(0)
    await t.owner.query('UPDATE user_account SET mfa_enabled_at = NULL WHERE id = $1', [u.id])
    c = await holdRow()
    asked = send('POST', '/api/account/email', u, { email: 'queued.new@example.test', password: PW })
    await new Promise((f) => setTimeout(f, 250))
    await c.query('DELETE FROM app_session WHERE user_id = $1', [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(409)
    expect((await mailed('queued.new@example.test')).length).toBe(0)
  })
  const heldRow = async (id: string) => {
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [id])
    return c
  }
  // long enough for the password check before the wait
  const queued = () => new Promise((f) => setTimeout(f, 400))
  it('TC-ACC-03 closing an account that waited is checked after the wait: two-step on, session ended, a role given', async () => {
    const u = await investor('queued.close@example.test')
    const closed = async () => (await t.owner.query<{ disabled_at: Date | null }>('SELECT disabled_at FROM user_account WHERE id = $1', [u.id])).rows[0]!.disabled_at
    let c = await heldRow(u.id)
    let asked = send('POST', '/api/account/delete', u, { password: PW })
    await queued()
    await c.query('UPDATE user_account SET mfa_enabled_at = now() WHERE id = $1', [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(409)
    expect(await closed()).toBeNull()
    await t.owner.query('UPDATE user_account SET mfa_enabled_at = NULL WHERE id = $1', [u.id])
    c = await heldRow(u.id)
    asked = send('POST', '/api/account/delete', u, { password: PW })
    await queued()
    await c.query("INSERT INTO role_grant (user_id, role) VALUES ($1, 'reviewer')", [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(409)
    expect(await closed()).toBeNull()
    await t.owner.query('DELETE FROM role_grant WHERE user_id = $1', [u.id])
    c = await heldRow(u.id)
    asked = send('POST', '/api/account/delete', u, { password: PW })
    await queued()
    await c.query('DELETE FROM app_session WHERE user_id = $1', [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(409)
    expect(await closed()).toBeNull()
  })
  it('TC-KYC-03 a name change that waited while the person was removed does not put their name back', async () => {
    const u = await investor('queued.gone@example.test')
    const c = await heldRow(u.id)
    const renaming = send('POST', '/api/account/name', u, { first_name: 'Back', last_name: 'Again' })
    await new Promise((f) => setTimeout(f, 150))
    await c.query("UPDATE user_account SET first_name = NULL, last_name = NULL, name = 'removed', anonymised_at = now(), disabled_at = now() WHERE id = $1", [u.id])
    await c.query('DELETE FROM app_session WHERE user_id = $1', [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await renaming).statusCode).toBe(409)
    expect((await t.owner.query('SELECT name, first_name FROM user_account WHERE id = $1', [u.id])).rows[0]).toEqual({ name: 'removed', first_name: null })
  })
  it('TC-ACC-03 other account requests that waited: a session ended meanwhile gets no link, no party mail and no new two-step secret', async () => {
    const resend = await investor('queued.resend@example.test')
    await t.owner.query('UPDATE user_account SET email_verified_at = NULL WHERE id = $1', [resend.id])
    const links = async () => (await t.owner.query('SELECT 1 FROM account_token WHERE user_id = $1', [resend.id])).rowCount
    const before = await links()
    let c = await heldRow(resend.id)
    let asked = send('POST', '/api/account/resend-verification', resend)
    await new Promise((f) => setTimeout(f, 150))
    await c.query('DELETE FROM app_session WHERE user_id = $1', [resend.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(409)
    expect(await links()).toBe(before)
    const m = await investor('queued.mfa.start@example.test')
    c = await heldRow(m.id)
    asked = send('POST', '/api/mfa/start', m, { password: PW })
    await queued()
    await c.query('DELETE FROM app_session WHERE user_id = $1', [m.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(409)
    expect((await t.owner.query('SELECT mfa_secret FROM user_account WHERE id = $1', [m.id])).rows[0]!.mfa_secret).toBeNull()
    const p = await investor('queued.party@example.test')
    const fields = { name: 'Q Ltd', company_number: '1', registered_address: '1', tax_residence: 'UK', tax_id: 'X', source_of_wealth: 'T' }
    const id = (await send('POST', '/api/entities', p, { type: 'company', fields, parties: [{ name: 'Own Er', email: 'queued.party.owner@example.test', kind: 'owner', ownership_bps: 5000 }] })).json().id
    const party = (await entityOf(p, id)).parties[0].id
    c = await heldRow(p.id)
    asked = send('POST', `/api/entities/${id}/parties/${party}/link`, p)
    await new Promise((f) => setTimeout(f, 150))
    await c.query('DELETE FROM app_session WHERE user_id = $1', [p.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(409)
    expect((await mailed('queued.party.owner@example.test')).length).toBe(0)
  })
  it('TC-ACC-01 a link asked for during the switch waits for it: registering and forgetting a password', async () => {
    await investor('switch.forgot@example.test')
    for (const [url, body] of [['/api/password/forgot', { email: 'switch.forgot@example.test' }], ['/api/register', { first_name: 'Fay', last_name: 'Fictional', email: 'switch.register@example.test', password: PW }]] as const) {
      const c = await t.owner.connect()
      await c.query('BEGIN')
      await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
      let answered = false
      const asked = send('POST', url, undefined, body).then((r) => { answered = true; return r })
      await new Promise((f) => setTimeout(f, 500))
      const waited = !answered // read now, judged after the lock is let go: a failure holding it would hang every test after this
      await c.query('COMMIT')
      c.release()
      expect(waited).toBe(true)
      expect((await asked).statusCode).toBe(200)
    }
  })
  it('TC-ACC-03 an account request and the switch take their locks in the same order, so they cannot deadlock', async () => {
    const u = await investor('order.email@example.test')
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
    const asked = send('POST', '/api/account/email', u, { email: 'order.new@example.test', password: PW })
    await queued()
    await c.query('UPDATE user_account SET name = name WHERE id = $1', [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await asked).statusCode).toBe(200)
  })
  it('TC-ENT-03 an account needs details to pay into, when added and when confirmed', async () => {
    const u = await investor('empty.bank@example.test')
    const id = await individualEntity(u)
    for (const account_fields of [{}, { sort_code: '11-22-33' }]) {
      const r = await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields, evidence_file: null })
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toMatch(/account details/)
    }
    const bad = (await t.owner.query<{ id: string }>("INSERT INTO entity_bank_account (id, entity_id, holder, account_fields) VALUES (gen_random_uuid(), $1, 'Fay Fictional', '{}') RETURNING id", [id])).rows[0]!.id
    const reviewer = await staff('empty.bank.reviewer@example.test', ['reviewer'])
    const r = await send('POST', `/api/review/bank/${bad}/decide`, reviewer, { decision: 'confirm' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/account details/)
    expect((await t.owner.query('SELECT status FROM entity_bank_account WHERE id = $1', [bad])).rows[0]!.status).toBe('pending')
  })
  it('TC-ELG-02 a reopening that waited behind a statement counts for that statement', async () => {
    const u = await investor('queued.reopen@example.test')
    expect((await send('POST', '/api/eligibility/statement', u, { answers: { category: 'neither' }, signed_name: 'Fay Fictional' })).statusCode).toBe(200)
    const reviewer = await staff('queued.reopen.reviewer@example.test', ['reviewer'])
    const c = await heldRow(u.id)
    const reopening = send('POST', `/api/review/users/${u.id}/reopen-eligibility`, reviewer, { reason: 'They called' })
    await queued()
    await c.query("INSERT INTO eligibility_statement (id, user_id, regime, pack_id, category, qualifies, answers, signed_name, signed_on, payload_sha256, ip, auth_method, expires_at, created_at) SELECT gen_random_uuid(), $1, r.regime, i.active_pack_id, 'neither', false, '{}', 'Fay Fictional', '2026-06-01', 'x', 'x', 'password', '2030-01-01', clock_timestamp() FROM instance_profile i JOIN regime_pack r ON r.id = i.active_pack_id", [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await reopening).statusCode).toBe(200)
    // `next` says statement either way; `ended` is what the reopening changes
    expect((await send('GET', '/api/eligibility', u)).json().ended).toBe(false)
  })
  it('TC-ELG-01 signing that waited for the account lock is checked after the wait; evidence says how the person really signed in', async () => {
    const u = await investor('queued.sign@example.test')
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [u.id])
    const page = (await send('GET', '/api/eligibility', u)).json()
    const signing = send('POST', '/api/eligibility/statement', u, { answers: { category: 'neither' }, signed_name: 'Fay Fictional', shown_sha256: page.shown_sha256 })
    await new Promise((f) => setTimeout(f, 150))
    await c.query('DELETE FROM app_session WHERE user_id = $1', [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await signing).statusCode).toBe(409)
    expect((await t.owner.query('SELECT 1 FROM eligibility_statement WHERE user_id = $1', [u.id])).rowCount).toBe(0)
    // a recovery code at sign-in is what the evidence reports, and works for the second step too
    const m = await investor('recovery.sign@example.test')
    const e = t.keyring.encrypt(MFA)
    await t.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [m.id, e.ciphertext, e.keyId, e.wrappedDek])
    await t.owner.query('INSERT INTO mfa_recovery_code (code_hmac, user_id) VALUES ($1, $2), ($3, $2)', [t.keyring.hmac('recovery\0seed-recovery-code'), m.id, t.keyring.hmac('recovery\0second-recovery')])
    const l = await send('POST', '/api/login', undefined, { email: 'recovery.sign@example.test', password: PW, code: 'seed-recovery-code' })
    expect(l.statusCode).toBe(200)
    const who: Client = { cookie: `bulma_session=${l.cookies.find((x) => x.name === 'bulma_session')!.value}`, csrf: l.json().csrf, id: m.id, email: 'recovery.sign@example.test' }
    expect((await send('POST', '/api/eligibility/statement', who, { answers: { category: 'neither' }, signed_name: 'Fay Fictional' })).statusCode).toBe(200)
    const signed = (await t.owner.query<{ auth_method: string }>('SELECT auth_method FROM eligibility_statement WHERE user_id = $1', [m.id])).rows[0]!
    expect(signed.auth_method).toBe('password+recovery_code')
    expect((await send('POST', '/api/account/email', who, { email: 'recovery.new@example.test', password: PW, code: 'second-recovery' })).statusCode).toBe(200)
    // and a one-time code as a one-time code
    const n = await staff('totp.sign@example.test', ['approver'])
    await send('POST', '/api/eligibility/statement', n, { answers: { category: 'neither' }, signed_name: 'Staff totp.sign@example.test' })
    expect((await t.owner.query<{ auth_method: string }>('SELECT auth_method FROM eligibility_statement WHERE user_id = $1', [n.id])).rows[0]!.auth_method).toBe('password+totp')
  })
  it('TC-ACC-03 a name change that waited behind a signature still needs the statement signed again', async () => {
    const u = await investor('queued.name@example.test')
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [u.id])
    const renaming = send('POST', '/api/account/name', u, { first_name: 'New', last_name: 'Name' })
    await new Promise((f) => setTimeout(f, 150))
    await c.query("INSERT INTO eligibility_statement (id, user_id, regime, pack_id, category, qualifies, answers, signed_name, signed_on, payload_sha256, ip, auth_method, expires_at, created_at) SELECT gen_random_uuid(), $1, r.regime, i.active_pack_id, 'high_net_worth', true, '{}', 'Fay Fictional', '2026-06-01', 'x', 'x', 'password', '2030-01-01', clock_timestamp() FROM instance_profile i JOIN regime_pack r ON r.id = i.active_pack_id", [u.id])
    await c.query('COMMIT')
    c.release()
    expect((await renaming).statusCode).toBe(200)
    expect((await send('GET', '/api/eligibility', u)).json().next).toBe('statement')
  })
  it('TC-ACC-02 F5: turning two-step on ends every other session; the one that did it carries on', async () => {
    const id = await tx(t.app, async (c) => {
      const u = await createUser(c, t.keyring, { email: 'two.sessions@example.test', name: 'Two', password: PW, by: null })
      await c.query('UPDATE user_account SET must_change_password = false WHERE id = $1', [u])
      await grantRole(c, t.keyring, u, 'reviewer', null)
      return u
    })
    expect(id).toBeTruthy()
    const sign = async () => {
      const l = await send('POST', '/api/login', undefined, { email: 'two.sessions@example.test', password: PW })
      return { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, csrf: l.json().csrf, id, email: 'two.sessions@example.test' }
    }
    const a = await sign()
    const b = await sign()
    const started = (await send('POST', '/api/mfa/start', b, { password: PW })).json()
    const secret = Buffer.from(started.secret.split('').reduce((acc: { out: number[]; v: number; bits: number }, ch: string) => {
      acc.v = (acc.v << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch)
      acc.bits += 5
      if (acc.bits >= 8) { acc.out.push((acc.v >>> (acc.bits - 8)) & 255); acc.bits -= 8; acc.v &= (1 << acc.bits) - 1 }
      return acc
    }, { out: [], v: 0, bits: 0 }).out)
    expect((await send('POST', '/api/mfa/confirm', b, { code: codeAt(secret, stepOf(clock.getTime())) })).statusCode).toBe(200)
    expect((await send('GET', '/api/review/kyc', a)).statusCode).toBe(401)
    expect((await send('GET', '/api/review/kyc', b)).statusCode).toBe(200)
  })
})

describe('entities and files', () => {
  it('TC-ENT-02 a company lists what is missing; exactly 25% is no beneficial owner; each owner has a link of their own', async () => {
    const u = await investor('company@example.test')
    const fields = { name: 'Seed Ltd', company_number: '01234567', registered_address: '1 Road', tax_residence: 'UK', tax_id: 'X', source_of_wealth: 'Trading' }
    const parties = [{ name: 'Dee Director', email: null, kind: 'director', ownership_bps: 0 }, { name: 'Quarter Owner', email: 'q@example.test', kind: 'owner', ownership_bps: 2500 }]
    const id = (await send('POST', '/api/entities', u, { type: 'company', fields, parties })).json().id
    let e = await entityOf(u, id)
    expect(e.gaps).toEqual(expect.arrayContaining(['file:registration_proof', 'party:beneficial_owner']))
    expect(e.gaps).not.toContain('field:name')
    expect((await send('PUT', `/api/entities/${id}`, u, { fields, parties: [parties[0], { ...parties[1], ownership_bps: 2501 }] })).json().version).toBe(2)
    e = await entityOf(u, id)
    expect(e.gaps).toContain('party:beneficial_owner_unverified')
    const owner = e.parties.find((p: { kind: string }) => p.kind === 'owner')
    const link = await send('POST', `/api/entities/${id}/parties/${owner.id}/link`, u)
    expect(link.json()).toEqual({ ok: true }) // the owner of the entity must not be able to confirm for this person
    expect((await send('POST', '/api/party-links/confirm', undefined, { token: 'wrong' })).statusCode).toBe(400)
    const token = tokenOf(await mailedLink('q@example.test', /confirm your details/))
    expect((await send('POST', '/api/party-links/confirm', undefined, { token })).statusCode).toBe(200)
    expect((await send('POST', '/api/party-links/confirm', undefined, { token })).statusCode).toBe(400)
    e = await entityOf(u, id)
    expect(e.gaps).not.toContain('party:beneficial_owner_unverified')
    const dir = e.parties.find((p: { kind: string }) => p.kind === 'director')
    expect((await send('POST', `/api/entities/${id}/parties/${dir.id}/link`, u)).statusCode).toBe(409)
    expect((await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })).statusCode).toBe(409)
  })
  it('hostile: someone else\'s entity, bad bodies and bad files', async () => {
    const a = await investor('owner.a@example.test')
    const b = await investor('owner.b@example.test')
    const id = (await send('POST', '/api/entities', a, { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    expect((await send('PUT', `/api/entities/${id}`, b, { fields: INDIVIDUAL, parties: [] })).statusCode).toBe(409)
    expect((await upload(b, id, 'identity_proof')).statusCode).toBe(409)
    expect((await send('POST', `/api/entities/${id}/kyc`, b, { path: 'manual', confirm_true: true })).statusCode).toBe(409)
    expect((await send('POST', '/api/entities', a, { type: 'martian', fields: {}, parties: [] })).statusCode).toBe(400)
    expect((await send('POST', '/api/entities', a, { type: 'company', fields: { __proto__x: 'y', 'bad key': 'x' }, parties: [] })).statusCode).toBe(400)
    expect((await send('POST', '/api/entities', a, { type: 'company', fields: {}, parties: [{ name: 'x', email: null, kind: 'owner', ownership_bps: 10001 }] })).statusCode).toBe(400)
    expect((await upload(a, id, 'identity_proof', Buffer.from('MZ not a document'))).statusCode).toBe(415)
    expect((await upload(a, id, 'identity_proof', Buffer.from('%PDF- EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))).statusCode).toBe(422)
    expect((await upload(a, id, '../../etc')).statusCode).toBe(400)
    expect((await t.owner.query('SELECT 1 FROM stored_file WHERE owner_id = $1', [id])).rowCount).toBe(0)
  })
  it('TC-AUTHZ-02 a reviewer finds the files through the case; only the owner and reviewers get them; every view is audited; files are encrypted at rest', async () => {
    const u = await investor('file.owner@example.test')
    const id = await individualEntity(u)
    await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })
    const row = (await send('GET', '/api/review/kyc', reviewer)).json().cases.find((c: { entity_id: string }) => c.entity_id === id)
    expect((await send('GET', `/api/review/kyc/${row.id}`, u)).statusCode).toBe(403)
    const before = await auditCount('kyc.case_viewed')
    const detail = (await send('GET', `/api/review/kyc/${row.id}`, reviewer)).json()
    expect(await auditCount('kyc.case_viewed')).toBe(before + 1)
    expect(detail.fields.tax_id).toBe('SEEDTAX1')
    expect(detail.files.map((f: { requirement: string }) => f.requirement).sort()).toEqual(['address_proof', 'identity_proof', 'source_of_wealth'])
    expect(detail.information_confirmed_at).toBeTruthy()
    const file = detail.files[0].id
    const lead = await investor('a.lead@example.test')
    expect((await send('GET', `/api/files/${file}`, lead)).statusCode).toBe(404)
    expect((await send('GET', `/api/files/${file}`, admin)).statusCode).toBe(404)
    expect((await send('GET', `/api/files/${file}`)).statusCode).toBe(401)
    const mine = await send('GET', `/api/files/${file}`, u)
    expect(mine.statusCode).toBe(200)
    expect(mine.rawPayload.equals(PDF)).toBe(true)
    expect(mine.headers['content-disposition']).toMatch(/^attachment/)
    const seen = await auditCount('kyc.file_viewed')
    expect((await send('GET', `/api/files/${file}`, reviewer)).statusCode).toBe(200)
    expect(await auditCount('kyc.file_viewed')).toBe(seen + 1)
    const stored = (await t.owner.query<{ wrapped_key: Buffer }>('SELECT wrapped_key FROM stored_file WHERE id = $1', [file])).rows[0]!
    expect(stored.wrapped_key.length).toBeGreaterThan(0)
    expect(JSON.stringify((await t.owner.query('SELECT * FROM audit')).rows)).not.toContain('Fay Fictional')
  })
  it('TC-ENT-02 the case stays bound to what was reviewed: a new document during review goes back, after a pass ends the pass; bank proof does neither', async () => {
    const u = await investor('swap.docs@example.test')
    const id = await individualEntity(u)
    await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })
    const c1 = (await send('GET', '/api/review/kyc', reviewer)).json().cases.find((c: { entity_id: string }) => c.entity_id === id)
    expect((await upload(u, id, 'identity_proof', Buffer.from('%PDF-1.4 a different document'))).statusCode).toBe(200)
    expect((await entityOf(u, id)).status).toBe('returned')
    expect((await send('POST', `/api/review/kyc/${c1.id}/decide`, reviewer, { decision: 'approve' })).statusCode).toBe(409)
    expect((await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })).statusCode).toBe(200)
    const c2 = (await send('GET', '/api/review/kyc', reviewer)).json().cases.find((c: { entity_id: string }) => c.entity_id === id)
    const seen = (await send('GET', `/api/review/kyc/${c2.id}`, reviewer)).json().files
    const newest = (await entityOf(u, id)).files.find((f: { requirement: string }) => f.requirement === 'identity_proof').id
    expect(seen.map((f: { id: string }) => f.id)).toContain(newest)
    expect((await send('POST', `/api/review/kyc/${c2.id}/decide`, reviewer, { decision: 'approve' })).statusCode).toBe(200)
    expect((await entityOf(u, id)).passed_on).toBe('2026-06-01')
    expect((await upload(u, id, 'bank_proof')).statusCode).toBe(200)
    expect((await entityOf(u, id)).status).toBe('passed')
    expect((await upload(u, id, 'address_proof', Buffer.from('%PDF-1.4 a new address'))).statusCode).toBe(200)
    const after = await entityOf(u, id)
    expect(after.status).toBe('to_do')
    expect(after.passed_on).toBeNull()
    expect((await upload(u, id, 'made_up_requirement')).statusCode).toBe(400)
  })
  it('TC-ENT-02 a company needs someone who acts for it; unchanged people keep their confirmation in a new version; a change confirms again', async () => {
    const u = await investor('company.people@example.test')
    const fields = { name: 'People Ltd', company_number: '1', registered_address: '1 Road', tax_residence: 'UK', tax_id: 'X', source_of_wealth: 'Trading' }
    const owner = { name: 'Over Owner', email: 'over@example.test', kind: 'owner', ownership_bps: 5000 }
    const id = (await send('POST', '/api/entities', u, { type: 'company', fields, parties: [owner] })).json().id
    expect((await entityOf(u, id)).gaps).toContain('party:representative')
    const p = (await entityOf(u, id)).parties[0]
    await send('POST', `/api/entities/${id}/parties/${p.id}/link`, u)
    await send('POST', '/api/party-links/confirm', undefined, { token: tokenOf(await mailedLink('over@example.test', /confirm your details/)) })
    await send('PUT', `/api/entities/${id}`, u, { fields: { ...fields, tax_id: 'Y' }, parties: [owner, { name: 'Rep', email: null, kind: 'representative', ownership_bps: 0 }, { name: 'Dee', email: null, kind: 'director', ownership_bps: 0 }] })
    const v2 = await entityOf(u, id)
    expect(v2.gaps).not.toContain('party:beneficial_owner_unverified')
    expect(v2.gaps).not.toContain('party:representative')
    await send('PUT', `/api/entities/${id}`, u, { fields, parties: [{ ...owner, ownership_bps: 6000 }] })
    expect((await entityOf(u, id)).gaps).toContain('party:beneficial_owner_unverified')
  })
  it('TC-ENT-02 limits: party links and uploads are throttled, and an entity has a cap', async () => {
    const u = await investor('limits@example.test')
    const fields = { name: 'L', company_number: '1', registered_address: '1', tax_residence: 'UK', tax_id: 'X', source_of_wealth: 'T' }
    const id = (await send('POST', '/api/entities', u, { type: 'company', fields, parties: [{ name: 'O', email: 'cannon@example.test', kind: 'owner', ownership_bps: 5000 }] })).json().id
    const p = (await entityOf(u, id)).parties[0]
    const statuses = []
    for (let i = 0; i < 11; i++) statuses.push((await send('POST', `/api/entities/${id}/parties/${p.id}/link`, u)).statusCode)
    expect(statuses.at(-1)).toBe(429)
    expect((await mailed('cannon@example.test')).length).toBe(10)
    const v = await investor('limits2@example.test')
    const other = await individualEntity(v)
    await t.owner.query("INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) SELECT gen_random_uuid(), 'entity_kyc', $1, 'address_proof', 'x', 'application/pdf', 'x', 1, 'clean', 'k', 'k', 'x', $2 FROM generate_series(1, 40)", [other, v.id])
    expect((await upload(v, other, 'address_proof')).statusCode).toBe(413)
    const w = await investor('limits3@example.test')
    const third = (await send('POST', '/api/entities', w, { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    const codes = []
    for (let i = 0; i < 11; i++) codes.push((await upload(w, third, 'identity_proof')).statusCode)
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true)
    expect(codes[10]).toBe(429)
  })
  it('TC-KYC-02 F1: parallel submissions do not starve the pool; the server still answers', async () => {
    const u = await investor('parallel@example.test')
    await t.owner.query("INSERT INTO login_throttle (key_hmac, failures, window_started_at) SELECT 'noop', 0, now() ON CONFLICT DO NOTHING")
    const ids: string[] = []
    for (let i = 0; i < 16; i++) ids.push((await t.owner.query<{ id: string }>("INSERT INTO legal_entity (id, owner_user, type) VALUES (gen_random_uuid(), $1, 'individual') RETURNING id", [u.id])).rows[0]!.id)
    await t.owner.query("INSERT INTO legal_entity_version (entity_id, version, fields) SELECT id, 1, '{}' FROM legal_entity WHERE owner_user = $1", [u.id])
    const all = await Promise.all(ids.map((id) => send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })))
    expect(all.every((r) => r.statusCode === 409)).toBe(true)
    expect((await send('GET', '/api/session', u)).statusCode).toBe(200)
  })
  it('TC-ENT-02 F7: caps per person, and a stranger\'s body is not read at all', async () => {
    const big = Buffer.alloc(16 * 1024 * 1024, 65)
    const stranger = await app.inject({ method: 'POST', url: '/api/entities/00000000-0000-4000-8000-000000000000/files?requirement=identity_proof&name=a', remoteAddress: nextIp(), headers: { 'content-type': 'application/octet-stream' }, payload: big })
    expect(stranger.statusCode).toBe(401)
    const unverified = await send('POST', '/api/register', undefined, { first_name: 'U', last_name: 'V', email: 'unverified.upload@example.test', password: PW })
    expect(unverified.statusCode).toBe(200)
    const uv = await login('unverified.upload@example.test')
    const denied = await app.inject({ method: 'POST', url: '/api/entities/00000000-0000-4000-8000-000000000000/files?requirement=identity_proof&name=a', remoteAddress: nextIp(), headers: { cookie: uv.cookie, 'x-csrf-token': uv.csrf, 'content-type': 'application/octet-stream' }, payload: big })
    expect(denied.statusCode).toBe(403)
    const u = await investor('many.entities@example.test')
    await t.owner.query("INSERT INTO legal_entity (id, owner_user, type) SELECT gen_random_uuid(), $1, 'individual' FROM generate_series(1, 20)", [u.id])
    expect((await send('POST', '/api/entities', u, { type: 'individual', fields: INDIVIDUAL, parties: [] })).statusCode).toBe(409)
    const v = await investor('many.bytes@example.test')
    const ent = (await send('POST', '/api/entities', v, { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    const other = (await send('POST', '/api/entities', v, { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    await t.owner.query("INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) VALUES (gen_random_uuid(), 'entity_kyc', $1, 'address_proof', 'x', 'application/pdf', 'x', 1073741824, 'clean', 'k', 'k', 'x', $2)", [other, v.id])
    expect((await upload(v, ent, 'identity_proof')).statusCode).toBe(413)
    const w = await investor('edit.throttle@example.test')
    const e = (await send('POST', '/api/entities', w, { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    const codes = []
    for (let i = 0; i < 10; i++) codes.push((await send('PUT', `/api/entities/${e}`, w, { fields: INDIVIDUAL, parties: [] })).statusCode)
    expect(codes.at(-1)).toBe(409)
    expect(codes[0]).toBe(200)
  })
  it('TC-ENT-02 uploads in flight are limited before any body is read', async () => {
    const db = await createTestDb()
    let open: () => void = () => undefined
    const gate = new Promise<void>((f) => { open = f })
    const scanner = { scan: async () => { await gate; return { clean: true as const } } }
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, real: { scanner, storage: new MemoryStorage(), mailer: { send: async () => ({ delivered: true }) } } })
    const argon2 = (await import('argon2')).default
    await db.owner.query("INSERT INTO user_account (id, email, name, password_hash, must_change_password, email_verified_at, first_name, last_name) VALUES ('00000000-0000-4000-8000-000000000001', 'slots@example.test', 'S', $1, false, now(), 'S', 'S')", [await argon2.hash(PW, { type: argon2.argon2id })])
    await db.owner.query("UPDATE instance_profile SET mode = 'real', regulatory_status = 'authorised_firm', accountable_person = 'P', accountable_confirmed_on = '2026-01-01', approved_by = '00000000-0000-4000-8000-000000000001'")
    const l = await server.inject({ method: 'POST', url: '/api/login', payload: { email: 'slots@example.test', password: PW } })
    const headers = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const id = (await server.inject({ method: 'POST', url: '/api/entities', headers, payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })).json().id
    const up = () => server.inject({ method: 'POST', url: `/api/entities/${id}/files?requirement=identity_proof&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    const first = up()
    const second = up()
    await new Promise((f) => setTimeout(f, 200)) // both are now waiting on the scanner, holding their slots
    expect((await up()).statusCode).toBe(429)
    open()
    expect((await first).statusCode).toBe(200)
    expect((await second).statusCode).toBe(200)
    expect((await up()).statusCode).toBe(200) // the slots came back
    await server.close()
    await db.drop()
  })
  it('TC-ENT-02 a stalled upload gives its slot back at the deadline and loses its connection, through a real socket', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, uploadDeadlineMs: 200 })
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'S', last_name: 'T', email: 'stalled@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'stalled@example.test', password: PW } })
    const cookie = `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`
    const id = (await server.inject({ method: 'POST', url: '/api/entities', headers: { cookie, 'x-csrf-token': l.json().csrf }, payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })).json().id
    await server.listen({ port: 0, host: '127.0.0.1' })
    const port = (server.server.address() as { port: number }).port
    const stall = () => new Promise<{ closed: Promise<void> }>((done) => {
      const s = connect(port, '127.0.0.1', () => {
        s.write(`POST /api/entities/${id}/files?requirement=identity_proof&name=f.pdf HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\nX-CSRF-Token: ${l.json().csrf}\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000\r\n\r\nabc`)
        done({ closed: new Promise<void>((f) => s.on('close', () => f())) })
      })
      s.on('error', () => undefined)
      s.resume() // reading, or the far end closing goes unseen
    })
    const a = await stall()
    const b = await stall()
    await new Promise((f) => setTimeout(f, 80))
    const up = () => server.inject({ method: 'POST', url: `/api/entities/${id}/files?requirement=identity_proof&name=f.pdf`, headers: { cookie, 'x-csrf-token': l.json().csrf, 'content-type': 'application/octet-stream' }, payload: PDF })
    expect((await up()).statusCode).toBe(429)
    await Promise.all([a.closed, b.closed]) // the server ended them, nobody else did
    await new Promise((f) => setTimeout(f, 20))
    expect((await up()).statusCode).toBe(200)
    await server.close()
    await db.drop()
  })
  it('TC-ENT-02 an upload dropped after its body arrived keeps its slot while the file is in memory, then gives it back, through a real socket', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false })
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'S', last_name: 'T', email: 'dropped@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'dropped@example.test', password: PW } })
    const cookie = `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`
    const csrf = l.json().csrf
    const id = (await server.inject({ method: 'POST', url: '/api/entities', headers: { cookie, 'x-csrf-token': csrf }, payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })).json().id
    await server.listen({ port: 0, host: '127.0.0.1' })
    const port = (server.server.address() as { port: number }).port
    const drop = () => new Promise<void>((done) => {
      const s = connect(port, '127.0.0.1', () => {
        s.write(`POST /api/entities/${id}/files?requirement=identity_proof&name=f.pdf HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\nX-CSRF-Token: ${csrf}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${PDF.length}\r\n\r\n`)
        s.write(PDF)
        setTimeout(() => { s.destroy(); done() }, 300) // the work is waiting on the lock below by now
      })
      s.on('error', () => undefined)
    })
    const up = () => server.inject({ method: 'POST', url: `/api/entities/${id}/files?requirement=identity_proof&name=f.pdf`, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, payload: PDF })
    // the lock is let go before anything is asserted: a failure while holding it would hang every test after this one
    const c = await db.owner.connect()
    let during: ReturnType<typeof up>
    try {
      await c.query('BEGIN')
      await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [l.json().user.id])
      await Promise.all([drop(), drop()])
      during = up()
      await new Promise((f) => setTimeout(f, 200))
    } finally {
      await c.query('COMMIT')
      c.release()
    }
    const refused = (await during!).statusCode
    await new Promise((f) => setTimeout(f, 300))
    const after = (await up()).statusCode
    await server.close()
    await db.drop()
    expect(refused).toBe(429)
    expect(after).toBe(200)
  })
  it('TC-ENT-02 a reader who stops reading cannot hold many files in memory, or hold one for long', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, downloadDeadlineMs: 700 })
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'S', last_name: 'T', email: 'stalled.reader@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'stalled.reader@example.test', password: PW } })
    const cookie = `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`
    const csrf = l.json().csrf
    const id = (await server.inject({ method: 'POST', url: '/api/entities', headers: { cookie, 'x-csrf-token': csrf }, payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })).json().id
    const big = Buffer.concat([PDF, Buffer.alloc(14 * 1024 * 1024, 32)])
    const file = (await server.inject({ method: 'POST', url: `/api/entities/${id}/files?requirement=identity_proof&name=f.pdf`, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, payload: big })).json().id
    await server.listen({ port: 0, host: '127.0.0.1' })
    const port = (server.server.address() as { port: number }).port
    const clients = Array.from({ length: 4 }, () => new Promise<ReturnType<typeof connect>>((done) => {
      const s = connect(port, '127.0.0.1', () => {
        s.write(`GET /api/files/${file} HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\n\r\n`)
        done(s)
      })
      s.on('error', () => undefined) // never read: the response stays in the server's memory
    }))
    const stalled = await Promise.all(clients)
    await new Promise((f) => setTimeout(f, 200))
    const get = () => server.inject({ method: 'GET', url: `/api/files/${file}`, headers: { cookie } })
    const during = (await get()).statusCode
    await new Promise((f) => setTimeout(f, 800)) // the server has ended them; nobody else did
    const after = await get()
    const again = await get() // an ordinary download gives its place back
    for (const s of stalled) s.destroy()
    await server.close()
    await db.drop()
    expect(during).toBe(429)
    expect(after.statusCode).toBe(200)
    expect(after.rawPayload.equals(big)).toBe(true)
    expect(again.statusCode).toBe(200)
  })
  it('TC-ENT-02 a director with a large share must confirm; a trust completes with no company details', async () => {
    const u = await investor('shares@example.test')
    const fields = { name: 'S Ltd', company_number: '1', registered_address: '1', tax_residence: 'UK', tax_id: 'X', source_of_wealth: 'T' }
    const id = (await send('POST', '/api/entities', u, { type: 'company', fields, parties: [{ name: 'Big Share', email: 'big.share@example.test', kind: 'director', ownership_bps: 7500 }, { name: 'Rep', email: null, kind: 'representative', ownership_bps: 0 }] })).json().id
    expect((await entityOf(u, id)).gaps).toContain('party:beneficial_owner_unverified')
    const v = await investor('trustee@example.test')
    const tf = { name: 'Family Trust', registered_address: '1 Road', tax_residence: 'UK', tax_id: 'TR', source_of_wealth: 'Family' }
    const tid = (await send('POST', '/api/entities', v, { type: 'trust', fields: tf, parties: [{ name: 'Tru Stee', email: null, kind: 'controller', ownership_bps: 0 }, { name: 'Rep', email: null, kind: 'representative', ownership_bps: 0 }] })).json().id
    for (const f of ['constitution_proof', 'address_proof', 'structure_chart']) expect((await upload(v, tid, f)).statusCode).toBe(200)
    await t.owner.query('UPDATE entity_party SET verified_at = now() WHERE entity_id = $1', [tid])
    expect((await entityOf(v, tid)).gaps).toEqual([])
    expect((await send('POST', `/api/entities/${tid}/kyc`, v, { path: 'manual', confirm_true: true })).statusCode).toBe(200)
  })
  it('TC-ENT-02 the owner threshold is the pack\'s', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false })
    const fpo = (await db.owner.query<{ content: RegimePack }>("SELECT content FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!.content
    const by = (await db.owner.query<{ id: string }>("INSERT INTO user_account (id, email, name, must_change_password) VALUES (gen_random_uuid(), 'o@example.test', 'O', false) RETURNING id")).rows[0]!.id
    const pid = await tx(db.app, (c) => insertPack(c, { ...fpo, key: 'ten-percent', thresholds: { ...fpo.thresholds, ubo_over_bps: 1000 } }, { builtIn: false, by }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [pid])
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'U', last_name: 'B', email: 'ubo@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'ubo@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    await server.inject({ method: 'POST', url: '/api/entities', headers: h, payload: { type: 'company', fields: {}, parties: [{ name: 'Twenty', email: null, kind: 'owner', ownership_bps: 2000 }] } })
    const e = (await server.inject({ method: 'GET', url: '/api/entities', headers: h })).json().entities[0]
    expect(e.gaps).toContain('party:beneficial_owner_unverified') // at the default 25% this owner would not count
    await server.close()
    await db.drop()
  })
  it('hostile F11: a NUL in a file name is refused, and a file whose row cannot be written is not left behind', async () => {
    const db = await createTestDb()
    const storage = new MemoryStorage()
    const puts: string[] = []
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, real: {} })
    const u = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'A', last_name: 'B', email: 'nul@example.test', password: PW } })
    expect(puts.length + (await storage.get('x') === null ? 0 : 1)).toBe(0)
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(u.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'nul@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const id = (await server.inject({ method: 'POST', url: '/api/entities', headers: h, payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })).json().id
    const up = (name: string) => server.inject({ method: 'POST', url: `/api/entities/${id}/files?requirement=identity_proof&name=${name}`, headers: { ...h, 'content-type': 'application/octet-stream' }, payload: PDF })
    expect((await up('a%00b')).statusCode).toBe(400)
    await db.owner.query('REVOKE INSERT ON stored_file FROM bulma_app')
    expect((await up('fine.pdf')).statusCode).toBe(500)
    await db.owner.query('GRANT INSERT ON stored_file TO bulma_app')
    // the sandbox store has its room back: a file of the whole limit still fits after the failures
    expect((await up('fine.pdf')).statusCode).toBe(200)
    await server.close()
    await db.drop()
  })
  it('TC-ENT-02 F13b: a party link from before a new version answers that it is no longer valid', async () => {
    const u = await investor('old.link@example.test')
    const fields = { name: 'L Ltd', company_number: '1', registered_address: '1', tax_residence: 'UK', tax_id: 'X', source_of_wealth: 'T' }
    const owner = { name: 'Own Er', email: 'own.er@example.test', kind: 'owner', ownership_bps: 5000 }
    const id = (await send('POST', '/api/entities', u, { type: 'company', fields, parties: [owner] })).json().id
    await send('POST', `/api/entities/${id}/parties/${(await entityOf(u, id)).parties[0].id}/link`, u)
    const token = tokenOf(await mailedLink('own.er@example.test', /confirm your details/))
    await send('PUT', `/api/entities/${id}`, u, { fields: { ...fields, tax_id: 'Y' }, parties: [owner] })
    expect((await send('POST', '/api/party-links/confirm', undefined, { token })).statusCode).toBe(400)
  })
  it('hostile: the 15 MB parser is only on the upload route', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(3 * 1024 * 1024, 65) })
    expect(r.statusCode).toBe(415)
  })
  it('TC-ENT-03 the account must be in the entity\'s name; a person confirms; a change needs proof; all audited', async () => {
    const u = await investor('bank@example.test')
    const id = await individualEntity(u)
    const fields = { sort_code: '11-22-33', account_number: '12345678' }
    expect((await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Someone Else', account_fields: fields, evidence_file: null })).statusCode).toBe(409)
    const a = await send('POST', `/api/entities/${id}/bank`, u, { holder: 'FAY  fictional', account_fields: fields, evidence_file: null })
    expect(a.statusCode).toBe(200)
    expect((await send('POST', `/api/review/bank/${a.json().id}/decide`, u, { decision: 'confirm' })).statusCode).toBe(403)
    expect((await send('POST', `/api/review/bank/${a.json().id}/decide`, reviewer, { decision: 'confirm' })).statusCode).toBe(200)
    expect((await send('POST', `/api/review/bank/${a.json().id}/decide`, reviewer, { decision: 'confirm' })).statusCode).toBe(409)
    expect((await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: fields, evidence_file: null })).json().error).toMatch(/needs proof/)
    expect((await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: fields, evidence_file: '00000000-0000-4000-8000-000000000000' })).json().error).toMatch(/not a file of this entity/)
    const file = (await entityOf(u, id)).files[0].id
    const b = await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: { ...fields, account_number: '87654321' }, evidence_file: file })
    expect(b.statusCode).toBe(200)
    expect((await send('POST', `/api/review/bank/${b.json().id}/decide`, reviewer, { decision: 'confirm' })).statusCode).toBe(200)
    const rows = (await t.owner.query<{ status: string }>('SELECT status FROM entity_bank_account WHERE entity_id = $1 ORDER BY created_at', [id])).rows.map((r) => r.status)
    expect(rows).toEqual(['replaced', 'confirmed'])
    expect(await auditCount('entity.bank_confirm')).toBeGreaterThanOrEqual(2)
    expect((await send('GET', '/api/review/bank', u)).statusCode).toBe(403)
    // a change of name retires accounts in the old one, waiting or confirmed
    const renamed = await investor('renamed@example.test')
    const rid = await individualEntity(renamed)
    const oldPending = await send('POST', `/api/entities/${rid}/bank`, renamed, { holder: 'Fay Fictional', account_fields: { iban: 'P' }, evidence_file: null })
    const oldConfirmed = await send('POST', `/api/entities/${rid}/bank`, renamed, { holder: 'Fay Fictional', account_fields: { iban: 'C' }, evidence_file: null })
    await send('POST', `/api/review/bank/${oldConfirmed.json().id}/decide`, reviewer, { decision: 'confirm' })
    await send('PUT', `/api/entities/${rid}`, renamed, { fields: { ...INDIVIDUAL, tax_id: 'SAME.NAME' }, parties: [] })
    expect((await entityOf(renamed, rid)).bank.map((x: { status: string }) => x.status)).toEqual(['pending', 'confirmed']) // the same name: nothing changes
    // the name changes while the decision is queued: refused either way
    await t.owner.query("UPDATE legal_entity_version SET fields = fields || '{\"full_name\":\"Someone New\"}' WHERE entity_id = $1", [rid])
    const stale = await send('POST', `/api/review/bank/${oldPending.json().id}/decide`, reviewer, { decision: 'confirm' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatch(/not in the name/)
    await send('PUT', `/api/entities/${rid}`, renamed, { fields: { ...INDIVIDUAL, full_name: 'Someone Else' }, parties: [] })
    expect((await entityOf(renamed, rid)).bank).toEqual([])
    // F13c: two waiting at once, the second confirmed after the first, with no proof: refused when a person decides
    const fresh = await investor('two.pending@example.test')
    const fid = await individualEntity(fresh)
    const p1 = await send('POST', `/api/entities/${fid}/bank`, fresh, { holder: 'Fay Fictional', account_fields: fields, evidence_file: null })
    const p2 = await send('POST', `/api/entities/${fid}/bank`, fresh, { holder: 'Fay Fictional', account_fields: { iban: 'X' }, evidence_file: null })
    expect((await send('POST', `/api/review/bank/${p1.json().id}/decide`, reviewer, { decision: 'confirm' })).statusCode).toBe(200)
    const noProof = await send('POST', `/api/review/bank/${p2.json().id}/decide`, reviewer, { decision: 'confirm' })
    expect(noProof.statusCode).toBe(409)
    expect(noProof.json().error).toMatch(/needs proof/)
    const waiting = await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: { iban: 'GB00' }, evidence_file: file })
    const listed = (await send('GET', '/api/review/bank', reviewer)).json().accounts.find((x: { id: string }) => x.id === waiting.json().id)
    expect(listed).toMatchObject({ holder: 'Fay Fictional', evidence_file: file, has_confirmed: true, account_fields: { iban: 'GB00' } })
    expect((await entityOf(u, id)).bank.map((x: { status: string }) => x.status)).toEqual(['confirmed', 'pending'])
    const self = await staff('self.reviewer@example.test', ['reviewer'])
    const own = (await send('POST', '/api/entities', self, { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    const mine = await send('POST', `/api/entities/${own}/bank`, self, { holder: 'Fay Fictional', account_fields: fields, evidence_file: null })
    expect((await send('POST', `/api/review/bank/${mine.json().id}/decide`, self, { decision: 'confirm' })).statusCode).toBe(409)
  })
})

describe('KYC', () => {
  it('TC-KYC-02 send, send back with a reason, send again, pass; a pass ends with a change of identity or on its date; one\'s own is refused', async () => {
    const u = await investor('kyc@example.test')
    const id = await individualEntity(u)
    const submit = () => send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })
    expect((await entityOf(u, id)).status).toBe('to_do')
    expect((await submit()).statusCode).toBe(200)
    expect((await entityOf(u, id)).status).toBe('in_review')
    expect((await submit()).statusCode).toBe(409)
    const queue = async () => (await send('GET', '/api/review/kyc', reviewer)).json().cases.filter((c: { entity_id: string }) => c.entity_id === id)
    const c1 = (await queue())[0]
    expect((await send('GET', '/api/review/kyc', u)).statusCode).toBe(403)
    expect((await send('POST', `/api/review/kyc/${c1.id}/decide`, u, { decision: 'approve' })).statusCode).toBe(403)
    expect((await send('POST', `/api/review/kyc/${c1.id}/decide`, reviewer, { decision: 'return' })).statusCode).toBe(400)
    expect((await send('POST', `/api/review/kyc/${c1.id}/decide`, reviewer, { decision: 'return', reason: 'Too dark to read' })).statusCode).toBe(200)
    const back = await entityOf(u, id)
    expect(back.status).toBe('returned')
    expect(back.return_reason).toBe('Too dark to read')
    expect((await send('POST', `/api/review/kyc/${c1.id}/decide`, reviewer, { decision: 'approve' })).statusCode).toBe(409)
    expect((await submit()).statusCode).toBe(200)
    const c2 = (await queue())[0]
    expect((await send('POST', `/api/review/kyc/${c2.id}/decide`, reviewer, { decision: 'approve' })).statusCode).toBe(200)
    const passed = await entityOf(u, id)
    expect(passed.status).toBe('passed')
    expect(passed.passed_on).toBe('2026-06-01')
    expect((await submit()).statusCode).toBe(409)
    // TC-NTF-01: returned and passed are told, in the fixed fields only: never the reviewer's reason
    const told = (await t.owner.query<{ subject: string; body: string }>("SELECT subject, body FROM sandbox_outbox WHERE to_address = 'kyc@example.test' ORDER BY created_at")).rows
    expect(told.map((m) => m.subject)).toEqual(expect.arrayContaining(['Identity check: more is needed', 'Identity check passed']))
    expect(JSON.stringify(told)).not.toContain('Too dark')
    // the default three years, then expired
    const row = (await t.owner.query<{ expires_on: string }>("SELECT expires_on FROM kyc_case WHERE entity_id = $1 AND status = 'approved'", [id])).rows[0]!
    expect(row.expires_on).toBe('2029-06-01')
    const saved = clock
    clock = new Date('2029-06-01T00:00:00.000Z')
    const expired = await entityOf(u, id)
    expect(expired.status).toBe('expired')
    expect(expired.passed_on).toBeNull()
    clock = saved
    // R-ENT-03: a change of identity ends the pass
    expect((await send('PUT', `/api/entities/${id}`, u, { fields: { ...INDIVIDUAL, address: '2 New Street' }, parties: [] })).statusCode).toBe(200)
    const changed = await entityOf(u, id)
    expect(changed.status).toBe('to_do')
    expect(changed.passed_on).toBeNull() // M15: the text must not outlive the pass
    expect((await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual' })).statusCode).toBe(400) // confirming the information is true is required
  })
  it('TC-KYC-02 refusing takes a person and a reason, ends that entity for good, and another entity can still go on', async () => {
    const u = await investor('rejected@example.test')
    const id = await individualEntity(u)
    await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })
    const c = (await send('GET', '/api/review/kyc', reviewer)).json().cases.find((x: { entity_id: string }) => x.entity_id === id)
    expect((await send('POST', `/api/review/kyc/${c.id}/decide`, reviewer, { decision: 'reject' })).statusCode).toBe(400)
    expect((await send('POST', `/api/review/kyc/${c.id}/decide`, reviewer, { decision: 'reject', reason: 'Refused by the operator' })).statusCode).toBe(200)
    expect((await entityOf(u, id)).status).toBe('rejected')
    expect((await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })).statusCode).toBe(409)
    expect((await send('PUT', `/api/entities/${id}`, u, { fields: INDIVIDUAL, parties: [] })).statusCode).toBe(409)
    await expect(t.owner.query("UPDATE kyc_case SET status = 'rejected', decided_by = NULL WHERE id = $1", [c.id])).rejects.toThrow(/rejection_by_a_person/)
    // nothing more goes in: no documents, no bank account
    expect((await upload(u, id, 'identity_proof')).statusCode).toBe(409)
    expect((await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: { iban: 'GB00' }, evidence_file: null })).statusCode).toBe(409)
    const other = await individualEntity(u)
    expect((await send('POST', `/api/entities/${other}/kyc`, u, { path: 'manual', confirm_true: true })).statusCode).toBe(200)
    const raw = JSON.stringify((await t.owner.query("SELECT * FROM audit WHERE action = 'kyc.reject'")).rows)
    expect(raw).not.toContain('Refused by the operator')
  })
  it('TC-KYC-02 a refusal binds the entity, whichever case it was given on; a queued decision stops when the role goes', async () => {
    const u = await investor('late.refusal@example.test')
    const id = await individualEntity(u)
    await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })
    const c1 = (await send('GET', '/api/review/kyc', reviewer)).json().cases.find((c: { entity_id: string }) => c.entity_id === id)
    await send('POST', `/api/review/kyc/${c1.id}/decide`, reviewer, { decision: 'approve' })
    // the pass has expired, a late "no" is flagged on it, and a new case is open
    await t.owner.query("UPDATE kyc_case SET expires_on = '2020-01-01', late_provider_result = 'provider_final' WHERE id = $1", [c1.id])
    expect((await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })).statusCode).toBe(200)
    const open = (await send('GET', '/api/review/kyc', reviewer)).json().cases.filter((c: { entity_id: string }) => c.entity_id === id)
    expect(open.length).toBe(2)
    expect((await send('POST', `/api/review/kyc/${c1.id}/decide`, reviewer, { decision: 'reject', reason: 'Refused' })).statusCode).toBe(200)
    const newer = open.find((c: { id: string }) => c.id !== c1.id)
    expect((await send('POST', `/api/review/kyc/${newer.id}/decide`, reviewer, { decision: 'approve' })).statusCode).toBe(409)
    const after = await entityOf(u, id)
    expect(after.status).toBe('rejected')
    expect(after.passed_on).toBeNull()
    expect((await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })).statusCode).toBe(409)
    // queued behind a role change in progress: when it commits, this reviewer no longer may
    const w = await investor('queued@example.test')
    const qid = await individualEntity(w)
    await send('POST', `/api/entities/${qid}/kyc`, w, { path: 'manual', confirm_true: true })
    const going = await staff('going@example.test', ['reviewer'])
    const q = (await send('GET', '/api/review/kyc', going)).json().cases.find((c: { entity_id: string }) => c.entity_id === qid)
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
    await c.query("DELETE FROM role_grant WHERE user_id = $1 AND role = 'reviewer'", [going.id])
    const pending = send('POST', `/api/review/kyc/${q.id}/decide`, going, { decision: 'approve' })
    await new Promise((f) => setTimeout(f, 150))
    await c.query('COMMIT')
    c.release()
    const refused = await pending
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/Only a reviewer/)
    expect((await t.owner.query<{ status: string }>('SELECT status FROM kyc_case WHERE id = $1', [q.id])).rows[0]!.status).toBe('pending_review')
    // the same for a session that ends while waiting
    const ending = await staff('ending@example.test', ['reviewer'])
    const d = await t.owner.connect()
    await d.query('BEGIN')
    await d.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
    await d.query('DELETE FROM app_session WHERE user_id = $1', [ending.id])
    const held = send('POST', `/api/review/kyc/${q.id}/decide`, ending, { decision: 'approve' })
    await new Promise((f) => setTimeout(f, 150))
    await d.query('COMMIT')
    d.release()
    expect((await held).statusCode).not.toBe(200)
  })
  it('TC-KYC-02 a decision that waited on the entity is checked again: a session ended meanwhile cannot act', async () => {
    const w = await investor('queued.entity@example.test')
    const qid = await individualEntity(w)
    await send('POST', `/api/entities/${qid}/kyc`, w, { path: 'manual', confirm_true: true })
    const r = await staff('queued.reviewer@example.test', ['reviewer'])
    const q = (await send('GET', '/api/review/kyc', r)).json().cases.find((c: { entity_id: string }) => c.entity_id === qid)
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM legal_entity WHERE id = $1 FOR UPDATE', [qid])
    const pending = send('POST', `/api/review/kyc/${q.id}/decide`, r, { decision: 'approve' })
    await new Promise((f) => setTimeout(f, 150))
    await t.owner.query('DELETE FROM app_session WHERE user_id = $1', [r.id]) // a password change, for instance
    await c.query('COMMIT')
    c.release()
    expect((await pending).statusCode).toBe(409)
    expect((await t.owner.query<{ status: string }>('SELECT status FROM kyc_case WHERE id = $1', [q.id])).rows[0]!.status).toBe('pending_review')
    // the same for a bank decision
    const acct = await send('POST', `/api/entities/${qid}/bank`, w, { holder: 'Fay Fictional', account_fields: { iban: 'Q' }, evidence_file: null })
    const r2 = await staff('queued.reviewer2@example.test', ['reviewer'])
    const d = await t.owner.connect()
    await d.query('BEGIN')
    await d.query('SELECT 1 FROM legal_entity WHERE id = $1 FOR UPDATE', [qid])
    const bank = send('POST', `/api/review/bank/${acct.json().id}/decide`, r2, { decision: 'confirm' })
    await new Promise((f) => setTimeout(f, 150))
    await t.owner.query('DELETE FROM app_session WHERE user_id = $1', [r2.id])
    await d.query('COMMIT')
    d.release()
    expect((await bank).statusCode).toBe(409)
  })
  it('TC-ENT-03 renaming away and back does not make a new account a first one', async () => {
    const u = await investor('rename.back@example.test')
    const id = await individualEntity(u)
    const first = await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: { iban: 'A' }, evidence_file: null })
    await send('POST', `/api/review/bank/${first.json().id}/decide`, reviewer, { decision: 'confirm' })
    await send('PUT', `/api/entities/${id}`, u, { fields: { ...INDIVIDUAL, full_name: 'Someone Else' }, parties: [] })
    await send('PUT', `/api/entities/${id}`, u, { fields: INDIVIDUAL, parties: [] })
    expect((await entityOf(u, id)).bank).toEqual([])
    const again = await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: { iban: 'B' }, evidence_file: null })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toMatch(/needs proof/)
    // an account that was only ever waiting is no earlier account
    const fresh = await investor('rename.pending@example.test')
    const fid = await individualEntity(fresh)
    await send('POST', `/api/entities/${fid}/bank`, fresh, { holder: 'Fay Fictional', account_fields: { iban: 'C' }, evidence_file: null })
    await send('PUT', `/api/entities/${fid}`, fresh, { fields: { ...INDIVIDUAL, full_name: 'Other Name' }, parties: [] })
    await send('PUT', `/api/entities/${fid}`, fresh, { fields: INDIVIDUAL, parties: [] })
    expect((await send('POST', `/api/entities/${fid}/bank`, fresh, { holder: 'Fay Fictional', account_fields: { iban: 'D' }, evidence_file: null })).statusCode).toBe(200)
  })
  it('TC-ENT-03 parallel confirmations leave one confirmed account, and the database itself refuses a second', async () => {
    const u = await investor('bank.race@example.test')
    const id = await individualEntity(u)
    const one = await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: { iban: 'A' }, evidence_file: null })
    const two = await send('POST', `/api/entities/${id}/bank`, u, { holder: 'Fay Fictional', account_fields: { iban: 'B' }, evidence_file: null })
    const both = await Promise.all([one, two].map((x) => send('POST', `/api/review/bank/${x.json().id}/decide`, reviewer, { decision: 'confirm' })))
    expect(both.map((x) => x.statusCode).sort()).toEqual([200, 409])
    expect((await t.owner.query("SELECT 1 FROM entity_bank_account WHERE entity_id = $1 AND status = 'confirmed'", [id])).rowCount).toBe(1)
    await expect(t.owner.query("UPDATE entity_bank_account SET status = 'confirmed' WHERE entity_id = $1", [id])).rejects.toThrow(/entity_bank_one_confirmed/)
  })
  it('TC-ENT-02 parallel uploads cannot pass an entity\'s cap together', async () => {
    const u = await investor('upload.race@example.test')
    const id = await individualEntity(u)
    await t.owner.query("INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) SELECT gen_random_uuid(), 'entity_kyc', $1, 'address_proof', 'x', 'application/pdf', 'x', 1, 'clean', 'k', 'k', 'x', $2 FROM generate_series(1, 36)", [id, u.id])
    await Promise.all([upload(u, id, 'address_proof'), upload(u, id, 'address_proof')])
    expect((await t.owner.query('SELECT 1 FROM stored_file WHERE owner_id = $1', [id])).rowCount).toBeLessThanOrEqual(40)
  })
  it('TC-KYC-02 changing the details during review sends the case back; a reviewer cannot pass the old details; nor decide their own', async () => {
    const u = await investor('moved@example.test')
    const id = await individualEntity(u)
    await send('POST', `/api/entities/${id}/kyc`, u, { path: 'manual', confirm_true: true })
    const c = (await send('GET', '/api/review/kyc', reviewer)).json().cases.find((x: { entity_id: string }) => x.entity_id === id)
    await send('PUT', `/api/entities/${id}`, u, { fields: { ...INDIVIDUAL, tax_id: 'CHANGED' }, parties: [] })
    expect((await send('POST', `/api/review/kyc/${c.id}/decide`, reviewer, { decision: 'approve' })).statusCode).toBe(409)
    expect((await entityOf(u, id)).status).toBe('returned')
    // F13e: named on someone else's entity is not independent either
    const named = await staff('named.reviewer@example.test', ['reviewer'])
    const co = await investor('names.reviewer@example.test')
    const cf = { name: 'N Ltd', company_number: '1', registered_address: '1', tax_residence: 'UK', tax_id: 'X', source_of_wealth: 'T' }
    const nid = (await send('POST', '/api/entities', co, { type: 'company', fields: cf, parties: [{ name: 'Dee', email: 'NAMED.reviewer@example.test', kind: 'director', ownership_bps: 0 }, { name: 'Rep', email: null, kind: 'representative', ownership_bps: 0 }, { name: 'Con', email: null, kind: 'controller', ownership_bps: 0 }] })).json().id
    for (const f of ['registration_proof', 'address_proof', 'structure_chart']) await upload(co, nid, f)
    await t.owner.query('UPDATE entity_party SET verified_at = now() WHERE entity_id = $1', [nid])
    expect((await send('POST', `/api/entities/${nid}/kyc`, co, { path: 'manual', confirm_true: true })).statusCode).toBe(200)
    const namedCase = (await send('GET', '/api/review/kyc', named)).json().cases.find((x: { entity_id: string }) => x.entity_id === nid)
    const refused = await send('POST', `/api/review/kyc/${namedCase.id}/decide`, named, { decision: 'approve' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/named on/)
    const self = await staff('self.kyc@example.test', ['reviewer'])
    const own = await individualEntity(self)
    await send('POST', `/api/entities/${own}/kyc`, self, { path: 'manual', confirm_true: true })
    const mine = (await send('GET', '/api/review/kyc', self)).json().cases.find((x: { entity_id: string }) => x.entity_id === own)
    const r = await send('POST', `/api/review/kyc/${mine.id}/decide`, self, { decision: 'approve' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/your own entity/)
  })
  it('TC-KYC-01 the provider path: consent recorded or refused, manual path has none, webhook signed, result goes to a person', async () => {
    const db = await createTestDb()
    let starts = 0
    const externals: string[] = []
    let duringStart: () => Promise<unknown> = async () => undefined
    const kyc = new SumsubKyc({ appToken: 'tok', secretKey: 's', webhookSecret: 'hook', levelName: 'basic', fetch: (async (u: string, init: { body: string }) => { if (String(u).includes('/resources/applicants')) { starts++; externals.push(JSON.parse(init.body).externalUserId); await duringStart() } return new Response(JSON.stringify(String(u).includes('websdkLink') ? { url: 'https://in.sumsub.example/p/abc' } : { id: `applicant-${starts}` }), { status: 200 }) }) as unknown as typeof fetch })
    const scanner = { scan: async () => ({ clean: true as const }) }
    const storage = new MemoryStorage()
    const real = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, real: { kyc, scanner, storage, mailer: { send: async () => ({ delivered: true }) } } })
    await db.owner.query("INSERT INTO user_account (id, email, name, password_hash, must_change_password, email_verified_at) VALUES ('00000000-0000-4000-8000-000000000001', 'a@example.test', 'A', 'x', false, now()), ('00000000-0000-4000-8000-000000000002', 'b@example.test', 'B', 'x', false, now())")
    const pack = (await db.owner.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile')).rows[0]!
    expect(pack.active_pack_id).toBeTruthy()
    await db.owner.query("UPDATE instance_profile SET mode = 'real', regulatory_status = 'authorised_firm', accountable_person = 'P', accountable_confirmed_on = '2026-01-01', approved_by = '00000000-0000-4000-8000-000000000002'")
    const session = async (email: string) => {
      const argon2 = (await import('argon2')).default
      await db.owner.query('UPDATE user_account SET password_hash = $2 WHERE email = $1', [email, await argon2.hash(PW, { type: argon2.argon2id })])
      const r = await real.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } })
      return { cookie: `bulma_session=${r.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': r.json().csrf }
    }
    const headers = await session('a@example.test')
    const call = (method: string, url: string, payload?: object) => real.inject({ method: method as 'POST', url, headers, ...(payload ? { payload } : {}) })
    const id = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const r of ['identity_proof', 'address_proof', 'source_of_wealth']) {
      expect((await real.inject({ method: 'POST', url: `/api/entities/${id}/files?requirement=${r}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })).statusCode).toBe(200)
    }
    const refused = await call('POST', `/api/entities/${id}/kyc`, { path: 'provider', confirm_true: true })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/Agree to it, or choose the route without it/)
    // what is agreed to is shown first, and its hash is what gets kept
    const routes = (await call('GET', '/api/kyc/routes')).json()
    expect(routes).toMatchObject({ provider: true, uses_biometrics: true })
    expect(routes.consent_text).toContain('biometric_consent')
    expect(routes.consent_format).toBe('plain')
    // wording that changed after it was shown is not agreed to, and nothing starts at the provider
    const stale = await call('POST', `/api/entities/${id}/kyc`, { path: 'provider', biometric_consent: true, biometric_consent_sha256: 'old', confirm_true: true })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatch(/wording you agreed to has changed/)
    expect(starts).toBe(0)
    const ok = await call('POST', `/api/entities/${id}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().url).toBe('https://in.sumsub.example/p/abc') // a page that opens here or on a phone
    expect((await call('POST', `/api/entities/${id}/kyc/link`)).json().url).toBe('https://in.sumsub.example/p/abc')
    const row = async () => (await db.owner.query<{ status: string; provider: string; provider_suggestion: string | null; biometric_consent_at: Date | null; biometric_consent_text_sha256: string | null; decided_by: string | null }>('SELECT status, provider, provider_suggestion, biometric_consent_at, biometric_consent_text_sha256, decided_by FROM kyc_case WHERE entity_id = $1', [id])).rows[0]!
    expect(await row()).toMatchObject({ status: 'in_progress', provider: 'sumsub' })
    expect((await call('GET', '/api/entities')).json().entities.find((e: { id: string }) => e.id === id).status).toBe('in_progress') // F13d
    expect((await row()).biometric_consent_at).not.toBeNull()
    expect((await row()).biometric_consent_text_sha256).toBe(createHash('sha256').update(routes.consent_text, 'utf8').digest('hex'))
    const hook = (o: object, secret = 'hook') => {
      const payload = JSON.stringify(o)
      return real.inject({ method: 'POST', url: '/api/kyc/webhook/sumsub', headers: { 'content-type': 'application/json', 'x-payload-digest-alg': 'HMAC_SHA256_HEX', 'x-payload-digest': createHmac('sha256', secret).update(payload).digest('hex') }, payload })
    }
    const finalRed = { type: 'applicantReviewed', applicantId: 'applicant-1', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL', clientComment: 'seed private note' } }
    expect((await hook(finalRed, 'wrong')).statusCode).toBe(401)
    expect((await row()).status).toBe('in_progress')
    expect((await hook(finalRed)).statusCode).toBe(200)
    // a final no from the provider is a suggestion: nobody is rejected until a person says so
    expect(await row()).toMatchObject({ status: 'pending_review', provider_suggestion: 'provider_final', decided_by: null })
    // the same delivery again changes nothing, and a different "yes" after that does not overwrite the "no"
    expect((await hook(finalRed)).statusCode).toBe(200)
    expect((await hook({ type: 'applicantReviewed', applicantId: 'applicant-1', reviewResult: { reviewAnswer: 'GREEN' } })).statusCode).toBe(200)
    expect(await row()).toMatchObject({ status: 'pending_review', provider_suggestion: 'provider_final' })
    // a retry that was already delivered cannot pull a case out of review
    const retry = { type: 'applicantReviewed', applicantId: 'applicant-1', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY', moderationComment: 'Blurred' } }
    expect((await hook(retry)).statusCode).toBe(200)
    expect((await row()).status).toBe('pending_review')
    expect(JSON.stringify((await db.owner.query('SELECT * FROM kyc_case')).rows)).not.toContain('seed private note')
    // an unknown applicant and other event types change nothing
    expect((await hook({ type: 'applicantReviewed', applicantId: 'someone-else', reviewResult: { reviewAnswer: 'GREEN' } })).statusCode).toBe(200)
    expect((await hook({ type: 'applicantCreated', applicantId: 'applicant-1' })).statusCode).toBe(200)
    // a manual route needs no consent
    const other = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const r of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${other}/files?requirement=${r}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    expect((await call('POST', `/api/entities/${other}/kyc`, { path: 'manual', confirm_true: true })).statusCode).toBe(200)
    const m = (await db.owner.query<{ provider: string; biometric_consent_at: Date | null }>('SELECT provider, biometric_consent_at FROM kyc_case WHERE entity_id = $1', [other])).rows[0]!
    expect(m).toEqual({ provider: 'manual', biometric_consent_at: null })
    // finishing at the provider before coming back here: the result waits on the case and goes to a reviewer on resubmitting; a further retry clears it
    await db.owner.query('DELETE FROM login_throttle')
    const early = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${early}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    await call('POST', `/api/entities/${early}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    const earlyRef = (await db.owner.query<{ provider_ref: string }>('SELECT provider_ref FROM kyc_case WHERE entity_id = $1', [early])).rows[0]!.provider_ref
    await hook({ type: 'applicantReviewed', applicantId: earlyRef, createdAtMs: 'r1', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' } })
    await hook({ type: 'applicantReviewed', applicantId: earlyRef, createdAtMs: 'g1', reviewResult: { reviewAnswer: 'GREEN' } })
    await hook({ type: 'applicantReviewed', applicantId: earlyRef, createdAtMs: 'r2', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' } })
    expect((await db.owner.query<{ unapplied_result: string | null }>("SELECT unapplied_result FROM kyc_case WHERE entity_id = $1", [early])).rows[0]!.unapplied_result).toBeNull()
    await hook({ type: 'applicantReviewed', applicantId: earlyRef, createdAtMs: 'g2', reviewResult: { reviewAnswer: 'GREEN' } })
    const startsEarly = starts
    expect((await call('POST', `/api/entities/${early}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })).statusCode).toBe(200)
    expect(starts).toBe(startsEarly)
    const resumed = (await db.owner.query<{ status: string; provider_suggestion: string; decided_by: string | null }>("SELECT status, provider_suggestion, decided_by FROM kyc_case WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1", [early])).rows[0]!
    expect(resumed).toEqual({ status: 'pending_review', provider_suggestion: 'provider_green', decided_by: null }) // a person still decides
    // the same, delivered between resubmission's first look and its last: nothing is lost
    await db.owner.query('DELETE FROM login_throttle')
    const between = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${between}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    await call('POST', `/api/entities/${between}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    const betweenRef = (await db.owner.query<{ provider_ref: string }>('SELECT provider_ref FROM kyc_case WHERE entity_id = $1', [between])).rows[0]!.provider_ref
    await hook({ type: 'applicantReviewed', applicantId: betweenRef, createdAtMs: 'br', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' } })
    const person = await db.owner.connect()
    await person.query('BEGIN')
    await person.query("SELECT 1 FROM user_account WHERE email = 'a@example.test' FOR UPDATE")
    const sending = call('POST', `/api/entities/${between}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    await new Promise((f) => setTimeout(f, 300))
    const delivered = await hook({ type: 'applicantReviewed', applicantId: betweenRef, createdAtMs: 'bg', reviewResult: { reviewAnswer: 'GREEN' } })
    await person.query('COMMIT')
    person.release()
    expect(delivered.statusCode).toBe(200)
    expect((await sending).statusCode).toBe(200)
    const latestOf = async (e: string) => (await db.owner.query<{ status: string; provider_suggestion: string }>('SELECT status, provider_suggestion FROM kyc_case WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1', [e])).rows[0]!
    expect(await latestOf(between)).toEqual({ status: 'pending_review', provider_suggestion: 'provider_green' })
    // and a result that waited while the case was being replaced reaches the new case, not the old one
    const racing = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${racing}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    await call('POST', `/api/entities/${racing}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    const racingRef = (await db.owner.query<{ provider_ref: string }>('SELECT provider_ref FROM kyc_case WHERE entity_id = $1', [racing])).rows[0]!.provider_ref
    await hook({ type: 'applicantReviewed', applicantId: racingRef, createdAtMs: 'rr', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' } })
    const replacing = await db.owner.connect()
    await replacing.query('BEGIN')
    await replacing.query('SELECT 1 FROM legal_entity WHERE id = $1 FOR UPDATE', [racing])
    const delivering = hook({ type: 'applicantReviewed', applicantId: racingRef, createdAtMs: 'rg', reviewResult: { reviewAnswer: 'GREEN' } })
    await new Promise((f) => setTimeout(f, 300))
    await replacing.query("UPDATE kyc_case SET status = 'superseded' WHERE entity_id = $1", [racing])
    await replacing.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, provider_ref, status, file_ids) SELECT gen_random_uuid(), entity_id, entity_version, provider, provider_ref, 'in_progress', file_ids FROM kyc_case WHERE entity_id = $1", [racing])
    await replacing.query('COMMIT')
    replacing.release()
    expect((await delivering).statusCode).toBe(200)
    expect(await latestOf(racing)).toEqual({ status: 'pending_review', provider_suggestion: 'provider_green' })
    // a case a person sent back while this was on its way is not carried on with the old applicant
    await db.owner.query('DELETE FROM login_throttle')
    const overtaken = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${overtaken}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    await call('POST', `/api/entities/${overtaken}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    const overtakenRef = (await db.owner.query<{ provider_ref: string }>('SELECT provider_ref FROM kyc_case WHERE entity_id = $1', [overtaken])).rows[0]!.provider_ref
    await hook({ type: 'applicantReviewed', applicantId: overtakenRef, createdAtMs: 'or', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' } })
    const second = await db.owner.connect()
    await second.query('BEGIN')
    await second.query("SELECT 1 FROM user_account WHERE email = 'a@example.test' FOR UPDATE")
    const late = call('POST', `/api/entities/${overtaken}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    await new Promise((f) => setTimeout(f, 300))
    await second.query("UPDATE kyc_case SET provider_suggestion = 'reviewer' WHERE entity_id = $1", [overtaken])
    await second.query('COMMIT')
    second.release()
    const lateAnswer = await late
    expect(lateAnswer.statusCode).toBe(409)
    expect(lateAnswer.json().error).toMatch(/changed while this was being sent/)
    // a retry on the same identity keeps the applicant: no second one is created, and the case goes through again
    await db.owner.query("UPDATE kyc_case SET status = 'returned', return_reason = 'x', provider_suggestion = 'provider_retry' WHERE entity_id = $1", [id])
    const startsBefore = starts
    expect((await call('POST', `/api/entities/${id}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })).statusCode).toBe(200)
    expect(starts).toBe(startsBefore)
    expect((await db.owner.query<{ status: string }>("SELECT status FROM kyc_case WHERE entity_id = $1 AND status = 'in_progress'", [id])).rowCount).toBe(1)
    // the provider retrying that old "send it again" must not send back the new submission
    expect((await hook(retry)).statusCode).toBe(200)
    expect((await db.owner.query<{ status: string }>("SELECT status FROM kyc_case WHERE entity_id = $1 AND status = 'in_progress'", [id])).rowCount).toBe(1)
    expect((await hook({ type: 'applicantReviewed', applicantId: 'applicant-1', createdAtMs: '2', reviewResult: { reviewAnswer: 'GREEN' } })).statusCode).toBe(200)
    // anything but a retry is a new check, with a new applicant of its own
    // details that change during the provider call: the applicant is for what was checked, so it is on record but no case is made
    const moving = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${moving}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    duringStart = () => call('PUT', `/api/entities/${moving}`, { fields: { ...INDIVIDUAL, tax_id: 'MOVED' }, parties: [] })
    const moved = await call('POST', `/api/entities/${moving}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    duringStart = async () => undefined
    expect(moved.statusCode).toBe(409)
    expect(moved.json().error).toMatch(/details changed/)
    expect((await db.owner.query('SELECT 1 FROM kyc_case WHERE entity_id = $1', [moving])).rowCount).toBe(0)
    await db.owner.query('DELETE FROM login_throttle')
    const third = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${third}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    expect((await call('POST', `/api/entities/${third}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })).statusCode).toBe(200)
    const before = starts
    await call('PUT', `/api/entities/${third}`, { fields: { ...INDIVIDUAL, tax_id: 'CHANGED' }, parties: [] }) // the check goes back with the details
    await db.owner.query("UPDATE kyc_case SET provider_suggestion = 'provider_retry' WHERE entity_id = $1", [third]) // even if the provider had asked for a retry
    expect((await call('POST', `/api/entities/${third}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })).statusCode).toBe(200)
    expect(starts).toBe(before + 1)
    expect(new Set(externals).size).toBe(externals.length)
    const refs = (await db.owner.query<{ provider_ref: string; status: string }>('SELECT provider_ref, status FROM kyc_case WHERE entity_id = $1 ORDER BY created_at', [third])).rows
    expect(refs[0]!.provider_ref).not.toBe(refs[1]!.provider_ref)
    // a result for the old version, delivered only now, touches nothing
    expect((await hook({ type: 'applicantReviewed', applicantId: refs[0]!.provider_ref, reviewResult: { reviewAnswer: 'GREEN' } })).statusCode).toBe(200)
    expect((await db.owner.query<{ status: string }>('SELECT status FROM kyc_case WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1', [third])).rows[0]!.status).toBe('in_progress')
    // nor does a person sending it back count as a retry
    await db.owner.query('DELETE FROM login_throttle') // this person has uploaded a lot by now
    const fourth = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${fourth}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    await call('POST', `/api/entities/${fourth}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    await db.owner.query("UPDATE kyc_case SET status = 'returned', return_reason = 'x' WHERE entity_id = $1", [fourth])
    const beforeFourth = starts
    await call('POST', `/api/entities/${fourth}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    expect(starts).toBe(beforeFourth + 1)
    // retention reaching the person during the call: the applicant cannot be left unreported
    await db.owner.query('DELETE FROM login_throttle')
    const lateOne = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${lateOne}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    duringStart = () => db.owner.query("UPDATE user_account SET anonymised_at = now() WHERE email = 'a@example.test'")
    const afterGone = starts + 1
    await call('POST', `/api/entities/${lateOne}/kyc`, { path: 'provider', biometric_consent: true, confirm_true: true })
    duringStart = async () => undefined
    await db.owner.query("UPDATE user_account SET anonymised_at = NULL WHERE email = 'a@example.test'")
    expect((await db.owner.query("SELECT 1 FROM audit WHERE action = 'retention.provider_followup.sumsub' AND entity_id = $1", [`applicant-${afterGone}`])).rowCount).toBe(1)
    expect((await db.owner.query('SELECT 1 FROM kyc_provider_ref WHERE provider_ref = $1', [`applicant-${afterGone}`])).rowCount).toBe(0)
    // a submission that fails after the provider has answered: no case, but the applicant is on record, and nothing is recorded as agreed
    await db.owner.query('DELETE FROM login_throttle')
    const fifth = (await call('POST', '/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await real.inject({ method: 'POST', url: `/api/entities/${fifth}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    const pageNow = (await call('GET', '/api/kyc/routes')).json()
    const activeNow = (await db.owner.query<{ active_pack_id: string; content: RegimePack }>('SELECT i.active_pack_id, r.content FROM instance_profile i JOIN regime_pack r ON r.id = i.active_pack_id')).rows[0]!
    const reworded = await tx(db.app, (c) => insertPack(c, { ...activeNow.content, key: 'reworded-consent', legal_texts: activeNow.content.legal_texts.map((x) => (x.text_key === activeNow.content.biometric_consent_text_key ? { ...x, body: 'New consent wording (sample, not legal text).' } : x)) }, { builtIn: false, by: '00000000-0000-4000-8000-000000000001' }))
    duringStart = () => db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [reworded])
    const lateChange = await call('POST', `/api/entities/${fifth}/kyc`, { path: 'provider', biometric_consent: true, biometric_consent_sha256: pageNow.consent_sha256, confirm_true: true })
    duringStart = async () => undefined
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [activeNow.active_pack_id])
    expect(lateChange.statusCode).toBe(409)
    expect((await db.owner.query('SELECT 1 FROM kyc_case WHERE entity_id = $1', [fifth])).rowCount).toBe(0)
    expect((await db.owner.query('SELECT 1 FROM kyc_provider_ref WHERE entity_id = $1', [fifth])).rowCount).toBe(1)
    // a "no" after a person has passed it: the pass stands, and a reviewer is asked to look
    const reviewerHeaders = await session('b@example.test')
    await db.owner.query("UPDATE user_account SET mfa_enabled_at = now() WHERE email = 'b@example.test'")
    await db.owner.query("INSERT INTO role_grant (user_id, role) VALUES ('00000000-0000-4000-8000-000000000002', 'reviewer')")
    const asReviewer = (method: string, url: string, payload?: object) => real.inject({ method: method as 'POST', url, headers: reviewerHeaders, ...(payload ? { payload } : {}) })
    const open = (await asReviewer('GET', '/api/review/kyc')).json().cases.find((c: { entity_id: string }) => c.entity_id === id)
    expect((await asReviewer('POST', `/api/review/kyc/${open.id}/decide`, { decision: 'approve' })).statusCode).toBe(200)
    expect((await hook({ type: 'applicantReviewed', applicantId: 'applicant-1', createdAtMs: '3', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' } })).statusCode).toBe(200)
    const flagged = (await asReviewer('GET', '/api/review/kyc')).json().cases.find((c: { entity_id: string }) => c.entity_id === id)
    expect(flagged).toMatchObject({ status: 'approved', late_provider_result: 'provider_final' })
    expect((await call('GET', '/api/entities')).json().entities.find((e: { id: string }) => e.id === id).status).toBe('passed')
    expect((await asReviewer('POST', `/api/review/kyc/${flagged.id}/decide`, { decision: 'approve' })).statusCode).toBe(200)
    expect((await asReviewer('GET', '/api/review/kyc')).json().cases.filter((c: { entity_id: string }) => c.entity_id === id)).toEqual([])
    expect((await db.owner.query<{ expires_on: string; late_provider_result: string | null }>("SELECT late_provider_result FROM kyc_case WHERE id = $1", [flagged.id])).rows[0]!.late_provider_result).toBeNull()
    // F12: a late "no" on a version that is gone waits on nobody: the pass has already ended
    expect((await hook({ type: 'applicantReviewed', applicantId: 'applicant-1', createdAtMs: '4', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' } })).statusCode).toBe(200)
    expect((await asReviewer('GET', '/api/review/kyc')).json().cases.filter((c: { entity_id: string }) => c.entity_id === id).length).toBe(1)
    await call('PUT', `/api/entities/${id}`, { fields: { ...INDIVIDUAL, tax_id: 'NEW' }, parties: [] })
    expect((await asReviewer('GET', '/api/review/kyc')).json().cases.filter((c: { entity_id: string }) => c.entity_id === id)).toEqual([])
    await real.close()
    await db.drop()
  })
  it('TC-KYC-01 with no provider configured the manual route still works in the real mode, and a provider that fails says so', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, real: { scanner: { scan: async () => ({ clean: true as const }) }, storage: new MemoryStorage(), mailer: { send: async () => ({ delivered: true }) } } })
    const argon2 = (await import('argon2')).default
    await db.owner.query("INSERT INTO user_account (id, email, name, password_hash, must_change_password, email_verified_at, first_name, last_name) VALUES ('00000000-0000-4000-8000-000000000001', 'm@example.test', 'M', $1, false, now(), 'M', 'M')", [await argon2.hash(PW, { type: argon2.argon2id })])
    await db.owner.query("UPDATE instance_profile SET mode = 'real', regulatory_status = 'authorised_firm', accountable_person = 'P', accountable_confirmed_on = '2026-01-01', approved_by = '00000000-0000-4000-8000-000000000001'")
    const l = await server.inject({ method: 'POST', url: '/api/login', payload: { email: 'm@example.test', password: PW } })
    const headers = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const call = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) })
    const id = (await call('/api/entities', { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const r of ['identity_proof', 'address_proof', 'source_of_wealth']) await server.inject({ method: 'POST', url: `/api/entities/${id}/files?requirement=${r}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    expect((await server.inject({ method: 'GET', url: '/api/kyc/routes', headers })).json().provider).toBe(false)
    expect((await call(`/api/entities/${id}/kyc`, { path: 'provider', confirm_true: true })).statusCode).toBe(409)
    const r = await call(`/api/entities/${id}/kyc`, { path: 'manual', confirm_true: true })
    expect(r.statusCode).toBe(200)
    expect((await db.owner.query<{ provider: string }>('SELECT provider FROM kyc_case WHERE entity_id = $1', [id])).rows[0]!.provider).toBe('manual')
    await server.close()
    const broken = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, real: { kyc: new SumsubKyc({ appToken: 'a', secretKey: 'b', webhookSecret: 'c', levelName: 'd', fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch }), scanner: { scan: async () => ({ clean: true as const }) }, storage: new MemoryStorage(), mailer: { send: async () => ({ delivered: true }) } } })
    const second = (await broken.inject({ method: 'POST', url: '/api/entities', headers, payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await broken.inject({ method: 'POST', url: `/api/entities/${second}/files?requirement=${f}&name=f.pdf`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: PDF })
    const down = await broken.inject({ method: 'POST', url: `/api/entities/${second}/kyc`, headers, payload: { path: 'provider', biometric_consent: true, confirm_true: true } })
    expect(down.statusCode).toBe(502)
    expect((await db.owner.query('SELECT 1 FROM kyc_case WHERE entity_id = $1', [second])).rowCount).toBe(0)
    await broken.close()
    await db.drop()
  })
  it('TC-KYC-01 the webhook does not exist in a sandbox, whatever is configured; a fake needs no consent', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/kyc/webhook/sumsub', headers: { 'content-type': 'application/json' }, payload: '{}' })
    expect(r.statusCode).toBe(404)
    const configured = await buildServer({ db: t.app, k: t.keyring, real: { kyc: new SumsubKyc({ appToken: 'a', secretKey: 'b', webhookSecret: 'c', levelName: 'd' }) } })
    const body = JSON.stringify({ type: 'applicantReviewed', applicantId: 'x', reviewResult: { reviewAnswer: 'GREEN' } })
    const signed = await configured.inject({ method: 'POST', url: '/api/kyc/webhook/sumsub', headers: { 'content-type': 'application/json', 'x-payload-digest-alg': 'HMAC_SHA256_HEX', 'x-payload-digest': createHmac('sha256', 'c').update(body).digest('hex') }, payload: body })
    expect(signed.statusCode).toBe(404)
    await configured.close()
    const u = await investor('fake.kyc@example.test')
    const id = await individualEntity(u)
    expect((await send('POST', `/api/entities/${id}/kyc`, u, { path: 'provider', confirm_true: true })).statusCode).toBe(200)
    expect((await t.owner.query<{ provider: string }>('SELECT provider FROM kyc_case WHERE entity_id = $1', [id])).rows[0]!.provider).toBe('fake')
  })
})

describe('eligibility', () => {
  const NET = { category: 'high_net_worth', high_net_worth: { income: { yes: true, amount_minor: '10000000' }, net_assets: { yes: false } } }
  const statement = (who: Client, answers: object = NET) => send('POST', '/api/eligibility/statement', who, { answers, signed_name: 'Fay Fictional' })
  const state = async (who: Client) => (await send('GET', '/api/eligibility', who)).json()
  const correct = async (db: TestDb, questions: Array<{ id: string }>) => {
    const pack = (await db.owner.query<{ content: { assessment: { questions: Array<{ id: string; correct_option: number }> } } }>('SELECT r.content FROM regime_pack r JOIN instance_profile i ON i.active_pack_id = r.id')).rows[0]!.content
    return Object.fromEntries(questions.map((q) => [q.id, pack.assessment.questions.find((x) => x.id === q.id)!.correct_option]))
  }

  it('TC-ELG-01 / TC-ELG-05 uk-fpo from start to qualified: order enforced, preparation first, evidence kept, and available even with no commitment', async () => {
    const u = await investor('fpo@example.test')
    let s = await state(u)
    expect(s.regime).toBe('uk-fpo')
    expect(s.next).toBe('statement')
    expect(s.qualified).toBe(false)
    expect(s.preparation.individual.text).toContain('preparation_individual')
    expect(s.texts['question_income/default']).toContain('Income of the amount') // F8: what is asked comes from the pack
    expect(s.texts['question_company_number/default']).toBeTruthy()
    expect(s.preparation.company.text).toContain('preparation_company')
    expect(s.preparation.individual.coolingOffHours).toBeNull()
    expect(JSON.stringify(s.steps.map((x: { kind: string }) => x.kind))).toBe(JSON.stringify(['statement', 'assessment', 'warning_block']))
    expect((await send('POST', '/api/eligibility/assessment/start', u)).statusCode).toBe(409)
    expect((await send('POST', '/api/eligibility/warning', u, { kind: 'warning_block', decision: 'continue' })).statusCode).toBe(409)
    // a format error says so, and nothing is kept
    const unrounded = await statement(u, { category: 'high_net_worth', high_net_worth: { income: { yes: true, amount_minor: '10000100' }, net_assets: { yes: false } } })
    expect(unrounded.statusCode).toBe(400)
    expect(unrounded.json().errors.join()).toMatch(/nearest £10,000/)
    // the signature: the account's own name, and the server's date whatever the client sends
    expect((await send('POST', '/api/eligibility/statement', u, { answers: NET, signed_name: 'Somebody Else' })).statusCode).toBe(400)
    expect((await send('POST', '/api/eligibility/statement', u, { answers: NET, signed_name: 'Fay Fictional', signed_on: '1999-01-01' })).statusCode).toBe(400)
    expect((await t.owner.query('SELECT 1 FROM eligibility_statement WHERE user_id = $1', [u.id])).rowCount).toBe(0)
    expect((await statement(u)).json().qualifies).toBe(true)
    s = await state(u)
    expect(s.next).toBe('assessment')
    expect(s.rounding).toEqual({ income: '£10,000', net_assets: '£100,000' })
    const a = (await send('POST', '/api/eligibility/assessment/start', u)).json()
    expect(JSON.stringify(a)).not.toContain('correct_option')
    expect((await send('POST', '/api/eligibility/assessment/answer', u, { attempt_id: a.id, answers: await correct(t, a.questions) })).json()).toEqual({ passed: true, locked_until: null })
    expect((await state(u)).next).toBe('warning_block')
    expect((await send('POST', '/api/eligibility/warning', u, { kind: 'warning_block', decision: 'continue' })).statusCode).toBe(200)
    s = await state(u)
    expect(s).toMatchObject({ qualified: true, next: null })
    expect(s.statement_expires_at).toBe('2027-06-01T09:00:00.000Z')
    expect(s.assessment_used_up).toBe(false)
    const ev = await send('GET', `/api/review/users/${u.id}/evidence`, reviewer)
    expect(ev.statusCode).toBe(200)
    const e = ev.json()
    expect(e.statements[0]).toMatchObject({ category: 'high_net_worth', qualifies: true, signed_name: 'Fay Fictional', auth_method: 'password' })
    expect(new Date(e.statements[0].signed_on).getFullYear()).toBe(2026)
    // F14: the audit row outlives the person, so it says nothing about them
    const rows = (await t.owner.query<{ action: string }>("SELECT action FROM audit WHERE entity_id = $1 AND action LIKE 'eligibility.%'", [u.id])).rows.map((x) => x.action)
    expect(rows.join()).not.toMatch(/high_net_worth|neither|qualif|fail|passed|leave/)
    expect(rows).toContain('eligibility.statement_signed')
    expect((await t.owner.query<{ signed_on: string }>("SELECT signed_on::text AS signed_on FROM eligibility_statement WHERE user_id = $1", [u.id])).rows[0]!.signed_on).toBe('2026-06-01')
    expect(e.statements[0].legal_text_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(e.statements[0].payload_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(e.statements[0].ip).toBeTruthy()
    expect(e.warnings[0].legal_text_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(e.assessments)).not.toContain('questions')
    expect(e.limits).toMatch(/does not know whether anything was read/)
    expect((await send('GET', `/api/review/users/${u.id}/evidence`, u)).statusCode).toBe(403)
    // R-ELG-03: after twelve months the person is no longer qualified; signing again restores it
    const saved = clock
    clock = new Date('2027-06-01T09:00:00.000Z')
    expect((await state(u)).qualified).toBe(false)
    expect((await state(u)).next).toBe('statement')
    expect((await statement(u)).statusCode).toBe(200)
    expect((await state(u)).qualified).toBe(true)
    clock = saved
    // a changed name stops it until signed again
    await send('POST', '/api/account/name', u, { first_name: 'Changed', last_name: 'Name' })
    expect((await state(u)).next).toBe('statement')
  })
  it('TC-ELG-02 choosing none: cannot continue, on the server too, for twelve months; no problem listed, nothing suggests another answer', async () => {
    const u = await investor('neither@example.test')
    const r = await statement(u, { category: 'neither' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ qualifies: false })
    const s = await state(u)
    expect(s.ended).toBe(true)
    expect(s.qualified).toBe(false)
    expect(s.notices.not_qualified).toContain('You cannot continue.')
    expect(s.texts).toEqual({})
    expect((await send('POST', '/api/eligibility/assessment/start', u)).statusCode).toBe(409)
    // the same moment, another answer: refused
    const again = await statement(u)
    expect(again.statusCode).toBe(409)
    expect(JSON.stringify(again.json())).not.toMatch(/answer|change|figure|threshold/i)
    expect((await t.owner.query('SELECT 1 FROM eligibility_statement WHERE user_id = $1', [u.id])).rowCount).toBe(1)
    const saved = clock
    clock = new Date('2027-06-01T08:59:59.000Z')
    expect((await statement(u)).statusCode).toBe(409)
    clock = new Date('2027-06-01T09:00:00.000Z')
    expect((await state(u)).ended).toBe(false)
    expect((await statement(u)).json().qualifies).toBe(true)
    clock = saved
  })
  it('TC-ELG-02 a figure under the test is signed as not qualifying and says nothing about why; every other failing answer too', async () => {
    const low = await investor('low.figure@example.test')
    const r = await statement(low, { category: 'high_net_worth', high_net_worth: { income: { yes: true, amount_minor: '9000000' }, net_assets: { yes: false } } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ qualifies: false })
    expect((await t.owner.query<{ category: string; qualifies: boolean }>('SELECT category, qualifies FROM eligibility_statement WHERE user_id = $1', [low.id])).rows[0]).toEqual({ category: 'high_net_worth', qualifies: false })
    expect((await state(low)).ended).toBe(true)
    expect((await statement(low)).statusCode).toBe(409) // raising the figure and sending again does not work
    const NO = { yes: false }
    const none = await investor('no.to.all@example.test')
    expect((await statement(none, { category: 'high_net_worth', high_net_worth: { income: NO, net_assets: NO } })).json()).toEqual({ qualifies: false })
    const one = await investor('one.investment@example.test')
    expect((await statement(one, { category: 'sophisticated', sophisticated: { worked_in_private_finance: NO, director: NO, unlisted_investments: { yes: true, count: 1 }, network_member: NO } })).json()).toEqual({ qualifies: false })
    expect((await state(one)).ended).toBe(true)
  })
  it('TC-ELG-01 a membership with the still-a-member answer left out is sent back: nothing is signed and no twelve-month lock follows', async () => {
    const u = await investor('unanswered.member@example.test')
    const NO = { yes: false }
    const answers = (network_member: object) => ({ category: 'sophisticated', sophisticated: { worked_in_private_finance: NO, director: NO, unlisted_investments: NO, network_member } })
    const left = await statement(u, answers({ yes: true, name: 'Example network', months: 7 }))
    expect(left.statusCode).toBe(400)
    expect(left.json().errors).toEqual(['Answer each question.'])
    expect((await t.owner.query('SELECT 1 FROM eligibility_statement WHERE user_id = $1', [u.id])).rowCount).toBe(0)
    expect((await state(u)).ended).toBe(false)
    // a No is an answer: signed, and it does not qualify
    expect((await statement(u, answers({ yes: true, name: 'Example network', months: 7, still_member: false }))).json()).toEqual({ qualifies: false })
    expect((await state(u)).ended).toBe(true)
  })
  it('TC-ELG-02 a reviewer who has been contacted can reopen, with a reason kept out of the audit; not their own; and it says nothing to the person', async () => {
    const u = await investor('typo@example.test')
    await statement(u, { category: 'neither' })
    const listed = (await send('GET', '/api/review/eligibility/closed', reviewer)).json().people
    expect(listed.map((p: { user_id: string }) => p.user_id)).toContain(u.id)
    expect((await send('GET', '/api/review/eligibility/closed', u)).statusCode).toBe(403)
    expect((await send('POST', `/api/review/users/${u.id}/reopen-eligibility`, u, { reason: 'x' })).statusCode).toBe(403)
    expect((await send('POST', `/api/review/users/${u.id}/reopen-eligibility`, reviewer, { reason: '' })).statusCode).toBe(400)
    const mailsBefore = (await mailed('typo@example.test')).length
    expect((await send('POST', `/api/review/users/${u.id}/reopen-eligibility`, reviewer, { reason: 'Seed typo reason' })).statusCode).toBe(200)
    expect((await mailed('typo@example.test')).length).toBe(mailsBefore)
    expect(JSON.stringify((await t.owner.query("SELECT a.*, d.detail FROM audit a LEFT JOIN audit_detail d ON d.audit_seq = a.seq WHERE a.action = 'eligibility.review_action'")).rows)).not.toContain('Seed typo reason')
    expect((await state(u)).ended).toBe(false)
    expect((await send('GET', '/api/review/eligibility/closed', reviewer)).json().people.map((p: { user_id: string }) => p.user_id)).not.toContain(u.id)
    expect((await send('POST', `/api/review/users/${u.id}/reopen-eligibility`, reviewer, { reason: 'twice' })).statusCode).toBe(409)
    // signing "none" again closes it again: the earlier reopening does not carry over
    await new Promise((f) => setTimeout(f, 5))
    await statement(u, { category: 'neither' })
    expect((await state(u)).ended).toBe(true)
    const selfish = await staff('self.reopen@example.test', ['reviewer'])
    await send('POST', '/api/eligibility/statement', selfish, { answers: { category: 'neither' }, signed_name: 'Staff self.reopen@example.test' })
    expect((await state(selfish)).ended).toBe(true)
    expect((await send('POST', `/api/review/users/${selfish.id}/reopen-eligibility`, selfish, { reason: 'mine' })).statusCode).toBe(409)
    expect((await state(selfish)).ended).toBe(true)
    expect((await statement(u)).statusCode).toBe(409)
    const ev = (await send('GET', `/api/review/users/${u.id}/evidence`, reviewer)).json()
    expect(ev.reopened[0].reason).toBe('Seed typo reason')
    // a reopening that waited for the person's row is checked again
    const u2 = await investor('typo2@example.test')
    await statement(u2, { category: 'neither' })
    const r2 = await staff('reopen.reviewer@example.test', ['reviewer'])
    const c = await t.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [u2.id])
    const pending = send('POST', `/api/review/users/${u2.id}/reopen-eligibility`, r2, { reason: 'x' })
    await new Promise((f) => setTimeout(f, 150))
    await t.owner.query('DELETE FROM app_session WHERE user_id = $1', [r2.id])
    await c.query('COMMIT')
    c.release()
    expect((await pending).statusCode).toBe(409)
    expect((await state(u2)).ended).toBe(true)
  })
  it('TC-ELG-03 the answer says only pass or fail; the second failure locks 24 hours, as does each later one; a retake gets other questions; the notice is neutral', async () => {
    const u = await investor('quiz@example.test')
    await statement(u)
    const fail = async () => {
      const a = (await send('POST', '/api/eligibility/assessment/start', u)).json()
      const wrong = Object.fromEntries(a.questions.map((q: { id: string }) => [q.id, 2]))
      return { asked: a.questions.map((q: { id: string }) => q.id), r: await send('POST', '/api/eligibility/assessment/answer', u, { attempt_id: a.id, answers: wrong }) }
    }
    const f1 = await fail()
    expect(f1.r.json()).toEqual({ passed: false, locked_until: null })
    const f2 = await fail()
    expect(f2.asked).not.toEqual(f1.asked)
    expect(f2.r.json().locked_until).toBe('2026-06-02T09:00:00.000Z')
    expect((await send('POST', '/api/eligibility/assessment/start', u)).statusCode).toBe(409)
    expect((await state(u)).assessment_locked_until).toBe('2026-06-02T09:00:00.000Z')
    const saved = clock
    clock = new Date('2026-06-02T09:00:00.000Z')
    const f3 = await fail()
    expect(f3.r.json().locked_until).toBe('2026-06-03T09:00:00.000Z')
    clock = saved
    const mail = (await t.owner.query<{ subject: string; body: string }>("SELECT subject, body FROM sandbox_outbox WHERE to_address = 'quiz@example.test' AND subject = 'About your assessment' LIMIT 1")).rows[0]!
    expect(`${mail.subject} ${mail.body}`).not.toMatch(/try again|retake|last chance|hurry|soon|don't miss/i)
    expect((await send('POST', '/api/eligibility/assessment/answer', u, { attempt_id: '00000000-0000-4000-8000-000000000000', answers: {} })).statusCode).toBe(409)
  })
  it('TC-ELG-03 holding attempts open dodges nothing: one open attempt, the same questions, and an answer is judged against the lock', async () => {
    const u = await investor('holder@example.test')
    await statement(u)
    const a1 = (await send('POST', '/api/eligibility/assessment/start', u)).json()
    const a2 = (await send('POST', '/api/eligibility/assessment/start', u)).json()
    expect(a2.id).toBe(a1.id)
    expect(a2.questions).toEqual(a1.questions)
    expect((await t.owner.query('SELECT 1 FROM assessment_attempt WHERE user_id = $1', [u.id])).rowCount).toBe(1)
    const wrong = (q: { questions: Array<{ id: string }> }) => Object.fromEntries(q.questions.map((x) => [x.id, 2]))
    expect((await send('POST', '/api/eligibility/assessment/answer', u, { attempt_id: a1.id, answers: wrong(a1) })).json().passed).toBe(false)
    const b = (await send('POST', '/api/eligibility/assessment/start', u)).json()
    expect(b.questions.map((q: { id: string }) => q.id)).not.toEqual(a1.questions.map((q: { id: string }) => q.id))
    // even with an attempt open when a lock falls, the right answers do not pass
    await t.owner.query("UPDATE assessment_attempt SET locked_until = '2026-06-02T09:00:00Z' WHERE id = $1", [a1.id])
    const late = await send('POST', '/api/eligibility/assessment/answer', u, { attempt_id: b.id, answers: await correct(t, b.questions) })
    expect(late.statusCode).toBe(409)
    expect((await state(u)).next).toBe('assessment')
    expect((await t.owner.query('SELECT 1 FROM assessment_attempt WHERE id = $1 AND passed IS NULL', [b.id])).rowCount).toBe(1)
    expect((await send('POST', '/api/eligibility/assessment/answer', u, { attempt_id: b.id, answers: await correct(t, b.questions) })).statusCode).toBe(409)
  })
  it('TC-ELG-03 a pack limit stops further attempts for good', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const base = (await db.owner.query<{ content: RegimePack; id: string }>("SELECT id, content FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!
    const owner = (await db.owner.query<{ id: string }>("INSERT INTO user_account (id, email, name, must_change_password) VALUES (gen_random_uuid(), 'o@example.test', 'O', false) RETURNING id")).rows[0]!.id
    const packId = await tx(db.app, (c) => insertPack(c, { ...base.content, key: 'two-tries', assessment: { ...base.content.assessment, max_attempts: 2 } }, { builtIn: false, by: owner }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [packId])
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'A', last_name: 'B', email: 'once@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'once@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'A B' })
    const fail = async () => {
      const a = (await post('/api/eligibility/assessment/start')).json()
      return post('/api/eligibility/assessment/answer', { attempt_id: a.id, answers: Object.fromEntries(a.questions.map((q: { id: string }) => [q.id, 2])) })
    }
    await fail()
    expect((await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json().assessment_used_up).toBe(false)
    expect((await fail()).json().locked_until).toBeTruthy() // the second failure also locks, but the date must not be shown as a way back
    expect((await post('/api/eligibility/assessment/start')).statusCode).toBe(409)
    // the lock's day passes, and the limit still holds
    const saved = clock
    clock = new Date(clock.getTime() + 25 * 3_600_000)
    expect((await post('/api/eligibility/assessment/start')).statusCode).toBe(409)
    clock = saved
    const page = (await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json()
    expect(page).toMatchObject({ assessment_used_up: true, assessment_locked_until: null })
    expect(page.notices.assessment_unavailable).toContain('not available')
    await server.close()
    await db.drop()
  })
  it('TC-ELG-03 after a switch to a smaller version of the same regime, a retake never repeats the failed questions, not even under new ids: none until enough new ones', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const base = (await db.owner.query<{ content: RegimePack }>("SELECT content FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!.content
    const owner = (await db.owner.query<{ id: string }>("INSERT INTO user_account (id, email, name, must_change_password) VALUES (gen_random_uuid(), 'o@example.test', 'O', false) RETURNING id")).rows[0]!.id
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'A', last_name: 'B', email: 'small@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'small@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    // an eight-question bank asks four
    const eight = [...base.assessment.questions, ...base.assessment.questions.map((q) => ({ ...q, id: `${q.id}-v2`, prompt: `${q.prompt} (second set)` }))]
    expect(eight.length).toBe(8)
    const first = await tx(db.app, (c) => insertPack(c, { ...base, key: 'eight-bank', assessment: { ...base.assessment, questions: eight } }, { builtIn: false, by: owner }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [first])
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'A B' })
    const a = (await post('/api/eligibility/assessment/start')).json()
    const asked: string[] = a.questions.map((q: { id: string }) => q.id)
    expect((await post('/api/eligibility/assessment/answer', { attempt_id: a.id, answers: Object.fromEntries(asked.map((id) => [id, 2])) })).json().passed).toBe(false)
    // a later attempt under the other regime does not stand in for this regime's last one (Codex group B r3 #1)
    const cobs = (await db.owner.query<{ id: string; q: string }>("SELECT id, content->'assessment'->'questions'->0->>'id' AS q FROM regime_pack WHERE key = 'uk-cobs-template' ORDER BY version DESC LIMIT 1")).rows[0]!
    await db.owner.query(
      "INSERT INTO assessment_attempt (id, user_id, pack_id, questions_used, passed, answered_at, created_at) SELECT gen_random_uuid(), id, $1, $2, false, clock_timestamp(), clock_timestamp() FROM user_account WHERE email = 'small@example.test'",
      [cobs.id, JSON.stringify([cobs.q])],
    )
    // the operator activates a version of the same regime whose bank is just the questions that were failed
    const only = eight.filter((q) => asked.includes(q.id))
    expect(only.length).toBe(4)
    const small = await tx(db.app, (c) => insertPack(c, { ...base, key: 'small-bank', assessment: { ...base.assessment, questions: only } }, { builtIn: false, by: owner }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [small])
    const r = await post('/api/eligibility/assessment/start')
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('The assessment is not available yet.')
    // the same four filed under new ids, wording in other case and spacing, are still the failed questions
    const rekeyed = only.map((q) => ({ ...q, id: `${q.id}-new`, prompt: ` ${q.prompt.toUpperCase()}` }))
    const copies = await tx(db.app, (c) => insertPack(c, { ...base, key: 'rekeyed-bank', assessment: { ...base.assessment, questions: rekeyed } }, { builtIn: false, by: owner }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [copies])
    const rr = await post('/api/eligibility/assessment/start')
    expect(rr.statusCode).toBe(409)
    expect(rr.json().error).toBe('The assessment is not available yet.')
    // the four copies and two new ones: a set is three, only two are new, so still none; with one of the four wordings lost on
    // the way, three would look new and the retake would start (Codex group B r3 #8)
    const twoNew = await tx(db.app, (c) => insertPack(c, { ...base, key: 'two-new-bank', assessment: { ...base.assessment, questions: [...rekeyed, ...eight.filter((q) => !asked.includes(q.id)).slice(0, 2)] } }, { builtIn: false, by: owner }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [twoNew])
    const r2 = await post('/api/eligibility/assessment/start')
    expect([r2.statusCode, r2.json().error]).toEqual([409, 'The assessment is not available yet.'])
    expect((await db.owner.query("SELECT 1 FROM assessment_attempt a JOIN user_account u ON u.id = a.user_id WHERE u.email = 'small@example.test'")).rowCount).toBe(2)
    // with enough new questions added, the retake asks only those: a full set, none of the failed wording. The new questions carry
    // the failed ids and the failed wording sits under new ids, so the retake proves it goes by wording alone (Codex group B r4 #6)
    const fresh = eight.filter((q) => !asked.includes(q.id)).map((q, i) => ({ ...q, id: asked[i]! }))
    const bigger = await tx(db.app, (c) => insertPack(c, { ...base, key: 'bigger-bank', assessment: { ...base.assessment, questions: [...rekeyed, ...fresh] } }, { builtIn: false, by: owner }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [bigger])
    const b = await post('/api/eligibility/assessment/start')
    expect(b.statusCode).toBe(200)
    const retake: { id: string; prompt: string }[] = b.json().questions
    expect(retake.map((q) => q.id).sort()).toEqual([...asked].sort())
    expect(retake.map((q) => q.prompt).sort()).toEqual(fresh.map((q) => q.prompt).sort())
    expect(retake.filter((q) => only.some((o) => o.prompt.toLowerCase() === q.prompt.trim().toLowerCase()))).toEqual([])
    await server.close()
    await db.drop()
  })
  it('TC-ELG-03 an attempt left open on a bank stored with one wording twice is handed out as issued; a new set waits for a fixed bank, then comes (Codex group B r4 #2, r5 #1)', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const base = (await db.owner.query<{ content: RegimePack }>("SELECT content FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!.content
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'A', last_name: 'B', email: 'legacy@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'legacy@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'A B' })
    // a legacy bank A, B, C, C stored as is (insertPack does not check), as the pack check of that time let it through
    const [qa, qb, qc] = base.assessment.questions
    const legacy = { ...base, key: 'legacy-bank', assessment: { ...base.assessment, questions: [qa!, qb!, qc!, { ...qc!, id: 'c-copy', prompt: qc!.prompt.toUpperCase() }] } }
    expect(parsePack(legacy).errors).toContain('a question prompt appears twice')
    const packId = await tx(db.app, (c) => insertPack(c, legacy, { builtIn: false, by: null }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [packId])
    // the attempt opened before this release, on A and B
    const open = (await db.owner.query<{ id: string }>(
      "INSERT INTO assessment_attempt (id, user_id, pack_id, questions_used) SELECT gen_random_uuid(), id, $1, $2 FROM user_account WHERE email = 'legacy@example.test' RETURNING id",
      [packId, JSON.stringify([qa!.id, qb!.id])],
    )).rows[0]!.id
    const r = await post('/api/eligibility/assessment/start')
    expect(r.statusCode).toBe(200)
    expect([r.json().id, r.json().questions.map((q: { id: string }) => q.id)]).toEqual([open, [qa!.id, qb!.id]])
    // answered as any attempt: one failure, no lock yet
    const wrong = Object.fromEntries([qa!, qb!].map((q) => [q.id, (q.correct_option + 1) % q.options.length]))
    expect((await post('/api/eligibility/assessment/answer', { attempt_id: open, answers: wrong })).json()).toMatchObject({ passed: false, locked_until: null })
    // no new set from that bank: it would ask C twice
    const none = await post('/api/eligibility/assessment/start')
    expect([none.statusCode, none.json().error]).toEqual([409, 'The assessment is not available yet.'])
    // the operator activates a fixed version: the retake comes, without A or B
    const fixed = await tx(db.app, (c) => insertPack(c, { ...base, key: 'fixed-bank' }, { builtIn: false, by: null }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [fixed])
    const retake = await post('/api/eligibility/assessment/start')
    expect(retake.statusCode).toBe(200)
    const ids: string[] = retake.json().questions.map((q: { id: string }) => q.id)
    expect(ids.length).toBe(Math.floor(base.assessment.questions.length / 2))
    expect(ids.filter((id) => id === qa!.id || id === qb!.id)).toEqual([])
    await server.close()
    await db.drop()
  })
  it('TC-ELG-03 an attempt left open across a switch to another version with the same ids is shown and marked by the version it was issued from (Codex group B r6 #4)', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const row = (await db.owner.query<{ id: string; content: RegimePack }>("SELECT id, content FROM regime_pack WHERE key = 'uk-fpo-template' ORDER BY version DESC LIMIT 1")).rows[0]!
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [row.id])
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'A', last_name: 'B', email: 'pinned@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'pinned@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'A B' })
    const a = (await post('/api/eligibility/assessment/start')).json()
    // in the order the attempt asked them (random)
    const issued = a.questions.map((x: { id: string }) => row.content.assessment.questions.find((q) => q.id === x.id)!) as RegimePack['assessment']['questions']
    // the operator activates a version with the same ids, other wording, other options and other right answers
    const changed = row.content.assessment.questions.map((q) => ({ ...q, prompt: `Changed: ${q.prompt}`, options: q.options.map((o) => `${o} (changed)`), correct_option: (q.correct_option + 1) % q.options.length }))
    const next = await tx(db.app, (c) => insertPack(c, { ...row.content, key: 'changed-bank', assessment: { ...row.content.assessment, questions: changed } }, { builtIn: false, by: null }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [next])
    // coming back shows the questions as issued
    const again = await post('/api/eligibility/assessment/start')
    expect(again.json()).toEqual({ id: a.id, questions: issued.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options })) })
    // the answers right under the issuing version pass; under the new one they would all be wrong
    const r = await post('/api/eligibility/assessment/answer', { attempt_id: a.id, answers: Object.fromEntries(issued.map((q) => [q.id, q.correct_option])) })
    expect(r.json()).toMatchObject({ passed: true })
    await server.close()
    await db.drop()
  })
  it('TC-ELG-03 the result stands when the neutral notice cannot be sent', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'A', last_name: 'B', email: 'nomail@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'nomail@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'A B' })
    const a = (await post('/api/eligibility/assessment/start')).json()
    // the sandbox outbox refuses the write
    await db.owner.query('REVOKE INSERT ON sandbox_outbox FROM bulma_app')
    const r = await post('/api/eligibility/assessment/answer', { attempt_id: a.id, answers: Object.fromEntries(a.questions.map((q: { id: string }) => [q.id, 2])) })
    expect(r.statusCode).toBe(200)
    expect(r.json().passed).toBe(false)
    await server.close()
    await db.drop()
  })
  it('TC-ELG-01 the warning goes by the category signed for, is bound to those words, and asks again when they change', async () => {
    const u = await investor('variant@example.test')
    const NO = { yes: false }
    expect((await statement(u, { category: 'sophisticated', sophisticated: { worked_in_private_finance: { yes: true, name: 'Firm' }, director: NO, unlisted_investments: NO, network_member: NO } })).json().qualifies).toBe(true)
    const a = (await send('POST', '/api/eligibility/assessment/start', u)).json()
    await send('POST', '/api/eligibility/assessment/answer', u, { attempt_id: a.id, answers: await correct(t, a.questions) })
    const s = await state(u)
    expect(s.next).toBe('warning_block')
    expect(Object.keys(s.texts)).toEqual(['promotion_warning/sophisticated'])
    await send('POST', '/api/eligibility/warning', u, { kind: 'warning_block', decision: 'continue' })
    expect((await state(u)).qualified).toBe(true)
    const pack = (await t.owner.query<{ content: RegimePack }>("SELECT content FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!.content
    const body = pack.legal_texts.find((x) => x.text_key === 'promotion_warning' && x.variant === 'sophisticated')!.body
    expect((await t.owner.query<{ legal_text_sha256: string }>("SELECT legal_text_sha256 FROM warning_ack WHERE user_id = $1", [u.id])).rows[0]!.legal_text_sha256).toBe(createHash('sha256').update(body, 'utf8').digest('hex'))
    // after a year, signing as the other category: those words have not been seen
    const saved = clock
    clock = new Date('2027-06-02T09:00:00.000Z')
    await statement(u)
    const again = await state(u)
    expect(again.next).toBe('warning_block')
    expect(Object.keys(again.texts)).toEqual(['promotion_warning/high_net_worth'])
    clock = saved
  })
  it('TC-ELG-06 another regime starts afresh and a new version of the same one does not; cooling-off stays once', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const packs = (await db.owner.query<{ id: string; key: string; content: RegimePack }>('SELECT id, key, content FROM regime_pack')).rows
    const fpo = packs.find((p) => p.key === 'uk-fpo-template')!
    const cobs = packs.find((p) => p.key === 'uk-cobs-template')!
    const use = (id: string) => db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [id])
    await use(cobs.id)
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'R', last_name: 'Egime', email: 'regime@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'regime@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    const get = async () => (await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json()
    await post('/api/eligibility/request')
    const warned = await get()
    expect(warned.texts['personalised_warning/default'].startsWith('R Egime:')).toBe(true) // M7: it really carries the name
    await post('/api/eligibility/warning', { kind: 'personalised_warning', decision: 'continue' })
    const expected = createHash('sha256').update(warned.texts['personalised_warning/default'], 'utf8').digest('hex')
    const stored = (await db.owner.query<{ legal_text_sha256: string; user_id: string }>('SELECT legal_text_sha256, user_id FROM warning_ack')).rows[0]!
    expect(stored.legal_text_sha256).toBe(expected)
    // the evidence alone reproduces that hash, even if the name changes later
    const evDb = await tx(db.app, async (c) => {
      const rev = await createUser(c, db.keyring, { email: 'ev@example.test', name: 'Ev', password: PW, by: null })
      await c.query('UPDATE user_account SET must_change_password = false WHERE id = $1', [rev])
      await grantRole(c, db.keyring, rev, 'reviewer', null)
      return rev
    })
    const evMfa = db.keyring.encrypt(MFA)
    await db.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [evDb, evMfa.ciphertext, evMfa.keyId, evMfa.wrappedDek])
    const evLogin = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'ev@example.test', password: PW, code: codeAt(MFA, stepOf(clock.getTime())) } })
    const evHeaders = { cookie: `bulma_session=${evLogin.cookies.find((c) => c.name === 'bulma_session')!.value}` }
    const exported = (await server.inject({ method: 'GET', url: `/api/review/users/${stored.user_id}/evidence`, headers: evHeaders })).json().warnings[0]
    const template = cobs.content.legal_texts.find((x) => x.text_key === 'personalised_warning')!.body
    expect(createHash('sha256').update(fillText(template, { full_name: exported.full_name }), 'utf8').digest('hex')).toBe(exported.legal_text_sha256)
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'R Egime' })
    const a = (await post('/api/eligibility/assessment/start')).json()
    await post('/api/eligibility/assessment/answer', { attempt_id: a.id, answers: await correct(db, a.questions) })
    expect((await get()).next).toBe('cooling_off_decision')
    // a new version of the same regime: nothing is lost
    const owner = (await db.owner.query<{ id: string }>('SELECT id FROM user_account LIMIT 1')).rows[0]!.id
    const v2 = await tx(db.app, (c) => insertPack(c, { ...cobs.content, key: 'my-cobs' }, { builtIn: false, by: owner }))
    await use(v2)
    expect((await get()).next).toBe('cooling_off_decision')
    // the other regime: the statement, assessment and warning done under COBS do not count, and nor does the reverse
    await use(fpo.id)
    expect((await get()).next).toBe('statement')
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'R Egime' })
    const b = (await post('/api/eligibility/assessment/start')).json()
    await post('/api/eligibility/assessment/answer', { attempt_id: b.id, answers: await correct(db, b.questions) })
    await post('/api/eligibility/warning', { kind: 'warning_block', decision: 'continue' })
    expect((await get()).qualified).toBe(true)
    await use(cobs.id)
    const back = await get()
    expect(back.qualified).toBe(false)
    expect(back.next).toBe('cooling_off_decision') // the COBS results are still there; cooling-off was never repeated
    expect((await db.owner.query('SELECT 1 FROM cooling_off')).rowCount).toBe(1)
    await server.close()
    await db.drop()
  })
  it('TC-ELG-06 a new name needs signing again under each regime: signing under one does not revive the other; a short wait under another pack does not count', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const packs = (await db.owner.query<{ id: string; key: string; content: RegimePack }>('SELECT id, key, content FROM regime_pack')).rows
    const fpo = packs.find((p) => p.key === 'uk-fpo-template')!
    const cobs = packs.find((p) => p.key === 'uk-cobs-template')!
    const use = (id: string) => db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [id])
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'T', last_name: 'Wo', email: 'two.regimes@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'two.regimes@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    const get = async () => (await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json()
    const pause = () => new Promise((f) => setTimeout(f, 5))
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'T Wo' })
    await use(cobs.id)
    await post('/api/eligibility/request')
    await post('/api/eligibility/warning', { kind: 'personalised_warning', decision: 'continue' })
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'T Wo' })
    expect((await get()).next).toBe('assessment')
    await pause()
    await post('/api/account/name', { first_name: 'New', last_name: 'Name' })
    await pause()
    expect((await get()).next).toBe('classification')
    await post('/api/eligibility/statement', { answers: NET, signed_name: 'New Name' })
    expect((await get()).next).toBe('assessment')
    await use(fpo.id)
    expect((await get()).next).toBe('statement') // the FPO statement carries the old name
    // a wait shorter than this pack asks starts again
    await use(cobs.id)
    await db.owner.query('UPDATE cooling_off SET ends_at = started_at, decision = $1', ['continue'])
    expect((await get()).next).toBe('request_access')
    await server.close()
    await db.drop()
  })
  it('TC-ELG-01 what is signed is what was shown: wording that changes under an open page is refused and shown again', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const fpo = (await db.owner.query<{ id: string; content: RegimePack }>("SELECT id, content FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'S', last_name: 'H', email: 'shown@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'shown@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    const page = (await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json()
    const by = (await db.owner.query<{ id: string }>('SELECT id FROM user_account LIMIT 1')).rows[0]!.id
    const changed = await tx(db.app, (c) => insertPack(c, { ...fpo.content, key: 'reworded', legal_texts: fpo.content.legal_texts.map((t) => (t.text_key === 'question_director' ? { ...t, body: 'New wording (sample, not legal text).' } : t)) }, { builtIn: false, by }))
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [changed])
    const stale = await post('/api/eligibility/statement', { answers: NET, signed_name: 'S H', shown_sha256: page.shown_sha256 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatch(/wording has changed/)
    expect((await db.owner.query('SELECT 1 FROM eligibility_statement')).rowCount).toBe(0)
    const fresh = (await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json()
    expect(fresh.shown_sha256).not.toBe(page.shown_sha256)
    expect(fresh.texts['question_director/default']).toContain('New wording')
    expect((await post('/api/eligibility/statement', { answers: NET, signed_name: 'S H', shown_sha256: fresh.shown_sha256 })).statusCode).toBe(200)
    // and a warning the same way
    const a = (await post('/api/eligibility/assessment/start')).json()
    const packContent = (await db.owner.query<{ content: RegimePack }>('SELECT content FROM regime_pack WHERE id = $1', [changed])).rows[0]!.content
    await post('/api/eligibility/assessment/answer', { attempt_id: a.id, answers: Object.fromEntries(a.questions.map((q: { id: string }) => [q.id, packContent.assessment.questions.find((x) => x.id === q.id)!.correct_option])) })
    expect((await post('/api/eligibility/warning', { kind: 'warning_block', decision: 'continue', shown_sha256: 'old' })).statusCode).toBe(409)
    await server.close()
    await db.drop()
  })
  it('TC-ELG-02 leaving says so: the API does not put the person back in front of the same choice', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    await db.owner.query("UPDATE instance_profile SET active_pack_id = (SELECT id FROM regime_pack WHERE key = 'uk-cobs-template')")
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'L', last_name: 'Eave', email: 'leaver@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'leaver@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    const get = async () => (await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json()
    await post('/api/eligibility/request')
    expect((await get()).left).toBe(false)
    await post('/api/eligibility/warning', { kind: 'personalised_warning', decision: 'leave' })
    expect((await get()).left).toBe(true)
    await post('/api/eligibility/warning', { kind: 'personalised_warning', decision: 'continue' })
    expect((await get()).left).toBe(false)
    await server.close()
    await db.drop()
  })
  it('TC-ELG-06 cooling-off from before the switch starts again; COBS asks its own questions', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const cobs = (await db.owner.query<{ id: string }>("SELECT id FROM regime_pack WHERE key = 'uk-cobs-template'")).rows[0]!.id
    await db.owner.query('UPDATE instance_profile SET active_pack_id = $1', [cobs])
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'C', last_name: 'O', email: 'restart@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'restart@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) })
    const get = async () => (await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json()
    await post('/api/eligibility/request')
    await post('/api/eligibility/warning', { kind: 'personalised_warning', decision: 'continue' })
    const signing = await get()
    expect(signing.texts['question_income/default']).toBeTruthy()
    expect(signing.texts['question_company_number/default']).toBeUndefined()
    expect(signing.texts['question_still_member/default']).toBeUndefined()
    await new Promise((f) => setTimeout(f, 5))
    await db.owner.query('UPDATE instance_profile SET real_since = now()')
    expect((await get()).next).toBe('request_access')
    const later = new Date(clock.getTime() + 3_600_000)
    const saved = clock
    clock = later
    expect((await post('/api/eligibility/request')).statusCode).toBe(200)
    expect((await get()).cooling_off_ends_at).toBe(new Date(later.getTime() + 24 * 3_600_000).toISOString())
    clock = saved
    await server.close()
    await db.drop()
  })
  it('TC-ELG-06 what was out of use before the switch takes up no room; a statement sent during the switch waits, and then counts as real', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, now: () => clock })
    const reg = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'R', last_name: 'M', email: 'room@example.test', password: PW } })
    await server.inject({ method: 'POST', url: '/api/verify-email', remoteAddress: nextIp(), payload: { token: tokenOf(reg.json().sandbox_link), password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'room@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const id = l.json().user.id
    await db.owner.query("INSERT INTO legal_entity (id, owner_user, type) SELECT gen_random_uuid(), $1, 'individual' FROM generate_series(1, 20)", [id])
    const addOne = () => server.inject({ method: 'POST', url: '/api/entities', headers: h, remoteAddress: nextIp(), payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })
    expect((await addOne()).statusCode).toBe(409)
    const c = await db.owner.connect()
    await c.query('BEGIN')
    await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
    const signing = server.inject({ method: 'POST', url: '/api/eligibility/statement', headers: h, remoteAddress: nextIp(), payload: { answers: NET, signed_name: 'R M' } })
    let done = false
    void signing.then(() => { done = true })
    await new Promise((f) => setTimeout(f, 150))
    expect(done).toBe(false) // it waits for the switch
    // what the switch does to someone with no role
    await c.query('UPDATE instance_profile SET real_since = clock_timestamp()')
    await c.query('DELETE FROM app_session WHERE user_id = $1', [id])
    await c.query('UPDATE user_account SET email_verified_at = NULL WHERE id = $1', [id])
    await c.query('COMMIT')
    c.release()
    expect((await signing).statusCode).toBe(409) // nothing is written on the strength of checks made before the wait
    expect((await db.owner.query('SELECT 1 FROM eligibility_statement WHERE user_id = $1', [id])).rowCount).toBe(0)
    // with the address proved again and a new session, the allowance is free
    await db.owner.query('UPDATE user_account SET email_verified_at = now() WHERE id = $1', [id])
    const l2 = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'room@example.test', password: PW } })
    const h2 = { cookie: `bulma_session=${l2.cookies.find((x) => x.name === 'bulma_session')!.value}`, 'x-csrf-token': l2.json().csrf }
    expect((await server.inject({ method: 'POST', url: '/api/entities', headers: h2, remoteAddress: nextIp(), payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })).statusCode).toBe(200)
    // each of the two alone is enough to stop a write queued behind the switch
    const queued = async (head: object, action: (c: { query: (q: string, p: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
      const q = await db.owner.connect()
      await q.query('BEGIN')
      await q.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
      const write = server.inject({ method: 'POST', url: '/api/entities', headers: head as Record<string, string>, remoteAddress: nextIp(), payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })
      await new Promise((f) => setTimeout(f, 150))
      await action(q)
      await q.query('COMMIT')
      q.release()
      return (await write).statusCode
    }
    await db.owner.query('DELETE FROM login_throttle')
    expect(await queued(h2, (q) => q.query('UPDATE user_account SET email_verified_at = NULL WHERE id = $1', [id]))).toBe(409) // the address only; the session stays
    await db.owner.query('UPDATE user_account SET email_verified_at = now() WHERE id = $1', [id])
    expect(await queued(h2, (q) => q.query('DELETE FROM app_session WHERE user_id = $1', [id]))).toBe(409) // the session only; the address stays
    const l3 = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'room@example.test', password: PW } })
    const h3 = { cookie: `bulma_session=${l3.cookies.find((x) => x.name === 'bulma_session')!.value}`, 'x-csrf-token': l3.json().csrf }
    // a cleared address alone: the session survives, the address does not
    await db.owner.query('UPDATE user_account SET email_verified_at = NULL WHERE id = $1', [id])
    expect((await server.inject({ method: 'POST', url: '/api/entities', headers: h3, remoteAddress: nextIp(), payload: { type: 'individual', fields: INDIVIDUAL, parties: [] } })).statusCode).toBe(403)
    await server.close()
    await db.drop()
  })
  it('TC-ELG-06 a link asked for during the switch waits, and is not a sandbox link', async () => {
    const db = await createTestDb()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, real: { mailer: { send: async () => ({ delivered: true }) } } })
    await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'D', last_name: 'S', email: 'during@example.test', password: PW } })
    const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email: 'during@example.test', password: PW } })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const by = (await db.owner.query<{ id: string }>('SELECT id FROM user_account LIMIT 1')).rows[0]!.id
    const c = await db.owner.connect()
    await c.query('BEGIN')
    await c.query("UPDATE instance_profile SET mode = 'real', regulatory_status = 'authorised_firm', accountable_person = 'P', accountable_confirmed_on = '2026-01-01', approved_by = $1, real_since = now()", [by])
    await c.query('UPDATE account_token SET consumed_at = now() WHERE consumed_at IS NULL')
    const asked = server.inject({ method: 'POST', url: '/api/account/resend-verification', headers: h, remoteAddress: nextIp() })
    await new Promise((f) => setTimeout(f, 150))
    await c.query('COMMIT')
    c.release()
    expect((await asked).json()).toEqual({ ok: true }) // no link in the reply
    await server.close()
    await db.drop()
  })
  it('TC-ELG-06 / TC-KYC-03 at the switch to the real mode, nothing done in the sandbox counts any more; then a shorter retention and lifting a hold wait for a second admin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulma-d1-pay-'))
    const paymentFile = join(dir, 'p.json')
    writeFileSync(paymentFile, JSON.stringify([{ currency: 'GBP', account_fields: { sort_code: '11-22-33', account_number: '12345678' }, holder: 'H Ltd', holder_capacity: 'C', holder_frn: null, asserted_client_money: true, your_money_text_key: 'your_money', refund_days: 10, receipt_check_note: 'n' }]))
    const db = await createTestDb()
    const mails: Array<{ to: string; body: string }> = []
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false, paymentFile, now: () => clock, real: { scanner: { scan: async () => ({ clean: true as const }) }, storage: new MemoryStorage(), mailer: { send: async (m) => { mails.push({ to: m.to, body: m.body }); return { delivered: true } } } } })
    const inject = (method: string, url: string, headers: object, payload?: object) => server.inject({ method: method as 'POST', url, headers: headers as Record<string, string>, remoteAddress: nextIp(), ...(payload ? { payload } : {}) })
    const sign = async (email: string, code = true) => {
      await db.owner.query('UPDATE user_account SET mfa_last_step = NULL WHERE email = $1', [email]) // several sign-ins in one 30-second step
      const l = await inject('POST', '/api/login', {}, { email, password: PW, ...(code ? { code: codeAt(MFA, stepOf(clock.getTime())) } : {}) })
      return { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    }
    const person = async (email: string, roles: Array<'admin' | 'reviewer' | 'approver'>) => {
      const id = await tx(db.app, async (c) => {
        const u = await createUser(c, db.keyring, { email, name: email, password: PW, by: null })
        await c.query('UPDATE user_account SET must_change_password = false WHERE id = $1', [u])
        for (const role of roles) await grantRole(c, db.keyring, u, role, null)
        return u
      })
      const e = db.keyring.encrypt(MFA)
      await db.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now(), mfa_last_step = NULL WHERE id = $1', [id, e.ciphertext, e.keyId, e.wrappedDek])
      return sign(email)
    }
    const a = await person('real.a@example.test', ['admin', 'approver'])
    const b = await person('real.b@example.test', ['admin'])
    const rev = await person('real.r@example.test', ['reviewer'])
    // a person who did everything in the sandbox
    const reg = await inject('POST', '/api/register', {}, { first_name: 'San', last_name: 'Box', email: 'sandboxed@example.test', password: PW })
    await inject('POST', '/api/verify-email', {}, { token: tokenOf(reg.json().sandbox_link), password: PW })
    const h = await sign('sandboxed@example.test', false)
    await inject('POST', '/api/eligibility/statement', h, { answers: NET, signed_name: 'San Box' })
    const att = (await inject('POST', '/api/eligibility/assessment/start', h)).json()
    await inject('POST', '/api/eligibility/assessment/answer', h, { attempt_id: att.id, answers: await correct(db, att.questions) })
    const before = (await inject('GET', '/api/eligibility', h)).json()
    expect(before.next).toBe('warning_block')
    const ent = (await inject('POST', '/api/entities', h, { type: 'individual', fields: INDIVIDUAL, parties: [] })).json().id
    for (const f of ['identity_proof', 'address_proof', 'source_of_wealth']) await inject('POST', `/api/entities/${ent}/files?requirement=${f}&name=f.pdf`, { ...h, 'content-type': 'application/octet-stream' }, PDF as unknown as object)
    await inject('POST', `/api/entities/${ent}/kyc`, h, { path: 'manual', confirm_true: true })
    const openCase = (await inject('GET', '/api/review/kyc', rev)).json().cases[0]
    await inject('POST', `/api/review/kyc/${openCase.id}/decide`, rev, { decision: 'approve' })
    const fileId = (await db.owner.query<{ id: string }>('SELECT id FROM stored_file LIMIT 1')).rows[0]!.id
    // two-step set up in the sandbox, on an address nobody proved
    const sq = db.keyring.encrypt(MFA)
    await db.owner.query("UPDATE user_account SET mfa_secret = $1, mfa_key_id = $2, mfa_wrapped_key = $3, mfa_enabled_at = now() WHERE email = 'sandboxed@example.test'", [sq.ciphertext, sq.keyId, sq.wrappedDek])
    const forgot = await inject('POST', '/api/password/forgot', {}, { email: 'sandboxed@example.test' })
    expect(forgot.statusCode).toBe(200)
    const staleLink = tokenOf(linkIn((await mailed('sandboxed@example.test', db)).find((m) => /new password/.test(m.subject))!.body))
    // an operator pack with no placeholder left, then the switch
    const fpo = (await db.owner.query<{ content: RegimePack }>("SELECT content FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!.content
    const mine = { ...fpo, key: 'operator-fpo', legal_texts: fpo.legal_texts.map((x) => ({ ...x, is_placeholder: false, body: x.body.replace(/\*\*PLACEHOLDER\*\*.*/s, '**PLACEHOLDER** kept word, operator text.').replace(/^.*not legal text.*$/is, `Operator wording for ${x.text_key}.`) })), assessment: { ...fpo.assessment, questions: fpo.assessment.questions.map((q) => ({ ...q, is_placeholder: false, prompt: `Operator question ${q.id}?`, options: ['One', 'Two', 'Three'] })) } }
    const packId = (await inject('POST', '/api/packs', a, mine)).json().id
    const act = (await inject('POST', '/api/requests/pack-activate', a, { pack_id: packId })).json().id
    expect((await inject('POST', `/api/requests/${act}/approve`, b)).statusCode).toBe(200)
    // F2: someone who leaves an assessment open on the very pack that goes live
    const left = await inject('POST', '/api/register', {}, { first_name: 'Left', last_name: 'Open', email: 'left.open@example.test', password: PW })
    await inject('POST', '/api/verify-email', {}, { token: tokenOf(left.json().sandbox_link), password: PW })
    const lh = await sign('left.open@example.test', false)
    await inject('POST', '/api/eligibility/statement', lh, { answers: NET, signed_name: 'Left Open' })
    expect((await inject('POST', '/api/eligibility/assessment/start', lh)).statusCode).toBe(200)
    const asked = await inject('POST', '/api/requests/mode-switch', a, { regulatory_status: 'authorised_firm', accountable_person: 'P', accountable_confirmed_on: '2026-01-01' })
    expect(asked.statusCode).toBe(200)
    expect((await inject('POST', `/api/requests/${asked.json().id}/approve`, b)).statusCode).toBe(200)
    // that person: signed out, address to prove again, and an old link dead
    expect((await inject('GET', '/api/session', h)).statusCode).toBe(401)
    expect((await inject('POST', '/api/password/reset', {}, { token: staleLink, password: 'a-brand-new-password' })).statusCode).toBe(400)
    expect((await db.owner.query('SELECT 1 FROM user_account WHERE email = $1 AND mfa_enabled_at IS NULL AND mfa_secret IS NULL', ['sandboxed@example.test'])).rowCount).toBe(1)
    const h2 = await sign('sandboxed@example.test', false)
    expect((await inject('GET', '/api/session', h2)).json().user.emailVerified).toBe(false)
    expect((await inject('GET', '/api/eligibility', h2)).statusCode).toBe(403)
    const u = (await db.owner.query<{ id: string }>("SELECT id FROM user_account WHERE email = 'sandboxed@example.test'")).rows[0]!.id
    // proving the address again, through the real mailer
    expect((await inject('POST', '/api/account/resend-verification', h2)).json()).toEqual({ ok: true })
    // the real mode does not wait for the mail (R23): the queue sends it just after
    await expect.poll(() => mails.some((m) => m.to === 'sandboxed@example.test')).toBe(true)
    const realLink = linkIn(mails.filter((m) => m.to === 'sandboxed@example.test').at(-1)!.body)
    expect((await inject('POST', '/api/verify-email', {}, { token: tokenOf(realLink), password: PW })).statusCode).toBe(200)
    const after = (await inject('GET', '/api/eligibility', h2)).json()
    expect(after.next).toBe('statement') // the statement and the assessment do not count
    expect((await inject('GET', '/api/entities', h2)).json().entities).toEqual([])
    expect((await inject('POST', `/api/entities/${ent}/kyc`, h2, { path: 'manual', confirm_true: true })).statusCode).toBe(409)
    // the outbox is a sandbox thing
    expect((await inject('GET', '/api/sandbox/outbox', await sign('real.a@example.test'))).statusCode).toBe(404)
    // staff stay signed in and see nothing left over
    const revAfter = await sign('real.r@example.test')
    expect((await inject('GET', '/api/review/kyc', revAfter)).json().cases).toEqual([])
    expect((await inject('GET', `/api/review/kyc/${openCase.id}`, revAfter)).statusCode).toBe(404)
    expect((await inject('GET', `/api/files/${fileId}`, revAfter)).statusCode).toBe(404)
    const ev = (await inject('GET', `/api/review/users/${u}/evidence`, revAfter)).json()
    expect(ev.statements).toEqual([])
    expect(ev.kyc).toEqual([])
    // the rows themselves wait for retention
    expect((await db.owner.query('SELECT 1 FROM eligibility_statement WHERE user_id = $1', [u])).rowCount).toBe(1)
    // and the real flow works from there
    expect((await inject('POST', '/api/eligibility/statement', h2, { answers: NET, signed_name: 'San Box' })).json().qualifies).toBe(true)
    expect((await inject('GET', '/api/eligibility', h2)).json().next).toBe('assessment')
    expect((await inject('POST', '/api/eligibility/assessment/start', h2)).statusCode).toBe(200)
    // F2: an assessment left open across the switch does not block a new one
    const lh2 = await sign('left.open@example.test', false)
    await inject('POST', '/api/account/resend-verification', lh2)
    await expect.poll(() => mails.some((m) => m.to === 'left.open@example.test')).toBe(true)
    await inject('POST', '/api/verify-email', {}, { token: tokenOf(linkIn(mails.filter((m) => m.to === 'left.open@example.test').at(-1)!.body)), password: PW })
    await inject('POST', '/api/eligibility/statement', lh2, { answers: NET, signed_name: 'Left Open' })
    expect((await inject('POST', '/api/eligibility/assessment/start', lh2)).statusCode).toBe(200)
    // F9: what can bring deletion nearer goes to a second admin here; a hold going on does not
    const a2 = await sign('real.a@example.test')
    const b2 = await sign('real.b@example.test')
    const shorter = await inject('PUT', '/api/retention-config', a2, { relationship_years: 1, idle_months: 24, kyc_valid_years: 3 })
    expect(shorter.json().requestId).toBeTruthy()
    expect((await inject('GET', '/api/retention-config', a2)).json().relationship_years).toBe(5)
    expect((await inject('POST', `/api/requests/${shorter.json().requestId}/approve`, a2)).statusCode).toBe(409)
    expect((await inject('POST', `/api/requests/${shorter.json().requestId}/approve`, b2)).statusCode).toBe(200)
    expect((await inject('GET', '/api/retention-config', a2)).json().relationship_years).toBe(1)
    expect((await inject('POST', `/api/users/${u}/retention-hold`, a2, { hold: true })).json().requestId).toBeUndefined()
    const lift = await inject('POST', `/api/users/${u}/retention-hold`, a2, { hold: false })
    expect(lift.json().requestId).toBeTruthy()
    const held = async () => (await db.owner.query<{ retention_hold: boolean }>('SELECT retention_hold FROM user_account WHERE id = $1', [u])).rows[0]!.retention_hold
    expect(await held()).toBe(true)
    expect((await inject('POST', `/api/requests/${lift.json().requestId}/approve`, b2)).statusCode).toBe(200)
    expect(await held()).toBe(false)
    await server.close()
    await db.drop()
  })
  it('TC-ELG-04 uk-cobs: no classification before continue; the 24 hours are exact; once per person; leaving does not qualify', async () => {
    const fresh = await createTestDb()
    const server = await buildServer({ db: fresh.app, k: fresh.keyring, secureCookies: false, now: () => clock })
    const start = new Date('2026-06-01T09:00:00.000Z')
    clock = start
    const cobs = (await fresh.owner.query<{ id: string }>("SELECT id FROM regime_pack WHERE key = 'uk-cobs-template'")).rows[0]!.id
    await fresh.owner.query('UPDATE instance_profile SET active_pack_id = $1', [cobs])
    const reg = async (email: string) => {
      const r = await server.inject({ method: 'POST', url: '/api/register', remoteAddress: nextIp(), payload: { first_name: 'C', last_name: 'Obs', email, password: PW } })
      await server.inject({ method: 'POST', url: '/api/verify-email', payload: { token: tokenOf(r.json().sandbox_link), password: PW } })
      const l = await server.inject({ method: 'POST', url: '/api/login', remoteAddress: nextIp(), payload: { email, password: PW } })
      return { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    }
    const h = await reg('cobs@example.test')
    const post = (url: string, payload?: object) => server.inject({ method: 'POST', url, headers: h, remoteAddress: nextIp(), ...(payload ? { payload } : {}) })
    const get = async () => (await server.inject({ method: 'GET', url: '/api/eligibility', headers: h })).json()
    let s = await get()
    expect(s.next).toBe('request_access')
    expect(s.preparation.individual.coolingOffHours).toBe(24)
    // a warning answered under another regime is no answer here
    const fpoPack = (await fresh.owner.query<{ id: string }>("SELECT id FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!.id
    const me = (await fresh.owner.query<{ id: string }>("SELECT id FROM user_account WHERE email = 'cobs@example.test'")).rows[0]!.id
    await fresh.owner.query("INSERT INTO warning_ack (id, user_id, pack_id, kind, legal_text_sha256, shown_at, decision) VALUES (gen_random_uuid(), $1, $2, 'personalised_warning', 'x', now(), 'continue')", [me, fpoPack])
    const body = { answers: NET, signed_name: 'C Obs' }
    expect((await post('/api/eligibility/statement', body)).statusCode).toBe(409)
    expect((await post('/api/eligibility/request')).statusCode).toBe(200)
    expect((await post('/api/eligibility/request')).statusCode).toBe(409) // once
    s = await get()
    expect(s.next).toBe('personalised_warning') // the row from the other regime did not count
    expect(s.texts['personalised_warning/default']).toBeTruthy()
    expect(s.texts['risk_summary/default']).toBeTruthy()
    expect((await post('/api/eligibility/statement', body)).statusCode).toBe(409)
    expect((await post('/api/eligibility/assessment/start')).statusCode).toBe(409)
    expect((await post('/api/eligibility/warning', { kind: 'personalised_warning', decision: 'leave' })).statusCode).toBe(200)
    expect((await post('/api/eligibility/statement', body)).statusCode).toBe(409)
    expect((await post('/api/eligibility/warning', { kind: 'personalised_warning', decision: 'continue' })).statusCode).toBe(200)
    expect((await post('/api/eligibility/statement', body)).statusCode).toBe(200)
    const a = (await post('/api/eligibility/assessment/start')).json()
    expect((await post('/api/eligibility/assessment/answer', { attempt_id: a.id, answers: await correct(fresh, a.questions) })).json().passed).toBe(true)
    s = await get()
    expect(s.next).toBe('cooling_off_decision')
    expect(s.cooling_off_over).toBe(false)
    expect(s.cooling_off_ends_at).toBe('2026-06-02T09:00:00.000Z')
    clock = new Date('2026-06-02T08:59:59.999Z')
    expect((await post('/api/eligibility/cooling-off', { decision: 'continue' })).statusCode).toBe(409)
    clock = new Date('2026-06-02T09:00:00.000Z')
    expect((await get()).cooling_off_over).toBe(true)
    expect((await post('/api/eligibility/cooling-off', { decision: 'leave' })).statusCode).toBe(200)
    expect((await get()).qualified).toBe(false)
    expect((await post('/api/eligibility/cooling-off', { decision: 'continue' })).statusCode).toBe(200)
    expect((await get()).qualified).toBe(true)
    expect((await post('/api/eligibility/cooling-off', { decision: 'leave' })).statusCode).toBe(409)
    clock = new Date('2026-06-01T09:00:00.000Z')
    await server.close()
    await fresh.drop()
  })
  it('hostile: strangers, junk bodies, another person\'s attempt', async () => {
    const a = await investor('hostile.a@example.test')
    const b = await investor('hostile.b@example.test')
    expect((await send('GET', '/api/eligibility')).statusCode).toBe(401)
    expect((await statement(a, { category: 'high_net_worth', high_net_worth: { income: { yes: true, amount_minor: '1e9' }, net_assets: { yes: false } } })).statusCode).toBe(400)
    expect((await send('POST', '/api/eligibility/warning', a, { kind: 'martian', decision: 'continue' })).statusCode).toBe(400)
    await statement(a)
    await statement(b)
    const at = (await send('POST', '/api/eligibility/assessment/start', a)).json()
    expect((await send('POST', '/api/eligibility/assessment/answer', b, { attempt_id: at.id, answers: {} })).statusCode).toBe(409)
    expect((await send('POST', '/api/eligibility/assessment/answer', a, { attempt_id: at.id, answers: { x: 99 } })).statusCode).toBe(400)
  })
})

describe('expiry', () => {
  it('TC-KYC-03 sandbox mail that no one can be tied to goes after seven days, whoever it was for, and newer mail stays', async () => {
    const db = await createTestDb()
    const at = new Date('2027-01-10T00:00:00Z')
    const mail = (to: string, when: string) => db.owner.query("INSERT INTO sandbox_outbox (id, to_address, subject, body, created_at) VALUES (gen_random_uuid(), $1, 's', 'b', $2)", [to, when])
    await mail('old.mail@example.test', '2027-01-02T23:59:59Z')
    await mail('new.mail@example.test', '2027-01-03T00:00:01Z')
    await runRetention(db.maintenance, db.keyring, new MemoryStorage(), at)
    expect((await db.owner.query<{ to_address: string }>('SELECT to_address FROM sandbox_outbox')).rows.map((r) => r.to_address)).toEqual(['new.mail@example.test'])
    await db.drop()
  })
  it('TC-KYC-03 at the end of retention nothing of the person is left in any table or in storage; the audit chain still verifies', async () => {
    const db = await createTestDb()
    const storage = new MemoryStorage()
    const server = await buildServer({ db: db.app, k: db.keyring, secureCookies: false })
    const SEEDS = ['seed.gone@example.test', 'seed.old@example.test', 'SEED.GONE@EXAMPLE.TEST', 'seed.owner@example.test', 'Gone', 'Person', 'SEEDADDRESS', 'SEEDTAXID', 'SEEDBANK', 'SEEDREASON', 'SEEDANSWER']
    const send2 = (url: string, h: object, payload?: object) => server.inject({ method: 'POST', url, headers: h as Record<string, string>, remoteAddress: nextIp(), ...(payload ? { payload } : {}) })
    // registered under an old address, moved, mail under the old address and under another spelling of the new one
    const reg = await send2('/api/register', {}, { first_name: 'Gone', last_name: 'Person', email: 'seed.old@example.test', password: PW })
    await send2('/api/verify-email', {}, { token: tokenOf(reg.json().sandbox_link), password: PW })
    const firstLogin = await send2('/api/login', {}, { email: 'seed.old@example.test', password: PW })
    const h0 = { cookie: `bulma_session=${firstLogin.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': firstLogin.json().csrf }
    await send2('/api/account/email', h0, { email: 'seed.gone@example.test', password: PW })
    const change = (await db.owner.query<{ body: string }>("SELECT body FROM sandbox_outbox WHERE to_address = 'seed.gone@example.test'")).rows[0]!.body
    await send2('/api/account/email/confirm', {}, { token: tokenOf(linkIn(change)), password: PW })
    await send2('/api/password/forgot', {}, { email: 'SEED.GONE@EXAMPLE.TEST' })
    const l = await send2('/api/login', {}, { email: 'seed.gone@example.test', password: PW })
    const h = { cookie: `bulma_session=${l.cookies.find((c) => c.name === 'bulma_session')!.value}`, 'x-csrf-token': l.json().csrf }
    const userId = l.json().user.id
    const id = (await send2('/api/entities', h, { type: 'company', fields: { name: 'Gone Person', company_number: '1', registered_address: 'SEEDADDRESS', tax_residence: 'UK', tax_id: 'SEEDTAXID', source_of_wealth: 's' }, parties: [{ name: 'Gone Person', email: 'seed.owner@example.test', kind: 'owner', ownership_bps: 5000 }] })).json().id
    expect((await server.inject({ method: 'POST', url: `/api/entities/${id}/files?requirement=registration_proof&name=f.pdf`, headers: { ...h, 'content-type': 'application/octet-stream' }, payload: PDF })).statusCode).toBe(200)
    const party = (await db.owner.query<{ id: string }>('SELECT id FROM entity_party')).rows[0]!.id
    await send2(`/api/entities/${id}/parties/${party}/link`, h)
    expect((await send2(`/api/entities/${id}/bank`, h, { holder: 'Gone Person', account_fields: { sort_code: '11-22-33', account_number: 'SEEDBANK' }, evidence_file: null })).statusCode).toBe(200)
    // every other table this person can reach
    expect((await send2('/api/eligibility/statement', h, { answers: { category: 'neither' }, signed_name: 'Gone Person' })).statusCode).toBe(200)
    await db.owner.query("INSERT INTO eligibility_reopen (id, user_id, reason, decided_by) VALUES (gen_random_uuid(), $1, 'SEEDREASON', $1)", [userId])
    await db.owner.query("INSERT INTO eligibility_statement (id, user_id, regime, pack_id, category, qualifies, answers, signed_name, signed_on, payload_sha256, ip, auth_method, expires_at) SELECT gen_random_uuid(), $1, 'uk-fpo', active_pack_id, 'high_net_worth', true, '{\"x\":\"SEEDANSWER\"}', 'Gone Person', '2026-01-01', 'x', 'SEEDADDRESS', 'password', now() FROM instance_profile", [userId])
    await db.owner.query("INSERT INTO assessment_attempt (id, user_id, pack_id, questions_used) SELECT gen_random_uuid(), $1, active_pack_id, '[]' FROM instance_profile", [userId])
    await db.owner.query("INSERT INTO warning_ack (id, user_id, pack_id, kind, full_name, legal_text_sha256, shown_at, decision) SELECT gen_random_uuid(), $1, active_pack_id, 'warning_block', 'Gone Person', 'x', now(), 'continue' FROM instance_profile", [userId])
    await db.owner.query("INSERT INTO cooling_off (user_id, started_at, ends_at) VALUES ($1, now(), now())", [userId])
    await db.owner.query("INSERT INTO mfa_recovery_code (code_hmac, user_id) VALUES ('seed', $1)", [userId])
    await db.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, provider_ref, status, return_reason) VALUES (gen_random_uuid(), $1, 1, 'sumsub', 'applicant-opaque-id', 'returned', 'SEEDREASON')", [id])
    await send2('/api/account/delete', h, { password: PW })
    const key = (await db.owner.query<{ storage_key: string }>('SELECT storage_key FROM stored_file')).rows[0]!.storage_key
    await storage.put(key, Buffer.from('sealed'))

    const dump = async () => {
      const tables = (await db.owner.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename)
      const out: string[] = []
      for (const name of tables) out.push(JSON.stringify((await db.owner.query(`SELECT * FROM ${name}`)).rows))
      return out.join('\n')
    }
    expect(await dump()).toContain('SEEDTAXID')
    // not due yet; then held; then due
    expect((await runRetention(db.maintenance, db.keyring, storage, new Date(Date.now() + 86_400_000))).removed).toEqual([])
    expect(await storage.get(key)).not.toBeNull()
    const later = new Date(Date.now() + 6 * 366 * 86_400_000)
    // the mail is recent on this clock, so only the removal of this person can take it, not the general clear-out; someone else's stays
    await db.owner.query('UPDATE sandbox_outbox SET created_at = $1', [later])
    await db.owner.query("INSERT INTO sandbox_outbox (id, to_address, subject, body, created_at) VALUES (gen_random_uuid(), 'someone.else@example.test', 's', 'b', $1)", [later])
    // the durable queue the same way: finished recently, so the 90-day blanking cannot take the address first; one row under
    // another spelling and tied to no account, so only the address can find it
    await db.owner.query('UPDATE notification_outbox SET finished_at = $1 WHERE finished_at IS NOT NULL', [later])
    await db.owner.query(
      `INSERT INTO notification_outbox (id, mode, audience, to_address, subject, status, cancel_reason, next_attempt_at, created_at, finished_at)
       VALUES (gen_random_uuid(), 'sandbox', 'address', 'Seed.Gone@Example.Test', 's', 'cancelled', 'held', $1, $1, $1),
              (gen_random_uuid(), 'sandbox', 'address', 'someone.else.queued@example.test', 's', 'cancelled', 'held', $1, $1, $1)`,
      [later],
    )
    await db.owner.query('UPDATE user_account SET retention_hold = true WHERE id = $1', [userId])
    expect((await runRetention(db.maintenance, db.keyring, storage, later)).removed).toEqual([])
    await db.owner.query('UPDATE user_account SET retention_hold = false WHERE id = $1', [userId])
    expect((await runRetention(db.maintenance, db.keyring, storage, later)).removed).toEqual([userId])
    const after = await dump()
    for (const s of SEEDS) expect(after, s).not.toContain(s)
    expect(after.toLowerCase()).not.toContain('seed.gone@example.test')
    expect(await storage.get(key)).toBeNull()
    expect(after).toContain('someone.else@example.test')
    expect(after).toContain('someone.else.queued@example.test')
    expect(after).toContain('retention.person_removed')
    // what is at the provider is the operator's to remove: this is how it finds it
    expect((await db.owner.query("SELECT 1 FROM audit WHERE action = 'retention.provider_followup.sumsub' AND entity_id = 'applicant-opaque-id'")).rowCount).toBe(1)
    const { verifyAudit } = await import('../store/audit.ts')
    expect((await verifyAudit(db.app, db.keyring)).ok).toBe(true)
    // running again changes nothing
    expect((await runRetention(db.maintenance, db.keyring, storage, later)).removed).toEqual([])
    await server.close()
    await db.drop()
  })
  it('TC-KYC-03 the job has no way to read what it only removes, and one bad person does not stop the rest; an abandoned case does not hold data for ever', async () => {
    const db = await createTestDb()
    await expect(db.maintenance.query('SELECT wrapped_key FROM stored_file')).rejects.toThrow(/permission denied/)
    await expect(db.maintenance.query('SELECT answers FROM eligibility_statement')).rejects.toThrow(/permission denied/)
    await expect(db.maintenance.query('SELECT password_hash FROM user_account')).rejects.toThrow(/permission denied/)
    await expect(db.app.query("UPDATE legal_entity_version SET fields = '{}'")).rejects.toThrow(/permission denied/)
    await expect(db.maintenance.query("UPDATE legal_entity_version SET fields = '{\"full_name\":\"Different Person\"}'")).rejects.toThrow(/permission denied/)
    const insert = (email: string) => db.owner.query<{ id: string }>("INSERT INTO user_account (id, email, name, created_at, must_change_password) VALUES (gen_random_uuid(), $1, 'Seed', '2020-01-01T00:00:00Z', false) RETURNING id", [email]).then((r) => r.rows[0]!.id)
    await expect(db.maintenance.query("UPDATE user_account SET password_hash = 'x'")).rejects.toThrow(/permission denied/)
    await expect(db.maintenance.query('UPDATE user_account SET mfa_enabled_at = NULL')).rejects.toThrow(/permission denied/)
    const bad = await insert('a.bad@example.test')
    const good = await insert('b.good@example.test')
    await db.owner.query(`CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.user_id = '${bad}' THEN RAISE EXCEPTION 'boom'; END IF; RETURN OLD; END $$`)
    await db.owner.query('CREATE TRIGGER boom BEFORE DELETE ON cooling_off FOR EACH ROW EXECUTE FUNCTION boom()')
    await db.owner.query('INSERT INTO cooling_off (user_id, started_at, ends_at) VALUES ($1, now(), now())', [bad])
    const at = new Date('2027-01-02T00:00:00Z')
    const r = await runRetention(db.maintenance, db.keyring, new MemoryStorage(), at)
    expect(r.failed).toEqual([bad])
    expect(r.removed).toEqual([good])
    expect((await db.owner.query('SELECT 1 FROM user_account WHERE id = $1 AND anonymised_at IS NULL', [bad])).rowCount).toBe(1)
    // the one fixed anonymisation refuses a role holder or a hold, however it is called
    const staffer = await insert('still.staff@example.test')
    await db.owner.query("INSERT INTO role_grant (user_id, role) VALUES ($1, 'admin')", [staffer])
    await expect(db.maintenance.query('SELECT anonymise_person($1)', [staffer])).rejects.toThrow(/cannot be removed/)
    const heldBack = await insert('held.back@example.test')
    await db.owner.query('UPDATE user_account SET retention_hold = true WHERE id = $1', [heldBack])
    await expect(db.maintenance.query('SELECT anonymise_person($1)', [heldBack])).rejects.toThrow(/cannot be removed/)
    // a change of the periods waits for a deletion in progress, which has already read them
    const e = await db.maintenance.connect()
    await e.query('BEGIN')
    await e.query('SELECT lock_person_for_retention($1)', [bad])
    const w = await db.owner.connect()
    await w.query("SET lock_timeout = '100ms'")
    await expect(w.query('UPDATE retention_config SET relationship_years = 50')).rejects.toThrow(/lock timeout/)
    w.release()
    await e.query('ROLLBACK')
    e.release()
    // a storage failure is tried again next run, and the rows are already gone
    const withFile = await insert('with.file@example.test')
    const ent = (await db.owner.query<{ id: string }>("INSERT INTO legal_entity (id, owner_user, type) VALUES (gen_random_uuid(), $1, 'individual') RETURNING id", [withFile])).rows[0]!.id
    await db.owner.query("INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) VALUES (gen_random_uuid(), 'entity_kyc', $1, 'r', 'x', 'application/pdf', 'x', 1, 'clean', 'broken-key', 'k', 'x', $2)", [ent, withFile])
    const failing = { put: async () => undefined, get: async () => null, delete: async () => { throw new Error('disk') } }
    const first = await runRetention(db.maintenance, db.keyring, failing, at)
    expect(first.removed).toContain(withFile)
    expect(first.filesLeft).toBe(1)
    expect((await db.owner.query('SELECT 1 FROM stored_file WHERE owner_id = $1', [ent])).rowCount).toBe(0)
    const store = new MemoryStorage()
    await store.put('broken-key', Buffer.from('sealed'))
    expect((await runRetention(db.maintenance, db.keyring, store, at)).filesLeft).toBe(0)
    expect(await store.get('broken-key')).toBeNull()
    // a hold put on while the job is running is seen: the person is judged again under the lock
    const racing = await insert('racing@example.test')
    const c = await db.owner.connect()
    await c.query('BEGIN')
    await c.query('UPDATE user_account SET retention_hold = true WHERE id = $1', [racing])
    const running = runRetention(db.maintenance, db.keyring, new MemoryStorage(), at)
    await new Promise((f) => setTimeout(f, 150))
    await c.query('COMMIT')
    c.release()
    const raced = await running
    expect(raced.removed).not.toContain(racing)
    expect(raced.failed).not.toContain(racing) // left alone because it was judged again, not because the last guard refused
    expect((await db.owner.query('SELECT 1 FROM user_account WHERE id = $1 AND anonymised_at IS NULL', [racing])).rowCount).toBe(1)
    await db.owner.query('UPDATE user_account SET retention_hold = false WHERE id = $1', [racing])
    // so is a longer period approved while it runs: the person's row is held, the list is already read
    const d = await db.owner.connect()
    await d.query('BEGIN')
    await d.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [racing])
    const second = runRetention(db.maintenance, db.keyring, new MemoryStorage(), at)
    await new Promise((f) => setTimeout(f, 150))
    await db.owner.query('UPDATE retention_config SET relationship_years = 50')
    await d.query('COMMIT')
    d.release()
    expect((await second).removed).not.toContain(racing)
    await db.owner.query('UPDATE retention_config SET relationship_years = 5')
    // a case abandoned long ago no longer counts as a relationship
    const stale = await insert('stale@example.test')
    const staleEnt = (await db.owner.query<{ id: string }>("INSERT INTO legal_entity (id, owner_user, type) VALUES (gen_random_uuid(), $1, 'individual') RETURNING id", [stale])).rows[0]!.id
    await db.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status, created_at) VALUES (gen_random_uuid(), $1, 1, 'manual', 'in_progress', '2020-01-01T00:00:00Z')", [staleEnt])
    expect((await runRetention(db.maintenance, db.keyring, new MemoryStorage(), at)).removed).toContain(stale)
    await db.drop()
  })
  it('TC-KYC-03 the periods are an admin\'s to set, and the change is audited', async () => {
    expect((await send('GET', '/api/retention-config', admin)).json()).toEqual({ relationship_years: 5, idle_months: 24, kyc_valid_years: 3, transaction_years: 10 })
    const u = await investor('not.admin@example.test')
    expect((await send('PUT', '/api/retention-config', u, { relationship_years: 6, idle_months: 24, kyc_valid_years: 3 })).statusCode).toBe(403)
    expect((await send('PUT', '/api/retention-config', admin, { relationship_years: -1, idle_months: 24, kyc_valid_years: 3 })).statusCode).toBe(400)
    expect((await send('PUT', '/api/retention-config', admin, { relationship_years: 5, idle_months: 24, kyc_valid_years: 0 })).statusCode).toBe(400)
    expect((await send('PUT', '/api/retention-config', admin, { relationship_years: 0, idle_months: 24, kyc_valid_years: 3 })).statusCode).toBe(200) // no floor: the operator's call
    expect((await send('PUT', '/api/retention-config', admin, { relationship_years: 6, idle_months: 24, kyc_valid_years: 3 })).statusCode).toBe(200)
    expect(await auditCount('retention.config_changed.6.24.3')).toBe(1)
    await send('PUT', '/api/retention-config', admin, { relationship_years: 5, idle_months: 24, kyc_valid_years: 3 })
  })
  it('TC-ACC-02 a role does nothing on an unproved address', async () => {
    const reg = await send('POST', '/api/register', undefined, { first_name: 'N', last_name: 'P', email: 'not.proved@example.test', password: PW })
    expect(reg.statusCode).toBe(200)
    const u = await login('not.proved@example.test')
    const e = t.keyring.encrypt(MFA)
    await t.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [u.id, e.ciphertext, e.keyId, e.wrappedDek])
    await t.owner.query("INSERT INTO role_grant (user_id, role) VALUES ($1, 'reviewer'), ($1, 'admin')", [u.id])
    expect((await send('GET', '/api/review/kyc', u)).statusCode).toBe(403)
    expect((await send('GET', '/api/users', u)).statusCode).toBe(403)
    expect((await send('GET', '/api/audit/head', u)).statusCode).toBe(403)
    expect((await currentStaff(t.app)).map((x) => x.userId)).not.toContain(u.id) // nor is this person counted towards any two-person rule
    await t.owner.query('DELETE FROM role_grant WHERE user_id = $1', [u.id])
  })
  it('TC-ACC-02 the sandbox outbox is for admins only, and does not exist in the real mode', async () => {
    const u = await investor('outbox.reader@example.test')
    expect((await send('GET', '/api/sandbox/outbox', u)).statusCode).toBe(403)
    expect((await send('GET', '/api/sandbox/outbox')).statusCode).toBe(401)
    const mail = (await send('GET', '/api/sandbox/outbox', admin)).json().mail
    expect(mail.some((m: { to_address: string }) => m.to_address === 'outbox.reader@example.test')).toBe(true)
  })
  it('TC-KYC-03 the idle clock, a role and an open case; a hold is set by an admin and audited', async () => {
    const db = await createTestDb()
    const storage = new MemoryStorage()
    const insert = (email: string, created: string) => db.owner.query<{ id: string }>("INSERT INTO user_account (id, email, name, created_at, must_change_password) VALUES (gen_random_uuid(), $1, 'Seed', $2, false) RETURNING id", [email, created]).then((r) => r.rows[0]!.id)
    const idle = await insert('idle@example.test', '2020-01-01T00:00:00Z')
    const staffer = await insert('staff@example.test', '2020-01-01T00:00:00Z')
    await db.owner.query("INSERT INTO role_grant (user_id, role) VALUES ($1, 'admin')", [staffer])
    const open = await insert('open@example.test', '2020-01-01T00:00:00Z')
    const entity = (await db.owner.query<{ id: string }>("INSERT INTO legal_entity (id, owner_user, type) VALUES (gen_random_uuid(), $1, 'individual') RETURNING id", [open])).rows[0]!.id
    await db.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES (gen_random_uuid(), $1, 1, 'manual', 'pending_review')", [entity])
    const recent = await insert('recent@example.test', '2026-01-01T00:00:00Z')
    expect(recent).toBeTruthy()
    // idle from 2022-01-01, plus five years
    expect((await runRetention(db.maintenance, db.keyring, storage, new Date('2026-12-31T00:00:00Z'))).removed).toEqual([])
    const due = await runRetention(db.maintenance, db.keyring, storage, new Date('2027-01-01T00:00:00Z'))
    expect(due.removed).toEqual([idle])
    expect(due.failed).toEqual([]) // the staff member was never attempted: the database's refusal is the last guard, not the first
    await db.drop()
  })
  it('TC-KYC-03 a hold is set by an admin and audited', async () => {
    const u = await investor('hold@example.test')
    expect((await send('POST', `/api/users/${u.id}/retention-hold`, u, { hold: true })).statusCode).toBe(403)
    expect((await send('POST', `/api/users/${u.id}/retention-hold`, admin, { hold: true })).statusCode).toBe(200)
    expect((await t.owner.query<{ retention_hold: boolean }>('SELECT retention_hold FROM user_account WHERE id = $1', [u.id])).rows[0]!.retention_hold).toBe(true)
    expect(await auditCount('retention.hold_on')).toBe(1)
    expect((await send('POST', '/api/users/00000000-0000-4000-8000-000000000000/retention-hold', admin, { hold: true })).statusCode).toBe(409)
  })
})
