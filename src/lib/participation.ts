// Investor status (PRD §5.2). Pure: the status is worked out from stored facts every time, never stored, so changing the
// pack's order of steps cannot make it wrong (TC-STAT-02). The names shown are this product's own.
import type { AnyDealState } from './gate.ts'
import type { RegimePack, StepKind } from './regimePack.ts'

export const OUTCOMES = ['active', 'removed', 'withdrawn', 'deal_cancelled', 'rejected_kyc', 'excluded_at_close'] as const
export type Outcome = (typeof OUTCOMES)[number]

export const STATUSES = [
  'declined',
  'removed',
  'withdrawn',
  'cancelled',
  'not_approved',
  'excluded',
  'not_responded',
  'getting_set_up',
  'deciding',
  'waitlisted',
  'verifying',
  'reconfirm',
  'confirm_amount',
  'to_sign',
  'to_pay',
  'payment_sent',
  'part_paid',
  'funded',
  'refund_due',
  'invested',
] as const
export type Status = (typeof STATUSES)[number]

export const STATUS_LABEL: Record<Status, string> = {
  declined: 'Declined',
  removed: 'Removed',
  withdrawn: 'Withdrawn',
  cancelled: 'Cancelled',
  not_approved: 'Not approved',
  excluded: 'Excluded at close',
  not_responded: 'Not responded',
  getting_set_up: 'Getting set up',
  deciding: 'Deciding',
  waitlisted: 'Waitlisted',
  verifying: 'Verifying',
  reconfirm: 'Reconfirm terms',
  confirm_amount: 'Confirm amount',
  to_sign: 'To sign',
  to_pay: 'To pay',
  payment_sent: 'Payment sent',
  part_paid: 'Part paid',
  funded: 'Funded',
  refund_due: 'Funded · refund due',
  invested: 'Invested',
}

export type Overlay = 'needs_check' | 'renew_statement' | 'identity_review' | 'no_response'

/** The facts one person has on one deal. A missing participation means they have not committed with this entity. */
export interface StatusFacts {
  /** null: only a pipeline row, no invitation yet. */
  invitation: 'active' | 'passed' | 'revoked' | null
  qualified: boolean
  /** The statement has run out (an overlay; the facts below still count). */
  statementExpired: boolean
  waitlisted: boolean
  participation: {
    outcome: Outcome
    kycPassed: boolean
    reconfirmPending: boolean
    /** §5.3: the reconfirmation's deadline has passed with no answer. Silence is never agreement: shown as no response. */
    reconfirmLapsed?: boolean
    amountProposalPending: boolean
    signed: boolean
    transferMarked: boolean
    /** N, money held (C-FEE-4). */
    held: bigint
    /** D, the amount to pay. */
    due: bigint
    /** Final investment once the deal is closed; null before. */
    invested: bigint | null
    identityReview: boolean
  } | null
}

const TERMINAL: Record<Exclude<Outcome, 'active'>, Status> = {
  removed: 'removed',
  withdrawn: 'withdrawn',
  deal_cancelled: 'cancelled',
  rejected_kyc: 'not_approved',
  excluded_at_close: 'excluded',
}

type Step = 'kyc' | 'reconfirm' | 'confirm_amount' | 'sign' | 'pay'

/** The steps after commit in the pack's order. Reconfirming and confirming an amount come before signing and paying. */
export function stepsAfterCommit(p: Pick<RegimePack, 'steps'>): Step[] {
  const kinds: StepKind[] = p.steps.map((s) => s.kind)
  const after = kinds.slice(kinds.indexOf('commit') + 1)
  const out: Step[] = []
  for (const k of after) {
    if (k === 'sign' || k === 'payment_instructions') {
      if (!out.includes('reconfirm')) out.push('reconfirm', 'confirm_amount')
      out.push(k === 'sign' ? 'sign' : 'pay')
    } else if (k === 'kyc') out.push('kyc')
  }
  return out
}

