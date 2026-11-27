// The demo deal seed's steps (PRD R-DEMO-03, decision R30, plan 05 §3, §4). Every step goes through the real routes, as a
// person on the screens would, with each demo account signed in on its own: the gates, audit and rule checks apply as for
// anyone, so the demo never shows a state the screens cannot reach. Only three things are done in-process: the run itself
// (`runDemo`, with its accounts), on an instance that never set one a sample platform fee (owner 2026-11-23), and the demo
// rules pack (R-DEMO-07: no route may install one).
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { demoScenario, DEMO_CURRENCY, type DemoInvestor } from '../demo/scenario.ts'
import { money, percent } from '../lib/dealSheet.ts'
import { demoPackContent, demoPackKey } from '../lib/demo.ts'
import { STATEMENT_DIGITS } from '../lib/eligibility.ts'
import { feeConfigErrors } from '../lib/fees.ts'
import { parsePack, type RegimePack, type StepKind } from '../lib/regimePack.ts'
import { codeAt, stepOf } from '../lib/totp.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { insertPack, packContent, packSha256 } from '../store/packs.ts'
import { addDemoAccounts, demoStepAllowed, recoverDemoRun, runDemo, type DemoAccount, type DemoAccounts, type DemoVia, type DropFiles } from './demo.ts'
import { activePack, policyNow } from './d3Core.ts'
import { renderPdf } from './pdf.ts'
import { Refused } from './requests.ts'

type Q = Pick<Tx, 'query'>

/** Set only when the operator never set a platform fee: the demo deal pays its own fee from the lead, so the amount is free. */
export const SAMPLE_PLATFORM_FEE = { rate_bps: 500, min_minor: 50_000n, max_minor: 2_500_000n, surcharge_threshold_minor: 0n, surcharge_bps: 0 } as const

/**
 * What stops the seed before anything is made (owner 2026-11-23: refuse at the start, never half a demo). The live deal's
 * link carries terms of its own and is opened by anyone holding it, so the operator's settings must allow both, without a
 * reviewer having to approve the terms first.
 */
export async function demoSeedRefusals(c: Q): Promise<string[]> {
  const out: string[] = []
  const mode = (await c.query<{ mode: string }>('SELECT mode FROM instance_profile WHERE id = 1')).rows[0]!.mode
  if (mode !== 'sandbox') return ['A demo deal can only be added in the sandbox.']
  const policy = await policyNow(c)
  if (!policy.perLinkTerms) out.push('The operator settings do not allow a link with terms of its own, which the demo deal needs.')
  if (!policy.genericLinks) out.push('The operator settings do not allow links that anyone holding them can open, which the demo deal needs.')
  const { pack } = await activePack(c)
  if (pack.incentive_attestation_required)
    out.push('The current rules pack asks a reviewer to approve each link with terms of its own; the demo deal needs one that does not.')
  // the investors walk the pack's own steps before the deal; a step the seed does not know is refused here (Codex r1 #5)
  const unknown = stepsBeforeDeal(pack).filter((k) => !WALKED.includes(k))
  if (unknown.length) out.push(`The current rules pack has steps before the deal that the demo deal does not walk: ${unknown.join(', ')}.`)
  // the investors sign at the pack's income threshold, which a statement takes only as at most 15 digits (Codex r2 #4)
  if (stepsBeforeDeal(pack).includes('statement') && BigInt(pack.thresholds.hnw_income_minor).toString().length > STATEMENT_DIGITS)
    out.push("The current rules pack's income threshold is longer than a statement's amount can be, so the demo investors cannot sign at it.")
  // self-test review 2026-11-24: each deal setting the scenario's steps depend on is checked here, not found failing half-way
  const cfg = (
    await c.query<{ enabled_structures: string[]; min_commitment_floor_minor: string; content_approval_in_sandbox: boolean; link_fee_max_bps: number }>(
      'SELECT enabled_structures, min_commitment_floor_minor::text, content_approval_in_sandbox, link_fee_max_bps FROM deal_config WHERE id = 1',
    )
  ).rows[0]!
  if (!cfg.enabled_structures.includes(DEMO_STRUCTURE))
    out.push('The deal settings do not allow the UK bare trust structure, which the demo deals use.')
  const smallest = demoScenario.investors.reduce((m, x) => (x.commitmentMinor < m ? x.commitmentMinor : m), demoScenario.investors[0]!.commitmentMinor)
  if (BigInt(cfg.min_commitment_floor_minor) > smallest)
    out.push(`The deal settings' minimum commitment is above ${money(smallest, DEMO_CURRENCY)}, the smallest commitment in the demo deal.`)
  if (cfg.content_approval_in_sandbox)
    out.push('The deal settings ask for promotion approval before launch in the sandbox; the demo deal has no approver to give it.')
  if (cfg.link_fee_max_bps < demoScenario.link.fee.bps)
    out.push(`The deal settings cap a link's lead fee below ${percent(demoScenario.link.fee.bps)}, the demo link's fee.`)
  const fee = (await c.query('SELECT 1 FROM fee_config LIMIT 1')).rowCount
  if (!fee && !(await sampleFeeBy(c, null))) out.push('No platform fee is set and there is no admin to set the sample one. Set the platform fee first.')
  return out
}

