// D4 lead panel (chunk 8b): the investor list with status, who it waits on and days at the step, the money figures, filters,
// and the CSV export (R-ADM-02, R-ADM-05, R-ADM-11, R-PIP-04). The rules are in `lib/participation.ts` and `lib/money.ts`;
// this file reads the facts. A lead never sees identity documents, return reasons, holds or money to check (R-KYC-02.1).
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { csvCell } from '../lib/csv.ts'
import { howToChange, SELF_SERVICE_FIELDS } from '../lib/change.ts'
import { rowActions, type RowActionFacts, type RowActionView } from '../lib/dealLife.ts'
import { activeHold, canAdministerDeal } from '../lib/gate.ts'
import type { AudienceRow } from '../lib/message.ts'
import { leadFeeOn, leadMetrics, type MetricsRow } from '../lib/money.ts'
import {
  daysInStatus,
  deriveStatus,
  leadRowMatches,
  leadRowView,
  STATUSES,
  WITH_OPERATOR_LABEL,
  type LeadRowView,
  type LeadStatus,
  type Outcome,
  type Waiter,
} from '../lib/participation.ts'
import { contentOf, diffContent } from '../lib/snapshot.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { partiesOf } from './d2.ts'
import { entityName } from './d3Invest.ts'
import {
  approvedSnapshot,
  dealById,
  dealGateFacts,
  linkFee,
  lockInstanceShare,
  participationStatus,
  packOf,
  policyNow,
  REAL_SINCE,
  type D3Deal,
  type FrozenTerms,
  type Q,
  type Snapshot,
} from './d3Core.ts'
import { MONEY_ARRIVED } from './d4Life.ts'
import { loadMoney } from './ledger.ts'
import { termsOfInvitation } from './reconfirm.ts'
import { Refused } from './requests.ts'

export interface D4PanelDeps {
  db: Db
  k: Keyring
  now?: () => Date
  /** §5.5 for a person on this deal's pack, as the investor's own pages judge it. */
  qualified: (c: Q, userId: string, dealId: string) => Promise<boolean>
  /** R-ADM-01: the investor page on the default link's terms; creates nothing. */
  previewPage: (c: Q, deal: D3Deal) => Promise<object>
  /** The memo, deck and shared documents exactly as the investor page takes them (R-ADM-10). */
  sharedContent: (c: Q, dealId: string, snap: Snapshot) => Promise<{ memo: unknown; deck: unknown; documents: unknown[] }>
}

const Uuid = z.uuid()
const NOT_FOUND = 'Not found.'
const LEAD_STATUSES = [...STATUSES, 'with_operator'] as const
const Filter = z.strictObject({
  status: z.enum(LEAD_STATUSES).optional(),
  waiting: z.enum(['investor', 'reviewer', 'lead', 'none']).optional(),
})

export interface PanelRow extends LeadRowView {
  invitation_id: string
  participation_id: string | null
  name: string
  entity: string | null
  /** R-ADM-07: the viewer's own commitment, marked so the screen can say so. */
  own: boolean
  days: number | null
  commitment_minor: string | null
  received_minor: string
  lead_fee_minor: string
  carry_bps: number
  /** R-ADM-06: what the viewer may do on this row, or why not. */
  actions: RowActionView[]
}

/**
 * R-ADM-05 "days at this step": counted from the latest thing recorded on this person's part that can move the step (the
 * commitment, its events, a signature, a receipt or its reversal, a refund step, an identity check, a reconfirmation, an amount
 * proposal, an instruction issued or voided). Before a commitment: the invitation, saying no, or the waiting list.
 */
const PART_SINCE = `SELECT GREATEST(p.created_at, p.updated_at, p.ended_at,
    (SELECT max(created_at) FROM participation_event WHERE participation_id = p.id),
    (SELECT max(signed_at) FROM signature_record WHERE participation_id = p.id),
    (SELECT max(created_at) FROM transfer_mark WHERE participation_id = p.id),
    (SELECT max(GREATEST(created_at, reversed_at)) FROM receipt WHERE participation_id = p.id),
    (SELECT max(GREATEST(created_at, approved_at, sent_at, recorded_at, cancelled_at)) FROM refund_payment WHERE participation_id = p.id),
    (SELECT max(GREATEST(created_at, information_confirmed_at, decided_at)) FROM kyc_case WHERE entity_id = p.entity_id),
    (SELECT max(GREATEST(started_at, decided_at)) FROM reconfirmation WHERE participation_id = p.id),
    (SELECT max(GREATEST(created_at, decided_at)) FROM amount_proposal WHERE participation_id = p.id),
    (SELECT max(GREATEST(created_at, voided_at)) FROM issued_instruction WHERE participation_id = p.id)) AS since
  FROM participation p WHERE p.id = $1`
