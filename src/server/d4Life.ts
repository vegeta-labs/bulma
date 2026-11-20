// D4 lead lifecycle (chunk 6a): asking for closing and taking it back, removal, withdrawal, cancellation and archiving
// (PRD §5.1, R-CLS-00/01, R-INV-03, R-WDR-01..05, R-PAY-03). The rules are in `lib/dealLife.ts`; this file reads the facts,
// writes the move and its effects in one transaction, and queues the mails in that same transaction.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  actionCell,
  cancelRequestRefusal,
  closingGaps,
  decideLife,
  onCancel,
  removeRefusal,
  withdrawalRefusal,
  type ClosingFacts,
  type LifeEvent,
  type LifeFacts,
  type LifeState,
} from '../lib/dealLife.ts'
import { capacityRefusal, releaseRefusal } from '../lib/allocation.ts'
import { money } from '../lib/dealSheet.ts'
import { exclusionRefusal, onLapse, workingDayDeadline } from '../lib/deadline.ts'
import { textSha256 } from '../lib/regimePack.ts'
import { kycPassed } from '../lib/entity.ts'
import { proposalRefusal } from '../lib/money.ts'
import { activeHold, canAdministerDeal } from '../lib/gate.ts'
import { invitationAfterEnd } from '../lib/participation.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { partiesOf } from './d2.ts'
import {
  approvedSnapshot,
  dealById,
  dealGateFacts,
  lockInstanceShare,
  linkFee,
  logParticipation,
  packOf,
  policyNow,
  REAL_SINCE,
  voidInstruction,
  type D3Deal,
  type FrozenTerms,
  type LinkRow,
  type Q,
} from './d3Core.ts'
import { allocationOf, capacityFor, committedInvest, endProposal, endWaitlist, openProposal, refreshRelationship, tellLeads as tellLeadsOf, tellLeadsOfRoom } from './allocation.ts'
import { staffMoneyTx } from './d4Money.ts'
import { dealLeadMetrics, ensureTodo, hasStake, loadMoney, noteReason, tellReviewers } from './ledger.ts'
import type { MailQueue } from './outbox.ts'
import { pendingReconfirmation, reconfirmClock } from './reconfirm.ts'
import { Refused } from './requests.ts'

export interface D4LifeDeps {
  db: Db
  k: Keyring
  mail: MailQueue
  now?: () => Date
}

const Uuid = z.uuid()
const Note = z.string().trim().min(3).max(2000)
const NOT_FOUND = 'Not found.'
/** §5.3: the pack's words for telling a silent person with money that they are excluded; optional, and without it nobody is. */
export const EXCLUSION_NOTICE = 'reconfirm_exclusion_notice'
const STAKE = 'You cannot act as reviewer on a deal you lead, work on, receive carry from or invest in.'

/** SQL: the person has money that counts, refunded or not (a reversed receipt, or one moved away whole, never arrived). */
export const MONEY_ARRIVED = 'EXISTS (SELECT 1 FROM receipt r WHERE r.participation_id = $1 AND r.reversed_at IS NULL AND r.amount_minor > r.moved_out_minor)'

export interface Part {
  id: string
  deal_id: string
  user_id: string
  invitation_id: string
  email: string
  outcome: string
}

export type EndOutcome = 'removed' | 'withdrawn' | 'excluded_at_close'

/**
 * Ends one active participation as removed, withdrawn or excluded (§5.3): the instruction is voided with the urgent "do not pay"
 * mail, otherwise a plain notice; the invitation ends unless another entity of the person's is still in (§5.2); an open
 * withdrawal asked by someone else lapses, and so does a pending reconfirmation (by the trigger in 005).
 */
export async function endParticipation(
  x: { k: Keyring; mail: MailQueue; now: () => Date },
  c: Tx,
  deal: D3Deal,
  p: Part,
  outcome: EndOutcome,
  actor: string,
  detail: Record<string, unknown>,
) {
  await c.query('UPDATE participation SET outcome = $2, ended_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1', [p.id, outcome])
  const others = await c.query("SELECT 1 FROM participation WHERE invitation_id = $1 AND outcome = 'active'", [p.invitation_id])
  if (invitationAfterEnd(outcome, others.rowCount! > 0) === 'revoke')
    await c.query("UPDATE deal_invitation SET state = 'revoked', ended_at = clock_timestamp() WHERE id = $1 AND state = 'active'", [p.invitation_id])
  await c.query("UPDATE withdrawal_request SET decision = 'lapsed', decided_at = clock_timestamp() WHERE participation_id = $1 AND decision IS NULL", [p.id])
  await endProposal(c, x, p.id, 'part_ended', actor)
  await logParticipation(c, p.id, outcome, actor, detail)
  await appendAudit(c, x.k, { actor, action: `participation.${outcome}`, entity: p.id, detail })
  if (await voidInstruction(c, x.k, p.id, outcome, actor))
    await x.mail.urgent(c, 'void_commitment_ended', { userId: p.user_id, to: p.email, dealId: deal.id })
  else await x.mail.investor(c, { action: 'commitment_ended', audience: { kind: 'account', userId: p.user_id }, to: p.email, dealId: deal.id })
  await refreshRelationship(c, p.user_id, x.now())
  await tellLeadsOfRoom(c, x.mail, deal)
}


