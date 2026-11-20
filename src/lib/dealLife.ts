// Deal states from `live` onwards (PRD §5.1, R-CLS-01, R-WDR-03), and the table of what may be done in each state. Pure and
// refuse-by-default: a fact that is missing counts against the move. The rows into `settled` and `closed`, and the payout
// exception that the system enters, arrive with D5; the exception is already a fact here because it stops cancelling and
// returning to `live`.
import { EXCLUSION_WORDS, messageRefusal } from './message.ts'
import { notLiveReason, ONE_CHANGE_OPEN } from './change.ts'
import type { AnyDealState } from './gate.ts'
import { proposalBlocked } from './money.ts'
import type { Outcome } from './participation.ts'

export type LifeState = 'live' | 'closing_requested' | 'closing' | 'cancelled' | 'archived'
export type LifeEvent = 'request_closing' | 'withdraw_closing' | 'start_closing' | 'return_to_live' | 'cancel' | 'archive'
export type LifeActor = 'lead' | 'reviewer'

export const LIFE_STATES: readonly LifeState[] = ['live', 'closing_requested', 'closing', 'cancelled', 'archived']
export const LIFE_EVENTS: readonly LifeEvent[] = ['request_closing', 'withdraw_closing', 'start_closing', 'return_to_live', 'cancel', 'archive']

/** R-CLS-01. `raisedMinor` is the sum of committed T when closing is asked for, and of allocated T (C-FEE-2's B) after. */
export interface ClosingFacts {
  investeeVerified: boolean
  investeeUboKycPassed: boolean
  leadKycPassed: boolean
  reconfirmPending: number
  hold: boolean
  minRaiseMinor: bigint | null
  raisedMinor: bigint
}

/** R-CLS-01: every reason the deal cannot ask for closing (or enter `closing`), in a fixed order. Empty means none. */
export function closingGaps(f: ClosingFacts): string[] {
  const out: string[] = []
  if (f.investeeVerified !== true) out.push('The company has not confirmed the deal.')
  if (f.investeeUboKycPassed !== true) out.push('The people who control the company have not passed identity checks.')
  if (f.leadKycPassed !== true) out.push('The lead has not passed identity checks.')
  if (!(Number.isInteger(f.reconfirmPending) && f.reconfirmPending === 0)) out.push('Some investors still have to reconfirm the terms.')
  if (f.hold !== false) out.push('A compliance hold is in force.')
  if (f.minRaiseMinor !== null && !(typeof f.raisedMinor === 'bigint' && f.raisedMinor >= f.minRaiseMinor)) out.push('The minimum raise has not been reached.')
  return out
}

export interface CancelRequest {
  by: LifeActor
  userId: string
}

export interface LifeFacts {
  actor: LifeActor
  userId: string
  reason?: string
  /** R-REV-04 for the reviewer who acts. */
  reviewerConflicted?: boolean
  closing?: ClosingFacts
  /** R-CLS-01.1: investors not fully funded with no decision yet, or with "wait". */
  closingDecisionsOpen?: number
  /** R-CLS-06.1. */
  payoutException?: boolean
  /** R-CLS-06: a release order that is not voided. */
  openReleaseOrder?: boolean
  /** R-CLS-06: what the operator wrote to say the money did not go out. */
  moneyNotSentNote?: string
  /** For `cancel`: the request this confirms (R-WDR-03). */
  cancelRequest?: CancelRequest
  /** For `archive`: refund to-dos not finished, and holds not released. */
  refundsOpen?: number
  holdsOpen?: number
}

/** What the server does in the same transaction as the move. */
export type LifeEffect =
  'pause_links_for_closing' | 'end_amount_proposals' | 'resume_links_paused_for_closing' | 'void_release_order' | 'apply_cancel_to_each_investor' | 'notify_all'

export type LifeDecision = { ok: true; to: LifeState; effects: LifeEffect[] } | { ok: false; reason: string }

