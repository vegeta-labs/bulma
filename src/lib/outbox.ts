// R23, R-NTF-02: the durable mail queue's rules. A mail is written in the same transaction as the change it reports; a worker
// sends it later and, before every attempt (retries too), decides again from what is true then (tech design "外发邮件").
import type { Mode } from './instance.ts'

/** Whom a queued mail is for, and so what is checked again before each attempt. */
export type Audience =
  /** Account links and notices to an address that was typed, and people with no account (investee contacts, parties). */
  | { kind: 'address' }
  /** R-NTF-01 urgent notice: never stopped by a gate, a hold or an approval. Goes to the person's current address. */
  | { kind: 'urgent'; userId: string }
  /** A notice about a person's own account. */
  | { kind: 'account'; userId: string }
  /** A targeted invitation (R-LNK-07): only while it is still open, the deal live and not held. */
  | { kind: 'invite'; inviteId: string; dealId: string }
  /** The lead or a co-lead of a deal: only while they still are. */
  | { kind: 'lead'; userId: string; dealId: string }
  /** R-NTF-01: a reminder to an investor, only while what it reminds about is still to do and the deal is not held. */
  | { kind: 'reminder'; userId: string; dealId: string; about: ReminderAbout; aboutId: string }
  /** R-COM-04: a lead's message: only while the person still takes part and the deal is not held; content decided per attempt. */
  | { kind: 'message'; userId: string; dealId: string; messageId: string }

/** commit: a bound invitation with no commitment yet; payment: a participation that owes; reconfirm: one asked to reconfirm. */
export type ReminderAbout = 'commit' | 'payment' | 'reconfirm'
export type AudienceKind = Audience['kind']
export const AUDIENCE_KINDS: readonly AudienceKind[] = ['address', 'urgent', 'account', 'invite', 'lead', 'reminder', 'message']

/** What the worker read just before an attempt. Only the fields the audience needs are read. */
export interface SendFacts {
  modeNow: Mode
  /** The account named by the audience; null when it does not exist. */
  user?: { email: string; disabled: boolean; anonymised: boolean } | null
  /** invite: still open; lead: still the lead or a co-lead; reminder: still to do; message: still takes part in the deal. */
  stillHolds?: boolean
  /** invite: the deal is live; reminder: the deal is in a state where the step can still be done. */
  dealLive?: boolean
  /** invite, reminder, message: a hold at any level (R-CMP-01). */
  held?: boolean
}

export type CancelReason = 'mode_changed' | 'no_recipient' | 'recipient_disabled' | 'role_ended' | 'deal_not_live' | 'held'
export type SendDecision = { send: true; to: string } | { send: false; reason: CancelReason }

/**
 * R-NTF-02: decided again before every attempt. A mail queued in one mode never goes out in the other: sandbox mail never
 * leaves, and the switch ends what the sandbox started (R-OP-01).
 */
export function decideSend(a: Audience, queuedTo: string, queuedMode: Mode, f: SendFacts): SendDecision {
  if (f.modeNow !== queuedMode) return { send: false, reason: 'mode_changed' }
  switch (a.kind) {
    case 'address':
      return { send: true, to: queuedTo }
    case 'urgent':
      // a closed account may still hold payment details, so it is told; an anonymised one has no address left
      if (!f.user || f.user.anonymised) return { send: false, reason: 'no_recipient' }
      return { send: true, to: f.user.email }
    case 'account':
    case 'lead':
    case 'reminder':
      if (!f.user || f.user.anonymised) return { send: false, reason: 'no_recipient' }
      if (f.user.disabled) return { send: false, reason: 'recipient_disabled' }
      if (a.kind !== 'account' && !f.stillHolds) return { send: false, reason: 'role_ended' }
      // a reminder never asks for money or a decision while the deal is paused (R-CMP-01)
      if (a.kind === 'reminder' && f.held) return { send: false, reason: 'held' }
      if (a.kind === 'reminder' && !f.dealLive) return { send: false, reason: 'deal_not_live' }
      return { send: true, to: f.user.email }
    case 'message':
      if (!f.user || f.user.anonymised) return { send: false, reason: 'no_recipient' }
      if (f.user.disabled) return { send: false, reason: 'recipient_disabled' }
      // R-CMP-01: queued promotional mail stops while the deal is paused
      if (f.held) return { send: false, reason: 'held' }
      if (!f.stillHolds) return { send: false, reason: 'role_ended' }
      return { send: true, to: f.user.email }
    case 'invite':
      if (!f.stillHolds) return { send: false, reason: 'role_ended' }
      if (f.held) return { send: false, reason: 'held' }
      if (!f.dealLive) return { send: false, reason: 'deal_not_live' }
      return { send: true, to: queuedTo }
  }
}

/** R28 (8): five retries after the first attempt, the wait growing to at most 24 hours; then the mail goes to the operator's list. */
export const RETRY_MINUTES = [1, 10, 60, 6 * 60, 24 * 60] as const
export const MAX_ATTEMPTS = 1 + RETRY_MINUTES.length

/** After `attempts` failed attempts: when to try again, or null when it has run out of tries. */
export function nextAttemptAt(attempts: number, failedAt: Date): Date | null {
  if (attempts < 1 || attempts >= MAX_ATTEMPTS) return null
  return new Date(failedAt.getTime() + RETRY_MINUTES[attempts - 1]! * 60_000)
}
