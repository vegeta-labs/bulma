// R23, R-NTF-02: the durable mail queue. `enqueue` runs inside the business transaction, so a mail exists exactly when the
// change it reports does. The worker takes one due row at a time with SKIP LOCKED, holds it while it sends, and decides again
// from current data before every attempt. Delivery is at least once: a crash between sending and the commit sends again.
import { randomUUID } from 'node:crypto'
import type { Mailer } from '../adapters/index.ts'
import type { Mode } from '../lib/instance.ts'
import { activeHold } from '../lib/gate.ts'
import { launchContentApproved } from '../lib/dealState.ts'
import { pickContent } from '../lib/mailContent.ts'
import { decideSend, nextAttemptAt, type Audience, type SendFacts } from '../lib/outbox.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import type { UrgentKind } from '../lib/mailContent.ts'
import { dealById, dealGateFacts, heldMinor, REAL_SINCE } from './d3Core.ts'
import { composeInvestor, composeMessage, composeUrgent, warningSha, type InvestorMail, type LeadMessage, type MessageFor, type PromotionFor, type UrgentMail } from './mail.ts'
import type { Delivery } from '../lib/message.ts'
import type { PromoWarning } from '../lib/mailContent.ts'

type Q = Pick<Tx, 'query'>

export interface QueuedMail {
  audience: Audience
  to: string
  subject: string
  body: string
  /** R-NTF-01: the operator's edited version, sent instead only to someone who passes that day (R-COM-04). */
  promo?: PromoPart
  /** The deal a mail is about when its audience names none (an urgent or account notice); kept whatever wording is sent. */
  dealId?: string
}

export interface PromoPart {
  /** An edited template; none for a lead's message, whose approval is the message's own. */
  template?: string
  version?: number
  dealId: string
  subject: string
  html: string
  /** The warning text in the HTML: another category or new wording by the time it is sent means the fixed mail. */
  warningSha: string
}

/** What is sealed: both versions, so the choice can be made at each attempt. */
interface Sealed {
  text: string
  promo?: { subject: string; html: string; warningSha: string }
}


export const modeOf = async (c: Q) => (await c.query<{ mode: Mode }>('SELECT mode FROM instance_profile WHERE id = 1')).rows[0]!.mode

/** Writes the mail in the caller's transaction; it goes out only if that transaction commits. */
export async function enqueue(c: Q, k: Keyring, now: Date, m: QueuedMail): Promise<string> {
  const id = randomUUID()
  const a = m.audience
  const p = m.promo
  if (p && !('userId' in a)) throw new Error('a promotional mail needs a person to decide on')
  const content: Sealed = { text: m.body, ...(p ? { promo: { subject: p.subject, html: p.html, warningSha: p.warningSha } } : {}) }
  const sealed = k.encrypt(Buffer.from(JSON.stringify(content), 'utf8'))
  await c.query(
    `INSERT INTO notification_outbox (id, mode, audience, user_id, deal_id, invite_id, about_kind, about_id, promo_template, promo_version, to_address, subject, key_id, wrapped_key, body_sealed, next_attempt_at, message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17)`,
    [
      id,
      await modeOf(c),
      a.kind,
      'userId' in a ? a.userId : null,
      'dealId' in a ? a.dealId : (m.dealId ?? p?.dealId ?? null),
      a.kind === 'invite' ? a.inviteId : null,
      a.kind === 'reminder' ? a.about : null,
      a.kind === 'reminder' ? a.aboutId : null,
      p?.template ?? null,
      p?.version ?? null,
      m.to,
      m.subject,
      sealed.keyId,
      sealed.wrappedDek,
      sealed.ciphertext,
      now.toISOString(),
      a.kind === 'message' ? a.messageId : null,
    ],
  )
  return id
}

interface Row {
  id: string
  mode: Mode
  audience: Audience['kind']
  user_id: string | null
  deal_id: string | null
  invite_id: string | null
  about_kind: 'commit' | 'payment' | 'reconfirm' | null
  about_id: string | null
  promo_template: string | null
  promo_version: number | null
  message_id: string | null
  to_address: string | null
  subject: string
  key_id: string
  wrapped_key: Buffer
  body_sealed: Buffer
  attempts: number
}

