// D4 complaints (chunk 9b; PRD R-AUD-05, TC-AUD-03, decision R28 (5)). A signed-in person sends one through the form; staff
// enter one that came by email, with the day it arrived. Each is on the operator's to-do list until acknowledged, due on the
// 30th day after receipt (`d4Work.ts`). Acknowledging a form complaint sends the person a fixed email; an emailed one is
// answered by email, and only the date is recorded here. The audit holds ids only, never the text.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  acknowledgementMail,
  COMPLAINT_MAX,
  complaintChannelText,
  complaintDue,
  complaintProblem,
  COMPLAINTS_PER_DAY,
  receivedOnProblem,
} from '../lib/complaint.ts'
import { emailComplaintDue } from '../lib/retention.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { policyNow, REAL_SINCE } from './d3Core.ts'
import type { MailQueue } from './outbox.ts'
import { Refused } from './requests.ts'

export interface D4ComplaintsDeps {
  db: Db
  k: Keyring
  mail: MailQueue
  now?: () => Date
}

const Body = z.string().max(COMPLAINT_MAX)
const NOT_FOUND = 'No such complaint.'

interface Row {
  id: string
  channel: 'form' | 'email'
  user_id: string | null
  name: string | null
  email: string | null
  from_address: string | null
  body: string
  received_at: Date
  acknowledged_at: Date | null
}

const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString())