/** Who the sample fee is recorded as set by: the admin who started the run, or else the first ordinary admin. */
async function sampleFeeBy(c: Q, by: string | null): Promise<string | null> {
  if (by) return by
  const r = await c.query<{ user_id: string }>(
    "SELECT g.user_id FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.role = 'admin' AND u.demo_run IS NULL AND u.disabled_at IS NULL ORDER BY g.created_at, g.user_id LIMIT 1",
  )
  return r.rows[0]?.user_id ?? null
}

/** Owner 2026-11-23: on an instance that never set a platform fee, the seed sets a sample one, audited as the demo's. */
async function ensurePlatformFee(db: Db, k: Keyring, runId: string, by: string | null): Promise<boolean> {
  return tx(db, async (c) => {
    await demoStepAllowed(c, runId)
    if ((await c.query('SELECT 1 FROM fee_config LIMIT 1')).rowCount) return false
    const who = await sampleFeeBy(c, by)
    if (!who) throw new Error('No platform fee is set and there is no admin to set the sample one.')
    const f = SAMPLE_PLATFORM_FEE
    if (feeConfigErrors(f).length) throw new Error('the sample platform fee is not valid')
    // version 1: an admin setting the first fee at the same moment makes this fail on the version, and the run is retired
    await c.query(
      'INSERT INTO fee_config (id, version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, changed_by) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)',
      [randomUUID(), f.rate_bps, String(f.min_minor), String(f.max_minor), String(f.surcharge_threshold_minor), f.surcharge_bps, who],
    )
    await appendAudit(c, k, { actor: by ?? 'system', action: 'demo.sample_fee', entity: runId })
    return true
  })
}

/**
 * R-DEMO-07: the run's rules pack, made from the current one with the three sample texts. A run whose demo pack would be
 * the same as one already stored takes that one, so retried runs do not pile up versions. The launch binds it (d2.ts).
 */
export async function installDemoPack(db: Db, k: Keyring, runId: string, by: string | null): Promise<string> {
  return tx(db, async (c) => {
    await demoStepAllowed(c, runId)
    const { pack } = await activePack(c)
    const key = demoPackKey(pack.regime)
    const stored = (await c.query<{ id: string; version: number; content_sha256: string }>('SELECT id, version, content_sha256 FROM regime_pack WHERE key = $1 AND demo_only', [key])).rows
    // stored as parsed, so compared as parsed
    const demo = (version: number) => {
      const parsed = parsePack(demoPackContent(pack, version))
      if (!parsed.pack) throw new Error(`the demo rules pack does not load: ${parsed.errors.join('; ')}`)
      return parsed.pack
    }
    let id = stored.find((r) => r.content_sha256 === packSha256(demo(r.version)))?.id
    if (!id) {
      const version = Math.max(0, ...(await c.query<{ version: number }>('SELECT version FROM regime_pack WHERE key = $1', [key])).rows.map((r) => r.version)) + 1
      id = await insertPack(c, demo(version), { builtIn: false, by, demoOnly: true })
      await appendAudit(c, k, { actor: by ?? 'system', action: 'pack.added', entity: id, detail: { demo_run: runId } })
    }
    await c.query('UPDATE demo_run SET pack_id = $2 WHERE id = $1', [runId, id])
    return id
  })
}

