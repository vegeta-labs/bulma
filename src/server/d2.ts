// D2 routes and services: the deal wizard, review, content approval and launch (PRD §4.6, §4.7, §5.1). Rules stay in lib/; this is transactions.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Adapters } from '../adapters/index.ts'
import { z } from 'zod'
import { decideTransition, launchContentApproved, type DealEvent, type DealState } from '../lib/dealState.ts'
import {
  draftGaps,
  MAX_DEAL_AMOUNT_MINOR,
  draftNotices,
  draftProblems,
  realDate,
  reviewChecklist,
  sectionProgress,
  type CarryRecipient,
  type Draft,
  type DraftContext,
} from '../lib/draft.ts'
import type { FeeConfig } from '../lib/fees.ts'
import { raiseFor } from '../lib/estimate.ts'
import { canAdministerDeal, canApproveDealContent, canReviewDeal, isInterestedParty, type DealParties } from '../lib/gate.ts'
import type { Mode } from '../lib/instance.ts'
import { contentOf, diffContent, stableJson } from '../lib/snapshot.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { dealFiles, dealFolders, registerDealFiles } from './d2Files.ts'
import { investeeForReview, investeeProgress, registerInvestee, syncInvesteeCheck, toLead, type Mail } from './d2Investee.ts'
import type { MailQueue } from './outbox.ts'
import { dealTeam, registerSyndicates } from './d2Syndicate.ts'
import { adminTx, Refused, reviewerTx, type Ctx } from './requests.ts'
import { createDefaultLinks } from './d3Lead.ts'
import { registerChanges } from './d4Change.ts'

export interface D2Deps {
  db: Db
  k: Keyring
  now?: () => Date
  publicUrl?: string
  mail: MailQueue
  adapters: () => Promise<Adapters>
  uploadDeadlineMs?: number
  downloadDeadlineMs?: number
}

interface DealRow {
  id: string
  lead_user: string
  syndicate_id: string | null
  state: DealState
  draft: Draft
  draft_rev: number
  public_code: string
  target_close: string | null
  fee_config_id: string | null
  bound_floor_minor: string | null
  approved_at: Date | null
  approved_version: number | null
  deleted_at: Date | null
  updated_at: Date
}
type Q = Pick<Tx, 'query'>

const Uuid = z.uuid()
const S = z.string().max(20_000).nullable().optional()
const N = z.number().nullable().optional()
const B = z.boolean().nullable().optional()
const Recipient = z.strictObject({
  kind: S,
  first_name: S,
  last_name: S,
  email: S,
  trading_name: S,
  legal_name: S,
  registration_number: S,
  contact_name: S,
  contact_email: S,
  share_bps: N,
})
/** The shape only: a draft saves as typed, and `draftProblems` says what is wrong with it. */
const DraftBody = z.strictObject({
  basics: z
    .strictObject({ structure: S, deal_type: S, name: S, syndicate: z.strictObject({ mode: S, id: S, name: S, lead_entity_id: S }).nullable().optional() })
    .optional(),
  company: z.strictObject({ legal_name: S, website: S, contact_name: S, contact_email: S, jurisdiction: S, registration_number: S, address: S }).optional(),
  terms: z
    .strictObject({
      currency: S,
      seis: B,
      eis: B,
      round: S,
      instrument: S,
      share_class: S,
      share_price_micros: S,
      price_is_placeholder: B,
      pre_money_minor: S,
      cap_type: S,
      cap_minor: S,
      discount_bps: N,
      fund_description: S,
      round_size_minor: S,
      allocation_minor: S,
      over_allocation: S,
      min_commitment_minor: S,
      min_raise_minor: S,
      target_close: S,
      pay_by: S,
      voter: S,
      custom_terms: z.unknown().optional(),
    })
    .optional(),
  files: z.strictObject({ memo: z.unknown().optional(), deck: z.strictObject({ kind: S, url: S, embed_url: S }).nullable().optional() }).optional(),
  economics: z.strictObject({ default_carry_bps: N, recipients: z.array(Recipient).max(100).optional(), fee_payer: S }).optional(),
  attestations: z.strictObject({ board_and_shareholders: B, fund_mainly_unlisted: B }).optional(),
})
/** A decision says which content it is about (R-REV-03): what the person read, not whatever is there by the time it arrives. */
const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const Reason = z.strictObject({ reason: z.string().max(5_000), internal_note: z.string().max(5_000).optional(), reviewed_sha256: Hash })
const ApproveBody = z.strictObject({ internal_note: z.string().max(5_000).optional(), reviewed_sha256: Hash })
const DealConfigBody = z.strictObject({
  required_company_fields: z.array(z.enum(['registration_number', 'address'])).max(2),
  min_commitment_floor_minor: z
    .string()
    .regex(/^[1-9]\d{0,12}$/)
    .refine((v) => BigInt(v) <= MAX_DEAL_AMOUNT_MINOR, 'The minimum commitment cannot be above the largest allocation a deal can have.'),
  default_carry_bps: z.number().int().min(0).max(10_000),
  embed_hosts: z.array(z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/)).max(50),
  review_target_days: z.number().int().min(1).max(365),
  launch_confirm_days: z.number().int().min(1).max(365),
  draft_restore_days: z.number().int().min(1).max(3650),
  investee_link_days: z.number().int().min(1).max(365),
  investee_reminder_hours: z.number().int().min(1).max(8760),
  investee_valid_days: z.number().int().min(1).max(3650),
  content_approval_in_sandbox: z.boolean(),
  // D3: R-LNK-02, C-REF-1, R-LNK-09. Optional, so a client that does not know them leaves them as they are.
  link_fee_max_bps: z.number().int().min(0).max(5_000).optional(),
  reference_prefix: z
    .string()
    .regex(/^[A-Z]{2,4}$/)
    .optional(),
  eea_count_limit: z.number().int().min(1).max(100_000).optional(),
})
const ContentApproval = z.strictObject({
  content_sha256: Hash,
  self_declared_name: z.string().trim().min(1).max(200),
  self_declared_frn: z
    .string()
    .regex(/^\d{6,7}$/)
    .nullable()
    .optional(),
})
const Launch = z.strictObject({ confirm: z.literal(true), content_sha256: Hash })

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const randomCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const NOT_FOUND = 'Deal not found.'
/** No fee setting exists yet: a configuration that always refuses, so a deal with investors paying cannot get through on a guess. */
const NO_FEE_CONFIG: FeeConfig = { rate_bps: 0, min_minor: 1n, max_minor: 0n, surcharge_threshold_minor: 0n, surcharge_bps: 0 }