const MOVES = new Map<LifeEvent, { actors: readonly LifeActor[]; from: ReadonlyMap<LifeState, LifeState> }>([
  ['request_closing', { actors: ['lead'], from: new Map([['live', 'closing_requested']]) }],
  ['withdraw_closing', { actors: ['lead', 'reviewer'], from: new Map([['closing_requested', 'live']]) }],
  ['start_closing', { actors: ['reviewer'], from: new Map([['closing_requested', 'closing']]) }],
  ['return_to_live', { actors: ['reviewer'], from: new Map([['closing', 'live']]) }],
  [
    'cancel',
    {
      actors: ['reviewer'],
      from: new Map([
        ['live', 'cancelled'],
        ['closing_requested', 'cancelled'],
        ['closing', 'cancelled'],
      ]),
    },
  ],
  ['archive', { actors: ['reviewer'], from: new Map([['cancelled', 'archived']]) }],
])

const isZero = (n: number | undefined) => n === 0
const blank = (s: string | undefined) => !s?.trim()

/** R-WDR-03: who may ask for a cancellation. A lead asks a reviewer; a reviewer asks a second person. */
export function cancelRequestRefusal(state: AnyDealState, f: { actor: LifeActor; payoutException?: boolean }): string | null {
  if (state !== 'live' && state !== 'closing_requested' && state !== 'closing') return 'A deal in this state cannot be cancelled.'
  if (f.payoutException !== false) return 'The deal cannot be cancelled while a payout is being sorted out.'
  return f.actor === 'lead' || f.actor === 'reviewer' ? null : 'You cannot cancel this deal.'
}

/** Who confirms a cancellation: always a reviewer with no stake, never the person who asked, in the sandbox too (R28 (10)). */
function cancelConfirmRefusal(f: LifeFacts): string | null {
  const req = f.cancelRequest
  if (!req) return 'Nobody has asked for this deal to be cancelled.'
  if (!req.userId || req.userId === f.userId) return 'Someone other than the person who asked must confirm the cancellation.'
  return null
}

function releaseOrderRefusal(f: LifeFacts): string | null {
  if (f.payoutException !== false) return 'Not while a payout is being sorted out.'
  if (f.openReleaseOrder === false) return null
  if (f.openReleaseOrder === true && !blank(f.moneyNotSentNote)) return null
  return 'A release order is open: write down that the money was not sent.'
}

function refusal(event: LifeEvent, f: LifeFacts): string | null {
  if (f.actor === 'reviewer' && f.reviewerConflicted !== false) return 'You cannot act as reviewer on a deal you lead, work on, or receive carry from.'
  switch (event) {
    case 'request_closing':
    case 'start_closing': {
      if (!f.closing) return 'What the deal still needs could not be checked.'
      const gaps = closingGaps(f.closing)
      if (gaps.length) return `Not yet: ${gaps.join(' ')}`
      if (event === 'start_closing' && !isZero(f.closingDecisionsOpen))
        return 'Decide for every investor who has not paid in full, and nobody may be left waiting.'
      return null
    }
    case 'withdraw_closing':
      return null
    case 'return_to_live':
      if (blank(f.reason)) return 'Give a reason.'
      return releaseOrderRefusal(f)
    case 'cancel':
      return cancelConfirmRefusal(f) ?? releaseOrderRefusal(f)
    case 'archive':
      if (!isZero(f.refundsOpen)) return 'Finish every refund first.'
      return isZero(f.holdsOpen) ? null : 'Release or settle every hold first.'
  }
}

const EFFECTS: Record<LifeEvent, LifeEffect[]> = {
  request_closing: ['pause_links_for_closing', 'end_amount_proposals'],
  withdraw_closing: ['resume_links_paused_for_closing'],
  start_closing: [],
  return_to_live: ['void_release_order', 'resume_links_paused_for_closing'],
  cancel: ['void_release_order', 'apply_cancel_to_each_investor', 'notify_all'],
  archive: [],
}

