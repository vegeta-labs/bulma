// One participation's money as rows, run through the C-FEE-4 rules in `src/lib/money.ts` (PRD C-FEE-4, R-KYC-02.1, R-OPS-05).
// Every transaction that changes a receipt or a refund locks the participation, loads its rows, applies one event with
// `applyMoney`, writes its own row, then `save` writes back what the rules cut (release per receipt, occupation per refund).
import { randomUUID } from 'node:crypto'
import { isInterestedParty } from '../lib/gate.ts'
import {
  applyMoney,
  figures,
  holdStepAfter,
  leadMetrics,
  refundReason,
  type Figures,
  type HoldStep,
  type LeadMetrics,
  type Ledger,
  type MoneyEvent,
  type Position,
  type RefundState,
  type Settlement,
} from '../lib/money.ts'
import type { Outcome } from '../lib/participation.ts'
import { REMOVED } from '../lib/retention.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import type { Tx } from '../store/db.ts'
import { partiesOf } from './d2.ts'
import { approvedSnapshot, dealById, linkFee, REAL_SINCE, type FrozenTerms, type Q } from './d3Core.ts'
import { termsOfInvitation } from './reconfirm.ts'
import { Refused } from './requests.ts'
import { endProposal } from './allocation.ts'
import type { MailQueue } from './outbox.ts'

export type TodoHold = 'none' | HoldStep

export interface Money {
  participationId: string
  dealId: string
  userId: string
  dealState: string
  ledger: Ledger
  position: Position
  settlement: Settlement
  figures: Figures
  /** The refund to-do's hold step, or null when there is no to-do yet. */
  hold: TodoHold | null
  endedAt: string | null
}

/** Loads the rows. With `lock`, the participation row is held first, so two money changes on one person never interleave. */
export async function loadMoney(c: Q, participationId: string, lock = false): Promise<Money | null> {
  const p = (
    await c.query<{
      id: string
      deal_id: string
      user_id: string
      outcome: Outcome
      cash_due_minor: string
      cash_consumed_minor: string | null
      ended_at: Date | null
      state: string
    }>(
      `SELECT p.id, p.deal_id, p.user_id, p.outcome, p.cash_due_minor, p.cash_consumed_minor, p.ended_at, d.state
         FROM participation p JOIN deal d ON d.id = p.deal_id WHERE p.id = $1${lock ? ' FOR UPDATE OF p' : ''}`,
      [participationId],
    )
  ).rows[0]
  if (!p) return null
  const receipts = (
    await c.query<{ id: string; amount_minor: string; hold_released_minor: string; reversed: boolean }>(
      'SELECT id, amount_minor - moved_out_minor AS amount_minor, hold_released_minor, reversed_at IS NOT NULL AS reversed FROM receipt WHERE participation_id = $1 ORDER BY created_at, id',
      [participationId],
    )
  ).rows.map((r) => ({ id: r.id, amount: BigInt(r.amount_minor), released: BigInt(r.hold_released_minor), reversed: r.reversed }))
  const refunds = (
    await c.query<{ id: string; state: RefundState | 'prepared'; amount_minor: string | null; actual_minor: string | null; hold_used_minor: string }>(
      "SELECT id, state, amount_minor, actual_minor, hold_used_minor FROM refund_payment WHERE participation_id = $1 AND state <> 'prepared' ORDER BY created_at, id",
      [participationId],
    )
  ).rows.map((r) => ({
    id: r.id,
    state: r.state as RefundState,
    approved: r.amount_minor === null ? null : BigInt(r.amount_minor),
    actual: r.actual_minor === null ? null : BigInt(r.actual_minor),
    occupied: BigInt(r.hold_used_minor),
  }))
  const ledger = { receipts, refunds }
  const position: Position = { outcome: p.outcome, due: BigInt(p.cash_due_minor) }
  // C-FEE-4: from `settled` on, refunds follow the cash the confirmed allocation used
  const settled = p.state === 'settled' || p.state === 'closed'
  const settlement: Settlement = { settled, allocatedCash: settled ? BigInt(p.cash_consumed_minor ?? '0') : 0n }
  const todo = (await c.query<{ hold: TodoHold }>('SELECT hold FROM refund_todo WHERE participation_id = $1', [participationId])).rows[0]
  return {
    participationId,
    dealId: p.deal_id,
    userId: p.user_id,
    dealState: p.state,
    ledger,
    position,
    settlement,
    figures: figures(ledger, position, settlement),
    hold: todo?.hold ?? null,
    endedAt: p.ended_at ? p.ended_at.toISOString() : null,
  }
}