const audienceOf = (r: Row): Audience => {
  switch (r.audience) {
    case 'address':
      return { kind: 'address' }
    case 'urgent':
    case 'account':
      return { kind: r.audience, userId: r.user_id! }
    case 'lead':
      return { kind: 'lead', userId: r.user_id!, dealId: r.deal_id! }
    case 'invite':
      return { kind: 'invite', inviteId: r.invite_id!, dealId: r.deal_id! }
    case 'reminder':
      return { kind: 'reminder', userId: r.user_id!, dealId: r.deal_id!, about: r.about_kind!, aboutId: r.about_id! }
    case 'message':
      return { kind: 'message', userId: r.user_id!, dealId: r.deal_id!, messageId: r.message_id! }
  }
}

/** Money may still be asked for, and reconfirmed, until the deal is done; a commitment only while it is live (§5.1). */
const STEP_OPEN: Record<'commit' | 'payment' | 'reconfirm', readonly string[]> = {
  commit: ['live'],
  payment: ['live', 'closing_requested', 'closing'],
  reconfirm: ['live', 'closing_requested', 'closing'],
}

/** Whether what a reminder is about is still to do. */
async function stillToDo(c: Q, about: 'commit' | 'payment' | 'reconfirm', id: string): Promise<boolean> {
  if (about === 'commit')
    return !!(
      await c.query(
        "SELECT 1 FROM deal_invitation i WHERE i.id = $1 AND i.state = 'active' AND NOT EXISTS (SELECT 1 FROM participation p WHERE p.invitation_id = i.id AND p.outcome = 'active')",
        [id],
      )
    ).rowCount
  if (about === 'payment') {
    const p = (
      await c.query<{ cash_due_minor: string }>(
        "SELECT p.cash_due_minor FROM participation p WHERE p.id = $1 AND p.outcome = 'active' AND EXISTS (SELECT 1 FROM issued_instruction i WHERE i.participation_id = p.id AND i.voided_at IS NULL)",
        [id],
      )
    ).rows[0]
    return !!p && (await heldMinor(c, id)) < BigInt(p.cash_due_minor)
  }
  return !!(
    await c.query(
      "SELECT 1 FROM reconfirmation r JOIN participation p ON p.id = r.participation_id WHERE r.id = $1 AND r.state = 'pending' AND p.outcome = 'active'",
      [id],
    )
  ).rowCount
}

/** Reads only what the audience is decided on, from the data as it is now. */
async function factsFor(c: Q, a: Audience, o: OutboxDeps): Promise<SendFacts & { delivery?: Delivery; warning?: PromoWarning | null }> {
  const f: SendFacts & { delivery?: Delivery; warning?: PromoWarning | null } = { modeNow: await modeOf(c) }
  if ('userId' in a) {
    const u = (
      await c.query<{ email: string; disabled_at: Date | null; anonymised_at: Date | null }>(
        'SELECT email, disabled_at, anonymised_at FROM user_account WHERE id = $1',
        [a.userId],
      )
    ).rows[0]
    f.user = u ? { email: u.email, disabled: !!u.disabled_at, anonymised: !!u.anonymised_at } : null
  }
  if (a.kind === 'lead') {
    const lead = await c.query(
      "SELECT 1 FROM deal d WHERE d.id = $1 AND (d.lead_user = $2 OR EXISTS (SELECT 1 FROM deal_member m WHERE m.deal_id = d.id AND m.user_id = $2 AND m.role = 'co_lead'))",
      [a.dealId, a.userId],
    )
    f.stillHolds = !!lead.rowCount
  }
  if (a.kind === 'reminder') {
    f.stillHolds = await stillToDo(c, a.about, a.aboutId)
    const deal = await dealById(c, a.dealId)
    const gate = deal ? await dealGateFacts(c, deal) : null
    f.dealLive = !!gate && STEP_OPEN[a.about].includes(gate.state)
    f.held = !!gate && activeHold(gate.holds)
  }
  if (a.kind === 'message') {
    // without the deal routes nobody can be judged, so nothing goes
    const m = o.message ? await o.message(c, a.userId, a.dealId) : { delivery: { kind: 'excluded', reason: 'ended' } as const, warning: null }
    f.delivery = m.delivery
    f.warning = m.warning
    f.held = m.delivery.kind === 'excluded' && m.delivery.reason === 'held'
    f.stillHolds = m.delivery.kind !== 'excluded'
  }
  if (a.kind === 'invite') {
    const t = (await c.query<{ open: boolean }>('SELECT (revoked_at IS NULL AND consumed_at IS NULL) AS open FROM targeted_invite WHERE id = $1', [a.inviteId]))
      .rows[0]
    f.stillHolds = !!t?.open
    const deal = await dealById(c, a.dealId)
    // the same facts as every deal gate: a sandbox deal after the switch counts as held
    const gate = deal ? await dealGateFacts(c, deal) : null
    f.dealLive = gate?.state === 'live'
    f.held = !!gate && activeHold(gate.holds)
  }
  return f
}

