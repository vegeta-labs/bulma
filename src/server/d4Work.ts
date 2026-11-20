// D4 operator workbench (chunk 9a): the to-do list across every deal (R-OPS-02) and the deal board (R-OPS-03). Items are
// worked out from the facts each time (`lib/workQueue.ts`); only who works on one is stored. Reviewers and admins only; a
// lead never reaches these routes (TC-OPS-01). Items on a deal the reader has a stake in are left out and counted, as every
// review queue already does (R-REV-04, R-KYC-02.1).
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { closingGaps } from '../lib/dealLife.ts'
import { complaintDue } from '../lib/complaint.ts'
import {
  assignRefusal,
  BOARD_FLAG_LABEL,
  boardRow,
  parseWorkKey,
  WORK_KINDS,
  WORK_LABEL,
  workCounts,
  workItems,
  type Assignment,
  type WorkFact,
  type WorkKind,
} from '../lib/workQueue.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { dealById, packOf, REAL_SINCE, type Q } from './d3Core.ts'
import { closingFacts } from './d4Life.ts'
import { hasStake, loadMoney } from './ledger.ts'
import { messageApproved, modeOf } from './outbox.ts'
import { pendingReconfirmation, reconfirmClock } from './reconfirm.ts'
import { Refused } from './requests.ts'

export interface D4WorkDeps {
  db: Db
  k: Keyring
  now?: () => Date
}

const Filter = z.strictObject({
  kind: z.enum(WORK_KINDS).optional(),
  deal: z.uuid().optional(),
  assignee: z.union([z.uuid(), z.literal('none')]).optional(),
})
const AssignBody = z.strictObject({ key: z.string().min(3).max(120), assignee: z.uuid().nullable() })

interface DealInfo {
  id: string
  public_code: string
  name: string | null
  lead_name: string
}