function payStatus(p: NonNullable<StatusFacts['participation']>): Status {
  // a negative N reads as nothing held underneath the overlay (§5.2): each test below treats it as 0
  const n = p.held
  if (n > p.due) return 'refund_due'
  if (n === p.due && n > 0n) return 'funded'
  if (n > 0n) return 'part_paid'
  return p.transferMarked ? 'payment_sent' : 'to_pay'
}

/** §5.2: terminal first, otherwise the first step not done in the pack's order. Exactly one status for any facts. */
export function deriveStatus(f: StatusFacts, p: Pick<RegimePack, 'steps'>): { status: Status; overlays: Overlay[] } {
  const overlays: Overlay[] = []
  if (f.statementExpired) overlays.push('renew_statement')
  const part = f.participation
  if (part) {
    if (part.held < 0n) overlays.push('needs_check')
    if (part.identityReview) overlays.push('identity_review')
    if (part.outcome === 'active' && part.reconfirmPending && part.reconfirmLapsed) overlays.push('no_response')
    if (part.outcome !== 'active') return { status: TERMINAL[part.outcome], overlays }
    if (part.invested !== null && part.invested > 0n) return { status: 'invested', overlays }
    const done: Record<Step, boolean> = {
      kyc: part.kycPassed,
      reconfirm: !part.reconfirmPending,
      confirm_amount: !part.amountProposalPending,
      sign: part.signed,
      pay: false,
    }
    const next = stepsAfterCommit(p).find((s) => !done[s])
    switch (next) {
      case 'kyc':
        return { status: 'verifying', overlays }
      case 'reconfirm':
        return { status: 'reconfirm', overlays }
      case 'confirm_amount':
        return { status: 'confirm_amount', overlays }
      case 'sign':
        return { status: 'to_sign', overlays }
      default:
        return { status: payStatus(part), overlays }
    }
  }
  if (f.invitation === null) return { status: 'not_responded', overlays }
  if (f.invitation === 'passed') return { status: 'declined', overlays }
  if (f.invitation === 'revoked') return { status: 'removed', overlays }
  if (!f.qualified) return { status: 'getting_set_up', overlays }
  return { status: f.waitlisted ? 'waitlisted' : 'deciding', overlays }
}

/** §5.2: N below zero, or an identity review, keeps a person out of new payment instructions. */
export const blocksNewInstructions = (p: NonNullable<StatusFacts['participation']>) => p.held < 0n || p.identityReview || p.reconfirmPending

// ---- Who the step waits on (§5.2, R-ADM-05) ----

export type Waiter = 'investor' | 'reviewer' | 'lead'

export interface WaitFacts {
  /** The entity's identity check is with a reviewer (not started, in progress or sent back is the investor's). */
  kycAwaitingReviewer: boolean
  dealState: AnyDealState
  /** R-CLS-01.1: the lead has decided for this person (anything but "wait"). */
  closingDecisionMade: boolean
  /** N above zero. */
  moneyOnHand: boolean
  /** H above zero, a hold of R-KYC-02.1. */
  held: boolean
  /** An ordinary refund is due or under way. */
  refundOpen: boolean
}

const BY_STATUS: Record<Status, Waiter | null> = {
  declined: null,
  removed: null,
  withdrawn: null,
  cancelled: null,
  not_approved: null,
  excluded: null,
  not_responded: 'investor',
  getting_set_up: 'investor',
  deciding: 'investor',
  waitlisted: 'lead',
  verifying: 'investor',
  reconfirm: 'investor',
  confirm_amount: 'investor',
  to_sign: 'investor',
  to_pay: 'investor',
  payment_sent: 'reviewer',
  part_paid: 'investor',
  funded: null,
  refund_due: 'reviewer',
  invested: null,
}

