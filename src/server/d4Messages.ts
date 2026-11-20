// D4 messages (chunk 8d): R-COM-01 bulk by the list's groups, R-COM-02 single from a row, R-COM-03 the archive for the lead and
// the investor, R-COM-04 each person decided for, R-CMP-02 approved content only (single messages too, owner 2026-11-17),
// R-CMP-03 the operator's switch for bulk. The text of a message is promotional: it reaches only someone who passes that day.
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { activeHold, canAdministerDeal, canApproveDealContent } from '../lib/gate.ts'
import {
  ARCHIVE_NOTE,
  audienceOf,
  EXCLUSION_WORDS,
  INTERNAL_APPROVAL_NOTE,
  messageProblems,
  messageRefusal,
  unfinishedNames,
  type AudienceFilter,
  type AudienceRow,
  type ExclusionReason,
} from '../lib/message.ts'
import { STATUSES } from '../lib/participation.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { partiesOf } from './d2.ts'
import { dealById, dealGateFacts, lockInstanceShare, policyNow, REAL_SINCE, type D3Deal, type Q } from './d3Core.ts'
import type { MessageFor } from './mail.ts'
import { messageApproved, modeOf, type MailQueue } from './outbox.ts'
import { Refused } from './requests.ts'

export interface D4MessagesDeps {
  db: Db
  k: Keyring
  mail: MailQueue
  /** Each row of the lead's list with its person (from the panel). */
  audienceRows: (c: Q, deal: D3Deal, viewer: string, lead: boolean) => Promise<AudienceRow[]>
  messageFor: MessageFor
}

const Uuid = z.uuid()
const NOT_FOUND = 'Not found.'
const Sha = z.string().regex(/^[0-9a-f]{64}$/)
const Filter = z.strictObject({
  status: z.enum([...STATUSES, 'with_operator']).optional(),
  waiting: z.enum(['investor', 'reviewer', 'lead', 'none']).optional(),
  committed: z.boolean().optional(),
})
const FilterQuery = z.strictObject({
  status: Filter.shape.status,
  waiting: Filter.shape.waiting,
  committed: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
})
const Text = z.strictObject({ subject: z.string().max(1_000), body: z.string().max(20_000) })
const Create = Text.extend({ to: z.union([z.strictObject({ filter: Filter }), z.strictObject({ invitation_id: Uuid })]) })

interface MessageRow {
  id: string
  deal_id: string
  author: string
  kind: 'bulk' | 'single'
  audience: AudienceFilter | null
  invitation_id: string | null
  subject: string | null
  body: string | null
  sha256: string | null
  created_at: Date
  sent_at: Date | null
}

/** What the approval's hash is over: the subject and the text together, as sent. */
export const messageSha = (subject: string, body: string) =>
  createHash('sha256')
    .update(JSON.stringify([subject, body]), 'utf8')
    .digest('hex')

