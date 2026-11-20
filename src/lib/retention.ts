// Retention clocks for deal and transaction records (PRD §5.6, R-KYC-04; tech design §3.1). The person's own clock is
// `retentionDue` in entity.ts; these are the other two, and what is taken out of a deal's working copy when its time comes.
import { addMonths } from './entity.ts'
import type { Draft } from './draft.ts'

/** What a blanked name or account reads as; a blanked address is `REMOVED_ADDRESS`. */
export const REMOVED = 'Removed'
export const REMOVED_ADDRESS = 'removed@invalid'

/**
 * §5.6: people without an account (the investee's contacts, carry recipients) and what was said in the deal go with the
 * deal, from the day it ended (cancelled, rejected; closed in D5). A legal hold on the deal stops it; no end, no clock.
 */
export function dealRecordsDue(d: { endedAt: Date | null; hold: boolean }, relationshipYears: number, now: Date): boolean {
  if (d.hold || !d.endedAt) return false
  return addMonths(d.endedAt, relationshipYears * 12) <= now
}

/**
 * MLR reg 40(4): records of a transaction are kept at most this many years after it, even while the relationship goes on.
 * A row whose money date is on or before the day returned has its payer details taken out; amounts stay.
 */
export function transactionCutoff(now: Date, transactionYears: number): string {
  return addMonths(now, -transactionYears * 12)
    .toISOString()
    .slice(0, 10)
}

/** A complaint emailed in by someone with no account has no relationship to follow: it is kept the same years from receipt. */
export function emailComplaintDue(receivedAt: Date, relationshipYears: number, now: Date): boolean {
  return addMonths(receivedAt, relationshipYears * 12) <= now
}

const PERSON_KEYS = ['first_name', 'last_name', 'email', 'contact_name', 'contact_email'] as const

/**
 * The deal's working copy (and a change asked for) holds the contact's and recipients' names as typed; versions refer to
 * them by id. Everything else, a company recipient's legal name included, stays.
 */
export function withoutPeople(d: Draft): Draft {
  const out: Draft = { ...d }
  if (d.company) {
    const { contact_name: _n, contact_email: _e, ...company } = d.company
    out.company = company
  }
  if (d.economics?.recipients)
    out.economics = {
      ...d.economics,
      recipients: d.economics.recipients.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !(PERSON_KEYS as readonly string[]).includes(k)))),
    }
  return out
}
