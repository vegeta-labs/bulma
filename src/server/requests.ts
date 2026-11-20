// Changes a second admin approves, and the facts they are judged on (PRD R-OP-02, R-OP-04, R-OP-08).
// Every decision locks the instance row first; role changes lock it too, so the facts cannot move during a decision.
import type { UrgentKind } from '../lib/mailContent.ts'
import type { UrgentMail } from './mail.ts'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  approvalRefusal, isSingleAdminException, roleChangeRefusal, switchBlockers,
  type Blocker, type InstanceRole, type Mode, type RegulatoryStatus, type SwitchFacts,
} from '../lib/instance.ts'
import { hasDefaultWording, invariantViolations, placeholderTexts, type RegimePack } from '../lib/regimePack.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { packContent } from '../store/packs.ts'
import { currentStaff, grantRole, sessionStillLive, voidTokens } from './auth.ts'
import { applyPolicyToLinks, policyNow } from './d3Core.ts'
import type { MailQueue, QueuedMail } from './outbox.ts'

export class Refused extends Error {
  readonly blockers?: Blocker[]
  constructor(message: string, blockers?: Blocker[]) {
    super(message)
    this.blockers = blockers
  }
}

export const paymentFileSchema = z.array(z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  account_fields: z.record(z.string().regex(/^[a-z_]{1,64}$/), z.string().trim().min(1).max(200)).refine((f) => Object.keys(f).length > 0),
  holder: z.string().trim().min(1).max(200),
  holder_capacity: z.string().trim().min(1).max(500),
  holder_frn: z.string().regex(/^\d{6,7}$/).nullable(),
  asserted_client_money: z.boolean(),
  your_money_text_key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  refund_days: z.number().int().min(0).max(365),
  receipt_check_note: z.string().trim().min(1).max(1000),
})).min(1).refine((list) => new Set(list.map((p) => p.currency)).size === list.length)
export type PaymentEntry = z.infer<typeof paymentFileSchema>[number]

export type PaymentFile = { state: 'none' } | { state: 'invalid' } | { state: 'ok'; entries: PaymentEntry[]; sha256: string }

/**
 * A sandbox has no input for payment details (R-OP-01), so the details for the real mode come from a file the deployment
 * mounts (docs/en/real-mode.md). They enter the database only when a second admin approves the switch. Editing screens are D3.
 */
export function readPaymentFile(path: string | undefined): PaymentFile {
  if (!path) return { state: 'none' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'none' } : { state: 'invalid' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'invalid' }
  }
  const r = paymentFileSchema.safeParse(parsed)
  return r.success ? { state: 'ok', entries: r.data, sha256: createHash('sha256').update(raw).digest('hex') } : { state: 'invalid' }
}

export interface InstanceRow {
  mode: Mode
  regulatory_status: RegulatoryStatus | null
  accountable_person: string | null
  accountable_confirmed_on: string | null
  active_pack_id: string
  updated: string
}

const lockInstance = async (c: Tx) => (await c.query<InstanceRow>('SELECT mode, regulatory_status, accountable_person, accountable_confirmed_on, active_pack_id, updated_at::text AS updated FROM instance_profile WHERE id = 1 FOR UPDATE')).rows[0]!

const today = () => new Date().toISOString().slice(0, 10)

const yourMoneyFilled = (entries: readonly PaymentEntry[], pack: RegimePack) =>
  entries.length > 0 && entries.every((e) => hasDefaultWording(pack, e.your_money_text_key) && pack.legal_texts.every((t) => t.text_key !== e.your_money_text_key || !placeholderTexts({ legal_texts: [t], assessment: { enabled: false, questions: [], max_attempts: null } }).length))

export interface SwitchInput {
  regulatory_status: RegulatoryStatus | null
  accountable_person: string | null
  accountable_confirmed_on: string | null
}

async function factsFor(c: Pick<Tx, 'query'>, packId: string, input: SwitchInput, paymentFile: string | undefined): Promise<{ facts: SwitchFacts; payment: PaymentFile }> {
  const pack = (await packContent(c, packId))!
  const payment = readPaymentFile(paymentFile)
  const facts: SwitchFacts = {
    regulatoryStatus: input.regulatory_status,
    accountablePerson: input.accountable_person,
    accountableConfirmedOn: input.accountable_confirmed_on,
    today: today(),
    placeholderTextKeys: placeholderTexts(pack),
    packFormatErrors: invariantViolations(pack), // a pack stored before a stricter release is judged by today's rules
    paymentInstructionsConfigured: payment.state === 'ok',
    paymentFileInvalid: payment.state === 'invalid',
    yourMoneyFilled: payment.state === 'ok' && yourMoneyFilled(payment.entries, pack),
    staff: await currentStaff(c),
  }
  return { facts, payment }
}

/** What the switch page lists as still missing. */
export async function currentBlockers(db: Db, row: Omit<InstanceRow, 'updated'>, paymentFile: string | undefined): Promise<Blocker[]> {
  const { facts } = await factsFor(db, row.active_pack_id, row, paymentFile)
  return switchBlockers(facts)
}

const profileSchema = z.strictObject({
  regulatory_status: z.enum(['authorised_firm', 'unauthorised_relying_on_exemption', 'appointed_representative']).nullable(),
  accountable_person: z.string().trim().max(200).nullable(),
  accountable_confirmed_on: z.iso.date().refine((d) => d >= '1900-01-01').nullable(),
})

function realProfileRefusal(input: SwitchInput): Refused | null {
  const blockers = switchBlockers({
    regulatoryStatus: input.regulatory_status,
    accountablePerson: input.accountable_person,
    accountableConfirmedOn: input.accountable_confirmed_on,
    today: today(),
    placeholderTextKeys: [],
    packFormatErrors: [],
    paymentInstructionsConfigured: true,
    paymentFileInvalid: false,
    yourMoneyFilled: true,
    staff: [{ userId: 'x', roles: ['admin', 'approver'] }, { userId: 'y', roles: ['admin'] }, { userId: 'z', roles: ['reviewer'] }],
  })
  return blockers.length ? new Refused('The real mode cannot take this profile.', blockers) : null
}