const errorCode = (e: unknown) => {
  const code = (e as { code?: unknown })?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'unknown'
}

/** A failed attempt: tried again later, or after the last try ended and put on the operator's list (R28 (8)). */
async function failAttempt(c: Q, k: Keyring, id: string, attempts: number, at: Date, e: unknown) {
  const next = nextAttemptAt(attempts, at)
  if (next) {
    await c.query('UPDATE notification_outbox SET attempts = $2, last_error = $3, next_attempt_at = $4::timestamptz WHERE id = $1', [
      id,
      attempts,
      errorCode(e),
      next.toISOString(),
    ])
    return
  }
  await c.query(
    "UPDATE notification_outbox SET status = 'failed', attempts = $3, last_error = $4, key_id = NULL, wrapped_key = NULL, body_sealed = NULL, finished_at = $2::timestamptz WHERE id = $1",
    [id, at.toISOString(), attempts, errorCode(e)],
  )
  await appendAudit(c as Tx, k, { actor: 'system', action: 'mail.failed', entity: id })
}

export interface OutboxDeps {
  db: Db
  k: Keyring
  now: () => Date
  /** The mailer for the mode the instance is in when the attempt is made. */
  mailer: (mode: Mode) => Promise<Mailer>
  /** Set once the deal routes exist; without it an edited mail always goes in its fixed version. */
  promotion?: PromotionFor
  /** Set once the deal routes exist; without it a lead's message is never sent. */
  message?: MessageFor
  publicUrl?: string
}

/** R-CMP-02: the message as it is now was approved (in a sandbox only when the operator asks for approvals there). */
export async function messageApproved(c: Q, mode: Mode, id: string): Promise<boolean> {
  const m = (await c.query<{ sha256: string | null }>('SELECT sha256 FROM message WHERE id = $1', [id])).rows[0]
  if (!m?.sha256) return false
  const cfg = (await c.query<{ content_approval_in_sandbox: boolean }>('SELECT content_approval_in_sandbox FROM deal_config WHERE id = 1')).rows[0]
  const approvals = (
    await c.query<{ content_sha256: string }>(
      `SELECT content_sha256 FROM promotion_approval WHERE subject_kind = 'message' AND subject_id = $1 AND created_at >= ${REAL_SINCE}`,
      [id],
    )
  ).rows
  return launchContentApproved({ mode, requiredInSandbox: !!cfg?.content_approval_in_sandbox, contentSha256: m.sha256, approvedSha256: approvals.map((x) => x.content_sha256) })
}

