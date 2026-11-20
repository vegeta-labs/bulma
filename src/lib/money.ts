// Money held for one participation and the deal's live figures (PRD C-FEE-4, R-KYC-02.1, R-OPS-04, R-OPS-05, R-ALO-01..03).
// Pure; integer minor units, BigInt only. The server stores receipts and refunds as rows and applies each event through
// `applyMoney` inside the business transaction, so the two invariants of C-FEE-4 hold after every event.
import { commitmentRefusal, dueFor, mulDivHalfUp, MAX_DUE_MINOR, type LinkFee } from './fees.ts'
import type { Outcome } from './participation.ts'

const BPS = 10_000n

export interface Receipt {
  id: string
  /** What is still on this participation after moves out. */
  amount: bigint
  /** The part of this receipt a release decision covers (R-KYC-02.1). A new or restored receipt starts at 0. */
  released: bigint
  reversed: boolean
}

/** R-OPS-05: prepared refunds are not money yet; approved and sent are in flight; recorded is done. */
export type RefundState = 'approved' | 'sent' | 'recorded' | 'cancelled'

export interface Refund {
  id: string
  state: RefundState
  /** The approved amount; null when the refund was recorded without an approval. */
  approved: bigint | null
  /** The amount actually sent, once recorded. */
  actual: bigint | null
  /** C-FEE-4 占用: the part of the released money this refund uses. */
  occupied: bigint
}

export interface Ledger {
  receipts: Receipt[]
  refunds: Refund[]
}

/** What the participation is, for the figures. D is the amount to pay (C-FEE-1). */
export interface Position {
  outcome: Outcome
  due: bigint
}

/** From `settled` on, refunds follow the confirmed allocation: the cash it used is passed in (C-FEE-4). */
export interface Settlement {
  settled: boolean
  allocatedCash: bigint
}

export const NOT_SETTLED: Settlement = { settled: false, allocatedCash: 0n }
export const EMPTY_LEDGER: Ledger = { receipts: [], refunds: [] }

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n)
const max0 = (x: bigint) => (x > 0n ? x : 0n)
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const inFlight = (r: Refund) => r.state === 'approved' || r.state === 'sent'

export interface Figures {
  /** Received on receipts not reversed. */
  received: bigint
  refunded: bigint
  inFlight: bigint
  /** N = received − refunded − in flight. */
  onHand: bigint
  /** E: 0 when the outcome is not `active`, else min(N, D); never below 0. */
  effective: bigint
  released: bigint
  occupied: bigint
  /** R = released − occupied. */
  usable: bigint
  /** H: max(0, N − E − R) for `rejected_kyc`, else 0. */
  hold: bigint
  /** The one refund obligation (待退款); null when N < 0. */
  refundDue: bigint | null
  /** N < 0: the needs-check overlay (§5.2); no allocation, no new instructions, no refund approval. */
  needsCheck: boolean
}

/** C-FEE-4 for one participation, worked out from the rows every time; nothing here is a stored balance. */
export function figures(l: Ledger, p: Position, s: Settlement = NOT_SETTLED): Figures {
  const live = l.receipts.filter((r) => !r.reversed)
  const received = sum(live.map((r) => r.amount))
  const refunded = sum(l.refunds.filter((r) => r.state === 'recorded').map((r) => r.actual ?? 0n))
  const flight = sum(l.refunds.filter(inFlight).map((r) => r.approved ?? 0n))
  const onHand = received - refunded - flight
  const effective = p.outcome === 'active' ? max0(min(onHand, p.due)) : 0n
  const released = sum(live.map((r) => r.released))
  const occupied = sum(l.refunds.filter((r) => r.state !== 'cancelled').map((r) => r.occupied))
  const usable = released - occupied
  const hold = p.outcome === 'rejected_kyc' ? max0(onHand - effective - usable) : 0n
  const needsCheck = onHand < 0n
  const used = s.settled ? s.allocatedCash : effective
  return {
    received,
    refunded,
    inFlight: flight,
    onHand,
    effective,
    released,
    occupied,
    usable,
    hold,
    refundDue: needsCheck ? null : max0(onHand - used - hold),
    needsCheck,
  }
}