async function packRefusal(c: Tx, packId: string, mode: Mode): Promise<Refused | null> {
  const pack = await packContent(c, packId)
  if (!pack) return new Refused('No such pack.')
  const invalid = invariantViolations(pack)
  if (invalid.length) return new Refused(`This pack no longer passes the format check: ${invalid.join('; ')}.`)
  if (mode === 'sandbox') return null
  const left = placeholderTexts(pack)
  if (left.length) return new Refused(`The real mode cannot use a pack with placeholder legal text: ${left.join(', ')}.`)
  const inUse = await c.query<{ your_money_text_key: string }>('SELECT DISTINCT ON (currency) your_money_text_key FROM payment_instruction ORDER BY currency, version DESC')
  for (const r of inUse.rows) {
    if (!hasDefaultWording(pack, r.your_money_text_key)) return new Refused(`The pack has no "your money" text ${r.your_money_text_key}.`)
  }
  return null
}

export type RequestKind = 'mode_switch' | 'profile_change' | 'pack_activate' | 'role_change' | 'user_disable' | 'mfa_reset' | 'retention_config' | 'retention_hold_off' | 'policy_change' | 'payment_instruction'

/** Who is acting: the account, and the session the request came in on. */
export interface Who { id: string; sessionHmac: string }

export interface Ctx {
  db: Db
  k: Keyring
  paymentFile?: string
  /** R23: mail queued in the transaction of the change, sent after the commit; a failure never undoes the change. */
  mail?: MailQueue
}

/**
 * The checks at the route ran before the lock. Whoever was removed, or whose session ended, while waiting must not act.
 * Session and account are read after the lock, so anything committed before this moment counts.
 */
async function assertAdmin(c: Tx, who: Who): Promise<void> {
  if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
  const staff = await currentStaff(c)
  if (!staff.some((s) => s.userId === who.id && s.roles.includes('admin'))) throw new Refused('Only an admin can do this.')
}

/**
 * A reviewer's decision: role changes and approvals lock this row for update, so taking it in share mode means whoever lost
 * the role, or whose session ended, while this waited cannot act. Reviewers do not hold each other up.
 */
export function reviewerTx<T>(x: Ctx, who: Who, fn: (c: Tx, recheck: () => Promise<void>) => Promise<T>): Promise<T> {
  return tx(x.db, async (c) => {
    await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
    const recheck = async () => {
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const r = await c.query("SELECT 1 FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.user_id = $1 AND g.role = 'reviewer' AND u.mfa_enabled_at IS NOT NULL AND u.email_verified_at IS NOT NULL", [who.id])
      if (!r.rowCount) throw new Refused('Only a reviewer can do this.')
    }
    await recheck()
    return fn(c, recheck)
  })
}

/** A privileged change: takes the lock role changes take, then rechecks the actor, so a removed admin's queued call fails. */
export function adminTx<T>(x: Ctx, who: Who, fn: (c: Tx) => Promise<T>): Promise<T> {
  return tx(x.db, async (c) => {
    await lockInstance(c)
    await assertAdmin(c, who)
    return fn(c)
  })
}

async function insertRequest(c: Tx, k: Keyring, kind: RequestKind, payload: object, by: string): Promise<string> {
  const id = randomUUID()
  await c.query('INSERT INTO admin_request (id, kind, payload, requested_by) VALUES ($1, $2, $3, $4)', [id, kind, JSON.stringify(payload), by])
  // the full request is in the detail, so its HMAC in the hash chain fixes what was asked
  await appendAudit(c, k, { actor: by, action: `request.created.${kind}`, entity: id, detail: payload })
  return id
}

export async function requestModeSwitch(x: Ctx, who: Who, raw: unknown): Promise<string> {
  const by = who.id
  const input = profileSchema.parse(raw)
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    if (row.mode === 'real') throw new Refused('The instance is already in the real mode.')
    const { facts, payment } = await factsFor(c, row.active_pack_id, input, x.paymentFile)
    const blockers = switchBlockers(facts)
    if (blockers.length) throw new Refused('The switch cannot be requested yet.', blockers)
    return insertRequest(c, x.k, 'mode_switch', { ...input, payment_sha256: payment.state === 'ok' ? payment.sha256 : null, base: row.updated }, by)
  }).catch(async (e) => {
    // the refusal rolled the transaction back, so its audit row is written on its own
    if (e instanceof Refused && e.blockers) {
      await tx(x.db, (c) => appendAudit(c, x.k, { actor: by, action: 'instance.switch_refused', entity: 'instance', detail: { codes: e.blockers?.map((b) => b.code) } }))
    }
    throw e
  })
}

export async function requestProfileChange(x: Ctx, who: Who, raw: unknown): Promise<string> {
  const by = who.id
  const input = profileSchema.parse(raw)
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    if (row.mode === 'real') {
      const refusal = realProfileRefusal(input)
      if (refusal) throw refusal
    }
    return insertRequest(c, x.k, 'profile_change', { ...input, base: row.updated }, by)
  })
}

export async function requestPackActivate(x: Ctx, who: Who, packId: string): Promise<string> {
  const by = who.id
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    const refusal = await packRefusal(c, packId, row.mode)
    if (refusal) throw refusal
    if (row.active_pack_id === packId) throw new Refused('This pack is already active.')
    return insertRequest(c, x.k, 'pack_activate', { pack_id: packId, base: row.updated }, by)
  })
}

async function revokeRefusal(c: Tx, mode: Mode, userId: string, role: InstanceRole): Promise<string | null> {
  const staff = await currentStaff(c)
  return roleChangeRefusal(mode, staff.map((s) => (s.userId === userId ? { ...s, roles: s.roles.filter((r) => r !== role) } : s)))
}

