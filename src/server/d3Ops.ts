// D3 operator routes: compliance holds, approving link terms, recording receipts, the switches and the deal sheet template
// (PRD R-CMP-01, R-CMP-03, R-LNK-06, R-PAY-09, R-SIG-02, R-OP-05).
import type { UrgentKind } from '../lib/mailContent.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { activeHold } from '../lib/gate.ts'
import { isSingleAdminException } from '../lib/instance.ts'
import { renderPdf } from './pdf.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { refreshRelationship } from './allocation.ts'
import { currentStaff, sessionStillLive, type SessionUser } from './auth.ts'
import {
  approvedSnapshot,
  dealById,
  dealGateFacts,
  EXECUTED,
  heldMinor,
  holdsOn,
  packOf,
  participationStatus,
  policyNow,
  REAL_SINCE,
  voidInstruction,
  type Q,
} from './d3Core.ts'
import { adminTx, changePolicy, Refused, requestPaymentChange, reviewerTx, type Ctx, type PolicyInput } from './requests.ts'
import type { MailQueue } from './outbox.ts'
import { apply, hasStake as stakeIn, loadMoney, recordReceipt, save } from './ledger.ts'

export interface D3OpsDeps {
  db: Db
  k: Keyring
  now?: () => Date
  paymentFile?: string
  mail: MailQueue
  /** From the investor routes: the deal sheet as it would be signed now, and whether a person is eligible on a deal. */
  sheetFor: (
    c: Q,
    pid: string,
    date?: string,
  ) => Promise<{ lead: string; body: string; date: string; sha256: string; template: { id: string; needs_deed: boolean } }>
  qualified: (c: Q, userId: string, dealId: string) => Promise<boolean>
}

const Uuid = z.uuid()
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const NOT_FOUND = 'Not found.'

/** R-CMP-01: the urgent notice, with no deal content. The same words for a hold and for its release. */