/** One demo account signed in through the login route, calling the routes as its browser would. */
class Caller {
  private cookie = ''
  private csrf = ''
  private readonly app: FastifyInstance
  private readonly ip: string
  constructor(app: FastifyInstance, ip: string) {
    this.app = app
    this.ip = ip
  }

  private who?: { email: string; password: string; mfaSecret?: Buffer }

  async signIn(email: string, password: string, mfaSecret?: Buffer): Promise<void> {
    this.who = { email, password, mfaSecret }
    const code = mfaSecret ? codeAt(mfaSecret, stepOf(Date.now())) : undefined
    const r = await this.send('POST', '/api/login', { email, password, ...(code ? { code } : {}) })
    this.cookie = `bulma_session=${r.cookies.find((c) => c.name === 'bulma_session')!.value}`
    this.csrf = (r.json() as { csrf: string }).csrf
  }

  /**
   * Signs in again only when the session has ended. With the real clock a run never outlives a session, so this adds no
   * sign-in (and no two-step code used twice); the export moves its clock by days between investors (plan 05 §5.6).
   */
  async keepSignedIn(): Promise<void> {
    const r = await this.app.inject({ method: 'GET', url: '/api/session', remoteAddress: this.ip, headers: { cookie: this.cookie } })
    if (r.statusCode !== 200) await this.signIn(this.who!.email, this.who!.password, this.who!.mfaSecret)
  }

  async call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT', url: string, body?: object, extraCookie?: string): Promise<T> {
    return (await this.send(method, url, body, extraCookie)).json() as T
  }

  async upload(url: string, bytes: Buffer): Promise<void> {
    await this.send('POST', url, bytes)
  }

  /** The response, or an error naming the route and its refusal: the run's failure says which step stopped it. */
  async send(method: 'GET' | 'POST' | 'PUT', url: string, body?: object | Buffer, extraCookie?: string): Promise<LightMyRequestResponse> {
    const cookies = [this.cookie, extraCookie].filter(Boolean).join('; ')
    const r = await this.app.inject({
      method,
      url,
      remoteAddress: this.ip,
      headers: {
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...(cookies ? { cookie: cookies } : {}),
        ...(Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(body === undefined ? {} : { payload: body as object }),
    })
    if (r.statusCode !== 200) {
      let why = ''
      try {
        why = String((r.json() as { error?: unknown }).error ?? '')
      } catch {
        why = ''
      }
      throw new Error(`demo step ${method} ${url.split('?')[0]} refused (${r.statusCode})${why ? `: ${why.slice(0, 300)}` : ''}`)
    }
    return r
  }
}

/** R-DEMO-03: every generated file says on each page that it is a fictional sample. */
export const SAMPLE_MARK = 'SAMPLE — fictional'
const samplePdf = (what: string, whose: string) =>
  renderPdf(
    [
      { text: SAMPLE_MARK, bold: true, boxed: true, size: 14 },
      { text: `${what} for ${whose}.` },
      { text: 'Made by the demo deal of a Bulma sandbox. Not a real document; no real person is named in it.' },
    ],
    `${SAMPLE_MARK}: ${what}`,
  )

const DEMO_STRUCTURE = 'uk_bare_trust'

const isoDay = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10)

/** The six parts of a deal, for a company of the demo; `parts` picks which are filled (a draft can stop part-way). */
function demoDraft(o: { company: string; contact: string; contactEmail: string; syndicateId: string; lead: DemoAccount }, parts: 'all' | 'some') {
  const basics = {
    structure: DEMO_STRUCTURE,
    deal_type: 'primary',
    name: `${o.company.replace(/ Ltd$/, '')} round`,
    syndicate: { mode: 'existing', id: o.syndicateId },
  }
  // registration number and address are filled even when the operator does not require them, so a setting that does
  // never stops the seed (self-test review 2026-11-24); both are visibly fictional
  const company = {
    legal_name: o.company,
    contact_name: o.contact,
    contact_email: o.contactEmail,
    jurisdiction: 'England and Wales',
    registration_number: 'SAMPLE-00000000',
    address: '1 Sample Street, Fictional Town',
  }
  if (parts === 'some') return { basics, company }
  return {
    basics,
    company,
    terms: {
      currency: DEMO_CURRENCY,
      instrument: 'equity',
      share_price_micros: '1500000',
      pre_money_minor: '400000000',
      allocation_minor: '25000000',
      // no minimum of its own: the operator's floor applies, which the refusals have checked is at most the smallest commitment
      voter: 'lead',
      target_close: isoDay(90),
    },
    files: {},
    economics: {
      default_carry_bps: demoScenario.link.carryBps,
      recipients: [{ kind: 'person', first_name: 'Bulma', last_name: 'Briefs', email: o.lead.email, share_bps: 10_000 }],
      // the lead pays the platform fee: what each investor sees invested is the commitment itself, not an estimate that moves
      // with whatever fee the operator set
      fee_payer: 'lead',
    },
    attestations: { board_and_shareholders: true },
  }
}