/** R-CLS-01 as asked for: committed T of active participations. UBO checks arrive with D5 (decision R22). */
export async function closingFacts(c: Q, deal: D3Deal, day: string): Promise<ClosingFacts> {
  const investee = (
    await c.query<{ ok: boolean }>(
      `SELECT (i.status = 'approved' AND co.verified_at >= ${REAL_SINCE} AND co.verified_until >= $2::date) AS ok
         FROM investee i JOIN investee_company co ON co.id = i.company_id WHERE i.deal_id = $1`,
      [deal.id, day],
    )
  ).rows[0]
  const lead = (
    await c.query<{ current_version: number; rejected_at: Date | null; status: string | null; entity_version: number | null; expires_on: string | null }>(
      `SELECT e.current_version, e.rejected_at, k.status, k.entity_version, to_char(k.expires_on, 'YYYY-MM-DD') AS expires_on
         FROM syndicate s JOIN legal_entity e ON e.id = s.lead_entity
         LEFT JOIN LATERAL (SELECT status, entity_version, expires_on FROM kyc_case WHERE entity_id = e.id AND created_at >= ${REAL_SINCE}
                             ORDER BY created_at DESC LIMIT 1) k ON true
        WHERE s.id = $1`,
      [deal.syndicate_id],
    )
  ).rows[0]
  const leadKyc =
    !!lead &&
    !lead.rejected_at &&
    !!lead.status &&
    kycPassed({ status: lead.status as 'approved', entityVersion: lead.entity_version!, expiresOn: lead.expires_on }, lead.current_version, day)
  const raised = (
    await c.query<{ t: string }>("SELECT coalesce(sum(invest_minor), 0)::text AS t FROM participation WHERE deal_id = $1 AND outcome = 'active'", [deal.id])
  ).rows[0]!.t
  const snap = await approvedSnapshot(c, deal)
  const min = snap?.snapshot.terms?.min_raise_minor
  return {
    investeeVerified: investee?.ok === true,
    // decision R22: the company's controllers are checked from D5, where entering `closing` must check them
    investeeUboKycPassed: true,
    leadKycPassed: leadKyc,
    reconfirmPending: Number(
      (await c.query<{ n: string }>("SELECT count(*)::text AS n FROM reconfirmation WHERE deal_id = $1 AND state = 'pending'", [deal.id])).rows[0]!.n,
    ),
    hold: activeHold((await dealGateFacts(c, deal)).holds),
    minRaiseMinor: min ? BigInt(min) : null,
    raisedMinor: BigInt(raised),
  }
}

