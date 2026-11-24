// D3 lead routes: links, targeted invitations, the expected-investor list and messages (PRD R-LNK-*, R-PIP-*, R-PAGE-06).
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { feeWords, percent } from '../lib/dealSheet.ts'
import { canAdministerDeal, canReadPipeline } from '../lib/gate.ts'
import { countPeople, countWarnings, differs, linkUsable, MAX_ACTIVE_LINKS, needsTermsApproval, newLinkRefusal, type LinkTerms } from '../lib/invite.ts'
import type { LinkFee } from '../lib/fees.ts'
import {
  csvCell,
  inviteePolicyRefusal,
  MAX_PIPELINE_ROWS,
  parsePipeline,
  PIPELINE_BODY_MAX,
  PIPELINE_CSV_HEADER,
  PIPELINE_TEXT_MAX,
  pipelineTotals,
  type PolicyVersion,
} from '../lib/pipeline.ts'
import { copiedDraft, type Draft } from '../lib/draft.ts'
import { INVITEE_POLICY_KEY, textIsPlaceholder, textSha256 } from '../lib/regimePack.ts'
import { STATUSES, type Outcome } from '../lib/participation.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { refreshRelationship } from './allocation.ts'
import { sessionStillLive, type SessionUser } from './auth.ts'
import { expand, partiesOf, randomCode } from './d2.ts'
import {
  activePack,
  approvedSnapshot,
  dealById,
  dealGateFacts,
  linkFee,
  linkAssignable,
  linkState,
  lockInstanceShare,
  newToken,
  packOf,
  participationStatus,
  policyNow,
  REAL_SINCE,
  type D3Deal,
  type LinkRow,
  type Q,
} from './d3Core.ts'
import { Refused } from './requests.ts'
import type { MailQueue } from './outbox.ts'

export interface D3LeadDeps {
  db: Db
  k: Keyring
  now?: () => Date
  publicUrl?: string
  mail: MailQueue
  previewSheet: (c: Q, deal: D3Deal) => Promise<{ body: string; needs_deed: boolean; note: string }>
}

const Uuid = z.uuid()
const NOT_FOUND = 'Deal not found.'
export const Fee = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('percent'), bps: z.number().int(), mode: z.enum(['on_top', 'deducted']) }),
  z.strictObject({ kind: z.literal('fixed'), minor: z.string().regex(/^[1-9]\d{0,14}$/), mode: z.enum(['on_top', 'deducted']) }),
])
const NewLink = z.strictObject({
  kind: z.enum(['open', 'terms_only']),
  label: z.string().trim().max(200).default(''),
  carry_bps: z.number().int(),
  fee: Fee,
  reason: z.string().trim().max(2000).nullable().optional(),
  incentive_attested: z.boolean().default(false),
  // R-LNK-02: the terms are shown, then confirmed, then saved
  confirm: z.literal(true),
})

export const toFee = (f: z.infer<typeof Fee>): LinkFee => (f.kind === 'fixed' ? { kind: 'fixed', minor: BigInt(f.minor), mode: f.mode } : f)

/** R-LNK-02: on launch, no carry and no fee, and the default carry with no fee; within the operator's switches. */
export async function createDefaultLinks(c: Tx, k: Keyring, dealId: string, defaultCarryBps: number, actor: string) {
  const policy = await policyNow(c)
  const { pack } = await activePack(c)
  const kind = policy.genericLinks ? 'open' : 'terms_only'
  const wanted: Array<{ carry: number; label: string }> = [{ carry: defaultCarryBps, label: 'Default carry, no fee' }]
  // a pack that asks the lead to attest different terms and a reviewer to approve them gets no such link made for it (R-LNK-06)
  if (policy.perLinkTerms && defaultCarryBps !== 0 && !pack.incentive_attestation_required) wanted.unshift({ carry: 0, label: 'No carry, no fee' })
  for (const w of wanted)
    await insertLink(c, k, dealId, {
      kind,
      label: w.label,
      terms: { carryBps: w.carry, fee: { kind: 'none' } },
      reason: w.carry === defaultCarryBps ? null : 'Made automatically at launch.',
      attested: false,
      needsApproval: false,
      isDefault: true,
      by: actor,
    })
}

