// D4 chunk 6b: what the commit, proposal, waiting-list and lifecycle routes share (R-ALO-01, R-ALO-03, R-ALO-04, PRD §5.6).
// The rules are in `lib/allocation.ts` and `lib/money.ts`; these read the facts and write what they decide, in the caller's
// transaction.
import { capacityMode, proposalLapsed, relationshipEnd, type ProposalEnd } from '../lib/allocation.ts'
import type { LinkFee } from '../lib/fees.ts'
import { capacity, type Capacity } from '../lib/money.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import type { Tx } from '../store/db.ts'
import { approvedSnapshot, logParticipation, type D3Deal, type Q } from './d3Core.ts'
import type { MailQueue } from './outbox.ts'

export interface AllocDeps {
  k: Keyring
  mail: MailQueue
  now: () => Date
}

/** Every lead and co-lead of the deal is told. */
export async function tellLeads(c: Q, mail: MailQueue, deal: Pick<D3Deal, 'id' | 'lead_user'>, subject: string, body: string) {
  const rows = (
    await c.query<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM user_account u WHERE u.id = $1
          OR u.id IN (SELECT user_id FROM deal_member WHERE deal_id = $2 AND role = 'co_lead')`,
      [deal.lead_user, deal.id],
    )
  ).rows
  for (const r of rows) await mail.queue(c, { audience: { kind: 'lead', userId: r.id, dealId: deal.id }, to: r.email, subject, body })
}

/** R-ALO-03's inputs from the approved deal: the choice, the SPV allocation and the minimum commitment. */
export async function allocationOf(c: Q, deal: D3Deal) {
  const t = (await approvedSnapshot(c, deal))?.snapshot.terms ?? {}
  return { mode: capacityMode(t.over_allocation), allocation: BigInt(t.allocation_minor ?? '0'), minimum: BigInt(t.min_commitment_minor ?? '1') }
}

/** Σ T of the active participations, without `except` (the one being changed). Read under the deal lock. */
export async function committedInvest(c: Q, dealId: string, except: string | null = null): Promise<bigint> {
  const r = await c.query<{ t: string }>(
    "SELECT coalesce(sum(invest_minor), 0)::text AS t FROM participation WHERE deal_id = $1 AND outcome = 'active' AND id IS DISTINCT FROM $2",
    [dealId, except],
  )
  return BigInt(r.rows[0]!.t)
}

/** R-ALO-03 for a commitment of `commitment` on `fee`, judged in the caller's transaction with the deal row held. */
export async function capacityFor(c: Q, deal: D3Deal, fee: LinkFee, commitment: bigint, except: string | null = null): Promise<Capacity> {
  const a = await allocationOf(c, deal)
  return capacity({ mode: a.mode, allocation: a.allocation, others: await committedInvest(c, deal.id, except), commitment, fee, minimum: a.minimum })
}

export interface ProposalRow {
  id: string
  participation_id: string
  from_commitment_minor: string
  proposed_minor: string
  deadline_at: Date
  created_at: Date
}

/**
 * Ends the open proposal of a participation, if any. Every end but acceptance leaves the amount as it was and tells the
 * investor so (R-ALO-01: the instruction is issued again at the original amount); a part that ended has its own mail.
 */
export async function endProposal(c: Tx, d: AllocDeps, participationId: string, how: ProposalEnd, actor: string | null): Promise<boolean> {
  const r = await c.query<{ id: string }>(
    'UPDATE amount_proposal SET decision = $2, decided_at = clock_timestamp() WHERE participation_id = $1 AND decision IS NULL RETURNING id',
    [participationId, how],
  )
  const row = r.rows[0]
  if (!row) return false
  await logParticipation(c, participationId, `amount_${how}`, actor, { proposal: row.id })
  await appendAudit(c, d.k, { actor: actor ?? 'system', action: `amount_proposal.${how}`, entity: row.id })
  if (how !== 'accepted' && how !== 'part_ended') {
    const p = (
      await c.query<{ user_id: string; email: string; deal_id: string }>(
        'SELECT p.user_id, u.email, p.deal_id FROM participation p JOIN user_account u ON u.id = p.user_id WHERE p.id = $1',
        [participationId],
      )
    ).rows[0]!
    await d.mail.investor(c, { action: 'amount_unchanged', audience: { kind: 'account', userId: p.user_id }, to: p.email, dealId: p.deal_id })
  }
  return true
}

/** The open proposal of a participation; one past its deadline is ended here first, so nobody can act on it (R-ALO-01). */
export async function openProposal(c: Tx, d: AllocDeps, participationId: string): Promise<ProposalRow | null> {
  const row = (
    await c.query<ProposalRow>(
      'SELECT id, participation_id, from_commitment_minor, proposed_minor, deadline_at, created_at FROM amount_proposal WHERE participation_id = $1 AND decision IS NULL FOR UPDATE',
      [participationId],
    )
  ).rows[0]
  if (!row) return null
  if (proposalLapsed(new Date(row.deadline_at), d.now())) {
    await endProposal(c, d, participationId, 'lapsed', null)
    return null
  }
  return row
}

/** R-ALO-04: every entry still waiting on the deal ends (asking for closing, cancellation), each person told unless `quiet`. */
export async function endWaitlist(c: Tx, d: AllocDeps, dealId: string, reason: 'closing_requested' | 'cancelled', actor: string, quiet = false) {
  const rows = (
    await c.query<{ id: string; user_id: string; email: string }>(
      `UPDATE waitlist_entry w SET state = 'ended', end_reason = $2, ended_at = clock_timestamp() FROM user_account u
        WHERE w.deal_id = $1 AND w.state = 'waiting' AND u.id = w.user_id RETURNING w.id, w.user_id, u.email`,
      [dealId, reason],
    )
  ).rows
  for (const r of rows) {
    await appendAudit(c, d.k, { actor, action: 'waitlist.ended', entity: r.id, detail: { reason } })
    if (!quiet) await d.mail.investor(c, { action: 'waitlist_ended', audience: { kind: 'account', userId: r.user_id }, to: r.email, dealId })
  }
  return rows.length
}

/** R-ALO-04: someone left a deal whose waiting list has people on it; the leads decide whether to let one in. */
export async function tellLeadsOfRoom(c: Q, mail: MailQueue, deal: Pick<D3Deal, 'id' | 'lead_user'>, why: 'left' | 'raised' = 'left') {
  const waiting = await c.query("SELECT 1 FROM waitlist_entry WHERE deal_id = $1 AND state = 'waiting' LIMIT 1", [deal.id])
  if (!waiting.rowCount) return
  await tellLeads(
    c,
    mail,
    deal,
    'Room may have opened in your deal',
    why === 'left'
      ? 'Someone has left a deal with people on its waiting list. Sign in to decide whether to let someone in.'
      : 'The allocation of a deal with people on its waiting list is now larger. Sign in to decide whether to let someone in.',
  )
}

/**
 * PRD §5.6: recomputes when this person's relationship ended, after any invitation or participation started or ended. It
 * runs while one is active, an investment is still held (`invested` > 0 with no end of holding), or an invitation to a deal
 * still taking commitments is open and was never committed on (§5.6 「邀请全部结束」 is the rule for those who never
 * committed; an invitation kept open after a part ended, as after a KYC rejection, follows the part's end).
 */
export async function refreshRelationship(c: Q, userId: string, now: Date) {
  const f = (
    await c.query<{ active: boolean; holding: boolean; invited: boolean; current: Date | null }>(
      `SELECT EXISTS (SELECT 1 FROM participation WHERE user_id = $1 AND outcome = 'active') AS active,
              EXISTS (SELECT 1 FROM participation WHERE user_id = $1 AND invested_minor > 0 AND holding_ended_at IS NULL) AS holding,
              EXISTS (SELECT 1 FROM deal_invitation i JOIN deal d ON d.id = i.deal_id
                       WHERE i.user_id = $1 AND i.state = 'active' AND d.state IN ('live', 'closing_requested', 'closing')
                         AND NOT EXISTS (SELECT 1 FROM participation p WHERE p.invitation_id = i.id)) AS invited,
              (SELECT relationship_ended_at FROM user_account WHERE id = $1) AS current`,
      [userId],
    )
  ).rows[0]!
  const next = relationshipEnd({ active: f.active, holding: f.holding, invited: f.invited, current: f.current, now })
  if ((next?.getTime() ?? null) !== (f.current?.getTime() ?? null))
    await c.query('UPDATE user_account SET relationship_ended_at = $2 WHERE id = $1', [userId, next])
}