const TERMINAL_STATUSES: readonly Status[] = ['declined', 'removed', 'withdrawn', 'cancelled', 'not_approved', 'excluded']
const BEFORE_FUNDED: readonly Status[] = ['verifying', 'reconfirm', 'confirm_amount', 'to_sign', 'to_pay', 'payment_sent', 'part_paid']

/**
 * §5.2: who the step waits on, worked out from the same facts as the status. The overlays come first: an identity review or
 * money to check is the reviewer's; so is any hold or ordinary refund, shown alike so that a lead cannot tell a hold from a
 * refund; a missing closing decision is the lead's. A lead sees no more than this one word.
 */
export function waitingOn(s: { status: Status; overlays: readonly Overlay[] }, f: WaitFacts): Waiter | null {
  if (s.overlays.includes('identity_review') || s.overlays.includes('needs_check')) return 'reviewer'
  if (f.held || f.refundOpen) return 'reviewer'
  // §5.3: past the deadline with no answer, the lead may remove someone with no money; with money the operator decides
  if (s.overlays.includes('no_response')) return f.moneyOnHand ? 'reviewer' : 'lead'
  if (TERMINAL_STATUSES.includes(s.status)) return f.moneyOnHand ? 'reviewer' : null
  if (f.dealState === 'closing_requested' && BEFORE_FUNDED.includes(s.status) && !f.closingDecisionMade) return 'lead'
  if (s.status === 'verifying') return f.kycAwaitingReviewer ? 'reviewer' : 'investor'
  return BY_STATUS[s.status]
}

/** R-ADM-05: whole days since the person entered the status shown, by the app's clock; null when either time is unknown. */
export function daysInStatus(since: Date, now: Date): number | null {
  const a = since.getTime()
  const b = now.getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return b <= a ? 0 : Math.floor((b - a) / 86_400_000)
}

/**
 * §5.2: what happens to the invitation when a participation ends. Leaving, removal and exclusion revoke it in the same
 * transaction unless another entity of the person's is still active under it; a failed identity check never does, since the
 * problem is the entity and the person may commit with another. A cancelled deal is closed to everyone by its state.
 */
export function invitationAfterEnd(ending: Exclude<Outcome, 'active'>, otherActiveUnderInvitation: boolean): 'keep' | 'revoke' {
  if (ending === 'rejected_kyc' || ending === 'deal_cancelled') return 'keep'
  return otherActiveUnderInvitation ? 'keep' : 'revoke'
}

// ---- The lead's list (R-ADM-05) ----

/** A refused identity check is never shown to a lead (R-KYC-02.1): such a row reads as being with the operator. */
export type LeadStatus = Status | 'with_operator'
export const WITH_OPERATOR_LABEL = 'With the operator'

export interface LeadRowView {
  status: LeadStatus
  label: string
  waiting: Waiter | null
  /** §5.3: past the reconfirmation deadline with no answer, the one overlay a lead acts on. */
  noResponse: boolean
}

/**
 * R-ADM-05: one row as a lead sees it: the status, who it waits on and nothing else. Identity documents, return reasons, holds
 * and money to check are never named; they show only as the reviewer being the one waited on.
 */
export function leadRowView(s: { status: Status; overlays: readonly Overlay[] }, f: WaitFacts): LeadRowView {
  if (s.status === 'not_approved') return { status: 'with_operator', label: WITH_OPERATOR_LABEL, waiting: 'reviewer', noResponse: false }
  return { status: s.status, label: STATUS_LABEL[s.status], waiting: waitingOn(s, f), noResponse: s.overlays.includes('no_response') }
}

/** R-ADM-05: the list filtered by status and by who it waits on; `none` is a row that waits on nobody. */
export function leadRowMatches(r: Pick<LeadRowView, 'status' | 'waiting'>, f: { status?: LeadStatus; waiting?: Waiter | 'none' }): boolean {
  if (f.status && r.status !== f.status) return false
  if (f.waiting && (r.waiting ?? 'none') !== f.waiting) return false
  return true
}
