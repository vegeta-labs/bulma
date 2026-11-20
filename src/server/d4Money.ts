// D4 operator money: the refund list, hold steps and release decisions, and refunds from preparing to recording
// (PRD C-FEE-4, R-KYC-02.1, R-OPS-05, R-WDR-04). The software never pays: these are the operator's records of what they do.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { activeHold } from '../lib/gate.ts'
import { holdStepAllowed, isLateMoney, refundExceptions, refundReason, type HoldStep } from '../lib/money.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { dealById, dealGateFacts, REAL_SINCE, type Q } from './d3Core.ts'
import { accountUnknown, apply, dealCurrency, ensureTodo, hasStake, loadMoney, noteReason, sameAccount, save, tellReviewers, todoEvent, type Money } from './ledger.ts'
import type { MailQueue } from './outbox.ts'
import { Refused } from './requests.ts'

export interface D4MoneyDeps {
  db: Db
  k: Keyring
  mail: MailQueue
}

const Uuid = z.uuid()
// at most £1bn, the database's limit on a refund
const Minor = z
  .string()
  .regex(/^[1-9]\d{0,11}$/)
  .refine((v) => BigInt(v) <= 100_000_000_000n)
const Basis = z.string().trim().min(3).max(2000)
const Name = z.string().trim().min(1).max(200)
const NOT_FOUND = 'Not found.'
const ONE_OPEN = 'Someone is already working on a refund for this person.'

const s = (x: bigint | null) => (x === null ? null : String(x))

/** The figures staff see. The lead never gets these (R-KYC-02.1: only "with the operator"). */
function view(m: Money) {
  const f = m.figures
  return {
    on_hand_minor: s(f.onHand),
    effective_minor: s(f.effective),
    hold_minor: s(f.hold),
    released_unused_minor: s(f.usable),
    in_flight_minor: s(f.inFlight),
    refunded_minor: s(f.refunded),
    refund_due_minor: s(f.refundDue),
    needs_check: f.needsCheck,
    hold_step: m.hold,
  }
}

/** R-OPS-05: a reviewer or an admin, checked again inside the transaction. The caller checks the stake per deal. */
export function staffMoneyTx<T>(db: Db, who: SessionUser, fn: (c: Tx) => Promise<T>): Promise<T> {
  return tx(db, async (c) => {
    await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
    if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
    const r = await c.query(
      "SELECT 1 FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.user_id = $1 AND g.role IN ('reviewer', 'admin') AND u.mfa_enabled_at IS NOT NULL AND u.email_verified_at IS NOT NULL",
      [who.id],
    )
    if (!r.rowCount) throw new Refused('Only a reviewer or an admin can do this.')
    return fn(c)
  }).catch((e: { code?: string; constraint?: string }) => {
    // two people taking the same refund at once: the second is refused (R-OPS-05)
    if (e.code === '23505' && e.constraint === 'refund_payment_one_open') throw new Refused(ONE_OPEN)
    throw e
  })
}