interface Seeded {
  runId: string
  accounts: DemoAccounts
  sampleFee: boolean
  deals: { live: string; draft: string; inReview: string }
}

/**
 * R-DEMO-03: adds the demo, or throws `Refused` before anything is made. One run: the accounts, then the lead's syndicate and
 * three deals, then the four investors each to their step, the longest in their step first. Any failure retires the run
 * (`runDemo`).
 */
export async function seedDemo(
  app: FastifyInstance,
  db: Db,
  k: Keyring,
  o: {
    by: string | null
    via: DemoVia
    /** P's export only: moves its clock to the investor's day before they are walked. The seed itself has no clock. */
    beforeInvestor?: (x: DemoInvestor) => Promise<void>
  },
): Promise<Seeded> {
  // set by buildServer: a failed run's files leave the sandbox's in-memory store too
  const drop = (app as FastifyInstance & { dropSandboxFiles?: DropFiles }).dropSandboxFiles
  // a run left adding because its own clean-up failed is retired first (Codex r2 #3)
  await recoverDemoRun(db, k, drop)
  const refusals = await demoSeedRefusals(db)
  if (refusals.length) throw new Refused(refusals.join(' '))
  let accounts: DemoAccounts | undefined
  let sampleFee = false
  const ids: Record<string, string> = {}
  const s = demoScenario
  const caller = (n: number) => new Caller(app, `127.0.44.${n}`)
  let lead!: Caller
  let reviewer!: Caller
  const investors: Array<{ c: Caller; who: DemoAccount; plan: DemoInvestor; entity?: string; p?: string }> = []
  const acc = () => accounts!
  const companyEmail = (mailbox: string, runId: string) => `${mailbox}@run-${runId.slice(0, 8)}.demo.invalid`

  const runId = await runDemo(db, k, { by: o.by, via: o.via, drop }, [
    async (run) => {
      accounts = await addDemoAccounts(db, k, run, o.by)
      sampleFee = await ensurePlatformFee(db, k, run, o.by)
      await installDemoPack(db, k, run, o.by)
    },
    // the lead: own entity, the syndicate, and the live deal through review
    async (run) => {
      lead = caller(1)
      await lead.signIn(acc().lead.email, acc().lead.password)
      reviewer = caller(2)
      await reviewer.signIn(acc().reviewer.email, acc().reviewer.password, acc().reviewer.mfaSecret)
      const entity = (
        await lead.call<{ id: string }>('POST', '/api/entities', {
          type: 'individual',
          fields: { full_name: s.lead.name, address: '1 Sample Street, Fictional Town', tax_residence: 'UK', tax_id: 'SAMPLE01' },
          parties: [],
        })
      ).id
      ids.syndicate = (await lead.call<{ id: string }>('POST', '/api/syndicates', { name: s.syndicate.name, lead_entity_id: entity })).id
      ids.live = await submittedDeal(lead, { company: s.investee.company, contact: s.investee.contact, contactEmail: companyEmail(s.investee.mailbox, run) })
      const sha = (await reviewer.call<{ latest_sha256: string }>('GET', `/api/review/deals/${ids.live}`)).latest_sha256
      await reviewer.call('POST', `/api/review/deals/${ids.live}/approve`, { reviewed_sha256: sha })
      const approved = (await lead.call<{ approved_sha256: string }>('GET', `/api/deals/${ids.live}`)).approved_sha256
      await lead.call('POST', `/api/deals/${ids.live}/launch`, { confirm: true, content_sha256: approved })
      const policy = await lead.call<{ text: { version: number; sha256: string } }>('GET', `/api/deals/${ids.live}/invitee-policy`)
      await lead.call('POST', `/api/deals/${ids.live}/invitee-policy`, { version: policy.text.version, sha256: policy.text.sha256 })
      ids.link = (
        await lead.call<{ id: string }>('POST', `/api/deals/${ids.live}/links`, {
          kind: 'open',
          label: s.link.name,
          carry_bps: s.link.carryBps,
          fee: s.link.fee,
          reason: 'The lead fee of the demo deal.',
          confirm: true,
        })
      ).id
    },
    // the lead's other two deals: one stops in draft, one waits for review
    async (run) => {
      for (const d of s.otherDeals) {
        const contact = { company: d.company, contact: 'Sample Contact', contactEmail: companyEmail(`contact-${d.stop}`, run) }
        if (d.stop === 'draft') {
          ids.draft = (await lead.call<{ id: string }>('POST', '/api/deals', {})).id
          await lead.call('PUT', `/api/deals/${ids.draft}/draft`, demoDraft({ ...contact, syndicateId: ids.syndicate!, lead: acc().lead }, 'some'))
        } else ids.inReview = await submittedDeal(lead, contact)
      }
    },
    // each investor in through the lead-fee link, in the scenario's order: the lead's list shows them in the order they came
    async () => {
      const url = (await lead.call<{ url: string }>('GET', `/api/deals/${ids.live}/links/${ids.link}/url`)).url
      const token = new URLSearchParams(url.split('?')[1] ?? '').get('token')!
      s.investors.forEach((plan, i) => investors.push({ c: caller(10 + i), who: acc().investors[i]!, plan }))
      for (const x of investors) {
        await x.c.signIn(x.who.email, x.who.password)
        const opened = await x.c.send('POST', '/api/invite/open', { token })
        const invite = `bulma_invite=${opened.cookies.find((c) => c.name === 'bulma_invite')!.value}`
        const accepted = await x.c.call<{ results: Array<{ result: string }> }>('POST', '/api/invite/accept', {}, invite)
        if (accepted.results[0]?.result !== 'invited') throw new Error(`demo step invite: ${accepted.results[0]?.result ?? 'nothing to accept'}`)
      }
    },
    // then one investor at a time, walked to their stop, the longest in their step first: each one's last step comes after
    // everything the earlier ones did, so the export's clock gives each the days of the scenario (plan 05 §5.6)
    ...[...s.investors.keys()]
      .sort((i, j) => s.investors[j]!.daysAtStep - s.investors[i]!.daysAtStep)
      .map((i) => (run: string) => walkInvestor(run, investors[i]!)),
  ])
  return { runId, accounts: acc(), sampleFee, deals: { live: ids.live!, draft: ids.draft!, inReview: ids.inReview! } }

  /** Qualified, an entity with sample files, a commitment and a KYC check; then, by the stop, approved, signed, paid. */
  async function walkInvestor(run: string, x: (typeof investors)[number]): Promise<void> {
    await o.beforeInvestor?.(x.plan)
    await x.c.keepSignedIn()
    await qualify(x.c, db, run, x.who.name)
    x.entity = (
      await x.c.call<{ id: string }>('POST', '/api/entities', {
        type: 'individual',
        fields: { full_name: x.who.name, address: '1 Sample Street, Fictional Town', tax_residence: 'UK', tax_id: 'SAMPLE02' },
        parties: [],
      })
    ).id
    for (const [requirement, what] of [
      ['identity_proof', 'Proof of identity'],
      ['address_proof', 'Proof of address'],
      ['source_of_wealth', 'Source of wealth'],
    ] as const)
      await x.c.upload(
        `/api/entities/${x.entity}/files?requirement=${requirement}&name=${encodeURIComponent(`sample-${requirement}.pdf`)}`,
        await samplePdf(what, x.who.name),
      )
    const amount = String(x.plan.commitmentMinor)
    const q = await x.c.call<{ due_minor: string; terms_link_id: string }>('POST', `/api/my/deals/${ids.live}/quote`, { commitment_minor: amount })
    await x.c.call('POST', `/api/my/deals/${ids.live}/commit`, {
      entity_id: x.entity,
      commitment_minor: amount,
      quoted_due_minor: q.due_minor,
      terms_link_id: q.terms_link_id,
    })
    x.p = (await x.c.call<{ participations: Array<{ id: string }> }>('GET', `/api/my/deals/${ids.live}`)).participations[0]!.id
    await x.c.call('POST', `/api/entities/${x.entity}/kyc`, { path: 'manual', confirm_true: true })
    // the reviewer passes every check but Krillin's
    if (x.plan.stage === 'kyc_in_review') return
    await reviewer.keepSignedIn()
    const cases = (await reviewer.call<{ cases: Array<{ id: string; entity_id: string }> }>('GET', '/api/review/kyc')).cases
    const kyc = cases.find((c) => c.entity_id === x.entity)
    if (!kyc) throw new Error('demo step KYC: the check is not in the review queue')
    await reviewer.call('POST', `/api/review/kyc/${kyc.id}/decide`, { decision: 'approve' })
    // Goku and Tien sign and see how to pay; Tien's money is recorded
    if (x.plan.stage === 'to_sign') return
    const sheet = await x.c.call<{ document_sha256: string }>('GET', `/api/my/participations/${x.p}/deal-sheet`)
    await x.c.call('POST', `/api/my/participations/${x.p}/sign`, { agree: true, signed_name: x.who.name, document_sha256: sheet.document_sha256 })
    // as the payment page does: a receiving account not yet seen is confirmed first, then the details are issued
    const first = await x.c.call<{ acknowledge?: boolean; account_sha256?: string }>('GET', `/api/my/participations/${x.p}/instructions`)
    if (first.acknowledge) await x.c.call('POST', `/api/my/participations/${x.p}/acknowledge-account`, { account_sha256: first.account_sha256 })
    const pay = await x.c.call<{ due_minor?: string }>('GET', `/api/my/participations/${x.p}/instructions`)
    if (!pay.due_minor) throw new Error('demo step payment details: none were issued')
    if (x.plan.stage === 'funded')
      await reviewer.call('POST', `/api/review/participations/${x.p}/receipts`, {
        amount_minor: pay.due_minor,
        received_on: isoDay(0),
        payer_name: x.who.name,
        payer_account: '12345678',
      })
  }

  async function submittedDeal(by: Caller, c: { company: string; contact: string; contactEmail: string }): Promise<string> {
    const id = (await by.call<{ id: string }>('POST', '/api/deals', {})).id
    await by.call('PUT', `/api/deals/${id}/draft`, demoDraft({ ...c, syndicateId: ids.syndicate!, lead: acc().lead }, 'all'))
    await by.upload(
      `/api/deals/${id}/files?kind=legal&name=${encodeURIComponent('sample-subscription-terms.pdf')}`,
      await samplePdf('Subscription terms', c.company),
    )
    await by.call('POST', `/api/deals/${id}/submit`, {})
    return id
  }
}

