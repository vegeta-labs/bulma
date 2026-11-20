// D4 evidence pack (chunk 9b; PRD R-AUD-02, TC-AUD-02, decision R28 (6)). One click from a row of the operator's list of a
// deal's investors: everything the site recorded for that person and that deal, with the records that belong to no deal
// (statements, warnings, cooling-off, assessment, identity checks). The facts are read here; the wording, the order and the
// hash checks are `lib/evidence.ts`. Reviewers and admins with two-step sign-in, not on a deal they have a stake in; every
// export is audited. A PDF to read and a JSON list to check, as two downloads (no zip dependency).
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { evidenceBlocks, evidenceManifest, type EvidenceItem, type SectionKey, type ShownText } from '../lib/evidence.ts'
import { INVITEE_POLICY_KEY } from '../lib/regimePack.ts'
import { appendAudit, SOFTWARE_VERSION } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db } from '../store/db.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import type { Q } from './d3Core.ts'
import { hasStake } from './ledger.ts'
import { PDF_MAX_CHARS, renderPdf } from './pdf.ts'
import { Refused } from './requests.ts'

export interface D4EvidenceDeps {
  db: Db
  k: Keyring
  now?: () => Date
}

const Uuid = z.uuid()
const NOT_FOUND = 'No such invitation.'
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString())
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v))

interface Subject {
  invitationId: string
  userId: string
  name: string
  email: string
  dealId: string
  dealCode: string
  dealName: string | null
}

/** The kept wording of a legal text by its recorded hash, from the pack it was shown under when that is known. */
async function legalText(c: Q, sha256: string | null, packId: string | null): Promise<{ key: string; version: number; body: string } | null> {
  if (!sha256) return null
  const r = (
    await c.query<{ text_key: string; variant: string; version: number; body: string }>(
      `SELECT text_key, variant, version, body FROM legal_text WHERE sha256 = $1 AND ($2::uuid IS NULL OR pack_id = $2) ORDER BY created_at LIMIT 1`,
      [sha256, packId],
    )
  ).rows[0]
  return r ? { key: r.variant === 'default' ? r.text_key : `${r.text_key}/${r.variant}`, version: r.version, body: r.body } : null
}

const utf8 = (text: string, sha256: string): ShownText => ({ hashed: 'utf8', text, sha256 })

