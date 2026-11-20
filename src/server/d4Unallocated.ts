// D4 unallocated money, moves between people, and payment queries (PRD R-OPS-04, R-PAY-07, R-PAY-08, R-PAY-09).
// Unallocated money belongs to nobody and counts in no N until a person allocates it; every outcome is audited.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { daysOpen, partsRefusal, suggestAllocation, type AllocationCandidate } from '../lib/unallocated.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import type { SessionUser } from './auth.ts'
import { heldMinor, REAL_SINCE, type Q } from './d3Core.ts'
import { staffMoneyTx } from './d4Money.ts'
import { apply, dealCurrency, hasStake, loadMoney, recordReceipt, save, tellReviewers, TAKES_MONEY } from './ledger.ts'
import type { MailQueue } from './outbox.ts'
import { Refused } from './requests.ts'

export interface D4UnallocatedDeps {
  db: Db
  k: Keyring
  mail: MailQueue
}

const Uuid = z.uuid()
const Minor = z.string().regex(/^[1-9]\d{0,11}$/)
const Basis = z.string().trim().min(3).max(2000)
const Name = z.string().trim().min(1).max(200)
const NOT_FOUND = 'Not found.'
const STAKE = 'You cannot change money records for a deal you lead, work on, receive carry from or invest in.'
const MAX_MINOR = 100_000_000_000n

const UnallocatedBody = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amount_minor: Minor,
  received_on: z.iso.date().refine((v) => v >= '2000-01-01'),
  // R-PAY-09: always written; "unknown" when not known
  payer_name: Name,
  payer_account: Name,
  bank_ref: z.string().max(500).default(''),
  note: z.string().trim().max(2000).optional(),
})

const Parts = z
  .array(z.strictObject({ participation_id: Uuid, amount_minor: Minor }))
  .min(1)
  .max(20)

const MoveParts = z
  .array(z.strictObject({ participation_id: Uuid.nullable(), amount_minor: Minor }))
  .min(1)
  .max(20)

interface UnallocatedRow {
  id: string
  currency: string
  amount_minor: string
  received_on: string
  payer_name: string
  payer_account: string
  bank_ref: string
  outcome: string
  owner: string
  return_requested_by: string | null
}