/** PRD §5.1 from `live` on: where this event takes the deal, or why it cannot happen. */
export function decideLife(from: LifeState, event: LifeEvent, f: LifeFacts): LifeDecision {
  const move = MOVES.get(event)
  const to = move?.from.get(from)
  if (!move || to === undefined) return { ok: false, reason: 'That cannot be done to a deal in this state.' }
  if (!move.actors.includes(f.actor) || !f.userId) return { ok: false, reason: 'You cannot do that to this deal.' }
  const why = refusal(event, f)
  if (why !== null) return { ok: false, reason: why }
  // a release order is voided only where one is open; the other effects always apply
  const effects = EFFECTS[event].filter((e) => e !== 'void_release_order' || f.openReleaseOrder === true)
  return { ok: true, to, effects }
}

/** §5.1: withdrawing closing, or a return to `live`, resumes only links paused for closing; a link the lead turned off stays off. */
export const afterClosingEnds = <L extends { disabled: boolean; closingPaused: boolean }>(l: L): L => ({ ...l, closingPaused: false })

export interface CancelledInvestor {
  committed: boolean
  /** Payment instructions issued and not voided. */
  instructionsOpen: boolean
  /** N, money held (C-FEE-4). */
  held: bigint
}

export interface CancelOutcome {
  case: 'not_committed' | 'committed' | 'instructions_sent' | 'money_received'
  /** The participation becomes `deal_cancelled`. */
  endParticipation: boolean
  voidInstructions: boolean
  /** The urgent "do not pay" mail (R-NTF-01). */
  doNotPayMail: boolean
  /** A refund to-do for what is held; money on hold stays on hold until released (R-KYC-02.1). */
  refundToDo: boolean
}

/** §5.1's table of what a cancellation does to each investor. Everyone is told; signed documents are kept. */
export function onCancel(p: CancelledInvestor): CancelOutcome {
  if (!p.committed) return { case: 'not_committed', endParticipation: false, voidInstructions: false, doNotPayMail: false, refundToDo: false }
  const money = p.held > 0n
  const kase = money ? 'money_received' : p.instructionsOpen ? 'instructions_sent' : 'committed'
  return { case: kase, endParticipation: true, voidInstructions: p.instructionsOpen, doNotPayMail: p.instructionsOpen, refundToDo: money }
}

// ---- What may be done in each state (§5.1's action table) ----

export const ACTIONS = [
  'commit',
  'change_commitment',
  'sign',
  'see_instructions',
  'record_receipt',
  'approve_refund',
  'approve_refund_final',
  'reconfirm_change',
  'text_correction',
  'change_limits',
  'reconfirm',
  'remove',
  'withdraw',
  'replace_link',
  'adjust_or_waitlist',
  'release_order',
  'bulk_message',
] as const
export type Action = (typeof ACTIONS)[number]

/**
 * A cell: `yes`, `no`, or yes with a limit the caller must still apply: before the final amounts are confirmed; only for people
 * who have not committed; only for people who have; only reconfirmations already under way; late money goes to refunds; from
 * `settled` on; in the payout stage (④); company updates.
 */
export type Cell =
  'yes' | 'no' | 'before_final' | 'uncommitted' | 'committed' | 'under_way' | 'late_to_refund' | 'from_settled' | 'payout_stage' | 'company_updates'

type Column = 'live' | 'closing_requested' | 'closing' | 'closed' | 'cancelled'

