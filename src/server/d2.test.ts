import { randomUUID } from 'node:crypto'
import { renderPdf } from './pdf.ts'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeAt, stepOf } from '../lib/totp.ts'
import { tx } from '../store/db.ts'
import { createTestDb, type TestDb } from '../store/testdb.ts'
import { buildServer } from './app.ts'
import { bootstrapAdmin, createUser, grantRole } from './auth.ts'
import { lapseApprovals } from './d2.ts'
import { UploadHolds } from './uploadSlots.ts'

const PW = 'a-long-enough-password'
const MFA = Buffer.alloc(20, 9)
let t: TestDb
let app: FastifyInstance
let clock = new Date('2026-11-09T09:00:00.000Z')
let ipCounter = 0
const nextIp = () => `10.30.${Math.floor(ipCounter / 200)}.${(ipCounter++ % 200) + 1}`

interface Client {
  cookie: string
  csrf: string
  id: string
  email: string
}

const inject = (method: string, url: string, who?: Client, payload?: unknown) =>
  app.inject({
    method: method as 'GET',
    url,
    remoteAddress: nextIp(),
    headers: who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  })

/** A decision names the content it is about. Most tests are about other things, so unless one names a hash the client does what the page does. */
const NO_HASH = '0'.repeat(64)
const send = async (method: string, url: string, who?: Client, payload?: unknown) => {
  const decision = /^\/api\/review\/deals\/([\w-]+)\/(?:approve|request-changes|reject)$/.exec(url)
  const content = /^\/api\/review\/deals\/([\w-]+)\/content-approval$/.exec(url)
  if (decision && payload && !('reviewed_sha256' in (payload as object))) {
    const v = await t.owner.query<{ sha256: string }>('SELECT sha256 FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1', [decision[1]])
    payload = { ...(payload as object), reviewed_sha256: v.rows[0]?.sha256 ?? NO_HASH }
  }
  if (content && payload && !('content_sha256' in (payload as object))) {
    const v = await t.owner.query<{ sha256: string }>(
      'SELECT v.sha256 FROM deal d JOIN deal_version v ON v.deal_id = d.id AND v.n = d.approved_version WHERE d.id = $1',
      [content[1]],
    )
    payload = { ...(payload as object), content_sha256: v.rows[0]?.sha256 ?? NO_HASH }
  }
  const launch = /^\/api\/deals\/([\w-]+)\/launch$/.exec(url)
  if (launch && (payload as { confirm?: boolean } | undefined)?.confirm && !('content_sha256' in (payload as object))) {
    const v = await t.owner.query<{ sha256: string }>(
      'SELECT v.sha256 FROM deal d JOIN deal_version v ON v.deal_id = d.id AND v.n = d.approved_version WHERE d.id = $1',
      [launch[1]],
    )
    payload = { ...(payload as object), content_sha256: v.rows[0]?.sha256 ?? NO_HASH }
  }
  const check = /^\/api\/review\/deals\/([\w-]+)\/investee\/(?:approve|return)$/.exec(url)
  if (check && payload && !('reviewed_sha256' in (payload as object))) {
    const page = (await inject('GET', `/api/review/deals/${check[1]}`, reviewer)).json()
    payload = { ...(payload as object), reviewed_sha256: page.investee?.check_sha256 ?? NO_HASH }
  }
  return inject(method, url, who, payload)
}

async function login(email: string): Promise<Client> {
  await t.owner.query('UPDATE user_account SET mfa_last_step = NULL WHERE lower(email) = lower($1)', [email])
  const r = await send('POST', '/api/login', undefined, { email, password: PW, code: codeAt(MFA, stepOf(clock.getTime())) })
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

async function person(email: string): Promise<Client> {
  const r = await send('POST', '/api/register', undefined, { first_name: 'Fay', last_name: 'Fictional', email, password: PW })
  expect(r.statusCode).toBe(200)
  const token = new URL(r.json().sandbox_link, 'http://x').searchParams.get('token')!
  expect((await send('POST', '/api/verify-email', undefined, { token, password: PW })).statusCode).toBe(200)
  return login(email)
}

let n = 0
const unique = (s: string) => `${s}${++n}@example.test`
// one each: the D1 limit on entities per person is real, and these tests are not about it
const entities = new Map<string, string>()
const entityFor = async (who: Client) => {
  const known = entities.get(who.id)
  if (known) return known
  const id = (
    await send('POST', '/api/entities', who, {
      type: 'individual',
      fields: { full_name: 'Fay Fictional', address: '1 Seed Street', tax_residence: 'UK', tax_id: 'SEEDTAX1' },
      parties: [],
    })
  ).json().id as string
  entities.set(who.id, id)
  return id
}

/** File routes come later in D2: a scanned legal document, put straight in the table. */
const legalFile = (deal: string) =>
  t.owner.query(
    "INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) SELECT $1, 'deal_shared', d.id, 'legal', 'a.pdf', 'application/pdf', 'x', 1, 'clean', 'k', 'k1', '\\x00', d.lead_user FROM deal d WHERE d.id = $2",
    [randomUUID(), deal],
  )

const draftFor = (entity: string, over: Record<string, unknown> = {}) => ({
  basics: {
    structure: 'uk_bare_trust',
    deal_type: 'primary',
    name: 'Seedling Round',
    syndicate: { mode: 'new', name: 'Seedling Friends', lead_entity_id: entity },
  },
  company: { legal_name: 'Seedling Ltd', contact_name: 'Sam Founder', contact_email: 'sam.founder@example.test', jurisdiction: 'England and Wales' },
  terms: {
    currency: 'GBP',
    instrument: 'equity',
    share_price_micros: '15000',
    pre_money_minor: '500000000',
    allocation_minor: '30000000',
    voter: 'lead',
    target_close: '2027-01-31',
  },
  files: {},
  economics: {
    default_carry_bps: 2000,
    recipients: [{ kind: 'person', first_name: 'Cara', last_name: 'Carry', email: 'cara.carry@example.test', share_bps: 10000 }],
    fee_payer: 'lead',
  },
  attestations: { board_and_shareholders: true },
  ...over,
})

async function newDeal(who: Client, draft?: object): Promise<string> {
  const id = (await send('POST', '/api/deals', who, {})).json().id as string
  if (draft) expect((await send('PUT', `/api/deals/${id}/draft`, who, draft)).statusCode).toBe(200)
  return id
}
async function submitted(who: Client): Promise<string> {
  const id = await newDeal(who, draftFor(await entityFor(who)))
  await legalFile(id)
  const r = await send('POST', `/api/deals/${id}/submit`, who, {})
  expect(r.statusCode, r.body).toBe(200)
  return id
}
const approve = (id: string, who = reviewer) => send('POST', `/api/review/deals/${id}/approve`, who, {})
async function approved(who: Client): Promise<string> {
  const id = await submitted(who)
  expect((await approve(id)).statusCode).toBe(200)
  return id
}
const stateOf = async (id: string) => (await t.owner.query<{ state: string }>('SELECT state FROM deal WHERE id = $1', [id])).rows[0]!.state
const mailTo = async (to: string) =>
  (
    await t.owner.query<{ subject: string; body: string }>('SELECT subject, body FROM sandbox_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at', [
      to,
    ])
  ).rows
const count = async (sql: string, args: unknown[] = []) => Number((await t.owner.query<{ n: string }>(sql, args)).rows[0]!.n)
const editName = async (id: string, who: Client, name: string) => {
  const current = (await send('GET', `/api/deals/${id}`, who)).json().draft
  return send('PUT', `/api/deals/${id}/draft`, who, { ...current, basics: { ...current.basics, name } })
}

let feeVersion = 0
const setFee = () =>
  t.owner.query(
    'INSERT INTO fee_config (id, version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, changed_by) SELECT $1, $2, 250, 400000, 2000000, 500000000, 10, id FROM user_account LIMIT 1',
    [randomUUID(), ++feeVersion + 100],
  )

// a real PDF: deal files are checked for a warning cover on upload (decision R26)
const PDF = await renderPdf([{ text: 'fictional agreement' }], 'Agreement')
/** A real zip with empty entries, built by hand: what the check reads is its directory. */
const zipOf = (names: string[]) => {
  const local = names.map((n) => {
    const b = Buffer.alloc(30 + n.length)
    b.writeUInt32LE(0x04034b50, 0)
    b.writeUInt16LE(n.length, 26)
    b.write(n, 30, 'latin1')
    return b
  })
  let at = 0
  const central = names.map((n, i) => {
    const b = Buffer.alloc(46 + n.length)
    b.writeUInt32LE(0x02014b50, 0)
    b.writeUInt16LE(n.length, 28)
    b.writeUInt32LE(at, 42)
    b.write(n, 46, 'latin1')
    at += local[i]!.length
    return b
  })
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(at, 16)
  return Buffer.concat([...local, dir, end])
}
const upload = (who: Client, deal: string, query: string, body: Buffer = PDF) =>
  app.inject({
    method: 'POST',
    url: `/api/deals/${deal}/files?${query}`,
    remoteAddress: nextIp(),
    headers: { cookie: who.cookie, 'x-csrf-token': who.csrf, 'content-type': 'application/octet-stream' },
    payload: body,
  })

let reviewer: Client
let approver: Client
let lead: Client

beforeAll(async () => {
  t = await createTestDb()
  app = await buildServer({ db: t.app, k: t.keyring, secureCookies: false, now: () => clock })
  await bootstrapAdmin(t.app, t.keyring, 'first@example.test', PW)
  await t.owner.query('UPDATE user_account SET must_change_password = false')
  reviewer = await staff('reviewer@example.test', ['reviewer'])
  approver = await staff('approver@example.test', ['approver'])
  lead = await person('lead@example.test')
  await setFee()
})
afterAll(async () => {
  await app?.close()
  await t?.drop()
})

describe('drafts', () => {
  it('TC-DRF-06 a draft saves however incomplete, says what is missing section by section, and any section can be saved first', async () => {
    const id = await newDeal(lead)
    expect((await send('PUT', `/api/deals/${id}/draft`, lead, { terms: { allocation_minor: 'not a number' } })).statusCode).toBe(200)
    const v = (await send('GET', `/api/deals/${id}`, lead)).json()
    expect(v.draft.terms.allocation_minor).toBe('not a number')
    expect(v.progress.terms).toBe(false)
    expect(v.problems.find((p: { field: string }) => p.field === 'allocation_minor').kind).toBe('invalid')
    expect(v.problems.find((p: { field: string }) => p.field === 'name').kind).toBe('missing')
  })

  it('TC-DRF-01 the server refuses a draft of the wrong shape or an unknown field', async () => {
    const id = await newDeal(lead)
    expect((await send('PUT', `/api/deals/${id}/draft`, lead, { nonsense: 1 })).statusCode).toBe(400)
    expect((await send('PUT', `/api/deals/${id}/draft`, lead, { terms: { allocation_minor: 5 } })).statusCode).toBe(400)
    expect((await send('PUT', `/api/deals/not-a-uuid/draft`, lead, {})).statusCode).toBe(400)
  })

  it('TC-DRF-02 a price of £0.015 is unchanged after saving and reading back', async () => {
    const id = await newDeal(lead, draftFor(await entityFor(lead)))
    expect((await send('GET', `/api/deals/${id}`, lead)).json().draft.terms.share_price_micros).toBe('15000')
  })

  it('TC-SYN-01 a draft creates no syndicate; deleting it leaves none; it can be restored within the period and not after', async () => {
    const before = await count('SELECT count(*) AS n FROM syndicate')
    const id = await newDeal(lead, draftFor(await entityFor(lead)))
    expect(await count('SELECT count(*) AS n FROM syndicate')).toBe(before)
    expect((await send('DELETE', `/api/deals/${id}`, lead)).statusCode).toBe(200)
    expect(await count('SELECT count(*) AS n FROM syndicate')).toBe(before)
    expect((await send('GET', `/api/deals/${id}`, lead)).statusCode).toBe(404)
    expect((await send('POST', `/api/deals/${id}/restore`, lead, {})).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${id}`, lead)).statusCode).toBe(200)
    await send('DELETE', `/api/deals/${id}`, lead)
    const saved = clock
    clock = new Date(clock.getTime() + 60 * 86_400_000)
    expect((await send('POST', `/api/deals/${id}/restore`, lead, {})).statusCode).toBe(409)
    clock = saved
  })

  it('TC-SYN-01 only a draft can be deleted', async () => {
    const id = await submitted(lead)
    expect((await send('DELETE', `/api/deals/${id}`, lead)).json().error).toBe('Only a draft can be deleted.')
  })

  it('TC-AUTHZ-03 someone else cannot see, change, submit or delete a deal, and cannot tell it exists', async () => {
    const other = await person(unique('other'))
    const id = await newDeal(lead)
    expect((await send('GET', `/api/deals/${id}`, other)).statusCode).toBe(404)
    for (const [m, u, b] of [
      ['PUT', `/api/deals/${id}/draft`, {}],
      ['POST', `/api/deals/${id}/submit`, {}],
      ['DELETE', `/api/deals/${id}`, undefined],
      ['POST', `/api/deals/${id}/withdraw`, {}],
    ] as const) {
      const r = await send(m, u, other, b)
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toBe('Deal not found.')
    }
    expect((await send('GET', '/api/deals', other)).json().deals).toEqual([])
    expect((await send('GET', `/api/deals/${id}`)).statusCode).toBe(401)
  })

  it('TC-AUTHZ-03 an assigned member can read the deal but not change it', async () => {
    const member = await person(unique('member'))
    const id = await newDeal(lead, draftFor(await entityFor(lead)))
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [id, member.id])
    const v = await send('GET', `/api/deals/${id}`, member)
    expect(v.statusCode).toBe(200)
    expect(v.json().can_edit).toBe(false)
    expect((await send('PUT', `/api/deals/${id}/draft`, member, {})).statusCode).toBe(409)
    expect((await send('GET', '/api/deals', member)).json().deals.map((d: { id: string }) => d.id)).toEqual([id])
  })
})

describe('submitting', () => {
  it('TC-DRF-06 an incomplete draft cannot be submitted and the refusal lists what is missing', async () => {
    const id = await newDeal(lead)
    const r = await send('POST', `/api/deals/${id}/submit`, lead, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('Deal name')
    expect(await stateOf(id)).toBe('draft')
  })

  it('TC-DRF-03 no legal document, no submission', async () => {
    const id = await newDeal(lead, draftFor(await entityFor(lead)))
    const r = await send('POST', `/api/deals/${id}/submit`, lead, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('Investment agreement and legal documents')
  })

  it('TC-DRF-08 no lead confirmation, no submission; with one, it is recorded against the version', async () => {
    const e = await entityFor(lead)
    const id = await newDeal(lead, draftFor(e, { attestations: {} }))
    await legalFile(id)
    expect((await send('POST', `/api/deals/${id}/submit`, lead, {})).json().error).toContain('Board and shareholder confirmation')
    await send('PUT', `/api/deals/${id}/draft`, lead, draftFor(e))
    expect((await send('POST', `/api/deals/${id}/submit`, lead, {})).statusCode).toBe(200)
    expect(await count("SELECT count(*) AS n FROM lead_attestation WHERE deal_id = $1 AND kind = 'board_and_shareholders' AND version_n = 1", [id])).toBe(1)
  })

  it('TC-SYN-01 the syndicate is created at submission, with the lead as its admin', async () => {
    const id = await submitted(lead)
    const row = (
      await t.owner.query<{ syndicate_id: string; role: string; name: string }>(
        'SELECT d.syndicate_id, m.role, s.name FROM deal d JOIN syndicate s ON s.id = d.syndicate_id JOIN syndicate_member m ON m.syndicate_id = s.id WHERE d.id = $1 AND m.user_id = $2',
        [id, lead.id],
      )
    ).rows[0]!
    expect(row).toMatchObject({ role: 'admin', name: 'Seedling Friends' })
    expect((await send('GET', `/api/deals/${id}`, lead)).json().draft.basics.syndicate).toEqual({ mode: 'existing', id: row.syndicate_id })
  })

  it('TC-DRF-07 nothing is mailed until submission; then the contact gets a link and the lead a notice without it', async () => {
    const who = await person(unique('mail'))
    const contact = unique('contact')
    const e = await entityFor(who)
    const base = draftFor(e)
    const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: contact } })
    await legalFile(id)
    expect(await mailTo(contact)).toEqual([])
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    const sent = await mailTo(contact)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toMatch(/\/investee\?token=[\w-]+/)
    const notice = (await mailTo(who.email)).find((m) => /Company check started/.test(m.subject))!
    expect(notice.body).not.toContain('token=')
  })

  it('TC-DRF-07 withdrawing and submitting again does not send a second link', async () => {
    const who = await person(unique('again'))
    const contact = unique('contact')
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: contact } })
    await legalFile(id)
    await send('POST', `/api/deals/${id}/submit`, who, {})
    await send('POST', `/api/deals/${id}/withdraw`, who, {})
    expect(await stateOf(id)).toBe('draft')
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    expect(await mailTo(contact)).toHaveLength(1)
  })
})

describe('what the wizard relies on', () => {
  it('TC-DRF-06 a lead is told what the operator asks for, without reading the operator settings', async () => {
    const who = await person(unique('settings'))
    const id = await newDeal(who)
    expect((await send('GET', '/api/deal-config', who)).statusCode).toBe(403)
    await t.owner.query(
      "UPDATE deal_config SET required_company_fields = '{registration_number}', embed_hosts = '{docs.example.test}', default_carry_bps = 1500",
    )
    const { settings } = await (async () => {
      try {
        return (await send('GET', `/api/deals/${id}`, who)).json()
      } finally {
        await t.owner.query("UPDATE deal_config SET required_company_fields = '{}', embed_hosts = '{}', default_carry_bps = 2000")
      }
    })()
    const fee = (
      await t.owner.query('SELECT rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps FROM fee_config ORDER BY version DESC LIMIT 1')
    ).rows[0]
    expect(settings).toEqual({
      enabled_structures: ['uk_bare_trust'],
      required_company_fields: ['registration_number'],
      min_commitment_floor_minor: '100000',
      default_carry_bps: 1500,
      draft_restore_days: 60,
      embed_hosts: ['docs.example.test'],
      fee,
    })
  })

  it('TC-REV-02 saving in the background never restarts a review; asking to save does', async () => {
    const who = await person(unique('autosave'))
    const id = await submitted(who)
    const draft = (await send('GET', `/api/deals/${id}`, who)).json().draft
    const renamed = { ...draft, basics: { ...draft.basics, name: 'A page left open' } }
    const events = () => count('SELECT count(*) AS n FROM review_event WHERE deal_id = $1', [id])
    const before = await events()
    expect((await send('PUT', `/api/deals/${id}/draft?autosave=1`, who, renamed)).statusCode).toBe(409)
    expect(await events()).toBe(before)
    expect((await send('GET', `/api/deals/${id}`, who)).json().draft.basics.name).toBe('Seedling Round')
    expect((await send('PUT', `/api/deals/${id}/draft`, who, renamed)).statusCode).toBe(200)
    expect(await events()).toBe(before + 1)

    const passed = await approved(who)
    const current = (await send('GET', `/api/deals/${passed}`, who)).json().draft
    expect(
      (await send('PUT', `/api/deals/${passed}/draft?autosave=1`, who, { ...current, basics: { ...current.basics, name: 'Still open' } })).statusCode,
    ).toBe(409)
    expect(await stateOf(passed)).toBe('approved')
  })

  it('TC-DRF-06 background saving works on a draft and on a deal sent back for changes', async () => {
    const who = await person(unique('autosave2'))
    const id = await newDeal(who, draftFor(await entityFor(who)))
    expect((await send('PUT', `/api/deals/${id}/draft?autosave=1`, who, { basics: { name: 'Typed so far' } })).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${id}`, who)).json().draft.basics.name).toBe('Typed so far')

    const sent = await submitted(who)
    expect((await send('POST', `/api/review/deals/${sent}/request-changes`, reviewer, { reason: 'More detail' })).statusCode).toBe(200)
    const draft = (await send('GET', `/api/deals/${sent}`, who)).json().draft
    expect((await send('PUT', `/api/deals/${sent}/draft?autosave=1`, who, { ...draft, basics: { ...draft.basics, name: 'Corrected' } })).statusCode).toBe(200)
    expect(await stateOf(sent)).toBe('changes_requested')
  })

  it('TC-DRF-06 a page holding an older copy cannot save over a newer one', async () => {
    const who = await person(unique('stale'))
    const id = await newDeal(who, draftFor(await entityFor(who)))
    const read = async () => (await send('GET', `/api/deals/${id}`, who)).json()
    const first = await read()
    const named = (name: string) => ({ ...first.draft, basics: { ...first.draft.basics, name } })
    const saved = await send('PUT', `/api/deals/${id}/draft?autosave=1&base=${first.draft_rev}`, who, named('Written first'))
    expect(saved.json().rev).toBe(first.draft_rev + 1)
    const stale = await send('PUT', `/api/deals/${id}/draft?autosave=1&base=${first.draft_rev}`, who, named('From an older page'))
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toContain('Someone has changed this deal')
    expect((await read()).draft.basics.name).toBe('Written first')
    expect((await send('PUT', `/api/deals/${id}/draft?autosave=1&base=${first.draft_rev + 1}`, who, named('From the newest page'))).statusCode).toBe(200)
    expect((await send('PUT', `/api/deals/${id}/draft?base=x`, who, named('Nonsense'))).statusCode).toBe(400)
  })

  it('TC-SYN-01 a page from before a submission cannot bring back the syndicate the submission settled', async () => {
    const who = await person(unique('stalesyn'))
    const id = await newDeal(who, draftFor(await entityFor(who)))
    await legalFile(id)
    const before = (await send('GET', `/api/deals/${id}`, who)).json()
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    expect((await send('POST', `/api/deals/${id}/withdraw`, who, {})).statusCode).toBe(200)
    expect((await send('PUT', `/api/deals/${id}/draft?autosave=1&base=${before.draft_rev}`, who, before.draft)).statusCode).toBe(409)
  })

  it('TC-DEAL-01 going live names the version the page showed; another one approved meanwhile is refused', async () => {
    const who = await person(unique('launchhash'))
    const id = await approved(who)
    const shown = (await send('GET', `/api/deals/${id}`, who)).json().approved_sha256
    const hash = (await t.owner.query<{ sha256: string }>('SELECT sha256 FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1', [id])).rows[0]!.sha256
    expect(shown).toBe(hash)
    expect((await inject('POST', `/api/deals/${id}/launch`, who, { confirm: true })).statusCode).toBe(400)
    const r = await inject('POST', `/api/deals/${id}/launch`, who, { confirm: true, content_sha256: NO_HASH })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('changed since you opened it')
    expect(await stateOf(id)).toBe('approved')
    expect((await inject('POST', `/api/deals/${id}/launch`, who, { confirm: true, content_sha256: shown })).json().state).toBe('live')
  })

  it('TC-REV-02 the review page names the content it shows', async () => {
    const id = await submitted(await person(unique('hashed')))
    const hash = (await t.owner.query<{ sha256: string }>('SELECT sha256 FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1', [id])).rows[0]!.sha256
    expect((await send('GET', `/api/review/deals/${id}`, reviewer)).json().latest_sha256).toBe(hash)
  })
})

