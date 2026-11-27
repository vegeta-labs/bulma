// D3 shared facts: what the gates in lib/gate.ts are judged on, read inside the caller's transaction. No rule is decided here.
import { randomBytes, randomUUID } from 'node:crypto'
import type { LinkFee } from '../lib/fees.ts'
import type { FeeConfig } from '../lib/fees.ts'
import type { AnyDealState, DealGateFacts, Holds, OwnParticipationFacts } from '../lib/gate.ts'
import { kycPassed } from '../lib/entity.ts'
import { deriveStatus, STATUS_LABEL, type Outcome, type Status } from '../lib/participation.ts'
import { differs, type LinkPolicy, type LinkTerms } from '../lib/invite.ts'
import type { RegimePack } from '../lib/regimePack.ts'
import { reconfirmLapsed } from './reconfirm.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import type { Tx } from '../store/db.ts'
import { packContent } from '../store/packs.ts'

export type Q = Pick<Tx, 'query'>

/** Decision R13: only what was done since the switch to the real mode counts. */
export const REAL_SINCE = "coalesce((SELECT real_since FROM instance_profile WHERE id = 1), '-infinity'::timestamptz)"

export interface D3Deal {
  id: string
  lead_user: string
  syndicate_id: string | null
  state: AnyDealState
  public_code: string
  approved_version: number | null
  pack_id: string | null
  fee_config_id: string | null
  bound_floor_minor: string | null
  went_live_at: Date | null
  /** The demo run the deal belongs to, or null for an ordinary deal (R-DEMO-05). */
  demo_run: string | null
  /** Live in the sandbox before the switch to real: it stops at the switch (D3 decision, see HANDOFF). */
  from_sandbox: boolean
}

/** SQL: a signature record that is an executed document. A deed sent outside and not yet recorded as signed is not one (Codex round 6). */
export const EXECUTED = "(provider <> 'external' OR external_status = 'signed')"
export const lockInstanceShare = (c: Q) => c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')

