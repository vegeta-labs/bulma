// R-NTF-01, R-NTF-02, R-COM-04, R-COM-06: what a mail says. Investor mail is built only from a fixed list of fields, so no
// company name, amount or term can reach it; urgent notices have fixed words nobody can change; an operator's edit of an
// investor template turns that mail promotional, sent as HTML with the warning first, and only to someone who passes that day.
import { textParts } from './legalText.ts'

/** R-NTF-01: the fixed list of action types an investor mail can name. */
export const INVESTOR_ACTIONS = {
  invitation: 'You have been invited to look at a private investment opportunity',
  commit_reminder: 'Reminder: an invitation is waiting for your decision',
  commitment_confirmed: 'Your commitment has been recorded',
  payment_reminder: 'Payment needed',
  reconfirm_reminder: 'Please reconfirm your commitment',
  money_received: 'Money received',
  details_checked: 'Your details have been checked',
  kyc_passed: 'Identity check passed',
  kyc_returned: 'Identity check: more is needed',
  assessment_retake: 'About your assessment',
  commitment_ended: 'Your commitment to this deal has ended',
  deal_cancelled: 'This deal has been cancelled',
  amount_proposed: 'A new amount has been proposed for your commitment',
  amount_unchanged: 'The proposed new amount has ended: your commitment is unchanged',
  waitlist_released: 'A place has opened for you in a deal',
  waitlist_ended: 'The waiting list for a deal has closed',
  deal_updated: 'A deal you committed to has been updated: sign in to see what changed',
  reconfirm_needed: 'The terms of a deal you committed to have changed: please reconfirm',
  new_message: 'You have a new message about a deal: sign in to read it',
} as const
export type InvestorAction = keyof typeof INVESTOR_ACTIONS

/** R-NTF-01: urgent notices. The title says what to do; the operator cannot change them, and they hold no deal content. */
export const URGENT = {
  void_details_changed: {
    subject: 'Do not send money: your earlier payment instructions are no longer valid',
    line: 'Your details changed after you signed, so the payment instructions you were given are no longer valid. Do not pay using them.',
  },
  void_kyc: {
    subject: 'Do not send money: your earlier payment instructions are no longer valid',
    line: 'The payment instructions you were given for this deal are no longer valid. Do not send money using them.',
  },
  void_commitment_ended: {
    subject: 'Do not send money: your earlier payment instructions are no longer valid',
    line: 'Your commitment has ended, so the payment instructions you were given are no longer valid. Do not pay using them.',
  },
  void_commitment_changed: {
    subject: 'Do not send money: your earlier payment instructions are no longer valid',
    line: 'Your commitment changed, so the payment instructions issued before are no longer valid. Do not pay using them.',
  },
  void_deal_cancelled: {
    subject: 'Do not send money: this deal has been cancelled',
    line: 'This deal has been cancelled, so the payment instructions you were given are no longer valid. Do not send any more money for it.',
  },
  void_amount_proposed: {
    subject: 'Do not send money: your earlier payment instructions are no longer valid',
    line: 'A new amount has been proposed for your commitment, so the payment instructions issued before are no longer valid. Do not pay using them. Sign in to answer.',
  },
  void_signature_replaced: {
    subject: 'Do not send money: your earlier payment instructions are no longer valid',
    line: 'A new document was sent to you for signing, so the payment instructions issued before are no longer valid. Do not pay using them.',
  },
  void_terms_changed: {
    subject: 'Do not send money: your earlier payment instructions are no longer valid',
    line: 'The terms of this deal have changed and you are asked to reconfirm them, so the payment instructions issued before are no longer valid. Do not pay using them. Sign in to answer.',
  },
  account_changed: {
    subject: 'Do not pay to the old account: the receiving account has changed',
    line: 'The account you were given for this deal has changed. Do not pay to the old details. Sign in to see the new ones, and check them before paying.',
  },
  hold: {
    subject: 'Do not send money for now',
    line: 'The operator has paused this deal. Do not send money for it until you hear again. Payments already made are safe and are recorded as usual.',
  },
  hold_ended: {
    subject: 'The pause has ended',
    line: 'The operator has ended the pause on this deal. Sign in to see where things stand.',
  },
} as const
export type UrgentKind = keyof typeof URGENT