describe('review', () => {
  it('TC-REV-01 the queue is in target close order, with no date last', async () => {
    const who = await person(unique('queue'))
    const e = await entityFor(who)
    const make = async (target_close?: string) => {
      const base = draftFor(e)
      const id = await newDeal(who, { ...base, terms: { ...base.terms, target_close } })
      await legalFile(id)
      expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
      return id
    }
    const late = await make('2030-06-01')
    const none = await make(undefined)
    const early = await make('2026-12-01')
    const order = (await send('GET', '/api/review/deals', reviewer))
      .json()
      .deals.map((d: { id: string }) => d.id)
      .filter((x: string) => [late, none, early].includes(x))
    expect(order).toEqual([early, late, none])
  })

  it('TC-REV-01 approve, return and reject each move the deal and tell the lead; a reason is required for the last two', async () => {
    const a = await submitted(lead)
    expect((await approve(a)).json().state).toBe('approved')
    const b = await submitted(lead)
    expect((await send('POST', `/api/review/deals/${b}/request-changes`, reviewer, { reason: '  ' })).statusCode).toBe(409)
    expect((await send('POST', `/api/review/deals/${b}/request-changes`, reviewer, { reason: 'Fix the valuation.' })).json().state).toBe('changes_requested')
    const c = await submitted(lead)
    expect((await send('POST', `/api/review/deals/${c}/reject`, reviewer, { reason: 'Out of scope.' })).json().state).toBe('rejected')
    expect((await send('POST', `/api/deals/${c}/submit`, lead, {})).statusCode).toBe(409)
    expect((await editName(c, lead, 'Again')).statusCode).toBe(409)
    expect((await mailTo(lead.email)).some((m) => m.body.includes('Fix the valuation.'))).toBe(true)
  })

  it('TC-REV-01 the lead never receives the internal note or who reviewed', async () => {
    const id = await submitted(lead)
    await send('POST', `/api/review/deals/${id}/request-changes`, reviewer, { reason: 'Please clarify.', internal_note: 'SECRET-NOTE' })
    const page = await send('GET', `/api/deals/${id}`, lead)
    expect(page.body).not.toContain('SECRET-NOTE')
    expect(page.body).not.toContain(reviewer.id)
    expect(page.body).toContain('Please clarify.')
    expect((await mailTo(lead.email)).some((m) => m.body.includes('SECRET-NOTE'))).toBe(false)
    expect((await send('GET', `/api/review/deals/${id}`, reviewer)).body).toContain('SECRET-NOTE')
  })

  it('TC-REV-01 only a reviewer reaches the queue or a decision', async () => {
    const id = await submitted(lead)
    expect((await send('GET', '/api/review/deals', lead)).statusCode).toBe(403)
    expect((await approve(id, lead)).statusCode).toBe(403)
    expect((await approve(id, approver)).statusCode).toBe(403)
    expect(await stateOf(id)).toBe('in_review')
  })

  it('TC-REV-02 an edit during review restarts it and shows what changed; a save with no change does not', async () => {
    const id = await submitted(lead)
    const versions = async () => count('SELECT count(*) AS n FROM deal_version WHERE deal_id = $1', [id])
    const before = await versions()
    const page = (await send('GET', `/api/deals/${id}`, lead)).json()
    expect((await send('PUT', `/api/deals/${id}/draft`, lead, page.draft)).statusCode).toBe(200)
    expect(await versions()).toBe(before)
    expect((await editName(id, lead, 'Renamed Round')).json().state).toBe('in_review')
    expect(await versions()).toBe(before + 1)
    expect((await send('GET', `/api/review/deals/${id}`, reviewer)).json().changes).toEqual([
      { field: 'basics.name', before: 'Seedling Round', after: 'Renamed Round' },
    ])
    expect(await count("SELECT count(*) AS n FROM review_event WHERE deal_id = $1 AND event = 'lead_edit'", [id])).toBe(1)
  })

  it('TC-REV-02 withdrawing and resubmitting unchanged content adds no version', async () => {
    const id = await submitted(lead)
    const versions = () => count('SELECT count(*) AS n FROM deal_version WHERE deal_id = $1', [id])
    const before = await versions()
    await send('POST', `/api/deals/${id}/withdraw`, lead, {})
    expect((await send('POST', `/api/deals/${id}/submit`, lead, {})).statusCode).toBe(200)
    expect(await versions()).toBe(before)
  })

  it('TC-REV-02 what changed still shows after the changed version is approved', async () => {
    const id = await submitted(lead)
    await editName(id, lead, 'Renamed Before Approval')
    await approve(id)
    expect((await send('GET', `/api/deals/${id}`, lead)).json().changes).toEqual([
      { field: 'basics.name', before: 'Seedling Round', after: 'Renamed Before Approval' },
    ])
  })

  it('TC-REV-02 an edit during review that would leave a required field empty is refused and nothing is saved', async () => {
    const id = await submitted(lead)
    const r = await editName(id, lead, '')
    expect(r.statusCode).toBe(409)
    expect((await send('GET', `/api/deals/${id}`, lead)).json().draft.basics.name).toBe('Seedling Round')
  })

  it('TC-REV-02 the lead can withdraw; a syndicate cannot be swapped during review', async () => {
    const id = await submitted(lead)
    const page = (await send('GET', `/api/deals/${id}`, lead)).json()
    await send('PUT', `/api/deals/${id}/draft`, lead, {
      ...page.draft,
      basics: { ...page.draft.basics, syndicate: { mode: 'new', name: 'Other', lead_entity_id: await entityFor(lead) } },
    })
    expect((await send('GET', `/api/deals/${id}`, lead)).json().draft.basics.syndicate).toEqual(page.draft.basics.syndicate)
    expect((await send('POST', `/api/deals/${id}/withdraw`, lead, {})).json().state).toBe('draft')
  })

  it('TC-DRF-08 the review page shows the custom terms to read', async () => {
    const e = await entityFor(lead)
    const base = draftFor(e)
    const custom_terms = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Investors indemnify the lead.' }] }] }
    const id = await newDeal(lead, { ...base, terms: { ...base.terms, custom_terms } })
    await legalFile(id)
    await send('POST', `/api/deals/${id}/submit`, lead, {})
    expect((await send('GET', `/api/review/deals/${id}`, reviewer)).json().checklist.customTerms).toBe('Investors indemnify the lead.')
  })

  it('TC-AUTHZ-04 a reviewer who is the lead, on the team or a carry recipient cannot decide; the queue says so', async () => {
    const strict = await staff(unique('conflicted'), ['reviewer'])
    const own = await submitted(strict)
    expect((await approve(own, strict)).statusCode).toBe(409)
    const onTeam = await submitted(lead)
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [onTeam, strict.id])
    expect((await send('POST', `/api/review/deals/${onTeam}/reject`, strict, { reason: 'x' })).statusCode).toBe(409)
    const base = draftFor(await entityFor(lead))
    const carry = await newDeal(lead, {
      ...base,
      economics: { ...base.economics, recipients: [{ kind: 'person', first_name: 'S', last_name: 'R', email: strict.email.toUpperCase(), share_bps: 10000 }] },
    })
    await legalFile(carry)
    await send('POST', `/api/deals/${carry}/submit`, lead, {})
    expect((await send('POST', `/api/review/deals/${carry}/request-changes`, strict, { reason: 'x' })).statusCode).toBe(409)
    const row = (await send('GET', '/api/review/deals', strict)).json().deals.find((d: { id: string }) => d.id === carry)
    expect(row.can_review).toBe(false)
    expect(await stateOf(carry)).toBe('in_review')
  })
})