export function registerD4Complaints(app: FastifyInstance, d: D4ComplaintsDeps) {
  const verified = { config: { gate: 'verified' as const } }
  const ops = { config: { gate: 'canRunOperations' as const } }
  const pub = { config: { gate: 'public' as const } }
  const now = () => d.now?.() ?? new Date()

  const live = <T>(who: SessionUser, fn: (c: Tx) => Promise<T>) =>
    tx(d.db, async (c) => {
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      return fn(c)
    })

  // shown with the form, and to anyone who is not signed in: where else a complaint can go
  app.get('/api/complaints/channel', pub, async () => {
    const email = (await policyNow(d.db)).complaintsEmail
    return { email, text: complaintChannelText(email) }
  })

  app.post('/api/my/complaints', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ body: Body }).parse(req.body)
    const problem = complaintProblem(b.body)
    if (problem) throw new Refused(problem)
    const at = now()
    const id = await live(who, async (c) => {
      // the person's row is held so two sends at once cannot pass the day's limit together
      await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [who.id])
      const today = (
        await c.query<{ n: number }>("SELECT count(*)::int AS n FROM complaint WHERE user_id = $1 AND received_at > $2::timestamptz - interval '1 day'", [
          who.id,
          at,
        ])
      ).rows[0]!.n
      if (today >= COMPLAINTS_PER_DAY) throw new Refused(`You have sent ${COMPLAINTS_PER_DAY} complaints in the last day. Send more tomorrow, or by email.`)
      const id = randomUUID()
      await c.query("INSERT INTO complaint (id, channel, user_id, body, received_at) VALUES ($1, 'form', $2, $3, $4)", [id, who.id, b.body, at])
      await appendAudit(c, d.k, { actor: who.id, action: 'complaint.received', entity: id, detail: { channel: 'form' } })
      return id
    })
    return { id, received_at: at.toISOString(), acknowledge_by: complaintDue(at), text: complaintChannelText((await policyNow(d.db)).complaintsEmail) }
  })

  app.get('/api/my/complaints', verified, async (req) =>
    live(req.user!, async (c) => ({
      complaints: (
        await c.query<Row>('SELECT id, body, received_at, acknowledged_at FROM complaint WHERE user_id = $1 ORDER BY received_at DESC, id', [req.user!.id])
      ).rows.map((r) => ({ id: r.id, body: r.body, received_at: iso(r.received_at), acknowledged_at: iso(r.acknowledged_at) })),
    })),
  )

  // staff enter a complaint that came by email, with the day it arrived: the 30 days run from then
  app.post('/api/ops/complaints', ops, async (req) => {
    const who = req.user!
    const b = z.strictObject({ from_address: z.email().max(320), received_on: z.string().max(10), body: Body }).parse(req.body)
    const at = now()
    const problem = complaintProblem(b.body) ?? receivedOnProblem(b.received_on, at.toISOString().slice(0, 10))
    if (problem) throw new Refused(problem)
    return live(who, async (c) => {
      // a day older than complaints are kept would be erased at the next nightly run: most likely a mistyped year
      const years = (await c.query<{ y: number }>('SELECT relationship_years AS y FROM retention_config')).rows[0]!.y
      if (emailComplaintDue(new Date(`${b.received_on}T00:00:00Z`), years, at)) throw new Refused('That day is older than complaints are kept. Check the year.')
      const id = randomUUID()
      await c.query("INSERT INTO complaint (id, channel, from_address, body, received_at, recorded_by) VALUES ($1, 'email', $2, $3, $4, $5)", [
        id,
        b.from_address,
        b.body,
        `${b.received_on}T00:00:00Z`,
        who.id,
      ])
      await appendAudit(c, d.k, { actor: who.id, action: 'complaint.recorded', entity: id, detail: { channel: 'email' } })
      return { id, acknowledge_by: complaintDue(new Date(`${b.received_on}T00:00:00Z`)) }
    })
  })

  app.get('/api/ops/complaints', ops, async (req) =>
    live(req.user!, async (c) => ({
      complaints: (
        await c.query<Row>(
          `SELECT c.id, c.channel, c.user_id, u.name, u.email, c.from_address, c.body, c.received_at, c.acknowledged_at
             FROM complaint c LEFT JOIN user_account u ON u.id = c.user_id WHERE c.created_at >= ${REAL_SINCE}
            ORDER BY (c.acknowledged_at IS NULL) DESC, c.received_at, c.id LIMIT 1000`,
        )
      ).rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        from: r.channel === 'form' ? { name: r.name, email: r.email } : { name: null, email: r.from_address },
        body: r.body,
        received_at: iso(r.received_at),
        acknowledge_by: complaintDue(r.received_at),
        acknowledged_at: iso(r.acknowledged_at),
      })),
    })),
  )

  // once: a form complaint gets the fixed email; an emailed one has been answered by email, and this records the date
  app.post<{ Params: { id: string } }>('/api/ops/complaints/:id/acknowledge', ops, async (req) => {
    const who = req.user!
    const id = z.uuid().parse(req.params.id)
    const out = await live(who, async (c) => {
      const r = (
        await c.query<Row>(
          `SELECT c.id, c.channel, c.user_id, u.email, c.received_at, c.acknowledged_at FROM complaint c LEFT JOIN user_account u ON u.id = c.user_id
            WHERE c.id = $1 AND c.created_at >= ${REAL_SINCE} FOR UPDATE OF c`,
          [id],
        )
      ).rows[0]
      if (!r) throw new Refused(NOT_FOUND)
      if (r.acknowledged_at) throw new Refused('This complaint has already been acknowledged.')
      // as for any decision about oneself (R-REV-04): someone else on the staff deals with it
      if (r.user_id === who.id) throw new Refused('Someone else must acknowledge your own complaint.')
      const at = now()
      await c.query('UPDATE complaint SET acknowledged_at = $2, acknowledged_by = $3 WHERE id = $1', [id, at, who.id])
      if (r.channel === 'form' && r.user_id && r.email) {
        const m = acknowledgementMail(new Date(r.received_at).toISOString().slice(0, 10))
        await d.mail.queue(c, { audience: { kind: 'account', userId: r.user_id }, to: r.email, subject: m.subject, body: m.body })
      }
      await appendAudit(c, d.k, { actor: who.id, action: 'complaint.acknowledged', entity: id })
      return { acknowledged_at: at.toISOString(), emailed: r.channel === 'form' }
    })
    await d.mail.flush()
    return out
  })
}