async function revoke(c: Tx, k: Keyring, by: string, userId: string, role: InstanceRole): Promise<void> {
  const r = await c.query('DELETE FROM role_grant WHERE user_id = $1 AND role = $2', [userId, role])
  if (r.rowCount) await appendAudit(c, k, { actor: by, action: `role.revoked.${role}`, entity: userId })
}

/**
 * Direct in the sandbox. In the real mode every role change goes to a second admin: otherwise one admin could add a puppet
 * reviewer or approver and remove the real one, and every control resting on those roles would rest on that admin alone.
 */
export async function changeRole(x: Ctx, who: Who, userId: string, role: InstanceRole, grant: boolean): Promise<{ requestId?: string }> {
  const by = who.id
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    const target = (await c.query<{ disabled_at: string | null }>('SELECT disabled_at FROM user_account WHERE id = $1', [userId])).rows[0]
    if (!target) throw new Refused('No such user.')
    if (grant && target.disabled_at) throw new Refused('This account is disabled.')
    if (!grant) {
      const refusal = await revokeRefusal(c, row.mode, userId, role)
      if (refusal) throw new Refused(refusal)
    }
    if (row.mode === 'real') return { requestId: await insertRequest(c, x.k, 'role_change', { user_id: userId, role, grant }, by) }
    if (grant) await grantRole(c, x.k, userId, role, by)
    else await revoke(c, x.k, by, userId, role)
    return {}
  })
}

async function disableNow(c: Tx, k: Keyring, by: string, userId: string): Promise<void> {
  const r = await c.query('UPDATE user_account SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL', [userId])
  if (!r.rowCount) throw new Refused('No such active user.')
  await c.query('DELETE FROM app_session WHERE user_id = $1', [userId])
  await appendAudit(c, k, { actor: by, action: 'user.disabled', entity: userId })
}

/**
 * Someone holding no role goes at once. In the real mode, staff go through a second admin like any role removal, or disabling
 * would be the way round that rule. The cost is that an emergency needs both admins; stated in docs/en/real-mode.md.
 */
export async function disableUser(x: Ctx, who: Who, userId: string): Promise<{ requestId?: string }> {
  const by = who.id
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    const staff = await currentStaff(c)
    const refusal = roleChangeRefusal(row.mode, staff.filter((s) => s.userId !== userId))
    if (refusal) throw new Refused(refusal)
    if (row.mode === 'real' && staff.some((s) => s.userId === userId)) return { requestId: await insertRequest(c, x.k, 'user_disable', { user_id: userId }, by) }
    await disableNow(c, x.k, by, userId)
    return {}
  })
}

/**
 * R-ACC-03.1, decision R14: someone who lost their authenticator and recovery codes. One admin asks, a second approves. Who the
 * person really is, the operator checks outside the software.
 */
export async function requestMfaReset(x: Ctx, who: Who, userId: string): Promise<string> {
  return tx(x.db, async (c) => {
    await lockInstance(c)
    await assertAdmin(c, who)
    const u = (await c.query<{ mfa_enabled_at: string | null }>('SELECT mfa_enabled_at FROM user_account WHERE id = $1', [userId])).rows[0]
    if (!u) throw new Refused('No such user.')
    if (!u.mfa_enabled_at) throw new Refused('This person has no two-step sign-in to reset.')
    return insertRequest(c, x.k, 'mfa_reset', { user_id: userId }, who.id)
  })
}

/** `transaction_years` (D4, MLR reg 40(4)) is left as it is when not given: a request asked for before D4 has none. */
export interface RetentionPeriods { relationship_years: number; idle_months: number; kyc_valid_years: number; transaction_years?: number }

async function applyRetentionPeriods(c: Tx, k: Keyring, by: string, p: RetentionPeriods) {
  await c.query('UPDATE retention_config SET relationship_years = $1, idle_months = $2, kyc_valid_years = $3, transaction_years = coalesce($4, transaction_years)', [p.relationship_years, p.idle_months, p.kyc_valid_years, p.transaction_years ?? null])
  await appendAudit(c, k, { actor: by, action: `retention.config_changed.${p.relationship_years}.${p.idle_months}.${p.kyc_valid_years}`, entity: 'retention_config', ...(p.transaction_years === undefined ? {} : { detail: { transaction_years: p.transaction_years } }) })
}

async function applyHold(c: Tx, k: Keyring, by: string, userId: string, hold: boolean) {
  const r = await c.query('UPDATE user_account SET retention_hold = $2 WHERE id = $1', [userId, hold])
  if (!r.rowCount) throw new Refused('No such user.')
  await appendAudit(c, k, { actor: by, action: hold ? 'retention.hold_on' : 'retention.hold_off', entity: userId })
}

/** Deleting cannot be undone, so in the real mode anything that can bring it nearer goes to a second admin (PRD R-KYC-04). */
export async function changeRetentionPeriods(x: Ctx, who: Who, p: RetentionPeriods): Promise<{ requestId?: string }> {
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    if (row.mode === 'real') return { requestId: await insertRequest(c, x.k, 'retention_config', p, who.id) }
    await applyRetentionPeriods(c, x.k, who.id, p)
    return {}
  })
}

export async function setRetentionHold(x: Ctx, who: Who, userId: string, hold: boolean): Promise<{ requestId?: string }> {
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    // putting a hold on only delays deletion, so it needs nobody else
    if (row.mode === 'real' && !hold) {
      const u = await c.query('SELECT 1 FROM user_account WHERE id = $1', [userId])
      if (!u.rowCount) throw new Refused('No such user.')
      return { requestId: await insertRequest(c, x.k, 'retention_hold_off', { user_id: userId }, who.id) }
    }
    await applyHold(c, x.k, who.id, userId, hold)
    return {}
  })
}

export type Detail = { label: string; value: string }