describe('launch', () => {
  it('TC-PUB-01 each approval stores a snapshot with who approved it, and it keeps its content after later edits', async () => {
    const id = await approved(lead)
    const v = (
      await t.owner.query<{ n: number; kind: string; approved_by: string; snapshot: { basics: { name: string } } }>(
        "SELECT n, kind, approved_by, snapshot FROM deal_version WHERE deal_id = $1 AND kind = 'approved'",
        [id],
      )
    ).rows[0]!
    expect(v).toMatchObject({ approved_by: reviewer.id })
    await editName(id, lead, 'Changed Later')
    const again = (
      await t.owner.query<{ snapshot: { basics: { name: string } } }>('SELECT snapshot FROM deal_version WHERE deal_id = $1 AND n = $2', [id, v.n])
    ).rows[0]!
    expect(again.snapshot.basics.name).toBe('Seedling Round')
  })

  it('TC-PUB-02 a snapshot holds no personal details, and an old version still shows the old contact after a change', async () => {
    const id = await submitted(lead)
    const first = (
      await t.owner.query<{ snapshot: { company: { contact_version: string }; economics: { recipients: Array<{ person_version: string }> } } }>(
        'SELECT snapshot FROM deal_version WHERE deal_id = $1 AND n = 1',
        [id],
      )
    ).rows[0]!.snapshot
    expect(JSON.stringify(first)).not.toContain('sam.founder@example.test')
    expect(JSON.stringify(first)).not.toContain('cara.carry@example.test')
    const page = (await send('GET', `/api/deals/${id}`, lead)).json()
    await send('PUT', `/api/deals/${id}/draft`, lead, { ...page.draft, company: { ...page.draft.company, contact_email: 'new.contact@example.test' } })
    const old = (await t.owner.query<{ fields: { contact_email: string } }>('SELECT fields FROM person_version WHERE id = $1', [first.company.contact_version]))
      .rows[0]!
    expect(old.fields.contact_email).toBe('sam.founder@example.test')
    expect((await send('GET', `/api/review/deals/${id}`, reviewer)).json().changes).toEqual([
      { field: 'company.contact_email', before: 'sam.founder@example.test', after: 'new.contact@example.test' },
    ])
  })

  it("TC-DEAL-01 an approved deal goes live on the lead's confirmation and binds the active pack", async () => {
    const id = await approved(lead)
    expect((await send('POST', `/api/deals/${id}/launch`, lead, {})).statusCode).toBe(400)
    expect((await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })).json().state).toBe('live')
    const row = (
      await t.owner.query<{ pack_id: string; active: string }>(
        'SELECT d.pack_id, i.active_pack_id AS active FROM deal d CROSS JOIN instance_profile i WHERE d.id = $1',
        [id],
      )
    ).rows[0]!
    expect(row.pack_id).toBe(row.active)
    expect((await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })).statusCode).toBe(409)
  })

  it('TC-DEAL-01 with no platform fee set, launch is refused in words, not a server error', async () => {
    const id = await approved(lead)
    await t.owner.query('UPDATE deal SET fee_config_id = NULL WHERE id = $1', [id])
    const r = await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('The operator has not set the platform fee yet.')
  })

  it('TC-DEAL-01 a deal cannot go live before approval', async () => {
    const id = await submitted(lead)
    expect((await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })).statusCode).toBe(409)
    expect(await stateOf(id)).toBe('in_review')
  })

  it('TC-DEAL-01 when content approval is required, launch waits for an approval of that exact version', async () => {
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = true')
    try {
      const id = await approved(lead)
      expect((await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })).json().error).toBe('The content has not been approved.')
      expect(
        (await send('POST', `/api/review/deals/${id}/content-approval`, approver, { self_declared_name: 'Olive Operator', self_declared_frn: '123456' }))
          .statusCode,
      ).toBe(200)
      expect((await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })).json().state).toBe('live')
    } finally {
      await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = false')
    }
  })

  it('TC-DEAL-04 an edit after approval goes back to review and the old content approval does not carry over', async () => {
    await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = true')
    try {
      const id = await approved(lead)
      await send('POST', `/api/review/deals/${id}/content-approval`, approver, { self_declared_name: 'Olive Operator' })
      expect((await editName(id, lead, 'Edited After Approval')).json().state).toBe('in_review')
      expect((await approve(id)).statusCode).toBe(200)
      expect((await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })).json().error).toBe('The content has not been approved.')
    } finally {
      await t.owner.query('UPDATE deal_config SET content_approval_in_sandbox = false')
    }
  })

  it('TC-DEAL-04 an approval left for 30 days returns to draft; one day earlier it stays', async () => {
    const id = await approved(lead)
    const start = clock
    await lapseApprovals(t.app, t.keyring, new Date(start.getTime() + 29 * 86_400_000))
    expect(await stateOf(id)).toBe('approved')
    await lapseApprovals(t.app, t.keyring, new Date(start.getTime() + 30 * 86_400_000))
    expect(await stateOf(id)).toBe('draft')
    expect(await count("SELECT count(*) AS n FROM review_event WHERE deal_id = $1 AND event = 'lapse'", [id])).toBe(1)
  })

  it('TC-OP-07 content can be approved only once it has passed review', async () => {
    const id = await submitted(lead)
    expect((await send('POST', `/api/review/deals/${id}/content-approval`, approver, { self_declared_name: 'X' })).json().error).toBe(
      'Only content that has passed review can be approved.',
    )
  })

  it('TC-OP-07 the approval records the account, stated name and FRN, date and hash, and refuses someone with a stake', async () => {
    const id = await approved(lead)
    expect(
      (await send('POST', `/api/review/deals/${id}/content-approval`, approver, { self_declared_name: 'Olive Operator', self_declared_frn: 'bad' })).statusCode,
    ).toBe(400)
    expect(
      (await send('POST', `/api/review/deals/${id}/content-approval`, approver, { self_declared_name: 'Olive Operator', self_declared_frn: '123456' }))
        .statusCode,
    ).toBe(200)
    const row = (
      await t.owner.query(
        "SELECT p.approver_user, p.self_declared_name, p.self_declared_frn, p.approved_on, p.content_sha256 = v.sha256 AS same FROM promotion_approval p JOIN deal d ON p.subject_id = d.id || ':' || d.approved_version JOIN deal_version v ON v.deal_id = d.id AND v.n = d.approved_version WHERE d.id = $1",
        [id],
      )
    ).rows[0]
    expect(row).toMatchObject({ approver_user: approver.id, self_declared_name: 'Olive Operator', self_declared_frn: '123456', same: true })
    const both = await staff(unique('both'), ['reviewer', 'approver'])
    const own = await submitted(both)
    expect((await approve(own)).statusCode).toBe(200)
    expect((await send('POST', `/api/review/deals/${own}/content-approval`, both, { self_declared_name: 'X' })).statusCode).toBe(409)
    expect((await send('POST', `/api/review/deals/${id}/content-approval`, lead, { self_declared_name: 'X' })).statusCode).toBe(403)
  })
})

describe('deal documents', () => {
  const uploader = async () => person(unique('files'))
  const WORD = zipOf(['[Content_Types].xml', 'word/document.xml'])

  it('TC-DRF-03 an uploaded agreement satisfies the requirement, and removing it brings the requirement back', async () => {
    const who = await uploader()
    const id = await newDeal(who, draftFor(await entityFor(who)))
    const r = await upload(who, id, 'kind=legal&name=agreement.pdf')
    expect(r.statusCode, r.body).toBe(200)
    expect((await send('GET', `/api/deals/${id}`, who)).json().problems).toEqual([])
    expect((await send('DELETE', `/api/deals/${id}/files/${r.json().id}`, who)).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${id}`, who)).json().problems.map((p: { field: string }) => p.field)).toEqual(['legal_files'])
  })

  it('TC-DRF-03 what is downloaded is what was uploaded, as an attachment', async () => {
    const who = await uploader()
    const id = await newDeal(who)
    const file = (await upload(who, id, 'kind=legal&name=a.pdf')).json().id
    const got = await send('GET', `/api/deals/${id}/files/${file}`, who)
    expect(got.statusCode).toBe(200)
    expect(got.rawPayload.equals(PDF)).toBe(true)
    expect(got.headers['content-disposition']).toBe('attachment; filename="document"')
  })

  it.each([
    ['a text file', 'legal', Buffer.from('plain text')],
    ['a plain zip', 'legal', Buffer.from('PK\x03\x04 nothing inside', 'latin1')],
    ['a Word file as a deck', 'deck', WORD],
  ])('TC-DRF-03 %s is refused by its content, whatever its name', async (_what, kind, body) => {
    const who = await uploader()
    const id = await newDeal(who)
    expect((await upload(who, id, `kind=${kind}&name=report.pdf`, body)).statusCode).toBe(415)
  })

  it('TC-DRF-03 a Word agreement is accepted', async () => {
    const who = await uploader()
    const id = await newDeal(who)
    expect((await upload(who, id, 'kind=legal&name=a.docx', WORD)).statusCode).toBe(200)
  })

  it('TC-DRF-03 a deck of exactly 10 MB is accepted; one byte more is refused; a legal file may be larger', async () => {
    const who = await uploader()
    const id = await newDeal(who)
    const big = (n: number) => Buffer.concat([PDF, Buffer.alloc(n - PDF.length, 32)])
    expect((await upload(who, id, 'kind=deck&name=d.pdf', big(10 * 1024 * 1024))).statusCode).toBe(200)
    expect((await upload(who, id, 'kind=deck&name=d.pdf', big(10 * 1024 * 1024 + 1))).statusCode).toBe(413)
    expect((await upload(who, id, 'kind=legal&name=l.pdf', big(10 * 1024 * 1024 + 1))).statusCode).toBe(200)
  })

  it('TC-DRF-03 a new deck replaces the last one', async () => {
    const who = await uploader()
    const id = await newDeal(who)
    await upload(who, id, 'kind=deck&name=one.pdf')
    await upload(who, id, 'kind=deck&name=two.pdf')
    expect((await send('GET', `/api/deals/${id}`, who)).json().files.map((f: { display_name: string }) => f.display_name)).toEqual(['two.pdf'])
  })

  it('TC-DRF-03 a file that fails the virus check is not kept', async () => {
    const who = await uploader()
    const id = await newDeal(who)
    const r = await upload(who, id, 'kind=legal&name=a.pdf', Buffer.concat([PDF, Buffer.from(' EICAR-STANDARD-ANTIVIRUS-TEST-FILE')]))
    expect(r.statusCode).toBe(422)
    expect(await count('SELECT count(*) AS n FROM stored_file WHERE owner_id = $1', [id])).toBe(0)
  })

  it('TC-DRF-03 a folder must belong to the deal, and a file can go in one', async () => {
    const who = await uploader()
    const id = await newDeal(who)
    const other = await newDeal(who)
    const folder = (await send('POST', `/api/deals/${id}/folders`, who, { name: 'Term sheets' })).json().id
    expect((await upload(who, id, `kind=legal&name=a.pdf&folder=${folder}`)).statusCode).toBe(200)
    expect((await upload(who, other, `kind=legal&name=a.pdf&folder=${folder}`)).statusCode).toBe(409)
    expect((await send('POST', `/api/deals/${other}/folders`, who, { name: 'x', parent_id: folder })).statusCode).toBe(409)
    expect((await send('GET', `/api/deals/${id}`, who)).json().files[0].folder_id).toBe(folder)
  })

  it('TC-AUTHZ-03 a stranger cannot upload to, remove from or download from a deal; a reviewer can read, and it is audited', async () => {
    const who = await uploader()
    const stranger = await uploader()
    const id = await newDeal(who)
    const file = (await upload(who, id, 'kind=legal&name=a.pdf')).json().id
    expect((await upload(stranger, id, 'kind=legal&name=a.pdf')).statusCode).toBe(409)
    expect((await send('DELETE', `/api/deals/${id}/files/${file}`, stranger)).statusCode).toBe(409)
    expect((await send('GET', `/api/deals/${id}/files/${file}`, stranger)).statusCode).toBe(404)
    expect((await send('GET', `/api/files/${file}`, who)).statusCode).toBe(404)
    expect((await send('GET', `/api/deals/${id}/files/${file}`, reviewer)).statusCode).toBe(404) // a draft has not been submitted to anyone
    const seen = await submitted(who)
    const sent = (await upload(who, seen, 'kind=legal&name=b.pdf')).json().id
    expect((await send('GET', `/api/deals/${seen}/files/${sent}`, reviewer)).statusCode).toBe(200)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'deal.file_viewed' AND entity_id = $1", [sent])).toBe(1)
    const other = await newDeal(who)
    expect((await send('GET', `/api/deals/${other}/files/${file}`, who)).statusCode).toBe(404)
  })

  it('TC-REV-02 adding a document during review restarts it and shows in the changes; removing the last one is refused', async () => {
    const who = await uploader()
    const id = await newDeal(who, draftFor(await entityFor(who)))
    const file = (await upload(who, id, 'kind=legal&name=agreement.pdf')).json().id
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    expect((await send('DELETE', `/api/deals/${id}/files/${file}`, who)).statusCode).toBe(409)
    expect((await send('GET', `/api/deals/${id}`, who)).json().files).toHaveLength(1)
    expect((await upload(who, id, 'kind=legal&name=side-letter.pdf', await renderPdf([{ text: 'side letter' }], 'Side letter'))).statusCode).toBe(200)
    expect(JSON.stringify((await send('GET', `/api/review/deals/${id}`, reviewer)).json().changes)).toContain('side-letter.pdf')
  })

  it('TC-DEAL-04 a document added after approval takes the deal back to review', async () => {
    const who = await uploader()
    const id = await approved(who)
    expect((await upload(who, id, 'kind=legal&name=late.pdf')).statusCode).toBe(200)
    expect(await stateOf(id)).toBe('in_review')
  })

  it('TC-DRF-03 a deal holds at most 200 files', async () => {
    const who = await uploader()
    const id = await newDeal(who)
    await t.owner.query(
      "INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) SELECT gen_random_uuid(), 'deal_shared', $1, 'legal', 'a.pdf', 'application/pdf', 'x', 1, 'clean', 'k', 'k1', '\\x00', (SELECT lead_user FROM deal WHERE id = $1) FROM generate_series(1, 200)",
      [id],
    )
    expect((await upload(who, id, 'kind=legal&name=a.pdf')).json().error).toBe('A deal can hold at most 200 files.')
  })

  it('TC-DRF-03 a rejected deal takes no more files', async () => {
    const who = await uploader()
    const id = await submitted(who)
    await send('POST', `/api/review/deals/${id}/reject`, reviewer, { reason: 'No.' })
    expect((await upload(who, id, 'kind=legal&name=a.pdf')).statusCode).toBe(409)
  })
})

describe('syndicates', () => {
  const newSyndicate = async (who: Client, name = 'Pilot Group') => {
    const r = await send('POST', '/api/syndicates', who, { name, lead_entity_id: await entityFor(who) })
    expect(r.statusCode, r.body).toBe(200)
    return r.json().id as string
  }
  const invite = async (who: Client, id: string, role = 'deal_member') =>
    (await send('POST', `/api/syndicates/${id}/invites`, who, { role })).json() as { id: string; link: string }
  const tokenIn = (link: string) => new URL(link, 'http://x').searchParams.get('token')!
  const join = (who: Client, link: string) => send('POST', '/api/syndicate-invites/accept', who, { token: tokenIn(link) })
  const founder = async () => person(unique('founder'))
  const memberOf = async (admin: Client, id: string, role = 'deal_member') => {
    const m = await person(unique('joiner'))
    expect((await join(m, (await invite(admin, id, role)).link)).statusCode).toBe(200)
    return m
  }

  it('TC-SYN-02 the list separates what I manage from what I joined', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const m = await memberOf(a, id)
    expect((await send('GET', '/api/syndicates', a)).json().managed.map((s: { id: string }) => s.id)).toEqual([id])
    const theirs = (await send('GET', '/api/syndicates', m)).json()
    expect(theirs.managed).toEqual([])
    expect(theirs.joined.map((s: { id: string }) => s.id)).toEqual([id])
  })

  it('TC-SYN-02 only members see the page; a stranger gets the same answer as for nothing at all', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const stranger = await founder()
    const page = await send('GET', `/api/syndicates/${id}`, a)
    expect(page.json()).toMatchObject({ name: 'Pilot Group', role: 'admin', can_start_deal: true })
    const refused = await send('GET', `/api/syndicates/${id}`, stranger)
    const missing = await send('GET', `/api/syndicates/${randomUUID()}`, stranger)
    expect([refused.statusCode, refused.body]).toEqual([missing.statusCode, missing.body])
    expect((await send('GET', `/api/syndicates/${id}`)).statusCode).toBe(401)
    expect((await send('GET', '/api/syndicates', stranger)).json()).toEqual({ managed: [], joined: [] })
  })

  it("TC-SYN-02 a syndicate needs the founder's own entity, and its thesis must be allowed formatting", async () => {
    const a = await founder()
    const b = await founder()
    expect((await send('POST', '/api/syndicates', a, { name: 'X', lead_entity_id: await entityFor(b) })).statusCode).toBe(409)
    const id = await newSyndicate(a)
    expect((await send('PUT', `/api/syndicates/${id}`, a, { name: 'Y', thesis: { type: 'doc', content: [{ type: 'script' }] } })).statusCode).toBe(409)
    const thesis = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We back climate.' }] }] }
    expect((await send('PUT', `/api/syndicates/${id}`, a, { name: 'Y', thesis })).statusCode).toBe(200)
    expect((await send('GET', `/api/syndicates/${id}`, a)).json().thesis).toEqual(thesis)
  })

  it('TC-AUTHZ-03 an admin sees every deal of the syndicate; a deal member only the one assigned, also in the deal list', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const m = await memberOf(a, id)
    const draft = draftFor(await entityFor(a), {
      basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'Seedling Round', syndicate: { mode: 'existing', id } },
    })
    const make = async () => {
      const deal = await newDeal(a, draft)
      await legalFile(deal)
      expect((await send('POST', `/api/deals/${deal}/submit`, a, {})).statusCode).toBe(200)
      return deal
    }
    const one = await make()
    const two = await make()
    expect((await send('PUT', `/api/deals/${one}/members/${m.id}`, a, { role: 'member' })).statusCode).toBe(200)
    const ids = (r: { json(): { deals: Array<{ id: string }> } }) =>
      r
        .json()
        .deals.map((d) => d.id)
        .sort()
    expect(ids(await send('GET', `/api/syndicates/${id}`, a))).toEqual([one, two].sort())
    expect(ids(await send('GET', `/api/syndicates/${id}`, m))).toEqual([one])
    expect(ids(await send('GET', '/api/deals', m))).toEqual([one])
    expect((await send('GET', `/api/deals/${two}`, m)).statusCode).toBe(404)
    expect((await send('GET', `/api/deals/${one}`, m)).statusCode).toBe(200)
  })

  it('TC-AUTHZ-04 a reviewer who is any member of the syndicate cannot review its deals, assigned or not', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const strict = await staff(unique('insider'), ['reviewer'])
    expect((await join(strict, (await invite(a, id)).link)).statusCode).toBe(200)
    const deal = await newDeal(
      a,
      draftFor(await entityFor(a), { basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'R', syndicate: { mode: 'existing', id } } }),
    )
    await legalFile(deal)
    await send('POST', `/api/deals/${deal}/submit`, a, {})
    expect((await approve(deal, strict)).statusCode).toBe(409)
    expect((await send('GET', `/api/deals/${deal}`, strict)).statusCode).toBe(404)
  })

  it('TC-SYN-03 a link is returned to be read and copied; the token is not stored; a revoked link stops working', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const inv = await invite(a, id)
    expect(inv.link).toMatch(/\/join-syndicate\?token=[\w-]+/)
    const stored = await t.owner.query<{ token_hmac: string }>('SELECT token_hmac FROM member_invite WHERE id = $1', [inv.id])
    expect(stored.rows[0]!.token_hmac).not.toContain(tokenIn(inv.link))
    expect(JSON.stringify((await send('GET', `/api/syndicates/${id}/invites`, a)).json())).not.toContain(tokenIn(inv.link))
    expect((await send('POST', `/api/syndicates/${id}/invites/${inv.id}/revoke`, a, {})).statusCode).toBe(200)
    expect((await join(await founder(), inv.link)).statusCode).toBe(404)
    expect((await send('POST', `/api/syndicates/${id}/invites/${inv.id}/revoke`, a, {})).statusCode).toBe(409)
  })

  it('TC-SYN-03 only an admin makes or revokes links, and a nonsense token does nothing', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const m = await memberOf(a, id)
    expect((await send('POST', `/api/syndicates/${id}/invites`, m, { role: 'admin' })).statusCode).toBe(409)
    expect((await send('GET', `/api/syndicates/${id}/invites`, m)).statusCode).toBe(404)
    expect((await send('POST', '/api/syndicate-invites/accept', m, { token: 'x'.repeat(43) })).statusCode).toBe(404)
  })

  it('TC-SYN-03 a link does not change the role of someone already in', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    await join(a, (await invite(a, id)).link)
    expect((await send('GET', `/api/syndicates/${id}`, a)).json().role).toBe('admin')
  })

  it("TC-SYN-02 members can be promoted and removed, but the last admin stays and a deal's lead cannot be removed", async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const m = await memberOf(a, id)
    expect((await send('DELETE', `/api/syndicates/${id}/members/${a.id}`, a)).statusCode).toBe(409)
    expect((await send('PUT', `/api/syndicates/${id}/members/${a.id}`, a, { role: 'deal_member' })).statusCode).toBe(409)
    expect((await send('PUT', `/api/syndicates/${id}/members/${a.id}`, m, { role: 'deal_member' })).statusCode).toBe(409)
    expect((await send('PUT', `/api/syndicates/${id}/members/${m.id}`, a, { role: 'admin' })).statusCode).toBe(200)
    const deal = await newDeal(
      a,
      draftFor(await entityFor(a), { basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'R', syndicate: { mode: 'existing', id } } }),
    )
    await legalFile(deal)
    await send('POST', `/api/deals/${deal}/submit`, a, {})
    expect((await send('DELETE', `/api/syndicates/${id}/members/${a.id}`, m)).json().error).toBe('This person leads a deal in the syndicate.')
  })

  it('TC-SYN-02 removing a member also takes them off its deals; anyone can leave', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const m = await memberOf(a, id)
    const n2 = await memberOf(a, id)
    const deal = await newDeal(
      a,
      draftFor(await entityFor(a), { basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'R', syndicate: { mode: 'existing', id } } }),
    )
    await send('PUT', `/api/deals/${deal}/members/${m.id}`, a, { role: 'member' })
    expect((await send('GET', `/api/deals/${deal}`, m)).statusCode).toBe(200)
    expect((await send('DELETE', `/api/syndicates/${id}/members/${m.id}`, a)).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${deal}`, m)).statusCode).toBe(404)
    expect((await send('DELETE', `/api/syndicates/${id}/members/${n2.id}`, n2)).statusCode).toBe(200)
    expect((await send('GET', `/api/syndicates/${id}`, n2)).statusCode).toBe(404)
  })

  it('TC-SYN-01 a syndicate with no deals can be archived and then takes no more; one with deals cannot', async () => {
    const a = await founder()
    const empty = await newSyndicate(a)
    const inv = await invite(a, empty)
    expect((await send('POST', `/api/syndicates/${empty}/archive`, a, {})).statusCode).toBe(200)
    expect((await join(await founder(), inv.link)).statusCode).toBe(404)
    expect((await send('POST', `/api/syndicates/${empty}/invites`, a, { role: 'deal_member' })).statusCode).toBe(409)
    const used = await newSyndicate(a, 'Busy')
    const deal = await newDeal(
      a,
      draftFor(await entityFor(a), { basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'R', syndicate: { mode: 'existing', id: used } } }),
    )
    await legalFile(deal)
    await send('POST', `/api/deals/${deal}/submit`, a, {})
    expect((await send('POST', `/api/syndicates/${used}/archive`, a, {})).statusCode).toBe(409)
  })

  it('TC-SYN-04 two leads on one deal: the co-lead can edit, carry splits by share, and the invitation goes at submission', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const co = await memberOf(a, id)
    const base = draftFor(await entityFor(a), { basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'Co', syndicate: { mode: 'existing', id } } })
    const split = [
      { kind: 'person', first_name: 'A', last_name: 'Lead', email: a.email, share_bps: 6000 },
      { kind: 'person', first_name: 'C', last_name: 'Lead', email: co.email, share_bps: 4000 },
    ]
    const deal = await newDeal(a, { ...base, economics: { ...base.economics, recipients: split } })
    await legalFile(deal)
    expect((await send('PUT', `/api/deals/${deal}/members/${co.id}`, a, { role: 'co_lead' })).statusCode).toBe(200)
    expect((await mailTo(co.email)).filter((m) => /co-lead/.test(m.subject))).toEqual([])
    const held = (await send('GET', `/api/deals/${deal}`, co)).json()
    expect(held.can_edit).toBe(true)
    expect(
      (await send('PUT', `/api/deals/${deal}/draft`, co, { ...held.draft, basics: { ...held.draft.basics, name: 'Edited by the co-lead' } })).statusCode,
    ).toBe(200)
    expect((await send('GET', `/api/deals/${deal}`, a)).json().draft.basics.name).toBe('Edited by the co-lead')
    expect((await send('POST', `/api/deals/${deal}/submit`, co, {})).statusCode).toBe(200)
    expect((await mailTo(co.email)).filter((m) => /co-lead/.test(m.subject))).toHaveLength(1)
    const shares = (
      await t.owner.query<{ share_bps: number }>('SELECT share_bps FROM carry_recipient WHERE deal_id = $1 ORDER BY share_bps DESC', [deal])
    ).rows.map((r) => r.share_bps)
    expect(shares).toEqual([6000, 4000])
    expect((await send('GET', '/api/review/deals', reviewer)).json().deals.find((d: { id: string }) => d.id === deal).can_review).toBe(true)
    await send('POST', `/api/deals/${deal}/withdraw`, a, {})
    await send('POST', `/api/deals/${deal}/submit`, a, {})
    expect((await mailTo(co.email)).filter((m) => /co-lead/.test(m.subject))).toHaveLength(1)
  })

  it('TC-SYN-04 only a member of the syndicate can join a deal, and the lead cannot be re-added', async () => {
    const a = await founder()
    const id = await newSyndicate(a)
    const outsider = await founder()
    const deal = await newDeal(
      a,
      draftFor(await entityFor(a), { basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'R', syndicate: { mode: 'existing', id } } }),
    )
    expect((await send('PUT', `/api/deals/${deal}/members/${outsider.id}`, a, { role: 'co_lead' })).statusCode).toBe(409)
    expect((await send('PUT', `/api/deals/${deal}/members/${a.id}`, a, { role: 'co_lead' })).statusCode).toBe(409)
    const noSyndicate = await newDeal(a)
    expect((await send('PUT', `/api/deals/${noSyndicate}/members/${outsider.id}`, a, { role: 'member' })).statusCode).toBe(409)
  })
})