/** The steps the seed's investors know how to walk before the deal. */
const WALKED: readonly StepKind[] = ['statement', 'assessment', 'warning_block']
const stepsBeforeDeal = (p: RegimePack): StepKind[] => {
  const kinds = p.steps.map((s) => s.kind)
  const at = kinds.indexOf('view_deal')
  return at < 0 ? kinds : kinds.slice(0, at)
}

/**
 * Through the eligibility routes, as the screens go, in the order of the run's own rules pack (the one a demo account's
 * eligibility reads): a signed statement at the pack's income threshold, the assessment if the pack has one, the warning.
 * The answers come from that pack, as a person who read the material would give them.
 */
async function qualify(c: Caller, db: Db, run: string, name: string): Promise<void> {
  const pack = await tx(db, async (q) => {
    const id = (await q.query<{ pack_id: string }>('SELECT pack_id FROM demo_run WHERE id = $1', [run])).rows[0]!.pack_id
    return (await packContent(q, id))!
  })
  const shown = async () => (await c.call<{ shown_sha256: string }>('GET', '/api/eligibility')).shown_sha256
  for (const kind of stepsBeforeDeal(pack)) {
    if (kind === 'statement') {
      // exactly at the threshold is always accepted, whatever the rounding (lib/eligibility.ts)
      const income = { yes: true, amount_minor: BigInt(pack.thresholds.hnw_income_minor).toString() } // a padded threshold is the same amount (Codex r2 #4)
      const answers = { category: 'high_net_worth', high_net_worth: { income, net_assets: { yes: false } } }
      await c.call('POST', '/api/eligibility/statement', { answers, signed_name: name, shown_sha256: await shown() })
    } else if (kind === 'assessment') {
      const a = await c.call<{ id: string; questions: Array<{ id: string }> }>('POST', '/api/eligibility/assessment/start', {})
      const chosen = Object.fromEntries(a.questions.map((q) => [q.id, pack.assessment.questions.find((r) => r.id === q.id)!.correct_option]))
      const passed = await c.call<{ passed: boolean }>('POST', '/api/eligibility/assessment/answer', { attempt_id: a.id, answers: chosen })
      if (!passed.passed) throw new Error('demo step eligibility: the assessment was not passed')
    } else if (kind === 'warning_block') {
      await c.call('POST', '/api/eligibility/warning', { kind: 'warning_block', decision: 'continue', shown_sha256: await shown() })
    } else throw new Error(`demo step eligibility: the step ${kind} is not one the demo walks`)
  }
}