const REAL_SINCE = "coalesce((SELECT real_since FROM instance_profile WHERE id = 1), '-infinity'::timestamptz)"
const CHANGED = 'This deal has changed since you opened it. Open it again.'
const OLDER_COPY = 'Someone has changed this deal since you opened it. Open it again to see the changes.'
const lockInstance = (c: Q) => c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
const lockDeal = async (c: Q, id: string) =>
  (await c.query<DealRow>('SELECT * FROM deal WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0] ?? null

const personFields = (r: CarryRecipient) => {
  const { share_bps: _share, kind: _kind, ...fields } = r
  return fields
}

export async function partiesOf(c: Q, deal: Pick<DealRow, 'id' | 'lead_user' | 'syndicate_id' | 'draft'>): Promise<DealParties> {
  const team = (await c.query<{ user_id: string; role: string }>('SELECT user_id, role FROM deal_member WHERE deal_id = $1', [deal.id])).rows
  const syndicate = deal.syndicate_id
    ? (await c.query<{ user_id: string; role: string }>('SELECT user_id, role FROM syndicate_member WHERE syndicate_id = $1', [deal.syndicate_id])).rows
    : []
  const admins = syndicate.filter((m) => m.role === 'admin').map((m) => m.user_id)
  const stored = (
    await c.query<{ email: string | null; contact_email: string | null }>(
      "SELECT p.fields->>'email' AS email, p.fields->>'contact_email' AS contact_email FROM carry_recipient r JOIN person_version p ON p.id = r.person_version WHERE r.deal_id = $1",
      [deal.id],
    )
  ).rows
  // the working copy as well: a recipient typed since the last version still has a stake
  const typed = deal.draft.economics?.recipients ?? []
  // both fields, whichever kind the recipient claims to be: the address is what gives the stake
  const emails = [...stored, ...typed].flatMap((r) => [r.email, r.contact_email]).filter((e): e is string => typeof e === 'string' && e.length > 0)
  // a stake stays with the person, not with the address: someone who has since changed it is still the recipient
  const former = emails.length
    ? (
        await c.query<{ email: string }>(
          'SELECT u.email FROM user_email_history h JOIN user_account u ON u.id = h.user_id WHERE lower(h.email) = ANY($1::text[])',
          [emails.map((e) => e.toLowerCase())],
        )
      ).rows.map((r) => r.email)
    : []
  return {
    leadUserIds: [deal.lead_user, ...team.filter((m) => m.role === 'co_lead').map((m) => m.user_id), ...admins],
    memberUserIds: team.filter((m) => m.role === 'member').map((m) => m.user_id),
    carryRecipientEmails: [...emails, ...former],
    otherSyndicateMemberIds: syndicate.filter((m) => m.role !== 'admin').map((m) => m.user_id),
  }
}

interface DealConfig {
  enabled_structures: string[]
  required_company_fields: DraftContext['requiredCompanyFields'] extends readonly (infer T)[] ? T[] : never
  min_commitment_floor_minor: string
  default_carry_bps: number
  embed_hosts: string[]
  review_target_days: number
  launch_confirm_days: number
  draft_restore_days: number
  investee_link_days: number
  content_approval_in_sandbox: boolean
}
const dealConfig = async (c: Q) => (await c.query<DealConfig>('SELECT * FROM deal_config WHERE id = 1')).rows[0]!

/** Refer to people by version, so a snapshot holds no personal data and shows what was true at the time (R-PUB-02, tech design §3.1). */
async function snapshotOf(c: Q, dealId: string, d: Draft) {
  const known = new Map<string, string>()
  const rows = await c.query<{ id: string; fields: unknown }>(
    'SELECT p.id, p.fields FROM person_version p WHERE p.id IN (SELECT person_version FROM carry_recipient WHERE deal_id = $1 UNION SELECT contact_version FROM investee WHERE deal_id = $1)',
    [dealId],
  )
  for (const r of rows.rows) known.set(stableJson(r.fields), r.id)
  const person = async (fields: unknown) => {
    const key = stableJson(fields)
    let id = known.get(key)
    if (!id) {
      id = randomUUID()
      await c.query('INSERT INTO person_version (id, fields) VALUES ($1, $2)', [id, key])
      known.set(key, id)
    }
    return id
  }
  const content = contentOf(d) as { company?: Record<string, unknown>; economics?: Record<string, unknown> }
  const { contact_name, contact_email, ...company } = content.company ?? {}
  const contactVersion = await person({ contact_name, contact_email })
  const recipients = []
  for (const r of (content.economics?.recipients ?? []) as CarryRecipient[])
    recipients.push({ kind: r.kind, person_version: await person(personFields(r)), share_bps: r.share_bps })
  // the documents are part of what is reviewed: a replaced agreement is a changed deal (R-REV-03)
  const documents = (
    await c.query<{ requirement: string; display_name: string; sha256: string }>(
      "SELECT requirement, display_name, sha256 FROM stored_file WHERE scope = 'deal_shared' AND owner_id = $1 AND removed_at IS NULL ORDER BY sha256, display_name, requirement",
      [dealId],
    )
  ).rows
  // what the deal is bound to is part of what is reviewed: a new fee on resubmission is a changed deal
  const platformFee = (
    await c.query(
      'SELECT f.rate_bps, f.min_minor, f.max_minor, f.surcharge_threshold_minor, f.surcharge_bps FROM deal d JOIN fee_config f ON f.id = d.fee_config_id WHERE d.id = $1',
      [dealId],
    )
  ).rows[0]
  const terms = (content as { terms?: Record<string, unknown> }).terms
  const snapshot = {
    ...content,
    // blank means the operator's minimum: reviewed as a figure, so moving the minimum later cannot change what was approved
    terms: { ...terms, min_commitment_minor: terms?.min_commitment_minor ?? (await boundFloor(c, dealId)) },
    ...(platformFee ? { platform_fee: platformFee } : {}),
    files: { ...(content as { files?: object }).files, documents },
    company: { ...company, contact_version: contactVersion },
    economics: { ...content.economics, recipients },
  }
  return { snapshot, contactVersion, recipients }
}

/** The operator minimum this deal was submitted under, or today's for a deal not yet bound. */
const boundFloor = async (c: Q, dealId: string) =>
  (await c.query<{ bound_floor_minor: string | null }>('SELECT bound_floor_minor FROM deal WHERE id = $1', [dealId])).rows[0]?.bound_floor_minor ??
  (await dealConfig(c)).min_commitment_floor_minor

async function recordVersion(c: Q, deal: DealRow, d: Draft, kind: 'submitted' | 'edited' | 'approved', by: string | null) {
  if (kind === 'approved') {
    // what was approved is exactly the version that was reviewed, even if an operator setting has moved since
    const reviewed = (
      await c.query<{ n: number; sha256: string; snapshot: unknown }>(
        'SELECT n, sha256, snapshot FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1',
        [deal.id],
      )
    ).rows[0]!
    const n = reviewed.n + 1
    await c.query('INSERT INTO deal_version (deal_id, n, snapshot, sha256, kind, approved_by) VALUES ($1, $2, $3, $4, $5, $6)', [
      deal.id,
      n,
      stableJson(reviewed.snapshot),
      reviewed.sha256,
      kind,
      by,
    ])
    return { n, sha256: reviewed.sha256, contactVersion: '' }
  }
  const { snapshot, contactVersion, recipients } = await snapshotOf(c, deal.id, d)
  const hash = sha(stableJson(snapshot))
  const latest = (await c.query<{ n: number; sha256: string }>('SELECT n, sha256 FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1', [deal.id]))
    .rows[0]
  await c.query('DELETE FROM carry_recipient WHERE deal_id = $1', [deal.id])
  for (const r of recipients)
    await c.query('INSERT INTO carry_recipient (id, deal_id, kind, person_version, share_bps) VALUES ($1, $2, $3, $4, $5)', [
      randomUUID(),
      deal.id,
      r.kind,
      r.person_version,
      r.share_bps,
    ])
  if (latest && latest.sha256 === hash) return { n: latest.n, sha256: hash, contactVersion }
  const n = (latest?.n ?? 0) + 1
  await c.query('INSERT INTO deal_version (deal_id, n, snapshot, sha256, kind, approved_by) VALUES ($1, $2, $3, $4, $5, $6)', [
    deal.id,
    n,
    stableJson(snapshot),
    hash,
    kind,
    null,
  ])
  return { n, sha256: hash, contactVersion }
}

const logEvent = (
  c: Q,
  dealId: string,
  from: DealState,
  to: DealState,
  event: string,
  actor: string | null,
  o: { reason?: string; note?: string; n?: number } = {},
) =>
  c.query(
    'INSERT INTO review_event (id, deal_id, from_state, to_state, actor, event, reason, internal_note, version_n) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [randomUUID(), dealId, from, to, actor, event, o.reason ?? null, o.note ?? null, o.n ?? null],
  )

/** A snapshot with the people put back, for showing to someone allowed to see the deal. */
export async function expand(c: Q, snapshot: Record<string, unknown>) {
  const s = snapshot as { company?: Record<string, unknown>; economics?: { recipients?: Array<Record<string, unknown>> } }
  const ids = [s.company?.contact_version, ...(s.economics?.recipients ?? []).map((r) => r.person_version)].filter((x): x is string => typeof x === 'string')
  const rows = (await c.query<{ id: string; fields: Record<string, unknown> }>('SELECT id, fields FROM person_version WHERE id = ANY($1::uuid[])', [ids])).rows
  const byId = new Map(rows.map((r) => [r.id, r.fields]))
  const { contact_version, ...company } = s.company ?? {}
  return {
    ...s,
    company: { ...company, ...byId.get(String(contact_version)) },
    economics: {
      ...s.economics,
      recipients: (s.economics?.recipients ?? []).map(({ person_version, ...r }) => ({ ...r, ...byId.get(String(person_version)) })),
    },
  }
}

/** The minimum commitment the last version was reviewed with, a blank having been fixed as a figure then. */
const effectiveMinimum = async (c: Q, dealId: string) =>
  (
    await c.query<{ m: string | null }>("SELECT snapshot->'terms'->>'min_commitment_minor' AS m FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1", [
      dealId,
    ])
  ).rows[0]?.m ?? null

/** What the last change of content altered; a later approval of the same content is not a change. */
async function latestVersion(c: Q, dealId: string) {
  return (await c.query<{ n: number; sha256: string }>('SELECT n, sha256 FROM deal_version WHERE deal_id = $1 ORDER BY n DESC LIMIT 1', [dealId])).rows[0]
}

async function latestChanges(c: Q, dealId: string) {
  const versions = (
    await c.query<{ snapshot: Record<string, unknown>; sha256: string }>('SELECT snapshot, sha256 FROM deal_version WHERE deal_id = $1 ORDER BY n DESC', [
      dealId,
    ])
  ).rows
  const latest = versions[0]
  const before = versions.find((v) => v.sha256 !== latest?.sha256)
  return latest && before ? diffContent(await expand(c, before.snapshot), await expand(c, latest.snapshot)) : []
}

export async function lapseApprovals(db: Db, k: Keyring, now: Date): Promise<number> {
  const due = (
    await db.query<{ id: string }>(
      "SELECT d.id FROM deal d CROSS JOIN deal_config c WHERE d.state = 'approved' AND d.approved_at + make_interval(days => c.launch_confirm_days) <= $1::timestamptz",
      [now.toISOString()],
    )
  ).rows
  let done = 0
  for (const { id } of due) {
    done += await tx(db, async (c) => {
      const deal = await lockDeal(c, id)
      if (!deal) return 0
      const r = decideTransition(deal.state, 'lapse', {
        actor: 'system',
        now,
        approvedAt: deal.approved_at ?? undefined,
        confirmDays: (await dealConfig(c)).launch_confirm_days,
      })
      if (!r.ok) return 0
      await c.query('UPDATE deal SET state = $2, approved_at = NULL, approved_version = NULL WHERE id = $1', [id, r.to])
      await logEvent(c, id, deal.state, r.to, 'lapse', null)
      await appendAudit(c, k, { actor: 'system', action: 'deal.approval_lapsed', entity: id })
      return 1
    })
  }
  return done
}

export function registerD2(app: FastifyInstance, d: D2Deps) {
  const x: Ctx = { db: d.db, k: d.k }
  const now = () => d.now?.() ?? new Date()
  const verified = { config: { gate: 'verified' as const } }
  const reviewer = { config: { gate: 'canReviewDeals' as const } }
  const approver = { config: { gate: 'canApproveContent' as const } }
  const linkTo = (path: string) => `${d.publicUrl ?? ''}${path}`
  const today = () => now().toISOString().slice(0, 10)
  const queueAll = async (c: Q, mails: Mail[]) => {
    for (const m of mails) await d.mail.queue(c, m)
  }

  /** After the deal is held, always in that order: who is in the syndicate cannot change while a decision depends on it. */
  async function holdSyndicate(c: Q, deal: Pick<DealRow, 'syndicate_id' | 'draft'>) {
    const s = deal.draft.basics?.syndicate as { mode?: string; id?: string } | undefined
    // the one it was in and the one it is moving to, in a fixed order so two requests cannot wait on each other
    const ids = [...new Set([deal.syndicate_id, s?.mode === 'existing' ? s.id : null])].filter((x): x is string => !!x && Uuid.safeParse(x).success).sort()
    for (const id of ids) await c.query('SELECT 1 FROM syndicate WHERE id = $1 FOR SHARE', [id])
  }

  const floorOf = (deal: Pick<DealRow, 'state' | 'bound_floor_minor'>, cfg: DealConfig) =>
    (deal.state === 'draft' ? null : deal.bound_floor_minor) ?? cfg.min_commitment_floor_minor

  /** The fee the deal is bound to once submitted; before that, the one in force. A later change by the operator must not move the rules under a deal. */
  async function feeFor(c: Q, deal: Pick<DealRow, 'state' | 'fee_config_id'>) {
    const bound = deal.state === 'draft' ? null : deal.fee_config_id
    return (
      await c.query<{ id: string; rate_bps: number; min_minor: string; max_minor: string; surcharge_threshold_minor: string; surcharge_bps: number }>(
        `SELECT id, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps FROM fee_config ${bound ? 'WHERE id = $1' : 'ORDER BY version DESC LIMIT 1'}`,
        bound ? [bound] : [],
      )
    ).rows[0]
  }

  /** For a write by whoever runs the deal. Everything is judged again once the deal is held. */
  function leadTx<T>(who: SessionUser, id: string, fn: (c: Tx, deal: DealRow) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await lockInstance(c)
      const deal = await lockDeal(c, id)
      if (deal) await holdSyndicate(c, deal)
      // after the waiting: a session or a membership that ended while this request queued must count as ended
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      // the same words as for a deal that does not exist, so an id cannot be tested
      if (!deal || !(await partiesOf(c, deal)).leadUserIds.includes(who.id)) throw new Refused(NOT_FOUND)
      return fn(c, deal)
    })
  }

  async function contextFor(c: Q, deal: DealRow): Promise<DraftContext> {
    const cfg = await dealConfig(c)
    const fee = await feeFor(c, deal)
    const syndicates = await c.query<{ id: string }>(
      "SELECT s.id FROM syndicate s JOIN syndicate_member m ON m.syndicate_id = s.id WHERE m.user_id = $1 AND m.role = 'admin' AND s.status = 'active'",
      [deal.lead_user],
    )
    // decision R13: what was made in the sandbox does not count once the instance is real
    const entities = await c.query<{ id: string }>(`SELECT id FROM legal_entity WHERE owner_user = $1 AND created_at >= ${REAL_SINCE}`, [deal.lead_user])
    const files = (
      await c.query<{ requirement: string }>(
        `SELECT requirement FROM stored_file WHERE scope = 'deal_shared' AND owner_id = $1 AND removed_at IS NULL AND scan_status = 'clean' AND created_at >= ${REAL_SINCE}`,
        [deal.id],
      )
    ).rows
    return {
      today: today(),
      enabledStructures: cfg.enabled_structures,
      requiredCompanyFields: cfg.required_company_fields,
      minCommitmentFloorMinor: BigInt(floorOf(deal, cfg)),
      feeConfig: fee
        ? {
            rate_bps: fee.rate_bps,
            min_minor: BigInt(fee.min_minor),
            max_minor: BigInt(fee.max_minor),
            surcharge_threshold_minor: BigInt(fee.surcharge_threshold_minor),
            surcharge_bps: fee.surcharge_bps,
          }
        : NO_FEE_CONFIG,
      embedHosts: cfg.embed_hosts,
      adminSyndicateIds: syndicates.rows.map((r) => r.id),
      ownedEntityIds: entities.rows.map((r) => r.id),
      cleanLegalFiles: files.filter((f) => f.requirement === 'legal').length,
      cleanDeckFile: files.some((f) => f.requirement === 'deck'),
    }
  }
  const problemsOf = async (c: Q, deal: DealRow) => draftProblems(deal.draft, await contextFor(c, deal))

  const targetClose = (draft: Draft) => (realDate(draft.terms?.target_close) ? draft.terms!.target_close! : null)

  function decided(from: DealState, event: DealEvent, facts: Parameters<typeof decideTransition>[2]): DealState {
    const r = decideTransition(from, event, facts)
    if (!r.ok) throw new Refused(r.reason)
    return r.to
  }

  /** Creates the syndicate a draft only described, now that the deal is really being submitted (R-SYN-02). */
  async function settleSyndicate(c: Q, deal: DealRow, who: string): Promise<{ syndicateId: string; draft: Draft }> {
    const s = deal.draft.basics?.syndicate as { mode?: string; id?: string; name?: string; lead_entity_id?: string }
    if (s.mode === 'existing') return { syndicateId: s.id!, draft: deal.draft }
    const id = randomUUID()
    const slug = `${
      s
        .name!.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'syndicate'
    }-${randomBytes(3).toString('hex')}`
    await c.query('INSERT INTO syndicate (id, name, slug, lead_entity, created_by) VALUES ($1, $2, $3, $4, $5)', [
      id,
      s.name!.trim(),
      slug,
      s.lead_entity_id,
      who,
    ])
    await c.query("INSERT INTO syndicate_member (syndicate_id, user_id, role) VALUES ($1, $2, 'admin')", [id, deal.lead_user])
    await appendAudit(c as Tx, d.k, { actor: who, action: 'syndicate.created', entity: id })
    return { syndicateId: id, draft: { ...deal.draft, basics: { ...deal.draft.basics, syndicate: { mode: 'existing', id } } } }
  }

  /** The company check, kept in step with the deal, and any co-lead not yet told (R-DRF-11). */
  async function submissionMails(c: Q, deal: DealRow, draft: Draft, contactVersion: string): Promise<Mail[]> {
    const coLeads = (
      await c.query<{ id: string; email: string }>(
        "UPDATE deal_member m SET notified_at = now() FROM user_account u WHERE u.id = m.user_id AND m.deal_id = $1 AND m.role = 'co_lead' AND m.notified_at IS NULL RETURNING u.id, u.email",
        [deal.id],
      )
    ).rows
    const invites: Mail[] = coLeads.map((u) => ({
      audience: { kind: 'lead', userId: u.id, dealId: deal.id },
      to: u.email,
      subject: 'You are a co-lead on a deal',
      body: 'A deal you co-lead has been submitted for review. You can see it in your list of deals.',
    }))
    return [...(await syncInvesteeCheck(c, { k: d.k, now, linkTo }, deal, draft, contactVersion)), ...invites]
  }

  const canEdit = (s: DealState) => s === 'draft' || s === 'changes_requested' || s === 'in_review' || s === 'approved'

  app.post('/api/deals', verified, async (req) => {
    const id = randomUUID()
    return tx(d.db, async (c) => {
      await lockInstance(c)
      if (!(await sessionStillLive(c, req.user!.sessionHmac, req.user!.id))) throw new Refused('Your session has ended.')
      await c.query('INSERT INTO deal (id, lead_user, public_code) VALUES ($1, $2, $3)', [id, req.user!.id, randomCode()])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.draft_created', entity: id })
      return { id }
    })
  })

  app.get('/api/deals', verified, async (req) => {
    const rows = (
      await d.db.query<{
        id: string
        state: DealState
        public_code: string
        name: string | null
        updated_at: Date
        deleted_at: Date | null
        restore_until: Date | null
      }>(
        `SELECT d.id, d.state, d.public_code, d.draft->'basics'->>'name' AS name, d.updated_at, d.deleted_at, d.deleted_at + make_interval(days => c.draft_restore_days) AS restore_until
       FROM deal d CROSS JOIN deal_config c
       WHERE (d.lead_user = $1 OR EXISTS (SELECT 1 FROM deal_member m WHERE m.deal_id = d.id AND m.user_id = $1) OR EXISTS (SELECT 1 FROM syndicate_member s WHERE s.syndicate_id = d.syndicate_id AND s.user_id = $1 AND s.role = 'admin'))
         AND (d.deleted_at IS NULL OR d.deleted_at + make_interval(days => c.draft_restore_days) > $2::timestamptz)
       ORDER BY d.updated_at DESC LIMIT 500`,
        [req.user!.id, now().toISOString()],
      )
    ).rows
    return { deals: rows }
  })

  app.get<{ Params: { id: string } }>('/api/deals/:id', verified, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const deal = (await d.db.query<DealRow>('SELECT * FROM deal WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0]
    if (!deal || !canAdministerDeal(req.user, await partiesOf(d.db, deal))) return reply.code(404).send({ error: NOT_FOUND })
    const problems = await problemsOf(d.db, deal)
    const cfg = await dealConfig(d.db)
    const { id: _feeId, ...fee } = (await feeFor(d.db, deal)) ?? { id: null }
    const parties = await partiesOf(d.db, deal)
    // never the internal note, and not who the reviewer was (R-REV-02)
    const events = (await d.db.query('SELECT event, from_state, to_state, reason, created_at FROM review_event WHERE deal_id = $1 ORDER BY created_at', [id]))
      .rows
    return {
      id,
      state: deal.state,
      public_code: deal.public_code,
      draft: deal.draft,
      problems,
      progress: sectionProgress(problems),
      notices: draftNotices(deal.draft),
      events,
      changes: await latestChanges(d.db, id),
      files: await dealFiles(d.db, id),
      folders: await dealFolders(d.db, id),
      team: await dealTeam(d.db, id),
      investee: await investeeProgress(d.db, id),
      draft_rev: deal.draft_rev,
      effective_min_commitment_minor: deal.state === 'draft' ? null : await effectiveMinimum(d.db, id),
      approved_sha256:
        deal.approved_version === null
          ? null
          : ((await d.db.query<{ sha256: string }>('SELECT sha256 FROM deal_version WHERE deal_id = $1 AND n = $2', [id, deal.approved_version])).rows[0]
              ?.sha256 ?? null),
      // the version a change after launch is made on (R-CHG-01)
      approved_version: deal.approved_version,
      review_target_days: cfg.review_target_days,
      // what the wizard must show a lead, who cannot read the operator's own settings
      settings: {
        enabled_structures: cfg.enabled_structures,
        required_company_fields: cfg.required_company_fields,
        min_commitment_floor_minor: floorOf(deal, cfg),
        default_carry_bps: cfg.default_carry_bps,
        draft_restore_days: cfg.draft_restore_days,
        embed_hosts: cfg.embed_hosts,
        fee: 'rate_bps' in fee ? fee : null,
      },
      can_edit: canEdit(deal.state) && parties.leadUserIds.includes(req.user!.id),
      can_manage: parties.leadUserIds.includes(req.user!.id),
    }
  })

  // R-ADM-03, decision R28 (7): how much to raise so that X reaches the company, platform fee and surcharge only, an estimate.
  // The deal's own fee (bound once submitted) and payer (the approved version's once there is one, else the saved draft's).
  app.post<{ Params: { id: string } }>('/api/deals/:id/calculator', verified, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const { target_minor } = z.strictObject({ target_minor: z.string().regex(/^[1-9][0-9]{0,15}$/) }).parse(req.body)
    const deal = (await d.db.query<DealRow>('SELECT * FROM deal WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0]
    if (!deal || !canAdministerDeal(req.user!, await partiesOf(d.db, deal))) return reply.code(404).send({ error: NOT_FOUND })
    const f = await feeFor(d.db, deal)
    if (!f) throw new Refused('The operator has not set a platform fee yet.')
    const approved =
      deal.approved_version === null
        ? null
        : (await d.db.query<{ snapshot: Draft }>('SELECT snapshot FROM deal_version WHERE deal_id = $1 AND n = $2', [id, deal.approved_version])).rows[0]
            ?.snapshot
    const payer = (approved ?? deal.draft)?.economics?.fee_payer
    if (payer !== 'investors' && payer !== 'lead' && payer !== 'company') throw new Refused('Choose who pays the platform fee first.')
    const config = { ...f, min_minor: BigInt(f.min_minor), max_minor: BigInt(f.max_minor), surcharge_threshold_minor: BigInt(f.surcharge_threshold_minor) }
    const r = raiseFor(config, payer, BigInt(target_minor))
    if (!r) throw new Refused('With this platform fee no amount raised can leave that much for the company.')
    return {
      payer,
      target_minor,
      raise_minor: String(r.raise),
      fee_minor: String(r.fee),
      net_minor: String(r.net),
      estimate: true,
      note:
        payer === 'investors'
          ? 'An estimate of the platform fee and surcharge only: lead fees, rounding and scale-back are not in it, and the final figures come at close.'
          : payer === 'company'
            ? 'An estimate of the platform fee and surcharge only: the company pays the fee out of what it is paid, so more must be raised; the final figures come at close.'
            : 'An estimate: the lead pays the platform fee on top, so it is not taken from investors or the company.',
    }
  })

  app.put<{ Params: { id: string }; Querystring: { autosave?: string; base?: string } }>('/api/deals/:id/draft', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const typed = DraftBody.parse(req.body) as unknown as Draft
    const autosave = req.query.autosave === '1'
    const base = req.query.base === undefined ? null : z.coerce.number().int().min(0).parse(req.query.base)
    const saved = await leadTx(req.user!, id, async (c, deal) => {
      if (!canEdit(deal.state)) throw new Refused('This deal can no longer be edited here.')
      // a page holds the whole draft: saved from an older copy, it would quietly undo what someone else wrote
      if (base !== null && base !== deal.draft_rev) throw new Refused(OLDER_COPY)
      // restarting a review is something a person asks for: a page left open must not do it by saving in the background
      if (autosave && (deal.state === 'in_review' || deal.state === 'approved')) throw new Refused('This deal has been submitted. Open it again to change it.')
      // once submitted the deal belongs to its syndicate; only a draft can move to another
      const body: Draft = deal.state === 'draft' ? typed : { ...typed, basics: { ...typed.basics, syndicate: deal.draft.basics?.syndicate } }
      if (deal.state === 'draft') {
        const existing = (b: Draft) => {
          const s = b.basics?.syndicate as { mode?: string; id?: string } | undefined
          return s?.mode === 'existing' && s.id && Uuid.safeParse(s.id).success ? s.id : null
        }
        const moved = existing(body)
        // the destination too, before asking who is in it: someone removed from it right now must not stay on this deal
        await holdSyndicate(c, { syndicate_id: null, draft: body })
        // a withdrawn deal is back to being a draft: the syndicate it left has no say over it, and submitting sets the new one
        if (deal.syndicate_id && deal.syndicate_id !== moved) await c.query('UPDATE deal SET syndicate_id = NULL WHERE id = $1', [id])
        // people assigned through the old syndicate do not come along
        if (existing(deal.draft) !== moved) {
          if (moved)
            await c.query('DELETE FROM deal_member WHERE deal_id = $1 AND user_id NOT IN (SELECT user_id FROM syndicate_member WHERE syndicate_id = $2)', [
              id,
              moved,
            ])
          else await c.query('DELETE FROM deal_member WHERE deal_id = $1', [id])
        }
      }
      // a deck no longer chosen must not stay on as a document anyone can open
      const deckDropped =
        body.files?.deck?.kind !== 'file' &&
        !!(
          await c.query(
            "UPDATE stored_file SET removed_at = now() WHERE scope = 'deal_shared' AND owner_id = $1 AND requirement = 'deck' AND removed_at IS NULL",
            [id],
          )
        ).rowCount
      const changedContent = deckDropped || stableJson(contentOf(deal.draft)) !== stableJson(contentOf(body))
      const next: DealRow = { ...deal, draft: body }
      let state: DealState = deal.state
      let mails: Mail[] = []
      if (deal.state === 'in_review' || deal.state === 'approved') {
        // judged even when the content is the same: taking back a confirmation changes no content, and is still not allowed here
        const to = decided(deal.state, 'lead_edit', { actor: 'lead', now: now(), gaps: draftGaps(await problemsOf(c, next)) })
        if (changedContent) {
          state = to
          const v = await recordVersion(c, next, body, 'edited', null)
          await recordAttestations(c, next, body, req.user!.id, v.n)
          await c.query('UPDATE deal SET state = $2, approved_at = NULL, approved_version = NULL WHERE id = $1', [id, state])
          await logEvent(c, id, deal.state, state, 'lead_edit', req.user!.id, { n: v.n })
          await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.edited_in_review', entity: id })
          mails = await syncInvesteeCheck(c, { k: d.k, now, linkTo }, next, body, v.contactVersion)
        }
      }
      await c.query('UPDATE deal SET draft = $2, state = $3, target_close = $4, updated_at = $5::timestamptz, draft_rev = draft_rev + 1 WHERE id = $1', [
        id,
        stableJson(body),
        state,
        targetClose(body),
        now().toISOString(),
      ])
      await queueAll(c, mails)
      return { state, rev: deal.draft_rev + 1 }
    })
    await d.mail.flush()
    return { state: saved.state, rev: saved.rev }
  })

  app.delete<{ Params: { id: string } }>('/api/deals/:id', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    return leadTx(req.user!, id, async (c, deal) => {
      if (deal.state !== 'draft') throw new Refused('Only a draft can be deleted.')
      await c.query('UPDATE deal SET deleted_at = $2::timestamptz WHERE id = $1', [id, now().toISOString()])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.draft_deleted', entity: id })
      return { ok: true }
    })
  })

  app.post<{ Params: { id: string } }>('/api/deals/:id/restore', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    return tx(d.db, async (c) => {
      await lockInstance(c)
      if (!(await sessionStillLive(c, req.user!.sessionHmac, req.user!.id))) throw new Refused('Your session has ended.')
      const deal = (await c.query<DealRow>('SELECT * FROM deal WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE', [id])).rows[0]
      if (!deal || !(await partiesOf(c, deal)).leadUserIds.includes(req.user!.id)) throw new Refused(NOT_FOUND)
      if (now().getTime() >= deal.deleted_at!.getTime() + (await dealConfig(c)).draft_restore_days * 86_400_000)
        throw new Refused('The time to restore this draft has passed.')
      await c.query('UPDATE deal SET deleted_at = NULL WHERE id = $1', [id])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.draft_restored', entity: id })
      return { ok: true }
    })
  })

  const recordAttestations = async (c: Q, deal: DealRow, draft: Draft, who: string, n: number) => {
    await c.query("INSERT INTO lead_attestation (id, deal_id, kind, actor, version_n) VALUES ($1, $2, 'board_and_shareholders', $3, $4)", [
      randomUUID(),
      deal.id,
      who,
      n,
    ])
    if (draft.terms?.instrument === 'fund_units')
      await c.query("INSERT INTO lead_attestation (id, deal_id, kind, actor, version_n) VALUES ($1, $2, 'fund_mainly_unlisted', $3, $4)", [
        randomUUID(),
        deal.id,
        who,
        n,
      ])
  }

  app.post<{ Params: { id: string } }>('/api/deals/:id/submit', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const shown = z.strictObject({ base: z.number().int().min(0).optional(), file_ids: z.array(Uuid).max(1_000).optional() }).parse(req.body ?? {})
    const { result } = await leadTx(req.user!, id, async (c, deal) => {
      // the confirmations are about what the page showed: not what a co-lead has since written or uploaded
      if (shown.base !== undefined && shown.base !== deal.draft_rev) throw new Refused(OLDER_COPY)
      if (shown.file_ids) {
        const held = (await dealFiles(c, id)).map((f) => f.id as string).sort()
        if (stableJson(held) !== stableJson([...shown.file_ids].sort())) throw new Refused(OLDER_COPY)
      }
      const to = decided(deal.state, deal.state === 'changes_requested' ? 'resubmit' : 'submit', {
        actor: 'lead',
        now: now(),
        gaps: draftGaps(await problemsOf(c, deal)),
      })
      const { syndicateId, draft } = await settleSyndicate(c, deal, req.user!.id)
      const feeId = (await feeFor(c, deal))?.id
      if (!feeId) throw new Refused('The operator has not set the platform fee yet.')
      // people on the team of another syndicate do not come along when a draft moves
      await c.query('DELETE FROM deal_member WHERE deal_id = $1 AND user_id NOT IN (SELECT user_id FROM syndicate_member WHERE syndicate_id = $2)', [
        id,
        syndicateId,
      ])
      const at = now().toISOString()
      await c.query(
        'UPDATE deal SET state = $2, draft = $3, syndicate_id = $4, fee_config_id = $5, target_close = $6, submitted_at = $7::timestamptz, bound_floor_minor = $8, updated_at = $7::timestamptz, draft_rev = draft_rev + 1 WHERE id = $1',
        [
          id,
          to,
          stableJson(draft),
          syndicateId,
          feeId,
          targetClose(draft),
          at,
          deal.state === 'draft' ? (await dealConfig(c)).min_commitment_floor_minor : floorOf(deal, await dealConfig(c)),
        ],
      )
      const v = await recordVersion(c, deal, draft, 'submitted', null)
      await recordAttestations(c, deal, draft, req.user!.id, v.n)
      await logEvent(c, id, deal.state, to, deal.state === 'changes_requested' ? 'resubmit' : 'submit', req.user!.id, { n: v.n })
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.submitted', entity: id })
      await queueAll(c, await submissionMails(c, deal, draft, v.contactVersion))
      return { result: { state: to } }
    })
    await d.mail.flush()
    return result
  })

  app.post<{ Params: { id: string } }>('/api/deals/:id/withdraw', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    return leadTx(req.user!, id, async (c, deal) => {
      const to = decided(deal.state, 'withdraw', { actor: 'lead', now: now() })
      await c.query('UPDATE deal SET state = $2, updated_at = $3::timestamptz WHERE id = $1', [id, to, now().toISOString()])
      await logEvent(c, id, deal.state, to, 'withdraw', req.user!.id)
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.withdrawn', entity: id })
      return { state: to }
    })
  })

  app.post<{ Params: { id: string } }>('/api/deals/:id/launch', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const launch = Launch.parse(req.body)
    return leadTx(req.user!, id, async (c, deal) => {
      const cfg = await dealConfig(c)
      const inst = (
        await c.query<{ mode: Mode; active_pack_id: string | null; real_since: Date | null }>(
          'SELECT mode, active_pack_id, real_since FROM instance_profile WHERE id = 1',
        )
      ).rows[0]!
      const version =
        deal.approved_version === null
          ? undefined
          : (await c.query<{ sha256: string }>('SELECT sha256 FROM deal_version WHERE deal_id = $1 AND n = $2', [id, deal.approved_version])).rows[0]
      const approvals = (
        await c.query<{ content_sha256: string }>(
          "SELECT content_sha256 FROM promotion_approval WHERE subject_kind = 'deal_version' AND subject_id = $1 AND created_at >= coalesce((SELECT real_since FROM instance_profile WHERE id = 1), '-infinity'::timestamptz)",
          [`${id}:${deal.approved_version}`],
        )
      ).rows
      const contentApproved =
        !!version &&
        launchContentApproved({
          mode: inst.mode,
          requiredInSandbox: cfg.content_approval_in_sandbox,
          contentSha256: version.sha256,
          approvedSha256: approvals.map((a) => a.content_sha256),
        })
      const to = decided(deal.state, 'launch', {
        actor: 'lead',
        now: now(),
        approvedAt: deal.approved_at ?? undefined,
        confirmDays: cfg.launch_confirm_days,
        contentApproved,
        leadConfirmed: true,
      })
      // the lead confirms what the page showed them: another version approved meanwhile is not what they agreed to
      if (version && version.sha256 !== launch.content_sha256) throw new Refused(CHANGED)
      // decision R13: a review done in the sandbox does not count once the instance is real
      if (inst.real_since && deal.approved_at!.getTime() < inst.real_since.getTime())
        throw new Refused('This deal was approved in the sandbox. It must be reviewed again.')
      // a stake taken on after the decision undoes it as surely as one held before (R-REV-04)
      const deciders = await c.query<{ id: string; email: string }>(
        "SELECT u.id, u.email FROM user_account u WHERE u.id IN (SELECT approved_by FROM deal_version WHERE deal_id = $1 AND n = $2 UNION SELECT approver_user FROM promotion_approval WHERE subject_kind = 'deal_version' AND subject_id = $3)",
        [id, deal.approved_version, `${id}:${deal.approved_version}`],
      )
      const parties = await partiesOf(c, deal)
      if (deciders.rows.some((u) => isInterestedParty(u, parties)))
        throw new Refused('Someone who approved this deal now has a stake in it. It must be reviewed again.')
      if (!inst.active_pack_id) throw new Refused('No rule pack is active.')
      if (!deal.fee_config_id) throw new Refused('The operator has not set the platform fee yet.')
      // R-OP-04.2: the pack in force now stays with this deal
      await c.query('UPDATE deal SET state = $2, pack_id = $3, went_live_at = $4::timestamptz, updated_at = $4::timestamptz WHERE id = $1', [
        id,
        to,
        inst.active_pack_id,
        now().toISOString(),
      ])
      await logEvent(c, id, deal.state, to, 'launch', req.user!.id, { n: deal.approved_version ?? undefined })
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.launched', entity: id })
      // R-LNK-02: the two default links come with launch, in the same transaction
      await createDefaultLinks(c, d.k, id, deal.draft.economics?.default_carry_bps ?? 0, req.user!.id)
      return { state: to }
    })
  })

  // Review (R-REV-01 to R-REV-04)
  app.get('/api/review/deals', reviewer, async (req) => {
    const rows = (
      await d.db.query<DealRow & { submitted_at: Date }>(
        "SELECT * FROM deal WHERE state = 'in_review' AND deleted_at IS NULL ORDER BY target_close ASC NULLS LAST, submitted_at ASC, id LIMIT 500",
      )
    ).rows
    const out = []
    for (const r of rows)
      out.push({
        id: r.id,
        public_code: r.public_code,
        name: r.draft.basics?.name ?? null,
        target_close: r.target_close,
        submitted_at: r.submitted_at,
        can_review: canReviewDeal(req.user, req.user!.email, await partiesOf(d.db, r)),
      })
    return { deals: out }
  })

  app.get<{ Params: { id: string } }>('/api/review/deals/:id', reviewer, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const page = await tx(d.db, async (c) => {
      // one view of the database for the whole page, so the hash a decision will name is the hash of exactly what is shown
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const deal = (await c.query<DealRow>('SELECT * FROM deal WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0]
      // the page holds internal notes and the company's documents: not for someone with a stake, and a draft has not been submitted to anyone
      if (!deal || deal.state === 'draft' || !canReviewDeal(req.user, req.user!.email, await partiesOf(c, deal))) return null
      const events = (
        await c.query('SELECT event, from_state, to_state, actor, reason, internal_note, created_at FROM review_event WHERE deal_id = $1 ORDER BY created_at', [
          id,
        ])
      ).rows
      return {
        id,
        state: deal.state,
        public_code: deal.public_code,
        draft: deal.draft,
        checklist: reviewChecklist(deal.draft),
        files: await dealFiles(c, id),
        investee: await investeeForReview(c, id),
        events,
        changes: await latestChanges(c, id),
        latest_sha256: (await latestVersion(c, id))?.sha256 ?? null,
        platform_fee: await feeFor(c, deal),
        effective_min_commitment_minor: await effectiveMinimum(c, id),
        can_review: true,
      }
    })
    return page ?? reply.code(404).send({ error: NOT_FOUND })
  })

  function reviewRoute(path: string, event: 'approve' | 'request_changes' | 'reject', action: string) {
    app.post<{ Params: { id: string } }>(`/api/review/deals/:id/${path}`, reviewer, async (req) => {
      const id = Uuid.parse(req.params.id)
      const body = event === 'approve' ? { ...ApproveBody.parse(req.body ?? {}), reason: undefined } : Reason.parse(req.body)
      const { state } = await reviewerTx(x, req.user!, async (c) => {
        const deal = await lockDeal(c, id)
        // a draft has been submitted to nobody: the same answer as for a deal that does not exist
        if (!deal || deal.state === 'draft') throw new Refused(NOT_FOUND)
        await holdSyndicate(c, deal)
        // after the waiting: someone whose session ended meanwhile, by changing their address for instance, decides nothing
        if (!(await sessionStillLive(c, req.user!.sessionHmac, req.user!.id))) throw new Refused('Your session has ended.')
        const to = decided(deal.state, event, {
          actor: 'reviewer',
          now: now(),
          reason: body.reason,
          reviewerConflicted: !canReviewDeal(req.user, req.user!.email, await partiesOf(c, deal)),
        })
        if ((await latestVersion(c, id))?.sha256 !== body.reviewed_sha256) throw new Refused('This deal has changed since you opened it. Open it again.')
        let n: number | undefined
        if (event === 'approve') {
          n = (await recordVersion(c, deal, deal.draft, 'approved', req.user!.id)).n
          await c.query('UPDATE deal SET state = $2, approved_at = $3::timestamptz, approved_version = $4, updated_at = $3::timestamptz WHERE id = $1', [
            id,
            to,
            now().toISOString(),
            n,
          ])
        } else
          await c.query(`UPDATE deal SET state = $2, updated_at = $3::timestamptz${event === 'reject' ? ', ended_at = $3::timestamptz' : ''} WHERE id = $1`, [
            id,
            to,
            now().toISOString(),
          ])
        await logEvent(c, id, deal.state, to, event, req.user!.id, { reason: body.reason, note: body.internal_note, n })
        await appendAudit(c, d.k, { actor: req.user!.id, action, entity: id })
        const words =
          event === 'approve'
            ? 'It has been approved. Please confirm on the deal page that it should go live.'
            : event === 'reject'
              ? `It was not accepted, and this is final. Reason: ${body.reason}`
              : `Changes were requested. Reason: ${body.reason}`
        await d.mail.queue(c, await toLead(c, deal.lead_user, deal.id, `Review of deal ${deal.public_code}`, words))
        return { state: to }
      })
      await d.mail.flush()
      return { state }
    })
  }
  reviewRoute('approve', 'approve', 'deal.approved')
  reviewRoute('request-changes', 'request_changes', 'deal.changes_requested')
  reviewRoute('reject', 'reject', 'deal.rejected')

  // What an approver needs in order to know what they are approving (R-CMP-02): only the version that passed review, and only with no stake
  app.get('/api/approvals/deals', approver, async (req) => {
    const rows = (await d.db.query<DealRow>("SELECT * FROM deal WHERE state = 'approved' AND deleted_at IS NULL ORDER BY approved_at, id LIMIT 500")).rows
    const out = []
    for (const r of rows)
      if (canApproveDealContent(req.user, req.user!.email, await partiesOf(d.db, r)))
        out.push({ id: r.id, public_code: r.public_code, name: r.draft.basics?.name ?? null, approved_at: r.approved_at })
    return { deals: out }
  })

  app.get<{ Params: { id: string } }>('/api/approvals/deals/:id', approver, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const deal = (await d.db.query<DealRow>('SELECT * FROM deal WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0]
    if (!deal || deal.state !== 'approved' || deal.approved_version === null || !canApproveDealContent(req.user, req.user!.email, await partiesOf(d.db, deal)))
      return reply.code(404).send({ error: NOT_FOUND })
    const v = (
      await d.db.query<{ snapshot: Record<string, unknown>; sha256: string }>('SELECT snapshot, sha256 FROM deal_version WHERE deal_id = $1 AND n = $2', [
        id,
        deal.approved_version,
      ])
    ).rows[0]!
    return {
      id,
      public_code: deal.public_code,
      content: await expand(d.db, v.snapshot),
      content_sha256: v.sha256,
      files: await dealFiles(d.db, id),
      checklist: reviewChecklist(deal.draft),
    }
  })

  // R-OP-09: the operator's own record of content approval, which is not the statutory approval of a promotion
  app.post<{ Params: { id: string } }>('/api/review/deals/:id/content-approval', approver, async (req) => {
    const id = Uuid.parse(req.params.id)
    const body = ContentApproval.parse(req.body)
    return tx(d.db, async (c) => {
      await lockInstance(c)
      if (!(await sessionStillLive(c, req.user!.sessionHmac, req.user!.id))) throw new Refused('Your session has ended.')
      const held = await c.query("SELECT 1 FROM role_grant WHERE user_id = $1 AND role = 'approver'", [req.user!.id])
      if (!held.rowCount) throw new Refused('Only a content approver can do this.')
      const deal = await lockDeal(c, id)
      if (!deal || deal.state === 'draft') throw new Refused(NOT_FOUND)
      await holdSyndicate(c, deal)
      if (!(await sessionStillLive(c, req.user!.sessionHmac, req.user!.id))) throw new Refused('Your session has ended.')
      if (deal.state !== 'approved' || deal.approved_version === null) throw new Refused('Only content that has passed review can be approved.')
      if (!canApproveDealContent(req.user, req.user!.email, await partiesOf(c, deal)))
        throw new Refused('You cannot approve the content of a deal you lead, work on, or receive carry from.')
      const v = (await c.query<{ sha256: string }>('SELECT sha256 FROM deal_version WHERE deal_id = $1 AND n = $2', [id, deal.approved_version])).rows[0]!
      if (v.sha256 !== body.content_sha256) throw new Refused('This deal has changed since you opened it. Open it again.')
      await c.query(
        "INSERT INTO promotion_approval (id, subject_kind, subject_id, approver_user, self_declared_name, self_declared_frn, approved_on, content_sha256) VALUES ($1, 'deal_version', $2, $3, $4, $5, $6, $7)",
        [randomUUID(), `${id}:${deal.approved_version}`, req.user!.id, body.self_declared_name, body.self_declared_frn ?? null, today(), v.sha256],
      )
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.content_approved', entity: id })
      return { content_sha256: v.sha256 }
    })
  })

  registerDealFiles(app, {
    db: d.db,
    k: d.k,
    adapters: d.adapters,
    uploadDeadlineMs: d.uploadDeadlineMs,
    downloadDeadlineMs: d.downloadDeadlineMs,
    canEdit,
    leadTx: leadTx as never,
    partiesFor: async (id) => {
      const deal = (await d.db.query<DealRow>('SELECT * FROM deal WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0]
      return deal ? { parties: await partiesOf(d.db, deal), state: deal.state } : null
    },
    documentsChanged: (async (c: Tx, deal: DealRow, who: string) => {
      if (deal.state !== 'in_review' && deal.state !== 'approved') return
      const state = decided(deal.state, 'lead_edit', { actor: 'lead', now: now(), gaps: draftGaps(await problemsOf(c, deal)) })
      const v = await recordVersion(c, deal, deal.draft, 'edited', null)
      // nobody was asked anything by a file changing: the confirmation stays with the person who gave it
      const attester = (await c.query<{ actor: string }>('SELECT actor FROM lead_attestation WHERE deal_id = $1 ORDER BY version_n DESC LIMIT 1', [deal.id]))
        .rows[0]?.actor
      await recordAttestations(c, deal, deal.draft, attester ?? who, v.n)
      await c.query('UPDATE deal SET state = $2, approved_at = NULL, approved_version = NULL, updated_at = $3::timestamptz WHERE id = $1', [
        deal.id,
        state,
        now().toISOString(),
      ])
      await logEvent(c, deal.id, deal.state, state, 'lead_edit', who, { n: v.n })
      await appendAudit(c, d.k, { actor: who, action: 'deal.edited_in_review', entity: deal.id })
    }) as never,
  })

  registerSyndicates(app, { db: d.db, k: d.k, linkTo, mail: d.mail, leadTx: leadTx as never })
  // D4: changes to a live deal (R-CHG-01..05)
  registerChanges(app, {
    db: d.db,
    k: d.k,
    mail: d.mail,
    now,
    leadTx: leadTx as never,
    parseDraft: (b) => DraftBody.parse(b) as unknown as Draft,
    gaps: async (c, deal, draft) => draftGaps(draftProblems(draft, await contextFor(c, { ...(deal as unknown as DealRow), draft }))),
    snapshotOf: (c, id, draft) => snapshotOf(c, id, draft),
    expand: (c, s) => expand(c, s) as Promise<Record<string, unknown>>,
    partiesOf: (c, deal) => partiesOf(c, deal),
  })
  registerInvestee(app, {
    db: d.db,
    k: d.k,
    now,
    linkTo,
    mail: d.mail,
    adapters: d.adapters,
    uploadDeadlineMs: d.uploadDeadlineMs,
    leadTx: leadTx as never,
    partiesInTx: async (c, id) => {
      const deal = await lockDeal(c, id)
      if (deal) await holdSyndicate(c, deal)
      return deal ? { parties: await partiesOf(c, deal), lead: deal.lead_user, code: deal.public_code, state: deal.state } : null
    },
    partiesRead: async (id) => {
      const deal = (await d.db.query<DealRow>('SELECT * FROM deal WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0]
      return deal ? { parties: await partiesOf(d.db, deal), state: deal.state } : null
    },
  })

  // the operator's settings for deals
  app.get('/api/deal-config', { config: { gate: 'canAdministerInstance' as const } }, async () => dealConfig(d.db))
  app.put('/api/deal-config', { config: { gate: 'canAdministerInstance' as const } }, async (req) => {
    const b = DealConfigBody.parse(req.body)
    return adminTx(x, req.user!, async (c) => {
      await c.query(
        'UPDATE deal_config SET required_company_fields = $1, min_commitment_floor_minor = $2, default_carry_bps = $3, embed_hosts = $4, review_target_days = $5, launch_confirm_days = $6, draft_restore_days = $7, investee_link_days = $8, investee_reminder_hours = $9, investee_valid_days = $10, content_approval_in_sandbox = $11 WHERE id = 1',
        [
          b.required_company_fields,
          b.min_commitment_floor_minor,
          b.default_carry_bps,
          b.embed_hosts,
          b.review_target_days,
          b.launch_confirm_days,
          b.draft_restore_days,
          b.investee_link_days,
          b.investee_reminder_hours,
          b.investee_valid_days,
          b.content_approval_in_sandbox,
        ],
      )
      await c.query(
        'UPDATE deal_config SET link_fee_max_bps = coalesce($1, link_fee_max_bps), reference_prefix = coalesce($2, reference_prefix), eea_count_limit = coalesce($3, eea_count_limit) WHERE id = 1',
        [b.link_fee_max_bps ?? null, b.reference_prefix ?? null, b.eea_count_limit ?? null],
      )
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal_config.changed', detail: b })
      return { ok: true }
    })
  })

  const timer = setInterval(
    () => void lapseApprovals(d.db, d.k, now()).catch((e: { code?: string }) => app.log.error(`lapse failed: ${e?.code ?? 'unknown'}`)),
    3_600_000,
  )
  timer.unref()
  app.addHook('onClose', async () => clearInterval(timer))
}
