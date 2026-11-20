// Complaints (PRD R-AUD-05, decision R28 (5)): registered on the site from the person's own form, or entered by staff from
// an email. Each must be acknowledged within 30 days of receipt (DUAA 2025 s.103 / DPA 2018 s.164A); until then it is on
// the operator's to-do list, due on the 30th day. Pure.

export const COMPLAINT_DAYS = 30
export const COMPLAINT_MAX = 10_000
/** A person's form complaints in one day; more are refused so the list cannot be flooded. Email stays open to them. */
export const COMPLAINTS_PER_DAY = 10

const DAY_MS = 86_400_000

/** The last day to acknowledge: the 30th calendar day after the day it was received (UTC), as YYYY-MM-DD. */
export function complaintDue(receivedAt: Date): string {
  const day = Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth(), receivedAt.getUTCDate())
  return new Date(day + COMPLAINT_DAYS * DAY_MS).toISOString().slice(0, 10)
}

/** Why a complaint's text cannot be kept; null when it can. */
export function complaintProblem(body: string): string | null {
  if (body.trim().length === 0) return 'Write what the complaint is about.'
  if (body.length > COMPLAINT_MAX) return `A complaint can be at most ${COMPLAINT_MAX} characters.`
  return null
}

/** Why staff cannot enter an emailed complaint as received on this day; null when they can. */
export function receivedOnProblem(receivedOn: string, today: string): string | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) ||
    Number.isNaN(Date.parse(`${receivedOn}T00:00:00Z`)) ||
    new Date(`${receivedOn}T00:00:00Z`).toISOString().slice(0, 10) !== receivedOn
  )
    return 'Give the day the email arrived as YYYY-MM-DD.'
  if (receivedOn > today) return 'The day the email arrived cannot be in the future.'
  return null
}

/** The fixed acknowledgement sent to someone who complained through the form. No text of theirs is repeated in it. */
export function acknowledgementMail(receivedOn: string): { subject: string; body: string } {
  return {
    subject: 'We have received your complaint',
    body: `We have received the complaint you sent through the site on ${receivedOn} and are looking into it. You can see it, and when it was acknowledged, under Complaints when you sign in.`,
  }
}

/** Shown with the form: what happens next, and the operator's address when they gave one. */
export function complaintChannelText(email: string | null): string {
  const base = `Your complaint is kept on this site and acknowledged within ${COMPLAINT_DAYS} days.`
  return email ? `${base} You can also email it to ${email}.` : base
}