/** Where the demo stands, for the instance page: the button shows only in the sandbox with no run adding or added. */
export async function demoState(c: Q): Promise<'none' | 'adding' | 'added' | null> {
  const mode = (await c.query<{ mode: string }>('SELECT mode FROM instance_profile WHERE id = 1')).rows[0]!.mode
  if (mode !== 'sandbox') return null
  const r = await c.query<{ state: 'adding' | 'added' }>("SELECT state FROM demo_run WHERE state IN ('adding', 'added')")
  return r.rows[0]?.state ?? 'none'
}

/** R-DEMO-08: the accounts to sign in as, shown once. Not the reviewer: it was made for the run alone and is already retired. */
export const demoSignIns = (a: DemoAccounts) => [
  { as: 'Lead', name: a.lead.name, email: a.lead.email, password: a.lead.password },
  ...a.investors.map((x) => ({ as: 'Investor', name: x.name, email: x.email, password: x.password })),
]

/**
 * R-DEMO-03: the instance page's "Add demo deal". The passwords go back in this one answer and are kept nowhere else (every
 * answer is sent `no-store`, app.ts). The real mode is refused by `demoSeedRefusals` with its reason.
 */
export function registerDemo(app: FastifyInstance, d: { db: Db; k: Keyring }) {
  app.post('/api/demo-deal', { config: { gate: 'canAdministerInstance' as const } }, async (req) => {
    const s = await seedDemo(app, d.db, d.k, { by: req.user!.id, via: 'button' })
    return { sign_ins: demoSignIns(s.accounts), sample_fee: s.sampleFee }
  })
}