/** Applies one event to the loaded rows; refuses with the rule's reason. Nothing is written yet. */
export function apply(m: Money, e: MoneyEvent): Money {
  const r = applyMoney(m.ledger, e, m.position, m.settlement)
  if (!r.ok) throw new Refused(r.reason)
  return { ...m, ledger: r.ledger, figures: figures(r.ledger, m.position, m.settlement) }
}

/** The one refund to-do of a participation (tech design `refund_todo`); a KYC rejection starts it at "considering". */
export async function ensureTodo(c: Tx, participationId: string, outcome: Outcome, actor: string | null): Promise<void> {
  const made = await c.query('INSERT INTO refund_todo (participation_id, hold) VALUES ($1, $2) ON CONFLICT (participation_id) DO NOTHING RETURNING 1', [
    participationId,
    outcome === 'rejected_kyc' ? 'considering' : 'none',
  ])
  if (made.rowCount && outcome === 'rejected_kyc') await todoEvent(c, participationId, 'hold_step', 'considering', null, actor)
}

/** R-KYC-02.1: a rejection opens the hold whether or not there is money; an existing to-do starts considering. */
export async function openHold(c: Tx, participationId: string, actor: string): Promise<void> {
  await ensureTodo(c, participationId, 'rejected_kyc', actor)
  const moved = await c.query("UPDATE refund_todo SET hold = 'considering' WHERE participation_id = $1 AND hold = 'none' RETURNING 1", [participationId])
  if (moved.rowCount) await todoEvent(c, participationId, 'hold_step', 'considering', null, actor)
}

export async function todoEvent(c: Q, participationId: string, kind: 'reason' | 'hold_step', value: string, basis: string | null, actor: string | null) {
  await c.query('INSERT INTO refund_todo_event (id, participation_id, kind, value, basis, actor) VALUES ($1, $2, $3, $4, $5, $6)', [
    randomUUID(),
    participationId,
    kind,
    value,
    basis,
    actor,
  ])
}

/** One obligation per person: the reason is written again only when it changed (C-FEE-4, TC-FEE-19). */
export async function noteReason(c: Tx, m: Money, actor: string | null): Promise<string> {
  const reason = refundReason(m.position.outcome, m.settlement.settled)
  const last = (
    await c.query<{ value: string }>(
      "SELECT value FROM refund_todo_event WHERE participation_id = $1 AND kind = 'reason' ORDER BY created_at DESC, id DESC LIMIT 1",
      [m.participationId],
    )
  ).rows[0]
  if (last?.value !== reason) await todoEvent(c, m.participationId, 'reason', reason, null, actor)
  return reason
}

/**
 * Writes back what the rules changed on rows that already exist (the caller has written its own new row), and moves the hold
 * back to "considering" when more money is held than before (R-KYC-02.1). Returns the new figures.
 */
export async function save(c: Tx, before: Money, after: Money, actor: string | null): Promise<Figures> {
  for (const r of after.ledger.receipts) {
    const old = before.ledger.receipts.find((x) => x.id === r.id)
    if (old && old.released !== r.released) await c.query('UPDATE receipt SET hold_released_minor = $2 WHERE id = $1', [r.id, String(r.released)])
  }
  for (const r of after.ledger.refunds) {
    const old = before.ledger.refunds.find((x) => x.id === r.id)
    if (!old || old.occupied !== r.occupied) await c.query('UPDATE refund_payment SET hold_used_minor = $2 WHERE id = $1', [r.id, String(r.occupied)])
  }
  if (after.position.outcome === 'rejected_kyc') {
    await ensureTodo(c, after.participationId, 'rejected_kyc', actor)
    const step = (await c.query<{ hold: TodoHold }>('SELECT hold FROM refund_todo WHERE participation_id = $1', [after.participationId])).rows[0]!.hold
    const next = holdStepAfter(step === 'none' ? 'considering' : step, before.figures.hold, after.figures.hold)
    if (next !== step) {
      await c.query('UPDATE refund_todo SET hold = $2 WHERE participation_id = $1', [after.participationId, next])
      await todoEvent(c, after.participationId, 'hold_step', next, null, actor)
    }
  }
  return after.figures
}