export function registerD3Ops(app: FastifyInstance, d: D3OpsDeps) {
  const x: Ctx = { db: d.db, k: d.k, paymentFile: d.paymentFile, mail: d.mail }
  const reviewer = { config: { gate: 'canReviewDeals' as const } }
  const money = { config: { gate: 'canRecordMoney' as const } }
  /** R-PAY-09: a reviewer or an admin, checked again once the instance row is held. */
  function moneyTx<T>(who: SessionUser, fn: (c: Tx) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const r = await c.query(
        "SELECT 1 FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.user_id = $1 AND g.role IN ('reviewer', 'admin') AND u.mfa_enabled_at IS NOT NULL AND u.email_verified_at IS NOT NULL",
        [who.id],
      )
      if (!r.rowCount) throw new Refused('Only a reviewer or an admin can do this.')
      return fn(c)
    })
  }
  const admin = { config: { gate: 'canAdministerInstance' as const } }
  const kycReviewer = { config: { gate: 'canReviewKyc' as const } }

  /** Committed people with valid instructions who still owe money (R-CMP-01). */
  async function owing(c: Q, where: string, params: unknown[]) {
    const rows = (
      await c.query<{ id: string; user_id: string; email: string; public_code: string; cash_due_minor: string }>(
        `SELECT p.id, p.user_id, u.email, d.public_code, p.cash_due_minor FROM participation p JOIN user_account u ON u.id = p.user_id JOIN deal d ON d.id = p.deal_id
          WHERE p.outcome = 'active' AND EXISTS (SELECT 1 FROM issued_instruction i WHERE i.participation_id = p.id AND i.voided_at IS NULL) AND ${where}`,
        params,
      )
    ).rows
    const out: Array<{ userId: string; email: string; code: string }> = []
    for (const r of rows) if ((await heldMinor(c, r.id)) < BigInt(r.cash_due_minor)) out.push({ userId: r.user_id, email: r.email, code: r.public_code })
    return out
  }
  const urgent = (c: Q, m: { userId: string; email: string; code?: string }, kind: UrgentKind) => d.mail.urgent(c, kind, { userId: m.userId, to: m.email, code: m.code })
  const scopeOf = (level: string) => (level === 'deal' ? 'p.deal_id = $1' : level === 'lead' ? 'd.lead_user = $1' : 'true')

  /** A stake in a deal: running it, working on it, carry from it (R-REV-04), or money in it as an investor. */
  const hasStake = (c: Q, who: { id: string; email: string }, deal: { id: string }) => stakeIn(c, who, deal.id)

  /** R-CMP-01: someone a hold is about, who may neither end it nor read its reason. */
  async function affectedBy(c: Q, h: { level: string; target_id: string | null }, who: { id: string; email: string }): Promise<boolean> {
    if (h.level === 'lead' && h.target_id === who.id) return true
    const deals =
      h.level === 'deal'
        ? (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1', [h.target_id])).rows
        : h.level === 'lead'
          ? // a lead-level hold is about every deal that lead runs: their team and carry recipients have a stake too
            (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE lead_user = $1 AND deleted_at IS NULL', [h.target_id])).rows
          : // an instance hold is about every deal that has gone live; a stake in any of them is a stake in the hold
            (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE went_live_at IS NOT NULL AND deleted_at IS NULL')).rows
    for (const deal of deals) if (await hasStake(c, who, deal)) return true
    return false
  }

  /** Only people under no hold that is still in force hear that a pause has ended (R-CMP-01). */
  async function stillHeld(c: Q, code: string) {
    const deal = (await c.query<{ id: string }>('SELECT id FROM deal WHERE public_code = $1', [code])).rows[0]
    const full = deal ? await dealById(c, deal.id) : null
    return !full || activeHold(await holdsOn(c, full))
  }

  // ---------- Compliance holds (R-CMP-01) ----------

  const HoldBody = z.strictObject({
    level: z.enum(['deal', 'lead', 'instance']),
    target_id: z.uuid().nullable().optional(),
    reason: z.string().trim().min(3).max(2000),
  })

  app.post('/api/holds', reviewer, async (req) => {
    const b = HoldBody.parse(req.body)
    const who = req.user!
    if ((b.level === 'instance') !== !b.target_id) throw new Refused(b.level === 'instance' ? 'An instance hold has no target.' : 'Say which deal or lead.')
    await reviewerTx(x, who, async (c) => {
      // every investor and lead write holds the instance row in share mode: taking it for update here waits for those in
      // flight, and makes those after see the hold, at every level (R-CMP-01)
      await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR UPDATE')
      if (b.level === 'deal' && !(await dealById(c, b.target_id!, true))) throw new Refused(NOT_FOUND)
      if (b.level === 'lead' && !(await c.query('SELECT 1 FROM user_account WHERE id = $1', [b.target_id])).rowCount) throw new Refused(NOT_FOUND)
      const id = randomUUID()
      await c.query('INSERT INTO compliance_hold (id, level, target_id, reason, applied_by) VALUES ($1, $2, $3, $4, $5)', [
        id,
        b.level,
        b.target_id ?? null,
        b.reason,
        who.id,
      ])
      // the reason may hold personal information or tip someone off, so it stays out of the audit row
      await appendAudit(c, d.k, { actor: who.id, action: `hold.applied.${b.level}`, entity: id })
      for (const m of await owing(c, scopeOf(b.level), b.level === 'instance' ? [] : [b.target_id])) await urgent(c, m, 'hold')
    })
    await d.mail.flush()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/holds/:id/release', reviewer, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    await reviewerTx(x, who, async (c) => {
      const h = (
        await c.query<{ level: string; target_id: string | null; applied_by: string; released_at: Date | null }>(
          'SELECT * FROM compliance_hold WHERE id = $1 FOR UPDATE',
          [id],
        )
      ).rows[0]
      if (!h) throw new Refused(NOT_FOUND)
      if (h.released_at) throw new Refused('This hold has already ended.')
      const mode = (await c.query<{ mode: 'sandbox' | 'real' }>('SELECT mode FROM instance_profile WHERE id = 1')).rows[0]!.mode
      const staff = await currentStaff(c)
      const admins = staff.filter((s) => s.roles.includes('admin')).map((s) => s.userId)
      // R-CMP-01: someone else ends it; the sandbox's only admin is the one exception, as for other two-person steps
      const single = isSingleAdminException({
        mode,
        requestedBy: h.applied_by,
        approver: who.id,
        adminCount: admins.length,
        approverIsAdmin: admins.includes(who.id),
      })
      if (h.applied_by === who.id && !single) throw new Refused('Someone else must end a hold you applied.')
      if (await affectedBy(c, h, who)) throw new Refused('You cannot end a pause on a deal you have a stake in.')
      await c.query('UPDATE compliance_hold SET released_by = $2, released_at = clock_timestamp(), single_admin_exception = $3 WHERE id = $1', [
        id,
        who.id,
        single,
      ])
      await appendAudit(c, d.k, { actor: who.id, action: `hold.released.${h.level}`, entity: id })
      for (const m of await owing(c, scopeOf(h.level), h.level === 'instance' ? [] : [h.target_id])) if (!(await stillHeld(c, m.code))) await urgent(c, m, 'hold_ended')
    })
    await d.mail.flush()
    return { ok: true }
  })

  app.get('/api/holds', reviewer, async (req) => {
    const rows = (
      await d.db.query<{ id: string; level: string; target_id: string | null; reason: string }>(
        `SELECT h.id, h.level, h.target_id, h.reason, h.applied_at, h.released_at, a.name AS applied_by, r.name AS released_by
           FROM compliance_hold h JOIN user_account a ON a.id = h.applied_by LEFT JOIN user_account r ON r.id = h.released_by
          WHERE h.applied_at >= ${REAL_SINCE} ORDER BY h.released_at IS NULL DESC, h.applied_at DESC LIMIT 200`,
      )
    ).rows
    // a reviewer with a stake sees that a pause exists, never why (R-CMP-01)
    const out = []
    for (const r of rows) out.push((await affectedBy(d.db, r, req.user!)) ? { ...r, reason: null, affects_you: true } : r)
    return { holds: out }
  })

  // ---------- Link terms waiting for a reviewer (R-LNK-06) ----------

  app.get('/api/review/links', reviewer, async (req) => {
    const rows = (
      await d.db.query<{
        id: string
        deal_id: string
        public_code: string
        label: string
        carry_bps: number
        fee_kind: string
        fee_bps: number | null
        fee_minor: string | null
        fee_mode: string | null
        reason: string | null
        incentive_attested: boolean
        created_at: Date
      }>(
        `SELECT l.id, l.deal_id, d.public_code, coalesce(d.draft->'terms'->>'currency', 'GBP') AS currency, l.label, l.carry_bps, l.fee_kind, l.fee_bps, l.fee_minor, l.fee_mode, l.reason, l.incentive_attested, l.created_at
           FROM invite_link l JOIN deal d ON d.id = l.deal_id
          WHERE l.needs_approval AND l.terms_approved_at IS NULL AND l.disabled_at IS NULL ORDER BY l.created_at LIMIT 500`,
      )
    ).rows
    const out = []
    for (const r of rows) {
      const deal = (await d.db.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1', [r.deal_id])).rows[0]
      if (await hasStake(d.db, req.user!, deal)) continue
      out.push(r)
    }
    return { links: out }
  })

  app.post<{ Params: { id: string } }>('/api/review/links/:id/approve', reviewer, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    return reviewerTx(x, who, async (c) => {
      const l = (
        await c.query<{ deal_id: string; needs_approval: boolean; terms_approved_at: Date | null }>(
          'SELECT deal_id, needs_approval, terms_approved_at FROM invite_link WHERE id = $1 FOR UPDATE',
          [id],
        )
      ).rows[0]
      if (!l || !l.needs_approval) throw new Refused(NOT_FOUND)
      if (l.terms_approved_at) throw new Refused('These terms are already approved.')
      const deal = (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1 FOR SHARE', [l.deal_id])).rows[0]
      // R-REV-04: the same conflict rule as reviewing the deal
      if (await hasStake(c, who, deal)) throw new Refused('You cannot review a deal you lead, work on, or receive carry from.')
      await c.query('UPDATE invite_link SET terms_approved_by = $2, terms_approved_at = clock_timestamp() WHERE id = $1', [id, who.id])
      await appendAudit(c, d.k, { actor: who.id, action: 'link.terms_approved', entity: id })
      return { ok: true }
    })
  })

  // ---------- Receipts recorded by hand (R-PAY-09, R-ENT-06) ----------

  /** Deals taking money, for reviewers and admins to find where to record it (R-PAY-09). */
  app.get('/api/review/live-deals', money, async () => ({
    deals: (
      await d.db.query(
        `SELECT d.id, d.public_code, d.draft->'basics'->>'name' AS name FROM deal d WHERE d.state = 'live' AND d.deleted_at IS NULL AND d.went_live_at >= ${REAL_SINCE} ORDER BY d.went_live_at DESC LIMIT 200`,
      )
    ).rows,
  }))

  /** Staff see who is in the deal and where each stands; read-only for the roster (R-OPS-01). */
  app.get<{ Params: { id: string } }>('/api/review/deals/:id/participations', money, async (req) => {
    const id = Uuid.parse(req.params.id)
    const deal = await dealById(d.db, id)
    if (!deal) throw new Refused(NOT_FOUND)
    // staff with a stake (a lead holding a staff role, a team member, an investor) see no roster: it shows refusals (R-KYC-02.1)
    const row = (await d.db.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1', [id])).rows[0]
    if (await hasStake(d.db, req.user!, row)) throw new Refused('You cannot see money records for a deal you lead, work on, receive carry from or invest in.')
    const pack = await packOf(d.db, deal)
    const snap = await approvedSnapshot(d.db, deal)
    const rows = (
      await d.db.query<{
        id: string
        reference: string
        outcome: never
        cash_due_minor: string
        name: string
        email: string
        entity_id: string
        entity_version: number
        identity_review: string
        deed_status: 'sent' | 'signed' | null
      }>(
        `SELECT p.id, p.reference, p.outcome, p.cash_due_minor, u.name, u.email, p.entity_id, p.entity_version, p.identity_review,
                (SELECT s.external_status FROM signature_record s WHERE s.participation_id = p.id AND s.superseded_at IS NULL AND s.provider = 'external') AS deed_status
           FROM participation p JOIN user_account u ON u.id = p.user_id
          WHERE p.deal_id = $1 AND p.created_at >= ${REAL_SINCE} ORDER BY p.join_seq`,
        [id],
      )
    ).rows
    const out = []
    for (const r of rows) {
      const held = await heldMinor(d.db, r.id)
      // the status from the real facts, as the investor sees it (§5.2)
      const st = pack
        ? await participationStatus(d.db, { ...r, entity_version: r.entity_version, invested_minor: null }, pack, (d.now?.() ?? new Date()).toISOString().slice(0, 10), d.now?.())
        : null
      const s = st ? { status: st.status, overlays: st.overlays } : null
      const receipts = (
        await d.db.query(
          'SELECT id, amount_minor, moved_out_minor, source, currency, received_on, payer_name, payer_account, payer_mismatch, reversed_at, reverse_reason, created_at FROM receipt WHERE participation_id = $1 ORDER BY created_at',
          [r.id],
        )
      ).rows
      out.push({
        ...r,
        held_minor: String(held),
        status: s?.status ?? null,
        status_label: st?.label ?? null,
        overlays: s?.overlays ?? [],
        receipts,
      })
    }
    return { deal_code: deal.public_code, currency: snap?.snapshot.terms?.currency ?? 'GBP', participations: out }
  })

  const ReceiptBody = z.strictObject({
    amount_minor: z.string().regex(/^[1-9]\d{0,11}$/),
    received_on: z.iso.date().refine((v) => v >= '2000-01-01'),
    // R-PAY-09: always written; "unknown" when not known
    payer_name: z.string().trim().min(1).max(200),
    payer_account: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).optional(),
  })

  app.post<{ Params: { id: string } }>('/api/review/participations/:id/receipts', money, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = ReceiptBody.parse(req.body)
    if (BigInt(b.amount_minor) > 100_000_000_000n) throw new Refused('The amount is above the largest allowed.')
    const out = await moneyTx(who, async (c) => {
      const p = (
        await c.query<{ id: string; deal_id: string; entity_id: string; user_id: string }>(
          'SELECT id, deal_id, entity_id, user_id FROM participation WHERE id = $1',
          [pid],
        )
      ).rows[0]
      if (!p) throw new Refused(NOT_FOUND)
      const deal = (await dealById(c, p.deal_id, true))!
      // R-PAY-09: from live on, at any time; never by the lead or anyone with a stake
      if (!['live', 'closing_requested', 'closing', 'settled', 'closed', 'cancelled', 'archived'].includes(deal.state))
        throw new Refused('Receipts are recorded from launch on.')
      const dealRowForStake = (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1', [deal.id])).rows[0]
      // an investor in the deal has money in it: they record no money on it either
      if (await hasStake(c, who, dealRowForStake)) throw new Refused('You cannot record money for a deal you lead, work on, receive carry from or invest in.')
      const snap = await approvedSnapshot(c, deal)
      const r = await recordReceipt(c, d.k, d.mail, who.id, {
        participationId: pid,
        amount: BigInt(b.amount_minor),
        currency: snap?.snapshot.terms?.currency ?? 'GBP',
        receivedOn: b.received_on,
        payerName: b.payer_name,
        payerAccount: b.payer_account,
        note: b.note ?? null,
        source: 'manual',
      })
      return { id: r.id, payer_mismatch: r.payerMismatch }
    })
    await d.mail.flush()
    return out
  })

  app.post<{ Params: { id: string } }>('/api/review/receipts/:id/reverse', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ reason: z.string().trim().min(3).max(2000) }).parse(req.body)
    return moneyTx(who, async (c) => {
      const r = (
        await c.query<{ participation_id: string; reversed_at: Date | null }>('SELECT participation_id, reversed_at FROM receipt WHERE id = $1 FOR UPDATE', [
          id,
        ])
      ).rows[0]
      if (!r) throw new Refused(NOT_FOUND)
      if (r.reversed_at) throw new Refused('This receipt is already reversed.')
      const dealOf = (await c.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [r.participation_id])).rows[0]!
      await dealById(c, dealOf.deal_id, true)
      const dealRow = (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1', [dealOf.deal_id])).rows[0]
      if (await hasStake(c, who, dealRow)) throw new Refused('You cannot change money records for a deal you lead, work on, receive carry from or invest in.')
      // C-FEE-4: the release on it goes with it; occupation and release over the new N are cut in the same step
      const before = (await loadMoney(c, r.participation_id, true))!
      const after = apply(before, { kind: 'reverse', receipt: id })
      await c.query('UPDATE receipt SET reversed_at = clock_timestamp(), reversed_by = $2, reverse_reason = $3 WHERE id = $1', [id, who.id, b.reason])
      await save(c, before, after, who.id)
      // §5.2: the status follows the money back, and the change is in the audit
      await c.query('INSERT INTO participation_event (id, participation_id, event, actor, detail) VALUES ($1, $2, $3, $4, $5)', [
        randomUUID(),
        r.participation_id,
        'receipt_reversed',
        who.id,
        JSON.stringify({ receipt: id }),
      ])
      await appendAudit(c, d.k, { actor: who.id, action: 'receipt.reversed', entity: id })
      return { ok: true }
    })
  })

  // ---------- The operator's switches (R-CMP-03) ----------

  const PolicyBody = z.strictObject({
    per_link_terms: z.boolean(),
    generic_links: z.boolean(),
    bulk_promo: z.boolean(),
    export_roles: z.array(z.enum(['admin', 'reviewer', 'lead'])).max(3),
    reminder_count: z.number().int().min(0).max(10),
    reminder_every_days: z.number().int().min(0).max(30),
    // left out = kept as it is; null = nothing said
    cancel_fee_note: z.string().trim().min(1).max(2000).nullable().optional(),
    amount_proposal_days: z.number().int().min(1).max(30).optional(),
    reconfirm_days: z.number().int().min(1).max(30).optional(),
    complaints_email: z.email().max(320).nullable().optional(),
  })
  const asInput = (p: Awaited<ReturnType<typeof policyNow>>): PolicyInput & { version: number } => ({
    version: p.version,
    per_link_terms: p.perLinkTerms,
    generic_links: p.genericLinks,
    bulk_promo: p.bulkPromo,
    export_roles: p.exportRoles as PolicyInput['export_roles'],
    reminder_count: p.reminderCount,
    reminder_every_days: p.reminderEveryDays,
    cancel_fee_note: p.cancelFeeNote,
    amount_proposal_days: p.amountProposalDays,
    reconfirm_days: p.reconfirmDays,
    complaints_email: p.complaintsEmail,
  })

  app.get('/api/admin/policy', admin, async () => asInput(await policyNow(d.db)))
  app.put('/api/admin/policy', admin, async (req) => {
    const b = PolicyBody.parse(req.body)
    const now = await policyNow(d.db)
    const note = b.cancel_fee_note === undefined ? now.cancelFeeNote : b.cancel_fee_note
    return changePolicy(x, req.user!, {
      ...b,
      export_roles: [...new Set(b.export_roles)],
      cancel_fee_note: note,
      amount_proposal_days: b.amount_proposal_days ?? now.amountProposalDays,
      reconfirm_days: b.reconfirm_days ?? now.reconfirmDays,
      complaints_email: b.complaints_email === undefined ? now.complaintsEmail : b.complaints_email,
    })
  })

  // ---------- Receiving account change (R-OP-05): from the mounted file, approved by a second admin ----------

  app.post('/api/admin/receiving-accounts/reload', admin, async (req) => ({ request_id: await requestPaymentChange(x, req.user!) }))

  // ---------- The deal sheet template (R-SIG-02) ----------

  app.get('/api/admin/templates/deal-sheet', admin, async () => {
    const t = (
      await d.db.query(
        "SELECT version, body, needs_deed, is_placeholder, created_at FROM document_template WHERE kind = 'deal_sheet' ORDER BY version DESC LIMIT 1",
      )
    ).rows[0]
    return {
      template: t ?? null,
      slots: [
        'deal_code',
        'company_name',
        'instrument',
        'investor_name',
        'entity_name',
        'breakdown',
        'commitment',
        'investment_part',
        'lead_fee',
        'rounding',
        'amount_to_pay',
        'carry',
        'fee_terms',
        'reference',
        'date',
        'custom_terms',
      ],
    }
  })
  app.put('/api/admin/templates/deal-sheet', admin, async (req) => {
    const b = z.strictObject({ body: z.string().trim().min(20).max(100_000), needs_deed: z.boolean() }).parse(req.body)
    return adminTx(x, req.user!, async (c: Tx) => {
      const v = (await c.query<{ v: number }>("SELECT coalesce(max(version), 0) AS v FROM document_template WHERE kind = 'deal_sheet'")).rows[0]!.v + 1
      const id = randomUUID()
      // the shipped wording saved again, unchanged or edited, stays a placeholder while it keeps its placeholder heading: it can
      // be neither approved nor signed in the real mode (Codex round 8)
      const placeholder = /PLACEHOLDER DEAL SHEET/i.test(b.body)
      await c.query(
        "INSERT INTO document_template (id, kind, version, body, needs_deed, is_placeholder, sha256, created_by) VALUES ($1, 'deal_sheet', $2, $3, $4, $5, $6, $7)",
        [id, v, b.body, b.needs_deed, placeholder, sha(b.body), req.user!.id],
      )
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'template.deal_sheet_saved', entity: id })
      return { version: v }
    })
  })

  // R-CMP-02: an approver approves a template version's exact wording, under the same conflict-free role as deal content
  const approver = { config: { gate: 'canApproveContent' as const } }
  app.get('/api/approvals/templates', approver, async () => ({
    templates: (
      await d.db.query(
        `SELECT t.id, t.kind, t.version, t.body, t.needs_deed, t.is_placeholder, t.sha256,
                EXISTS (SELECT 1 FROM promotion_approval a WHERE a.subject_kind = 'template' AND a.subject_id = t.id::text AND a.content_sha256 = t.sha256 AND a.created_at >= ${REAL_SINCE}) AS approved
           FROM document_template t WHERE t.kind = 'deal_sheet' ORDER BY t.version DESC LIMIT 5`,
      )
    ).rows,
  }))
  app.post<{ Params: { id: string } }>('/api/approvals/templates/:id', approver, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z
      .strictObject({
        content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        self_declared_name: z.string().trim().min(1).max(200),
        self_declared_frn: z
          .string()
          .regex(/^\d{6,7}$/)
          .nullable()
          .optional(),
      })
      .parse(req.body)
    return tx(d.db, async (c) => {
      await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const ok = await c.query(
        "SELECT 1 FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.user_id = $1 AND g.role = 'approver' AND u.mfa_enabled_at IS NOT NULL",
        [who.id],
      )
      if (!ok.rowCount) throw new Refused('Only an approver can do this.')
      const t = (await c.query<{ sha256: string; is_placeholder: boolean }>('SELECT sha256, is_placeholder FROM document_template WHERE id = $1', [id])).rows[0]
      if (!t) throw new Refused(NOT_FOUND)
      if (t.is_placeholder) throw new Refused('Placeholder wording cannot be approved.')
      // what the approver read is what is approved
      if (t.sha256 !== b.content_sha256) throw new Refused('This template has changed since you opened it. Open it again.')
      await c.query(
        "INSERT INTO promotion_approval (id, subject_kind, subject_id, approver_user, self_declared_name, self_declared_frn, approved_on, content_sha256) VALUES ($1, 'template', $2, $3, $4, $5, current_date, $6)",
        [randomUUID(), id, who.id, b.self_declared_name, b.self_declared_frn ?? null, t.sha256],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'template.approved', entity: id })
      return { ok: true }
    })
  })

  /**
   * R-SIG-04: a deed or witnessed signature happens outside the site in two steps. Sending saves the exact document and what
   * it is bound to; recording marks that saved document signed, and is refused if it is no longer the current one, so the
   * record never certifies figures the investor did not sign (Codex round 5). Both steps pass the signing gate.
   */
  async function deedGate(c: Tx, who: SessionUser, pid: string) {
    const dealId = (await c.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [pid])).rows[0]?.deal_id
    const deal = dealId ? await dealById(c, dealId, true) : null
    if (!deal) throw new Refused(NOT_FOUND)
    const p = (
      await c.query<{ id: string; user_id: string; entity_id: string; entity_version: number; terms_version: number; identity_review: string }>(
        "SELECT id, user_id, entity_id, entity_version, terms_version, identity_review FROM participation WHERE id = $1 AND outcome = 'active' FOR UPDATE",
        [pid],
      )
    ).rows[0]
    if (!p) throw new Refused(NOT_FOUND)
    const dealRow = (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1', [deal.id])).rows[0]
    if (await hasStake(c, who, dealRow)) throw new Refused('You cannot record a signature for a deal you lead, work on, or receive carry from.')
    // the shared deal facts: they count a sandbox deal stopped at the switch as held for good (R25)
    if (activeHold((await dealGateFacts(c, deal)).holds)) throw new Refused('Nothing new can be done on this deal now.')
    if (!['live', 'closing_requested', 'closing'].includes(deal.state)) throw new Refused('Signatures are recorded while the deal is open.')
    const ent = (
      await c.query<{ current_version: number; rejected_at: Date | null }>('SELECT current_version, rejected_at FROM legal_entity WHERE id = $1', [p.entity_id])
    ).rows[0]!
    // only a check made since the switch to real counts, as for signing on the site (decision R13)
    const kyc = await c.query(
      `SELECT 1 FROM kyc_case WHERE entity_id = $1 AND entity_version = $2 AND status = 'approved' AND expires_on > current_date AND created_at >= ${REAL_SINCE}`,
      [p.entity_id, ent.current_version],
    )
    const pack = (await packOf(c, deal))!
    const at = (k: string) => pack.steps.findIndex((x) => x.kind === k)
    const kycFirst = at('kyc') >= 0 && at('kyc') < at('sign')
    if (p.identity_review === 'pending' || p.entity_version !== ent.current_version || ent.rejected_at || (kycFirst && !kyc.rowCount))
      throw new Refused('This person cannot sign yet: the identity check is not complete.')
    if (!(await d.qualified(c, p.user_id, deal.id))) throw new Refused('This person cannot sign: their investor statement is not in force.')
    const sheet = await d.sheetFor(c, p.id)
    if (!sheet.template.needs_deed) throw new Refused('The deal sheet is signed on this site.')
    return { deal, p, sheet }
  }

  app.post<{ Params: { id: string } }>('/api/review/participations/:id/deed-sent', kycReviewer, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const done = await reviewerTx(x, who, async (c) => {
      const { deal, p, sheet } = await deedGate(c, who, pid)
      // a new document replaces the old signature, so an instruction bound to the old one is void (R-PAY-03)
      if (await voidInstruction(c, d.k, p.id, 'signature_replaced', who.id)) {
        const u = (await c.query<{ email: string }>('SELECT email FROM user_account WHERE id = $1', [p.user_id])).rows[0]!
        await urgent(c, { userId: p.user_id, email: u.email, code: deal.public_code }, 'void_signature_replaced')
      }
      // a document already executed is never replaced by one merely sent (Codex round 6); an unsigned one sent before is
      const executed = await c.query(`SELECT 1 FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL AND ${EXECUTED}`, [p.id])
      if (executed.rowCount) throw new Refused('This person has already signed the current deal sheet.')
      await c.query('UPDATE signature_record SET superseded_at = clock_timestamp() WHERE participation_id = $1 AND superseded_at IS NULL', [p.id])
      const id = randomUUID()
      const document = `${sheet.lead}\n\n${sheet.body}`
      await c.query(
        `INSERT INTO signature_record (id, participation_id, entity_version, terms_version, template_id, document, document_lead, document_sha256, provider, signed_name, ip, auth_method, external_status, document_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'external', $9, $10, 'external', 'sent', $11)`,
        // the hash is of exactly what is kept; the date in it is kept too, so recording it another day compares like with like
        [
          id,
          p.id,
          p.entity_version,
          p.terms_version,
          sheet.template.id,
          document,
          sheet.lead,
          sha(document),
          `Sent for signature by ${who.name}`,
          req.ip,
          sheet.date,
        ],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'participation.deed_sent', entity: id })
      return { ok: true, document }
    })
    await d.mail.flush()
    return done
  })

  app.post<{ Params: { id: string } }>('/api/review/participations/:id/deed-signed', kycReviewer, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    return reviewerTx(x, who, async (c) => {
      const { p } = await deedGate(c, who, pid)
      const sent = (
        await c.query<{ id: string; document: string; terms_version: number; entity_version: number; document_date: string }>(
          "SELECT id, document, terms_version, entity_version, to_char(document_date, 'YYYY-MM-DD') AS document_date FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL AND provider = 'external' AND external_status = 'sent' FOR UPDATE",
          [p.id],
        )
      ).rows[0]
      if (!sent) throw new Refused('No document has been sent for signing. Send it first.')
      // what was sent must still be what would be sent now, made on the day it was sent: the same terms, identity, figures and wording
      const sheet = await d.sheetFor(c, p.id, sent.document_date ?? undefined)
      if (sent.terms_version !== p.terms_version || sent.entity_version !== p.entity_version || sent.document !== `${sheet.lead}\n\n${sheet.body}`)
        throw new Refused('The document sent for signing is no longer current. Send the new one.')
      await c.query("UPDATE signature_record SET external_status = 'signed', signed_name = $2, signed_at = clock_timestamp() WHERE id = $1", [
        sent.id,
        `Signed outside this site; recorded by ${who.name}`,
      ])
      await appendAudit(c, d.k, { actor: who.id, action: 'participation.deed_recorded', entity: sent.id })
      return { ok: true }
    })
  })

  // R-SIG-04: the exact document saved when the deed was sent, for the reviewer to send and have signed outside (Codex round 6)
  app.get<{ Params: { id: string } }>('/api/review/participations/:id/deed', kycReviewer, async (req, reply) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const doc = await tx(d.db, async (c) => {
      const row = (
        await c.query('SELECT d.id, d.lead_user, d.syndicate_id, d.draft FROM participation p JOIN deal d ON d.id = p.deal_id WHERE p.id = $1', [pid])
      ).rows[0]
      if (!row) throw new Refused(NOT_FOUND)
      if (await hasStake(c, who, row)) throw new Refused('You cannot record a signature for a deal you lead, work on, or receive carry from.')
      const s = (
        await c.query<{ document: string; document_lead: string; external_status: string; signed_name: string; signed_at: Date }>(
          "SELECT document, document_lead, external_status, signed_name, signed_at FROM signature_record WHERE participation_id = $1 AND superseded_at IS NULL AND provider = 'external'",
          [pid],
        )
      ).rows[0]
      if (!s) throw new Refused('No document has been sent for signing. Send it first.')
      return s
    })
    const body =
      doc.document_lead && doc.document.startsWith(doc.document_lead) ? doc.document.slice(doc.document_lead.length).replace(/^\n\n/, '') : doc.document
    const pdf = await renderPdf(
      [
        ...(doc.document_lead ? [{ text: doc.document_lead, bold: true, boxed: true }] : []),
        { text: body },
        ...(doc.external_status === 'signed' ? [{ text: `${doc.signed_name} on ${new Date(doc.signed_at).toISOString()}` }] : []),
      ],
      doc.external_status === 'signed' ? 'Signed deed' : 'Deed for signing',
    )
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'attachment; filename="deed.pdf"')
    return reply.send(pdf)
  })

  /**
   * R-ENT-03, §5.2: a reviewer resolves an identity review. Same legal entity (a correction or a new name): the commitment
   * moves to the new version once it has passed KYC, and the deal sheet is signed again. Another entity: this participation
   * ends as withdrawn; the person may commit afresh with the new one (money held is a refund, D4).
   */
  app.post<{ Params: { id: string } }>('/api/review/participations/:id/identity', reviewer, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = z.strictObject({ decision: z.enum(['same_entity', 'other_entity']), reason: z.string().trim().min(3).max(2000) }).parse(req.body)
    await reviewerTx(x, who, async (c) => {
      const dealId = (await c.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [pid])).rows[0]?.deal_id
      const deal = dealId ? await dealById(c, dealId, true) : null
      if (!deal) throw new Refused(NOT_FOUND)
      const p = (
        await c.query<{ id: string; user_id: string; entity_id: string; identity_review: string }>(
          "SELECT id, user_id, entity_id, identity_review FROM participation WHERE id = $1 AND outcome = 'active' FOR UPDATE",
          [pid],
        )
      ).rows[0]
      if (!p || p.identity_review !== 'pending') throw new Refused('This commitment is not waiting for an identity decision.')
      const dealRow = (await c.query('SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1', [deal.id])).rows[0]
      if (await hasStake(c, who, dealRow)) throw new Refused('You cannot review a deal you lead, work on, or receive carry from.')
      if (p.user_id === who.id) throw new Refused('You cannot decide on your own commitment.')
      if (b.decision === 'same_entity') {
        const ent = (await c.query<{ current_version: number }>('SELECT current_version FROM legal_entity WHERE id = $1', [p.entity_id])).rows[0]!
        const kyc = await c.query("SELECT 1 FROM kyc_case WHERE entity_id = $1 AND entity_version = $2 AND status = 'approved' AND expires_on > current_date", [
          p.entity_id,
          ent.current_version,
        ])
        if (!kyc.rowCount) throw new Refused('The new details have not passed the identity check yet.')
        await c.query("UPDATE participation SET entity_version = $2, identity_review = 'resolved', updated_at = clock_timestamp() WHERE id = $1", [
          p.id,
          ent.current_version,
        ])
        // the deal sheet names the entity, so it is signed again; any instruction was voided when the review began
        await c.query('UPDATE signature_record SET superseded_at = clock_timestamp() WHERE participation_id = $1 AND superseded_at IS NULL', [p.id])
      } else {
        await c.query(
          "UPDATE participation SET outcome = 'withdrawn', identity_review = 'resolved', ended_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1",
          [p.id],
        )
        await voidInstruction(c, d.k, p.id, 'identity_other_entity', who.id)
        // §5.2: the invitation ends with its last active participation; coming back needs an invitation of its own
        await c.query(
          `UPDATE deal_invitation i SET state = 'revoked', ended_at = clock_timestamp() FROM participation p
            WHERE p.id = $1 AND i.id = p.invitation_id AND i.state = 'active'
              AND NOT EXISTS (SELECT 1 FROM participation o WHERE o.invitation_id = i.id AND o.outcome = 'active')`,
          [p.id],
        )
      }
      await c.query('INSERT INTO participation_event (id, participation_id, event, actor, detail) VALUES ($1, $2, $3, $4, $5)', [
        randomUUID(),
        p.id,
        `identity_${b.decision}`,
        who.id,
        '{}',
      ])
      // the reason can hold personal information, so it is not in the audit row
      await appendAudit(c, d.k, { actor: who.id, action: `participation.identity_${b.decision}`, entity: p.id })
      // §5.6: withdrawn here, this may have been the person's last part
      await refreshRelationship(c, p.user_id, d.now?.() ?? new Date())
      const u = (await c.query<{ email: string }>('SELECT email FROM user_account WHERE id = $1', [p.user_id])).rows[0]!
      await d.mail.investor(c, { action: 'details_checked', audience: { kind: 'account', userId: p.user_id }, to: u.email, dealId: deal.id })
    })
    await d.mail.flush()
    return { ok: true }
  })

  return { voidInstruction }
}
