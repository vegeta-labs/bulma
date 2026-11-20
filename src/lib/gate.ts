// Named access decisions (tech design T7, §4). Pure and deny-by-default. Every route names one; a route without one does
// not start (TC-AUTHZ-07). Deal and investor decisions join this file from D1.
import type { InstanceRole } from './instance.ts'

export interface Actor {
  id: string
  roles: readonly InstanceRole[]
  mustChangePassword: boolean
  emailVerified: boolean
  mfaOn: boolean
}

export type Gate = (actor: Actor | null) => boolean

// R-ACC-03: every role needs two-step sign-in switched on before it can do anything
const hasRole =
  (role: InstanceRole): Gate =>
  (a) =>
    !!a && !a.mustChangePassword && a.emailVerified && a.mfaOn && a.roles.includes(role)

export const GATES = {
  // reachable with no session; the full list is PUBLIC_ROUTES in the server, and a mismatch stops the start
  public: () => true,
  // signed in, even while the password must still be changed
  signedIn: (a) => !!a,
  // signed in with a password that is not a temporary one
  active: (a) => !!a && !a.mustChangePassword,
  // an investor or lead: signed in with a proven email address
  verified: (a) => !!a && !a.mustChangePassword && a.emailVerified,
  canAdministerInstance: hasRole('admin'),
  canReviewKyc: hasRole('reviewer'),
  canReviewDeals: hasRole('reviewer'),
  canApproveContent: hasRole('approver'),
  // R-PAY-09: a reviewer or an admin records money
  canRecordMoney: (a) => !!a && !a.mustChangePassword && a.emailVerified && a.mfaOn && (a.roles.includes('admin') || a.roles.includes('reviewer')),
  // R-OPS-01..03: the workbench, the deal board and every deal's list, read only
  canRunOperations: (a) => !!a && !a.mustChangePassword && a.emailVerified && a.mfaOn && (a.roles.includes('admin') || a.roles.includes('reviewer')),
  canReadAudit: (a) => !!a && !a.mustChangePassword && a.emailVerified && a.mfaOn && (a.roles.includes('admin') || a.roles.includes('reviewer')),
} as const satisfies Record<string, Gate>

export type GateName = keyof typeof GATES

export const isGateName = (x: unknown): x is GateName => typeof x === 'string' && Object.hasOwn(GATES, x)