export type MoneyEvent =
  | { kind: 'receive'; id: string; amount: bigint }
  | { kind: 'reverse'; receipt: string }
  /** A reversed receipt brought back counts as new money: its release is gone. */
  | { kind: 'restore'; receipt: string }
  /** R-OPS-04: part or all of a receipt moved to another person or back to unallocated money. */
  | { kind: 'move_out'; receipt: string; amount: bigint }
  /** R-KYC-02.1: a release decision names the receipt, the amount and the reason. */
  | { kind: 'release'; receipt: string; amount: bigint; basis: string }
  | { kind: 'approve_refund'; id: string; amount: bigint }
  | { kind: 'send_refund'; refund: string }
  /** Only an approval not yet sent; a sent one comes back only with evidence that the recall worked (R-OPS-05). */
  | { kind: 'cancel_refund'; refund: string; recallEvidence?: string }
  /** Never refused once the money has gone: a different amount, no approval, or a hold meanwhile are all recorded. */
  | { kind: 'record_refund'; refund: string | null; id: string; actual: bigint }

export type Applied = { ok: true; ledger: Ledger } | { ok: false; reason: string }

const refuse = (reason: string): Applied => ({ ok: false, reason })

/** The most that may be moved off this participation now (R-OPS-04, R-KYC-02.1): cash not used by a confirmed allocation, not held. */
export function movable(l: Ledger, p: Position, s: Settlement = NOT_SETTLED): bigint {
  const f = figures(l, p, s)
  return max0(f.onHand - (s.settled ? s.allocatedCash : 0n) - f.hold)
}

/** The most a refund approval may be for now (R-OPS-05, C-FEE-4); 0 under the needs-check overlay. */
export function refundCap(l: Ledger, p: Position, s: Settlement = NOT_SETTLED): bigint {
  return figures(l, p, s).refundDue ?? 0n
}

/**
 * Applies one event and then restores the two invariants of C-FEE-4 in the same step:
 * (1) occupied ≤ released, taking the excess first from approvals that can still be cancelled, then from sent and finally
 * from recorded refunds, so cancelling an approval never brings back release already used; (2) R ≤ max(N, 0), taking back
 * release from the latest receipts. What is taken back is never restored without a new release decision.
 */
export function applyMoney(l: Ledger, e: MoneyEvent, p: Position, s: Settlement = NOT_SETTLED): Applied {
  const next: Ledger = { receipts: l.receipts.map((r) => ({ ...r })), refunds: l.refunds.map((r) => ({ ...r })) }
  const before = figures(l, p, s)
  const receipt = (id: string) => next.receipts.find((r) => r.id === id)
  const refund = (id: string) => next.refunds.find((r) => r.id === id)
  const idTaken = (id: string) => next.receipts.some((r) => r.id === id) || next.refunds.some((r) => r.id === id)

  switch (e.kind) {
    case 'receive': {
      if (e.amount < 1n) return refuse('A receipt must be above 0.')
      if (idTaken(e.id)) return refuse('That receipt is already recorded.')
      next.receipts.push({ id: e.id, amount: e.amount, released: 0n, reversed: false })
      break
    }
    case 'reverse': {
      const r = receipt(e.receipt)
      if (!r || r.reversed) return refuse('No such receipt to reverse.')
      r.reversed = true
      break
    }
    case 'restore': {
      const r = receipt(e.receipt)
      if (!r || !r.reversed) return refuse('No such reversed receipt.')
      r.reversed = false
      r.released = 0n
      break
    }
    case 'move_out': {
      const r = receipt(e.receipt)
      if (!r || r.reversed) return refuse('No such receipt to move.')
      if (e.amount < 1n || e.amount > r.amount) return refuse('The amount to move must be above 0 and no more than the receipt.')
      if (before.needsCheck) return refuse('This person’s money needs checking first.')
      if (e.amount > movable(l, p, s)) return refuse('That is more than the money free to move.')
      if (p.outcome === 'rejected_kyc' && e.amount > r.released) return refuse('Held money cannot be moved before a release decision.')
      // a part move takes the released part first (C-FEE-4)
      r.released -= min(r.released, e.amount)
      r.amount -= e.amount
      break
    }
    case 'release': {
      const r = receipt(e.receipt)
      if (p.outcome !== 'rejected_kyc') return refuse('Only held money is released.')
      if (!e.basis.trim()) return refuse('Give the reason for the release decision.')
      if (!r || r.reversed) return refuse('No such receipt to release.')
      if (e.amount < 1n) return refuse('The amount to release must be above 0.')
      if (e.amount > r.amount - r.released) return refuse('That is more than the part of this receipt not yet released.')
      if (e.amount > before.hold) return refuse('That is more than the money held now.')
      r.released += e.amount
      break
    }
    case 'approve_refund': {
      if (idTaken(e.id)) return refuse('That refund already exists.')
      if (before.needsCheck) return refuse('This person’s money needs checking first.')
      if (next.refunds.some(inFlight)) return refuse('Another refund for this person is already in progress.')
      if (e.amount < 1n) return refuse('The refund must be above 0.')
      if (e.amount > (before.refundDue ?? 0n)) return refuse('The refund is more than the amount due back.')
      next.refunds.push({ id: e.id, state: 'approved', approved: e.amount, actual: null, occupied: min(max0(before.usable), e.amount) })
      break
    }
    case 'send_refund': {
      const r = refund(e.refund)
      if (!r || r.state !== 'approved') return refuse('Only an approved refund can be marked sent.')
      r.state = 'sent'
      break
    }
    case 'cancel_refund': {
      const r = refund(e.refund)
      if (!r || !inFlight(r)) return refuse('Only a refund in progress can be cancelled.')
      if (r.state === 'sent' && !e.recallEvidence?.trim()) return refuse('A sent refund comes back only with evidence that the recall worked.')
      r.state = 'cancelled'
      r.occupied = 0n
      break
    }
    case 'record_refund': {
      if (e.actual < 1n) return refuse('The amount sent must be above 0.')
      if (e.refund === null) {
        if (idTaken(e.id)) return refuse('That refund already exists.')
        next.refunds.push({ id: e.id, state: 'recorded', approved: null, actual: e.actual, occupied: min(max0(before.usable), e.actual) })
        break
      }
      const r = refund(e.refund)
      if (!r || !inFlight(r)) return refuse('Only a refund in progress can be recorded.')
      const approved = r.approved ?? 0n
      if (e.actual < approved) r.occupied = min(r.occupied, e.actual)
      else r.occupied += min(max0(before.usable), e.actual - approved)
      r.state = 'recorded'
      r.actual = e.actual
      break
    }
  }
  restoreInvariants(next, p, s)
  return { ok: true, ledger: next }
}