describe('investee check', () => {
  const contactOf = (n2: string, reg?: string) => (entity: string) => {
    const base = draftFor(entity)
    return { ...base, company: { ...base.company, contact_email: n2, ...(reg ? { registration_number: reg } : {}) } }
  }
  const started = async (over: (e: string) => object = contactOf(unique('company')), who?: Client) => {
    const lead2 = who ?? (await person(unique('investeelead')))
    const draft = over(await entityFor(lead2)) as { company: { contact_email: string } }
    const id = await newDeal(lead2, draft)
    await legalFile(id)
    expect((await send('POST', `/api/deals/${id}/submit`, lead2, {})).statusCode).toBe(200)
    return { id, lead2, contact: draft.company.contact_email }
  }
  const linkFor = async (contact: string) => {
    const m = (await mailTo(contact)).at(-1)!
    return /\/investee\?token=([\w-]+)/.exec(m.body)![1]!
  }
  const view = (token: string) => send('POST', '/api/investee/view', undefined, { token })
  const give = (token: string, requirement: string, body: Buffer = PDF) =>
    app.inject({
      method: 'POST',
      url: `/api/investee/files?requirement=${requirement}&name=doc.pdf`,
      remoteAddress: nextIp(),
      headers: { 'x-investee-token': token, 'content-type': 'application/octet-stream' },
      payload: body,
    })
  const finish = (token: string, needs: boolean | null = false) => send('POST', '/api/investee/submit', undefined, { token, needs_notarised_signature: needs })
  const DOCS = ['incorporation_certificate', 'bank_statement', 'address_proof']
  const giveAll = async (token: string) => {
    for (const r of DOCS) expect((await give(token, r)).statusCode).toBe(200)
  }
  const sent = async (over?: (e: string) => object) => {
    const s = await started(over)
    const token = await linkFor(s.contact)
    await giveAll(token)
    expect((await finish(token)).statusCode).toBe(200)
    return { ...s, token }
  }

  it('TC-INV-01 the contact needs no account: the link alone shows what is asked for', async () => {
    const s = await started()
    const r = await view(await linkFor(s.contact))
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ company: 'Seedling Ltd', status: 'waiting', required: DOCS, uploaded: [] })
  })

  it('TC-INV-01 a wrong token and an expired one get the same refusal, and expiry is at the moment set', async () => {
    const s = await started()
    const token = await linkFor(s.contact)
    const wrong = await view('x'.repeat(43))
    expect(wrong.statusCode).toBe(404)
    const saved = clock
    clock = new Date(clock.getTime() + 14 * 86_400_000 - 1)
    expect((await view(token)).statusCode).toBe(200)
    clock = new Date(saved.getTime() + 14 * 86_400_000)
    const expired = await view(token)
    expect([expired.statusCode, expired.body]).toEqual([wrong.statusCode, wrong.body])
    clock = saved
  })

  it('TC-INV-01 sending again makes a new link and the old one stops; reminders are limited; the lead sees progress only', async () => {
    const s = await started()
    const first = await linkFor(s.contact)
    await giveAll(first)
    expect((await send('POST', `/api/deals/${s.id}/investee/remind`, s.lead2, {})).statusCode).toBe(200)
    expect((await view(first)).statusCode).toBe(404)
    const second = await linkFor(s.contact)
    expect(second).not.toBe(first)
    expect((await view(second)).statusCode).toBe(200)
    expect((await send('POST', `/api/deals/${s.id}/investee/remind`, s.lead2, {})).json().error).toBe('A reminder was sent recently. Try again later.')
    const saved = clock
    clock = new Date(clock.getTime() + 24 * 3_600_000)
    expect((await send('POST', `/api/deals/${s.id}/investee/remind`, s.lead2, {})).statusCode).toBe(200)
    clock = saved
    const page = await send('GET', `/api/deals/${s.id}`, s.lead2)
    expect(page.json().investee).toMatchObject({ status: 'waiting', documents_received: 3 })
    expect(page.body).not.toContain('doc.pdf')
  })

  it('TC-INV-01 a stranger cannot chase the company or add contacts', async () => {
    const s = await started()
    const other = await person(unique('stranger'))
    expect((await send('POST', `/api/deals/${s.id}/investee/remind`, other, {})).json().error).toBe('Deal not found.')
    expect((await send('POST', `/api/deals/${s.id}/investee/contacts`, other, { name: 'A', email: 'a@example.test' })).json().error).toBe('Deal not found.')
    expect((await send('POST', `/api/deals/${s.id}/investee/contacts`, s.lead2, { name: 'A', email: 'a@example.test' })).statusCode).toBe(200)
  })

  it('TC-INV-03 chasing waits the configured hours to the second; extra contacts are recorded up to the limit, in order', async () => {
    const s = await started()
    const saved = clock
    expect((await send('POST', `/api/deals/${s.id}/investee/remind`, s.lead2, {})).statusCode).toBe(200)
    clock = new Date(saved.getTime() + 24 * 3_600_000 - 1000)
    expect((await send('POST', `/api/deals/${s.id}/investee/remind`, s.lead2, {})).json().error).toBe('A reminder was sent recently. Try again later.')
    clock = new Date(saved.getTime() + 24 * 3_600_000)
    expect((await send('POST', `/api/deals/${s.id}/investee/remind`, s.lead2, {})).statusCode).toBe(200)
    clock = saved
    for (let i = 0; i < 5; i++)
      expect((await send('POST', `/api/deals/${s.id}/investee/contacts`, s.lead2, { name: `Extra ${i}`, email: `extra${i}@example.test` })).statusCode).toBe(200)
    expect((await send('POST', `/api/deals/${s.id}/investee/contacts`, s.lead2, { name: 'One more', email: 'more@example.test' })).json().error).toBe(
      'There can be at most 5 extra contacts.',
    )
    const kept = (
      await t.owner.query<{ fields: { contact_email: string } }>(
        'SELECT v.fields FROM investee i CROSS JOIN LATERAL unnest(i.extra_contact_versions) WITH ORDINALITY AS x(v, k) JOIN person_version v ON v.id = x.v WHERE i.deal_id = $1 ORDER BY x.k',
        [s.id],
      )
    ).rows.map((r) => r.fields.contact_email)
    expect(kept).toEqual([0, 1, 2, 3, 4].map((i) => `extra${i}@example.test`))
  })

  it('TC-INV-02 documents are collected: nothing can be sent until all are in and the signature question is answered', async () => {
    const s = await started()
    const token = await linkFor(s.contact)
    await give(token, DOCS[0]!)
    expect((await finish(token)).json().error).toBe('Still missing: bank_statement, address_proof.')
    await give(token, DOCS[1]!)
    await give(token, DOCS[2]!)
    expect((await finish(token, null)).json().error).toBe('Still missing: needs_notarised_signature.')
    expect((await finish(token, true)).json().status).toBe('submitted')
    expect((await view(token)).json().status).toBe('submitted')
    expect((await give(token, DOCS[0]!)).statusCode).toBe(409)
  })

  it('TC-INV-01 a decision on the company names what was read: a check that has since become another company is refused', async () => {
    const s = await sent()
    const old = (await send('GET', `/api/review/deals/${s.id}`, reviewer)).json().investee.check_sha256
    const draft = (await send('GET', `/api/deals/${s.id}`, s.lead2)).json().draft
    expect(
      (await send('PUT', `/api/deals/${s.id}/draft`, s.lead2, { ...draft, company: { ...draft.company, legal_name: 'Other Company Ltd' } })).statusCode,
    ).toBe(200)
    const token = await linkFor(s.contact)
    await giveAll(token)
    expect((await finish(token)).statusCode).toBe(200)
    const url = `/api/review/deals/${s.id}/investee`
    expect((await inject('POST', `${url}/approve`, reviewer, {})).statusCode).toBe(400)
    const pass = await inject('POST', `${url}/approve`, reviewer, { reviewed_sha256: old })
    expect(pass.statusCode).toBe(409)
    expect(pass.json().error).toContain('changed since you opened it')
    expect((await inject('POST', `${url}/return`, reviewer, { reason: 'x', reviewed_sha256: old })).statusCode).toBe(409)
    const current = (await send('GET', `/api/review/deals/${s.id}`, reviewer)).json().investee.check_sha256
    expect(current).not.toBe(old)
    expect((await inject('POST', `${url}/approve`, reviewer, { reviewed_sha256: current })).json().status).toBe('approved')
  })

  it('TC-INV-01 the page says which company the link was issued for, whatever the working copy says by now', async () => {
    const s = await started()
    const token = await linkFor(s.contact)
    expect((await send('POST', `/api/deals/${s.id}/withdraw`, s.lead2, {})).statusCode).toBe(200)
    const draft = (await send('GET', `/api/deals/${s.id}`, s.lead2)).json().draft
    expect(
      (await send('PUT', `/api/deals/${s.id}/draft`, s.lead2, { ...draft, company: { ...draft.company, legal_name: 'Someone Else Ltd' } })).statusCode,
    ).toBe(200)
    expect((await view(token)).json().company).toBe('Seedling Ltd')
  })

  it('TC-INV-01 a name changed only in its capitals is the same check, and the page keeps the name it was issued for', async () => {
    const s = await started()
    const token = await linkFor(s.contact)
    const draft = (await send('GET', `/api/deals/${s.id}`, s.lead2)).json().draft
    expect((await send('PUT', `/api/deals/${s.id}/draft`, s.lead2, { ...draft, company: { ...draft.company, legal_name: 'SEEDLING LTD' } })).statusCode).toBe(
      200,
    )
    expect((await view(token)).json().company).toBe('Seedling Ltd')
  })

  it('TC-INV-01 a link cannot be used to fill the disk by adding and removing files', async () => {
    const s = await started()
    const token = await linkFor(s.contact)
    const file = (await give(token, 'bank_statement')).json().id as string
    await t.owner.query(
      'INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, removed_at) SELECT gen_random_uuid(), scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key || g, key_id, wrapped_key, now() FROM stored_file, generate_series(1, 59) g WHERE id = $1',
      [file],
    )
    const r = await give(token, 'bank_statement')
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('There are too many files.')
  })

  it('TC-INV-01 SEIS or EIS adds the advance assurance letter', async () => {
    const s = await started((e) => {
      const b = contactOf(unique('company'))(e) as ReturnType<typeof draftFor>
      return { ...b, terms: { ...b.terms, seis: true } }
    })
    expect((await view(await linkFor(s.contact))).json().required).toContain('seis_eis_advance_assurance')
  })

  it('TC-INV-01 only allowed types and listed documents are taken, and a bad token is refused before anything is read', async () => {
    const s = await started()
    const token = await linkFor(s.contact)
    expect((await give(token, DOCS[0]!, Buffer.from('plain'))).statusCode).toBe(415)
    expect((await give(token, 'something_else')).statusCode).toBe(400)
    expect((await give(token, DOCS[0]!, Buffer.concat([PDF, Buffer.from(' EICAR-STANDARD-ANTIVIRUS-TEST-FILE')]))).statusCode).toBe(422)
    expect((await give('x'.repeat(43), DOCS[0]!)).statusCode).toBe(404)
    expect(
      await count(
        "SELECT count(*) AS n FROM stored_file WHERE scope = 'investee_verification' AND display_name = 'doc.pdf' AND owner_id = (SELECT id FROM investee WHERE deal_id = $1)",
        [s.id],
      ),
    ).toBe(0)
  })

  it('TC-INV-01 a rejected deal closes the link', async () => {
    const s = await started()
    const token = await linkFor(s.contact)
    await send('POST', `/api/review/deals/${s.id}/reject`, reviewer, { reason: 'No.' })
    expect((await view(token)).statusCode).toBe(404)
  })

  it('TC-INV-02 a reviewer sees and can open the documents, and approves; the lead cannot open them', async () => {
    const s = await sent()
    const page = (await send('GET', `/api/review/deals/${s.id}`, reviewer)).json()
    expect(page.investee.documents).toHaveLength(3)
    const file = page.investee.documents[0].id
    const got = await send('GET', `/api/review/deals/${s.id}/investee/files/${file}`, reviewer)
    expect(got.rawPayload.equals(PDF)).toBe(true)
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'investee.file_viewed' AND entity_id = $1", [file])).toBe(1)
    expect((await send('GET', `/api/review/deals/${s.id}/investee/files/${file}`, s.lead2)).statusCode).toBe(403)
    expect((await send('GET', `/api/deals/${s.id}/files/${file}`, s.lead2)).statusCode).toBe(404)
    expect((await send('POST', `/api/review/deals/${s.id}/investee/approve`, reviewer, {})).json().status).toBe('approved')
    expect((await send('GET', `/api/deals/${s.id}`, s.lead2)).json().investee.status).toBe('approved')
    expect((await send('POST', `/api/review/deals/${s.id}/investee/approve`, reviewer, {})).statusCode).toBe(409)
  })

  it('TC-INV-02 a document can only be opened through its own deal', async () => {
    const s = await sent()
    const other = await started()
    const file = (await send('GET', `/api/review/deals/${s.id}`, reviewer)).json().investee.documents[0].id
    expect((await send('GET', `/api/review/deals/${other.id}/investee/files/${file}`, reviewer)).statusCode).toBe(404)
  })

  it('TC-INV-02 returning asks again with a new link and the reason; the company can then send again', async () => {
    const s = await sent()
    expect((await send('POST', `/api/review/deals/${s.id}/investee/return`, reviewer, { reason: '  ' })).statusCode).toBe(400)
    expect((await send('POST', `/api/review/deals/${s.id}/investee/return`, reviewer, { reason: 'The statement is too old.' })).json().status).toBe('returned')
    expect((await mailTo(s.contact)).at(-1)!.body).toContain('The statement is too old.')
    expect((await view(s.token)).statusCode).toBe(404)
    const next = await linkFor(s.contact)
    expect((await view(next)).json()).toMatchObject({ status: 'returned', return_reason: 'The statement is too old.' })
    expect((await give(next, DOCS[1]!)).statusCode).toBe(200)
    expect((await finish(next)).json().status).toBe('submitted')
  })

  it('TC-INV-02 a reviewer with a stake cannot decide, and nothing can be decided before the company has sent', async () => {
    const strict = await staff(unique('stake'), ['reviewer'])
    const own = await started(contactOf(unique('company')), strict)
    expect((await send('POST', `/api/review/deals/${own.id}/investee/approve`, reviewer, {})).statusCode).toBe(409)
    const token = await linkFor(own.contact)
    await giveAll(token)
    await finish(token)
    expect((await send('POST', `/api/review/deals/${own.id}/investee/approve`, strict, {})).statusCode).toBe(409)
  })

  it('TC-INV-02 a deal can go live while the company check has not passed', async () => {
    const s = await started()
    expect((await approve(s.id)).statusCode).toBe(200)
    expect((await send('POST', `/api/deals/${s.id}/launch`, s.lead2, { confirm: true })).json().state).toBe('live')
    expect((await send('GET', `/api/deals/${s.id}`, s.lead2)).json().investee.status).toBe('waiting')
  })

  it('TC-INV-02 a company already checked is recognised by its registration number and not asked again, until the check runs out', async () => {
    const reg = `REG${++n}`
    const first = await sent(contactOf(unique('company'), reg))
    await send('POST', `/api/review/deals/${first.id}/investee/approve`, reviewer, {})
    const again = await started(contactOf(unique('company'), reg))
    expect((await send('GET', `/api/deals/${again.id}`, again.lead2)).json().investee.status).toBe('approved')
    expect(await mailTo(again.contact)).toEqual([])
    const saved = clock
    clock = new Date(clock.getTime() + 366 * 86_400_000)
    const later = await started(contactOf(unique('company'), reg))
    expect((await send('GET', `/api/deals/${later.id}`, later.lead2)).json().investee.status).toBe('waiting')
    clock = saved
  })

  it('TC-INV-02 with no registration number a company is never assumed to be the same one', async () => {
    const first = await sent()
    await send('POST', `/api/review/deals/${first.id}/investee/approve`, reviewer, {})
    const again = await started()
    expect((await send('GET', `/api/deals/${again.id}`, again.lead2)).json().investee.status).toBe('waiting')
  })

  const changeCompany = async (id: string, who: Client, company: object) => {
    const draft = (await send('GET', `/api/deals/${id}`, who)).json().draft
    return send('PUT', `/api/deals/${id}/draft`, who, { ...draft, company: { ...draft.company, ...company } })
  }

  it('TC-INV-01 naming a different company starts again: the old link, approval and documents no longer count', async () => {
    const s = await sent(contactOf(unique('company'), `AAA${++n}`))
    await send('POST', `/api/review/deals/${s.id}/investee/approve`, reviewer, {})
    expect((await changeCompany(s.id, s.lead2, { legal_name: 'Totally Different Ltd', registration_number: `ZZZ${++n}` })).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${s.id}`, s.lead2)).json().investee).toMatchObject({ status: 'waiting', documents_received: 0 })
    expect((await view(s.token)).statusCode).toBe(404)
    expect((await view(await linkFor(s.contact))).json()).toMatchObject({ company: 'Totally Different Ltd', status: 'waiting', uploaded: [] })
  })

  it.each([
    ['the legal name', undefined, { legal_name: 'Another Name Ltd' }],
    ['the registration number', 'OLD', { registration_number: 'NEW' }],
    ['the jurisdiction', undefined, { jurisdiction: 'Scotland' }],
  ])('TC-INV-01 changing only %s starts the check again', async (_what, reg, change) => {
    const s = await sent(contactOf(unique('company'), reg ? `${reg}${++n}` : undefined))
    await send('POST', `/api/review/deals/${s.id}/investee/approve`, reviewer, {})
    const company = 'registration_number' in change ? { registration_number: `NEW${++n}` } : change
    expect((await changeCompany(s.id, s.lead2, company)).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${s.id}`, s.lead2)).json().investee.status).toBe('waiting')
  })

  it('TC-INV-01 correcting the contact stops the old link and tells the new person', async () => {
    const s = await started()
    const old = await linkFor(s.contact)
    const corrected = unique('corrected')
    expect((await changeCompany(s.id, s.lead2, { contact_email: corrected })).statusCode).toBe(200)
    expect((await view(old)).statusCode).toBe(404)
    expect((await give(old, DOCS[0]!)).statusCode).toBe(404)
    expect((await view(await linkFor(corrected))).statusCode).toBe(200)
  })

  it('TC-INV-01 once the company has sent, a new contact gets no link, and the old link stops', async () => {
    const s = await sent()
    const corrected = unique('corrected')
    await changeCompany(s.id, s.lead2, { contact_email: corrected })
    expect(await mailTo(corrected)).toEqual([])
    expect((await view(s.token)).statusCode).toBe(404)
    expect((await send('GET', `/api/deals/${s.id}`, s.lead2)).json().investee.status).toBe('submitted')
  })

  it('TC-INV-02 a check without the advance assurance letter is not reused for a deal that needs one', async () => {
    const reg = `REG${++n}`
    const first = await sent(contactOf(unique('company'), reg))
    await send('POST', `/api/review/deals/${first.id}/investee/approve`, reviewer, {})
    const later = await started((e) => {
      const b = contactOf(unique('company'), reg)(e) as ReturnType<typeof draftFor>
      return { ...b, terms: { ...b.terms, seis: true } }
    })
    expect((await send('GET', `/api/deals/${later.id}`, later.lead2)).json().investee.status).toBe('waiting')
    expect((await view(await linkFor(later.contact))).json().required).toContain('seis_eis_advance_assurance')
  })

  it('TC-INV-02 ticking SEIS after the check passed asks for the letter', async () => {
    const s = await sent()
    await send('POST', `/api/review/deals/${s.id}/investee/approve`, reviewer, {})
    const draft = (await send('GET', `/api/deals/${s.id}`, s.lead2)).json().draft
    expect((await send('PUT', `/api/deals/${s.id}/draft`, s.lead2, { ...draft, terms: { ...draft.terms, seis: true } })).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${s.id}`, s.lead2)).json().investee.status).toBe('waiting')
    expect((await view(await linkFor(s.contact))).json().required).toContain('seis_eis_advance_assurance')
  })

  it('TC-INV-02 a company checked in the sandbox is asked again once the instance is real', async () => {
    const reg = `REG${++n}`
    const first = await sent(contactOf(unique('company'), reg))
    await send('POST', `/api/review/deals/${first.id}/investee/approve`, reviewer, {})
    await t.owner.query('UPDATE instance_profile SET real_since = $1::timestamptz', [new Date(clock.getTime() + 3_600_000).toISOString()])
    try {
      const later = await started(contactOf(unique('company'), reg))
      expect((await send('GET', `/api/deals/${later.id}`, later.lead2)).json().investee.status).toBe('waiting')
    } finally {
      await t.owner.query('UPDATE instance_profile SET real_since = NULL')
    }
  })

  it('TC-INV-02 a reviewer with a stake cannot open the company documents, and nothing is decided on a rejected deal', async () => {
    const strict = await staff(unique('stakeholder'), ['reviewer'])
    const own = await started(contactOf(unique('company')), strict)
    const token = await linkFor(own.contact)
    await giveAll(token)
    await finish(token)
    const file = (await send('GET', `/api/review/deals/${own.id}`, reviewer)).json().investee.documents[0].id
    expect((await send('GET', `/api/review/deals/${own.id}`, strict)).statusCode).toBe(404)
    expect((await send('GET', `/api/review/deals/${own.id}/investee/files/${file}`, strict)).statusCode).toBe(404)
    const s = await sent()
    await send('POST', `/api/review/deals/${s.id}/reject`, reviewer, { reason: 'No.' })
    expect((await send('POST', `/api/review/deals/${s.id}/investee/approve`, reviewer, {})).json().error).toBe('This deal has ended.')
    const open = await started()
    await send('POST', `/api/review/deals/${open.id}/reject`, reviewer, { reason: 'No.' })
    expect((await send('POST', `/api/deals/${open.id}/investee/remind`, open.lead2, {})).json().error).toBe('This deal has ended.')
  })

  it('TC-INV-01 a bad link is refused before the body is read, and a company can take back a file', async () => {
    expect((await give('x'.repeat(43), DOCS[0]!, Buffer.alloc(15 * 1024 * 1024 + 1, 32))).statusCode).toBe(404)
    const s = await started()
    const token = await linkFor(s.contact)
    await give(token, DOCS[0]!)
    const uploaded = (await view(token)).json().uploaded
    expect((await send('POST', '/api/investee/files/remove', undefined, { token, file_id: uploaded[0].id })).statusCode).toBe(200)
    expect((await view(token)).json().uploaded).toEqual([])
    expect((await send('POST', '/api/investee/files/remove', undefined, { token, file_id: uploaded[0].id })).statusCode).toBe(409)
    expect((await send('POST', '/api/investee/files/remove', undefined, { token: 'x'.repeat(43), file_id: uploaded[0].id })).statusCode).toBe(404)
  })
})

describe('requests that overlap', () => {
  /** Holds a lock while `change` happens, lets `request` start and reach the lock, and only then commits. Always lets go. */
  const whileHeld = async <T>(
    lockSql: string,
    args: unknown[],
    change: (c: { query: (s: string, a?: unknown[]) => Promise<unknown> }) => Promise<unknown>,
    request: () => Promise<T>,
  ) => {
    const c = await t.owner.connect()
    let waiting: Promise<T> | undefined
    try {
      await c.query('BEGIN')
      await c.query(lockSql, args)
      await change(c)
      waiting = request()
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      await c.query('COMMIT')
      c.release()
    }
    return waiting!
  }
  const syndicateFor = async (who: Client) =>
    (await send('POST', '/api/syndicates', who, { name: `S ${unique('s')}`, lead_entity_id: await entityFor(who) })).json().id as string

  it('TC-SYN-03 a link revoked while someone is joining with it does not let them in', async () => {
    const a = await person(unique('revoker'))
    const id = await syndicateFor(a)
    const link = (await send('POST', `/api/syndicates/${id}/invites`, a, { role: 'deal_member' })).json().link as string
    const token = new URL(link, 'http://x').searchParams.get('token')!
    const joiner = await person(unique('joiner'))
    const r = await whileHeld(
      'SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE',
      [id],
      (c) => c.query('UPDATE member_invite SET revoked_at = now() WHERE syndicate_id = $1', [id]),
      () => send('POST', '/api/syndicate-invites/accept', joiner, { token }),
    )
    expect(r.statusCode).toBe(404)
    expect(await count('SELECT count(*) AS n FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [id, joiner.id])).toBe(0)
  })

  it('TC-INV-01 a company link revoked while it is being used stops at once', async () => {
    const who = await person(unique('revokedlink'))
    const contact = unique('revokedcompany')
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: contact } })
    await legalFile(id)
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    const token = /\/investee\?token=([\w-]+)/.exec((await mailTo(contact)).at(-1)!.body)![1]!
    const r = await whileHeld(
      'SELECT 1 FROM investee WHERE deal_id = $1 FOR UPDATE',
      [id],
      (c) => c.query('UPDATE investee_link SET revoked_at = now() WHERE investee_id = (SELECT id FROM investee WHERE deal_id = $1)', [id]),
      () => send('POST', '/api/investee/submit', undefined, { token, needs_notarised_signature: false }),
    )
    expect(r.statusCode).toBe(404)
  })

  it('TC-AUTHZ-04 a reviewer whose session ends while the decision waits decides nothing', async () => {
    const r2 = await staff(unique('endedreviewer'), ['reviewer'])
    const id = await submitted(await person(unique('endedlead')))
    const r = await whileHeld(
      'SELECT 1 FROM deal WHERE id = $1 FOR UPDATE',
      [id],
      (c) => c.query('DELETE FROM app_session WHERE user_id = $1', [r2.id]),
      () => send('POST', `/api/review/deals/${id}/reject`, r2, { reason: 'No' }),
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('Your session has ended.')
    expect(await stateOf(id)).toBe('in_review')
  })

  it('TC-OP-07 an approver whose session ends while the approval waits records nothing', async () => {
    const a2 = await staff(unique('endedapprover'), ['approver'])
    const id = await approved(await person(unique('endedapprovallead')))
    const r = await whileHeld(
      'SELECT 1 FROM deal WHERE id = $1 FOR UPDATE',
      [id],
      (c) => c.query('DELETE FROM app_session WHERE user_id = $1', [a2.id]),
      () => inject('POST', `/api/review/deals/${id}/content-approval`, a2, { content_sha256: NO_HASH, self_declared_name: 'A' }),
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('Your session has ended.')
  })

  it('TC-INV-01 a reviewer whose session ends while a company decision waits decides nothing', async () => {
    const r2 = await staff(unique('endedcompany'), ['reviewer'])
    const id = await submitted(await person(unique('endedcompanylead')))
    const r = await whileHeld(
      'SELECT 1 FROM deal WHERE id = $1 FOR UPDATE',
      [id],
      (c) => c.query('DELETE FROM app_session WHERE user_id = $1', [r2.id]),
      () => inject('POST', `/api/review/deals/${id}/investee/approve`, r2, { reviewed_sha256: NO_HASH }),
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('Your session has ended.')
  })

  it('TC-SYN-03 a session that ends while an admin request waits does nothing', async () => {
    const a = await person(unique('endedadmin'))
    const id = await syndicateFor(a)
    const r = await whileHeld(
      'SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE',
      [id],
      (c) => c.query('DELETE FROM app_session WHERE user_id = $1', [a.id]),
      () => send('POST', `/api/syndicates/${id}/invites`, a, { role: 'deal_member' }),
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('Your session has ended.')
    expect(await count('SELECT count(*) AS n FROM member_invite WHERE syndicate_id = $1', [id])).toBe(0)
  })

  it('TC-SYN-03 a session that ends while joining or leaving does nothing', async () => {
    const a = await person(unique('endedjoinadmin'))
    const id = await syndicateFor(a)
    const link = (await send('POST', `/api/syndicates/${id}/invites`, a, { role: 'deal_member' })).json().link as string
    const token = new URL(link, 'http://x').searchParams.get('token')!
    const joiner = await person(unique('endedjoiner'))
    const lock = 'SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE'
    const end = (who: Client) => (c: { query: (s: string, a?: unknown[]) => Promise<unknown> }) =>
      c.query('DELETE FROM app_session WHERE user_id = $1', [who.id])
    const r = await whileHeld(lock, [id], end(joiner), () => send('POST', '/api/syndicate-invites/accept', joiner, { token }))
    expect(r.json().error).toBe('Your session has ended.')
    expect(await count('SELECT count(*) AS n FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [id, joiner.id])).toBe(0)
    const leaver = await person(unique('endedleaver'))
    expect((await send('POST', '/api/syndicate-invites/accept', leaver, { token })).statusCode).toBe(200)
    const l = await whileHeld(lock, [id], end(leaver), () => send('DELETE', `/api/syndicates/${id}/members/${leaver.id}`, leaver))
    expect(l.json().error).toBe('Your session has ended.')
    expect(await count('SELECT count(*) AS n FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [id, leaver.id])).toBe(1)
  })

  it('TC-SYN-01 a resubmission into another syndicate waits for that syndicate, not only the old one', async () => {
    const a = await person(unique('moving'))
    const first = await submitted(a)
    expect((await send('POST', `/api/deals/${first}/withdraw`, a, {})).statusCode).toBe(200)
    const target = await syndicateFor(a)
    const draft = (await send('GET', `/api/deals/${first}`, a)).json().draft
    expect(
      (await send('PUT', `/api/deals/${first}/draft`, a, { ...draft, basics: { ...draft.basics, syndicate: { mode: 'existing', id: target } } })).statusCode,
    ).toBe(200)
    const r = await whileHeld(
      'SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE',
      [target],
      (c) => c.query('DELETE FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [target, a.id]),
      () => send('POST', `/api/deals/${first}/submit`, a, {}),
    )
    expect(r.statusCode).toBe(409)
    expect(await stateOf(first)).toBe('draft')
  })

  it('TC-AUTHZ-03 someone removed from the destination syndicate while a draft moves there comes off the deal', async () => {
    const a = await person(unique('movedrace'))
    const one = await syndicateFor(a)
    const two = await syndicateFor(a)
    const base = draftFor(await entityFor(a))
    const inSyndicate = (id: string) => ({ ...base, basics: { ...base.basics, syndicate: { mode: 'existing', id } } })
    const deal = await newDeal(a, inSyndicate(one))
    const u = await person(unique('inboth'))
    for (const id of [one, two]) {
      const link = (await send('POST', `/api/syndicates/${id}/invites`, a, { role: 'deal_member' })).json().link as string
      await send('POST', '/api/syndicate-invites/accept', u, { token: new URL(link, 'http://x').searchParams.get('token')! })
    }
    expect((await send('PUT', `/api/deals/${deal}/members/${u.id}`, a, { role: 'member' })).statusCode).toBe(200)
    const r = await whileHeld(
      'SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE',
      [two],
      (c) => c.query('DELETE FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [two, u.id]),
      () => send('PUT', `/api/deals/${deal}/draft`, a, inSyndicate(two)),
    )
    expect(r.statusCode).toBe(200)
    expect(await count('SELECT count(*) AS n FROM deal_member WHERE deal_id = $1 AND user_id = $2', [deal, u.id])).toBe(0)
  })

  it('TC-CMP-03 an upload that spans the switch to the real mode is refused', async () => {
    const who = await person(unique('spanning'))
    const id = await newDeal(who, draftFor(await entityFor(who)))
    try {
      const r = await whileHeld(
        'SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE',
        [],
        (c) => c.query("UPDATE instance_profile SET real_since = now() + interval '1 hour'"),
        () => upload(who, id, 'kind=legal&name=a.pdf'),
      )
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toContain('The instance changed')
      expect(await count("SELECT count(*) AS n FROM stored_file WHERE owner_id = $1 AND scope = 'deal_shared'", [id])).toBe(0)
    } finally {
      await t.owner.query('UPDATE instance_profile SET real_since = NULL')
    }
  })

  it('TC-CMP-03 a company upload that spans the switch to the real mode is refused', async () => {
    const who = await person(unique('spanningco'))
    const contact = unique('spanningcontact')
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: contact } })
    await legalFile(id)
    await send('POST', `/api/deals/${id}/submit`, who, {})
    const token = /\/investee\?token=([\w-]+)/.exec((await mailTo(contact)).at(-1)!.body)![1]!
    try {
      const r = await whileHeld(
        'SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE',
        [],
        (c) => c.query("UPDATE instance_profile SET real_since = now() + interval '1 hour'"),
        () =>
          app.inject({
            method: 'POST',
            url: '/api/investee/files?requirement=bank_statement&name=d.pdf',
            remoteAddress: nextIp(),
            headers: { 'x-investee-token': token, 'content-type': 'application/octet-stream' },
            payload: PDF,
          }),
      )
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toContain('The instance changed')
    } finally {
      await t.owner.query('UPDATE instance_profile SET real_since = NULL')
    }
  })

  it('TC-AUTHZ-03 an admin removed while going live cannot finish', async () => {
    const a = await person(unique('launchlead'))
    const id = await approved(a)
    const { syndicate_id } = (await t.owner.query<{ syndicate_id: string }>('SELECT syndicate_id FROM deal WHERE id = $1', [id])).rows[0]!
    const other = await person(unique('launchadmin'))
    const link = (await send('POST', `/api/syndicates/${syndicate_id}/invites`, a, { role: 'admin' })).json().link as string
    await send('POST', '/api/syndicate-invites/accept', other, { token: new URL(link, 'http://x').searchParams.get('token')! })
    const r = await whileHeld(
      'SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE',
      [syndicate_id],
      (c) => c.query('DELETE FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [syndicate_id, other.id]),
      () => send('POST', `/api/deals/${id}/launch`, other, { confirm: true }),
    )
    expect(r.statusCode).toBe(409)
    expect(await stateOf(id)).toBe('approved')
  })

  it('TC-AUTHZ-04 joining a syndicate while a company decision waits counts as a stake', async () => {
    const r2 = await staff(unique('joinedreviewer'), ['reviewer'])
    const who = await person(unique('joinedlead'))
    const contact = unique('joinedcompany')
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: contact } })
    await legalFile(id)
    await send('POST', `/api/deals/${id}/submit`, who, {})
    const token = /\/investee\?token=([\w-]+)/.exec((await mailTo(contact)).at(-1)!.body)![1]!
    for (const requirement of ['incorporation_certificate', 'bank_statement', 'address_proof'])
      await app.inject({
        method: 'POST',
        url: `/api/investee/files?requirement=${requirement}&name=d.pdf`,
        remoteAddress: nextIp(),
        headers: { 'x-investee-token': token, 'content-type': 'application/octet-stream' },
        payload: PDF,
      })
    await send('POST', '/api/investee/submit', undefined, { token, needs_notarised_signature: false })
    const hash = (await send('GET', `/api/review/deals/${id}`, r2)).json().investee.check_sha256
    const { syndicate_id } = (await t.owner.query<{ syndicate_id: string }>('SELECT syndicate_id FROM deal WHERE id = $1', [id])).rows[0]!
    const r = await whileHeld(
      'SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE',
      [syndicate_id],
      (c) => c.query("INSERT INTO syndicate_member (syndicate_id, user_id, role) VALUES ($1, $2, 'deal_member')", [syndicate_id, r2.id]),
      () => inject('POST', `/api/review/deals/${id}/investee/approve`, r2, { reviewed_sha256: hash }),
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('cannot review')
  })

  it('TC-SYN-01 someone removed from a syndicate while submitting into it cannot finish', async () => {
    const a = await person(unique('removedsub'))
    const id = await syndicateFor(a)
    const base = draftFor(await entityFor(a))
    const deal = await newDeal(a, { ...base, basics: { ...base.basics, syndicate: { mode: 'existing', id } } })
    await legalFile(deal)
    const r = await whileHeld(
      'SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE',
      [id],
      (c) => c.query('DELETE FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [id, a.id]),
      () => send('POST', `/api/deals/${deal}/submit`, a, {}),
    )
    expect(r.statusCode).toBe(409)
    expect(await stateOf(deal)).toBe('draft')
  })
})

describe('what a decision is about', () => {
  it('TC-AUTHZ-04 a carry recipient who has since changed their email is still conflicted', async () => {
    const r2 = await staff(unique('movedreviewer'), ['reviewer'])
    const who = await person(unique('movedlead'))
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, {
      ...base,
      economics: { ...base.economics, recipients: [{ kind: 'person', first_name: 'R', last_name: 'R', email: r2.email, share_bps: 10000 }] },
    })
    await legalFile(id)
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    await t.owner.query('INSERT INTO user_email_history (user_id, email) VALUES ($1, $2)', [r2.id, r2.email])
    await t.owner.query('UPDATE user_account SET email = $2 WHERE id = $1', [r2.id, unique('newaddress')])
    expect((await send('GET', `/api/review/deals/${id}`, r2)).statusCode).toBe(404)
    expect((await send('POST', `/api/review/deals/${id}/approve`, r2, {})).statusCode).toBe(409)
    expect(await stateOf(id)).toBe('in_review')
  })

  it('TC-DRF-05 once submitted a deal is judged by the fee it is bound to, and the screen shows that fee', async () => {
    const who = await person(unique('boundfee'))
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, terms: { ...base.terms, allocation_minor: '1000000' }, economics: { ...base.economics, fee_payer: 'investors' } })
    await legalFile(id)
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    await t.owner.query(
      'INSERT INTO fee_config (id, version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, changed_by) SELECT $1, $2, 100, 100, 200000, 500000000, 0, id FROM user_account ORDER BY created_at LIMIT 1',
      [randomUUID(), ++feeVersion + 100],
    )
    try {
      const page = (await send('GET', `/api/deals/${id}`, who)).json()
      expect(page.settings.fee.min_minor).toBe('400000')
      const r = await send('PUT', `/api/deals/${id}/draft`, who, { ...page.draft, terms: { ...page.draft.terms, allocation_minor: '300000' } })
      expect(r.statusCode).toBe(409)
      expect(await stateOf(id)).toBe('in_review')
    } finally {
      await setFee()
    }
  })

  const joined = async (a: Client, syndicate: string) => {
    const m = await person(unique('member'))
    await joinAs(m, syndicate, a, 'deal_member')
    return m
  }

  it('TC-AUTHZ-03 moving a draft to another syndicate leaves behind people assigned through the old one', async () => {
    const a = await person(unique('moveteam'))
    const e = await entityFor(a)
    const syndicate = (name: string) => send('POST', '/api/syndicates', a, { name, lead_entity_id: e }).then((r) => r.json().id as string)
    const one = await syndicate('First')
    const two = await syndicate('Second')
    const base = draftFor(e)
    const inSyndicate = (id: string) => ({ ...base, basics: { ...base.basics, syndicate: { mode: 'existing', id } } })
    const deal = await newDeal(a, inSyndicate(one))
    const u = await joined(a, one)
    expect((await send('PUT', `/api/deals/${deal}/members/${u.id}`, a, { role: 'co_lead' })).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${deal}`, u)).statusCode).toBe(200)
    expect((await send('PUT', `/api/deals/${deal}/draft`, a, inSyndicate(two))).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${deal}`, u)).statusCode).toBe(404)

    const stays = await joined(a, two)
    await joinAs(stays, one, a, 'deal_member')
    await send('PUT', `/api/deals/${deal}/draft`, a, inSyndicate(one))
    expect((await send('PUT', `/api/deals/${deal}/members/${stays.id}`, a, { role: 'member' })).statusCode).toBe(200)
    expect((await send('PUT', `/api/deals/${deal}/draft`, a, inSyndicate(two))).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${deal}`, stays)).statusCode).toBe(200)
    expect((await send('PUT', `/api/deals/${deal}/draft`, a, { ...base })).statusCode).toBe(200)
    expect((await send('GET', `/api/deals/${deal}`, stays)).statusCode).toBe(404)
  })

  it('TC-AUTHZ-03 a withdrawn deal moved to another syndicate is out of reach of the one it left', async () => {
    const a = await person(unique('leftsyn'))
    const id = await submitted(a)
    const old = await syndicateOf(id)
    const oldAdmin = await person(unique('oldadmin'))
    await joinAs(oldAdmin, old, a, 'admin')
    expect((await send('GET', `/api/deals/${id}`, oldAdmin)).statusCode).toBe(200)
    await send('POST', `/api/deals/${id}/withdraw`, a, {})
    const target = (await send('POST', '/api/syndicates', a, { name: 'Next', lead_entity_id: await entityFor(a) })).json().id as string
    const draft = (await send('GET', `/api/deals/${id}`, a)).json().draft
    expect(
      (await send('PUT', `/api/deals/${id}/draft`, a, { ...draft, basics: { ...draft.basics, syndicate: { mode: 'existing', id: target } } })).statusCode,
    ).toBe(200)
    expect((await send('GET', `/api/deals/${id}`, oldAdmin)).statusCode).toBe(404)
    expect((await send('POST', `/api/deals/${id}/submit`, a, {})).statusCode).toBe(200)
    expect(await syndicateOf(id)).toBe(target)
  })

  it('TC-DRF-01 the lead is shown the minimum the deal was reviewed with, not the one of today', async () => {
    const who = await person(unique('leadfloor'))
    const id = await submitted(who)
    await t.owner.query('UPDATE deal_config SET min_commitment_floor_minor = 200000')
    try {
      const page = (await send('GET', `/api/deals/${id}`, who)).json()
      expect(page.effective_min_commitment_minor).toBe('100000')
    } finally {
      await t.owner.query('UPDATE deal_config SET min_commitment_floor_minor = 100000')
    }
    const draft = await newDeal(who)
    expect((await send('GET', `/api/deals/${draft}`, who)).json().effective_min_commitment_minor).toBeNull()
  })

  it('TC-DRF-01 a raised operator minimum does not move under a submitted deal, whatever is edited', async () => {
    const who = await person(unique('heldfloor'))
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, terms: { ...base.terms, allocation_minor: '150000' } })
    await legalFile(id)
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    await t.owner.query('UPDATE deal_config SET min_commitment_floor_minor = 200000')
    try {
      const page = (await send('GET', `/api/deals/${id}`, who)).json()
      expect(page.settings.min_commitment_floor_minor).toBe('100000')
      expect((await send('PUT', `/api/deals/${id}/draft`, who, { ...page.draft, basics: { ...page.draft.basics, name: 'Only the name' } })).statusCode).toBe(
        200,
      )
      expect((await upload(who, id, 'kind=legal&name=more.pdf')).statusCode).toBe(200)
      const v = (
        await t.owner.query<{ m: string }>(
          "SELECT snapshot->'terms'->>'min_commitment_minor' AS m FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1",
          [id],
        )
      ).rows[0]!
      expect(v.m).toBe('100000')
      await send('POST', `/api/deals/${id}/withdraw`, who, {})
      expect((await send('GET', `/api/deals/${id}`, who)).json().settings.min_commitment_floor_minor).toBe('200000')
    } finally {
      await t.owner.query('UPDATE deal_config SET min_commitment_floor_minor = 100000')
    }
  })

  it('TC-OP-07 the operator minimum can be the largest allocation and no more', async () => {
    const admin = await staff(unique('flooradmin'), ['admin'])
    const { id: _id, enabled_structures: _s, ...editable } = (await send('GET', '/api/deal-config', admin)).json()
    expect((await send('PUT', '/api/deal-config', admin, { ...editable, min_commitment_floor_minor: '100000000000' })).statusCode).toBe(200)
    expect((await send('PUT', '/api/deal-config', admin, { ...editable, min_commitment_floor_minor: '100000000001' })).statusCode).toBe(400)
    expect((await send('PUT', '/api/deal-config', admin, editable)).statusCode).toBe(200)
  })

  it('TC-DRF-03 a pitch deck no longer chosen stops being a document of the deal, and that counts as a change', async () => {
    const who = await person(unique('deckdrop'))
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, files: { deck: { kind: 'file' } } })
    await legalFile(id)
    expect((await upload(who, id, 'kind=deck&name=deck.pdf')).statusCode).toBe(200)
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    const before = (await send('GET', `/api/review/deals/${id}`, reviewer)).json()
    expect(before.files.map((f: { requirement: string }) => f.requirement)).toContain('deck')
    const page = (await send('GET', `/api/deals/${id}`, who)).json()
    expect(
      (await send('PUT', `/api/deals/${id}/draft`, who, { ...page.draft, files: { deck: { kind: 'link', url: 'https://decks.example.test/a' } } })).statusCode,
    ).toBe(200)
    const after = (await send('GET', `/api/review/deals/${id}`, reviewer)).json()
    expect(after.files.map((f: { requirement: string }) => f.requirement)).not.toContain('deck')
    expect(after.latest_sha256).not.toBe(before.latest_sha256)
  })

  it('TC-DRF-03 a deck that was never the chosen one goes at the next save, and that alone counts as a change', async () => {
    const who = await person(unique('deckleft'))
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, files: { deck: { kind: 'link', url: 'https://decks.example.test/a' } } })
    await legalFile(id)
    expect((await upload(who, id, 'kind=deck&name=deck.pdf')).statusCode).toBe(200)
    expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
    const before = (await send('GET', `/api/review/deals/${id}`, reviewer)).json()
    const page = (await send('GET', `/api/deals/${id}`, who)).json()
    expect((await send('PUT', `/api/deals/${id}/draft`, who, page.draft)).statusCode).toBe(200)
    const after = (await send('GET', `/api/review/deals/${id}`, reviewer)).json()
    expect(after.files.map((f: { requirement: string }) => f.requirement)).not.toContain('deck')
    expect(after.latest_sha256).not.toBe(before.latest_sha256)
  })

  it('TC-INV-01 the reviewer is told which company a check is about, and a kept download link stops once the deal is withdrawn', async () => {
    const who = await person(unique('whichco'))
    const contact = unique('whichcontact')
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: contact, registration_number: 'WC1' } })
    await legalFile(id)
    await send('POST', `/api/deals/${id}/submit`, who, {})
    const token = /\/investee\?token=([\w-]+)/.exec((await mailTo(contact)).at(-1)!.body)![1]!
    const file = (
      await app.inject({
        method: 'POST',
        url: `/api/investee/files?requirement=bank_statement&name=d.pdf`,
        remoteAddress: nextIp(),
        headers: { 'x-investee-token': token, 'content-type': 'application/octet-stream' },
        payload: PDF,
      })
    ).json().id as string
    expect((await send('GET', `/api/review/deals/${id}`, reviewer)).json().investee.company).toEqual({
      legal_name: 'Seedling Ltd',
      jurisdiction: 'England and Wales',
      registration_number: 'WC1',
    })
    const url = `/api/review/deals/${id}/investee/files/${file}`
    expect((await send('GET', url, reviewer)).statusCode).toBe(200)
    await send('POST', `/api/deals/${id}/withdraw`, who, {})
    expect((await send('GET', url, reviewer)).statusCode).toBe(404)
  })

  it('TC-INV-03 the signature answer stays with the checked company even after the deal that asked moves on', async () => {
    const reg = `SA${unique('r').replace(/\W/g, '')}`
    const first = await person(unique('answera'))
    const contact = unique('answerco')
    const base = draftFor(await entityFor(first))
    const one = await newDeal(first, { ...base, company: { ...base.company, contact_email: contact, registration_number: reg } })
    await legalFile(one)
    await send('POST', `/api/deals/${one}/submit`, first, {})
    const token = /\/investee\?token=([\w-]+)/.exec((await mailTo(contact)).at(-1)!.body)![1]!
    for (const requirement of ['incorporation_certificate', 'bank_statement', 'address_proof'])
      await app.inject({
        method: 'POST',
        url: `/api/investee/files?requirement=${requirement}&name=d.pdf`,
        remoteAddress: nextIp(),
        headers: { 'x-investee-token': token, 'content-type': 'application/octet-stream' },
        payload: PDF,
      })
    await send('POST', '/api/investee/submit', undefined, { token, needs_notarised_signature: true })
    await send('POST', `/api/review/deals/${one}/investee/approve`, reviewer, {})
    const held = (await send('GET', `/api/deals/${one}`, first)).json().draft
    await send('PUT', `/api/deals/${one}/draft`, first, { ...held, company: { ...held.company, legal_name: 'Another Co', registration_number: `${reg}X` } })
    const who = await person(unique('answerb'))
    const b2 = draftFor(await entityFor(who))
    const two = await newDeal(who, { ...b2, company: { ...b2.company, contact_email: unique('answerco2'), registration_number: reg } })
    await legalFile(two)
    await send('POST', `/api/deals/${two}/submit`, who, {})
    const page = (await send('GET', `/api/review/deals/${two}`, reviewer)).json().investee
    expect([page.status, page.needs_notarised_signature]).toEqual(['approved', true])
  })

  it('TC-DRF-01 a blank minimum is reviewed as the operator figure of the day, and moving it later changes nothing approved', async () => {
    const who = await person(unique('floor'))
    const id = await submitted(who)
    const page = (await send('GET', `/api/review/deals/${id}`, reviewer)).json()
    expect(page.effective_min_commitment_minor).toBe('100000')
    await t.owner.query('UPDATE deal_config SET min_commitment_floor_minor = 200000')
    try {
      expect((await send('POST', `/api/review/deals/${id}/approve`, reviewer, { reviewed_sha256: page.latest_sha256 })).statusCode).toBe(200)
    } finally {
      await t.owner.query('UPDATE deal_config SET min_commitment_floor_minor = 100000')
    }
    const v = (
      await t.owner.query<{ m: string; sha256: string }>(
        "SELECT snapshot->'terms'->>'min_commitment_minor' AS m, sha256 FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1",
        [id],
      )
    ).rows[0]!
    expect(v).toEqual({ m: '100000', sha256: page.latest_sha256 })
  })

  it('TC-PUB-02 a new fee on resubmission is a changed deal: an older review page cannot approve it', async () => {
    const who = await person(unique('refee'))
    const id = await submitted(who)
    const first = (await send('GET', `/api/review/deals/${id}`, reviewer)).json()
    expect(first.platform_fee.rate_bps).toBe(250)
    expect((await send('POST', `/api/deals/${id}/withdraw`, who, {})).statusCode).toBe(200)
    await t.owner.query(
      'INSERT INTO fee_config (id, version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, changed_by) SELECT $1, $2, 300, 400000, 2000000, 500000000, 10, id FROM user_account ORDER BY created_at LIMIT 1',
      [randomUUID(), ++feeVersion + 100],
    )
    try {
      expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
      const r = await inject('POST', `/api/review/deals/${id}/approve`, reviewer, { reviewed_sha256: first.latest_sha256 })
      expect(r.statusCode).toBe(409)
      const second = (await send('GET', `/api/review/deals/${id}`, reviewer)).json()
      expect(second.platform_fee.rate_bps).toBe(300)
      expect(second.changes).toContainEqual({ field: 'platform_fee.rate_bps', before: '250', after: '300' })
    } finally {
      await setFee()
    }
  })

  it('TC-INV-01 an old link is about what it was issued for, not a later working copy', async () => {
    const who = await person(unique('oldlink'))
    const contact = unique('oldlinkco')
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: contact } })
    await legalFile(id)
    await send('POST', `/api/deals/${id}/submit`, who, {})
    const token = /\/investee\?token=([\w-]+)/.exec((await mailTo(contact)).at(-1)!.body)![1]!
    await send('POST', `/api/deals/${id}/withdraw`, who, {})
    const draft = (await send('GET', `/api/deals/${id}`, who)).json().draft
    await send('PUT', `/api/deals/${id}/draft`, who, {
      ...draft,
      basics: { ...draft.basics, name: 'Confidential next round' },
      terms: { ...draft.terms, seis: true },
    })
    const page = (await send('POST', '/api/investee/view', undefined, { token })).json()
    expect(page.deal_name).toBe('Seedling Round')
    expect(page.required).not.toContain('seis_eis_advance_assurance')
  })

  it('TC-INV-03 a check reused for another deal keeps the signature answer, and says it was reused', async () => {
    const reg = `REG${unique('r').replace(/\W/g, '')}`
    const first = await person(unique('reusea'))
    const contact = unique('reuseco')
    const make = async (who: Client, mail: string) => {
      const base = draftFor(await entityFor(who))
      const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: mail, registration_number: reg } })
      await legalFile(id)
      expect((await send('POST', `/api/deals/${id}/submit`, who, {})).statusCode).toBe(200)
      return id
    }
    const one = await make(first, contact)
    const token = /\/investee\?token=([\w-]+)/.exec((await mailTo(contact)).at(-1)!.body)![1]!
    for (const requirement of ['incorporation_certificate', 'bank_statement', 'address_proof'])
      await app.inject({
        method: 'POST',
        url: `/api/investee/files?requirement=${requirement}&name=d.pdf`,
        remoteAddress: nextIp(),
        headers: { 'x-investee-token': token, 'content-type': 'application/octet-stream' },
        payload: PDF,
      })
    await send('POST', '/api/investee/submit', undefined, { token, needs_notarised_signature: true })
    expect((await send('POST', `/api/review/deals/${one}/investee/approve`, reviewer, {})).json().status).toBe('approved')
    const two = await make(await person(unique('reuseb')), unique('reuseco2'))
    const page = (await send('GET', `/api/review/deals/${two}`, reviewer)).json().investee
    expect(page.status).toBe('approved')
    expect(page.needs_notarised_signature).toBe(true)
    expect(page.reused_earlier_check).toBe(true)
  })

  it('TC-AUTHZ-02 a company decision on an unsubmitted draft gets the answer for a deal that does not exist', async () => {
    const who = await person(unique('hiddencompany'))
    const id = await newDeal(who, draftFor(await entityFor(who)))
    const body = { reviewed_sha256: NO_HASH }
    const hidden = await inject('POST', `/api/review/deals/${id}/investee/approve`, reviewer, body)
    const absent = await inject('POST', `/api/review/deals/${randomUUID()}/investee/approve`, reviewer, body)
    expect([hidden.statusCode, hidden.json().error]).toEqual([absent.statusCode, absent.json().error])
  })

  it('TC-AUTHZ-04 two leads with reviewer roles: neither can review their own deal', async () => {
    const a = await staff(unique('leadreviewer'), ['reviewer'])
    const co = await staff(unique('coleadreviewer'), ['reviewer'])
    const id = await submitted(a)
    await joinAs(co, await syndicateOf(id), a, 'deal_member')
    expect((await send('PUT', `/api/deals/${id}/members/${co.id}`, a, { role: 'co_lead' })).statusCode).toBe(200)
    for (const who of [a, co]) expect((await send('POST', `/api/review/deals/${id}/approve`, who, {})).statusCode).toBe(409)
    expect(await stateOf(id)).toBe('in_review')
  })

  it('TC-DRF-06 submitting names the copy and the documents the page showed', async () => {
    const who = await person(unique('submithash'))
    const id = await newDeal(who, draftFor(await entityFor(who)))
    await legalFile(id)
    const page = (await send('GET', `/api/deals/${id}`, who)).json()
    const files = page.files.map((f: { id: string }) => f.id)
    const older = await send('POST', `/api/deals/${id}/submit`, who, { base: page.draft_rev + 1, file_ids: files })
    expect(older.statusCode).toBe(409)
    expect(older.json().error).toContain('Someone has changed this deal')
    expect((await send('POST', `/api/deals/${id}/submit`, who, { base: page.draft_rev, file_ids: [] })).statusCode).toBe(409)
    expect(await stateOf(id)).toBe('draft')
    expect((await send('POST', `/api/deals/${id}/submit`, who, { base: page.draft_rev, file_ids: files })).json().state).toBe('in_review')
  })

  it('TC-INV-01 a changed answer about signatures is a different check', async () => {
    const who = await person(unique('notarised'))
    const contact = unique('notarisedco')
    const base = draftFor(await entityFor(who))
    const id = await newDeal(who, { ...base, company: { ...base.company, contact_email: contact } })
    await legalFile(id)
    await send('POST', `/api/deals/${id}/submit`, who, {})
    const token = /\/investee\?token=([\w-]+)/.exec((await mailTo(contact)).at(-1)!.body)![1]!
    for (const requirement of ['incorporation_certificate', 'bank_statement', 'address_proof'])
      await app.inject({
        method: 'POST',
        url: `/api/investee/files?requirement=${requirement}&name=d.pdf`,
        remoteAddress: nextIp(),
        headers: { 'x-investee-token': token, 'content-type': 'application/octet-stream' },
        payload: PDF,
      })
    await send('POST', '/api/investee/submit', undefined, { token, needs_notarised_signature: false })
    const old = (await send('GET', `/api/review/deals/${id}`, reviewer)).json().investee.check_sha256
    await t.owner.query('UPDATE investee SET needs_notarised_signature = true WHERE deal_id = $1', [id])
    expect((await inject('POST', `/api/review/deals/${id}/investee/approve`, reviewer, { reviewed_sha256: old })).statusCode).toBe(409)
  })

  it('TC-AUTHZ-03 what a person may do about the company follows who runs the deal, also once it is live', async () => {
    const who = await person(unique('manage'))
    const id = await approved(who)
    expect((await send('POST', `/api/deals/${id}/launch`, who, { confirm: true })).json().state).toBe('live')
    const page = (await send('GET', `/api/deals/${id}`, who)).json()
    expect(page.can_edit).toBe(false)
    expect(page.can_manage).toBe(true)
  })

  it('TC-AUTHZ-02 a decision on an unsubmitted draft gets the answer for a deal that does not exist', async () => {
    const who = await person(unique('hiddendraft'))
    const id = await newDeal(who, draftFor(await entityFor(who)))
    for (const [url, actor, body] of [
      [`/api/review/deals/${id}/approve`, reviewer, { reviewed_sha256: NO_HASH }],
      [`/api/review/deals/${id}/content-approval`, approver, { content_sha256: NO_HASH, self_declared_name: 'A' }],
    ] as const) {
      const hidden = await inject('POST', url, actor, body)
      const absent = await inject('POST', url.replace(id, randomUUID()), actor, body)
      expect([hidden.statusCode, hidden.json().error]).toEqual([absent.statusCode, absent.json().error])
    }
  })

  it('TC-PUB-02 an old version still shows the old carry recipient after a change', async () => {
    const who = await person(unique('oldcarry'))
    const id = await submitted(who)
    const first = (
      await t.owner.query<{ snapshot: { economics: { recipients: Array<{ person_version: string }> } } }>(
        'SELECT snapshot FROM deal_version WHERE deal_id = $1 AND n = 1',
        [id],
      )
    ).rows[0]!.snapshot
    const page = (await send('GET', `/api/deals/${id}`, who)).json()
    const recipients = [{ ...page.draft.economics.recipients[0], email: 'carried.on@example.test' }]
    expect((await send('PUT', `/api/deals/${id}/draft`, who, { ...page.draft, economics: { ...page.draft.economics, recipients } })).statusCode).toBe(200)
    const old = (
      await t.owner.query<{ fields: { email: string } }>('SELECT fields FROM person_version WHERE id = $1', [first.economics.recipients[0]!.person_version])
    ).rows[0]!
    expect(old.fields.email).toBe('cara.carry@example.test')
  })

  it('TC-DRF-03 removed files still count against what a person may store', async () => {
    const who = await person(unique('quota'))
    const id = await newDeal(who, draftFor(await entityFor(who)))
    const file = (await upload(who, id, 'kind=legal&name=a.pdf')).json().id as string
    expect((await send('DELETE', `/api/deals/${id}/files/${file}`, who)).statusCode).toBe(200)
    await t.owner.query('UPDATE stored_file SET size_bytes = 1000000000000 WHERE id = $1', [file])
    const r = await upload(who, id, 'kind=legal&name=b.pdf')
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('You have too many files.')
  })

  it('TC-CMP-03 an entity or a file from the sandbox does not count for a deal once the instance is real', async () => {
    const who = await person(unique('sandboxmade'))
    const entity = await entityFor(who)
    const id = await newDeal(who, draftFor(entity))
    await legalFile(id)
    const fields = async () => (await send('GET', `/api/deals/${id}`, who)).json().problems.map((p: { field: string }) => p.field)
    expect(await fields()).not.toContain('legal_files')
    await t.owner.query("UPDATE instance_profile SET real_since = now() + interval '1 hour'")
    try {
      const after = await fields()
      expect(after).toContain('legal_files')
      expect(after).toContain('syndicate.lead_entity_id')
      expect((await send('POST', '/api/syndicates', who, { name: 'Made from the sandbox', lead_entity_id: entity })).statusCode).toBe(409)
    } finally {
      await t.owner.query('UPDATE instance_profile SET real_since = NULL')
    }
  })

  const joinAs = async (who: Client, syndicate: string, admin: Client, role: 'admin' | 'deal_member') => {
    const link = (await send('POST', `/api/syndicates/${syndicate}/invites`, admin, { role })).json().link as string
    const token = new URL(link, 'http://x').searchParams.get('token')!
    expect((await send('POST', '/api/syndicate-invites/accept', who, { token })).statusCode).toBe(200)
  }
  const syndicateOf = async (deal: string) =>
    (await t.owner.query<{ syndicate_id: string }>('SELECT syndicate_id FROM deal WHERE id = $1', [deal])).rows[0]!.syndicate_id

  it('TC-AUTHZ-03 the person leading a deal cannot be demoted out of running it', async () => {
    const a = await person(unique('demoted'))
    const id = await submitted(a)
    const syndicate = await syndicateOf(id)
    const other = await person(unique('otheradmin'))
    await joinAs(other, syndicate, a, 'admin')
    const r = await send('PUT', `/api/syndicates/${syndicate}/members/${a.id}`, other, { role: 'deal_member' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('This person leads a deal in the syndicate.')
    expect((await send('PUT', `/api/syndicates/${syndicate}/members/${other.id}`, a, { role: 'deal_member' })).statusCode).toBe(200)
  })

  it('TC-DRF-08 a co-lead adding a file does not become the person who confirmed the board approval', async () => {
    const a = await person(unique('attester'))
    const id = await submitted(a)
    const co = await person(unique('filer'))
    await joinAs(co, await syndicateOf(id), a, 'deal_member')
    expect((await send('PUT', `/api/deals/${id}/members/${co.id}`, a, { role: 'co_lead' })).statusCode).toBe(200)
    expect((await upload(co, id, 'kind=legal&name=late.pdf')).statusCode).toBe(200)
    const rows = (await t.owner.query<{ actor: string }>('SELECT actor FROM lead_attestation WHERE deal_id = $1 ORDER BY version_n DESC', [id])).rows
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[0]!.actor).toBe(a.id)
  })

  it('TC-REV-02 a decision on content that has since changed is refused, and it must say what it read', async () => {
    const id = await submitted(lead)
    const read = (await send('GET', `/api/review/deals/${id}`, reviewer)).json().latest_sha256
    expect(read).toMatch(/^[0-9a-f]{64}$/)
    await editName(id, lead, 'Swapped After Reading')
    for (const [path, body] of [
      ['approve', {}],
      ['request-changes', { reason: 'x' }],
      ['reject', { reason: 'x' }],
    ] as const) {
      const r = await send('POST', `/api/review/deals/${id}/${path}`, reviewer, { ...body, reviewed_sha256: read })
      expect(r.json().error).toBe('This deal has changed since you opened it. Open it again.')
    }
    expect(await stateOf(id)).toBe('in_review')
    expect((await inject('POST', `/api/review/deals/${id}/approve`, reviewer, {})).statusCode).toBe(400)
  })

  it('TC-OP-07 an approver approves the content they read, and can read it', async () => {
    const id = await approved(lead)
    expect((await send('GET', '/api/approvals/deals', approver)).json().deals.map((d: { id: string }) => d.id)).toContain(id)
    const page = (await send('GET', `/api/approvals/deals/${id}`, approver)).json()
    expect(page.content.basics.name).toBe('Seedling Round')
    expect(page.content.company.contact_email).toBe('sam.founder@example.test')
    expect(
      (await send('POST', `/api/review/deals/${id}/content-approval`, approver, { self_declared_name: 'O', content_sha256: 'a'.repeat(64) })).statusCode,
    ).toBe(409)
    expect((await inject('POST', `/api/review/deals/${id}/content-approval`, approver, { self_declared_name: 'O' })).statusCode).toBe(400)
    expect(
      (await send('POST', `/api/review/deals/${id}/content-approval`, approver, { self_declared_name: 'O', content_sha256: page.content_sha256 })).statusCode,
    ).toBe(200)
  })

  it('TC-OP-07 an approver with a stake sees neither the page nor the entry, and nothing before review has passed', async () => {
    const both = await staff(unique('approverlead'), ['approver'])
    const own = await approved(both)
    expect((await send('GET', `/api/approvals/deals/${own}`, both)).statusCode).toBe(404)
    expect((await send('GET', '/api/approvals/deals', both)).json().deals.map((d: { id: string }) => d.id)).not.toContain(own)
    expect((await send('GET', `/api/approvals/deals/${await submitted(lead)}`, approver)).statusCode).toBe(404)
  })

  it('TC-AUTHZ-04 a reviewer with a stake cannot read the internal notes, and nobody reads a draft', async () => {
    const strict = await staff(unique('notes'), ['reviewer'])
    const id = await submitted(strict)
    await send('POST', `/api/review/deals/${id}/request-changes`, reviewer, { reason: 'x', internal_note: 'SECRET-NOTE' })
    const r = await send('GET', `/api/review/deals/${id}`, strict)
    expect(r.statusCode).toBe(404)
    expect(r.body).not.toContain('SECRET-NOTE')
    expect((await send('GET', `/api/review/deals/${await newDeal(lead, draftFor(await entityFor(lead)))}`, reviewer)).statusCode).toBe(404)
  })

  it('TC-AUTHZ-03 a reviewer who is in the syndicate cannot use the staff route to its documents', async () => {
    const insider = await staff(unique('insiderfile'), ['reviewer'])
    const id = await submitted(lead)
    await t.owner.query("INSERT INTO syndicate_member (syndicate_id, user_id, role) SELECT syndicate_id, $2, 'deal_member' FROM deal WHERE id = $1", [
      id,
      insider.id,
    ])
    const file = (await upload(lead, id, 'kind=legal&name=x.pdf')).json().id
    expect((await send('GET', `/api/deals/${id}/files/${file}`, insider)).statusCode).toBe(404)
  })

  it('TC-AUTHZ-04 a stake gained after approval stops the launch', async () => {
    const id = await approved(lead)
    await t.owner.query("INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, 'member')", [id, reviewer.id])
    expect((await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })).json().error).toBe(
      'Someone who approved this deal now has a stake in it. It must be reviewed again.',
    )
  })

  it('TC-AUTHZ-04 a stray field cannot hide the address that gives a company recipient its stake', async () => {
    const strict = await staff(unique('decoy'), ['reviewer'])
    const base = draftFor(await entityFor(lead))
    const recipient = {
      kind: 'company',
      trading_name: 'T',
      legal_name: 'L',
      registration_number: '1',
      contact_name: 'C',
      contact_email: strict.email,
      email: 'decoy@example.test',
      share_bps: 10000,
    }
    const id = await newDeal(lead, { ...base, economics: { ...base.economics, recipients: [recipient] } })
    await legalFile(id)
    await send('POST', `/api/deals/${id}/submit`, lead, {})
    expect((await approve(id, strict)).statusCode).toBe(409)
  })

  it('TC-DEAL-01 a deal approved in the sandbox must be reviewed again once the instance is real', async () => {
    const id = await approved(lead)
    await t.owner.query('UPDATE instance_profile SET real_since = $1::timestamptz', [new Date(clock.getTime() + 3_600_000).toISOString()])
    try {
      expect((await send('POST', `/api/deals/${id}/launch`, lead, { confirm: true })).json().error).toBe(
        'This deal was approved in the sandbox. It must be reviewed again.',
      )
    } finally {
      await t.owner.query('UPDATE instance_profile SET real_since = NULL')
    }
  })

  it('TC-DRF-08 a confirmation cannot be taken back during review', async () => {
    const id = await approved(lead)
    const draft = (await send('GET', `/api/deals/${id}`, lead)).json().draft
    const r = await send('PUT', `/api/deals/${id}/draft`, lead, { ...draft, attestations: { board_and_shareholders: false } })
    expect(r.statusCode).toBe(409)
    expect(await stateOf(id)).toBe('approved')
    expect((await send('GET', `/api/deals/${id}`, lead)).json().draft.attestations.board_and_shareholders).toBe(true)
  })

  it('TC-DRF-08 changing to fund units during review records the extra confirmation against the new version', async () => {
    const id = await submitted(lead)
    const draft = (await send('GET', `/api/deals/${id}`, lead)).json().draft
    const terms = { ...draft.terms, instrument: 'fund_units', share_price_micros: undefined, pre_money_minor: undefined }
    expect((await send('PUT', `/api/deals/${id}/draft`, lead, { ...draft, terms })).statusCode).toBe(409)
    expect(
      (await send('PUT', `/api/deals/${id}/draft`, lead, { ...draft, terms, attestations: { board_and_shareholders: true, fund_mainly_unlisted: true } }))
        .statusCode,
    ).toBe(200)
    expect(await count("SELECT count(*) AS n FROM lead_attestation WHERE deal_id = $1 AND kind = 'fund_mainly_unlisted' AND version_n = 2", [id])).toBe(1)
  })

  it('TC-REV-02 after changes are requested the deal stays with its syndicate', async () => {
    const id = await submitted(lead)
    await send('POST', `/api/review/deals/${id}/request-changes`, reviewer, { reason: 'x' })
    const draft = (await send('GET', `/api/deals/${id}`, lead)).json().draft
    await send('PUT', `/api/deals/${id}/draft`, lead, {
      ...draft,
      basics: { ...draft.basics, syndicate: { mode: 'new', name: 'Elsewhere', lead_entity_id: await entityFor(lead) } },
    })
    expect((await send('GET', `/api/deals/${id}`, lead)).json().draft.basics.syndicate).toEqual(draft.basics.syndicate)
  })

  it('TC-SYN-04 a co-lead added after a withdrawal is told at the next submission, once; a draft cannot use a syndicate its lead does not run', async () => {
    const a = await person(unique('wd'))
    const entity = await entityFor(a)
    const group = (await send('POST', '/api/syndicates', a, { name: 'G', lead_entity_id: entity })).json().id
    const link = (await send('POST', `/api/syndicates/${group}/invites`, a, { role: 'deal_member' })).json().link
    const co = await person(unique('coagain'))
    await send('POST', '/api/syndicate-invites/accept', co, { token: new URL(link, 'http://x').searchParams.get('token') })
    const deal = await newDeal(
      a,
      draftFor(entity, { basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'R', syndicate: { mode: 'existing', id: group } } }),
    )
    await legalFile(deal)
    await send('POST', `/api/deals/${deal}/submit`, a, {})
    await send('POST', `/api/deals/${deal}/withdraw`, a, {})
    expect((await send('PUT', `/api/deals/${deal}/members/${co.id}`, a, { role: 'co_lead' })).statusCode).toBe(200)
    await send('POST', `/api/deals/${deal}/submit`, a, {})
    await send('POST', `/api/deals/${deal}/withdraw`, a, {})
    await send('POST', `/api/deals/${deal}/submit`, a, {})
    expect((await mailTo(co.email)).filter((m) => /co-lead/.test(m.subject))).toHaveLength(1)
    const outsider = await person(unique('outsiderlead'))
    const stolen = await newDeal(
      outsider,
      draftFor(await entityFor(outsider), {
        basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'R', syndicate: { mode: 'existing', id: group } },
      }),
    )
    expect((await send('PUT', `/api/deals/${stolen}/members/${co.id}`, outsider, { role: 'member' })).json().error).toBe('Choose a syndicate you manage.')
  })

  it('TC-SYN-02 leaving a syndicate you are not in looks the same as one that does not exist', async () => {
    const a = await person(unique('exists'))
    const group = (await send('POST', '/api/syndicates', a, { name: 'G', lead_entity_id: await entityFor(a) })).json().id
    const other = await person(unique('notin'))
    const real = await send('DELETE', `/api/syndicates/${group}/members/${other.id}`, other)
    const none = await send('DELETE', `/api/syndicates/${randomUUID()}/members/${other.id}`, other)
    expect([real.statusCode, real.body]).toEqual([none.statusCode, none.body])
  })

  it('TC-DRF-05 with no platform fee set, a deal cannot be submitted', async () => {
    const saved = { t, app }
    const fresh = await createTestDb()
    const server = await buildServer({ db: fresh.app, k: fresh.keyring, secureCookies: false, now: () => clock })
    t = fresh
    app = server
    try {
      const who = await person(unique('nofee'))
      const id = await newDeal(who, draftFor(await entityFor(who)))
      await legalFile(id)
      expect((await send('POST', `/api/deals/${id}/submit`, who, {})).json().error).toBe('The operator has not set the platform fee yet.')
    } finally {
      t = saved.t
      app = saved.app
      await server.close()
      await fresh.drop()
    }
  })

  it('TC-DRF-01 a date Postgres cannot store is a problem to fix, not a server error', async () => {
    const base = draftFor(await entityFor(lead))
    const id = await newDeal(lead, { ...base, terms: { ...base.terms, target_close: '0000-01-01' } })
    expect((await send('GET', `/api/deals/${id}`, lead)).json().problems.map((p: { field: string }) => p.field)).toContain('target_close')
  })

  it.each([
    ['half a surrogate pair', '{"basics":{"name":"\\ud800"}}'],
    ['a NUL', '{"basics":{"name":"a\\u0000b"}}'],
    ['very deep nesting', `{"terms":{"custom_terms":${'['.repeat(100_000)}${']'.repeat(100_000)}}}`],
  ])('TC-DRF-01 %s in a draft is refused as a bad request', async (_what, payload) => {
    const id = await newDeal(lead)
    const r = await app.inject({
      method: 'PUT',
      url: `/api/deals/${id}/draft`,
      remoteAddress: nextIp(),
      headers: { cookie: lead.cookie, 'x-csrf-token': lead.csrf, 'content-type': 'application/json' },
      payload,
    })
    expect(r.statusCode).toBe(400)
  })

  it('TC-DRF-03 a NUL in a file name is a bad request, and a stranger is refused before a large body is read', async () => {
    const who = await person(unique('nul'))
    const id = await newDeal(who)
    expect((await upload(who, id, 'kind=legal&name=a%00b.pdf')).statusCode).toBe(400)
    const stranger = await person(unique('hugefile'))
    expect((await upload(stranger, id, 'kind=legal&name=a.pdf', Buffer.alloc(100 * 1024 * 1024 + 1, 32))).statusCode).toBe(409)
  })

  it('TC-DRF-03 uploads in flight have a limit in bytes as well as in number, and it comes back', () => {
    const closers: Array<() => void> = []
    const holds = new UploadHolds(60_000, 5, 5, 100)
    const req = () => ({ raw: { destroy: () => undefined } })
    const reply = { raw: { once: (_e: 'close', fn: () => void) => closers.push(fn) }, code: () => ({ send: (b: unknown) => b }) }
    expect(holds.hold(req(), reply, 'a', 60)).toBe(true)
    expect(holds.hold(req(), reply, 'b', 41)).toBe(false)
    expect(holds.hold(req(), reply, 'b', 40)).toBe(true)
    closers[0]!()
    expect(holds.hold(req(), reply, 'c', 60)).toBe(true)
  })

  it('TC-OP-07 the operator settings are for admins, are checked, and take effect', async () => {
    const admin = await staff(unique('dealadmin'), ['admin'])
    const current = (await send('GET', '/api/deal-config', admin)).json()
    const { id: _id, enabled_structures: _s, ...editable } = current
    expect((await send('PUT', '/api/deal-config', lead, editable)).statusCode).toBe(403)
    expect((await send('PUT', '/api/deal-config', admin, { ...editable, embed_hosts: ['https://not-a-host'] })).statusCode).toBe(400)
    expect((await send('PUT', '/api/deal-config', admin, { ...editable, launch_confirm_days: 45 })).statusCode).toBe(200)
    expect((await send('GET', '/api/deal-config', admin)).json().launch_confirm_days).toBe(45)
    await send('PUT', '/api/deal-config', admin, editable)
  })
})