/** R-PAY-09, R-OPS-05: nobody records or approves money on a deal they lead, work on, receive carry from or invest in. */
export async function hasStake(c: Q, who: { id: string; email: string }, dealId: string): Promise<boolean> {
  const deal = (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1', [dealId])).rows[0]
  if (deal && isInterestedParty(who, await partiesOf(c, deal))) return true
  // any participation, ended or not: money can still be held, or owed back, after it ends (Codex round 3)
  return (await c.query('SELECT 1 FROM participation WHERE deal_id = $1 AND user_id = $2', [dealId, who.id])).rowCount! > 0
}

/** R-OPS-05, R-KYC-02.1: a fixed notice to every reviewer. No names or amounts: they sign in to see. */
export async function tellReviewers(c: Q, mail: MailQueue, subject: string, body: string): Promise<void> {
  const rows = (
    await c.query<{ id: string; email: string }>(
      "SELECT DISTINCT u.id, u.email FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.role = 'reviewer' AND u.disabled_at IS NULL AND u.anonymised_at IS NULL",
    )
  ).rows
  for (const r of rows) await mail.queue(c, { audience: { kind: 'account', userId: r.id }, to: r.email, subject, body })
}

/** R-PAY-09: money can be recorded for a deal from launch on, at any time after. */
export const TAKES_MONEY = ['live', 'closing_requested', 'closing', 'settled', 'closed', 'cancelled', 'archived']

/** The deal's currency, from its approved terms. */
export async function dealCurrency(c: Q, dealId: string): Promise<string> {
  const deal = (await dealById(c, dealId))!
  return (await approvedSnapshot(c, deal))?.snapshot.terms?.currency ?? 'GBP'
}

/** R-ENT-06: a payer that is not the entity, nor the holder of one of its confirmed accounts, is listed for checking. */
export async function payerMismatch(c: Q, participationId: string, payerName: string): Promise<boolean> {
  const p = (await c.query<{ entity_id: string }>('SELECT entity_id FROM participation WHERE id = $1', [participationId])).rows[0]!
  const names = (
    await c.query<{ holder: string }>("SELECT holder FROM entity_bank_account WHERE entity_id = $1 AND status = 'confirmed'", [p.entity_id])
  ).rows.map((r) => r.holder)
  const ent = (
    await c.query<{ fields: Record<string, string>; type: string }>(
      'SELECT v.fields, e.type FROM legal_entity e JOIN legal_entity_version v ON v.entity_id = e.id AND v.version = e.current_version WHERE e.id = $1',
      [p.entity_id],
    )
  ).rows[0]!
  const own = (ent.type === 'individual' ? ent.fields.full_name : ent.fields.name) ?? ''
  const payer = payerName.trim().toLowerCase()
  return payer === 'unknown' || ![own, ...names].some((n) => n.trim().toLowerCase() === payer)
}

export interface NewReceipt {
  participationId: string
  amount: bigint
  currency: string
  receivedOn: string
  payerName: string
  payerAccount: string
  note: string | null
  source: 'manual' | 'unallocated' | 'moved' | 'statement' | 'ledger'
  unallocatedId?: string
  movedFrom?: string
}

/**
 * R-PAY-09: one receipt row through the C-FEE-4 rules (new money starts unreleased, so on a rejected person it is held), its
 * event, audit and the investor's notice. A known payer who is not the investor is listed as a third-party payment for a
 * reviewer (R-PAY-08). The caller has checked who may record and the deal's state.
 */
export async function recordReceipt(c: Tx, k: Keyring, mail: MailQueue, actor: string, r: NewReceipt): Promise<{ id: string; payerMismatch: boolean }> {
  const id = randomUUID()
  const before = (await loadMoney(c, r.participationId, true))!
  const after = apply(before, { kind: 'receive', id, amount: r.amount })
  const mismatch = await payerMismatch(c, r.participationId, r.payerName)
  await c.query(
    `INSERT INTO receipt (id, participation_id, amount_minor, currency, source, received_on, payer_name, payer_account, payer_mismatch, note, entered_by, unallocated_id, moved_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      r.participationId,
      String(r.amount),
      r.currency,
      r.source,
      r.receivedOn,
      r.payerName,
      r.payerAccount,
      mismatch,
      r.note,
      actor,
      r.unallocatedId ?? null,
      r.movedFrom ?? null,
    ],
  )
  await save(c, before, after, actor)
  await c.query('INSERT INTO participation_event (id, participation_id, event, actor, detail) VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    r.participationId,
    'receipt_recorded',
    actor,
    JSON.stringify({ receipt: id, source: r.source }),
  ])
  await appendAudit(c, k, { actor, action: 'receipt.recorded', entity: id, detail: { source: r.source } })
  // R-ALO-01: money arriving while a new amount is proposed ends the proposal; the amount stays
  await endProposal(c, { k, mail, now: () => new Date() }, r.participationId, 'money_arrived', actor)
  if (mismatch && r.payerName.trim().toLowerCase() !== 'unknown') {
    const q = randomUUID()
    await c.query("INSERT INTO payment_query (id, participation_id, kind, receipt_id, raised_by) VALUES ($1, $2, 'third_party', $3, $4)", [
      q,
      r.participationId,
      id,
      actor,
    ])
    await appendAudit(c, k, { actor, action: 'payment_query.raised', entity: q, detail: { kind: 'third_party' } })
  }
  // R-NTF-01: that money arrived, not how much
  const u = (await c.query<{ id: string; email: string }>('SELECT u.id, u.email FROM participation p JOIN user_account u ON u.id = p.user_id WHERE p.id = $1', [r.participationId])).rows[0]!
  await mail.investor(c, { action: 'money_received', audience: { kind: 'account', userId: u.id }, to: u.email, dealId: before.dealId })
  return { id, payerMismatch: mismatch }
}

/** Reverses one receipt through the C-FEE-4 rules (the release on it goes with it), with its event and audit. Caller locks the deal. */
export async function reverseReceipt(c: Tx, k: Keyring, actor: string, receiptId: string, reason: string): Promise<void> {
  const r = (await c.query<{ participation_id: string; reversed_at: Date | null }>('SELECT participation_id, reversed_at FROM receipt WHERE id = $1', [receiptId])).rows[0]!
  if (r.reversed_at) return
  const before = (await loadMoney(c, r.participation_id, true))!
  const after = apply(before, { kind: 'reverse', receipt: receiptId })
  await c.query('UPDATE receipt SET reversed_at = clock_timestamp(), reversed_by = $2, reverse_reason = $3 WHERE id = $1', [receiptId, actor, reason])
  await save(c, before, after, actor)
  await c.query('INSERT INTO participation_event (id, participation_id, event, actor, detail) VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    r.participation_id,
    'receipt_reversed',
    actor,
    JSON.stringify({ receipt: receiptId }),
  ])
  await appendAudit(c, k, { actor, action: 'receipt.reversed', entity: receiptId })
}

/** R-ADM-02 / R-CLS-00: the deal's figures as the lead sees them, over every participation the panel counts. */
export async function dealLeadMetrics(c: Q, dealId: string): Promise<LeadMetrics> {
  const parts = (
    await c.query<{ id: string; outcome: Outcome; commitment_minor: string; inv: string; terms_snapshot: FrozenTerms | null; invite_link: string }>(
      `SELECT p.id, p.outcome, p.commitment_minor, i.id AS inv, i.terms_snapshot, i.invite_link
         FROM participation p JOIN deal_invitation i ON i.id = p.invitation_id
        WHERE p.deal_id = $1 AND i.created_at >= ${REAL_SINCE} ORDER BY i.created_at, i.id, p.join_seq`,
      [dealId],
    )
  ).rows
  const rows = []
  for (const p of parts) {
    const fee = linkFee(await termsOfInvitation(c, { id: p.inv, terms_snapshot: p.terms_snapshot, invite_link: p.invite_link }))
    rows.push({ outcome: p.outcome, commitment: BigInt(p.commitment_minor), fee, figures: (await loadMoney(c, p.id))!.figures })
  }
  return leadMetrics(rows)
}

/** A statement carries no payer account: the line's receipt says so in these words. */
export const NO_ACCOUNT = 'not on the file'

/**
 * Plan R28 (3): a payer account typed as unknown, a statement line with none, or one the retention job has blanked
 * (MLR reg 40(4) blanks it on time even with money still to give back) is no account to send a refund back to.
 */
export const accountUnknown = (a: string | null | undefined) => !a || ['unknown', NO_ACCOUNT, REMOVED.toLowerCase()].includes(a.trim().toLowerCase())

/** R-OPS-05: the same name and account, however spaced or cased, is the account the money came from. */
export function sameAccount(a: { name: string; account: string }, b: { name: string; account: string }): boolean {
  const name = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ')
  const account = (x: string) => x.toLowerCase().replace(/\s/g, '')
  return name(a.name) === name(b.name) && account(a.account) === account(b.account)
}