export function registerD4Money(app: FastifyInstance, d: D4MoneyDeps) {
  const money = { config: { gate: 'canRecordMoney' as const } }

  const moneyTx = <T>(who: SessionUser, fn: (c: Tx) => Promise<T>) => staffMoneyTx(d.db, who, fn)

  /** Locks and loads one participation's money, refusing anyone with a stake in its deal. */
  async function locked(c: Tx, who: SessionUser, pid: string): Promise<Money> {
    const m = await loadMoney(c, pid, true)
    if (!m) throw new Refused(NOT_FOUND)
    if (await hasStake(c, who, m.dealId)) throw new Refused('You cannot change money records for a deal you lead, work on, receive carry from or invest in.')
    return m
  }

  async function refundRow(c: Q, id: string) {
    const r = (
      await c.query<{
        id: string
        participation_id: string
        state: string
        amount_minor: string | null
        prepared_by: string | null
        due_at_approval: string | null
        held_at_approval: boolean | null
      }>('SELECT id, participation_id, state, amount_minor, prepared_by, due_at_approval, held_at_approval FROM refund_payment WHERE id = $1', [id])
    ).rows[0]
    if (!r) throw new Refused(NOT_FOUND)
    return r
  }

  /** Whether the person's money is under a hold now: a compliance hold on the deal, or a KYC rejection (R-OPS-05 exception). */
  async function heldNow(c: Q, m: Money): Promise<boolean> {
    const deal = (await dealById(c, m.dealId))!
    return m.position.outcome === 'rejected_kyc' || activeHold((await dealGateFacts(c, deal)).holds)
  }

  /** The payer of the latest receipt still counted: the default destination (R-OPS-05). */
  async function sourcePayer(c: Q, pid: string) {
    return (
      await c.query<{ payer_name: string; payer_account: string; currency: string }>(
        'SELECT payer_name, payer_account, currency FROM receipt WHERE participation_id = $1 AND reversed_at IS NULL AND amount_minor > moved_out_minor ORDER BY created_at DESC, id DESC LIMIT 1',
        [pid],
      )
    ).rows[0]
  }

  // ---------- the list (R-OPS-05, R-WDR-04, R-KYC-02.1) ----------

  app.get('/api/review/refunds', money, async (req) => {
    const who = req.user!
    const ids = (
      await d.db.query<{ id: string }>(
        `SELECT p.id FROM participation p
          WHERE p.created_at >= ${REAL_SINCE}
            AND (EXISTS (SELECT 1 FROM receipt r WHERE r.participation_id = p.id) OR EXISTS (SELECT 1 FROM refund_todo t WHERE t.participation_id = p.id))
          ORDER BY p.join_seq`,
      )
    ).rows
    const out = []
    for (const { id } of ids) {
      const m = (await loadMoney(d.db, id))!
      if (await hasStake(d.db, who, m.dealId)) continue
      const payments = (
        await d.db.query(
          `SELECT id, state, reason, currency, amount_minor, actual_minor, dest_name, dest_account, differs_from_source, evidence, prepared_by, approved_by, sent_on, exceptions, created_at
             FROM refund_payment WHERE participation_id = $1 ORDER BY created_at`,
          [id],
        )
      ).rows
      const open = payments.some((p) => ['prepared', 'approved', 'sent'].includes(p.state))
      const f = m.figures
      if (!(f.needsCheck || (f.refundDue ?? 0n) > 0n || f.hold > 0n || open || m.position.outcome === 'rejected_kyc')) continue
      const receipts = (
        await d.db.query<{ created_at: Date; reversed: boolean }>(
          'SELECT created_at, reversed_at IS NOT NULL OR amount_minor = moved_out_minor AS reversed FROM receipt WHERE participation_id = $1',
          [id],
        )
      ).rows
      const info = (
        await d.db.query<{ public_code: string; reference: string; name: string }>(
          'SELECT dl.public_code, p.reference, u.name FROM participation p JOIN deal dl ON dl.id = p.deal_id JOIN user_account u ON u.id = p.user_id WHERE p.id = $1',
          [id],
        )
      ).rows[0]!
      const reasons = (
        await d.db.query<{ value: string }>("SELECT value FROM refund_todo_event WHERE participation_id = $1 AND kind = 'reason' ORDER BY created_at, id", [id])
      ).rows.map((r) => r.value)
      // the screen's release form: each receipt still counted, with the part a release decision already covers
      const counted = (
        await d.db.query<{ id: string; received_on: string; left_minor: string; released_minor: string }>(
          `SELECT id, to_char(received_on, 'YYYY-MM-DD') AS received_on, (amount_minor - moved_out_minor)::text AS left_minor, hold_released_minor::text AS released_minor
             FROM receipt WHERE participation_id = $1 AND reversed_at IS NULL AND amount_minor > moved_out_minor ORDER BY created_at, id`,
          [id],
        )
      ).rows
      out.push({
        participation_id: id,
        deal_id: m.dealId,
        currency: await dealCurrency(d.db, m.dealId),
        receipts: counted,
        deal_code: info.public_code,
        reference: info.reference,
        investor: info.name,
        outcome: m.position.outcome,
        // one obligation: the reason now, and the earlier ones as history
        reason: refundReason(m.position.outcome, m.settlement.settled),
        reason_history: reasons,
        // plan R28 (3): with no known payer account, a refund needs an account typed with evidence
        payer_account_known: !accountUnknown((await sourcePayer(d.db, id))?.payer_account),
        late_money: receipts.some((r) => !r.reversed && isLateMoney(m.endedAt, r.created_at.toISOString())),
        ...view(m),
        refunds: payments,
      })
    }
    return { rows: out }
  })

  // ---------- holds (R-KYC-02.1) ----------

  app.post<{ Params: { id: string } }>('/api/review/participations/:id/hold-step', money, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = z.strictObject({ step: z.enum(['disclosure_consent', 'release_allowed']), basis: Basis }).parse(req.body)
    return moneyTx(who, async (c) => {
      const m = await locked(c, who, pid)
      if (m.position.outcome !== 'rejected_kyc' || !m.hold || m.hold === 'none') throw new Refused('There is no hold on this person’s money.')
      if (!holdStepAllowed(m.hold as HoldStep, b.step)) throw new Refused('That step does not follow from where the hold is now.')
      await c.query('UPDATE refund_todo SET hold = $2 WHERE participation_id = $1', [pid, b.step])
      // MLR reg 31: the decision and its basis are recorded, not only that it was considered
      await todoEvent(c, pid, 'hold_step', b.step, b.basis, who.id)
      await appendAudit(c, d.k, { actor: who.id, action: 'hold.step', entity: pid, detail: { step: b.step } })
      return { ok: true, hold_step: b.step }
    })
  })

  const ReleaseBody = z.strictObject({
    items: z
      .array(z.strictObject({ receipt: Uuid, amount_minor: Minor }))
      .min(1)
      .max(100),
    basis: Basis,
  })

  app.post<{ Params: { id: string } }>('/api/review/participations/:id/release', money, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = ReleaseBody.parse(req.body)
    return moneyTx(who, async (c) => {
      const before = await locked(c, who, pid)
      if (before.hold !== 'release_allowed') throw new Refused('Money is released only once the hold has reached a release decision.')
      // each item is checked against H as it stands after the ones before it, so the total is at most H at the time
      let after = before
      for (const i of b.items) after = apply(after, { kind: 'release', receipt: i.receipt, amount: BigInt(i.amount_minor), basis: b.basis })
      const id = randomUUID()
      await c.query('INSERT INTO hold_release (id, participation_id, basis, items, decided_by) VALUES ($1, $2, $3, $4, $5)', [
        id,
        pid,
        b.basis,
        JSON.stringify(b.items),
        who.id,
      ])
      await save(c, before, after, who.id)
      await appendAudit(c, d.k, { actor: who.id, action: 'hold.released', entity: id })
      return { ok: true, ...view(after) }
    })
  })

  // ---------- refunds (R-OPS-05) ----------

  const PrepareBody = z.strictObject({
    amount_minor: Minor,
    dest_name: Name.optional(),
    dest_account: Name.optional(),
    evidence: Basis.optional(),
  })

  app.post<{ Params: { id: string } }>('/api/review/participations/:id/refunds', money, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = PrepareBody.parse(req.body)
    return moneyTx(who, async (c) => {
      const m = await locked(c, who, pid)
      if (m.figures.needsCheck) throw new Refused('This person’s money needs checking first.')
      if (BigInt(b.amount_minor) > (m.figures.refundDue ?? 0n)) throw new Refused('The refund is more than the amount due back.')
      const src = await sourcePayer(c, pid)
      if (!src) throw new Refused('There is no receipt to refund.')
      // plan R28 (3): with no known payer account there is no default; the account typed counts as a different one
      if (accountUnknown(src.payer_account) && !b.dest_account) throw new Refused('The account the money came from is not known: type the account to send it to.')
      const destName = b.dest_name ?? src.payer_name
      const destAccount = b.dest_account ?? src.payer_account
      const differs = accountUnknown(src.payer_account) || !sameAccount({ name: destName, account: destAccount }, { name: src.payer_name, account: src.payer_account })
      if (differs && !b.evidence) throw new Refused('The account is not the one the money came from: give the evidence for sending it there.')
      await ensureTodo(c, pid, m.position.outcome, who.id)
      const reason = await noteReason(c, m, who.id)
      const id = randomUUID()
      await c.query(
        `INSERT INTO refund_payment (id, participation_id, state, reason, currency, amount_minor, source_name, source_account, dest_name, dest_account, differs_from_source, evidence, prepared_by, prepared_at)
         VALUES ($1, $2, 'prepared', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp())`,
        [id, pid, reason, src.currency, b.amount_minor, src.payer_name, src.payer_account, destName, destAccount, differs, differs ? b.evidence : null, who.id],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'refund.prepared', entity: id, detail: { differs_from_source: differs } })
      return { id, differs_from_source: differs }
    })
  })

  app.post<{ Params: { id: string } }>('/api/review/refunds/:id/approve', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    return moneyTx(who, async (c) => {
      const pre = await refundRow(c, id)
      const before = await locked(c, who, pre.participation_id)
      const r = await refundRow(c, id)
      if (r.state !== 'prepared') throw new Refused('Only a prepared refund can be approved.')
      // R-OPS-05, plan R28: a second person, in the sandbox too
      if (r.prepared_by === who.id) throw new Refused('The person who prepared a refund cannot approve it.')
      const after = apply(before, { kind: 'approve_refund', id, amount: BigInt(r.amount_minor!) })
      await c.query(
        "UPDATE refund_payment SET state = 'approved', approved_by = $2, approved_at = clock_timestamp(), due_at_approval = $3, held_at_approval = $4 WHERE id = $1",
        [id, who.id, String(before.position.due), await heldNow(c, before)],
      )
      await save(c, before, after, who.id)
      await appendAudit(c, d.k, { actor: who.id, action: 'refund.approved', entity: id })
      return { ok: true, ...view(after) }
    })
  })

  app.post<{ Params: { id: string } }>('/api/review/refunds/:id/sent', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    return moneyTx(who, async (c) => {
      const pre = await refundRow(c, id)
      const before = await locked(c, who, pre.participation_id)
      const after = apply(before, { kind: 'send_refund', refund: id })
      await c.query("UPDATE refund_payment SET state = 'sent', sent_by = $2, sent_at = clock_timestamp() WHERE id = $1", [id, who.id])
      await save(c, before, after, who.id)
      await appendAudit(c, d.k, { actor: who.id, action: 'refund.sent', entity: id })
      return { ok: true, ...view(after) }
    })
  })

  app.post<{ Params: { id: string } }>('/api/review/refunds/:id/cancel', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ recall_evidence: Basis.optional() }).parse(req.body ?? {})
    return moneyTx(who, async (c) => {
      const pre = await refundRow(c, id)
      const before = await locked(c, who, pre.participation_id)
      const r = await refundRow(c, id)
      if (r.state !== 'prepared' && r.state !== 'approved' && r.state !== 'sent') throw new Refused('Only a refund in progress can be cancelled.')
      // a prepared refund is not money yet: it is simply dropped
      const after = r.state === 'prepared' ? before : apply(before, { kind: 'cancel_refund', refund: id, recallEvidence: b.recall_evidence })
      await c.query("UPDATE refund_payment SET state = 'cancelled', cancelled_by = $2, cancelled_at = clock_timestamp(), recall_evidence = $3 WHERE id = $1", [
        id,
        who.id,
        r.state === 'sent' ? b.recall_evidence : null,
      ])
      await save(c, before, after, who.id)
      await appendAudit(c, d.k, { actor: who.id, action: 'refund.cancelled', entity: id, detail: { was: r.state } })
      return { ok: true, ...view(after) }
    })
  })

  const RecordBody = z.strictObject({
    refund_id: Uuid.optional(),
    actual_minor: Minor,
    sent_on: z.iso.date().refine((v) => v >= '2000-01-01'),
    dest_name: Name.optional(),
    dest_account: Name.optional(),
    evidence: Basis.optional(),
  })

  /** R-OPS-05: the money has gone, so recording is never refused; anything unusual is kept as an exception and reviewers are told. */
  app.post<{ Params: { id: string } }>('/api/review/participations/:id/refund-records', money, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = RecordBody.parse(req.body)
    const out = await moneyTx(who, async (c) => {
      const before = await locked(c, who, pid)
      const actual = BigInt(b.actual_minor)
      const held = await heldNow(c, before)
      const r = b.refund_id ? await refundRow(c, b.refund_id) : null
      if (r && r.participation_id !== pid) throw new Refused(NOT_FOUND)
      const approved = r && (r.state === 'approved' || r.state === 'sent')
      if (r && !approved && r.state !== 'prepared') throw new Refused('That refund is already finished.')
      const id = r?.id ?? randomUUID()
      // a prepared refund sent before anyone approved it is recorded as a refund with no approval
      const after = apply(before, { kind: 'record_refund', refund: approved ? id : null, id, actual })
      const exceptions: string[] = refundExceptions({
        approved: approved ? BigInt(r!.amount_minor!) : null,
        actual,
        dueAtApproval: approved && r!.due_at_approval !== null ? BigInt(r!.due_at_approval) : null,
        dueNow: before.position.due,
        heldAtApproval: !!r?.held_at_approval,
        heldNow: held,
      })
      if (r) {
        await c.query(
          "UPDATE refund_payment SET state = 'recorded', actual_minor = $2, recorded_by = $3, recorded_at = clock_timestamp(), sent_on = $4, exceptions = $5 WHERE id = $1",
          [id, b.actual_minor, who.id, b.sent_on, exceptions],
        )
      } else {
        const src = await sourcePayer(c, pid)
        const srcName = src?.payer_name ?? 'unknown'
        const srcAccount = src?.payer_account ?? 'unknown'
        const destName = b.dest_name ?? srcName
        const destAccount = b.dest_account ?? srcAccount
        // plan R28 (3): money sent with no known payer account went to an account typed by hand, so it counts as a different one
        const differs = accountUnknown(srcAccount) || accountUnknown(destAccount) || !sameAccount({ name: destName, account: destAccount }, { name: srcName, account: srcAccount })
        // the money has gone: an account other than the payer's with no evidence is kept as it is and checked
        if (differs && !b.evidence) exceptions.push('account_differs')
        await ensureTodo(c, pid, before.position.outcome, who.id)
        const reason = await noteReason(c, before, who.id)
        const currency = src?.currency ?? (await dealCurrency(c, before.dealId))
        await c.query(
          `INSERT INTO refund_payment (id, participation_id, state, reason, currency, actual_minor, source_name, source_account, dest_name, dest_account, differs_from_source, evidence,
                                       recorded_by, recorded_at, sent_on, exceptions)
           VALUES ($1, $2, 'recorded', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp(), $13, $14)`,
          [
            id,
            pid,
            reason,
            currency,
            b.actual_minor,
            srcName,
            srcAccount,
            destName,
            destAccount,
            differs,
            differs ? (b.evidence ?? 'None given when recorded.') : null,
            who.id,
            b.sent_on,
            exceptions,
          ],
        )
      }
      await save(c, before, after, who.id)
      await appendAudit(c, d.k, { actor: who.id, action: 'refund.recorded', entity: id, detail: { exceptions } })
      if (exceptions.length)
        await tellReviewers(
          c,
          d.mail,
          'A refund to check',
          'A refund was recorded that differs from what was approved, or had no approval. Sign in to see it on the refunds list.',
        )
      return { id, exceptions, ...view(after) }
    })
    await d.mail.flush()
    return out
  })
}