export interface PolicyInput {
  per_link_terms: boolean
  generic_links: boolean
  bulk_promo: boolean
  export_roles: Array<'admin' | 'reviewer' | 'lead'>
  reminder_count: number
  reminder_every_days: number
  /** R-WDR-05: the operator's words on what cancelling may cost; words only, so changing them loosens nothing. */
  cancel_fee_note: string | null
  /** R-ALO-01: a deadline for an answer, not a safety switch, so changing it loosens nothing. */
  amount_proposal_days: number
  /** §5.3: working days to reconfirm changed terms; a deadline for an answer, like the one above. */
  reconfirm_days: number
  /** R-AUD-05: where complaints may also be emailed; words only, like the note above. */
  complaints_email: string | null
}

/** R-CMP-03: true when any switch is looser than now. Tightening needs one person; loosening needs a second admin. */
export function loosens(from: PolicyInput, to: PolicyInput): boolean {
  return (!from.per_link_terms && to.per_link_terms) || (!from.generic_links && to.generic_links) || (!from.bulk_promo && to.bulk_promo)
    || to.export_roles.some((r) => !from.export_roles.includes(r)) || to.reminder_count > from.reminder_count
    // more often, or back on, is looser
    || (to.reminder_every_days > 0 && (from.reminder_every_days === 0 || to.reminder_every_days < from.reminder_every_days))
}

async function applyPolicy(c: Tx, k: Keyring, changedBy: string, approvedBy: string | null, p: PolicyInput & { base_version: number; base_pack: string | null }) {
  const latest = (await c.query<{ version: number }>('SELECT coalesce(max(version), 0) AS version FROM operator_policy')).rows[0]!.version
  // with no version written yet the settings are the active pack's defaults: a change of pack is a change of settings
  const pack = (await c.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile WHERE id = 1')).rows[0]!.active_pack_id
  if (latest !== p.base_version || (latest === 0 && pack !== p.base_pack)) throw new Refused('The settings changed after this was asked. Ask again.')
  await c.query('INSERT INTO operator_policy (version, per_link_terms, generic_links, bulk_promo, export_roles, reminder_count, reminder_every_days, cancel_fee_note, amount_proposal_days, reconfirm_days, complaints_email, changed_by, approved_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    [latest + 1, p.per_link_terms, p.generic_links, p.bulk_promo, p.export_roles, p.reminder_count, p.reminder_every_days, p.cancel_fee_note ?? null, p.amount_proposal_days ?? 5, p.reconfirm_days ?? 5, p.complaints_email ?? null, changedBy, approvedBy])
  await appendAudit(c, k, { actor: approvedBy ?? changedBy, action: 'policy.changed', entity: String(latest + 1), detail: { ...p } })
  await applyPolicyToLinks(c, k, approvedBy ?? changedBy)
}

/** R-CMP-03: tighten now; loosen through a second admin. Judged on the policy in force once the instance row is held. */
export async function changePolicy(x: Ctx, who: Who, next: PolicyInput): Promise<{ requestId?: string }> {
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    const now = await policyNow(c)
    const current: PolicyInput = { per_link_terms: now.perLinkTerms, generic_links: now.genericLinks, bulk_promo: now.bulkPromo, export_roles: now.exportRoles as PolicyInput['export_roles'], reminder_count: now.reminderCount, reminder_every_days: now.reminderEveryDays, cancel_fee_note: now.cancelFeeNote, amount_proposal_days: now.amountProposalDays, reconfirm_days: now.reconfirmDays, complaints_email: now.complaintsEmail }
    const payload = { ...next, base_version: now.version, base_pack: now.version === 0 ? row.active_pack_id : null }
    if (loosens(current, next)) return { requestId: await insertRequest(c, x.k, 'policy_change', payload, who.id) }
    await applyPolicy(c, x.k, who.id, null, payload)
    return {}
  })
}

/** R-OP-05: a new receiving account from the mounted file, through a second admin. Real mode only. */
export async function requestPaymentChange(x: Ctx, who: Who): Promise<string> {
  return tx(x.db, async (c) => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    if (row.mode !== 'real') throw new Refused('Receiving accounts are set in the real mode only.')
    const file = readPaymentFile(x.paymentFile)
    if (file.state !== 'ok') throw new Refused('The payment details file is missing or not valid.')
    await refuseMissingWording(c, file.entries)
    return insertRequest(c, x.k, 'payment_instruction', { payment_sha256: file.sha256 }, who.id)
  })
}

/** R-PAY-01.1: the "your money" wording an account names must exist in the active pack, and not as a placeholder. */
async function refuseMissingWording(c: Tx, entries: PaymentEntry[]) {
  // the active pack, and every pack a deal still taking money is bound to: instructions read the deal's own pack. Deals
  // live since before the switch to real are stopped (R25) and take no money.
  const packs = (await c.query<{ content: RegimePack }>(
    `SELECT r.content FROM regime_pack r WHERE r.id = (SELECT active_pack_id FROM instance_profile WHERE id = 1)
        OR r.id IN (SELECT pack_id FROM deal WHERE pack_id IS NOT NULL AND state IN ('live', 'closing_requested', 'closing') AND deleted_at IS NULL
          AND went_live_at >= coalesce((SELECT real_since FROM instance_profile WHERE id = 1), '-infinity'::timestamptz))`,
  )).rows.map((r) => r.content)
  for (const pack of packs)
    for (const e of entries) {
      const t = pack.legal_texts.find((x) => x.text_key === e.your_money_text_key)
      if (!t || t.is_placeholder) throw new Refused(`The ${e.currency} account names "your money" wording that pack ${pack.key} v${pack.version} does not have in final form: ${e.your_money_text_key}.`)
    }
}

interface PaymentRow { id: string; version: number; account_fields: unknown; holder: string; holder_capacity: string; holder_frn: string | null; asserted_client_money: boolean; your_money_text_key: string; refund_days: number; receipt_check_note: string }