// rows in ACTIONS order; columns live, closing_requested, closing, closed, cancelled
const TABLE: Record<Action, readonly [Cell, Cell, Cell, Cell, Cell]> = {
  commit: ['yes', 'no', 'no', 'no', 'no'],
  change_commitment: ['yes', 'no', 'no', 'no', 'no'],
  sign: ['yes', 'yes', 'before_final', 'no', 'no'],
  see_instructions: ['yes', 'yes', 'before_final', 'no', 'no'],
  record_receipt: ['yes', 'yes', 'yes', 'late_to_refund', 'late_to_refund'],
  approve_refund: ['yes', 'yes', 'yes', 'yes', 'yes'],
  approve_refund_final: ['no', 'no', 'no', 'from_settled', 'no'],
  reconfirm_change: ['yes', 'no', 'no', 'no', 'no'],
  text_correction: ['yes', 'yes', 'yes', 'no', 'no'],
  change_limits: ['yes', 'no', 'no', 'no', 'no'],
  reconfirm: ['yes', 'under_way', 'no', 'no', 'no'],
  remove: ['yes', 'yes', 'no', 'no', 'no'],
  withdraw: ['yes', 'yes', 'before_final', 'no', 'no'],
  replace_link: ['uncommitted', 'no', 'no', 'no', 'no'],
  adjust_or_waitlist: ['yes', 'no', 'no', 'no', 'no'],
  release_order: ['no', 'no', 'payout_stage', 'no', 'no'],
  bulk_message: ['yes', 'committed', 'committed', 'company_updates', 'no'],
}
const AT = { live: 0, closing_requested: 1, closing: 2, closed: 3, cancelled: 4 } as const satisfies Record<Column, number>

export interface ActionContext {
  state: AnyDealState
  /** R-CLS-06.1: the deal is in the payout exception. */
  payoutException: boolean
}

/**
 * §5.1: whether an action may be done in this state, and under what limit. `settled` acts as `closed` except that company
 * updates wait for `closed`; the payout exception acts as `closing`, adds reconfirming, and freezes refund approvals. A cancelled
 * or archived deal only takes money in (to be refunded) and refunds it: the table is silent there, and this is the least.
 * States before `live` have none of these actions.
 */
export function actionCell(action: Action, c: ActionContext): Cell {
  if (!Object.hasOwn(TABLE, action)) return 'no'
  const row = TABLE[action]
  if (c.payoutException) {
    if (action === 'approve_refund' || action === 'approve_refund_final') return 'no'
    if (action === 'reconfirm' || action === 'reconfirm_change') return 'yes'
    return row[AT.closing]
  }
  const column: Column | null =
    c.state === 'settled' || c.state === 'closed'
      ? 'closed'
      : c.state === 'archived'
        ? 'cancelled'
        : c.state === 'live' || c.state === 'closing_requested' || c.state === 'closing' || c.state === 'cancelled'
          ? c.state
          : null
  if (column === null) return 'no'
  const cell = row[AT[column]]
  if (c.state === 'settled' && cell === 'company_updates') return 'no'
  return cell
}

// ---- Removal and withdrawal (R-WDR-01, R-WDR-02) ----

export interface EndingFacts {
  /** Any receipt still counted for this person, refunded or not: money has arrived (R-WDR-02). */
  moneyArrived: boolean
  /** The person said "I have paid" (R-PAY-04). */
  transferMarked: boolean
  /** For a removal after "I have paid": the lead says they checked where the money is. */
  moneyChecked?: boolean
}

/** R-WDR-01: removal is only for someone whose money never arrived; after "I have paid" the lead first checks the money. */
export function removeRefusal(f: EndingFacts): string | null {
  if (f.moneyArrived !== false) return 'Money has arrived from this person: record a withdrawal instead.'
  if (f.transferMarked !== false && f.moneyChecked !== true) return 'This person said they have paid: check where the money is first, then confirm.'
  return null
}

/** R-WDR-02: a withdrawal is the way out once any money has arrived, and needs the person's written consent. */
export function withdrawalRefusal(f: Pick<EndingFacts, 'moneyArrived'> & { consentConfirmed: boolean; evidence: string }): string | null {
  if (f.moneyArrived !== true) return 'No money has arrived from this person: remove them instead.'
  if (f.consentConfirmed !== true) return "Confirm that you have the investor's written consent."
  return f.evidence.trim().length >= 3 ? null : 'Say where the written consent is: paste the email or name the document.'
}

// ---- The lead's row actions (R-ADM-06) ----

export const ROW_ACTIONS = ['email', 'view_documents', 'remove', 'withdrawal', 'replace_link', 'amount_proposal', 'change_terms'] as const
export type RowAction = (typeof ROW_ACTIONS)[number]