/**
 * R-DEMO-03, R-DEMO-08: `BULMA_DEMO_DEAL=1` at start-up calls the same seed in-process: no route, no sign-in skipped. The
 * passwords go to a file only the process user can read; the log names the file, never a password. Ignored in the real
 * mode, and a restart with the demo already added adds nothing: either way one log line says why. Returns that line.
 */
export async function demoOnStart(app: FastifyInstance, db: Db, k: Keyring, o: { flag: string | undefined; file: string }): Promise<string | null> {
  if (o.flag !== '1') return null
  let s: Seeded
  try {
    s = await seedDemo(app, db, k, { by: null, via: 'env' })
  } catch (e) {
    if (e instanceof Refused) return `BULMA_DEMO_DEAL is ignored: ${e.message}`
    return `BULMA_DEMO_DEAL: adding the demo deal failed and the run was retired: ${e instanceof Error ? e.message : String(e)}`
  }
  const lines = demoSignIns(s.accounts).map((x) => `${x.as}\t${x.name}\t${x.email}\t${x.password}`)
  try {
    // a file left by an earlier run may be readable by others: it goes, and the new one is made private from the start
    await rm(o.file, { force: true })
    await writeFile(o.file, `# Bulma demo deal: sign-ins (sandbox only, fictional)\n${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' })
  } catch (e) {
    return `BULMA_DEMO_DEAL: the demo deal was added, but the sign-ins could not be written to ${o.file} (${(e as { code?: string }).code ?? 'error'})`
  }
  return `BULMA_DEMO_DEAL: the demo deal was added; the sign-ins are in ${o.file}`
}