export const SAFETY_LINE = 'We never send bank details by email. You can also open the site yourself instead of using this link.'

/** Everything an investor mail may say. Nothing else can be passed in. */
export interface InvestorFields {
  /** The deal's public code, as the deal page shows it. */
  code?: string
  /** The deadline for this step, YYYY-MM-DD. */
  deadline?: string
  /** The operator's name (the pack's sender text). */
  operator: string
  link: string
}

export interface Rendered {
  subject: string
  text: string
}

const withCode = (s: string, code?: string) => (code ? `${s} (deal ${code})` : s)

function lines(head: string, f: InvestorFields): string {
  return [
    'Hello,',
    '',
    head,
    ...(f.deadline ? [`Deadline for this step: ${f.deadline}`] : []),
    ...(f.code ? [`Deal reference: ${f.code}`] : []),
    `From: ${f.operator}`,
    '',
    `Sign in: ${f.link}`,
    '',
    SAFETY_LINE,
  ].join('\n')
}

/** R-NTF-01: the fixed structure: greeting, action type, deadline, deal code, operator, link, safety line. */
export function transactional(action: InvestorAction, f: InvestorFields): Rendered {
  const label = INVESTOR_ACTIONS[action]
  return { subject: withCode(label, f.code), text: lines(`${label}.`, f) }
}

export function urgent(kind: UrgentKind, f: InvestorFields): Rendered {
  const u = URGENT[kind]
  return { subject: withCode(u.subject, f.code), text: lines(u.line, f) }
}

// ---------- operator edits ----------

/**
 * Investor templates the operator may change. Each is about one deal, so whether the person passes can be decided for that
 * deal. Invitations go to people who have not passed for the deal yet, so an edit would never be sent: not offered.
 */
export const EDITABLE: readonly InvestorAction[] = [
  'commit_reminder',
  'commitment_confirmed',
  'payment_reminder',
  'reconfirm_reminder',
  'money_received',
  'details_checked',
]
/** The only variables a template may use: R-NTF-01's fixed fields. */
export const TEMPLATE_VARS = ['code', 'deadline', 'operator', 'link'] as const
export const SUBJECT_MAX = 150
export const BODY_MAX = 5000

export const templateKey = (action: InvestorAction) => `investor.${action}`

/** What the operator starts from: the fixed wording, with its variables. */
export function defaultTemplate(action: InvestorAction): { subject: string; body: string } {
  const label = INVESTOR_ACTIONS[action]
  return { subject: `${label} (deal {code})`, body: `Hello,\n\n${label}.\nDeal reference: {code}\nFrom: {operator}` }
}