const OCCUPATION_ORDER: RefundState[] = ['approved', 'sent', 'recorded']

function restoreInvariants(l: Ledger, p: Position, s: Settlement) {
  let f = figures(l, p, s)
  let excess = f.occupied - f.released
  for (const state of OCCUPATION_ORDER) {
    for (const r of [...l.refunds].reverse()) {
      if (excess <= 0n) break
      if (r.state !== state) continue
      const cut = min(r.occupied, excess)
      r.occupied -= cut
      excess -= cut
    }
  }
  f = figures(l, p, s)
  let over = f.usable - max0(f.onHand)
  for (const r of [...l.receipts].reverse()) {
    if (over <= 0n) break
    if (r.reversed) continue
    const cut = min(r.released, over)
    r.released -= cut
    over -= cut
  }
}

/** R-KYC-02.1: the three recorded steps of a hold. A release decision is the last; later money starts again at the first. */
export const HOLD_STEPS = ['considering', 'disclosure_consent', 'release_allowed'] as const
export type HoldStep = (typeof HOLD_STEPS)[number]

/** Whether the hold record may go from one step to another. Disclosure is skipped when none is needed. */
export function holdStepAllowed(from: HoldStep, to: HoldStep): boolean {
  if (from === 'considering') return to === 'disclosure_consent' || to === 'release_allowed'
  if (from === 'disclosure_consent') return to === 'release_allowed'
  return false
}

/** The hold step after an event: more held money than before goes back to considering. */
export function holdStepAfter(step: HoldStep, holdBefore: bigint, holdAfter: bigint): HoldStep {
  return holdAfter > holdBefore ? 'considering' : step
}

/**
 * C-FEE-4 发起人费 for one person: f(E) by the link's mode, as Goten C-ALL-1, C-ALL-4, C-ALL-6 and C-ALL-7 would at close
 * with no scale-back. A fixed fee is 0 when E ≤ F, else F. A percent fee is on the investment the money buys.
 */
export function leadFeeOn(effective: bigint, fee: LinkFee): bigint {
  if (effective < 0n) throw new RangeError('E cannot be negative')
  if (fee.kind === 'none' || effective === 0n) return 0n
  if (fee.kind === 'fixed') return effective <= fee.minor ? 0n : fee.minor
  const bps = BigInt(fee.bps)
  const feeOn = (i: bigint) => (fee.mode === 'deducted' ? mulDivHalfUp(i, bps, BPS - bps) : mulDivHalfUp(i, bps, BPS))
  // Goten's C-ALL-7 step (take a penny off I while I + fee > E) never applies with one fee: I + I × p ≤ E and E − I is
  // whole, so rounding I × p half up cannot pass E − I
  const invest = fee.mode === 'deducted' ? (effective * (BPS - bps)) / BPS : (effective * BPS) / (BPS + bps)
  return invest > 0n ? feeOn(invest) : 0n
}

