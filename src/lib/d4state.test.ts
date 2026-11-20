import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONTENT_ITEMS,
  changesShown,
  classifyChange,
  decideChange,
  needsJudgement,
  personChangeRefusal,
  personTermsRefusal,
  PRICE_HIDDEN_TEXT,
  termsChanges,
  selfServiceOnly,
  type ChangeInput,
  type Classified,
} from './change.ts'
import { howToChange, SELF_SERVICE_FIELDS } from './change.ts'
import { changesInWords } from './dealSheet.ts'
import { ROW_ACTIONS, rowActions, type RowActionFacts } from './dealLife.ts'
import { deadlineState, exclusionRefusal, onDisagree, onLapse, statementPauses, workingDayDeadline } from './deadline.ts'
import { capacityMode, capacityRefusal, proposalLapsed, relationshipEnd, releaseRefusal, waitlistRefusal } from './allocation.ts'
import {
  ACTIONS,
  actionCell,
  afterClosingEnds,
  cancelRequestRefusal,
  closingGaps,
  decideLife,
  LIFE_EVENTS,
  LIFE_STATES,
  onCancel,
  removeRefusal,
  withdrawalRefusal,
  type Action,
  type Cell,
  type ClosingFacts,
  type LifeActor,
  type LifeEvent,
  type LifeFacts,
  type LifeState,
} from './dealLife.ts'
import type { Draft } from './draft.ts'
import { canReceivePromotion, type AnyDealState, type DealGateFacts } from './gate.ts'
import { audienceOf, deliveryFor, messageProblems, messageRefusal, unfinishedNames, type AudienceRow, type RecipientFacts } from './message.ts'
import { MAX_TARGET, raiseFor } from './estimate.ts'
import { MAX_MINOR, platformFee } from './fees.ts'
import {
  daysInStatus,
  deriveStatus,
  invitationAfterEnd,
  leadRowMatches,
  leadRowView,
  STATUSES,
  waitingOn,
  type Overlay,
  type Status,
  type StatusFacts,
  type WaitFacts,
} from './participation.ts'
import { parsePack } from './regimePack.ts'

// ---------------------------------------------------------------- deal states from live (TC-DEAL-07)

const CLOSING_OK: ClosingFacts = {
  investeeVerified: true,
  investeeUboKycPassed: true,
  leadKycPassed: true,
  reconfirmPending: 0,
  hold: false,
  minRaiseMinor: 10_000_000n,
  raisedMinor: 10_000_000n,
}
const good = (actor: LifeActor, userId = actor === 'lead' ? 'u-lead' : 'u-rev2'): LifeFacts => ({
  actor,
  userId,
  reason: 'Because.',
  reviewerConflicted: false,
  closing: CLOSING_OK,
  closingDecisionsOpen: 0,
  payoutException: false,
  openReleaseOrder: false,
  cancelRequest: { by: 'reviewer', userId: 'u-rev1' },
  refundsOpen: 0,
  holdsOpen: 0,
})

const LEGAL: Array<[LifeState, LifeEvent, LifeState, LifeActor]> = [
  ['live', 'request_closing', 'closing_requested', 'lead'],
  ['closing_requested', 'withdraw_closing', 'live', 'lead'],
  ['closing_requested', 'withdraw_closing', 'live', 'reviewer'],
  ['closing_requested', 'start_closing', 'closing', 'reviewer'],
  ['closing', 'return_to_live', 'live', 'reviewer'],
  ['live', 'cancel', 'cancelled', 'reviewer'],
  ['closing_requested', 'cancel', 'cancelled', 'reviewer'],
  ['closing', 'cancel', 'cancelled', 'reviewer'],
  ['cancelled', 'archive', 'archived', 'reviewer'],
]

