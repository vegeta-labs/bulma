import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pdfText } from './pdfText.ts'
import { codeAt, stepOf } from '../lib/totp.ts'
import { tx } from '../store/db.ts'
import { insertPack, packContent } from '../store/packs.ts'
import { createTestDb, type TestDb } from '../store/testdb.ts'
import { buildServer } from './app.ts'
import { bootstrapAdmin, createUser, grantRole } from './auth.ts'
import { attemptOne, drain, enqueue, mailQueue, type OutboxDeps, type QueuedMail } from './outbox.ts'
import { runReminders } from './reminders.ts'
import { FakeOutbox, MemoryStorage } from '../adapters/index.ts'
import { runRetention } from '../maintenance/retention.ts'
import { SAFETY_LINE } from '../lib/mailContent.ts'
import { forbiddenClaims } from '../lib/evidence.ts'
import { stableJson } from '../lib/snapshot.ts'

const PW = 'a-long-enough-password'
const MFA = Buffer.alloc(20, 9)
let t: TestDb
let app: FastifyInstance
let clock = new Date('2026-11-10T09:00:00.000Z')
let ipCounter = 0
const nextIp = () => `10.40.${Math.floor(ipCounter / 200)}.${(ipCounter++ % 200) + 1}`

interface Client {
  cookie: string
  csrf: string
  id: string
  email: string
}

const inject = (method: string, url: string, who?: Client, payload?: unknown, extraCookie?: string) =>
  app.inject({
    method: method as 'GET',
    url,
    remoteAddress: nextIp(),
    headers: {
      ...(who ? { 'x-csrf-token': who.csrf } : {}),
      ...(who || extraCookie ? { cookie: [who?.cookie, extraCookie].filter(Boolean).join('; ') } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })

const latestSha = async (deal: string, approvedOnly = false) =>
  (
    await t.owner.query<{ sha256: string }>(
      approvedOnly
        ? 'SELECT v.sha256 FROM deal d JOIN deal_version v ON v.deal_id = d.id AND v.n = d.approved_version WHERE d.id = $1'
        : 'SELECT sha256 FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1',
      [deal],
    )
  ).rows[0]!.sha256

async function login(email: string): Promise<Client> {
  await t.owner.query('UPDATE user_account SET mfa_last_step = NULL WHERE lower(email) = lower($1)', [email])
  const r = await inject('POST', '/api/login', undefined, { email, password: PW, code: codeAt(MFA, stepOf(clock.getTime())) })
  expect(r.statusCode, r.body).toBe(200)
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
  await t.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [
    id,
    e.ciphertext,
    e.keyId,
    e.wrappedDek,
  ])
  return login(email)
}

/** Registers, keeping any invitation cookie the browser holds (R-LNK-10). */
async function person(email: string, inviteCookie?: string): Promise<Client> {
  const r = await inject('POST', '/api/register', undefined, { first_name: 'Fay', last_name: 'Fictional', email, password: PW }, inviteCookie)
  expect(r.statusCode, r.body).toBe(200)
  const token = new URL(r.json().sandbox_link, 'http://x').searchParams.get('token')!
  expect((await inject('POST', '/api/verify-email', undefined, { token, password: PW })).statusCode).toBe(200)
  return login(email)
}

let n = 0
const unique = (s: string) => `${s}${++n}@example.test`

async function newEntity(who: Client, name = 'Fay Fictional'): Promise<string> {
  const r = await inject('POST', '/api/entities', who, {
    type: 'individual',
    fields: { full_name: name, address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' },
    parties: [],
  })
  expect(r.statusCode, r.body).toBe(200)
  return r.json().id
}

/** KYC passed for the entity's current identity, put straight in the table: D1 tests the KYC flow itself. */
async function passKyc(entity: string) {
  await t.owner.query(
    "INSERT INTO kyc_case (id, entity_id, entity_version, provider, status, decided_by, decided_at, expires_on) SELECT $1, e.id, e.current_version, 'manual', 'approved', $2, now(), '2029-01-01' FROM legal_entity e WHERE e.id = $3",
    [randomUUID(), reviewer.id, entity],
  )
}

/** Through the real eligibility routes: statement, assessment, warning block (uk-fpo). */
async function qualify(u: Client, name = 'Fay Fictional') {
  const page = (await inject('GET', '/api/eligibility', u)).json()
  const net = { category: 'high_net_worth', high_net_worth: { income: { yes: true, amount_minor: '10000000' }, net_assets: { yes: false } } }
  expect((await inject('POST', '/api/eligibility/statement', u, { answers: net, signed_name: name, shown_sha256: page.shown_sha256 })).statusCode).toBe(200)
  const a = (await inject('POST', '/api/eligibility/assessment/start', u)).json()
  const pack = (
    await t.owner.query<{ content: { assessment: { questions: Array<{ id: string; correct_option: number }> } } }>(
      'SELECT r.content FROM regime_pack r JOIN instance_profile i ON i.active_pack_id = r.id',
    )
  ).rows[0]!.content
  const answers = Object.fromEntries(a.questions.map((q: { id: string }) => [q.id, pack.assessment.questions.find((x) => x.id === q.id)!.correct_option]))
  expect((await inject('POST', '/api/eligibility/assessment/answer', u, { attempt_id: a.id, answers })).json().passed).toBe(true)
  const w = (await inject('GET', '/api/eligibility', u)).json()
  expect((await inject('POST', '/api/eligibility/warning', u, { kind: 'warning_block', decision: 'continue', shown_sha256: w.shown_sha256 })).statusCode).toBe(
    200,
  )
  expect((await inject('GET', '/api/eligibility', u)).json().qualified).toBe(true)
}

const draftFor = (entity: string, over: Record<string, unknown> = {}) => ({
  basics: {
    structure: 'uk_bare_trust',
    deal_type: 'primary',
    name: 'Seedling Round',
    syndicate: { mode: 'new', name: `Seedling Friends ${++n}`, lead_entity_id: entity },
  },
  company: { legal_name: 'Seedling Ltd', contact_name: 'Sam Founder', contact_email: 'sam.founder@example.test', jurisdiction: 'England and Wales' },
  terms: {
    currency: 'GBP',
    instrument: 'equity',
    share_price_micros: '15000',
    pre_money_minor: '500000000',
    allocation_minor: '30000000',
    min_commitment_minor: '100000',
    voter: 'lead',
    target_close: '2027-01-31',
  },
  files: {},
  economics: {
    default_carry_bps: 2000,
    recipients: [{ kind: 'person', first_name: 'Cara', last_name: 'Carry', email: 'cara.carry@example.test', share_bps: 10000 }],
    fee_payer: 'investors',
  },
  attestations: { board_and_shareholders: true },
  ...over,
})

const leadEntities = new Map<string, string>()
async function liveDeal(who: Client, over: Record<string, unknown> = {}, o: { confirm?: boolean } = {}): Promise<string> {
  let ent = leadEntities.get(who.id)
  if (!ent) leadEntities.set(who.id, (ent = await newEntity(who)))
  const id = (await inject('POST', '/api/deals', who, {})).json().id as string
  expect((await inject('PUT', `/api/deals/${id}/draft`, who, draftFor(ent, over))).statusCode).toBe(200)
  await t.owner.query(
    "INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) SELECT $1, 'deal_shared', d.id, 'legal', 'a.pdf', 'application/pdf', 'x', 1, 'clean', 'k', 'k1', '\\x00', d.lead_user FROM deal d WHERE d.id = $2",
    [randomUUID(), id],
  )
  expect((await inject('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
  expect((await inject('POST', `/api/review/deals/${id}/approve`, reviewer, { reviewed_sha256: await latestSha(id) })).statusCode).toBe(200)
  const r = await inject('POST', `/api/deals/${id}/launch`, who, { confirm: true, content_sha256: await latestSha(id, true) })
  expect(r.statusCode, r.body).toBe(200)
  if (o.confirm !== false) await confirmPolicy(who, id)
  return id
}

/** R-PIP-06: the lead confirms the operator's text on whom to invite, as shown. */
async function confirmPolicy(who: Client, deal: string) {
  const p = (await inject('GET', `/api/deals/${deal}/invitee-policy`, who)).json()
  if (p.confirmed) return
  const r = await inject('POST', `/api/deals/${deal}/invitee-policy`, who, { version: p.text.version, sha256: p.text.sha256 })
  expect(r.statusCode, r.body).toBe(200)
}

interface LinkView {
  id: string
  kind: string
  carry_bps: number
  is_default: boolean
}
const links = async (deal: string, who = lead) => (await inject('GET', `/api/deals/${deal}/links`, who)).json().links as LinkView[]
const urlOf = async (deal: string, link: string, who = lead) => (await inject('GET', `/api/deals/${deal}/links/${link}/url`, who)).json().url as string
const tokenOf = (url: string) => new URL(url, 'http://x').searchParams.get('token')!

/** Opens a link in a fresh browser; returns the invitation cookie. */
async function open(token: string): Promise<string> {
  const r = await inject('POST', '/api/invite/open', undefined, { token })
  expect(r.statusCode, r.body).toBe(200)
  return `bulma_invite=${r.cookies.find((c) => c.name === 'bulma_invite')!.value}`
}

/** A qualified investor with a passed entity, invited to the deal through its default link. */
async function investor(deal: string, o: { link?: string; leader?: Client } = {}) {
  const ls = await links(deal, o.leader)
  const link = o.link ?? ls.find((l) => l.is_default && l.carry_bps === 2000)!.id
  const cookie = await open(tokenOf(await urlOf(deal, link, o.leader)))
  const u = await person(unique('inv'), cookie)
  const acc = await inject('POST', '/api/invite/accept', u, {})
  expect(acc.json().results).toEqual([{ deal_code: expect.any(String), result: 'invited' }])
  await qualify(u)
  const entity = await newEntity(u)
  await passKyc(entity)
  return { u, entity }
}

/** As the screen does: quote, then commit what was shown. A quote that is refused is sent on as it is, to see the refusal. */
async function commit(u: Client, deal: string, entity: string, amount: string, extra: Record<string, unknown> = {}) {
  const q = /^\d+$/.test(amount) ? (await inject('POST', `/api/my/deals/${deal}/quote`, u, { commitment_minor: amount })).json() : {}
  return inject('POST', `/api/my/deals/${deal}/commit`, u, {
    entity_id: entity,
    commitment_minor: amount,
    quoted_due_minor: q.due_minor,
    terms_link_id: q.terms_link_id,
    ...extra,
  })
}
/** A changed commitment, quoted first. */
async function change(u: Client, deal: string, p: string, amount: string) {
  const q = (await inject('POST', `/api/my/deals/${deal}/quote`, u, { commitment_minor: amount })).json()
  return inject('PUT', `/api/my/participations/${p}/commitment`, u, { commitment_minor: amount, quoted_due_minor: q.due_minor ?? '1' })
}
const pid = async (u: Client, deal: string) => (await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0].id as string
async function sign(u: Client, p: string) {
  const sheet = (await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json()
  return inject('POST', `/api/my/participations/${p}/sign`, u, { agree: true, signed_name: 'Fay Fictional', document_sha256: sheet.document_sha256 })
}
const instructions = (u: Client, p: string) => inject('GET', `/api/my/participations/${p}/instructions`, u)
const mailTo = async (to: string) =>
  (
    await t.owner.query<{ subject: string; body: string }>('SELECT subject, body FROM sandbox_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at', [
      to,
    ])
  ).rows
const count = async (sql: string, args: unknown[] = []) => Number((await t.owner.query<{ n: string }>(sql, args)).rows[0]!.n)

/** Words from the deal that must never appear before the gate (TC-GATE-01, E2E-03). */
const SEEDS = ['Seedling', 'Sam Founder', '300,000', '30000000', '500000000', 'Cara']
const holdsNoSeed = (body: string) => SEEDS.every((s) => !body.includes(s))

let admin: Client
let reviewer: Client
let reviewer2: Client
let lead: Client

beforeAll(async () => {
  t = await createTestDb()
  app = await buildServer({ db: t.app, k: t.keyring, secureCookies: false, now: () => clock })
  await bootstrapAdmin(t.app, t.keyring, 'first@example.test', PW)
  await t.owner.query('UPDATE user_account SET must_change_password = false')
  const e = t.keyring.encrypt(MFA)
  await t.owner.query(
    "UPDATE user_account SET mfa_secret = $1, mfa_key_id = $2, mfa_wrapped_key = $3, mfa_enabled_at = now() WHERE email = 'first@example.test'",
    [e.ciphertext, e.keyId, e.wrappedDek],
  )
  admin = await login('first@example.test')
  reviewer = await staff('reviewer@example.test', ['reviewer'])
  reviewer2 = await staff('reviewer2@example.test', ['reviewer'])
  lead = await person('lead@example.test')
  await t.owner.query(
    'INSERT INTO fee_config (id, version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, changed_by) SELECT $1, 101, 250, 400000, 2000000, 500000000, 10, id FROM user_account LIMIT 1',
    [randomUUID()],
  )
})
afterAll(async () => {
  await app?.close()
  await t?.drop()
})

// first in the file on purpose: the operator has saved no settings yet, so the active pack's defaults are the settings, and
// the settings table only ever takes new rows (Codex round 4)
describe('before any settings are saved', () => {
  it('TC-CMP-03 a pack whose defaults turn open links off applies at once, and an open link lets nobody new in', async () => {
    const deal = await liveDeal(lead)
    const open1 = (await links(deal)).find((l) => l.kind === 'open' && l.carry_bps === 2000)!
    const token = tokenOf(await urlOf(deal, open1.id))
    const cookie = await open(token)
    const { insertPack } = await import('../store/packs.ts')
    const before = (await t.owner.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile')).rows[0]!.active_pack_id
    const content = (
      await t.owner.query<{ content: Record<string, unknown> & { version: number; policy_defaults: Record<string, boolean> } }>(
        'SELECT content FROM regime_pack WHERE id = $1',
        [before],
      )
    ).rows[0]!.content
    const strict = await tx(t.app, (c) =>
      insertPack(c, { ...content, version: content.version + 200 + n, policy_defaults: { ...content.policy_defaults, generic_links: false } } as never, {
        builtIn: false,
        by: null,
      }),
    )
    try {
      const asked = await inject('POST', '/api/requests/pack-activate', admin, { pack_id: strict })
      expect(asked.statusCode, asked.body).toBe(200)
      const reqId = asked.json().request_id ?? asked.json().requestId ?? asked.json().id
      expect((await inject('POST', `/api/requests/${reqId}/approve`, admin, {})).statusCode).toBe(200)
      expect((await t.owner.query('SELECT disabled_at FROM invite_link WHERE id = $1', [open1.id])).rows[0].disabled_at).not.toBeNull()
      const u = await person(unique('lateopen'), cookie)
      expect((await inject('POST', '/api/invite/accept', u, {})).json().results[0].result).not.toBe('invited')
    } finally {
      await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [before])
    }
  })
})

describe('links', () => {
  it('TC-LNK-11 launch makes two default links: no carry and the default carry, neither with a fee', async () => {
    const deal = await liveDeal(lead)
    const ls = await links(deal)
    expect(ls.map((l) => [l.carry_bps, l.kind, l.is_default]).sort()).toEqual([
      [0, 'open', true],
      [2000, 'open', true],
    ])
  })

  it('TC-LNK-01 / TC-LNK-02 only a live deal makes links; the URL can be found again; no token is stored in clear; the 501st is refused', async () => {
    const deal = await liveDeal(lead)
    const made = await inject('POST', `/api/deals/${deal}/links`, lead, {
      kind: 'open',
      label: 'Angels',
      carry_bps: 1500,
      fee: { kind: 'none' },
      reason: 'Early backers',
      confirm: true,
    })
    expect(made.statusCode, made.body).toBe(200)
    const url = made.json().url as string
    expect(await urlOf(deal, made.json().id)).toBe(url)
    expect(await count('SELECT count(*) AS n FROM invite_link WHERE token_hmac = $1', [tokenOf(url)])).toBe(0)
    expect(JSON.stringify((await t.owner.query('SELECT * FROM invite_link WHERE id = $1', [made.json().id])).rows)).not.toContain(tokenOf(url))
    // unconfirmed terms are not saved (R-LNK-02)
    expect((await inject('POST', `/api/deals/${deal}/links`, lead, { kind: 'open', carry_bps: 1500, fee: { kind: 'none' }, reason: 'x' })).statusCode).toBe(400)
    await t.owner.query(
      "INSERT INTO invite_link (id, deal_id, kind, carry_bps, fee_kind) SELECT gen_random_uuid(), $1, 'terms_only', 2000, 'none' FROM generate_series(1, 496)",
      [deal],
    )
    const at500 = await inject('POST', `/api/deals/${deal}/links`, lead, { kind: 'terms_only', carry_bps: 2000, fee: { kind: 'none' }, confirm: true })
    expect(at500.statusCode, at500.body).toBe(200)
    expect(
      (await inject('POST', `/api/deals/${deal}/links`, lead, { kind: 'terms_only', carry_bps: 2000, fee: { kind: 'none' }, confirm: true })).json().error,
    ).toMatch(/500/)
    expect((await inject('POST', `/api/deals/${deal}/links/${at500.json().id}/disable`, lead, {})).statusCode).toBe(200)
    expect(
      (await inject('POST', `/api/deals/${deal}/links`, lead, { kind: 'terms_only', carry_bps: 2000, fee: { kind: 'none' }, confirm: true })).statusCode,
    ).toBe(200)
  })

  it('TC-LNK-03 the database refuses any change to a link’s terms', async () => {
    const deal = await liveDeal(lead)
    const l = (await links(deal))[0]!
    await expect(t.owner.query('UPDATE invite_link SET carry_bps = 1 WHERE id = $1', [l.id])).rejects.toThrow(/cannot change/)
    await expect(t.owner.query('DELETE FROM invite_link WHERE id = $1', [l.id])).rejects.toThrow(/never deleted/)
    await t.owner.query("UPDATE invite_link SET label = 'renamed' WHERE id = $1", [l.id])
  })

  it('TC-FEE-07 the operator fee limit applies to new links', async () => {
    const deal = await liveDeal(lead)
    const over = await inject('POST', `/api/deals/${deal}/links`, lead, {
      kind: 'open',
      carry_bps: 2000,
      fee: { kind: 'percent', bps: 2501, mode: 'on_top' },
      reason: 'x',
      confirm: true,
    })
    expect(over.json().error).toMatch(/25.00%/)
  })
})

describe('opening and accepting', () => {
  it('TC-GATE-01 / E2E-03 before the gate nothing about the deal is returned, and the pages ask not to be indexed', async () => {
    const deal = await liveDeal(lead)
    const url = await urlOf(deal, (await links(deal))[0]!.id)
    const r = await inject('POST', '/api/invite/open', undefined, { token: tokenOf(url) })
    expect(r.statusCode).toBe(200)
    expect(holdsNoSeed(r.body)).toBe(true)
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    const cookie = `bulma_invite=${r.cookies.find((c) => c.name === 'bulma_invite')!.value}`
    const pending = await inject('GET', '/api/invite/pending', undefined, undefined, cookie)
    expect(pending.headers['x-robots-tag']).toBe('noindex')
    expect(pending.json()).toEqual({ pending: true, deal_code: expect.stringMatching(/^[A-Z2-9]{6}$/) })
    const u = await person(unique('gate'), cookie)
    expect((await inject('POST', '/api/invite/accept', u, {})).json().results[0].result).toBe('invited')
    // invited but not qualified: the deal is not shown, and the list row is neutral
    const page = await inject('GET', `/api/my/deals/${deal}`, u)
    expect(page.statusCode).toBe(404)
    expect(holdsNoSeed(page.body)).toBe(true)
    const list = await inject('GET', '/api/my/deals', u)
    expect(holdsNoSeed(list.body)).toBe(true)
    expect(list.json().deals[0]).toMatchObject({ visible: false, name: null, company: null })
    // a bad token answers the same way as a disabled link
    expect((await inject('POST', '/api/invite/open', undefined, { token: 'x'.repeat(43) })).statusCode).toBe(404)
  })

  it('TC-LNK-10 a new user who opened the link keeps it after verifying on another device', async () => {
    const deal = await liveDeal(lead)
    const cookie = await open(tokenOf(await urlOf(deal, (await links(deal))[0]!.id)))
    const u = await person(unique('device'), cookie)
    // signed in without the cookie: the invitation was attached to the account at sign-up
    expect((await inject('POST', '/api/invite/accept', u, {})).json().results[0].result).toBe('invited')
    expect(await count("SELECT count(*) AS n FROM deal_invitation WHERE user_id = $1 AND state = 'active'", [u.id])).toBe(1)
  })

  it('TC-LNK-05 / TC-LNK-11 someone invited who opens a second link keeps their terms and the lead is told', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    const other = (await links(deal)).find((l) => l.carry_bps === 0)!
    const before = (await mailTo(lead.email)).length
    const cookie = await open(tokenOf(await urlOf(deal, other.id)))
    const r = await inject('POST', '/api/invite/accept', { ...u, cookie: `${u.cookie}; ${cookie}` }, {})
    expect(r.json().results[0].result).toBe('already_invited')
    const inv = (
      await t.owner.query<{ carry_bps: number }>('SELECT l.carry_bps FROM deal_invitation i JOIN invite_link l ON l.id = i.invite_link WHERE i.user_id = $1', [
        u.id,
      ])
    ).rows
    expect(inv).toEqual([{ carry_bps: 2000 }])
    expect((await mailTo(lead.email)).length).toBe(before + 1)
    const first = (await t.owner.query('SELECT second_link_seen_at FROM deal_invitation WHERE user_id = $1', [u.id])).rows[0].second_link_seen_at
    // the same second link opened again: still answered, the lead told again, the first time kept (Codex round 10)
    const again = await inject('POST', '/api/invite/accept', { ...u, cookie: `${u.cookie}; ${await open(tokenOf(await urlOf(deal, other.id)))}` }, {})
    expect(again.json().results[0].result).toBe('already_invited')
    expect((await mailTo(lead.email)).length).toBe(before + 2)
    expect((await t.owner.query('SELECT second_link_seen_at FROM deal_invitation WHERE user_id = $1', [u.id])).rows[0].second_link_seen_at).toEqual(first)
  })

  it('TC-LNK-04 / TC-LNK-07 / TC-LNK-10 a targeted invitation: no deal content in the mail; the wrong address is refused; a used one cannot be reused', async () => {
    const deal = await liveDeal(lead)
    const link = (await links(deal)).find((l) => l.carry_bps === 2000)!
    const email = unique('target')
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email, link_id: link.id })).statusCode).toBe(200)
    const mail = (await mailTo(email))[0]!
    expect(holdsNoSeed(mail.subject + mail.body)).toBe(true)
    const token = /token=([\w-]+)/.exec(mail.body)![1]!
    // forwarded to someone else with a verified account: refused
    const other = await person(unique('forward'), await open(token))
    expect((await inject('POST', '/api/invite/accept', other, {})).json().results[0].result).toBe('wrong_address')
    // the right person, signing up afterwards: accepted
    const right = await person(email, await open(token))
    expect((await inject('POST', '/api/invite/accept', right, {})).json().results[0].result).toBe('invited')
    expect((await inject('POST', '/api/invite/open', undefined, { token })).statusCode).toBe(404)
  })

  it('TC-LNK-10 turning a link off: unbound cannot open, bound and uncommitted are withdrawn, committed are unaffected', async () => {
    const deal = await liveDeal(lead)
    const link = (await links(deal)).find((l) => l.carry_bps === 2000)!
    const token = tokenOf(await urlOf(deal, link.id))
    const a = await investor(deal)
    const b = await investor(deal)
    expect((await commit(b.u, deal, b.entity, '1000000')).statusCode).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/links/${link.id}/disable`, lead, {})).json().revoked).toBe(1)
    expect((await inject('POST', '/api/invite/open', undefined, { token })).statusCode).toBe(404)
    expect((await inject('GET', `/api/my/deals/${deal}`, a.u)).statusCode).toBe(404)
    expect((await inject('GET', `/api/my/deals/${deal}`, b.u)).statusCode).toBe(200)
  })
})

describe('the deal page and committing', () => {
  it('TC-PAGE-01 / TC-PAGE-04 the warning comes first; key terms with all fees; the share price is not shown; each view is logged', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    const r = await inject('GET', `/api/my/deals/${deal}`, u)
    expect(r.statusCode, r.body).toBe(200)
    expect(Object.keys(r.json())[0]).toBe('warning')
    const k = r.json().key_terms
    expect(k).toMatchObject({
      carry: '20.00%',
      lead_fee: 'No fee',
      platform_fee: { rate: '2.50%', min: '£4,000.00', max: '£20,000.00', payer: 'investors' },
      target_close: '2027-01-31',
    })
    expect(JSON.stringify(r.json())).not.toContain('15000')
    expect(r.json().deal_code).toMatch(/^[A-Z2-9]{6}$/)
    expect(await count('SELECT count(*) AS n FROM deal_view WHERE deal_id = $1 AND user_id = $2', [deal, u.id])).toBe(1)
  })

  it('TC-CMT-05 / TC-LNK-12 the quote adds up to the amount to pay, under FPO as a total commitment; estimates are labelled', async () => {
    const deal = await liveDeal(lead)
    const fee = await inject('POST', `/api/deals/${deal}/links`, lead, {
      kind: 'open',
      carry_bps: 2000,
      fee: { kind: 'percent', bps: 400, mode: 'on_top' },
      reason: 'Arranging fee',
      confirm: true,
    })
    const { u } = await investor(deal, { link: fee.json().id })
    const q = (await inject('POST', `/api/my/deals/${deal}/quote`, u, { commitment_minor: '1000000' })).json()
    expect(q.lines).toEqual([
      { key: 'investment_part', label: expect.any(String), minor: '1000000' },
      { key: 'lead_fee', label: 'Lead fee', minor: '40000' },
      { key: 'total_commitment', label: 'Total commitment: the amount to pay', minor: '1040000' },
    ])
    expect(q.due_minor).toBe('1040000')
    // C-FEE-3 at the target: £7,500 over £300,000, so £250 on £10,000
    expect(q.expected_minor).toBe('975000')
    expect(q.least_minor).toBe('599999')
    expect(q.estimate_label).toMatch(/Estimate/)
    expect(q.oversubscription).toMatch(/scaled back/)
    expect(q.fixed_total).toMatch(/total you commit/)
  })

  it('TC-CMT-02 / TC-FEE-08 below the minimum, zero and too large are refused; eligibility is checked again', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    expect((await commit(u, deal, entity, '99999')).json().error).toMatch(/minimum/)
    expect((await commit(u, deal, entity, '0')).statusCode).toBe(400)
    expect((await commit(u, deal, entity, '100000000001')).json().error).toMatch(/largest/)
    // a statement that has run out stops the commitment
    await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])
    expect((await commit(u, deal, entity, '100000')).statusCode).toBe(409)
  })

  it('TC-LNK-06 / TC-LNK-07 / TC-CMT-07 the first commitment freezes the terms; a second entity uses them with its own reference; the same entity twice is refused', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    expect((await commit(u, deal, entity, '1000000')).statusCode).toBe(200)
    expect((await commit(u, deal, entity, '1000000')).json().error).toMatch(/already committed/)
    const second = await newEntity(u, 'Fay Fictional Two')
    expect((await commit(u, deal, second, '500000')).statusCode).toBe(200)
    const rows = (
      await t.owner.query<{ reference: string; invitation_id: string }>(
        'SELECT reference, invitation_id FROM participation WHERE user_id = $1 ORDER BY join_seq',
        [u.id],
      )
    ).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]!.invitation_id).toBe(rows[1]!.invitation_id)
    expect(rows[0]!.reference).not.toBe(rows[1]!.reference)
    for (const r of rows) expect(r.reference).toMatch(/^BU-[A-HJKMNP-Z2-9]{6}$/)
    const inv = (
      await t.owner.query<{ id: string; terms_snapshot: { carry_bps: number } }>('SELECT id, terms_snapshot FROM deal_invitation WHERE user_id = $1', [u.id])
    ).rows[0]!
    expect(inv.terms_snapshot.carry_bps).toBe(2000)
    const other = (await links(deal)).find((l) => l.carry_bps === 0)!
    expect((await inject('POST', `/api/deals/${deal}/invitations/${inv.id}/link`, lead, { link_id: other.id })).json().error).toMatch(/committed/)
    // and the database refuses it too (R-LNK-05)
    await expect(t.app.query('UPDATE deal_invitation SET terms_snapshot = \'{"carry_bps": 0}\' WHERE id = $1', [inv.id])).rejects.toThrow(/frozen/)
    await expect(t.app.query('UPDATE deal_invitation SET invite_link = $2 WHERE id = $1', [inv.id, other.id])).rejects.toThrow(/frozen/)
  })

  it('TC-CMT-01 not investing moves the deal to the not-investing list', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    expect((await inject('POST', `/api/my/deals/${deal}/pass`, u, {})).statusCode).toBe(200)
    expect((await inject('GET', '/api/my/deals', u)).json().deals[0].kind).toBe('not_investing')
    expect((await inject('GET', `/api/my/deals/${deal}`, u)).statusCode).toBe(404)
  })

  it('TC-CMT-06 a commitment changes only while live; after money it only goes up', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    expect((await change(u, deal, p, '800000')).json().changed).toBe(true)
    await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: '100000',
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '12345678',
    })
    expect((await change(u, deal, p, '700000')).json().error).toMatch(/only go up/)
    expect((await change(u, deal, p, '900000')).json().changed).toBe(true)
  })
})

describe('signing and paying', () => {
  async function signedAndIssued() {
    const deal = await liveDeal(lead)
    const fee = await inject('POST', `/api/deals/${deal}/links`, lead, {
      kind: 'open',
      carry_bps: 2000,
      fee: { kind: 'percent', bps: 400, mode: 'on_top' },
      reason: 'Arranging fee',
      confirm: true,
    })
    const inv = await investor(deal, { link: fee.json().id })
    expect((await commit(inv.u, deal, inv.entity, '1500000')).statusCode).toBe(200)
    const p = await pid(inv.u, deal)
    expect((await sign(inv.u, p)).statusCode).toBe(200)
    const r = await instructions(inv.u, p)
    expect(r.statusCode, r.body).toBe(200)
    return { deal, p, ...inv, page: r.json() }
  }

  it('TC-SIG-01 / TC-SIG-02 / TC-SIG-03 signing waits for KYC; the sheet carries this investor’s figures; the evidence is kept; a changed document is refused', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    const fresh = await newEntity(u, 'No Kyc Yet')
    expect((await commit(u, deal, fresh, '1000000')).statusCode).toBe(200)
    const p = await pid(u, deal)
    const sheet = (await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json()
    expect(sheet.can_sign).toBe(false)
    expect(sheet.document).toContain('£10,000.00')
    expect(sheet.document).toContain('No Kyc Yet')
    expect((await sign(u, p)).statusCode).toBe(409)
    await passKyc(fresh)
    expect(
      (await inject('POST', `/api/my/participations/${p}/sign`, u, { agree: true, signed_name: 'Fay Fictional', document_sha256: 'a'.repeat(64) })).json()
        .error,
    ).toMatch(/changed/)
    expect((await sign(u, p)).statusCode).toBe(200)
    const ev = (
      await t.owner.query(
        'SELECT document_sha256, template_id, signed_name, ip, auth_method, signed_at, entity_version FROM signature_record WHERE participation_id = $1',
        [p],
      )
    ).rows[0]
    expect(ev).toMatchObject({ signed_name: 'Fay Fictional', auth_method: 'password', entity_version: 1 })
    expect(ev.ip).toBeTruthy()
  })

  it('TC-SIG-04 a deed is not click-signed', async () => {
    await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Deed for {investor_name}, amount {amount_to_pay}.', needs_deed: true })
    try {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      expect((await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json()).toMatchObject({ needs_deed: true, can_sign: false })
      expect((await sign(u, p)).json().error).toMatch(/outside/)
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).statusCode).toBe(200)
    } finally {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {amount_to_pay}, reference {reference}.',
        needs_deed: false,
      })
    }
  })

  it('TC-PAY-01 / TC-PAY-07 the amount still to pay is the largest figure; reference, account, your-money panel and reminders; no money is held', async () => {
    const { page } = await signedAndIssued()
    expect(page.still_to_pay_minor).toBe('1560000')
    expect(page.due_minor).toBe('1560000')
    expect(page.reference).toMatch(/^BU-/)
    expect(page.account.fictional).toBe(true)
    expect(page.your_money.operator_statement).toMatch(/not checked/)
    expect(page.no_money_held).toMatch(/does not receive money/)
    expect(page.reminders.join(' ')).toMatch(/saved/)
    expect(page.reminders.join(' ')).toMatch(/Cryptocurrency/)
    expect(Object.keys(page).indexOf('your_money')).toBeLessThan(Object.keys(page).indexOf('breakdown'))
  })

  it('TC-PAY-01 D £15,600 and N £10,400: still to pay £5,200', async () => {
    const { u, p } = await signedAndIssued()
    await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: '1040000',
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '12345678',
    })
    expect((await instructions(u, p)).json().still_to_pay_minor).toBe('520000')
  })

  it('TC-PAY-02 the PDF carries the warning first and a verify link; a larger commitment voids it, and both report it invalid', async () => {
    const { deal, u, p, page } = await signedAndIssued()
    const pdf = await inject('GET', `/api/my/participations/${p}/instructions.pdf`, u)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    const text = await pdfText(pdf.rawPayload)
    expect(text.join(' ')).toContain('PLACEHOLDER')
    expect(text.join(' ')).toContain('£15,600.00')
    expect(text.join(' ')).toContain('verify-instruction')
    const token = new URL(page.verify_url, 'http://x').searchParams.get('token')!
    expect((await inject('GET', `/api/instructions/verify?token=${token}`)).json().valid).toBe(true)
    expect((await change(u, deal, p, '1600000')).statusCode).toBe(200)
    expect((await inject('GET', `/api/instructions/verify?token=${token}`)).json().valid).toBe(false)
    expect((await mailTo(u.email)).at(-1)!.subject).toMatch(/no longer valid/)
    // the new amount needs a new signature, then a new issue
    expect((await instructions(u, p)).statusCode).toBe(409)
    await sign(u, p)
    expect((await instructions(u, p)).json().due_minor).toBe('1664000')
  })

  it('TC-PAY-03 "I have paid" tells the lead and is not a receipt', async () => {
    const { u, p } = await signedAndIssued()
    expect((await inject('POST', `/api/my/participations/${p}/paid`, u, {})).statusCode).toBe(200)
    expect(await count('SELECT count(*) AS n FROM receipt WHERE participation_id = $1', [p])).toBe(0)
    expect((await mailTo(lead.email)).at(-1)!.body).toMatch(/not a receipt/)
  })

  it('TC-PAY-06 / TC-STAT-04 the lead cannot record money; a reviewer can, with a payer, once per payment; reversal moves the status back and is audited', async () => {
    const { deal, u, p } = await signedAndIssued()
    const body = { amount_minor: '1560000', received_on: '2026-11-10', payer_name: 'Fay Fictional', payer_account: '12345678' }
    expect((await inject('POST', `/api/review/participations/${p}/receipts`, lead, body)).statusCode).toBe(403)
    expect((await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, { ...body, payer_name: '' })).statusCode).toBe(400)
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, body)
    expect(r.json().payer_mismatch).toBe(false)
    const status = async () => (await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0].status
    expect(await status()).toBe('funded')
    expect((await inject('POST', `/api/review/receipts/${r.json().id}/reverse`, reviewer, { reason: 'Bank recalled it' })).statusCode).toBe(200)
    expect(await status()).toBe('to_pay')
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'receipt.reversed' AND entity_id = $1", [r.json().id])).toBe(1)
    // the app role cannot bring the receipt back, nor rewrite why it was reversed
    await expect(t.app.query('UPDATE receipt SET reversed_at = NULL, reversed_by = NULL, reverse_reason = NULL WHERE id = $1', [r.json().id])).rejects.toThrow(/stays reversed/)
    await expect(t.app.query("UPDATE receipt SET reverse_reason = 'other' WHERE id = $1", [r.json().id])).rejects.toThrow(/stays reversed/)
  })

  it('TC-ENT-05 a payer that does not match is listed for checking; "unknown" is allowed and listed', async () => {
    const { p } = await signedAndIssued()
    expect(
      (
        await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
          amount_minor: '100',
          received_on: '2026-11-10',
          payer_name: 'Someone Else',
          payer_account: '1',
        })
      ).json().payer_mismatch,
    ).toBe(true)
    expect(
      (
        await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
          amount_minor: '100',
          received_on: '2026-11-10',
          payer_name: 'unknown',
          payer_account: 'unknown',
        })
      ).json().payer_mismatch,
    ).toBe(true)
  })

  it('TC-SIG-06 / TC-GATE-03 after the statement runs out: the signed document and the issued instruction are still there; nothing new is', async () => {
    const { deal, u, p } = await signedAndIssued()
    await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])
    const signed = await inject('GET', `/api/my/participations/${p}/signed`, u)
    expect(signed.statusCode).toBe(200)
    expect(signed.headers['content-type']).toBe('application/pdf')
    expect((await instructions(u, p)).statusCode).toBe(200)
    expect((await inject('GET', `/api/my/deals/${deal}`, u)).statusCode).toBe(404)
    expect((await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).statusCode).toBe(409)
  })

  it('TC-GATE-07 a KYC rejection: the invitation stays and another entity commits on the same terms', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    const a = await newEntity(u, 'Entity A')
    const b = await newEntity(u, 'Entity B')
    await commit(u, deal, a, '1000000')
    await commit(u, deal, b, '1000000')
    // A withdraws (D4's route; set directly here), then B is rejected
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = now() WHERE entity_id = $1", [a])
    // a case waiting for a reviewer, put straight in the table: D1 tests how one gets there
    const caseId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [caseId, b])
    const decided = await inject('POST', `/api/review/kyc/${caseId}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })
    expect(decided.statusCode, decided.body).toBe(200)
    expect((await t.owner.query('SELECT outcome FROM participation WHERE entity_id = $1', [b])).rows[0].outcome).toBe('rejected_kyc')
    expect((await inject('GET', `/api/my/deals/${deal}`, u)).statusCode).toBe(200)
    const cEnt = await newEntity(u, 'Entity C')
    expect((await commit(u, deal, cEnt, '1000000')).statusCode).toBe(200)
    const terms = (await t.owner.query<{ n: string }>('SELECT count(DISTINCT invitation_id)::text AS n FROM participation WHERE user_id = $1', [u.id])).rows[0]!
      .n
    expect(terms).toBe('1')
  })

  it('TC-ENT-01 signed with A, A changes and passes again: instructions and signing stay blocked by the identity review', async () => {
    const { u, p, entity } = await signedAndIssued()
    const r = await inject('PUT', `/api/entities/${entity}`, u, {
      fields: { full_name: 'Fay Renamed', address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' },
      parties: [],
    })
    expect(r.statusCode, r.body).toBe(200)
    await passKyc(entity)
    expect((await t.owner.query('SELECT identity_review FROM participation WHERE id = $1', [p])).rows[0].identity_review).toBe('pending')
    expect(await count('SELECT count(*) AS n FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL', [p])).toBe(0)
    expect((await instructions(u, p)).statusCode).toBe(409)
  })
})

describe('holds', () => {
  it('TC-CMP-01 a reviewer pauses alone; everything new stops; the issued instruction says do not pay; mail only to those still owing; someone else releases', async () => {
    const deal = await liveDeal(lead)
    const owes = await investor(deal)
    await commit(owes.u, deal, owes.entity, '1000000')
    const p = await pid(owes.u, deal)
    await sign(owes.u, p)
    const page = (await instructions(owes.u, p)).json()
    const fresh = await investor(deal)
    // signed, but no instruction issued before the hold
    const signedOnly = await investor(deal)
    await commit(signedOnly.u, deal, signedOnly.entity, '1000000')
    const sp = await pid(signedOnly.u, deal)
    await sign(signedOnly.u, sp)
    const hold = await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'Checking the company' })
    expect(hold.statusCode, hold.body).toBe(200)
    expect((await inject('GET', `/api/my/deals/${deal}`, fresh.u)).statusCode).toBe(404)
    expect((await commit(fresh.u, deal, fresh.entity, '1000000')).statusCode).toBe(409)
    const firstIssue = await instructions(signedOnly.u, sp)
    expect(firstIssue.statusCode).toBe(200)
    expect(firstIssue.json()).toMatchObject({ held: true })
    expect(await count('SELECT count(*) AS n FROM issued_instruction WHERE participation_id = $1', [sp])).toBe(0)
    const held = (await instructions(owes.u, p)).json()
    expect(held).toMatchObject({ held: true })
    expect(JSON.stringify(held)).not.toContain('Checking')
    const token = new URL(page.verify_url, 'http://x').searchParams.get('token')!
    expect((await inject('GET', `/api/instructions/verify?token=${token}`)).json()).toMatchObject({ valid: false, held: true })
    expect((await mailTo(owes.u.email)).at(-1)!.subject).toMatch(/do not send money/i)
    expect((await mailTo(fresh.u.email)).some((m) => /do not send money/i.test(m.subject))).toBe(false)
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: unique('x'), link_id: (await links(deal))[0]!.id })).json().error).toMatch(
      /paused/,
    )
    // receipts go on
    expect(
      (
        await inject('POST', `/api/review/participations/${p}/receipts`, reviewer2, {
          amount_minor: '100',
          received_on: '2026-11-10',
          payer_name: 'Fay Fictional',
          payer_account: '1',
        })
      ).statusCode,
    ).toBe(200)
    const id = (await inject('GET', '/api/holds', reviewer)).json().holds.find((h: { target_id: string }) => h.target_id === deal).id
    expect((await inject('POST', `/api/holds/${id}/release`, reviewer, {})).json().error).toMatch(/Someone else/)
    expect((await inject('POST', `/api/holds/${id}/release`, reviewer2, {})).statusCode).toBe(200)
    expect((await inject('GET', `/api/instructions/verify?token=${token}`)).json().valid).toBe(true)
    expect(await (await import('./d3Core.ts')).dealById(t.owner, deal).then((d) => d!.state)).toBe('live')
  })
})

describe('expected investors', () => {
  it('TC-PIP-01 paste with line numbers for bad rows, duplicates flagged, and the 500-row limit', async () => {
    const deal = await liveDeal(lead)
    const bad = await inject('POST', `/api/deals/${deal}/pipeline`, lead, {
      text: 'name,email,expected\nAnn,ann@example.test,£10,000\nBob,not-an-email,5000\n',
    })
    expect(bad.json().errors).toEqual([{ line: 3, message: 'Give a valid email address.' }])
    expect(bad.json().added).toBe(0)
    const ok = await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: 'Ann\tann@example.test\t10000\tdefault\nAnn Two\tANN@example.test\t\t\n' })
    expect(ok.json()).toMatchObject({ added: 2, duplicates: ['ann@example.test'] })
    const many = Array.from({ length: 498 }, (_, i) => `P${i},p${i}@example.test,100`).join('\n')
    expect((await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: many })).json().added).toBe(498)
    expect((await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: 'Q,q@example.test,1' })).json().errors[0].message).toMatch(/500/)
    const csv = await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: '=cmd,eq@example.test,1' })
    expect(csv.json().errors[0].message).toMatch(/500/)
  })

  it('TC-PIP-01 a list as long as an export can be, with 2,000-character notes, is read in one go (Codex round 10)', async () => {
    const deal = await liveDeal(lead)
    const note = 'n'.repeat(2000)
    const text = Array.from({ length: 300 }, (_, i) => `Ann ${i},${unique('long')},100,friends,${note}`).join('\n')
    expect(text.length).toBeGreaterThan(600_000)
    const r = await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text, dry_run: true })
    expect(r.json().errors).toEqual([])
    expect(r.json().rows).toHaveLength(300)
  })

  it('TC-PIP-01 a list larger than the usual 2 MB request is still read: JSON may write it longer than its text (Codex round 11)', async () => {
    const deal = await liveDeal(lead)
    // backslashes are written twice in JSON: 2.2 MB of request for 1.1 million characters
    const text = `Ann,${unique('slash')},100,friends,x\n` + '\\'.repeat(1_100_000)
    const r = await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text, dry_run: true })
    expect(r.statusCode).toBe(200)
    expect(r.json().rows).toHaveLength(1)
  })

  it('TC-PIP-02 / TC-PIP-03 one click: counted first, sent without deal content; the ones who respond show their status, the rest are named', async () => {
    const deal = await liveDeal(lead)
    const a = unique('pipe')
    const b = unique('pipe')
    await inject('POST', `/api/deals/${deal}/pipeline`, lead, {
      text: `Ann Pipe,${a},10000,friends,Call on Friday\nBen Pipe,${b},20000\n=Formula,${unique('pipe')},1,,"-said yes, maybe"`,
    })
    const rows = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows as Array<{ id: string; name: string }>
    const link = (await links(deal)).find((l) => l.carry_bps === 2000)!
    const entries = rows.map((r) => ({ id: r.id, link_id: link.id }))
    const preview = (await inject('POST', `/api/deals/${deal}/pipeline/preview`, lead, { entries })).json()
    expect(preview.count).toBe(3)
    expect(preview.by_terms).toEqual({ '20.00% carry · No fee': 3 })
    expect(
      (await inject('POST', `/api/deals/${deal}/pipeline/invite`, lead, { entries, confirm_count: 2, plan_sha256: preview.plan_sha256 })).json().error,
    ).toMatch(/changed/)
    expect(
      (await inject('POST', `/api/deals/${deal}/pipeline/invite`, lead, { entries, confirm_count: 3, plan_sha256: preview.plan_sha256 })).json().sent,
    ).toBe(3)
    const mail = (await mailTo(a))[0]!
    expect(holdsNoSeed(mail.subject + mail.body)).toBe(true)
    const token = /token=([\w-]+)/.exec(mail.body)![1]!
    const ann = await person(a, await open(token))
    await inject('POST', '/api/invite/accept', ann, {})
    const after = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json()
    expect(after.rows.find((r: { email: string }) => r.email === a).status).toBe('invited')
    expect(after.not_responded).toContain('Ben Pipe')
    // R-PIP-04: nobody committed yet, so expected is every row's typed amount; the allocation is the deal's
    const typed = (after.rows as Array<{ expected_minor: string | null }>).reduce((x, r) => x + BigInt(r.expected_minor ?? '0'), 0n)
    expect(typed).toBeGreaterThan(0n)
    expect(after.totals).toMatchObject({ committed_minor: '0', expected_minor: String(typed) })
    expect(after.totals.allocation_minor).toBe((await t.owner.query("SELECT draft->'terms'->>'allocation_minor' AS a FROM deal WHERE id = $1", [deal])).rows[0]!.a)
    // sent once: a second click does not send again
    expect((await inject('POST', `/api/deals/${deal}/pipeline/preview`, lead, { entries })).json().count).toBe(0)
    // R-CMP-03: by default only staff export; the operator lets leads through a second admin
    expect((await inject('GET', `/api/deals/${deal}/pipeline.csv`, lead)).json().error).toMatch(/does not allow/)
    const pol = (await inject('GET', '/api/admin/policy', admin)).json()
    const asked = await inject('PUT', '/api/admin/policy', admin, {
      per_link_terms: pol.per_link_terms,
      generic_links: pol.generic_links,
      bulk_promo: pol.bulk_promo,
      export_roles: [...pol.export_roles, 'lead'],
      reminder_count: pol.reminder_count,
      reminder_every_days: pol.reminder_every_days,
    })
    expect(asked.json().requestId).toBeTruthy()
    expect((await inject('POST', `/api/requests/${asked.json().requestId}/approve`, admin, {})).statusCode).toBe(200)
    // the export writes a formula as text (Goten I-09) and amounts in pounds and pence, so it reads back the same
    const csv = (await inject('GET', `/api/deals/${deal}/pipeline.csv`, lead)).body
    expect(csv).toContain('Ann Pipe,' + a + ',10000.00')
    const again = await inject('POST', `/api/deals/${await liveDeal(lead)}/pipeline`, lead, { text: csv, dry_run: true })
    expect(again.json().rows.find((r: { email: string }) => r.email === a).expected_minor).toBe('1000000')
    expect(csv).toContain("'=Formula")
    // the whole row reads back as it was: name, email, amount, terms label and private note; the status column is left out (Codex round 9)
    const listed = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows as Array<Record<string, unknown>>
    const pick = (r: Record<string, unknown>) => ({ name: r.name, email: r.email, expected_minor: r.expected_minor, terms_label: r.terms_label, private_note: r.private_note })
    expect(again.json().errors).toEqual([])
    expect((again.json().rows as Array<Record<string, unknown>>).map(pick)).toEqual(listed.map(pick))
    expect(listed.map((r) => r.private_note)).toContain('Call on Friday')
    expect(listed.map((r) => r.private_note)).toContain('-said yes, maybe')
  })
})

describe('switches and access', () => {
  it('TC-CMP-03 tightening applies at once and turns off unbound links; loosening waits for a second admin', async () => {
    const deal = await liveDeal(lead)
    const before = (await inject('GET', '/api/admin/policy', admin)).json()
    const tight = {
      per_link_terms: false,
      generic_links: before.generic_links,
      bulk_promo: before.bulk_promo,
      export_roles: before.export_roles,
      reminder_count: before.reminder_count,
      reminder_every_days: before.reminder_every_days,
    }
    expect((await inject('PUT', '/api/admin/policy', admin, tight)).json()).toEqual({})
    const ls = await links(deal)
    expect(ls.find((l) => l.carry_bps === 0)).toMatchObject({ usable: false })
    expect(
      (await inject('POST', `/api/deals/${deal}/links`, lead, { kind: 'open', carry_bps: 1000, fee: { kind: 'none' }, reason: 'x', confirm: true })).json()
        .error,
    ).toMatch(/does not allow/)
    const loose = await inject('PUT', '/api/admin/policy', admin, { ...tight, per_link_terms: true })
    expect(loose.json().requestId).toBeTruthy()
    // the sandbox's only admin may approve their own request
    expect((await inject('POST', `/api/requests/${loose.json().requestId}/approve`, admin, {})).statusCode).toBe(200)
    expect((await inject('GET', '/api/admin/policy', admin)).json().per_link_terms).toBe(true)
  })

  it('TC-AUTHZ-01 nobody reaches another person’s participation, a lead’s routes or a reviewer’s', async () => {
    const deal = await liveDeal(lead)
    const a = await investor(deal)
    const b = await investor(deal)
    await commit(a.u, deal, a.entity, '1000000')
    const p = await pid(a.u, deal)
    for (const [m, url] of [
      ['GET', `/api/my/participations/${p}/deal-sheet`],
      ['GET', `/api/my/participations/${p}/instructions`],
      ['GET', `/api/my/participations/${p}/signed`],
      ['POST', `/api/my/participations/${p}/paid`],
      ['PUT', `/api/my/participations/${p}/commitment`],
    ] as const) {
      const r = await inject(m, url, b.u, m === 'PUT' ? { commitment_minor: '1', quoted_due_minor: '1' } : m === 'POST' ? {} : undefined)
      expect([404, 409], `${m} ${url}`).toContain(r.statusCode)
      expect(r.body).not.toContain(a.u.email)
    }
    for (const url of [`/api/deals/${deal}/links`, `/api/deals/${deal}/pipeline`, `/api/deals/${deal}/messages`])
      expect((await inject('GET', url, a.u)).statusCode).toBe(409)
    expect((await inject('POST', '/api/holds', a.u, { level: 'deal', target_id: deal, reason: 'nope' })).statusCode).toBe(403)
    expect((await inject('GET', `/api/review/deals/${deal}/participations`, lead)).statusCode).toBe(403)
    expect(
      (
        await inject('POST', `/api/review/participations/${p}/receipts`, a.u, {
          amount_minor: '1',
          received_on: '2026-11-10',
          payer_name: 'x',
          payer_account: 'y',
        })
      ).statusCode,
    ).toBe(403)
  })

  it('TC-PAGE-03 a message reaches the lead', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    expect((await inject('POST', `/api/my/deals/${deal}/message`, u, { body: 'When does it close?' })).statusCode).toBe(200)
    expect((await inject('GET', `/api/deals/${deal}/messages`, lead)).json().messages[0].body).toBe('When does it close?')
    expect((await mailTo(lead.email)).at(-1)!.subject).toMatch(/message from an investor/)
  })

  it('TC-LNK-09 people are counted once by country, as a reminder', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    expect((await inject('PUT', '/api/my/country', u, { country: 'gb' })).statusCode).toBe(400)
    expect((await inject('PUT', '/api/my/country', u, { country: 'GB' })).statusCode).toBe(200)
    expect((await inject('GET', '/api/my/country', u)).json().country).toBe('GB')
    const reach = (await inject('GET', `/api/deals/${deal}/links`, lead)).json().reach
    expect(reach.counts.uk).toBe(1)
    expect(reach.note).toMatch(/reminders/)
  })
})

describe('remaining D3 cases', () => {
  it('TC-FEE-12 nobody’s amount to pay moves when others commit or leave', async () => {
    const deal = await liveDeal(lead)
    const a = await investor(deal)
    await commit(a.u, deal, a.entity, '1000000')
    const due = async () =>
      (await t.owner.query<{ cash_due_minor: string }>('SELECT cash_due_minor FROM participation WHERE user_id = $1', [a.u.id])).rows[0]!.cash_due_minor
    const before = await due()
    for (let i = 0; i < 3; i++) {
      const b = await investor(deal)
      await commit(b.u, deal, b.entity, String(100000 + i * 777777))
      if (i === 1) await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = now() WHERE user_id = $1", [b.u.id])
      expect(await due()).toBe(before)
    }
  })

  it('TC-GATE-09 an expired statement: an uninvested deal is a neutral row without the company; an invested one is shown', async () => {
    const deal = await liveDeal(lead)
    const other = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    const cookie = await open(tokenOf(await urlOf(other, (await links(other))[0]!.id)))
    await inject('POST', '/api/invite/accept', { ...u, cookie: `${u.cookie}; ${cookie}` }, {})
    await commit(u, deal, entity, '1000000')
    await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])
    const rows = (await inject('GET', '/api/my/deals', u)).json().deals as Array<{
      deal_id: string
      visible: boolean
      company: string | null
      name: string | null
    }>
    expect(rows.find((r) => r.deal_id === other)).toMatchObject({ visible: false, company: null, name: null })
    // the committed one keeps the person's own record; new promotion is what the expiry stops
    expect(rows.find((r) => r.deal_id === deal)!.visible).toBe(false)
    expect(holdsNoSeed(JSON.stringify(rows.find((r) => r.deal_id === other)))).toBe(true)
  })

  it('TC-CMT-03 the wording on what a commitment means comes from the pack, and a placeholder stops the real mode', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    const q = (await inject('POST', `/api/my/deals/${deal}/quote`, u, { commitment_minor: '1000000' })).json()
    const pack = (
      await t.owner.query<{ content: { legal_texts: Array<{ text_key: string; body: string; is_placeholder: boolean }> } }>(
        'SELECT r.content FROM regime_pack r JOIN instance_profile i ON i.active_pack_id = r.id',
      )
    ).rows[0]!.content
    const text = pack.legal_texts.find((x) => x.text_key === 'commitment_effect')!
    expect(q.commitment_effect).toBe(text.body)
    expect(text.is_placeholder).toBe(true)
    const blockers = (await inject('GET', '/api/instance', admin)).json().blockers as Array<{ code: string; message: string }>
    expect(JSON.stringify(blockers)).toMatch(/placeholder/i)
  })

  it('TC-CMT-04 an S/EIS deal shows the remainder note and keeps each person’s scheme; a scheme the deal does not offer is refused', async () => {
    const deal = await liveDeal(lead, { terms: { ...draftFor('x').terms, seis: true } })
    const { u, entity } = await investor(deal)
    const q = (await inject('POST', `/api/my/deals/${deal}/quote`, u, { commitment_minor: '1000000' })).json()
    expect(q.scheme_note).toMatch(/remainder/)
    expect(q.scheme_note).toMatch(/whole number of shares/)
    expect((await commit(u, deal, entity, '1000000', { scheme: 'eis' })).json().error).toMatch(/EIS/)
    expect((await commit(u, deal, entity, '1000000', { scheme: 'seis' })).statusCode).toBe(200)
    expect((await t.owner.query('SELECT scheme FROM participation WHERE user_id = $1', [u.id])).rows[0].scheme).toBe('seis')
  })

  it('TC-CMP-02 investors see the approved version, not the lead’s working copy', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    await t.owner.query("UPDATE deal SET draft = jsonb_set(draft, '{basics,name}', '\"Typed After Launch\"') WHERE id = $1", [deal])
    const page = await inject('GET', `/api/my/deals/${deal}`, u)
    expect(page.json().name).toBe('Seedling Round')
    expect(page.body).not.toContain('Typed After Launch')
  })

  it('TC-PAGE-02 the documents are the deal’s; the deal sheet is the person’s own; invest or not', async () => {
    const deal = await liveDeal(lead)
    const a = await investor(deal)
    const b = await investor(deal)
    const page = (await inject('GET', `/api/my/deals/${deal}`, a.u)).json()
    expect(page.documents.map((d: { display_name: string }) => d.display_name)).toEqual(['a.pdf'])
    expect(page.can_commit).toBe(true)
    await commit(a.u, deal, a.entity, '1000000')
    const p = await pid(a.u, deal)
    expect((await inject('GET', `/api/my/participations/${p}/deal-sheet`, b.u)).statusCode).toBe(409)
    expect((await inject('GET', `/api/my/participations/${p}/deal-sheet`, a.u)).statusCode).toBe(200)
    expect((await inject('POST', `/api/my/deals/${deal}/pass`, b.u, {})).statusCode).toBe(200)
  })

  // R-SIG-05 is P1: no outside provider exists yet, so this checks the adapter shape only (Codex round 1, finding 22, rejected for D3)
  it('TC-SIG-05 the signature adapter shape: the fake one starts and reports a signature', async () => {
    const { FakeSignature } = await import('../adapters/index.ts')
    const s = new FakeSignature()
    const { ref } = await s.start('a'.repeat(64), 'signer')
    expect(['pending', 'signed']).toContain(await s.status(ref))
  })

  it('TC-PAY-04 paying more than due lists a refund and does not raise the commitment', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    await sign(u, p)
    await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: '600000',
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '1',
    })
    let part = (await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0]
    expect(part).toMatchObject({ status: 'part_paid', still_to_pay_minor: '400000' })
    await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: '500000',
      received_on: '2026-11-11',
      payer_name: 'Fay Fictional',
      payer_account: '1',
    })
    part = (await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0]
    expect(part).toMatchObject({ status: 'refund_due', commitment_minor: '1000000', due_minor: '1000000', still_to_pay_minor: '0' })
  })
})

describe('the warning cover (decision R26)', () => {
  it('TC-GATE-05 a third-party PDF is served with the warning as its first page; an unreadable one is not served', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage([300, 300]).drawText('Company agreement page')
    const real = Buffer.from(await doc.save())
    let ent = leadEntities.get(lead.id)
    if (!ent) leadEntities.set(lead.id, (ent = await newEntity(lead)))
    const id = (await inject('POST', '/api/deals', lead, {})).json().id as string
    await inject('PUT', `/api/deals/${id}/draft`, lead, draftFor(ent))
    const put = (body: Buffer, name: string) =>
      app.inject({
        method: 'POST',
        url: `/api/deals/${id}/files?kind=legal&name=${name}`,
        remoteAddress: nextIp(),
        headers: { cookie: lead.cookie, 'x-csrf-token': lead.csrf, 'content-type': 'application/octet-stream' },
        payload: body,
      })
    expect((await put(real, 'agreement.pdf')).statusCode).toBe(200)
    // a PDF that cannot take its cover is refused at upload, while the lead can still replace it (Codex round 4)
    const refused = await put(Buffer.from('%PDF-1.7 not really a pdf'), 'broken.pdf')
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error).toMatch(/cannot be read/)
    expect((await inject('POST', `/api/deals/${id}/submit`, lead, {})).statusCode).toBe(200)
    expect((await inject('POST', `/api/review/deals/${id}/approve`, reviewer, { reviewed_sha256: await latestSha(id) })).statusCode).toBe(200)
    expect((await inject('POST', `/api/deals/${id}/launch`, lead, { confirm: true, content_sha256: await latestSha(id, true) })).statusCode).toBe(200)
    const { u } = await investor(id)
    const docs = (await inject('GET', `/api/my/deals/${id}`, u)).json().documents as Array<{ id: string; display_name: string }>
    const got = await inject('GET', `/api/my/deals/${id}/files/${docs.find((d) => d.display_name === 'agreement.pdf')!.id}`, u)
    expect(got.statusCode).toBe(200)
    expect(got.headers['content-type']).toBe('application/pdf')
    const out = await PDFDocument.load(got.rawPayload)
    expect(out.getPageCount()).toBe(2)
    // the cover's text, from its compressed content streams: the first page comes from us
    const { inflateSync } = await import('node:zlib')
    const raw = got.rawPayload.toString('latin1')
    const texts = [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => {
      try {
        return inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1')
      } catch {
        return ''
      }
    })
    expect(texts.some((x) => x.includes('PLACEHOLDER') || /<[0-9A-F]+> Tj/.test(x))).toBe(true)
    expect(docs.some((d) => d.display_name === 'broken.pdf')).toBe(false)
  })
})

describe('fixes from the first fresh-context review', () => {
  it('TC-GATE-05 / TC-SIG-02 under FPO the deal sheet leads with the warning for the person’s category, and the signed copy keeps it', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    const sheet = (await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json()
    expect(sheet.warning.text).toMatch(/PLACEHOLDER/)
    await sign(u, p)
    const doc = (await t.owner.query<{ document: string }>('SELECT document FROM signature_record WHERE participation_id = $1', [p])).rows[0]!.document
    expect(doc.startsWith(sheet.warning.text)).toBe(true)
  })

  it('TC-ENT-01 an entity changed before signing: the commitment follows the new version and can be signed once it passes', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    const r = await inject('PUT', `/api/entities/${entity}`, u, {
      fields: { full_name: 'Fay Changed', address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' },
      parties: [],
    })
    expect(r.statusCode, r.body).toBe(200)
    const row = (await t.owner.query('SELECT entity_version, identity_review FROM participation WHERE id = $1', [p])).rows[0]
    expect(row).toEqual({ entity_version: 2, identity_review: 'none' })
    expect((await sign(u, p)).statusCode).toBe(409)
    await passKyc(entity)
    expect((await sign(u, p)).statusCode).toBe(200)
  })

  it('TC-CMP-01 a reviewer who is the lead cannot end a pause on their own deal or read its reason, nor reverse money on it', async () => {
    const both = await person(unique('leadrev'))
    await t.owner.query("INSERT INTO role_grant (user_id, role) VALUES ($1, 'reviewer')", [both.id])
    const e = t.keyring.encrypt(MFA)
    await t.owner.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [
      both.id,
      e.ciphertext,
      e.keyId,
      e.wrappedDek,
    ])
    const lr = await login(both.email)
    const deal = await liveDeal(lr)
    const { u, entity } = await investor(deal, { leader: lr })
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    const rec = (
      await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
        amount_minor: '100',
        received_on: '2026-11-10',
        payer_name: 'Fay Fictional',
        payer_account: '1',
      })
    ).json()
    expect((await inject('POST', `/api/review/receipts/${rec.id}/reverse`, lr, { reason: 'mine' })).json().error).toMatch(/lead, work on/)
    await inject('POST', '/api/holds', reviewer, { level: 'lead', target_id: lr.id, reason: 'Secret reason' })
    const mine = (await inject('GET', '/api/holds', lr)).json().holds.find((h: { target_id: string }) => h.target_id === lr.id)
    expect(mine.reason).toBeNull()
    expect((await inject('POST', `/api/holds/${mine.id}/release`, lr, {})).json().error).toMatch(/stake/)
    expect((await inject('POST', `/api/holds/${mine.id}/release`, reviewer2, {})).statusCode).toBe(200)
  })

  it('TC-CMP-01 ending one pause while another still covers the deal tells nobody the pause has ended', async () => {
    const deal = await liveDeal(lead)
    const owes = await investor(deal)
    await commit(owes.u, deal, owes.entity, '1000000')
    const p = await pid(owes.u, deal)
    await sign(owes.u, p)
    await instructions(owes.u, p)
    await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'One' })
    await inject('POST', '/api/holds', reviewer, { level: 'lead', target_id: lead.id, reason: 'Two' })
    const id = (await inject('GET', '/api/holds', reviewer2))
      .json()
      .holds.find((h: { target_id: string; released_at: string | null }) => h.target_id === deal && !h.released_at).id
    expect((await inject('POST', `/api/holds/${id}/release`, reviewer2, {})).statusCode).toBe(200)
    expect((await mailTo(owes.u.email)).some((m) => /pause has ended/.test(m.subject))).toBe(false)
    const other = (await inject('GET', '/api/holds', reviewer2))
      .json()
      .holds.find((h: { target_id: string; released_at: string | null }) => h.target_id === lead.id && !h.released_at).id
    await inject('POST', `/api/holds/${other}/release`, reviewer2, {})
    expect((await mailTo(owes.u.email)).some((m) => /pause has ended/.test(m.subject))).toBe(true)
  })

  it('TC-OP-05 in the real mode nobody short of the payment gate sees the receiving account, even to acknowledge it', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    // a second person, signed in the sandbox: the placeholder deal sheet cannot be signed in the real mode
    const other = await investor(deal)
    await commit(other.u, deal, other.entity, '1000000')
    const op = await pid(other.u, deal)
    expect((await sign(other.u, op)).statusCode).toBe(200)
    try {
      await t.owner.query(
        "UPDATE instance_profile SET mode = 'real', real_since = '2000-01-01', regulatory_status = 'authorised_firm', accountable_person = 'A Person', accountable_confirmed_on = '2026-11-10', approved_by = $1",
        [admin.id],
      )
      await t.owner.query(
        `INSERT INTO payment_instruction (id, currency, version, account_fields, holder, holder_capacity, asserted_client_money, your_money_text_key, refund_days, receipt_check_note, prepared_by, approved_by)
         VALUES ($1, 'GBP', 1, '{"sort_code": "11-22-33", "account_number": "98765432"}', 'Real Holder Ltd', 'Operator', true, 'your_money', 10, 'Daily', $2, $3)`,
        [randomUUID(), admin.id, reviewer.id],
      )
      const before = await instructions(u, p)
      expect(before.statusCode).toBe(409)
      expect(before.body).not.toContain('98765432')
      const ack = await instructions(other.u, op)
      // told it changed, not shown it, until they confirm (R-OP-05)
      expect(ack.json()).toMatchObject({ acknowledge: true })
      expect(ack.body).not.toContain('98765432')
      expect(
        (await inject('POST', `/api/my/participations/${op}/acknowledge-account`, other.u, { account_sha256: ack.json().account_sha256 })).statusCode,
      ).toBe(200)
      expect((await instructions(other.u, op)).json().account.account_number).toBe('98765432')
    } finally {
      await t.owner.query(
        "UPDATE instance_profile SET mode = 'sandbox', real_since = NULL, regulatory_status = NULL, accountable_person = NULL, accountable_confirmed_on = NULL, approved_by = NULL",
      )
      // the row stays: the table only takes new rows, and the sandbox never reads it
    }
  })
})

describe('fixes from Codex round 1', () => {
  it('TC-CMT-05 a commitment is refused when the amount or the terms moved after the quote', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    const q = (await inject('POST', `/api/my/deals/${deal}/quote`, u, { commitment_minor: '1000000' })).json()
    expect(
      (
        await inject('POST', `/api/my/deals/${deal}/commit`, u, {
          entity_id: entity,
          commitment_minor: '10000000',
          quoted_due_minor: q.due_minor,
          terms_link_id: q.terms_link_id,
        })
      ).json().error,
    ).toMatch(/changed after you checked/)
    // the lead moves this person to a fee link between the quote and the commitment
    const fee = (
      await inject('POST', `/api/deals/${deal}/links`, lead, {
        kind: 'open',
        carry_bps: 2000,
        fee: { kind: 'percent', bps: 400, mode: 'on_top' },
        reason: 'x',
        confirm: true,
      })
    ).json().id
    const inv = (await t.owner.query<{ id: string }>('SELECT id FROM deal_invitation WHERE user_id = $1', [u.id])).rows[0]!.id
    expect((await inject('POST', `/api/deals/${deal}/invitations/${inv}/link`, lead, { link_id: fee })).statusCode).toBe(200)
    expect(
      (
        await inject('POST', `/api/my/deals/${deal}/commit`, u, {
          entity_id: entity,
          commitment_minor: '1000000',
          quoted_due_minor: q.due_minor,
          terms_link_id: q.terms_link_id,
        })
      ).json().error,
    ).toMatch(/changed after you checked/)
    expect((await inject('POST', `/api/my/deals/${deal}/commit`, u, { entity_id: entity, commitment_minor: '1000000' })).json().error).toMatch(
      /Check the amount/,
    )
  })

  it('TC-CMT-04 a scheme the deal does not offer is refused, not dropped', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    expect((await commit(u, deal, entity, '1000000', { scheme: 'seis' })).json().error).toMatch(/SEIS/)
  })

  it('TC-ENT-01 both identity decisions: same entity signs again; another entity ends the commitment', async () => {
    const deal = await liveDeal(lead)
    for (const decision of ['same_entity', 'other_entity'] as const) {
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      await sign(u, p)
      await inject('PUT', `/api/entities/${entity}`, u, {
        fields: { full_name: 'Fay Renamed', address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' },
        parties: [],
      })
      expect((await inject('POST', `/api/review/participations/${p}/identity`, reviewer, { decision, reason: 'checked' })).json().error ?? '').toMatch(
        decision === 'same_entity' ? /not passed/ : /^$/,
      )
      if (decision === 'same_entity') {
        await passKyc(entity)
        expect((await inject('POST', `/api/review/participations/${p}/identity`, reviewer, { decision, reason: 'checked' })).statusCode).toBe(200)
        expect((await t.owner.query('SELECT entity_version, identity_review, outcome FROM participation WHERE id = $1', [p])).rows[0]).toEqual({
          entity_version: 2,
          identity_review: 'resolved',
          outcome: 'active',
        })
        expect((await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0].status).toBe('to_sign')
        expect((await sign(u, p)).statusCode).toBe(200)
      } else {
        expect((await t.owner.query('SELECT outcome FROM participation WHERE id = $1', [p])).rows[0].outcome).toBe('withdrawn')
      }
    }
  })

  it('TC-CMP-02 in the real mode a new deal sheet wording reaches investors only once approved', async () => {
    const approverC = await staff(unique('approver'), ['approver'])
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = true')
    try {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Approved wording for {investor_name}: {breakdown}', needs_deed: false })
      expect((await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json().error).toMatch(/not set up/)
      const t1 = (await inject('GET', '/api/approvals/templates', approverC)).json().templates[0]
      expect(
        (await inject('POST', `/api/approvals/templates/${t1.id}`, approverC, { content_sha256: 'a'.repeat(64), self_declared_name: 'Ana' })).json().error,
      ).toMatch(/changed/)
      expect((await inject('POST', `/api/approvals/templates/${t1.id}`, approverC, { content_sha256: t1.sha256, self_declared_name: 'Ana' })).statusCode).toBe(
        200,
      )
      expect((await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json().document).toContain('Approved wording')
      // a later unapproved version does not replace it
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Unapproved wording for {investor_name}: {breakdown}', needs_deed: false })
      expect((await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json().document).toContain('Approved wording')
    } finally {
      await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = false')
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {breakdown}, reference {reference}.',
        needs_deed: false,
      })
    }
  })

  it('TC-CMP-02 the shipped placeholder saved again unchanged, or with its heading kept, stays a placeholder and cannot be approved', async () => {
    const approverC = await staff(unique('approver'), ['approver'])
    const shipped = (await t.owner.query<{ body: string }>("SELECT body FROM document_template WHERE kind = 'deal_sheet' AND version = 1")).rows[0]!.body
    try {
      for (const body of [shipped, shipped.replace('The operator replaces this text before real use.', 'Edited a little.')]) {
        expect((await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body, needs_deed: false })).statusCode).toBe(200)
        const t1 = (await inject('GET', '/api/approvals/templates', approverC)).json().templates[0]
        expect(t1.is_placeholder).toBe(true)
        expect((await inject('POST', `/api/approvals/templates/${t1.id}`, approverC, { content_sha256: t1.sha256, self_declared_name: 'Ana' })).json().error).toMatch(
          /Placeholder/,
        )
      }
    } finally {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {breakdown}, reference {reference}.',
        needs_deed: false,
      })
    }
  })

  it('TC-PAY-06 an admin without the reviewer role records money', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    expect(
      (
        await inject('POST', `/api/review/participations/${p}/receipts`, admin, {
          amount_minor: '100',
          received_on: '2026-11-10',
          payer_name: 'Fay Fictional',
          payer_account: '1',
        })
      ).statusCode,
    ).toBe(200)
    expect((await inject('GET', '/api/review/live-deals', admin)).json().deals.some((x: { id: string }) => x.id === deal)).toBe(true)
  })

  it('TC-LNK-02 the 500th person can join a deal, the 501st cannot', async () => {
    const deal = await liveDeal(lead)
    const link = (await links(deal)).find((l) => l.carry_bps === 2000)!
    const filler = await t.owner.query<{ id: string }>(
      "INSERT INTO user_account (id, email, name, password_hash) SELECT gen_random_uuid(), 'fill' || g || '-' || $1 || '@example.test', 'Fill', 'x' FROM generate_series(1, 499) g RETURNING id",
      [deal.slice(0, 8)],
    )
    for (const r of filler.rows)
      await t.owner.query('INSERT INTO deal_invitation (id, deal_id, user_id, invite_link) VALUES (gen_random_uuid(), $1, $2, $3)', [deal, r.id, link.id])
    const at500 = await person(unique('p500'), await open(tokenOf(await urlOf(deal, link.id))))
    expect((await inject('POST', '/api/invite/accept', at500, {})).json().results[0].result).toBe('invited')
    const at501 = await person(unique('p501'), await open(tokenOf(await urlOf(deal, link.id))))
    expect((await inject('POST', '/api/invite/accept', at501, {})).json().results[0].result).toBe('deal_full')
  })

  it('TC-CMP-01 a lead-level pause: the lead’s team cannot read its reason or end it', async () => {
    const deal = await liveDeal(lead)
    const member = await staff(unique('teamrev'), ['reviewer'])
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, member.id])
    await inject('POST', '/api/holds', reviewer, { level: 'lead', target_id: lead.id, reason: 'Lead secret' })
    const h = (await inject('GET', '/api/holds', member))
      .json()
      .holds.find((x: { target_id: string; released_at: string | null }) => x.target_id === lead.id && !x.released_at)
    expect(h.reason).toBeNull()
    expect((await inject('POST', `/api/holds/${h.id}/release`, member, {})).json().error).toMatch(/stake/)
    expect((await inject('POST', `/api/holds/${h.id}/release`, reviewer2, {})).statusCode).toBe(200)
  })

  it('TC-CMP-03 / TC-LNK-11 turning both switches off stops an open link someone is bound to; COBS launch makes no different-terms link', async () => {
    const deal = await liveDeal(lead)
    const zero = (await links(deal)).find((l) => l.carry_bps === 0)!
    const token = tokenOf(await urlOf(deal, zero.id))
    const bound = await person(unique('bound'), await open(token))
    await inject('POST', '/api/invite/accept', bound, {})
    const pol = (await inject('GET', '/api/admin/policy', admin)).json()
    await inject('PUT', '/api/admin/policy', admin, { ...pol, version: undefined, per_link_terms: false, generic_links: false })
    expect((await inject('POST', '/api/invite/open', undefined, { token })).statusCode).toBe(404)
    expect(await count("SELECT count(*) AS n FROM deal_invitation WHERE user_id = $1 AND state = 'active'", [bound.id])).toBe(1)
    const cobs = (await t.owner.query<{ id: string }>("SELECT id FROM regime_pack WHERE key = 'uk-cobs-template' ORDER BY version DESC LIMIT 1")).rows[0]!.id
    const fpo = (await t.owner.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile')).rows[0]!.active_pack_id
    await t.owner.query(
      "INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count) SELECT max(version) + 1, true, true, true, ARRAY['admin'], 2 FROM operator_policy",
    )
    await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [cobs])
    try {
      const c = await liveDeal(lead)
      expect((await links(c)).map((l) => l.carry_bps)).toEqual([2000])
    } finally {
      await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [fpo])
    }
  })

  it('TC-SIG-04 a deed cannot be recorded for someone whose statement has run out; the record holds the sheet sent out', async () => {
    await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Deed for {investor_name}: {breakdown}', needs_deed: true })
    try {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).json().error).toMatch(/statement/)
      await t.owner.query("UPDATE eligibility_statement SET expires_at = now() + interval '1 year' WHERE user_id = $1", [u.id])
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).json().error).toMatch(/Send it first/)
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      // the amount changes after the document went out: recording that document is refused (Codex round 5)
      expect((await change(u, deal, p, '1200000')).statusCode).toBe(200)
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).json().error).toMatch(/Send it first|no longer current/)
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      // the wording changes after the document went out, while the sent record stays: still refused as no longer current
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'New deed wording for {investor_name}: {breakdown}', needs_deed: true })
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).json().error).toMatch(/no longer current/)
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Deed for {investor_name}: {breakdown}', needs_deed: true })
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).statusCode).toBe(200)
      const doc = (
        await t.owner.query<{ document: string }>('SELECT document FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL', [p])
      ).rows[0]!.document
      expect(doc).toContain('Deed for Fay Fictional')
      expect(doc).toContain('£12,000.00')
    } finally {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {breakdown}, reference {reference}.',
        needs_deed: false,
      })
    }
  })

  it('TC-PIP-03 a KYC refusal is never shown to the lead; extra columns are refused with their line', async () => {
    const deal = await liveDeal(lead)
    const email = unique('piprej')
    await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Rae Ject,${email},5000` })
    const cookie = await open(tokenOf(await urlOf(deal, (await links(deal)).find((l) => l.carry_bps === 2000)!.id)))
    const u = await person(email, cookie)
    await inject('POST', '/api/invite/accept', u, {})
    await qualify(u)
    const e = await newEntity(u)
    await passKyc(e)
    await commit(u, deal, e, '1000000')
    await t.owner.query("UPDATE participation SET outcome = 'rejected_kyc', ended_at = now() WHERE user_id = $1", [u.id])
    const rows = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows
    // R-KYC-02.1: a refusal reads as being with the operator (Codex round 2)
    expect(rows.find((r: { email: string }) => r.email === email).status_label).toBe('With the operator')
    expect(JSON.stringify(rows)).not.toMatch(/Not approved/)
    expect((await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: 'A,a1@example.test,1,t,n,extra' })).json().errors[0]).toMatchObject({
      line: 1,
      message: expect.stringMatching(/five columns/),
    })
  })

  it('TC-GATE-03 / TC-PAY-07 your own documents stay reachable when the statement lapses; the list leads with the warning; money facts shown', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    await sign(u, p)
    const page = (await instructions(u, p)).json()
    expect(page.your_money).toMatchObject({ operator_statement: expect.any(String) })
    expect((await inject('GET', '/api/my/deals', u)).json().warning.text).toMatch(/PLACEHOLDER/)
    await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])
    const mine = (await inject('GET', '/api/my/participations', u)).json().participations
    expect(mine).toEqual([{ id: p, deal_code: expect.any(String), signed: true, instruction: true, held: false, exclusion_notice: null }])
    expect(JSON.stringify(mine)).not.toContain('Seedling')
  })
})

describe('fixes from Codex round 2', () => {
  it('TC-OP-05 a new receiving account through the real request: shown to the second admin, old instructions voided, investors told', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { insertPack } = await import('../store/packs.ts')
    const dir = mkdtempSync(join(tmpdir(), 'bulma-pay-'))
    const file = join(dir, 'payment.json')
    const entry = (n: string) => ({
      currency: 'GBP',
      account_fields: { sort_code: '11-22-33', account_number: n },
      holder: 'Real Holder Ltd',
      holder_capacity: 'Operator',
      holder_frn: null,
      asserted_client_money: true,
      your_money_text_key: 'your_money',
      refund_days: 10,
      receipt_check_note: 'Daily',
    })
    writeFileSync(file, JSON.stringify([entry('22222222')]))
    // in the real mode mail goes to the configured mailer, not the sandbox outbox: this one records what it is given
    const sent: Array<{ to: string; subject: string }> = []
    const real = { mailer: { send: async (m: { to: string; subject: string }) => (sent.push(m), { delivered: true }) } }
    const app2 = await buildServer({ db: t.app, k: t.keyring, secureCookies: false, now: () => clock, paymentFile: file, real: real as never })
    const admin2 = await staff(unique('admin2'), ['admin'])
    const before = (await t.owner.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile')).rows[0]!.active_pack_id
    const content = (
      await t.owner.query<{ content: { legal_texts: Array<{ text_key: string; is_placeholder: boolean }> } & Record<string, unknown> }>(
        'SELECT content FROM regime_pack WHERE id = $1',
        [before],
      )
    ).rows[0]!.content
    const final = {
      ...content,
      key: 'test-final-money',
      version: 1,
      legal_texts: content.legal_texts.map((x) => (x.text_key === 'your_money' ? { ...x, is_placeholder: false } : x)),
    }
    const packId = await tx(t.app, (c) => insertPack(c, final as never, { builtIn: false, by: null }))
    await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [packId])
    // this deal goes live a minute after the others, so the switch can fall between them
    const savedClock = clock
    clock = new Date(clock.getTime() + 60_000)
    try {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      expect((await sign(u, p)).statusCode).toBe(200)
      await t.owner.query(
        // the switch counted as just before this deal went live: earlier sandbox deals are stopped (R25)
        "UPDATE instance_profile SET mode = 'real', real_since = (SELECT went_live_at - interval '1 second' FROM deal WHERE id = $2), regulatory_status = 'authorised_firm', accountable_person = 'A Person', accountable_confirmed_on = '2026-11-10', approved_by = $1",
        [admin.id, deal],
      )
      await t.owner.query(
        `INSERT INTO payment_instruction (id, currency, version, account_fields, holder, holder_capacity, asserted_client_money, your_money_text_key, refund_days, receipt_check_note, prepared_by, approved_by)
         SELECT $1, 'GBP', coalesce(max(version), 0) + 1, '{"sort_code": "11-22-33", "account_number": "11111111"}', 'Real Holder Ltd', 'Operator', true, 'your_money', 10, 'Daily', $2, $3 FROM payment_instruction WHERE currency = 'GBP'`,
        [randomUUID(), admin.id, reviewer.id],
      )
      const ack = (await instructions(u, p)).json()
      await inject('POST', `/api/my/participations/${p}/acknowledge-account`, u, { account_sha256: ack.account_sha256 })
      const page = (await instructions(u, p)).json()
      expect(page.account.account_number).toBe('11111111')
      const token = new URL(page.verify_url, 'http://x').searchParams.get('token')!
      const asked = await app2.inject({
        method: 'POST',
        url: '/api/admin/receiving-accounts/reload',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {},
      })
      expect(asked.statusCode, asked.body).toBe(200)
      const list = await app2.inject({ method: 'GET', url: '/api/requests', headers: { cookie: admin2.cookie } })
      expect(list.body).toContain('22222222')
      expect(list.body).toContain('11111111')
      const ok = await app2.inject({
        method: 'POST',
        url: `/api/requests/${asked.json().request_id}/approve`,
        headers: { cookie: admin2.cookie, 'x-csrf-token': admin2.csrf },
        payload: {},
      })
      expect(ok.statusCode, ok.body).toBe(200)
      expect((await inject('GET', `/api/instructions/verify?token=${token}`)).json().valid).toBe(false)
      // the real mode does not wait for the mail (R23): the queue sends it just after
      await expect.poll(() => sent.some((m) => m.to === u.email && /receiving account has changed/.test(m.subject))).toBe(true)
      // the notice names the deal only by its code, and keeps the deal it is about for that deal's evidence pack
      expect(
        (await t.owner.query<{ deal_id: string | null }>("SELECT deal_id FROM notification_outbox WHERE user_id = $1 AND audience = 'urgent' AND subject LIKE '%receiving account has changed%'", [u.id])).rows,
      ).toEqual([{ deal_id: deal }])
      expect((await instructions(u, p)).json()).toMatchObject({ acknowledge: true })
    } finally {
      clock = savedClock
      await t.owner.query(
        "UPDATE instance_profile SET mode = 'sandbox', real_since = NULL, regulatory_status = NULL, accountable_person = NULL, accountable_confirmed_on = NULL, approved_by = NULL, active_pack_id = $1",
        [before],
      )
      await app2.close()
    }
  })

  it('TC-OP-05 an account file naming placeholder "your money" wording is refused', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'bulma-pay-'))
    const file = join(dir, 'payment.json')
    writeFileSync(
      file,
      JSON.stringify([
        {
          currency: 'GBP',
          account_fields: { a: '1' },
          holder: 'H',
          holder_capacity: 'O',
          holder_frn: null,
          asserted_client_money: false,
          your_money_text_key: 'your_money',
          refund_days: 1,
          receipt_check_note: 'x',
        },
      ]),
    )
    const app2 = await buildServer({ db: t.app, k: t.keyring, secureCookies: false, now: () => clock, paymentFile: file })
    await t.owner.query(
      "UPDATE instance_profile SET mode = 'real', real_since = '2000-01-01', regulatory_status = 'authorised_firm', accountable_person = 'A', accountable_confirmed_on = '2026-11-10', approved_by = $1",
      [admin.id],
    )
    try {
      const r = await app2.inject({
        method: 'POST',
        url: '/api/admin/receiving-accounts/reload',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {},
      })
      expect(r.json().error).toMatch(/final form/)
    } finally {
      await t.owner.query(
        "UPDATE instance_profile SET mode = 'sandbox', real_since = NULL, regulatory_status = NULL, accountable_person = NULL, accountable_confirmed_on = NULL, approved_by = NULL",
      )
      await app2.close()
    }
  })

  it('TC-CMP-01 / TC-PAY-06 a reviewer who invested in the deal cannot record its money, read a pause reason on it or end that pause', async () => {
    const deal = await liveDeal(lead)
    const rv = await staff(unique('revinv'), ['reviewer'])
    const link = (await links(deal)).find((l) => l.carry_bps === 2000)!
    await inject('POST', '/api/invite/accept', { ...rv, cookie: `${rv.cookie}; ${await open(tokenOf(await urlOf(deal, link.id)))}` }, {})
    await qualify(rv, `Staff ${rv.email}`)
    const e = await newEntity(rv)
    await passKyc(e)
    await commit(rv, deal, e, '1000000')
    const p = await pid(rv, deal)
    expect(
      (
        await inject('POST', `/api/review/participations/${p}/receipts`, rv, {
          amount_minor: '100',
          received_on: '2026-11-10',
          payer_name: 'Fay Fictional',
          payer_account: '1',
        })
      ).json().error,
    ).toMatch(/invest in/)
    await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'Investor secret' })
    const h = (await inject('GET', '/api/holds', rv))
      .json()
      .holds.find((x: { target_id: string; released_at: string | null }) => x.target_id === deal && !x.released_at)
    expect(h.reason).toBeNull()
    expect((await inject('POST', `/api/holds/${h.id}/release`, rv, {})).json().error).toMatch(/stake/)
    // an investment that has ended, with money still to sort out, is still a stake (Codex round 3); last, as an end is one-way
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = now() WHERE id = $1", [p])
    const ended = await inject('POST', `/api/review/participations/${p}/receipts`, rv, {
      amount_minor: '100',
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '1',
    })
    expect(ended.json().error).toMatch(/invest in/)
  })

  it('TC-ENT-01 another entity ends the invitation with the commitment; KYC running out after signing does not send it back', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    await sign(u, p)
    await t.owner.query("UPDATE kyc_case SET expires_on = '2026-01-01' WHERE entity_id = $1", [entity])
    expect((await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0].status).toBe('to_pay')
    expect((await instructions(u, p)).statusCode).toBe(200)
    await t.owner.query("UPDATE kyc_case SET expires_on = '2029-01-01' WHERE entity_id = $1", [entity])
    await inject('PUT', `/api/entities/${entity}`, u, {
      fields: { full_name: 'Fay Other', address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' },
      parties: [],
    })
    expect((await mailTo(u.email)).at(-1)!.subject).toMatch(/do not send money/i)
    expect((await inject('POST', `/api/review/participations/${p}/identity`, reviewer, { decision: 'other_entity', reason: 'A new company' })).statusCode).toBe(
      200,
    )
    expect(await count("SELECT count(*) AS n FROM deal_invitation WHERE user_id = $1 AND state = 'active'", [u.id])).toBe(0)
    expect((await inject('GET', `/api/my/deals/${deal}`, u)).statusCode).toBe(404)
  })

  it('TC-STAT-01 staff and lead see the status from the real facts; a refusal reads as with the operator', async () => {
    const deal = await liveDeal(lead)
    const email = unique('realstat')
    await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Real Stat,${email},5000` })
    const u = await person(email, await open(tokenOf(await urlOf(deal, (await links(deal)).find((l) => l.carry_bps === 2000)!.id))))
    await inject('POST', '/api/invite/accept', u, {})
    await qualify(u)
    const e = await newEntity(u)
    await commit(u, deal, e, '1000000')
    const staffView = (await inject('GET', `/api/review/deals/${deal}/participations`, reviewer)).json().participations[0]
    expect(staffView.status).toBe('verifying')
    expect((await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows[0].status).toBe('verifying')
    await t.owner.query("UPDATE participation SET outcome = 'rejected_kyc', ended_at = now() WHERE user_id = $1", [u.id])
    expect((await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows[0].status_label).toBe('With the operator')
  })

  it('TC-PIP-02 sending refuses a plan other than the one previewed', async () => {
    const deal = await liveDeal(lead)
    await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Plan Person,${unique('plan')},1` })
    const row = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows[0]
    const ls = await links(deal)
    const zero = ls.find((l) => l.carry_bps === 0)!
    const twenty = ls.find((l) => l.carry_bps === 2000)!
    // the same row twice is refused before anything is planned
    expect(
      (
        await inject('POST', `/api/deals/${deal}/pipeline/preview`, lead, {
          entries: [
            { id: row.id, link_id: zero.id },
            { id: row.id, link_id: zero.id },
          ],
        })
      ).statusCode,
    ).toBe(400)
    const prev = (await inject('POST', `/api/deals/${deal}/pipeline/preview`, lead, { entries: [{ id: row.id, link_id: zero.id }] })).json()
    expect(
      (
        await inject('POST', `/api/deals/${deal}/pipeline/invite`, lead, {
          entries: [{ id: row.id, link_id: twenty.id }],
          confirm_count: 1,
          plan_sha256: prev.plan_sha256,
        })
      ).json().error,
    ).toMatch(/changed/)
    expect(
      (
        await inject('POST', `/api/deals/${deal}/pipeline/invite`, lead, {
          entries: [{ id: row.id, link_id: zero.id }],
          confirm_count: 1,
          plan_sha256: prev.plan_sha256,
        })
      ).json().sent,
    ).toBe(1)
  })

  it('TC-FEE-11 a quote for a changed amount replaces the old commitment in the estimate', async () => {
    // a £100,000 target: replacing £60,000 with £80,000 leaves £80,000 in, under the target; counting both would be £140,000
    const deal = await liveDeal(lead, { terms: { ...draftFor('x').terms, allocation_minor: '10000000' } })
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '6000000')
    const p = await pid(u, deal)
    const fresh = (await inject('POST', `/api/my/deals/${deal}/quote`, u, { commitment_minor: '8000000', replacing: p })).json()
    const added = (await inject('POST', `/api/my/deals/${deal}/quote`, u, { commitment_minor: '8000000' })).json()
    // fee at the target is the £4,000 minimum: £4,000 × 80/100 = £3,200 against £4,000 × 80/140
    expect(fresh.expected_minor).toBe('7680000')
    expect(added.expected_minor).toBe(String(8000000n - (400000n * 8000000n * 2n + 14000000n) / (14000000n * 2n)))
  })
})

describe('the route-by-condition gate matrix (TC-GATE-02, TC-GATE-03)', () => {
  type Condition = [string, (u: Client) => Promise<void>]
  const conditions: Condition[] = [
    ['no statement', async (u) => void (await t.owner.query('DELETE FROM eligibility_statement WHERE user_id = $1', [u.id]))],
    [
      'statement expired',
      async (u) => void (await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])),
    ],
    [
      'renewed as none of these',
      async (u) => {
        await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])
        const page = (await inject('GET', '/api/eligibility', u)).json()
        expect(
          (
            await inject('POST', '/api/eligibility/statement', u, {
              answers: { category: 'neither' },
              signed_name: 'Fay Fictional',
              shown_sha256: page.shown_sha256,
            })
          ).statusCode,
        ).toBe(200)
      },
    ],
    ['assessment not passed', async (u) => void (await t.owner.query('UPDATE assessment_attempt SET passed = false WHERE user_id = $1', [u.id]))],
    ['warning block not confirmed', async (u) => void (await t.owner.query("UPDATE warning_ack SET legal_text_sha256 = 'x' WHERE user_id = $1", [u.id]))],
  ]

  it.each(conditions)(
    'TC-GATE-02 / TC-GATE-03 %s: every new step refused with no deal content; the signed document and the issued instruction still served',
    async (_name, apply) => {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      // a second entity, committed and unsigned, for the signing routes
      const second = await newEntity(u, 'Fay Second')
      await passKyc(second)
      await commit(u, deal, entity, '1000000')
      await commit(u, deal, second, '500000')
      const parts = (await inject('GET', `/api/my/deals/${deal}`, u)).json().participations as Array<{ id: string; entity: { id: string } }>
      const p = parts.find((x) => x.entity.id === entity)!.id
      const unsigned = parts.find((x) => x.entity.id === second)!.id
      await sign(u, p)
      expect((await instructions(u, p)).statusCode).toBe(200)
      // money in, so a renewal that does not qualify leaves it to the operator rather than ending it (R-ELG-03)
      await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
        amount_minor: '100',
        received_on: '2026-11-10',
        payer_name: 'Fay Fictional',
        payer_account: '1',
      })
      const sheet = (await inject('GET', `/api/my/participations/${unsigned}/deal-sheet`, u)).json()
      await apply(u)
      const refused: Array<[string, string, unknown]> = [
        ['GET', `/api/my/deals/${deal}`, undefined],
        ['POST', `/api/my/deals/${deal}/quote`, { commitment_minor: '1000000' }],
        ['POST', `/api/my/deals/${deal}/commit`, { entity_id: entity, commitment_minor: '1000000', quoted_due_minor: '1000000', terms_link_id: randomUUID() }],
        ['GET', `/api/my/participations/${unsigned}/deal-sheet`, undefined],
        [
          'POST',
          `/api/my/participations/${unsigned}/sign`,
          { agree: true, signed_name: 'Fay Fictional', document_sha256: sheet.document_sha256 ?? 'a'.repeat(64) },
        ],
        ['GET', `/api/my/participations/${unsigned}/instructions`, undefined],
      ]
      for (const [m, url, body] of refused) {
        const r = await inject(m, url, u, body)
        expect([404, 409], `${m} ${url}`).toContain(r.statusCode)
        expect(holdsNoSeed(r.body), `${m} ${url}`).toBe(true)
      }
      expect((await inject('GET', '/api/my/deals', u)).json().deals[0]).toMatchObject({ visible: false, name: null, company: null })
      // the narrow exceptions (§5.5)
      expect((await inject('GET', `/api/my/participations/${p}/signed`, u)).statusCode).toBe(200)
      const kept = await instructions(u, p)
      expect(kept.statusCode).toBe(200)
      expect(kept.json().warning.text).toMatch(/PLACEHOLDER/)
      const pdf = await inject('GET', `/api/my/participations/${p}/instructions.pdf`, u)
      expect((await pdfText(pdf.rawPayload)).join(' ')).toContain('PLACEHOLDER')
    },
  )
})

describe('fixes from Codex round 3', () => {
  it('TC-CMP-03 a link whose terms the switches no longer allow is given to nobody new', async () => {
    const deal = await liveDeal(lead)
    const fee = (
      await inject('POST', `/api/deals/${deal}/links`, lead, {
        kind: 'terms_only',
        carry_bps: 0,
        fee: { kind: 'percent', bps: 400, mode: 'on_top' },
        reason: 'x',
        confirm: true,
      })
    ).json().id
    const first = unique('termsonly')
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: first, link_id: fee })).statusCode).toBe(200)
    // the first person accepts, so the link stays on for them when the switch is tightened
    const token = /token=([\w-]+)/.exec((await mailTo(first))[0]!.body)![1]!
    const bound = await person(first, await open(token))
    expect((await inject('POST', '/api/invite/accept', bound, {})).json().results[0].result).toBe('invited')
    const pol = (await inject('GET', '/api/admin/policy', admin)).json()
    await inject('PUT', '/api/admin/policy', admin, { ...pol, version: undefined, per_link_terms: false })
    try {
      expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: unique('second'), link_id: fee })).json().error).toMatch(/current settings/)
    } finally {
      const asked = await inject('PUT', '/api/admin/policy', admin, { ...pol, version: undefined, per_link_terms: true })
      if (asked.json().requestId) await inject('POST', `/api/requests/${asked.json().requestId}/approve`, admin, {})
    }
  })

  it('TC-LNK-10 a pending invitation survives a refusal for now, and is accepted after the pause ends', async () => {
    const deal = await liveDeal(lead)
    const cookie = await open(tokenOf(await urlOf(deal, (await links(deal)).find((l) => l.carry_bps === 2000)!.id)))
    await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'Wait' })
    const u = await person(unique('waits'), cookie)
    expect((await inject('POST', '/api/invite/accept', u, {})).json().results[0].result).toBe('held')
    const h = (await inject('GET', '/api/holds', reviewer2))
      .json()
      .holds.find((x: { target_id: string; released_at: string | null }) => x.target_id === deal && !x.released_at)
    await inject('POST', `/api/holds/${h.id}/release`, reviewer2, {})
    expect((await inject('POST', '/api/invite/accept', u, {})).json().results[0].result).toBe('invited')
  })

  it('TC-LNK-07 an invitation that was replaced cannot be resent again', async () => {
    const deal = await liveDeal(lead)
    const link = (await links(deal)).find((l) => l.carry_bps === 2000)!
    const first = (await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: unique('resend'), link_id: link.id })).json().id
    expect((await inject('POST', `/api/deals/${deal}/targeted/${first}/resend`, lead, {})).statusCode).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/targeted/${first}/resend`, lead, {})).json().error).toMatch(/replaced already/)
  })

  it('TC-ELG-03 a renewal as none of these ends unpaid commitments and voids their instructions, with a mail', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    await sign(u, p)
    const page = (await instructions(u, p)).json()
    await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])
    const e = (await inject('GET', '/api/eligibility', u)).json()
    await inject('POST', '/api/eligibility/statement', u, { answers: { category: 'neither' }, signed_name: 'Fay Fictional', shown_sha256: e.shown_sha256 })
    expect((await t.owner.query('SELECT outcome FROM participation WHERE id = $1', [p])).rows[0].outcome).toBe('withdrawn')
    expect((await inject('GET', `/api/instructions/verify?token=${new URL(page.verify_url, 'http://x').searchParams.get('token')}`)).json().valid).toBe(false)
    expect((await mailTo(u.email)).at(-1)!.subject).toMatch(/do not send money/i)
    // the app role cannot make the old issue valid again, nor change why it was voided
    await expect(t.app.query('UPDATE issued_instruction SET voided_at = NULL, void_reason = NULL WHERE participation_id = $1', [p])).rejects.toThrow(/stays void/)
    await expect(t.app.query("UPDATE issued_instruction SET void_reason = 'other' WHERE participation_id = $1", [p])).rejects.toThrow(/stays void/)
  })

  it('TC-LNK-07 / TC-LNK-05 / TC-CMP-01 every end is one-way: the app role cannot revive an invitation, invite, link, commitment, release or removal (Codex round 9)', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    const link = (await links(deal)).find((l) => l.carry_bps === 2000)!
    const ti = (await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: unique('oneway'), link_id: link.id })).json().id
    await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Ann\t${unique('pipe')}\t10000\tdefault\n` })
    const hold = randomUUID()
    await t.owner.query("INSERT INTO compliance_hold (id, level, target_id, reason, applied_by) VALUES ($1, 'deal', $2, 'r', $3)", [hold, deal, lead.id])
    // each ended the way the app ends it: set once
    await t.owner.query('UPDATE targeted_invite SET consumed_at = now(), consumed_by = $2, revoked_at = now() WHERE id = $1', [ti, u.id])
    await t.owner.query("UPDATE deal_invitation SET state = 'passed', ended_at = now(), second_link_seen_at = now() WHERE deal_id = $1", [deal])
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = now() WHERE id = $1", [p])
    await t.owner.query("UPDATE invite_link SET disabled_at = now(), disabled_reason = 'lead', terms_approved_at = now(), terms_approved_by = $2 WHERE id = $1", [link.id, reviewer.id])
    await t.owner.query('UPDATE compliance_hold SET released_at = now(), released_by = $2 WHERE id = $1', [hold, reviewer.id])
    await t.owner.query('UPDATE pipeline_entry SET removed_at = now() WHERE deal_id = $1', [deal])
    const refused: Array<[string, unknown[], RegExp]> = [
      ['UPDATE targeted_invite SET consumed_at = NULL, consumed_by = NULL WHERE id = $1', [ti], /stays used/],
      ['UPDATE targeted_invite SET consumed_by = $2 WHERE id = $1', [ti, lead.id], /stays used/],
      ['UPDATE targeted_invite SET revoked_at = NULL WHERE id = $1', [ti], /stays revoked/],
      ["UPDATE deal_invitation SET state = 'active', ended_at = NULL WHERE deal_id = $1", [deal], /stays ended/],
      ["UPDATE deal_invitation SET state = 'revoked' WHERE deal_id = $1", [deal], /stays ended/],
      ['UPDATE deal_invitation SET second_link_seen_at = NULL WHERE deal_id = $1', [deal], /stays seen/],
      ["UPDATE participation SET outcome = 'active', ended_at = NULL WHERE id = $1", [p], /stays ended/],
      ['UPDATE invite_link SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1', [link.id], /stays disabled/],
      ['UPDATE invite_link SET terms_approved_by = $2 WHERE id = $1', [link.id, lead.id], /stays as given/],
      ['UPDATE compliance_hold SET released_at = NULL, released_by = NULL WHERE id = $1', [hold], /stays as recorded/],
      ['UPDATE compliance_hold SET single_admin_exception = true WHERE id = $1', [hold], /stays as recorded/],
      ['UPDATE pipeline_entry SET removed_at = NULL WHERE deal_id = $1', [deal], /stays removed/],
    ]
    for (const [sql, args, err] of refused) await expect(t.app.query(sql, args), sql).rejects.toThrow(err)
    // what is not an end still changes
    await t.app.query('UPDATE targeted_invite SET sent_count = sent_count + 1 WHERE id = $1', [ti])
  })

  it('TC-ELG-03 a statement under another regime that does not qualify leaves a commitment under this regime alone', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    await sign(u, p)
    const page = (await instructions(u, p)).json()
    const fpo = (await t.owner.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile')).rows[0]!.active_pack_id
    const cobs = (await t.owner.query<{ id: string }>("SELECT id FROM regime_pack WHERE key = 'uk-cobs-template' ORDER BY version DESC LIMIT 1")).rows[0]!.id
    await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [cobs])
    try {
      await inject('POST', '/api/eligibility/request', u, {})
      let e = (await inject('GET', '/api/eligibility', u)).json()
      expect(e.next).toBe('personalised_warning')
      await inject('POST', '/api/eligibility/warning', u, { kind: 'personalised_warning', decision: 'continue', shown_sha256: e.shown_sha256 })
      e = (await inject('GET', '/api/eligibility', u)).json()
      expect(e.next).toBe('classification')
      const r = await inject('POST', '/api/eligibility/statement', u, { answers: { category: 'neither' }, signed_name: 'Fay Fictional', shown_sha256: e.shown_sha256 })
      expect(r.json().qualifies).toBe(false)
    } finally {
      await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [fpo])
    }
    expect((await t.owner.query('SELECT outcome FROM participation WHERE id = $1', [p])).rows[0].outcome).toBe('active')
    expect((await inject('GET', `/api/instructions/verify?token=${new URL(page.verify_url, 'http://x').searchParams.get('token')}`)).json().valid).toBe(true)
  })

  it('TC-SIG-04 a recorded deed is kept with a hash of exactly what is kept', async () => {
    await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Deed for {investor_name}: {breakdown}', needs_deed: true })
    try {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).statusCode).toBe(200)
      const r = (
        await t.owner.query<{ document: string; document_sha256: string }>(
          'SELECT document, document_sha256 FROM signature_record WHERE participation_id = $1',
          [p],
        )
      ).rows[0]!
      const { createHash } = await import('node:crypto')
      expect(createHash('sha256').update(r.document, 'utf8').digest('hex')).toBe(r.document_sha256)
    } finally {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {breakdown}, reference {reference}.',
        needs_deed: false,
      })
    }
  })
})

describe('fixes from Codex round 4', () => {
  /** A new version of the active pack with its own warning wording, made active; returns a function to switch back. */
  async function packWithNewWarning(extra = ' Second wording.'): Promise<{ id: string; restore: () => Promise<void> }> {
    const { insertPack } = await import('../store/packs.ts')
    const before = (await t.owner.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile')).rows[0]!.active_pack_id
    const content = (
      await t.owner.query<{ content: { version: number; legal_texts: Array<{ text_key: string; body: string }> } & Record<string, unknown> }>(
        'SELECT content FROM regime_pack WHERE id = $1',
        [before],
      )
    ).rows[0]!.content
    const next = {
      ...content,
      version: content.version + 100 + n,
      legal_texts: content.legal_texts.map((x) => (x.text_key === 'promotion_warning' ? { ...x, body: `${x.body}${extra}` } : x)),
    }
    const id = await tx(t.app, (c) => insertPack(c, next as never, { builtIn: false, by: null }))
    await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [id])
    return { id, restore: async () => void (await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [before])) }
  }

  it('TC-PAGE-05 two deals whose warnings are worded differently: the list names neither company', async () => {
    const first = await liveDeal(lead)
    const { u } = await investor(first)
    const v2 = await packWithNewWarning()
    try {
      const second = await liveDeal(lead)
      await inject('POST', '/api/invite/accept', { ...u, cookie: `${u.cookie}; ${await open(tokenOf(await urlOf(second, (await links(second))[0]!.id)))}` }, {})
      // the new wording is confirmed too, so the person is qualified for both
      const w = (await inject('GET', '/api/eligibility', u)).json()
      expect(
        (await inject('POST', '/api/eligibility/warning', u, { kind: 'warning_block', decision: 'continue', shown_sha256: w.shown_sha256 })).statusCode,
      ).toBe(200)
      const list = (await inject('GET', '/api/my/deals', u)).json()
      expect(list.warning).toBeNull()
      expect(list.deals.every((d: { name: string | null; company: string | null }) => d.name === null && d.company === null)).toBe(true)
    } finally {
      await v2.restore()
    }
  })

  it('TC-SIG-02 a long warning and a sheet near its own limit: refused before signing, so every signed sheet downloads (Codex round 11)', async () => {
    const v2 = await packWithNewWarning(` ${'w'.repeat(110_000)}`)
    try {
      const terms = 'Investors attend the dinner. '.repeat(500)
      const custom = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: terms }] }] }
      const deal = await liveDeal(lead, { terms: { ...draftFor('x').terms, custom_terms: custom } })
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      // about 392,000 characters of sheet: inside the sheet limit, but not with a 110,000-character warning in front
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: `Sheet for {investor_name}. ${'{custom_terms} '.repeat(27)}`, needs_deed: false })
      try {
        const res = await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)
        // the sheet alone fits, so the message names the warning as well (owner 2026-11-11)
        expect(res.json().error).toMatch(/not together with the warning/)
        expect(res.json().error).toMatch(/warning texts in the regime pack/)
        // the lead's preview has no warning in front, so it is still shown
        expect((await inject('GET', `/api/deals/${deal}/deal-sheet-preview`, lead)).json().body).toContain('Sheet for')
      } finally {
        await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
          body: 'Deal sheet for {investor_name}: {amount_to_pay}, reference {reference}.',
          needs_deed: false,
        })
      }
      // the same deal with the usual template is offered as before
      expect((await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json().document).toContain('Deal sheet for')
    } finally {
      await v2.restore()
    }
  })

  it('TC-AUTHZ-01 staff with a stake in a deal see no money roster for it', async () => {
    const deal = await liveDeal(lead)
    const member = await staff(unique('rosterrev'), ['reviewer'])
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, member.id])
    expect((await inject('GET', `/api/review/deals/${deal}/participations`, member)).json().error).toMatch(/cannot see/)
    expect((await inject('GET', `/api/review/deals/${deal}/participations`, reviewer)).statusCode).toBe(200)
  })

  it('TC-LNK-07 a targeted invitation is used up even when the person was already invited', async () => {
    const deal = await liveDeal(lead)
    const { u } = await investor(deal)
    // a second set of terms the current settings allow: the default carry, kept for invitations sent to an address
    const other = (
      await inject('POST', `/api/deals/${deal}/links`, lead, { kind: 'terms_only', label: 'second', carry_bps: 2000, fee: { kind: 'none' }, confirm: true })
    ).json().id
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: u.email, link_id: other })).statusCode).toBe(200)
    const token = /token=([\w-]+)/.exec((await mailTo(u.email)).at(-1)!.body)![1]!
    const again = { ...u, cookie: `${u.cookie}; ${await open(token)}` }
    expect((await inject('POST', '/api/invite/accept', again, {})).json().results[0].result).toBe('already_invited')
    expect((await inject('POST', '/api/invite/open', undefined, { token })).statusCode).toBe(404)
  })
})

describe('fixes from Codex round 5', () => {
  it('TC-PAGE-01 / TC-SIG-02 a convertible’s cap and discount are on the page, and approved custom terms are on the page and in the signed sheet', async () => {
    const custom = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Investors attend the annual dinner.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Payment is due in' }, { type: 'hard_break' }, { type: 'text', text: '30 days.' }] },
      ],
    }
    const deal = await liveDeal(lead, {
      terms: {
        ...draftFor('x').terms,
        instrument: 'safe',
        share_price_micros: undefined,
        pre_money_minor: undefined,
        cap_type: 'pre_money',
        cap_minor: '500000000',
        discount_bps: 2000,
        custom_terms: custom,
      },
    })
    const { u, entity } = await investor(deal)
    const k = (await inject('GET', `/api/my/deals/${deal}`, u)).json().key_terms
    expect(k).toMatchObject({ cap_type: 'pre_money', cap_minor: '500000000', discount_bps: 2000 })
    expect(JSON.stringify(k.custom_terms)).toContain('annual dinner')
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    const sheet = (await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)).json()
    expect(sheet.document).toContain('Custom terms of this deal:\nInvestors attend the annual dinner.')
    await sign(u, p)
    const doc = (await t.owner.query<{ document: string }>('SELECT document FROM signature_record WHERE participation_id = $1', [p])).rows[0]!.document
    expect(doc).toContain('annual dinner')
    // a line break typed in the terms is kept in what is signed
    expect(sheet.document).toContain('Payment is due in\n30 days.')
    expect(doc).toContain('Payment is due in\n30 days.')
  })

  it('TC-SIG-02 a template naming the custom terms many times is refused once filled in past the limit, before any PDF (Codex round 9)', async () => {
    const long = 'Investors attend the dinner. '.repeat(600)
    const custom = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: long }] }] }
    const deal = await liveDeal(lead, { terms: { ...draftFor('x').terms, custom_terms: custom } })
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: `Sheet for {investor_name}. ${'{custom_terms} '.repeat(30)}`, needs_deed: false })
    try {
      const res = await inject('GET', `/api/my/participations/${p}/deal-sheet`, u)
      expect(res.json().error).toMatch(/too long once filled in/)
      expect((await inject('GET', `/api/deals/${deal}/deal-sheet-preview`, lead)).json().error).toMatch(/too long once filled in/)
    } finally {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {amount_to_pay}, reference {reference}.',
        needs_deed: false,
      })
    }
  })

  it('TC-SIG-04 a deed cannot be sent for a sandbox deal stopped at the switch (R25)', async () => {
    await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Deed for {investor_name}: {breakdown}', needs_deed: true })
    try {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      // the deal went live before the switch: it is stopped for good
      await t.owner.query("UPDATE deal SET went_live_at = now() - interval '1 day' WHERE id = $1", [deal])
      await t.owner.query("UPDATE instance_profile SET real_since = now() - interval '1 hour'")
      try {
        expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).json().error).toMatch(/Nothing new/)
      } finally {
        await t.owner.query('UPDATE instance_profile SET real_since = NULL')
      }
    } finally {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {breakdown}, reference {reference}.',
        needs_deed: false,
      })
    }
  })

  it('TC-LNK-10 registering again on an unconfirmed address keeps the invitation opened this time', async () => {
    const deal = await liveDeal(lead)
    const email = unique('again')
    // first registration, with no invitation, never confirmed
    expect((await inject('POST', '/api/register', undefined, { first_name: 'Fay', last_name: 'Fictional', email, password: PW })).statusCode).toBe(200)
    const cookie = await open(tokenOf(await urlOf(deal, (await links(deal))[0]!.id)))
    const r = await inject('POST', '/api/register', undefined, { first_name: 'Fay', last_name: 'Fictional', email, password: PW }, cookie)
    const token = new URL(r.json().sandbox_link, 'http://x').searchParams.get('token')!
    expect((await inject('POST', '/api/verify-email', undefined, { token, password: PW })).statusCode).toBe(200)
    // signed in elsewhere, with no cookie: the invitation is still there
    const u = await login(email)
    expect((await inject('POST', '/api/invite/accept', u, {})).json().results[0].result).toBe('invited')
  })

  it('TC-GATE-01 / TC-ELG-05 the invitation page carries the pack’s preparation, with no deal content', async () => {
    const deal = await liveDeal(lead)
    const r = await inject('POST', '/api/invite/open', undefined, { token: tokenOf(await urlOf(deal, (await links(deal))[0]!.id)) })
    expect(r.json().preparation).toMatchObject({
      steps: expect.any(Number),
      individual: expect.stringMatching(/PLACEHOLDER/),
      company: expect.stringMatching(/PLACEHOLDER/),
    })
    expect(holdsNoSeed(r.body)).toBe(true)
  })
})

describe('fixes from Codex round 6', () => {
  const deedTemplate = (body: string) => inject('PUT', '/api/admin/templates/deal-sheet', admin, { body, needs_deed: true })
  const resetTemplate = () =>
    inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Deal sheet for {investor_name}: {breakdown}, reference {reference}.', needs_deed: false })

  it('TC-SIG-04 / TC-SIG-06 a deed sent and not yet signed is not a signed document; once recorded it is, and it is never replaced', async () => {
    await deedTemplate('Deed for {investor_name}: {breakdown}')
    try {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      // the investor holds no signed document yet, and the list does not say so
      expect((await inject('GET', `/api/my/participations/${p}/signed`, u)).json().error).toMatch(/Not found/)
      const listed = (await inject('GET', '/api/my/participations', u)).json().participations.find((x: { id: string }) => x.id === p)
      expect(listed.signed).toBe(false)
      // the reviewer can download exactly what was saved, to send it out
      const sent = await inject('GET', `/api/review/participations/${p}/deed`, reviewer)
      expect(sent.statusCode).toBe(200)
      expect(sent.headers['content-type']).toMatch(/pdf/)
      const roster = (await inject('GET', `/api/review/deals/${deal}/participations`, reviewer)).json().participations
      expect(roster.find((x: { id: string }) => x.id === p).deed_status).toBe('sent')
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).statusCode).toBe(200)
      expect((await inject('GET', `/api/my/participations/${p}/signed`, u)).statusCode).toBe(200)
      const rec = (
        await t.owner.query<{ signed_name: string }>('SELECT signed_name FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL', [p])
      ).rows[0]!
      expect(rec.signed_name).toMatch(/^Signed outside this site; recorded by /)
      // an executed deed is not replaced by sending another
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).json().error).toMatch(/already signed/)
      expect((await inject('GET', `/api/my/participations/${p}/signed`, u)).statusCode).toBe(200)
    } finally {
      await resetTemplate()
    }
  })

  it('TC-SIG-04 a dated deed sent one day is recorded on the next, against the date it carried', async () => {
    await deedTemplate('Deed for {investor_name} dated {date}: {breakdown}')
    const saved = clock
    try {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      const day = clock.toISOString().slice(0, 10)
      clock = new Date(clock.getTime() + 24 * 3600_000)
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).statusCode).toBe(200)
      const doc = (
        await t.owner.query<{ document: string }>('SELECT document FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL', [p])
      ).rows[0]!.document
      expect(doc).toContain(`dated ${day}`)
    } finally {
      clock = saved
      await resetTemplate()
    }
  })

  it('TC-ENT-01 a deed only sent is not signed: when the entity changes the participation follows it, and the old deed cannot be recorded', async () => {
    await deedTemplate('Deed for {entity_name}: {breakdown}')
    try {
      const deal = await liveDeal(lead)
      const { u, entity } = await investor(deal)
      await commit(u, deal, entity, '1000000')
      const p = await pid(u, deal)
      expect((await inject('POST', `/api/review/participations/${p}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      const r = await inject('PUT', `/api/entities/${entity}`, u, {
        fields: { full_name: 'Fay Renamed', address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' },
        parties: [],
      })
      expect(r.statusCode, r.body).toBe(200)
      expect((await t.owner.query('SELECT identity_review FROM participation WHERE id = $1', [p])).rows[0].identity_review).not.toBe('pending')
      // it follows the entity's new version, as an unsigned participation does
      const v = (
        await t.owner.query<{ pv: number; ev: number }>(
          'SELECT p.entity_version AS pv, e.current_version AS ev FROM participation p JOIN legal_entity e ON e.id = p.entity_id WHERE p.id = $1',
          [p],
        )
      ).rows[0]!
      expect(v.pv).toBe(v.ev)
      expect((await inject('POST', `/api/review/participations/${p}/deed-signed`, reviewer, {})).json().error).toMatch(/no longer current|identity/)
    } finally {
      await resetTemplate()
    }
  })

  it('TC-PIP-01 reviewers and admins read the expected-investor list, and cannot change it', async () => {
    const deal = await liveDeal(lead)
    await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Ann Staff,${unique('staffread')},10000` })
    for (const who of [reviewer, admin]) {
      const r = await inject('GET', `/api/deals/${deal}/pipeline`, who)
      expect(r.statusCode, r.body).toBe(200)
      expect(r.json().rows.map((x: { name: string }) => x.name)).toContain('Ann Staff')
      expect((await inject('POST', `/api/deals/${deal}/pipeline`, who, { text: `Bo Staff,${unique('staffwrite')},1` })).statusCode).not.toBe(200)
    }
  })

  it('TC-PIP-03 an invitation sent to a mistyped address is sent again to the right one; the old token stops and the row follows', async () => {
    const deal = await liveDeal(lead)
    const wrong = unique('typo')
    const right = unique('fixed')
    await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Cy Typo,${wrong},10000` })
    const row = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows.find((x: { name: string }) => x.name === 'Cy Typo')
    const link = (await links(deal))[0]!
    const entries = [{ id: row.id, link_id: link.id }]
    const plan = (await inject('POST', `/api/deals/${deal}/pipeline/preview`, lead, { entries })).json()
    expect((await inject('POST', `/api/deals/${deal}/pipeline/invite`, lead, { entries, confirm_count: 1, plan_sha256: plan.plan_sha256 })).json().sent).toBe(1)
    const first = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows.find((x: { id: string }) => x.id === row.id).targeted_invite
    expect((await inject('POST', `/api/deals/${deal}/targeted/${first}/resend`, lead, { email: right })).statusCode).toBe(200)
    const after = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows.find((x: { id: string }) => x.id === row.id)
    expect(after.email).toBe(right)
    expect(after.targeted_invite).not.toBe(first)
    expect((await t.owner.query('SELECT revoked_at FROM targeted_invite WHERE id = $1', [first])).rows[0].revoked_at).not.toBeNull()
    const token = /token=([\w-]+)/.exec((await mailTo(right))[0]!.body)![1]!
    const cy = await person(right, await open(token))
    expect((await inject('POST', '/api/invite/accept', cy, {})).json().results[0].result).toBe('invited')
  })

  it('TC-GATE-01 the invitation page’s overview is filled in, never shown with its slots', async () => {
    const deal = await liveDeal(lead)
    const r = await inject('POST', '/api/invite/open', undefined, { token: tokenOf(await urlOf(deal, (await links(deal))[0]!.id)) })
    const prep = r.json().preparation
    expect(prep.overview).toContain(`${prep.steps} steps in all`)
    expect(prep.overview).not.toMatch(/[{}]/)
  })
})

describe('fixes from Codex round 7', () => {
  it('TC-SIG-03 signature evidence cannot be rewritten by the application, except recording a sent deed once', async () => {
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    await commit(u, deal, entity, '1000000')
    const p = await pid(u, deal)
    await sign(u, p)
    const id = (await t.owner.query<{ id: string }>('SELECT id FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL', [p])).rows[0]!.id
    await expect(t.app.query("UPDATE signature_record SET signed_name = 'Someone else' WHERE id = $1", [id])).rejects.toThrow(/cannot change/)
    await expect(t.app.query("UPDATE signature_record SET signed_at = now() - interval '1 year' WHERE id = $1", [id])).rejects.toThrow(/cannot change/)
    await expect(t.app.query("UPDATE signature_record SET external_status = 'signed' WHERE id = $1", [id])).rejects.toThrow(/cannot change/)
    await t.app.query('UPDATE signature_record SET superseded_at = now() WHERE id = $1', [id])
    await expect(t.app.query('UPDATE signature_record SET superseded_at = NULL WHERE id = $1', [id])).rejects.toThrow(/stays superseded/)
    // a deed recorded as signed does not go back to sent
    await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Deed for {investor_name}: {breakdown}', needs_deed: true })
    try {
      const d2 = await liveDeal(lead)
      const x = await investor(d2)
      await commit(x.u, d2, x.entity, '1000000')
      const q = await pid(x.u, d2)
      expect((await inject('POST', `/api/review/participations/${q}/deed-sent`, reviewer, {})).statusCode).toBe(200)
      expect((await inject('POST', `/api/review/participations/${q}/deed-signed`, reviewer, {})).statusCode).toBe(200)
      const deed = (await t.owner.query<{ id: string }>('SELECT id FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL', [q])).rows[0]!
        .id
      await expect(t.app.query("UPDATE signature_record SET external_status = 'sent' WHERE id = $1", [deed])).rejects.toThrow(/cannot change/)
      await expect(t.app.query("UPDATE signature_record SET signed_name = 'Again' WHERE id = $1", [deed])).rejects.toThrow(/cannot change/)
    } finally {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {breakdown}, reference {reference}.',
        needs_deed: false,
      })
    }
  })

  it('TC-LNK-08 opening a link is limited per address and per token, and the same browser reuses what it holds', async () => {
    const deal = await liveDeal(lead)
    const token = tokenOf(await urlOf(deal, (await links(deal))[0]!.id))
    const from = (ip: string, cookie?: string) =>
      app.inject({ method: 'POST', url: '/api/invite/open', remoteAddress: ip, headers: cookie ? { cookie } : {}, payload: { token } })
    // the same browser opening again: one pending row, not one per click
    const first = await from(nextIp())
    const cookie = `bulma_invite=${first.cookies.find((c) => c.name === 'bulma_invite')!.value}`
    const rows = async () => Number((await t.owner.query('SELECT count(*) AS n FROM pending_invite')).rows[0].n)
    const before = await rows()
    for (let i = 0; i < 3; i++) expect((await from(nextIp(), cookie)).statusCode).toBe(200)
    expect(await rows()).toBe(before)
    // one address: refused past its limit, and nothing stored for the refused ones
    const ip = nextIp()
    for (let i = 0; i < 30; i++) expect((await from(ip, cookie)).statusCode).toBe(200)
    const refused = await from(ip)
    expect(refused.statusCode).toBe(429)
    expect(await rows()).toBe(before)
    // one token, from many addresses: refused past its own limit
    let last = 200
    for (let i = 0; i < 300 && last === 200; i++) last = (await from(nextIp(), cookie)).statusCode
    expect(last).toBe(429)
  })

  it('TC-PAGE-01 an approved deck embed is on the investor page while its site is allowed, and frames are allowed from those sites only', async () => {
    const { frameAllowing, CSP } = await import('./app.ts')
    expect(frameAllowing([])).toBe(CSP)
    expect(frameAllowing(['decks.example.test'])).toBe(`${CSP}; frame-src https://decks.example.test`)
    expect(frameAllowing(["x.test; script-src 'unsafe-inline'"])).toBe(CSP)
    const saved = (await t.owner.query<{ h: string[] }>('SELECT embed_hosts AS h FROM deal_config WHERE id = 1')).rows[0]!.h
    await t.owner.query("UPDATE deal_config SET embed_hosts = ARRAY['decks.example.test']")
    try {
      const deal = await liveDeal(lead, {
        files: { deck: { kind: 'link', url: 'https://decks.example.test/view/1', embed_url: 'https://decks.example.test/embed/1' } },
      })
      const { u } = await investor(deal)
      expect((await inject('GET', `/api/my/deals/${deal}`, u)).json().deck).toMatchObject({ embed_url: 'https://decks.example.test/embed/1' })
      // the operator stops allowing the site: the page no longer frames it, the plain link stays
      await t.owner.query('UPDATE deal_config SET embed_hosts = ARRAY[]::text[]')
      expect((await inject('GET', `/api/my/deals/${deal}`, u)).json().deck).toMatchObject({ embed_url: null, url: 'https://decks.example.test/view/1' })
    } finally {
      await t.owner.query('UPDATE deal_config SET embed_hosts = $1', [saved])
    }
  })

  it('TC-SIG-02 the lead previews the default deal sheet: the deal’s values and default terms, investor details left blank', async () => {
    const deal = await liveDeal(lead)
    const r = await inject('GET', `/api/deals/${deal}/deal-sheet-preview`, lead)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().body).toContain('Deal sheet for [investor name]')
    expect(r.json().body).not.toMatch(/[{}]/)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'deal_sheet.previewed' AND entity_id = $1", [deal])).toBeGreaterThan(0)
    expect(await count('SELECT count(*) AS n FROM participation WHERE deal_id = $1', [deal])).toBe(0)
    // nobody else on the deal: refused as not found
    const { u } = await investor(deal)
    expect((await inject('GET', `/api/deals/${deal}/deal-sheet-preview`, u)).json().error).toMatch(/not found/i)
  })

  it('TC-SIG-02 the preview shows the deal’s default carry, not the no-carry link launch also makes', async () => {
    // launch makes the no-carry link only while different terms per link are allowed; an earlier test may have turned that off
    const copy = (perLink: string) =>
      t.owner.query(
        `INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count)
         SELECT version + 1, ${perLink}, generic_links, bulk_promo, export_roles, reminder_count FROM operator_policy ORDER BY version DESC LIMIT 1`,
      )
    const was = (await t.owner.query<{ p: boolean }>('SELECT per_link_terms AS p FROM operator_policy ORDER BY version DESC LIMIT 1')).rows[0]!.p
    await copy('true')
    const deal = await liveDeal(lead)
    await copy(String(was))
    const defaults = (await links(deal)).filter((l) => l.is_default).map((l) => l.carry_bps)
    expect(defaults.sort()).toEqual([0, 2000])
    await inject('PUT', '/api/admin/templates/deal-sheet', admin, { body: 'Deal sheet: carry {carry}; fees {fee_terms}.', needs_deed: false })
    try {
      const body = (await inject('GET', `/api/deals/${deal}/deal-sheet-preview`, lead)).json().body
      expect(body).toContain('carry 20.00%')
      expect(body).toContain('fees No fee')
    } finally {
      await inject('PUT', '/api/admin/templates/deal-sheet', admin, {
        body: 'Deal sheet for {investor_name}: {breakdown}, reference {reference}.',
        needs_deed: false,
      })
    }
  })
})


describe('D4 durable mail queue (R23, R-NTF-02)', () => {
  // far ahead of the shared clock, so the sends after other requests leave these rows alone
  let ahead = new Date(clock.getTime() + 400 * 86_400_000)
  const later = () => (ahead = new Date(ahead.getTime() + 86_400_000))
  type Sent = { to: string; subject: string; body: string }
  const worker = (at: Date, send: (m: Sent) => Promise<unknown> = async () => undefined): OutboxDeps & { sent: Sent[] } => {
    const sent: Sent[] = []
    return {
      db: t.app,
      k: t.keyring,
      now: () => at,
      sent,
      mailer: async () => ({ send: async (m: Sent) => (await send(m), sent.push(m), { delivered: false }) }),
    }
  }
  const queued = (at: Date, m: QueuedMail) => tx(t.app, (c) => enqueue(c, t.keyring, at, m))
  const row = async (id: string) =>
    (
      await t.owner.query<{ status: string; cancel_reason: string | null; attempts: number; last_error: string | null; body_sealed: Buffer | null; next_attempt_at: Date; to_address: string }>(
        'SELECT status, cancel_reason, attempts, last_error, body_sealed, next_attempt_at, to_address FROM notification_outbox WHERE id = $1',
        [id],
      )
    ).rows[0]!
  const audited = async (id: string, action: string) => count('SELECT count(*) AS n FROM audit WHERE entity_id = $1 AND action = $2', [id, action])

  it('TC-NTF-02 a mail is written with its change: a refused change leaves none, a done one is sent and keeps no body', async () => {
    const deal = await liveDeal(lead)
    const link = (await links(deal))[0]!
    const email = unique('queued')
    const rows = () => count('SELECT count(*) AS n FROM notification_outbox WHERE lower(to_address) = lower($1)', [email])
    // refused inside the transaction (a link that is not this deal's): nothing queued
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email, link_id: randomUUID() })).statusCode).toBe(409)
    expect(await rows()).toBe(0)
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email, link_id: link.id })).statusCode).toBe(200)
    const r = (await t.owner.query<{ id: string; audience: string }>('SELECT id, audience FROM notification_outbox WHERE lower(to_address) = lower($1)', [email])).rows[0]!
    // decided again at every attempt as an invitation, not as a bare address
    expect(r.audience).toBe('invite')
    const done = await row(r.id)
    expect([done.status, done.attempts, done.body_sealed]).toEqual(['sent', 1, null])
    expect((await mailTo(email)).length).toBe(1)
  })

  it('TC-NTF-02 the body waits sealed: the sign-in link in it is not readable in the table', async () => {
    const at = later()
    const id = await queued(at, { audience: { kind: 'address' }, to: unique('sealed'), subject: 'Choose a new password', body: 'Choose a new password: /reset-password?token=SECRET-TOKEN-123' })
    const r = await row(id)
    expect(r.status).toBe('queued')
    expect(r.body_sealed!.toString('latin1')).not.toContain('SECRET-TOKEN-123')
    const w = worker(at)
    await drain(w)
    expect(w.sent.find((m) => m.subject === 'Choose a new password')!.body).toContain('SECRET-TOKEN-123')
    expect((await row(id)).body_sealed).toBeNull()
  })

  it('TC-NTF-02 decided again at the send: an invitation withdrawn or a deal paused after queueing is not sent, and why is kept', async () => {
    const deal = await liveDeal(lead)
    const link = (await links(deal))[0]!
    const email = unique('withdrawn')
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email, link_id: link.id })).statusCode).toBe(200)
    const invite = (await t.owner.query<{ id: string }>('SELECT id FROM targeted_invite WHERE lower(email) = lower($1)', [email])).rows[0]!.id
    const at = later()
    const m: QueuedMail = { audience: { kind: 'invite', inviteId: invite, dealId: deal }, to: email, subject: 'Invitation again', body: 'no content' }
    // paused after it was queued
    const paused = await queued(at, m)
    const hold = await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'Checking' })
    expect(hold.statusCode).toBe(200)
    const w = worker(at)
    await drain(w)
    expect(w.sent.some((x) => x.to === email)).toBe(false)
    expect(await row(paused)).toMatchObject({ status: 'cancelled', cancel_reason: 'held', body_sealed: null })
    expect(await audited(paused, 'mail.cancelled')).toBe(1)
    const holdId = (await inject('GET', '/api/holds', reviewer)).json().holds.find((h: { target_id: string }) => h.target_id === deal).id
    expect((await inject('POST', `/api/holds/${holdId}/release`, reviewer2)).statusCode).toBe(200)
    // released again: it would go, until the invitation is withdrawn
    const open = await queued(at, m)
    const withdrawn = await queued(at, m)
    await drain(worker(at), 1)
    expect((await row(open)).status).toBe('sent')
    await t.owner.query('UPDATE targeted_invite SET revoked_at = now() WHERE id = $1', [invite])
    await drain(worker(at))
    expect(await row(withdrawn)).toMatchObject({ status: 'cancelled', cancel_reason: 'role_ended' })
  })

  it('TC-NTF-02 the current role and address are read at the send: a lead mail goes to the new address, and to nobody once they no longer lead', async () => {
    const deal = await liveDeal(lead)
    const at = later()
    const toLead = await queued(at, { audience: { kind: 'lead', userId: lead.id, dealId: deal }, to: lead.email, subject: 'For the lead', body: 'b' })
    const notLead = await queued(at, { audience: { kind: 'lead', userId: reviewer.id, dealId: deal }, to: reviewer.email, subject: 'Not the lead', body: 'b' })
    const w = worker(at)
    await drain(w)
    expect(w.sent.filter((m) => m.subject === 'For the lead').map((m) => m.to)).toEqual([lead.email])
    expect((await row(toLead)).status).toBe('sent')
    expect(await row(notLead)).toMatchObject({ status: 'cancelled', cancel_reason: 'role_ended' })
    // an account whose address changed after queueing
    const u = await person(unique('moved'))
    const moved = await queued(at, { audience: { kind: 'account', userId: u.id }, to: u.email, subject: 'Moved', body: 'b' })
    const fresh = unique('fresh')
    await t.owner.query('UPDATE user_account SET email = $2 WHERE id = $1', [u.id, fresh])
    const w2 = worker(at)
    await drain(w2)
    expect(w2.sent.filter((m) => m.subject === 'Moved').map((m) => m.to)).toEqual([fresh])
    expect((await row(moved)).to_address).toBe(u.email)
    await t.owner.query('UPDATE user_account SET email = $2 WHERE id = $1', [u.id, u.email])
  })

  it('TC-NTF-02 / TC-NTF-03 an urgent notice still goes under a hold and to a closed account', async () => {
    const u = await person(unique('urgent'))
    await t.owner.query('UPDATE user_account SET disabled_at = now() WHERE id = $1', [u.id])
    const at = later()
    const id = await queued(at, { audience: { kind: 'urgent', userId: u.id }, to: u.email, subject: 'Do not send money', body: 'b' })
    const plain = await queued(at, { audience: { kind: 'account', userId: u.id }, to: u.email, subject: 'Plain', body: 'b' })
    await drain(worker(at))
    expect((await row(id)).status).toBe('sent')
    expect(await row(plain)).toMatchObject({ status: 'cancelled', cancel_reason: 'recipient_disabled' })
    await t.owner.query('UPDATE user_account SET disabled_at = NULL WHERE id = $1', [u.id])
  })

  it('TC-NTF-02 a sandbox mail is never handed to a mailer in the other mode', async () => {
    const at = later()
    const id = await queued(at, { audience: { kind: 'address' }, to: unique('mode'), subject: 'Mode', body: 'b' })
    // as if queued before a switch: the row's mode is not the instance's
    await t.owner.query("UPDATE notification_outbox SET mode = 'real' WHERE id = $1", [id])
    const w = worker(at)
    await drain(w)
    expect(w.sent.some((m) => m.subject === 'Mode')).toBe(false)
    expect(await row(id)).toMatchObject({ status: 'cancelled', cancel_reason: 'mode_changed' })
  })

  it('TC-NTF-02 a failed send is tried five more times, decided again each time, then listed for the operator', async () => {
    let at = later()
    const fail = async () => {
      throw Object.assign(new Error('refused by the server for someone@example.test'), { code: 'ECONNECTION' })
    }
    const id = await queued(at, { audience: { kind: 'address' }, to: unique('retry'), subject: 'Retry', body: 'b' })
    await drain(worker(at, fail))
    let r = await row(id)
    expect([r.status, r.attempts, r.last_error]).toEqual(['queued', 1, 'ECONNECTION'])
    expect(r.next_attempt_at.getTime() - at.getTime()).toBe(60_000)
    // not due yet: left alone
    await drain(worker(at, fail))
    expect((await row(id)).attempts).toBe(1)
    for (const wait of [1, 10, 60, 360, 1440]) {
      at = new Date(at.getTime() + wait * 60_000)
      await drain(worker(at, fail))
    }
    r = await row(id)
    expect([r.status, r.attempts, r.body_sealed]).toEqual(['failed', 6, null])
    expect(await audited(id, 'mail.failed')).toBe(1)
    // a retry is decided again: an account closed between two tries is not written to
    const u = await person(unique('closing'))
    const at2 = later()
    const second = await queued(at2, { audience: { kind: 'account', userId: u.id }, to: u.email, subject: 'Second', body: 'b' })
    await drain(worker(at2, fail))
    await t.owner.query('UPDATE user_account SET disabled_at = now() WHERE id = $1', [u.id])
    await drain(worker(new Date(at2.getTime() + 60_000)))
    expect(await row(second)).toMatchObject({ status: 'cancelled', cancel_reason: 'recipient_disabled', attempts: 1 })
    await t.owner.query('UPDATE user_account SET disabled_at = NULL WHERE id = $1', [u.id])
  })

  it('TC-NTF-02 two workers at once send a mail once', async () => {
    const at = later()
    const id = await queued(at, { audience: { kind: 'address' }, to: unique('once'), subject: 'Once', body: 'b' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = worker(at, () => gate)
    const fast = worker(at)
    const first = attemptOne(slow)
    // the first holds the row while it sends; the second finds nothing due
    await expect.poll(async () => (await t.owner.query("SELECT 1 FROM pg_stat_activity WHERE state = 'idle in transaction'")).rowCount).toBeGreaterThan(0)
    const second = await attemptOne(fast)
    release()
    await first
    expect(second).toBe(false)
    expect([...slow.sent, ...fast.sent].filter((m) => m.subject === 'Once')).toHaveLength(1)
    expect((await row(id)).status).toBe('sent')
  })

  it('TC-NTF-02 one row that cannot be read does not stop the rest of the queue', async () => {
    const at = later()
    const bad = await queued(at, { audience: { kind: 'address' }, to: unique('bad'), subject: 'Bad', body: 'b' })
    const good = await queued(at, { audience: { kind: 'address' }, to: unique('good'), subject: 'Good', body: 'b' })
    // a sealed body that no longer opens
    await t.owner.query("UPDATE notification_outbox SET body_sealed = '\\x00'::bytea WHERE id = $1", [bad])
    const w = worker(at)
    await drain(w)
    expect(w.sent.some((m) => m.subject === 'Good')).toBe(true)
    expect((await row(good)).status).toBe('sent')
    expect(await row(bad)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'ERR_CRYPTO_INVALID_AUTH_TAG' })
  })
})

describe('D4 mail content (R-NTF-01, R-COM-04, R-COM-06)', () => {
  type Mail = { subject: string; body: string; is_html: boolean }
  const mailsTo = async (to: string) =>
    (await t.owner.query<Mail>('SELECT subject, body, is_html FROM sandbox_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at', [to])).rows
  const codeOf = async (deal: string) => (await t.owner.query<{ public_code: string }>('SELECT public_code FROM deal WHERE id = $1', [deal])).rows[0]!.public_code
  const DAY = 86_400_000
  const plus = (d: Date, days: number) => new Date(new Date(d).getTime() + days * DAY)
  // the job runs over every deal in this shared database, so the queue is drained to the end, not the usual 200
  // and the two tests that run it many times take about 12 s on a fast machine: a longer limit than the 20 s default
  const OVER_THE_WHOLE_DATABASE = 60_000
  const remindAt = async (at: Date) => {
    const o: OutboxDeps = { db: t.app, k: t.keyring, now: () => at, mailer: async () => new FakeOutbox(t.app) }
    await runReminders({ db: t.app, now: () => at, mail: mailQueue(o, () => undefined) })
    while ((await drain(o, 1000)) > 0);
  }
  // queues without sending: flush is replaced, so nothing is drained
  const queueOnly = (): OutboxDeps => ({ db: t.app, k: t.keyring, now: () => new Date(), mailer: async () => new FakeOutbox(t.app) })
  async function setReminders(count: number, every: number) {
    const rows = await count_('SELECT count(*) AS n FROM operator_policy')
    if (!rows)
      await t.owner.query("INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days) VALUES (1, true, true, true, ARRAY['admin','reviewer'], $1, $2)", [count, every])
    else
      await t.owner.query(
        `INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days)
         SELECT version + 1, per_link_terms, generic_links, bulk_promo, export_roles, $1, $2 FROM operator_policy ORDER BY version DESC LIMIT 1`,
        [count, every],
      )
  }
  const count_ = count
  const holdOn = async (deal: string) =>
    (await inject('GET', '/api/holds', reviewer)).json().holds.find((h: { target_id: string; released_at: string | null }) => h.target_id === deal && !h.released_at).id as string
  /** Every line is one of the fixed fields (TC-NTF-01). */
  const onlyFixed = (m: Mail, code: string) => {
    expect(m.is_html).toBe(false)
    expect(holdsNoSeed(m.subject + m.body)).toBe(true)
    expect(m.subject.endsWith(`(deal ${code})`)).toBe(true)
    expect(m.body).toContain(`Deal reference: ${code}`)
    expect(m.body.endsWith(SAFETY_LINE)).toBe(true)
    expect(m.body.split('\n').length).toBeLessThanOrEqual(10)
  }
  const termsWith = (extra: Record<string, unknown>) => ({ terms: { ...(draftFor('x').terms as object), ...extra } })
  async function owingInvestor(deal: string) {
    const x = await investor(deal)
    expect((await commit(x.u, deal, x.entity, '1000000')).statusCode).toBe(200)
    const p = await pid(x.u, deal)
    await sign(x.u, p)
    expect((await instructions(x.u, p)).statusCode).toBe(200)
    const issuedAt = (await t.owner.query<{ created_at: Date }>('SELECT created_at FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL', [p])).rows[0]!.created_at
    return { ...x, p, issuedAt }
  }
  const payInFull = async (p: string) => {
    const due = (await t.owner.query<{ cash_due_minor: string }>('SELECT cash_due_minor FROM participation WHERE id = $1', [p])).rows[0]!.cash_due_minor
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, { amount_minor: due, received_on: '2026-11-10', payer_name: 'Fay Fictional', payer_account: '12345678' })
    expect(r.statusCode, r.body).toBe(200)
  }

  it('TC-NTF-01 commitment and money received mails hold only the fixed fields; the code is the deal page\'s', async () => {
    const deal = await liveDeal(lead)
    const code = await codeOf(deal)
    const { u, p } = await owingInvestor(deal)
    expect((await inject('GET', `/api/my/deals/${deal}`, u)).body).toContain(code)
    await payInFull(p)
    const mails = await mailsTo(u.email)
    const confirmed = mails.find((m) => m.subject.startsWith('Your commitment has been recorded'))!
    const received = mails.find((m) => m.subject.startsWith('Money received'))!
    for (const m of [confirmed, received]) onlyFixed(m, code)
    // the deal code is random and may hold four digits in a row; only amounts are looked for
    expect(received.body.replaceAll(code, '')).not.toMatch(/\d{4,}|£/)
  })

  it('TC-NTF-01 invitation reminders: the operator\'s count, every three days, none at 0, none once taken up', async () => {
    const deal = await liveDeal(lead)
    const code = await codeOf(deal)
    const link = (await links(deal))[0]!.id
    await setReminders(2, 3)
    const to = unique('remind')
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: to, link_id: link })).statusCode).toBe(200)
    const sent = (await t.owner.query<{ last_sent_at: Date }>('SELECT last_sent_at FROM targeted_invite WHERE lower(email) = lower($1)', [to])).rows[0]!.last_sent_at
    const reminders = async () => (await mailsTo(to)).filter((m) => m.subject.startsWith('Reminder: an invitation is waiting'))
    await remindAt(plus(sent, 2.9))
    expect(await reminders()).toHaveLength(0)
    await remindAt(plus(sent, 3))
    await remindAt(plus(sent, 3.1))
    expect(await reminders()).toHaveLength(1)
    onlyFixed((await reminders())[0]!, code)
    await remindAt(plus(sent, 6))
    await remindAt(plus(sent, 40))
    expect(await reminders()).toHaveLength(2)
    // someone who took the invitation up but has not committed: reminded too, within the same count, until they commit
    const x = await investor(deal)
    const inv = (await t.owner.query<{ id: string; created_at: Date }>('SELECT id, created_at FROM deal_invitation WHERE user_id = $1 AND deal_id = $2', [x.u.id, deal])).rows[0]!
    const theirs = async () => (await mailsTo(x.u.email)).filter((m) => m.subject.startsWith('Reminder: an invitation is waiting'))
    await remindAt(plus(inv.created_at, 2.9))
    expect(await theirs()).toHaveLength(0)
    await remindAt(plus(inv.created_at, 3))
    await remindAt(plus(inv.created_at, 3.1))
    expect(await theirs()).toHaveLength(1)
    onlyFixed((await theirs())[0]!, code)
    expect((await t.owner.query('SELECT audience, about_kind FROM notification_outbox WHERE about_id = $1', [inv.id])).rows).toEqual([{ audience: 'reminder', about_kind: 'commit' }])
    // queued, then they commit before it goes: decided again at the send, not sent
    await runReminders({ db: t.app, now: () => plus(inv.created_at, 6), mail: { ...mailQueue(queueOnly(), () => undefined), flush: async () => undefined } })
    expect((await commit(x.u, deal, x.entity, '1000000')).statusCode).toBe(200)
    await remindAt(plus(inv.created_at, 6))
    expect(await theirs()).toHaveLength(1)
    expect((await t.owner.query('SELECT status, cancel_reason FROM notification_outbox WHERE about_id = $1 ORDER BY created_at', [inv.id])).rows).toEqual([
      { status: 'sent', cancel_reason: null },
      { status: 'cancelled', cancel_reason: 'role_ended' },
    ])
    // committed once and ended: they have decided, and no reminder brings them back
    await setReminders(5, 3)
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = now() WHERE invitation_id = $1", [inv.id])
    await remindAt(plus(inv.created_at, 9))
    expect(await theirs()).toHaveLength(1)
    await setReminders(2, 3)
    // taken up from a targeted invitation that was already reminded twice: the count is used up, not started again
    const tid = (await t.owner.query<{ id: string }>('SELECT id FROM targeted_invite WHERE lower(email) = lower($1)', [to])).rows[0]!.id
    const y = await investor(deal)
    const yInv = (await t.owner.query<{ id: string; created_at: Date }>('UPDATE deal_invitation SET targeted_invite = $3 WHERE user_id = $1 AND deal_id = $2 RETURNING id, created_at', [y.u.id, deal, tid])).rows[0]!
    await remindAt(plus(yInv.created_at, 3.1))
    expect((await mailsTo(y.u.email)).filter((m) => m.subject.startsWith('Reminder'))).toHaveLength(0)
    // reminders can be turned off
    await setReminders(0, 3)
    const quiet = unique('quiet')
    await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: quiet, link_id: link })
    await remindAt(plus(sent, 40))
    expect((await mailsTo(quiet)).filter((m) => m.subject.startsWith('Reminder'))).toHaveLength(0)
    await setReminders(2, 3)
  }, OVER_THE_WHOLE_DATABASE)

  it('TC-NTF-01 / TC-NTF-02 payment reminders carry the payment deadline, stop once paid, after the deadline and during a pause', async () => {
    const payBy = '2027-06-30'
    const deal = await liveDeal(lead, termsWith({ pay_by: payBy }))
    const code = await codeOf(deal)
    await setReminders(2, 3)
    const a = await owingInvestor(deal)
    const paymentMails = async (to: string) => (await mailsTo(to)).filter((m) => m.subject.startsWith('Payment needed'))
    await remindAt(plus(a.issuedAt, 2.9))
    expect(await paymentMails(a.u.email)).toHaveLength(0)
    await remindAt(plus(a.issuedAt, 3))
    await remindAt(plus(a.issuedAt, 3.5))
    const first = await paymentMails(a.u.email)
    expect(first).toHaveLength(1)
    onlyFixed(first[0]!, code)
    expect(first[0]!.body).toContain(`Deadline for this step: ${payBy}`)
    // paid in full: no more
    await payInFull(a.p)
    await remindAt(plus(a.issuedAt, 6))
    expect(await paymentMails(a.u.email)).toHaveLength(1)
    // queued, then paid before it went: decided again, cancelled
    const b = await owingInvestor(deal)
    const queuedId = await tx(t.app, (c) =>
      enqueue(c, t.keyring, plus(b.issuedAt, 3), { audience: { kind: 'reminder', userId: b.u.id, dealId: deal, about: 'payment', aboutId: b.p }, to: b.u.email, subject: 'x', body: 'x' }),
    )
    await payInFull(b.p)
    await drain({ db: t.app, k: t.keyring, now: () => plus(b.issuedAt, 3), mailer: async () => new FakeOutbox(t.app) })
    expect((await t.owner.query('SELECT status, cancel_reason FROM notification_outbox WHERE id = $1', [queuedId])).rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'role_ended' })
    // a pause stops them; so does the deadline passing
    const c2 = await owingInvestor(deal)
    expect((await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'Checking' })).statusCode).toBe(200)
    await remindAt(plus(c2.issuedAt, 4))
    expect(await paymentMails(c2.u.email)).toHaveLength(0)
    // not even queued: the job checks the pause itself, as the queue does again later
    expect(await count("SELECT count(*) AS n FROM notification_outbox WHERE about_id = $1", [c2.p])).toBe(0)
    expect((await inject('POST', `/api/holds/${await holdOn(deal)}/release`, reviewer2, {})).statusCode).toBe(200)
    await remindAt(new Date(new Date(`${payBy}T23:59:59.999Z`).getTime() + 1))
    expect(await paymentMails(c2.u.email)).toHaveLength(0)
    // with no payment deadline there are none
    const open = await liveDeal(lead)
    const d = await owingInvestor(open)
    await remindAt(plus(d.issuedAt, 30))
    expect(await paymentMails(d.u.email)).toHaveLength(0)
  }, OVER_THE_WHOLE_DATABASE)

  it('TC-NTF-01 / TC-CMP-03 payment reminders more often, or back on, is a loosening a second admin approves; less often applies at once', async () => {
    const now = (await inject('GET', '/api/admin/policy', admin)).json()
    const put = (days: number) => inject('PUT', '/api/admin/policy', admin, { ...now, version: undefined, reminder_every_days: days })
    expect((await put(now.reminder_every_days + 2)).json()).toEqual({})
    expect((await put(0)).json()).toEqual({})
    // back on, from none
    expect((await put(5)).json().requestId).toBeTruthy()
    expect((await inject('GET', '/api/admin/policy', admin)).json().reminder_every_days).toBe(0)
    await setReminders(2, 5)
    // more often
    expect((await put(4)).json().requestId).toBeTruthy()
    expect((await put(6)).json()).toEqual({})
    await setReminders(2, 3)
  })

  it('TC-NTF-03 an urgent notice cannot be edited, and reaches someone whose statement has lapsed, with nothing of the deal in it', async () => {
    expect((await inject('PUT', '/api/admin/mail-templates/urgent.hold', admin, { subject: 'Hi', body: 'Text' })).json().error).toBe('Urgent notices cannot be changed.')
    expect((await inject('PUT', '/api/admin/mail-templates/investor.invitation', admin, { subject: 'Hi', body: 'Text' })).statusCode).toBe(409)
    const list = (await inject('GET', '/api/admin/mail-templates', admin)).json()
    expect(list.urgent.map((u: { key: string }) => u.key)).toContain('urgent.hold')
    expect(list.templates.map((x: { key: string }) => x.key)).not.toContain('investor.invitation')
    const deal = await liveDeal(lead)
    const code = await codeOf(deal)
    const x = await owingInvestor(deal)
    // an edited, unapproved template elsewhere changes nothing for urgent notices
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = true')
    expect((await inject('PUT', '/api/admin/mail-templates/investor.payment_reminder', admin, { subject: 'Pay {code}', body: 'Please pay.' })).statusCode).toBe(200)
    await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [x.u.id, clock.toISOString()])
    expect((await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'Checking the company' })).statusCode).toBe(200)
    const m = (await mailsTo(x.u.email)).at(-1)!
    expect(m.subject).toBe(`Do not send money for now (deal ${code})`)
    expect(holdsNoSeed(m.body) && !m.body.includes('Checking') && !m.is_html).toBe(true)
    expect((await inject('POST', `/api/holds/${await holdOn(deal)}/release`, reviewer2, {})).statusCode).toBe(200)
    expect((await inject('PUT', '/api/admin/mail-templates/investor.payment_reminder', admin, { reset: true })).json()).toMatchObject({ promotional: false })
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = false')
  })

  it('TC-NTF-01 / TC-COM-04 / TC-CMP-07 an edited investor template is promotional: HTML with the warning first, approved wording, only to someone who passes', async () => {
    const put = (body: unknown) => inject('PUT', '/api/admin/mail-templates/investor.money_received', admin, body)
    expect((await put({ subject: 'Thanks', body: 'You sent {amount}' })).json().error).toMatch(/\{amount\} is not a field/)
    expect((await put({ subject: 'Thanks', body: 'Hi' })).statusCode).toBe(200)
    // the lead cannot edit
    expect((await inject('PUT', '/api/admin/mail-templates/investor.money_received', lead, { subject: 'x', body: 'y' })).statusCode).toBe(403)
    const saved = await put({ subject: 'Thanks for {code} <3', body: 'We got it. <b>Thanks</b>\n\nFrom {operator}' })
    expect(saved.json()).toMatchObject({ promotional: true })
    const deal = await liveDeal(lead)
    const code = await codeOf(deal)
    const lastTo = async (to: string) => (await mailsTo(to)).filter((m) => m.subject.startsWith('Thanks for') || m.subject.startsWith('Money received')).at(-1)!
    const variant = async (to: string) =>
      (await t.owner.query<{ sent_variant: string }>("SELECT sent_variant FROM notification_outbox WHERE lower(to_address) = lower($1) AND promo_template = 'investor.money_received' ORDER BY created_at DESC LIMIT 1", [to])).rows[0]!.sent_variant
    const pay = async (p: string) =>
      expect((await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, { amount_minor: '1000', received_on: '2026-11-10', payer_name: 'Fay Fictional', payer_account: '12345678' })).statusCode).toBe(200)

    // passes today: the edited version, as HTML, the warning before anything else
    const yes = await owingInvestor(deal)
    await pay(yes.p)
    const promo = await lastTo(yes.u.email)
    expect(promo.is_html).toBe(true)
    expect(promo.subject).toBe(`Thanks for ${code} <3`)
    expect(promo.body.slice(promo.body.indexOf('<body>') + 6).startsWith('<div role="note" id="warning"><p>')).toBe(true)
    expect(promo.body).toContain('PLACEHOLDER')
    expect(promo.body.indexOf('We got it.')).toBeGreaterThan(promo.body.indexOf('</div>'))
    expect(promo.body).toContain('&lt;b&gt;Thanks&lt;/b&gt;')
    expect(holdsNoSeed(promo.body)).toBe(true)
    expect(await variant(yes.u.email)).toBe('promo')

    // no longer passes (the statement lapsed): the fixed mail, no edited words
    const no = await owingInvestor(deal)
    await t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [no.u.id, clock.toISOString()])
    await pay(no.p)
    const fixed = await lastTo(no.u.email)
    onlyFixed(fixed, code)
    expect(fixed.body).not.toContain('We got it')
    expect(await variant(no.u.email)).toBe('fixed')

    // approvals asked for: unapproved wording is not sent; approved wording is
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = true')
    await pay(yes.p)
    expect((await lastTo(yes.u.email)).is_html).toBe(false)
    const approverC = await staff(unique('approver'), ['approver'])
    const waiting = (await inject('GET', '/api/approvals/mail-templates', approverC)).json().templates.find((x: { key: string }) => x.key === 'investor.money_received')
    const approve = (sha: string) =>
      inject('POST', `/api/approvals/mail-templates/investor.money_received/${waiting.version}`, approverC, { content_sha256: sha, self_declared_name: 'Ann Approver' })
    expect((await approve('0'.repeat(64))).json().error).toMatch(/changed since you opened it/)
    expect((await approve(waiting.sha256)).statusCode).toBe(200)
    await pay(yes.p)
    expect((await lastTo(yes.u.email)).is_html).toBe(true)
    // a new edit needs its own approval
    expect((await put({ subject: 'Thanks again for {code}', body: 'Again.' })).statusCode).toBe(200)
    await pay(yes.p)
    expect((await lastTo(yes.u.email)).is_html).toBe(false)
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = false')

    // back to the fixed wording
    expect((await put({ reset: true })).json()).toMatchObject({ promotional: false })
    await pay(yes.p)
    onlyFixed(await lastTo(yes.u.email), code)
  })
})

describe('D4 operator money (C-FEE-4, R-KYC-02.1, R-OPS-05, R-WDR-04)', () => {
  /** A committed investor on a live deal, with what they are to pay (D). Receipts need no signature. */
  async function committed(amount = '1000000') {
    const deal = await liveDeal(lead)
    const inv = await investor(deal)
    expect((await commit(inv.u, deal, inv.entity, amount)).statusCode).toBe(200)
    const p = await pid(inv.u, deal)
    const due = BigInt((await t.owner.query<{ d: string }>('SELECT cash_due_minor::text AS d FROM participation WHERE id = $1', [p])).rows[0]!.d)
    return { deal, p, due, ...inv }
  }
  async function receive(p: string, amount: bigint) {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: String(amount),
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '12345678',
    })
    expect(r.statusCode, r.body).toBe(200)
    return r.json().id as string
  }
  const row = async (p: string, who = reviewer) => (await inject('GET', '/api/review/refunds', who)).json().rows.find((r: { participation_id: string }) => r.participation_id === p)
  const prepare = (p: string, amount: bigint, who = reviewer, extra: Record<string, unknown> = {}) =>
    inject('POST', `/api/review/participations/${p}/refunds`, who, { amount_minor: String(amount), ...extra })
  const act = (id: string, what: 'approve' | 'sent' | 'cancel', who = reviewer2, body: Record<string, unknown> = {}) => inject('POST', `/api/review/refunds/${id}/${what}`, who, body)
  const record = (p: string, actual: bigint, extra: Record<string, unknown> = {}) =>
    inject('POST', `/api/review/participations/${p}/refund-records`, reviewer, { actual_minor: String(actual), sent_on: '2026-11-11', ...extra })
  /** Prepared by one reviewer, approved by the other. */
  async function approved(p: string, amount: bigint) {
    const r = await prepare(p, amount)
    expect(r.statusCode, r.body).toBe(200)
    const a = await act(r.json().id, 'approve')
    expect(a.statusCode, a.body).toBe(200)
    return r.json().id as string
  }
  async function reject(entity: string) {
    const caseId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [caseId, entity])
    const r = await inject('POST', `/api/review/kyc/${caseId}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })
    expect(r.statusCode, r.body).toBe(200)
  }
  const step = (p: string, to: string) => inject('POST', `/api/review/participations/${p}/hold-step`, reviewer, { step: to, basis: `Decided: ${to}` })
  const release = (p: string, receipt: string, amount: bigint) =>
    inject('POST', `/api/review/participations/${p}/release`, reviewer, { items: [{ receipt, amount_minor: String(amount) }], basis: 'No disclosure needed; consent not required' })

  it('TC-FEE-19 / TC-WDR-03 one obligation through overpaid, withdrawn, a part refund and late money; a reversal after a refund is needs-check, not 0', async () => {
    const { p, due, deal, u } = await committed()
    await receive(p, due + 100000n)
    let r = await row(p)
    expect([r.on_hand_minor, r.effective_minor, r.refund_due_minor, r.reason]).toEqual([String(due + 100000n), String(due), '100000', 'overpaid'])
    const id = await approved(p, 50000n)
    expect((await act(id, 'sent', reviewer)).statusCode).toBe(200)
    expect((await record(p, 50000n, { refund_id: id })).json().exceptions).toEqual([])
    // another refund prepared and dropped for the same reason adds no second reason
    const dropped = await prepare(p, 1000n)
    expect((await act(dropped.json().id, 'cancel', reviewer)).statusCode).toBe(200)
    // withdrawn (chunk 6's route; set directly here): E 0, everything left is due back
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = clock_timestamp() WHERE id = $1", [p])
    r = await row(p)
    expect([r.effective_minor, r.refund_due_minor, r.reason, r.late_money]).toEqual(['0', String(due + 50000n), 'withdrawn', false])
    await receive(p, 30000n)
    r = await row(p)
    // still one row and one amount; the reasons are only history
    expect((await inject('GET', '/api/review/refunds', reviewer)).json().rows.filter((x: { participation_id: string }) => x.participation_id === p)).toHaveLength(1)
    expect([r.refund_due_minor, r.late_money, r.reason_history]).toEqual([String(due + 80000n), true, ['overpaid']])
    expect((await record(p, due + 80000n)).json().exceptions).toEqual(['no_approval'])
    r = await row(p)
    expect(r).toBeUndefined()
    expect(await count("SELECT count(*) AS n FROM refund_todo_event WHERE participation_id = $1 AND kind = 'reason'", [p])).toBe(2)
    // a receipt reversed after the refund: N < 0 is the needs-check overlay, and no refund can be prepared
    const other = await committed()
    const rc = await receive(other.p, other.due)
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = clock_timestamp() WHERE id = $1", [other.p])
    expect((await record(other.p, other.due)).statusCode).toBe(200)
    expect((await inject('POST', `/api/review/receipts/${rc}/reverse`, reviewer, { reason: 'Bank recalled it' })).statusCode).toBe(200)
    r = await row(other.p)
    expect([r.on_hand_minor, r.needs_check, r.refund_due_minor]).toEqual([String(-other.due), true, null])
    expect((await prepare(other.p, 1n)).json().error).toMatch(/needs checking/)
    void deal
    void u
  })

  it('TC-FEE-19 / TC-FEE-23 D, an overpayment refunded, then a larger commitment: the gap shows; cancelling an approval adds it back', async () => {
    const { p, due, deal, u } = await committed()
    await receive(p, due + 100000n)
    const id = await approved(p, 100000n)
    let r = await row(p)
    // in flight comes off N at once
    expect([r.on_hand_minor, r.in_flight_minor, r.refund_due_minor]).toEqual([String(due), '100000', '0'])
    // and from what the investor's page and status count as received
    expect((await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0].held_minor).toBe(String(due))
    expect((await act(id, 'cancel', reviewer)).statusCode).toBe(200)
    r = await row(p)
    expect([r.on_hand_minor, r.refund_due_minor]).toEqual([String(due + 100000n), '100000'])
    const id2 = await approved(p, 100000n)
    expect((await act(id2, 'sent', reviewer)).statusCode).toBe(200)
    // sent: back only with evidence that the recall worked
    expect((await act(id2, 'cancel', reviewer)).json().error).toMatch(/recall worked/)
    expect((await act(id2, 'cancel', reviewer, { recall_evidence: 'Bank confirmed the recall' })).statusCode).toBe(200)
    const id3 = await approved(p, 100000n)
    expect((await act(id3, 'sent', reviewer)).statusCode).toBe(200)
    expect((await record(p, 100000n, { refund_id: id3 })).statusCode).toBe(200)
    expect((await change(u, deal, p, '1100000')).statusCode).toBe(200)
    const due2 = BigInt((await t.owner.query<{ d: string }>('SELECT cash_due_minor::text AS d FROM participation WHERE id = $1', [p])).rows[0]!.d)
    const mine = (await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0]
    // E is the old D: the refunded money is not counted again, and the gap is what the larger commitment added
    expect(due2).toBeGreaterThan(due)
    expect([mine.held_minor, mine.still_to_pay_minor]).toEqual([String(due), String(due2 - due)])
    expect((await row(p)) ?? null).toBeNull()
  })

  it('TC-OPS-04 a second person approves; one in progress; the destination defaults to the payer; recording is never refused and odd ones are flagged', async () => {
    const { p, due, deal, u } = await committed()
    await receive(p, due + 100000n)
    expect((await prepare(p, 100001n)).json().error).toMatch(/more than the amount due/)
    expect((await prepare(p, 1000n, lead)).statusCode).toBe(403)
    expect((await prepare(p, 1000n, reviewer, { dest_account: '99999999' })).json().error).toMatch(/evidence/)
    // two people take it at once: one wins
    const both = await Promise.all([prepare(p, 1000n, reviewer), prepare(p, 1000n, reviewer2)])
    expect(both.map((x) => x.statusCode).sort()).toEqual([200, 409])
    const id = both.find((x) => x.statusCode === 200)!.json().id
    const preparer = both[0]!.statusCode === 200 ? reviewer : reviewer2
    const other = preparer === reviewer ? reviewer2 : reviewer
    expect((await act(id, 'approve', preparer)).json().error).toMatch(/cannot approve/)
    await expect(t.app.query('UPDATE refund_payment SET approved_by = prepared_by, approved_at = now(), state = $2 WHERE id = $1', [id, 'approved'])).rejects.toThrow(/second_person/)
    expect((await prepare(p, 1000n, other)).json().error).toBe('Someone is already working on a refund for this person.')
    expect((await act(id, 'cancel', other)).statusCode).toBe(200)
    // the destination: the payer's account by default; another one needs evidence and is marked
    const d = await prepare(p, 100000n, reviewer, { dest_account: '99999999', evidence: 'Signed letter from the investor' })
    expect(d.json().differs_from_source).toBe(true)
    // the approver's cap is checked again: money reversed meanwhile leaves less to give back
    const rc = await receive(p, 5000n)
    await act(d.json().id, 'cancel', reviewer2)
    const big = await prepare(p, 105000n)
    expect((await inject('POST', `/api/review/receipts/${rc}/reverse`, reviewer, { reason: 'Bank recalled it' })).statusCode).toBe(200)
    expect((await act(big.json().id, 'approve')).json().error).toMatch(/more than the amount due/)
    await act(big.json().id, 'cancel', reviewer)
    // approved £1,000, sent £600: recorded, N gets £400 back, flagged, reviewers told; a commitment raised meanwhile is flagged too
    const id2 = await approved(p, 100000n)
    expect((await change(u, deal, p, '1100000')).statusCode).toBe(200)
    expect((await act(id2, 'sent', reviewer)).statusCode).toBe(200)
    const rec = await record(p, 60000n, { refund_id: id2 })
    expect(rec.statusCode, rec.body).toBe(200)
    expect(rec.json().exceptions).toEqual(['amount_differs', 'commitment_changed'])
    expect(rec.json().on_hand_minor).toBe(String(due + 40000n))
    expect((await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0].held_minor).toBe(String(due + 40000n))
    expect((await mailTo(reviewer2.email)).some((m) => m.subject === 'A refund to check' && holdsNoSeed(m.body))).toBe(true)
    // more than approved is recorded as well (fresh money first: the larger commitment used up what was due back)
    await receive(p, 1000000n)
    const id3 = await approved(p, 1000n)
    expect((await record(p, 2000n, { refund_id: id3 })).json().exceptions).toEqual(['amount_differs'])
    // a finished refund stays finished
    await expect(t.app.query("UPDATE refund_payment SET state = 'approved' WHERE id = $1", [id3])).rejects.toThrow(/stays finished/)
    // nor is what was recorded rewritten, and an open one never goes back
    await expect(t.app.query("UPDATE refund_payment SET actual_minor = 1, exceptions = '{}' WHERE id = $1", [id3])).rejects.toThrow(/stays finished/)
    await expect(t.app.query("UPDATE refund_payment SET hold_used_minor = hold_used_minor WHERE id = $1", [id3])).resolves.toBeDefined()
    await expect(t.app.query("UPDATE refund_payment SET cancelled_at = now() WHERE id = $1", [id])).rejects.toThrow(/stays finished/)
    const back = await approved(p, 1000n)
    expect((await act(back, 'sent', reviewer)).statusCode).toBe(200)
    await expect(t.app.query("UPDATE refund_payment SET state = 'approved' WHERE id = $1", [back])).rejects.toThrow(/only moves forward/)
    expect((await act(back, 'cancel', reviewer, { recall_evidence: 'Bank confirmed the recall' })).statusCode).toBe(200)
    // a held deal meanwhile: still recorded
    const id4 = await approved(p, 1000n)
    await t.owner.query("INSERT INTO compliance_hold (id, level, target_id, reason, applied_by) VALUES ($1, 'deal', $2, 'Checking', $3)", [randomUUID(), deal, admin.id])
    expect((await record(p, 1000n, { refund_id: id4 })).json().exceptions).toEqual(['held_meanwhile'])
    await t.owner.query("UPDATE compliance_hold SET released_at = now(), released_by = $2 WHERE target_id = $1 AND released_at IS NULL", [deal, reviewer2.id])
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'refund.recorded' AND entity_id = ANY($1)", [[id2, id3, id4]])).toBe(3)
  })

  it('TC-OPS-04 / R28 (3) the payer account is not known: no default destination; the account typed counts as different; the deal currency, the £1bn limit', async () => {
    const { p, due } = await committed()
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: String(due + 100000n),
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: 'Unknown',
    })
    expect(r.statusCode, r.body).toBe(200)
    expect((await prepare(p, 1000n)).json().error).toMatch(/not known: type the account/)
    // typing "unknown" again is no account either: still a different one, with evidence
    expect((await prepare(p, 1000n, reviewer, { dest_account: 'unknown' })).json().error).toMatch(/evidence/)
    expect((await prepare(p, 1000n, reviewer, { dest_account: '12345678' })).json().error).toMatch(/evidence/)
    const ok = await prepare(p, 1000n, reviewer, { dest_account: '12345678', evidence: 'The investor wrote with their account' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await t.owner.query('SELECT differs_from_source FROM refund_payment WHERE id = $1', [ok.json().id])).rows[0]!.differs_from_source).toBe(true)
    expect((await act(ok.json().id, 'cancel', reviewer2)).statusCode).toBe(200)
    // recorded with no approval, nowhere known, no evidence: kept and flagged
    const rec = await record(p, 1000n, { dest_account: 'unknown' })
    expect(rec.statusCode, rec.body).toBe(200)
    const row2 = (await t.owner.query<{ exceptions: string[]; currency: string }>("SELECT exceptions, currency FROM refund_payment WHERE participation_id = $1 AND state = 'recorded'", [p])).rows[0]!
    expect(row2.exceptions).toContain('account_differs')
    expect(row2.currency).toBe('GBP')
    // over the database's limit: refused, not a server error
    expect((await record(p, 100_000_000_001n)).statusCode).toBe(400)
    // a year 0001 date is refused, as on the receipt
    expect((await record(p, 1000n, { sent_on: '0001-01-01' })).statusCode).toBe(400)
    expect(
      (await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, { amount_minor: '100', received_on: '1999-12-31', payer_name: 'Fay', payer_account: '1' })).statusCode,
    ).toBe(400)
  })

  it('TC-FEE-22 / TC-KYC-05 a rejection holds the money: nothing is refunded before a release decision; later money goes back to considering; the lead sees only "with the operator"', async () => {
    const { p, due, deal, u, entity } = await committed()
    await reject(entity)
    // the hold record exists with no money
    let r = await row(p)
    expect([r.hold_step, r.hold_minor, r.refund_due_minor]).toEqual(['considering', '0', '0'])
    const r1 = await receive(p, due)
    r = await row(p)
    expect([r.hold_minor, r.refund_due_minor]).toEqual([String(due), '0'])
    expect((await prepare(p, 1n)).json().error).toMatch(/more than the amount due/)
    // considering and disclosure/consent are not a release
    expect((await release(p, r1, 1000n)).json().error).toMatch(/release decision/)
    expect((await step(p, 'disclosure_consent')).statusCode).toBe(200)
    expect((await release(p, r1, 1000n)).json().error).toMatch(/release decision/)
    expect((await step(p, 'disclosure_consent')).json().error).toMatch(/does not follow/)
    expect((await step(p, 'release_allowed')).statusCode).toBe(200)
    expect((await release(p, r1, due + 1n)).json().error).toMatch(/more than/)
    const rel = await release(p, r1, 400000n)
    expect(rel.statusCode, rel.body).toBe(200)
    expect([rel.json().hold_minor, rel.json().refund_due_minor]).toEqual([String(due - 400000n), '400000'])
    // only the released part can be approved
    expect((await prepare(p, 400001n)).json().error).toMatch(/more than the amount due/)
    const id = await approved(p, 400000n)
    // new money is held and the hold starts again at considering
    await receive(p, 50000n)
    r = await row(p)
    expect([r.hold_step, r.hold_minor]).toEqual(['considering', String(due - 400000n + 50000n)])
    // the release form's receipts: each one still counted, with the part already released
    expect(r.receipts.map((x: { id: string; left_minor: string; released_minor: string }) => [x.id === r1, x.left_minor, x.released_minor])).toEqual([
      [true, String(due), '400000'],
      [false, '50000', '0'],
    ])
    expect([r.deal_id, r.currency]).toEqual([deal, 'GBP'])
    expect(await count("SELECT count(*) AS n FROM refund_todo_event WHERE participation_id = $1 AND kind = 'hold_step' AND basis IS NOT NULL", [p])).toBe(2)
    // the approval cancelled: the release it used comes back as usable, the hold stays what it was
    expect((await act(id, 'cancel', reviewer)).statusCode).toBe(200)
    r = await row(p)
    expect([r.hold_minor, r.refund_due_minor]).toEqual([String(due - 400000n + 50000n), '400000'])
    // the lead's panel: only the neutral status, and no hold figure in the body
    expect((await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Fay\t${u.email}\t\t\n` })).statusCode).toBe(200)
    const pipe = await inject('GET', `/api/deals/${deal}/pipeline`, lead)
    expect(pipe.statusCode).toBe(200)
    expect(pipe.body).not.toMatch(/"hold[a-z_]*":/)
    expect(pipe.body).toContain('with_operator')
    // a new commitment with another entity: reviewers are told, nobody else hears why
    const e2 = await newEntity(u, 'Entity Two')
    await passKyc(e2)
    expect((await commit(u, deal, e2, '1000000')).statusCode).toBe(200)
    expect((await mailTo(reviewer2.email)).some((m) => m.subject === 'A new commitment to check')).toBe(true)
    expect((await mailTo(u.email)).some((m) => /\bhold|reject|release/i.test(m.subject + m.body))).toBe(false)
  })
})


describe('D4 unallocated money and payment queries (R-OPS-04, R-PAY-07, R-PAY-08)', () => {
  async function committed(amount = '1000000') {
    const deal = await liveDeal(lead)
    const inv = await investor(deal)
    expect((await commit(inv.u, deal, inv.entity, amount)).statusCode).toBe(200)
    const p = await pid(inv.u, deal)
    const due = BigInt((await t.owner.query<{ d: string }>('SELECT cash_due_minor::text AS d FROM participation WHERE id = $1', [p])).rows[0]!.d)
    return { deal, p, due, ...inv }
  }
  async function receive(p: string, amount: bigint, payer = 'Fay Fictional') {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: String(amount),
      received_on: '2026-11-10',
      payer_name: payer,
      payer_account: '12345678',
    })
    expect(r.statusCode, r.body).toBe(200)
    return r.json().id as string
  }
  /** C-FEE-4 N as every screen counts it. */
  const onHand = async (p: string) =>
    BigInt(
      (
        await t.owner.query<{ n: string }>(
          `SELECT ((SELECT coalesce(sum(amount_minor - moved_out_minor), 0) FROM receipt WHERE participation_id = $1 AND reversed_at IS NULL)
                 - (SELECT coalesce(sum(CASE WHEN state = 'recorded' THEN actual_minor WHEN state IN ('approved', 'sent') THEN amount_minor ELSE 0 END), 0)
                      FROM refund_payment WHERE participation_id = $1))::text AS n`,
          [p],
        )
      ).rows[0]!.n,
    )
  const list = (amount: bigint, extra: Record<string, unknown> = {}) =>
    inject('POST', '/api/review/unallocated', reviewer, {
      currency: 'GBP',
      amount_minor: String(amount),
      received_on: '2026-11-11',
      payer_name: 'Fay Fictional',
      payer_account: '87654321',
      ...extra,
    })
  const allocate = (id: string, parts: Array<[string, bigint]>, who = reviewer) =>
    inject('POST', `/api/review/unallocated/${id}/allocate`, who, { parts: parts.map(([p, a]) => ({ participation_id: p, amount_minor: String(a) })) })
  const move = (receipt: string, parts: Array<[string | null, bigint]>, who = reviewer) =>
    inject('POST', `/api/review/receipts/${receipt}/move`, who, {
      parts: parts.map(([p, a]) => ({ participation_id: p, amount_minor: String(a) })),
      reason: 'Paid with the wrong reference',
    })
  const openRows = async () => (await inject('GET', '/api/review/unallocated', reviewer)).json().rows as Array<Record<string, unknown> & { id: string }>

  it('TC-OPS-03 listed in no N, suggested across deals, allocated whole or split to the penny, other currency refused, returned only by a second person', async () => {
    // an amount nobody else in the test database owes, so these two rank first
    const a = await committed('1234567')
    const b = await committed('1234567')
    const r = await list(a.due)
    expect(r.statusCode, r.body).toBe(200)
    const id = r.json().id as string
    expect([await onHand(a.p), await onHand(b.p)]).toEqual([0n, 0n])
    const row = (await openRows()).find((x) => x.id === id)!
    expect([row.days_open, row.owner]).toEqual([0, reviewer.id])
    // suggestions only, across deals: same amount owed and the payer's name
    const sug = row.suggestions as Array<{ participation_id: string; by_amount: boolean; by_name: boolean; deal_code: string }>
    expect(sug.filter((s) => [a.p, b.p].includes(s.participation_id)).map((s) => [s.by_amount, s.by_name])).toEqual([
      [true, true],
      [true, true],
    ])
    // the lead never sees the list
    expect((await inject('GET', '/api/review/unallocated', lead)).statusCode).toBe(403)
    // split: the parts must add up exactly
    expect((await allocate(id, [[a.p, 500000n], [b.p, a.due - 500001n]])).json().error).toMatch(/add up/)
    expect((await allocate(id, [[a.p, 500000n], [a.p, a.due - 500000n]])).json().error).toMatch(/different place/)
    const split = await allocate(id, [
      [a.p, 500000n],
      [b.p, a.due - 500000n],
    ])
    expect(split.statusCode, split.body).toBe(200)
    expect(split.json().outcome).toBe('split')
    expect([await onHand(a.p), await onHand(b.p)]).toEqual([500000n, a.due - 500000n])
    expect((await allocate(id, [[a.p, a.due]])).json().error).toMatch(/already been dealt with/)
    expect(await count("SELECT count(*) AS n FROM receipt WHERE unallocated_id = $1 AND source = 'unallocated'", [id])).toBe(2)
    // whole, to one person
    const whole = (await list(1000n)).json().id as string
    expect((await allocate(whole, [[a.p, 1000n]])).json().outcome).toBe('allocated')
    expect(await onHand(a.p)).toBe(501000n)
    // another currency from the deal's cannot be allocated
    const eur = (await list(1000n, { currency: 'EUR' })).json().id as string
    expect((await allocate(eur, [[a.p, 1000n]])).json().error).toMatch(/another currency/)
    expect(await onHand(a.p)).toBe(501000n)
    // return: asked by one, approved by another; nothing else meanwhile
    expect((await inject('POST', `/api/review/unallocated/${eur}/return`, reviewer, { basis: 'Nobody can be found' })).statusCode).toBe(200)
    expect((await allocate(eur, [[a.p, 1000n]])).json().error).toMatch(/waiting for approval/)
    expect((await inject('POST', `/api/review/unallocated/${eur}/return/approve`, reviewer)).json().error).toMatch(/other than/)
    expect((await inject('POST', `/api/review/unallocated/${eur}/return/approve`, reviewer2)).statusCode).toBe(200)
    expect((await openRows()).some((x) => x.id === eur)).toBe(false)
    expect((await t.owner.query('SELECT outcome, returned_approved_by FROM unallocated_receipt WHERE id = $1', [eur])).rows[0]).toEqual({
      outcome: 'returned',
      returned_approved_by: reviewer2.id,
    })
    // every outcome is audited
    for (const action of ['unallocated.listed', 'unallocated.split', 'unallocated.allocated', 'unallocated.return_requested', 'unallocated.returned'])
      expect(await count('SELECT count(*) AS n FROM audit WHERE action = $1', [action])).toBeGreaterThan(0)
  })

  it('TC-OPS-03 a move changes both N; money approved, sent, refunded, used by a confirmed allocation or held cannot move; at most what is free', async () => {
    const a = await committed()
    const b = await committed()
    const rc = await receive(a.p, a.due)
    expect((await move(rc, [[a.p, 1n]])).json().error).toMatch(/already with this person/)
    expect((await move(rc, [[b.p, 300000n]])).statusCode).toBe(200)
    expect([await onHand(a.p), await onHand(b.p)]).toEqual([a.due - 300000n, 300000n])
    // what both investors' pages count as received
    expect((await inject('GET', `/api/my/deals/${a.deal}`, a.u)).json().participations[0].held_minor).toBe(String(a.due - 300000n))
    expect((await inject('GET', `/api/my/deals/${b.deal}`, b.u)).json().participations[0].held_minor).toBe('300000')
    // a refund approved for A: it is in flight, so only the rest is free to move
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = clock_timestamp() WHERE id = $1", [a.p])
    const prep = await inject('POST', `/api/review/participations/${a.p}/refunds`, reviewer, { amount_minor: '100000' })
    expect(prep.statusCode, prep.body).toBe(200)
    expect((await inject('POST', `/api/review/refunds/${prep.json().id}/approve`, reviewer2)).statusCode).toBe(200)
    const free = a.due - 400000n
    expect(await onHand(a.p)).toBe(free)
    expect((await move(rc, [[b.p, free + 1n]])).json().error).toMatch(/free to move/)
    expect((await move(rc, [[b.p, free]])).statusCode).toBe(200)
    // sent, then recorded: still nothing left to move
    expect((await inject('POST', `/api/review/refunds/${prep.json().id}/sent`, reviewer)).statusCode).toBe(200)
    expect((await move(rc, [[b.p, 1n]])).json().error).toMatch(/free to move/)
    expect((await inject('POST', `/api/review/participations/${a.p}/refund-records`, reviewer, { actual_minor: '100000', sent_on: '2026-11-11', refund_id: prep.json().id })).statusCode).toBe(200)
    expect((await move(rc, [[b.p, 1n]])).json().error).toMatch(/free to move/)
    expect([await onHand(a.p), await onHand(b.p)]).toEqual([0n, a.due - 100000n])
    // used by a confirmed allocation (`settled`, D5): `movable` in the lib test (TC-FEE-19 after settled)
    // held money (a KYC rejection) does not move before a release decision
    const h = await committed()
    const hr = await receive(h.p, h.due)
    const caseId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [caseId, h.entity])
    expect((await inject('POST', `/api/review/kyc/${caseId}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })).statusCode).toBe(200)
    expect((await move(hr, [[b.p, 1n]])).json().error).toMatch(/free to move|Held money/)
    expect(await onHand(h.p)).toBe(h.due)
    // back to unallocated money, and the moved receipt says where it came from
    const bReceipt = (await t.owner.query<{ id: string }>('SELECT id FROM receipt WHERE participation_id = $1 AND moved_from = $2 LIMIT 1', [b.p, rc])).rows[0]!.id
    const back = await move(bReceipt, [[null, 1000n]])
    expect(back.statusCode, back.body).toBe(200)
    const u = back.json().moved[0].unallocated as string
    expect((await openRows()).find((x) => x.id === u)?.amount_minor).toBe('1000')
    expect(await onHand(b.p)).toBe(a.due - 100000n - 1000n)
    // the lead cannot reach the route
    expect((await move(bReceipt, [[a.p, 1n]], lead)).statusCode).toBe(403)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'receipt.moved'")).toBeGreaterThanOrEqual(3)
  })

  it('TC-OPS-03 / TC-CMP-01 a reviewer who invests in a deal cannot allocate to it, move money off it, see it suggested or decide its payment queries', async () => {
    const deal = await liveDeal(lead)
    const rv = await staff(unique('revalloc'), ['reviewer'])
    const link = (await links(deal)).find((l) => l.carry_bps === 2000)!
    await inject('POST', '/api/invite/accept', { ...rv, cookie: `${rv.cookie}; ${await open(tokenOf(await urlOf(deal, link.id)))}` }, {})
    await qualify(rv, `Staff ${rv.email}`)
    const e = await newEntity(rv)
    await passKyc(e)
    await commit(rv, deal, e, '1000000')
    const mine = await pid(rv, deal)
    const other = await committed()
    const inv = await investor(deal)
    expect((await commit(inv.u, deal, inv.entity, '1000000')).statusCode).toBe(200)
    const theirs = await pid(inv.u, deal)
    const id = (await list(1000n)).json().id as string
    const seen = (await inject('GET', '/api/review/unallocated', rv)).json().rows.find((x: { id: string }) => x.id === id)
    expect(seen.suggestions.some((x: { participation_id: string }) => [mine, theirs].includes(x.participation_id))).toBe(false)
    // nor among the people the screen offers to assign to by hand
    const offered = (await inject('GET', '/api/review/unallocated', rv)).json().people as Array<{ participation_id: string; owed_minor: string; currency: string }>
    expect(offered.some((x) => [mine, theirs].includes(x.participation_id))).toBe(false)
    expect(offered.find((x) => x.participation_id === other.p)).toMatchObject({ currency: 'GBP', owed_minor: String(other.due) })
    expect((await allocate(id, [[theirs, 1000n]], rv)).json().error).toMatch(/invest in/)
    const rc = await receive(theirs, 5000n, 'Uncle Bob')
    expect((await move(rc, [[other.p, 1000n]], rv)).json().error).toMatch(/invest in/)
    const oc = await receive(other.p, 5000n)
    expect((await move(oc, [[theirs, 1000n]], rv)).json().error).toMatch(/invest in/)
    const q = (await inject('GET', '/api/review/transfer-queries', reviewer)).json().rows.find((x: { participation_id: string }) => x.participation_id === theirs)
    expect((await inject('GET', '/api/review/transfer-queries', rv)).json().rows.some((x: { id: string }) => x.id === q.id)).toBe(false)
    expect((await inject('POST', `/api/review/transfer-queries/${q.id}/decide`, rv, { decision: 'approved', note: 'Looks fine' })).json().error).toMatch(/invest in/)
  })

  it('TC-PAY-05 a wrong reference goes on the list to check; a payment from someone else is approved by a reviewer; stuck payments get the trace text', async () => {
    const a = await committed()
    // R-PAY-07: the investor reports it; once, until dealt with; nobody else can for them
    const report = (who: Client) => inject('POST', `/api/my/participations/${a.p}/reference-report`, who, { note: 'I used my old reference' })
    expect((await report(a.u)).statusCode).toBe(200)
    expect((await report(a.u)).json().error).toMatch(/already told us/)
    const other = await committed()
    expect((await report(other.u)).json().error).toBe('Not found.')
    expect((await mailTo(reviewer2.email)).some((m) => m.subject === 'A payment needs checking')).toBe(true)
    let qs = (await inject('GET', '/api/review/transfer-queries', reviewer)).json().rows as Array<{ id: string; kind: string; participation_id: string; status: string }>
    const wrong = qs.find((q) => q.participation_id === a.p && q.kind === 'wrong_reference')!
    expect(wrong.status).toBe('open')
    expect((await inject('POST', `/api/review/transfer-queries/${wrong.id}/decide`, reviewer, { decision: 'approved', note: 'Found it' })).json().error).toMatch(/closed once/)
    expect((await inject('POST', `/api/review/transfer-queries/${wrong.id}/decide`, reviewer, { decision: 'closed', note: 'Found it and allocated' })).statusCode).toBe(200)
    // R-PAY-08: someone else paid; listed, and only a reviewer approves
    await receive(a.p, 1000n, 'Uncle Bob')
    await receive(a.p, 1000n, 'unknown')
    qs = (await inject('GET', '/api/review/transfer-queries', reviewer)).json().rows
    const third = qs.filter((q) => q.participation_id === a.p && q.kind === 'third_party')
    expect(third).toHaveLength(1)
    const admin2 = await staff(unique('moneyadmin'), ['admin'])
    expect((await inject('POST', `/api/review/transfer-queries/${third[0]!.id}/decide`, admin2, { decision: 'approved', note: 'Family member' })).json().error).toMatch(
      /Only a reviewer/,
    )
    expect((await inject('POST', `/api/review/transfer-queries/${third[0]!.id}/decide`, reviewer, { decision: 'closed', note: 'Family member' })).json().error).toMatch(
      /approved or declined/,
    )
    expect((await inject('POST', `/api/review/transfer-queries/${third[0]!.id}/decide`, reviewer, { decision: 'approved', note: 'Family member' })).statusCode).toBe(200)
    expect((await inject('POST', `/api/review/transfer-queries/${third[0]!.id}/decide`, reviewer2, { decision: 'declined', note: 'Changed mind' })).json().error).toMatch(
      /already been decided/,
    )
    // and the database keeps it decided: not re-decided, given other evidence, or reopened
    for (const sql of [
      "UPDATE payment_query SET status = 'declined' WHERE id = $1",
      "UPDATE payment_query SET decision_note = 'Other evidence' WHERE id = $1",
      "UPDATE payment_query SET status = 'open', decided_by = NULL, decided_at = NULL, decision_note = NULL WHERE id = $1",
    ])
      await expect(t.app.query(sql, [third[0]!.id]), sql).rejects.toThrow(/stays decided/)
    await expect(t.app.query("UPDATE payment_query SET decision_note = 'Other' WHERE id = $1", [wrong.id])).rejects.toThrow(/stays decided/)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action IN ('payment_query.raised', 'payment_query.closed', 'payment_query.approved')")).toBeGreaterThanOrEqual(4)
    // R-PAY-07: the instructions carry how to trace a payment that has not arrived
    const s = await committed()
    expect((await sign(s.u, s.p)).statusCode).toBe(200)
    expect((await instructions(s.u, s.p)).json().stuck_payment_help).toMatch(/MT103 .*UETR/)
  })
})

describe('D4 statement import, Goten read-back and roster (R-OPS-07, §5.7)', () => {
  async function committed(amount = '1000000', over: Record<string, unknown> = {}) {
    const deal = await liveDeal(lead, over)
    const inv = await investor(deal)
    expect((await commit(inv.u, deal, inv.entity, amount)).statusCode).toBe(200)
    const p = await pid(inv.u, deal)
    const q = (await t.owner.query<{ d: string; reference: string }>('SELECT cash_due_minor::text AS d, reference FROM participation WHERE id = $1', [p])).rows[0]!
    return { deal, p, due: BigInt(q.d), reference: q.reference, ...inv }
  }
  /** Another investor in the same deal. */
  async function another(deal: string, amount = '1000000') {
    const inv = await investor(deal)
    expect((await commit(inv.u, deal, inv.entity, amount)).statusCode).toBe(200)
    const p = await pid(inv.u, deal)
    return { p, ...inv }
  }
  const onHand = async (p: string) =>
    BigInt(
      (
        await t.owner.query<{ n: string }>(
          `SELECT ((SELECT coalesce(sum(amount_minor - moved_out_minor), 0) FROM receipt WHERE participation_id = $1 AND reversed_at IS NULL)
                 - (SELECT coalesce(sum(CASE WHEN state = 'recorded' THEN actual_minor WHEN state IN ('approved', 'sent') THEN amount_minor ELSE 0 END), 0)
                      FROM refund_payment WHERE participation_id = $1))::text AS n`,
          [p],
        )
      ).rows[0]!.n,
    )
  const money = (m: bigint) => `${m / 100n}.${String(m % 100n).padStart(2, '0')}`
  const statement = (rows: Array<[string, string, bigint, string, string] | [string, string, bigint, string, string, string]>, withCurrency = false) =>
    [
      withCurrency ? 'transaction_id,date,amount,payer,reference,currency' : 'transaction_id,date,amount,payer,reference',
      ...rows.map(([id, date, amount, payer, ref, ccy]) => [id, date, money(amount), payer, ref, ...(withCurrency ? [ccy ?? ''] : [])].join(',')),
    ].join('\n')
  const ledgerCsv = (rows: Array<[string, bigint, string, string, string]>) =>
    [
      'transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency',
      ...rows.map(([id, amount, status, investorId, payer]) => [id, '2026-11-10', money(amount), payer, 'REF', status, investorId, 'Name', 'auto', '', 'GBP'].join(',')),
    ].join('\n')
  const accounts = async () => (await inject('GET', '/api/review/receiving-accounts', reviewer)).json().accounts as Array<{ account: string; currency: string }>
  const gbp = async () => (await accounts()).find((a) => a.currency === 'GBP')!.account
  type Row = { n: number; kind: string; participation_id: string | null; receipt_id: string | null; reason?: string; pair_with?: string[]; late?: boolean; amount_minor: string | null }
  const importStatement = async (csv: string, account?: string) => {
    const r = await inject('POST', '/api/review/statement-imports', reviewer, { account: account ?? (await gbp()), csv })
    expect(r.statusCode, r.body).toBe(200)
    return r.json() as { import_id: string; rows: Row[]; already_imported: number[]; errors?: unknown[] }
  }
  const decide = (imp: string, n: number, decision: string, extra: Record<string, unknown> = {}, who = reviewer) =>
    inject('POST', `/api/review/imports/${imp}/rows/${n}`, who, { decision, ...extra })
  async function receive(p: string, amount: bigint) {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, { amount_minor: String(amount), received_on: '2026-11-10', payer_name: 'Fay Fictional', payer_account: '12345678' })
    expect(r.statusCode, r.body).toBe(200)
    return r.json().id as string
  }

  it('TC-OPS-06 the receiving account first; its currency only: a reference to a EUR deal or a EUR currency cell goes to unallocated, N unchanged', async () => {
    const eur = await committed('1000000', { terms: { ...(draftFor('x').terms as object), currency: 'EUR' } })
    const g = await committed()
    const none = await inject('POST', '/api/review/statement-imports', reviewer, { csv: statement([['', '2026-11-10', 1_000_000n, 'Fay', eur.reference]]) })
    expect([none.statusCode, none.json().error]).toEqual([409, expect.stringMatching(/receiving account/)])
    expect((await accounts()).map((a) => a.currency).sort()).toEqual(['EUR', 'GBP', 'USD'])
    const r = await importStatement(statement([['', '2026-11-10', 1_000_000n, 'Fay', eur.reference]]))
    expect(r.rows).toMatchObject([{ kind: 'unallocated', reason: 'deal_currency', amount_minor: '1000000' }])
    // a currency cell naming another currency, with a GBP person's reference
    const c = await importStatement(statement([['X-EUR-1', '2026-11-10', 500_000n, 'Fay', g.reference, 'EUR']], true))
    expect(c.rows).toMatchObject([{ kind: 'unallocated', reason: 'currency_column' }])
    expect([await onHand(eur.p), await onHand(g.p)]).toEqual([0n, 0n])
    // decided: the money is listed in pounds, the account's currency, never as euros
    const d = await decide(r.import_id, 1, 'unallocated')
    expect(d.statusCode, d.body).toBe(200)
    const u = (await t.owner.query<{ currency: string; amount_minor: string }>('SELECT currency, amount_minor FROM unallocated_receipt WHERE id = $1', [d.json().unallocated_id])).rows[0]
    expect(u).toEqual({ currency: 'GBP', amount_minor: '1000000' })
    expect(await onHand(eur.p)).toBe(0n)
    // a match cannot be recorded into the other deal either
    expect((await decide(c.import_id, 1, 'record')).statusCode).toBe(409)
  })

  it('TC-OPS-06 three references in one file: each matched, nothing counts before a person confirms; unknown and several go to unallocated; a second import counts nothing twice', async () => {
    const a = await committed()
    const b = await another(a.deal)
    const c = await committed()
    const refOf = async (p: string) => (await t.owner.query<{ reference: string }>('SELECT reference FROM participation WHERE id = $1', [p])).rows[0]!.reference
    const bRef = await refOf(b.p)
    const csv = statement([
      ['', '2026-11-10', a.due, 'Fay Fictional', `INV ${a.reference}`],
      ['', '2026-11-10', 300_000n, 'Fay Fictional', `${bRef} and ${c.reference}`],
      ['', '2026-11-10', 400_000n, 'Fay Fictional', c.reference.toLowerCase()],
      ['', '2026-11-10', 700_000n, 'Somebody', 'no reference here'],
    ])
    const r = await importStatement(csv)
    expect(r.rows.map((x) => [x.kind, x.participation_id ?? x.reason])).toEqual([
      ['match', a.p],
      ['unallocated', 'several'],
      ['match', c.p],
      ['unallocated', 'no_match'],
    ])
    expect([await onHand(a.p), await onHand(b.p), await onHand(c.p)]).toEqual([0n, 0n, 0n])
    expect((await decide(r.import_id, 1, 'record')).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(a.due)
    expect((await decide(r.import_id, 1, 'record')).json().error).toMatch(/already been decided/)
    expect((await decide(r.import_id, 1 + 1, 'record')).json().error).toMatch(/not a choice/)
    // the same file again: the confirmed line is known; the others are offered again, never counted twice
    const again = await importStatement(csv)
    expect(again.already_imported).toEqual([2])
    expect(again.rows.map((x) => x.kind)).toEqual(['unallocated', 'match', 'unallocated'])
    // the first import's undecided row and the second's are one line: only one person can take it
    expect((await decide(r.import_id, 3, 'record')).statusCode).toBe(200)
    expect((await decide(again.import_id, 2, 'record')).json().error).toMatch(/taken in already/)
    expect(await onHand(c.p)).toBe(400_000n)
    // a statement is only a period: a later file without these lines offers nothing to undo
    const later = await importStatement(statement([['', '2026-11-12', 1_000n, 'Somebody', 'nothing']]))
    expect(later.rows.map((x) => x.kind)).toEqual(['unallocated'])
    // a line a person says is not money to count is remembered as looked at
    expect((await decide(later.import_id, 1, 'skip')).statusCode).toBe(200)
    expect((await importStatement(statement([['', '2026-11-12', 1_000n, 'Somebody', 'nothing']]))).already_imported).toEqual([2])
  })

  it('TC-OPS-06 the same transfer recorded by hand: offered as a pair, counted once; recorded money stores the account currency', async () => {
    const a = await committed()
    const hand = await receive(a.p, 250_000n)
    const r = await importStatement(statement([['BANK-77', '2026-11-10', 250_000n, 'Fay Fictional', a.reference]]))
    expect(r.rows[0]).toMatchObject({ kind: 'match', pair_with: [hand], late: false })
    // what the screen shows to say "the same transfer"
    expect((r.rows[0] as unknown as { pair_details: unknown }).pair_details).toEqual([
      { id: hand, received_on: '2026-11-10', amount_minor: '250000', payer_name: 'Fay Fictional', source: 'manual' },
    ])
    expect((await decide(r.import_id, 1, 'pair', { receipt_id: randomUUID() })).json().error).toMatch(/cannot be paired/)
    expect((await decide(r.import_id, 1, 'pair', { receipt_id: hand })).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(250_000n)
    // the same transfer read back from Goten too: still offered as a pair, still counted once
    const gl = await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, {
      ledger_name: 'Main',
      csv: ledgerCsv([['G1', 250_000n, 'confirmed', a.p, 'Fay Fictional']]),
    })
    expect(gl.statusCode, gl.body).toBe(200)
    expect(gl.json().rows[0]).toMatchObject({ kind: 'added', pair_with: [hand] })
    expect((await decide(gl.json().import_id, 1, 'pair', { receipt_id: hand })).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(250_000n)
    // the statement's own line is already on that receipt: the bank line again is not new
    expect((await importStatement(statement([['BANK-77', '2026-11-10', 250_000n, 'Fay Fictional', a.reference]]))).rows).toEqual([])
    // another transfer of the same amount in that account: the receipt already has this account's line, so it is not offered
    expect((await importStatement(statement([['BANK-79', '2026-11-12', 250_000n, 'Fay Fictional', a.reference]]))).rows[0]).toMatchObject({ kind: 'match', pair_with: [] })
    // money recorded from a statement keeps the account's currency and says where it came from (`settled` and its late money are D5; lib tests)
    const more = await importStatement(statement([['BANK-78', '2026-11-11', 10_000n, 'Fay Fictional', a.reference]]))
    expect(more.rows[0]).toMatchObject({ kind: 'match', late: false, pair_with: [] })
    const d = await decide(more.import_id, 1, 'record')
    expect(d.statusCode, d.body).toBe(200)
    const rc = (await t.owner.query<{ currency: string; source: string }>('SELECT currency, source FROM receipt WHERE id = $1', [d.json().receipt_id])).rows[0]
    expect(rc).toEqual({ currency: 'GBP', source: 'statement' })
  })

  it('TC-IO-02 read-back: unbooked lines do not count; re-import counts nothing twice; two identical transfers count twice; ledgers do not clash; pair, then undo only on a person’s word', async () => {
    const a = await committed('2000000')
    const b = await another(a.deal)
    const hand = await receive(a.p, 500_000n)
    const handB = await receive(b.p, 123_400n)
    const file1 = ledgerCsv([
      ['T1', 500_000n, 'auto', a.p, 'Fay Fictional'],
      ['T2', 500_000n, 'confirmed', a.p, 'Fay Fictional'],
      ['', 200_000n, 'confirmed', b.p, 'Fay Fictional'],
      ['', 200_000n, 'confirmed', b.p, 'Fay Fictional'],
      ['T9', 900_000n, 'suggested', '', 'Fay Fictional'],
    ])
    const up = await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_name: 'Main', csv: file1 })
    expect(up.statusCode, up.body).toBe(200)
    const r = up.json() as { import_id: string; ledger_id: string; rows: Row[]; not_booked: number[]; unpaired_manual: string[] }
    expect(r.rows.map((x) => [x.kind, x.participation_id, x.amount_minor])).toEqual([
      ['added', a.p, '500000'],
      ['added', a.p, '500000'],
      ['added', b.p, '200000'],
      ['added', b.p, '200000'],
    ])
    expect(r.not_booked).toEqual([6])
    expect(r.rows[0]!.pair_with).toEqual([hand])
    expect(r.unpaired_manual.sort()).toEqual([hand, handB].sort())
    expect(await onHand(a.p)).toBe(500_000n)
    expect((await decide(r.import_id, 1, 'pair', { receipt_id: hand })).statusCode).toBe(200)
    for (const n of [2, 3, 4]) expect((await decide(r.import_id, n, 'record')).statusCode).toBe(200)
    // hand £5,000 + ledger £5,000 (the same) + £5,000 = £10,000; two identical transfers on one day are two
    expect([await onHand(a.p), await onHand(b.p)]).toEqual([1_000_000n, 123_400n + 400_000n])
    // the same file again: nothing new
    const again = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_id: r.ledger_id, csv: file1 })).json()
    expect([again.rows, again.unchanged, again.unpaired_manual]).toEqual([[], 4, [handB]])
    expect((await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_name: 'Main', csv: file1 })).json().error).toMatch(/already has a ledger/)
    // another ledger with the same transaction ID: no clash
    const other = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_name: 'Second', csv: ledgerCsv([['T1', 500_000n, 'auto', a.p, 'X']]) })).json()
    expect(other.rows.map((x: Row) => x.kind)).toEqual(['added'])
    // a corrected import without T2 and without T1: offered to undo, nothing changes until a person confirms
    const fixed = (
      await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, {
        ledger_id: r.ledger_id,
        csv: ledgerCsv([
          ['', 200_000n, 'confirmed', b.p, 'Fay Fictional'],
          ['', 200_000n, 'confirmed', b.p, 'Fay Fictional'],
        ]),
      })
    ).json() as { import_id: string; rows: Row[] }
    expect(fixed.rows.map((x) => x.kind)).toEqual(['gone', 'gone'])
    expect(await onHand(a.p)).toBe(1_000_000n)
    const goneHand = fixed.rows.find((x) => x.receipt_id === hand)!
    const goneT2 = fixed.rows.find((x) => x.receipt_id !== hand)!
    expect((await decide(fixed.import_id, goneT2.n, 'reverse')).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(500_000n)
    // the hand record was only paired: the pairing ends, the record stays
    expect((await decide(fixed.import_id, goneHand.n, 'reverse')).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(500_000n)
    // a changed line: another amount under the same ID reverses the old receipt and takes the new one, once confirmed
    const changed = (
      await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_id: r.ledger_id, csv: ledgerCsv([['T1', 600_000n, 'auto', a.p, 'X']]) })
    ).json() as { import_id: string; rows: Row[] }
    expect(changed.rows.map((x) => x.kind).sort()).toEqual(['added', 'gone', 'gone'])
  })

  it('TC-IO-02 a changed ledger line is undone and replaced only when confirmed; not by someone with a stake', async () => {
    const a = await committed()
    const first = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_name: 'L', csv: ledgerCsv([['T1', 300_000n, 'auto', a.p, 'X']]) })).json()
    const twice = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_id: first.ledger_id, csv: ledgerCsv([['T1', 300_000n, 'auto', a.p, 'X']]) })).json()
    expect((await decide(first.import_id, 1, 'record')).statusCode).toBe(200)
    // the same line proposed by two imports before either was decided counts once
    expect((await decide(twice.import_id, 1, 'record')).json().error).toMatch(/taken in already/)
    const next = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_id: first.ledger_id, csv: ledgerCsv([['T1', 350_000n, 'auto', a.p, 'X']]) })).json()
    expect(next.rows).toMatchObject([{ kind: 'changed', amount_minor: '350000', receipt_id: expect.any(String) }])
    expect(await onHand(a.p)).toBe(300_000n)
    expect((await decide(next.import_id, 1, 'record')).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(350_000n)
    // the lead has a stake (and no money role)
    expect((await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, lead, { ledger_id: first.ledger_id, csv: ledgerCsv([]) })).statusCode).toBe(403)
  })

  it('TC-IO-02 a changed line paired with a hand record: the new amount is not recorded on top; reversed by hand first, then taken in once', async () => {
    const a = await committed()
    const hand = await receive(a.p, 100_000n)
    const first = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_name: 'L', csv: ledgerCsv([['T1', 100_000n, 'auto', a.p, 'X']]) })).json()
    expect((await decide(first.import_id, 1, 'pair', { receipt_id: hand })).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(100_000n)
    // Goten now books T1 at £900: the hand £1,000 stays, so recording £900 as well would make £1,900
    const next = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_id: first.ledger_id, csv: ledgerCsv([['T1', 90_000n, 'auto', a.p, 'X']]) })).json()
    expect(next.rows).toMatchObject([{ kind: 'changed', receipt_id: hand, amount_minor: '90000' }])
    expect((await decide(next.import_id, 1, 'record')).json().error).toMatch(/paired with money recorded another way/)
    expect(await onHand(a.p)).toBe(100_000n)
    // the person puts the hand record right, then the ledger's amount is taken in once
    expect((await inject('POST', `/api/review/receipts/${hand}/reverse`, reviewer, { reason: 'Goten has the right amount' })).statusCode).toBe(200)
    const again = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_id: first.ledger_id, csv: ledgerCsv([['T1', 90_000n, 'auto', a.p, 'X']]) })).json()
    const row = (again.rows as Row[]).find((x) => x.amount_minor === '90000')!
    expect((await decide(again.import_id, row.n, 'record')).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(90_000n)
  })

  it('TC-IO-02 a paired line gone and back at another amount: not recorded on top of the hand record that stayed; after its reversal taken in once', async () => {
    const a = await committed()
    const hand = await receive(a.p, 100_000n)
    const first = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_name: 'L', csv: ledgerCsv([['T1', 100_000n, 'auto', a.p, 'X']]) })).json()
    expect((await decide(first.import_id, 1, 'pair', { receipt_id: hand })).statusCode).toBe(200)
    // T1 leaves the ledger: ending the pairing keeps the hand £1,000
    const gone = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_id: first.ledger_id, csv: ledgerCsv([['T2', 5_000n, 'auto', a.p, 'X']]) })).json()
    const goneRow = (gone.rows as Row[]).find((x) => x.kind === 'gone')!
    expect((await decide(gone.import_id, goneRow.n, 'reverse')).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(100_000n)
    // T1 comes back at £900, now a new line: recording it as well would make £1,900
    const back = (await inject('POST', `/api/review/deals/${a.deal}/ledger-imports`, reviewer, { ledger_id: first.ledger_id, csv: ledgerCsv([['T1', 90_000n, 'auto', a.p, 'X']]) })).json()
    const t1 = (back.rows as Row[]).find((x) => x.amount_minor === '90000')!
    expect(t1.kind).toBe('added')
    expect((await decide(back.import_id, t1.n, 'record')).json().error).toMatch(/paired with money recorded another way, which still counts/)
    expect(await onHand(a.p)).toBe(100_000n)
    expect((await inject('POST', `/api/review/receipts/${hand}/reverse`, reviewer, { reason: 'Goten has the right amount' })).statusCode).toBe(200)
    expect((await decide(back.import_id, t1.n, 'record')).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(90_000n)
  })

  it('TC-OPS-06 someone with a stake in the matched deal decides nothing about a statement line: not record, set aside or skip', async () => {
    const a = await committed()
    const staked = await staff(unique('staked'), ['reviewer'])
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [a.deal, staked.id])
    const r = await importStatement(statement([['', '2026-11-10', 100_000n, 'Fay Fictional', a.reference]]))
    expect(r.rows).toMatchObject([{ kind: 'match', participation_id: a.p }])
    for (const choice of ['record', 'unallocated', 'skip'])
      expect((await decide(r.import_id, 1, choice, {}, staked)).json().error, choice).toMatch(/deal you lead, work on/)
    expect(await count('SELECT count(*) AS n FROM imported_line WHERE import_id = $1', [r.import_id])).toBe(0)
    expect((await decide(r.import_id, 1, 'record')).statusCode).toBe(200)
    expect(await onHand(a.p)).toBe(100_000n)
  })

  it('TC-IO-01 TC-IO-03 roster: issued references exported, terminal people flagged refund_only, no reference named, refunds warned', async () => {
    const a = await committed()
    await sign(a.u, a.p)
    expect((await instructions(a.u, a.p)).statusCode).toBe(200)
    const b = await another(a.deal)
    const c = await another(a.deal)
    await sign(c.u, c.p)
    expect((await instructions(c.u, c.p)).statusCode).toBe(200)
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = clock_timestamp() WHERE id = $1", [c.p])
    await receive(c.p, 100_000n)
    const prep = await inject('POST', `/api/review/participations/${c.p}/refunds`, reviewer, { amount_minor: '100000' })
    expect(prep.statusCode, prep.body).toBe(200)
    expect((await inject('POST', `/api/review/refunds/${prep.json().id}/approve`, reviewer2)).statusCode).toBe(200)
    const r = await inject('GET', `/api/review/deals/${a.deal}/roster`, reviewer)
    expect(r.statusCode, r.body).toBe(200)
    const out = r.json()
    const lines = (out.csv as string).trimEnd().split('\r\n')
    expect(lines[0]).toBe('investor_id,name,email,reference,cash_due,scheme,refund_only,currency')
    expect(lines.slice(1).map((l) => [l.split(',')[0], l.split(',')[6]])).toEqual([
      [a.p, ''],
      [c.p, 'yes'],
    ])
    expect(out.no_reference).toEqual([b.p])
    expect(out.refund_warnings).toEqual([{ participation_id: c.p, refunded_minor: '100000', bulma_short_minor: expect.any(String), goten_short_minor: expect.any(String) }])
    expect(out.refund_only_note).toMatch(/by hand/)
  })
})

void clock

describe('D4 lead lifecycle: closing asked for, removal, withdrawal, cancellation (§5.1, R-WDR-01..05, R-CLS-01)', () => {
  const stateOf = async (deal: string) => (await t.owner.query<{ state: string }>('SELECT state FROM deal WHERE id = $1', [deal])).rows[0]!.state
  const outcomeOf = async (p: string) => (await t.owner.query<{ outcome: string }>('SELECT outcome FROM participation WHERE id = $1', [p])).rows[0]!.outcome
  const validInstruction = (p: string) => count('SELECT count(*) AS n FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL', [p])
  async function committed(deal: string, amount = '1000000') {
    const x = await investor(deal)
    expect((await commit(x.u, deal, x.entity, amount)).statusCode).toBe(200)
    return { ...x, p: await pid(x.u, deal) }
  }
  async function withInstructions(deal: string) {
    const x = await committed(deal)
    expect((await sign(x.u, x.p)).statusCode).toBe(200)
    expect((await instructions(x.u, x.p)).statusCode).toBe(200)
    return x
  }
  async function receive(p: string, amount: string) {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: amount,
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '12345678',
    })
    expect(r.statusCode, r.body).toBe(200)
  }
  const remove = (deal: string, p: string, body: Record<string, unknown> = {}, who = lead) => inject('POST', `/api/deals/${deal}/participations/${p}/remove`, who, body)
  const askWithdrawal = (deal: string, p: string, body: Record<string, unknown>, who = lead) =>
    inject('POST', `/api/deals/${deal}/participations/${p}/withdrawal`, who, body)
  const CONSENT = { consent_confirmed: true, evidence: 'Email from the investor, 10 Nov 2026: "Please take me out of this deal."' }
  /** The company checked and the lead's own entity passed: what R-CLS-01 needs before D5. */
  async function readyToClose(deal: string) {
    await t.owner.query(
      "UPDATE investee_company SET verified_at = now(), verified_until = '2027-12-31' WHERE id = (SELECT company_id FROM investee WHERE deal_id = $1)",
      [deal],
    )
    await t.owner.query("UPDATE investee SET status = 'approved', decided_at = now() WHERE deal_id = $1", [deal])
    await passKyc(leadEntities.get(lead.id)!)
  }

  it('TC-GATE-06 one entity removed while another of the same person stays in: the invitation stays and the deal is still shown', async () => {
    const deal = await liveDeal(lead)
    const a = await committed(deal)
    const second = await newEntity(a.u, 'Fay Fictional Ltd')
    await passKyc(second)
    expect((await commit(a.u, deal, second, '1000000')).statusCode).toBe(200)
    const parts = (await t.owner.query<{ id: string; invitation_id: string }>('SELECT id, invitation_id FROM participation WHERE user_id = $1 ORDER BY join_seq', [a.u.id])).rows
    expect(parts).toHaveLength(2)
    expect((await inject('POST', `/api/deals/${deal}/participations/${parts[0]!.id}/remove`, lead, {})).statusCode).toBe(200)
    expect((await t.owner.query('SELECT state FROM deal_invitation WHERE id = $1', [parts[0]!.invitation_id])).rows[0]!.state).toBe('active')
    expect((await inject('GET', `/api/my/deals/${deal}`, a.u)).statusCode).toBe(200)
    // and when the last one goes, the invitation ends
    expect((await inject('POST', `/api/deals/${deal}/participations/${parts[1]!.id}/remove`, lead, {})).statusCode).toBe(200)
    expect((await t.owner.query('SELECT state FROM deal_invitation WHERE id = $1', [parts[0]!.invitation_id])).rows[0]!.state).toBe('revoked')
  })

  it('TC-WDR-01 removal only before money; after "I have paid" the lead confirms first; instructions voided with the urgent mail; not in closing', async () => {
    const deal = await liveDeal(lead)
    // committed, nothing issued: removed with a plain notice, the invitation ends
    const a = await committed(deal)
    const r = await remove(deal, a.p, { reason: 'Asked to step back' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await outcomeOf(a.p)).toBe('removed')
    expect(await count("SELECT count(*) AS n FROM deal_invitation WHERE deal_id = $1 AND user_id = $2 AND state = 'revoked'", [deal, a.u.id])).toBe(1)
    expect((await mailTo(a.u.email)).map((m) => m.subject).some((s) => s.startsWith('Your commitment to this deal has ended'))).toBe(true)
    expect((await remove(deal, a.p)).json().error).toMatch(/already ended/)
    // another deal's participation is not found through this one
    const other = await liveDeal(lead)
    expect((await remove(other, (await committed(deal)).p)).json().error).toBe('Not found.')
    // instructions issued: voided in the same move, with the urgent "do not pay" mail
    const b = await withInstructions(deal)
    // "I have paid": the lead must say they checked the money first
    expect((await inject('POST', `/api/my/participations/${b.p}/paid`, b.u, {})).statusCode).toBe(200)
    expect((await remove(deal, b.p)).json().error).toMatch(/check where the money is/)
    expect((await remove(deal, b.p, { money_checked: true })).statusCode).toBe(200)
    expect(await validInstruction(b.p)).toBe(0)
    expect((await mailTo(b.u.email)).map((m) => m.subject).some((s) => s.startsWith('Do not send money'))).toBe(true)
    expect((await instructions(b.u, b.p)).statusCode).not.toBe(200)
    expect(await count("SELECT count(*) AS n FROM notification_outbox WHERE user_id = $1 AND audience = 'urgent' AND deal_id = $2", [b.u.id, deal])).toBe(1)
    // money arrived: a withdrawal, not a removal
    const c = await committed(deal)
    await receive(c.p, '1000000')
    expect((await remove(deal, c.p, { money_checked: true })).json().error).toMatch(/withdrawal/)
    // §5.1: not in `closing` (exclusion is D5's), still in `closing_requested`
    const d1 = await committed(deal)
    await t.owner.query("UPDATE deal SET state = 'closing' WHERE id = $1", [deal])
    expect((await remove(deal, d1.p)).json().error).toMatch(/Nobody can be removed/)
    await t.owner.query("UPDATE deal SET state = 'closing_requested' WHERE id = $1", [deal])
    expect((await remove(deal, d1.p)).statusCode).toBe(200)
    await t.owner.query("UPDATE deal SET state = 'live' WHERE id = $1", [deal])
  })

  it('TC-WDR-02 withdrawal needs money and written consent; a reviewer with no stake accepts; only then a refund to-do; limited by the state table', async () => {
    const deal = await liveDeal(lead)
    const a = await withInstructions(deal)
    expect((await askWithdrawal(deal, a.p, CONSENT)).json().error).toMatch(/remove them instead/)
    await receive(a.p, '600000')
    expect((await askWithdrawal(deal, a.p, { ...CONSENT, consent_confirmed: false })).json().error).toMatch(/written consent/)
    expect((await askWithdrawal(deal, a.p, { ...CONSENT, evidence: ' ' })).json().error).toMatch(/where the written consent is/)
    const asked = await askWithdrawal(deal, a.p, CONSENT)
    expect(asked.statusCode, asked.body).toBe(200)
    expect((await askWithdrawal(deal, a.p, CONSENT)).json().error).toMatch(/already waiting/)
    // nothing changes before a reviewer accepts: still active, nothing due back
    expect(await outcomeOf(a.p)).toBe('active')
    const due = async () =>
      (await inject('GET', '/api/review/refunds', reviewer)).json().rows.find((r: { participation_id: string }) => r.participation_id === a.p)?.refund_due_minor
    expect(await due()).toBeUndefined()
    // the lead cannot accept; a reviewer who invests in the deal does not see it and cannot accept
    const id = asked.json().id as string
    expect((await inject('POST', `/api/review/withdrawals/${id}/accept`, lead, {})).statusCode).toBe(403)
    const rv = await staff(unique('rvinv'), ['reviewer'])
    const theirEntity = await newEntity(rv, 'Rita Reviewer')
    await passKyc(theirEntity)
    await t.owner.query(
      "INSERT INTO participation (id, invitation_id, deal_id, user_id, entity_id, entity_version, commitment_minor, invest_minor, lead_fee_minor, rounding_minor, cash_due_minor, reference, reference_norm) SELECT $1, invitation_id, deal_id, $2, $3, 1, 1000000, 1000000, 0, 0, 1000000, 'RV-ABCDEF', 'RVABCDEF' FROM participation WHERE id = $4",
      [randomUUID(), rv.id, theirEntity, a.p],
    )
    expect((await inject('GET', '/api/review/withdrawals', rv)).json().withdrawals.some((w: { id: string }) => w.id === id)).toBe(false)
    expect((await inject('POST', `/api/review/withdrawals/${id}/accept`, rv, {})).json().error).toMatch(/invest in/)
    expect((await inject('GET', '/api/review/withdrawals', reviewer)).json().withdrawals.some((w: { id: string }) => w.id === id)).toBe(true)
    const ok = await inject('POST', `/api/review/withdrawals/${id}/accept`, reviewer, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await outcomeOf(a.p)).toBe('withdrawn')
    expect(await validInstruction(a.p)).toBe(0)
    expect(await due()).toBe('600000')
    expect((await inject('POST', `/api/review/withdrawals/${id}/accept`, reviewer, {})).json().error).toMatch(/already been decided/)
    // declined: stays in, with the note
    const b = await committed(deal)
    await receive(b.p, '100000')
    const id2 = (await askWithdrawal(deal, b.p, CONSENT)).json().id as string
    expect((await inject('POST', `/api/review/withdrawals/${id2}/decline`, reviewer, { note: 'The email is not from the investor' })).statusCode).toBe(200)
    expect(await outcomeOf(b.p)).toBe('active')
    // §5.1: not once the deal is cancelled (or closed); a reviewer may ask on the investor's behalf
    await t.owner.query("UPDATE deal SET state = 'cancelled' WHERE id = $1", [deal])
    expect((await inject('POST', `/api/review/participations/${b.p}/withdrawal`, reviewer, CONSENT)).json().error).toMatch(/cannot be recorded in this state/)
    await t.owner.query("UPDATE deal SET state = 'live' WHERE id = $1", [deal])
    expect((await inject('POST', `/api/review/participations/${b.p}/withdrawal`, reviewer, CONSENT)).statusCode).toBe(200)
    // the money reversed after asking: no longer a withdrawal
    const c = await committed(deal)
    await receive(c.p, '100000')
    const id3 = (await askWithdrawal(deal, c.p, CONSENT)).json().id as string
    await t.owner.query("UPDATE receipt SET reversed_at = now(), reverse_reason = 'test: wrong person', reversed_by = $2 WHERE participation_id = $1", [c.p, reviewer.id])
    expect((await inject('POST', `/api/review/withdrawals/${id3}/accept`, reviewer, {})).json().error).toMatch(/No money counts/)
    expect(await outcomeOf(c.p)).toBe('active')
    // the part ended another way first (a failed identity check): the ask lapses
    const e = await committed(deal)
    await receive(e.p, '100000')
    const id4 = (await askWithdrawal(deal, e.p, CONSENT)).json().id as string
    const caseId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [caseId, e.entity])
    expect((await inject('POST', `/api/review/kyc/${caseId}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })).statusCode).toBe(200)
    // lapsed in the same step, as every other end of a part does
    expect((await t.owner.query('SELECT decision FROM withdrawal_request WHERE id = $1', [id4])).rows[0]!.decision).toBe('lapsed')
    expect((await inject('POST', `/api/review/withdrawals/${id4}/accept`, reviewer, {})).json().error).toMatch(/already been decided/)
    expect(await outcomeOf(e.p)).toBe('rejected_kyc')
    // ended by the identity review (another entity) while the ask was open: that path leaves the ask, so accepting it lapses it
    // instead of ending the part a second time
    const f = await committed(deal)
    await receive(f.p, '100000')
    expect((await sign(f.u, f.p)).statusCode).toBe(200)
    const id5 = (await askWithdrawal(deal, f.p, CONSENT)).json().id as string
    await inject('PUT', `/api/entities/${f.entity}`, f.u, {
      fields: { full_name: 'Fay Renamed', address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' },
      parties: [],
    })
    expect((await inject('POST', `/api/review/participations/${f.p}/identity`, reviewer, { decision: 'other_entity', reason: 'checked' })).statusCode).toBe(200)
    expect(await outcomeOf(f.p)).toBe('withdrawn')
    const events = () => count("SELECT count(*) AS n FROM participation_event WHERE participation_id = $1 AND event = 'withdrawn'", [f.p])
    const before = await events()
    const lapsed = await inject('POST', `/api/review/withdrawals/${id5}/accept`, reviewer, {})
    expect(lapsed.statusCode, lapsed.body).toBe(200)
    expect(lapsed.json().outcome).toBe('lapsed')
    expect((await t.owner.query('SELECT decision FROM withdrawal_request WHERE id = $1', [id5])).rows[0]!.decision).toBe('lapsed')
    expect(await events()).toBe(before)
  })

  it('TC-DEAL-03 / TC-PAY-08 cancel: asked by the lead, confirmed by a reviewer; each investor case; held money stays held; archive waits for refunds and holds', async () => {
    const deal = await liveDeal(lead)
    const code = (await t.owner.query<{ public_code: string }>('SELECT public_code FROM deal WHERE id = $1', [deal])).rows[0]!.public_code
    // not committed: told
    const ls = await links(deal)
    const cookie = await open(tokenOf(await urlOf(deal, ls.find((l) => l.is_default && l.carry_bps === 2000)!.id)))
    const looker = await person(unique('look'), cookie)
    expect((await inject('POST', '/api/invite/accept', looker, {})).statusCode).toBe(200)
    const committedOnly = await committed(deal)
    const owing = await withInstructions(deal)
    const paid = await withInstructions(deal)
    await receive(paid.p, '1040000')
    // a KYC rejection with money: on hold before the cancellation, and still on hold after it
    const rejected = await committed(deal)
    await receive(rejected.p, '500000')
    const caseId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [caseId, rejected.entity])
    expect((await inject('POST', `/api/review/kyc/${caseId}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })).statusCode).toBe(200)

    // asked by the lead; the lead cannot confirm; a second ask waits
    const ask = await inject('POST', `/api/deals/${deal}/cancel-request`, lead, { reason: 'The company withdrew' })
    expect(ask.statusCode, ask.body).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/cancel-request`, lead, {})).json().error).toMatch(/already waiting/)
    const id = ask.json().id as string
    expect((await inject('POST', `/api/review/cancel-requests/${id}/confirm`, lead, {})).statusCode).toBe(403)
    expect(await stateOf(deal)).toBe('live')
    const ok = await inject('POST', `/api/review/cancel-requests/${id}/confirm`, reviewer, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toEqual({ state: 'cancelled', participations_ended: 3 })
    expect(await stateOf(deal)).toBe('cancelled')
    for (const x of [committedOnly, owing, paid]) expect(await outcomeOf(x.p)).toBe('deal_cancelled')
    expect(await outcomeOf(rejected.p)).toBe('rejected_kyc')
    // instructions voided with an urgent mail that says the deal is cancelled; the others get a plain notice
    expect(await validInstruction(owing.p)).toBe(0)
    expect((await mailTo(owing.u.email)).some((m) => m.subject === `Do not send money: this deal has been cancelled (deal ${code})`)).toBe(true)
    for (const x of [looker, committedOnly.u]) expect((await mailTo(x.email)).some((m) => m.subject.startsWith('This deal has been cancelled'))).toBe(true)
    // signed documents are kept
    expect(await count('SELECT count(*) AS n FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL', [paid.p])).toBe(1)
    // money received: a refund to-do with the reason; held money cannot be refunded until released
    const rows = (await inject('GET', '/api/review/refunds', reviewer2)).json().rows as Array<{ participation_id: string; reason: string; refund_due_minor: string; hold_minor: string }>
    expect(rows.find((r) => r.participation_id === paid.p)).toMatchObject({ reason: 'deal_cancelled', refund_due_minor: '1040000' })
    expect(await count("SELECT count(*) AS n FROM refund_todo_event WHERE participation_id = $1 AND kind = 'reason' AND value = 'deal_cancelled'", [paid.p])).toBe(1)
    expect(rows.find((r) => r.participation_id === rejected.p)).toMatchObject({ hold_minor: '500000' })
    expect((await inject('POST', `/api/review/participations/${rejected.p}/refunds`, reviewer, { amount_minor: '500000' })).statusCode).not.toBe(200)
    // archive waits for every refund and every hold
    expect((await inject('POST', `/api/review/deals/${deal}/archive`, reviewer, {})).json().error).toMatch(/Finish every refund/)
    const prep = await inject('POST', `/api/review/participations/${paid.p}/refunds`, reviewer, { amount_minor: '1040000' })
    expect(prep.statusCode, prep.body).toBe(200)
    expect((await inject('POST', `/api/review/refunds/${prep.json().id}/approve`, reviewer2, {})).statusCode).toBe(200)
    const rec = await inject('POST', `/api/review/participations/${paid.p}/refund-records`, reviewer, { actual_minor: '1040000', sent_on: '2026-11-11', refund_id: prep.json().id })
    expect(rec.statusCode, rec.body).toBe(200)
    expect((await inject('POST', `/api/review/deals/${deal}/archive`, reviewer, {})).json().error).toMatch(/hold/)
    await t.owner.query('UPDATE receipt SET reversed_at = now(), reverse_reason = $2, reversed_by = $3 WHERE participation_id = $1', [rejected.p, 'test: hold settled', reviewer.id])
    const arch = await inject('POST', `/api/review/deals/${deal}/archive`, reviewer, {})
    expect(arch.statusCode, arch.body).toBe(200)
    expect(await stateOf(deal)).toBe('archived')
  })

  it('TC-DEAL-03 a reviewer who asks needs a second person; a decline is told to the lead; not after the deal is cancelled', async () => {
    const deal = await liveDeal(lead)
    const ask = await inject('POST', `/api/review/deals/${deal}/cancel-request`, reviewer, {})
    expect(ask.statusCode, ask.body).toBe(200)
    const id = ask.json().id as string
    expect((await inject('POST', `/api/review/cancel-requests/${id}/confirm`, reviewer, {})).json().error).toMatch(/other than the person who asked/)
    expect((await inject('POST', `/api/review/cancel-requests/${id}/decline`, reviewer, { note: 'Changed my mind' })).json().error).toMatch(/other than/)
    expect((await inject('POST', `/api/review/cancel-requests/${id}/decline`, reviewer2, { note: 'Not a reason to cancel' })).statusCode).toBe(200)
    expect(await stateOf(deal)).toBe('live')
    const lead2 = await inject('POST', `/api/deals/${deal}/cancel-request`, lead, {})
    expect((await inject('POST', `/api/review/cancel-requests/${lead2.json().id}/decline`, reviewer, { note: 'Talk to us first' })).statusCode).toBe(200)
    expect((await mailTo(lead.email)).some((m) => m.subject === 'Your cancellation was not confirmed' && m.body.includes('Talk to us first'))).toBe(true)
    const again = (await inject('POST', `/api/deals/${deal}/cancel-request`, lead, {})).json().id as string
    expect((await inject('POST', `/api/review/cancel-requests/${again}/confirm`, reviewer2, {})).statusCode).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/cancel-request`, lead, {})).json().error).toMatch(/cannot be cancelled/)
  })

  it('TC-DEAL-03 a deal waiting for closing can still be cancelled: asked and confirmed from closing_requested', async () => {
    const deal = await liveDeal(lead)
    await committed(deal)
    await readyToClose(deal)
    const asked = await inject('POST', `/api/deals/${deal}/request-closing`, lead, { confirm: true })
    expect(asked.statusCode, asked.body).toBe(200)
    expect(await stateOf(deal)).toBe('closing_requested')
    const id = (await inject('POST', `/api/deals/${deal}/cancel-request`, lead, {})).json().id as string
    expect((await inject('POST', `/api/review/cancel-requests/${id}/confirm`, reviewer, {})).statusCode).toBe(200)
    expect(await stateOf(deal)).toBe('cancelled')
  })

  it('TC-WDR-04 the operator’s note on what cancelling may cost is shown to whoever asks and in the lead’s cancellation mail', async () => {
    const before = (await inject('GET', '/api/admin/policy', admin)).json()
    expect(before.cancel_fee_note).toBeNull()
    const { version: _v, ...current } = before
    const note = 'Cancelling during closing may carry a fee from the platform.'
    const put = await inject('PUT', '/api/admin/policy', admin, { ...current, cancel_fee_note: note })
    expect(put.statusCode, put.body).toBe(200)
    expect(put.json().requestId).toBeUndefined()
    expect((await inject('GET', '/api/admin/policy', admin)).json().cancel_fee_note).toBe(note)
    // left out keeps it
    const { cancel_fee_note: _n, ...without } = current
    expect((await inject('PUT', '/api/admin/policy', admin, { ...without, reminder_count: Math.max(0, current.reminder_count - 1) })).statusCode).toBe(200)
    expect((await inject('GET', '/api/admin/policy', admin)).json().cancel_fee_note).toBe(note)
    const deal = await liveDeal(lead)
    expect((await inject('GET', `/api/deals/${deal}/cancel-note`, lead)).json().cancel_fee_note).toBe(note)
    const ask = await inject('POST', `/api/deals/${deal}/cancel-request`, lead, {})
    expect(ask.json().cancel_fee_note).toBe(note)
    expect((await inject('POST', `/api/review/cancel-requests/${ask.json().id}/confirm`, reviewer, {})).statusCode).toBe(200)
    expect((await mailTo(lead.email)).some((m) => m.subject === 'Your deal has been cancelled' && m.body.includes(note))).toBe(true)
  })

  it('TC-INV-04 / TC-PAY-08 closing cannot be asked while the company is not checked; asking pauses links and stops commitments; taking it back resumes only those; a passed deadline voids nothing', async () => {
    const deal = await liveDeal(lead, { terms: { ...(draftFor('x').terms as object), pay_by: '2026-11-20' } })
    const owing = await withInstructions(deal)
    let gaps = (await inject('GET', `/api/deals/${deal}/closing`, lead)).json().gaps as string[]
    expect(gaps).toContain('The company has not confirmed the deal.')
    expect((await inject('POST', `/api/deals/${deal}/request-closing`, lead, { confirm: true })).json().error).toMatch(/company has not confirmed/)
    await readyToClose(deal)
    gaps = (await inject('GET', `/api/deals/${deal}/closing`, lead)).json().gaps
    expect(gaps).toEqual([])
    // a link the lead turned off stays off afterwards
    const made = await inject('POST', `/api/deals/${deal}/links`, lead, { kind: 'terms_only', carry_bps: 2000, fee: { kind: 'none' }, confirm: true })
    expect(made.statusCode, made.body).toBe(200)
    const off = { id: made.json().id as string }
    expect((await inject('POST', `/api/deals/${deal}/links/${off.id}/disable`, lead, {})).statusCode).toBe(200)
    type Usable = LinkView & { usable: boolean; disabled: boolean }
    // a hold is a gap too
    const hold = await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'Checking' })
    expect((await inject('POST', `/api/deals/${deal}/request-closing`, lead, { confirm: true })).json().error).toMatch(/compliance hold/)
    const holdId = (await t.owner.query<{ id: string }>('SELECT id FROM compliance_hold WHERE target_id = $1 AND released_at IS NULL', [deal])).rows[0]!.id
    expect(hold.statusCode).toBe(200)
    await t.owner.query('UPDATE compliance_hold SET released_at = now(), released_by = $2 WHERE id = $1', [holdId, reviewer2.id])
    const r = await inject('POST', `/api/deals/${deal}/request-closing`, lead, { confirm: true })
    expect(r.statusCode, r.body).toBe(200)
    expect(await stateOf(deal)).toBe('closing_requested')
    expect(await count('SELECT count(*) AS n FROM invite_link WHERE deal_id = $1 AND closing_paused_at IS NULL', [deal])).toBe(0)
    // no one new comes in while closing is asked for: every link is paused
    expect(((await links(deal)) as Usable[]).some((l) => l.usable)).toBe(false)
    // a passed payment deadline voids nothing (R-DRF-04: it only reminds)
    clock = new Date('2026-12-01T09:00:00.000Z')
    expect((await instructions(owing.u, owing.p)).statusCode).toBe(200)
    expect(await validInstruction(owing.p)).toBe(1)
    clock = new Date('2026-11-10T09:00:00.000Z')
    // taken back: links paused for closing come back, the one the lead turned off does not
    expect((await inject('POST', `/api/deals/${deal}/withdraw-closing`, lead, {})).statusCode).toBe(200)
    expect(await stateOf(deal)).toBe('live')
    const after = await links(deal)
    expect(after.find((l) => l.id === off.id)).toMatchObject({ disabled: true })
    const rest = (after as Usable[]).filter((l) => l.id !== off.id)
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every((l) => l.usable)).toBe(true)
    // a reviewer may take it back too; not from `live`
    expect((await inject('POST', `/api/deals/${deal}/request-closing`, lead, { confirm: true })).statusCode).toBe(200)
    expect((await inject('POST', `/api/review/deals/${deal}/withdraw-closing`, reviewer, {})).statusCode).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/withdraw-closing`, lead, {})).json().error).toMatch(/this state/)
  })
})

describe('D4 amount proposals, a full deal and the waiting list (R-ALO-01, R-ALO-03, R-ALO-04, R-LNK-11, §5.6)', () => {
  const validInstruction = (p: string) => count('SELECT count(*) AS n FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL', [p])
  const dueOf = async (p: string) => (await t.owner.query<{ d: string }>('SELECT cash_due_minor::text AS d FROM participation WHERE id = $1', [p])).rows[0]!.d
  const decisionOf = async (p: string) =>
    (await t.owner.query<{ decision: string | null }>('SELECT decision FROM amount_proposal WHERE participation_id = $1 ORDER BY created_at DESC LIMIT 1', [p]))
      .rows[0]?.decision
  const subjects = async (to: string) => (await mailTo(to)).map((m) => m.subject)
  const propose = (deal: string, p: string, amount: string, who = lead) =>
    inject('POST', `/api/deals/${deal}/participations/${p}/amount-proposal`, who, { commitment_minor: amount })
  const proposalOf = async (u: Client, p: string) => (await inject('GET', `/api/my/participations/${p}/amount-proposal`, u)).json().proposal
  async function accept(u: Client, p: string, quoted?: string) {
    const o = await proposalOf(u, p)
    return inject('POST', `/api/my/participations/${p}/amount-proposal/accept`, u, { proposal_id: o.id, quoted_due_minor: quoted ?? o.quote.due_minor })
  }
  async function receive(p: string, amount: string) {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: amount,
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '12345678',
    })
    expect(r.statusCode, r.body).toBe(200)
  }
  /** A link with its own fee, and an investor brought in on it by a targeted invitation. */
  async function feeLink(deal: string, fee: Record<string, unknown>) {
    const r = await inject('POST', `/api/deals/${deal}/links`, lead, { kind: 'terms_only', carry_bps: 0, fee, reason: 'x', confirm: true })
    expect(r.statusCode, r.body).toBe(200)
    return r.json().id as string
  }
  async function viaLink(deal: string, link: string) {
    const email = unique('feeinv')
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email, link_id: link })).statusCode).toBe(200)
    const token = /token=([\w-]+)/.exec((await mailTo(email))[0]!.body)![1]!
    const u = await person(email, await open(token))
    expect((await inject('POST', '/api/invite/accept', u, {})).json().results[0].result).toBe('invited')
    await qualify(u)
    const entity = await newEntity(u)
    await passKyc(entity)
    return { u, entity }
  }
  async function committed(deal: string, amount: string, link?: string) {
    const x = link ? await viaLink(deal, link) : await investor(deal)
    const r = await commit(x.u, deal, x.entity, amount)
    expect(r.statusCode, r.body).toBe(200)
    return { ...x, p: await pid(x.u, deal) }
  }
  /** A deal that stops at its allocation and keeps a waiting list. */
  const stopDeal = (allocation: string) =>
    liveDeal(lead, { terms: { ...draftFor('x').terms, allocation_minor: allocation, over_allocation: 'stop_and_waitlist' } })
  async function readyToClose(deal: string) {
    await t.owner.query(
      "UPDATE investee_company SET verified_at = now(), verified_until = '2027-12-31' WHERE id = (SELECT company_id FROM investee WHERE deal_id = $1)",
      [deal],
    )
    await t.owner.query("UPDATE investee SET status = 'approved', decided_at = now() WHERE deal_id = $1", [deal])
    await passKyc(leadEntities.get(lead.id)!)
  }
  const ON_TOP = { kind: 'percent', bps: 400, mode: 'on_top' }
  // earlier tests in this file tighten the operator's settings; links with their own fee are allowed again here
  beforeAll(async () => {
    await t.owner.query(
      `INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days, cancel_fee_note, amount_proposal_days, changed_by)
       SELECT version + 1, true, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days, cancel_fee_note, amount_proposal_days, $1
         FROM operator_policy ORDER BY version DESC LIMIT 1`,
      [reviewer.id],
    )
  })

  it('R-CLS-00 the closing page shows the allocation, money received, lead fees and estimated investment, the same figures as the panel', async () => {
    const deal = await liveDeal(lead)
    const a = await committed(deal, '2000000', await feeLink(deal, ON_TOP))
    await receive(a.p, '2080000')
    const c = (await inject('GET', `/api/deals/${deal}/closing`, lead)).json()
    const m = (await inject('GET', `/api/deals/${deal}/panel`, lead)).json().metrics
    expect(c.allocation_minor).toBe((await t.owner.query("SELECT draft->'terms'->>'allocation_minor' AS a FROM deal WHERE id = $1", [deal])).rows[0]!.a)
    // £20,800 received at 4% on top: £800 lead fee, £20,000 to invest before the platform fee
    expect(c).toMatchObject({ received_minor: '2080000', lead_fees_minor: '80000', estimated_investment_minor: '2000000' })
    expect(c).toMatchObject({ received_minor: m.received_minor, lead_fees_minor: m.lead_fees_minor, estimated_investment_minor: m.usable_gross_minor })
    expect(c.platform_fee_note).toMatch(/worked out at closing/)
  })

  it('TC-ALO-01 / TC-PAY-08 £20,000 proposed down to £10,000 with 4% on top: instruction voided; agreed → D £10,400; no reviewer, no change request; audited', async () => {
    const deal = await liveDeal(lead)
    const a = await committed(deal, '2000000', await feeLink(deal, ON_TOP))
    expect(await dueOf(a.p)).toBe('2080000')
    expect((await sign(a.u, a.p)).statusCode).toBe(200)
    expect((await instructions(a.u, a.p)).statusCode).toBe(200)
    const made = await propose(deal, a.p, '1000000')
    expect(made.statusCode, made.body).toBe(200)
    // R-PAY-03: void in the same move, with the urgent mail; the investor is asked, with a deadline and no amount
    expect(await validInstruction(a.p)).toBe(0)
    const s = await subjects(a.u.email)
    expect(s.some((x) => x.startsWith('Do not send money'))).toBe(true)
    const asked = (await mailTo(a.u.email)).find((m) => m.subject.startsWith('A new amount has been proposed'))!
    expect(asked.body).toMatch(/Deadline for this step: \d{4}-\d{2}-\d{2}/)
    expect(asked.body).not.toMatch(/10,400|10400|20,800/)
    expect((await propose(deal, a.p, '1500000')).json().error).toMatch(/already waiting/)
    // nothing new is issued, the person cannot change the amount themselves meanwhile, and the status says what to do
    expect((await instructions(a.u, a.p)).json().error).toMatch(/Answer that first/)
    expect((await change(a.u, deal, a.p, '2500000')).json().error).toMatch(/Answer that first/)
    expect((await inject('GET', `/api/my/deals/${deal}`, a.u)).json().participations[0].status).toBe('confirm_amount')
    // one screen: the new amount to pay, and the deal sheet signed again
    const o = await proposalOf(a.u, a.p)
    expect(o).toMatchObject({ current_due_minor: '2080000', proposed_commitment_minor: '1000000', sign_again: true })
    expect(o.quote.due_minor).toBe('1040000')
    expect((await accept(a.u, a.p, '1040001')).json().error).toMatch(/changed after you checked/)
    const ok = await accept(a.u, a.p)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().due_minor).toBe('1040000')
    expect(await dueOf(a.p)).toBe('1040000')
    expect(await decisionOf(a.p)).toBe('accepted')
    // signed again before the new instruction, which is for the new amount
    expect((await instructions(a.u, a.p)).statusCode).not.toBe(200)
    expect((await sign(a.u, a.p)).statusCode).toBe(200)
    expect((await instructions(a.u, a.p)).statusCode).toBe(200)
    expect(
      await count("SELECT count(*) AS n FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL AND cash_due_minor = 1040000", [a.p]),
    ).toBe(1)
    // R-LNK-03: the new amount and the agreement on the record; audited; no reviewer, the deal's version unchanged
    expect(await count("SELECT count(*) AS n FROM participation_event WHERE participation_id = $1 AND event = 'amount_agreed'", [a.p])).toBe(1)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action IN ('amount_proposal.made', 'participation.amount_agreed') AND entity_id IN ($1, $2)", [made.json().id, a.p])).toBe(2)
    expect(await count("SELECT count(*) AS n FROM review_event WHERE deal_id = $1 AND event NOT IN ('submit', 'approve', 'launch')", [deal])).toBe(0)
  })

  it('TC-ALO-01 declined, past the deadline (fixed clock), on asking for closing, or money arriving: the amount stays £20,800 and the instruction comes back', async () => {
    const deal = await liveDeal(lead)
    const link = await feeLink(deal, ON_TOP)
    // declined: the lead is told; the instruction is issued again at the original amount
    const a = await committed(deal, '2000000', link)
    expect((await sign(a.u, a.p)).statusCode).toBe(200)
    expect((await instructions(a.u, a.p)).statusCode).toBe(200)
    expect((await propose(deal, a.p, '1000000')).statusCode).toBe(200)
    const o = await proposalOf(a.u, a.p)
    expect((await inject('POST', `/api/my/participations/${a.p}/amount-proposal/decline`, a.u, { proposal_id: o.id })).statusCode).toBe(200)
    expect(await decisionOf(a.p)).toBe('declined')
    expect(await dueOf(a.p)).toBe('2080000')
    expect((await subjects(a.u.email)).some((x) => x.startsWith('The proposed new amount has ended'))).toBe(true)
    expect((await subjects(lead.email)).some((x) => x.startsWith('A proposed amount was declined'))).toBe(true)
    expect((await instructions(a.u, a.p)).statusCode).toBe(200)
    expect(
      await count("SELECT count(*) AS n FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL AND cash_due_minor = 2080000", [a.p]),
    ).toBe(1)
    // a decided proposal cannot be accepted afterwards
    expect((await inject('POST', `/api/my/participations/${a.p}/amount-proposal/accept`, a.u, { proposal_id: o.id, quoted_due_minor: '1040000' })).json().error).toMatch(
      /has ended/,
    )
    // past the deadline: ended as soon as anyone looks, and by the hourly run when nobody does
    const b = await committed(deal, '2000000', link)
    expect((await propose(deal, b.p, '1000000')).statusCode).toBe(200)
    const pending = await proposalOf(b.u, b.p)
    // the app's clock is fixed in these tests: a deadline long past
    await t.owner.query("UPDATE amount_proposal SET deadline_at = '2000-01-03' WHERE participation_id = $1 AND decision IS NULL", [b.p])
    // before anyone records the lapse, the status no longer asks the investor to confirm an amount
    const shown = (await inject('GET', `/api/my/deals/${deal}`, b.u)).json().participations[0]
    expect(shown.status).not.toBe('confirm_amount')
    expect(await decisionOf(b.p)).toBeNull()
    expect(await proposalOf(b.u, b.p)).toBeNull()
    expect(await decisionOf(b.p)).toBe('lapsed')
    expect((await inject('POST', `/api/my/participations/${b.p}/amount-proposal/accept`, b.u, { proposal_id: pending.id, quoted_due_minor: '1040000' })).json().error).toMatch(
      /has ended/,
    )
    expect(await dueOf(b.p)).toBe('2080000')
    const c = await committed(deal, '2000000', link)
    expect((await propose(deal, c.p, '3000000')).statusCode).toBe(200)
    const deadline = new Date(
      (await t.owner.query<{ at: Date }>('SELECT deadline_at AS at FROM amount_proposal WHERE participation_id = $1', [c.p])).rows[0]!.at,
    )
    const runAt = async (at: Date) => {
      const ob: OutboxDeps = { db: t.app, k: t.keyring, now: () => at, mailer: async () => new FakeOutbox(t.app) }
      await runReminders({ db: t.app, k: t.keyring, now: () => at, mail: mailQueue(ob, () => undefined) })
      while ((await drain(ob, 1000)) > 0);
    }
    await runAt(new Date(deadline.getTime() - 1000))
    expect(await decisionOf(c.p)).toBeNull()
    await runAt(deadline)
    expect(await decisionOf(c.p)).toBe('lapsed')
    expect(await dueOf(c.p)).toBe('2080000')
    // money arriving ends it
    const d1 = await committed(deal, '2000000', link)
    expect((await propose(deal, d1.p, '1000000')).statusCode).toBe(200)
    await receive(d1.p, '100000')
    expect(await decisionOf(d1.p)).toBe('money_arrived')
    expect(await dueOf(d1.p)).toBe('2080000')
    // asking for closing ends every open one
    const e = await committed(deal, '2000000', link)
    expect((await propose(deal, e.p, '1000000')).statusCode).toBe(200)
    await readyToClose(deal)
    const asked = await inject('POST', `/api/deals/${deal}/request-closing`, lead, { confirm: true })
    expect(asked.statusCode, asked.body).toBe(200)
    expect(await decisionOf(e.p)).toBe('closing_requested')
    expect(await dueOf(e.p)).toBe('2080000')
    expect((await inject('POST', `/api/deals/${deal}/withdraw-closing`, lead, {})).statusCode).toBe(200)
  })

  it('TC-ALO-01 refused: money held, "I have paid", below the minimum, the same amount, not live, an increase past a stopping allocation; acceptance with money held', async () => {
    const deal = await liveDeal(lead)
    const a = await committed(deal, '1000000')
    await receive(a.p, '100000')
    expect((await propose(deal, a.p, '2000000')).json().error).toMatch(/Money has arrived/)
    const b = await committed(deal, '1000000')
    expect((await sign(b.u, b.p)).statusCode).toBe(200)
    expect((await instructions(b.u, b.p)).statusCode).toBe(200)
    expect((await inject('POST', `/api/my/participations/${b.p}/paid`, b.u, {})).statusCode).toBe(200)
    expect((await propose(deal, b.p, '2000000')).json().error).toMatch(/said they paid/)
    const c = await committed(deal, '1000000')
    expect((await propose(deal, c.p, '99999')).statusCode).not.toBe(200)
    expect((await propose(deal, c.p, '1000000')).json().error).toMatch(/different from the current/)
    // only the lead or a co-lead proposes
    expect((await propose(deal, c.p, '2000000', c.u)).json().error).toBe('Not found.')
    await t.owner.query("UPDATE deal SET state = 'closing_requested' WHERE id = $1", [deal])
    expect((await propose(deal, c.p, '2000000')).json().error).toMatch(/only be proposed while the deal is live/)
    await t.owner.query("UPDATE deal SET state = 'live' WHERE id = $1", [deal])
    // money that reached the books without the usual path (as a check): acceptance still finds N > 0 and refuses
    expect((await propose(deal, c.p, '2000000')).statusCode).toBe(200)
    await t.owner.query(
      "INSERT INTO receipt (id, participation_id, amount_minor, currency, source, received_on, payer_name, payer_account, entered_by) VALUES ($1, $2, 1000, 'GBP', 'manual', '2026-11-10', 'Fay Fictional', '1', $3)",
      [randomUUID(), c.p, reviewer.id],
    )
    expect((await accept(c.u, c.p)).json().error).toMatch(/Money has arrived/)
    // stop mode: an increase that does not fit is refused when proposed, and again when accepted after the room went
    const full = await stopDeal('2000000')
    const x = await committed(full, '1000000')
    expect((await propose(full, x.p, '2100000')).json().error).toMatch(/room only for a commitment of up to £20,000.00/)
    expect((await propose(full, x.p, '1500000')).statusCode).toBe(200)
    await committed(full, '1000000')
    expect((await accept(x.u, x.p)).json().error).toMatch(/up to|no longer room/)
    expect(await dueOf(x.p)).toBe('1000000')
  })

  it('TC-ALO-03 reminder mode never blocks; stop mode: up to what is left, then only the waiting list; the fee decides what fits; an increase is judged alike', async () => {
    // reminder (the default): over the allocation is taken and flagged
    const remind = await liveDeal(lead, { terms: { ...draftFor('x').terms, allocation_minor: '1000000' } })
    const r1 = await investor(remind)
    const over = await commit(r1.u, remind, r1.entity, '1500000')
    expect(over.statusCode, over.body).toBe(200)
    expect(over.json().over_allocation).toBe(true)
    const r2 = await investor(remind)
    expect((await inject('POST', `/api/my/deals/${remind}/waitlist`, r2.u, { desired_minor: '100000' })).json().error).toMatch(/no waiting list/)
    // stop: £10,000, minimum £1,000
    const deal = await stopDeal('1000000')
    await committed(deal, '500000')
    const b = await investor(deal)
    const q = (await inject('POST', `/api/my/deals/${deal}/quote`, b.u, { commitment_minor: '600000' })).json()
    expect(q).toMatchObject({ capacity: 'limit', max_commitment_minor: '500000' })
    expect((await commit(b.u, deal, b.entity, '600000')).json().error).toMatch(/up to £5,000.00/)
    expect((await commit(b.u, deal, b.entity, '500000')).statusCode).toBe(200)
    const c = await investor(deal)
    expect((await inject('POST', `/api/my/deals/${deal}/quote`, c.u, { commitment_minor: '100000' })).json().capacity).toBe('waitlist')
    expect((await commit(c.u, deal, c.entity, '100000')).json().error).toMatch(/full.*waiting list/)
    // what fits depends on the fee: 4% taken from the payment with £960 left fits £1,000; 4% on top does not
    const fees = await stopDeal('1000000')
    await committed(fees, '904000')
    const onTop = await viaLink(fees, await feeLink(fees, ON_TOP))
    expect((await commit(onTop.u, fees, onTop.entity, '100000')).json().error).toMatch(/full/)
    const deducted = await viaLink(fees, await feeLink(fees, { kind: 'percent', bps: 400, mode: 'deducted' }))
    expect((await commit(deducted.u, fees, deducted.entity, '100000')).statusCode).toBe(200)
    // an increase: the person's own T is not counted twice
    const inc = await stopDeal('1000000')
    const x = await committed(inc, '500000')
    await committed(inc, '200000')
    expect((await change(x.u, inc, x.p, '900000')).json().error).toMatch(/up to £8,000.00/)
    expect((await change(x.u, inc, x.p, '800000')).statusCode).toBe(200)
    // a decrease always fits
    expect((await change(x.u, inc, x.p, '700000')).statusCode).toBe(200)
  })

  it('TC-ALO-03 two people at once for the last room: only one gets it', async () => {
    const deal = await stopDeal('1000000')
    await committed(deal, '500000')
    const a = await investor(deal)
    const b = await investor(deal)
    const both = await Promise.all([commit(a.u, deal, a.entity, '500000'), commit(b.u, deal, b.entity, '500000')])
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(await count("SELECT count(*) AS n FROM participation WHERE deal_id = $1 AND outcome = 'active'", [deal])).toBe(2)
  })

  it('TC-ALO-04 a part ended by an identity refusal also tells the lead there may be room, and ends an open withdrawal', async () => {
    const deal = await stopDeal('1000000')
    const a = await committed(deal, '1000000')
    const c = await investor(deal)
    expect((await inject('POST', `/api/my/deals/${deal}/waitlist`, c.u, { desired_minor: '200000' })).statusCode).toBe(200)
    await t.owner.query(
      'INSERT INTO withdrawal_request (id, participation_id, asked_by, consent_confirmed, evidence) VALUES ($1, $2, $3, true, $4)',
      [randomUUID(), a.p, lead.id, 'Email from the investor'],
    )
    const caseId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [caseId, a.entity])
    const r = await inject('POST', `/api/review/kyc/${caseId}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })
    expect(r.statusCode, r.body).toBe(200)
    expect((await subjects(lead.email)).some((x) => x.startsWith('Room may have opened'))).toBe(true)
    expect(await count('SELECT count(*) AS n FROM withdrawal_request WHERE participation_id = $1 AND decision IS NULL', [a.p])).toBe(0)
  })

  it('TC-ALO-04 the waiting list: no participation, amount or reference; the lead lets people in out of order only with room; then a normal commitment; ends on closing or cancel', async () => {
    const deal = await stopDeal('1000000')
    const a = await committed(deal, '600000')
    await committed(deal, '400000')
    const join = async (x: { u: Client }, amount = '200000') => inject('POST', `/api/my/deals/${deal}/waitlist`, x.u, { desired_minor: amount })
    const c = await investor(deal)
    const e = await investor(deal)
    expect((await join(c, '50000')).statusCode).not.toBe(200)
    const cj = await join(c)
    expect(cj.statusCode, cj.body).toBe(200)
    expect((await join(c)).json().error).toMatch(/already on the waiting list/)
    expect((await join(e, '300000')).statusCode).toBe(200)
    expect((await subjects(lead.email)).some((x) => x.startsWith('Someone joined your waiting list'))).toBe(true)
    // nothing to pay: no participation, no reference, no instruction
    expect(await count('SELECT count(*) AS n FROM participation WHERE user_id = $1', [c.u.id])).toBe(0)
    const page = (await inject('GET', `/api/my/deals/${deal}`, c.u)).json()
    expect(page.waitlist).toEqual({ desired_minor: '200000', state: 'waiting' })
    expect(page.participations).toEqual([])
    // the lead sees the list, and cannot let anyone in without room
    const list = (await inject('GET', `/api/deals/${deal}/waitlist`, lead)).json()
    expect(list).toMatchObject({ mode: 'stop', room_minor: '0' })
    expect(list.entries.map((w: { desired_minor: string }) => w.desired_minor)).toEqual(['200000', '300000'])
    const [first, second] = list.entries as Array<{ id: string }>
    expect((await inject('POST', `/api/deals/${deal}/waitlist/${second!.id}/release`, lead, {})).json().error).toMatch(/no room/)
    expect((await inject('POST', `/api/deals/${deal}/waitlist/${second!.id}/release`, c.u, {})).json().error).toBe('Not found.')
    // someone leaves: the lead is told; the second in line is let in first, at the lead's choice
    expect((await inject('POST', `/api/deals/${deal}/participations/${a.p}/remove`, lead, {})).statusCode).toBe(200)
    expect((await subjects(lead.email)).some((x) => x.startsWith('Room may have opened'))).toBe(true)
    const let1 = await inject('POST', `/api/deals/${deal}/waitlist/${second!.id}/release`, lead, {})
    expect(let1.statusCode, let1.body).toBe(200)
    expect((await subjects(e.u.email)).some((x) => x.startsWith('A place has opened for you'))).toBe(true)
    expect((await inject('POST', `/api/deals/${deal}/waitlist/${second!.id}/release`, lead, {})).json().error).toMatch(/no longer waiting/)
    // back through the normal commitment, judged by R-ALO-03 again
    expect((await commit(e.u, deal, e.entity, '700000')).json().error).toMatch(/up to £6,000.00/)
    expect((await commit(e.u, deal, e.entity, '300000')).statusCode).toBe(200)
    expect((await t.owner.query<{ state: string }>('SELECT state FROM waitlist_entry WHERE user_id = $1', [e.u.id])).rows[0]!.state).toBe('committed')
    // the investor can leave; asking for closing ends whoever still waits, with a notice
    const f = await investor(deal)
    expect((await join(f, '400000')).statusCode).toBe(200)
    expect((await inject('POST', `/api/my/deals/${deal}/waitlist/leave`, f.u, {})).statusCode).toBe(200)
    expect((await inject('POST', `/api/my/deals/${deal}/waitlist/leave`, f.u, {})).json().error).toMatch(/not on the waiting list/)
    await readyToClose(deal)
    expect((await inject('POST', `/api/deals/${deal}/request-closing`, lead, { confirm: true })).statusCode).toBe(200)
    expect((await t.owner.query<{ state: string; end_reason: string }>('SELECT state, end_reason FROM waitlist_entry WHERE id = $1', [first!.id])).rows[0]).toEqual({
      state: 'ended',
      end_reason: 'closing_requested',
    })
    expect((await subjects(c.u.email)).some((x) => x.startsWith('The waiting list for a deal has closed'))).toBe(true)
    // cancellation ends a waiting list too, the cancellation notice reaching those on it
    const other = await stopDeal('500000')
    await committed(other, '500000')
    const g = await investor(other)
    expect((await inject('POST', `/api/my/deals/${other}/waitlist`, g.u, { desired_minor: '100000' })).statusCode).toBe(200)
    const asked = await inject('POST', `/api/deals/${other}/cancel-request`, lead, {})
    expect(asked.statusCode, asked.body).toBe(200)
    expect((await inject('POST', `/api/review/cancel-requests/${asked.json().id}/confirm`, reviewer, {})).statusCode).toBe(200)
    expect((await t.owner.query<{ end_reason: string }>('SELECT end_reason FROM waitlist_entry WHERE user_id = $1', [g.u.id])).rows[0]!.end_reason).toBe('cancelled')
    expect((await subjects(g.u.email)).some((x) => x.startsWith('This deal has been cancelled'))).toBe(true)
  })

  it('TC-GATE-08 an ended person: no way back through an open link; a personal invitation lets them see the deal and commit again with a new reference', async () => {
    const deal = await liveDeal(lead)
    const a = await committed(deal, '1000000')
    const oldRef = (await t.owner.query<{ reference: string }>('SELECT reference FROM participation WHERE id = $1', [a.p])).rows[0]!.reference
    expect((await inject('POST', `/api/deals/${deal}/participations/${a.p}/remove`, lead, {})).statusCode).toBe(200)
    // §5.6: the relationship ended with the last participation
    const ended = async () => (await t.owner.query<{ at: Date | null }>('SELECT relationship_ended_at AS at FROM user_account WHERE id = $1', [a.u.id])).rows[0]!.at
    expect(await ended()).not.toBeNull()
    const link = (await links(deal)).find((l) => l.is_default && l.carry_bps === 2000)!
    const generic = await open(tokenOf(await urlOf(deal, link.id)))
    expect((await inject('POST', '/api/invite/accept', a.u, {}, generic)).json().results[0].result).toBe('ended_before')
    expect((await inject('GET', `/api/my/deals/${deal}`, a.u)).statusCode).toBe(404)
    // a personal invitation sent to someone else, picked up by this person: refused
    const elsewhere = unique('someoneelse')
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: elsewhere, link_id: link.id, allows_reentry: true })).statusCode).toBe(200)
    const theirs = /token=([\w-]+)/.exec((await mailTo(elsewhere))[0]!.body)![1]!
    expect((await inject('POST', '/api/invite/accept', a.u, {}, await open(theirs))).json().results[0].result).toBe('wrong_address')
    // the one sent to them: back in; the deal is shown before any new commitment, the old ending still there
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: a.u.email, link_id: link.id, allows_reentry: true })).statusCode).toBe(200)
    const mine = /token=([\w-]+)/.exec((await mailTo(a.u.email)).find((m) => m.subject.startsWith('You have been invited'))!.body)![1]!
    expect((await inject('POST', '/api/invite/accept', a.u, {}, await open(mine))).json().results[0].result).toBe('invited')
    const page = await inject('GET', `/api/my/deals/${deal}`, a.u)
    expect(page.statusCode, page.body).toBe(200)
    expect(await count("SELECT count(*) AS n FROM participation WHERE id = $1 AND outcome = 'removed'", [a.p])).toBe(1)
    expect(await count("SELECT count(*) AS n FROM deal_invitation WHERE deal_id = $1 AND user_id = $2 AND state = 'revoked'", [deal, a.u.id])).toBe(1)
    expect((await commit(a.u, deal, a.entity, '1000000')).statusCode).toBe(200)
    const again = (
      await t.owner.query<{ reference: string }>("SELECT reference FROM participation WHERE user_id = $1 AND deal_id = $2 AND outcome = 'active'", [a.u.id, deal])
    ).rows[0]!.reference
    expect(again).not.toBe(oldRef)
    expect(await ended()).toBeNull()
  })

  it('TC-KYC-07 the relationship end is set by the real flows: choosing not to invest, cancellation; a person still in another deal keeps it open', async () => {
    const endedAt = async (u: Client) =>
      (await t.owner.query<{ at: Date | null }>('SELECT relationship_ended_at AS at FROM user_account WHERE id = $1', [u.id])).rows[0]!.at
    const deal = await liveDeal(lead)
    const a = await investor(deal)
    expect(await endedAt(a.u)).toBeNull()
    expect((await inject('POST', `/api/my/deals/${deal}/pass`, a.u, {})).statusCode).toBe(200)
    expect(await endedAt(a.u)).not.toBeNull()
    // cancellation: set for each person whose last part it ended
    const b = await committed(deal, '1000000')
    expect(await endedAt(b.u)).toBeNull()
    const asked = await inject('POST', `/api/deals/${deal}/cancel-request`, lead, {})
    expect((await inject('POST', `/api/review/cancel-requests/${asked.json().id}/confirm`, reviewer, {})).statusCode).toBe(200)
    expect(await endedAt(b.u)).not.toBeNull()
  })

  it('TC-KYC-07 an entity refused at KYC ends the relationship; committing again with another entity on the same invitation opens it', async () => {
    const endedAt = async (u: Client) =>
      (await t.owner.query<{ at: Date | null }>('SELECT relationship_ended_at AS at FROM user_account WHERE id = $1', [u.id])).rows[0]!.at
    const deal = await liveDeal(lead)
    const { u, entity } = await investor(deal)
    expect((await commit(u, deal, entity, '1000000')).statusCode).toBe(200)
    const caseId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [caseId, entity])
    expect((await inject('POST', `/api/review/kyc/${caseId}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })).statusCode).toBe(200)
    // the invitation stays (TC-GATE-07) but has a part, so nothing is going on: ended
    expect(await endedAt(u)).not.toBeNull()
    const other = await newEntity(u, 'Entity Two')
    expect((await commit(u, deal, other, '1000000')).statusCode).toBe(200)
    expect(await endedAt(u)).toBeNull()
  })
})

describe('D4 changes to a live deal (R-CHG-01, R-CHG-02, R-CHG-05, R-CMP-02, §5.3)', () => {
  const validInstruction = (p: string) => count('SELECT count(*) AS n FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL', [p])
  const subjects = async (to: string) => (await mailTo(to)).map((m) => m.subject)
  const got = async (to: string, start: string) => (await subjects(to)).some((x) => x.startsWith(start))
  const UPDATED = 'A deal you committed to has been updated'
  const RECONFIRM = 'The terms of a deal you committed to have changed'
  const VOID = 'Do not send money'
  const memo = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const dealRow = async (deal: string) =>
    (await t.owner.query<{ draft: Record<string, Record<string, unknown>>; approved_version: number }>('SELECT draft, approved_version FROM deal WHERE id = $1', [deal]))
      .rows[0]!
  /** The lead asks for a change: `edit` alters a copy of the deal as it is now. */
  async function ask(deal: string, edit: (d: Record<string, Record<string, unknown>>) => void, summary = 'A plain sentence.', who = lead) {
    const row = await dealRow(deal)
    const draft = structuredClone(row.draft)
    edit(draft)
    return inject('POST', `/api/deals/${deal}/changes`, who, { draft, summary, base_version: row.approved_version })
  }
  const shaOf = async (cid: string) => (await t.owner.query<{ s: string }>('SELECT proposed_sha256 AS s FROM change_request WHERE id = $1', [cid])).rows[0]!.s
  const decide = async (cid: string, body: Record<string, unknown> = {}, who = reviewer) =>
    inject('POST', `/api/review/changes/${cid}/decide`, who, { proposed_sha256: await shaOf(cid), ...body })
  const pending = (p: string) => count("SELECT count(*) AS n FROM reconfirmation WHERE participation_id = $1 AND state = 'pending'", [p])
  const termsVersion = async (p: string) => (await t.owner.query<{ v: number }>('SELECT terms_version AS v FROM participation WHERE id = $1', [p])).rows[0]!.v
  /** An investor who has committed, signed and been given an instruction. */
  async function ready(deal: string, amount: string) {
    const x = await investor(deal)
    const r = await commit(x.u, deal, x.entity, amount)
    expect(r.statusCode, r.body).toBe(200)
    const p = await pid(x.u, deal)
    expect((await sign(x.u, p)).statusCode).toBe(200)
    expect((await instructions(x.u, p)).statusCode).toBe(200)
    return { ...x, p }
  }

  it('TC-CHG-01 the lead moves the target close: in force at once, a new version, investors told; no reviewer, no reconfirmation, the instruction stays', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const before = (await dealRow(deal)).approved_version
    const r = await ask(deal, (d) => (d.terms!.target_close = '2027-02-28'), 'We need four more weeks.')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ state: 'applied', version: before + 1 })
    expect(await count("SELECT count(*) AS n FROM deal_version WHERE deal_id = $1 AND kind = 'self_service' AND approved_by IS NULL", [deal])).toBe(1)
    expect((await dealRow(deal)).draft.terms!.target_close).toBe('2027-02-28')
    expect(await got(a.u.email, UPDATED)).toBe(true)
    expect(await pending(a.p)).toBe(0)
    expect(await validInstruction(a.p)).toBe(1)
    const listed = (await inject('GET', `/api/deals/${deal}/changes`, lead)).json().changes
    expect(listed[0]).toMatchObject({ state: 'applied', summary: 'We need four more weeks.', self_service: true })
    expect(listed[0].changes).toEqual([{ field: 'terms.target_close', before: '2027-01-31', after: '2027-02-28' }])
  })

  it('TC-ALO-03 the lead switches a full deal to stop and waitlist alone: in force at once, investors told, the next commitment past the allocation waits; back to alert alone too', async () => {
    const deal = await liveDeal(lead, { terms: { ...draftFor('x').terms, allocation_minor: '1000000' } })
    const a = await ready(deal, '1000000')
    const before = (await dealRow(deal)).approved_version
    const r = await ask(deal, (d) => (d.terms!.over_allocation = 'stop_and_waitlist'), 'We stop at the allocation from now on.')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ state: 'applied', version: before + 1 })
    expect(await count("SELECT count(*) AS n FROM deal_version WHERE deal_id = $1 AND kind = 'self_service' AND approved_by IS NULL", [deal])).toBe(1)
    expect(await got(a.u.email, UPDATED)).toBe(true)
    expect(await pending(a.p)).toBe(0)
    expect(await validInstruction(a.p)).toBe(1)
    const b = await investor(deal)
    expect((await commit(b.u, deal, b.entity, '200000')).json().error).toBe('This deal is full. You can join the waiting list instead.')
    const back = await ask(deal, (d) => (d.terms!.over_allocation = 'alert'), 'We take everyone again.')
    expect(back.json()).toMatchObject({ state: 'applied', version: before + 2 })
    expect((await commit(b.u, deal, b.entity, '200000')).statusCode).toBe(200)
    // neither change went to a reviewer
    expect(await count("SELECT count(*) AS n FROM change_request WHERE deal_id = $1 AND NOT self_service", [deal])).toBe(0)
  })

  it('TC-CHG-02 minimum £1,000 → £5,000 judged notice: C £2,000 reconfirms (instruction void, urgent mail), C £10,000 is only told; a reason is required', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const b = await ready(deal, '1000000')
    const r = await ask(deal, (d) => (d.terms!.min_commitment_minor = '500000'))
    expect(r.json().state).toBe('submitted')
    const cid = r.json().id as string
    // investors still see the version before, and nothing has happened to them yet
    expect(await pending(a.p)).toBe(0)
    const shown = (await inject('GET', `/api/review/changes/${cid}`, reviewer)).json()
    expect(shown).toMatchObject({ needs_judgement: true, below_new_minimum: 1, resign: false })
    expect(shown.items).toEqual([expect.objectContaining({ field: 'terms.min_commitment_minor', kind: 'content', item: 'min_commitment_raise' })])
    expect((await decide(cid, { verdict: 'notice' })).json().error).toMatch(/Give a reason/)
    expect((await decide(cid, {})).json().error).toMatch(/Decide whether/)
    const ok = await decide(cid, { verdict: 'notice', reason: 'Tidies the minimum; only one person is below it.' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().state).toBe('applied')
    expect(await pending(a.p)).toBe(1)
    expect(await pending(b.p)).toBe(0)
    expect(await validInstruction(a.p)).toBe(0)
    expect(await validInstruction(b.p)).toBe(1)
    expect(await termsVersion(a.p)).toBe(2)
    expect(await termsVersion(b.p)).toBe(1)
    expect(await got(a.u.email, VOID)).toBe(true)
    expect(await got(a.u.email, RECONFIRM)).toBe(true)
    expect(await got(b.u.email, VOID)).toBe(false)
    expect(await got(b.u.email, UPDATED)).toBe(true)
    // §5.3: only the person asked is held back: no new instruction, the status says what to do
    expect((await inject('GET', `/api/my/deals/${deal}`, a.u)).json().participations[0].status).toBe('reconfirm')
    expect((await instructions(a.u, a.p)).statusCode).not.toBe(200)
    expect((await instructions(b.u, b.p)).statusCode).toBe(200)
  })

  it('TC-CHG-02 / TC-PAY-08 a memo typo judged notice: differences and a notice, no reconfirmation, no signing again, the instruction stays', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const r = await ask(deal, (d) => (d.files!.memo = memo('Seedling grows tomatoes.')), 'Fixed a typo in the memo.')
    const cid = r.json().id as string
    expect((await decide(cid, { verdict: 'notice', reason: 'A spelling fix.' })).json().state).toBe('applied')
    expect(await pending(a.p)).toBe(0)
    expect(await termsVersion(a.p)).toBe(1)
    expect(await validInstruction(a.p)).toBe(1)
    expect(await count('SELECT count(*) AS n FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL', [a.p])).toBe(1)
    expect(await got(a.u.email, VOID)).toBe(false)
    expect(await got(a.u.email, UPDATED)).toBe(true)
    const listed = (await inject('GET', `/api/deals/${deal}/changes`, lead)).json().changes
    expect(listed[0]).toMatchObject({ state: 'applied', verdict: 'notice', verdict_reason: 'A spelling fix.' })
  })

  it('TC-CHG-02 the valuation and the company name on the deal sheet: everyone reconfirms whatever the reviewer says; the deal sheet changes, so they sign again', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const b = await ready(deal, '1000000')
    const r = await ask(deal, (d) => {
      d.terms!.pre_money_minor = '600000000'
      d.company!.legal_name = 'Seedling Holdings Ltd'
    })
    const cid = r.json().id as string
    expect((await inject('GET', `/api/review/changes/${cid}`, reviewer)).json()).toMatchObject({ needs_judgement: false, resign: true })
    // "notice" is not the reviewer's to give here: it is not read, and everyone is asked
    expect((await decide(cid, { verdict: 'notice', reason: 'Small.' })).json().state).toBe('applied')
    expect(await pending(a.p)).toBe(1)
    expect(await pending(b.p)).toBe(1)
    expect(await count('SELECT count(*) AS n FROM reconfirmation WHERE deal_id = $1 AND resign', [deal])).toBe(2)
    expect((await t.owner.query('SELECT verdict FROM change_request WHERE id = $1', [cid])).rows[0]!.verdict).toBeNull()
  })

  it('TC-CHG-02 a second change before they answer: a re-signing still owed is kept, though the second change alone is off the deal sheet', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    // v2 renames the company (on the deal sheet): a signs again
    const first = await ask(deal, (d) => (d.company!.legal_name = 'Seedling Holdings Ltd'))
    expect((await decide(first.json().id, {})).json().state).toBe('applied')
    // v3, before a answers, changes only the valuation (not on the sheet); a's signature is still on the v1 sheet
    const second = await ask(deal, (d) => (d.terms!.pre_money_minor = '600000000'))
    expect((await inject('GET', `/api/review/changes/${second.json().id}`, reviewer)).json()).toMatchObject({ resign: false })
    expect((await decide(second.json().id, {})).json().state).toBe('applied')
    const rows = (
      await t.owner.query<{ state: string; resign: boolean }>('SELECT state, resign FROM reconfirmation WHERE participation_id = $1 ORDER BY started_at, state', [a.p])
    ).rows
    expect(rows.find((r) => r.state === 'pending')).toEqual({ state: 'pending', resign: true })
    expect(rows.filter((r) => r.state === 'superseded')).toHaveLength(1)
  })

  it('TC-CHG-02 limits only in live; a correction still in closing_requested; the currency never once committed; one change at a time', async () => {
    const deal = await liveDeal(lead)
    await ready(deal, '200000')
    expect((await ask(deal, (d) => (d.terms!.currency = 'EUR'))).json().error).toMatch(/currency cannot change/)
    const first = await ask(deal, (d) => (d.files!.memo = memo('One.')))
    expect((await ask(deal, (d) => (d.files!.memo = memo('Two.')))).json().error).toMatch(/waiting for a decision/)
    expect((await inject('POST', `/api/deals/${deal}/changes/${first.json().id}/withdraw`, lead, {})).json().state).toBe('withdrawn')
    await t.owner.query("UPDATE deal SET state = 'closing_requested' WHERE id = $1", [deal])
    expect((await ask(deal, (d) => (d.terms!.allocation_minor = '40000000'))).json().error).toMatch(/only change while the deal is live/)
    expect((await ask(deal, (d) => (d.terms!.pre_money_minor = '600000000'))).json().error).toMatch(/closing request withdrawn first/)
    const fix = await ask(deal, (d) => (d.files!.memo = memo('Three.')))
    expect(fix.json().state).toBe('submitted')
    expect((await decide(fix.json().id, { verdict: 'reconfirm', reason: 'x' })).json().error).toMatch(/closing request withdrawn first/)
    expect((await decide(fix.json().id, { verdict: 'notice', reason: 'A correction.' })).json().state).toBe('applied')
    await t.owner.query("UPDATE deal SET state = 'live' WHERE id = $1", [deal])
  })

  it('TC-CHG-04 setting a placeholder price is a correction; raising a published price must be reconfirmed', async () => {
    const deal = await liveDeal(lead, { terms: { ...draftFor('x').terms, price_is_placeholder: true, share_price_micros: '1000000' } })
    const a = await ready(deal, '200000')
    const set = await ask(deal, (d) => {
      d.terms!.share_price_micros = '1500000'
      d.terms!.price_is_placeholder = false
    })
    const item = (await inject('GET', `/api/review/changes/${set.json().id}`, reviewer)).json().items[0]
    expect(item).toMatchObject({ kind: 'content', item: 'price_set', suggested: 'notice' })
    expect((await decide(set.json().id, { verdict: 'notice', reason: 'The price is now known.' })).json().state).toBe('applied')
    expect(await pending(a.p)).toBe(0)
    const raise = await ask(deal, (d) => (d.terms!.share_price_micros = '1600000'))
    expect((await inject('GET', `/api/review/changes/${raise.json().id}`, reviewer)).json()).toMatchObject({ needs_judgement: false })
    expect((await decide(raise.json().id)).json().state).toBe('applied')
    expect(await pending(a.p)).toBe(1)
  })

  it('§5.3 a second change replaces the first: the first is superseded and both compare with the version last agreed', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const agreed = (await dealRow(deal)).approved_version
    const one = await ask(deal, (d) => (d.terms!.pre_money_minor = '600000000'))
    await decide(one.json().id)
    const two = await ask(deal, (d) => (d.terms!.pre_money_minor = '700000000'))
    await decide(two.json().id)
    const rows = (
      await t.owner.query<{ state: string; compared_to: number; deal_version: number }>(
        'SELECT state, compared_to, deal_version FROM reconfirmation WHERE participation_id = $1 ORDER BY started_at',
        [a.p],
      )
    ).rows
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'pending'])
    expect(rows.every((r) => r.compared_to === agreed)).toBe(true)
    expect(rows[1]!.deal_version).toBe((await dealRow(deal)).approved_version)
    expect(await termsVersion(a.p)).toBe(3)
  })

  it('R-CMP-02 with content approval on: after review investors still see the old version until an approver with no stake approves', async () => {
    const approver = await staff(unique('approver'), ['approver'])
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = true')
    try {
      const before = (await dealRow(deal)).approved_version
      const r = await ask(deal, (d) => (d.files!.memo = memo('Better words.')))
      const cid = r.json().id as string
      expect((await decide(cid, { verdict: 'notice', reason: 'Wording.' })).json()).toEqual({ state: 'reviewed', version: null })
      expect((await dealRow(deal)).approved_version).toBe(before)
      expect(await got(a.u.email, UPDATED)).toBe(false)
      const listed = (await inject('GET', '/api/approvals/changes', approver)).json().changes
      expect(listed.map((x: { id: string }) => x.id)).toContain(cid)
      const page = (await inject('GET', `/api/approvals/changes/${cid}`, approver)).json()
      expect((await inject('POST', `/api/approvals/changes/${cid}`, approver, { content_sha256: 'f'.repeat(64), self_declared_name: 'Op' })).json().error).toMatch(
        /not the one you opened/,
      )
      // another version in force after the review (as by a fix made outside this flow): the approval must not land on it
      await t.owner.query(
        "INSERT INTO deal_version (deal_id, n, snapshot, sha256, kind, approved_by) SELECT deal_id, n + 1, snapshot, sha256, 'self_service', NULL FROM deal_version WHERE deal_id = $1 AND n = $2",
        [deal, before],
      )
      await t.owner.query('UPDATE deal SET approved_version = $2 WHERE id = $1', [deal, before + 1])
      expect((await inject('POST', `/api/approvals/changes/${cid}`, approver, { content_sha256: page.proposed_sha256, self_declared_name: 'Op' })).json().error).toMatch(
        /changed since this was asked/,
      )
      await t.owner.query('UPDATE deal SET approved_version = $2 WHERE id = $1', [deal, before])
      const ok = await inject('POST', `/api/approvals/changes/${cid}`, approver, { content_sha256: page.proposed_sha256, self_declared_name: 'Op' })
      expect(ok.statusCode, ok.body).toBe(200)
      // the unused row stays (versions are only added); the change becomes the next one
      expect((await dealRow(deal)).approved_version).toBe(before + 2)
      expect(await count("SELECT count(*) AS n FROM promotion_approval WHERE subject_id = $1", [`${deal}:${before + 2}`])).toBe(1)
      expect(await got(a.u.email, UPDATED)).toBe(true)
    } finally {
      await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = false')
    }
  })

  it('R-CHG-02 refused: a page from an older version, nothing changed, a decision on other content, the lead returning it; returned with a reason', async () => {
    const deal = await liveDeal(lead)
    const row = await dealRow(deal)
    expect(
      (await inject('POST', `/api/deals/${deal}/changes`, lead, { draft: row.draft, summary: 'x', base_version: row.approved_version - 1 })).json().error,
    ).toMatch(/changed this deal since you opened it/)
    expect((await ask(deal, () => {})).json().error).toMatch(/Nothing has changed/)
    const r = await ask(deal, (d) => (d.files!.memo = memo('New.')))
    const cid = r.json().id as string
    expect((await inject('POST', `/api/review/changes/${cid}/decide`, reviewer, { proposed_sha256: 'a'.repeat(64) })).json().error).toMatch(/not the one/)
    expect((await inject('POST', `/api/review/changes/${cid}/return`, lead, { reason: 'no' })).statusCode).not.toBe(200)
    const back = await inject('POST', `/api/review/changes/${cid}/return`, reviewer, { reason: 'Say what changed in the memo.' })
    expect(back.json().state).toBe('returned')
    expect((await inject('GET', `/api/deals/${deal}/changes`, lead)).json().changes[0]).toMatchObject({ state: 'returned', return_reason: 'Say what changed in the memo.' })
    expect((await mailTo(lead.email)).some((m) => m.body.includes('Say what changed in the memo.'))).toBe(true)
  })

  // ---------- 7b: the investor's answer, the deadline and silence (§5.3) ----------

  const reconfirmOf = async (u: Client, p: string) => (await inject('GET', `/api/my/participations/${p}/reconfirmation`, u)).json().reconfirmation
  async function agree(u: Client, p: string, o: { sign?: boolean; sha?: string } = {}) {
    const rc = await reconfirmOf(u, p)
    const signing = o.sign === false ? {} : { signed_name: 'Fay Fictional', document_sha256: o.sha ?? rc.deal_sheet?.document_sha256 }
    return inject('POST', `/api/my/participations/${p}/reconfirmation/agree`, u, { reconfirmation_id: rc.id, agree: true, ...(rc.sign_again ? signing : {}) })
  }
  const declineRc = async (u: Client, p: string) =>
    inject('POST', `/api/my/participations/${p}/reconfirmation/decline`, u, { reconfirmation_id: (await reconfirmOf(u, p)).id })
  const rcRow = async (p: string) =>
    (
      await t.owner.query<{ id: string; state: string; signature_id: string | null; deal_version: number; compared_to: number }>(
        'SELECT id, state, signature_id, deal_version, compared_to FROM reconfirmation WHERE participation_id = $1 ORDER BY started_at DESC, id LIMIT 1',
        [p],
      )
    ).rows[0]!
  const outcomeOf = async (p: string) => (await t.owner.query<{ outcome: string }>('SELECT outcome FROM participation WHERE id = $1', [p])).rows[0]!.outcome
  const statusOf = async (u: Client, deal: string) => (await inject('GET', `/api/my/deals/${deal}`, u)).json().participations[0]
  const staffList = async (deal: string) =>
    ((await inject('GET', '/api/review/reconfirmations', reviewer)).json().reconfirmations as Array<Record<string, string>>).filter((r) => r.deal_id === deal)
  async function pay(p: string, amount: string) {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: amount,
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '12345678',
    })
    expect(r.statusCode, r.body).toBe(200)
  }
  /** Statements made before the test clock, so that the clock reads them as covering the whole time (they are stamped by the database). */
  const statementSince = (u: Client) => t.owner.query("UPDATE eligibility_statement SET created_at = '2026-11-01T00:00:00Z' WHERE user_id = $1", [u.id])
  async function at<T>(when: Date, fn: () => Promise<T>): Promise<T> {
    const saved = clock
    clock = when
    try {
      return await fn()
    } finally {
      clock = saved
    }
  }
  const valuation = (deal: string, v: string, summary = 'The round is now priced higher.') =>
    ask(deal, (d) => {
      d.terms!.pre_money_minor = v
      d.company!.legal_name = `Seedling ${v} Ltd`
    }, summary)
  // started on Tue 10 Nov 09:00; five working days end with Tue 17 Nov
  const DEADLINE = '2026-11-18T00:00:00.000Z'
  const AFTER = new Date('2026-11-18T09:00:00Z')

  it('E2E-05 / TC-STAT-05 a change to reconfirm: the differences, the sentence, the deadline; agree and sign again on one screen; the instruction comes back', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const first = (await dealRow(deal)).approved_version
    const oldSig = (await t.owner.query<{ id: string }>('SELECT id FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL', [a.p])).rows[0]!.id
    await decide((await valuation(deal, '600000000')).json().id)
    const rc = await reconfirmOf(a.u, a.p)
    expect(rc).toMatchObject({ summary: 'The round is now priced higher.', compared_to: first, sign_again: true, clock: 'open', deadline: DEADLINE, working_days: 5 })
    expect(rc.differences).toEqual(
      expect.arrayContaining([
        { field: 'key_terms.pre_money_minor', before: '500000000', after: '600000000' },
        { field: 'company.legal_name', before: expect.any(String), after: 'Seedling 600000000 Ltd' },
      ]),
    )
    // the sheet to sign is the one for the new version (an earlier test may have changed the template's words)
    expect(rc.deal_sheet.document_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await statusOf(a.u, deal)).status).toBe('reconfirm')
    // the deal sheet is not signed apart from agreeing; agreeing needs the signature, of the sheet shown
    expect((await sign(a.u, a.p)).statusCode).not.toBe(200)
    expect((await agree(a.u, a.p, { sign: false })).json().error).toMatch(/Sign the new deal sheet/)
    expect((await agree(a.u, a.p, { sha: 'b'.repeat(64) })).json().error).toMatch(/changed since you opened it/)
    expect(await rcRow(a.p)).toMatchObject({ state: 'pending' })
    const r = await agree(a.u, a.p)
    expect(r.json(), r.body).toEqual({ ok: true, signed_again: true })
    const row = await rcRow(a.p)
    expect(row.state).toBe('agreed')
    expect(row.signature_id).not.toBeNull()
    expect(await count('SELECT count(*) AS n FROM signature_record WHERE id = $1 AND superseded_at IS NOT NULL', [oldSig])).toBe(1)
    expect((await t.owner.query('SELECT agreed_version FROM participation WHERE id = $1', [a.p])).rows[0]!.agreed_version).toBe(row.deal_version)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'participation.reconfirmed' AND entity_id = $1", [a.p])).toBe(1)
    expect((await statusOf(a.u, deal)).status).toBe('to_pay')
    expect((await instructions(a.u, a.p)).statusCode).toBe(200)
    expect(await validInstruction(a.p)).toBe(1)
    // answered once only
    expect((await inject('POST', `/api/my/participations/${a.p}/reconfirmation/agree`, a.u, { reconfirmation_id: row.id, agree: true })).json().error).toMatch(
      /nothing to reconfirm/,
    )
    expect(await reconfirmOf(a.u, a.p)).toBeNull()
  })

  it('E2E-05 a typo judged notice: the investor sees the difference and the sentence, and nothing is asked of them', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const cid = (await ask(deal, (d) => (d.files!.memo = memo('Fixed a typo.')), 'A typo in the memo.')).json().id
    expect((await decide(cid, { verdict: 'notice', reason: 'A typo.' })).json().state).toBe('applied')
    expect(await reconfirmOf(a.u, a.p)).toBeNull()
    const ups = (await inject('GET', `/api/my/deals/${deal}/updates`, a.u)).json().updates
    expect(ups).toHaveLength(1)
    expect(ups[0]).toMatchObject({ summary: 'A typo in the memo.', kind: 'notice' })
    // the memo was empty before: nothing, not the word null
    expect(ups[0].differences).toEqual([{ field: 'memo', before: null, after: 'Fixed a typo.' }])
    expect((await statusOf(a.u, deal)).status).toBe('to_pay')
    // someone not in the deal sees nothing
    expect((await inject('GET', `/api/my/deals/${deal}/updates`, lead)).statusCode).toBe(404)
  })

  it('TC-STAT-05 a notice after a change still waiting: the person can still agree, to the version now in force, same deadline', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    await decide((await ask(deal, (d) => (d.terms!.pre_money_minor = '600000000'))).json().id)
    const full = async () =>
      (await t.owner.query("SELECT id, state, days, started_at, deal_version FROM reconfirmation WHERE participation_id = $1 AND state = 'pending'", [a.p])).rows[0]!
    const first = await full()
    const cid = (await ask(deal, (d) => (d.files!.memo = memo('Fixed a typo.')), 'A typo in the memo.')).json().id
    expect((await decide(cid, { verdict: 'notice', reason: 'A typo.' })).json().state).toBe('applied')
    const moved = await full()
    expect(moved).toMatchObject({ id: first.id, state: 'pending', days: first.days, started_at: first.started_at })
    expect(moved.deal_version).toBe((await dealRow(deal)).approved_version)
    expect(moved.deal_version).toBeGreaterThan(first.deal_version)
    expect((await agree(a.u, a.p)).json()).toMatchObject({ ok: true })
    expect((await rcRow(a.p)).state).toBe('agreed')
    expect((await t.owner.query('SELECT agreed_version FROM participation WHERE id = $1', [a.p])).rows[0]!.agreed_version).toBe(moved.deal_version)
  })

  it('R-CHG-05 a price set while it stays hidden: shown only as "set"; its value never reaches the investor', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    await decide((await ask(deal, (d) => (d.terms!.pre_money_minor = '600000000'))).json().id)
    const before = (await dealRow(deal)).draft.terms!.share_price_micros
    await agree(a.u, a.p)
    const cid = (
      await ask(deal, (d) => {
        d.terms!.pre_money_minor = '650000000'
        d.terms!.share_price_micros = '7777777'
        d.terms!.price_is_placeholder = false
      })
    ).json().id
    await decide(cid)
    const rc = await reconfirmOf(a.u, a.p)
    expect(rc.differences).toEqual(expect.arrayContaining([{ field: 'terms.share_price_micros', before: null, after: 'The price is set; it is shown after closing.' }]))
    expect(JSON.stringify(rc)).not.toContain('7777777')
    expect(before).not.toBe('7777777')
  })

  it('TC-STAT-05 saying no: with no money the part ends (withdrawn, no refund to do); with money, a withdrawal with a refund to do; the lead is told', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const b = await ready(deal, '200000')
    const due = (await t.owner.query<{ d: string }>('SELECT cash_due_minor::text AS d FROM participation WHERE id = $1', [b.p])).rows[0]!.d
    await pay(b.p, due)
    await decide((await valuation(deal, '600000000')).json().id)
    expect((await declineRc(a.u, a.p)).json()).toEqual({ outcome: 'withdrawn', refund: false })
    expect(await outcomeOf(a.p)).toBe('withdrawn')
    expect((await rcRow(a.p)).state).toBe('declined')
    expect(await count('SELECT count(*) AS n FROM refund_todo WHERE participation_id = $1', [a.p])).toBe(0)
    expect((await declineRc(b.u, b.p)).json()).toEqual({ outcome: 'withdrawn', refund: true })
    expect(await outcomeOf(b.p)).toBe('withdrawn')
    expect(await count("SELECT count(*) AS n FROM refund_todo_event WHERE participation_id = $1 AND kind = 'reason' AND value = 'withdrawn'", [b.p])).toBe(1)
    expect(await got(lead.email, 'Changed terms declined')).toBe(true)
    // nobody is left to reconfirm, so closing can be asked for as far as reconfirmation goes
    expect(await count("SELECT count(*) AS n FROM reconfirmation WHERE deal_id = $1 AND state = 'pending'", [deal])).toBe(0)
  })

  it('TC-OPS-01 a change waiting for a reviewer, and silence after the deadline, are on the operator’s to-do list until dealt with', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    await statementSince(a.u)
    const keys = async () => ((await inject('GET', '/api/ops/work', reviewer)).json().items as Array<{ key: string; deadline: string | null }>)
    const asked = await valuation(deal, '600000000')
    expect(asked.statusCode, asked.body).toBe(200)
    const cid = asked.json().id as string
    expect((await keys()).map((i) => i.key)).toContain(`change:${cid}`)
    expect((await decide(cid)).statusCode).toBe(200)
    expect((await keys()).map((i) => i.key)).not.toContain(`change:${cid}`)
    const rc = (await rcRow(a.p)).id
    // still within the deadline: waiting on the investor, not the operator
    expect((await keys()).map((i) => i.key)).not.toContain(`reconfirm_silent:${rc}`)
    await at(AFTER, async () => {
      const it = (await keys()).find((i) => i.key === `reconfirm_silent:${rc}`)
      expect(it).toMatchObject({ deadline: DEADLINE })
    })
  })

  it('TC-STAT-05 silence: "no response" after the deadline; the lead removes someone with no money; the operator decides for someone with money', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const b = await ready(deal, '200000')
    for (const x of [a, b]) await statementSince(x.u)
    const due = (await t.owner.query<{ d: string }>('SELECT cash_due_minor::text AS d FROM participation WHERE id = $1', [b.p])).rows[0]!.d
    await pay(b.p, due)
    await decide((await valuation(deal, '600000000')).json().id)
    expect((await staffList(deal)).map((r) => r.clock)).toEqual(['open', 'open'])
    await at(AFTER, async () => {
      expect((await statusOf(a.u, deal)).overlays).toContain('no_response')
      const staffView = (await inject('GET', `/api/review/deals/${deal}/participations`, reviewer)).json().participations
      expect(staffView.every((x: { overlays: string[] }) => x.overlays.includes('no_response'))).toBe(true)
      const list = await staffList(deal)
      expect(Object.fromEntries(list.map((r) => [r.participation_id, [r.clock, r.next]]))).toEqual({
        [a.p]: ['lapsed', 'may_remove'],
        [b.p]: ['lapsed', 'operator_decides'],
      })
      // silence is not agreement: the instruction stays void and the step is still the investor's
      expect(await validInstruction(a.p)).toBe(0)
      // the operator excludes only someone with money, only with the pack's notice
      const rcA = list.find((r) => r.participation_id === a.p)!.id
      const rcB = list.find((r) => r.participation_id === b.p)!.id
      expect((await inject('POST', `/api/review/reconfirmations/${rcA}/exclude`, reviewer, { evidence: 'Mailed twice.' })).json().error).toMatch(/remove them/)
      expect((await inject('POST', `/api/review/reconfirmations/${rcB}/exclude`, reviewer, { evidence: 'Mailed twice.' })).json().error).toMatch(
        /reconfirm_exclusion_notice/,
      )
      // the lead removes the one with no money; the reconfirmation ends with the part
      expect((await inject('POST', `/api/deals/${deal}/participations/${a.p}/remove`, lead, {})).json()).toEqual({ outcome: 'removed' })
      expect((await rcRow(a.p)).state).toBe('ended')
    })
  })

  it('TC-STAT-05 the operator excludes a silent person with money after the pack\'s notice: evidence kept, refund to do, the notice shown to them; not before the deadline', async () => {
    const deal = await liveDeal(lead)
    const b = await ready(deal, '200000')
    await statementSince(b.u)
    const due = (await t.owner.query<{ d: string }>('SELECT cash_due_minor::text AS d FROM participation WHERE id = $1', [b.p])).rows[0]!.d
    await pay(b.p, due)
    // the deal's pack, with the operator's words for this notice added as a new pack version
    const packId = (await t.owner.query<{ pack_id: string }>('SELECT pack_id FROM deal WHERE id = $1', [deal])).rows[0]!.pack_id
    const content = (await t.owner.query<{ content: Record<string, unknown> & { legal_texts: unknown[]; key: string } }>('SELECT content FROM regime_pack WHERE id = $1', [packId]))
      .rows[0]!.content
    const NOTICE = 'You did not answer the changed terms in time, so you are excluded and your money will be refunded.'
    const next = {
      ...content,
      key: `notice-test-${randomUUID().slice(0, 8)}`,
      legal_texts: [
        ...content.legal_texts,
        { text_key: 'reconfirm_exclusion_notice', variant: 'default', version: 1, format: 'plain', body: NOTICE, required_bold: [], is_placeholder: false },
      ],
    }
    const { insertPack } = await import('../store/packs.ts')
    const newPack = await tx(t.owner, (c) => insertPack(c, next as never, { builtIn: false, by: null }))
    await t.owner.query('UPDATE deal SET pack_id = $2 WHERE id = $1', [deal, newPack])
    await decide((await valuation(deal, '600000000')).json().id)
    const rc = (await staffList(deal))[0]!.id
    expect((await inject('POST', `/api/review/reconfirmations/${rc}/exclude`, reviewer, { evidence: 'Mailed twice.' })).json().error).toMatch(/not passed/)
    await at(AFTER, async () => {
      expect((await inject('POST', `/api/review/reconfirmations/${rc}/exclude`, reviewer, { evidence: ' x ' })).json().error).toMatch(/Write down/)
      // a reviewer with a stake cannot
      expect((await inject('POST', `/api/review/reconfirmations/${rc}/exclude`, b.u, { evidence: 'Mailed twice.' })).statusCode).not.toBe(200)
      const r = await inject('POST', `/api/review/reconfirmations/${rc}/exclude`, reviewer, { evidence: 'Mailed twice, called once.' })
      expect(r.json(), r.body).toMatchObject({ outcome: 'excluded_at_close' })
    })
    expect(await outcomeOf(b.p)).toBe('excluded_at_close')
    expect((await rcRow(b.p)).state).toBe('ended')
    const x = (await t.owner.query('SELECT notice_text, evidence, deadline_at FROM reconfirm_exclusion WHERE reconfirmation_id = $1', [rc])).rows[0]!
    expect(x).toMatchObject({ notice_text: NOTICE, evidence: 'Mailed twice, called once.', deadline_at: new Date(DEADLINE) })
    expect(await count("SELECT count(*) AS n FROM refund_todo_event WHERE participation_id = $1 AND kind = 'reason' AND value = 'excluded_at_close'", [b.p])).toBe(1)
    const mine = (await inject('GET', '/api/my/participations', b.u)).json().participations
    expect(mine.find((m: { id: string }) => m.id === b.p).exclusion_notice).toBe(NOTICE)
    await expect(t.owner.query('UPDATE reconfirm_exclusion SET evidence = $2 WHERE reconfirmation_id = $1', [rc, 'other'])).rejects.toThrow()
  })

  it('TC-STAT-05 an expired statement stops the clock until it is renewed; reminders go every N days only while the clock runs', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    await statementSince(a.u)
    await decide((await valuation(deal, '600000000')).json().id)
    const rc = (await rcRow(a.p)).id
    // every three days, whatever earlier tests left as the newest settings
    await t.owner.query(
      `INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days)
       SELECT coalesce(max(version), 0) + 1, true, true, true, ARRAY['admin','reviewer'], 2, 3 FROM operator_policy`,
    )
    const remind = (when: Date) =>
      runReminders({ db: t.app, now: () => when, mail: { ...mailQueue({ db: t.app, k: t.keyring, now: () => when, mailer: async () => new FakeOutbox(t.app) }, () => undefined), flush: async () => undefined } })
    const reminded = () => count("SELECT count(*) AS n FROM mail_reminder WHERE kind = 'reconfirm' AND about_id = $1", [rc])
    await remind(new Date('2026-11-12T09:00:00Z'))
    expect(await reminded()).toBe(0)
    await remind(new Date('2026-11-13T09:00:01Z'))
    expect(await reminded()).toBe(1)
    await remind(new Date('2026-11-14T09:00:01Z'))
    expect(await reminded()).toBe(1)
    // the statement ran out on Fri 13 Nov 00:00 and was renewed on Mon 16 Nov 00:00: three days paused
    await t.owner.query("UPDATE eligibility_statement SET expires_at = '2026-11-13T00:00:00Z' WHERE user_id = $1", [a.u.id])
    await at(new Date('2026-11-15T09:00:00Z'), async () => expect((await staffList(deal))[0]).toMatchObject({ clock: 'paused', deadline: null }))
    await remind(new Date('2026-11-17T09:00:01Z'))
    expect(await reminded()).toBe(1)
    await t.owner.query(
      `INSERT INTO eligibility_statement (id, user_id, regime, pack_id, category, qualifies, answers, legal_text_sha256, signed_name, signed_on, payload_sha256, ip, auth_method, expires_at, created_at)
       SELECT $2, user_id, regime, pack_id, category, qualifies, answers, legal_text_sha256, signed_name, signed_on, payload_sha256, ip, auth_method, '2027-11-16T00:00:00Z', '2026-11-16T00:00:00Z'
         FROM eligibility_statement WHERE user_id = $1 LIMIT 1`,
      [a.u.id, randomUUID()],
    )
    await at(AFTER, async () => expect((await staffList(deal))[0]).toMatchObject({ clock: 'open', deadline: '2026-11-21T00:00:00.000Z' }))
    await remind(new Date('2026-11-17T09:00:01Z'))
    expect(await reminded()).toBe(2)
    // agreed: no more reminders
    await at(AFTER, async () => expect((await agree(a.u, a.p)).statusCode).toBe(200))
    await remind(new Date('2026-11-20T09:00:01Z'))
    expect(await reminded()).toBe(2)
  })

  it('§5.3 a second change replaces the first and restarts the clock: the one who agreed compares with what they agreed, the silent one with the older version', async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const b = await ready(deal, '200000')
    for (const x of [a, b]) await statementSince(x.u)
    const first = (await dealRow(deal)).approved_version
    await decide((await valuation(deal, '600000000')).json().id)
    const agreedTo = (await dealRow(deal)).approved_version
    expect((await agree(a.u, a.p)).statusCode).toBe(200)
    await at(new Date('2026-11-12T09:00:00Z'), async () => {
      await decide((await valuation(deal, '700000000', 'Higher again.')).json().id)
      const ra = await reconfirmOf(a.u, a.p)
      const rb = await reconfirmOf(b.u, b.p)
      expect(ra).toMatchObject({ compared_to: agreedTo, summary: 'Higher again.', deadline: '2026-11-20T00:00:00.000Z' })
      expect(rb).toMatchObject({ compared_to: first, summary: 'Higher again.' })
      expect(ra.differences).toContainEqual({ field: 'key_terms.pre_money_minor', before: '600000000', after: '700000000' })
      expect(rb.differences).toContainEqual({ field: 'key_terms.pre_money_minor', before: '500000000', after: '700000000' })
      // the replaced one cannot be answered
      const old = (await t.owner.query<{ id: string }>("SELECT id FROM reconfirmation WHERE participation_id = $1 AND state = 'superseded'", [b.p])).rows[0]!.id
      expect((await inject('POST', `/api/my/participations/${b.p}/reconfirmation/agree`, b.u, { reconfirmation_id: old, agree: true })).json().error).toMatch(
        /nothing to reconfirm/,
      )
    })
  })

  // ---------- 7c: one person's terms, taking a change back, a larger allocation ----------

  const ON_TOP_4 = { kind: 'percent', bps: 400, mode: 'on_top' }
  // run alone, this block may find no operator policy yet (the pack's defaults stand); one is written either way
  const allowLinkTerms = async (on: boolean) =>
    (await count('SELECT count(*) AS n FROM operator_policy'))
      ? linkTermsPolicy(on)
      : t.owner.query(
          "INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count) VALUES (1, $1, true, true, ARRAY['admin', 'reviewer'], 2)",
          [on],
        )
  const linkTermsPolicy = (on: boolean) =>
    t.owner.query(
      `INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days, cancel_fee_note, amount_proposal_days, reconfirm_days, changed_by)
       SELECT version + 1, $1, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days, cancel_fee_note, amount_proposal_days, 5, $2
         FROM operator_policy ORDER BY version DESC LIMIT 1`,
      [on, reviewer.id],
    )
  async function personTerms(deal: string, p: string, body: Record<string, unknown>, who = lead) {
    return inject('POST', `/api/deals/${deal}/participations/${p}/terms`, who, {
      carry_bps: 2000,
      fee: ON_TOP_4,
      summary: 'The fee we agreed on the phone.',
      base_version: (await dealRow(deal)).approved_version,
      ...body,
    })
  }
  const partRow = async (p: string) =>
    (
      await t.owner.query<{ cash_due_minor: string; invest_minor: string; agreed_terms_n: number; terms_version: number }>(
        'SELECT cash_due_minor::text, invest_minor::text, agreed_terms_n, terms_version FROM participation WHERE id = $1',
        [p],
      )
    ).rows[0]!

  it("TC-CHG-02 / TC-STAT-05 one person's terms: only they reconfirm and sign again; the amount to pay is worked out again and someone paid in full owes the difference", async () => {
    await allowLinkTerms(true)
    const deal = await liveDeal(lead)
    const a = await ready(deal, '1000000')
    const b = await ready(deal, '200000')
    await pay(a.p, '1000000')
    expect((await statusOf(a.u, deal)).status).toBe('funded')
    const before = (await dealRow(deal)).approved_version
    const r = await personTerms(deal, a.p, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().state).toBe('submitted')
    const cid = r.json().id as string
    // nothing moves before the reviewer decides
    expect((await partRow(a.p)).cash_due_minor).toBe('1000000')
    const shown = (await inject('GET', `/api/review/changes/${cid}`, reviewer)).json()
    expect(shown).toMatchObject({ person: { commitments: 1 }, needs_judgement: false, resign: true, summary: 'The fee we agreed on the phone.' })
    expect(shown.differences).toEqual([{ field: 'lead_fee', before: 'No fee', after: '4.00% added on top of the commitment' }])
    expect((await inject('GET', `/api/deals/${deal}/changes`, lead)).json().changes[0].changes).toEqual(shown.differences)
    // one change at a time, for the whole deal too
    expect((await ask(deal, (d) => (d.terms!.target_close = '2027-02-28'))).json().error).toMatch(/Another change/)
    const ok = await decide(cid)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().state).toBe('applied')
    // no new deal version: the deal is the same for everyone else
    expect((await dealRow(deal)).approved_version).toBe(before)
    expect(await pending(a.p)).toBe(1)
    expect(await pending(b.p)).toBe(0)
    expect(await validInstruction(a.p)).toBe(0)
    expect(await validInstruction(b.p)).toBe(1)
    expect(await partRow(a.p)).toMatchObject({ cash_due_minor: '1040000', invest_minor: '1000000', terms_version: 2, agreed_terms_n: 0 })
    expect((await partRow(b.p)).terms_version).toBe(1)
    expect(await got(a.u.email, VOID)).toBe(true)
    expect(await got(a.u.email, RECONFIRM)).toBe(true)
    expect(await got(b.u.email, UPDATED)).toBe(false)
    expect(await count('SELECT count(*) AS n FROM invitation_terms WHERE invitation_id = (SELECT invitation_id FROM participation WHERE id = $1)', [a.p])).toBe(2)
    // the investor sees their own terms change, signs the new deal sheet and agrees on one screen
    const rc = await reconfirmOf(a.u, a.p)
    expect(rc).toMatchObject({ summary: 'The fee we agreed on the phone.', sign_again: true, compared_to: before })
    expect(rc.differences).toEqual([{ field: 'key_terms.lead_fee', before: 'No fee', after: '4.00% added on top of the commitment' }])
    expect((await statusOf(a.u, deal)).status).toBe('reconfirm')
    const agreed = await agree(a.u, a.p)
    expect(agreed.json(), agreed.body).toEqual({ ok: true, signed_again: true })
    expect((await partRow(a.p)).agreed_terms_n).toBe(1)
    // §5.3: paid in full before, now short by the new fee
    expect((await statusOf(a.u, deal)).status).toBe('part_paid')
    expect((await instructions(a.u, a.p)).statusCode).toBe(200)
    // nobody else sees one person's terms among the deal's updates
    expect((await inject('GET', `/api/my/deals/${deal}/updates`, b.u)).json().updates).toEqual([])
    // the frozen terms never change except to a set a change wrote
    await expect(
      t.owner.query("UPDATE deal_invitation SET terms_snapshot = terms_snapshot || '{\"carry_bps\": 0}' WHERE id = (SELECT invitation_id FROM participation WHERE id = $1)", [a.p]),
    ).rejects.toThrow(/frozen terms cannot change/)
  })

  it("TC-CHG-02 one person's fixed fee in another currency reads in that currency for the lead and the reviewer", async () => {
    await allowLinkTerms(true)
    const deal = await liveDeal(lead, { terms: { ...(draftFor('x').terms as object), currency: 'EUR' } })
    const a = await ready(deal, '1000000')
    const r = await personTerms(deal, a.p, { fee: { kind: 'fixed', minor: '50000', mode: 'on_top' } })
    expect(r.statusCode, r.body).toBe(200)
    const cid = r.json().id as string
    const words = [{ field: 'lead_fee', before: 'No fee', after: '€500.00 added on top of the commitment' }]
    expect((await inject('GET', `/api/review/changes/${cid}`, reviewer)).json().differences).toEqual(words)
    expect((await inject('GET', `/api/deals/${deal}/changes`, lead)).json().changes[0].changes).toEqual(words)
    expect((await inject('POST', `/api/deals/${deal}/changes/${cid}/withdraw`, lead, {})).statusCode).toBe(200)
  })

  it("TC-CHG-02 one person's terms refused: the operator's switch, nothing changed, a fee as large as the commitment, a stake, no longer live; a lower fee leaves money to refund", async () => {
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    await allowLinkTerms(false)
    const off = await personTerms(deal, a.p, {})
    expect(off.json().error).toMatch(/does not allow terms that differ/)
    await allowLinkTerms(true)
    expect((await personTerms(deal, a.p, { fee: { kind: 'none' } })).json().error).toMatch(/Nothing has changed/)
    expect((await personTerms(deal, a.p, { fee: { kind: 'fixed', minor: '200000', mode: 'deducted' } })).json().error).toMatch(/whole of a commitment/)
    expect((await personTerms(deal, a.p, { carry_bps: 10001 })).json().error).toMatch(/Carry must be/)
    expect((await personTerms(deal, a.p, {}, a.u)).statusCode).not.toBe(200)
    expect((await personTerms(deal, a.p, { base_version: (await dealRow(deal)).approved_version - 1 })).json().error).toMatch(/Someone has changed/)
    // one change at a time: a deal change waiting for review stops one person's
    const open = (await ask(deal, (d) => (d.files!.memo = memo('Waiting.')))).json().id
    expect((await personTerms(deal, a.p, {})).json().error).toMatch(/Another change/)
    await inject('POST', `/api/deals/${deal}/changes/${open}/withdraw`, lead, {})
    // a fee lowered after full payment: the difference is money to refund
    const cid = (await personTerms(deal, a.p, {})).json().id
    expect((await decide(cid)).json().state).toBe('applied')
    expect((await agree(a.u, a.p)).statusCode).toBe(200)
    await pay(a.p, '208000')
    expect((await statusOf(a.u, deal)).status).toBe('funded')
    const back = (await personTerms(deal, a.p, { fee: { kind: 'none' }, summary: 'No fee after all.' })).json().id
    expect((await decide(back)).json().state).toBe('applied')
    expect((await partRow(a.p)).cash_due_minor).toBe('200000')
    expect((await agree(a.u, a.p)).statusCode).toBe(200)
    expect((await statusOf(a.u, deal)).status).toBe('refund_due')
    // only while live
    await t.owner.query("UPDATE deal SET state = 'closing_requested' WHERE id = $1", [deal])
    expect((await personTerms(deal, a.p, {})).json().error).toMatch(/closing request withdrawn first/)
    await t.owner.query("UPDATE deal SET state = 'closing' WHERE id = $1", [deal])
    expect((await personTerms(deal, a.p, {})).json().error).toBe('A change that investors must reconfirm needs the deal back in live, or cancelled.')
    // cancelled the real way (§5.1 has no way back): the plain refusal, not "back in live, or cancelled"
    await t.owner.query("UPDATE deal SET state = 'live' WHERE id = $1", [deal])
    const cancel = await inject('POST', `/api/deals/${deal}/cancel-request`, lead, { reason: 'The company withdrew' })
    expect(cancel.statusCode, cancel.body).toBe(200)
    const confirmed = await inject('POST', `/api/review/cancel-requests/${cancel.json().id}/confirm`, reviewer, {})
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const refused = await personTerms(deal, a.p, {})
    expect(refused.statusCode).not.toBe(200)
    expect(refused.json().error).toBe('This deal cannot be changed in its state.')
  })

  it('§5.3 taking a change back: a silent person whose agreed version is in force again has nothing to reconfirm; the one who agreed to the change is asked again', async () => {
    await allowLinkTerms(true)
    const deal = await liveDeal(lead)
    const a = await ready(deal, '200000')
    const b = await ready(deal, '200000')
    await pay(b.p, '200000')
    const first = (await dealRow(deal)).approved_version
    const name = (await dealRow(deal)).draft.company!.legal_name
    await decide((await valuation(deal, '600000000')).json().id)
    expect((await agree(a.u, a.p)).statusCode).toBe(200)
    // b stays silent with money on hand; the lead takes the change back through the normal path
    const undo = await ask(deal, (d) => {
      d.terms!.pre_money_minor = '500000000'
      d.company!.legal_name = name
    }, 'We are going back to the earlier valuation.')
    const row = (await t.owner.query<{ snapshot: Record<string, unknown> }>('SELECT snapshot FROM deal_version WHERE deal_id = $1 AND n = $2', [deal, first])).rows[0]!
    expect((await t.owner.query<{ s: string }>('SELECT proposed_snapshot AS s FROM change_request WHERE id = $1', [undo.json().id])).rows[0]!.s).toEqual(row.snapshot)
    expect((await decide(undo.json().id)).json().state).toBe('applied')
    const now = (await dealRow(deal)).approved_version
    expect(await pending(b.p)).toBe(0)
    expect((await t.owner.query('SELECT agreed_version FROM participation WHERE id = $1', [b.p])).rows[0]!.agreed_version).toBe(now)
    expect((await statusOf(b.u, deal)).status).toBe('funded')
    expect((await instructions(b.u, b.p)).statusCode).toBe(200)
    expect(await pending(a.p)).toBe(1)
    expect((await reconfirmOf(a.u, a.p)).differences).toContainEqual({ field: 'key_terms.pre_money_minor', before: '600000000', after: '500000000' })
    // the same for one person's terms put back while they stayed silent
    const c1 = (await personTerms(deal, b.p, {})).json().id
    await decide(c1)
    expect(await pending(b.p)).toBe(1)
    const c2 = (await personTerms(deal, b.p, { fee: { kind: 'none' }, summary: 'Back to no fee.' })).json().id
    await decide(c2)
    expect(await pending(b.p)).toBe(0)
    expect(await partRow(b.p)).toMatchObject({ cash_due_minor: '200000', agreed_terms_n: 2 })
    // one person's terms are never among anyone else's updates
    const ups = (await inject('GET', `/api/my/deals/${deal}/updates`, a.u)).json().updates as Array<{ summary: string }>
    expect(ups.map((x) => x.summary)).toEqual(['We are going back to the earlier valuation.'])
    expect((await statusOf(b.u, deal)).status).toBe('funded')
  })

  it('R-ALO-04 a larger allocation tells the lead when people are waiting', async () => {
    const deal = await liveDeal(lead, { terms: { ...draftFor('x').terms, allocation_minor: '1000000', over_allocation: 'stop_and_waitlist' } })
    const full = await investor(deal)
    const done = await commit(full.u, deal, full.entity, '1000000')
    expect(done.statusCode, done.body).toBe(200)
    const w = await investor(deal)
    expect((await inject('POST', `/api/my/deals/${deal}/waitlist`, w.u, { desired_minor: '200000' })).statusCode).toBe(200)
    const roomMails = async () => (await subjects(lead.email)).filter((x) => x.startsWith('Room may have opened')).length
    const was = await roomMails()
    const cid = (await ask(deal, (d) => (d.terms!.allocation_minor = '2000000'), 'More room.')).json().id
    expect((await decide(cid, { verdict: 'notice', reason: 'More room for the waiting list.' })).json().state).toBe('applied')
    expect(await roomMails()).toBe(was + 1)
    expect((await mailTo(lead.email)).some((m) => m.body.includes('allocation of a deal with people on its waiting list is now larger'))).toBe(true)
  })
})

describe('D4 whom to invite (R-PIP-06, decision R29)', () => {
  it('TC-PIP-05 no list and no targeted invitation before the lead confirms the operator’s text, by version; another lead’s confirmation does not count; the sandbox asks too', async () => {
    const lead5 = await person('pip5-lead@example.test')
    const deal = await liveDeal(lead5, {}, { confirm: false })
    const link = (await links(deal, lead5)).find((l) => l.is_default)!.id
    const row = 'Pat Expected, pat5@example.test, 1000, standard, met at a dinner'
    const refusedAll = async (why: RegExp) => {
      for (const [url, body] of [
        [`/api/deals/${deal}/pipeline`, { text: row }],
        [`/api/deals/${deal}/pipeline`, { text: row, dry_run: true }],
        [`/api/deals/${deal}/targeted`, { email: 'tara5@example.test', link_id: link }],
      ] as const) {
        const r = await inject('POST', url, lead5, body)
        expect(r.statusCode, url).toBe(409)
        expect(r.json().error, url).toMatch(why)
      }
    }
    // this instance is in the sandbox: the text is the template's placeholder and still has to be confirmed
    expect((await t.owner.query('SELECT mode FROM instance_profile')).rows[0].mode).toBe('sandbox')
    const shown = (await inject('GET', `/api/deals/${deal}/invitee-policy`, lead5)).json()
    expect(shown).toMatchObject({ confirmed: false, confirmed_before: false, text: { version: 1, placeholder: true } })
    expect(shown.text.body).toMatch(/whom a lead may invite/)
    await refusedAll(/confirm it first/)
    expect(await count('SELECT count(*) AS n FROM pipeline_entry WHERE deal_id = $1', [deal])).toBe(0)
    expect(await count('SELECT count(*) AS n FROM targeted_invite WHERE deal_id = $1', [deal])).toBe(0)

    // the lead's own confirmation, made on another deal, does not count for this one's lead
    const other = await liveDeal(lead)
    expect((await inject('GET', `/api/deals/${other}/invitee-policy`, lead)).json().confirmed).toBe(true)
    await refusedAll(/confirm it first/)
    // what was confirmed must be what is in force: another version number or other words are refused
    for (const wrong of [{ version: 2, sha256: shown.text.sha256 }, { version: 1, sha256: '0'.repeat(64) }]) {
      const r = await inject('POST', `/api/deals/${deal}/invitee-policy`, lead5, wrong)
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toMatch(/changed this text/)
    }
    // someone who is not a lead of this deal cannot confirm on it
    expect((await inject('POST', `/api/deals/${deal}/invitee-policy`, lead, { version: 1, sha256: shown.text.sha256 })).statusCode).toBe(409)

    const ok = await inject('POST', `/api/deals/${deal}/invitee-policy`, lead5, { version: 1, sha256: shown.text.sha256 })
    expect(ok.statusCode, ok.body).toBe(200)
    // confirming again records nothing new
    expect((await inject('POST', `/api/deals/${deal}/invitee-policy`, lead5, { version: 1, sha256: shown.text.sha256 })).statusCode).toBe(200)
    const lead5Id = (await t.owner.query<{ id: string }>("SELECT id FROM user_account WHERE email = 'pip5-lead@example.test'")).rows[0]!.id
    const acks = (
      await t.owner.query<{ id: string; text_version: number; text_sha256: string; deal_id: string; pack_id: string; created_at: Date }>(
        'SELECT id, text_version, text_sha256, deal_id, pack_id, created_at FROM invitee_policy_ack WHERE user_id = $1',
        [lead5Id],
      )
    ).rows
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ text_version: 1, text_sha256: shown.text.sha256, deal_id: deal })
    expect(acks[0]!.created_at).toBeInstanceOf(Date)
    const audit = (
      await t.owner.query<{ actor_id: string; detail: string }>(
        "SELECT a.actor_id, d.detail FROM audit a JOIN audit_detail d ON d.audit_seq = a.seq WHERE a.action = 'invitee_policy.confirmed' AND a.entity_id = $1",
        [acks[0]!.id],
      )
    ).rows
    expect(audit.map((a) => ({ ...a, detail: JSON.parse(a.detail) }))).toEqual([{ actor_id: lead5Id, detail: { version: 1, sha256: shown.text.sha256 } }])
    // a confirmation is never changed or taken away
    await expect(t.app.query('UPDATE invitee_policy_ack SET text_version = 2 WHERE id = $1', [acks[0]!.id])).rejects.toThrow()
    await expect(t.app.query('DELETE FROM invitee_policy_ack WHERE id = $1', [acks[0]!.id])).rejects.toThrow()

    const added = await inject('POST', `/api/deals/${deal}/pipeline`, lead5, { text: row })
    expect(added.statusCode, added.body).toBe(200)
    expect(added.json().added).toBe(1)
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead5, { email: 'tara5@example.test', link_id: link })).statusCode).toBe(200)

    // the operator loads a pack with a new version of the text: refused again until confirmed again
    const before = (await t.owner.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile')).rows[0]!.active_pack_id
    const pack = (await packContent(t.owner, before))!
    const newer = {
      ...pack,
      version: pack.version + 1000,
      legal_texts: pack.legal_texts.map((x) => (x.text_key === 'invitee_policy' ? { ...x, version: 2, body: `${x.body} Second version.` } : x)),
    }
    const newId = await tx(t.owner as never, (c) => insertPack(c, newer, { builtIn: false, by: null }))
    await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [newId])
    try {
      const again = (await inject('GET', `/api/deals/${deal}/invitee-policy`, lead5)).json()
      expect(again).toMatchObject({ confirmed: false, confirmed_before: true, text: { version: 2 } })
      await refusedAll(/changed its text/)
      const pipe = (await inject('GET', `/api/deals/${deal}/pipeline`, lead5)).json().rows as Array<{ id: string; targeted_invite: string | null }>
      const sent = pipe[0]!
      // sending from the list and resending are refused as well
      const viaList = await inject('POST', `/api/deals/${deal}/pipeline/invite`, lead5, { entries: [{ id: sent.id, link_id: link }], confirm_count: 1, plan_sha256: '0'.repeat(64) })
      expect(viaList.json().error).toMatch(/changed its text/)
      const tid = (await t.owner.query<{ id: string }>("SELECT id FROM targeted_invite WHERE deal_id = $1 AND email = 'tara5@example.test'", [deal])).rows[0]!.id
      const resend = await inject('POST', `/api/deals/${deal}/targeted/${tid}/resend`, lead5, {})
      expect(resend.json().error).toMatch(/changed its text/)
      const ok2 = await inject('POST', `/api/deals/${deal}/invitee-policy`, lead5, { version: 2, sha256: again.text.sha256 })
      expect(ok2.statusCode, ok2.body).toBe(200)
      expect((await inject('POST', `/api/deals/${deal}/targeted/${tid}/resend`, lead5, {})).statusCode).toBe(200)
      expect(await count('SELECT count(*) AS n FROM invitee_policy_ack WHERE user_id = $1', [lead5Id])).toBe(2)
    } finally {
      await t.owner.query('UPDATE instance_profile SET active_pack_id = $1', [before])
    }
  })
})

describe('D4 lead panel: list, waiting on, days, figures, export (R-ADM-02, R-ADM-05, R-ADM-07, R-ADM-11)', () => {
  interface Row {
    invitation_id: string
    participation_id: string | null
    status: string
    label: string
    waiting: string | null
    days: number | null
    own: boolean
    entity: string | null
    commitment_minor: string | null
    received_minor: string
    lead_fee_minor: string
    carry_bps: number
  }
  const panel = async (deal: string, q = '', who = lead) => inject('GET', `/api/deals/${deal}/panel${q}`, who)
  const rowsOf = async (deal: string, q = '') => (await panel(deal, q)).json().rows as Row[]
  async function receive(p: string, amount: string) {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: amount,
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '12345678',
    })
    expect(r.statusCode, r.body).toBe(200)
  }
  async function committed(deal: string, amount = '1000000', o: { entityName?: string; leader?: Client; signed?: boolean; link?: string } = {}) {
    const ls = await links(deal, o.leader)
    const cookie = await open(tokenOf(await urlOf(deal, o.link ?? ls.find((l) => l.is_default && l.carry_bps === 2000)!.id, o.leader)))
    const u = await person(unique('panel'), cookie)
    expect((await inject('POST', '/api/invite/accept', u, {})).statusCode).toBe(200)
    await qualify(u)
    const entity = await newEntity(u, o.entityName)
    await passKyc(entity)
    expect((await commit(u, deal, entity, amount)).statusCode).toBe(200)
    const p = await pid(u, deal)
    if (o.signed !== false) expect((await sign(u, p)).statusCode).toBe(200)
    return { u, entity, p }
  }
  /** A new policy version with these export roles, keeping the rest; with no policy yet, the pack's defaults as policyNow reads them. */
  async function exportTo(roles: string[]) {
    await t.owner.query(
      `INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count)
       SELECT coalesce(max(version), 0) + 1,
              coalesce((array_agg(per_link_terms ORDER BY version DESC))[1], true), coalesce((array_agg(generic_links ORDER BY version DESC))[1], true),
              coalesce((array_agg(bulk_promo ORDER BY version DESC))[1], true), $1, coalesce((array_agg(reminder_count ORDER BY version DESC))[1], 2)
         FROM operator_policy`,
      [roles],
    )
  }
  const exportRoles = async () =>
    (await t.owner.query<{ export_roles: string[] }>('SELECT export_roles FROM operator_policy ORDER BY version DESC LIMIT 1')).rows[0]?.export_roles ?? ['admin', 'reviewer']

  it('TC-STAT-06 / TC-ADM-02 each person by status and who it waits on; days at the step by the fixed clock; filters; a refusal reads as with the operator; no documents or reasons', async () => {
    const deal = await liveDeal(lead)
    const a = await investor(deal)
    const b = await committed(deal)
    expect((await instructions(b.u, b.p)).statusCode).toBe(200)
    const c = await committed(deal)
    await receive(c.p, '1000000')
    const e = await committed(deal)
    await receive(e.p, '500000')
    await t.owner.query("UPDATE participation SET outcome = 'rejected_kyc', ended_at = now() WHERE id = $1", [e.p])
    // a case with a reviewer: what the lead sees is only who it waits on
    const f = await committed(deal, '1000000', { signed: false })
    await t.owner.query("UPDATE participation SET identity_review = 'pending' WHERE id = $1", [f.p])
    // an identity check sent to a reviewer
    const k = await committed(deal, '1000000', { signed: false })
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) SELECT $1, id, current_version, 'manual', 'pending_review' FROM legal_entity WHERE id = $2", [
      randomUUID(),
      k.entity,
    ])
    // left the deal with money still to give back
    const w = await committed(deal)
    await receive(w.p, '300000')
    await t.owner.query("UPDATE participation SET outcome = 'withdrawn', ended_at = now() WHERE id = $1", [w.p])
    // paid in full with a refund being prepared: a reviewer's
    const rf = await committed(deal)
    await receive(rf.p, '1000000')

    const r = await panel(deal)
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json().rows as Row[]
    const row = (p: string) => rows.find((x) => x.participation_id === p)!
    expect(rows.find((x) => x.participation_id === null && x.invitation_id && x.status === 'deciding')).toBeTruthy()
    expect(row(b.p)).toMatchObject({ status: 'to_pay', waiting: 'investor', entity: 'Fay Fictional', commitment_minor: '1000000', received_minor: '0' })
    expect(row(c.p)).toMatchObject({ status: 'funded', waiting: null, received_minor: '1000000' })
    expect(row(e.p)).toMatchObject({ status: 'with_operator', label: 'With the operator', waiting: 'reviewer' })
    expect(row(f.p).waiting).toBe('reviewer')
    expect(row(k.p)).toMatchObject({ status: 'verifying', waiting: 'reviewer' })
    expect(row(w.p)).toMatchObject({ status: 'withdrawn', waiting: 'reviewer' })
    expect(row(rf.p)).toMatchObject({ status: 'funded', waiting: null })
    // £0.01 too much, its refund approved and on its way: funded again, but a reviewer's until the refund is done
    await receive(rf.p, '1')
    const prep = await inject('POST', `/api/review/participations/${rf.p}/refunds`, reviewer, { amount_minor: '1' })
    expect(prep.statusCode, prep.body).toBe(200)
    expect((await inject('POST', `/api/review/refunds/${prep.json().id}/approve`, reviewer2)).statusCode).toBe(200)
    expect((await rowsOf(deal)).find((x) => x.participation_id === rf.p)).toMatchObject({ status: 'funded', waiting: 'reviewer' })
    // R-ADM-05, R-KYC-02.1: no refusal, no identity review, no overlay names, no documents
    expect(r.body).not.toMatch(/not_approved|Not approved|identity_review|needs_check|rejected|overlays|kyc/i)
    expect(rows.every((x) => !x.own)).toBe(true)
    // "I have paid": now the reviewer's to check
    expect((await inject('POST', `/api/my/participations/${b.p}/paid`, b.u, {})).statusCode).toBe(200)
    expect((await rowsOf(deal)).find((x) => x.participation_id === b.p)).toMatchObject({ status: 'payment_sent', waiting: 'reviewer' })

    // filters, and how many are in each
    expect(new Set((await rowsOf(deal, '?status=funded')).map((x) => x.participation_id))).toEqual(new Set([c.p, rf.p]))
    expect((await rowsOf(deal, '?waiting=none')).map((x) => x.participation_id)).toEqual([c.p])
    expect(new Set((await rowsOf(deal, '?waiting=reviewer')).map((x) => x.participation_id))).toEqual(new Set([b.p, e.p, f.p, k.p, w.p, rf.p]))
    expect((await rowsOf(deal, '?status=with_operator&waiting=investor')).length).toBe(0)
    expect((await panel(deal, '?status=nonsense')).statusCode).toBe(400)
    expect((await panel(deal, '?waiting=lead&extra=1')).statusCode).toBe(400)
    expect((await panel(deal)).json().counts).toMatchObject({ status: { funded: 2, deciding: 1, payment_sent: 1, with_operator: 1, withdrawn: 1 }, waiting: { none: 1 } })

    // days at the step, by the app's clock: from the latest thing recorded on the person's part
    await t.owner.query("UPDATE deal_invitation SET created_at = created_at - interval '2 days' WHERE deal_id = $1 AND user_id = $2", [deal, a.u.id])
    const was = clock
    clock = new Date(Date.now() + 3 * 86_400_000 + 60_000)
    try {
      const later = await rowsOf(deal)
      expect(later.find((x) => x.participation_id === null)!.days).toBe(5)
      expect(later.find((x) => x.participation_id === c.p)!.days).toBe(3)
      // a new event starts the count again (the database stamps it now: put it at the app's time)
      await receive(c.p, '1')
      await t.owner.query("UPDATE receipt SET created_at = $2 WHERE participation_id = $1 AND amount_minor = 1", [c.p, clock])
      expect((await rowsOf(deal)).find((x) => x.participation_id === c.p)!).toMatchObject({ status: 'refund_due', waiting: 'reviewer', days: 0 })
    } finally {
      clock = was
    }

    // only the lead and the deal's team: an investor, a reviewer or another lead gets "not found"
    for (const who of [b.u, reviewer, admin]) expect((await panel(deal, '', who)).statusCode, who.email).toBe(409)
    const lead2 = await person(unique('panel-other-lead'))
    expect((await panel(deal, '', lead2)).json().error).toBe('Not found.')
  })

  it('TC-ADM-01 the figures come from the rules and match a hand count', async () => {
    const deal = await liveDeal(lead)
    await investor(deal)
    const b = await committed(deal, '2000000')
    const c = await committed(deal, '1000000')
    await receive(c.p, '1000000')
    const d2 = await committed(deal, '1500000')
    await receive(d2.p, '400000')
    const e = await committed(deal, '3000000')
    await receive(e.p, '700000')
    await t.owner.query("UPDATE participation SET outcome = 'rejected_kyc', ended_at = now() WHERE id = $1", [e.p])
    const g = await committed(deal, '500000')
    await receive(g.p, '600000')
    void b
    // a link with a 4% lead fee on top: £10,000 commitment, £10,400 to pay, all paid: the fee is £400 of it
    const feeLink = await inject('POST', `/api/deals/${deal}/links`, lead, {
      kind: 'open',
      carry_bps: 2000,
      fee: { kind: 'percent', bps: 400, mode: 'on_top' },
      reason: 'Arranging fee',
      confirm: true,
    })
    expect(feeLink.statusCode, feeLink.body).toBe(200)
    const h = await committed(deal, '1000000', { link: feeLink.json().id })
    await receive(h.p, '1040000')
    const m = (await panel(deal)).json()
    // by hand: committed = 2,000,000 + 1,000,000 + 1,500,000 + 500,000 (the refused person's 3,000,000 does not count);
    // received = 1,000,000 + 400,000 + 700,000 + 600,000; the refused person's 700,000 is with the operator; g paid 100,000 too much.
    // No lead fee on the default link, so usable gross = what counts: 1,000,000 + 400,000 + 500,000; h adds 1,000,000 of
    // commitment, 1,040,000 received, 40,000 lead fee and 1,000,000 usable.
    expect(m.metrics).toEqual({
      committed_minor: '6000000',
      received_minor: '3740000',
      refund_due_minor: '100000',
      refunded_minor: '0',
      operator_handling_minor: '700000',
      lead_fees_minor: '40000',
      usable_gross_minor: '2900000',
    })
    expect((m.rows as Row[]).find((r) => r.participation_id === h.p)).toMatchObject({ lead_fee_minor: '40000', carry_bps: 2000, received_minor: '1040000' })
    expect(m.currency).toBe('GBP')
  })

  it('TC-ADM-05 the export: refused unless the operator allows leads; formulas guarded; written to the audit', async () => {
    const deal = await liveDeal(lead)
    const x = await committed(deal, '1000000', { entityName: '=HYPERLINK("http://x")' })
    await receive(x.p, '250000')
    const before = await count("SELECT count(*) AS n FROM audit WHERE action = 'investors.exported'")
    const pol = await exportRoles()
    await exportTo(pol.filter((r) => r !== 'lead'))
    try {
      const no = await inject('GET', `/api/deals/${deal}/investors.csv`, lead)
      expect(no.json().error).toMatch(/does not allow/)
      expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'investors.exported'")).toBe(before)
      await exportTo([...pol.filter((r) => r !== 'lead'), 'lead'])
      const r = await inject('GET', `/api/deals/${deal}/investors.csv`, lead)
      expect(r.statusCode, r.body).toBe(200)
      expect(r.headers['content-type']).toMatch(/text\/csv/)
      const lines = r.body.split('\r\n')
      expect(lines[0]).toBe('name,entity,status,waiting_on,days_at_step,currency,commitment,received,lead_fee,carry_percent')
      const line = lines.find((l) => l.includes('HYPERLINK'))!
      expect(line).toContain(`"'=HYPERLINK(""http://x"")"`)
      expect(line).toMatch(/,Part paid,investor,\d+,GBP,10000\.00,2500\.00,0\.00,20\.00$/)
      expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'investors.exported' AND entity_id = $1", [deal])).toBe(1)
      // an investor cannot export
      expect((await inject('GET', `/api/deals/${deal}/investors.csv`, x.u)).statusCode).toBe(409)
    } finally {
      await exportTo(pol)
    }
  })

  it('TC-AUTHZ-06 a lead invests through the same steps as anyone; other investors never see the lead’s commitment', async () => {
    const lead8 = await person(unique('panel-lead'))
    const deal = await liveDeal(lead8)
    const ls = await inject('GET', `/api/deals/${deal}/links`, lead8)
    expect(ls.statusCode, ls.body).toBe(200)
    const cookie = await open(tokenOf(await urlOf(deal, (ls.json().links as LinkView[]).find((l) => l.is_default && l.carry_bps === 2000)!.id, lead8)))
    expect((await inject('POST', '/api/invite/accept', lead8, {}, cookie)).statusCode).toBe(200)
    const entity = leadEntities.get(lead8.id)!
    // not qualified yet: refused as anyone would be
    const early = await commit(lead8, deal, entity, '1234500')
    expect(early.statusCode).not.toBe(200)
    await qualify(lead8)
    await passKyc(entity)
    const ok = await commit(lead8, deal, entity, '1234500')
    expect(ok.statusCode, ok.body).toBe(200)
    const own = (await panel(deal, '', lead8)).json().rows as Row[]
    expect(own.find((r) => r.commitment_minor === '1234500')).toMatchObject({ own: true, status: 'to_sign' })

    // another investor in the same deal: nothing they can read names the lead's amount
    const other = await committed(deal, '1000000', { leader: lead8 })
    for (const url of [`/api/my/deals/${deal}`, `/api/my/deals/${deal}/updates`, '/api/my/participations', '/api/my/deals']) {
      const r = await inject('GET', url, other.u)
      expect(r.statusCode, url).toBe(200)
      expect(r.body, url).not.toMatch(/1234500|12,345|12345\.00/)
    }
  })
})

describe('D4 lead panel: preview, calculator, copy (R-ADM-01, R-ADM-03, R-PIP-05)', () => {
  const tally = async (deal: string) => ({
    parts: await count('SELECT count(*) AS n FROM participation WHERE deal_id = $1', [deal]),
    invitations: await count('SELECT count(*) AS n FROM deal_invitation WHERE deal_id = $1', [deal]),
    views: await count('SELECT count(*) AS n FROM deal_view WHERE deal_id = $1', [deal]),
  })

  it('TC-AUTHZ-05 preview as an investor: read only, the default terms, nothing created, audited; only those who run the deal', async () => {
    const deal = await liveDeal(lead)
    const before = await tally(deal)
    const r = await inject('GET', `/api/deals/${deal}/investor-preview`, lead)
    expect(r.statusCode, r.body).toBe(200)
    const p = r.json()
    expect(p).toMatchObject({ preview: true, read_only: true, name: 'Seedling Round', company: { legal_name: 'Seedling Ltd' } })
    expect(p.key_terms).toMatchObject({ carry: '20.00%', currency: 'GBP', instrument: 'equity' })
    expect(p.warnings.length).toBeGreaterThan(1)
    for (const w of p.warnings) expect(w.text.length, w.variant).toBeGreaterThan(0)
    // no way to commit, nothing of anyone's own
    expect(p).not.toHaveProperty('can_commit')
    expect(p).not.toHaveProperty('participations')
    expect(await tally(deal)).toEqual(before)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'deal.previewed_as_investor' AND entity_id = $1 AND actor_id = $2", [deal, lead.id])).toBe(1)
    // an investor in the deal, a stranger and a reviewer (who reads in the workbench) get the same refusal as a missing deal
    const { u } = await investor(deal)
    for (const who of [u, await person(unique('stranger')), reviewer]) expect((await inject('GET', `/api/deals/${deal}/investor-preview`, who)).statusCode).not.toBe(200)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'deal.previewed_as_investor' AND entity_id = $1", [deal])).toBe(1)
    // before approval there is nothing to preview
    const draft = (await inject('POST', '/api/deals', lead, {})).json().id as string
    const early = await inject('GET', `/api/deals/${draft}/investor-preview`, lead)
    expect(early.statusCode).not.toBe(200)
    expect(early.body).toMatch(/once the deal is approved/)
  })

  it('TC-ADM-01 calculator: what to raise for X to reach the company, by the deal’s fee and payer, as an estimate', async () => {
    const deal = await liveDeal(lead)
    const calc = (id: string, target: string, who = lead) => inject('POST', `/api/deals/${id}/calculator`, who, { target_minor: target })
    // 2.5%, minimum £4,000: £100,000 to the company needs £104,000
    const r = await calc(deal, '10000000')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ payer: 'investors', raise_minor: '10400000', fee_minor: '400000', net_minor: '10000000', estimate: true })
    expect(r.json().note).toMatch(/estimate/i)
    expect((await calc(deal, '48750000')).json().raise_minor).toBe('50000000')
    // a draft where the lead pays: raise X, the fee on top
    const ent = leadEntities.get(lead.id)!
    const d2 = (await inject('POST', '/api/deals', lead, {})).json().id as string
    expect((await inject('PUT', `/api/deals/${d2}/draft`, lead, draftFor(ent, { economics: { default_carry_bps: 2000, fee_payer: 'lead' } }))).statusCode).toBe(200)
    expect((await calc(d2, '10000000')).json()).toMatchObject({ payer: 'lead', raise_minor: '10000000', fee_minor: '400000' })
    // the company pays: the fee comes out of what it is paid, so £100,000 to it needs £104,000
    expect((await inject('PUT', `/api/deals/${d2}/draft`, lead, draftFor(ent, { economics: { default_carry_bps: 2000, fee_payer: 'company' } }))).statusCode).toBe(200)
    expect((await calc(d2, '10000000')).json()).toMatchObject({ payer: 'company', raise_minor: '10400000', fee_minor: '400000', net_minor: '10000000' })
    // no payer chosen yet, bad amounts, someone else's deal
    const d3 = (await inject('POST', '/api/deals', lead, {})).json().id as string
    expect((await calc(d3, '10000000')).statusCode).not.toBe(200)
    for (const bad of ['0', '-1', '1.5', '01', '99999999999999999']) expect((await calc(deal, bad)).statusCode, bad).not.toBe(200)
    expect((await calc(deal, '10000000', await person(unique('stranger')))).statusCode).not.toBe(200)
  })

  it('TC-PIP-04 copy a deal: only the listed fields, no company, valuation, price, files or approvals; invited people as name and address', async () => {
    const deal = await liveDeal(lead, {
      terms: { ...draftFor('x').terms, custom_terms: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pro rata rights.' }] }] } },
    })
    const a = await investor(deal)
    // a targeted invitation from the list, and a list row never invited
    expect((await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: 'name,email,expected\nTara Target,tara.target@example.test,5000\nNed Never,ned@example.test,7000' })).statusCode).toBe(200)
    const rows = (await inject('GET', `/api/deals/${deal}/pipeline`, lead)).json().rows as Array<{ id: string; email: string }>
    await t.owner.query("UPDATE pipeline_entry SET targeted_invite = (SELECT id FROM targeted_invite LIMIT 1) WHERE deal_id = $1 AND email = 'tara.target@example.test'", [deal])
    expect(rows.length).toBe(2)
    if (!(await count('SELECT count(*) AS n FROM targeted_invite'))) {
      // no targeted invitation anywhere yet: send one so the row counts as invited
      const link = (await links(deal)).find((l) => l.is_default && l.carry_bps === 2000)!.id
      expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: 'tara.target@example.test', link_id: link })).statusCode).toBe(200)
      await t.owner.query("UPDATE pipeline_entry SET targeted_invite = (SELECT id FROM targeted_invite LIMIT 1) WHERE deal_id = $1 AND email = 'tara.target@example.test'", [deal])
    }

    const r = await inject('POST', `/api/deals/${deal}/copy`, lead, { import_invited: true })
    expect(r.statusCode, r.body).toBe(200)
    const id = r.json().id as string
    const row = (await t.owner.query('SELECT state, lead_user, draft, syndicate_id, approved_version, pack_id, fee_config_id, submitted_at FROM deal WHERE id = $1', [id])).rows[0]
    const src = (await t.owner.query<{ syndicate_id: string }>('SELECT syndicate_id FROM deal WHERE id = $1', [deal])).rows[0]!
    expect(row).toMatchObject({ state: 'draft', lead_user: lead.id, syndicate_id: null, approved_version: null, pack_id: null, fee_config_id: null, submitted_at: null })
    expect(row.draft).toEqual({
      basics: { structure: 'uk_bare_trust', syndicate: { mode: 'existing', id: src.syndicate_id } },
      terms: { instrument: 'equity', custom_terms: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pro rata rights.' }] }] } },
      economics: {
        default_carry_bps: 2000,
        recipients: [{ kind: 'person', first_name: 'Cara', last_name: 'Carry', email: 'cara.carry@example.test', share_bps: 10000 }],
        fee_payer: 'investors',
      },
    })
    expect(await count('SELECT count(*) AS n FROM stored_file WHERE owner_id = $1', [id])).toBe(0)
    expect(await count('SELECT count(*) AS n FROM deal_version WHERE deal_id = $1', [id])).toBe(0)
    expect(await count('SELECT count(*) AS n FROM invite_link WHERE deal_id = $1', [id])).toBe(0)
    // the invited, by name and address only; the list row never invited is not carried
    const copied = (
      await t.owner.query('SELECT name, email, expected_minor, terms_label, invite_link, private_note, targeted_invite FROM pipeline_entry WHERE deal_id = $1 ORDER BY email', [id])
    ).rows
    const accountOf = (await t.owner.query<{ name: string; email: string }>('SELECT name, email FROM user_account WHERE id = $1', [a.u.id])).rows[0]!
    const blank = { expected_minor: null, terms_label: '', invite_link: null, private_note: null, targeted_invite: null }
    expect(copied).toEqual(
      expect.arrayContaining([
        { name: accountOf.name, email: accountOf.email, ...blank },
        { name: 'Tara Target', email: 'tara.target@example.test', ...blank },
      ]),
    )
    expect(copied.map((x) => x.email)).not.toContain('ned@example.test')
    expect(r.json().invited).toBe(copied.length)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'deal.copied' AND entity_id = $1", [id])).toBe(1)

    // no right to the deal: refused as if it did not exist; an investor in it too
    for (const who of [await person(unique('stranger')), a.u]) expect((await inject('POST', `/api/deals/${deal}/copy`, who, {})).statusCode).not.toBe(200)
    // R-PIP-06: importing the people needs the lead's own confirmation; copying alone does not
    const lead9 = await person(unique('copy-lead'))
    const own = await liveDeal(lead9, {}, { confirm: false })
    expect((await inject('POST', `/api/deals/${own}/copy`, lead9, { import_invited: true })).statusCode).not.toBe(200)
    const plain = await inject('POST', `/api/deals/${own}/copy`, lead9, {})
    expect(plain.statusCode, plain.body).toBe(200)
    expect(plain.json().invited).toBe(0)
    // a team member may copy with the people too (R-PIP-05): they confirm the text themselves, which changes nothing on the deal
    const mate = await person(unique('copy-member'))
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, mate.id])
    expect((await inject('POST', `/api/deals/${deal}/copy`, mate, { import_invited: true })).statusCode).not.toBe(200)
    const before = (await t.owner.query('SELECT draft, updated_at FROM deal WHERE id = $1', [deal])).rows[0]
    await confirmPolicy(mate, deal)
    expect((await t.owner.query('SELECT draft, updated_at FROM deal WHERE id = $1', [deal])).rows[0]).toEqual(before)
    const theirs = await inject('POST', `/api/deals/${deal}/copy`, mate, { import_invited: true })
    expect(theirs.statusCode, theirs.body).toBe(200)
    expect(theirs.json().invited).toBe(copied.length)
    // the stranger still cannot confirm on a deal they do not run
    const stranger = await person(unique('stranger2'))
    const shown = (await inject('GET', `/api/deals/${deal}/invitee-policy`, mate)).json()
    expect((await inject('POST', `/api/deals/${deal}/invitee-policy`, stranger, { version: shown.text.version, sha256: shown.text.sha256 })).statusCode).not.toBe(200)
  })
})

describe('D4 lead panel: row actions, terms, files, memo (R-ADM-06, R-ADM-08, R-ADM-09, R-ADM-10)', () => {
  interface Act {
    action: string
    allowed: boolean
    why: string | null
    confirm?: string
  }
  interface Row {
    invitation_id: string
    participation_id: string | null
    actions: Act[]
  }
  const ACTIONS = ['email', 'view_documents', 'remove', 'withdrawal', 'replace_link', 'amount_proposal', 'change_terms'] as const
  type ActionName = (typeof ACTIONS)[number]
  const rowsOf = async (deal: string, who = lead) => {
    const r = await inject('GET', `/api/deals/${deal}/panel`, who)
    expect(r.statusCode, r.body).toBe(200)
    return r.json().rows as Row[]
  }
  const acts = async (deal: string, p: string | null, who = lead) => {
    const row = (await rowsOf(deal, who)).find((x) => x.participation_id === p)!
    return { inv: row.invitation_id, a: Object.fromEntries(row.actions.map((x) => [x.action, x])) as Record<ActionName, Act> }
  }
  const draftOf = async (deal: string) =>
    (await t.owner.query<{ draft: Record<string, Record<string, unknown>>; approved_version: number }>('SELECT draft, approved_version FROM deal WHERE id = $1', [deal]))
      .rows[0]!
  async function ask(deal: string, edit: (d: Record<string, Record<string, unknown>>) => void, summary: string) {
    const row = await draftOf(deal)
    const draft = structuredClone(row.draft)
    edit(draft)
    return inject('POST', `/api/deals/${deal}/changes`, lead, { draft, summary, base_version: row.approved_version })
  }
  async function receive(p: string, amount: string) {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: amount,
      received_on: '2026-11-10',
      payer_name: 'Fay Fictional',
      payer_account: '12345678',
    })
    expect(r.statusCode, r.body).toBe(200)
  }
  async function signedUp(deal: string, amount = '1000000') {
    const x = await investor(deal)
    expect((await commit(x.u, deal, x.entity, amount)).statusCode).toBe(200)
    const p = await pid(x.u, deal)
    expect((await sign(x.u, p)).statusCode).toBe(200)
    return { ...x, p }
  }
  const memo = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

  it('TC-ADM-03 each row lists every action, allowed or with the words the action itself refuses with; the team only reads', async () => {
    const deal = await liveDeal(lead)
    await investor(deal)
    const b = await signedUp(deal)
    const c = await signedUp(deal)
    await receive(c.p, '500000')
    const m = await signedUp(deal)
    expect((await instructions(m.u, m.p)).statusCode).toBe(200)
    expect((await inject('POST', `/api/my/participations/${m.p}/paid`, m.u, {})).statusCode).toBe(200)
    const NOT = 'This person has not committed.'

    // invited, nothing committed: only the link can change
    const inv = await acts(deal, null)
    expect(Object.keys(inv.a)).toEqual(ACTIONS)
    expect(inv.a.replace_link).toMatchObject({ allowed: true, why: null })
    expect(inv.a.email).toMatchObject({ allowed: true, why: null })
    for (const k of ['view_documents', 'remove', 'withdrawal', 'amount_proposal', 'change_terms'] as const) expect(inv.a[k], k).toMatchObject({ allowed: false, why: NOT })

    /** The action refuses with exactly the words the row gave. */
    const sameRefusal = async (row: Act, r: { json(): { error?: string }; statusCode: number }) => {
      expect(row.allowed).toBe(false)
      expect(r.statusCode).not.toBe(200)
      expect(r.json().error).toBe(row.why)
    }
    const otherLink = (await links(deal))[0]!.id as string

    // committed, no money: removal, a new amount and new terms are open; a withdrawal and a new link are not
    const bb = await acts(deal, b.p)
    expect(bb.a.view_documents.allowed).toBe(true)
    expect(bb.a.remove).toEqual({ action: 'remove', allowed: true, why: null })
    expect(bb.a.amount_proposal.allowed).toBe(true)
    expect(bb.a.change_terms.allowed).toBe(true)
    await sameRefusal(bb.a.withdrawal, await inject('POST', `/api/deals/${deal}/participations/${b.p}/withdrawal`, lead, { consent_confirmed: true, evidence: 'Email of 1 Nov.' }))
    await sameRefusal(bb.a.replace_link, await inject('POST', `/api/deals/${deal}/invitations/${bb.inv}/link`, lead, { link_id: otherLink }))

    // money arrived: a withdrawal, not a removal or a new amount
    const cc = await acts(deal, c.p)
    expect(cc.a.withdrawal.allowed).toBe(true)
    await sameRefusal(cc.a.remove, await inject('POST', `/api/deals/${deal}/participations/${c.p}/remove`, lead, {}))
    await sameRefusal(cc.a.amount_proposal, await inject('POST', `/api/deals/${deal}/participations/${c.p}/amount-proposal`, lead, { commitment_minor: '2000000' }))

    // "I have paid": removal asks the lead to confirm where the money is, and no new amount
    const mm = await acts(deal, m.p)
    expect(mm.a.remove).toMatchObject({ allowed: true, confirm: 'money_checked' })
    await sameRefusal(mm.a.amount_proposal, await inject('POST', `/api/deals/${deal}/participations/${m.p}/amount-proposal`, lead, { commitment_minor: '2000000' }))

    // one open at a time: a withdrawal waiting, a new amount waiting, a change waiting
    expect((await inject('POST', `/api/deals/${deal}/participations/${c.p}/withdrawal`, lead, { consent_confirmed: true, evidence: 'Email of 1 Nov.' })).statusCode).toBe(200)
    await sameRefusal(
      (await acts(deal, c.p)).a.withdrawal,
      await inject('POST', `/api/deals/${deal}/participations/${c.p}/withdrawal`, lead, { consent_confirmed: true, evidence: 'Email of 1 Nov.' }),
    )
    expect((await inject('POST', `/api/deals/${deal}/participations/${b.p}/amount-proposal`, lead, { commitment_minor: '2000000' })).statusCode).toBe(200)
    await sameRefusal(
      (await acts(deal, b.p)).a.amount_proposal,
      await inject('POST', `/api/deals/${deal}/participations/${b.p}/amount-proposal`, lead, { commitment_minor: '3000000' }),
    )
    // a proposal past its deadline has ended, so a new one is offered again
    const deadline = (await t.owner.query<{ d: Date }>('SELECT deadline_at AS d FROM amount_proposal WHERE participation_id = $1', [b.p])).rows[0]!.d
    // by the app's clock: a day ahead of it is still waiting, whatever the machine's date
    await t.owner.query('UPDATE amount_proposal SET deadline_at = $2 WHERE participation_id = $1', [b.p, new Date(clock.getTime() + 86_400_000)])
    expect((await acts(deal, b.p)).a.amount_proposal.allowed).toBe(false)
    await t.owner.query('UPDATE amount_proposal SET deadline_at = $2 WHERE participation_id = $1', [b.p, clock])
    expect((await acts(deal, b.p)).a.amount_proposal.allowed).toBe(true)
    await t.owner.query('UPDATE amount_proposal SET deadline_at = $2 WHERE participation_id = $1', [b.p, deadline])
    expect((await ask(deal, (d) => (d.files!.memo = memo('Better words.')), 'Fixed a typo.')).statusCode).toBe(200)
    const bt = (await acts(deal, b.p)).a.change_terms
    await sameRefusal(
      bt,
      await inject('POST', `/api/deals/${deal}/participations/${b.p}/terms`, lead, {
        carry_bps: 1500,
        fee: { kind: 'percent', bps: 400, mode: 'on_top' },
        summary: 'The carry we agreed.',
        base_version: (await draftOf(deal)).approved_version,
      }),
    )

    // the deal's team reads the same list; every action that writes says only the lead or a co-lead may
    const member = await person(unique('panel-team'))
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, member.id])
    const seen = (await acts(deal, b.p, member)).a
    expect(seen.view_documents.allowed).toBe(true)
    for (const k of ACTIONS.filter((a) => a !== 'view_documents')) expect(seen[k], k).toMatchObject({ allowed: false, why: 'Only the lead or a co-lead can do this.' })
    expect((await inject('POST', `/api/deals/${deal}/participations/${b.p}/remove`, member, {})).statusCode).not.toBe(200)

    // outside live: by the state's own words
    await t.owner.query("UPDATE deal SET state = 'closing_requested' WHERE id = $1", [deal])
    try {
      const late = (await acts(deal, m.p)).a
      expect(late.remove.allowed).toBe(true)
      await sameRefusal(late.amount_proposal, await inject('POST', `/api/deals/${deal}/participations/${m.p}/amount-proposal`, lead, { commitment_minor: '2000000' }))
      expect(late.change_terms.why).toBe('A change that investors must reconfirm needs the closing request withdrawn first.')
      expect((await acts(deal, null)).a.replace_link.why).toBe('Links can be replaced only while the deal is live.')
    } finally {
      await t.owner.query("UPDATE deal SET state = 'live' WHERE id = $1", [deal])
    }
  })

  it("TC-ADM-03 one person's documents: what they signed, current and replaced; only those who run the deal; audited", async () => {
    const deal = await liveDeal(lead)
    const b = await signedUp(deal)
    const r = await inject('GET', `/api/deals/${deal}/participations/${b.p}/documents`, lead)
    expect(r.statusCode, r.body).toBe(200)
    const signed = r.json().signed as Array<{ document: string; replaced: boolean; awaiting_deed: boolean; terms_version: number }>
    expect(signed).toHaveLength(1)
    expect(signed[0]).toMatchObject({ replaced: false, awaiting_deed: false, terms_version: 1 })
    expect(signed[0]!.document).toContain('Fay Fictional')
    // no IP, no signing method
    expect(r.body).not.toMatch(/"ip"|auth_method|signed_name/)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'participation.documents_viewed' AND entity_id = $1", [b.p])).toBe(1)
    // the investor, a stranger, another deal's lead: not found; another deal's participation through this deal: not found
    for (const who of [b.u, await person(unique('docs-stranger')), reviewer])
      expect((await inject('GET', `/api/deals/${deal}/participations/${b.p}/documents`, who)).statusCode, who.email).not.toBe(200)
    const other = await liveDeal(lead)
    expect((await inject('GET', `/api/deals/${other}/participations/${b.p}/documents`, lead)).json().error).toBe('Not found.')
  })

  it('TC-ADM-04 terms by how they change, every version and how many saw it, the files, and the memo exactly as investors read it', async () => {
    const deal = await liveDeal(lead, { files: { memo: memo('Seedling grows tomatoes.') } })
    const r0 = await inject('GET', `/api/deals/${deal}/content`, lead)
    expect(r0.statusCode, r0.body).toBe(200)
    const c0 = r0.json()
    const term = (f: string) => (c0.terms as Array<{ field: string }>).find((x) => x.field === f)
    expect(term('terms.target_close')).toMatchObject({ route: 'yourself', live_only: false })
    expect(term('terms.pay_by')).toMatchObject({ route: 'yourself' })
    expect(term('terms.instrument')).toMatchObject({ route: 'reconfirm' })
    expect(term('terms.allocation_minor')).toMatchObject({ route: 'reviewer', live_only: true })
    expect(term('terms.currency')).toMatchObject({ route: 'reconfirm', locked: false, value: 'GBP' })
    expect(term('basics.name')).toMatchObject({ route: 'reviewer', value: 'Seedling Round' })
    expect(c0.terms.some((x: { field: string }) => x.field.startsWith('files.'))).toBe(false)
    expect(c0.memo_change).toMatchObject({ route: 'reviewer' })
    expect(c0.files.deal_sheet).toBe(`/api/deals/${deal}/deal-sheet-preview`)
    expect((await inject('GET', c0.files.deal_sheet, lead)).statusCode).toBe(200)
    expect(c0.versions).toEqual([expect.objectContaining({ n: c0.version, in_force: true, shown_to: 0, self_service: false })])

    // the investor's page and the lead's preview carry the same memo, deck and documents
    const x = await signedUp(deal)
    const page = (await inject('GET', `/api/my/deals/${deal}`, x.u)).json()
    const preview = (await inject('GET', `/api/deals/${deal}/investor-preview`, lead)).json()
    const c1 = (await inject('GET', `/api/deals/${deal}/content`, lead)).json()
    expect(c1.memo).toEqual(page.memo)
    expect(c1.memo).toEqual(preview.memo)
    expect(c1.memo).not.toBeNull()
    expect(c1.files.documents).toEqual(page.documents)
    expect(c1.files.deck).toEqual(page.deck)
    // committed: the currency is locked; the version shows one person was shown it
    expect((c1.terms as Array<{ field: string; locked: boolean }>).find((t) => t.field === 'terms.currency')!.locked).toBe(true)
    expect(c1.versions[0]).toMatchObject({ shown_to: 1 })

    // the lead's own date: a new version, with its sentence, in force; the earlier one kept
    expect((await ask(deal, (d) => (d.terms!.target_close = '2027-02-28'), 'We need four more weeks.')).statusCode).toBe(200)
    const c2 = (await inject('GET', `/api/deals/${deal}/content`, lead)).json()
    expect(c2.versions.map((v: { n: number }) => v.n)).toEqual([c0.version + 1, c0.version])
    expect(c2.versions[0]).toMatchObject({ self_service: true, summary: 'We need four more weeks.', in_force: true, shown_to: 0 })
    expect(c2.versions[1]).toMatchObject({ in_force: false, shown_to: 1 })
    expect((c2.terms as Array<{ field: string; value: unknown }>).find((t) => t.field === 'terms.target_close')!.value).toBe('2027-02-28')

    // the team reads it; an investor and a stranger do not; before approval there is nothing
    for (const who of [x.u, await person(unique('content-stranger'))]) expect((await inject('GET', `/api/deals/${deal}/content`, who)).statusCode).not.toBe(200)
    const draft = (await inject('POST', '/api/deals', lead, {})).json().id as string
    expect((await inject('GET', `/api/deals/${draft}/content`, lead)).json().error).toMatch(/once the deal is approved/)
  })
})

describe('D4 messages (R-COM-01..04, R-CMP-02, R-CMP-03)', () => {
  type Mail = { subject: string; body: string; is_html: boolean; reply_to: string | null }
  const mailsTo = async (to: string) =>
    (await t.owner.query<Mail>('SELECT subject, body, is_html, reply_to FROM sandbox_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at', [to])).rows
  const lapse = (u: Client) => t.owner.query("UPDATE eligibility_statement SET expires_at = $2::timestamptz - interval '1 day' WHERE user_id = $1", [u.id, clock.toISOString()])
  const renew = (u: Client) => t.owner.query("UPDATE eligibility_statement SET expires_at = now() + interval '1 year' WHERE user_id = $1", [u.id])
  const write = (deal: string, to: unknown, subject = 'Founders call on Friday', body = 'Join us at {link}.\n\n<b>Questions</b> welcome.', who = lead) =>
    inject('POST', `/api/deals/${deal}/mail`, who, { subject, body, to })
  async function sendNow(deal: string, to: unknown, who = lead) {
    const w = await write(deal, to, undefined, undefined, who)
    expect(w.statusCode, w.body).toBe(200)
    const r = await inject('POST', `/api/deals/${deal}/mail/${w.json().id}/send`, who, { content_sha256: w.json().content_sha256 })
    expect(r.statusCode, r.body).toBe(200)
    return { id: w.json().id as string, ...(r.json() as { sent: number; excluded: { name: string; why: string }[] }) }
  }
  const rowOf = async (deal: string, u: Client) => {
    const name = (await t.owner.query<{ name: string }>('SELECT name FROM user_account WHERE id = $1', [u.id])).rows[0]!.name
    return ((await inject('GET', `/api/deals/${deal}/panel`, lead)).json().rows as Array<{ name: string; invitation_id: string; actions: Array<{ action: string; allowed: boolean; why: string | null }> }>).find(
      (r) => r.name === name,
    )!
  }
  /** Each person by a name of their own, as the list shows it. */
  async function named(deal: string) {
    const x = await investor(deal)
    await t.owner.query('UPDATE user_account SET name = $2 WHERE id = $1', [x.u.id, unique('Ivy')])
    return x
  }
  async function committed(deal: string) {
    const x = await named(deal)
    expect((await commit(x.u, deal, x.entity, '1000000')).statusCode).toBe(200)
    return x
  }
  async function bulkPromo(on: boolean) {
    await t.owner.query(
      `INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days)
       SELECT coalesce(max(version), 0) + 1, true, true, $1, ARRAY['admin','reviewer','lead'], 0, 3 FROM operator_policy`,
      [on],
    )
  }

  it('TC-COM-01 each status and "committed" as a group, the names of those with a step to do, a single message from a row, kept for both sides', async () => {
    const deal = await liveDeal(lead)
    const deciding = await named(deal)
    const done = await committed(deal)
    const passed = await named(deal)
    expect((await inject('POST', `/api/my/deals/${deal}/pass`, passed.u, {})).statusCode).toBe(200)
    const removed = await committed(deal)
    expect((await inject('POST', `/api/deals/${deal}/participations/${await pid(removed.u, deal)}/remove`, lead, {})).statusCode).toBe(200)
    const panel = (await inject('GET', `/api/deals/${deal}/panel`, lead)).json()
    // every status on the list is a group of its own, of the same size
    for (const [status, n] of Object.entries(panel.counts.status as Record<string, number>)) {
      const a = (await inject('GET', `/api/deals/${deal}/mail/audience?status=${status}`, lead)).json()
      expect(a.people, status).toBe(n)
    }
    expect((await inject('GET', `/api/deals/${deal}/mail/audience?status=declined`, lead)).json().people).toBe(1)
    expect((await inject('GET', `/api/deals/${deal}/mail/audience?committed=true`, lead)).json().people).toBe(1)
    expect((await inject('GET', `/api/deals/${deal}/mail/audience?committed=false`, lead)).json().people).toBe(3)
    const all = (await inject('GET', `/api/deals/${deal}/mail/audience`, lead)).json()
    expect(all.people).toBe(4)
    const waitingOnThem = (panel.rows as Array<{ name: string; waiting: string | null }>).filter((r) => r.waiting === 'investor').map((r) => r.name)
    expect(all.unfinished_names.sort()).toEqual(waitingOnThem.sort())
    expect(all.unfinished_names.length).toBeGreaterThan(0)
    expect((await inject('GET', `/api/deals/${deal}/mail/audience?status=bogus`, lead)).statusCode).toBe(400)

    // single, from the row; replies go to the lead
    const row = await rowOf(deal, deciding.u)
    expect(row.actions.find((a) => a.action === 'email')).toMatchObject({ allowed: true, why: null })
    const one = await sendNow(deal, { invitation_id: row.invitation_id })
    expect(one).toMatchObject({ sent: 1, excluded: [] })
    const got = (await mailsTo(deciding.u.email)).at(-1)!
    expect(got.is_html).toBe(true)
    expect(got.subject).toBe('Founders call on Friday')
    expect(got.reply_to).toBe(lead.email)
    // the text as written: braces stay, markup is escaped
    expect(got.body).toContain('Join us at {link}.')
    expect(got.body).toContain('&lt;b&gt;Questions&lt;/b&gt;')
    expect((await mailsTo(done.u.email)).some((m) => m.subject === 'Founders call on Friday')).toBe(false)

    // kept: the lead's list and the investor's own, each saying replies are not kept
    const kept = (await inject('GET', `/api/deals/${deal}/mail`, lead)).json()
    expect(kept.note).toBe('Only messages sent through this site are kept here. Replies, and anything said outside the site, are not.')
    expect(kept.messages[0]).toMatchObject({ id: one.id, kind: 'single', subject: 'Founders call on Friday', recipients: [{ sent: true, mail: 'sent' }] })
    const mine = (await inject('GET', '/api/my/mail', deciding.u)).json()
    expect(mine.note).toBe(kept.note)
    expect(mine.messages[0]).toMatchObject({ id: one.id, subject: 'Founders call on Friday', body: 'Join us at {link}.\n\n<b>Questions</b> welcome.' })
    expect(mine.messages[0].warning.text).toContain('PLACEHOLDER')
    expect((await inject('GET', '/api/my/mail', done.u)).json().messages).toEqual([])

    // the deal's team reads the archive; only the lead and co-leads write
    const member = await person(unique('mail-team'))
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, member.id])
    expect((await inject('GET', `/api/deals/${deal}/mail`, member)).json().messages).toHaveLength(1)
    expect((await write(deal, { invitation_id: row.invitation_id }, 'Hi', 'Hello', member)).json().error).toBe('Only the lead or a co-lead can do this.')
    expect((await inject('GET', `/api/deals/${deal}/mail`, deciding.u)).statusCode).toBe(409)
    // a sent message stays as sent
    expect((await inject('PUT', `/api/deals/${deal}/mail/${one.id}`, lead, { subject: 'x', body: 'y' })).json().error).toBe('This message has already been sent.')
    expect((await inject('POST', `/api/deals/${deal}/mail/${one.id}/send`, lead, { content_sha256: kept.messages[0].content_sha256 })).json().error).toBe(
      'This message has already been sent.',
    )
  })

  it('TC-COM-02 each person decided for: the message with the warning first, a sign-in notice with nothing in it, or left out and listed', async () => {
    const deal = await liveDeal(lead)
    const code = (await t.owner.query<{ public_code: string }>('SELECT public_code FROM deal WHERE id = $1', [deal])).rows[0]!.public_code
    const yes = await committed(deal)
    const lapsedC = await committed(deal)
    const lapsedI = await named(deal)
    const gone = await named(deal)
    expect((await inject('POST', `/api/my/deals/${deal}/pass`, gone.u, {})).statusCode).toBe(200)
    const removed = await committed(deal)
    expect((await inject('POST', `/api/deals/${deal}/participations/${await pid(removed.u, deal)}/remove`, lead, {})).statusCode).toBe(200)
    const closed = await named(deal)
    await t.owner.query('UPDATE user_account SET disabled_at = now() WHERE id = $1', [closed.u.id])
    await lapse(lapsedC.u)
    await lapse(lapsedI.u)
    const nameOf = async (u: Client) => (await t.owner.query<{ name: string }>('SELECT name FROM user_account WHERE id = $1', [u.id])).rows[0]!.name

    const r = await sendNow(deal, { filter: {} })
    expect(r.sent).toBe(3)
    const ended = 'They no longer take part in this deal.'
    expect(r.excluded).toEqual(
      expect.arrayContaining([
        { name: await nameOf(gone.u), why: ended },
        { name: await nameOf(removed.u), why: ended },
        { name: await nameOf(closed.u), why: 'Their account is closed.' },
      ]),
    )
    expect(r.excluded).toHaveLength(3)

    const promo = (await mailsTo(yes.u.email)).at(-1)!
    expect(promo.is_html).toBe(true)
    expect(promo.body.slice(promo.body.indexOf('<body>') + 6).startsWith('<div role="note" id="warning"><p>')).toBe(true)
    expect(promo.body.indexOf('Join us')).toBeGreaterThan(promo.body.indexOf('</div>'))
    for (const u of [lapsedC.u, lapsedI.u]) {
      const n = (await mailsTo(u.email)).at(-1)!
      expect(n.is_html).toBe(false)
      expect(n.subject).toBe(`You have a new message about a deal: sign in to read it (deal ${code})`)
      expect(n.body).not.toMatch(/Founders|Join us|Questions/)
      expect(holdsNoSeed(n.subject + n.body)).toBe(true)
      expect(n.reply_to).toBe(lead.email)
    }
    for (const u of [gone.u, removed.u, closed.u]) expect((await mailsTo(u.email)).some((m) => m.subject.includes('new message'))).toBe(false)
    // nor kept for them
    expect((await inject('GET', '/api/my/mail', gone.u)).json().messages).toEqual([])
    const variants = (
      await t.owner.query<{ user_id: string; delivery: string; sent_variant: string | null }>(
        'SELECT r.user_id, r.delivery, o.sent_variant FROM message_recipient r LEFT JOIN notification_outbox o ON o.id = r.outbox_id WHERE r.message_id = $1',
        [r.id],
      )
    ).rows
    const v = (u: Client) => variants.find((x) => x.user_id === u.id)
    expect(v(yes.u)).toMatchObject({ delivery: 'message', sent_variant: 'promo' })
    expect(v(lapsedC.u)).toMatchObject({ delivery: 'notice', sent_variant: 'fixed' })
    expect(v(gone.u)).toMatchObject({ delivery: 'excluded', sent_variant: null })

    // the lead sees whether each person got it, not how: the notice is not told apart (§5.2)
    const kept = (await inject('GET', `/api/deals/${deal}/mail`, lead)).json().messages[0]
    expect(kept.recipients.filter((x: { sent: boolean }) => x.sent)).toHaveLength(3)
    expect(JSON.stringify(kept)).not.toMatch(/notice|lapse|statement/)
    // in the site the text waits until the person may see the deal again
    expect((await inject('GET', '/api/my/mail', lapsedC.u)).json().messages[0]).toEqual({ id: r.id, deal_code: code, sent_at: expect.any(String), hidden: true })
    await renew(lapsedC.u)
    expect((await inject('GET', '/api/my/mail', lapsedC.u)).json().messages[0].body).toContain('Join us')

    // someone with no part in the deal is not written to from a row either, in the row's own words
    const row = await rowOf(deal, gone.u)
    const act = row.actions.find((a) => a.action === 'email')!
    expect(act).toMatchObject({ allowed: false, why: 'They no longer take part in this deal.' })
    expect((await write(deal, { invitation_id: row.invitation_id })).json().error).toBe(act.why)

    // paused: nothing is written or sent, in the row's words too
    expect((await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: deal, reason: 'Checking' })).statusCode).toBe(200)
    const held = (await rowOf(deal, yes.u)).actions.find((a) => a.action === 'email')!
    expect(held.why).toBe('The operator has paused this deal.')
    expect((await write(deal, { filter: {} })).json().error).toBe(held.why)
    const hold = (await inject('GET', '/api/holds', reviewer)).json().holds.find((h: { target_id: string; released_at: string | null }) => h.target_id === deal && !h.released_at)
    expect((await inject('POST', `/api/holds/${hold.id}/release`, reviewer2, {})).statusCode).toBe(200)
  })

  it('TC-CMP-07 approved content only, single messages too: an edit after approval stops it; an approver with a stake cannot; fixed mail needs none; the switch stops bulk', async () => {
    const deal = await liveDeal(lead)
    const x = await committed(deal)
    const p = await pid(x.u, deal)
    expect((await sign(x.u, p)).statusCode).toBe(200)
    expect((await instructions(x.u, p)).statusCode).toBe(200)
    const row = await rowOf(deal, x.u)
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = true')
    try {
      for (const to of [{ filter: { committed: true } }, { invitation_id: row.invitation_id }]) {
        const w = (await write(deal, to)).json()
        expect(w.needs_approval).toBe(true)
        const send = (sha: string) => inject('POST', `/api/deals/${deal}/mail/${w.id}/send`, lead, { content_sha256: sha })
        expect((await send(w.content_sha256)).json().error).toBe('An approver must approve this message before it can be sent.')
        // the queue shows it with the words of an internal approval
        const approverM = await staff(unique('approver'), ['approver'])
        const q = (await inject('GET', '/api/approvals/mail', approverM)).json()
        expect(q.note).toBe("This is the operator's internal record that the content was approved. It is not the statutory approval of a financial promotion.")
        const item = q.messages.find((m: { id: string }) => m.id === w.id)
        expect(item).toMatchObject({ subject: 'Founders call on Friday', content_sha256: w.content_sha256 })
        const approve = (sha: string, who = approverM) => inject('POST', `/api/approvals/mail/${w.id}`, who, { content_sha256: sha, self_declared_name: 'Ann Approver' })
        expect((await approve('0'.repeat(64))).json().error).toBe('This message has changed since you opened it. Open it again.')
        expect((await approve(w.content_sha256)).json()).toEqual({ ok: true, note: q.note })
        // changed after approval: not sent; a new text needs its own approval
        const edited = (await inject('PUT', `/api/deals/${deal}/mail/${w.id}`, lead, { subject: 'Founders call moved', body: 'Now Monday.' })).json()
        expect(edited.approved).toBe(false)
        expect((await send(w.content_sha256)).json().error).toBe('This message has changed since you opened it. Open it again.')
        expect((await send(edited.content_sha256)).json().error).toBe('An approver must approve this message before it can be sent.')
        // someone working on the deal cannot approve it
        const inside = await staff(unique('approver-team'), ['approver'])
        await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [deal, inside.id])
        expect((await approve(edited.content_sha256, inside)).json().error).toBe('You cannot approve the content of a deal you lead, work on, or receive carry from.')
        expect((await approve(edited.content_sha256)).statusCode).toBe(200)
        expect((await inject('GET', '/api/approvals/mail', approverM)).json().messages.some((m: { id: string }) => m.id === w.id)).toBe(false)
        expect((await send(edited.content_sha256)).json()).toEqual({ sent: 1, excluded: [] })
        expect((await mailsTo(x.u.email)).at(-1)!).toMatchObject({ subject: 'Founders call moved', is_html: true })
        const recorded = (
          await t.owner.query("SELECT self_declared_name, content_sha256 FROM promotion_approval WHERE subject_kind = 'message' AND subject_id = $1 ORDER BY created_at", [w.id])
        ).rows
        expect(recorded).toEqual([
          { self_declared_name: 'Ann Approver', content_sha256: w.content_sha256 },
          { self_declared_name: 'Ann Approver', content_sha256: edited.content_sha256 },
        ])
      }
      // fixed-structure mail goes without approval while approvals are asked for
      const before = (await mailsTo(x.u.email)).length
      const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, { amount_minor: '1000', received_on: '2026-11-10', payer_name: 'Fay Fictional', payer_account: '12345678' })
      expect(r.statusCode, r.body).toBe(200)
      expect((await mailsTo(x.u.email)).slice(before).some((m) => m.subject.startsWith('Money received') && !m.is_html)).toBe(true)
    } finally {
      await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = false')
    }

    // R-CMP-03: the operator's switch stops bulk; one person from a row still can be written to
    await bulkPromo(false)
    try {
      expect((await inject('GET', `/api/deals/${deal}/mail/audience`, lead)).json().bulk_allowed).toBe(false)
      expect((await write(deal, { filter: {} })).json().error).toBe('The operator has turned off messages to many investors at once.')
      expect((await sendNow(deal, { invitation_id: row.invitation_id })).sent).toBe(1)
    } finally {
      await bulkPromo(true)
    }
    // checks on the text
    expect((await write(deal, { filter: {} }, 'Two\nlines', 'x')).json().error).toBe('The subject must be one line of 1 to 150 characters.')
    expect((await write(deal, { filter: {} }, 'Hi', '  ')).json().error).toBe('The text must be 1 to 10000 characters.')
  })
})

describe('D4 operator workbench: to-do list, deal board, every deal’s list (R-OPS-01..03)', () => {
  type Item = { key: string; kind: string; deal_id: string | null; deal_code: string | null; person: string | null; amount_minor: string | null; currency: string | null; days: number; deadline: string | null; note: string; assignee: { id: string; name: string } | null }
  const work = async (who: Client = reviewer, q = '') => (await inject('GET', `/api/ops/work${q}`, who)).json() as { items: Item[]; counts: Record<string, number>; left_out: number }
  const item = async (key: string, who: Client = reviewer) => (await work(who)).items.find((i) => i.key === key)
  const nameAs = (u: { id: string }, name: string) => t.owner.query('UPDATE user_account SET name = $2 WHERE id = $1', [u.id, name])
  async function receive(p: string, amount: bigint, payer = 'Fay Fictional') {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, { amount_minor: String(amount), received_on: '2026-11-10', payer_name: payer, payer_account: '12345678' })
    expect(r.statusCode, r.body).toBe(200)
    return r.json().id as string
  }
  async function committed(deal: string, amount = '1000000') {
    const x = await investor(deal)
    expect((await commit(x.u, deal, x.entity, amount)).statusCode).toBe(200)
    const p = await pid(x.u, deal)
    const due = BigInt((await t.owner.query<{ d: string }>('SELECT cash_due_minor::text AS d FROM participation WHERE id = $1', [p])).rows[0]!.d)
    return { ...x, p, due }
  }
  /** A deal submitted for review, and optionally approved, not launched. */
  async function submitted(approve = false) {
    let ent = leadEntities.get(lead.id)
    if (!ent) leadEntities.set(lead.id, (ent = await newEntity(lead)))
    const id = (await inject('POST', '/api/deals', lead, {})).json().id as string
    expect((await inject('PUT', `/api/deals/${id}/draft`, lead, draftFor(ent))).statusCode).toBe(200)
    await t.owner.query(
      "INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) SELECT $1, 'deal_shared', d.id, 'legal', 'a.pdf', 'application/pdf', 'x', 1, 'clean', 'k', 'k1', '\\x00', d.lead_user FROM deal d WHERE d.id = $2",
      [randomUUID(), id],
    )
    expect((await inject('POST', `/api/deals/${id}/submit`, lead, {})).statusCode).toBe(200)
    if (approve) expect((await inject('POST', `/api/review/deals/${id}/approve`, reviewer, { reviewed_sha256: await latestSha(id) })).statusCode).toBe(200)
    return id
  }

  it('TC-OPS-01 / TC-AUTHZ-09 one seed of each kind: listed with deal, person, amount, days, deadline; assigned shows who; resolved goes; leads and investors are refused', async () => {
    const deal = await liveDeal(lead)
    const code = (await t.owner.query<{ c: string }>('SELECT public_code AS c FROM deal WHERE id = $1', [deal])).rows[0]!.c
    // refund: paid 50.00 more than due
    const over = await committed(deal)
    await nameAs(over.u, 'Olive Over')
    await receive(over.p, over.due + 5000n)
    // a third party paid
    const third = await committed(deal)
    await nameAs(third.u, 'Theo Third')
    await receive(third.p, 300000n, 'Someone Else')
    // identity check waiting since 3 Nov
    const kycId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status, created_at) VALUES ($1, $2, 1, 'manual', 'pending_review', '2026-11-03T09:00:00Z')", [kycId, third.entity])
    // withdrawal asked for
    const w = await committed(deal)
    expect((await sign(w.u, w.p)).statusCode).toBe(200)
    expect((await instructions(w.u, w.p)).statusCode).toBe(200)
    await receive(w.p, 600000n)
    const asked = await inject('POST', `/api/deals/${deal}/participations/${w.p}/withdrawal`, lead, { consent_confirmed: true, evidence: 'Email from the investor, 10 Nov 2026.' })
    expect(asked.statusCode, asked.body).toBe(200)
    // other deals: a hold, a cancellation asked for, closing asked for, one in review, one approved
    const held = await liveDeal(lead)
    expect((await inject('POST', '/api/holds', reviewer, { level: 'deal', target_id: held, reason: 'Checking' })).statusCode).toBe(200)
    const cancelling = await liveDeal(lead)
    const cancel = await inject('POST', `/api/deals/${cancelling}/cancel-request`, lead, {})
    expect(cancel.statusCode, cancel.body).toBe(200)
    const closing = await liveDeal(lead)
    await t.owner.query("UPDATE deal SET state = 'closing_requested' WHERE id = $1", [closing])
    const inReview = await submitted()
    const approved = await submitted(true)
    await t.owner.query("UPDATE investee SET status = 'submitted' WHERE deal_id = $1", [inReview])
    const investeeId = (await t.owner.query<{ id: string }>('SELECT id FROM investee WHERE deal_id = $1', [inReview])).rows[0]!.id
    // money held after an identity check is refused (R-KYC-02.1)
    const refused = await committed(deal)
    await receive(refused.p, 250000n)
    const refuseCase = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [refuseCase, refused.entity])
    expect((await inject('POST', `/api/review/kyc/${refuseCase}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })).statusCode).toBe(200)
    // money nobody's yet, and a statement line nobody has decided
    const un = await inject('POST', '/api/review/unallocated', reviewer, { currency: 'GBP', amount_minor: '12345', received_on: '2026-11-11', payer_name: 'Pat Payer', payer_account: '87654321' })
    expect(un.statusCode, un.body).toBe(200)
    const account = ((await inject('GET', '/api/review/receiving-accounts', reviewer)).json().accounts as Array<{ account: string; currency: string }>).find((a) => a.currency === 'GBP')!.account
    const imp = await inject('POST', '/api/review/statement-imports', reviewer, { account, csv: `transaction_id,date,amount,payer,reference\nWB-${randomUUID()},2026-11-10,10.00,Nobody,NO-SUCH-REF` })
    expect(imp.statusCode, imp.body).toBe(200)

    const got = await work()
    const byKey = new Map(got.items.map((i) => [i.key, i]))
    const pq = (await t.owner.query<{ id: string }>("SELECT id FROM payment_query WHERE participation_id = $1 AND kind = 'third_party'", [third.p])).rows[0]!.id
    const holdId = (await t.owner.query<{ id: string }>('SELECT id FROM compliance_hold WHERE target_id = $1 AND released_at IS NULL', [held])).rows[0]!.id
    const wid = (await t.owner.query<{ id: string }>('SELECT id FROM withdrawal_request WHERE participation_id = $1', [w.p])).rows[0]!.id
    expect(byKey.get(`refund:${over.p}`)).toMatchObject({ deal_id: deal, deal_code: code, person: 'Olive Over', amount_minor: '5000', currency: 'GBP', assignee: null })
    expect(byKey.get(`payer_check:${pq}`)).toMatchObject({ deal_id: deal, person: 'Theo Third', amount_minor: '300000', note: 'Paid by someone else.' })
    expect(byKey.get(`kyc:${kycId}`)).toMatchObject({ deal_id: null, person: 'Theo Third', days: 7, amount_minor: null })
    expect(byKey.get(`withdrawal:${wid}`)).toMatchObject({ deal_id: deal, kind: 'withdrawal' })
    expect(byKey.get(`hold:${refused.p}`)).toMatchObject({ deal_id: deal, amount_minor: '250000', note: 'Money held after an identity check was refused.' })
    expect(byKey.get(`hold:${holdId}`)).toMatchObject({ deal_id: held, note: 'A hold on this deal.' })
    expect(byKey.get(`cancel_request:${cancel.json().id}`)).toMatchObject({ deal_id: cancelling, note: 'Asked by the lead.' })
    expect(byKey.get(`closing:${closing}`)).toMatchObject({ deal_id: closing, deadline: '2027-01-31', note: 'The lead asked to close.' })
    expect(byKey.get(`deal_review:${inReview}`)).toMatchObject({ deadline: '2027-01-31' })
    expect(byKey.get(`investee:${investeeId}`)).toMatchObject({ deal_id: inReview })
    expect(byKey.get(`content_approval:${approved}`)).toMatchObject({ deal_id: approved })
    expect(byKey.get(`unallocated:${un.json().id}`)).toMatchObject({ person: 'Pat Payer', amount_minor: '12345', assignee: { id: reviewer.id } })
    expect(byKey.get(`statement_import:${imp.json().import_id}`)?.note).toMatch(/1 row to decide/)
    // the lead is named on deal-level items
    expect(byKey.get(`deal_review:${inReview}`)!.person).toBe((await t.owner.query<{ name: string }>('SELECT name FROM user_account WHERE id = $1', [lead.id])).rows[0]!.name)
    // filters
    expect((await work(reviewer, '?kind=refund')).items.every((i) => i.kind === 'refund')).toBe(true)
    expect((await work(reviewer, `?deal=${deal}`)).items.every((i) => i.deal_id === deal)).toBe(true)
    expect((await inject('GET', '/api/ops/work?kind=nope', reviewer)).statusCode).toBe(400)

    // put someone on it: shown, history kept; a lead cannot be; a closed item cannot be
    const assign = (key: string, assignee: string | null, who = reviewer) => inject('POST', '/api/ops/work/assign', who, { key, assignee })
    expect((await assign(`refund:${over.p}`, reviewer2.id)).statusCode).toBe(200)
    expect((await item(`refund:${over.p}`))!.assignee).toMatchObject({ id: reviewer2.id, name: 'Staff reviewer2@example.test' })
    // whom an item can be given to: staff by name, never a lead or an investor
    const staffIds = ((await inject('GET', '/api/ops/work', reviewer)).json().staff as Array<{ id: string; name: string }>).map((x) => x.id)
    expect(staffIds).toEqual(expect.arrayContaining([reviewer.id, reviewer2.id]))
    expect(staffIds).not.toContain(lead.id)
    expect((await work(reviewer, `?assignee=${reviewer2.id}`)).items.map((i) => i.key)).toContain(`refund:${over.p}`)
    expect((await work(reviewer, '?assignee=none')).items.map((i) => i.key)).not.toContain(`refund:${over.p}`)
    expect((await assign(`refund:${over.p}`, lead.id)).json().error).toBe('Only a reviewer or an admin can work on this.')
    expect((await assign(`refund:${randomUUID()}`, reviewer2.id)).json().error).toBe('This item is no longer open.')
    expect((await assign(`refund:${over.p}`, null)).statusCode).toBe(200)
    expect((await item(`refund:${over.p}`))!.assignee).toBeNull()
    expect(await count("SELECT count(*) AS n FROM work_item_assignment WHERE item_key = $1", [`refund:${over.p}`])).toBe(2)
    // money nobody's yet keeps its own owner (R-OPS-04)
    expect((await assign(`unallocated:${un.json().id}`, reviewer2.id)).statusCode).toBe(200)
    expect((await t.owner.query<{ owner: string }>('SELECT owner FROM unallocated_receipt WHERE id = $1', [un.json().id])).rows[0]!.owner).toBe(reviewer2.id)
    expect((await assign(`unallocated:${un.json().id}`, null)).json().error).toMatch(/always has someone/)

    // resolved: gone, even with someone on it
    expect((await assign(`kyc:${kycId}`, reviewer2.id)).statusCode).toBe(200)
    expect((await inject('POST', `/api/review/kyc/${kycId}/decide`, reviewer, { decision: 'approve' })).statusCode).toBe(200)
    expect(await item(`kyc:${kycId}`)).toBeUndefined()
    await t.owner.query('UPDATE compliance_hold SET released_at = now(), released_by = $2 WHERE id = $1', [holdId, reviewer2.id])
    expect(await item(`hold:${holdId}`)).toBeUndefined()

    // only reviewers and admins
    expect((await work(admin)).items.some((i) => i.key === `refund:${over.p}`)).toBe(true)
    for (const who of [lead, over.u])
      for (const [m, url, body] of [
        ['GET', '/api/ops/work', undefined],
        ['POST', '/api/ops/work/assign', { key: `refund:${over.p}`, assignee: null }],
        ['GET', '/api/ops/deals', undefined],
        ['GET', `/api/ops/deals/${deal}/investors`, undefined],
        ['GET', `/api/ops/deals/${deal}/investors.csv`, undefined],
      ] as const)
        expect((await inject(m, url, who, body)).statusCode, `${m} ${url}`).toBe(403)

    // a reviewer on the deal's team sees none of its items, only how many were left out (R-REV-04)
    const member = await staff(unique('member'), ['reviewer'])
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, member.id])
    const theirs = await work(member)
    expect(theirs.items.some((i) => i.deal_id === deal)).toBe(false)
    expect(theirs.left_out).toBeGreaterThanOrEqual(3)
    // and cannot be put on one
    expect((await assign(`payer_check:${pq}`, member.id)).json().error).toMatch(/stake/)
  })

  it('TC-OPS-02 the deal board: stage, target date and days left, received and due, what closing lacks, and the three flags', async () => {
    const deal = await liveDeal(lead)
    const x = await committed(deal)
    const board = async () => ((await inject('GET', '/api/ops/deals', reviewer)).json().deals as Array<Record<string, unknown>>).find((r) => r.id === deal)!
    let row = await board()
    // clock: 10 Nov 2026; target 31 Jan 2027
    expect(row).toMatchObject({ state: 'live', target_close: '2027-01-31', days_left: 82, received_minor: '0', due_minor: String(x.due), flags: [], target_changes: 0 })
    expect(row.closing_gaps).toContain('The company has not confirmed the deal.')
    // money but cannot close
    await receive(x.p, 100000n)
    row = await board()
    expect(row).toMatchObject({ received_minor: '100000', flags: ['money_cannot_close'], flag_labels: ['Money received but cannot close now'] })
    // the target date moved twice by the lead's own change, then passed
    const move = async (to: string) => {
      const d = (await t.owner.query<{ draft: Record<string, Record<string, unknown>>; approved_version: number }>('SELECT draft, approved_version FROM deal WHERE id = $1', [deal])).rows[0]!
      const draft = structuredClone(d.draft)
      draft.terms!.target_close = to
      const r = await inject('POST', `/api/deals/${deal}/changes`, lead, { draft, summary: 'New date.', base_version: d.approved_version })
      expect(r.statusCode, r.body).toBe(200)
    }
    await move('2027-02-28')
    expect((await board()).flags).toEqual(['money_cannot_close'])
    await move('2026-11-09')
    row = await board()
    expect(row).toMatchObject({ target_close: '2026-11-09', days_left: -1, target_changes: 2, flags: ['target_passed', 'target_moved', 'money_cannot_close'] })
    // a draft has no closing gaps; a cancelled deal has no days left
    const draft = (await inject('POST', '/api/deals', lead, {})).json().id as string
    const drow = ((await inject('GET', '/api/ops/deals', admin)).json().deals as Array<Record<string, unknown>>).find((r) => r.id === draft)!
    expect(drow).toMatchObject({ state: 'draft', closing_gaps: null, flags: [] })
  })

  it('TC-AUTHZ-08 reviewers and admins read every deal’s list, even with a stake, and change nothing; the export is audited and follows the operator’s roles', async () => {
    const deal = await liveDeal(lead)
    const x = await committed(deal)
    await nameAs(x.u, 'Lena List')
    const member = await staff(unique('team'), ['reviewer'])
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, member.id])
    for (const who of [reviewer, admin, member]) {
      const r = await inject('GET', `/api/ops/deals/${deal}/investors`, who)
      expect(r.statusCode, r.body).toBe(200)
      const row = r.json().rows.find((y: { name: string }) => y.name === 'Lena List')
      expect(row).toBeTruthy()
      // read only: no actions, and nothing the lead would not see
      expect(row.actions).toBeUndefined()
      expect(JSON.stringify(r.json())).not.toMatch(/reason|document|kyc/i)
    }
    const before = await count("SELECT count(*) AS n FROM audit WHERE action = 'investors.exported' AND entity_id = $1", [deal])
    await inject('GET', `/api/ops/deals/${deal}/investors`, reviewer)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'investors.exported' AND entity_id = $1", [deal])).toBe(before)
    const csv = await inject('GET', `/api/ops/deals/${deal}/investors.csv`, reviewer)
    expect(csv.statusCode, csv.body).toBe(200)
    expect(csv.body).toContain('Lena List')
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'investors.exported' AND entity_id = $1", [deal])).toBe(before + 1)
    // the operator's export roles apply to staff too
    const now = (await inject('GET', '/api/admin/policy', admin)).json()
    const policy = (roles: string[]) =>
      t.owner.query(
        `INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days, cancel_fee_note, amount_proposal_days, reconfirm_days)
         VALUES ((SELECT coalesce(max(version), 0) + 1 FROM operator_policy), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [now.per_link_terms, now.generic_links, now.bulk_promo, roles, now.reminder_count, now.reminder_every_days, now.cancel_fee_note, now.amount_proposal_days, now.reconfirm_days],
      )
    const roles = now.export_roles as string[]
    await policy(['admin'])
    try {
      expect((await inject('GET', `/api/ops/deals/${deal}/investors.csv`, reviewer)).json().error).toBe('The operator does not allow your role to export this list.')
      expect((await inject('GET', `/api/ops/deals/${deal}/investors.csv`, admin)).statusCode).toBe(200)
    } finally {
      await policy(roles)
    }
    // the expected-investor list: staff read it, the team member with a stake too, and none of them write it
    await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Ann Staff,${unique('opsread')},10000` })
    for (const who of [reviewer, admin, member]) {
      expect((await inject('GET', `/api/deals/${deal}/pipeline`, who)).json().rows.map((y: { name: string }) => y.name)).toContain('Ann Staff')
      expect((await inject('POST', `/api/deals/${deal}/pipeline`, who, { text: `Bo Staff,${unique('opswrite')},1` })).statusCode).not.toBe(200)
    }
    expect((await inject('POST', `/api/deals/${deal}/participations/${x.p}/remove`, reviewer, {})).statusCode).not.toBe(200)
    // an investor reads neither list
    expect((await inject('GET', `/api/deals/${deal}/pipeline`, x.u)).statusCode).toBe(409)
    expect((await inject('GET', `/api/ops/deals/${deal}/investors`, x.u)).statusCode).toBe(403)
  })

  it('TC-AUTHZ-09 every D4 route, tried on someone else\'s deal by a lead of another deal, an investor of another deal and staff with a stake: nothing read, nothing done', async () => {
    const deal = await liveDeal(lead)
    const x = await committed(deal)
    await receive(x.p, 100_000n)
    const inv = (await t.owner.query<{ id: string }>('SELECT invitation_id AS id FROM participation WHERE id = $1', [x.p])).rows[0]!.id
    const otherLead = await person(unique('olead'))
    const other = await liveDeal(otherLead)
    const outsider = await investor(other, { leader: otherLead })
    const member = await staff(unique('stake'), ['reviewer', 'approver'])
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, member.id])
    const name = (await t.owner.query<{ name: string }>('SELECT name FROM user_account WHERE id = $1', [x.u.id])).rows[0]!.name
    const someId = randomUUID()
    const sha = 'a'.repeat(64)
    type R = readonly [string, string, unknown?]
    // the lead's routes and the investor's own routes on this deal
    const dealRoutes: R[] = [
      ['GET', `/api/deals/${deal}/panel`],
      ['GET', `/api/deals/${deal}/investors.csv`],
      ['GET', `/api/deals/${deal}/investor-preview`],
      ['GET', `/api/deals/${deal}/content`],
      ['GET', `/api/deals/${deal}/closing`],
      ['GET', `/api/deals/${deal}/cancel-note`],
      ['GET', `/api/deals/${deal}/changes`],
      ['GET', `/api/deals/${deal}/mail`],
      ['GET', `/api/deals/${deal}/mail/audience`],
      ['GET', `/api/deals/${deal}/waitlist`],
      ['GET', `/api/deals/${deal}/invitee-policy`],
      ['GET', `/api/deals/${deal}/participations/${x.p}/documents`],
      ['POST', `/api/deals/${deal}/calculator`, { raise_minor: '1000000' }],
      ['POST', `/api/deals/${deal}/cancel-request`, {}],
      ['POST', `/api/deals/${deal}/request-closing`, { confirm: true }],
      ['POST', `/api/deals/${deal}/withdraw-closing`, {}],
      ['POST', `/api/deals/${deal}/copy`, {}],
      ['POST', `/api/deals/${deal}/invitee-policy`, { version: 1 }],
      ['POST', `/api/deals/${deal}/mail`, { kind: 'bulk', subject: 'Hi', body: 'Hello', filter: {} }],
      ['PUT', `/api/deals/${deal}/mail/${someId}`, { subject: 'Hi', body: 'Hello' }],
      ['POST', `/api/deals/${deal}/mail/${someId}/send`, { sha256: sha }],
      ['POST', `/api/deals/${deal}/changes/${someId}/withdraw`, {}],
      ['POST', `/api/deals/${deal}/participations/${x.p}/amount-proposal`, { amount_minor: '500000' }],
      ['POST', `/api/deals/${deal}/participations/${x.p}/remove`, {}],
      ['POST', `/api/deals/${deal}/participations/${x.p}/withdrawal`, { consent_confirmed: true, evidence: 'Email from them' }],
      ['POST', `/api/deals/${deal}/waitlist/${someId}/release`, {}],
      ['GET', `/api/my/deals/${deal}/updates`],
      ['POST', `/api/my/deals/${deal}/waitlist`, { desired_minor: '100000' }],
      ['GET', `/api/my/participations/${x.p}/amount-proposal`],
      ['GET', `/api/my/participations/${x.p}/reconfirmation`],
      ['POST', `/api/my/participations/${x.p}/amount-proposal/accept`, { proposal_id: someId, quoted_due_minor: '1' }],
      ['POST', `/api/my/participations/${x.p}/amount-proposal/decline`, { proposal_id: someId }],
      ['POST', `/api/my/participations/${x.p}/reconfirmation/agree`, { reconfirmation_id: someId, agree: true }],
      ['POST', `/api/my/participations/${x.p}/reconfirmation/decline`, { reconfirmation_id: someId }],
      ['POST', `/api/my/participations/${x.p}/reference-report`, {}],
    ]
    // staff routes: refused outright to anyone without the role
    const staffRoutes: R[] = [
      ['GET', '/api/ops/work'],
      ['GET', '/api/ops/deals'],
      ['GET', `/api/ops/deals/${deal}/investors`],
      ['GET', `/api/ops/deals/${deal}/investors.csv`],
      ['GET', `/api/ops/invitations/${inv}/evidence.json`],
      ['GET', `/api/ops/invitations/${inv}/evidence.pdf`],
      ['GET', '/api/ops/complaints'],
      ['GET', '/api/review/refunds'],
      ['GET', '/api/review/unallocated'],
      ['GET', '/api/review/withdrawals'],
      ['GET', '/api/review/cancel-requests'],
      ['GET', '/api/review/reconfirmations'],
      ['GET', '/api/review/changes'],
      ['GET', '/api/review/transfer-queries'],
      ['GET', '/api/review/receiving-accounts'],
      ['GET', `/api/review/deals/${deal}/ledgers`],
      ['GET', `/api/review/deals/${deal}/roster`],
      ['GET', '/api/approvals/mail'],
      ['GET', '/api/approvals/changes'],
      ['GET', '/api/approvals/mail-templates'],
      ['GET', '/api/admin/mail-templates'],
      ['POST', '/api/ops/work/assign', { key: `refund:${x.p}`, assignee: null }],
      ['POST', `/api/review/participations/${x.p}/refunds`, { amount_minor: '1000' }],
      ['POST', `/api/review/participations/${x.p}/refund-records`, { actual_minor: '1000', sent_on: '2026-11-11' }],
      ['POST', `/api/review/participations/${x.p}/hold-step`, { step: 'considering', basis: 'A reason' }],
      ['POST', `/api/review/participations/${x.p}/release`, { basis: 'A reason', items: [] }],
      ['POST', `/api/review/participations/${x.p}/withdrawal`, { consent_confirmed: true, evidence: 'Email from them' }],
      ['POST', `/api/review/deals/${deal}/cancel-request`, {}],
      ['POST', `/api/review/deals/${deal}/withdraw-closing`, {}],
      ['POST', `/api/review/deals/${deal}/archive`, {}],
      ['POST', `/api/review/deals/${deal}/ledger-imports`, { ledger_name: 'Main', csv: 'transaction_id' }],
      ['POST', `/api/review/unallocated`, { currency: 'GBP', amount_minor: '1', received_on: '2026-11-10', payer_name: 'X', payer_account: 'Y' }],
      ['POST', `/api/review/statement-imports`, { account: someId, csv: 'x' }],
      ['POST', `/api/review/refunds/${someId}/approve`, {}],
      ['POST', `/api/review/receipts/${someId}/move`, {}],
      ['POST', `/api/approvals/mail/${someId}`, { sha256: sha }],
      ['POST', `/api/approvals/changes/${someId}`, {}],
      ['POST', `/api/ops/complaints`, { from_address: 'a@b.test', received_on: '2026-11-01', body: 'x' }],
    ]
    const audits = async () => count('SELECT count(*) AS n FROM audit', [])
    const before = await audits()
    for (const who of [otherLead, outsider.u])
      for (const [m, url, body] of [...dealRoutes, ...staffRoutes]) {
        const r = await inject(m, url, who, body ?? (m === 'GET' ? undefined : {}))
        expect(r.statusCode, `${m} ${url}`).not.toBeLessThan(400)
        expect(r.body, `${m} ${url}`).not.toContain(x.u.email)
        expect(r.body, `${m} ${url}`).not.toContain(name)
      }
    for (const [m, url, body] of staffRoutes) expect((await inject(m, url, outsider.u, body ?? (m === 'GET' ? undefined : {}))).statusCode, `${m} ${url}`).toBe(403)
    // staff with a stake: they read every deal's list (R-OPS-01) but act on nothing of this deal, and see none of its items
    for (const [m, url, body] of staffRoutes.filter(([m, u]) => m === 'POST' && (u.includes(deal) || u.includes(x.p)))) {
      const r = await inject(m, url, member, body)
      expect(r.statusCode, `${m} ${url}`).not.toBeLessThan(400)
    }
    // the evidence pack is for staff with no stake (R-AUD-02); the roster is staff reading, as the lists (chunk 5b2)
    expect((await inject('GET', `/api/ops/invitations/${inv}/evidence.json`, member)).statusCode).not.toBe(200)
    expect((await inject('GET', '/api/ops/work', member)).json().items.some((i: Item) => i.deal_id === deal)).toBe(false)
    expect(((await inject('GET', '/api/review/refunds', member)).json().rows as Array<{ participation_id: string }>).some((r) => r.participation_id === x.p)).toBe(false)
    expect(await audits()).toBe(before)
  })
})

describe('D4 evidence pack and complaints (R-AUD-02, R-AUD-05)', () => {
  type Shown = { hashed_as: string; sha256_recorded: string; sha256_now: string; matches: boolean; text?: string; subject?: string; value?: unknown }
  type Item = { at: string | null; what: string; fields?: Record<string, unknown>; shown?: Shown }
  type Pack = { format: string; limits: string[]; software_version: string; sections: { key: string; note: string | null; items: Item[] }[]; mismatches: number }
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
  const invitationOf = async (u: Client, deal: string) =>
    (await t.owner.query<{ id: string }>('SELECT id FROM deal_invitation WHERE deal_id = $1 AND user_id = $2', [deal, u.id])).rows[0]!.id
  const section = (p: Pack, key: string) => p.sections.find((s) => s.key === key)!.items

  it('TC-AUD-02 one investor’s pack: limits first, every text rebuilt with its hash, approvals marked internal, messages, terms, instructions, versions; no answers; staff only', async () => {
    const deal = await liveDeal(lead)
    const x = await investor(deal)
    expect((await commit(x.u, deal, x.entity, '1000000')).statusCode).toBe(200)
    const p = await pid(x.u, deal)
    expect((await sign(x.u, p)).statusCode).toBe(200)
    const ins = (await instructions(x.u, p)).json()
    if (ins.account_sha256) await inject('POST', `/api/my/participations/${p}/acknowledge-account`, x.u, { account_sha256: ins.account_sha256 })
    const inv = await invitationOf(x.u, deal)
    const w = await inject('POST', `/api/deals/${deal}/mail`, lead, { subject: 'Founders call', body: 'Friday at ten.', to: { invitation_id: inv } })
    expect(w.statusCode, w.body).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/mail/${w.json().id}/send`, lead, { content_sha256: w.json().content_sha256 })).statusCode).toBe(200)
    // a second investor in the same deal, with a signature and a message of their own: none of it is in the first one's pack
    const y = await investor(deal)
    expect((await commit(y.u, deal, y.entity, '2000000')).statusCode).toBe(200)
    expect((await sign(y.u, await pid(y.u, deal))).statusCode).toBe(200)
    const wy = await inject('POST', `/api/deals/${deal}/mail`, lead, { subject: 'Only for the second', body: 'Private note.', to: { invitation_id: await invitationOf(y.u, deal) } })
    expect((await inject('POST', `/api/deals/${deal}/mail/${wy.json().id}/send`, lead, { content_sha256: wy.json().content_sha256 })).statusCode).toBe(200)

    const r = await inject('GET', `/api/ops/invitations/${inv}/evidence.json`, reviewer)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['content-disposition']).toBe('attachment; filename="evidence-pack.json"')
    const pack = r.json() as Pack
    expect(pack.format).toBe('bulma-evidence-pack/1')
    expect(pack.limits[1]).toMatch(/cannot tell whether they read/)
    expect(pack.mismatches).toBe(0)
    for (const key of ['statements', 'warnings', 'assessment', 'kyc', 'deal_versions', 'link_terms', 'instructions', 'signatures', 'messages', 'mails', 'versions'])
      expect(section(pack, key).length, key).toBeGreaterThan(0)
    const whole = JSON.stringify(pack)
    for (const theirs of [y.u.email, 'Only for the second', 'Private note.']) expect(whole, theirs).not.toContain(theirs)
    expect(section(pack, 'signatures')).toHaveLength(1)
    expect(section(pack, 'messages')).toHaveLength(1)

    // every kept text hashes, by this test's own sums, to what was recorded when it was shown
    let texts = 0
    for (const s of pack.sections)
      for (const i of s.items) {
        if (!i.shown) continue
        texts += 1
        const again =
          i.shown.value !== undefined ? sha(stableJson(i.shown.value)) : i.shown.subject !== undefined ? sha(JSON.stringify([i.shown.subject, i.shown.text])) : sha(i.shown.text!)
        expect(again, `${s.key}: ${i.what}`).toBe(i.shown.sha256_recorded)
        expect(i.shown.matches).toBe(true)
      }
    expect(texts).toBeGreaterThanOrEqual(5)
    // the deal page version served, with the hash the database recorded for it
    const version = section(pack, 'deal_versions')[0]!
    const recorded = (await t.owner.query<{ sha256: string }>('SELECT sha256 FROM deal_version WHERE deal_id = $1 AND n = $2', [deal, version.fields!.version])).rows[0]!.sha256
    expect(version.shown!.sha256_recorded).toBe(recorded)
    expect(pack.sections.find((s) => s.key === 'deal_versions')!.note).toMatch(/internal record that the content was approved. It is not the statutory approval/)
    // the signed deal sheet, word for word
    const signed = (await t.owner.query<{ document: string }>('SELECT document FROM signature_record WHERE participation_id = $1', [p])).rows[0]!.document
    expect(section(pack, 'signatures')[0]!.shown!.text).toBe(signed)
    // the message as sent, and the archive note
    expect(section(pack, 'messages')[0]).toMatchObject({ shown: { subject: 'Founders call', text: 'Friday at ten.', matches: true } })
    expect(pack.sections.find((s) => s.key === 'messages')!.note).toMatch(/Replies, and anything said outside the site, are not/)
    // link terms, rule pack and software versions
    expect(section(pack, 'link_terms')[0]!.fields).toMatchObject({ carry_bps: 2000, default_terms: true })
    expect(section(pack, 'versions').map((i) => i.what).join('\n')).toMatch(/Rule pack .* version \d+[\s\S]*Software version /)
    expect(pack.software_version).toMatch(/^\d+\.\d+\.\d+/)
    // results only: no question or answer from the assessment
    for (const a of section(pack, 'assessment')) expect(Object.keys(a.fields!).sort()).toEqual(['answered_at', 'next_try_from', 'result'])
    const asked = (await t.owner.query<{ q: string[] }>('SELECT questions_used AS q FROM assessment_attempt WHERE user_id = $1', [x.u.id])).rows.flatMap((a) => a.q)
    const body = JSON.stringify(pack)
    for (const q of asked) expect(body).not.toContain(JSON.stringify(q))
    expect(body).not.toContain('correct_option')
    // our own words make no claim that anyone saw or read anything, or that every exchange is kept
    const ours = JSON.stringify({ ...pack, sections: pack.sections.map((s) => ({ ...s, items: s.items.map(({ shown: _s, ...i }) => i) })) })
    expect(forbiddenClaims(ours)).toEqual([])

    // the PDF: the limits come first; the same records
    const pdf = await inject('GET', `/api/ops/invitations/${inv}/evidence.pdf`, reviewer)
    expect(pdf.statusCode, pdf.body).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    const lines = (await pdfText(pdf.rawPayload)).join(' ')
    expect(lines.indexOf('What this pack can and cannot show.')).toBe(0)
    expect(lines).toContain('Founders call')
    expect(lines).toContain('Every kept text has the hash recorded when it was shown.')
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'evidence.exported' AND entity_id = $1", [inv])).toBe(2)

    // the database keeps a sent message as it went
    await expect(t.app.query("UPDATE message SET body = 'Thursday at ten.' WHERE id = $1", [w.json().id])).rejects.toThrow(/stays as it was sent/)
    // a text changed after it was sent (by someone going round the database's guard) shows as changed
    await t.owner.query('ALTER TABLE message DISABLE TRIGGER message_sent_fixed')
    await t.owner.query("UPDATE message SET body = 'Thursday at ten.' WHERE id = $1", [w.json().id])
    await t.owner.query('ALTER TABLE message ENABLE TRIGGER message_sent_fixed')
    const after = (await inject('GET', `/api/ops/invitations/${inv}/evidence.json`, reviewer)).json() as Pack
    expect(after.mismatches).toBe(1)
    expect(section(after, 'messages')[0]!.shown).toMatchObject({ matches: false, sha256_recorded: section(pack, 'messages')[0]!.shown!.sha256_recorded })

    // what reached the person is the queue's outcome at the attempt, not the choice made when it was queued
    const more = async (subject: string) => {
      const m = await inject('POST', `/api/deals/${deal}/mail`, lead, { subject, body: 'Not for the pack.', to: { invitation_id: inv } })
      expect((await inject('POST', `/api/deals/${deal}/mail/${m.json().id}/send`, lead, { content_sha256: m.json().content_sha256 })).statusCode).toBe(200)
      const o = (await t.owner.query<{ outbox_id: string }>('SELECT outbox_id FROM message_recipient WHERE message_id = $1', [m.json().id])).rows[0]!.outbox_id
      return { id: m.json().id as string, outbox: o }
    }
    const asNotice = await more('Went as a notice')
    // the person no longer passed when it went: the worker sent only the notice to sign in
    await t.owner.query("UPDATE notification_outbox SET sent_variant = 'fixed' WHERE id = $1", [asNotice.outbox])
    const stopped = await more('Stopped before it went')
    await t.owner.query("UPDATE notification_outbox SET status = 'cancelled', sent_variant = NULL, cancel_reason = 'held' WHERE id = $1", [stopped.outbox])
    const failed = await more('Could not be delivered')
    await t.owner.query("UPDATE notification_outbox SET status = 'failed', sent_variant = NULL, last_error = 'EENVELOPE' WHERE id = $1", [failed.outbox])
    const outcome = (await inject('GET', `/api/ops/invitations/${inv}/evidence.json`, reviewer)).json() as Pack
    const of = (id: string) => section(outcome, 'messages').find((i) => i.fields!.message === id)!
    expect(of(asNotice.id)).toMatchObject({ what: expect.stringMatching(/only a notice to sign in was sent/) })
    expect(of(stopped.id)).toMatchObject({ what: expect.stringMatching(/not sent to this person/), fields: { why_not_sent: 'held' } })
    expect(of(failed.id)).toMatchObject({ what: expect.stringMatching(/not sent to this person/), fields: { why_not_sent: 'the email could not be delivered' } })
    for (const id of [asNotice.id, stopped.id, failed.id]) expect(of(id).shown, id).toBeUndefined()
    expect(JSON.stringify(outcome)).not.toContain('Not for the pack.')

    // a fixed notice keeps the deal it is about: the commitment's confirmation is this deal's, another deal's notice is not here
    expect(
      await count("SELECT count(*) AS n FROM notification_outbox WHERE user_id = $1 AND audience = 'account' AND deal_id = $2 AND status = 'sent'", [x.u.id, deal]),
    ).toBeGreaterThan(0)
    const elsewhere = await liveDeal(lead)
    await t.owner.query(
      `INSERT INTO notification_outbox (id, mode, audience, user_id, deal_id, subject, next_attempt_at, status, sent_variant, finished_at)
       VALUES ($1, 'sandbox', 'urgent', $2, $3, 'Another deal: your payment details are no longer valid', now(), 'sent', 'fixed', now())`,
      [randomUUID(), x.u.id, elsewhere],
    )
    const mails = JSON.stringify(section((await inject('GET', `/api/ops/invitations/${inv}/evidence.json`, reviewer)).json() as Pack, 'mails'))
    expect(mails).toContain('Email sent:')
    expect(mails).not.toContain('Another deal:')

    // the lead and the investor never reach it; staff with a stake in the deal are refused
    expect((await inject('GET', `/api/ops/invitations/${inv}/evidence.json`, lead)).statusCode).toBe(403)
    expect((await inject('GET', `/api/ops/invitations/${inv}/evidence.pdf`, x.u)).statusCode).toBe(403)
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [deal, reviewer2.id])
    expect((await inject('GET', `/api/ops/invitations/${inv}/evidence.json`, reviewer2)).json().error).toMatch(/stake in this deal/)
    expect((await inject('GET', `/api/ops/invitations/${randomUUID()}/evidence.json`, reviewer)).json().error).toBe('No such invitation.')
  })

  it('TC-AUD-03 complaints: the form and the operator’s address, acknowledged within 30 days from the to-do list, emailed ones entered by staff', async () => {
    const open = await inject('GET', '/api/complaints/channel')
    expect(open.statusCode).toBe(200)
    expect(open.json()).toEqual({ email: null, text: 'Your complaint is kept on this site and acknowledged within 30 days.' })
    const policy = (await inject('GET', '/api/admin/policy', admin)).json()
    const { version: _v, ...same } = policy
    expect((await inject('PUT', '/api/admin/policy', admin, { ...same, complaints_email: 'complaints@op.test' })).statusCode).toBe(200)
    expect((await inject('GET', '/api/complaints/channel')).json().email).toBe('complaints@op.test')

    const u = await person(unique('complainer'))
    const other = await person(unique('other'))
    expect((await inject('POST', '/api/my/complaints', u, { body: '   ' })).json().error).toMatch(/Write what/)
    const sent = await inject('POST', '/api/my/complaints', u, { body: 'My refund is late.' })
    expect(sent.statusCode, sent.body).toBe(200)
    const due = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate()) + 30 * 86_400_000).toISOString().slice(0, 10)
    expect(sent.json()).toMatchObject({ acknowledge_by: due, text: expect.stringContaining('complaints@op.test') })
    const id = sent.json().id as string
    expect((await inject('GET', '/api/my/complaints', u)).json().complaints).toEqual([{ id, body: 'My refund is late.', received_at: clock.toISOString(), acknowledged_at: null }])
    expect((await inject('GET', '/api/my/complaints', other)).json().complaints).toEqual([])
    // the audit holds the id, never the words
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'complaint.received' AND entity_id = $1", [id])).toBe(1)
    expect(await count("SELECT count(*) AS n FROM audit_detail WHERE detail LIKE '%refund is late%'")).toBe(0)

    // staff enter one that came by email, from the day it arrived
    expect((await inject('POST', '/api/ops/complaints', lead, { from_address: 'a@b.test', received_on: '2026-10-01', body: 'x' })).statusCode).toBe(403)
    const future = new Date(clock.getTime() + 86_400_000).toISOString().slice(0, 10)
    expect((await inject('POST', '/api/ops/complaints', reviewer, { from_address: 'a@b.test', received_on: future, body: 'x' })).json().error).toMatch(/future/)
    // a year typed wrong would be erased at the next run: refused
    expect((await inject('POST', '/api/ops/complaints', reviewer, { from_address: 'a@b.test', received_on: '2006-10-01', body: 'x' })).json().error).toMatch(/older than complaints are kept/)
    const mailed = await inject('POST', '/api/ops/complaints', reviewer, { from_address: 'writer@b.test', received_on: '2026-10-01', body: 'Your site was down.' })
    expect(mailed.json()).toMatchObject({ acknowledge_by: '2026-10-31' })
    const mid = mailed.json().id as string

    // both on the to-do list, the overdue one first, until acknowledged
    const work = async () =>
      ((await inject('GET', '/api/ops/work?kind=complaint', reviewer)).json().items as Array<{ key: string; deadline: string; person: string | null }>).filter((i) =>
        [`complaint:${id}`, `complaint:${mid}`].includes(i.key),
      )
    const name = (await t.owner.query<{ name: string }>('SELECT name FROM user_account WHERE id = $1', [u.id])).rows[0]!.name
    expect(await work()).toEqual([
      expect.objectContaining({ key: `complaint:${mid}`, deadline: '2026-10-31', person: null }),
      expect.objectContaining({ key: `complaint:${id}`, deadline: due, person: name }),
    ])
    const list = (await inject('GET', '/api/ops/complaints', reviewer)).json().complaints as Array<{ id: string; from: { email: string } }>
    expect(list.find((c) => c.id === id)!.from.email).toBe(u.email)
    expect(list.find((c) => c.id === mid)!.from.email).toBe('writer@b.test')
    expect((await inject('GET', '/api/ops/complaints', lead)).statusCode).toBe(403)

    // acknowledging: the form's sender gets the fixed email; once only; off the list
    const ack = await inject('POST', `/api/ops/complaints/${id}/acknowledge`, reviewer, {})
    expect(ack.json()).toMatchObject({ emailed: true })
    const got = (await mailTo(u.email)).at(-1)!
    expect(got.subject).toBe('We have received your complaint')
    expect(got.body).not.toContain('refund is late')
    expect((await inject('POST', `/api/ops/complaints/${id}/acknowledge`, reviewer, {})).json().error).toMatch(/already been acknowledged/)
    const before = (await mailTo('writer@b.test')).length
    expect((await inject('POST', `/api/ops/complaints/${mid}/acknowledge`, reviewer, {})).json()).toMatchObject({ emailed: false })
    expect((await mailTo('writer@b.test')).length).toBe(before)
    expect(await work()).toEqual([])
    // a reviewer's own complaint is acknowledged by someone else
    const mine = await inject('POST', '/api/my/complaints', reviewer, { body: 'The page was slow.' })
    expect(mine.statusCode, mine.body).toBe(200)
    expect((await inject('POST', `/api/ops/complaints/${mine.json().id}/acknowledge`, reviewer, {})).json().error).toMatch(/Someone else/)
    expect((await inject('POST', `/api/ops/complaints/${mine.json().id}/acknowledge`, reviewer2, {})).statusCode).toBe(200)
    expect((await inject('GET', '/api/my/complaints', u)).json().complaints[0].acknowledged_at).toBe(clock.toISOString())

    // a day's limit on the form, so the list cannot be flooded
    for (let i = 1; i < 10; i++) expect((await inject('POST', '/api/my/complaints', u, { body: `again ${i}` })).statusCode).toBe(200)
    expect((await inject('POST', '/api/my/complaints', u, { body: 'one more' })).json().error).toMatch(/10 complaints in the last day/)
  })
})

describe('D4 retention: the person, the deal and the transaction clocks (R-KYC-04, §5.6)', () => {
  // these runs look years ahead and act on everything in the database, so this block comes last
  const at = (d: Date, years: number, days = 0) =>
    new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate() + days, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()))
  const run = async (now: Date) => {
    const r = await runRetention(t.maintenance, t.keyring, new MemoryStorage(), now)
    expect(r.failed).toEqual([])
    return r
  }
  const one = async <T extends Record<string, unknown>>(sql: string, args: unknown[]) => (await t.owner.query<T>(sql, args)).rows[0]!
  const defaultLink = async (deal: string) => (await links(deal)).find((l) => l.is_default && l.carry_bps === 2000)!.id
  const receipt = async (p: string, payer = 'Kim Kept') => {
    const r = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: '500000',
      received_on: '2026-11-10',
      payer_name: payer,
      payer_account: '12345678',
    })
    expect(r.statusCode, r.body).toBe(200)
  }
  const endedAt = async (u: Client) => (await one<{ at: Date | null }>('SELECT relationship_ended_at AS at FROM user_account WHERE id = $1', [u.id])).at
  const cancel = async (deal: string) => {
    const asked = await inject('POST', `/api/deals/${deal}/cancel-request`, lead, {})
    expect((await inject('POST', `/api/review/cancel-requests/${asked.json().id}/confirm`, reviewer, {})).statusCode).toBe(200)
  }

  it('TC-KYC-07 a person at the end of retention: what they did in deals goes or is blanked, amounts stay; their address leaves the lead’s list and the personal invitation', async () => {
    const deal = await liveDeal(lead)
    const email = unique('kept')
    expect((await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Kim Kept\t${email}\t10000\tdefault` })).statusCode).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email, link_id: await defaultLink(deal), allows_reentry: false })).statusCode).toBe(200)
    const token = /token=([\w-]+)/.exec((await mailTo(email))[0]!.body)![1]!
    const u = await person(email, await open(token))
    expect((await inject('POST', '/api/invite/accept', u, {})).json().results[0].result).toBe('invited')
    await qualify(u)
    const entity = await newEntity(u)
    await passKyc(entity)
    expect((await commit(u, deal, entity, '1000000')).statusCode).toBe(200)
    const p = await pid(u, deal)
    expect((await sign(u, p)).statusCode).toBe(200)
    await receipt(p)
    expect((await inject('POST', `/api/my/deals/${deal}/message`, u, { body: 'A question for the lead.' })).statusCode).toBe(200)
    expect((await inject('POST', '/api/my/complaints', u, { body: 'My refund is late.' })).statusCode).toBe(200)
    // someone else in the same deal, who stays
    const other = await investor(deal)
    expect((await commit(other.u, deal, other.entity, '1000000')).statusCode).toBe(200)
    const op = await pid(other.u, deal)

    // their identity check is rejected through the real flow: the part ends and the relationship with it; the deal goes on
    expect(await endedAt(u)).toBeNull()
    const caseId = randomUUID()
    await t.owner.query("INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) VALUES ($1, $2, 1, 'manual', 'pending_review')", [caseId, entity])
    expect((await inject('POST', `/api/review/kyc/${caseId}/decide`, reviewer, { decision: 'reject', reason: 'Not satisfied' })).statusCode).toBe(200)
    const ended = (await endedAt(u))!
    expect(ended).not.toBeNull()

    expect((await run(at(ended, 5, -1))).removed).not.toContain(u.id)
    expect(await count('SELECT count(*) AS n FROM participation_event WHERE participation_id = $1', [p])).toBeGreaterThan(0)
    const r = await run(at(ended, 5, 1))
    expect(r.removed).toContain(u.id)
    expect(r.deals).not.toContain(deal)

    for (const table of ['participation_event', 'instruction_ack', 'payment_query', 'withdrawal_request', 'refund_todo_event', 'reconfirm_exclusion'])
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE participation_id = $1`, [p]), table).toBe(0)
    for (const [table, col] of [['deal_view', 'user_id'], ['deal_message', 'author'], ['complaint', 'user_id'], ['message_recipient', 'user_id'], ['invitee_policy_ack', 'user_id']])
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE ${col} = $1`, [u.id]), table).toBe(0)
    expect(await one('SELECT signed_name, ip, document FROM signature_record WHERE participation_id = $1', [p])).toEqual({ signed_name: 'Removed', ip: '', document: '' })
    expect(await one('SELECT payer_name, payer_account, amount_minor::text AS amount FROM receipt WHERE participation_id = $1', [p])).toEqual({
      payer_name: 'Removed',
      payer_account: 'Removed',
      amount: '500000',
    })
    // the part itself stays, with its amounts, so the deal's figures still add up
    expect(await one('SELECT outcome, commitment_minor::text AS c FROM participation WHERE id = $1', [p])).toEqual({ outcome: 'rejected_kyc', c: '1000000' })
    expect(await one('SELECT email FROM targeted_invite WHERE consumed_by = $1', [u.id])).toEqual({ email: 'removed@invalid' })
    expect(await count("SELECT count(*) AS n FROM pipeline_entry WHERE deal_id = $1 AND (name = 'Kim Kept' OR lower(email) = lower($2))", [deal, email])).toBe(0)
    expect(await count("SELECT count(*) AS n FROM pipeline_entry WHERE deal_id = $1 AND name = 'Removed'", [deal])).toBe(1)
    // the other investor and the deal are untouched
    expect(await count('SELECT count(*) AS n FROM participation_event WHERE participation_id = $1', [op])).toBeGreaterThan(0)
    expect(await one('SELECT anonymised_at FROM user_account WHERE id = $1', [other.u.id])).toEqual({ anonymised_at: null })
    expect(await one('SELECT records_erased_at FROM deal WHERE id = $1', [deal])).toEqual({ records_erased_at: null })
  })

  it('TC-KYC-07 the deal’s clock: five years after a cancellation or a rejection, contacts and recipients with no account, the investee’s files, messages and the lead’s list go; a legal hold stops it; a live deal is untouched', async () => {
    const deal = await liveDeal(lead)
    const live = await liveDeal(lead)
    const x = await investor(deal)
    expect((await commit(x.u, deal, x.entity, '1000000')).statusCode).toBe(200)
    const inv = (await one<{ id: string }>('SELECT id FROM deal_invitation WHERE deal_id = $1 AND user_id = $2', [deal, x.u.id])).id
    const w = await inject('POST', `/api/deals/${deal}/mail`, lead, { subject: 'Founders call', body: 'Friday at ten.', to: { invitation_id: inv } })
    expect(w.statusCode, w.body).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/mail/${w.json().id}/send`, lead, { content_sha256: w.json().content_sha256 })).statusCode).toBe(200)
    const investee = (await one<{ id: string }>('SELECT id FROM investee WHERE deal_id = $1', [deal])).id
    await t.owner.query(
      "INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key) VALUES ($1, 'investee_verification', $2, 'id', 'passport.pdf', 'application/pdf', 'x', 1, 'clean', $3, 'k1', '\\x00')",
      [randomUUID(), investee, `inv-${investee}`],
    )
    expect((await inject('POST', `/api/deals/${deal}/pipeline`, lead, { text: `Nora Never\t${unique('never')}\t10000\tdefault` })).statusCode).toBe(200)
    expect((await inject('POST', `/api/deals/${deal}/targeted`, lead, { email: unique('never'), link_id: await defaultLink(deal), allows_reentry: false })).statusCode).toBe(200)
    // §5.6 "邀请全部结束": choosing not to invest ends it; a new invitation opens it again; choosing not to invest while
    // invited to another running deal ends nothing; someone who never answers ends with the deal
    const join = async (u: Client, d: string) =>
      expect((await inject('POST', '/api/invite/accept', u, {}, await open(tokenOf(await urlOf(d, await defaultLink(d)))))).json().results[0].result).toBe('invited')
    const y = await investor(live)
    expect((await inject('POST', `/api/my/deals/${live}/pass`, y.u, {})).statusCode).toBe(200)
    expect(await endedAt(y.u)).not.toBeNull()
    await join(y.u, deal)
    expect(await endedAt(y.u)).toBeNull()
    const v = await investor(live)
    await join(v.u, deal)
    expect((await inject('POST', `/api/my/deals/${live}/pass`, v.u, {})).statusCode).toBe(200)
    expect(await endedAt(v.u)).toBeNull()
    const z = await investor(deal)
    // a link turned off ends the invitations bound to it
    const made = await inject('POST', `/api/deals/${live}/links`, lead, { kind: 'open', label: 'Angels', carry_bps: 1500, fee: { kind: 'none' }, reason: 'Early backers', confirm: true })
    expect(made.statusCode, made.body).toBe(200)
    const off = await investor(live, { link: made.json().id })
    expect(await endedAt(off.u)).toBeNull()
    expect((await inject('POST', `/api/deals/${live}/links/${made.json().id}/disable`, lead, {})).statusCode).toBe(200)
    expect(await endedAt(off.u)).not.toBeNull()

    await cancel(deal)
    for (const u of [y.u, v.u, z.u]) expect(await endedAt(u)).not.toBeNull()
    const ended = (await one<{ at: Date | null }>('SELECT ended_at AS at FROM deal WHERE id = $1', [deal])).at!
    expect(ended).not.toBeNull()
    // a deal the reviewer rejects ends too
    const ent = await newEntity(lead)
    const rejected = (await inject('POST', '/api/deals', lead, {})).json().id as string
    expect((await inject('PUT', `/api/deals/${rejected}/draft`, lead, draftFor(ent))).statusCode).toBe(200)
    await t.owner.query(
      "INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) SELECT $1, 'deal_shared', d.id, 'legal', 'a.pdf', 'application/pdf', 'x', 1, 'clean', 'k', 'k1', '\\x00', d.lead_user FROM deal d WHERE d.id = $2",
      [randomUUID(), rejected],
    )
    expect((await inject('POST', `/api/deals/${rejected}/submit`, lead, {})).statusCode).toBe(200)
    const no = await inject('POST', `/api/review/deals/${rejected}/reject`, reviewer, { reason: 'Out of scope.', reviewed_sha256: await latestSha(rejected) })
    expect(no.statusCode, no.body).toBe(200)
    expect((await one<{ at: Date | null }>('SELECT ended_at AS at FROM deal WHERE id = $1', [rejected])).at).not.toBeNull()

    const people = async (d: string) =>
      JSON.stringify(
        (
          await t.owner.query<{ fields: unknown }>(
            'SELECT fields FROM person_version WHERE id IN (SELECT contact_version FROM investee WHERE deal_id = $1 UNION SELECT person_version FROM carry_recipient WHERE deal_id = $1)',
            [d],
          )
        ).rows.map((r) => r.fields),
      )
    expect(await people(deal)).toMatch(/Sam Founder/)
    expect((await run(at(ended, 5, -1))).deals).not.toContain(deal)
    await t.owner.query('UPDATE deal SET retention_hold = true WHERE id = $1', [deal])
    expect((await run(at(ended, 5, 1))).deals).not.toContain(deal)
    expect(await people(deal)).toMatch(/Sam Founder/)
    await t.owner.query('UPDATE deal SET retention_hold = false WHERE id = $1', [deal])
    const r = await run(at(ended, 5, 1))
    expect(r.deals).toContain(deal)
    expect(r.deals).not.toContain(live)
    // the rejection was dated by the app's clock, a week before: an earlier run already took it
    expect(await one('SELECT records_erased_at IS NOT NULL AS done FROM deal WHERE id = $1', [rejected])).toEqual({ done: true })

    for (const d of [deal, rejected]) {
      expect(await people(d)).not.toMatch(/Sam Founder|Cara|example\.test/)
      const draft = (await one<{ draft: { company: Record<string, unknown>; economics: { recipients: Record<string, unknown>[] } } }>('SELECT draft FROM deal WHERE id = $1', [d])).draft
      expect(draft.company).not.toHaveProperty('contact_name')
      expect(draft.company).not.toHaveProperty('contact_email')
      expect(draft.company.legal_name).toBe('Seedling Ltd')
      expect(draft.economics.recipients[0]).toEqual({ kind: 'person', share_bps: 10000 })
    }
    expect(await people(live)).toMatch(/Sam Founder/)
    expect(await one('SELECT subject, body, erased_at IS NOT NULL AS erased FROM message WHERE deal_id = $1', [deal])).toEqual({ subject: null, body: null, erased: true })
    expect(await count("SELECT count(*) AS n FROM stored_file WHERE scope = 'investee_verification' AND owner_id = $1", [investee])).toBe(0)
    expect(await count("SELECT count(*) AS n FROM pipeline_entry WHERE deal_id = $1 AND name <> 'Removed'", [deal])).toBe(0)
    expect(await count("SELECT count(*) AS n FROM targeted_invite WHERE deal_id = $1 AND email <> 'removed@invalid'", [deal])).toBe(0)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'retention.deal_records_removed' AND entity_id = $1", [deal])).toBe(1)
    // done once: a later run leaves it alone
    expect((await run(at(ended, 6))).deals).not.toContain(deal)
  })

  it('TC-KYC-07 the transaction period is the operator’s setting (0 to 10 years): a shorter one applies at the next run; a change that leaves it out keeps it, zero included', async () => {
    const deal = await liveDeal(lead)
    const a = await investor(deal)
    const cm = await commit(a.u, deal, a.entity, '1000000')
    expect(cm.statusCode, cm.body).toBe(200)
    const pa = await pid(a.u, deal)
    await receipt(pa, 'Sam Short')
    const set = (body: Record<string, number>) => inject('PUT', '/api/retention-config', admin, body)
    const now = async () => (await inject('GET', '/api/retention-config', admin)).json()
    const before = await now()
    // the other periods stay as they are, so the run below removes nobody the later tests use
    const periods = { relationship_years: before.relationship_years, idle_months: before.idle_months, kyc_valid_years: before.kyc_valid_years }
    expect(before.transaction_years).toBe(10)
    expect((await set({ ...before, transaction_years: 11 })).statusCode).toBe(400)
    expect((await inject('PUT', '/api/retention-config', reviewer, { ...before, transaction_years: 0 })).statusCode).toBe(403)
    try {
      expect((await set({ ...periods, transaction_years: 0 })).statusCode).toBe(200)
      expect(await now()).toMatchObject({ ...periods, transaction_years: 0 })
      expect((await set(periods)).statusCode).toBe(200)
      expect((await now()).transaction_years).toBe(0)
      expect(await count(
          "SELECT count(*) AS n FROM audit a JOIN audit_detail d ON d.audit_seq = a.seq WHERE a.action = $1 AND d.detail = '{\"transaction_years\":0}'",
          [`retention.config_changed.${periods.relationship_years}.${periods.idle_months}.${periods.kyc_valid_years}`],
        )).toBe(1)
      // open work stays whatever its age: a withdrawal not decided, money nobody has placed
      const w = await inject('POST', `/api/deals/${deal}/participations/${pa}/withdrawal`, lead, { consent_confirmed: true, evidence: 'Email from the investor' })
      expect(w.statusCode, w.body).toBe(200)
      const un = await inject('POST', '/api/review/unallocated', reviewer, {
        currency: 'GBP',
        amount_minor: '5000',
        received_on: new Date().toISOString().slice(0, 10),
        payer_name: 'Olive Open',
        payer_account: '11112222',
      })
      expect(un.statusCode, un.body).toBe(200)
      // zero: payer details go at the next run, here a day after the receipt was recorded
      await run(at(new Date(), 0, 1))
      expect(await one('SELECT payer_name FROM receipt WHERE participation_id = $1', [pa])).toEqual({ payer_name: 'Removed' })
      expect(await count("SELECT count(*) AS n FROM withdrawal_request WHERE participation_id = $1 AND decision IS NULL", [pa])).toBe(1)
      expect(await one("SELECT payer_name FROM unallocated_receipt WHERE payer_name = 'Olive Open'", [])).toEqual({ payer_name: 'Olive Open' })
    } finally {
      expect((await set(before)).statusCode).toBe(200)
    }
  })

  it('TC-KYC-07 transaction records: a receipt 11 years old loses its payer while the relationship and the account go on; identity checks and files stay; a legal hold keeps it', async () => {
    const deal = await liveDeal(lead)
    const a = await investor(deal)
    const b = await investor(deal)
    for (const x of [a, b]) expect((await commit(x.u, deal, x.entity, '1000000')).statusCode).toBe(200)
    const pa = await pid(a.u, deal)
    const pb = await pid(b.u, deal)
    await receipt(pa, 'Pat Payer')
    await receipt(pb, 'Pat Payer')
    await t.owner.query(
      "INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) VALUES ($1, 'entity_kyc', $2, 'id', 'passport.pdf', 'application/pdf', 'x', 1, 'clean', $3, 'k1', '\\x00', $4)",
      [randomUUID(), a.entity, `kyc-${a.entity}`, a.u.id],
    )
    await t.owner.query('UPDATE user_account SET retention_hold = true WHERE id = $1', [b.u.id])
    const payer = async (p: string) => one('SELECT payer_name, amount_minor::text AS amount FROM receipt WHERE participation_id = $1', [p])

    // nine years on: kept; and the account, idle for years, stays while the part is still running
    await run(new Date('2035-11-11T00:00:00Z'))
    expect(await payer(pa)).toEqual({ payer_name: 'Pat Payer', amount: '500000' })
    const r = await run(new Date('2037-11-11T00:00:00Z'))
    expect(r.transactionRows).toBeGreaterThan(0)
    expect(r.removed).not.toContain(a.u.id)
    expect(await payer(pa)).toEqual({ payer_name: 'Removed', amount: '500000' })
    expect(await payer(pb)).toEqual({ payer_name: 'Pat Payer', amount: '500000' })
    // CDD records are on the person's clock, not this one
    expect(await one('SELECT anonymised_at FROM user_account WHERE id = $1', [a.u.id])).toEqual({ anonymised_at: null })
    expect(await count('SELECT count(*) AS n FROM kyc_case WHERE entity_id = $1', [a.entity])).toBe(1)
    expect(await count("SELECT count(*) AS n FROM stored_file WHERE scope = 'entity_kyc' AND owner_id = $1", [a.entity])).toBe(1)
    expect(await count("SELECT count(*) AS n FROM legal_entity_version WHERE entity_id = $1 AND fields <> '{}'", [a.entity])).toBeGreaterThan(0)
    expect(await count('SELECT count(*) AS n FROM participation_event WHERE participation_id = $1', [pa])).toBe(0)
    expect(await count('SELECT count(*) AS n FROM participation_event WHERE participation_id = $1', [pb])).toBeGreaterThan(0)
  })

  it('TC-KYC-07 a blanked payer account is no account to refund to: money still due back needs the account typed, with evidence (plan R28 (3))', async () => {
    // the runs above, years ahead, removed the shared lead
    const leader = await person(unique('retention-refund-lead'))
    const deal = await liveDeal(leader)
    const a = await investor(deal, { leader })
    expect((await commit(a.u, deal, a.entity, '1000000')).statusCode).toBe(200)
    const p = await pid(a.u, deal)
    const paid = await inject('POST', `/api/review/participations/${p}/receipts`, reviewer, {
      amount_minor: '5000000',
      received_on: '2026-11-10',
      payer_name: 'Pat Payer',
      payer_account: '12345678',
    })
    expect(paid.statusCode, paid.body).toBe(200)
    await run(new Date('2037-11-11T00:00:00Z'))
    expect(await one('SELECT DISTINCT payer_account FROM receipt WHERE participation_id = $1', [p])).toEqual({ payer_account: 'Removed' })
    const known = (await inject('GET', '/api/review/refunds', reviewer)).json().rows.find((r: { participation_id: string }) => r.participation_id === p)
    expect(known.payer_account_known).toBe(false)
    const ask = (extra: object) => inject('POST', `/api/review/participations/${p}/refunds`, reviewer, { amount_minor: '1000', ...extra })
    expect((await ask({})).json().error).toMatch(/not known: type the account/)
    expect((await ask({ dest_name: 'Pat Payer', dest_account: '12345678' })).json().error).toMatch(/evidence/)
    const typed = await ask({ dest_name: 'Pat Payer', dest_account: '12345678', evidence: 'Bank letter naming the account' })
    expect(typed.statusCode, typed.body).toBe(200)
    expect(typed.json().differs_from_source).toBe(true)
  })

})