const INVITATION_SINCE = `SELECT GREATEST(i.created_at, i.ended_at,
    (SELECT created_at FROM invitation_pass WHERE invitation_id = i.id),
    (SELECT max(GREATEST(created_at, released_at, ended_at)) FROM waitlist_entry WHERE invitation_id = i.id)) AS since
  FROM deal_invitation i WHERE i.id = $1`

export function registerD4Panel(app: FastifyInstance, d: D4PanelDeps) {
  const verified = { config: { gate: 'verified' as const } }
  const now = () => d.now?.() ?? new Date()

  /** The lead, co-leads and the deal's team read the panel (R-SYN-06); nothing here writes but the export's audit. */
  function panelTx<T>(who: SessionUser, id: string, fn: (c: Tx, deal: D3Deal, lead: boolean) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await lockInstanceShare(c)
      const row = (
        await c.query<{ id: string; lead_user: string; syndicate_id: string | null; draft: never }>(
          'SELECT id, lead_user, syndicate_id, draft FROM deal WHERE id = $1 AND deleted_at IS NULL',
          [id],
        )
      ).rows[0]
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const parties = row && (await partiesOf(c, row))
      if (!parties || !canAdministerDeal(who, parties)) throw new Refused(NOT_FOUND)
      return fn(c, (await dealById(c, id))!, parties.leadUserIds.includes(who.id))
    })
  }

  async function sinceOf(c: Q, sql: string, id: string): Promise<number | null> {
    const s = (await c.query<{ since: Date | null }>(sql, [id])).rows[0]?.since
    return s ? daysInStatus(s, now()) : null
  }

  /** `audience`, when given, receives each row's person for messages (R-COM-01); the rows themselves never carry an account id. */
  async function panel(c: Q, deal: D3Deal, viewer: string, lead: boolean, audience?: AudienceRow[]) {
    const pack = await packOf(c, deal)
    if (!pack) throw new Refused(NOT_FOUND)
    const today = now().toISOString().slice(0, 10)
    const invitations = (
      await c.query<{
        id: string
        user_id: string
        state: 'active' | 'passed' | 'revoked'
        terms_snapshot: FrozenTerms | null
        invite_link: string
        name: string
      }>(
        `SELECT i.id, i.user_id, i.state, i.terms_snapshot, i.invite_link, u.name FROM deal_invitation i JOIN user_account u ON u.id = i.user_id
          WHERE i.deal_id = $1 AND i.created_at >= ${REAL_SINCE} ORDER BY i.created_at, i.id`,
        [deal.id],
      )
    ).rows
    const rows: PanelRow[] = []
    const metrics: MetricsRow[] = []
    const held = activeHold((await dealGateFacts(c, deal)).holds)
    const changeOpen = (await c.query("SELECT 1 FROM change_request WHERE deal_id = $1 AND state IN ('submitted', 'reviewed')", [deal.id])).rowCount! > 0
    const act = (inv: { state: string; terms_snapshot: FrozenTerms | null }, part: RowActionFacts['part']) =>
      rowActions({
        state: deal.state,
        payoutException: false,
        isLead: lead,
        invitationActive: inv.state === 'active',
        termsFrozen: inv.terms_snapshot !== null,
        part,
        changeOpen,
        held,
      })
    for (const inv of invitations) {
      const terms = await termsOfInvitation(c, inv)
      const fee = linkFee(terms)
      const parts = (
        await c.query<{
          id: string
          entity_id: string
          entity_version: number
          outcome: Outcome
          identity_review: string
          cash_due_minor: string
          invested_minor: string | null
          commitment_minor: string
        }>(
          'SELECT id, entity_id, entity_version, outcome, identity_review, cash_due_minor, invested_minor, commitment_minor FROM participation WHERE invitation_id = $1 ORDER BY join_seq',
          [inv.id],
        )
      ).rows
      if (!parts.length) {
        const waitlisted = (await c.query("SELECT 1 FROM waitlist_entry WHERE invitation_id = $1 AND state IN ('waiting', 'released')", [inv.id])).rowCount! > 0
        const qualified = inv.state === 'active' && (await d.qualified(c, inv.user_id, deal.id))
        const s = deriveStatus({ invitation: inv.state, qualified, statementExpired: false, waitlisted, participation: null }, pack)
        const view = leadRowView(s, {
          kycAwaitingReviewer: false,
          dealState: deal.state,
          closingDecisionMade: false,
          moneyOnHand: false,
          held: false,
          refundOpen: false,
        })
        rows.push({
          ...view,
          invitation_id: inv.id,
          participation_id: null,
          name: inv.name,
          entity: null,
          own: inv.user_id === viewer,
          days: await sinceOf(c, INVITATION_SINCE, inv.id),
          commitment_minor: null,
          received_minor: '0',
          lead_fee_minor: '0',
          carry_bps: terms.carry_bps,
          actions: act(inv, null),
        })
        audience?.push({ userId: inv.user_id, name: inv.name, status: view.status, waiting: view.waiting, committed: false })
        continue
      }
      for (const p of parts) {
        const money = (await loadMoney(c, p.id))!
        const f = money.figures
        metrics.push({ outcome: p.outcome, commitment: BigInt(p.commitment_minor), fee, figures: f })
        const s = await participationStatus(c, p, pack, today, now())
        const kyc = (
          await c.query<{ status: string }>(
            `SELECT status FROM kyc_case WHERE entity_id = $1 AND created_at >= ${REAL_SINCE} ORDER BY created_at DESC LIMIT 1`,
            [p.entity_id],
          )
        ).rows[0]
        // money due back already shows as a reviewer's (refund due, or a final status with money); a refund on its way does not
        const refundOpen = (await c.query("SELECT 1 FROM refund_payment WHERE participation_id = $1 AND state IN ('approved', 'sent')", [p.id])).rowCount! > 0
        const view = leadRowView(
          { status: s.status, overlays: s.overlays as never },
          {
            kycAwaitingReviewer: kyc?.status === 'pending_review',
            dealState: deal.state,
            closingDecisionMade: false,
            moneyOnHand: f.onHand > 0n,
            held: f.hold > 0n,
            refundOpen,
          },
        )
        const ent = (
          await c.query<{ fields: Record<string, string>; type: string }>(
            'SELECT v.fields, e.type FROM legal_entity e JOIN legal_entity_version v ON v.entity_id = e.id AND v.version = $2 WHERE e.id = $1',
            [p.entity_id, p.entity_version],
          )
        ).rows[0]!
        audience?.push({ userId: inv.user_id, name: inv.name, status: view.status, waiting: view.waiting, committed: p.outcome === 'active' })
        rows.push({
          ...view,
          invitation_id: inv.id,
          participation_id: p.id,
          name: inv.name,
          entity: entityName(ent.type, ent.fields),
          own: inv.user_id === viewer,
          days: await sinceOf(c, PART_SINCE, p.id),
          commitment_minor: p.commitment_minor,
          received_minor: String(f.received),
          lead_fee_minor: String(leadFeeOn(f.effective, fee)),
          carry_bps: terms.carry_bps,
          actions: act(inv, {
            outcome: p.outcome,
            moneyArrived: (await c.query(`SELECT 1 WHERE ${MONEY_ARRIVED}`, [p.id])).rowCount! > 0,
            transferMarked: (await c.query('SELECT 1 FROM transfer_mark WHERE participation_id = $1', [p.id])).rowCount! > 0,
            onHand: f.onHand,
            withdrawalOpen: (await c.query('SELECT 1 FROM withdrawal_request WHERE participation_id = $1 AND decision IS NULL', [p.id])).rowCount! > 0,
            // a proposal past its deadline has ended, even before anyone records it (R-ALO-01)
            proposalOpen:
              (await c.query('SELECT 1 FROM amount_proposal WHERE participation_id = $1 AND decision IS NULL AND deadline_at > $2', [p.id, now()])).rowCount! >
              0,
          }),
        })
      }
    }
    const m = leadMetrics(metrics)
    const snap = await approvedSnapshot(c, deal)
    return {
      currency: snap?.snapshot.terms?.currency ?? 'GBP',
      metrics: {
        committed_minor: String(m.committed),
        received_minor: String(m.received),
        refund_due_minor: String(m.refundDue),
        refunded_minor: String(m.refunded),
        operator_handling_minor: String(m.operatorHandling),
        lead_fees_minor: String(m.leadFees),
        usable_gross_minor: String(m.usableGross),
      },
      rows,
    }
  }

  const counts = (rows: PanelRow[]) => {
    const status: Partial<Record<LeadStatus, number>> = {}
    const waiting: Partial<Record<Waiter | 'none', number>> = {}
    for (const r of rows) {
      status[r.status] = (status[r.status] ?? 0) + 1
      waiting[r.waiting ?? 'none'] = (waiting[r.waiting ?? 'none'] ?? 0) + 1
    }
    return { status, waiting }
  }

  // R-ADM-02, R-ADM-05: the figures, the list, its filters and how many are in each
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/deals/:id/panel', verified, async (req) => {
    const f = Filter.parse(req.query ?? {})
    return panelTx(req.user!, Uuid.parse(req.params.id), async (c, deal, lead) => {
      const p = await panel(c, deal, req.user!.id, lead)
      return {
        ...p,
        with_operator_label: WITH_OPERATOR_LABEL,
        counts: counts(p.rows),
        rows: p.rows.filter((r) => leadRowMatches(r, f)),
      }
    })
  })

  // R-ADM-01: the deal page as an investor sees it, read only, on the default terms; no participation, no page view; audited
  app.get<{ Params: { id: string } }>('/api/deals/:id/investor-preview', verified, async (req) =>
    panelTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      const page = await d.previewPage(c, deal)
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.previewed_as_investor', entity: deal.id })
      return page
    }),
  )

  // R-ADM-08, R-ADM-09, R-ADM-10, R-CHG-03: the approved terms sorted by how each can change, every version with how many people
  // were shown it, the files, and the memo exactly as investors read it
  app.get<{ Params: { id: string } }>('/api/deals/:id/content', verified, async (req) =>
    panelTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      const snap = await approvedSnapshot(c, deal)
      const pack = await packOf(c, deal)
      if (!snap || !pack) throw new Refused('The terms, files and memo are shown here once the deal is approved.')
      const stricter = pack.must_reconfirm_extra ?? []
      const anyCommitment = (await c.query(`SELECT 1 FROM participation WHERE deal_id = $1 AND created_at >= ${REAL_SINCE}`, [deal.id])).rowCount! > 0
      const content = contentOf(snap.snapshot as never)
      const valueAt = (field: string) => {
        const [section, key] = field.split('.') as [string, string]
        const v = (content[section] as Record<string, unknown> | undefined)?.[key]
        return v === undefined ? null : v
      }
      const fields = new Set([...SELF_SERVICE_FIELDS, ...diffContent({}, content).map((x) => x.field.split('.').slice(0, 2).join('.'))])
      const view = (field: string) => {
        const h = howToChange(field, stricter)
        return { field: h.field, value: valueAt(h.field), route: h.route, live_only: h.liveOnly, locked: h.lockedAfterCommitment && anyCommitment }
      }
      const versions = (
        await c.query<{ n: number; kind: string; created_at: Date; summary: string | null; shown_to: number }>(
          `SELECT v.n, v.kind, v.created_at, (SELECT summary FROM change_request WHERE deal_id = v.deal_id AND applied_version = v.n) AS summary,
             (SELECT count(DISTINCT user_id)::int FROM deal_view WHERE deal_id = v.deal_id AND version = v.n AND served_at >= ${REAL_SINCE}) AS shown_to
             FROM deal_version v WHERE v.deal_id = $1 AND v.kind IN ('approved', 'self_service') ORDER BY v.n DESC`,
          [deal.id],
        )
      ).rows
      const shared = await d.sharedContent(c, deal.id, snap.snapshot)
      return {
        version: snap.n,
        terms: [...fields].filter((f) => !f.startsWith('files.')).map(view),
        versions: versions.map((v) => ({
          n: v.n,
          self_service: v.kind === 'self_service',
          approved_at: v.created_at,
          summary: v.summary,
          shown_to: v.shown_to,
          in_force: v.n === snap.n,
        })),
        files: {
          // the deal sheet as an investor would get it, drawn by the deal sheet preview
          deal_sheet: `/api/deals/${deal.id}/deal-sheet-preview`,
          documents: shared.documents,
          documents_change: view('files.documents'),
          deck: shared.deck,
          deck_change: view('files.deck'),
        },
        memo: shared.memo,
        memo_change: view('files.memo'),
      }
    }),
  )

  // R-ADM-06: one person's documents as the lead sees them: what they signed, current and replaced, with no identity papers
  app.get<{ Params: { id: string; pid: string } }>('/api/deals/:id/participations/:pid/documents', verified, async (req) =>
    panelTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      const pid = Uuid.parse(req.params.pid)
      const p = (await c.query(`SELECT 1 FROM participation WHERE id = $1 AND deal_id = $2 AND created_at >= ${REAL_SINCE}`, [pid, deal.id])).rows[0]
      if (!p) throw new Refused(NOT_FOUND)
      const signed = (
        await c.query<{
          document: string
          document_sha256: string
          terms_version: number
          signed_at: Date
          superseded_at: Date | null
          external_status: string | null
        }>(
          'SELECT document, document_sha256, terms_version, signed_at, superseded_at, external_status FROM signature_record WHERE participation_id = $1 ORDER BY signed_at DESC',
          [pid],
        )
      ).rows
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'participation.documents_viewed', entity: pid })
      return {
        signed: signed.map((x) => ({
          document: x.document,
          document_sha256: x.document_sha256,
          terms_version: x.terms_version,
          signed_at: x.signed_at,
          replaced: x.superseded_at !== null,
          // a deed sent outside and not yet signed back is not a signed document (R-SIG-04)
          awaiting_deed: x.external_status === 'sent',
        })),
      }
    }),
  )

  /** The list as a file: the panel's columns, amounts in major units with the currency (R-ADM-11, R-OPS-01). */
  function investorsCsv(p: Awaited<ReturnType<typeof panel>>): string {
    const amount = (m: string | null) => (m === null ? '' : `${BigInt(m) / 100n}.${String(BigInt(m) % 100n).padStart(2, '0')}`)
    const pct = (bps: number) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`
    return [
      INVESTORS_CSV_HEADER,
      ...p.rows.map((r) =>
        [r.name, r.entity ?? '', r.label, r.waiting ?? '', r.days === null ? '' : String(r.days), p.currency, amount(r.commitment_minor), amount(r.received_minor), amount(r.lead_fee_minor), pct(r.carry_bps)]
          .map(csvCell)
          .join(','),
      ),
    ].join('\r\n')
  }
  const sendCsv = (reply: FastifyReply, csv: string) =>
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="investors.csv"').send(csv)

  // R-ADM-11: the same list as a file, at any time, audited; the operator may keep it from leads (R-CMP-03)
  app.get<{ Params: { id: string } }>('/api/deals/:id/investors.csv', verified, async (req, reply) => {
    const csv = await panelTx(req.user!, Uuid.parse(req.params.id), async (c, deal, lead) => {
      if (!(await policyNow(c)).exportRoles.includes('lead')) throw new Refused('The operator does not allow leads to export this list.')
      const p = await panel(c, deal, req.user!.id, lead)
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'investors.exported', entity: deal.id, detail: { rows: p.rows.length } })
      return investorsCsv(p)
    })
    return sendCsv(reply, csv)
  })

  // ---------- R-OPS-01: reviewers and admins read every deal's list; nothing on it can be done from here ----------

  const ops = { config: { gate: 'canRunOperations' as const } }
  function staffTx<T>(who: SessionUser, id: string, fn: (c: Tx, deal: D3Deal) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await lockInstanceShare(c)
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const deal = await dealById(c, id)
      if (!deal || !(await packOf(c, deal))) throw new Refused(NOT_FOUND)
      return fn(c, deal)
    })
  }
  /** The lead's own rows, with no row actions: the same words for everyone, so a reader with a stake learns nothing more (R-KYC-02.1). */
  const readOnly = (p: Awaited<ReturnType<typeof panel>>) => ({ ...p, rows: p.rows.map(({ actions: _a, own: _o, ...r }) => r) })

  // viewing is not audited; exporting is (R-OPS-01)
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/ops/deals/:id/investors', ops, async (req) => {
    const f = Filter.parse(req.query ?? {})
    return staffTx(req.user!, Uuid.parse(req.params.id), async (c, deal) => {
      const p = readOnly(await panel(c, deal, req.user!.id, false))
      return { ...p, with_operator_label: WITH_OPERATOR_LABEL, counts: counts(p.rows as PanelRow[]), rows: p.rows.filter((r) => leadRowMatches(r, f)) }
    })
  })

  app.get<{ Params: { id: string } }>('/api/ops/deals/:id/investors.csv', ops, async (req, reply) => {
    const who = req.user!
    const csv = await staffTx(who, Uuid.parse(req.params.id), async (c, deal) => {
      const roles = (await policyNow(c)).exportRoles
      if (!who.roles.some((r) => roles.includes(r))) throw new Refused('The operator does not allow your role to export this list.')
      const p = await panel(c, deal, who.id, false)
      await appendAudit(c, d.k, { actor: who.id, action: 'investors.exported', entity: deal.id, detail: { rows: p.rows.length, by: 'operator' } })
      return investorsCsv(p)
    })
    return sendCsv(reply, csv)
  })

  return {
    /** R-COM-01: each row of the list with its person, for choosing whom a message goes to. */
    async audienceRows(c: Q, deal: D3Deal, viewer: string, lead: boolean): Promise<AudienceRow[]> {
      const out: AudienceRow[] = []
      await panel(c, deal, viewer, lead, out)
      return out
    },
  }
}

export const INVESTORS_CSV_HEADER = 'name,entity,status,waiting_on,days_at_step,currency,commitment,received,lead_fee,carry_percent'
