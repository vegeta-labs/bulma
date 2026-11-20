// D4 chunk 7: changes to a live deal (PRD R-CHG-01..03, R-CHG-05, R-CMP-02, §5.3). The lead asks with one plain sentence; the
// lead's own dates take effect at once; anything else is judged by a reviewer with no stake and takes effect only with the
// content approval, in the same transaction: the new version, the notices, the voided instructions and the people asked to
// reconfirm all start then. Until then investors keep seeing the version approved before. Rules live in lib/change.ts.
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  classifyChange,
  decideChange,
  needsJudgement,
  ONE_CHANGE_OPEN,
  personTermsRefusal,
  selfServiceOnly,
  termsChanges,
  type Classified,
  type Judgement,
} from '../lib/change.ts'
import { breakdown, changesInWords } from '../lib/dealSheet.ts'
import { MAX_DUE_MINOR, type LinkFee } from '../lib/fees.ts'
import type { Draft } from '../lib/draft.ts'
import { canApproveDealContent, isInterestedParty, type DealParties } from '../lib/gate.ts'
import { diffContent, stableJson, type FieldChange } from '../lib/snapshot.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { allocationOf, committedInvest, tellLeads, tellLeadsOfRoom } from './allocation.ts'
import { approvedSnapshot, linkFee, logParticipation, packOf, policyNow, voidInstruction, type FrozenTerms, type Q } from './d3Core.ts'
import { Fee, toFee } from './d3Lead.ts'
import { termsAt, termsNow } from './reconfirm.ts'
import { hasStake, tellReviewers } from './ledger.ts'
import type { MailQueue } from './outbox.ts'
import { Refused } from './requests.ts'

/** The deal row as d2 holds it. */
export interface ChangeDeal {
  id: string
  lead_user: string
  syndicate_id: string | null
  state: string
  draft: Draft
  public_code: string
  approved_version: number | null
  bound_floor_minor: string | null
  pack_id: string | null
}

export interface ChangeDeps {
  db: Db
  k: Keyring
  mail: MailQueue
  now: () => Date
  /** d2's: the lead or a co-lead, with the deal and its syndicate held. */
  leadTx: <T>(who: SessionUser, id: string, fn: (c: Tx, deal: ChangeDeal) => Promise<T>) => Promise<T>
  parseDraft: (body: unknown) => Draft
  /** What the draft still lacks or has wrong, as labels (R17). */
  gaps: (c: Q, deal: ChangeDeal, draft: Draft) => Promise<string[]>
  snapshotOf: (c: Q, dealId: string, draft: Draft) => Promise<{ snapshot: Record<string, unknown> }>
  expand: (c: Q, snapshot: Record<string, unknown>) => Promise<Record<string, unknown>>
  partiesOf: (c: Q, deal: ChangeDeal) => Promise<DealParties>
}

interface ChangeRow {
  id: string
  deal_id: string
  base_version: number
  proposed: Draft
  proposed_snapshot: Record<string, unknown>
  proposed_sha256: string
  summary: string
  classification: Classified
  self_service: boolean
  submitted_by: string
  state: 'submitted' | 'reviewed' | 'applied' | 'returned' | 'withdrawn'
  verdict: 'notice' | 'reconfirm' | null
  verdict_reason: string | null
  reviewed_by: string | null
  return_reason: string | null
  applied_version: number | null
  /** A change to one person's terms: their invitation. */
  invitation_id: string | null
  created_at: Date
}

/** What a change to one person's terms holds: the terms before and after, and the lead's confirmation (R-LNK-06). */
interface PersonSnapshot {
  before: FrozenTerms
  after: FrozenTerms
  incentive_attested: boolean
}

const asLink = (t: FrozenTerms) => ({ carryBps: t.carry_bps, fee: linkFee(t) })
function frozen(linkId: string, carryBps: number, fee: LinkFee): FrozenTerms {
  return {
    link_id: linkId,
    carry_bps: carryBps,
    fee_kind: fee.kind,
    fee_bps: fee.kind === 'percent' ? fee.bps : null,
    fee_minor: fee.kind === 'fixed' ? String(fee.minor) : null,
    fee_mode: fee.kind === 'none' ? null : fee.mode,
  }
}

const Uuid = z.uuid()
const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const Reason = z.string().trim().min(1).max(2000)
const NOT_FOUND = 'Not found.'
const STAKE = 'You cannot decide on a change to a deal you lead, work on, receive carry from or invest in.'
const CHANGED = 'This change is not the one you opened. Open it again.'
const MOVED = 'The deal has changed since this was asked for. Withdraw it and ask again.'
const ONE_OPEN = ONE_CHANGE_OPEN
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const OPEN = "state IN ('submitted', 'reviewed')"