/** Runs inside an approval, which holds the instance row for update: no other account change or instruction issue runs meanwhile. */
async function applyPaymentChange(c: Tx, k: Keyring, preparedBy: string, approvedBy: string, entries: PaymentEntry[]): Promise<Tell[]> {
  const tell: Tell[] = []
  for (const e of entries) {
    const cur = (await c.query<PaymentRow>('SELECT * FROM payment_instruction WHERE currency = $1 ORDER BY version DESC LIMIT 1', [e.currency])).rows[0]
    const same = !!cur && JSON.stringify(cur.account_fields) === JSON.stringify(e.account_fields) && cur.holder === e.holder && cur.holder_capacity === e.holder_capacity && cur.holder_frn === e.holder_frn
      && cur.asserted_client_money === e.asserted_client_money && cur.your_money_text_key === e.your_money_text_key && cur.refund_days === e.refund_days && cur.receipt_check_note === e.receipt_check_note
    if (same) continue
    const id = randomUUID()
    await c.query(
      `INSERT INTO payment_instruction (id, currency, version, account_fields, holder, holder_capacity, holder_frn, asserted_client_money, your_money_text_key, refund_days, receipt_check_note, prepared_by, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, e.currency, (cur?.version ?? 0) + 1, JSON.stringify(e.account_fields), e.holder, e.holder_capacity, e.holder_frn, e.asserted_client_money, e.your_money_text_key, e.refund_days, e.receipt_check_note, preparedBy, approvedBy],
    )
    await appendAudit(c, k, { actor: approvedBy, action: 'payment_instruction.changed', entity: id })
    if (!cur) continue
    // R-PAY-03: every instruction issued on the old account is void at once, and each person is told
    const voided = (await c.query<{ user_id: string; email: string; public_code: string }>(
      `UPDATE issued_instruction i SET voided_at = clock_timestamp(), void_reason = 'account_changed' FROM participation p, user_account u, deal d
        WHERE i.payment_instruction_id = $1 AND i.voided_at IS NULL AND p.id = i.participation_id AND u.id = p.user_id AND d.id = p.deal_id RETURNING u.id AS user_id, u.email, d.public_code`,
      [cur.id],
    )).rows
    for (const v of voided)
      tell.push({ urgent: 'account_changed', m: { userId: v.user_id, to: v.email, code: v.public_code } })
  }
  return tell
}

/** Every wording and setting that would change, in full: the approver reads the change itself, not a hash of it. */
export function packChanges(from: RegimePack, to: RegimePack): Detail[] {
  const id = (t: RegimePack['legal_texts'][number]) => `${t.text_key}/${t.variant}`
  const before = new Map(from.legal_texts.map((t) => [id(t), t]))
  const out: Detail[] = []
  for (const t of to.legal_texts) {
    const old = before.get(id(t))
    if (!old || old.body !== t.body || old.format !== t.format || JSON.stringify(old.required_bold) !== JSON.stringify(t.required_bold)) out.push({ label: `${old ? 'Changed' : 'New'} text ${id(t)}`, value: t.body })
    before.delete(id(t))
  }
  for (const key of before.keys()) out.push({ label: `Removed text ${key}`, value: before.get(key)!.body })
  const settings = Object.keys(to).filter((k) => k !== 'legal_texts' && k !== 'key' && k !== 'version') as Array<keyof RegimePack>
  for (const k of settings) {
    if (JSON.stringify(from[k]) !== JSON.stringify(to[k])) out.push({ label: `Changed setting ${k}`, value: JSON.stringify(to[k]) })
  }
  return out
}

/** What the approver is being asked to approve, in full: a button alone would meet the two-person rule in form only. */
export async function describeRequest(x: Ctx, kind: string, payload: Record<string, unknown>, status: string): Promise<Detail[]> {
  const shown = (v: unknown) => (v === null || v === undefined || v === '' ? 'not given' : String(v))
  if (kind === 'user_disable') {
    const u = (await x.db.query<{ name: string; email: string }>('SELECT name, email FROM user_account WHERE id = $1', [payload.user_id])).rows[0]
    return [{ label: 'Disable the account of', value: u ? `${u.name}, ${u.email}` : 'unknown' }]
  }
  if (kind === 'retention_config') return [{ label: 'Years after a relationship ends', value: shown(payload.relationship_years) }, { label: 'Months without sign-in that end a relationship', value: shown(payload.idle_months) }, { label: 'Years an identity check stays valid', value: shown(payload.kyc_valid_years) }, ...(payload.transaction_years === undefined ? [] : [{ label: 'Years payment details are kept', value: shown(payload.transaction_years) }]), { label: 'Before approving', value: 'A shorter period can delete records at the next run, and that cannot be undone.' }]
  if (kind === 'policy_change') return [
    { label: 'Links with their own terms', value: payload.per_link_terms ? 'allowed' : 'not allowed' },
    { label: 'Open links', value: payload.generic_links ? 'allowed' : 'only invitations to a named address' },
    { label: 'Promotional bulk messages', value: payload.bulk_promo ? 'allowed' : 'not allowed' },
    { label: 'Who may export investor lists', value: shown((payload.export_roles as string[] | undefined)?.join(', ')) },
    { label: 'Reminders', value: shown(payload.reminder_count) },
    { label: 'Days between payment reminders', value: shown(payload.reminder_every_days) },
    { label: 'What cancelling may cost', value: shown(payload.cancel_fee_note) },
    { label: 'Working days to answer a proposed amount', value: shown(payload.amount_proposal_days) },
    { label: 'Working days to reconfirm changed terms', value: shown(payload.reconfirm_days) },
    { label: 'Address for complaints', value: shown(payload.complaints_email) },
  ]
  if (kind === 'payment_instruction') {
    // the approver sees exactly what will be installed, next to what is there now (R-OP-05)
    const file = readPaymentFile(x.paymentFile)
    const proposed: Detail[] = file.state === 'ok' && file.sha256 === payload.payment_sha256
      ? file.entries.map((e) => ({ label: `Proposed ${e.currency} account`, value: `${e.holder} (${e.holder_capacity}); ${Object.entries(e.account_fields).map(([k, v]) => `${k}: ${v}`).join(', ')}; FRN ${shown(e.holder_frn)}; client money: ${e.asserted_client_money ? 'yes' : 'no'}; refunds within ${e.refund_days} days; your-money wording ${e.your_money_text_key}` }))
      : [{ label: 'Proposed accounts', value: 'The file has changed since this was asked. Reject this request and ask again.' }]
    const current = (await x.db.query<{ currency: string; holder: string; account_fields: Record<string, string> }>('SELECT DISTINCT ON (currency) currency, holder, account_fields FROM payment_instruction ORDER BY currency, version DESC')).rows
      .map((r) => ({ label: `Current ${r.currency} account`, value: `${r.holder}; ${Object.entries(r.account_fields).map(([k, v]) => `${k}: ${v}`).join(', ')}` }))
    return [...proposed, ...current,
    { label: 'File fingerprint', value: shown(payload.payment_sha256) },
    { label: 'Before approving', value: 'Check the new details against a source you trust, not an email. Every payment instruction already issued for a changed account becomes invalid, and investors are told.' },
  ]
  }
  if (kind === 'retention_hold_off') {
    const u = (await x.db.query<{ name: string; email: string }>('SELECT name, email FROM user_account WHERE id = $1', [payload.user_id])).rows[0]
    return [{ label: 'Lift the retention hold on', value: u ? `${u.name}, ${u.email}` : 'unknown' }, { label: 'Before approving', value: 'Records past their date can be deleted at the next run, and that cannot be undone.' }]
  }
  if (kind === 'mfa_reset') {
    const u = (await x.db.query<{ name: string; email: string }>('SELECT name, email FROM user_account WHERE id = $1', [payload.user_id])).rows[0]
    return [{ label: 'Clear two-step sign-in for', value: u ? `${u.name}, ${u.email}` : 'unknown' }, { label: 'Before approving', value: 'Check who this person is outside this software. The software cannot.' }]
  }
  if (kind === 'role_change') {
    const u = (await x.db.query<{ name: string; email: string }>('SELECT name, email FROM user_account WHERE id = $1', [payload.user_id])).rows[0]
    return [{ label: 'Person', value: u ? `${u.name}, ${u.email}` : 'unknown' }, { label: payload.grant ? 'Give the role' : 'Remove the role', value: shown(payload.role) }]
  }
  if (kind === 'pack_activate') {
    const p = (await x.db.query<{ key: string; version: number; regime: string; content_sha256: string; content: RegimePack }>('SELECT key, version, regime, content_sha256, content FROM regime_pack WHERE id = $1', [payload.pack_id])).rows[0]
    if (!p) return [{ label: 'Pack', value: 'unknown' }]
    const active = (await x.db.query<{ content: RegimePack }>('SELECT r.content FROM regime_pack r JOIN instance_profile i ON i.active_pack_id = r.id')).rows[0]!.content
    return [
      { label: 'Pack', value: `${p.key} version ${p.version}, ${p.regime}` },
      { label: 'Compared with', value: `${active.key} version ${active.version}, the active pack` },
      { label: 'Placeholder texts left', value: String(placeholderTexts(p.content).length) },
      { label: 'SHA-256', value: p.content_sha256 },
      ...packChanges(active, p.content),
    ]
  }
  const profile = [
    { label: 'Regulatory status', value: shown(payload.regulatory_status) },
    { label: 'Operator accountable person', value: shown(payload.accountable_person) },
    { label: 'Date they confirmed', value: shown(payload.accountable_confirmed_on) },
  ]
  if (kind !== 'mode_switch') return profile
  const out = [...profile, { label: 'Payment details SHA-256', value: shown(payload.payment_sha256) }]
  if (status !== 'pending') return out
  const file = readPaymentFile(x.paymentFile)
  if (file.state !== 'ok' || file.sha256 !== payload.payment_sha256) return [...out, { label: 'Payment details', value: 'The file has changed since this was asked, so approving it will be refused.' }]
  const row = (await x.db.query<{ content: RegimePack }>('SELECT r.content FROM regime_pack r JOIN instance_profile i ON i.active_pack_id = r.id')).rows[0]!
  for (const e of file.entries) {
    const panel = row.content.legal_texts.find((t) => t.text_key === e.your_money_text_key && t.variant === 'default')
    out.push({ label: `${e.currency} refund days`, value: String(e.refund_days) })
    out.push({ label: `${e.currency} receipt check`, value: e.receipt_check_note })
    out.push({ label: `${e.currency} "your money" panel (${e.your_money_text_key}, version ${panel?.version ?? 'none'})`, value: panel?.body ?? 'not found' })
    out.push({ label: `${e.currency} account`, value: Object.entries(e.account_fields).map(([k, v]) => `${k}: ${v}`).join(', ') })
    out.push({ label: `${e.currency} holder`, value: `${e.holder} (${e.holder_capacity})${e.holder_frn ? `, FRN ${e.holder_frn} as stated` : ''}` })
    out.push({ label: `${e.currency} stated to be a client money account`, value: e.asserted_client_money ? 'Yes' : 'No' })
  }
  return out
}

interface RequestRow {
  id: string
  kind: RequestKind
  payload: Record<string, unknown>
  status: string
  requested_by: string
}

const profileOf = (p: Record<string, unknown>) => profileSchema.parse({ regulatory_status: p.regulatory_status, accountable_person: p.accountable_person, accountable_confirmed_on: p.accountable_confirmed_on })

/**
 * Decision R13. Results made with fake adapters and placeholder wording stop counting as the mode changes: readers compare
 * `created_at` with `real_since`. Nothing is deleted here; only the expiry job deletes. People with no role prove their address
 * again, because in a sandbox it was proved by a link handed back on the page.
 */
async function voidSandboxResults(c: Tx): Promise<void> {
  await c.query('UPDATE instance_profile SET real_since = clock_timestamp() WHERE id = 1') // now, with the lock held: not when this transaction began
  await c.query('UPDATE account_token SET consumed_at = now() WHERE consumed_at IS NULL')
  // R-OP-01: sandbox mail never leaves, and the sign-in links it holds are spent above
  await c.query(
    "UPDATE notification_outbox SET status = 'cancelled', cancel_reason = 'mode_changed', key_id = NULL, wrapped_key = NULL, body_sealed = NULL, finished_at = clock_timestamp() WHERE status = 'queued' AND mode = 'sandbox'",
  )
  // hidden by `real_since` from here on; left open, it would stop this person starting a new one
  await c.query('UPDATE assessment_attempt SET passed = false WHERE passed IS NULL')
  await c.query('DELETE FROM app_session WHERE user_id NOT IN (SELECT user_id FROM role_grant)')
  await c.query('UPDATE user_account SET email_verified_at = NULL WHERE id NOT IN (SELECT user_id FROM role_grant)')
  // two-step set up on an address nobody proved must not lock out whoever really owns it
  await c.query('UPDATE mfa_recovery_code SET used_at = now() WHERE used_at IS NULL AND user_id NOT IN (SELECT user_id FROM role_grant)')
  await c.query('UPDATE user_account SET mfa_secret = NULL, mfa_key_id = NULL, mfa_wrapped_key = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL WHERE id NOT IN (SELECT user_id FROM role_grant)')
}

/** A mail an approval sends: a plain one, or an urgent notice in its fixed words (R-NTF-01). */
type Tell = QueuedMail | { urgent: UrgentKind; m: UrgentMail }

async function apply(c: Tx, x: Ctx, req: RequestRow, row: InstanceRow, by: string): Promise<{ mails?: Tell[] }> {
  // judged against the instance as it was when asked: a stale request must not overwrite a newer decision
  if (req.kind !== 'role_change' && req.kind !== 'user_disable' && req.kind !== 'mfa_reset' && req.kind !== 'retention_config' && req.kind !== 'retention_hold_off' && req.kind !== 'policy_change' && req.kind !== 'payment_instruction' && req.payload.base !== row.updated) throw new Refused('The instance changed after this was asked. Ask again.')
  if (req.kind === 'mode_switch') {
    if (row.mode === 'real') throw new Refused('The instance is already in the real mode.')
    const input = profileOf(req.payload)
    const { facts, payment } = await factsFor(c, row.active_pack_id, input, x.paymentFile)
    const blockers = switchBlockers(facts)
    if (blockers.length) throw new Refused('The switch cannot go ahead.', blockers)
    if (payment.state !== 'ok' || payment.sha256 !== req.payload.payment_sha256) throw new Refused('The payment details changed after the request. Ask for the switch again.')
    for (const e of payment.entries) {
      await c.query(
        `INSERT INTO payment_instruction (id, currency, version, account_fields, holder, holder_capacity, holder_frn, asserted_client_money, your_money_text_key, refund_days, receipt_check_note, prepared_by, approved_by)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [randomUUID(), e.currency, JSON.stringify(e.account_fields), e.holder, e.holder_capacity, e.holder_frn, e.asserted_client_money, e.your_money_text_key, e.refund_days, e.receipt_check_note, req.requested_by, by],
      )
    }
    await c.query("UPDATE instance_profile SET mode = 'real', regulatory_status = $1, accountable_person = $2, accountable_confirmed_on = $3, approved_by = $4, updated_at = now() WHERE id = 1", [input.regulatory_status, input.accountable_person, input.accountable_confirmed_on, by])
    // the status is not personal, so it is in the action, inside the hash, and outlives the detail row
    await appendAudit(c, x.k, { actor: by, action: `instance.switched_to_real.${input.regulatory_status}`, entity: 'instance', detail: { request: req.id, payment_sha256: payment.sha256, accountable_person: input.accountable_person, accountable_confirmed_on: input.accountable_confirmed_on } })
    await voidSandboxResults(c)
    return {}
  }
  if (req.kind === 'profile_change') {
    const input = profileOf(req.payload)
    if (row.mode === 'real') {
      const refusal = realProfileRefusal(input)
      if (refusal) throw refusal
    }
    await c.query('UPDATE instance_profile SET regulatory_status = $1, accountable_person = $2, accountable_confirmed_on = $3, approved_by = $4, updated_at = now() WHERE id = 1', [input.regulatory_status, input.accountable_person, input.accountable_confirmed_on, by])
    await appendAudit(c, x.k, { actor: by, action: `instance.profile_changed.${row.regulatory_status ?? 'none'}.to.${input.regulatory_status ?? 'none'}`, entity: 'instance', detail: { request: req.id, accountable_person: input.accountable_person } })
    return {}
  }
  if (req.kind === 'pack_activate') {
    const packId = String(req.payload.pack_id)
    const refusal = await packRefusal(c, packId, row.mode)
    if (refusal) throw refusal
    await c.query('UPDATE instance_profile SET active_pack_id = $1, updated_at = now() WHERE id = 1', [packId])
    // with no settings of the operator's own, the new pack's defaults are the settings now: links follow at once (Codex round 4)
    await applyPolicyToLinks(c, x.k, by)
    await appendAudit(c, x.k, { actor: by, action: 'instance.pack_activated', entity: packId })
    return {}
  }
  if (req.kind === 'retention_config') {
    await applyRetentionPeriods(c, x.k, by, req.payload as unknown as RetentionPeriods)
    return {}
  }
  if (req.kind === 'policy_change') {
    await applyPolicy(c, x.k, req.requested_by, by, req.payload as unknown as PolicyInput & { base_version: number; base_pack: string | null })
    return {}
  }
  if (req.kind === 'payment_instruction') {
    if (row.mode !== 'real') throw new Refused('Receiving accounts are set in the real mode only.')
    const file = readPaymentFile(x.paymentFile)
    if (file.state !== 'ok' || file.sha256 !== req.payload.payment_sha256) throw new Refused('The payment details file changed after the request. Ask again.')
    await refuseMissingWording(c, file.entries)
    // returned, not kept aside: mail goes only after the approval commits, and never for one that rolled back
    return { mails: await applyPaymentChange(c, x.k, req.requested_by, by, file.entries) }
  }
  const userId = String(req.payload.user_id)
  if (req.kind === 'retention_hold_off') {
    await applyHold(c, x.k, by, userId, false)
    return {}
  }
  if (req.kind === 'user_disable') {
    const refusal = roleChangeRefusal(row.mode, (await currentStaff(c)).filter((s) => s.userId !== userId))
    if (refusal) throw new Refused(refusal)
    await disableNow(c, x.k, by, userId)
    return {}
  }
  if (req.kind === 'mfa_reset') {
    const r = await c.query<{ id: string; email: string }>(
      'UPDATE user_account SET mfa_secret = NULL, mfa_key_id = NULL, mfa_wrapped_key = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, credential_version = credential_version + 1 WHERE id = $1 AND mfa_enabled_at IS NOT NULL RETURNING id, email',
      [userId],
    )
    if (!r.rows[0]) throw new Refused('This person has no two-step sign-in to reset.')
    await c.query('UPDATE mfa_recovery_code SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId])
    await c.query('DELETE FROM app_session WHERE user_id = $1', [userId])
    await voidTokens(c, userId)
    await appendAudit(c, x.k, { actor: by, action: 'user.mfa_reset', entity: userId })
    const tell: QueuedMail = {
      audience: { kind: 'account', userId: r.rows[0].id },
      to: r.rows[0].email,
      subject: 'Your two-step sign-in was reset',
      body: 'An administrator cleared two-step sign-in on your account and ended your sessions. Set it up again after you sign in. If you did not ask for this, tell your operator at once.',
    }
    return { mails: [tell] }
  }
  const role = String(req.payload.role) as InstanceRole
  if (req.payload.grant) {
    const target = (await c.query<{ disabled_at: string | null }>('SELECT disabled_at FROM user_account WHERE id = $1', [userId])).rows[0]
    if (!target || target.disabled_at) throw new Refused('This account can no longer take the role.')
    await grantRole(c, x.k, userId, role, by)
    return {}
  }
  const refusal = await revokeRefusal(c, row.mode, userId, role)
  if (refusal) throw new Refused(refusal)
  await revoke(c, x.k, by, userId, role)
  return {}
}