/** R-CMP-02: the edited wording was approved as it is (in a sandbox only when the operator asks for approvals there). */
async function templateApproved(c: Q, mode: Mode, key: string, version: number): Promise<boolean> {
  const t = (await c.query<{ sha256: string | null }>('SELECT sha256 FROM email_template WHERE key = $1 AND version = $2', [key, version])).rows[0]
  if (!t?.sha256) return false
  const cfg = (await c.query<{ content_approval_in_sandbox: boolean }>('SELECT content_approval_in_sandbox FROM deal_config WHERE id = 1')).rows[0]
  const approvals = (
    await c.query<{ content_sha256: string }>(
      `SELECT content_sha256 FROM promotion_approval WHERE subject_kind = 'template' AND subject_id = $1 AND created_at >= ${REAL_SINCE}`,
      [`${key}:${version}`],
    )
  ).rows
  return launchContentApproved({ mode, requiredInSandbox: !!cfg?.content_approval_in_sandbox, contentSha256: t.sha256, approvedSha256: approvals.map((x) => x.content_sha256) })
}

/** R-COM-04, decided at every attempt: the edited version only to someone who passes today, under approved wording. */
async function choose(
  o: OutboxDeps,
  c: Q,
  r: Row,
  mode: Mode,
  sealed: Sealed,
  f: { delivery?: Delivery; warning?: PromoWarning | null },
): Promise<{ subject: string; body: string; html: boolean; variant: 'fixed' | 'promo' }> {
  const fixed = { subject: r.subject, body: sealed.text, html: false, variant: 'fixed' as const }
  if (r.audience === 'message') {
    if (!sealed.promo) return fixed
    const pick = pickContent({
      approved: await messageApproved(c, mode, r.message_id!),
      recipientPasses: f.delivery?.kind === 'message',
      warningCurrent: !!f.warning && warningSha(f.warning.text) === sealed.promo.warningSha,
    })
    return pick === 'promo' ? { subject: sealed.promo.subject, body: sealed.promo.html, html: true, variant: 'promo' } : fixed
  }
  if (!sealed.promo || !r.promo_template || !o.promotion) return fixed
  const gate = await o.promotion(c, r.user_id!, r.deal_id!)
  const pick = pickContent({
    approved: await templateApproved(c, mode, r.promo_template, r.promo_version!),
    recipientPasses: gate.passes,
    warningCurrent: !!gate.warning && warningSha(gate.warning.text) === sealed.promo.warningSha,
  })
  return pick === 'promo' ? { subject: sealed.promo.subject, body: sealed.promo.html, html: true, variant: 'promo' } : fixed
}

/**
 * One due mail, decided and attempted. Returns false when nothing is due. The row stays locked until the outcome is stored, so
 * a second worker skips it rather than sending it twice.
 */
export async function attemptOne(o: OutboxDeps): Promise<boolean> {
  let picked: { id: string; attempts: number } | null = null
  try {
    return await tryOne(o, (r) => (picked = r))
  } catch (e) {
    const row = picked as { id: string; attempts: number } | null
    if (!row) throw e
    // a fault with this row rather than with the mail server: it counts as an attempt, so one bad row cannot stop the queue
    await tx(o.db, async (c) => {
      const still = await c.query("SELECT 1 FROM notification_outbox WHERE id = $1 AND status = 'queued' AND attempts = $2 FOR UPDATE", [row.id, row.attempts])
      if (still.rowCount) await failAttempt(c, o.k, row.id, row.attempts + 1, o.now(), e)
    })
    return true
  }
}