export function registerChanges(app: FastifyInstance, d: ChangeDeps) {
  const verified = { config: { gate: 'verified' as const } }
  const reviewer = { config: { gate: 'canReviewDeals' as const } }
  const approver = { config: { gate: 'canApproveContent' as const } }

  const lockDeal = async (c: Q, id: string) =>
    (
      await c.query<ChangeDeal>(
        'SELECT id, lead_user, syndicate_id, state, draft, public_code, approved_version, bound_floor_minor, pack_id FROM deal WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [id],
      )
    ).rows[0] ?? null

  /** The change and its deal, both held: the deal first, as every other writer takes them. */
  async function lockChange(c: Tx, cid: string): Promise<{ cr: ChangeRow; deal: ChangeDeal }> {
    const dealId = (await c.query<{ deal_id: string }>('SELECT deal_id FROM change_request WHERE id = $1', [cid])).rows[0]?.deal_id
    if (!dealId) throw new Refused(NOT_FOUND)
    const deal = (await lockDeal(c, dealId))!
    const cr = (await c.query<ChangeRow>('SELECT * FROM change_request WHERE id = $1 FOR UPDATE', [cid])).rows[0]!
    return { cr, deal }
  }

  /** A staff member with the role, still signed in, and no stake in the deal (R-REV-04). */
  async function staffTx<T>(
    who: SessionUser,
    role: 'reviewer' | 'approver',
    cid: string,
    fn: (c: Tx, cr: ChangeRow, deal: ChangeDeal) => Promise<T>,
  ): Promise<T> {
    return tx(d.db, async (c) => {
      await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
      const { cr, deal } = await lockChange(c, cid)
      if (deal.syndicate_id) await c.query('SELECT 1 FROM syndicate WHERE id = $1 FOR SHARE', [deal.syndicate_id])
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const held = await c.query(
        'SELECT 1 FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.user_id = $1 AND g.role = $2 AND u.mfa_enabled_at IS NOT NULL AND u.email_verified_at IS NOT NULL',
        [who.id, role],
      )
      if (!held.rowCount) throw new Refused(role === 'reviewer' ? 'Only a reviewer can do this.' : 'Only a content approver can do this.')
      if (await hasStake(c, who, deal.id)) throw new Refused(STAKE)
      return fn(c, cr, deal)
    })
  }

  /** Content approval is needed in the real mode, and in the sandbox only when the operator turned it on (R-CMP-02). */
  async function approvalNeeded(c: Q): Promise<boolean> {
    const r = (
      await c.query<{ mode: string; on: boolean }>(
        'SELECT p.mode, c.content_approval_in_sandbox AS on FROM instance_profile p CROSS JOIN deal_config c WHERE p.id = 1 AND c.id = 1',
      )
    ).rows[0]!
    return r.mode === 'real' || r.on
  }

  /** Committed people not in a final status, with their commitment C (§5.3: who a change can reach). */
  const activePeople = async (c: Q, dealId: string, invitationId: string | null = null) =>
    (
      await c.query<{
        id: string
        user_id: string
        email: string
        commitment_minor: string
        invest_minor: string
        agreed_version: number | null
        invitation_id: string
        agreed_terms_n: number
      }>(
        `SELECT p.id, p.user_id, u.email, p.commitment_minor::text, p.invest_minor::text, p.agreed_version, p.invitation_id, p.agreed_terms_n
           FROM participation p JOIN user_account u ON u.id = p.user_id
          WHERE p.deal_id = $1 AND p.outcome = 'active' AND ($2::uuid IS NULL OR p.invitation_id = $2) ORDER BY p.join_seq FOR UPDATE OF p`,
        [dealId, invitationId],
      )
    ).rows

  /** The classifier, asked again with what is true now: the state, the people and the pack may have moved since. */
  async function classifyNow(c: Q, deal: ChangeDeal, after: Draft) {
    const pack = await packOf(c, deal)
    const people = await activePeople(c, deal.id)
    const ever = (await c.query('SELECT 1 FROM participation WHERE deal_id = $1 LIMIT 1', [deal.id])).rowCount! > 0
    const floor =
      deal.bound_floor_minor ?? (await c.query<{ f: string }>('SELECT min_commitment_floor_minor::text AS f FROM deal_config WHERE id = 1')).rows[0]!.f
    const cls = classifyChange({
      before: deal.draft,
      after,
      state: deal.state as never,
      anyCommitment: ever,
      stricter: pack?.must_reconfirm_extra ?? [],
      floorMinor: BigInt(floor),
      people: people.map((p) => ({ id: p.id, commitment: BigInt(p.commitment_minor) })),
    })
    if (!cls.ok) throw new Refused(cls.reason)
    return { c: cls.c, people }
  }

  /**
   * R-CHG-02, R-CMP-02, §5.3: the change takes effect. One transaction: the version investors see, the notices, the voided
   * instructions and the reconfirmations. A notice keeps the terms version, the signatures and the instructions.
   */
  async function apply(c: Tx, deal: ChangeDeal, cr: ChangeRow, actor: string, approvedBy: string | null): Promise<number> {
    if (deal.approved_version !== cr.base_version) throw new Refused(MOVED)
    const { c: cls, people } = await classifyNow(c, deal, cr.proposed)
    const j: Judgement = { verdict: cr.verdict ?? undefined, reason: cr.verdict_reason ?? undefined }
    const decision = decideChange(cls, deal.state as never, j)
    if (!decision.ok) throw new Refused(decision.reason)
    const effect = decision.effect
    // a change asked for as the lead's own dates must still be only that; one judged by a reviewer must still need nothing more
    if (selfServiceOnly(cls) !== cr.self_service) throw new Refused(MOVED)
    if (!cr.self_service && needsJudgement(cls) && !cr.verdict) throw new Refused(MOVED)
    const n = (await c.query<{ n: number }>('SELECT max(n) + 1 AS n FROM deal_version WHERE deal_id = $1', [deal.id])).rows[0]!.n
    await c.query('INSERT INTO deal_version (deal_id, n, snapshot, sha256, kind, approved_by) VALUES ($1, $2, $3, $4, $5, $6)', [
      deal.id,
      n,
      stableJson(cr.proposed_snapshot),
      cr.proposed_sha256,
      cr.self_service ? 'self_service' : 'approved',
      cr.self_service ? null : (approvedBy ?? cr.reviewed_by),
    ])
    // the carry recipients follow the content that is now in force
    const recipients = ((cr.proposed_snapshot.economics as { recipients?: Array<{ kind: string; person_version: string; share_bps: number }> } | undefined)
      ?.recipients ?? []) as Array<{ kind: string; person_version: string; share_bps: number }>
    await c.query('DELETE FROM carry_recipient WHERE deal_id = $1', [deal.id])
    for (const r of recipients)
      await c.query('INSERT INTO carry_recipient (id, deal_id, kind, person_version, share_bps) VALUES ($1, $2, $3, $4, $5)', [
        randomUUID(),
        deal.id,
        r.kind,
        r.person_version,
        r.share_bps,
      ])
    const close = cr.proposed.terms?.target_close
    await c.query(
      'UPDATE deal SET draft = $2, approved_version = $3, target_close = $4, updated_at = $5::timestamptz, draft_rev = draft_rev + 1 WHERE id = $1',
      [deal.id, stableJson(cr.proposed), n, typeof close === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(close) ? close : null, d.now().toISOString()],
    )
    await c.query(
      "UPDATE change_request SET state = 'applied', applied_version = $2, applied_at = clock_timestamp(), ended_at = clock_timestamp() WHERE id = $1",
      [cr.id, n],
    )
    await c.query('INSERT INTO review_event (id, deal_id, from_state, to_state, actor, event, reason, version_n) VALUES ($1, $2, $3, $3, $4, $5, $6, $7)', [
      randomUUID(),
      deal.id,
      deal.state,
      actor,
      cr.self_service ? 'change_self_service' : 'change_applied',
      cr.verdict_reason,
      n,
    ])

    const asked = effect.reconfirm === 'all' ? new Set(people.map((p) => p.id)) : new Set(effect.reconfirm)
    const days = asked.size ? (await policyNow(c)).reconfirmDays : 0
    for (const p of people) {
      if (!asked.has(p.id)) continue
      // §5.3: a newer change replaces the one still waiting; everyone, those who agreed included, compares with what they last agreed
      // a re-signing still owed carries over: their signature is on the older sheet, whatever this change alone touches
      const owed = (
        await c.query<{ resign: boolean }>(
          "UPDATE reconfirmation SET state = 'superseded', decided_at = clock_timestamp() WHERE participation_id = $1 AND state = 'pending' RETURNING resign",
          [p.id],
        )
      ).rows.some((r) => r.resign)
      const termsN = await termsNow(c, p.invitation_id)
      // a change taken back: someone whose last agreed version is exactly the one now in force, on the terms they agreed, has
      // nothing to reconfirm (§5.3 "or take this change back")
      const agreed = p.agreed_version ?? cr.base_version
      const was = (await c.query<{ snapshot: Record<string, unknown> }>('SELECT snapshot FROM deal_version WHERE deal_id = $1 AND n = $2', [deal.id, agreed]))
        .rows[0]!.snapshot
      if (sha(stableJson(was)) === cr.proposed_sha256 && termsN === p.agreed_terms_n) {
        await c.query('UPDATE participation SET agreed_version = $2, updated_at = clock_timestamp() WHERE id = $1', [p.id, n])
        await logParticipation(c, p.id, 'change_taken_back', actor, { version: n, change: cr.id })
        asked.delete(p.id)
        continue
      }
      await c.query('UPDATE participation SET terms_version = terms_version + 1, updated_at = clock_timestamp() WHERE id = $1', [p.id])
      await c.query(
        // the clock starts by the app's time, as every deadline here does
        `INSERT INTO reconfirmation (id, participation_id, change_id, deal_id, deal_version, compared_to, resign, days, started_at, terms_n, terms_compared_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [randomUUID(), p.id, cr.id, deal.id, n, agreed, effect.resign || owed, days, d.now().toISOString(), termsN, p.agreed_terms_n],
      )
      await logParticipation(c, p.id, 'reconfirm_asked', actor, { version: n, change: cr.id })
      // R-PAY-03: the instruction was bound to the terms version that has just moved
      if (await voidInstruction(c, d.k, p.id, 'terms_changed', actor))
        await d.mail.urgent(c, 'void_terms_changed', { userId: p.user_id, to: p.email, dealId: deal.id })
    }
    // R-CHG-02 / §5.3: a change that asks nothing of someone leaves their pending reconfirmation standing, on the version now in
    // force (same deadline): otherwise a notice or the lead's own dates would leave them nothing they could agree to
    await c.query("UPDATE reconfirmation SET deal_version = $2 WHERE deal_id = $1 AND state = 'pending' AND deal_version <> $2", [deal.id, n])
    // one mail a person: the one asking for an answer if any of their commitments must reconfirm
    const told = new Map<string, { email: string; reconfirm: boolean }>()
    for (const p of people) {
      const was = told.get(p.user_id)
      told.set(p.user_id, { email: p.email, reconfirm: (was?.reconfirm ?? false) || asked.has(p.id) })
    }
    for (const [userId, t] of told)
      await d.mail.investor(c, {
        action: t.reconfirm ? 'reconfirm_needed' : 'deal_updated',
        audience: { kind: 'account', userId },
        to: t.email,
        dealId: deal.id,
      })
    await appendAudit(c, d.k, {
      actor,
      action: cr.self_service ? 'deal.change_self_service' : 'deal.change_applied',
      entity: deal.id,
      detail: { change: cr.id, version: n, reconfirm: asked.size, resign: effect.resign },
    })
    await tellLeads(
      c,
      d.mail,
      deal,
      `Change to deal ${deal.public_code}`,
      asked.size
        ? `Your change is now in force. ${asked.size} commitment(s) must be reconfirmed by the investors before the deal can ask for closing.`
        : 'Your change is now in force. Investors have been told and can see what changed.',
    )
    // R-ALO-04: a larger allocation may let people in from the waiting list
    const room = (t: Draft) => BigInt(String(t.terms?.allocation_minor ?? '0'))
    if (room(cr.proposed) > room(deal.draft)) await tellLeadsOfRoom(c, d.mail, deal, 'raised')
    return n
  }

  // ---------- one person's terms (R-CHG-02 last line) ----------

  /** The rules for changing one person's terms, with today's facts; the commitments under them, held. */
  async function personCheck(c: Q, deal: ChangeDeal, invitationId: string, snap: PersonSnapshot, reason: string) {
    const pack = await packOf(c, deal)
    const policy = await policyNow(c)
    const cfg = (await c.query<{ link_fee_max_bps: number }>('SELECT link_fee_max_bps FROM deal_config WHERE id = 1')).rows[0]!
    const defaultCarry = (await approvedSnapshot(c, deal))?.snapshot.economics?.default_carry_bps ?? 0
    const parts = await activePeople(c, deal.id, invitationId)
    const a = await allocationOf(c, deal as never)
    const mine = parts.reduce((s, p) => s + BigInt(p.invest_minor), 0n)
    const refusal = personTermsRefusal({
      state: deal.state as never,
      before: asLink(snap.before),
      after: asLink(snap.after),
      reason,
      defaultCarryBps: defaultCarry,
      feeMaxBps: cfg.link_fee_max_bps,
      policy,
      attestationRequired: !!pack?.incentive_attestation_required,
      incentiveAttested: snap.incentive_attested,
      commitments: parts.map((p) => BigInt(p.commitment_minor)),
      room: { stop: a.mode === 'stop', allocation: a.allocation, others: (await committedInvest(c, deal.id)) - mine },
    })
    if (refusal) throw new Refused(refusal)
    return { parts, fpo: pack?.regime === 'uk-fpo' }
  }

  /**
   * R-CHG-02, §5.3: one person's terms take effect. Only the commitments under that invitation reconfirm and sign again; the amount
   * to pay is worked out again, so someone who had paid in full is back to paying the difference or having it refunded.
   */
  async function applyPerson(c: Tx, deal: ChangeDeal, cr: ChangeRow, actor: string): Promise<void> {
    if (deal.approved_version !== cr.base_version) throw new Refused(MOVED)
    const inv = (
      await c.query<{ id: string; terms_snapshot: FrozenTerms }>('SELECT id, terms_snapshot FROM deal_invitation WHERE id = $1 FOR UPDATE', [cr.invitation_id])
    ).rows[0]!
    const snap = cr.proposed_snapshot as unknown as PersonSnapshot
    if (stableJson(inv.terms_snapshot) !== stableJson(snap.before)) throw new Refused(MOVED)
    const { parts, fpo } = await personCheck(c, deal, inv.id, snap, cr.summary)
    const fee = linkFee(snap.after)
    const dues = parts.map((p) => breakdown(BigInt(p.commitment_minor), fee, fpo).due)
    if (dues.some((x) => x.due > MAX_DUE_MINOR)) throw new Refused('The amount to pay would be above the largest allowed.')
    const top = (await c.query<{ n: number | null }>('SELECT max(n) AS n FROM invitation_terms WHERE invitation_id = $1', [inv.id])).rows[0]!.n
    if (top === null) await c.query('INSERT INTO invitation_terms (invitation_id, n, terms) VALUES ($1, 0, $2)', [inv.id, stableJson(snap.before)])
    const n = (top ?? 0) + 1
    await c.query('INSERT INTO invitation_terms (invitation_id, n, terms, change_id) VALUES ($1, $2, $3, $4)', [inv.id, n, stableJson(snap.after), cr.id])
    await c.query('UPDATE deal_invitation SET terms_snapshot = $2 WHERE id = $1', [inv.id, stableJson(snap.after)])
    const days = (await policyNow(c)).reconfirmDays
    const version = deal.approved_version!
    const asked = new Set<string>()
    for (const [i, p] of parts.entries()) {
      const due = dues[i]!
      await c.query(
        `UPDATE participation SET invest_minor = $2, lead_fee_minor = $3, rounding_minor = $4, cash_due_minor = $5, terms_version = terms_version + 1,
                updated_at = clock_timestamp() WHERE id = $1`,
        [p.id, String(due.invest), String(due.leadFee), String(due.rounding), String(due.due)],
      )
      await c.query("UPDATE reconfirmation SET state = 'superseded', decided_at = clock_timestamp() WHERE participation_id = $1 AND state = 'pending'", [p.id])
      const agreed = p.agreed_version ?? cr.base_version
      // terms put back to the ones this person last agreed, on the version they agreed: nothing to reconfirm
      if (agreed === version && stableJson(await termsAt(c, inv.id, p.agreed_terms_n)) === stableJson(snap.after)) {
        await c.query('UPDATE participation SET agreed_terms_n = $2 WHERE id = $1', [p.id, n])
        await logParticipation(c, p.id, 'change_taken_back', actor, { change: cr.id, terms: n })
      } else {
        asked.add(p.user_id)
        await c.query(
          `INSERT INTO reconfirmation (id, participation_id, change_id, deal_id, deal_version, compared_to, resign, days, started_at, terms_n, terms_compared_to)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10)`,
          [randomUUID(), p.id, cr.id, deal.id, version, agreed, days, d.now().toISOString(), n, p.agreed_terms_n],
        )
        await logParticipation(c, p.id, 'reconfirm_asked', actor, { change: cr.id, terms: n, due_minor: String(due.due) })
      }
      // R-PAY-03: the amount to pay and the terms version have moved
      if (await voidInstruction(c, d.k, p.id, 'terms_changed', actor))
        await d.mail.urgent(c, 'void_terms_changed', { userId: p.user_id, to: p.email, dealId: deal.id })
    }
    const person = parts[0]!
    await d.mail.investor(c, {
      action: asked.size ? 'reconfirm_needed' : 'deal_updated',
      audience: { kind: 'account', userId: person.user_id },
      to: person.email,
      dealId: deal.id,
    })
    await c.query(
      "UPDATE change_request SET state = 'applied', applied_version = $2, applied_at = clock_timestamp(), ended_at = clock_timestamp() WHERE id = $1",
      [cr.id, version],
    )
    await appendAudit(c, d.k, { actor, action: 'deal.person_terms_changed', entity: deal.id, detail: { change: cr.id, invitation: inv.id, terms: n } })
    await tellLeads(
      c,
      d.mail,
      deal,
      `Change to deal ${deal.public_code}`,
      asked.size
        ? "The investor's new terms are in force. They must reconfirm and sign again before the deal can ask for closing."
        : "The investor's terms are back to the ones they agreed. Nothing is asked of them.",
    )
  }

  const PersonTerms = z.strictObject({
    carry_bps: z.number().int(),
    fee: Fee,
    summary: z.string().trim().min(1).max(300),
    base_version: z.number().int().positive(),
    incentive_attested: z.boolean().default(false),
  })

  // R-CHG-02: the lead asks to change one person's terms (all their commitments share them, R-CMT-07); a reviewer decides
  app.post<{ Params: { id: string; pid: string } }>('/api/deals/:id/participations/:pid/terms', verified, async (req) => {
    const b = PersonTerms.parse(req.body)
    const who = req.user!
    const r = await d.leadTx(who, Uuid.parse(req.params.id), async (c, deal) => {
      if (deal.approved_version === null) throw new Refused('This deal cannot be changed in its state.')
      if (deal.approved_version !== b.base_version) throw new Refused('Someone has changed this deal since you opened it. Open it again.')
      if ((await c.query(`SELECT 1 FROM change_request WHERE deal_id = $1 AND ${OPEN}`, [deal.id])).rowCount) throw new Refused(ONE_OPEN)
      const inv = (
        await c.query<{ id: string; terms_snapshot: FrozenTerms | null }>(
          'SELECT i.id, i.terms_snapshot FROM participation p JOIN deal_invitation i ON i.id = p.invitation_id WHERE p.id = $1 AND p.deal_id = $2 FOR UPDATE OF i',
          [Uuid.parse(req.params.pid), deal.id],
        )
      ).rows[0]
      if (!inv?.terms_snapshot) throw new Refused(NOT_FOUND)
      const before = inv.terms_snapshot
      const snap: PersonSnapshot = { before, after: frozen(before.link_id, b.carry_bps, toFee(b.fee)), incentive_attested: b.incentive_attested }
      await personCheck(c, deal, inv.id, snap, b.summary)
      const cls: Classified = {
        changes: termsChanges(asLink(before), asLink(snap.after)),
        items: [{ field: 'link_terms', kind: 'reconfirm', limit: false }],
        belowNewMinimum: [],
        resign: true,
      }
      const id = randomUUID()
      await c.query(
        `INSERT INTO change_request (id, deal_id, base_version, proposed, proposed_snapshot, proposed_sha256, summary, classification, self_service, submitted_by, invitation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10)`,
        [id, deal.id, b.base_version, stableJson(snap.after), stableJson(snap), sha(stableJson(snap)), b.summary, stableJson(cls), who.id, inv.id],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.change_asked', entity: deal.id, detail: { change: id, invitation: inv.id } })
      await tellReviewers(
        c,
        d.mail,
        `A change to deal ${deal.public_code} needs review`,
        "A lead has asked to change one investor's terms. Sign in to review it.",
      )
      return { id, state: 'submitted' as const }
    })
    await d.mail.flush()
    return r
  })

  // ---------- the lead ----------

  const Submit = z.strictObject({ draft: z.unknown(), summary: z.string().trim().min(1).max(300), base_version: z.number().int().positive() })

  app.post<{ Params: { id: string } }>('/api/deals/:id/changes', verified, async (req) => {
    const b = Submit.parse(req.body)
    const typed = d.parseDraft(b.draft)
    const who = req.user!
    const r = await d.leadTx(who, Uuid.parse(req.params.id), async (c, deal) => {
      if (deal.approved_version === null || !['live', 'closing_requested', 'closing'].includes(deal.state))
        throw new Refused('This deal cannot be changed in its state.')
      // the page read one version: another one in force meanwhile is not what the lead changed
      if (deal.approved_version !== b.base_version) throw new Refused('Someone has changed this deal since you opened it. Open it again.')
      if ((await c.query(`SELECT 1 FROM change_request WHERE deal_id = $1 AND ${OPEN}`, [deal.id])).rowCount) throw new Refused(ONE_OPEN)
      // the syndicate and the lead's confirmations are not changed this way
      const after: Draft = { ...typed, basics: { ...typed.basics, syndicate: deal.draft.basics?.syndicate }, attestations: deal.draft.attestations }
      // R17: a change may not leave a required field empty or wrong, unless it already was
      const was = new Set(await d.gaps(c, deal, deal.draft))
      const added = (await d.gaps(c, deal, after)).filter((g) => !was.has(g))
      if (added.length) throw new Refused(`Fix these first: ${added.join(', ')}.`)
      const { c: cls } = await classifyNow(c, deal, after)
      const { snapshot } = await d.snapshotOf(c, deal.id, after)
      const self = selfServiceOnly(cls)
      const id = randomUUID()
      const row = (
        await c.query<ChangeRow>(
          `INSERT INTO change_request (id, deal_id, base_version, proposed, proposed_snapshot, proposed_sha256, summary, classification, self_service, submitted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [id, deal.id, b.base_version, stableJson(after), stableJson(snapshot), sha(stableJson(snapshot)), b.summary, stableJson(cls), self, who.id],
        )
      ).rows[0]!
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.change_asked', entity: deal.id, detail: { change: id } })
      if (self) {
        const n = await apply(c, deal, row, who.id, null)
        return { id, state: 'applied' as const, version: n }
      }
      await tellReviewers(c, d.mail, `A change to deal ${deal.public_code} needs review`, 'A lead has asked to change a live deal. Sign in to review it.')
      return { id, state: 'submitted' as const, version: null }
    })
    await d.mail.flush()
    return r
  })

  app.get<{ Params: { id: string } }>('/api/deals/:id/changes', verified, async (req) =>
    d.leadTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      const rows = (await c.query<ChangeRow>('SELECT * FROM change_request WHERE deal_id = $1 ORDER BY created_at DESC, id LIMIT 200', [deal.id])).rows
      return {
        changes: rows.map((r) => ({
          id: r.id,
          state: r.state,
          summary: r.summary,
          self_service: r.self_service,
          changes: changesInWords(r.classification.changes, deal.draft.terms?.currency ?? ''),
          verdict: r.verdict,
          verdict_reason: r.verdict_reason,
          return_reason: r.return_reason,
          version: r.applied_version,
          created_at: r.created_at,
        })),
      }
    }),
  )

  app.post<{ Params: { id: string; cid: string } }>('/api/deals/:id/changes/:cid/withdraw', verified, async (req) => {
    const who = req.user!
    return d.leadTx(who, Uuid.parse(req.params.id), async (c, deal) => {
      const cr = (await c.query<ChangeRow>('SELECT * FROM change_request WHERE id = $1 AND deal_id = $2 FOR UPDATE', [Uuid.parse(req.params.cid), deal.id]))
        .rows[0]
      if (!cr) throw new Refused(NOT_FOUND)
      if (cr.state !== 'submitted' && cr.state !== 'reviewed') throw new Refused('This change has already been decided.')
      await c.query("UPDATE change_request SET state = 'withdrawn', ended_at = clock_timestamp() WHERE id = $1", [cr.id])
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.change_withdrawn', entity: deal.id, detail: { change: cr.id } })
      return { state: 'withdrawn' as const }
    })
  })

  // ---------- review (R-CHG-02) and content approval (R-CMP-02) ----------

  /** What a reviewer or approver reads: the plain sentence, each item and its kind, and the differences people will be shown. */
  async function details(c: Q, cr: ChangeRow, deal: ChangeDeal) {
    if (cr.invitation_id) {
      const people = (await c.query("SELECT 1 FROM participation WHERE invitation_id = $1 AND outcome = 'active'", [cr.invitation_id])).rowCount!
      return {
        id: cr.id,
        deal_id: deal.id,
        public_code: deal.public_code,
        deal_state: deal.state,
        state: cr.state,
        summary: cr.summary,
        person: { commitments: people },
        items: cr.classification.items,
        needs_judgement: false,
        below_new_minimum: 0,
        resign: true,
        differences: changesInWords(cr.classification.changes, deal.draft.terms?.currency ?? ''),
        proposed_sha256: cr.proposed_sha256,
        verdict: null,
        verdict_reason: null,
        out_of_date: deal.approved_version !== cr.base_version,
        created_at: cr.created_at,
      }
    }
    const base = (
      await c.query<{ snapshot: Record<string, unknown> }>('SELECT snapshot FROM deal_version WHERE deal_id = $1 AND n = $2', [deal.id, cr.base_version])
    ).rows[0]!
    const diff: FieldChange[] = diffContent(await d.expand(c, base.snapshot), await d.expand(c, cr.proposed_snapshot))
    return {
      id: cr.id,
      deal_id: deal.id,
      public_code: deal.public_code,
      deal_state: deal.state,
      state: cr.state,
      summary: cr.summary,
      items: cr.classification.items,
      needs_judgement: needsJudgement(cr.classification),
      below_new_minimum: cr.classification.belowNewMinimum.length,
      resign: cr.classification.resign,
      differences: diff,
      proposed_sha256: cr.proposed_sha256,
      verdict: cr.verdict,
      verdict_reason: cr.verdict_reason,
      out_of_date: deal.approved_version !== cr.base_version,
      created_at: cr.created_at,
    }
  }

  app.get('/api/review/changes', reviewer, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<{ id: string; deal_id: string; state: string; summary: string; created_at: Date; public_code: string }>(
        `SELECT c.id, c.deal_id, c.state, c.summary, c.created_at, d.public_code FROM change_request c JOIN deal d ON d.id = c.deal_id
          WHERE c.${OPEN} ORDER BY c.created_at, c.id LIMIT 500`,
      )
    ).rows
    const out = []
    for (const r of rows) if (!(await hasStake(d.db, who, r.deal_id))) out.push(r)
    return { changes: out }
  })

  app.get<{ Params: { cid: string } }>('/api/review/changes/:cid', reviewer, async (req, reply) => {
    const who = req.user!
    const cr = (await d.db.query<ChangeRow>('SELECT * FROM change_request WHERE id = $1', [Uuid.parse(req.params.cid)])).rows[0]
    if (!cr || cr.self_service || (await hasStake(d.db, who, cr.deal_id))) return reply.code(404).send({ error: NOT_FOUND })
    const deal = (
      await d.db.query<ChangeDeal>(
        'SELECT id, lead_user, syndicate_id, state, draft, public_code, approved_version, bound_floor_minor, pack_id FROM deal WHERE id = $1',
        [cr.deal_id],
      )
    ).rows[0]!
    return details(d.db, cr, deal)
  })

  const Decide = z.strictObject({ verdict: z.enum(['notice', 'reconfirm']).optional(), reason: z.string().max(2000).optional(), proposed_sha256: Hash })

  app.post<{ Params: { cid: string } }>('/api/review/changes/:cid/decide', reviewer, async (req) => {
    const b = Decide.parse(req.body)
    const who = req.user!
    const r = await staffTx(who, 'reviewer', Uuid.parse(req.params.cid), async (c, cr, deal) => {
      if (cr.self_service || cr.state !== 'submitted') throw new Refused('This change is not waiting for review.')
      if (cr.proposed_sha256 !== b.proposed_sha256) throw new Refused(CHANGED)
      if (deal.approved_version !== cr.base_version) throw new Refused(MOVED)
      // one person's terms are not deal content: the reviewer's decision puts them in force (no content approval, R-CMP-02)
      if (cr.invitation_id) {
        await c.query("UPDATE change_request SET state = 'reviewed', reviewed_by = $2, reviewed_at = clock_timestamp() WHERE id = $1", [cr.id, who.id])
        await appendAudit(c, d.k, { actor: who.id, action: 'deal.change_reviewed', entity: deal.id, detail: { change: cr.id, verdict: null } })
        await applyPerson(c, deal, cr, who.id)
        return { state: 'applied' as const, version: cr.base_version }
      }
      const { c: cls } = await classifyNow(c, deal, cr.proposed)
      const judged = needsJudgement(cls)
      const j: Judgement = judged ? { verdict: b.verdict, reason: b.reason } : {}
      const decision = decideChange(cls, deal.state as never, j)
      if (!decision.ok) throw new Refused(decision.reason)
      await c.query(
        "UPDATE change_request SET state = 'reviewed', verdict = $2, verdict_reason = $3, reviewed_by = $4, reviewed_at = clock_timestamp() WHERE id = $1",
        [cr.id, judged ? b.verdict : null, judged ? b.reason!.trim() : null, who.id],
      )
      await appendAudit(c, d.k, {
        actor: who.id,
        action: 'deal.change_reviewed',
        entity: deal.id,
        detail: { change: cr.id, verdict: judged ? b.verdict : null },
      })
      // R-CMP-02: with no content approval asked for, the review is what puts it in force
      if (!(await approvalNeeded(c))) {
        const reviewed = { ...cr, verdict: judged ? b.verdict! : null, verdict_reason: judged ? b.reason!.trim() : null, reviewed_by: who.id }
        return { state: 'applied' as const, version: await apply(c, deal, reviewed, who.id, who.id) }
      }
      return { state: 'reviewed' as const, version: null }
    })
    await d.mail.flush()
    return r
  })

  app.post<{ Params: { cid: string } }>('/api/review/changes/:cid/return', reviewer, async (req) => {
    const b = z.strictObject({ reason: Reason }).parse(req.body)
    const who = req.user!
    const r = await staffTx(who, 'reviewer', Uuid.parse(req.params.cid), async (c, cr, deal) => {
      if (cr.self_service || (cr.state !== 'submitted' && cr.state !== 'reviewed')) throw new Refused('This change is not waiting for a decision.')
      await c.query("UPDATE change_request SET state = 'returned', return_reason = $2, ended_at = clock_timestamp() WHERE id = $1", [cr.id, b.reason])
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.change_returned', entity: deal.id, detail: { change: cr.id } })
      await tellLeads(c, d.mail, deal, `Change to deal ${deal.public_code}`, `Your change was not accepted. Reason: ${b.reason}`)
      return { state: 'returned' as const }
    })
    await d.mail.flush()
    return r
  })

  // what an approver needs to know what they approve: only changes that passed review, and only with no stake
  app.get('/api/approvals/changes', approver, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<{ id: string; deal_id: string; summary: string; reviewed_at: Date; public_code: string }>(
        `SELECT c.id, c.deal_id, c.summary, c.reviewed_at, d.public_code FROM change_request c JOIN deal d ON d.id = c.deal_id
          WHERE c.state = 'reviewed' ORDER BY c.reviewed_at, c.id LIMIT 500`,
      )
    ).rows
    const out = []
    for (const r of rows) if (!(await hasStake(d.db, who, r.deal_id))) out.push(r)
    return { changes: out }
  })

  app.get<{ Params: { cid: string } }>('/api/approvals/changes/:cid', approver, async (req, reply) => {
    const who = req.user!
    const cr = (await d.db.query<ChangeRow>("SELECT * FROM change_request WHERE id = $1 AND state = 'reviewed'", [Uuid.parse(req.params.cid)])).rows[0]
    if (!cr || (await hasStake(d.db, who, cr.deal_id))) return reply.code(404).send({ error: NOT_FOUND })
    const deal = (
      await d.db.query<ChangeDeal>(
        'SELECT id, lead_user, syndicate_id, state, draft, public_code, approved_version, bound_floor_minor, pack_id FROM deal WHERE id = $1',
        [cr.deal_id],
      )
    ).rows[0]!
    return { ...(await details(d.db, cr, deal)), content: await d.expand(d.db, cr.proposed_snapshot) }
  })

  const Approve = z.strictObject({
    content_sha256: Hash,
    self_declared_name: z.string().trim().min(1).max(200),
    self_declared_frn: z
      .string()
      .regex(/^\d{6,7}$/)
      .nullable()
      .optional(),
  })

  // R-CMP-02: the approver records approval of exactly the content the reviewer passed; the change takes effect with it
  app.post<{ Params: { cid: string } }>('/api/approvals/changes/:cid', approver, async (req) => {
    const b = Approve.parse(req.body)
    const who = req.user!
    const r = await staffTx(who, 'approver', Uuid.parse(req.params.cid), async (c, cr, deal) => {
      if (cr.state !== 'reviewed') throw new Refused('Only a change that has passed review can be approved.')
      if (cr.proposed_sha256 !== b.content_sha256) throw new Refused(CHANGED)
      if (!canApproveDealContent(who, who.email, await d.partiesOf(c, deal))) throw new Refused(STAKE)
      // a stake taken on after the review undoes it (R-REV-04)
      const reviewer = (await c.query<{ id: string; email: string }>('SELECT id, email FROM user_account WHERE id = $1', [cr.reviewed_by])).rows[0]!
      if (isInterestedParty(reviewer, await d.partiesOf(c, deal)) || (await hasStake(c, reviewer, deal.id)))
        throw new Refused('The reviewer of this change now has a stake in the deal. It must be reviewed again.')
      const n = await apply(c, deal, cr, who.id, who.id)
      await c.query(
        "INSERT INTO promotion_approval (id, subject_kind, subject_id, approver_user, self_declared_name, self_declared_frn, approved_on, content_sha256) VALUES ($1, 'deal_version', $2, $3, $4, $5, $6, $7)",
        [randomUUID(), `${deal.id}:${n}`, who.id, b.self_declared_name, b.self_declared_frn ?? null, d.now().toISOString().slice(0, 10), cr.proposed_sha256],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.content_approved', entity: deal.id, detail: { version: n } })
      return { state: 'applied' as const, version: n }
    })
    await d.mail.flush()
    return r
  })
}