export interface MetricsRow {
  outcome: Outcome
  commitment: bigint
  fee: LinkFee
  figures: Figures
}

/** R-ADM-02 as the lead sees it: a held person's money is only ever "operator handling"; no hold figure is in here. */
export interface LeadMetrics {
  committed: bigint
  received: bigint
  refundDue: bigint
  refunded: bigint
  operatorHandling: bigint
  leadFees: bigint
  usableGross: bigint
  needsCheck: number
}

export function leadMetrics(rows: MetricsRow[]): LeadMetrics {
  const m: LeadMetrics = { committed: 0n, received: 0n, refundDue: 0n, refunded: 0n, operatorHandling: 0n, leadFees: 0n, usableGross: 0n, needsCheck: 0 }
  for (const r of rows) {
    const f = r.figures
    if (r.outcome === 'active') m.committed += r.commitment
    m.received += f.received
    m.refunded += f.refunded
    if (f.needsCheck) m.needsCheck += 1
    if (r.outcome === 'rejected_kyc') m.operatorHandling += max0(f.onHand)
    else m.refundDue += f.refundDue ?? 0n
    const fee = leadFeeOn(f.effective, r.fee)
    m.leadFees += fee
    m.usableGross += f.effective - fee
  }
  return m
}

/** R-ADM-02 for reviewers and admins: the real hold and refund due of held people as well. */
export function operatorMetrics(rows: MetricsRow[]): LeadMetrics & { hold: bigint; heldRefundDue: bigint } {
  const lead = leadMetrics(rows)
  let hold = 0n
  let heldRefundDue = 0n
  for (const r of rows) {
    if (r.outcome !== 'rejected_kyc') continue
    hold += r.figures.hold
    heldRefundDue += r.figures.refundDue ?? 0n
  }
  return { ...lead, hold, heldRefundDue }
}

/**
 * R-ALO-02, the same split as Goten C-ALL-3: when Σ T is over the allocation, the allocation is shared in proportion to T
 * by largest remainder, equal remainders in joining order. Null when not over. Entries are in joining order.
 */
export function scaleBack(entries: { id: string; invest: bigint }[], allocation: bigint): { over: bigint; scaled: Map<string, bigint> } | null {
  if (allocation < 0n) throw new RangeError('the allocation cannot be negative')
  if (entries.some((e) => e.invest < 0n)) throw new RangeError('T cannot be negative')
  const total = sum(entries.map((e) => e.invest))
  if (total <= allocation) return null
  const parts = entries.map((e, order) => ({ id: e.id, order, base: (e.invest * allocation) / total, rest: (e.invest * allocation) % total }))
  let left = allocation - sum(parts.map((x) => x.base))
  const byRest = [...parts].sort((a, b) => (a.rest === b.rest ? a.order - b.order : a.rest > b.rest ? -1 : 1))
  for (const x of byRest) {
    if (left <= 0n) break
    x.base += 1n
    left -= 1n
  }
  return { over: total - allocation, scaled: new Map(parts.map((x) => [x.id, x.base])) }
}

export type CapacityMode = 'remind' | 'stop'
export type Capacity =
  | { kind: 'ok' }
  /** Remind mode: not blocked, the lead is warned (R-CMT-07). */
  | { kind: 'warn' }
  /** Stop mode: this amount does not fit, but a commitment up to `maxCommitment` does. */
  | { kind: 'limit'; maxCommitment: bigint }
  | { kind: 'waitlist' }

/**
 * R-ALO-03, judged in the same transaction as the commitment. `others` is Σ T of the other active participations (for an
 * increase, without this person's current T). Full means others + T > allocation. In stop mode a commitment can still be
 * made when some C ≥ the minimum, accepted by R-CMT-02, has a T within what is left.
 */
