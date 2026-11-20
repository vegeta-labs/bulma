// Deal state machine up to `live` (PRD §5.1, R-REV-02 to R-REV-04, R-PUB-01). Pure and refuse-by-default: a fact that is missing
// counts against the move. The rows from `live` onwards arrive with D4 and D5.
export type DealState = 'draft' | 'in_review' | 'changes_requested' | 'rejected' | 'approved' | 'live'
export type DealEvent = 'submit' | 'withdraw' | 'request_changes' | 'lead_edit' | 'resubmit' | 'reject' | 'approve' | 'lapse' | 'launch'
export type DealActor = 'lead' | 'reviewer' | 'system'

export const DEAL_STATES: readonly DealState[] = ['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'live']
export const DEAL_EVENTS: readonly DealEvent[] = ['submit', 'withdraw', 'request_changes', 'lead_edit', 'resubmit', 'reject', 'approve', 'lapse', 'launch']

export interface TransitionFacts {
  actor: DealActor
  now: Date
  /** What the draft still lacks. Every move into review needs this empty, so an edit cannot leave a reviewer an incomplete deal. */
  gaps?: readonly string[]
  reason?: string
  /** R-REV-04: true when this reviewer is the lead, on the team, or a carry recipient. */
  reviewerConflicted?: boolean
  /** R-CMP-02. */
  contentApproved?: boolean
  leadConfirmed?: boolean
  approvedAt?: Date
  /** Days a lead has to confirm launch (R-PUB-01, operator setting, default 30). */
  confirmDays?: number
}

export type Decision = { ok: true; to: DealState } | { ok: false; reason: string }

const DAY_MS = 86_400_000

const MOVES = new Map<DealEvent, { actor: DealActor; from: ReadonlyMap<DealState, DealState> }>([
  ['submit', { actor: 'lead', from: new Map([['draft', 'in_review']]) }],
  ['withdraw', { actor: 'lead', from: new Map([['in_review', 'draft']]) }],
  ['request_changes', { actor: 'reviewer', from: new Map([['in_review', 'changes_requested']]) }],
  // an edit during review restarts it; an edit after approval takes the deal back to review (R-REV-03, R-PUB-01)
  [
    'lead_edit',
    {
      actor: 'lead',
      from: new Map([
        ['in_review', 'in_review'],
        ['approved', 'in_review'],
      ]),
    },
  ],
  ['resubmit', { actor: 'lead', from: new Map([['changes_requested', 'in_review']]) }],
  ['reject', { actor: 'reviewer', from: new Map([['in_review', 'rejected']]) }],
  ['approve', { actor: 'reviewer', from: new Map([['in_review', 'approved']]) }],
  ['lapse', { actor: 'system', from: new Map([['approved', 'draft']]) }],
  ['launch', { actor: 'lead', from: new Map([['approved', 'live']]) }],
])

/** When an approval runs out, or null when that cannot be worked out. */
function confirmDeadline(f: TransitionFacts): number | null {
  const at = f.approvedAt?.getTime()
  const days = f.confirmDays
  if (at === undefined || !Number.isFinite(at) || days === undefined || !Number.isInteger(days) || days < 1) return null
  return at + days * DAY_MS
}

function refusal(event: DealEvent, f: TransitionFacts): string | null {
  const now = f.now.getTime()
  if (!Number.isFinite(now)) return 'The time of this action is not known.'
  switch (event) {
    case 'submit':
    case 'resubmit':
    case 'lead_edit':
      if (!f.gaps) return 'What is missing from the deal could not be checked.'
      return f.gaps.length ? `Still missing: ${f.gaps.join(', ')}.` : null
    case 'request_changes':
    case 'reject':
    case 'approve':
      if (f.reviewerConflicted !== false) return 'You cannot review a deal you lead, work on, or receive carry from.'
      if (event !== 'approve' && !f.reason?.trim()) return 'Give a reason.'
      return null
    case 'lapse': {
      const due = confirmDeadline(f)
      return due !== null && now >= due ? null : 'The time to confirm launch has not run out.'
    }
    case 'launch': {
      const due = confirmDeadline(f)
      // judged here as well as by the job, so the result does not depend on when the job last ran
      if (due === null || now >= due) return 'The time to confirm launch has run out.'
      if (f.contentApproved !== true) return 'The content has not been approved.'
      return f.leadConfirmed === true ? null : 'Confirm that the deal should go live.'
    }
    case 'withdraw':
      return null
  }
}

/** PRD §5.1: where this event takes the deal, or why it cannot happen. */
export function decideTransition(from: DealState, event: DealEvent, f: TransitionFacts): Decision {
  const move = MOVES.get(event)
  const to = move?.from.get(from)
  if (!move || to === undefined) return { ok: false, reason: 'That cannot be done to a deal in this state.' }
  if (f.actor !== move.actor) return { ok: false, reason: 'You cannot do that to this deal.' }
  const why = refusal(event, f)
  return why === null ? { ok: true, to } : { ok: false, reason: why }
}

/** R-CMP-02: the real mode launches only content whose hash was approved; a sandbox asks only when the operator turned this on. */
export function launchContentApproved(f: {
  mode: 'sandbox' | 'real'
  requiredInSandbox: boolean
  contentSha256: string
  approvedSha256: readonly string[]
}): boolean {
  if (f.mode === 'sandbox' && !f.requiredInSandbox) return true
  return f.approvedSha256.includes(f.contentSha256)
}