/** Who has a stake in a deal. Carry recipients need no account, so they are known by address. */
export interface DealParties {
  /** The lead, co-leads and syndicate admins, who run the deal. */
  leadUserIds: readonly string[]
  /** The members assigned to this deal, who can read it but not change it (R-SYN-06). */
  memberUserIds: readonly string[]
  carryRecipientEmails: readonly string[]
  /** Everyone else in the syndicate. They cannot review its deals, but being in it gives them no access to one. */
  otherSyndicateMemberIds?: readonly string[]
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** R-REV-04: the lead, anyone on the team, or a carry recipient. */
export function isInterestedParty(user: { id: string; email: string }, p: DealParties): boolean {
  return (
    p.leadUserIds.includes(user.id) ||
    p.memberUserIds.includes(user.id) ||
    !!p.otherSyndicateMemberIds?.includes(user.id) ||
    p.carryRecipientEmails.some((e) => sameAddress(e, user.email))
  )
}

export function canAdministerDeal(a: Actor | null, p: DealParties): boolean {
  return GATES.verified(a) && !!a && (p.leadUserIds.includes(a.id) || p.memberUserIds.includes(a.id))
}

export function canReviewDeal(a: Actor | null, email: string, p: DealParties): boolean {
  return hasRole('reviewer')(a) && !!a && !isInterestedParty({ id: a.id, email }, p)
}

/** R-PIP-01: the expected-investor list is read by the lead and the deal's team, and by reviewers and admins, read only. */
export function canReadPipeline(a: Actor | null, p: DealParties): boolean {
  return canAdministerDeal(a, p) || hasRole('reviewer')(a) || hasRole('admin')(a)
}

/** R-OP-09: a content approver passes the same conflict check as a reviewer. */
export function canApproveDealContent(a: Actor | null, email: string, p: DealParties): boolean {
  return hasRole('approver')(a) && !!a && !isInterestedParty({ id: a.id, email }, p)
}

// ---- Deal and investor decisions (PRD §5.5, R-CMP-01, tech design §4). D3. ----

/** Every deal state a gate may see; states past `live` arrive with D4 and D5, and are judged here already (TC-GATE-04). */
export type AnyDealState =
  | 'draft'
  | 'in_review'
  | 'changes_requested'
  | 'rejected'
  | 'approved'
  | 'live'
  | 'closing_requested'
  | 'closing'
  | 'settled'
  | 'closed'
  | 'cancelled'
  | 'archived'

/** R-CMP-01: holds in force at this moment, at any of the three levels. */
export interface Holds {
  deal: boolean
  lead: boolean
  instance: boolean
}
export const activeHold = (h: Holds) => h.deal || h.lead || h.instance

export interface DealGateFacts {
  state: AnyDealState
  holds: Holds
  /** R-CLS-04: final amounts confirmed. */
  finalConfirmed: boolean
}

export interface PersonGateFacts {
  /** isQualified from eligibility.ts: statement in date, not "neither", the pack's steps done. */
  qualified: boolean
  /** An invitation of this person's to this deal is in progress (§5.2). */
  invitationActive: boolean
}

export interface OwnParticipationFacts {
  outcome: 'active' | 'removed' | 'withdrawn' | 'deal_cancelled' | 'rejected_kyc' | 'excluded_at_close'
  kycPassed: boolean
  signed: boolean
  identityReview: boolean
  /** The entity version the participation is bound to is still the entity's current one. */
  entityVersionCurrent: boolean
  reconfirmPending: boolean
  /** N below zero (§5.2 "需要核对"). */
  needsCheck: boolean
  /** The person has acknowledged the current receiving-account version (instruction_ack, R-OP-05). */
  accountAcknowledged: boolean
}

/** canReceivePromotion (§5.5): deal page, memo, files, promotional email to a person who has not committed. */
export function canReceivePromotion(p: PersonGateFacts, d: DealGateFacts): boolean {
  return !activeHold(d.holds) && p.qualified && p.invitationActive && d.state === 'live'
}

/** R-CMT-02, R-ELG-02.1: a new commitment. The entity must hold what the pack asks of it. */
export function canCommit(p: PersonGateFacts, d: DealGateFacts, entityMeetsPack: boolean): boolean {
  return canReceivePromotion(p, d) && entityMeetsPack
}

const CONTINUE_STATES: readonly AnyDealState[] = ['live', 'closing_requested', 'closing']

/** canContinueOwnParticipation (§5.5): new content and actions for someone who committed. */
export function canContinueOwnParticipation(p: PersonGateFacts, part: OwnParticipationFacts, d: DealGateFacts): boolean {
  if (activeHold(d.holds) || !p.qualified || part.outcome !== 'active') return false
  if (!CONTINUE_STATES.includes(d.state)) return false
  // §5.1: signing and instructions in `closing` only before the final amounts are confirmed
  return !(d.state === 'closing' && d.finalConfirmed)
}

/** R-SIG-01, §5.1, §5.2: signing. `kycFirst` is whether the pack puts KYC before signing. */
export function canSign(p: PersonGateFacts, part: OwnParticipationFacts, d: DealGateFacts, kycFirst: boolean): boolean {
  if (!canContinueOwnParticipation(p, part, d)) return false
  if (kycFirst && !part.kycPassed) return false
  return !part.identityReview && part.entityVersionCurrent && !part.reconfirmPending && !part.signed
}

/** R-PAY-01, §5.2: new payment instructions. KYC and signing always come first (pack invariant c). */
export function canSeePaymentInstructions(p: PersonGateFacts, part: OwnParticipationFacts, d: DealGateFacts): boolean {
  if (!canContinueOwnParticipation(p, part, d)) return false
  return (
    part.kycPassed && part.signed && part.accountAcknowledged && !part.identityReview && part.entityVersionCurrent && !part.reconfirmPending && !part.needsCheck
  )
}

/** canSeeOwnExecutedDocs (§5.5, R-SIG-06): narrow exception. Only whether the file is the person's own. */
export const canSeeOwnExecutedDocs = (own: boolean) => own

/** canSeeIssuedInstructions (§5.5, R-ELG-03): narrow exception. Not voided; a hold hides them (R-CMP-01). */
export function canSeeIssuedInstructions(own: boolean, issued: { voided: boolean }, d: DealGateFacts): boolean {
  return own && !issued.voided && !activeHold(d.holds)
}

/** canReceiveCompanyUpdate (§5.5): closed and invested. A hold stops it (R-CMP-01). */
export function canReceiveCompanyUpdate(invested: bigint | null, d: DealGateFacts): boolean {
  return !activeHold(d.holds) && d.state === 'closed' && invested !== null && invested > 0n
}