export interface RowActionFacts {
  state: AnyDealState
  payoutException: boolean
  /** The lead or a co-lead; the deal's team only reads (R-SYN-06). */
  isLead: boolean
  /** The invitation is still open (not passed or revoked). */
  invitationActive: boolean
  /** The person has committed under this invitation, so its terms are fixed (R-LNK-05). */
  termsFrozen: boolean
  /** The row's commitment, or null for an invitation with none. */
  part: null | {
    outcome: Outcome
    moneyArrived: boolean
    transferMarked: boolean
    onHand: bigint
    withdrawalOpen: boolean
    proposalOpen: boolean
  }
  /** A change to this deal is waiting for a decision (one at a time). */
  changeOpen: boolean
  /** A hold at any level (R-CMP-01). */
  held: boolean
}

export interface RowActionView {
  action: RowAction
  allowed: boolean
  /** Why not, in the words the action itself would refuse with. */
  why: string | null
  /** The action asks the lead to confirm they checked where the money is (R-WDR-01 after "I have paid"). */
  confirm?: 'money_checked'
}

const ONLY_LEADS = 'Only the lead or a co-lead can do this.'
const NOT_COMMITTED = 'This person has not committed.'
const ENDED = 'This commitment has already ended.'

/** R-ADM-06: each action on one row of the lead's list, allowed or with the reason the action itself would give. */
export function rowActions(f: RowActionFacts): RowActionView[] {
  const ctx = { state: f.state, payoutException: f.payoutException }
  const p = f.part
  const why = (a: RowAction): string | null => {
    if (a === 'view_documents') return p ? null : NOT_COMMITTED
    if (a === 'email') {
      // R-COM-02: as the message route refuses; someone with no part in the deal any more would get nothing
      const no = messageRefusal({ state: f.state, isLead: f.isLead, held: f.held, bulk: false, bulkAllowed: true })
      return no ?? (f.invitationActive || p?.outcome === 'active' ? null : EXCLUSION_WORDS.ended)
    }
    if (!f.isLead) return ONLY_LEADS
    if (a === 'replace_link') {
      if (actionCell('replace_link', ctx) !== 'uncommitted') return 'Links can be replaced only while the deal is live.'
      if (!f.invitationActive) return 'This invitation has ended.'
      return f.termsFrozen ? 'This person has committed, so their terms are fixed. A change goes through a change request.' : null
    }
    if (!p) return NOT_COMMITTED
    if (a === 'remove' || a === 'withdrawal') {
      const cell = actionCell(a === 'remove' ? 'remove' : 'withdraw', ctx)
      if (cell !== 'yes' && cell !== 'before_final')
        return a === 'remove' ? 'Nobody can be removed in this state.' : 'A withdrawal cannot be recorded in this state.'
      if (p.outcome !== 'active') return ENDED
      if (a === 'remove') return removeRefusal({ moneyArrived: p.moneyArrived, transferMarked: p.transferMarked, moneyChecked: true })
      const no = withdrawalRefusal({ moneyArrived: p.moneyArrived, consentConfirmed: true, evidence: 'consent' })
      return no ?? (p.withdrawalOpen ? 'A withdrawal for this person is already waiting for a reviewer.' : null)
    }
    if (p.outcome !== 'active') return ENDED
    if (a === 'amount_proposal') {
      const no = proposalBlocked({ dealState: f.state, onHand: p.onHand, transferMarked: p.transferMarked })
      return no ?? (p.proposalOpen ? 'A new amount for this person is already waiting for their answer.' : null)
    }
    if (f.state !== 'live') return notLiveReason(f.state)
    return f.changeOpen ? ONE_CHANGE_OPEN : null
  }
  return ROW_ACTIONS.map((action) => {
    const w = why(action)
    const v: RowActionView = { action, allowed: w === null, why: w }
    if (action === 'remove' && w === null && p!.transferMarked) v.confirm = 'money_checked'
    return v
  })
}
