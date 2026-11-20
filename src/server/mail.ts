// R-NTF-01, R-NTF-02: investor mail is put together here and nowhere else, from the fixed fields only. An operator's edit of
// an investor template adds a promotional version, which the queue sends instead only to someone who passes that day.
import { createHash } from 'node:crypto'
import { EDITABLE, messageHtml, promotionalHtml, templateKey, transactional, urgent, type InvestorAction, type PromoWarning, type UrgentKind } from '../lib/mailContent.ts'
import type { Delivery } from '../lib/message.ts'
import type { Audience } from '../lib/outbox.ts'
import type { RegimePack } from '../lib/regimePack.ts'
import type { Tx } from '../store/db.ts'
import { activePack, packOf } from './d3Core.ts'
import type { QueuedMail } from './outbox.ts'

type Q = Pick<Tx, 'query'>

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** §5.5: whether a person passes for a deal now, and the warning their category gets. */
export type PromotionFor = (c: Q, userId: string, dealId: string) => Promise<{ passes: boolean; warning: PromoWarning | null }>

/** R-COM-04: what a lead's message is for this person now, and the warning their category gets. */
export type MessageFor = (c: Q, userId: string, dealId: string) => Promise<{ delivery: Delivery; warning: PromoWarning | null }>

export interface ComposeDeps {
  publicUrl?: string
  /** Set once the deal routes exist. */
  promotion?: PromotionFor
}

const senderOf = (p: RegimePack) => p.legal_texts.find((t) => t.text_key === p.sender.name_text_key)?.body ?? ''

async function dealFacts(c: Q, dealId: string | undefined) {
  const deal = dealId
    ? (await c.query<{ public_code: string; pack_id: string | null }>('SELECT public_code, pack_id FROM deal WHERE id = $1', [dealId])).rows[0]
    : undefined
  // the deal's own pack once it has one, so the name matches the deal page; the active one before that
  const pack = (deal && (await packOf(c, deal))) || (await activePack(c)).pack
  return { code: deal?.public_code, operator: senderOf(pack) }
}

export const signInLink = (d: ComposeDeps) => `${d.publicUrl ?? ''}/`

export interface InvestorMail {
  action: InvestorAction
  audience: Audience
  to: string
  dealId?: string
  /** YYYY-MM-DD, the deadline for this step. */
  deadline?: string
  link?: string
}

/** The latest wording the operator saved for a template; null when it is the fixed one. */
export async function editedTemplate(c: Q, action: InvestorAction) {
  const t = (
    await c.query<{ version: number; subject: string | null; body: string | null }>(
      'SELECT version, subject, body FROM email_template WHERE key = $1 ORDER BY version DESC LIMIT 1',
      [templateKey(action)],
    )
  ).rows[0]
  return t?.body && t.subject ? { version: t.version, subject: t.subject, body: t.body } : null
}

export async function composeInvestor(c: Q, d: ComposeDeps, m: InvestorMail): Promise<QueuedMail> {
  const facts = await dealFacts(c, m.dealId)
  const fields = { code: facts.code, deadline: m.deadline, operator: facts.operator, link: m.link ?? signInLink(d) }
  const fixed = transactional(m.action, fields)
  const out: QueuedMail = { audience: m.audience, to: m.to, subject: fixed.subject, body: fixed.text, ...(m.dealId ? { dealId: m.dealId } : {}) }
  const userId = 'userId' in m.audience ? m.audience.userId : null
  if (!m.dealId || !userId || !EDITABLE.includes(m.action) || !d.promotion) return out
  const t = await editedTemplate(c, m.action)
  if (!t) return out
  // the warning for this person's category now; the queue checks it is still theirs when it sends
  const { warning } = await d.promotion(c, userId, m.dealId)
  if (!warning) return out
  const promo = promotionalHtml(t.subject, t.body, fields, warning)
  return {
    ...out,
    promo: { template: templateKey(m.action), version: t.version, dealId: m.dealId, subject: promo.subject, html: promo.text, warningSha: sha(warning.text) },
  }
}

export interface LeadMessage {
  userId: string
  to: string
  dealId: string
  messageId: string
  subject: string
  body: string
  /** The person's warning today; without one only the sign-in notice can go. */
  warning: PromoWarning | null
}

/**
 * R-COM-04: the sign-in notice, which holds nothing of the message or the deal, and the message as HTML with the warning first.
 * The queue chooses between them before each attempt.
 */
export async function composeMessage(c: Q, d: ComposeDeps, m: LeadMessage): Promise<QueuedMail> {
  const facts = await dealFacts(c, m.dealId)
  const fields = { code: facts.code, operator: facts.operator, link: signInLink(d) }
  const notice = transactional('new_message', fields)
  const out: QueuedMail = { audience: { kind: 'message', userId: m.userId, dealId: m.dealId, messageId: m.messageId }, to: m.to, subject: notice.subject, body: notice.text }
  if (!m.warning) return out
  const html = messageHtml(m.subject, m.body, fields, m.warning)
  return { ...out, promo: { dealId: m.dealId, subject: html.subject, html: html.text, warningSha: sha(m.warning.text) } }
}

export interface UrgentMail {
  userId: string
  to: string
  dealId?: string
  /** When the caller has the code but not the deal. */
  code?: string
}

/** R-NTF-01: fixed words, a title that says what to do; never gated, held or approved. */
export async function composeUrgent(c: Q, d: ComposeDeps, kind: UrgentKind, m: UrgentMail): Promise<QueuedMail> {
  // the deal the notice is about, kept on the row so the notice is in that deal's evidence pack only (R-AUD-02)
  const dealId = m.dealId ?? (m.code ? (await c.query<{ id: string }>('SELECT id FROM deal WHERE public_code = $1', [m.code])).rows[0]?.id : undefined)
  const facts = await dealFacts(c, dealId)
  const r = urgent(kind, { code: facts.code ?? m.code, operator: facts.operator, link: signInLink(d) })
  return { audience: { kind: 'urgent', userId: m.userId }, to: m.to, subject: r.subject, body: r.text, ...(dealId ? { dealId } : {}) }
}

export const warningSha = sha