/** Why an edit is refused; empty when it may be saved. */
export function templateProblems(key: string, subject: string, body: string): string[] {
  if (key.startsWith('urgent.')) return ['Urgent notices cannot be changed.']
  const action = key.startsWith('investor.') ? (key.slice('investor.'.length) as InvestorAction) : null
  if (!action || !EDITABLE.includes(action)) return ['This mail cannot be changed.']
  const out: string[] = []
  // a line break in a subject would start a new mail header
  if (subject.trim().length === 0 || subject.length > SUBJECT_MAX || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(subject))
    out.push(`The subject must be one line of 1 to ${SUBJECT_MAX} characters.`)
  if (body.trim().length === 0 || body.length > BODY_MAX) out.push(`The text must be 1 to ${BODY_MAX} characters.`)
  // only the fixed fields: no variable can bring a company name, an amount or a term into the mail
  for (const m of `${subject}\n${body}`.matchAll(/\{([^{}\s]*)\}/g))
    if (!(TEMPLATE_VARS as readonly string[]).includes(m[1]!))
      out.push(`{${m[1]}} is not a field this mail can use. Use ${TEMPLATE_VARS.map((v) => `{${v}}`).join(', ')}.`)
  return [...new Set(out)]
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const varsOf = (f: InvestorFields): Record<(typeof TEMPLATE_VARS)[number], string> => ({
  code: f.code ?? '',
  deadline: f.deadline ?? '',
  operator: f.operator,
  link: f.link,
})
/** Fills the fixed fields; `esc` is applied to the template text and to each value alike. */
const fill = (t: string, f: InvestorFields, esc: (s: string) => string) =>
  t
    .split(/(\{(?:code|deadline|operator|link)\})/)
    .map((part) => {
      const m = /^\{(code|deadline|operator|link)\}$/.exec(part)
      return m ? esc(varsOf(f)[m[1] as keyof ReturnType<typeof varsOf>]) : esc(part)
    })
    .join('')

export interface PromoWarning {
  /** The promotion_warning text for the person's category (§5.5). */
  text: string
  /** The operator's sender line. */
  sender: string
}

/**
 * R-COM-06: promotional mail is HTML only, the warning block before anything else, never a plain-text part. No styles: the
 * warning must not depend on how a mail program themes it.
 */
export function promotionalHtml(subject: string, body: string, f: InvestorFields, w: PromoWarning): Rendered {
  return promoHtml(fill(subject, f, (s) => s), fill(body, f, escapeHtml), f, w)
}

/** R-COM-04: a lead's message, as written: no field is filled in, so braces in it stay as typed. */
export function messageHtml(subject: string, body: string, f: InvestorFields, w: PromoWarning): Rendered {
  return promoHtml(subject, escapeHtml(body), f, w)
}

function promoHtml(filledSubject: string, safeBody: string, f: InvestorFields, w: PromoWarning): Rendered {
  const warning = w.text
    .split(/\n{2,}/)
    .map(
      (para) =>
        `<p>${textParts(para)
          .map((p) => (p.bold ? `<strong>${escapeHtml(p.text)}</strong>` : escapeHtml(p.text)))
          .join('')
          .replace(/\n/g, '<br>')}</p>`,
    )
    .join('')
  const paras = safeBody
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
  const link = escapeHtml(f.link)
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(filledSubject)}</title></head><body>` +
    `<div role="note" id="warning">${warning}<p>Sent by: ${escapeHtml(w.sender)}</p></div><hr>` +
    `${paras}<p>Sign in: <a href="${link}">${link}</a></p><p>${escapeHtml(SAFETY_LINE)}</p></body></html>`
  return { subject: filledSubject, text: html }
}

/** Decided again before every attempt (R-NTF-02, R-COM-04): the edited mail only to someone who passes today, else the fixed one. */
export function pickContent(p: { approved: boolean; recipientPasses: boolean; warningCurrent: boolean }): 'promo' | 'fixed' {
  return p.approved && p.recipientPasses && p.warningCurrent ? 'promo' : 'fixed'
}

// ---------- reminders (R-NTF-01) ----------

const DAY = 86_400_000
/** Commitment reminders: the k-th comes k × 3 days after the invitation was (last) sent. The count is the operator's (R-CMP-03). */
export const COMMIT_REMINDER_EVERY_DAYS = 3

export function commitReminderDue(sentAt: Date, remindedSince: number, count: number, now: Date): boolean {
  if (remindedSince >= count) return false
  return now.getTime() >= sentAt.getTime() + (remindedSince + 1) * COMMIT_REMINDER_EVERY_DAYS * DAY
}

/**
 * Payment and reconfirmation reminders: every `everyDays` days from the start until the deadline has passed. No deadline,
 * no reminders: a payment deadline exists only to remind (R-DRF-04). 0 days turns them off.
 */
export function periodicReminderDue(from: Date, last: Date | null, everyDays: number, until: Date | null, now: Date): boolean {
  if (everyDays <= 0 || !until || now > until) return false
  return now.getTime() >= (last ?? from).getTime() + everyDays * DAY
}

/** A payment deadline (YYYY-MM-DD) ends at the end of that day, UTC (as §5.3's working days). */
export const endOfDay = (date: string) => new Date(`${date}T23:59:59.999Z`)
