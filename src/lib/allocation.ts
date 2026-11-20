// R-ALO-01, R-ALO-03, R-ALO-04 and PRD §5.6: a lead's proposed amount, a full deal, the waiting list, and when a person's
// relationship with the operator ends. Pure; the server reads the facts and writes what these decide.
import { largestCommitmentWithin, type Capacity, type CapacityMode } from './money.ts'
import type { LinkFee } from './fees.ts'

/** R-ALO-03: the deal's choice for a full allocation (R-DRF-04). Anything but "stop" is the default, a reminder. */
export const capacityMode = (overAllocation: unknown): CapacityMode => (overAllocation === 'stop_and_waitlist' ? 'stop' : 'remind')

/** R-ALO-03: why a commitment (or an increase) cannot be made as asked, or null. The words name what can be done instead. */
export function capacityRefusal(c: Capacity, words: (minor: bigint) => string): string | null {
  if (c.kind === 'limit') return `This deal has room only for a commitment of up to ${words(c.maxCommitment)}.`
  if (c.kind === 'waitlist') return 'This deal is full. You can join the waiting list instead.'
  return null
}

/** R-ALO-01: how a proposal ended. Only `accepted` changes the amount. */
export type ProposalEnd = 'accepted' | 'declined' | 'lapsed' | 'money_arrived' | 'closing_requested' | 'part_ended'

/** R-ALO-01: silence is never agreement; at the deadline the proposal ends and the amount stays. */
export const proposalLapsed = (deadline: Date, now: Date): boolean => now.getTime() >= deadline.getTime()

/**
 * R-ALO-04: why this person cannot join the waiting list for `desired`, or null. Only in stop mode, while live, and only when
 * the amount does not fit: when it does, the person commits instead. One entry per invitation.
 */
export function waitlistRefusal(i: { dealState: string; mode: CapacityMode; capacity: Capacity; alreadyOn: boolean }): string | null {
  if (i.dealState !== 'live') return 'The waiting list is open only while the deal is live.'
  if (i.mode !== 'stop') return 'This deal has no waiting list. You can commit.'
  if (i.alreadyOn) return 'You are already on the waiting list for this deal.'
  if (i.capacity.kind === 'ok' || i.capacity.kind === 'warn') return 'There is room for this amount. You can commit.'
  return null
}

/**
 * R-ALO-04: why the lead cannot let this person in now, or null. Order is the lead's choice, but there must be room for some
 * commitment the person could make (R-ALO-03, judged on their terms and the deal's minimum).
 */
export function releaseRefusal(i: { dealState: string; state: string; room: bigint; fee: LinkFee; minimum: bigint }): string | null {
  if (i.dealState !== 'live') return 'People can be let in from the waiting list only while the deal is live.'
  if (i.state !== 'waiting') return 'This person is no longer waiting.'
  if (largestCommitmentWithin(i.room, i.fee, i.minimum) === null) return 'There is no room left in the deal. Raise the allocation first.'
  return null
}

/**
 * PRD §5.6: the day the relationship ended, from which records are kept. It runs while any participation is active, an
 * investment is still held (D5), or an invitation to a running deal is still open ("邀请全部结束"); otherwise it is the day
 * the last one ended: kept once set, so a later look does not move it.
 */
export function relationshipEnd(i: { active: boolean; holding: boolean; invited: boolean; current: Date | null; now: Date }): Date | null {
  if (i.active || i.holding || i.invited) return null
  return i.current ?? i.now
}