/** Every section for one person and one deal. */
export async function loadEvidence(c: Q, s: Subject): Promise<Partial<Record<SectionKey, EvidenceItem[]>>> {
  const rows = async <T>(sql: string, p: unknown[]) => (await c.query<T & Record<string, unknown>>(sql, p)).rows
  const out: Partial<Record<SectionKey, EvidenceItem[]>> = {}
  const add = (k: SectionKey, item: EvidenceItem) => void (out[k] ??= []).push(item)
  const packs = new Set<string>()

  // ---- records that belong to no deal ----
  for (const r of await rows<{
    pack_id: string
    regime: string
    category: string
    qualifies: boolean
    answers: unknown
    legal_text_sha256: string | null
    signed_name: string
    signed_on: string
    payload_sha256: string
    auth_method: string
    expires_at: Date
    created_at: Date
  }>(
    `SELECT pack_id, regime, category, qualifies, answers, legal_text_sha256, signed_name, to_char(signed_on, 'YYYY-MM-DD') AS signed_on, payload_sha256,
            auth_method, expires_at, created_at FROM eligibility_statement WHERE user_id = $1`,
    [s.userId],
  )) {
    packs.add(r.pack_id)
    const t = await legalText(c, r.legal_text_sha256, r.pack_id)
    add('statements', {
      at: iso(r.created_at),
      what: 'Eligibility statement made',
      fields: {
        regime: r.regime,
        category: r.category,
        qualifies: r.qualifies,
        answers: json(r.answers),
        signed_name: r.signed_name,
        signed_on: r.signed_on,
        expires_at: iso(r.expires_at),
        statement_sha256: r.payload_sha256,
        sign_in_method: r.auth_method,
        text_key: t?.key ?? null,
        text_version: t?.version ?? null,
      },
      shown: r.legal_text_sha256 ? utf8(t?.body ?? '', r.legal_text_sha256) : undefined,
    })
  }

  for (const r of await rows<{ pack_id: string; kind: string; full_name: string | null; legal_text_sha256: string; shown_at: Date; decision: string }>(
    'SELECT pack_id, kind, full_name, legal_text_sha256, shown_at, decision FROM warning_ack WHERE user_id = $1',
    [s.userId],
  )) {
    packs.add(r.pack_id)
    const t = await legalText(c, r.legal_text_sha256, r.pack_id)
    add('warnings', {
      at: iso(r.shown_at),
      what: r.kind === 'personalised_warning' ? 'Personalised risk warning shown' : 'Risk warning shown',
      fields: {
        choice: r.decision,
        name_filled_in: r.kind === 'personalised_warning' ? (r.full_name ?? '') : null,
        text_key: t?.key ?? null,
        text_version: t?.version ?? null,
      },
      shown: utf8(t?.body ?? '', r.legal_text_sha256),
    })
  }

  for (const r of await rows<{ started_at: Date; ends_at: Date; decision: string | null; decided_at: Date | null }>(
    'SELECT started_at, ends_at, decision, decided_at FROM cooling_off WHERE user_id = $1',
    [s.userId],
  ))
    add('cooling_off', {
      at: iso(r.started_at),
      what: 'Cooling-off period started',
      fields: { ends_at: iso(r.ends_at), choice: r.decision, chosen_at: iso(r.decided_at) },
    })

  for (const r of await rows<{ pack_id: string; passed: boolean | null; answered_at: Date | null; locked_until: Date | null; created_at: Date }>(
    'SELECT pack_id, passed, answered_at, locked_until, created_at FROM assessment_attempt WHERE user_id = $1',
    [s.userId],
  )) {
    packs.add(r.pack_id)
    add('assessment', {
      at: iso(r.created_at),
      what: 'Assessment attempt',
      fields: {
        result: r.passed === null ? 'not finished' : r.passed ? 'passed' : 'not passed',
        answered_at: iso(r.answered_at),
        next_try_from: iso(r.locked_until),
      },
    })
  }

  for (const r of await rows<{
    type: string
    entity_version: number
    status: string
    return_reason: string | null
    decided_at: Date | null
    expires_on: string | null
    biometric_consent_at: Date | null
    biometric_consent_text_sha256: string | null
    created_at: Date
  }>(
    `SELECT e.type, k.entity_version, k.status, k.return_reason, k.decided_at, to_char(k.expires_on, 'YYYY-MM-DD') AS expires_on, k.biometric_consent_at,
            k.biometric_consent_text_sha256, k.created_at
       FROM kyc_case k JOIN legal_entity e ON e.id = k.entity_id WHERE e.owner_user = $1`,
    [s.userId],
  )) {
    const t = await legalText(c, r.biometric_consent_text_sha256, null)
    add('kyc', {
      at: iso(r.created_at),
      what: `Identity check of an ${r.type === 'individual' ? 'individual' : `investing ${r.type}`}`,
      fields: {
        details_version: r.entity_version,
        status: r.status,
        decided_at: iso(r.decided_at),
        reason_given: r.return_reason,
        valid_until: r.expires_on,
        biometric_consent_at: iso(r.biometric_consent_at),
      },
      shown: r.biometric_consent_text_sha256 ? utf8(t?.body ?? '', r.biometric_consent_text_sha256) : undefined,
    })
  }

  // ---- this deal ----
  const deal = (await rows<{ pack_id: string | null }>('SELECT pack_id FROM deal WHERE id = $1', [s.dealId]))[0]
  if (deal?.pack_id) packs.add(deal.pack_id)

  for (const r of await rows<{
    version: number
    first: Date
    last: Date
    times: number
    snapshot: unknown
    sha256: string
    kind: string
    version_made: Date
  }>(
    `SELECT v.version, min(v.served_at) AS first, max(v.served_at) AS last, count(*)::int AS times, dv.snapshot, dv.sha256, dv.kind, dv.created_at AS version_made
       FROM deal_view v JOIN deal_version dv ON dv.deal_id = v.deal_id AND dv.n = v.version
      WHERE v.deal_id = $1 AND v.user_id = $2 GROUP BY v.version, dv.snapshot, dv.sha256, dv.kind, dv.created_at`,
    [s.dealId, s.userId],
  )) {
    const approvals = await rows<{
      self_declared_name: string
      self_declared_frn: string | null
      approved_on: string
      content_sha256: string
      approver_user: string
    }>(
      `SELECT self_declared_name, self_declared_frn, to_char(approved_on, 'YYYY-MM-DD') AS approved_on, content_sha256, approver_user FROM promotion_approval
        WHERE subject_kind = 'deal_version' AND subject_id = $1 ORDER BY created_at`,
      [`${s.dealId}:${r.version}`],
    )
    add('deal_versions', {
      at: iso(r.first),
      what: `Deal page version ${r.version} returned to this account`,
      fields: {
        version: r.version,
        version_kind: r.kind,
        version_made: iso(r.version_made),
        times_returned: r.times,
        last_returned: iso(r.last),
        content_approvals: approvals.length,
        ...Object.fromEntries(
          approvals.flatMap((a, i) => [
            [`approval_${i + 1}`, `${a.approved_on} by account ${a.approver_user}, name given ${a.self_declared_name} (self-declared)`],
            [`approval_${i + 1}_frn`, a.self_declared_frn === null ? null : `${a.self_declared_frn} (self-declared)`],
            [`approval_${i + 1}_sha256`, a.content_sha256],
          ]),
        ),
      },
      shown: { hashed: 'stable_json', value: r.snapshot, sha256: r.sha256 },
    })
  }

  for (const r of await rows<{
    id: string
    state: string
    created_at: Date
    ended_at: Date | null
    terms_snapshot: unknown
    terms_frozen_at: Date | null
    link_kind: string
    carry_bps: number
    fee_kind: string
    fee_bps: number | null
    fee_minor: string | null
    fee_mode: string | null
    is_default: boolean
    terms_approved_at: Date | null
    targeted: string | null
    sent_by: string | null
    sent_by_name: string | null
    sent_at: Date | null
  }>(
    `SELECT i.id, i.state, i.created_at, i.ended_at, i.terms_snapshot, i.terms_frozen_at, l.kind AS link_kind, l.carry_bps, l.fee_kind, l.fee_bps,
            l.fee_minor::text, l.fee_mode, l.is_default, l.terms_approved_at, t.id AS targeted, t.sent_by, u.name AS sent_by_name, t.created_at AS sent_at
       FROM deal_invitation i JOIN invite_link l ON l.id = i.invite_link
       LEFT JOIN targeted_invite t ON t.id = i.targeted_invite LEFT JOIN user_account u ON u.id = t.sent_by
      WHERE i.deal_id = $1 AND i.user_id = $2`,
    [s.dealId, s.userId],
  )) {
    add('link_terms', {
      at: iso(r.created_at),
      what: r.targeted ? `Invitation sent to this person by ${r.sent_by_name ?? 'a lead'}` : 'Invitation through a link',
      fields: {
        state: r.state,
        ended_at: iso(r.ended_at),
        link: r.link_kind,
        default_terms: r.is_default,
        carry_bps: r.carry_bps,
        lead_fee: r.fee_kind,
        lead_fee_bps: r.fee_bps,
        lead_fee_minor: r.fee_minor,
        lead_fee_mode: r.fee_mode,
        terms_approved_at: iso(r.terms_approved_at),
        terms_fixed_at: iso(r.terms_frozen_at),
        terms_fixed: json(r.terms_snapshot),
      },
    })
    if (r.targeted && r.sent_by) {
      // R-PIP-06: the sender's own confirmation of the operator's "whom to invite" text in force when this invitation went out
      const ack = (
        await rows<{ pack_id: string; text_version: number; text_sha256: string; created_at: Date }>(
          `SELECT pack_id, text_version, text_sha256, created_at FROM invitee_policy_ack WHERE user_id = $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1`,
          [r.sent_by, r.sent_at],
        )
      )[0]
      const body = ack
        ? (
            await rows<{ body: string }>(`SELECT body FROM legal_text WHERE pack_id = $1 AND text_key = $2 AND variant = 'default'`, [
              ack.pack_id,
              INVITEE_POLICY_KEY,
            ])
          )[0]
        : undefined
      add('link_terms', {
        at: iso(ack?.created_at ?? null),
        what: ack
          ? "The sender's confirmation of the operator's text on whom to invite"
          : 'No confirmation by the sender of the text on whom to invite is recorded',
        fields: { text_key: INVITEE_POLICY_KEY, text_version: ack?.text_version ?? null },
        shown: ack ? utf8(body?.body ?? '', ack.text_sha256) : undefined,
      })
    }
    for (const t of await rows<{ n: number; terms: unknown; change_id: string | null; created_at: Date }>(
      'SELECT n, terms, change_id, created_at FROM invitation_terms WHERE invitation_id = $1 ORDER BY n',
      [r.id],
    ))
      add('link_terms', {
        at: iso(t.created_at),
        what: t.n === 0 ? "This person's terms fixed" : `This person's terms changed (version ${t.n})`,
        fields: { terms: json(t.terms), change: t.change_id },
      })
  }

  const parts = await rows<{ id: string; reference: string }>('SELECT id, reference FROM participation WHERE deal_id = $1 AND user_id = $2', [
    s.dealId,
    s.userId,
  ])
  for (const p of parts) {
    for (const r of await rows<{
      created_at: Date
      cash_due_minor: string
      terms_version: number
      deal_version: number
      account_sha256: string
      voided_at: Date | null
      void_reason: string | null
      currency: string | null
      version: number | null
      holder: string | null
      holder_capacity: string | null
      holder_frn: string | null
      asserted_client_money: boolean | null
      refund_days: number | null
    }>(
      `SELECT i.created_at, i.cash_due_minor::text, i.terms_version, i.deal_version, i.account_sha256, i.voided_at, i.void_reason,
              pi.currency, pi.version, pi.holder, pi.holder_capacity, pi.holder_frn, pi.asserted_client_money, pi.refund_days
         FROM issued_instruction i LEFT JOIN payment_instruction pi ON pi.id = i.payment_instruction_id WHERE i.participation_id = $1`,
      [p.id],
    ))
      add('instructions', {
        at: iso(r.created_at),
        what: 'Payment instruction issued',
        fields: {
          reference: p.reference,
          amount_due_minor: r.cash_due_minor,
          currency: r.currency,
          instruction_version: r.version ?? 'sandbox example',
          account_holder: r.holder,
          holder_capacity: r.holder_capacity,
          holder_frn: r.holder_frn,
          holder_says_client_money: r.asserted_client_money,
          refund_days: r.refund_days,
          account_details_sha256: r.account_sha256,
          terms_version: r.terms_version,
          deal_version: r.deal_version,
          voided_at: iso(r.voided_at),
          void_reason: r.void_reason,
        },
      })
    for (const r of await rows<{ created_at: Date; currency: string; version: number }>(
      `SELECT a.created_at, pi.currency, pi.version FROM instruction_ack a JOIN payment_instruction pi ON pi.id = a.payment_instruction_id WHERE a.participation_id = $1`,
      [p.id],
    ))
      add('instructions', {
        at: iso(r.created_at),
        what: 'Receiving account confirmed by this person',
        fields: { reference: p.reference, currency: r.currency, instruction_version: r.version },
      })

    for (const r of await rows<{
      id: string
      document: string
      document_sha256: string
      provider: string
      signed_name: string
      ip: string
      auth_method: string
      external_status: string | null
      document_date: string | null
      signed_at: Date
      superseded_at: Date | null
      terms_version: number
      entity_version: number
      template_version: number
    }>(
      `SELECT s.id, s.document, s.document_sha256, s.provider, s.signed_name, s.ip, s.auth_method, s.external_status, to_char(s.document_date, 'YYYY-MM-DD') AS document_date,
              s.signed_at, s.superseded_at, s.terms_version, s.entity_version, t.version AS template_version
         FROM signature_record s JOIN document_template t ON t.id = s.template_id WHERE s.participation_id = $1`,
      [p.id],
    ))
      add('signatures', {
        at: iso(r.signed_at),
        what: 'Deal sheet signed',
        fields: {
          reference: p.reference,
          signature: r.id,
          signed_name: r.signed_name,
          method: r.provider,
          sign_in_method: r.auth_method,
          ip: r.ip,
          deed_status: r.external_status,
          document_date: r.document_date,
          template_version: r.template_version,
          terms_version: r.terms_version,
          details_version: r.entity_version,
          replaced_at: iso(r.superseded_at),
        },
        shown: utf8(r.document, r.document_sha256),
      })

    for (const r of await rows<{
      deal_version: number
      compared_to: number
      resign: boolean
      days: number
      state: string
      started_at: Date
      decided_at: Date | null
      by_person: boolean | null
      signature_id: string | null
    }>(
      `SELECT r.deal_version, r.compared_to, r.resign, r.days, r.state, r.started_at, r.decided_at, (r.decided_by = $2) AS by_person, r.signature_id
         FROM reconfirmation r WHERE r.participation_id = $1`,
      [p.id, s.userId],
    ))
      add('reconfirmations', {
        at: iso(r.started_at),
        what: `Asked to reconfirm version ${r.deal_version} against version ${r.compared_to}`,
        fields: {
          reference: p.reference,
          re_sign: r.resign,
          working_days: r.days,
          outcome: r.state,
          outcome_at: iso(r.decided_at),
          answered_by_this_person: r.by_person,
          signature: r.signature_id,
        },
      })
  }

  for (const r of await rows<{
    id: string
    kind: string
    delivery: string
    exclusion: string | null
    mail_status: string | null
    sent_variant: string | null
    cancel_reason: string | null
    finished_at: Date | null
    subject: string | null
    body: string | null
    sha256: string | null
    sent_at: Date
    erased_at: Date | null
    author_name: string
  }>(
    // what reached the person is the queue's outcome, decided again at the attempt: not what was decided when it was queued
    `SELECT m.id, m.kind, r.delivery, r.exclusion, o.status AS mail_status, o.sent_variant, o.cancel_reason, o.finished_at,
            m.subject, m.body, m.sha256, m.sent_at, m.erased_at, u.name AS author_name
       FROM message_recipient r JOIN message m ON m.id = r.message_id JOIN user_account u ON u.id = m.author
       LEFT JOIN notification_outbox o ON o.id = r.outbox_id
      WHERE m.deal_id = $1 AND r.user_id = $2 AND m.sent_at IS NOT NULL`,
    [s.dealId, s.userId],
  )) {
    const approvals = await rows<{
      self_declared_name: string
      self_declared_frn: string | null
      approved_on: string
      content_sha256: string
      approver_user: string
    }>(
      `SELECT self_declared_name, self_declared_frn, to_char(approved_on, 'YYYY-MM-DD') AS approved_on, content_sha256, approver_user FROM promotion_approval
        WHERE subject_kind = 'message' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [r.id],
    )
    const a = approvals[0]
    // the mail itself went out (promo = the message, fixed = the notice to sign in), was stopped, failed, or is still waiting
    const went = r.mail_status === 'sent' ? (r.sent_variant === 'promo' ? 'message' : 'notice') : null
    add('messages', {
      at: iso(went ? r.finished_at! : r.sent_at),
      what:
        went === 'message'
          ? `Message from ${r.author_name} sent to this person`
          : went === 'notice'
            ? `Message from ${r.author_name}: only a notice to sign in was sent, with none of the message in it`
            : r.mail_status === 'queued'
              ? `Message from ${r.author_name}: the email to this person has not gone yet`
              : `Message from ${r.author_name} not sent to this person`,
      fields: {
        message: r.id,
        sent_to: r.kind === 'bulk' ? 'a group' : 'this person only',
        why_not_sent: r.exclusion ?? (r.mail_status === 'cancelled' ? r.cancel_reason : r.mail_status === 'failed' ? 'the email could not be delivered' : null),
        content_approved_on: a ? a.approved_on : null,
        content_approved_by: a ? `account ${a.approver_user}, name given ${a.self_declared_name} (self-declared)` : null,
        content_approved_frn: a?.self_declared_frn ? `${a.self_declared_frn} (self-declared)` : null,
        content_approved_sha256: a?.content_sha256 ?? null,
        text_erased_at: iso(r.erased_at),
      },
      shown:
        went === 'message' && r.subject !== null && r.body !== null && r.sha256
          ? { hashed: 'subject_and_text', subject: r.subject, text: r.body, sha256: r.sha256 }
          : undefined,
    })
  }

  for (const r of await rows<{ audience: string; mode: string; subject: string; sent_variant: string; finished_at: Date; deal_id: string | null }>(
    `SELECT o.audience, o.mode, o.subject, o.sent_variant, o.finished_at, o.deal_id FROM notification_outbox o
      WHERE o.status = 'sent' AND o.audience <> 'message'
        AND ((o.user_id = $1 AND (o.deal_id IS NULL OR o.deal_id = $2))
          OR o.invite_id IN (SELECT targeted_invite FROM deal_invitation WHERE id = $3))`,
    [s.userId, s.dealId, s.invitationId],
  ))
    add('mails', {
      at: iso(r.finished_at),
      what: `Email sent: ${r.subject}`,
      fields: {
        kind: r.audience,
        wording: r.sent_variant === 'promo' ? "the operator's approved wording" : 'fixed wording',
        mode: r.mode,
        about_this_deal: r.deal_id !== null,
      },
    })

  for (const r of await rows<{ key: string; version: number; regime: string; content_sha256: string }>(
    'SELECT key, version, regime, content_sha256 FROM regime_pack WHERE id = ANY($1::uuid[])',
    [[...packs]],
  ))
    add('versions', { at: null, what: `Rule pack ${r.key} version ${r.version}`, fields: { regime: r.regime, content_sha256: r.content_sha256 } })
  for (const r of await rows<{ software_version: string; first: Date; last: Date }>(
    'SELECT software_version, min(at) AS first, max(at) AS last FROM audit WHERE actor_id = $1 GROUP BY software_version',
    [s.userId],
  ))
    add('versions', { at: iso(r.first), what: `Software version ${r.software_version} in use for this person's actions`, fields: { until: iso(r.last) } })

  return out
}

export function registerD4Evidence(app: FastifyInstance, d: D4EvidenceDeps) {
  const ops = { config: { gate: 'canRunOperations' as const } }
  const now = () => d.now?.() ?? new Date()

  /** Read the pack in one snapshot and audit the export in the same transaction. */
  const pack = (who: SessionUser, invitationId: string, format: 'json' | 'pdf') =>
    tx(d.db, async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const s = (
        await c.query<Subject>(
          `SELECT i.id AS "invitationId", u.id AS "userId", u.name, u.email, d.id AS "dealId", d.public_code AS "dealCode", d.draft->'basics'->>'name' AS "dealName"
             FROM deal_invitation i JOIN user_account u ON u.id = i.user_id JOIN deal d ON d.id = i.deal_id WHERE i.id = $1 AND d.deleted_at IS NULL`,
          [invitationId],
        )
      ).rows[0]
      if (!s) throw new Refused(NOT_FOUND)
      if (await hasStake(c, who, s.dealId)) throw new Refused('You have a stake in this deal, so another reviewer or admin exports this pack.')
      const manifest = evidenceManifest({
        person: { id: s.userId, name: s.name, email: s.email },
        deal: { id: s.dealId, code: s.dealCode, name: s.dealName },
        generatedAt: now(),
        softwareVersion: SOFTWARE_VERSION,
        sections: await loadEvidence(c, s),
      })
      await appendAudit(c, d.k, { actor: who.id, action: 'evidence.exported', entity: s.invitationId, detail: { format } })
      return manifest
    })

  const attach = (reply: FastifyReply, type: string, name: string) =>
    reply.header('Content-Type', type).header('Content-Disposition', `attachment; filename="${name}"`)

  app.get<{ Params: { id: string } }>('/api/ops/invitations/:id/evidence.json', ops, async (req, reply) => {
    const m = await pack(req.user!, Uuid.parse(req.params.id), 'json')
    return attach(reply, 'application/json; charset=utf-8', 'evidence-pack.json').send(JSON.stringify(m, null, 2))
  })

  app.get<{ Params: { id: string } }>('/api/ops/invitations/:id/evidence.pdf', ops, async (req, reply) => {
    const m = await pack(req.user!, Uuid.parse(req.params.id), 'pdf')
    const blocks = evidenceBlocks(m)
    if (blocks.reduce((n, b) => n + b.text.length, 0) > PDF_MAX_CHARS)
      throw new Refused('This pack is too long for one PDF. Download the JSON list, which holds the same records.')
    return attach(reply, 'application/pdf', 'evidence-pack.pdf').send(await renderPdf(blocks, 'Evidence pack'))
  })
}