async function insertLink(
  c: Q,
  k: Keyring,
  dealId: string,
  o: {
    kind: 'open' | 'terms_only'
    label: string
    terms: LinkTerms
    reason: string | null
    attested: boolean
    needsApproval: boolean
    isDefault: boolean
    by: string
  },
): Promise<{ id: string; token: string | null }> {
  const id = randomUUID()
  const token = o.kind === 'open' ? newToken() : null
  const sealed = token ? k.encrypt(Buffer.from(token)) : null
  const f = o.terms.fee
  await c.query(
    `INSERT INTO invite_link (id, deal_id, kind, token_hmac, token_sealed, token_key_id, token_wrapped_key, label, carry_bps, fee_kind, fee_bps, fee_minor, fee_mode, reason, incentive_attested, needs_approval, is_default, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      id,
      dealId,
      o.kind,
      token ? k.hmac(`invite\0${token}`) : null,
      sealed?.ciphertext ?? null,
      sealed?.keyId ?? null,
      sealed?.wrappedDek ?? null,
      o.label,
      o.terms.carryBps,
      f.kind,
      f.kind === 'percent' ? f.bps : null,
      f.kind === 'fixed' ? String(f.minor) : null,
      f.kind === 'none' ? null : f.mode,
      o.reason,
      o.attested,
      o.needsApproval,
      o.isDefault,
      o.by,
    ],
  )
  await appendAudit(c as Tx, k, { actor: o.by, action: 'link.created', entity: id })
  return { id, token }
}

export function registerD3Lead(app: FastifyInstance, d: D3LeadDeps) {
  const verified = { config: { gate: 'verified' as const } }
  const linkTo = (path: string) => `${d.publicUrl ?? ''}${path}`

  async function heldDeal(c: Q, id: string, lock: boolean) {
    const row = (
      await c.query<{ id: string; lead_user: string; syndicate_id: string | null; draft: never; state: string }>(
        `SELECT id, lead_user, syndicate_id, draft, state FROM deal WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0]
    return row ?? null
  }

  /** The lead, co-leads and syndicate admins write; assigned members only read (R-SYN-06). */
  function leadTx<T>(who: SessionUser, id: string, write: boolean | 'pipeline', fn: (c: Tx, deal: D3Deal) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await lockInstanceShare(c)
      const row = await heldDeal(c, id, write === true)
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      if (!row) throw new Refused(NOT_FOUND)
      const parties = await partiesOf(c, row)
      // 'pipeline': reading the expected-investor list, which reviewers and admins may also do (R-PIP-01)
      const allowed = write === 'pipeline' ? canReadPipeline(who, parties) : canAdministerDeal(who, parties) && (!write || parties.leadUserIds.includes(who.id))
      if (!allowed) throw new Refused(NOT_FOUND)
      return fn(c, (await dealById(c, id))!)
    })
  }

  const defaultCarry = async (c: Q, deal: D3Deal) => {
    const snap = await approvedSnapshot(c, deal)
    return snap?.snapshot.economics?.default_carry_bps ?? 0
  }

  function linkView(l: LinkRow, currency: string, counts: { invited: number; committed: number }) {
    return {
      id: l.id,
      kind: l.kind,
      label: l.label,
      carry: percent(l.carry_bps),
      carry_bps: l.carry_bps,
      fee: feeWords(linkFee(l), currency),
      reason: l.reason,
      is_default: l.is_default,
      awaiting_approval: l.needs_approval && !l.terms_approved_at,
      disabled: !!l.disabled_at,
      disabled_reason: l.disabled_reason,
      usable: linkUsable(linkState(l)),
      ...counts,
    }
  }

  app.get<{ Params: { id: string } }>('/api/deals/:id/links', verified, async (req) => {
    return leadTx(req.user!, Uuid.parse(req.params.id), false, async (c, deal) => {
      const snap = await approvedSnapshot(c, deal)
      const currency = snap?.snapshot.terms?.currency ?? 'GBP'
      const links = (await c.query<LinkRow>('SELECT * FROM invite_link WHERE deal_id = $1 ORDER BY created_at', [deal.id])).rows
      const counts = (
        await c.query<{ invite_link: string; invited: string; committed: string }>(
          `SELECT i.invite_link, count(*)::text AS invited, count(*) FILTER (WHERE i.terms_frozen_at IS NOT NULL)::text AS committed
             FROM deal_invitation i WHERE i.deal_id = $1 AND i.state = 'active' GROUP BY i.invite_link`,
          [deal.id],
        )
      ).rows
      const pending = (
        await c.query<{ invite_link: string; n: string }>(
          'SELECT invite_link, count(*)::text AS n FROM pending_invite WHERE user_id IS NULL GROUP BY invite_link',
        )
      ).rows
      const policy = await policyNow(c)
      return {
        deal_state: deal.state,
        policy: { per_link_terms: policy.perLinkTerms, generic_links: policy.genericLinks },
        default_carry_bps: await defaultCarry(c, deal),
        active_count: links.filter((l) => !l.disabled_at).length,
        max: MAX_ACTIVE_LINKS,
        links: links.map((l) => ({
          ...linkView(l, currency, {
            invited: Number(counts.find((x) => x.invite_link === l.id)?.invited ?? 0),
            committed: Number(counts.find((x) => x.invite_link === l.id)?.committed ?? 0),
          }),
          // §5.2: opened but not bound to anyone yet, counted by link only
          opened_unbound: Number(pending.find((p) => p.invite_link === l.id)?.n ?? 0),
        })),
        reach: await reach(c, deal),
      }
    })
  })

  /** R-LNK-09: counted when bound, once per person, by the country they gave; passing or a withdrawn invitation does not take anyone off (they received the promotion). A reminder only. */
  async function reach(c: Q, deal: D3Deal) {
    const people = (
      await c.query<{ user_id: string; country: string | null }>(
        "SELECT i.user_id, u.country FROM deal_invitation i JOIN user_account u ON u.id = i.user_id WHERE i.deal_id = $1",
        [deal.id],
      )
    ).rows.map((r) => ({ userId: r.user_id, country: r.country }))
    const counted = countPeople(people)
    const ukRaised = BigInt(
      (
        await c.query<{ t: string }>(
          "SELECT coalesce(sum(p.invest_minor), 0)::text AS t FROM participation p JOIN user_account u ON u.id = p.user_id WHERE p.deal_id = $1 AND p.outcome = 'active' AND u.country = 'GB'",
          [deal.id],
        )
      ).rows[0]!.t,
    )
    const limit = (await c.query<{ eea_count_limit: number }>('SELECT eea_count_limit FROM deal_config WHERE id = 1')).rows[0]!.eea_count_limit
    return { counts: counted, warnings: countWarnings(counted, ukRaised, limit), note: 'These are reminders only. Do not promote this deal publicly.' }
  }

  app.post<{ Params: { id: string } }>('/api/deals/:id/links', verified, async (req) => {
    const b = NewLink.parse(req.body)
    const who = req.user!
    return leadTx(who, Uuid.parse(req.params.id), true, async (c, deal) => {
      const pack = await packOf(c, deal)
      const policy = await policyNow(c)
      const cfg = (await c.query<{ link_fee_max_bps: number }>('SELECT link_fee_max_bps FROM deal_config WHERE id = 1')).rows[0]!
      const active = Number(
        (await c.query<{ n: string }>('SELECT count(*)::text AS n FROM invite_link WHERE deal_id = $1 AND disabled_at IS NULL', [deal.id])).rows[0]!.n,
      )
      const terms: LinkTerms = { carryBps: b.carry_bps, fee: toFee(b.fee) }
      const dc = await defaultCarry(c, deal)
      const attestationRequired = !!pack?.incentive_attestation_required
      const refusal = newLinkRefusal({
        dealLive: deal.state === 'live' && !deal.from_sandbox,
        activeLinks: active,
        defaultCarryBps: dc,
        feeMaxBps: cfg.link_fee_max_bps,
        policy,
        kind: b.kind,
        terms,
        reason: b.reason ?? null,
        incentiveAttested: b.incentive_attested,
        attestationRequired,
      })
      if (refusal) throw new Refused(refusal)
      const made = await insertLink(c, d.k, deal.id, {
        kind: b.kind,
        label: b.label,
        terms,
        reason: differs(terms, dc) ? b.reason!.trim() : null,
        attested: b.incentive_attested,
        needsApproval: needsTermsApproval(terms, dc, attestationRequired),
        isDefault: false,
        by: who.id,
      })
      return {
        id: made.id,
        url: made.token ? linkTo(`/invite?token=${made.token}`) : null,
        awaiting_approval: needsTermsApproval(terms, dc, attestationRequired),
      }
    })
  })

  // R-LNK-04: shown again for a person to copy; nothing writes to the clipboard
  app.get<{ Params: { id: string; link: string } }>('/api/deals/:id/links/:link/url', verified, async (req) => {
    const who = req.user!
    return leadTx(who, Uuid.parse(req.params.id), false, async (c, deal) => {
      const l = (
        await c.query<{ token_sealed: Buffer | null; token_key_id: string | null; token_wrapped_key: Buffer | null; id: string }>(
          'SELECT id, token_sealed, token_key_id, token_wrapped_key FROM invite_link WHERE id = $1 AND deal_id = $2',
          [Uuid.parse(req.params.link), deal.id],
        )
      ).rows[0]
      if (!l) throw new Refused(NOT_FOUND)
      if (!l.token_sealed) throw new Refused('This link keeps terms only. Use it by sending an invitation to an address.')
      await appendAudit(c, d.k, { actor: who.id, action: 'link.url_shown', entity: l.id })
      return { url: linkTo(`/invite?token=${d.k.decrypt(l.token_key_id!, l.token_wrapped_key!, l.token_sealed).toString()}`) }
    })
  })

  app.post<{ Params: { id: string; link: string } }>('/api/deals/:id/links/:link/disable', verified, async (req) => {
    const who = req.user!
    return leadTx(who, Uuid.parse(req.params.id), true, async (c, deal) => {
      const r = await c.query(
        "UPDATE invite_link SET disabled_at = clock_timestamp(), disabled_reason = 'lead' WHERE id = $1 AND deal_id = $2 AND disabled_at IS NULL",
        [Uuid.parse(req.params.link), deal.id],
      )
      if (!r.rowCount) throw new Refused('This link is already off.')
      // R-LNK-10: people bound but not committed see that the invitation was withdrawn; committed people are unaffected
      const revoked = await c.query(
        "UPDATE deal_invitation SET state = 'revoked', ended_at = clock_timestamp() WHERE invite_link = $1 AND state = 'active' AND terms_frozen_at IS NULL RETURNING id, user_id",
        [req.params.link],
      )
      // §5.6: for someone with nothing else going on, the relationship ends here
      for (const r of revoked.rows as { user_id: string }[]) await refreshRelationship(c, r.user_id, d.now?.() ?? new Date())
      await appendAudit(c, d.k, { actor: who.id, action: 'link.disabled', entity: req.params.link, detail: { revoked: revoked.rowCount } })
      return { ok: true, revoked: revoked.rowCount }
    })
  })

  // R-LNK-05: before the first commitment the lead can move a person to another link
  app.post<{ Params: { id: string; invitation: string } }>('/api/deals/:id/invitations/:invitation/link', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ link_id: z.uuid() }).parse(req.body)
    return leadTx(who, Uuid.parse(req.params.id), true, async (c, deal) => {
      if (deal.state !== 'live') throw new Refused('Links can be replaced only while the deal is live.')
      const inv = (
        await c.query<{ id: string; terms_frozen_at: Date | null }>(
          "SELECT id, terms_frozen_at FROM deal_invitation WHERE id = $1 AND deal_id = $2 AND state = 'active' FOR UPDATE",
          [Uuid.parse(req.params.invitation), deal.id],
        )
      ).rows[0]
      if (!inv) throw new Refused(NOT_FOUND)
      if (inv.terms_frozen_at) throw new Refused('This person has committed, so their terms are fixed. A change goes through a change request.')
      const l = (await c.query<LinkRow>('SELECT * FROM invite_link WHERE id = $1 AND deal_id = $2', [b.link_id, deal.id])).rows[0]
      if (!l || !(await linkAssignable(c, deal, l))) throw new Refused('Choose a link that is in use and allowed by the current settings.')
      await c.query('UPDATE deal_invitation SET invite_link = $2 WHERE id = $1', [inv.id, l.id])
      await appendAudit(c, d.k, { actor: who.id, action: 'invitation.link_replaced', entity: inv.id })
      return { ok: true }
    })
  })

  // ---------- Whom to invite (R-PIP-06, decision R29) ----------

  /** The operator's text in the active pack: it is the operator's rule for leads, so a deal's bound pack does not keep an old one. */
  async function inviteePolicyNow(c: Q) {
    const { id, pack } = await activePack(c)
    const t = pack.legal_texts.find((x) => x.text_key === INVITEE_POLICY_KEY && x.variant === 'default')
    if (!t) return null
    return { packId: id, version: t.version, sha256: textSha256(t.body), body: t.body, placeholder: textIsPlaceholder(t) }
  }

  /** Only this account's own confirmations count, never another lead's. */
  const confirmedBy = async (c: Q, userId: string): Promise<PolicyVersion[]> =>
    (await c.query<{ version: number; sha256: string }>('SELECT text_version AS version, text_sha256 AS sha256 FROM invitee_policy_ack WHERE user_id = $1', [userId])).rows

  async function requireInviteePolicy(c: Q, who: SessionUser) {
    const now = await inviteePolicyNow(c)
    const refusal = inviteePolicyRefusal(now && { version: now.version, sha256: now.sha256 }, await confirmedBy(c, who.id))
    if (refusal) throw new Refused(refusal)
  }

  app.get<{ Params: { id: string } }>('/api/deals/:id/invitee-policy', verified, async (req) => {
    const who = req.user!
    return leadTx(who, Uuid.parse(req.params.id), false, async (c) => {
      const now = await inviteePolicyNow(c)
      const confirmed = await confirmedBy(c, who.id)
      return {
        text: now && { body: now.body, version: now.version, sha256: now.sha256, placeholder: now.placeholder },
        confirmed: !inviteePolicyRefusal(now && { version: now.version, sha256: now.sha256 }, confirmed),
        confirmed_before: confirmed.length > 0,
      }
    })
  })

  // the version and words the lead read are sent back, so a text changed meanwhile is not confirmed unseen.
  // Anyone who runs the deal may confirm: it is their own statement, not a change to the deal, and a team member needs it to copy the deal with its people (R-PIP-05)
  app.post<{ Params: { id: string } }>('/api/deals/:id/invitee-policy', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ version: z.number().int().positive().max(2147483647), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.body)
    return leadTx(who, Uuid.parse(req.params.id), false, async (c, deal) => {
      const now = await inviteePolicyNow(c)
      if (!now) throw new Refused(inviteePolicyRefusal(null, [])!)
      if (now.version !== b.version || now.sha256 !== b.sha256) throw new Refused('The operator changed this text since you opened it. Read it again.')
      if (!inviteePolicyRefusal(now, await confirmedBy(c, who.id))) return { ok: true }
      const id = randomUUID()
      await c.query('INSERT INTO invitee_policy_ack (id, user_id, pack_id, text_version, text_sha256, deal_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        id,
        who.id,
        now.packId,
        now.version,
        now.sha256,
        deal.id,
      ])
      await appendAudit(c, d.k, { actor: who.id, action: 'invitee_policy.confirmed', entity: id, detail: { version: now.version, sha256: now.sha256 } })
      return { ok: true }
    })
  })

  // ---------- Targeted invitations (R-LNK-07) ----------

  async function sendTargeted(c: Tx, who: SessionUser, deal: D3Deal, email: string, linkId: string, reentry: boolean, pipelineId: string | null) {
    const l = (await c.query<LinkRow>('SELECT * FROM invite_link WHERE id = $1 AND deal_id = $2', [linkId, deal.id])).rows[0]
    if (!l || !(await linkAssignable(c, deal, l))) throw new Refused('Choose a link that is in use and allowed by the current settings.')
    const token = newToken()
    const id = randomUUID()
    await c.query('INSERT INTO targeted_invite (id, deal_id, invite_link, token_hmac, email, allows_reentry, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id,
      deal.id,
      l.id,
      d.k.hmac(`invite\0${token}`),
      email.trim(),
      reentry,
      who.id,
    ])
    if (pipelineId) await c.query('UPDATE pipeline_entry SET targeted_invite = $2, invite_link = $3 WHERE id = $1', [pipelineId, id, l.id])
    await appendAudit(c, d.k, { actor: who.id, action: 'invitation.targeted_sent', entity: id })
    // R-NTF-02: goes only while the invitation is open and the deal live and not held
    await d.mail.investor(c, { action: 'invitation', audience: { kind: 'invite', inviteId: id, dealId: deal.id }, to: email.trim(), dealId: deal.id, link: linkTo(`/invite?token=${token}`) })
    return { id }
  }

  app.post<{ Params: { id: string } }>('/api/deals/:id/targeted', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ email: z.email().max(320), link_id: z.uuid(), allows_reentry: z.boolean().default(false) }).parse(req.body)
    const out = await leadTx(who, Uuid.parse(req.params.id), true, async (c, deal) => {
      if (deal.state !== 'live' || deal.from_sandbox) throw new Refused('Invitations can be sent only while the deal is live.')
      if (activeHoldOf(await dealGateFacts(c, deal))) throw new Refused('The operator has paused this deal.')
      await requireInviteePolicy(c, who)
      return sendTargeted(c, who, deal, b.email, b.link_id, b.allows_reentry, null)
    })
    await d.mail.flush()
    return { id: out.id }
  })

  // R-LNK-07: sent again with a new token; the old one stops working. R-PIP-03: optionally to a corrected address (Codex round 6)
  app.post<{ Params: { id: string; targeted: string } }>('/api/deals/:id/targeted/:targeted/resend', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ email: z.email().max(320).optional() }).parse(req.body ?? {})
    const out = await leadTx(who, Uuid.parse(req.params.id), true, async (c, deal) => {
      if (deal.state !== 'live' || deal.from_sandbox) throw new Refused('Invitations can be sent only while the deal is live.')
      if (activeHoldOf(await dealGateFacts(c, deal))) throw new Refused('The operator has paused this deal.')
      await requireInviteePolicy(c, who)
      const t = (
        await c.query<{ id: string; email: string; invite_link: string; allows_reentry: boolean; consumed_at: Date | null; revoked_at: Date | null }>(
          'SELECT * FROM targeted_invite WHERE id = $1 AND deal_id = $2 FOR UPDATE',
          [Uuid.parse(req.params.targeted), deal.id],
        )
      ).rows[0]
      if (!t) throw new Refused(NOT_FOUND)
      if (t.consumed_at) throw new Refused('This invitation has been accepted already.')
      // only the current invitation is resent: a replaced one has a successor already, so a second resend makes no second live one
      if (t.revoked_at) throw new Refused('This invitation was replaced already. Resend the newest one.')
      await c.query('UPDATE targeted_invite SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL', [t.id])
      const pipe = (await c.query<{ id: string }>('SELECT id FROM pipeline_entry WHERE targeted_invite = $1', [t.id])).rows[0]
      const email = b.email?.trim() ?? t.email
      if (email.toLowerCase() !== t.email.toLowerCase()) {
        // the new token is bound to the corrected address; the list row follows it, so it is matched there from now on
        if (pipe) {
          const taken = await c.query('SELECT 1 FROM pipeline_entry WHERE deal_id = $1 AND id <> $2 AND removed_at IS NULL AND lower(email) = lower($3)', [
            deal.id,
            pipe.id,
            email,
          ])
          if (taken.rowCount) throw new Refused('Someone else on the list has this address already.')
          await c.query('UPDATE pipeline_entry SET email = $2 WHERE id = $1', [pipe.id, email])
        }
        await appendAudit(c, d.k, { actor: who.id, action: 'invitation.address_corrected', entity: t.id })
      }
      return sendTargeted(c, who, deal, email, t.invite_link, t.allows_reentry, pipe?.id ?? null)
    })
    await d.mail.flush()
    return { id: out.id }
  })

  // R-SIG-02: the default deal sheet, for the lead and the deal's team to read; recorded who looked (Codex round 7)
  app.get<{ Params: { id: string } }>('/api/deals/:id/deal-sheet-preview', verified, async (req) => {
    const who = req.user!
    return leadTx(who, Uuid.parse(req.params.id), false, async (c, deal) => {
      const sheet = await d.previewSheet(c, deal)
      await appendAudit(c, d.k, { actor: who.id, action: 'deal_sheet.previewed', entity: deal.id })
      return sheet
    })
  })

  // ---------- Expected investors (R-PIP-01 to R-PIP-04) ----------

  async function pipelineRows(c: Q, deal: D3Deal) {
    const rows = (
      await c.query<{
        id: string
        name: string
        email: string
        expected_minor: string | null
        terms_label: string
        invite_link: string | null
        private_note: string | null
        targeted_invite: string | null
      }>(
        'SELECT id, name, email, expected_minor, terms_label, invite_link, private_note, targeted_invite FROM pipeline_entry WHERE deal_id = $1 AND removed_at IS NULL ORDER BY created_at, id',
        [deal.id],
      )
    ).rows
    const pack = await packOf(c, deal)
    const out = []
    for (const r of rows) {
      // R-PIP-03: matched by verified address; a different address stays "not responded"
      const user = (await c.query<{ id: string }>('SELECT id FROM user_account WHERE lower(email) = lower($1) AND email_verified_at IS NOT NULL', [r.email]))
        .rows[0]
      const inv = user
        ? (
            await c.query<{ id: string; state: 'active' | 'passed' | 'revoked' }>(
              `SELECT id, state FROM deal_invitation WHERE deal_id = $1 AND user_id = $2 AND created_at >= ${REAL_SINCE} ORDER BY created_at DESC LIMIT 1`,
              [deal.id, user.id],
            )
          ).rows[0]
        : undefined
      // every entity this person committed with, under any invitation to this deal
      const parts = user
        ? (
            await c.query<{
              id: string
              entity_id: string
              entity_version: number
              outcome: Outcome
              identity_review: string
              cash_due_minor: string
              invested_minor: string | null
              invest_minor: string
            }>(
              `SELECT id, entity_id, entity_version, outcome, identity_review, cash_due_minor, invested_minor, invest_minor FROM participation WHERE deal_id = $1 AND user_id = $2 AND created_at >= ${REAL_SINCE} ORDER BY join_seq`,
              [deal.id, user.id],
            )
          ).rows
        : []
      const active = parts.filter((p) => p.outcome === 'active')
      // R-PIP-03: the §5.2 status from the real facts of the furthest-along entity. R-KYC-02.1: a refusal is never shown to
      // the lead; with nothing else in progress it reads as being with the operator.
      let status: string
      let label: string
      if (!inv) [status, label] = ['not_responded', 'Not responded']
      else if (active.length && pack) {
        const all = await Promise.all(active.map((p) => participationStatus(c, p, pack, (d.now?.() ?? new Date()).toISOString().slice(0, 10), d.now?.())))
        const best = all.sort((a, b) => STATUSES.indexOf(b.status) - STATUSES.indexOf(a.status))[0]!
        ;[status, label] = [best.status, best.label]
      } else if (inv.state === 'active' && parts.some((p) => p.outcome === 'rejected_kyc')) [status, label] = ['with_operator', 'With the operator']
      else if (inv.state === 'active') [status, label] = ['invited', 'Invited']
      else if (inv.state === 'passed') [status, label] = ['declined', 'Declined']
      else [status, label] = ['ended', 'No longer taking part']
      out.push({
        ...r,
        status,
        committed: active.length > 0,
        status_label: label,
        committed_invest_minor: active.reduce((a, p) => a + BigInt(p.invest_minor), 0n).toString(),
      })
    }
    return out
  }

  // R-PIP-05: a new draft from a deal this person may run, with only the listed fields; optionally the people the earlier deal
  // invited, as name and address only (R-PIP-06 first: importing a list). The copier is the new draft's lead.
  app.post<{ Params: { id: string } }>('/api/deals/:id/copy', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ import_invited: z.boolean().default(false) }).parse(req.body ?? {})
    return leadTx(who, Uuid.parse(req.params.id), false, async (c, deal) => {
      if (b.import_invited) await requireInviteePolicy(c, who)
      // the approved version with its people put back (carry recipients are kept apart from it), else the draft as saved
      const snap = await approvedSnapshot(c, deal)
      const src = snap ? await expand(c, snap.snapshot as Record<string, unknown>) : (await c.query<{ draft: Draft }>('SELECT draft FROM deal WHERE id = $1', [deal.id])).rows[0]!.draft
      const id = randomUUID()
      await c.query('INSERT INTO deal (id, lead_user, public_code, draft) VALUES ($1, $2, $3, $4)', [
        id,
        who.id,
        randomCode(),
        JSON.stringify(copiedDraft(src as Draft)),
      ])
      let invited = 0
      if (b.import_invited) {
        // whoever the earlier deal invited: accepted invitations and the list's sent invitations, once each by address
        const people = (
          await c.query<{ name: string; email: string }>(
            `SELECT DISTINCT ON (lower(email)) name, email FROM (
               SELECT u.name, u.email, i.created_at FROM deal_invitation i JOIN user_account u ON u.id = i.user_id
                WHERE i.deal_id = $1 AND i.created_at >= ${REAL_SINCE} AND u.name IS NOT NULL AND length(trim(u.name)) BETWEEN 1 AND 200
               UNION ALL
               SELECT p.name, p.email, p.created_at FROM pipeline_entry p
                WHERE p.deal_id = $1 AND p.targeted_invite IS NOT NULL AND p.removed_at IS NULL AND p.created_at >= ${REAL_SINCE}
             ) x WHERE lower(email) <> lower((SELECT email FROM user_account WHERE id = $2))
             ORDER BY lower(email), created_at LIMIT ${MAX_PIPELINE_ROWS}`,
            [deal.id, who.id],
          )
        ).rows
        for (const p of people)
          await c.query('INSERT INTO pipeline_entry (id, deal_id, name, email, created_by) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), id, p.name, p.email, who.id])
        invited = people.length
      }
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.copied', entity: id, detail: { from: deal.id, invited } })
      return { id, invited }
    })
  })

  app.get<{ Params: { id: string } }>('/api/deals/:id/pipeline', verified, async (req) => {
    return leadTx(req.user!, Uuid.parse(req.params.id), 'pipeline', async (c, deal) => {
      const rows = await pipelineRows(c, deal)
      const invest = (await c.query<{ t: string }>("SELECT invest_minor::text AS t FROM participation WHERE deal_id = $1 AND outcome = 'active'", [deal.id])).rows
      const { committed, expected } = pipelineTotals(
        invest.map((r) => BigInt(r.t)),
        rows,
      )
      const snap = await approvedSnapshot(c, deal)
      const draftAlloc = (await c.query<{ a: string | null }>("SELECT draft->'terms'->>'allocation_minor' AS a FROM deal WHERE id = $1", [deal.id])).rows[0]!.a
      return {
        currency:
          snap?.snapshot.terms?.currency ??
          (await c.query<{ c: string | null }>("SELECT draft->'terms'->>'currency' AS c FROM deal WHERE id = $1", [deal.id])).rows[0]!.c ??
          'GBP',
        rows,
        not_responded: rows.filter((r) => r.status === 'not_responded' || r.status === 'invited').map((r) => r.name),
        totals: {
          committed_minor: String(committed),
          expected_minor: String(expected),
          expected_note: 'Expected amounts are what you typed. They are not commitments.',
          allocation_minor: snap?.snapshot.terms?.allocation_minor ?? draftAlloc,
        },
      }
    })
  })

  // any list the app exported reads back in one request, whatever its characters (Codex rounds 10 and 11)
  app.post<{ Params: { id: string } }>('/api/deals/:id/pipeline', { ...verified, bodyLimit: PIPELINE_BODY_MAX }, async (req) => {
    const who = req.user!
    const b = z.strictObject({ text: z.string().max(PIPELINE_TEXT_MAX), dry_run: z.boolean().default(false) }).parse(req.body)
    return leadTx(who, Uuid.parse(req.params.id), true, async (c, deal) => {
      await requireInviteePolicy(c, who)
      const existing = (await c.query<{ email: string }>('SELECT email FROM pipeline_entry WHERE deal_id = $1 AND removed_at IS NULL', [deal.id])).rows.map(
        (r) => r.email,
      )
      const parsed = parsePipeline(b.text, existing, MAX_PIPELINE_ROWS - existing.length)
      if (b.dry_run || parsed.errors.length) return { added: 0, ...parsed }
      for (const r of parsed.rows)
        await c.query(
          'INSERT INTO pipeline_entry (id, deal_id, name, email, expected_minor, terms_label, private_note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [randomUUID(), deal.id, r.name, r.email, r.expected_minor, r.terms_label, r.private_note, who.id],
        )
      await appendAudit(c, d.k, { actor: who.id, action: 'pipeline.rows_added', entity: deal.id, detail: { n: parsed.rows.length } })
      return { added: parsed.rows.length, ...parsed }
    })
  })

  app.delete<{ Params: { id: string; entry: string } }>('/api/deals/:id/pipeline/:entry', verified, async (req) => {
    const who = req.user!
    return leadTx(who, Uuid.parse(req.params.id), true, async (c, deal) => {
      const r = await c.query('UPDATE pipeline_entry SET removed_at = clock_timestamp() WHERE id = $1 AND deal_id = $2 AND removed_at IS NULL', [
        Uuid.parse(req.params.entry),
        deal.id,
      ])
      if (!r.rowCount) throw new Refused(NOT_FOUND)
      return { ok: true }
    })
  })

  app.get<{ Params: { id: string } }>('/api/deals/:id/pipeline.csv', verified, async (req, reply) => {
    const rows = await leadTx(req.user!, Uuid.parse(req.params.id), false, async (c, deal) => {
      // R-CMP-03: the operator decides whether leads may take the list away
      if (!(await policyNow(c)).exportRoles.includes('lead')) throw new Refused('The operator does not allow leads to export this list.')
      return pipelineRows(c, deal)
    })
    // amounts in pounds and pence, as typed in, so the file reads back the same (R-PIP-01)
    const pounds = (m: string | null) => (m ? `${BigInt(m) / 100n}.${String(BigInt(m) % 100n).padStart(2, '0')}` : '')
    const csv = [
      PIPELINE_CSV_HEADER,
      ...rows.map((r) => [r.name, r.email, pounds(r.expected_minor), r.terms_label, r.private_note ?? '', r.status_label].map(csvCell).join(',')),
    ].join('\r\n')
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="expected-investors.csv"').send(csv)
  })

  const SendBody = z.strictObject({
    entries: z
      .array(z.strictObject({ id: z.uuid(), link_id: z.uuid() }))
      .min(1)
      .max(MAX_PIPELINE_ROWS)
      // one invitation per person on the list: the same row twice is refused, not sent twice (Codex round 5)
      .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, 'Each person can be chosen once.'),
    // R-PIP-02: the person saw how many and on which terms, and confirms that number and that plan
    confirm_count: z.number().int().positive(),
    plan_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })

  /** R-PIP-02: what one click would send, for the person to confirm. Nothing is sent. */
  app.post<{ Params: { id: string } }>('/api/deals/:id/pipeline/preview', verified, async (req) => {
    const b = z.strictObject({ entries: SendBody.shape.entries }).parse(req.body)
    return leadTx(req.user!, Uuid.parse(req.params.id), false, async (c, deal) => {
      const plan = await planSend(c, deal, b.entries)
      return { count: plan.send.length, skipped: plan.skipped, by_terms: plan.byTerms, plan_sha256: planSha(plan.send), reach: await reach(c, deal) }
    })
  })

  /** Who gets which terms, exactly: what the preview showed is what is sent. */
  const planSha = (send: Array<{ id: string; email: string; link: LinkRow }>) =>
    createHash('sha256')
      .update(JSON.stringify(send.map((x) => [x.id, x.email, x.link.id, x.link.carry_bps, x.link.fee_kind, x.link.fee_bps, x.link.fee_minor, x.link.fee_mode])))
      .digest('hex')

  async function planSend(c: Q, deal: D3Deal, entries: Array<{ id: string; link_id: string }>) {
    const rows = await pipelineRows(c, deal)
    const links = (await c.query<LinkRow>('SELECT * FROM invite_link WHERE deal_id = $1', [deal.id])).rows
    const send: Array<{ id: string; email: string; link: LinkRow }> = []
    const skipped: Array<{ name: string; why: string }> = []
    for (const e of entries) {
      const r = rows.find((x) => x.id === e.id)
      if (!r) continue
      const l = links.find((x) => x.id === e.link_id)
      if (!l || !(await linkAssignable(c, deal, l))) {
        skipped.push({ name: r.name, why: 'The chosen link is not in use, or the current settings no longer allow its terms.' })
        continue
      }
      // R-LNK-07: sent once; sending again is the resend action, which makes the old link stop working
      if (r.targeted_invite) {
        skipped.push({ name: r.name, why: 'Already sent. Use resend to send it again.' })
        continue
      }
      // §5.2: a person whose invitation ended is not brought back by one click
      if (!['not_responded'].includes(r.status)) {
        skipped.push({
          name: r.name,
          why: r.status === 'invited' ? 'Already invited.' : 'Already responded; a person who left needs an invitation of their own.',
        })
        continue
      }
      send.push({ id: r.id, email: r.email, link: l })
    }
    const byTerms: Record<string, number> = {}
    const snap = await approvedSnapshot(c, deal)
    const currency = snap?.snapshot.terms?.currency ?? 'GBP'
    for (const s of send) {
      const key = `${percent(s.link.carry_bps)} carry · ${feeWords(linkFee(s.link), currency)}`
      byTerms[key] = (byTerms[key] ?? 0) + 1
    }
    return { send, skipped, byTerms }
  }

  app.post<{ Params: { id: string } }>('/api/deals/:id/pipeline/invite', verified, async (req) => {
    const who = req.user!
    const b = SendBody.parse(req.body)
    const out = await leadTx(who, Uuid.parse(req.params.id), true, async (c, deal) => {
      if (deal.state !== 'live' || deal.from_sandbox) throw new Refused('Invitations can be sent only while the deal is live.')
      if (activeHoldOf(await dealGateFacts(c, deal))) throw new Refused('The operator has paused this deal.')
      await requireInviteePolicy(c, who)
      const plan = await planSend(c, deal, b.entries)
      if (plan.send.length !== b.confirm_count || planSha(plan.send) !== b.plan_sha256)
        throw new Refused('The list has changed since you checked it. Check it again.')
      for (const s of plan.send) await sendTargeted(c, who, deal, s.email, s.link.id, false, s.id)
      return { sent: plan.send.length, skipped: plan.skipped }
    })
    await d.mail.flush()
    return { sent: out.sent, skipped: out.skipped }
  })

  // R-PAGE-06
  app.get<{ Params: { id: string } }>('/api/deals/:id/messages', verified, async (req) => {
    return leadTx(req.user!, Uuid.parse(req.params.id), false, async (c, deal) => ({
      messages: (
        await c.query(
          'SELECT m.id, m.body, m.created_at, u.name AS author FROM deal_message m JOIN user_account u ON u.id = m.author WHERE m.deal_id = $1 ORDER BY m.created_at DESC LIMIT 500',
          [deal.id],
        )
      ).rows,
    }))
  })
}

const activeHoldOf = (g: { holds: { deal: boolean; lead: boolean; instance: boolean } }) => g.holds.deal || g.holds.lead || g.holds.instance
