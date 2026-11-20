// R-COM-01..04, R-CMP-02, R-CMP-03: the lead's messages. Free text cannot be judged, so every message is promotional: it needs
// approved content (R-CMP-02; single messages too, owner 2026-11-17), goes as HTML with the warning first only to someone who
// passes that day, and otherwise is a sign-in notice with no content, or is not sent at all and listed to the sender.
import {
  activeHold,
  type AnyDealState,
  canContinueOwnParticipation,
  canReceivePromotion,
  type DealGateFacts,
  type OwnParticipationFacts,
  type PersonGateFacts,
} from './gate.ts'
import type { LeadRowView } from './participation.ts'

export const MESSAGE_SUBJECT_MAX = 150
export const MESSAGE_BODY_MAX = 10_000

/** R-COM-03: said wherever the archive is shown (the lead's list, the investor's, the evidence pack). */
export const ARCHIVE_NOTE = 'Only messages sent through this site are kept here. Replies, and anything said outside the site, are not.'

/** R-OP-09, TC-CMP-07: what an approval of a message is, said wherever it is recorded or shown. */
export const INTERNAL_APPROVAL_NOTE =
  "This is the operator's internal record that the content was approved. It is not the statutory approval of a financial promotion."

/** Why a subject and text cannot be saved; empty when they can. */
export function messageProblems(subject: string, body: string): string[] {
  const out: string[] = []
  // a line break in a subject would start a new mail header
  if (subject.trim().length === 0 || subject.length > MESSAGE_SUBJECT_MAX || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(subject))
    out.push(`The subject must be one line of 1 to ${MESSAGE_SUBJECT_MAX} characters.`)
  if (body.trim().length === 0 || body.length > MESSAGE_BODY_MAX) out.push(`The text must be 1 to ${MESSAGE_BODY_MAX} characters.`)
  return out
}

/** The deal states a lead may write in: while people are still taking part. After closing it is company updates (R-COM-05). */
const MESSAGE_STATES: readonly AnyDealState[] = ['live', 'closing_requested', 'closing']

export interface SendFactsForLead {
  state: AnyDealState
  isLead: boolean
  held: boolean
  bulk: boolean
  /** R-CMP-03: the operator's switch for promotional bulk mail. */
  bulkAllowed: boolean
}

/** Why the lead cannot write or send this message now; null when they can. The same words for the route and the row action. */
export function messageRefusal(f: SendFactsForLead): string | null {
  if (!f.isLead) return 'Only the lead or a co-lead can do this.'
  if (!MESSAGE_STATES.includes(f.state)) return 'Messages can be sent only while the deal is live or closing.'
  if (f.held) return 'The operator has paused this deal.'
  if (f.bulk && !f.bulkAllowed) return 'The operator has turned off messages to many investors at once.'
  return null
}

/** The facts about one recipient, read when the message is sent and again before each attempt. */
export interface RecipientFacts {
  /** The account exists, is not closed or anonymised. */
  reachable: boolean
  person: PersonGateFacts
  /** The person has a commitment on this deal that has not ended. */
  activeCommitment: boolean
  deal: DealGateFacts
}

export type Delivery = { kind: 'message' } | { kind: 'notice' } | { kind: 'excluded'; reason: ExclusionReason }
export type ExclusionReason = 'no_account' | 'ended' | 'held'

const ACTIVE: OwnParticipationFacts = {
  outcome: 'active',
  kycPassed: false,
  signed: false,
  identityReview: false,
  entityVersionCurrent: true,
  reconfirmPending: false,
  needsCheck: false,
  accountAcknowledged: false,
}

/**
 * R-COM-04, §5.5: the message itself to someone who may see promotional content of this deal today: someone deciding
 * (canReceivePromotion) or someone who committed (canContinueOwnParticipation). Someone still taking part who does not pass
 * today (a lapsed statement) gets a sign-in notice with no content; whoever has no part in the deal any more gets nothing.
 */
export function deliveryFor(f: RecipientFacts): Delivery {
  if (!f.reachable) return { kind: 'excluded', reason: 'no_account' }
  if (activeHold(f.deal.holds)) return { kind: 'excluded', reason: 'held' }
  if (canReceivePromotion(f.person, f.deal) || (f.activeCommitment && canContinueOwnParticipation(f.person, ACTIVE, f.deal))) return { kind: 'message' }
  if ((f.person.invitationActive || f.activeCommitment) && MESSAGE_STATES.includes(f.deal.state)) return { kind: 'notice' }
  return { kind: 'excluded', reason: 'ended' }
}

export const EXCLUSION_WORDS: Record<ExclusionReason, string> = {
  no_account: 'Their account is closed.',
  ended: 'They no longer take part in this deal.',
  held: 'The operator has paused this deal.',
}

/** R-COM-01: whom a bulk message goes to. Every field left out matches everyone; `committed` is "invested" before closing. */
export interface AudienceFilter {
  status?: LeadRowView['status']
  waiting?: NonNullable<LeadRowView['waiting']> | 'none'
  committed?: boolean
}

export interface AudienceRow {
  userId: string
  name: string
  status: LeadRowView['status']
  waiting: LeadRowView['waiting']
  /** The row is a commitment that has not ended. */
  committed: boolean
}

const rowMatches = (r: AudienceRow, f: AudienceFilter) =>
  (!f.status || r.status === f.status) && (!f.waiting || (r.waiting ?? 'none') === f.waiting) && (f.committed === undefined || r.committed === f.committed)

/** One entry per person: a person is in when any of their rows matches. */
export function audienceOf(rows: readonly AudienceRow[], f: AudienceFilter): { userId: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const r of rows) if (rowMatches(r, f) && !seen.has(r.userId)) seen.set(r.userId, r.name)
  return [...seen].map(([userId, name]) => ({ userId, name }))
}

/** R-COM-01 "copy the names of those not done": in the chosen group, whoever has a step of their own still to do. */
export function unfinishedNames(rows: readonly AudienceRow[], f: AudienceFilter): string[] {
  const names = new Map<string, string>()
  for (const r of rows) if (rowMatches(r, f) && r.waiting === 'investor' && !names.has(r.userId)) names.set(r.userId, r.name)
  return [...names.values()]
}