export function capacity(i: { mode: CapacityMode; allocation: bigint; others: bigint; commitment: bigint; fee: LinkFee; minimum: bigint }): Capacity {
  const invest = dueFor(i.commitment, i.fee).invest
  if (i.others + invest <= i.allocation) return { kind: 'ok' }
  if (i.mode === 'remind') return { kind: 'warn' }
  const most = largestCommitmentWithin(i.allocation - i.others, i.fee, i.minimum)
  return most === null ? { kind: 'waitlist' } : { kind: 'limit', maxCommitment: most }
}

/** The largest C that R-CMT-02 accepts with T ≤ `room`, or null when none. T and D both grow with C, so this is a search. */
export function largestCommitmentWithin(room: bigint, fee: LinkFee, minimum: bigint): bigint | null {
  const lowest = minimum > 1n ? minimum : 1n
  const fits = (c: bigint) => {
    const d = dueFor(c, fee)
    return d.invest <= room && d.due <= MAX_DUE_MINOR
  }
  if (room < 1n || lowest > MAX_DUE_MINOR || !fits(lowest)) return null
  let lo = lowest
  let hi = MAX_DUE_MINOR
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    if (fits(mid)) lo = mid
    else hi = mid - 1n
  }
  return commitmentRefusal(lo, fee, minimum) === null ? lo : null
}

/** R-ALO-01: why no new amount can be proposed for this person at all, whatever the amount (also the panel's row action). */
export function proposalBlocked(i: { dealState: string; onHand: bigint; transferMarked: boolean }): string | null {
  if (i.dealState !== 'live') return 'A new amount can only be proposed while the deal is live.'
  if (i.onHand !== 0n) return 'Money has arrived for this person, so the amount cannot be changed this way.'
  if (i.transferMarked) return 'This person has said they paid, so the amount cannot be changed this way.'
  return null
}

/** R-ALO-01: why the lead cannot propose a new amount now, or null. */
export function proposalRefusal(i: {
  dealState: string
  onHand: bigint
  transferMarked: boolean
  current: bigint
  proposed: bigint
  fee: LinkFee
  minimum: bigint
}): string | null {
  const blocked = proposalBlocked(i)
  if (blocked) return blocked
  if (i.proposed === i.current) return 'Propose an amount different from the current one.'
  return commitmentRefusal(i.proposed, i.fee, i.minimum)
}

/** R-ALO-01: why the investor's acceptance cannot take effect, or null. An increase also passes R-ALO-03. */
export function acceptProposalRefusal(i: { onHand: bigint; current: bigint; proposed: bigint; capacity: Capacity }): string | null {
  if (i.onHand !== 0n) return 'Money has arrived, so the proposal has ended and the amount stays as it was.'
  if (i.proposed > i.current && i.capacity.kind !== 'ok' && i.capacity.kind !== 'warn') return 'There is no longer room in the deal for this amount.'
  return null
}

/**
 * R-OPS-05, PRD §5.1 table: why money is due back. One obligation per person (C-FEE-4); the reason changes only as history.
 * From `settled` on an active person's refund is what the confirmed allocation did not use (scale-back, rounding, late money).
 */
export type RefundReason = 'overpaid' | 'after_allocation' | 'withdrawn' | 'removed' | 'deal_cancelled' | 'released' | 'excluded_at_close'

export function refundReason(outcome: Outcome, settled: boolean): RefundReason {
  if (outcome === 'active') return settled ? 'after_allocation' : 'overpaid'
  if (outcome === 'rejected_kyc') return 'released'
  return outcome
}

/** R-WDR-04: money that arrived after the person's part ended (removed, withdrew, not investing, cancelled) is late money. An active part has no end. */
export function isLateMoney(endedAt: string | null, receivedAt: string): boolean {
  return endedAt !== null && receivedAt > endedAt
}

/** R-OPS-05: what is recorded as it happened and goes to the workbench. Recording itself is never refused. */
export type RefundException = 'no_approval' | 'amount_differs' | 'commitment_changed' | 'held_meanwhile' | 'account_differs'

export function refundExceptions(i: {
  approved: bigint | null
  actual: bigint
  dueAtApproval: bigint | null
  dueNow: bigint
  heldAtApproval: boolean
  heldNow: boolean
}): RefundException[] {
  if (i.approved === null) return i.heldNow ? ['no_approval', 'held_meanwhile'] : ['no_approval']
  const out: RefundException[] = []
  if (i.actual !== i.approved) out.push('amount_differs')
  if (i.dueAtApproval !== null && i.dueNow !== i.dueAtApproval) out.push('commitment_changed')
  if (i.heldNow && !i.heldAtApproval) out.push('held_meanwhile')
  return out
}