describe('deal states from live', () => {
  it.each(LEGAL)('TC-DEAL-07 %s + %s goes to %s for the %s', (from, event, to, actor) => {
    const r = decideLife(from, event, good(actor))
    expect(r.ok && r.to).toBe(to)
  })

  it('TC-DEAL-07 every other state, event and actor is refused however good the facts', () => {
    let refused = 0
    for (const from of LIFE_STATES)
      for (const event of LIFE_EVENTS)
        for (const actor of ['lead', 'reviewer'] as const) {
          if (LEGAL.some((l) => l[0] === from && l[1] === event && l[3] === actor)) continue
          expect(decideLife(from, event, good(actor)).ok, `${from} ${event} ${actor}`).toBe(false)
          refused++
        }
    expect(refused).toBe(LIFE_STATES.length * LIFE_EVENTS.length * 2 - LEGAL.length)
    for (const bad of ['__proto__', 'constructor', 'settled'])
      expect(decideLife(bad as LifeState, 'cancel', good('reviewer')).ok || decideLife('live', bad as LifeEvent, good('lead')).ok).toBe(false)
  })

  it('TC-DEAL-07 asking for closing pauses invitations and ends amount proposals; withdrawing resumes only those paused for closing', () => {
    expect(decideLife('live', 'request_closing', good('lead'))).toEqual({
      ok: true,
      to: 'closing_requested',
      effects: ['pause_links_for_closing', 'end_amount_proposals'],
    })
    expect(decideLife('closing_requested', 'withdraw_closing', good('reviewer'))).toEqual({
      ok: true,
      to: 'live',
      effects: ['resume_links_paused_for_closing'],
    })
    expect(afterClosingEnds({ disabled: true, closingPaused: true })).toEqual({ disabled: true, closingPaused: false })
    expect(afterClosingEnds({ disabled: false, closingPaused: true })).toEqual({ disabled: false, closingPaused: false })
  })

  it('TC-DEAL-07 closing needs every R-CLS-01 condition, each named, and refuses when they were not checked', () => {
    expect(closingGaps(CLOSING_OK)).toEqual([])
    expect(closingGaps({ ...CLOSING_OK, minRaiseMinor: null, raisedMinor: 0n })).toEqual([])
    const all = closingGaps({
      investeeVerified: false,
      investeeUboKycPassed: false,
      leadKycPassed: false,
      reconfirmPending: 2,
      hold: true,
      minRaiseMinor: 10_000_000n,
      raisedMinor: 9_999_999n,
    })
    expect(all).toHaveLength(6)
    for (const [k, v] of [
      ['investeeVerified', false],
      ['investeeUboKycPassed', false],
      ['leadKycPassed', false],
      ['reconfirmPending', 1],
      ['hold', true],
      ['raisedMinor', 9_999_999n],
    ] as const) {
      const f = { ...CLOSING_OK, [k]: v }
      expect(closingGaps(f), k).toHaveLength(1)
      for (const ev of ['request_closing', 'start_closing'] as const) {
        const from = ev === 'request_closing' ? 'live' : 'closing_requested'
        const r = decideLife(from, ev, { ...good(ev === 'request_closing' ? 'lead' : 'reviewer'), closing: f })
        expect(r.ok, `${k} ${ev}`).toBe(false)
      }
    }
    expect(decideLife('live', 'request_closing', { ...good('lead'), closing: undefined }).ok).toBe(false)
  })

  it('TC-DEAL-07 entering closing needs every closing decision made, with nobody left waiting, and a reviewer with no stake', () => {
    expect(decideLife('closing_requested', 'start_closing', { ...good('reviewer'), closingDecisionsOpen: 1 }).ok).toBe(false)
    expect(decideLife('closing_requested', 'start_closing', { ...good('reviewer'), closingDecisionsOpen: undefined }).ok).toBe(false)
    expect(decideLife('closing_requested', 'start_closing', { ...good('reviewer'), reviewerConflicted: true }).ok).toBe(false)
    expect(decideLife('closing_requested', 'start_closing', { ...good('reviewer'), reviewerConflicted: undefined }).ok).toBe(false)
  })

  it('TC-DEAL-07 going back to live needs a reason; an open release order needs a written note that the money was not sent', () => {
    expect(decideLife('closing', 'return_to_live', { ...good('reviewer'), reason: '  ' }).ok).toBe(false)
    expect(decideLife('closing', 'return_to_live', { ...good('reviewer'), openReleaseOrder: true }).ok).toBe(false)
    expect(decideLife('closing', 'return_to_live', { ...good('reviewer'), openReleaseOrder: undefined }).ok).toBe(false)
    expect(decideLife('closing', 'return_to_live', { ...good('reviewer'), openReleaseOrder: true, moneyNotSentNote: 'Bank confirms nothing left.' })).toEqual({
      ok: true,
      to: 'live',
      effects: ['void_release_order', 'resume_links_paused_for_closing'],
    })
  })

  it('TC-DEAL-07 the payout exception stops cancelling and going back to live', () => {
    expect(decideLife('closing', 'return_to_live', { ...good('reviewer'), payoutException: true }).ok).toBe(false)
    expect(decideLife('closing', 'cancel', { ...good('reviewer'), payoutException: true }).ok).toBe(false)
    expect(decideLife('closing', 'cancel', { ...good('reviewer'), payoutException: undefined }).ok).toBe(false)
    expect(cancelRequestRefusal('closing', { actor: 'lead', payoutException: true })).not.toBeNull()
    expect(cancelRequestRefusal('closing', { actor: 'lead' })).not.toBeNull()
  })

  it('TC-DEAL-07 a cancellation is asked for by the lead or a reviewer and confirmed by a different reviewer, never after settled', () => {
    for (const s of ['live', 'closing_requested', 'closing'] as const) {
      expect(cancelRequestRefusal(s, { actor: 'lead', payoutException: false })).toBeNull()
      expect(cancelRequestRefusal(s, { actor: 'reviewer', payoutException: false })).toBeNull()
    }
    for (const s of ['settled', 'closed', 'cancelled', 'archived', 'approved', 'draft'] as const)
      expect(cancelRequestRefusal(s, { actor: 'reviewer', payoutException: false })).not.toBeNull()
    // the lead asked: a reviewer confirms
    expect(decideLife('live', 'cancel', { ...good('reviewer', 'u-rev1'), cancelRequest: { by: 'lead', userId: 'u-lead' } }).ok).toBe(true)
    // a reviewer asked: the same reviewer cannot confirm, a second one can
    expect(decideLife('live', 'cancel', { ...good('reviewer', 'u-rev1'), cancelRequest: { by: 'reviewer', userId: 'u-rev1' } }).ok).toBe(false)
    expect(decideLife('live', 'cancel', { ...good('reviewer', 'u-rev2'), cancelRequest: { by: 'reviewer', userId: 'u-rev1' } }).ok).toBe(true)
    expect(decideLife('live', 'cancel', { ...good('reviewer'), cancelRequest: undefined }).ok).toBe(false)
    expect(decideLife('live', 'cancel', { ...good('reviewer'), reviewerConflicted: true }).ok).toBe(false)
    expect(decideLife('live', 'cancel', { ...good('lead'), cancelRequest: { by: 'reviewer', userId: 'u-rev1' } }).ok).toBe(false)
    expect(decideLife('live', 'cancel', good('reviewer'))).toEqual({ ok: true, to: 'cancelled', effects: ['apply_cancel_to_each_investor', 'notify_all'] })
  })

  it('TC-DEAL-07 each investor on cancellation, by the table', () => {
    expect(onCancel({ committed: false, instructionsOpen: false, held: 0n })).toEqual({
      case: 'not_committed',
      endParticipation: false,
      voidInstructions: false,
      doNotPayMail: false,
      refundToDo: false,
    })
    expect(onCancel({ committed: true, instructionsOpen: false, held: 0n })).toMatchObject({
      case: 'committed',
      endParticipation: true,
      voidInstructions: false,
      refundToDo: false,
    })
    expect(onCancel({ committed: true, instructionsOpen: true, held: 0n })).toMatchObject({
      case: 'instructions_sent',
      voidInstructions: true,
      doNotPayMail: true,
      refundToDo: false,
    })
    expect(onCancel({ committed: true, instructionsOpen: true, held: 1n })).toMatchObject({ case: 'money_received', voidInstructions: true, refundToDo: true })
    expect(onCancel({ committed: true, instructionsOpen: false, held: 5n })).toMatchObject({
      case: 'money_received',
      voidInstructions: false,
      refundToDo: true,
    })
    // money to check (N below zero) is not money to refund
    expect(onCancel({ committed: true, instructionsOpen: false, held: -5n })).toMatchObject({ case: 'committed', refundToDo: false })
  })

  it('TC-DEAL-07 archiving needs every refund done and no hold left', () => {
    expect(decideLife('cancelled', 'archive', { ...good('reviewer'), refundsOpen: 1 }).ok).toBe(false)
    expect(decideLife('cancelled', 'archive', { ...good('reviewer'), holdsOpen: 1 }).ok).toBe(false)
    expect(decideLife('cancelled', 'archive', { ...good('reviewer'), holdsOpen: undefined }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------- the action table (TC-DEAL-02)

// Copied by hand from PRD §5.1, columns live, closing_requested, closing, closed. Written apart from the code on purpose.
const PRD: Record<Action, [Cell, Cell, Cell, Cell]> = {
  commit: ['yes', 'no', 'no', 'no'],
  change_commitment: ['yes', 'no', 'no', 'no'],
  sign: ['yes', 'yes', 'before_final', 'no'],
  see_instructions: ['yes', 'yes', 'before_final', 'no'],
  record_receipt: ['yes', 'yes', 'yes', 'late_to_refund'],
  approve_refund: ['yes', 'yes', 'yes', 'yes'],
  approve_refund_final: ['no', 'no', 'no', 'from_settled'],
  reconfirm_change: ['yes', 'no', 'no', 'no'],
  text_correction: ['yes', 'yes', 'yes', 'no'],
  change_limits: ['yes', 'no', 'no', 'no'],
  reconfirm: ['yes', 'under_way', 'no', 'no'],
  remove: ['yes', 'yes', 'no', 'no'],
  withdraw: ['yes', 'yes', 'before_final', 'no'],
  replace_link: ['uncommitted', 'no', 'no', 'no'],
  adjust_or_waitlist: ['yes', 'no', 'no', 'no'],
  release_order: ['no', 'no', 'payout_stage', 'no'],
  bulk_message: ['yes', 'committed', 'committed', 'company_updates'],
}
const cell = (action: Action, state: AnyDealState, payoutException = false) => actionCell(action, { state, payoutException })

describe('what may be done in each state', () => {
  it('TC-DEAL-02 every cell of the table', () => {
    expect(Object.keys(PRD).sort()).toEqual([...ACTIONS].sort())
    let n = 0
    for (const a of ACTIONS)
      (['live', 'closing_requested', 'closing', 'closed'] as const).forEach((s, i) => {
        expect(cell(a, s), `${a} in ${s}`).toBe(PRD[a][i])
        n++
      })
    expect(n).toBe(68)
  })

  it('TC-DEAL-02 settled acts as closed, except company updates wait for closed', () => {
    for (const a of ACTIONS) expect(cell(a, 'settled'), a).toBe(a === 'bulk_message' ? 'no' : PRD[a][3])
  })

  it('TC-DEAL-02 the payout exception acts as closing, adds reconfirming, and freezes refund approvals', () => {
    for (const a of ACTIONS) {
      const want = a === 'approve_refund' || a === 'approve_refund_final' ? 'no' : a === 'reconfirm' || a === 'reconfirm_change' ? 'yes' : PRD[a][2]
      for (const s of ['closing', 'live', 'cancelled', 'archived', 'closing_requested'] as const) expect(cell(a, s, true), `${a} ${s}`).toBe(want)
    }
  })

  it('TC-DEAL-02 a cancelled or archived deal only takes late money in for refund and approves refunds; before live, nothing', () => {
    for (const a of ACTIONS)
      for (const s of ['cancelled', 'archived'] as const)
        expect(cell(a, s), `${a} ${s}`).toBe(a === 'record_receipt' ? 'late_to_refund' : a === 'approve_refund' ? 'yes' : 'no')
    for (const s of ['draft', 'in_review', 'changes_requested', 'rejected', 'approved'] as const) for (const a of ACTIONS) expect(cell(a, s)).toBe('no')
    expect(cell('__proto__' as Action, 'live')).toBe('no')
    expect(cell('commit', 'nonsense' as AnyDealState)).toBe('no')
  })
})

// ---------------------------------------------------------------- who it waits on (TC-STAT-06), seeing the deal (TC-GATE-06)

const FPO = { steps: ['view_deal', 'commit', 'kyc', 'sign', 'payment_instructions'].map((kind) => ({ kind, qualifying: false })) } as Parameters<
  typeof deriveStatus
>[1]
const WAIT: WaitFacts = { kycAwaitingReviewer: false, dealState: 'live', closingDecisionMade: false, moneyOnHand: false, held: false, refundOpen: false }
const waits = (status: Status, f: Partial<WaitFacts> = {}, overlays: Overlay[] = []) => waitingOn({ status, overlays }, { ...WAIT, ...f })

describe('who a step waits on', () => {
  it('TC-STAT-06 each status by the table', () => {
    const want: Record<Status, string | null> = {
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
    for (const s of STATUSES) expect(waits(s), s).toBe(want[s])
  })

  it('TC-STAT-05 past the reconfirmation deadline: "no response" while it is still pending; the lead removes someone with no money, the reviewer decides with money', () => {
    const part = {
      outcome: 'active' as const,
      kycPassed: true,
      reconfirmPending: true,
      reconfirmLapsed: true,
      amountProposalPending: false,
      signed: true,
      transferMarked: false,
      held: 0n,
      due: 100n,
      invested: null,
      identityReview: false,
    }
    const f: StatusFacts = { invitation: 'active', qualified: true, statementExpired: false, waitlisted: false, participation: part }
    expect(deriveStatus(f, FPO)).toEqual({ status: 'reconfirm', overlays: ['no_response'] })
    expect(deriveStatus({ ...f, participation: { ...part, reconfirmLapsed: false } }, FPO).overlays).toEqual([])
    expect(deriveStatus({ ...f, participation: { ...part, reconfirmPending: false } }, FPO).overlays).toEqual([])
    expect(deriveStatus({ ...f, participation: { ...part, outcome: 'removed' } }, FPO).overlays).toEqual([])
    expect(waits('reconfirm', {}, ['no_response'])).toBe('lead')
    expect(waits('reconfirm', { moneyOnHand: true }, ['no_response'])).toBe('reviewer')
    expect(waits('reconfirm', { moneyOnHand: true })).toBe('investor')
  })

  it('TC-STAT-06 identity check with a reviewer → reviewer; not started, in progress or sent back → investor', () => {
    expect(waits('verifying', { kycAwaitingReviewer: true })).toBe('reviewer')
    expect(waits('verifying', { kycAwaitingReviewer: false })).toBe('investor')
  })

  it('TC-STAT-06 a final status with money still on hand waits on a reviewer', () => {
    for (const s of ['removed', 'withdrawn', 'cancelled', 'not_approved', 'excluded'] as const) expect(waits(s, { moneyOnHand: true })).toBe('reviewer')
  })

  it('TC-STAT-06 the overlays come first: identity review and money to check → reviewer', () => {
    for (const s of STATUSES) {
      expect(waits(s, {}, ['identity_review'])).toBe('reviewer')
      expect(waits(s, {}, ['needs_check'])).toBe('reviewer')
    }
  })

  it('TC-STAT-06 not paid in full with no closing decision → lead, only while closing is asked for', () => {
    for (const s of ['verifying', 'reconfirm', 'confirm_amount', 'to_sign', 'to_pay', 'payment_sent', 'part_paid'] as const) {
      expect(waits(s, { dealState: 'closing_requested' }), s).toBe('lead')
      expect(waits(s, { dealState: 'closing_requested', closingDecisionMade: true }), s).not.toBe('lead')
      expect(waits(s, { dealState: 'live' }), s).not.toBe('lead')
    }
    expect(waits('funded', { dealState: 'closing_requested' })).toBeNull()
  })

  it('TC-STAT-06 a hold and an ordinary refund look the same: both show the reviewer, whatever the status', () => {
    for (const s of STATUSES) expect(waits(s, { held: true })).toBe(waits(s, { refundOpen: true }))
    expect(waits('funded', { held: true })).toBe('reviewer')
    expect(waits('funded', { refundOpen: true })).toBe('reviewer')
  })

  it('TC-STAT-06 days in the step by the fixed clock', () => {
    const at = new Date('2026-11-02T09:00:00Z')
    expect(daysInStatus(at, new Date('2026-11-02T23:59:59Z'))).toBe(0)
    expect(daysInStatus(at, new Date('2026-11-03T09:00:00Z'))).toBe(1)
    expect(daysInStatus(at, new Date('2026-11-12T08:59:59Z'))).toBe(9)
    expect(daysInStatus(at, new Date('2026-11-01T00:00:00Z'))).toBe(0)
    expect(daysInStatus(new Date('nope'), at)).toBeNull()
  })

  it('TC-STAT-06 the lead\'s row: a refusal reads as with the operator and waits on a reviewer; no response is shown; filters', () => {
    expect(leadRowView({ status: 'not_approved', overlays: ['needs_check'] }, WAIT)).toEqual({
      status: 'with_operator',
      label: 'With the operator',
      waiting: 'reviewer',
      noResponse: false,
    })
    expect(leadRowView({ status: 'to_pay', overlays: [] }, WAIT)).toEqual({ status: 'to_pay', label: 'To pay', waiting: 'investor', noResponse: false })
    expect(leadRowView({ status: 'reconfirm', overlays: ['no_response'] }, WAIT)).toMatchObject({ waiting: 'lead', noResponse: true })
    expect(leadRowView({ status: 'funded', overlays: [] }, WAIT).waiting).toBeNull()
    const row = { status: 'funded' as const, waiting: null }
    expect(leadRowMatches(row, {})).toBe(true)
    expect(leadRowMatches(row, { status: 'funded' })).toBe(true)
    expect(leadRowMatches(row, { status: 'to_pay' })).toBe(false)
    expect(leadRowMatches(row, { waiting: 'none' })).toBe(true)
    expect(leadRowMatches(row, { waiting: 'reviewer' })).toBe(false)
    expect(leadRowMatches({ status: 'to_pay', waiting: 'investor' }, { status: 'to_pay', waiting: 'none' })).toBe(false)
    expect(leadRowMatches({ status: 'to_pay', waiting: 'investor' }, { status: 'to_pay', waiting: 'investor' })).toBe(true)
  })

  it('TC-GATE-06 leaving, removal or exclusion with no other active entity revokes the invitation; with one, it stays', () => {
    const d = { state: 'live' as const, holds: { deal: false, lead: false, instance: false }, finalConfirmed: false }
    for (const o of ['withdrawn', 'removed', 'excluded_at_close'] as const) {
      expect(invitationAfterEnd(o, false)).toBe('revoke')
      expect(invitationAfterEnd(o, true)).toBe('keep')
      const active = invitationAfterEnd(o, false) === 'keep'
      expect(canReceivePromotion({ qualified: true, invitationActive: active }, d)).toBe(false)
      expect(canReceivePromotion({ qualified: true, invitationActive: invitationAfterEnd(o, true) === 'keep' }, d)).toBe(true)
    }
    // A leaves while B stays; B then fails the identity check: the invitation stays, and C can commit
    expect(invitationAfterEnd('rejected_kyc', false)).toBe('keep')
    expect(invitationAfterEnd('deal_cancelled', false)).toBe('keep')
    const base: StatusFacts = { invitation: 'active', qualified: true, statementExpired: false, waitlisted: false, participation: null }
    expect(deriveStatus(base, FPO).status).toBe('deciding')
  })
})

// ---------------------------------------------------------------- changes (TC-CHG-02, TC-CHG-04)

const DEAL = (): Draft => ({
  basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'Example Round', syndicate: { mode: 'existing', id: 'syn-1' } },
  company: { legal_name: 'Example Ltd', contact_name: 'Sam Founder', contact_email: 'sam@example.test', jurisdiction: 'England and Wales' },
  terms: {
    currency: 'GBP',
    instrument: 'equity',
    share_class: 'ordinary',
    share_price_micros: '1000000',
    price_is_placeholder: true,
    pre_money_minor: '500000000',
    allocation_minor: '30000000',
    min_commitment_minor: '100000',
    min_raise_minor: '10000000',
    voter: 'lead',
    target_close: '2026-12-31',
  },
  files: { memo: { blocks: [{ type: 'p', text: 'We make bikes.' }] } },
  economics: { default_carry_bps: 2000, fee_payer: 'lead' },
})
type T = NonNullable<Draft['terms']>
const terms = (t: Partial<T>): Draft => ({ ...DEAL(), terms: { ...DEAL().terms, ...t } })
const PEOPLE = [
  { id: 'p-a', commitment: 100_000n },
  { id: 'p-c', commitment: 200_000n },
  { id: 'p-d', commitment: 700_000n },
]
const input = (after: Draft, more: Partial<ChangeInput> = {}): ChangeInput => ({
  before: DEAL(),
  after,
  state: 'live',
  anyCommitment: true,
  stricter: [],
  floorMinor: 100_000n,
  people: PEOPLE,
  ...more,
})
function classified(after: Draft, more: Partial<ChangeInput> = {}): Classified {
  const r = classifyChange(input(after, more))
  if (!r.ok) throw new Error(r.reason)
  return r.c
}

describe('changes to a live deal', () => {
  const MUST: Array<[string, Draft]> = [
    ['valuation', terms({ pre_money_minor: '600000000' })],
    ['instrument', terms({ instrument: 'cln', cap_type: 'none' })],
    ['share class', terms({ share_class: 'preferred' })],
    ['carry', { ...DEAL(), economics: { ...DEAL().economics, default_carry_bps: 2500 } }],
    ['who pays the fee', { ...DEAL(), economics: { ...DEAL().economics, fee_payer: 'investors' } }],
    ['voter', terms({ voter: 'founder' })],
    ['custom terms', terms({ custom_terms: { blocks: [{ type: 'p', text: 'Drag-along applies.' }] } })],
    ['lower minimum raise', terms({ min_raise_minor: '5000000' })],
    ['no minimum raise', terms({ min_raise_minor: undefined })],
    ['company legal name', { ...DEAL(), company: { ...DEAL().company, legal_name: 'Other Ltd' } }],
    ['a field not in any list', { ...DEAL(), basics: { ...DEAL().basics, structure: 'other' } }],
  ]

  it.each(MUST)('TC-CHG-02 %s: always reconfirmed, and the reviewer cannot make it a notice', (_name, after) => {
    const c = classified(after)
    expect(c.items.some((x) => x.kind === 'reconfirm')).toBe(true)
    expect(decideChange(c, 'live', { verdict: 'notice', reason: 'Small.' }).ok).toBe(needsJudgement(c) ? false : true)
    const r = decideChange(c, 'live', { verdict: 'reconfirm', reason: 'Material.' })
    expect(r.ok && r.effect).toMatchObject({ reconfirm: 'all', newTermsVersion: true })
    // only live
    expect(classifyChange(input(after, { state: 'closing_requested' })).ok).toBe(false)
    expect(classifyChange(input(after, { state: 'closing' })).ok).toBe(false)
  })

  it('TC-CHG-02 a pack can only add to what is reconfirmed: its list names content items, never lowers a field', () => {
    const pack = JSON.parse(readFileSync(new URL('../../packs/uk-fpo-template/pack.json', import.meta.url), 'utf8'))
    expect(parsePack({ ...pack, must_reconfirm_extra: ['memo'] }).errors).toEqual([])
    expect(parsePack({ ...pack, must_reconfirm_extra: ['valuation'] }).pack).toBeNull()
    expect(parsePack({ ...pack, must_reconfirm_extra: ['pre_money_minor'] }).pack).toBeNull()
    const memo = { ...DEAL(), files: { memo: { blocks: [{ type: 'p', text: 'We make bicycles.' }] } } }
    const c = classified(memo, { stricter: ['memo'] })
    expect(c.items).toEqual([{ field: 'files.memo', kind: 'reconfirm', item: 'memo', limit: false, suggested: undefined }])
    expect(decideChange(c, 'live', {}).ok && decideChange(c, 'live', {})).toMatchObject({ effect: { reconfirm: 'all' } })
    for (const k of CONTENT_ITEMS) expect(parsePack({ ...pack, must_reconfirm_extra: [k] }).errors, k).toEqual([])
  })

  it('TC-CHG-02 minimum £1,000 → £5,000: the person at £2,000 (and at £1,000) reconfirms, the others are only told', () => {
    const c = classified(terms({ min_commitment_minor: '500000' }))
    expect(c.belowNewMinimum).toEqual(['p-a', 'p-c'])
    const r = decideChange(c, 'live', { verdict: 'notice', reason: 'Raise for admin cost.' })
    expect(r.ok && r.effect).toEqual({ newTermsVersion: true, reconfirm: ['p-a', 'p-c'], resign: false, notify: true, reviewed: true })
    // nobody below the new minimum: a notice, no new version
    const none = decideChange(classified(terms({ min_commitment_minor: '100001' }), { people: [{ id: 'p-d', commitment: 700_000n }] }), 'live', {
      verdict: 'notice',
      reason: 'x',
    })
    expect(none.ok && none.effect).toMatchObject({ newTermsVersion: false, reconfirm: [] })
    // exactly at the new minimum is fine, a penny under is not
    const edge = classified(terms({ min_commitment_minor: '500000' }), {
      people: [
        { id: 'p-under', commitment: 499_999n },
        { id: 'p-at', commitment: 500_000n },
      ],
    })
    expect(edge.belowNewMinimum).toEqual(['p-under'])
    // a blank minimum means the operator's floor
    expect(classified(terms({ min_commitment_minor: undefined })).items[0]).toMatchObject({ item: 'min_commitment_lower' })
    expect(classified(terms({ min_commitment_minor: '100000' }), { before: terms({ min_commitment_minor: undefined }) }).items).toBeDefined()
  })

  it('TC-CHG-02 the allocation and the minimums change only in live; a text correction until closing, and it leaves confirmations alone', () => {
    for (const after of [
      terms({ allocation_minor: '40000000' }),
      terms({ min_commitment_minor: '200000' }),
      terms({ min_raise_minor: '20000000' }),
      terms({ over_allocation: 'stop_and_waitlist' }),
    ])
      for (const state of ['closing_requested', 'closing'] as const) expect(classifyChange(input(after, { state })).ok, state).toBe(false)
    const typo = { ...DEAL(), files: { memo: { blocks: [{ type: 'p', text: 'We make bicycles.' }] } } }
    for (const state of ['live', 'closing_requested', 'closing'] as const) {
      const r = decideChange(classified(typo, { state }), state, { verdict: 'notice', reason: 'Typo.' })
      expect(r.ok && r.effect, state).toEqual({ newTermsVersion: false, reconfirm: [], resign: false, notify: true, reviewed: true })
    }
    for (const state of ['settled', 'closed', 'cancelled', 'draft', 'approved'] as const) expect(classifyChange(input(typo, { state })).ok, state).toBe(false)
  })

  it('TC-CHG-02 a memo typo judged notice only: told and shown, no reconfirmation, no re-signing; upgraded by the reviewer: reconfirmed', () => {
    const typo = { ...DEAL(), files: { memo: { blocks: [{ type: 'p', text: 'We make bicycles.' }] } } }
    const c = classified(typo)
    expect(c.changes.map((x) => x.field)).toEqual(['files.memo.blocks.0.text'])
    expect(needsJudgement(c)).toBe(true)
    expect(decideChange(c, 'live', { verdict: 'reconfirm', reason: 'Changes the business.' })).toEqual({
      ok: true,
      effect: { newTermsVersion: true, reconfirm: 'all', resign: false, notify: true, reviewed: true },
    })
    // an upgrade is refused outside live, a notice is not
    expect(decideChange(c, 'closing_requested', { verdict: 'reconfirm', reason: 'x' }).ok).toBe(false)
    expect(decideChange(c, 'closing_requested', { verdict: 'notice', reason: 'x' }).ok).toBe(true)
  })

  it('TC-CHG-02 a judgement needs a choice and a reason', () => {
    const c = classified(terms({ allocation_minor: '40000000' }))
    expect(decideChange(c, 'live', { reason: 'x' }).ok).toBe(false)
    expect(decideChange(c, 'live', { verdict: 'notice', reason: '  ' }).ok).toBe(false)
    expect(decideChange(c, 'live', { verdict: 'notice' }).ok).toBe(false)
    expect(decideChange(c, 'live', { verdict: 'nonsense' as 'notice', reason: 'x' }).ok).toBe(false)
  })

  it('TC-CHG-02 a larger allocation suggests a notice; a smaller one has no suggestion and must be judged', () => {
    expect(classified(terms({ allocation_minor: '40000000' })).items).toEqual([
      { field: 'terms.allocation_minor', kind: 'content', item: 'allocation_increase', limit: true, suggested: 'notice' },
    ])
    expect(classified(terms({ allocation_minor: '20000000' })).items).toEqual([
      { field: 'terms.allocation_minor', kind: 'content', item: 'allocation_decrease', limit: true, suggested: null },
    ])
  })

  it('TC-CHG-02 changing what a signed document says always means signing again', () => {
    for (const after of [
      { ...DEAL(), company: { ...DEAL().company, legal_name: 'Other Ltd' } },
      terms({ instrument: 'cln', cap_type: 'none' }),
      { ...DEAL(), economics: { ...DEAL().economics, default_carry_bps: 1000 } },
      terms({ custom_terms: { blocks: [{ type: 'p', text: 'New.' }] } }),
    ]) {
      const r = decideChange(classified(after), 'live', { verdict: 'reconfirm', reason: 'x' })
      expect(r.ok && r.effect.resign).toBe(true)
    }
    const r = decideChange(classified(terms({ voter: 'chair' })), 'live', {})
    expect(r.ok && r.effect.resign).toBe(false)
  })

  it('TC-CHG-02 a lower minimum raise is reconfirmed; a higher one is only told', () => {
    expect(classified(terms({ min_raise_minor: '5000000' })).items[0]?.kind).toBe('reconfirm')
    expect(classified(terms({ min_raise_minor: '20000000' })).items[0]).toMatchObject({ kind: 'content', item: 'min_raise_raise' })
    expect(classified(terms({ min_raise_minor: '1' }), { before: terms({ min_raise_minor: undefined }) }).items[0]).toMatchObject({ kind: 'content' })
  })

  it('TC-CHG-02 a change to one person reconfirms that person only, and only in live', () => {
    const t = { carryBps: 2000, fee: { kind: 'none' as const } }
    expect(personChangeRefusal('live', t, { ...t, carryBps: 1500 })).toBeNull()
    expect(personChangeRefusal('live', t, { carryBps: 2000, fee: { kind: 'fixed', minor: 5000n, mode: 'on_top' } })).toBeNull()
    expect(personChangeRefusal('live', t, { ...t })).not.toBeNull()
    expect(personChangeRefusal('closing_requested', t, { ...t, carryBps: 1500 })).not.toBeNull()
  })

  it("TC-CHG-02 / TC-ALO-03 one person's new terms meet a new link's rules, leave something invested and fit a stopping allocation", () => {
    const t = { carryBps: 2000, fee: { kind: 'none' as const } }
    const fee4 = { carryBps: 2000, fee: { kind: 'percent' as const, bps: 400, mode: 'deducted' as const } }
    const base = {
      state: 'live' as const,
      before: fee4,
      after: t,
      reason: 'As agreed.',
      defaultCarryBps: 2000,
      feeMaxBps: 1000,
      policy: { perLinkTerms: false, genericLinks: true },
      attestationRequired: false,
      incentiveAttested: false,
      commitments: [100_000n],
      room: { stop: true, allocation: 1_000_000n, others: 904_000n },
    }
    // dropping a 4% fee taken from £1,000 makes £1,000 invested: fits with others at £9,000 of £10,000, not a penny more
    expect(personTermsRefusal({ ...base, room: { ...base.room, others: 900_000n } })).toBeNull()
    expect(personTermsRefusal({ ...base, room: { ...base.room, others: 900_001n } })).toMatch(/past its allocation/)
    // reminder mode never blocks, nor does a change that invests less
    expect(personTermsRefusal({ ...base, room: { ...base.room, stop: false } })).toBeNull()
    expect(personTermsRefusal({ ...base, before: t, after: fee4, policy: { perLinkTerms: true, genericLinks: true }, room: { ...base.room, others: 950_000n } })).toBeNull()
    expect(personTermsRefusal({ ...base, before: fee4, after: { ...fee4 } })).toMatch(/Nothing has changed/)
    expect(personTermsRefusal({ ...base, commitments: [] })).toMatch(/Nobody is committed/)
    expect(personTermsRefusal({ ...base, before: t, after: fee4 })).toMatch(/does not allow terms that differ/)
    const on = { ...base, before: t, policy: { perLinkTerms: true, genericLinks: true } }
    expect(personTermsRefusal({ ...on, after: { ...t, fee: { kind: 'percent', bps: 1001, mode: 'on_top' } } })).not.toBeNull()
    expect(personTermsRefusal({ ...on, after: fee4, attestationRequired: true })).toMatch(/not an incentive/)
    expect(personTermsRefusal({ ...on, after: fee4, attestationRequired: true, incentiveAttested: true })).toBeNull()
    // a fixed fee taken from the payment must leave something invested
    expect(personTermsRefusal({ ...on, after: { ...t, fee: { kind: 'fixed', minor: 100_000n, mode: 'deducted' } } })).toMatch(/whole of a commitment/)
    expect(personTermsRefusal({ ...on, after: { ...t, fee: { kind: 'fixed', minor: 99_999n, mode: 'deducted' } } })).toBeNull()
    expect(termsChanges(t, { ...fee4, carryBps: 1500 })).toEqual([
      { field: 'carry_bps', before: '2000', after: '1500' },
      { field: 'lead_fee', before: '{"kind":"none"}', after: '{"kind":"percent","bps":400,"mode":"deducted"}' },
    ])
    expect(termsChanges(t, t)).toEqual([])
    // the lead, reviewer and approver read the fee as the investor does, not as stored
    const fixed = termsChanges(fee4, { ...t, fee: { kind: 'fixed', minor: 150_000n, mode: 'on_top' } })
    expect(changesInWords([...termsChanges(t, { ...fee4, carryBps: 1500 }), ...fixed], 'GBP')).toEqual([
      { field: 'carry_bps', before: '2000', after: '1500' },
      { field: 'lead_fee', before: 'No fee', after: '4.00% taken from the payment' },
      { field: 'lead_fee', before: '4.00% taken from the payment', after: '£1,500.00 added on top of the commitment' },
    ])
    expect(changesInWords([{ field: 'lead_fee', before: null, after: 'not json' }], 'GBP')).toEqual([{ field: 'lead_fee', before: null, after: 'not json' }])
    // a record that is not whole stays as stored
    for (const bad of ['{"kind":"fixed"}', '{"kind":"fixed","minor":150000,"mode":"on_top"}', '{"kind":"percent","mode":"on_top"}', '{"kind":"percent","bps":400,"mode":"x"}', 'null', '{"kind":"other","mode":"on_top"}'])
      expect(changesInWords([{ field: 'lead_fee', before: bad, after: bad }], 'GBP')).toEqual([{ field: 'lead_fee', before: bad, after: bad }])
  })

  it('TC-CHG-02 the currency cannot change after the first commitment', () => {
    expect(classifyChange(input(terms({ currency: 'EUR' }))).ok).toBe(false)
    expect(classified(terms({ currency: 'EUR' }), { anyCommitment: false, people: [] }).items[0]?.kind).toBe('reconfirm')
  })

  it('TC-CHG-02 the lead own dates need no reviewer: a version and a notice', () => {
    const c = classified(terms({ target_close: '2027-01-31', pay_by: '2026-12-15' }))
    expect(selfServiceOnly(c)).toBe(true)
    expect(decideChange(c, 'closing', {})).toEqual({
      ok: true,
      effect: { newTermsVersion: false, reconfirm: [], resign: false, notify: true, reviewed: false },
    })
    expect(classifyChange(input(DEAL())).ok).toBe(false)
  })

  it('TC-ALO-03 the lead changes what happens when the allocation is full alone (R-ALO-03, R-CHG-01): a version and a notice, only in live', () => {
    for (const [before, after] of [
      [undefined, 'stop_and_waitlist'],
      ['stop_and_waitlist', 'alert'],
    ] as const) {
      const c = classified(terms({ over_allocation: after }), { before: terms({ over_allocation: before }) })
      expect(c.items).toEqual([{ field: 'terms.over_allocation', kind: 'self_service', limit: true }])
      expect(selfServiceOnly(c)).toBe(true)
      expect(decideChange(c, 'live', {})).toEqual({
        ok: true,
        effect: { newTermsVersion: false, reconfirm: [], resign: false, notify: true, reviewed: false },
      })
    }
    // a pack cannot make it a reviewer's item: it is not in the list a pack may name
    expect(CONTENT_ITEMS).not.toContain('over_allocation' as never)
    for (const state of ['closing_requested', 'closing'] as const)
      expect(classifyChange(input(terms({ over_allocation: 'stop_and_waitlist' }), { state }))).toEqual({
        ok: false,
        reason: 'The allocation, the minimums and what happens when it is full can only change while the deal is live.',
      })
    // with anything a reviewer judges, the whole change goes to the reviewer
    const both = classified(terms({ over_allocation: 'stop_and_waitlist', allocation_minor: '40000000' }))
    expect(selfServiceOnly(both)).toBe(false)
  })

  it('TC-CHG-04 setting a placeholder price is not material; raising a published price is; lowering it is a notice', () => {
    const set = classified(terms({ share_price_micros: '1500000', price_is_placeholder: undefined }))
    expect(set.items).toEqual([{ field: 'terms.share_price_micros', kind: 'content', item: 'price_set', limit: false, suggested: 'notice' }])
    const real = terms({ share_price_micros: '1500000', price_is_placeholder: undefined })
    expect(classified(terms({ share_price_micros: '1600000', price_is_placeholder: undefined }), { before: real }).items[0]?.kind).toBe('reconfirm')
    expect(classified(terms({ share_price_micros: '1400000', price_is_placeholder: undefined }), { before: real }).items[0]).toMatchObject({
      kind: 'content',
      item: 'price_lower',
    })
    expect(classified(terms({ share_price_micros: '1500001', price_is_placeholder: undefined }), { before: real }).items[0]?.kind).toBe('reconfirm')
    expect(classified(terms({ share_price_micros: '1499999', price_is_placeholder: undefined }), { before: real }).items[0]?.kind).toBe('content')
    // turning a real price back into a placeholder hides it: reconfirmed
    expect(classified(terms({ share_price_micros: '1500000', price_is_placeholder: true }), { before: real }).items[0]?.kind).toBe('reconfirm')
    // the price may be set during closing as a notice; a raise then is refused
    expect(classifyChange(input(terms({ share_price_micros: '1500000', price_is_placeholder: undefined }), { state: 'closing' })).ok).toBe(true)
    expect(classifyChange(input(terms({ share_price_micros: '1600000', price_is_placeholder: undefined }), { before: real, state: 'closing' })).ok).toBe(false)
    expect(classified(terms({ share_price_micros: '1500000', price_is_placeholder: undefined }), { stricter: ['price_set'] }).items[0]?.kind).toBe('reconfirm')
  })

  it('TC-CHG-04 the reconfirm page does not show a hidden price', () => {
    const real = terms({ share_price_micros: '1500000', price_is_placeholder: undefined })
    const c = classified(terms({ share_price_micros: '1600000', price_is_placeholder: undefined, voter: 'chair' }), { before: real })
    const shown = changesShown(c.changes, false)
    expect(JSON.stringify(shown)).not.toMatch(/1500000|1600000/)
    expect(shown).toContainEqual({ field: 'terms.share_price_micros', before: null, after: PRICE_HIDDEN_TEXT })
    expect(shown.map((x) => x.field)).toContain('terms.voter')
    const set = classified(terms({ share_price_micros: '1500000', price_is_placeholder: undefined }))
    expect(changesShown(set.changes, false)).toEqual([{ field: 'terms.share_price_micros', before: null, after: PRICE_HIDDEN_TEXT }])
    expect(changesShown(set.changes, true)).toEqual(set.changes)
  })
})

// ---------------------------------------------------------------- deadlines (§5.3, R28 (4))

describe('deadlines in working days', () => {
  it('TC-STAT-05 five working days from a Friday afternoon end with the next Friday; the start day never counts', () => {
    expect(workingDayDeadline(new Date('2026-11-13T15:00:00Z'), 5)?.toISOString()).toBe('2026-11-21T00:00:00.000Z')
    expect(workingDayDeadline(new Date('2026-11-09T00:00:00Z'), 1)?.toISOString()).toBe('2026-11-11T00:00:00.000Z')
    expect(workingDayDeadline(new Date('2026-11-14T10:00:00Z'), 1)?.toISOString()).toBe('2026-11-17T00:00:00.000Z')
    expect(workingDayDeadline(new Date('2026-11-13T10:00:00Z'), 10)?.toISOString()).toBe('2026-11-28T00:00:00.000Z')
    // the limit itself: 260 working days are 52 whole weeks, so a Friday again
    expect(workingDayDeadline(new Date('2026-11-13T10:00:00Z'), 260)?.toISOString()).toBe('2027-11-13T00:00:00.000Z')
    for (const d of [0, -1, 1.5, 261, Number.NaN]) expect(workingDayDeadline(new Date('2026-11-13T10:00:00Z'), d)).toBeNull()
    expect(workingDayDeadline(new Date('nope'), 5)).toBeNull()
  })

  it('TC-STAT-05 silence is not agreement: after the deadline the state is lapsed', () => {
    const start = new Date('2026-11-13T15:00:00Z')
    expect(deadlineState({ start, days: 5, pauses: [], now: new Date('2026-11-20T23:59:59Z') }).state).toBe('open')
    expect(deadlineState({ start, days: 5, pauses: [], now: new Date('2026-11-21T00:00:00Z') }).state).toBe('lapsed')
  })

  it('TC-STAT-05 an expired statement stops the clock; overlapping pauses count once; a pause before the start does not count', () => {
    const start = new Date('2026-11-13T15:00:00Z')
    const now = new Date('2026-11-21T12:00:00Z')
    expect(deadlineState({ start, days: 5, pauses: [{ from: new Date('2026-11-16T00:00:00Z'), to: null }], now })).toEqual({ state: 'paused' })
    const day = { from: new Date('2026-11-16T00:00:00Z'), to: new Date('2026-11-17T00:00:00Z') }
    expect(deadlineState({ start, days: 5, pauses: [day], now })).toEqual({ state: 'open', deadline: new Date('2026-11-22T00:00:00Z') })
    const overlap = { from: new Date('2026-11-16T12:00:00Z'), to: new Date('2026-11-16T18:00:00Z') }
    expect(deadlineState({ start, days: 5, pauses: [day, overlap], now })).toEqual({ state: 'open', deadline: new Date('2026-11-22T00:00:00Z') })
    const before = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-13T15:00:00Z') }
    expect(deadlineState({ start, days: 5, pauses: [before], now }).state).toBe('lapsed')
    expect(deadlineState({ start, days: 5, pauses: [{ from: new Date('2026-11-22T00:00:00Z'), to: null }], now }).state).toBe('lapsed')
    // an open pause that has not begun by this clock, though before the deadline, stops nothing yet
    expect(deadlineState({ start, days: 5, pauses: [{ from: new Date('2026-11-18T00:00:00Z'), to: null }], now: new Date('2026-11-16T12:00:00Z') })).toEqual({
      state: 'open',
      deadline: new Date('2026-11-21T00:00:00Z'),
    })
    expect(deadlineState({ start, days: 5, pauses: [{ from: new Date('2026-11-17T00:00:00Z'), to: new Date('2026-11-16T00:00:00Z') }], now })).toEqual({
      state: 'unknown',
    })
  })

  it('TC-STAT-05 a statement running out after the deadline gives no time back; one running out before it moves it on by its whole length', () => {
    const start = new Date('2026-11-13T15:00:00Z')
    const later = new Date('2026-11-25T00:00:00Z')
    // deadline end of Fri 20th; a pause from the 23rd, open or closed, changes nothing
    expect(deadlineState({ start, days: 5, pauses: [{ from: new Date('2026-11-23T00:00:00Z'), to: null }], now: later })).toEqual({
      state: 'lapsed',
      deadline: new Date('2026-11-21T00:00:00Z'),
    })
    const after = { from: new Date('2026-11-23T00:00:00Z'), to: new Date('2026-11-24T00:00:00Z') }
    expect(deadlineState({ start, days: 5, pauses: [after], now: later })).toEqual({ state: 'lapsed', deadline: new Date('2026-11-21T00:00:00Z') })
    // a pause from the last hour of the deadline day to two days later: the clock stopped, so the whole two days count
    const across = { from: new Date('2026-11-20T23:00:00Z'), to: new Date('2026-11-22T23:00:00Z') }
    expect(deadlineState({ start, days: 5, pauses: [across], now: later })).toEqual({ state: 'lapsed', deadline: new Date('2026-11-23T00:00:00Z') })
    // a first pause moves the deadline past the start of a second: that one counts too
    const one = { from: new Date('2026-11-16T00:00:00Z'), to: new Date('2026-11-18T00:00:00Z') }
    const two = { from: new Date('2026-11-21T12:00:00Z'), to: new Date('2026-11-22T12:00:00Z') }
    expect(deadlineState({ start, days: 5, pauses: [one, two], now: later })).toEqual({ state: 'lapsed', deadline: new Date('2026-11-24T00:00:00Z') })
  })

  it('TC-STAT-05 the clock\'s pauses are the times after the start with no valid statement; one still running is open', () => {
    const d = (s: string) => new Date(`2026-11-${s}Z`)
    const start = d('13T15:00:00')
    const now = d('25T00:00:00')
    expect(statementPauses([{ from: d('01T00:00:00'), to: d('30T00:00:00') }], start, now)).toEqual([])
    expect(statementPauses([{ from: d('01T00:00:00'), to: d('16T00:00:00') }, { from: d('17T00:00:00'), to: d('30T00:00:00') }], start, now)).toEqual([
      { from: d('16T00:00:00'), to: d('17T00:00:00') },
    ])
    // overlapping statements count once; none at all is one open pause from the start
    expect(statementPauses([{ from: d('01T00:00:00'), to: d('20T00:00:00') }, { from: d('10T00:00:00'), to: d('18T00:00:00') }], start, now)).toEqual([
      { from: d('20T00:00:00'), to: null },
    ])
    expect(statementPauses([], start, now)).toEqual([{ from: start, to: null }])
    // run out before the start, renewed after it
    expect(statementPauses([{ from: d('01T00:00:00'), to: d('10T00:00:00') }, { from: d('14T00:00:00'), to: d('30T00:00:00') }], start, now)).toEqual([
      { from: start, to: d('14T00:00:00') },
    ])
    expect(statementPauses([], now, start)).toEqual([])
  })

  it('TC-STAT-05 the operator excludes a silent person only after the deadline, with money, with the pack\'s notice and a basis', () => {
    const lapsed = { state: 'lapsed' as const, deadline: new Date('2026-11-21T00:00:00Z') }
    const ok = { clock: lapsed, held: 100n, notice: 'You are excluded.', evidence: 'Mailed twice.' }
    expect(exclusionRefusal(ok)).toBeNull()
    expect(exclusionRefusal({ ...ok, clock: { state: 'open', deadline: lapsed.deadline } })).toMatch(/not passed/)
    expect(exclusionRefusal({ ...ok, clock: { state: 'paused' } })).toMatch(/not passed/)
    expect(exclusionRefusal({ ...ok, held: 0n })).toMatch(/remove them/)
    expect(exclusionRefusal({ ...ok, held: -5n })).toMatch(/remove them/)
    expect(exclusionRefusal({ ...ok, notice: null })).toMatch(/reconfirm_exclusion_notice/)
    expect(exclusionRefusal({ ...ok, notice: '  ' })).toMatch(/reconfirm_exclusion_notice/)
    expect(exclusionRefusal({ ...ok, evidence: ' x ' })).toMatch(/Write down/)
  })

  it('TC-STAT-05 saying no, and silence after the deadline, with and without money', () => {
    expect(onDisagree(0n)).toBe('withdrawn')
    expect(onDisagree(1n)).toBe('withdrawal_with_refund')
    expect(onLapse(0n)).toBe('may_remove')
    expect(onLapse(1n)).toBe('operator_decides')
  })
})

describe('removal and withdrawal (R-WDR-01, R-WDR-02)', () => {
  it('TC-WDR-01 removal: never with money; after "I have paid" only once the lead checked; a missing fact refuses', () => {
    expect(removeRefusal({ moneyArrived: false, transferMarked: false })).toBeNull()
    expect(removeRefusal({ moneyArrived: true, transferMarked: false, moneyChecked: true })).toMatch(/withdrawal/)
    expect(removeRefusal({ moneyArrived: false, transferMarked: true })).toMatch(/check where the money is/)
    expect(removeRefusal({ moneyArrived: false, transferMarked: true, moneyChecked: false })).toMatch(/check where the money is/)
    expect(removeRefusal({ moneyArrived: false, transferMarked: true, moneyChecked: true })).toBeNull()
    expect(removeRefusal({ moneyArrived: undefined as unknown as boolean, transferMarked: false })).toMatch(/withdrawal/)
    expect(removeRefusal({ moneyArrived: false, transferMarked: undefined as unknown as boolean })).toMatch(/check/)
  })
  it('TC-WDR-02 withdrawal: only with money, with consent confirmed and the evidence named', () => {
    const ok = { moneyArrived: true, consentConfirmed: true, evidence: 'Email of 10 Nov' }
    expect(withdrawalRefusal(ok)).toBeNull()
    expect(withdrawalRefusal({ ...ok, moneyArrived: false })).toMatch(/remove them instead/)
    expect(withdrawalRefusal({ ...ok, consentConfirmed: false })).toMatch(/written consent/)
    expect(withdrawalRefusal({ ...ok, evidence: '  ab ' })).toMatch(/where the written consent is/)
    expect(withdrawalRefusal({ ...ok, evidence: 'abc' })).toBeNull()
  })
})

describe('a full deal, the waiting list and the relationship end (R-ALO-01, R-ALO-03, R-ALO-04, §5.6)', () => {
  const words = (x: bigint) => `£${x}`
  it('TC-ALO-03 only "stop and waitlist" stops; the refusal says what fits, or that only the waiting list is left', () => {
    expect(capacityMode('stop_and_waitlist')).toBe('stop')
    expect(capacityMode('alert')).toBe('remind')
    expect(capacityMode(undefined)).toBe('remind')
    expect(capacityRefusal({ kind: 'ok' }, words)).toBeNull()
    expect(capacityRefusal({ kind: 'warn' }, words)).toBeNull()
    expect(capacityRefusal({ kind: 'limit', maxCommitment: 500n }, words)).toMatch(/up to £500\./)
    expect(capacityRefusal({ kind: 'waitlist' }, words)).toMatch(/full.*waiting list/)
  })

  it('TC-ALO-01 a proposal lapses at its deadline, not a moment before', () => {
    const at = new Date('2026-11-20T00:00:00Z')
    expect(proposalLapsed(at, new Date(at.getTime() - 1))).toBe(false)
    expect(proposalLapsed(at, at)).toBe(true)
  })

  it('TC-ALO-04 joining: live, stop mode, not already on it, and only when the amount does not fit', () => {
    const base = { dealState: 'live', mode: 'stop' as const, capacity: { kind: 'waitlist' as const }, alreadyOn: false }
    expect(waitlistRefusal(base)).toBeNull()
    expect(waitlistRefusal({ ...base, capacity: { kind: 'limit', maxCommitment: 100000n } })).toBeNull()
    expect(waitlistRefusal({ ...base, dealState: 'closing_requested' })).toMatch(/only while the deal is live/)
    expect(waitlistRefusal({ ...base, mode: 'remind' })).toMatch(/no waiting list/)
    expect(waitlistRefusal({ ...base, alreadyOn: true })).toMatch(/already on/)
    expect(waitlistRefusal({ ...base, capacity: { kind: 'ok' } })).toMatch(/room for this amount/)
    expect(waitlistRefusal({ ...base, capacity: { kind: 'warn' } })).toMatch(/room for this amount/)
  })

  it('TC-ALO-04 letting in: live, still waiting, and room for a commitment the person could make on their terms', () => {
    const none = { kind: 'none' } as const
    const onTop = { kind: 'percent', bps: 400, mode: 'on_top' } as const
    const base = { dealState: 'live', state: 'waiting', room: 100000n, fee: none, minimum: 100000n }
    expect(releaseRefusal(base)).toBeNull()
    expect(releaseRefusal({ ...base, room: 99999n })).toMatch(/no room/)
    // 4% on top with £1,000 left: T of £1,000 fits
    expect(releaseRefusal({ ...base, fee: onTop })).toBeNull()
    // 4% taken from the payment with £960 left: C £1,000 gives T £960
    expect(releaseRefusal({ ...base, room: 96000n, fee: { kind: 'percent', bps: 400, mode: 'deducted' } })).toBeNull()
    expect(releaseRefusal({ ...base, room: 95999n, fee: { kind: 'percent', bps: 400, mode: 'deducted' } })).toMatch(/no room/)
    expect(releaseRefusal({ ...base, state: 'released' })).toMatch(/no longer waiting/)
    expect(releaseRefusal({ ...base, dealState: 'cancelled' })).toMatch(/only while the deal is live/)
  })

  it('TC-KYC-07 (lib) the relationship ends with the last participation or open invitation, never while one is active or an investment held; once set it does not move', () => {
    const now = new Date('2026-11-12T10:00:00Z')
    const before = new Date('2026-01-01T00:00:00Z')
    const none = { active: false, holding: false, invited: false }
    expect(relationshipEnd({ ...none, active: true, current: before, now })).toBeNull()
    expect(relationshipEnd({ ...none, holding: true, current: before, now })).toBeNull()
    expect(relationshipEnd({ ...none, invited: true, current: before, now })).toBeNull()
    expect(relationshipEnd({ ...none, current: null, now })).toEqual(now)
    expect(relationshipEnd({ ...none, current: before, now })).toEqual(before)
  })
})

describe('R-PIP-06 whom to invite, by version', () => {
  it('TC-PIP-05 only a confirmation of the version and words in force counts; a missing text refuses everything', async () => {
    const { inviteePolicyRefusal } = await import('./pipeline.ts')
    const v1 = { version: 1, sha256: 'a'.repeat(64) }
    expect(inviteePolicyRefusal(v1, [v1])).toBeNull()
    expect(inviteePolicyRefusal(v1, [])).toMatch(/confirm it first/)
    expect(inviteePolicyRefusal(v1, [])).not.toMatch(/changed/)
    // an older version, or other words under the same number, does not count
    expect(inviteePolicyRefusal({ version: 2, sha256: 'b'.repeat(64) }, [v1])).toMatch(/changed its text/)
    expect(inviteePolicyRefusal({ version: 1, sha256: 'b'.repeat(64) }, [v1])).toMatch(/changed its text/)
    expect(inviteePolicyRefusal({ version: 2, sha256: v1.sha256 }, [v1])).toMatch(/changed its text/)
    expect(inviteePolicyRefusal({ version: 2, sha256: 'b'.repeat(64) }, [v1, { version: 2, sha256: 'b'.repeat(64) }])).toBeNull()
    expect(inviteePolicyRefusal(null, [v1])).toMatch(/has not written whom leads may invite/)
  })
})

describe('R-ADM-03 net calculator', () => {
  const cfg = { rate_bps: 250, min_minor: 400_000n, max_minor: 2_000_000n, surcharge_threshold_minor: 500_000_000n, surcharge_bps: 10 }
  const smallest = (c: typeof cfg, target: bigint) => {
    const r = raiseFor(c, 'investors', target)!
    expect(r.net).toBe(r.raise - r.fee)
    expect(r.fee).toBe(platformFee(c, r.raise))
    expect(r.net >= target).toBe(true)
    // nothing smaller reaches the target
    for (let b = r.raise - 1n; b >= r.raise - 3_000n && b > 0n; b--) expect(b - platformFee(c, b) < target).toBe(true)
    return r
  }

  it('TC-ADM-01 calculator: the smallest raise that leaves the target after the fee, at each part of C-FEE-2', () => {
    // the minimum fee: £100,000 to the company needs £104,000
    expect(smallest(cfg, 10_000_000n)).toEqual({ payer: 'investors', raise: 10_400_000n, fee: 400_000n, net: 10_000_000n })
    // the rate: £487,500 needs £500,000 (fee £12,500)
    expect(smallest(cfg, 48_750_000n).raise).toBe(50_000_000n)
    // the cap and the surcharge: £6,000,000 raised pays £21,000
    expect(platformFee(cfg, 600_000_000n)).toBe(2_100_000n)
    expect(smallest(cfg, 600_000_000n - 2_100_000n).raise).toBe(600_000_000n)
    // rounding: odd rates and pennies, every answer checked by hand rule
    const odd = { rate_bps: 333, min_minor: 0n, max_minor: 900_000_000n, surcharge_threshold_minor: 7n, surcharge_bps: 77 }
    for (const t of [1n, 2n, 3n, 97n, 1_001n, 123_457n, 9_999_999n]) smallest(odd, t)
  })

  it('TC-ADM-01 calculator: equal to a count from the first penny, for every target, where the fee rounds most', () => {
    const configs = [
      { rate_bps: 4_999, min_minor: 0n, max_minor: 900_000_000n, surcharge_threshold_minor: 3n, surcharge_bps: 4_999 },
      { rate_bps: 5_000, min_minor: 0n, max_minor: 900_000_000n, surcharge_threshold_minor: 0n, surcharge_bps: 4_000 },
      { rate_bps: 333, min_minor: 7n, max_minor: 400n, surcharge_threshold_minor: 1_000n, surcharge_bps: 77 },
      // both parts round up by exactly half a penny at once, so B − fee is a penny under B − the exact fee
      { rate_bps: 2_500, min_minor: 0n, max_minor: 900_000_000n, surcharge_threshold_minor: 1n, surcharge_bps: 5_000 },
    ]
    for (const c of configs) {
      // the smallest raise for each target, by walking every raise from one penny up
      const first = new Map<bigint, bigint>()
      let most = 0n
      for (let b = 1n; most < 4_000n; b++) {
        const net = b - platformFee(c, b)
        for (let t = most + 1n; t <= net; t++) first.set(t, b)
        if (net > most) most = net
      }
      for (let t = 1n; t <= 4_000n; t++) expect(raiseFor(c, 'investors', t)!.raise, `${c.rate_bps} ${t}`).toBe(first.get(t))
    }
  })

  it('TC-ADM-01 calculator: a lead paying adds the fee on top; the company paying takes it from its payout (C-FEE-3); impossible rates give no answer', () => {
    expect(raiseFor(cfg, 'lead', 10_000_000n)).toEqual({ payer: 'lead', raise: 10_000_000n, fee: 400_000n, net: 10_000_000n })
    // the company receives the raise less the fee, so £100,000 to it needs £104,000, as when investors pay
    expect(raiseFor(cfg, 'company', 10_000_000n)).toEqual({ payer: 'company', raise: 10_400_000n, fee: 400_000n, net: 10_000_000n })
    expect(raiseFor(cfg, 'company', 48_750_000n)).toEqual({ ...raiseFor(cfg, 'investors', 48_750_000n)!, payer: 'company' })
    expect(raiseFor({ ...cfg, rate_bps: 9_995, surcharge_bps: 5 }, 'company', 100n)).toBeNull()
    expect(raiseFor({ ...cfg, rate_bps: 9_995, surcharge_bps: 5 }, 'investors', 100n)).toBeNull()
    expect(raiseFor({ ...cfg, surcharge_bps: 0, min_minor: MAX_TARGET * 3n, max_minor: MAX_TARGET * 3n }, 'investors', 100n)).toEqual({
      payer: 'investors',
      raise: MAX_TARGET * 3n + 100n,
      fee: MAX_TARGET * 3n,
      net: 100n,
    })
    // reached exactly at the largest stored amount, and past it there is no answer
    expect(raiseFor({ ...cfg, surcharge_bps: 0, min_minor: MAX_MINOR - 100n, max_minor: MAX_MINOR }, 'investors', 100n)).toEqual({
      payer: 'investors',
      raise: MAX_MINOR,
      fee: MAX_MINOR - 100n,
      net: 100n,
    })
    expect(raiseFor({ ...cfg, min_minor: MAX_MINOR, max_minor: MAX_MINOR }, 'investors', 100n)).toBeNull()
    // at the top: half the raise to the fee, the largest target needs exactly twice it; a high rate needs far more than the target
    const half = { rate_bps: 5_000, min_minor: 0n, max_minor: MAX_MINOR, surcharge_threshold_minor: 0n, surcharge_bps: 0 }
    expect(raiseFor(half, 'company', MAX_TARGET)).toEqual({ payer: 'company', raise: MAX_TARGET * 2n, fee: MAX_TARGET, net: MAX_TARGET })
    const r = raiseFor({ ...half, rate_bps: 9_900 }, 'investors', MAX_TARGET)!
    expect(r.net).toBeGreaterThanOrEqual(MAX_TARGET)
    expect(r.raise - 1n - platformFee({ ...half, rate_bps: 9_900 }, r.raise - 1n)).toBeLessThan(MAX_TARGET)
    expect(raiseFor(cfg, 'investors', MAX_TARGET + 1n)).toBeNull()
    expect(() => raiseFor(cfg, 'investors', 0n)).toThrow()
    // a fee that rounds to nothing: the raise is the target
    expect(raiseFor({ ...cfg, rate_bps: 0, min_minor: 0n, surcharge_bps: 0 }, 'investors', 5n)).toEqual({ payer: 'investors', raise: 5n, fee: 0n, net: 5n })
  })
})

describe('D4 lead panel: row actions and how each term changes (R-ADM-06, R-ADM-08)', () => {
  const part = { outcome: 'active' as const, moneyArrived: false, transferMarked: false, onHand: 0n, withdrawalOpen: false, proposalOpen: false }
  const base: RowActionFacts = { state: 'live', payoutException: false, isLead: true, invitationActive: true, termsFrozen: true, part, changeOpen: false, held: false }
  const why = (f: Partial<RowActionFacts>, p: Partial<NonNullable<RowActionFacts['part']>> = {}) =>
    Object.fromEntries(rowActions({ ...base, ...f, part: f.part === null ? null : { ...part, ...p } }).map((a) => [a.action, a.why]))

  it('TC-ADM-03 each action with the reason its own route gives', () => {
    expect(rowActions(base).map((a) => a.action)).toEqual([...ROW_ACTIONS])
    expect(why({})).toEqual({
      email: null,
      view_documents: null,
      remove: null,
      withdrawal: 'No money has arrived from this person: remove them instead.',
      replace_link: 'This person has committed, so their terms are fixed. A change goes through a change request.',
      amount_proposal: null,
      change_terms: null,
    })
    // an invitation with no commitment
    const NOT = 'This person has not committed.'
    expect(why({ part: null, termsFrozen: false })).toEqual({
      email: null,
      view_documents: NOT,
      remove: NOT,
      withdrawal: NOT,
      replace_link: null,
      amount_proposal: NOT,
      change_terms: NOT,
    })
    expect(why({ part: null, termsFrozen: false, invitationActive: false }).replace_link).toBe('This invitation has ended.')
    // money arrived
    expect(why({}, { moneyArrived: true, onHand: 5n })).toMatchObject({
      remove: 'Money has arrived from this person: record a withdrawal instead.',
      withdrawal: null,
      amount_proposal: 'Money has arrived for this person, so the amount cannot be changed this way.',
    })
    expect(why({}, { moneyArrived: true, withdrawalOpen: true }).withdrawal).toBe('A withdrawal for this person is already waiting for a reviewer.')
    // "I have paid": removal after a check, no new amount
    const marked = rowActions({ ...base, part: { ...part, transferMarked: true } })
    expect(marked.find((a) => a.action === 'remove')).toEqual({ action: 'remove', allowed: true, why: null, confirm: 'money_checked' })
    expect(rowActions(base).find((a) => a.action === 'remove')).toEqual({ action: 'remove', allowed: true, why: null })
    expect(marked.find((a) => a.action === 'amount_proposal')!.why).toBe('This person has said they paid, so the amount cannot be changed this way.')
    expect(why({}, { proposalOpen: true }).amount_proposal).toBe('A new amount for this person is already waiting for their answer.')
    expect(why({ changeOpen: true }).change_terms).toBe('Another change to this deal is waiting for a decision. Withdraw it or wait for the answer.')
    // ended
    const ENDED = 'This commitment has already ended.'
    expect(why({}, { outcome: 'removed' })).toMatchObject({ view_documents: null, remove: ENDED, withdrawal: ENDED, amount_proposal: ENDED, change_terms: ENDED })
    // the team reads
    const team = why({ isLead: false })
    expect(team.view_documents).toBeNull()
    for (const k of ROW_ACTIONS.filter((a) => a !== 'view_documents')) expect(team[k], k).toBe('Only the lead or a co-lead can do this.')
    expect(why({ isLead: false, part: null }).view_documents).toBe(NOT)
  })

  it('TC-ADM-03 by the state: §5.1 and the routes, each in its own words', () => {
    const cr = why({ state: 'closing_requested' }, { moneyArrived: true })
    expect(cr).toMatchObject({
      remove: 'Money has arrived from this person: record a withdrawal instead.',
      withdrawal: null,
      amount_proposal: 'A new amount can only be proposed while the deal is live.',
      change_terms: 'A change that investors must reconfirm needs the closing request withdrawn first.',
    })
    expect(why({ state: 'closing_requested', part: null, termsFrozen: false }).replace_link).toBe('Links can be replaced only while the deal is live.')
    const cl = why({ state: 'closing' }, { moneyArrived: true })
    expect(cl).toMatchObject({
      remove: 'Nobody can be removed in this state.',
      withdrawal: null,
      change_terms: 'A change that investors must reconfirm needs the deal back in live, or cancelled.',
    })
    const done = why({ state: 'cancelled' }, { moneyArrived: true })
    expect(done).toMatchObject({
      remove: 'Nobody can be removed in this state.',
      withdrawal: 'A withdrawal cannot be recorded in this state.',
      change_terms: 'This deal cannot be changed in its state.',
    })
    // the payout exception acts as closing
    expect(why({ state: 'closed', payoutException: true }, { moneyArrived: true }).withdrawal).toBeNull()
    expect(why({ state: 'closed' }, { moneyArrived: true }).withdrawal).toBe('A withdrawal cannot be recorded in this state.')
  })

  it('TC-ADM-04 each field by the route a change takes, the same as the classifier sorts it, and a pack can only make it stricter', () => {
    const h = (f: string, s: string[] = []) => howToChange(f, s)
    expect(h('terms.target_close')).toEqual({ field: 'terms.target_close', route: 'yourself', liveOnly: false, lockedAfterCommitment: false })
    expect(h('terms.pay_by').route).toBe('yourself')
    expect(h('terms.instrument').route).toBe('reconfirm')
    expect(h('economics.default_carry_bps').route).toBe('reconfirm')
    expect(h('terms.custom_terms.content.0').field).toBe('terms.custom_terms')
    expect(h('terms.currency')).toEqual({ field: 'terms.currency', route: 'reconfirm', liveOnly: false, lockedAfterCommitment: true })
    expect(h('files.memo').route).toBe('reviewer')
    expect(h('files.memo', ['memo']).route).toBe('reconfirm')
    expect(h('files.documents').route).toBe('reconfirm')
    expect(h('basics.name').route).toBe('reviewer')
    expect(h('terms.round_size_minor')).toMatchObject({ route: 'reviewer', liveOnly: false })
    expect(h('terms.over_allocation')).toMatchObject({ route: 'yourself', liveOnly: true })
    expect(h('terms.allocation_minor')).toMatchObject({ route: 'reviewer', liveOnly: true })
    expect(h('terms.allocation_minor', ['allocation_decrease']).route).toBe('by_direction')
    expect(h('terms.allocation_minor', ['allocation_decrease', 'allocation_increase']).route).toBe('reconfirm')
    expect(h('terms.min_commitment_minor')).toMatchObject({ route: 'reviewer', liveOnly: true })
    expect(h('terms.min_raise_minor')).toMatchObject({ route: 'by_direction', liveOnly: true })
    expect(h('terms.min_raise_minor', ['min_raise_raise']).route).toBe('reconfirm')
    expect(h('terms.share_price_micros').route).toBe('by_direction')
    expect(h('terms.price_is_placeholder').route).toBe('by_direction')
    expect(h('terms.share_price_micros', ['price_set', 'price_lower']).route).toBe('reconfirm')
    // a field no rule names is reconfirmed
    expect(h('terms.something_new').route).toBe('reconfirm')
    expect(SELF_SERVICE_FIELDS).toEqual(['terms.target_close', 'terms.pay_by', 'terms.over_allocation'])
  })
})

describe('D4 messages (R-COM-01..04, R-CMP-03)', () => {
  const live: DealGateFacts = { state: 'live', holds: { deal: false, lead: false, instance: false }, finalConfirmed: false }
  const fine: RecipientFacts = { reachable: true, person: { qualified: true, invitationActive: true }, activeCommitment: false, deal: live }
  const d = (over: Partial<RecipientFacts> = {}, deal: Partial<DealGateFacts> = {}) => deliveryFor({ ...fine, ...over, deal: { ...live, ...deal } })

  it('TC-COM-02 the message to whoever may see the deal today; a notice to whoever still takes part; nothing to the rest', () => {
    expect(d()).toEqual({ kind: 'message' })
    // committed, in closing: the own-participation gate (§5.5)
    for (const state of ['live', 'closing_requested', 'closing'] as const)
      expect(d({ person: { qualified: true, invitationActive: false }, activeCommitment: true }, { state }), state).toEqual({ kind: 'message' })
    expect(d({ person: { qualified: true, invitationActive: false }, activeCommitment: true }, { state: 'closing', finalConfirmed: true })).toEqual({ kind: 'notice' })
    // deciding but not live any more: not promoted to, still told to sign in
    expect(d({}, { state: 'closing_requested' })).toEqual({ kind: 'notice' })
    // a lapsed statement, deciding or committed
    expect(d({ person: { qualified: false, invitationActive: true } })).toEqual({ kind: 'notice' })
    expect(d({ person: { qualified: false, invitationActive: false }, activeCommitment: true })).toEqual({ kind: 'notice' })
    // no part any more, or a state where no message is written
    expect(d({ person: { qualified: true, invitationActive: false } })).toEqual({ kind: 'excluded', reason: 'ended' })
    expect(d({}, { state: 'closed' })).toEqual({ kind: 'excluded', reason: 'ended' })
    expect(d({ activeCommitment: true }, { state: 'cancelled' })).toEqual({ kind: 'excluded', reason: 'ended' })
    // paused at any level, and closed accounts, before anything else
    for (const h of ['deal', 'lead', 'instance'] as const) expect(d({}, { holds: { ...live.holds, [h]: true } }), h).toEqual({ kind: 'excluded', reason: 'held' })
    expect(d({ reachable: false }, { holds: { ...live.holds, deal: true } })).toEqual({ kind: 'excluded', reason: 'no_account' })
  })

  it('TC-COM-01 who may write: leads only, while live or closing, not paused; bulk only while the operator allows it', () => {
    const f = { state: 'live' as AnyDealState, isLead: true, held: false, bulk: true, bulkAllowed: true }
    expect(messageRefusal(f)).toBeNull()
    expect(messageRefusal({ ...f, isLead: false, state: 'closed', held: true, bulkAllowed: false })).toBe('Only the lead or a co-lead can do this.')
    for (const state of ['closing_requested', 'closing'] as const) expect(messageRefusal({ ...f, state })).toBeNull()
    for (const state of ['draft', 'approved', 'closed', 'cancelled', 'archived', 'settled'] as AnyDealState[])
      expect(messageRefusal({ ...f, state, held: true }), state).toBe('Messages can be sent only while the deal is live or closing.')
    expect(messageRefusal({ ...f, held: true, bulkAllowed: false })).toBe('The operator has paused this deal.')
    expect(messageRefusal({ ...f, bulkAllowed: false })).toBe('The operator has turned off messages to many investors at once.')
    expect(messageRefusal({ ...f, bulk: false, bulkAllowed: false })).toBeNull()
  })

  it('TC-COM-01 a group is each person once; the names to copy are those with a step of their own still to do', () => {
    const rows: AudienceRow[] = [
      { userId: 'a', name: 'Ann', status: 'to_sign', waiting: 'investor', committed: true },
      { userId: 'a', name: 'Ann', status: 'funded', waiting: null, committed: true },
      { userId: 'b', name: 'Bob', status: 'deciding', waiting: 'investor', committed: false },
      { userId: 'c', name: 'Cy', status: 'declined', waiting: null, committed: false },
      { userId: 'e', name: 'Eve', status: 'verifying', waiting: 'reviewer', committed: true },
    ]
    const ids = (f: Parameters<typeof audienceOf>[1]) => audienceOf(rows, f).map((p) => p.userId)
    expect(ids({})).toEqual(['a', 'b', 'c', 'e'])
    expect(ids({ status: 'funded' })).toEqual(['a'])
    expect(ids({ committed: true })).toEqual(['a', 'e'])
    expect(ids({ committed: false })).toEqual(['b', 'c'])
    expect(ids({ status: 'declined' })).toEqual(['c'])
    expect(ids({ waiting: 'none' })).toEqual(['a', 'c'])
    expect(ids({ waiting: 'reviewer', committed: true })).toEqual(['e'])
    expect(ids({ status: 'deciding', committed: true })).toEqual([])
    expect(unfinishedNames(rows, {})).toEqual(['Ann', 'Bob'])
    expect(unfinishedNames(rows, { committed: true })).toEqual(['Ann'])
    expect(unfinishedNames(rows, { status: 'funded' })).toEqual([])
  })

  it('TC-COM-01 the subject is one line; the text is not empty and not too long', () => {
    expect(messageProblems('Hi', 'x')).toEqual([])
    expect(messageProblems('a'.repeat(150), 'x'.repeat(10_000))).toEqual([])
    const SUBJ = 'The subject must be one line of 1 to 150 characters.'
    const TEXT = 'The text must be 1 to 10000 characters.'
    for (const bad of ['', '  ', 'a'.repeat(151), 'a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\u202eb', 'a\u200bb']) expect(messageProblems(bad, 'x'), JSON.stringify(bad)).toEqual([SUBJ])
    expect(messageProblems('Hi', ' \n ')).toEqual([TEXT])
    expect(messageProblems('Hi', 'x'.repeat(10_001))).toEqual([TEXT])
  })

  it('TC-ADM-03 the row action to write to one person, in the route\'s words', () => {
    const part = { outcome: 'active' as const, moneyArrived: false, transferMarked: false, onHand: 0n, withdrawalOpen: false, proposalOpen: false }
    const base: RowActionFacts = { state: 'live', payoutException: false, isLead: true, invitationActive: true, termsFrozen: true, part, changeOpen: false, held: false }
    const email = (f: Partial<RowActionFacts>) => rowActions({ ...base, ...f }).find((a) => a.action === 'email')!.why
    expect(email({})).toBeNull()
    expect(email({ part: null })).toBeNull()
    // the invitation ended but the commitment did not (another entity left): still taking part
    expect(email({ invitationActive: false })).toBeNull()
    expect(email({ invitationActive: false, part: { ...part, outcome: 'withdrawn' } })).toBe('They no longer take part in this deal.')
    expect(email({ invitationActive: false, part: null })).toBe('They no longer take part in this deal.')
    expect(email({ held: true })).toBe('The operator has paused this deal.')
    expect(email({ state: 'closing' })).toBeNull()
    expect(email({ state: 'cancelled' })).toBe('Messages can be sent only while the deal is live or closing.')
    expect(email({ isLead: false })).toBe('Only the lead or a co-lead can do this.')
  })
})