export async function decideRequest(x: Ctx, who: Who, requestId: string, decision: 'approve' | 'reject'): Promise<void> {
  const by = who.id
  await tx(x.db, async (c): Promise<void> => {
    const row = await lockInstance(c)
    await assertAdmin(c, who)
    const req = (await c.query<RequestRow>('SELECT id, kind, payload, status, requested_by FROM admin_request WHERE id = $1 FOR UPDATE', [requestId])).rows[0]
    if (!req) throw new Refused('No such request.')
    if (req.status !== 'pending') throw new Refused('This request has already been decided.')
    if (decision === 'reject') {
      await c.query("UPDATE admin_request SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1", [requestId, by])
      await appendAudit(c, x.k, { actor: by, action: `request.rejected.${req.kind}`, entity: requestId })
      return
    }
    const staff = await currentStaff(c)
    const adminIds = staff.filter((s) => s.roles.includes('admin')).map((s) => s.userId)
    const facts = { mode: row.mode, requestedBy: req.requested_by, approver: by, adminCount: adminIds.length, approverIsAdmin: adminIds.includes(by) }
    const refusal = approvalRefusal(facts)
    if (refusal) throw new Refused(refusal)
    if (!adminIds.includes(req.requested_by)) throw new Refused('The person who asked is no longer an admin. Ask again.')
    const done = await apply(c, x, req, row, by)
    if (req.kind === 'mfa_reset') {
      // an older request approved later would clear a two-step set up since
      const old = await c.query<{ id: string }>("UPDATE admin_request SET status = 'rejected', decided_by = $2, decided_at = now() WHERE kind = 'mfa_reset' AND status = 'pending' AND id <> $1 AND payload->>'user_id' = $3 RETURNING id", [requestId, by, req.payload.user_id])
      for (const r of old.rows) await appendAudit(c, x.k, { actor: by, action: 'request.superseded.mfa_reset', entity: r.id })
    }
    if (req.kind === 'role_change') {
      // a decision on this person's role closes older requests about it, so approving one later cannot undo this
      const old = await c.query<{ id: string }>(
        "UPDATE admin_request SET status = 'rejected', decided_by = $2, decided_at = now() WHERE kind = 'role_change' AND status = 'pending' AND id <> $1 AND payload->>'user_id' = $3 AND payload->>'role' = $4 RETURNING id",
        [requestId, by, req.payload.user_id, req.payload.role],
      )
      for (const r of old.rows) await appendAudit(c, x.k, { actor: by, action: 'request.superseded.role_change', entity: r.id })
    }
    await c.query("UPDATE admin_request SET status = 'approved', decided_by = $2, decided_at = now(), single_admin_exception = $3 WHERE id = $1", [requestId, by, isSingleAdminException(facts)])
    await appendAudit(c, x.k, { actor: by, action: `request.approved.${req.kind}`, entity: requestId })
    for (const m of done.mails ?? []) await ('urgent' in m ? x.mail?.urgent(c, m.urgent, m.m) : x.mail?.queue(c, m))
  }).catch(async (e) => {
    // an approval that was refused is worth recording; the transaction rolled back, so it is written on its own
    if (e instanceof Refused && decision === 'approve') await tx(x.db, (c) => appendAudit(c, x.k, { actor: by, action: 'request.approval_refused', entity: requestId }))
    throw e
  })
  await x.mail?.flush()
}