export function registerD4Work(app: FastifyInstance, d: D4WorkDeps) {
  const ops = { config: { gate: 'canRunOperations' as const } }
  const now = () => d.now?.() ?? new Date()

  /** Every open fact, and how many were left out because the reader has a stake in their deal. */
  async function facts(c: Q, who: SessionUser): Promise<{ facts: WorkFact[]; leftOut: number }> {
    const out: WorkFact[] = []
    // per deal: its row, or why it is not listed (gone, or the reader has a stake in it)
    const deals = new Map<string, DealInfo | 'gone' | 'stake'>()
    let leftOut = 0
    const add = async (dealId: string | null, f: Omit<WorkFact, 'dealId' | 'dealCode' | 'dealName'>) => {
      if (dealId === null) return void out.push({ ...f, dealId: null, dealCode: null, dealName: null })
      if (!deals.has(dealId)) {
        const info = (
          await c.query<DealInfo>(
            `SELECT d.id, d.public_code, d.draft->'basics'->>'name' AS name, u.name AS lead_name FROM deal d JOIN user_account u ON u.id = d.lead_user
              WHERE d.id = $1 AND d.deleted_at IS NULL`,
            [dealId],
          )
        ).rows[0]
        deals.set(dealId, !info ? 'gone' : (await hasStake(c, who, dealId)) ? 'stake' : info)
      }
      const info = deals.get(dealId)!
      if (info === 'stake') leftOut += 1
      if (typeof info === 'string') return
      out.push({ ...f, person: f.person ?? info.lead_name, dealId, dealCode: info.public_code, dealName: info.name })
    }
    const rows = async <T>(sql: string, p: unknown[] = []) => (await c.query<T & Record<string, unknown>>(sql, p)).rows
    const base = { amountMinor: null, currency: null, deadline: null, person: null }

    // deals to review and to approve (R-REV-*, R-CMP-02)
    for (const r of await rows<{ id: string; submitted_at: Date; target_close: string | null }>(
      `SELECT id, submitted_at, to_char(target_close, 'YYYY-MM-DD') AS target_close FROM deal WHERE state = 'in_review' AND deleted_at IS NULL`,
    ))
      await add(r.id, { ...base, kind: 'deal_review', subject: r.id, since: r.submitted_at, deadline: r.target_close, note: 'Submitted for review.' })
    for (const r of await rows<{ id: string; approved_at: Date }>("SELECT id, approved_at FROM deal WHERE state = 'approved' AND deleted_at IS NULL"))
      await add(r.id, { ...base, kind: 'content_approval', subject: r.id, since: r.approved_at, note: 'The deal’s content.' })
    for (const r of await rows<{ id: string; deal_id: string; reviewed_at: Date }>(
      `SELECT id, deal_id, reviewed_at FROM change_request WHERE state = 'reviewed' AND created_at >= ${REAL_SINCE}`,
    ))
      await add(r.deal_id, { ...base, kind: 'content_approval', subject: r.id, since: r.reviewed_at, note: 'A reviewed change to the terms.' })
    if ((await modeOf(c)) === 'real' || (await rows<{ on: boolean }>('SELECT content_approval_in_sandbox AS on FROM deal_config WHERE id = 1'))[0]?.on) {
      const mode = await modeOf(c)
      for (const r of await rows<{ id: string; deal_id: string; updated_at: Date }>(
        `SELECT id, deal_id, updated_at FROM message WHERE sent_at IS NULL AND sha256 IS NOT NULL AND created_at >= ${REAL_SINCE}`,
      ))
        if (!(await messageApproved(c, mode, r.id)))
          await add(r.deal_id, { ...base, kind: 'content_approval', subject: r.id, since: r.updated_at, note: 'A lead’s message to investors.' })
    }
    for (const r of await rows<{ id: string; created_at: Date }>(
      `SELECT t.id, t.created_at FROM (SELECT * FROM document_template WHERE kind = 'deal_sheet' AND NOT is_placeholder ORDER BY version DESC LIMIT 1) t
        WHERE NOT EXISTS (SELECT 1 FROM promotion_approval a WHERE a.subject_kind = 'template' AND a.subject_id = t.id::text AND a.content_sha256 = t.sha256 AND a.created_at >= ${REAL_SINCE})`,
    ))
      await add(null, { ...base, kind: 'content_approval', subject: r.id, since: r.created_at, note: 'The deal sheet template.' })
    for (const r of await rows<{ key: string; version: number; created_at: Date }>(
      `SELECT * FROM (SELECT DISTINCT ON (t.key) t.key, t.version, t.sha256, t.created_at FROM email_template t ORDER BY t.key, t.version DESC) t
        WHERE t.sha256 IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM promotion_approval a WHERE a.subject_kind = 'template' AND a.subject_id = t.key || ':' || t.version AND a.content_sha256 = t.sha256 AND a.created_at >= ${REAL_SINCE})`,
    ))
      await add(null, {
        ...base,
        kind: 'content_approval',
        subject: `${r.key.replace('.', '_')}-${r.version}`,
        since: r.created_at,
        note: 'An edited investor mail.',
      })
    for (const r of await rows<{ id: string; deal_id: string; created_at: Date }>(
      'SELECT id, deal_id, created_at FROM invite_link WHERE needs_approval AND terms_approved_at IS NULL AND disabled_at IS NULL',
    ))
      await add(r.deal_id, { ...base, kind: 'content_approval', subject: r.id, since: r.created_at, note: 'A link’s own terms.' })

    // identity checks (R-KYC-01) and identity to confirm for a deal (R-ENT-04)
    for (const r of await rows<{ id: string; created_at: Date; owner_name: string }>(
      `SELECT k.id, k.created_at, u.name AS owner_name FROM kyc_case k JOIN legal_entity e ON e.id = k.entity_id JOIN user_account u ON u.id = e.owner_user
        WHERE (k.status = 'pending_review' OR (k.status = 'approved' AND k.late_provider_result IS NOT NULL AND k.entity_version = e.current_version))
          AND k.created_at >= ${REAL_SINCE}`,
    ))
      await add(null, { ...base, kind: 'kyc', subject: r.id, person: r.owner_name, since: r.created_at, note: 'Waiting for a reviewer.' })
    for (const r of await rows<{ id: string; deal_id: string; updated_at: Date; name: string }>(
      `SELECT p.id, p.deal_id, p.updated_at, u.name FROM participation p JOIN user_account u ON u.id = p.user_id
        WHERE p.identity_review = 'pending' AND p.outcome = 'active' AND p.created_at >= ${REAL_SINCE}`,
    ))
      await add(r.deal_id, { ...base, kind: 'kyc', subject: r.id, person: r.name, since: r.updated_at, note: 'The investing entity to confirm for this deal.' })

    // company details (R-INV-*)
    for (const r of await rows<{ id: string; deal_id: string; since: Date }>(
      `SELECT i.id, i.deal_id, coalesce((SELECT max(a.at)::timestamptz FROM audit a WHERE a.action = 'investee.submitted' AND a.entity_id = i.id::text), i.created_at) AS since
         FROM investee i WHERE i.status = 'submitted'`,
    ))
      await add(r.deal_id, { ...base, kind: 'investee', subject: r.id, since: r.since, note: 'The company sent its details.' })

    // changes to review (R-CHG-*), cancellations (§5.1), withdrawals (R-WDR-*)
    for (const r of await rows<{ id: string; deal_id: string; created_at: Date }>(
      `SELECT id, deal_id, created_at FROM change_request WHERE state = 'submitted' AND NOT self_service AND created_at >= ${REAL_SINCE}`,
    ))
      await add(r.deal_id, { ...base, kind: 'change', subject: r.id, since: r.created_at, note: 'Waiting for a reviewer.' })
    for (const r of await rows<{ id: string; deal_id: string; created_at: Date; asked_as: string }>(
      'SELECT id, deal_id, created_at, asked_as FROM cancel_request WHERE decision IS NULL',
    ))
      await add(r.deal_id, {
        ...base,
        kind: 'cancel_request',
        subject: r.id,
        since: r.created_at,
        note: r.asked_as === 'lead' ? 'Asked by the lead.' : 'Asked by a reviewer.',
      })
    for (const r of await rows<{ id: string; deal_id: string; created_at: Date; name: string }>(
      `SELECT w.id, p.deal_id, w.created_at, u.name FROM withdrawal_request w JOIN participation p ON p.id = w.participation_id JOIN user_account u ON u.id = p.user_id
        WHERE w.decision IS NULL AND p.created_at >= ${REAL_SINCE}`,
    ))
      await add(r.deal_id, { ...base, kind: 'withdrawal', subject: r.id, person: r.name, since: r.created_at, note: 'Waiting for a reviewer.' })

    // payments to check: a third party paid, or the reference was wrong (R-PAY-05)
    for (const r of await rows<{
      id: string
      deal_id: string
      created_at: Date
      name: string
      kind: string
      amount_minor: string | null
      currency: string | null
    }>(
      `SELECT q.id, p.deal_id, q.created_at, u.name, q.kind, r.amount_minor::text AS amount_minor, r.currency
         FROM payment_query q JOIN participation p ON p.id = q.participation_id JOIN user_account u ON u.id = p.user_id LEFT JOIN receipt r ON r.id = q.receipt_id
        WHERE q.status = 'open' AND p.created_at >= ${REAL_SINCE}`,
    ))
      await add(r.deal_id, {
        ...base,
        kind: 'payer_check',
        subject: r.id,
        person: r.name,
        amountMinor: r.amount_minor === null ? null : BigInt(r.amount_minor),
        currency: r.currency,
        since: r.created_at,
        note: r.kind === 'third_party' ? 'Paid by someone else.' : 'The investor says the reference was wrong.',
      })

    // refunds and money held after a refused identity check (R-OPS-05, R-KYC-02.1)
    for (const r of await rows<{ id: string; deal_id: string; name: string; since: Date }>(
      `SELECT p.id, p.deal_id, u.name, coalesce((SELECT max(created_at) FROM refund_todo_event WHERE participation_id = p.id),
                (SELECT created_at FROM refund_todo WHERE participation_id = p.id),
                (SELECT max(created_at) FROM receipt WHERE participation_id = p.id)) AS since
         FROM participation p JOIN user_account u ON u.id = p.user_id
        WHERE p.created_at >= ${REAL_SINCE}
          AND (EXISTS (SELECT 1 FROM receipt r WHERE r.participation_id = p.id) OR EXISTS (SELECT 1 FROM refund_todo t WHERE t.participation_id = p.id))`,
    )) {
      const m = (await loadMoney(c, r.id))!
      const f = m.figures
      const inFlight = (
        await rows<{ state: string; amount_minor: string | null; created_at: Date }>(
          "SELECT state, amount_minor::text AS amount_minor, created_at FROM refund_payment WHERE participation_id = $1 AND state IN ('prepared', 'approved', 'sent') ORDER BY created_at DESC LIMIT 1",
          [r.id],
        )
      )[0]
      const currency = (
        await rows<{ currency: string }>("SELECT coalesce(d.draft->'terms'->>'currency', 'GBP') AS currency FROM deal d WHERE d.id = $1", [r.deal_id])
      )[0]!.currency
      if (f.hold > 0n)
        await add(r.deal_id, {
          ...base,
          kind: 'hold',
          subject: r.id,
          person: r.name,
          amountMinor: f.hold,
          currency,
          since: r.since,
          note: 'Money held after an identity check was refused.',
        })
      const step = inFlight
        ? { amount: inFlight.amount_minor === null ? null : BigInt(inFlight.amount_minor), note: `Refund ${inFlight.state}.`, since: inFlight.created_at }
        : f.needsCheck
          ? { amount: null, note: 'More was paid back than received: check the money.', since: r.since }
          : (f.refundDue ?? 0n) > 0n
            ? { amount: f.refundDue!, note: 'Refund to prepare.', since: r.since }
            : null
      if (step)
        await add(r.deal_id, { ...base, kind: 'refund', subject: r.id, person: r.name, amountMinor: step.amount, currency, since: step.since, note: step.note })
    }

    // compliance holds (R-CMP-01)
    for (const r of await rows<{ id: string; level: string; target_id: string | null; applied_at: Date }>(
      `SELECT id, level, target_id::text AS target_id, applied_at FROM compliance_hold WHERE released_at IS NULL AND applied_at >= ${REAL_SINCE}`,
    )) {
      const note = r.level === 'deal' ? 'A hold on this deal.' : r.level === 'lead' ? 'A hold on a lead’s deals.' : 'A hold on the whole instance.'
      await add(r.level === 'deal' ? r.target_id : null, { ...base, kind: 'hold', subject: r.id, since: r.applied_at, note })
    }

    // §5.3: no answer by the deadline; the operator records what happens next
    for (const r of await rows<{ participation_id: string; deal_id: string; user_id: string; name: string }>(
      `SELECT r.participation_id, r.deal_id, p.user_id, u.name FROM reconfirmation r JOIN participation p ON p.id = r.participation_id JOIN user_account u ON u.id = p.user_id
        WHERE r.state = 'pending' AND p.created_at >= ${REAL_SINCE}`,
    )) {
      const deal = (await dealById(c, r.deal_id))!
      const pack = await packOf(c, deal)
      const rc = await pendingReconfirmation(c, r.participation_id)
      if (!pack || !rc) continue
      const clock = await reconfirmClock(c, rc, r.user_id, pack.regime, now())
      if (clock.state !== 'lapsed') continue
      await add(r.deal_id, {
        ...base,
        kind: 'reconfirm_silent',
        subject: rc.id,
        person: r.name,
        since: clock.deadline,
        deadline: clock.deadline.toISOString(),
        note: 'No answer by the deadline.',
      })
    }

    // closing asked for, and closing (R-CLS-*); what is missing is on the deal board
    for (const r of await rows<{ id: string; state: string; target_close: string | null; since: Date }>(
      `SELECT d.id, d.state, to_char(d.target_close, 'YYYY-MM-DD') AS target_close,
              coalesce((SELECT max(created_at) FROM review_event e WHERE e.deal_id = d.id AND e.to_state = d.state), d.updated_at) AS since
         FROM deal d WHERE d.state IN ('closing_requested', 'closing') AND d.deleted_at IS NULL`,
    ))
      await add(r.id, {
        ...base,
        kind: 'closing',
        subject: r.id,
        since: r.since,
        deadline: r.target_close,
        note: r.state === 'closing' ? 'Closing.' : 'The lead asked to close.',
      })

    // money nobody's yet (R-OPS-04); its owner is who works on it
    for (const r of await rows<{
      id: string
      amount_minor: string
      currency: string
      created_at: Date
      payer_name: string
      return_requested_by: string | null
    }>(
      `SELECT id, amount_minor::text AS amount_minor, currency, created_at, payer_name, return_requested_by FROM unallocated_receipt WHERE outcome = 'open' AND created_at >= ${REAL_SINCE}`,
    ))
      await add(null, {
        ...base,
        kind: 'unallocated',
        subject: r.id,
        person: r.payer_name,
        amountMinor: BigInt(r.amount_minor),
        currency: r.currency,
        since: r.created_at,
        note: r.return_requested_by ? 'A return waits for a second person.' : 'Not yet assigned to anyone.',
      })

    // statement and ledger imports with rows nobody has decided (R-OPS-07, §5.7)
    for (const r of await rows<{ id: string; kind: string; created_at: Date; open: number }>(
      `SELECT g.id, g.kind, g.created_at, (SELECT count(*)::int FROM goten_import_row x WHERE x.import_id = g.id AND x.decision IS NULL) AS open
         FROM goten_import g WHERE g.created_at >= ${REAL_SINCE}
          AND EXISTS (SELECT 1 FROM goten_import_row x WHERE x.import_id = g.id AND x.decision IS NULL)`,
    ))
      await add(null, {
        ...base,
        kind: 'statement_import',
        subject: r.id,
        since: r.created_at,
        note: `${r.kind === 'ledger' ? 'A ledger read-back' : 'A bank statement'}: ${r.open} row${r.open === 1 ? '' : 's'} to decide.`,
      })

    // complaints not yet acknowledged, due on the 30th day after receipt (R-AUD-05, decision R28 (5)); they belong to no deal
    for (const r of await rows<{ id: string; received_at: Date; channel: string; name: string | null }>(
      `SELECT c.id, c.received_at, c.channel, u.name FROM complaint c LEFT JOIN user_account u ON u.id = c.user_id
        WHERE c.acknowledged_at IS NULL AND c.created_at >= ${REAL_SINCE}`,
    ))
      await add(null, {
        ...base,
        kind: 'complaint',
        subject: r.id,
        person: r.name,
        since: r.received_at,
        deadline: complaintDue(r.received_at),
        note: r.channel === 'form' ? 'Sent through the complaint form.' : 'Received by email.',
      })
    return { facts: out, leftOut }
  }

  /** The latest assignment of every key, and each unallocated receipt's owner (R-OPS-04 keeps its own). */
  async function assignments(c: Q): Promise<Assignment[]> {
    const a = (
      await c.query<{ item_key: string; assignee: string | null; name: string | null }>(
        `SELECT DISTINCT ON (w.item_key) w.item_key, w.assignee, u.name FROM work_item_assignment w LEFT JOIN user_account u ON u.id = w.assignee
          ORDER BY w.item_key, w.created_at DESC, w.id`,
      )
    ).rows
    const out: Assignment[] = a.filter((x) => x.assignee !== null).map((x) => ({ key: x.item_key, assignee: x.assignee!, assigneeName: x.name ?? '' }))
    const owners = (
      await c.query<{ id: string; owner: string; name: string }>(
        "SELECT x.id, x.owner, u.name FROM unallocated_receipt x JOIN user_account u ON u.id = x.owner WHERE x.outcome = 'open'",
      )
    ).rows
    for (const o of owners) out.push({ key: `unallocated:${o.id}`, assignee: o.owner, assigneeName: o.name })
    return out
  }

  const readTx = <T>(who: SessionUser, fn: (c: Q) => Promise<T>) =>
    tx(d.db, async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      return fn(c)
    })

  // R-OPS-02: one list across every deal, from the facts; filter by kind, deal, or who is on it
  app.get<{ Querystring: Record<string, string> }>('/api/ops/work', ops, async (req) => {
    const f = Filter.parse(req.query ?? {})
    return readTx(req.user!, async (c) => {
      const got = await facts(c, req.user!)
      const all = workItems(got.facts, await assignments(c), now())
      return {
        kinds: WORK_KINDS.map((k) => ({ kind: k, label: WORK_LABEL[k] })),
        counts: workCounts(all),
        items: workItems(got.facts, await assignments(c), now(), f),
        // R-REV-04: someone with no stake handles these
        left_out: got.leftOut,
        // whom an item can be given to: staff only, by name (the assign route still refuses anyone with a stake in its deal)
        staff: (
          await c.query<{ id: string; name: string }>(
            `SELECT u.id, u.name FROM user_account u WHERE u.disabled_at IS NULL AND u.anonymised_at IS NULL
                AND EXISTS (SELECT 1 FROM role_grant g WHERE g.user_id = u.id AND g.role IN ('reviewer', 'admin')) ORDER BY u.name, u.id LIMIT 500`,
          )
        ).rows,
      }
    })
  })

  // R-OPS-02: put a colleague on an item, or take them off it (null)
  app.post('/api/ops/work/assign', ops, async (req) => {
    const who = req.user!
    const b = AssignBody.parse(req.body)
    const key = parseWorkKey(b.key)
    if (!key) throw new Refused('This item is no longer open.')
    return tx(d.db, async (c) => {
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      // one assignment at a time for a key, so two people cannot both be put on it unseen
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`work:${b.key}`])
      const open = (await facts(c, who)).facts.find((x) => x.kind === key.kind && x.subject === key.subject)
      if (b.assignee !== null) {
        const staff = (
          await c.query<{ id: string; email: string }>(
            `SELECT u.id, u.email FROM user_account u WHERE u.id = $1 AND u.disabled_at IS NULL AND u.anonymised_at IS NULL
                AND EXISTS (SELECT 1 FROM role_grant g WHERE g.user_id = u.id AND g.role IN ('reviewer', 'admin'))`,
            [b.assignee],
          )
        ).rows[0]
        const refusal = assignRefusal({
          itemOpen: !!open,
          assigneeIsStaff: !!staff,
          assigneeHasStake: !!staff && !!open?.dealId && (await hasStake(c, staff, open.dealId)),
        })
        if (refusal) throw new Refused(refusal)
      } else if (!open) throw new Refused('This item is no longer open.')
      if (key.kind === 'unallocated') {
        // R-OPS-04: an unallocated receipt always has an owner
        if (b.assignee === null) throw new Refused('Money not yet assigned always has someone on it.')
        await c.query('UPDATE unallocated_receipt SET owner = $2 WHERE id = $1', [key.subject, b.assignee])
      } else
        await c.query('INSERT INTO work_item_assignment (id, item_key, assignee, assigned_by) VALUES ($1, $2, $3, $4)', [
          randomUUID(),
          b.key,
          b.assignee,
          who.id,
        ])
      await appendAudit(c, d.k, { actor: who.id, action: 'work.assigned', entity: b.key, detail: { assignee: b.assignee } })
      return { ok: true }
    })
  })

  // R-OPS-03: every deal, its stage, target date and days left, money received and due, what closing still lacks, and flags
  app.get('/api/ops/deals', ops, async (req) =>
    readTx(req.user!, async (c) => {
      const today = now().toISOString().slice(0, 10)
      const deals = (
        await c.query<{ id: string; public_code: string; name: string | null; state: string; target_close: string | null; currency: string }>(
          `SELECT id, public_code, draft->'basics'->>'name' AS name, state, to_char(target_close, 'YYYY-MM-DD') AS target_close,
                  coalesce(draft->'terms'->>'currency', 'GBP') AS currency
             FROM deal WHERE deleted_at IS NULL ORDER BY target_close NULLS LAST, created_at, id LIMIT 1000`,
        )
      ).rows
      const out = []
      for (const r of deals) {
        const history = (
          await c.query<{ t: string | null }>(
            "SELECT snapshot->'terms'->>'target_close' AS t FROM deal_version WHERE deal_id = $1 AND kind IN ('approved', 'self_service') ORDER BY n",
            [r.id],
          )
        ).rows.map((x) => x.t)
        let received = 0n
        let due = 0n
        for (const p of (
          await c.query<{ id: string; outcome: string; cash_due_minor: string }>(
            `SELECT id, outcome, cash_due_minor::text AS cash_due_minor FROM participation WHERE deal_id = $1 AND created_at >= ${REAL_SINCE}`,
            [r.id],
          )
        ).rows) {
          received += (await loadMoney(c, p.id))!.figures.received
          if (p.outcome === 'active') due += BigInt(p.cash_due_minor)
        }
        const deal = (await dealById(c, r.id))!
        const gaps = ['live', 'closing_requested', 'closing'].includes(r.state) ? closingGaps(await closingFacts(c, deal, today)) : null
        const b = boardRow({ state: r.state, targetClose: r.target_close, today, targetHistory: history, receivedMinor: received, gaps })
        out.push({
          id: r.id,
          public_code: r.public_code,
          name: r.name,
          state: r.state,
          target_close: r.target_close,
          ...b,
          flag_labels: b.flags.map((f) => BOARD_FLAG_LABEL[f]),
          currency: r.currency,
          received_minor: String(received),
          due_minor: String(due),
          closing_gaps: gaps,
        })
      }
      return { deals: out }
    }),
  )
}

export type { WorkKind }