async function tryOne(o: OutboxDeps, pick: (r: { id: string; attempts: number }) => void): Promise<boolean> {
  return tx(
    o.db,
    async (c) => {
      const t = o.now()
      const r = (
        await c.query<Row>(
          `SELECT id, mode, audience, user_id, deal_id, invite_id, about_kind, about_id, promo_template, promo_version, message_id, to_address, subject, key_id, wrapped_key, body_sealed, attempts FROM notification_outbox
            WHERE status = 'queued' AND next_attempt_at <= $1::timestamptz ORDER BY next_attempt_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [t.toISOString()],
        )
      ).rows[0]
      if (!r) return false
      pick(r)
      const a = audienceOf(r)
      const f = await factsFor(c, a, o)
      const decision = decideSend(a, r.to_address ?? '', r.mode, f)
      const done = 'key_id = NULL, wrapped_key = NULL, body_sealed = NULL, finished_at = $2::timestamptz'
      if (!decision.send) {
        await c.query(`UPDATE notification_outbox SET status = 'cancelled', cancel_reason = $3, ${done} WHERE id = $1`, [
          r.id,
          t.toISOString(),
          decision.reason,
        ])
        await appendAudit(c, o.k, { actor: 'system', action: 'mail.cancelled', entity: r.id, detail: { reason: decision.reason } })
        return true
      }
      const sealed = JSON.parse(o.k.decrypt(r.key_id, r.wrapped_key, r.body_sealed).toString('utf8')) as Sealed
      const m = await choose(o, c, r, f.modeNow, sealed, f)
      const replyTo = r.message_id ? await authorAddress(c, r.message_id) : null
      const attempts = r.attempts + 1
      try {
        await (await o.mailer(f.modeNow)).send({ to: decision.to, subject: m.subject, body: m.body, ...(m.html ? { html: true } : {}), ...(replyTo ? { replyTo } : {}) })
      } catch (e) {
        await failAttempt(c, o.k, r.id, attempts, t, e)
        return true
      }
      await c.query(`UPDATE notification_outbox SET status = 'sent', attempts = $3, last_error = NULL, sent_variant = $4, ${done} WHERE id = $1`, [
        r.id,
        t.toISOString(),
        attempts,
        m.variant,
      ])
      return true
    },
    1, // never retried as a whole: the mail may already have gone
  )
}

/** R-COM-02: replies to a lead's message go to the lead's current address, while their account is open. */
async function authorAddress(c: Q, messageId: string): Promise<string | null> {
  const u = (
    await c.query<{ email: string }>(
      'SELECT u.email FROM message m JOIN user_account u ON u.id = m.author WHERE m.id = $1 AND u.disabled_at IS NULL AND u.anonymised_at IS NULL',
      [messageId],
    )
  ).rows[0]
  return u?.email ?? null
}

/** Attempts due mail until none is left or `limit` were handled. */
export async function drain(o: OutboxDeps, limit = 200): Promise<number> {
  let n = 0
  while (n < limit && (await attemptOne(o))) n++
  return n
}

/** The background loop: one drain at a time, every `everyMs`. */
export function startWorker(o: OutboxDeps, everyMs: number, onError: (code: string) => void): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    drain(o)
      .catch((e) => onError(errorCode(e)))
      .finally(() => {
        running = false
      })
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

/** What routes get: `queue` inside their transaction, `flush` once it has committed. */
export interface MailQueue {
  queue(c: Q, m: QueuedMail): Promise<string>
  /** R-NTF-01: an investor mail from the fixed fields (and the operator's edited version, if any). */
  investor(c: Q, m: InvestorMail): Promise<string>
  /** R-NTF-01: an urgent notice, fixed words. */
  urgent(c: Q, kind: UrgentKind, m: UrgentMail): Promise<string>
  /** R-COM-04: a lead's message to one person. */
  message(c: Q, m: LeadMessage): Promise<string>
  flush(): Promise<void>
}

/**
 * A sandbox delivers at once to its own outbox, so a page and a test can read it straight away. In the real mode nobody waits:
 * neither the time taken nor a failure can tell one address from another, and the worker picks up whatever this leaves.
 */
export function mailQueue(o: OutboxDeps, onError: (code: string) => void): MailQueue {
  return {
    queue: (c, m) => enqueue(c, o.k, o.now(), m),
    investor: async (c, m) => enqueue(c, o.k, o.now(), await composeInvestor(c, o, m)),
    urgent: async (c, kind, m) => enqueue(c, o.k, o.now(), await composeUrgent(c, o, kind, m)),
    message: async (c, m) => enqueue(c, o.k, o.now(), await composeMessage(c, o, m)),
    async flush() {
      const run = drain(o).catch((e) => onError(errorCode(e)))
      if ((await modeOf(o.db)) === 'sandbox') await run
    },
  }
}