export async function dealById(c: Q, id: string, lock = false): Promise<D3Deal | null> {
  return (
    (
      await c.query<D3Deal>(
        `SELECT id, lead_user, syndicate_id, state, public_code, approved_version, pack_id, fee_config_id, bound_floor_minor, went_live_at, demo_run,
                (went_live_at IS NOT NULL AND went_live_at < ${REAL_SINCE}) AS from_sandbox
           FROM deal WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0] ?? null
  )
}

/** R-CMP-01: holds in force on this deal now, at each level. Callers who act on them lock the deal first. */
export async function holdsOn(c: Q, deal: Pick<D3Deal, 'id' | 'lead_user'>): Promise<Holds> {
  const rows = (
    await c.query<{ level: 'deal' | 'lead' | 'instance' }>(
      `SELECT DISTINCT level FROM compliance_hold WHERE released_at IS NULL AND applied_at >= ${REAL_SINCE}
         AND ((level = 'deal' AND target_id = $1) OR (level = 'lead' AND target_id = $2) OR level = 'instance')`,
      [deal.id, deal.lead_user],
    )
  ).rows
  return { deal: rows.some((r) => r.level === 'deal'), lead: rows.some((r) => r.level === 'lead'), instance: rows.some((r) => r.level === 'instance') }
}

/** What every deal gate reads. A sandbox deal after the switch counts as held: nothing new may happen on it. */
export async function dealGateFacts(c: Q, deal: D3Deal): Promise<DealGateFacts> {
  const holds = await holdsOn(c, deal)
  return { state: deal.state, holds: deal.from_sandbox ? { ...holds, instance: true } : holds, finalConfirmed: false }
}

export async function packOf(c: Q, deal: Pick<D3Deal, 'pack_id'>): Promise<RegimePack | null> {
  return deal.pack_id ? packContent(c, deal.pack_id) : null
}

export async function activePack(c: Q): Promise<{ id: string; pack: RegimePack }> {
  const id = (await c.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile WHERE id = 1')).rows[0]!.active_pack_id
  return { id, pack: (await packContent(c, id))! }
}

export async function feeConfigOf(c: Q, deal: Pick<D3Deal, 'fee_config_id'>): Promise<FeeConfig | null> {
  if (!deal.fee_config_id) return null
  const f = (
    await c.query<{ rate_bps: number; min_minor: string; max_minor: string; surcharge_threshold_minor: string; surcharge_bps: number }>(
      'SELECT rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps FROM fee_config WHERE id = $1',
      [deal.fee_config_id],
    )
  ).rows[0]
  return f
    ? {
        rate_bps: f.rate_bps,
        min_minor: BigInt(f.min_minor),
        max_minor: BigInt(f.max_minor),
        surcharge_threshold_minor: BigInt(f.surcharge_threshold_minor),
        surcharge_bps: f.surcharge_bps,
      }
    : null
}

/** The version investors see: the approved one (R-CMP-02). Changes after launch are D4. */
export async function approvedSnapshot(c: Q, deal: Pick<D3Deal, 'id' | 'approved_version'>): Promise<{ n: number; snapshot: Snapshot; sha256: string } | null> {
  if (deal.approved_version === null) return null
  const r = (
    await c.query<{ n: number; snapshot: Snapshot; sha256: string }>('SELECT n, snapshot, sha256 FROM deal_version WHERE deal_id = $1 AND n = $2', [
      deal.id,
      deal.approved_version,
    ])
  ).rows[0]
  return r ?? null
}

export interface Snapshot {
  basics?: { name?: string; structure?: string; deal_type?: string }
  company?: { legal_name?: string; website?: string; jurisdiction?: string }
  terms?: Record<string, unknown> & {
    currency?: string
    allocation_minor?: string
    min_commitment_minor?: string
    min_raise_minor?: string
    instrument?: string
    seis?: boolean
    eis?: boolean
  }
  files?: { memo?: unknown; deck?: unknown; documents?: Array<{ requirement: string; display_name: string; sha256: string }> }
  economics?: { default_carry_bps?: number; fee_payer?: string }
  platform_fee?: unknown
}

export interface PolicyNow extends LinkPolicy {
  version: number
  bulkPromo: boolean
  exportRoles: string[]
  reminderCount: number
  /** R-NTF-01: days between payment (and reconfirmation) reminders; 0 = none. */
  reminderEveryDays: number
  /** R-WDR-05: shown to whoever asks for a cancellation; null = nothing said. */
  cancelFeeNote: string | null
  /** R-ALO-01: working days an investor has to answer a proposed amount. */
  amountProposalDays: number
  /** §5.3: working days to reconfirm changed terms (default 5). */
  reconfirmDays: number
  /** R-AUD-05: an address for complaints shown next to the complaint form; null = the form only. */
  complaintsEmail: string | null
}

/** R-CMP-03: the newest version, or the active pack's defaults when the operator never set one. */
export async function policyNow(c: Q): Promise<PolicyNow> {
  const row = (
    await c.query<{ version: number; per_link_terms: boolean; generic_links: boolean; bulk_promo: boolean; export_roles: string[]; reminder_count: number; reminder_every_days: number; cancel_fee_note: string | null; amount_proposal_days: number; reconfirm_days: number; complaints_email: string | null }>(
      'SELECT * FROM operator_policy ORDER BY version DESC LIMIT 1',
    )
  ).rows[0]
  if (row)
    return {
      version: row.version,
      perLinkTerms: row.per_link_terms,
      genericLinks: row.generic_links,
      bulkPromo: row.bulk_promo,
      exportRoles: row.export_roles,
      reminderCount: row.reminder_count,
      reminderEveryDays: row.reminder_every_days,
      cancelFeeNote: row.cancel_fee_note,
      amountProposalDays: row.amount_proposal_days,
      reconfirmDays: row.reconfirm_days,
      complaintsEmail: row.complaints_email,
    }
  const { pack } = await activePack(c)
  const p = pack.policy_defaults
  return {
    version: 0,
    perLinkTerms: p.per_link_terms,
    genericLinks: p.generic_links,
    bulkPromo: p.bulk_promo,
    exportRoles: ['admin', 'reviewer'],
    reminderCount: 2,
    reminderEveryDays: 3,
    cancelFeeNote: null,
    amountProposalDays: 5,
    reconfirmDays: 5,
    complaintsEmail: null,
  }
}

export interface LinkRow {
  id: string
  deal_id: string
  kind: 'open' | 'terms_only'
  label: string
  carry_bps: number
  fee_kind: 'none' | 'percent' | 'fixed'
  fee_bps: number | null
  fee_minor: string | null
  fee_mode: 'on_top' | 'deducted' | null
  reason: string | null
  incentive_attested: boolean
  needs_approval: boolean
  terms_approved_at: Date | null
  is_default: boolean
  disabled_at: Date | null
  disabled_reason: string | null
  closing_paused_at: Date | null
  created_at: Date
}

export function linkFee(l: Pick<LinkRow, 'fee_kind' | 'fee_bps' | 'fee_minor' | 'fee_mode'>): LinkFee {
  if (l.fee_kind === 'percent') return { kind: 'percent', bps: l.fee_bps!, mode: l.fee_mode! }
  if (l.fee_kind === 'fixed') return { kind: 'fixed', minor: BigInt(l.fee_minor!), mode: l.fee_mode! }
  return { kind: 'none' }
}
export const linkTerms = (l: LinkRow): LinkTerms => ({ carryBps: l.carry_bps, fee: linkFee(l) })
export const linkState = (l: LinkRow) => ({
  disabled: !!l.disabled_at,
  closingPaused: !!l.closing_paused_at,
  awaitingApproval: l.needs_approval && !l.terms_approved_at,
})

/** Frozen terms, in the shape stored on the invitation (R-LNK-05). Amounts as strings. */
export interface FrozenTerms {
  link_id: string
  carry_bps: number
  fee_kind: 'none' | 'percent' | 'fixed'
  fee_bps: number | null
  fee_minor: string | null
  fee_mode: 'on_top' | 'deducted' | null
}
export const freeze = (l: LinkRow): FrozenTerms => ({
  link_id: l.id,
  carry_bps: l.carry_bps,
  fee_kind: l.fee_kind,
  fee_bps: l.fee_bps,
  fee_minor: l.fee_minor,
  fee_mode: l.fee_mode,
})

/** C-FEE-4 N: receipts not reversed − refunds recorded − refunds in flight (approved or sent). Below 0 is the needs-check overlay. */
export async function heldMinor(c: Q, participationId: string): Promise<bigint> {
  const r = (
    await c.query<{ n: string }>(
      `SELECT ((SELECT coalesce(sum(amount_minor - moved_out_minor), 0) FROM receipt WHERE participation_id = $1 AND reversed_at IS NULL)
             - (SELECT coalesce(sum(CASE WHEN state = 'recorded' THEN actual_minor WHEN state IN ('approved', 'sent') THEN amount_minor ELSE 0 END), 0)
                  FROM refund_payment WHERE participation_id = $1))::text AS n`,
      [participationId],
    )
  ).rows[0]!
  return BigInt(r.n)
}

/** R-PAY-03: void the valid instruction, in the caller's transaction. Returns whether one was voided. */
export async function voidInstruction(c: Tx, k: Keyring, participationId: string, reason: string, actor: string): Promise<boolean> {
  const r = await c.query<{ id: string }>(
    'UPDATE issued_instruction SET voided_at = clock_timestamp(), void_reason = $2 WHERE participation_id = $1 AND voided_at IS NULL RETURNING id',
    [participationId, reason],
  )
  for (const row of r.rows) await appendAudit(c, k, { actor, action: 'instruction.voided', entity: row.id, detail: { reason } })
  return r.rowCount! > 0
}

export async function logParticipation(c: Q, participationId: string, event: string, actor: string | null, detail: Record<string, unknown> = {}) {
  await c.query('INSERT INTO participation_event (id, participation_id, event, actor, detail) VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    participationId,
    event,
    actor,
    JSON.stringify(detail),
  ])
}

/** A 256-bit URL-safe token (tech design §5). */
export const newToken = () => randomBytes(32).toString('base64url')

/** R-CMP-03: when a switch is tightened, links that no longer fit and are not bound to anyone are turned off. */
export async function applyPolicyToLinks(c: Tx, k: Keyring, actor: string) {
  const policy = await policyNow(c)
  const live = (
    await c.query<LinkRow & { default_carry_bps: number | null }>(
      `SELECT l.*, (d.draft->'economics'->>'default_carry_bps')::int AS default_carry_bps FROM invite_link l JOIN deal d ON d.id = l.deal_id WHERE l.disabled_at IS NULL`,
    )
  ).rows
  for (const l of live) {
    const different = differs({ carryBps: l.carry_bps, fee: linkFee(l) }, l.default_carry_bps ?? -1)
    const offTerms = !policy.perLinkTerms && different
    const offGeneric = !policy.genericLinks && l.kind === 'open'
    if (!offTerms && !offGeneric) continue
    // people already bound keep their terms either way: turning a link off only stops new people (R-CMP-03). With different
    // terms switched off, a terms-only link someone is bound to stays, for their own invitation; an open token never does.
    const bound = (await c.query("SELECT 1 FROM deal_invitation WHERE invite_link = $1 AND state = 'active'", [l.id])).rowCount! > 0
    if (bound && offTerms && !offGeneric && l.kind === 'terms_only') continue
    await c.query("UPDATE invite_link SET disabled_at = clock_timestamp(), disabled_reason = 'policy' WHERE id = $1", [l.id])
    await appendAudit(c, k, { actor, action: 'link.disabled_by_policy', entity: l.id })
  }
}

export interface ParticipationKey {
  id: string
  entity_id: string
  entity_version: number
  outcome: Outcome
  identity_review: string
  cash_due_minor: string
  invested_minor: string | null
}

/**
 * The facts of one participation, as every gate and status reads them. A KYC pass that has since run out still counts
 * for someone who signed on it, as long as the identity is the one signed for and nothing was refused (R-KYC-02.1): expiry
 * stops new starts, not progress already made.
 */
export async function participationFacts(
  c: Q,
  p: ParticipationKey,
  today: string,
): Promise<Omit<OwnParticipationFacts, 'accountAcknowledged'> & { held: bigint; transferMarked: boolean; signatureId: string | null }> {
  const ent = (
    await c.query<{ current_version: number; rejected_at: Date | null }>('SELECT current_version, rejected_at FROM legal_entity WHERE id = $1', [p.entity_id])
  ).rows[0]!
  const kyc = (
    await c.query<{ status: string; entity_version: number; expires_on: string | null }>(
      `SELECT status, entity_version, to_char(expires_on, 'YYYY-MM-DD') AS expires_on FROM kyc_case WHERE entity_id = $1 AND created_at >= ${REAL_SINCE} ORDER BY created_at DESC LIMIT 1`,
      [p.entity_id],
    )
  ).rows[0]
  const sig = (
    await c.query<{ id: string; entity_version: number; external_status: string | null; provider: string }>(
      'SELECT id, entity_version, external_status, provider FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL',
      [p.id],
    )
  ).rows[0]
  const signed = !!sig && (sig.provider !== 'external' || sig.external_status === 'signed')
  const passedNow =
    !!kyc && kycPassed({ status: kyc.status as 'approved', entityVersion: kyc.entity_version, expiresOn: kyc.expires_on }, ent.current_version, today)
  const passedWhenSigned =
    signed && sig!.entity_version === ent.current_version && !!kyc && kyc.status === 'approved' && kyc.entity_version === ent.current_version
  const held = await heldMinor(c, p.id)
  return {
    outcome: p.outcome,
    kycPassed: !ent.rejected_at && (passedNow || passedWhenSigned),
    signed,
    identityReview: p.identity_review === 'pending',
    entityVersionCurrent: p.entity_version === ent.current_version,
    reconfirmPending: (await c.query("SELECT 1 FROM reconfirmation WHERE participation_id = $1 AND state = 'pending'", [p.id])).rowCount! > 0,
    needsCheck: held < 0n,
    held,
    transferMarked: (await c.query('SELECT 1 FROM transfer_mark WHERE participation_id = $1', [p.id])).rowCount! > 0,
    signatureId: sig?.id ?? null,
  }
}

/** §5.2 status of one participation from its real facts, for staff and the lead. */
export async function participationStatus(
  c: Q,
  p: ParticipationKey,
  pack: RegimePack,
  today: string,
  now = new Date(),
): Promise<{ status: Status; label: string; overlays: string[] }> {
  const f = await participationFacts(c, p, today)
  const s = deriveStatus(
    {
      invitation: 'active',
      qualified: true,
      statementExpired: false,
      waitlisted: false,
      participation: {
        outcome: p.outcome,
        kycPassed: f.kycPassed,
        reconfirmPending: f.reconfirmPending,
        reconfirmLapsed: f.reconfirmPending && (await reconfirmLapsed(c, p.id, pack.regime, now)),
        amountProposalPending: // past its deadline the proposal has lapsed, even before the sweep records it (R-ALO-01)
        (await c.query('SELECT 1 FROM amount_proposal WHERE participation_id = $1 AND decision IS NULL AND deadline_at > $2', [p.id, now])).rowCount! > 0,
        signed: f.signed,
        transferMarked: f.transferMarked,
        held: f.held,
        due: BigInt(p.cash_due_minor),
        invested: p.invested_minor === null ? null : BigInt(p.invested_minor),
        identityReview: f.identityReview,
      },
    },
    pack,
  )
  return { status: s.status, label: STATUS_LABEL[s.status], overlays: s.overlays }
}

/**
 * R-CMP-03: whether a link may be given to someone new now. Turning a switch off keeps the terms of people already bound to a
 * link, but no new person is given terms the switches no longer allow (Codex round 3).
 */
export async function linkAssignable(c: Q, deal: Pick<D3Deal, 'id' | 'approved_version'>, l: LinkRow, viaOpenToken = false): Promise<boolean> {
  const st = linkState(l)
  if (st.disabled || st.closingPaused || st.awaitingApproval) return false
  const policy = await policyNow(c)
  // someone who arrives through an open link, when open links are off, is not let in; an invitation sent to them still works
  if (viaOpenToken && !policy.genericLinks) return false
  const snap = await approvedSnapshot(c, deal)
  const defaultCarry = snap?.snapshot.economics?.default_carry_bps ?? -1
  if (!policy.perLinkTerms && differs({ carryBps: l.carry_bps, fee: linkFee(l) }, defaultCarry)) return false
  return true
}