export function registerD4Life(app: FastifyInstance, d: D4LifeDeps) {
  const verified = { config: { gate: 'verified' as const } }
  const reviewer = { config: { gate: 'canReviewDeals' as const } }
  const today = () => (d.now?.() ?? new Date()).toISOString().slice(0, 10)

  /** The lead and co-leads act; members of the team only read (R-SYN-06). The deal row is held for the move. */
  function leadTx<T>(who: SessionUser, id: string, fn: (c: Tx, deal: D3Deal) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await lockInstanceShare(c)
      const row = (
        await c.query<{ id: string; lead_user: string; syndicate_id: string | null; draft: never }>(
          'SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [id],
        )
      ).rows[0]
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      if (!row) throw new Refused(NOT_FOUND)
      const parties = await partiesOf(c, row)
      if (!canAdministerDeal(who, parties) || !parties.leadUserIds.includes(who.id)) throw new Refused(NOT_FOUND)
      return fn(c, (await dealById(c, id))!)
    })
  }

  /** A reviewer with no stake in the deal (R-REV-04), the deal row held. */
  function reviewTx<T>(who: SessionUser, dealId: string, fn: (c: Tx, deal: D3Deal) => Promise<T>): Promise<T> {
    return staffMoneyTx(d.db, who, async (c) => {
      const deal = await dealById(c, dealId, true)
      if (!deal) throw new Refused(NOT_FOUND)
      if (await hasStake(c, who, deal.id)) throw new Refused(STAKE)
      return fn(c, deal)
    })
  }

  const lifeState = (deal: D3Deal): LifeState | null =>
    (['live', 'closing_requested', 'closing', 'cancelled', 'archived'] as const).find((s) => s === deal.state) ?? null

  async function moveDeal(c: Tx, deal: D3Deal, to: LifeState, event: LifeEvent, actor: string, reason: string | null) {
    // §5.6: a cancelled deal has ended; people with no account it named are kept from this day
    await c.query(`UPDATE deal SET state = $2${to === 'cancelled' ? ', ended_at = coalesce(ended_at, clock_timestamp())' : ''} WHERE id = $1`, [deal.id, to])
    await c.query('INSERT INTO review_event (id, deal_id, from_state, to_state, actor, event, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      randomUUID(),
      deal.id,
      deal.state,
      to,
      actor,
      event,
      reason,
    ])
    await appendAudit(c, d.k, { actor, action: `deal.${event}`, entity: deal.id, detail: { from: deal.state, to } })
  }

  const alloc = { k: d.k, mail: d.mail, now: () => d.now?.() ?? new Date() }
  const tellLeads = (c: Q, deal: D3Deal, subject: string, body: string) => tellLeadsOf(c, d.mail, deal, subject, body)

  // ---------- closing: what is missing, asking, taking it back (R-CLS-00, R-CLS-01, R-INV-03) ----------

  app.get<{ Params: { id: string } }>('/api/deals/:id/closing', verified, async (req) => {
    return leadTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      const f = await closingFacts(c, deal, today())
      const m = await dealLeadMetrics(c, deal.id)
      return {
        state: deal.state,
        gaps: deal.state === 'live' ? closingGaps(f) : [],
        committed_minor: String(f.raisedMinor),
        min_raise_minor: f.minRaiseMinor === null ? null : String(f.minRaiseMinor),
        // R-CLS-00: allocation, money received, the lead's fee and the estimated investment; the platform fee is worked out at closing
        allocation_minor: String((await allocationOf(c, deal)).allocation),
        received_minor: String(m.received),
        lead_fees_minor: String(m.leadFees),
        estimated_investment_minor: String(m.usableGross),
        platform_fee_note: 'The platform fee is worked out at closing.',
      }
    })
  })

  async function closingMove(c: Tx, deal: D3Deal, who: SessionUser, event: 'request_closing' | 'withdraw_closing', actor: 'lead' | 'reviewer') {
    const from = lifeState(deal)
    if (!from) throw new Refused('That cannot be done to a deal in this state.')
    const facts: LifeFacts = { actor, userId: who.id, reviewerConflicted: false }
    if (event === 'request_closing') facts.closing = await closingFacts(c, deal, today())
    const decision = decideLife(from, event, facts)
    if (!decision.ok) throw new Refused(decision.reason)
    await moveDeal(c, deal, decision.to, event, who.id, null)
    if (decision.effects.includes('pause_links_for_closing'))
      await c.query('UPDATE invite_link SET closing_paused_at = clock_timestamp() WHERE deal_id = $1 AND closing_paused_at IS NULL', [deal.id])
    // only what closing paused comes back; a link the lead turned off stays off (§5.1)
    // R-ALO-01, R-ALO-04: an unanswered proposal ends with the amount unchanged; nobody still waiting is let in any more
    if (decision.effects.includes('end_amount_proposals')) {
      const open = (
        await c.query<{ participation_id: string }>(
          'SELECT a.participation_id FROM amount_proposal a JOIN participation p ON p.id = a.participation_id WHERE p.deal_id = $1 AND a.decision IS NULL ORDER BY a.id',
          [deal.id],
        )
      ).rows
      for (const o of open) await endProposal(c, alloc, o.participation_id, 'closing_requested', who.id)
      await endWaitlist(c, alloc, deal.id, 'closing_requested', who.id)
    }
    if (decision.effects.includes('resume_links_paused_for_closing'))
      await c.query('UPDATE invite_link SET closing_paused_at = NULL WHERE deal_id = $1 AND closing_paused_at IS NOT NULL', [deal.id])
    if (event === 'request_closing')
      await tellReviewers(c, d.mail, 'A deal asks for closing', 'A lead has asked for a deal to close. It is waiting in the review list.')
    return { state: decision.to }
  }

  app.post<{ Params: { id: string } }>('/api/deals/:id/request-closing', verified, async (req) => {
    // R-CLS-00: the lead has seen the confirmation page
    z.strictObject({ confirm: z.literal(true) }).parse(req.body)
    const r = await leadTx(req.user!, Uuid.parse(req.params.id), (c, deal) => closingMove(c, deal, req.user!, 'request_closing', 'lead'))
    await d.mail.flush()
    return r
  })
  app.post<{ Params: { id: string } }>('/api/deals/:id/withdraw-closing', verified, async (req) =>
    leadTx(req.user!, Uuid.parse(req.params.id), (c, deal) => closingMove(c, deal, req.user!, 'withdraw_closing', 'lead')),
  )
  app.post<{ Params: { id: string } }>('/api/review/deals/:id/withdraw-closing', reviewer, async (req) =>
    reviewTx(req.user!, Uuid.parse(req.params.id), (c, deal) => closingMove(c, deal, req.user!, 'withdraw_closing', 'reviewer')),
  )

  // ---------- one person's part ending (R-WDR-01, R-WDR-02, R-PAY-03) ----------

  async function lockPart(c: Tx, pid: string, dealId?: string): Promise<Part> {
    const p = (
      await c.query<Part>(
        `SELECT p.id, p.deal_id, p.user_id, p.invitation_id, u.email, p.outcome FROM participation p JOIN user_account u ON u.id = p.user_id
          WHERE p.id = $1 AND p.created_at >= ${REAL_SINCE} FOR UPDATE OF p`,
        [pid],
      )
    ).rows[0]
    if (!p || (dealId && p.deal_id !== dealId)) throw new Refused(NOT_FOUND)
    return p
  }

  const moneyArrived = async (c: Q, pid: string) => (await c.query(`SELECT 1 WHERE ${MONEY_ARRIVED}`, [pid])).rowCount! > 0
  const transferMarked = async (c: Q, pid: string) => (await c.query('SELECT 1 FROM transfer_mark WHERE participation_id = $1', [pid])).rowCount! > 0

  /** §5.1's table for removal and withdrawal; the final amounts are never confirmed before D5. */
  function allowedNow(deal: D3Deal, action: 'remove' | 'withdraw') {
    const cell = actionCell(action, { state: deal.state, payoutException: false })
    if (cell !== 'yes' && cell !== 'before_final')
      throw new Refused(action === 'remove' ? 'Nobody can be removed in this state.' : 'A withdrawal cannot be recorded in this state.')
  }

  const endPart = (c: Tx, deal: D3Deal, p: Part, outcome: EndOutcome, actor: string, detail: Record<string, unknown>) =>
    endParticipation(alloc, c, deal, p, outcome, actor, detail)

  app.post<{ Params: { id: string; pid: string } }>('/api/deals/:id/participations/:pid/remove', verified, async (req) => {
    const b = z.strictObject({ money_checked: z.boolean().default(false), reason: z.string().trim().max(2000).optional() }).parse(req.body ?? {})
    const r = await leadTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      allowedNow(deal, 'remove')
      const p = await lockPart(c, Uuid.parse(req.params.pid), deal.id)
      if (p.outcome !== 'active') throw new Refused('This commitment has already ended.')
      const why = removeRefusal({ moneyArrived: await moneyArrived(c, p.id), transferMarked: await transferMarked(c, p.id), moneyChecked: b.money_checked })
      if (why) throw new Refused(why)
      await endPart(c, deal, p, 'removed', req.user!.id, { money_checked: b.money_checked, reason: b.reason ?? null })
      return { outcome: 'removed' as const }
    })
    await d.mail.flush()
    return r
  })

  const WithdrawalBody = z.strictObject({ consent_confirmed: z.boolean(), evidence: z.string().max(5000) })

  async function askWithdrawal(c: Tx, deal: D3Deal, pid: string, who: SessionUser, body: unknown) {
    const b = WithdrawalBody.parse(body)
    allowedNow(deal, 'withdraw')
    const p = await lockPart(c, pid, deal.id)
    if (p.outcome !== 'active') throw new Refused('This commitment has already ended.')
    const why = withdrawalRefusal({ moneyArrived: await moneyArrived(c, p.id), consentConfirmed: b.consent_confirmed, evidence: b.evidence })
    if (why) throw new Refused(why)
    if ((await c.query('SELECT 1 FROM withdrawal_request WHERE participation_id = $1 AND decision IS NULL', [p.id])).rowCount)
      throw new Refused('A withdrawal for this person is already waiting for a reviewer.')
    const id = randomUUID()
    await c.query('INSERT INTO withdrawal_request (id, participation_id, asked_by, consent_confirmed, evidence) VALUES ($1, $2, $3, true, $4)', [
      id,
      p.id,
      who.id,
      b.evidence.trim(),
    ])
    await logParticipation(c, p.id, 'withdrawal_asked', who.id)
    await appendAudit(c, d.k, { actor: who.id, action: 'withdrawal.asked', entity: id })
    await tellReviewers(c, d.mail, 'A withdrawal is waiting', 'A withdrawal with written consent is waiting for a reviewer to check the evidence.')
    return { id }
  }

  app.post<{ Params: { id: string; pid: string } }>('/api/deals/:id/participations/:pid/withdrawal', verified, async (req) => {
    const r = await leadTx(req.user!, Uuid.parse(req.params.id), (c, deal) => askWithdrawal(c, deal, Uuid.parse(req.params.pid), req.user!, req.body))
    await d.mail.flush()
    return r
  })
  // the investor may write to the operator instead of the lead
  app.post<{ Params: { pid: string } }>('/api/review/participations/:pid/withdrawal', reviewer, async (req) => {
    const pid = Uuid.parse(req.params.pid)
    const dealId = (await d.db.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [pid])).rows[0]?.deal_id
    if (!dealId) throw new Refused(NOT_FOUND)
    const r = await reviewTx(req.user!, dealId, (c, deal) => askWithdrawal(c, deal, pid, req.user!, req.body))
    await d.mail.flush()
    return r
  })

  app.get('/api/review/withdrawals', reviewer, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<{
        id: string
        participation_id: string
        deal_id: string
        public_code: string
        reference: string
        evidence: string
        asked_by: string
        created_at: Date
        name: string
      }>(
        `SELECT w.id, w.participation_id, p.deal_id, dl.public_code, p.reference, w.evidence, w.asked_by, w.created_at, u.name
           FROM withdrawal_request w JOIN participation p ON p.id = w.participation_id JOIN deal dl ON dl.id = p.deal_id
           JOIN user_account u ON u.id = p.user_id
          WHERE w.decision IS NULL ORDER BY w.created_at, w.id`,
      )
    ).rows
    const out = []
    for (const r of rows) if (!(await hasStake(d.db, who, r.deal_id))) out.push(r)
    return { withdrawals: out }
  })

  async function withdrawalRow(c: Q, id: string) {
    const w = (
      await c.query<{ id: string; participation_id: string; deal_id: string; decision: string | null }>(
        'SELECT w.id, w.participation_id, p.deal_id, w.decision FROM withdrawal_request w JOIN participation p ON p.id = w.participation_id WHERE w.id = $1',
        [id],
      )
    ).rows[0]
    if (!w) throw new Refused(NOT_FOUND)
    return w
  }

  /** R-WDR-02: the reviewer accepts the evidence; only then is there a refund to-do that can be paid (R-OPS-05). */
  app.post<{ Params: { id: string } }>('/api/review/withdrawals/:id/accept', reviewer, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const w0 = await withdrawalRow(d.db, id)
    const r = await reviewTx(who, w0.deal_id, async (c, deal) => {
      const p = await lockPart(c, w0.participation_id, deal.id)
      const w = (await c.query<{ decision: string | null }>('SELECT decision FROM withdrawal_request WHERE id = $1 FOR UPDATE', [id])).rows[0]!
      if (w.decision !== null) throw new Refused('This withdrawal has already been decided.')
      if (p.outcome !== 'active') {
        await c.query("UPDATE withdrawal_request SET decision = 'lapsed', decided_at = clock_timestamp() WHERE id = $1", [id])
        return { outcome: 'lapsed' as const }
      }
      allowedNow(deal, 'withdraw')
      // the money may have gone back since it was asked (a reversal): then it is a removal, not a withdrawal
      if (!(await moneyArrived(c, p.id))) throw new Refused('No money counts for this person any more: decline this, and the lead can remove them.')
      await c.query("UPDATE withdrawal_request SET decision = 'accepted', decided_by = $2, decided_at = clock_timestamp() WHERE id = $1", [id, who.id])
      await endPart(c, deal, p, 'withdrawn', who.id, { withdrawal: id })
      await ensureTodo(c, p.id, 'withdrawn', who.id)
      const m = await loadMoney(c, p.id)
      await noteReason(c, m!, who.id)
      return { outcome: 'withdrawn' as const }
    })
    await d.mail.flush()
    return r
  })

  app.post<{ Params: { id: string } }>('/api/review/withdrawals/:id/decline', reviewer, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ note: Note }).parse(req.body)
    const w0 = await withdrawalRow(d.db, id)
    return reviewTx(who, w0.deal_id, async (c) => {
      const r = await c.query(
        "UPDATE withdrawal_request SET decision = 'declined', decided_by = $2, decided_at = clock_timestamp(), decision_note = $3 WHERE id = $1 AND decision IS NULL",
        [id, who.id, b.note],
      )
      if (!r.rowCount) throw new Refused('This withdrawal has already been decided.')
      await appendAudit(c, d.k, { actor: who.id, action: 'withdrawal.declined', entity: id })
      return { ok: true }
    })
  })

  // ---------- §5.3: silence past the deadline ----------

  // every reconfirmation still waiting, with where its clock stands: past the deadline, the lead removes people with no money and
  // the operator decides for people with money
  app.get('/api/review/reconfirmations', reviewer, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<{
        id: string
        participation_id: string
        deal_id: string
        public_code: string
        user_id: string
        reference: string
        name: string
      }>(
        `SELECT r.id, r.participation_id, r.deal_id, d.public_code, p.user_id, p.reference, u.name FROM reconfirmation r
           JOIN participation p ON p.id = r.participation_id JOIN deal d ON d.id = r.deal_id JOIN user_account u ON u.id = p.user_id
          WHERE r.state = 'pending' AND p.created_at >= ${REAL_SINCE} ORDER BY r.started_at, r.id LIMIT 500`,
      )
    ).rows
    const out = []
    for (const r of rows) {
      if (await hasStake(d.db, who, r.deal_id)) continue
      const deal = (await dealById(d.db, r.deal_id))!
      const pack = (await packOf(d.db, deal))!
      const rc = (await pendingReconfirmation(d.db, r.participation_id))!
      const clock = await reconfirmClock(d.db, rc, r.user_id, pack.regime, alloc.now())
      const held = (await loadMoney(d.db, r.participation_id))!.figures.onHand
      out.push({
        id: r.id,
        deal_id: r.deal_id,
        deal_code: r.public_code,
        participation_id: r.participation_id,
        reference: r.reference,
        name: r.name,
        clock: clock.state,
        deadline: clock.state === 'open' || clock.state === 'lapsed' ? clock.deadline.toISOString() : null,
        held_minor: String(held),
        next: clock.state === 'lapsed' ? onLapse(held) : null,
      })
    }
    return { reconfirmations: out }
  })

  // §5.3: the operator's recorded decision for a silent person with money: told in the pack's words, excluded, and refunded
  app.post<{ Params: { id: string } }>('/api/review/reconfirmations/:id/exclude', reviewer, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ evidence: z.string().max(5000) }).parse(req.body)
    const rc0 = (await d.db.query<{ deal_id: string; participation_id: string }>('SELECT deal_id, participation_id FROM reconfirmation WHERE id = $1', [id]))
      .rows[0]
    if (!rc0) throw new Refused(NOT_FOUND)
    const r = await reviewTx(who, rc0.deal_id, async (c, deal) => {
      allowedNow(deal, 'withdraw')
      const p = await lockPart(c, rc0.participation_id, deal.id)
      const rc = await pendingReconfirmation(c, p.id, true)
      if (p.outcome !== 'active' || !rc || rc.id !== id) throw new Refused('This reconfirmation has already ended.')
      const pack = (await packOf(c, deal))!
      const clock = await reconfirmClock(c, rc, p.user_id, pack.regime, alloc.now())
      const held = (await loadMoney(c, p.id))!.figures.onHand
      const notice = pack.legal_texts.find((t) => t.text_key === EXCLUSION_NOTICE && t.variant === 'default')?.body ?? null
      const why = exclusionRefusal({ clock, held, notice, evidence: b.evidence })
      if (why || clock.state !== 'lapsed') throw new Refused(why ?? 'The deadline to reconfirm has not passed.')
      const xid = randomUUID()
      await c.query(
        `INSERT INTO reconfirm_exclusion (id, reconfirmation_id, participation_id, decided_by, deadline_at, notice_text, notice_sha256, pack_id, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [xid, rc.id, p.id, who.id, clock.deadline, notice, textSha256(notice!), deal.pack_id, b.evidence.trim()],
      )
      await endPart(c, deal, p, 'excluded_at_close', who.id, { reconfirmation: rc.id, exclusion: xid })
      await ensureTodo(c, p.id, 'excluded_at_close', who.id)
      await noteReason(c, (await loadMoney(c, p.id))!, who.id)
      await tellLeadsOf(c, d.mail, deal, 'An investor was excluded', 'An investor did not answer the changed terms in time and has been excluded. Their money will be refunded.')
      return { outcome: 'excluded_at_close' as const, exclusion: xid }
    })
    await d.mail.flush()
    return r
  })

  // ---------- cancellation (R-WDR-03, R-WDR-05) and archiving ----------

  async function askCancel(c: Tx, deal: D3Deal, who: SessionUser, as: 'lead' | 'reviewer', reason: string | undefined) {
    const why = cancelRequestRefusal(deal.state, { actor: as, payoutException: false })
    if (why) throw new Refused(why)
    if ((await c.query('SELECT 1 FROM cancel_request WHERE deal_id = $1 AND decision IS NULL', [deal.id])).rowCount)
      throw new Refused('A cancellation of this deal is already waiting to be confirmed.')
    const id = randomUUID()
    await c.query('INSERT INTO cancel_request (id, deal_id, asked_by, asked_as, reason) VALUES ($1, $2, $3, $4, $5)', [id, deal.id, who.id, as, reason ?? null])
    await appendAudit(c, d.k, { actor: who.id, action: 'deal.cancel_asked', entity: deal.id, detail: { request: id, as } })
    await tellReviewers(c, d.mail, 'A cancellation is waiting', 'Someone has asked for a deal to be cancelled. Another person must confirm it.')
    // R-WDR-05: the operator's words on what cancelling may cost
    return { id, cancel_fee_note: (await policyNow(c)).cancelFeeNote }
  }

  const CancelBody = z.strictObject({ reason: z.string().trim().min(1).max(2000).optional() })
  app.get<{ Params: { id: string } }>('/api/deals/:id/cancel-note', verified, async (req) =>
    leadTx(req.user!, Uuid.parse(req.params.id), async (c) => ({ cancel_fee_note: (await policyNow(c)).cancelFeeNote })),
  )
  app.post<{ Params: { id: string } }>('/api/deals/:id/cancel-request', verified, async (req) => {
    const b = CancelBody.parse(req.body ?? {})
    const r = await leadTx(req.user!, Uuid.parse(req.params.id), (c, deal) => askCancel(c, deal, req.user!, 'lead', b.reason))
    await d.mail.flush()
    return r
  })
  app.post<{ Params: { id: string } }>('/api/review/deals/:id/cancel-request', reviewer, async (req) => {
    const b = CancelBody.parse(req.body ?? {})
    const r = await reviewTx(req.user!, Uuid.parse(req.params.id), (c, deal) => askCancel(c, deal, req.user!, 'reviewer', b.reason))
    await d.mail.flush()
    return r
  })

  app.get('/api/review/cancel-requests', reviewer, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<{
        id: string
        deal_id: string
        public_code: string
        state: string
        asked_as: string
        asked_by: string
        reason: string | null
        created_at: Date
      }>(
        `SELECT r.id, r.deal_id, dl.public_code, dl.state, r.asked_as, r.asked_by, r.reason, r.created_at
           FROM cancel_request r JOIN deal dl ON dl.id = r.deal_id WHERE r.decision IS NULL ORDER BY r.created_at, r.id`,
      )
    ).rows
    const out = []
    for (const r of rows) if (!(await hasStake(d.db, who, r.deal_id))) out.push({ ...r, mine: r.asked_by === who.id })
    return { requests: out }
  })

  async function cancelRow(c: Q, id: string) {
    const r = (
      await c.query<{ id: string; deal_id: string; asked_by: string; asked_as: 'lead' | 'reviewer'; decision: string | null }>(
        'SELECT id, deal_id, asked_by, asked_as, decision FROM cancel_request WHERE id = $1',
        [id],
      )
    ).rows[0]
    if (!r) throw new Refused(NOT_FOUND)
    return r
  }

  /** §5.1's table, applied to everyone in the same transaction as the move. */
  async function applyCancel(c: Tx, deal: D3Deal, actor: string) {
    const parts = (
      await c.query<Part>(
        `SELECT p.id, p.deal_id, p.user_id, p.invitation_id, u.email, p.outcome FROM participation p JOIN user_account u ON u.id = p.user_id
          WHERE p.deal_id = $1 AND p.outcome = 'active' ORDER BY p.id FOR UPDATE OF p`,
        [deal.id],
      )
    ).rows
    const told = new Set<string>()
    for (const p of parts) {
      const m = (await loadMoney(c, p.id))!
      const open = (await c.query('SELECT 1 FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL', [p.id])).rowCount! > 0
      const o = onCancel({ committed: true, instructionsOpen: open, held: m.figures.onHand })
      await c.query("UPDATE participation SET outcome = 'deal_cancelled', ended_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1", [p.id])
      await c.query("UPDATE withdrawal_request SET decision = 'lapsed', decided_at = clock_timestamp() WHERE participation_id = $1 AND decision IS NULL", [
        p.id,
      ])
      await endProposal(c, alloc, p.id, 'part_ended', actor)
      await logParticipation(c, p.id, 'deal_cancelled', actor, { case: o.case })
      if (o.voidInstructions) await voidInstruction(c, d.k, p.id, 'deal_cancelled', actor)
      if (o.refundToDo) {
        await ensureTodo(c, p.id, 'deal_cancelled', actor)
        await noteReason(c, (await loadMoney(c, p.id))!, actor)
      }
      const key = `${p.user_id}`
      if (o.doNotPayMail) await d.mail.urgent(c, 'void_deal_cancelled', { userId: p.user_id, to: p.email, dealId: deal.id })
      else if (!told.has(key))
        await d.mail.investor(c, { action: 'deal_cancelled', audience: { kind: 'account', userId: p.user_id }, to: p.email, dealId: deal.id })
      told.add(key)
      await refreshRelationship(c, p.user_id, alloc.now())
    }
    // R-ALO-04: the waiting list ends; those on it are invited, so the cancellation notice below reaches them
    await endWaitlist(c, alloc, deal.id, 'cancelled', actor, true)
    // people invited who never committed are told too; the deal's state closes it to them
    const invited = (
      await c.query<{ user_id: string; email: string }>(
        `SELECT DISTINCT i.user_id, u.email FROM deal_invitation i JOIN user_account u ON u.id = i.user_id
          WHERE i.deal_id = $1 AND i.state = 'active' AND u.anonymised_at IS NULL`,
        [deal.id],
      )
    ).rows
    for (const i of invited) {
      if (!told.has(i.user_id)) {
        told.add(i.user_id)
        await d.mail.investor(c, { action: 'deal_cancelled', audience: { kind: 'account', userId: i.user_id }, to: i.email, dealId: deal.id })
      }
      // §5.6: an invitation to a cancelled deal is over; for someone who never committed it may have been the last thing
      await refreshRelationship(c, i.user_id, alloc.now())
    }
    return parts.length
  }

  app.post<{ Params: { id: string } }>('/api/review/cancel-requests/:id/confirm', reviewer, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const r0 = await cancelRow(d.db, id)
    const r = await reviewTx(who, r0.deal_id, async (c, deal) => {
      const row = (await c.query<{ decision: string | null }>('SELECT decision FROM cancel_request WHERE id = $1 FOR UPDATE', [id])).rows[0]!
      if (row.decision !== null) throw new Refused('This cancellation has already been decided.')
      const from = lifeState(deal)
      if (!from) throw new Refused('That cannot be done to a deal in this state.')
      const decision = decideLife(from, 'cancel', {
        actor: 'reviewer',
        userId: who.id,
        reviewerConflicted: false,
        cancelRequest: { by: r0.asked_as, userId: r0.asked_by },
        payoutException: false,
        // release orders arrive with D5
        openReleaseOrder: false,
      })
      if (!decision.ok) throw new Refused(decision.reason)
      await c.query("UPDATE cancel_request SET decision = 'confirmed', decided_by = $2, decided_at = clock_timestamp() WHERE id = $1", [id, who.id])
      await moveDeal(c, deal, decision.to, 'cancel', who.id, null)
      const ended = await applyCancel(c, deal, who.id)
      const note = (await policyNow(c)).cancelFeeNote
      await tellLeads(c, deal, 'Your deal has been cancelled', `The deal has been cancelled. Investors have been told.${note ? `\n\n${note}` : ''}`)
      return { state: decision.to, participations_ended: ended }
    })
    await d.mail.flush()
    return r
  })

  app.post<{ Params: { id: string } }>('/api/review/cancel-requests/:id/decline', reviewer, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ note: Note }).parse(req.body)
    const r0 = await cancelRow(d.db, id)
    if (r0.asked_by === who.id) throw new Refused('Someone other than the person who asked must decide.')
    const r = await reviewTx(who, r0.deal_id, async (c, deal) => {
      const u = await c.query(
        "UPDATE cancel_request SET decision = 'declined', decided_by = $2, decided_at = clock_timestamp(), decision_note = $3 WHERE id = $1 AND decision IS NULL",
        [id, who.id, b.note],
      )
      if (!u.rowCount) throw new Refused('This cancellation has already been decided.')
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.cancel_declined', entity: deal.id, detail: { request: id } })
      if (r0.asked_as === 'lead') await tellLeads(c, deal, 'Your cancellation was not confirmed', `A reviewer did not confirm the cancellation.\n\n${b.note}`)
      return { ok: true }
    })
    await d.mail.flush()
    return r
  })

  /** §5.1 `cancelled` → `archived`: every refund done and no money still held (TC-DEAL-03). */
  app.post<{ Params: { id: string } }>('/api/review/deals/:id/archive', reviewer, async (req) => {
    const who = req.user!
    return reviewTx(who, Uuid.parse(req.params.id), async (c, deal) => {
      const from = lifeState(deal)
      if (!from) throw new Refused('That cannot be done to a deal in this state.')
      let refundsOpen = 0
      let holdsOpen = 0
      const pids = (await c.query<{ id: string }>('SELECT id FROM participation WHERE deal_id = $1 ORDER BY id FOR UPDATE', [deal.id])).rows
      for (const { id } of pids) {
        const f = (await loadMoney(c, id))!.figures
        if (f.hold > 0n) holdsOpen++
        // anything owed back, in flight, or below zero to be checked keeps the deal open
        if ((f.refundDue ?? 0n) > 0n || f.inFlight > 0n || f.needsCheck) refundsOpen++
      }
      const decision = decideLife(from, 'archive', { actor: 'reviewer', userId: who.id, reviewerConflicted: false, refundsOpen, holdsOpen })
      if (!decision.ok) throw new Refused(decision.reason)
      await moveDeal(c, deal, decision.to, 'archive', who.id, null)
      await c.query("UPDATE cancel_request SET decision = 'lapsed', decided_at = clock_timestamp() WHERE deal_id = $1 AND decision IS NULL", [deal.id])
      return { state: decision.to }
    })
  })

  // ---------- a new amount proposed by the lead (R-ALO-01) ----------

  const Amount = z.string().regex(/^[1-9]\d{0,14}$/)

  /** The participation's own terms (frozen at its first commitment) and amounts. */
  async function partTerms(c: Q, pid: string) {
    const r = (
      await c.query<{ commitment_minor: string; terms_snapshot: FrozenTerms }>(
        'SELECT p.commitment_minor, i.terms_snapshot FROM participation p JOIN deal_invitation i ON i.id = p.invitation_id WHERE p.id = $1',
        [pid],
      )
    ).rows[0]!
    return { current: BigInt(r.commitment_minor), fee: linkFee(r.terms_snapshot) }
  }

  app.post<{ Params: { id: string; pid: string } }>('/api/deals/:id/participations/:pid/amount-proposal', verified, async (req) => {
    const b = z.strictObject({ commitment_minor: Amount }).parse(req.body)
    const who = req.user!
    const r = await leadTx(who, Uuid.parse(req.params.id), async (c, deal) => {
      const p = await lockPart(c, Uuid.parse(req.params.pid), deal.id)
      if (p.outcome !== 'active') throw new Refused('This commitment has already ended.')
      const { current, fee } = await partTerms(c, p.id)
      const proposed = BigInt(b.commitment_minor)
      const a = await allocationOf(c, deal)
      const m = (await loadMoney(c, p.id))!
      const why = proposalRefusal({
        dealState: deal.state,
        onHand: m.figures.onHand,
        transferMarked: await transferMarked(c, p.id),
        current,
        proposed,
        fee,
        minimum: a.minimum,
      })
      if (why) throw new Refused(why)
      if (await openProposal(c, alloc, p.id)) throw new Refused('A new amount for this person is already waiting for their answer.')
      // an increase must fit now as well as when it is accepted (R-ALO-03)
      if (proposed > current) {
        const currency = (await approvedSnapshot(c, deal))?.snapshot.terms?.currency ?? 'GBP'
        const full = capacityRefusal(await capacityFor(c, deal, fee, proposed, p.id), (x) => money(x, currency))
        if (full) throw new Refused(full)
      }
      const deadline = workingDayDeadline(alloc.now(), (await policyNow(c)).amountProposalDays)!
      const id = randomUUID()
      await c.query(
        'INSERT INTO amount_proposal (id, participation_id, proposed_by, from_commitment_minor, proposed_minor, deadline_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, p.id, who.id, String(current), String(proposed), deadline],
      )
      await logParticipation(c, p.id, 'amount_proposed', who.id, { from: String(current), to: String(proposed) })
      await appendAudit(c, d.k, { actor: who.id, action: 'amount_proposal.made', entity: id, detail: { from: String(current), to: String(proposed) } })
      // R-PAY-03: the instruction is void until the person answers; the urgent notice says so
      if (await voidInstruction(c, d.k, p.id, 'amount_proposed', who.id))
        await d.mail.urgent(c, 'void_amount_proposed', { userId: p.user_id, to: p.email, dealId: deal.id })
      // the last whole day to answer: the deadline is the end of it
      const last = new Date(deadline.getTime() - 1).toISOString().slice(0, 10)
      await d.mail.investor(c, { action: 'amount_proposed', audience: { kind: 'account', userId: p.user_id }, to: p.email, dealId: deal.id, deadline: last })
      return { id, deadline_at: deadline.toISOString() }
    })
    await d.mail.flush()
    return r
  })

  // ---------- the waiting list, as the lead sees it (R-ALO-04) ----------

  app.get<{ Params: { id: string } }>('/api/deals/:id/waitlist', verified, async (req) =>
    leadTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      const a = await allocationOf(c, deal)
      const rows = (
        await c.query<{ id: string; name: string; desired_minor: string; state: string; created_at: Date; released_at: Date | null }>(
          `SELECT w.id, u.name, w.desired_minor::text, w.state, w.created_at, w.released_at FROM waitlist_entry w JOIN user_account u ON u.id = w.user_id
            WHERE w.deal_id = $1 AND w.state IN ('waiting', 'released') ORDER BY w.created_at, w.id`,
          [deal.id],
        )
      ).rows
      const left = a.allocation - (await committedInvest(c, deal.id))
      return { mode: a.mode, room_minor: String(left > 0n ? left : 0n), entries: rows }
    }),
  )

  app.post<{ Params: { id: string; wid: string } }>('/api/deals/:id/waitlist/:wid/release', verified, async (req) => {
    const who = req.user!
    const r = await leadTx(who, Uuid.parse(req.params.id), async (c, deal) => {
      const w = (
        await c.query<{ id: string; state: string; user_id: string; email: string; terms: FrozenTerms | null; invite_link: string }>(
          `SELECT w.id, w.state, w.user_id, u.email, i.terms_snapshot AS terms, i.invite_link FROM waitlist_entry w
             JOIN user_account u ON u.id = w.user_id JOIN deal_invitation i ON i.id = w.invitation_id
            WHERE w.id = $1 AND w.deal_id = $2 FOR UPDATE OF w`,
          [Uuid.parse(req.params.wid), deal.id],
        )
      ).rows[0]
      if (!w) throw new Refused(NOT_FOUND)
      // the person's terms: frozen if they committed before with another entity, else their link's
      const fee = w.terms
        ? linkFee(w.terms)
        : linkFee((await c.query<LinkRow>('SELECT * FROM invite_link WHERE id = $1', [w.invite_link])).rows[0]!)
      const a = await allocationOf(c, deal)
      const why = releaseRefusal({ dealState: deal.state, state: w.state, room: a.allocation - (await committedInvest(c, deal.id)), fee, minimum: a.minimum })
      if (why) throw new Refused(why)
      await c.query("UPDATE waitlist_entry SET state = 'released', released_by = $2, released_at = clock_timestamp() WHERE id = $1", [w.id, who.id])
      await appendAudit(c, d.k, { actor: who.id, action: 'waitlist.released', entity: w.id })
      await d.mail.investor(c, { action: 'waitlist_released', audience: { kind: 'account', userId: w.user_id }, to: w.email, dealId: deal.id })
      return { state: 'released' as const }
    })
    await d.mail.flush()
    return r
  })
}