export function registerD4Messages(app: FastifyInstance, d: D4MessagesDeps) {
  const verified = { config: { gate: 'verified' as const } }
  const approver = { config: { gate: 'canApproveContent' as const } }

  /** The lead, co-leads and the deal's team; only the first two write (R-SYN-06). */
  function dealTx<T>(who: SessionUser, id: string, fn: (c: Tx, deal: D3Deal, lead: boolean) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await lockInstanceShare(c)
      const row = (
        await c.query<{ id: string; lead_user: string; syndicate_id: string | null; draft: never }>(
          'SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [id],
        )
      ).rows[0]
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const parties = row && (await partiesOf(c, row))
      if (!parties || !canAdministerDeal(who, parties)) throw new Refused(NOT_FOUND)
      return fn(c, (await dealById(c, id))!, parties.leadUserIds.includes(who.id))
    })
  }

  /** Why this lead cannot write or send now; the deal's state, a hold and the operator's switch as they are now. */
  async function refusal(c: Q, deal: D3Deal, lead: boolean, bulk: boolean) {
    const gate = await dealGateFacts(c, deal)
    return messageRefusal({ state: gate.state, isLead: lead, held: activeHold(gate.holds), bulk, bulkAllowed: (await policyNow(c)).bulkPromo })
  }

  const messageOf = async (c: Q, deal: string, id: string) =>
    (await c.query<MessageRow>(`SELECT * FROM message WHERE id = $1 AND deal_id = $2 AND created_at >= ${REAL_SINCE} FOR UPDATE`, [id, deal])).rows[0] ?? null

  async function approvalNeeded(c: Q) {
    if ((await modeOf(c)) === 'real') return true
    return !!(await c.query<{ on: boolean }>('SELECT content_approval_in_sandbox AS on FROM deal_config WHERE id = 1')).rows[0]?.on
  }

  /** Single: the person of a row on this deal's list, while they still take part (as the row action says). */
  async function singleRecipient(c: Q, deal: D3Deal, invitationId: string) {
    const r = (
      await c.query<{ user_id: string; name: string; active: boolean }>(
        `SELECT i.user_id, u.name, (i.state = 'active' OR EXISTS (SELECT 1 FROM participation p WHERE p.invitation_id = i.id AND p.outcome = 'active')) AS active
           FROM deal_invitation i JOIN user_account u ON u.id = i.user_id WHERE i.id = $1 AND i.deal_id = $2 AND i.created_at >= ${REAL_SINCE}`,
        [invitationId, deal.id],
      )
    ).rows[0]
    if (!r) throw new Refused(NOT_FOUND)
    if (!r.active) throw new Refused(EXCLUSION_WORDS.ended)
    return { userId: r.user_id, name: r.name }
  }

  function checkText(subject: string, body: string) {
    const problems = messageProblems(subject, body)
    if (problems.length) throw new Refused(problems.join(' '))
  }

  // R-COM-01: how many people a group holds, and the names of those with a step still to do, to copy
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/deals/:id/mail/audience', verified, async (req) => {
    const f = FilterQuery.parse(req.query ?? {})
    return dealTx(req.user!, Uuid.parse(req.params.id), async (c, deal, lead) => {
      const rows = await d.audienceRows(c, deal, req.user!.id, lead)
      return {
        people: audienceOf(rows, f).length,
        unfinished_names: unfinishedNames(rows, f),
        bulk_allowed: (await policyNow(c)).bulkPromo,
      }
    })
  })

  // R-COM-01, R-COM-02: a message is written first, approved if the operator asks (R-CMP-02), then sent
  app.post<{ Params: { id: string } }>('/api/deals/:id/mail', verified, async (req) => {
    const b = Create.parse(req.body)
    return dealTx(req.user!, Uuid.parse(req.params.id), async (c, deal, lead) => {
      const bulk = 'filter' in b.to
      const no = await refusal(c, deal, lead, bulk)
      if (no) throw new Refused(no)
      checkText(b.subject, b.body)
      if (!bulk) await singleRecipient(c, deal, (b.to as { invitation_id: string }).invitation_id)
      const id = randomUUID()
      const sha = messageSha(b.subject, b.body)
      await c.query(
        'INSERT INTO message (id, deal_id, author, kind, audience, invitation_id, subject, body, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          id,
          deal.id,
          req.user!.id,
          bulk ? 'bulk' : 'single',
          bulk ? JSON.stringify((b.to as { filter: AudienceFilter }).filter) : null,
          bulk ? null : (b.to as { invitation_id: string }).invitation_id,
          b.subject,
          b.body,
          sha,
        ],
      )
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'message.written', entity: id, detail: { deal: deal.id, kind: bulk ? 'bulk' : 'single' } })
      return { id, content_sha256: sha, needs_approval: await approvalNeeded(c) }
    })
  })

  // until it is sent; a new text needs its own approval, since the approval is of the text's hash
  app.put<{ Params: { id: string; mid: string } }>('/api/deals/:id/mail/:mid', verified, async (req) => {
    const b = Text.parse(req.body)
    return dealTx(req.user!, Uuid.parse(req.params.id), async (c, deal, lead) => {
      const m = await messageOf(c, deal.id, Uuid.parse(req.params.mid))
      if (!m) throw new Refused(NOT_FOUND)
      const no = await refusal(c, deal, lead, m.kind === 'bulk')
      if (no) throw new Refused(no)
      if (m.sent_at) throw new Refused('This message has already been sent.')
      checkText(b.subject, b.body)
      const sha = messageSha(b.subject, b.body)
      await c.query('UPDATE message SET subject = $2, body = $3, sha256 = $4, updated_at = clock_timestamp() WHERE id = $1', [m.id, b.subject, b.body, sha])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'message.edited', entity: m.id })
      return { id: m.id, content_sha256: sha, approved: await messageApproved(c, await modeOf(c), m.id) }
    })
  })

  // R-COM-04: each person is decided for now (and the queue decides again before each attempt); replies go to the lead
  app.post<{ Params: { id: string; mid: string } }>('/api/deals/:id/mail/:mid/send', verified, async (req) => {
    const b = z.strictObject({ content_sha256: Sha }).parse(req.body)
    const out = await dealTx(req.user!, Uuid.parse(req.params.id), async (c, deal, lead) => {
      const m = await messageOf(c, deal.id, Uuid.parse(req.params.mid))
      if (!m || !m.sha256) throw new Refused(NOT_FOUND)
      const no = await refusal(c, deal, lead, m.kind === 'bulk')
      if (no) throw new Refused(no)
      if (m.sent_at) throw new Refused('This message has already been sent.')
      // what the lead read is what goes, and only as approved
      if (m.sha256 !== b.content_sha256) throw new Refused('This message has changed since you opened it. Open it again.')
      if (!(await messageApproved(c, await modeOf(c), m.id))) throw new Refused('An approver must approve this message before it can be sent.')
      const people =
        m.kind === 'bulk' ? audienceOf(await d.audienceRows(c, deal, req.user!.id, lead), m.audience!) : [await singleRecipient(c, deal, m.invitation_id!)]
      if (!people.length) throw new Refused('Nobody is in this group.')
      let sent = 0
      const excluded: { name: string; why: string }[] = []
      for (const p of people) {
        const { delivery, warning } = await d.messageFor(c, p.userId, deal.id)
        const email = (await c.query<{ email: string }>('SELECT email FROM user_account WHERE id = $1', [p.userId])).rows[0]!.email
        const outbox =
          delivery.kind === 'excluded'
            ? null
            : await d.mail.message(c, { userId: p.userId, to: email, dealId: deal.id, messageId: m.id, subject: m.subject!, body: m.body!, warning })
        await c.query('INSERT INTO message_recipient (message_id, user_id, delivery, exclusion, outbox_id) VALUES ($1, $2, $3, $4, $5)', [
          m.id,
          p.userId,
          delivery.kind,
          delivery.kind === 'excluded' ? delivery.reason : null,
          outbox,
        ])
        if (delivery.kind === 'excluded') excluded.push({ name: p.name, why: EXCLUSION_WORDS[delivery.reason] })
        else sent++
      }
      await c.query('UPDATE message SET sent_at = clock_timestamp() WHERE id = $1', [m.id])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'message.sent', entity: m.id, detail: { deal: deal.id, sent, excluded: excluded.length } })
      return { sent, excluded }
    })
    await d.mail.flush()
    return out
  })

  // R-COM-03: everything sent through the site, for the lead, co-leads and the team; whether each person got it, not how
  app.get<{ Params: { id: string } }>('/api/deals/:id/mail', verified, async (req) =>
    dealTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      const mode = await modeOf(c)
      const ms = (
        await c.query<MessageRow & { author_name: string; to_name: string | null }>(
          `SELECT m.*, a.name AS author_name, (SELECT u.name FROM deal_invitation i JOIN user_account u ON u.id = i.user_id WHERE i.id = m.invitation_id) AS to_name
             FROM message m JOIN user_account a ON a.id = m.author WHERE m.deal_id = $1 AND m.created_at >= ${REAL_SINCE} ORDER BY m.created_at DESC, m.id`,
          [deal.id],
        )
      ).rows
      const out = []
      for (const m of ms) {
        const recipients = (
          await c.query<{ name: string; delivery: string; exclusion: ExclusionReason | null; status: string | null }>(
            `SELECT u.name, r.delivery, r.exclusion, o.status FROM message_recipient r JOIN user_account u ON u.id = r.user_id
               LEFT JOIN notification_outbox o ON o.id = r.outbox_id WHERE r.message_id = $1 ORDER BY u.name, u.id`,
            [m.id],
          )
        ).rows
        out.push({
          id: m.id,
          kind: m.kind,
          filter: m.audience,
          to: m.to_name,
          author: m.author_name,
          subject: m.subject,
          body: m.body,
          content_sha256: m.sha256,
          created_at: m.created_at,
          sent_at: m.sent_at,
          approved: m.sent_at ? null : await messageApproved(c, mode, m.id),
          // a sign-in notice and the message read the same here: the list shows no more than the status does (§5.2)
          recipients: recipients.map((r) =>
            r.exclusion
              ? { name: r.name, sent: false, why: EXCLUSION_WORDS[r.exclusion] }
              : { name: r.name, sent: true, mail: r.status === 'cancelled' || r.status === 'failed' ? 'not_delivered' : r.status },
          ),
        })
      }
      return { note: ARCHIVE_NOTE, needs_approval: await approvalNeeded(c), messages: out }
    }),
  )

  // R-COM-03: the investor's own messages; the text only while they may see this deal's content today (R-COM-04)
  app.get('/api/my/mail', verified, async (req) => {
    const who = req.user!
    return tx(d.db, async (c) => {
      const rows = (
        await c.query<{ id: string; deal_id: string; public_code: string; subject: string | null; body: string | null; sent_at: Date }>(
          `SELECT m.id, m.deal_id, d.public_code, m.subject, m.body, m.sent_at FROM message_recipient r JOIN message m ON m.id = r.message_id JOIN deal d ON d.id = m.deal_id
            WHERE r.user_id = $1 AND r.delivery <> 'excluded' AND m.sent_at IS NOT NULL AND m.created_at >= ${REAL_SINCE} ORDER BY m.sent_at DESC, m.id`,
          [who.id],
        )
      ).rows
      const out = []
      for (const r of rows) {
        const { delivery, warning } = await d.messageFor(c, who.id, r.deal_id)
        const open = delivery.kind === 'message' && r.body !== null
        out.push({
          id: r.id,
          deal_code: r.public_code,
          sent_at: r.sent_at,
          ...(open ? { warning, subject: r.subject, body: r.body } : { hidden: true }),
        })
      }
      return { note: ARCHIVE_NOTE, messages: out }
    })
  })

  // R-CMP-02: the approval queue for messages; an approver with no stake in the deal (R-REV-04)
  app.get('/api/approvals/mail', approver, async () =>
    tx(d.db, async (c) => {
      if (!(await approvalNeeded(c))) return { note: INTERNAL_APPROVAL_NOTE, messages: [] }
      const mode = await modeOf(c)
      const rows = (
        await c.query<MessageRow & { public_code: string }>(
          `SELECT m.*, d.public_code FROM message m JOIN deal d ON d.id = m.deal_id
            WHERE m.sent_at IS NULL AND m.sha256 IS NOT NULL AND m.created_at >= ${REAL_SINCE} ORDER BY m.updated_at, m.id`,
        )
      ).rows
      const waiting = []
      for (const m of rows)
        if (!(await messageApproved(c, mode, m.id)))
          waiting.push({ id: m.id, deal_code: m.public_code, kind: m.kind, filter: m.audience, subject: m.subject, body: m.body, content_sha256: m.sha256 })
      return { note: INTERNAL_APPROVAL_NOTE, messages: waiting }
    }),
  )

  app.post<{ Params: { mid: string } }>('/api/approvals/mail/:mid', approver, async (req) => {
    const who = req.user!
    const b = z
      .strictObject({
        content_sha256: Sha,
        self_declared_name: z.string().trim().min(1).max(200),
        self_declared_frn: z
          .string()
          .regex(/^\d{6,7}$/)
          .nullable()
          .optional(),
      })
      .parse(req.body)
    return tx(d.db, async (c) => {
      await lockInstanceShare(c)
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const ok = await c.query(
        "SELECT 1 FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.user_id = $1 AND g.role = 'approver' AND u.mfa_enabled_at IS NOT NULL",
        [who.id],
      )
      if (!ok.rowCount) throw new Refused('Only an approver can do this.')
      const m = (await c.query<MessageRow>(`SELECT * FROM message WHERE id = $1 AND created_at >= ${REAL_SINCE} FOR UPDATE`, [Uuid.parse(req.params.mid)]))
        .rows[0]
      if (!m || !m.sha256) throw new Refused(NOT_FOUND)
      const deal = (
        await c.query<{ id: string; lead_user: string; syndicate_id: string | null; draft: never }>(
          'SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1',
          [m.deal_id],
        )
      ).rows[0]!
      if (!canApproveDealContent(who, who.email, await partiesOf(c, deal)))
        throw new Refused('You cannot approve the content of a deal you lead, work on, or receive carry from.')
      if (m.sent_at) throw new Refused('This message has already been sent.')
      if (m.sha256 !== b.content_sha256) throw new Refused('This message has changed since you opened it. Open it again.')
      await c.query(
        "INSERT INTO promotion_approval (id, subject_kind, subject_id, approver_user, self_declared_name, self_declared_frn, approved_on, content_sha256) VALUES ($1, 'message', $2, $3, $4, $5, current_date, $6)",
        [randomUUID(), m.id, who.id, b.self_declared_name, b.self_declared_frn ?? null, m.sha256],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'message.approved', entity: m.id })
      return { ok: true, note: INTERNAL_APPROVAL_NOTE }
    })
  })
}