export function registerD4Unallocated(app: FastifyInstance, d: D4UnallocatedDeps) {
  const money = { config: { gate: 'canRecordMoney' as const } }
  const verified = { config: { gate: 'verified' as const } }
  const moneyTx = <T>(who: SessionUser, fn: (c: Tx) => Promise<T>) => staffMoneyTx(d.db, who, fn)

  async function openRow(c: Tx, id: string): Promise<UnallocatedRow> {
    const r = (
      await c.query<UnallocatedRow>(
        `SELECT id, currency, amount_minor, to_char(received_on, 'YYYY-MM-DD') AS received_on, payer_name, payer_account, bank_ref, outcome, owner, return_requested_by
           FROM unallocated_receipt WHERE id = $1 AND created_at >= ${REAL_SINCE} FOR UPDATE`,
        [id],
      )
    ).rows[0]
    if (!r) throw new Refused(NOT_FOUND)
    if (r.outcome !== 'open') throw new Refused('This money has already been dealt with.')
    return r
  }

  /** A person money can go to: a participation in a deal taking money, with no stake for the one acting, in this currency. */
  async function target(c: Tx, who: SessionUser, pid: string, currency: string): Promise<void> {
    const p = (
      await c.query<{ deal_id: string; state: string }>('SELECT p.deal_id, d.state FROM participation p JOIN deal d ON d.id = p.deal_id WHERE p.id = $1', [pid])
    ).rows[0]
    if (!p) throw new Refused(NOT_FOUND)
    if (!TAKES_MONEY.includes(p.state)) throw new Refused('Money is recorded for a deal only from launch on.')
    if (await hasStake(c, who, p.deal_id)) throw new Refused(STAKE)
    // R-OPS-04: a different currency from the deal's cannot be allocated
    if ((await dealCurrency(c, p.deal_id)) !== currency) throw new Refused('The money is in another currency from the deal.')
  }

  /** Participation rows locked in one order, so two moves never wait on each other. */
  async function lockAll(c: Tx, ids: string[]) {
    for (const id of [...new Set(ids)].sort()) await c.query('SELECT 1 FROM participation WHERE id = $1 FOR UPDATE', [id])
  }

  // ---------- the list (R-OPS-04) ----------

  app.get('/api/review/unallocated', money, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<UnallocatedRow & { owner_name: string; created_at: Date; return_basis: string | null }>(
        `SELECT x.id, x.currency, x.amount_minor, to_char(x.received_on, 'YYYY-MM-DD') AS received_on, x.payer_name, x.payer_account, x.bank_ref, x.outcome,
                x.owner, u.name AS owner_name, x.return_requested_by, x.return_basis, x.created_at
           FROM unallocated_receipt x JOIN user_account u ON u.id = x.owner
          WHERE x.outcome = 'open' AND x.created_at >= ${REAL_SINCE} ORDER BY x.created_at, x.id`,
      )
    ).rows
    // R-OPS-04: suggestions across every deal still taking commitments, never one the viewer has a stake in
    const people = (
      await d.db.query<{ id: string; deal_id: string; public_code: string; reference: string; investor: string; cash_due_minor: string; entity_id: string }>(
        `SELECT p.id, p.deal_id, dl.public_code, p.reference, u.name AS investor, p.cash_due_minor, p.entity_id
           FROM participation p JOIN deal dl ON dl.id = p.deal_id JOIN user_account u ON u.id = p.user_id
          WHERE p.outcome = 'active' AND dl.state IN ('live', 'closing_requested', 'closing') AND p.created_at >= ${REAL_SINCE}
          ORDER BY p.join_seq`,
      )
    ).rows
    const candidates: AllocationCandidate[] = []
    const info = new Map<string, { deal_code: string; reference: string; investor: string }>()
    const currencies = new Map<string, string>()
    for (const p of people) {
      if (await hasStake(d.db, who, p.deal_id)) continue
      if (!currencies.has(p.deal_id)) currencies.set(p.deal_id, await dealCurrency(d.db, p.deal_id))
      const names = (
        await d.db.query<{ name: string }>(
          `SELECT coalesce(v.fields->>'full_name', v.fields->>'name', '') AS name FROM legal_entity e
             JOIN legal_entity_version v ON v.entity_id = e.id AND v.version = e.current_version WHERE e.id = $1
           UNION ALL SELECT holder FROM entity_bank_account WHERE entity_id = $1 AND status = 'confirmed'`,
          [p.entity_id],
        )
      ).rows.map((r) => r.name)
      candidates.push({ participation: p.id, currency: currencies.get(p.deal_id)!, owedMinor: BigInt(p.cash_due_minor) - (await heldMinor(d.db, p.id)), names })
      info.set(p.id, { deal_code: p.public_code, reference: p.reference, investor: p.investor })
    }
    const now = new Date().toISOString()
    return {
      // anyone the money may go to, for a payer the suggestions do not find (R-OPS-04)
      people: candidates.map((c) => ({
        participation_id: c.participation,
        currency: c.currency,
        owed_minor: String(c.owedMinor),
        ...info.get(c.participation)!,
      })),
      rows: rows.map((r) => ({
        id: r.id,
        currency: r.currency,
        amount_minor: r.amount_minor,
        received_on: r.received_on,
        payer_name: r.payer_name,
        payer_account: r.payer_account,
        bank_ref: r.bank_ref,
        owner: r.owner,
        owner_name: r.owner_name,
        days_open: daysOpen(r.created_at.toISOString(), now),
        return_requested_by: r.return_requested_by,
        return_basis: r.return_basis,
        suggestions: suggestAllocation({ amountMinor: BigInt(r.amount_minor), currency: r.currency, payerName: r.payer_name }, candidates).map((s) => ({
          participation_id: s.participation,
          ...info.get(s.participation)!,
          by_amount: s.byAmount,
          by_name: s.byName,
        })),
      })),
    }
  })

  // ---------- listing money nobody can be matched to yet (R-OPS-04, R-PAY-09) ----------

  app.post('/api/review/unallocated', money, async (req) => {
    const who = req.user!
    const b = UnallocatedBody.parse(req.body)
    if (BigInt(b.amount_minor) > MAX_MINOR) throw new Refused('The amount is above the largest allowed.')
    return moneyTx(who, async (c) => {
      const id = randomUUID()
      await c.query(
        `INSERT INTO unallocated_receipt (id, currency, amount_minor, received_on, payer_name, payer_account, bank_ref, note, owner, entered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [id, b.currency, b.amount_minor, b.received_on, b.payer_name, b.payer_account, b.bank_ref, b.note ?? null, who.id],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'unallocated.listed', entity: id })
      return { id }
    })
  })

  app.post<{ Params: { id: string } }>('/api/review/unallocated/:id/claim', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    return moneyTx(who, async (c) => {
      await openRow(c, id)
      await c.query('UPDATE unallocated_receipt SET owner = $2 WHERE id = $1', [id, who.id])
      await appendAudit(c, d.k, { actor: who.id, action: 'unallocated.claimed', entity: id })
      return { ok: true }
    })
  })

  // ---------- allocate whole or split (R-OPS-04) ----------

  app.post<{ Params: { id: string } }>('/api/review/unallocated/:id/allocate', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ parts: Parts }).parse(req.body)
    const out = await moneyTx(who, async (c) => {
      const row = await openRow(c, id)
      if (row.return_requested_by) throw new Refused('A return of this money is waiting for approval.')
      const parts = b.parts.map((p) => ({ to: p.participation_id, amount: BigInt(p.amount_minor) }))
      const refusal = partsRefusal(BigInt(row.amount_minor), parts, true)
      if (refusal) throw new Refused(refusal)
      await lockAll(
        c,
        parts.map((p) => p.to),
      )
      const receipts: string[] = []
      for (const p of parts) {
        await target(c, who, p.to, row.currency)
        const r = await recordReceipt(c, d.k, d.mail, who.id, {
          participationId: p.to,
          amount: p.amount,
          currency: row.currency,
          receivedOn: row.received_on,
          payerName: row.payer_name,
          payerAccount: row.payer_account,
          note: row.bank_ref || null,
          source: 'unallocated',
          unallocatedId: id,
        })
        receipts.push(r.id)
      }
      const outcome = parts.length === 1 ? 'allocated' : 'split'
      await c.query('UPDATE unallocated_receipt SET outcome = $2, decided_by = $3, decided_at = clock_timestamp() WHERE id = $1', [id, outcome, who.id])
      await appendAudit(c, d.k, { actor: who.id, action: `unallocated.${outcome}`, entity: id, detail: { receipts } })
      return { ok: true, outcome, receipts }
    })
    await d.mail.flush()
    return out
  })

  // ---------- return, not identified: a second person approves (R-OPS-04) ----------

  app.post<{ Params: { id: string } }>('/api/review/unallocated/:id/return', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ basis: Basis }).parse(req.body)
    return moneyTx(who, async (c) => {
      const row = await openRow(c, id)
      if (row.return_requested_by) throw new Refused('A return of this money is already waiting for approval.')
      await c.query('UPDATE unallocated_receipt SET return_requested_by = $2, return_requested_at = clock_timestamp(), return_basis = $3 WHERE id = $1', [
        id,
        who.id,
        b.basis,
      ])
      await appendAudit(c, d.k, { actor: who.id, action: 'unallocated.return_requested', entity: id, detail: { basis: b.basis } })
      return { ok: true }
    })
  })

  app.post<{ Params: { id: string } }>('/api/review/unallocated/:id/return/approve', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    return moneyTx(who, async (c) => {
      const row = await openRow(c, id)
      if (!row.return_requested_by) throw new Refused('Nobody has asked to return this money.')
      // decision R28: no self-approval of money, the sandbox included
      if (row.return_requested_by === who.id) throw new Refused('Someone other than the person who asked must approve the return.')
      await c.query(
        "UPDATE unallocated_receipt SET outcome = 'returned', returned_approved_by = $2, decided_by = $2, decided_at = clock_timestamp() WHERE id = $1",
        [id, who.id],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'unallocated.returned', entity: id })
      return { ok: true }
    })
  })

  app.post<{ Params: { id: string } }>('/api/review/unallocated/:id/return/decline', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    return moneyTx(who, async (c) => {
      const row = await openRow(c, id)
      if (!row.return_requested_by) throw new Refused('Nobody has asked to return this money.')
      await c.query('UPDATE unallocated_receipt SET return_requested_by = NULL, return_requested_at = NULL, return_basis = NULL WHERE id = $1', [id])
      await appendAudit(c, d.k, { actor: who.id, action: 'unallocated.return_declined', entity: id })
      return { ok: true }
    })
  })

  // ---------- moving allocated money to someone else, or back (R-OPS-04, C-FEE-4) ----------

  app.post<{ Params: { id: string } }>('/api/review/receipts/:id/move', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ parts: MoveParts, reason: Basis }).parse(req.body)
    const out = await moneyTx(who, async (c) => {
      const src = (
        await c.query<{
          participation_id: string
          currency: string
          received_on: string
          payer_name: string
          payer_account: string
          reversed: boolean
          left: string
        }>(
          `SELECT participation_id, currency, to_char(received_on, 'YYYY-MM-DD') AS received_on, payer_name, payer_account,
                  reversed_at IS NOT NULL AS reversed, (amount_minor - moved_out_minor)::text AS left FROM receipt WHERE id = $1`,
          [id],
        )
      ).rows[0]
      if (!src) throw new Refused(NOT_FOUND)
      if (src.reversed) throw new Refused('This receipt is reversed.')
      const parts = b.parts.map((p) => ({ to: p.participation_id, amount: BigInt(p.amount_minor) }))
      const refusal = partsRefusal(
        BigInt(src.left),
        parts.map((p) => ({ to: p.to ?? 'unallocated', amount: p.amount })),
        false,
      )
      if (refusal) throw new Refused(refusal)
      if (parts.some((p) => p.to === src.participation_id)) throw new Refused('The money is already with this person.')
      // R-OPS-04: the check runs under the same lock as refund approval, so money approved, sent or refunded cannot move
      await lockAll(c, [src.participation_id, ...parts.flatMap((p) => (p.to ? [p.to] : []))])
      const before = (await loadMoney(c, src.participation_id, true))!
      if (await hasStake(c, who, before.dealId)) throw new Refused(STAKE)
      let after = before
      for (const p of parts) after = apply(after, { kind: 'move_out', receipt: id, amount: p.amount })
      // the release is cut first, then the moved part leaves: the two always fit inside the receipt
      await save(c, before, after, who.id)
      const total = parts.reduce((s, p) => s + p.amount, 0n)
      await c.query('UPDATE receipt SET moved_out_minor = moved_out_minor + $2 WHERE id = $1', [id, String(total)])
      await c.query('INSERT INTO participation_event (id, participation_id, event, actor, detail) VALUES ($1, $2, $3, $4, $5)', [
        randomUUID(),
        src.participation_id,
        'receipt_moved',
        who.id,
        JSON.stringify({ receipt: id }),
      ])
      const made: Array<{ participation_id: string | null; receipt?: string; unallocated?: string }> = []
      for (const p of parts) {
        if (p.to === null) {
          const u = randomUUID()
          await c.query(
            `INSERT INTO unallocated_receipt (id, currency, amount_minor, received_on, payer_name, payer_account, from_receipt, owner, entered_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
            [u, src.currency, String(p.amount), src.received_on, src.payer_name, src.payer_account, id, who.id],
          )
          made.push({ participation_id: null, unallocated: u })
          continue
        }
        await target(c, who, p.to, src.currency)
        const r = await recordReceipt(c, d.k, d.mail, who.id, {
          participationId: p.to,
          amount: p.amount,
          currency: src.currency,
          receivedOn: src.received_on,
          payerName: src.payer_name,
          payerAccount: src.payer_account,
          note: null,
          source: 'moved',
          movedFrom: id,
        })
        made.push({ participation_id: p.to, receipt: r.id })
      }
      await appendAudit(c, d.k, { actor: who.id, action: 'receipt.moved', entity: id, detail: { reason: b.reason, to: made } })
      return { ok: true, moved: made }
    })
    await d.mail.flush()
    return out
  })

  // ---------- payment queries (R-PAY-07, R-PAY-08) ----------

  app.post<{ Params: { id: string } }>('/api/my/participations/:id/reference-report', verified, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = z.strictObject({ note: z.string().trim().min(1).max(2000) }).parse(req.body)
    const out = await tx(d.db, async (c) => {
      const p = (await c.query('SELECT 1 FROM participation WHERE id = $1 AND user_id = $2 FOR UPDATE', [pid, who.id])).rows[0]
      if (!p) throw new Refused(NOT_FOUND)
      const open = await c.query("SELECT 1 FROM payment_query WHERE participation_id = $1 AND kind = 'wrong_reference' AND status = 'open'", [pid])
      if (open.rowCount) throw new Refused('You have already told us about this payment. We will be in touch.')
      const id = randomUUID()
      await c.query("INSERT INTO payment_query (id, participation_id, kind, note, raised_by) VALUES ($1, $2, 'wrong_reference', $3, $4)", [
        id,
        pid,
        b.note,
        who.id,
      ])
      await appendAudit(c, d.k, { actor: who.id, action: 'payment_query.raised', entity: id, detail: { kind: 'wrong_reference' } })
      await tellReviewers(
        c,
        d.mail,
        'A payment needs checking',
        'An investor has reported a payment sent with a wrong reference. Sign in to see the list of payments to check.',
      )
      return { ok: true }
    })
    await d.mail.flush()
    return out
  })

  app.get('/api/review/transfer-queries', money, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<{ deal_id: string } & Record<string, unknown>>(
        `SELECT q.id, q.kind, q.status, q.note, q.decision_note, q.created_at, q.participation_id, p.deal_id, dl.public_code AS deal_code, p.reference,
                u.name AS investor, r.amount_minor, r.currency, r.payer_name, r.payer_account, to_char(r.received_on, 'YYYY-MM-DD') AS received_on
           FROM payment_query q JOIN participation p ON p.id = q.participation_id JOIN deal dl ON dl.id = p.deal_id JOIN user_account u ON u.id = p.user_id
           LEFT JOIN receipt r ON r.id = q.receipt_id
          WHERE q.created_at >= ${REAL_SINCE} ORDER BY q.status = 'open' DESC, q.created_at`,
      )
    ).rows
    const out = []
    for (const r of rows) if (!(await hasStake(d.db, who, r.deal_id))) out.push(r)
    return { rows: out }
  })

  app.post<{ Params: { id: string } }>('/api/review/transfer-queries/:id/decide', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ decision: z.enum(['approved', 'declined', 'closed']), note: Basis }).parse(req.body)
    return moneyTx(who, async (c) => {
      const q = (
        await c.query<{ kind: string; status: string; deal_id: string }>(
          'SELECT q.kind, q.status, p.deal_id FROM payment_query q JOIN participation p ON p.id = q.participation_id WHERE q.id = $1 FOR UPDATE OF q',
          [id],
        )
      ).rows[0]
      if (!q) throw new Refused(NOT_FOUND)
      if (q.status !== 'open') throw new Refused('This has already been decided.')
      if (await hasStake(c, who, q.deal_id)) throw new Refused(STAKE)
      if (q.kind === 'third_party') {
        // R-PAY-08: a reviewer approves a payment from someone else
        if (b.decision === 'closed') throw new Refused('A payment from someone else is approved or declined.')
        if (!(await isReviewer(c, who.id))) throw new Refused('Only a reviewer decides on a payment from someone else.')
      } else if (b.decision !== 'closed') throw new Refused('A report of a wrong reference is closed once dealt with.')
      await c.query('UPDATE payment_query SET status = $2, decided_by = $3, decided_at = clock_timestamp(), decision_note = $4 WHERE id = $1', [
        id,
        b.decision,
        who.id,
        b.note,
      ])
      await appendAudit(c, d.k, { actor: who.id, action: `payment_query.${b.decision}`, entity: id, detail: { note: b.note } })
      return { ok: true }
    })
  })
}

async function isReviewer(c: Q, userId: string): Promise<boolean> {
  return (await c.query("SELECT 1 FROM role_grant WHERE user_id = $1 AND role = 'reviewer'", [userId])).rowCount! > 0
}
