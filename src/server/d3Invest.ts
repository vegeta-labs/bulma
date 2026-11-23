// D3 investor routes: opening a link, accepting, the deal page, committing, signing, payment instructions (PRD §4.9 to 4.13).
// Every rule comes from lib/; this file reads facts, asks the gate, and writes inside one transaction.
import { deliveryFor, type Delivery } from '../lib/message.ts'
import type { PromoWarning } from '../lib/mailContent.ts'
import { STUCK_PAYMENT_HELP } from '../lib/unallocated.ts'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { breakdown, feeWords, money, percent, renderDealSheet, signedSheetFits } from '../lib/dealSheet.ts'
import { richTextPlain } from '../lib/richText.ts'
import { isQualified, preparation, type EligibilityFacts } from '../lib/eligibility.ts'
import { commitmentRefusal, MAX_DUE_MINOR } from '../lib/fees.ts'
import { expectedInvestment, leastInvestment, type FeePayer } from '../lib/estimate.ts'
import {
  activeHold,
  canCommit,
  canContinueOwnParticipation,
  canReceivePromotion,
  canSeeIssuedInstructions,
  canSeeOwnExecutedDocs,
  canSeePaymentInstructions,
  canSign,
  type DealGateFacts,
  type OwnParticipationFacts,
  type PersonGateFacts,
} from '../lib/gate.ts'
import { decideAccept, INVITE_OPENS_PER_IP, INVITE_OPENS_PER_TOKEN, PENDING_INVITE_DAYS } from '../lib/invite.ts'
import { allowedEmbed } from '../lib/draft.ts'
import { sandboxPaymentInstruction, type Mode } from '../lib/instance.ts'
import { deriveStatus, STATUS_LABEL } from '../lib/participation.ts'
import { PDF_MAX_CHARS, renderPdf } from './pdf.ts'
import { issueReference, normaliseReference } from '../lib/reference.ts'
import { warningVariant } from '../lib/eligibility.ts'
import { fillText, type RegimePack } from '../lib/regimePack.ts'
import type { Adapters } from '../adapters/index.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { reserveAttempt, sessionStillLive, type SessionUser } from './auth.ts'
import { tellReviewers } from './ledger.ts'
import { allocationOf, capacityFor, endProposal, openProposal, refreshRelationship, tellLeads } from './allocation.ts'
import { capacityRefusal, waitlistRefusal } from '../lib/allocation.ts'
import { acceptProposalRefusal } from '../lib/money.ts'
import { ensureTodo, loadMoney, noteReason } from './ledger.ts'
import { endParticipation } from './d4Life.ts'
import { pendingReconfirmation, reconfirmClock, reconfirmLapsed, termsAt } from './reconfirm.ts'
import { changesShown } from '../lib/change.ts'
import { onDisagree } from '../lib/deadline.ts'
import { diffContent, type FieldChange } from '../lib/snapshot.ts'
import {
  approvedSnapshot,
  dealById,
  dealGateFacts,
  EXECUTED,
  feeConfigOf,
  freeze,
  heldMinor,
  linkAssignable,
  linkFee,
  linkState,
  lockInstanceShare,
  logParticipation,
  newToken,
  packOf,
  participationFacts,
  REAL_SINCE,
  voidInstruction,
  type D3Deal,
  type FrozenTerms,
  type LinkRow,
  type Q,
  type Snapshot,
} from './d3Core.ts'
import { withWarningCover } from './pdfCover.ts'
import { toLead } from './d2Investee.ts'
import type { MailQueue } from './outbox.ts'
import { Refused } from './requests.ts'

export const INVITE_COOKIE = 'bulma_invite'
/** §5.8: people on one deal. */
export const MAX_INVESTORS = 500

export interface D3Deps {
  db: Db
  k: Keyring
  now?: () => Date
  publicUrl?: string
  secureCookies?: boolean
  mail: MailQueue
  eligibilityFacts: (c: Q, userId: string, pack: RegimePack) => Promise<EligibilityFacts>
  adapters: () => Promise<Adapters>
}

const Uuid = z.uuid()
const Amount = z.string().regex(/^[1-9]\d{0,14}$/)
const NOT_FOUND = 'Not found.'
/** Shown wherever a deal cannot be shown: no company name, no terms (R-PAGE-05, R-CMP-01). */
const NEUTRAL = 'This deal is not available to you at the moment.'
const DONT_PAY = 'Do not send money for this deal at the moment. Your operator will contact you.'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

interface InvitationRow {
  id: string
  deal_id: string
  user_id: string
  invite_link: string
  state: 'active' | 'passed' | 'revoked'
  terms_snapshot: FrozenTerms | null
}

interface ParticipationRow {
  id: string
  /** The deal version the person last agreed to (set at commitment, moved by reconfirming). */
  agreed_version: number | null
  invitation_id: string
  deal_id: string
  user_id: string
  entity_id: string
  entity_version: number
  outcome: OwnParticipationFacts['outcome']
  identity_review: 'none' | 'pending' | 'resolved'
  scheme: 'none' | 'seis' | 'eis'
  commitment_minor: string
  invest_minor: string
  lead_fee_minor: string
  rounding_minor: string
  cash_due_minor: string
  terms_version: number
  reference: string
  invested_minor: string | null
}

export function registerD3Invest(app: FastifyInstance, d: D3Deps) {
  const now = () => d.now?.() ?? new Date()
  const pub = { config: { gate: 'public' as const } }
  const verified = { config: { gate: 'verified' as const } }
  const linkTo = (path: string) => `${d.publicUrl ?? ''}${path}`
  const today = () => now().toISOString().slice(0, 10)
  const alloc = { k: d.k, mail: d.mail, now }
  const modeOf = async (c: Q) => (await c.query<{ mode: Mode }>('SELECT mode FROM instance_profile WHERE id = 1')).rows[0]!.mode

  /** A signed-in person's write: the session is checked again once the instance row is held. */
  function personTx<T>(who: SessionUser, fn: (c: Tx) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await lockInstanceShare(c)
      await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [who.id])
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      return fn(c)
    })
  }

  const linkById = async (c: Q, id: string) => (await c.query<LinkRow>('SELECT * FROM invite_link WHERE id = $1', [id])).rows[0] ?? null
  const activeInvitation = async (c: Q, dealId: string, userId: string) =>
    (
      await c.query<InvitationRow>(`SELECT * FROM deal_invitation WHERE deal_id = $1 AND user_id = $2 AND state = 'active' AND created_at >= ${REAL_SINCE}`, [
        dealId,
        userId,
      ])
    ).rows[0] ?? null

  async function personFacts(c: Q, userId: string, deal: D3Deal, pack: RegimePack) {
    const f = await d.eligibilityFacts(c, userId, pack)
    const inv = await activeInvitation(c, deal.id, userId)
    const person: PersonGateFacts = { qualified: isQualified(pack, f, now()), invitationActive: !!inv }
    return { person, inv, eligibility: f }
  }

  /** Everything a participation gate reads. */
  async function ownFacts(
    c: Q,
    p: ParticipationRow,
    mode: Mode,
  ): Promise<OwnParticipationFacts & { held: bigint; transferMarked: boolean; signatureId: string | null }> {
    const base = await participationFacts(c, p, today())
    return { ...base, accountAcknowledged: await accountAcknowledged(c, p.id, mode) }
  }

  /** The receiving account in force for this currency: the sandbox's fictional one, or the newest approved version. */
  async function currentAccount(c: Q, currency: string, mode: Mode) {
    if (mode === 'sandbox') {
      const s = sandboxPaymentInstruction((['GBP', 'USD', 'EUR'].includes(currency) ? currency : 'GBP') as 'GBP')
      return {
        id: null as string | null,
        sha256: sha(JSON.stringify(s)),
        fields: s as Record<string, unknown>,
        yourMoneyKey: 'your_money',
        refundDays: null as number | null,
      }
    }
    const r = (
      await c.query<{
        id: string
        account_fields: Record<string, string>
        holder: string
        holder_capacity: string
        holder_frn: string | null
        asserted_client_money: boolean
        your_money_text_key: string
        refund_days: number
        receipt_check_note: string
      }>(`SELECT * FROM payment_instruction WHERE currency = $1 AND created_at >= ${REAL_SINCE} ORDER BY version DESC LIMIT 1`, [currency])
    ).rows[0]
    if (!r) return null
    const fields = {
      currency,
      ...r.account_fields,
      holder: r.holder,
      holder_capacity: r.holder_capacity,
      holder_frn: r.holder_frn,
      asserted_client_money: r.asserted_client_money,
      receipt_check_note: r.receipt_check_note,
    }
    return {
      id: r.id,
      sha256: sha(JSON.stringify(fields)),
      fields: fields as Record<string, unknown>,
      yourMoneyKey: r.your_money_text_key,
      refundDays: r.refund_days,
    }
  }

  async function accountAcknowledged(c: Q, participationId: string, mode: Mode): Promise<boolean> {
    const p = (await c.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [participationId])).rows[0]!
    const snap = await approvedSnapshot(c, (await dealById(c, p.deal_id))!)
    const acct = await currentAccount(c, snap?.snapshot.terms?.currency ?? 'GBP', mode)
    // the sandbox account never changes, so there is nothing new to confirm
    if (!acct || !acct.id) return !!acct
    return (
      (await c.query('SELECT 1 FROM instruction_ack WHERE participation_id = $1 AND payment_instruction_id = $2', [participationId, acct.id])).rowCount! > 0
    )
  }

  /** §5.5: the warning that leads every promotional surface, chosen by the person's category under FPO. */
  function warningFor(pack: RegimePack, category: string | undefined) {
    const text = pack.legal_texts.find((t) => t.text_key === 'promotion_warning' && t.variant === warningVariant(pack, category))
    const risk = pack.legal_texts.find((t) => t.text_key === 'risk_summary')
    return {
      regime: pack.regime,
      text: text?.body ?? '',
      format: text?.format ?? 'plain',
      required_bold: text?.required_bold ?? [],
      risk_summary: pack.regime === 'uk-cobs' ? (risk?.body ?? '') : null,
      // §5.5: the block names who sends the promotion (name and address, from the pack)
      sender: pack.legal_texts.find((t) => t.text_key === pack.sender.name_text_key)?.body ?? '',
    }
  }

  const textOf = (pack: RegimePack, key: string) => pack.legal_texts.find((t) => t.text_key === key)?.body ?? ''

  /** R-ELG-08: the pack's preparation for both kinds of investor, the estimates and any wait. Neutral: no deal content. */
  function preparationFor(pack: RegimePack) {
    const one = (type: 'individual' | 'company') => {
      const p = preparation(pack, type)
      return { text: textOf(pack, p.textKey) }
    }
    const p = preparation(pack, 'individual')
    return {
      // filled as on the eligibility page, never shown with its slots (Codex round 6)
      overview: fillText(textOf(pack, p.overviewKey), { steps: String(p.steps), review_days: String(p.reviewDays) }),
      steps: p.steps,
      individual: one('individual').text,
      company: one('company').text,
      minutes: Object.values(p.minutes).reduce((a, m) => a + (m ?? 0), 0),
      review_days: p.reviewDays,
      cooling_off_hours: p.coolingOffHours,
    }
  }

  /** Loads the deal and its pack, or refuses with the same words whether it is missing or not the person's. */
  async function dealAndPack(c: Q, dealId: string, lock = false) {
    const deal = await dealById(c, dealId, lock)
    if (!deal) throw new Refused(NOT_FOUND)
    const pack = await packOf(c, deal)
    if (!pack) throw new Refused(NOT_FOUND)
    return { deal, pack }
  }

  const ownParticipations = async (c: Q, dealId: string, userId: string) =>
    (
      await c.query<ParticipationRow>(`SELECT * FROM participation WHERE deal_id = $1 AND user_id = $2 AND created_at >= ${REAL_SINCE} ORDER BY join_seq`, [
        dealId,
        userId,
      ])
    ).rows

  async function ownParticipation(c: Q, id: string, userId: string, lock = false) {
    const p = (
      await c.query<ParticipationRow>(
        `SELECT * FROM participation WHERE id = $1 AND user_id = $2 AND created_at >= ${REAL_SINCE} ${lock ? 'FOR UPDATE' : ''}`,
        [id, userId],
      )
    ).rows[0]
    if (!p) throw new Refused(NOT_FOUND)
    return p
  }

  /** Terms this person would commit under: frozen on the invitation if already, else the link's. */
  async function termsOf(c: Q, inv: InvitationRow): Promise<FrozenTerms> {
    if (inv.terms_snapshot) return inv.terms_snapshot
    return freeze((await linkById(c, inv.invite_link))!)
  }
  const feeOfTerms = (t: FrozenTerms) => linkFee(t)

  function keyTerms(snap: Snapshot, terms: FrozenTerms, cfg: Awaited<ReturnType<typeof feeConfigOf>>, currency: string) {
    const t = snap.terms ?? {}
    const convertible = ['cln', 'safe', 'asa'].includes(String(t.instrument))
    return {
      instrument: t.instrument ?? null,
      round: t.round ?? null,
      // R-PAGE-02: a convertible has no share class or price; the price stays hidden until close
      share_class: convertible ? null : (t.share_class ?? null),
      pre_money_minor: t.pre_money_minor ?? null,
      cap_type: t.cap_type ?? null,
      cap_minor: t.cap_minor ?? null,
      discount_bps: t.discount_bps ?? null,
      round_size_minor: t.round_size_minor ?? null,
      allocation_minor: t.allocation_minor ?? null,
      min_commitment_minor: t.min_commitment_minor ?? null,
      min_raise_minor: t.min_raise_minor ?? null,
      target_close: t.target_close ?? null,
      pay_by: t.pay_by ?? null,
      voter: t.voter ?? null,
      currency,
      seis: !!t.seis,
      eis: !!t.eis,
      carry: percent(terms.carry_bps),
      lead_fee: feeWords(feeOfTerms(terms), currency),
      platform_fee: cfg
        ? {
            rate: percent(cfg.rate_bps),
            min: money(cfg.min_minor, currency),
            max: money(cfg.max_minor, currency),
            surcharge: cfg.surcharge_bps ? `${percent(cfg.surcharge_bps)} above ${money(cfg.surcharge_threshold_minor, currency)}` : null,
            payer: snap.economics?.fee_payer ?? null,
          }
        : null,
      custom_terms: t.custom_terms ?? null,
    }
  }

  function deckView(deck: unknown, hosts: string[]) {
    if (!deck || typeof deck !== 'object') return null
    const k = deck as { kind?: string; url?: string; embed_url?: string }
    return { kind: k.kind, url: k.url, embed_url: k.kind === 'link' ? allowedEmbed(k.embed_url, hosts) : null }
  }

  // ---------- Opening a link (R-LNK-08, R-LNK-10). Public: the response holds nothing about the deal. ----------

  const sameAnswer = { ok: false, message: 'This link does not work. Ask whoever sent it for a new one.' }
  const tooMany = { ok: false, message: 'Too many attempts. Try again later.' }

  app.post('/api/invite/open', pub, async (req, reply) => {
    const { token } = z.strictObject({ token: z.string().min(10).max(200) }).parse(req.body)
    const h = d.k.hmac(`invite\0${token}`)
    // tech design §5: limited by address, then by token, before anything is stored (Codex round 7). A shared link is opened by
    // many people, so its own limit is higher than one address's.
    if (!(await reserveAttempt(d.db, [d.k.hmac(`invite-open-ip\0${req.ip}`)], INVITE_OPENS_PER_IP))) return reply.code(429).send(tooMany)
    if (!(await reserveAttempt(d.db, [d.k.hmac(`invite-open-token\0${h}`)], INVITE_OPENS_PER_TOKEN))) return reply.code(429).send(tooMany)
    const cookie = req.cookies?.[INVITE_COOKIE]
    const found = await tx(d.db, async (c) => {
      await lockInstanceShare(c)
      const open = (await c.query<LinkRow>(`SELECT * FROM invite_link WHERE token_hmac = $1 AND created_at >= ${REAL_SINCE}`, [h])).rows[0]
      const targeted = open
        ? null
        : (
            await c.query<{ id: string; invite_link: string; consumed_at: Date | null; revoked_at: Date | null }>(
              `SELECT id, invite_link, consumed_at, revoked_at FROM targeted_invite WHERE token_hmac = $1 AND created_at >= ${REAL_SINCE}`,
              [h],
            )
          ).rows[0]
      const linkId = open?.id ?? targeted?.invite_link
      if (!linkId || targeted?.consumed_at || targeted?.revoked_at) return null
      const link = open ?? (await linkById(c, linkId))!
      // R-LNK-10: an unbound link that is off does not open; a targeted one is judged on acceptance
      if (open && (link.disabled_at || link.closing_paused_at || (link.needs_approval && !link.terms_approved_at))) return null
      const deal = await dealById(c, link.deal_id)
      if (!deal || deal.state !== 'live' || deal.from_sandbox) return null
      await c.query('DELETE FROM pending_invite WHERE expires_at < clock_timestamp()')
      // the same browser opening the same invitation again keeps the one it holds: no new row
      const held = cookie
        ? (
            await c.query('SELECT 1 FROM pending_invite WHERE browser_hmac = $1 AND invite_link = $2 AND targeted_invite IS NOT DISTINCT FROM $3', [
              d.k.hmac(`pending\0${cookie}`),
              link.id,
              targeted?.id ?? null,
            ])
          ).rowCount
        : 0
      const pack = await packOf(c, deal)
      if (held) return { browser: cookie!, code: deal.public_code, prep: pack ? preparationFor(pack) : null }
      const browser = newToken()
      await c.query('INSERT INTO pending_invite (id, browser_hmac, invite_link, targeted_invite, user_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [
        randomUUID(),
        d.k.hmac(`pending\0${browser}`),
        link.id,
        targeted?.id ?? null,
        req.user?.id ?? null,
        new Date(now().getTime() + PENDING_INVITE_DAYS * 86_400_000).toISOString(),
      ])
      // R-ELG-08: what to prepare, from the deal's own pack; nothing about the deal itself
      return { browser, code: deal.public_code, prep: pack ? preparationFor(pack) : null }
    })
    if (!found) return reply.code(404).send(sameAnswer)
    reply.setCookie(INVITE_COOKIE, found.browser, {
      httpOnly: true,
      secure: d.secureCookies ?? true,
      sameSite: 'lax',
      path: '/',
      maxAge: PENDING_INVITE_DAYS * 86_400,
    })
    reply.header('Referrer-Policy', 'no-referrer')
    return { ok: true, deal_code: found.code, preparation: found.prep }
  })

  /** R-ELG-08: what the invitation page may show before anything else: the code, the operator, how to prepare. */
  app.get('/api/invite/pending', pub, async (req, reply) => {
    reply.header('X-Robots-Tag', 'noindex')
    const cookie = req.cookies?.[INVITE_COOKIE]
    if (!cookie) return { pending: false }
    const r = (
      await d.db.query<{ public_code: string }>(
        'SELECT d.public_code FROM pending_invite p JOIN invite_link l ON l.id = p.invite_link JOIN deal d ON d.id = l.deal_id WHERE p.browser_hmac = $1 AND p.expires_at > $2',
        [d.k.hmac(`pending\0${cookie}`), now().toISOString()],
      )
    ).rows[0]
    return r ? { pending: true, deal_code: r.public_code } : { pending: false }
  })

  /** Called on sign-up (D1): the opened link is attached to the new account on the server, so another device keeps it. */
  async function attachPending(c: Q, browserCookie: string | undefined, userId: string) {
    if (!browserCookie) return
    await c.query('UPDATE pending_invite SET user_id = $2 WHERE browser_hmac = $1 AND user_id IS NULL AND expires_at > $3', [
      d.k.hmac(`pending\0${browserCookie}`),
      userId,
      now().toISOString(),
    ])
  }

  /**
   * R-LNK-10, R-LNK-11: accept every opened link this person holds, from this browser or attached to the account. The address
   * must be verified (the route's gate). Each result is reported without deal content.
   */
  app.post('/api/invite/accept', verified, async (req, reply) => {
    const who = req.user!
    const results = await personTx(who, async (c) => {
      await attachPending(c, req.cookies?.[INVITE_COOKIE], who.id)
      const pending = (
        await c.query<{ id: string; invite_link: string; targeted_invite: string | null }>(
          'SELECT id, invite_link, targeted_invite FROM pending_invite WHERE user_id = $1 AND expires_at > $2 ORDER BY created_at',
          [who.id, now().toISOString()],
        )
      ).rows
      const out: Array<{ deal_code: string; result: string }> = []
      for (const p of pending) {
        // consumed when it is decided for good; a refusal for now (a pause, the deal not open yet, terms awaiting approval,
        // the deal full) keeps it, so the person need not find the link again (Codex round 3)
        const done = () => c.query('DELETE FROM pending_invite WHERE id = $1', [p.id])
        // the deal first, then the link: a link turned off while this waited is read as off
        const dealId = (await c.query<{ deal_id: string }>('SELECT deal_id FROM invite_link WHERE id = $1', [p.invite_link])).rows[0]!.deal_id
        const deal = (await dealById(c, dealId, true))!
        const link = (await c.query<LinkRow>('SELECT * FROM invite_link WHERE id = $1', [p.invite_link])).rows[0]!
        const facts = await dealGateFacts(c, deal)
        const targeted = p.targeted_invite
          ? (
              await c.query<{ id: string; email: string; consumed_at: Date | null; revoked_at: Date | null; allows_reentry: boolean }>(
                'SELECT id, email, consumed_at, revoked_at, allows_reentry FROM targeted_invite WHERE id = $1 FOR UPDATE',
                [p.targeted_invite],
              )
            ).rows[0]!
          : null
        const active = await activeInvitation(c, deal.id, who.id)
        const ended =
          (
            await c.query(`SELECT 1 FROM deal_invitation WHERE deal_id = $1 AND user_id = $2 AND state <> 'active' AND created_at >= ${REAL_SINCE}`, [
              deal.id,
              who.id,
            ])
          ).rowCount! > 0 ||
          (
            await c.query(
              `SELECT 1 FROM participation WHERE deal_id = $1 AND user_id = $2 AND outcome NOT IN ('active', 'rejected_kyc') AND created_at >= ${REAL_SINCE}`,
              [deal.id, who.id],
            )
          ).rowCount! > 0
        const r = decideAccept({
          dealLive: deal.state === 'live',
          held: activeHold(facts.holds),
          link: linkState(link),
          person: { activeInvitation: !!active, endedBefore: ended && !active },
          targeted: targeted
            ? { email: targeted.email, consumed: !!targeted.consumed_at, revoked: !!targeted.revoked_at, allowsReentry: targeted.allows_reentry }
            : null,
          verifiedEmail: who.email,
        })
        if (!r.ok) {
          if (!['held', 'deal_not_open'].includes(r.reason) && !(r.reason === 'link_unusable' && !link.disabled_at)) await done()
          out.push({ deal_code: deal.public_code, result: r.reason })
          continue
        }
        // a new person is only given terms the switches allow now (R-CMP-03)
        if (r.kind === 'new' && !(await linkAssignable(c, deal, link, !targeted))) {
          out.push({ deal_code: deal.public_code, result: 'link_unusable' })
          continue
        }
        if (r.kind === 'already_invited') {
          // R-LNK-11: the terms stay; the lead hears about it
          if (link.id !== active!.invite_link) {
            // the first time is kept; a later visit is in the audit and mails the lead again (Codex round 10)
            await c.query('UPDATE deal_invitation SET second_link_seen_at = coalesce(second_link_seen_at, clock_timestamp()) WHERE id = $1', [active!.id])
            await appendAudit(c, d.k, { actor: who.id, action: 'invitation.second_link', entity: active!.id })
            await d.mail.queue(
              c,
              await toLead(
                c,
                deal.lead_user,
                deal.id,
                `Deal ${deal.public_code}: an investor opened a second link`,
                'Someone already invited to this deal opened another of its links. Their terms have not changed.',
              ),
            )
          }
          // a targeted invitation is used up either way: it cannot be accepted again (R-LNK-07)
          if (targeted) await c.query('UPDATE targeted_invite SET consumed_at = clock_timestamp(), consumed_by = $2 WHERE id = $1', [targeted.id, who.id])
          await done()
          out.push({ deal_code: deal.public_code, result: 'already_invited' })
          continue
        }
        // §5.8: at most 500 people on a deal, counted once whatever the number of entities, under the deal lock
        const people = Number(
          (
            await c.query<{ n: string }>(
              `SELECT count(DISTINCT user_id)::text AS n FROM (SELECT user_id FROM deal_invitation WHERE deal_id = $1 AND state = 'active' UNION SELECT user_id FROM participation WHERE deal_id = $1 AND outcome = 'active') x`,
              [deal.id],
            )
          ).rows[0]!.n,
        )
        if (people >= MAX_INVESTORS) {
          out.push({ deal_code: deal.public_code, result: 'deal_full' })
          continue
        }
        const id = randomUUID()
        await c.query('INSERT INTO deal_invitation (id, deal_id, user_id, invite_link, targeted_invite) VALUES ($1, $2, $3, $4, $5)', [
          id,
          deal.id,
          who.id,
          link.id,
          targeted?.id ?? null,
        ])
        if (targeted) await c.query('UPDATE targeted_invite SET consumed_at = clock_timestamp(), consumed_by = $2 WHERE id = $1', [targeted.id, who.id])
        await appendAudit(c, d.k, { actor: who.id, action: 'invitation.accepted', entity: id })
        // §5.6: an open invitation is a relationship going on again
        await refreshRelationship(c, who.id, now())
        await done()
        out.push({ deal_code: deal.public_code, result: 'invited' })
      }
      return out
    })
    await d.mail.flush()
    reply.clearCookie(INVITE_COOKIE, { path: '/' })
    return { results }
  })

  // ---------- The investor's list and the deal page (R-PAGE-01 to R-PAGE-07) ----------

  app.get('/api/my/deals', verified, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<{ deal_id: string; state: string }>(
        `SELECT DISTINCT ON (deal_id) deal_id, state FROM deal_invitation WHERE user_id = $1 AND created_at >= ${REAL_SINCE} ORDER BY deal_id, created_at DESC`,
        [who.id],
      )
    ).rows
    const out = []
    let warning: ReturnType<typeof warningFor> | null = null
    const regimes = new Set<string>()
    for (const r of rows) {
      const { deal, pack } = await dealAndPack(d.db, r.deal_id)
      const gate = await dealGateFacts(d.db, deal)
      const { person } = await personFacts(d.db, who.id, deal, pack)
      const parts = (await ownParticipations(d.db, deal.id, who.id)).filter((p) => p.outcome === 'active')
      const committed = parts.length > 0
      const visible = canReceivePromotion(person, gate) || (committed && parts.length > 0 && !activeHold(gate.holds) && person.qualified)
      const snap = visible ? await approvedSnapshot(d.db, deal) : null
      // a row naming a company is promotional: the list then leads with the warning (§5.5)
      // the warning itself decides: two packs, or two versions of one, may word it differently (Codex round 4)
      if (visible) {
        const w = warningFor(pack, (await d.eligibilityFacts(d.db, who.id, pack)).statement?.category)
        regimes.add(JSON.stringify([w.regime, w.text, w.sender, w.risk_summary]))
      }
      if (visible && !warning) warning = warningFor(pack, (await d.eligibilityFacts(d.db, who.id, pack)).statement?.category)
      out.push({
        deal_id: deal.id,
        deal_code: deal.public_code,
        // R-PAGE-05: a neutral row, without the company, when the gate is not passed
        name: snap?.snapshot.basics?.name ?? null,
        company: snap?.snapshot.company?.legal_name ?? null,
        visible,
        kind: r.state === 'passed' ? 'not_investing' : committed ? 'committed' : 'invited',
        note: visible ? null : NEUTRAL,
      })
    }
    // deals under different packs need different warnings: then the list names no company, and each deal shows its own
    // warning when opened (Codex round 3)
    if (regimes.size > 1) return { warning: null, deals: out.map((x) => ({ ...x, name: null, company: null })) }
    return { warning, deals: out }
  })

  /**
   * Narrow exceptions (§5.5, R-SIG-06, R-ELG-03): the person's own commitments and what they hold, by ownership alone, so a
   * lapsed statement or a pause never takes away a signed document or a valid instruction. No company, no terms.
   */
  app.get('/api/my/participations', verified, async (req) => {
    const who = req.user!
    const rows = (
      await d.db.query<{ id: string; public_code: string; deal_id: string; signed: boolean; issued: boolean; notice: string | null }>(
        `SELECT p.id, d.public_code, d.id AS deal_id,
                EXISTS (SELECT 1 FROM signature_record s WHERE s.participation_id = p.id AND ${EXECUTED}) AS signed,
                (SELECT x.notice_text FROM reconfirm_exclusion x WHERE x.participation_id = p.id) AS notice,
                EXISTS (SELECT 1 FROM issued_instruction i WHERE i.participation_id = p.id AND i.voided_at IS NULL) AS issued
           FROM participation p JOIN deal d ON d.id = p.deal_id WHERE p.user_id = $1 AND p.created_at >= ${REAL_SINCE} ORDER BY p.join_seq`,
        [who.id],
      )
    ).rows
    const out = []
    for (const r of rows) {
      const deal = (await dealById(d.db, r.deal_id))!
      // an issued instruction is hidden during a pause, and the screen says not to pay
      const held = activeHold((await dealGateFacts(d.db, deal)).holds)
      out.push({
        id: r.id,
        deal_code: r.public_code,
        signed: canSeeOwnExecutedDocs(true) && r.signed,
        instruction: r.issued && !held,
        held,
        // §5.3: the operator's notice to someone excluded for not answering changed terms, in the pack's words
        exclusion_notice: r.notice,
      })
    }
    return { participations: out }
  })

  app.get<{ Params: { id: string } }>('/api/my/deals/:id', verified, async (req, reply) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    return tx(d.db, async (c) => {
      const { deal, pack } = await dealAndPack(c, id)
      const gate = await dealGateFacts(c, deal)
      const { person, inv, eligibility } = await personFacts(c, who.id, deal, pack)
      const parts = (await ownParticipations(c, deal.id, who.id)).filter((p) => p.outcome === 'active')
      const mode = await modeOf(c)
      const continuing = []
      for (const p of parts) if (canContinueOwnParticipation(person, { ...(await ownFacts(c, p, mode)) }, gate)) continuing.push(p)
      const promo = canReceivePromotion(person, gate)
      if (!promo && !continuing.length) {
        if (activeHold(gate.holds) && parts.length) return reply.code(200).send({ held: true, deal_code: deal.public_code, message: DONT_PAY })
        return reply.code(404).send({ error: NEUTRAL })
      }
      const snap = (await approvedSnapshot(c, deal))!
      const cfg = await feeConfigOf(c, deal)
      const currency = snap.snapshot.terms?.currency ?? 'GBP'
      const terms = inv ? await termsOf(c, inv) : (await termsOfParticipation(c, parts[0]!))!
      // R-PAGE-07: one row per version served; an open page that checks itself again does not log each check
      await c.query(
        "INSERT INTO deal_view (id, deal_id, user_id, version) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM deal_view WHERE deal_id = $2 AND user_id = $3 AND version = $4 AND served_at > clock_timestamp() - interval '10 minutes')",
        [randomUUID(), deal.id, who.id, snap.n],
      )
      return {
        // §5.5: the warning comes first; the page draws it before anything else
        warning: warningFor(pack, eligibility.statement?.category),
        deal_code: deal.public_code,
        version: snap.n,
        name: snap.snapshot.basics?.name ?? null,
        company: { legal_name: snap.snapshot.company?.legal_name ?? null, website: snap.snapshot.company?.website ?? null },
        ...(await sharedContent(c, deal.id, snap.snapshot)),
        key_terms: keyTerms(snap.snapshot, terms, cfg, currency),
        commitment_effect: textOf(pack, 'commitment_effect'),
        estimate_note: 'In this version, fees and investment amounts here are estimates. Only the amount to pay is exact.',
        can_commit: promo && deal.state === 'live',
        // R-ALO-04: no participation, no amount to pay; only what the person asked for and whether they were let in
        waitlist: inv
          ? ((
              await c.query<{ desired_minor: string; state: string }>(
                "SELECT desired_minor::text, state FROM waitlist_entry WHERE invitation_id = $1 AND state IN ('waiting', 'released')",
                [inv.id],
              )
            ).rows[0] ?? null)
          : null,
        participations: await Promise.all(parts.map((p) => participationView(c, p, deal, pack, snap.snapshot, mode, gate))),
      }
    })
  })

  async function participationView(c: Q, p: ParticipationRow, deal: D3Deal, pack: RegimePack, snap: Snapshot, mode: Mode, gate: DealGateFacts) {
    const f = await ownFacts(c, p, mode)
    // past its deadline the proposal has lapsed, even before the sweep records it (R-ALO-01)
    const proposalOpen =
      (await c.query('SELECT 1 FROM amount_proposal WHERE participation_id = $1 AND decision IS NULL AND deadline_at > $2', [p.id, now()])).rowCount! > 0
    const s = deriveStatus(
      {
        invitation: 'active',
        qualified: true,
        statementExpired: false,
        waitlisted: false,
        participation: {
          outcome: p.outcome,
          kycPassed: f.kycPassed,
          reconfirmPending: f.reconfirmPending,
          reconfirmLapsed: f.reconfirmPending && (await reconfirmLapsed(c, p.id, pack.regime, now())),
          amountProposalPending: proposalOpen,
          signed: f.signed,
          transferMarked: f.transferMarked,
          held: f.held,
          due: BigInt(p.cash_due_minor),
          invested: p.invested_minor === null ? null : BigInt(p.invested_minor),
          identityReview: f.identityReview,
        },
      },
      pack,
    )
    const entity = (
      await c.query<{ fields: Record<string, string>; type: string }>(
        'SELECT v.fields, e.type FROM legal_entity e JOIN legal_entity_version v ON v.entity_id = e.id AND v.version = e.current_version WHERE e.id = $1',
        [p.entity_id],
      )
    ).rows[0]!
    const est = await estimates(c, deal, snap, BigInt(p.invest_minor))
    return {
      id: p.id,
      entity: { id: p.entity_id, name: entityName(entity.type, entity.fields) },
      status: s.status,
      status_label: STATUS_LABEL[s.status],
      overlays: s.overlays,
      // R-ALO-01: a proposal can be answered while an earlier step (the identity check) is still open, so the screen does not read it from the status
      amount_proposal_open: proposalOpen,
      commitment_minor: p.commitment_minor,
      due_minor: p.cash_due_minor,
      held_minor: String(f.held),
      still_to_pay_minor: String(BigInt(p.cash_due_minor) > f.held ? BigInt(p.cash_due_minor) - (f.held > 0n ? f.held : 0n) : 0n),
      reference: p.reference,
      scheme: p.scheme,
      ...est,
      can_sign: canSign({ qualified: true, invitationActive: true }, f, gate, kycFirst(pack)),
    }
  }

  const kycFirst = (pack: RegimePack) => {
    const k = pack.steps.findIndex((s) => s.kind === 'kyc')
    const sgn = pack.steps.findIndex((s) => s.kind === 'sign')
    return k >= 0 && k < sgn
  }

  async function estimates(c: Q, deal: D3Deal, snap: Snapshot, invest: bigint) {
    const cfg = await feeConfigOf(c, deal)
    const payer = (snap.economics?.fee_payer ?? 'investors') as FeePayer
    const allocation = BigInt(snap.terms?.allocation_minor ?? '0')
    const total = BigInt(
      (await c.query<{ t: string }>("SELECT coalesce(sum(invest_minor), 0)::text AS t FROM participation WHERE deal_id = $1 AND outcome = 'active'", [deal.id]))
        .rows[0]!.t,
    )
    if (!cfg) return { expected_minor: null, least_minor: null, payer }
    const e = expectedInvestment({ config: cfg, payer, allocation, invest, totalInvest: total < invest ? invest : total, stage: 'live' })
    const least = leastInvestment({ config: cfg, payer, allocation, minRaise: snap.terms?.min_raise_minor ? BigInt(snap.terms.min_raise_minor) : null, invest })
    return { expected_minor: String(e.expected), least_minor: least === null ? null : String(least), payer, estimate: true }
  }

  // R-PAGE-03: a file from the deal's documents, only through the gate
  app.get<{ Params: { id: string; file: string } }>('/api/my/deals/:id/files/:file', verified, async (req, reply) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const fileId = Uuid.parse(req.params.file)
    const file = await tx(d.db, async (c) => {
      const { deal, pack } = await dealAndPack(c, id)
      const gate = await dealGateFacts(c, deal)
      const { person } = await personFacts(c, who.id, deal, pack)
      const mode = await modeOf(c)
      let ok = canReceivePromotion(person, gate)
      for (const p of (await ownParticipations(c, deal.id, who.id)).filter((x) => x.outcome === 'active'))
        ok ||= canContinueOwnParticipation(person, await ownFacts(c, p, mode), gate)
      if (!ok) throw new Refused(NOT_FOUND)
      const snap = (await approvedSnapshot(c, deal))!
      const f = (
        await c.query<{ id: string; display_name: string; content_type: string; storage_key: string; key_id: string; wrapped_key: Buffer; sha256: string }>(
          `SELECT id, display_name, content_type, storage_key, key_id, wrapped_key, sha256 FROM stored_file WHERE id = $1 AND scope = 'deal_shared' AND owner_id = $2 AND removed_at IS NULL AND sha256 = ANY($3::text[])`,
          [fileId, deal.id, (snap.snapshot.files?.documents ?? []).map((x) => x.sha256)],
        )
      ).rows[0]
      if (!f) throw new Refused(NOT_FOUND)
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.file_served', entity: f.id })
      const category = (await d.eligibilityFacts(c, who.id, pack)).statement?.category
      const w = warningFor(pack, category)
      return { ...f, warning: [w.text, w.sender && `Sent by: ${w.sender}`, w.risk_summary].filter(Boolean).join('\n\n'), code: deal.public_code }
    })
    const sealed = await (await d.adapters()).storage.get(file.storage_key)
    if (!sealed) return reply.code(404).send({ error: NOT_FOUND })
    const plain = d.k.decrypt(file.key_id, file.wrapped_key, sealed)
    if (file.content_type !== 'application/pdf')
      // decision R26 covers PDFs; a Word file cannot carry a cover page, so the page shows the warning before its link
      return reply.header('content-disposition', 'attachment; filename="document"').type(file.content_type).send(plain)
    // decision R26, §5.5: the warning is the first page of the file; a PDF that cannot be read is not served bare
    const covered = await withWarningCover(plain, file.warning, `Deal ${file.code}`)
    if (!covered) return reply.code(422).send({ error: 'This document cannot be shown with its warning. Ask the lead for another copy.' })
    return reply.header('content-disposition', 'attachment; filename="document.pdf"').type('application/pdf').send(covered)
  })

  // R-CMT-01: not investing
  app.post<{ Params: { id: string } }>('/api/my/deals/:id/pass', verified, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    return personTx(who, async (c) => {
      const deal = await dealById(c, id, true)
      if (!deal) throw new Refused(NOT_FOUND)
      const inv = await activeInvitation(c, deal.id, who.id)
      if (!inv) throw new Refused(NOT_FOUND)
      if ((await ownParticipations(c, deal.id, who.id)).some((p) => p.outcome === 'active'))
        throw new Refused('You have committed to this deal. To withdraw, contact the lead.')
      await c.query("UPDATE deal_invitation SET state = 'passed', ended_at = clock_timestamp() WHERE id = $1", [inv.id])
      await c.query('INSERT INTO invitation_pass (invitation_id) VALUES ($1)', [inv.id])
      await appendAudit(c, d.k, { actor: who.id, action: 'invitation.passed', entity: inv.id })
      await c.query(
        "UPDATE waitlist_entry SET state = 'ended', end_reason = 'left', ended_at = clock_timestamp() WHERE invitation_id = $1 AND state IN ('waiting', 'released')",
        [inv.id],
      )
      // §5.6, TC-KYC-07: choosing not to invest ends the relationship unless something else is still going on
      await refreshRelationship(c, who.id, now())
      return { ok: true }
    })
  })

  // ---------- Committing (R-CMT-02 to R-CMT-07) ----------

  const CommitBody = z.strictObject({
    commitment_minor: Amount,
    entity_id: z.uuid().optional(),
    scheme: z.enum(['none', 'seis', 'eis']).optional(),
    // what the person was shown: the commitment is refused if either has moved since (the amount to pay, the terms)
    quoted_due_minor: Amount.optional(),
    terms_link_id: z.uuid().optional(),
  })
  const STALE = 'The amount or the terms changed after you checked them. Check again before you commit.'

  /** The figures shown before committing; nothing is written. */
  app.post<{ Params: { id: string } }>('/api/my/deals/:id/quote', verified, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = CommitBody.extend({ replacing: z.uuid().optional() }).parse(req.body)
    return tx(d.db, async (c) => {
      const { deal, pack } = await dealAndPack(c, id)
      const gate = await dealGateFacts(c, deal)
      const { person, inv } = await personFacts(c, who.id, deal, pack)
      if (!inv || !canReceivePromotion(person, gate)) throw new Refused(NEUTRAL)
      const old = b.replacing ? await ownParticipation(c, b.replacing, who.id) : null
      if (old && (old.deal_id !== deal.id || old.outcome !== 'active')) throw new Refused(NOT_FOUND)
      return quoteFor(c, deal, pack, inv, BigInt(b.commitment_minor), old ? BigInt(old.invest_minor) : 0n, old?.id ?? null)
    })
  })

  async function quoteFor(c: Q, deal: D3Deal, pack: RegimePack, inv: InvitationRow, commitment: bigint, replacing = 0n, except: string | null = null) {
    const snap = (await approvedSnapshot(c, deal))!
    const terms = await termsOf(c, inv)
    const fee = feeOfTerms(terms)
    const minimum = BigInt(snap.snapshot.terms?.min_commitment_minor ?? '1')
    const refusal = commitmentRefusal(commitment, fee, minimum)
    const currency = snap.snapshot.terms?.currency ?? 'GBP'
    if (refusal) return { ok: false, error: refusal, minimum_minor: String(minimum), currency }
    const fpo = pack.regime === 'uk-fpo'
    const b = breakdown(commitment, fee, fpo)
    const est = await estimates(c, deal, snap.snapshot, b.due.invest)
    // R-ALO-03: judged again, under the deal lock, when the commitment is made
    const room = await capacityFor(c, deal, fee, commitment, except)
    // the person's own T is not in the total yet: add it, so the estimate is what it will be once they commit
    const cfg = await feeConfigOf(c, deal)
    const total = BigInt(
      (await c.query<{ t: string }>("SELECT coalesce(sum(invest_minor), 0)::text AS t FROM participation WHERE deal_id = $1 AND outcome = 'active'", [deal.id]))
        .rows[0]!.t,
    )
    const payer = (snap.snapshot.economics?.fee_payer ?? 'investors') as FeePayer
    const expected = cfg
      ? expectedInvestment({
          config: cfg,
          payer,
          allocation: BigInt(snap.snapshot.terms?.allocation_minor ?? '0'),
          invest: b.due.invest,
          // a changed commitment replaces its old T in the total, not adds to it
          totalInvest: total - replacing + b.due.invest,
          stage: 'live',
        })
      : null
    return {
      ok: true,
      currency,
      terms_link_id: terms.link_id,
      minimum_minor: String(minimum),
      lines: b.lines,
      due_minor: String(b.due.due),
      expected_minor: expected ? String(expected.expected) : null,
      least_minor: est.least_minor,
      payer,
      estimate_label:
        payer === 'investors'
          ? 'Estimate: the platform fee is shared at close, so this may go up or down. It is settled at close.'
          : 'The platform fee is not taken from investors in this deal.',
      least_assumes: 'This assumes only you invest, or only the minimum raise is reached, whichever is more.',
      oversubscription: 'If the deal is oversubscribed, your amount may be scaled back and the difference returned.',
      scheme_note:
        snap.snapshot.terms?.seis || snap.snapshot.terms?.eis
          ? 'Fees and rounding can leave a remainder; the final number of shares is set at close.' +
            (payer === 'investors' ? ' Your investment amount is only known at close, so a whole number of shares cannot be promised.' : '')
          : null,
      commitment_effect: textOf(pack, 'commitment_effect'),
      fixed_total: fpo ? 'This is the total you commit to. You will not be asked to add to it; paying more needs your agreement again.' : null,
      capacity: room.kind,
      max_commitment_minor: room.kind === 'limit' ? String(room.maxCommitment) : null,
      capacity_refusal: capacityRefusal(room, (x) => money(x, currency)),
    }
  }

  app.post<{ Params: { id: string } }>('/api/my/deals/:id/commit', verified, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = CommitBody.parse(req.body)
    if (!b.entity_id) throw new Refused('Choose who is investing.')
    const result = await personTx(who, async (c) => {
      const deal = await dealById(c, id, true)
      if (!deal) throw new Refused(NOT_FOUND)
      const pack = (await packOf(c, deal))!
      const gate = await dealGateFacts(c, deal)
      const { person, inv } = await personFacts(c, who.id, deal, pack)
      const entity = (
        await c.query<{ id: string; current_version: number; rejected_at: Date | null }>(
          `SELECT id, current_version, rejected_at FROM legal_entity WHERE id = $1 AND owner_user = $2 AND created_at >= ${REAL_SINCE} FOR UPDATE`,
          [b.entity_id, who.id],
        )
      ).rows[0]
      if (!entity) throw new Refused(NOT_FOUND)
      if (entity.rejected_at) throw new Refused('This entity cannot be used to invest. Choose another.')
      // R-ELG-02.1: neither template pack asks an entity for anything of its own yet; a pack that does is refused until supported
      if (!inv || !canCommit(person, gate, true)) throw new Refused(NEUTRAL)
      const commitment = BigInt(b.commitment_minor)
      const q = await quoteFor(c, deal, pack, inv, commitment)
      if (!q.ok) throw new Refused(q.error!)
      if (!b.quoted_due_minor || !b.terms_link_id) throw new Refused('Check the amount before you commit.')
      if (q.due_minor !== b.quoted_due_minor || q.terms_link_id !== b.terms_link_id) throw new Refused(STALE)
      if (q.capacity_refusal) throw new Refused(q.capacity_refusal)
      const snap = (await approvedSnapshot(c, deal))!
      // a scheme the deal does not offer is refused, never quietly dropped (R-CMT-04)
      if (b.scheme === 'seis' && !snap.snapshot.terms?.seis) throw new Refused('This deal does not offer SEIS.')
      if (b.scheme === 'eis' && !snap.snapshot.terms?.eis) throw new Refused('This deal does not offer EIS.')
      const scheme = b.scheme ?? 'none'
      const dup = await c.query(`SELECT 1 FROM participation WHERE deal_id = $1 AND user_id = $2 AND entity_id = $3 AND outcome = 'active'`, [
        deal.id,
        who.id,
        entity.id,
      ])
      if (dup.rowCount) throw new Refused('You have already committed with this entity. Change that commitment instead.')
      // R-LNK-05: the first commitment freezes the terms on the invitation; a second entity uses the same ones (R-CMT-07)
      const terms = await termsOf(c, inv)
      if (!inv.terms_snapshot)
        await c.query('UPDATE deal_invitation SET terms_snapshot = $2, terms_frozen_at = clock_timestamp() WHERE id = $1', [inv.id, JSON.stringify(terms)])
      const due = breakdown(commitment, feeOfTerms(terms), pack.regime === 'uk-fpo').due
      if (due.due > MAX_DUE_MINOR) throw new Refused('The amount to pay is above the largest allowed.')
      const prefix = (await c.query<{ reference_prefix: string }>('SELECT reference_prefix FROM deal_config WHERE id = 1')).rows[0]!.reference_prefix
      const pid = randomUUID()
      for (let attempt = 0; ; attempt++) {
        const ref = issueReference(prefix, randomInt, () => false)
        await c.query('SAVEPOINT ref')
        try {
          await c.query(
            `INSERT INTO participation (id, invitation_id, deal_id, user_id, entity_id, entity_version, scheme, commitment_minor, invest_minor, lead_fee_minor, rounding_minor, cash_due_minor, reference, reference_norm, agreed_version, agreed_terms_n)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                     (SELECT coalesce(max(n), 0) FROM invitation_terms WHERE invitation_id = $2))`,
            [
              pid,
              inv.id,
              deal.id,
              who.id,
              entity.id,
              entity.current_version,
              scheme,
              String(commitment),
              String(due.invest),
              String(due.leadFee),
              String(due.rounding),
              String(due.due),
              ref,
              normaliseReference(ref),
              // §5.3: what this person agreed to, so a later change is shown against it
              deal.approved_version,
            ],
          )
          await c.query('RELEASE SAVEPOINT ref')
          break
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT ref')
          // C-REF-1: a clash on the unique reference draws again; anything else is a real failure
          if ((e as { code?: string; constraint?: string }).constraint !== 'participation_reference_norm_key' || attempt >= 20) throw e
        }
      }
      await logParticipation(c, pid, 'committed', who.id, { commitment_minor: String(commitment), due_minor: String(due.due), lines: q.lines })
      await appendAudit(c, d.k, { actor: who.id, action: 'participation.committed', entity: pid })
      // R-ALO-04: a place on the waiting list is taken up by committing, let in or not
      await c.query("UPDATE waitlist_entry SET state = 'committed', ended_at = clock_timestamp() WHERE invitation_id = $1 AND state IN ('waiting', 'released')", [
        inv.id,
      ])
      await refreshRelationship(c, who.id, now())
      // R-NTF-01: the confirmation names no amount, only that it was recorded
      await d.mail.investor(c, { action: 'commitment_confirmed', audience: { kind: 'account', userId: who.id }, to: who.email, dealId: deal.id })
      // R-KYC-02.1: a person with a hold on this deal commits again with another entity; reviewers are told, nobody else
      const held = await c.query(
        "SELECT 1 FROM participation p JOIN refund_todo t ON t.participation_id = p.id WHERE p.deal_id = $1 AND p.user_id = $2 AND p.outcome = 'rejected_kyc' AND t.hold <> 'none'",
        [deal.id, who.id],
      )
      if (held.rowCount)
        await tellReviewers(c, d.mail, 'A new commitment to check', 'Someone whose money on a deal is under a hold has made a new commitment with another entity. Sign in to see it.')
      // R-CMT-07: in reminder mode a commitment over the allocation is taken; the lead's panel warns
      return { id: pid, over_allocation: q.capacity === 'warn' }
    })
    await d.mail.flush()
    return result
  })

  // R-CMT-06: change a commitment, only while live. Before any money, either way; after, only up.
  app.put<{ Params: { id: string } }>('/api/my/participations/:id/commitment', verified, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = z.strictObject({ commitment_minor: Amount, quoted_due_minor: Amount }).parse(req.body)
    const out = await personTx(who, async (c) => {
      const p0 = await ownParticipation(c, pid, who.id)
      const deal = (await dealById(c, p0.deal_id, true))!
      const p = await ownParticipation(c, pid, who.id, true)
      const pack = (await packOf(c, deal))!
      const gate = await dealGateFacts(c, deal)
      const { person, inv } = await personFacts(c, who.id, deal, pack)
      const mode = await modeOf(c)
      if (deal.state !== 'live') throw new Refused('Commitments can be changed only while the deal is live.')
      if (!inv || !canContinueOwnParticipation(person, await ownFacts(c, p, mode), gate)) throw new Refused(NEUTRAL)
      if (await openProposal(c, alloc, p.id)) throw new Refused('The lead has proposed a new amount. Answer that first.')
      const next = BigInt(b.commitment_minor)
      const held = await heldMinor(c, p.id)
      const receipts = (await c.query('SELECT 1 FROM receipt WHERE participation_id = $1 AND reversed_at IS NULL AND amount_minor > moved_out_minor', [p.id])).rowCount! > 0
      if (receipts && next < BigInt(p.commitment_minor))
        throw new Refused('Money has arrived, so the commitment can only go up. To reduce it, contact the lead.')
      if (next === BigInt(p.commitment_minor)) return { ok: true, changed: false }
      const q = await quoteFor(c, deal, pack, inv, next, BigInt(p.invest_minor), p.id)
      if (!q.ok) throw new Refused(q.error!)
      if (q.due_minor !== b.quoted_due_minor) throw new Refused(STALE)
      // R-ALO-03: an increase is judged like a new commitment; a decrease always fits
      if (next > BigInt(p.commitment_minor) && q.capacity_refusal) throw new Refused(q.capacity_refusal)
      const due = breakdown(next, feeOfTerms(await termsOf(c, inv)), pack.regime === 'uk-fpo').due
      await c.query(
        'UPDATE participation SET commitment_minor = $2, invest_minor = $3, lead_fee_minor = $4, rounding_minor = $5, cash_due_minor = $6, updated_at = clock_timestamp() WHERE id = $1',
        [p.id, String(next), String(due.invest), String(due.leadFee), String(due.rounding), String(due.due)],
      )
      // the deal sheet carries the amount, so a signed one no longer matches: sign again (R-CMT-06)
      await c.query('UPDATE signature_record SET superseded_at = clock_timestamp() WHERE participation_id = $1 AND superseded_at IS NULL', [p.id])
      if (await voidInstruction(c, d.k, p.id, 'commitment_changed', who.id))
        await d.mail.urgent(c, 'void_commitment_changed', { userId: who.id, to: who.email, dealId: deal.id })
      await logParticipation(c, p.id, 'commitment_changed', who.id, { from: p.commitment_minor, to: String(next), held: String(held) })
      await appendAudit(c, d.k, { actor: who.id, action: 'participation.commitment_changed', entity: p.id })
      return { ok: true, changed: true, due_minor: String(due.due) }
    })
    await d.mail.flush()
    return out
  })

  // ---------- A new amount proposed by the lead (R-ALO-01) ----------

  /** The person's own participation, the deal held, and the gate a step on it needs. */
  async function ownStep(c: Tx, who: SessionUser, pid: string) {
    const p0 = await ownParticipation(c, pid, who.id)
    const deal = (await dealById(c, p0.deal_id, true))!
    const p = await ownParticipation(c, pid, who.id, true)
    const pack = (await packOf(c, deal))!
    const gate = await dealGateFacts(c, deal)
    const { person, inv } = await personFacts(c, who.id, deal, pack)
    const f = await ownFacts(c, p, await modeOf(c))
    if (p.outcome !== 'active' || !inv || !canContinueOwnParticipation(person, f, gate)) throw new Refused(NEUTRAL)
    return { p, deal, pack, inv, signed: f.signed }
  }
  const PROPOSAL_ENDED = 'This proposal has ended. Your amount is unchanged.'

  /** One screen: the new amount to pay, the investment part and the estimate, and whether the deal sheet is signed again. */
  app.get<{ Params: { id: string } }>('/api/my/participations/:id/amount-proposal', verified, async (req) => {
    const who = req.user!
    const out = await personTx(who, async (c) => {
      const { p, deal, pack, inv, signed } = await ownStep(c, who, Uuid.parse(req.params.id))
      const o = await openProposal(c, alloc, p.id)
      if (!o) return { proposal: null }
      return {
        proposal: {
          id: o.id,
          current_commitment_minor: p.commitment_minor,
          current_due_minor: p.cash_due_minor,
          proposed_commitment_minor: o.proposed_minor,
          deadline_at: new Date(o.deadline_at).toISOString(),
          quote: await quoteFor(c, deal, pack, inv, BigInt(o.proposed_minor), BigInt(p.invest_minor), p.id),
          // the deal sheet names the amount, so a signed one is signed again (R-ALO-01)
          sign_again: signed,
        },
      }
    })
    await d.mail.flush()
    return out
  })

  const ProposalAnswer = z.strictObject({ proposal_id: z.uuid(), quoted_due_minor: Amount })

  app.post<{ Params: { id: string } }>('/api/my/participations/:id/amount-proposal/accept', verified, async (req) => {
    const who = req.user!
    const b = ProposalAnswer.parse(req.body)
    const out = await personTx(who, async (c) => {
      const { p, deal, pack, inv } = await ownStep(c, who, Uuid.parse(req.params.id))
      if (deal.state !== 'live') throw new Refused(PROPOSAL_ENDED)
      const o = await openProposal(c, alloc, p.id)
      if (!o || o.id !== b.proposal_id) throw new Refused(PROPOSAL_ENDED)
      const current = BigInt(p.commitment_minor)
      const proposed = BigInt(o.proposed_minor)
      const q = await quoteFor(c, deal, pack, inv, proposed, BigInt(p.invest_minor), p.id)
      if (!q.ok) throw new Refused(q.error!)
      if (q.due_minor !== b.quoted_due_minor) throw new Refused(STALE)
      const fee = feeOfTerms(await termsOf(c, inv))
      const why = acceptProposalRefusal({
        onHand: (await loadMoney(c, p.id))!.figures.onHand,
        current,
        proposed,
        capacity: await capacityFor(c, deal, fee, proposed, p.id),
      })
      if (why) throw new Refused(why)
      const due = breakdown(proposed, fee, pack.regime === 'uk-fpo').due
      await c.query(
        'UPDATE participation SET commitment_minor = $2, invest_minor = $3, lead_fee_minor = $4, rounding_minor = $5, cash_due_minor = $6, updated_at = clock_timestamp() WHERE id = $1',
        [p.id, String(proposed), String(due.invest), String(due.leadFee), String(due.rounding), String(due.due)],
      )
      await c.query('UPDATE signature_record SET superseded_at = clock_timestamp() WHERE participation_id = $1 AND superseded_at IS NULL', [p.id])
      await endProposal(c, alloc, p.id, 'accepted', who.id)
      // R-LNK-03: the new amount to pay and the person's agreement to it, on the record
      await logParticipation(c, p.id, 'amount_agreed', who.id, {
        proposal: o.id,
        from: String(current),
        to: String(proposed),
        due_minor: String(due.due),
        lines: q.lines,
      })
      await appendAudit(c, d.k, { actor: who.id, action: 'participation.amount_agreed', entity: p.id, detail: { proposal: o.id } })
      return { ok: true, due_minor: String(due.due) }
    })
    await d.mail.flush()
    return out
  })

  app.post<{ Params: { id: string } }>('/api/my/participations/:id/amount-proposal/decline', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ proposal_id: z.uuid() }).parse(req.body)
    const out = await personTx(who, async (c) => {
      const { p, deal } = await ownStep(c, who, Uuid.parse(req.params.id))
      const o = await openProposal(c, alloc, p.id)
      if (!o || o.id !== b.proposal_id) throw new Refused(PROPOSAL_ENDED)
      await endProposal(c, alloc, p.id, 'declined', who.id)
      await tellLeads(c, d.mail, deal, 'A proposed amount was declined', 'An investor declined the new amount you proposed. Their commitment is unchanged.')
      return { ok: true }
    })
    await d.mail.flush()
    return out
  })

  // ---------- Reconfirming changed terms (§5.3, R-CHG-02, R-CHG-05) ----------

  const RECONFIRM_ENDED = 'There is nothing to reconfirm here any more. Open the deal again.'

  /** What an investor is shown of one version: the page's own fields, never the raw content (R-PAGE-02, R-CHG-05). */
  async function shownAt(c: Q, deal: D3Deal, n: number, terms: FrozenTerms) {
    const v = (await c.query<{ snapshot: Snapshot }>('SELECT snapshot FROM deal_version WHERE deal_id = $1 AND n = $2', [deal.id, n])).rows[0]!.snapshot
    const currency = v.terms?.currency ?? 'GBP'
    return {
      raw: v,
      shown: {
        name: v.basics?.name ?? null,
        company: { legal_name: v.company?.legal_name ?? null, website: v.company?.website ?? null },
        memo: v.files?.memo ? richTextPlain(v.files.memo) : null,
        documents: (v.files?.documents ?? []).map((x) => `${x.display_name} (${x.sha256.slice(0, 12)})`).sort(),
        key_terms: keyTerms(v, terms, await feeConfigOf(c, deal), currency),
      },
    }
  }

  /** §5.3: the differences against the version this person last agreed to; the price only as "set", while it stays hidden. */
  async function differencesShown(c: Q, deal: D3Deal, from: number, to: number, terms: FrozenTerms, termsTo = terms): Promise<FieldChange[]> {
    const before = await shownAt(c, deal, from, terms)
    const after = await shownAt(c, deal, to, termsTo)
    const out = diffContent(before.shown, after.shown)
    const price = changesShown(
      diffContent({ terms: before.raw.terms ?? {} }, { terms: after.raw.terms ?? {} }).filter((x) => /^terms\.(share_price_micros|price_is_placeholder)$/.test(x.field)),
      false,
    )
    return [...out, ...price]
  }

  // R-CHG-02, R-CHG-03: every change in force since the person committed, with the lead's sentence and what they can see changed;
  // a notice asks nothing of them
  app.get<{ Params: { id: string } }>('/api/my/deals/:id/updates', verified, async (req, reply) => {
    const who = req.user!
    return tx(d.db, async (c) => {
      const { deal, pack } = await dealAndPack(c, Uuid.parse(req.params.id))
      const gate = await dealGateFacts(c, deal)
      const { person, inv } = await personFacts(c, who.id, deal, pack)
      const mode = await modeOf(c)
      const parts = []
      for (const p of (await ownParticipations(c, deal.id, who.id)).filter((x) => x.outcome === 'active'))
        if (canContinueOwnParticipation(person, await ownFacts(c, p, mode), gate)) parts.push(p)
      if (!parts.length) return reply.code(404).send({ error: NEUTRAL })
      const since = Math.min(...parts.map((p) => p.agreed_version ?? deal.approved_version ?? 0))
      const terms = inv ? await termsOf(c, inv) : (await termsOfParticipation(c, parts[0]!))!
      const rows = (
        await c.query<{ applied_version: number; summary: string; self_service: boolean; reconfirm: boolean; applied_at: Date }>(
          `SELECT c.applied_version, c.summary, c.self_service, c.applied_at,
                  EXISTS (SELECT 1 FROM reconfirmation r WHERE r.change_id = c.id) AS reconfirm
             FROM change_request c WHERE c.deal_id = $1 AND c.state = 'applied' AND c.invitation_id IS NULL AND c.applied_version > $2
            ORDER BY c.applied_version`,
          [deal.id, since],
        )
      ).rows
      const out = []
      for (const r of rows) {
        const prev = (
          await c.query<{ n: number }>('SELECT max(n) AS n FROM deal_version WHERE deal_id = $1 AND n < $2', [deal.id, r.applied_version])
        ).rows[0]!.n
        out.push({
          version: r.applied_version,
          summary: r.summary,
          applied_at: r.applied_at,
          kind: r.reconfirm ? 'reconfirm' : r.self_service ? 'lead_choice' : 'notice',
          differences: await differencesShown(c, deal, prev, r.applied_version, terms),
        })
      }
      return { updates: out }
    })
  })

  /** One screen: what changed, the lead's sentence, the deadline, and the deal sheet to sign again when it changed (§5.3). */
  app.get<{ Params: { id: string } }>('/api/my/participations/:id/reconfirmation', verified, async (req) => {
    const who = req.user!
    return personTx(who, async (c) => {
      const { p, deal, pack, inv, signed } = await ownStep(c, who, Uuid.parse(req.params.id))
      const rc = await pendingReconfirmation(c, p.id)
      if (!rc) return { reconfirmation: null }
      const summary = (await c.query<{ summary: string }>('SELECT summary FROM change_request WHERE id = $1', [rc.change_id])).rows[0]!.summary
      const clock = await reconfirmClock(c, rc, who.id, pack.regime, now())
      const sheet = rc.resign && signed ? await dealSheetFor(c, p, deal, pack) : null
      return {
        reconfirmation: {
          id: rc.id,
          version: rc.deal_version,
          compared_to: rc.compared_to,
          summary,
          // one person's terms are compared like the deal: with the set they last agreed to (R-CHG-02)
          differences: await differencesShown(
            c,
            deal,
            rc.compared_to,
            rc.deal_version,
            await termsAt(c, inv.id, rc.terms_compared_to),
            await termsAt(c, inv.id, rc.terms_n),
          ),
          deadline: clock.state === 'open' || clock.state === 'lapsed' ? clock.deadline.toISOString() : null,
          // silence is never agreement: past the deadline the answer is still open until the operator decides
          clock: clock.state,
          working_days: rc.days,
          sign_again: !!sheet,
          deal_sheet: sheet && { warning: sheet.warning, document: sheet.body, document_sha256: sheet.sha256, needs_deed: sheet.template.needs_deed },
        },
      }
    })
  })

  const ReconfirmAgree = z.strictObject({
    reconfirmation_id: z.uuid(),
    agree: z.literal(true),
    signed_name: z.string().trim().min(2).max(200).optional(),
    document_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })

  app.post<{ Params: { id: string } }>('/api/my/participations/:id/reconfirmation/agree', verified, async (req) => {
    const who = req.user!
    const b = ReconfirmAgree.parse(req.body)
    const out = await personTx(who, async (c) => {
      const { p, deal, pack, signed } = await ownStep(c, who, Uuid.parse(req.params.id))
      const rc = await pendingReconfirmation(c, p.id, true)
      if (!rc || rc.id !== b.reconfirmation_id) throw new Refused(RECONFIRM_ENDED)
      // the version asked about must still be the one in force: a newer change replaces this one (§5.3)
      if (deal.approved_version !== rc.deal_version) throw new Refused(RECONFIRM_ENDED)
      let signature: string | null = null
      if (rc.resign && signed) {
        // §5.3: the deal sheet changed, so agreeing is signing it again, on the same screen. A deed is signed outside the site,
        // and someone who could not sign now (identity being checked, KYC first and not passed) signs once they can.
        const sheet = await dealSheetFor(c, p, deal, pack)
        await c.query('UPDATE signature_record SET superseded_at = clock_timestamp() WHERE participation_id = $1 AND superseded_at IS NULL', [p.id])
        const f = await ownFacts(c, p, await modeOf(c))
        const canSignNow = !f.identityReview && f.entityVersionCurrent && (!kycFirst(pack) || f.kycPassed)
        if (!sheet.template.needs_deed && canSignNow) {
          if (!b.signed_name || !b.document_sha256) throw new Refused('Sign the new deal sheet to agree.')
          if (sheet.sha256 !== b.document_sha256) throw new Refused('The document has changed since you opened it. Open it again.')
          signature = await recordSignature(c, p, sheet, b.signed_name, req.ip, who.authMethod)
        }
      }
      await c.query("UPDATE reconfirmation SET state = 'agreed', decided_by = $2, decided_at = clock_timestamp(), signature_id = $3 WHERE id = $1", [
        rc.id,
        who.id,
        signature,
      ])
      await c.query('UPDATE participation SET agreed_version = $2, agreed_terms_n = $3, updated_at = clock_timestamp() WHERE id = $1', [
        p.id,
        rc.deal_version,
        rc.terms_n,
      ])
      await logParticipation(c, p.id, 'reconfirmed', who.id, { reconfirmation: rc.id, version: rc.deal_version, signature })
      await appendAudit(c, d.k, { actor: who.id, action: 'participation.reconfirmed', entity: p.id, detail: { reconfirmation: rc.id, version: rc.deal_version } })
      return { ok: true, signed_again: signature !== null }
    })
    await d.mail.flush()
    return out
  })

  // §5.3: no, with no money on hand, is the end (`withdrawn`); with money, a withdrawal with a refund to do
  app.post<{ Params: { id: string } }>('/api/my/participations/:id/reconfirmation/decline', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ reconfirmation_id: z.uuid() }).parse(req.body)
    const out = await personTx(who, async (c) => {
      const { p, deal } = await ownStep(c, who, Uuid.parse(req.params.id))
      const rc = await pendingReconfirmation(c, p.id, true)
      if (!rc || rc.id !== b.reconfirmation_id) throw new Refused(RECONFIRM_ENDED)
      const held = (await loadMoney(c, p.id))!.figures.onHand
      const ending = onDisagree(held)
      await c.query("UPDATE reconfirmation SET state = 'declined', decided_by = $2, decided_at = clock_timestamp() WHERE id = $1", [rc.id, who.id])
      const part = { id: p.id, deal_id: deal.id, user_id: who.id, invitation_id: p.invitation_id, email: who.email, outcome: p.outcome }
      await endParticipation(alloc, c, deal, part, 'withdrawn', who.id, { reconfirmation: rc.id, declined: true })
      if (ending === 'withdrawal_with_refund') {
        await ensureTodo(c, p.id, 'withdrawn', who.id)
        await noteReason(c, (await loadMoney(c, p.id))!, who.id)
      }
      await tellLeads(c, d.mail, deal, 'Changed terms declined', 'An investor did not agree to the changed terms. Their commitment has ended.')
      return { outcome: 'withdrawn' as const, refund: ending === 'withdrawal_with_refund' }
    })
    await d.mail.flush()
    return out
  })

  // ---------- The waiting list (R-ALO-04) ----------

  app.post<{ Params: { id: string } }>('/api/my/deals/:id/waitlist', verified, async (req) => {
    const who = req.user!
    const b = z.strictObject({ desired_minor: Amount }).parse(req.body)
    const out = await personTx(who, async (c) => {
      const { deal, pack } = await dealAndPack(c, Uuid.parse(req.params.id), true)
      const gate = await dealGateFacts(c, deal)
      const { person, inv } = await personFacts(c, who.id, deal, pack)
      // the other checks of R-CMT-02 still apply
      if (!inv || !canCommit(person, gate, true)) throw new Refused(NEUTRAL)
      const desired = BigInt(b.desired_minor)
      const fee = feeOfTerms(await termsOf(c, inv))
      const a = await allocationOf(c, deal)
      const small = commitmentRefusal(desired, fee, a.minimum)
      if (small) throw new Refused(small)
      const on = await c.query("SELECT 1 FROM waitlist_entry WHERE invitation_id = $1 AND state IN ('waiting', 'released')", [inv.id])
      const why = waitlistRefusal({ dealState: deal.state, mode: a.mode, capacity: await capacityFor(c, deal, fee, desired), alreadyOn: on.rowCount! > 0 })
      if (why) throw new Refused(why)
      const id = randomUUID()
      await c.query('INSERT INTO waitlist_entry (id, deal_id, invitation_id, user_id, desired_minor) VALUES ($1, $2, $3, $4, $5)', [
        id,
        deal.id,
        inv.id,
        who.id,
        String(desired),
      ])
      await appendAudit(c, d.k, { actor: who.id, action: 'waitlist.joined', entity: id })
      await tellLeads(c, d.mail, deal, 'Someone joined your waiting list', 'An investor joined the waiting list of a full deal. Sign in to see it.')
      return { id, state: 'waiting' as const }
    })
    await d.mail.flush()
    return out
  })

  app.post<{ Params: { id: string } }>('/api/my/deals/:id/waitlist/leave', verified, async (req) => {
    const who = req.user!
    return personTx(who, async (c) => {
      const deal = await dealById(c, Uuid.parse(req.params.id), true)
      const inv = deal ? await activeInvitation(c, deal.id, who.id) : null
      const r = inv
        ? await c.query<{ id: string }>(
            "UPDATE waitlist_entry SET state = 'ended', end_reason = 'left', ended_at = clock_timestamp() WHERE invitation_id = $1 AND state IN ('waiting', 'released') RETURNING id",
            [inv.id],
          )
        : null
      if (!r?.rowCount) throw new Refused('You are not on the waiting list for this deal.')
      await appendAudit(c, d.k, { actor: who.id, action: 'waitlist.left', entity: r.rows[0]!.id })
      return { ok: true }
    })
  })

  // ---------- Signing (R-SIG-01 to R-SIG-06) ----------

  // the sheet fits on its own here, so it is the warning in front of it that tips it over: both are named (owner 2026-11-11)
  const SHEET_AND_WARNING_TOO_LONG =
    "The deal sheet fits on its own, but not together with the warning in front of it. Shorten the warning texts in the regime pack, or the operator's template or the deal's custom terms."
  const SHEET_TOO_LONG = "The deal sheet would be too long once filled in. The operator's template or the deal's custom terms must be shortened."

  /** The deal-sheet template that serves now, or a refusal when there is none the mode accepts. */
  async function sheetTemplate(c: Q) {
    // R-CMP-02: a generated document is the approved template on the approved deal version. The real mode always asks for the
    // template's approval; the sandbox only when the operator turned approval on. Until a newer one is approved, the last one serves.
    const mode = await modeOf(c)
    const ask = mode === 'real' || (await c.query<{ a: boolean }>('SELECT content_approval_in_sandbox AS a FROM deal_config WHERE id = 1')).rows[0]!.a
    const tpl = (
      await c.query<{ id: string; body: string; needs_deed: boolean; is_placeholder: boolean; version: number }>(
        `SELECT t.id, t.body, t.needs_deed, t.is_placeholder, t.version FROM document_template t WHERE t.kind = 'deal_sheet'
           AND ($1 = false OR EXISTS (SELECT 1 FROM promotion_approval a WHERE a.subject_kind = 'template' AND a.subject_id = t.id::text AND a.content_sha256 = t.sha256 AND a.created_at >= ${REAL_SINCE}))
         ORDER BY t.version DESC LIMIT 1`,
        [ask],
      )
    ).rows[0]
    if (!tpl) throw new Refused('The operator has not set up the deal sheet yet.')
    if (tpl.is_placeholder && (await modeOf(c)) === 'real') throw new Refused('The operator has not set up the deal sheet yet.')
    return tpl
  }

  /**
   * R-SIG-02: the default deal sheet for the lead to preview: the deal's own values and the default link's terms, with each
   * investor's details and amounts left as marked blanks. Nothing is created and nothing is signed (Codex round 7).
   */
  async function previewSheet(c: Q, deal: D3Deal) {
    const tpl = await sheetTemplate(c)
    const snap = await approvedSnapshot(c, deal)
    if (!snap) throw new Refused('The deal sheet can be previewed once the deal is approved.')
    const l = await defaultLink(c, deal, snap.snapshot)
    const currency = snap.snapshot.terms?.currency ?? 'GBP'
    const custom = snap.snapshot.terms?.custom_terms ? richTextPlain(snap.snapshot.terms.custom_terms).trim() : ''
    const each = '[for each investor]'
    const rendered = renderDealSheet(tpl.body, {
      deal_code: deal.public_code,
      company_name: snap.snapshot.company?.legal_name ?? '',
      instrument: String(snap.snapshot.terms?.instrument ?? ''),
      investor_name: '[investor name]',
      entity_name: '[investing entity]',
      commitment: each,
      investment_part: each,
      rounding: each,
      breakdown: each,
      lead_fee: each,
      amount_to_pay: each,
      carry: l ? percent(l.carry_bps) : each,
      fee_terms: l ? feeWords(linkFee(l), currency) : each,
      reference: each,
      date: today(),
      custom_terms: custom,
    })
    if (rendered === null) throw new Refused(SHEET_TOO_LONG)
    const body = rendered
    return { body, needs_deed: tpl.needs_deed, note: "Each investor's copy starts with the warning for their category and has their own details and amounts." }
  }

  /** The default link the lead previews with: launch can make two, the one with the deal's own default carry first (Codex round 8). */
  async function defaultLink(c: Q, deal: D3Deal, snap: Snapshot) {
    return (
      await c.query<LinkRow>('SELECT * FROM invite_link WHERE deal_id = $1 AND is_default ORDER BY (carry_bps = $2) DESC, created_at LIMIT 1', [
        deal.id,
        snap.economics?.default_carry_bps ?? 0,
      ])
    ).rows[0]
  }

  /**
   * R-ADM-01: the deal page as an investor would see it, read only, on the default link's terms. Nothing is created: no
   * participation, no invitation, no page view; the caller writes the audit. Every category's warning is shown; each
   * investor's page has the one for their category.
   */
  /**
   * The memo, the deck and the shared documents of a version, as investors see them: the investor page, the lead's preview and
   * the lead's content view all take them from here, so they cannot differ (R-ADM-10).
   */
  async function sharedContent(c: Q, dealId: string, snap: Snapshot) {
    const documents = (
      await c.query<{ id: string; display_name: string; requirement: string }>(
        `SELECT id, display_name, requirement FROM stored_file WHERE scope = 'deal_shared' AND owner_id = $1 AND removed_at IS NULL AND sha256 = ANY($2::text[]) ORDER BY display_name`,
        [dealId, (snap.files?.documents ?? []).map((x) => x.sha256)],
      )
    ).rows
    return {
      memo: snap.files?.memo ?? null,
      // R-PAGE-01: the embed only while its site is still allowed; the page's frame policy names the same sites
      deck: deckView(
        snap.files?.deck,
        (await c.query<{ embed_hosts: string[] }>('SELECT embed_hosts FROM deal_config WHERE id = 1')).rows[0]?.embed_hosts ?? [],
      ),
      documents,
    }
  }

  async function previewPage(c: Q, deal: D3Deal) {
    const pack = await packOf(c, deal)
    const snap = await approvedSnapshot(c, deal)
    if (!pack || !snap) throw new Refused('The investor page can be previewed once the deal is approved.')
    const l = await defaultLink(c, deal, snap.snapshot)
    if (!l) throw new Refused('The investor page can be previewed once the deal has a default link.')
    const currency = snap.snapshot.terms?.currency ?? 'GBP'
    return {
      preview: true as const,
      read_only: true as const,
      // each category's warning, as the page opens with the one for the viewer's category (§5.5)
      warnings: [...new Set(pack.legal_texts.filter((t) => t.text_key === 'promotion_warning').map((t) => t.variant ?? 'default'))].map((v) => ({
        variant: v,
        ...warningFor(pack, v),
      })),
      deal_code: deal.public_code,
      version: snap.n,
      name: snap.snapshot.basics?.name ?? null,
      company: { legal_name: snap.snapshot.company?.legal_name ?? null, website: snap.snapshot.company?.website ?? null },
      ...(await sharedContent(c, deal.id, snap.snapshot)),
      key_terms: keyTerms(snap.snapshot, freeze(l), await feeConfigOf(c, deal), currency),
      commitment_effect: textOf(pack, 'commitment_effect'),
      note: "This is the page on the default link's terms. Each investor sees only the warning for their category, and their own link's terms.",
    }
  }

  async function dealSheetFor(c: Q, p: ParticipationRow, deal: D3Deal, pack: RegimePack, date = today()) {
    const tpl = await sheetTemplate(c)
    const snap = (await approvedSnapshot(c, deal))!
    const currency = snap.snapshot.terms?.currency ?? 'GBP'
    const inv = (await c.query<InvitationRow>('SELECT * FROM deal_invitation WHERE id = $1', [p.invitation_id])).rows[0]!
    const terms = inv.terms_snapshot!
    const ent = (
      await c.query<{ fields: Record<string, string>; type: string }>(
        'SELECT v.fields, e.type FROM legal_entity e JOIN legal_entity_version v ON v.entity_id = e.id AND v.version = $2 WHERE e.id = $1',
        [p.entity_id, p.entity_version],
      )
    ).rows[0]!
    const user = (await c.query<{ name: string }>('SELECT name FROM user_account WHERE id = $1', [p.user_id])).rows[0]!
    const lines = breakdown(BigInt(p.commitment_minor), linkFee(terms), pack.regime === 'uk-fpo').lines
    // R-DRF-04: approved custom terms belong in the deal sheet, whatever the operator's template does with them
    const custom = snap.snapshot.terms?.custom_terms ? richTextPlain(snap.snapshot.terms.custom_terms).trim() : ''
    const rendered = renderDealSheet(tpl.body, {
      deal_code: deal.public_code,
      company_name: snap.snapshot.company?.legal_name ?? '',
      instrument: String(snap.snapshot.terms?.instrument ?? ''),
      investor_name: user.name,
      entity_name: entityName(ent.type, ent.fields),
      // under FPO the amount to pay is the total commitment (R-LNK-03); elsewhere the commitment as typed
      commitment: money(BigInt(pack.regime === 'uk-fpo' ? p.cash_due_minor : p.commitment_minor), currency),
      investment_part: money(BigInt(p.invest_minor), currency),
      rounding: money(BigInt(p.rounding_minor), currency),
      // the canonical lines, adding up to the amount to pay, whatever the template does with the other slots
      breakdown: lines.map((l) => `${l.label}: ${money(BigInt(l.minor), currency)}`).join('\n'),
      lead_fee: money(BigInt(p.lead_fee_minor), currency),
      amount_to_pay: money(BigInt(p.cash_due_minor), currency),
      carry: percent(terms.carry_bps),
      fee_terms: feeWords(linkFee(terms), currency),
      reference: p.reference,
      date,
      custom_terms: custom,
    })
    if (rendered === null) throw new Refused(SHEET_TOO_LONG)
    const body = rendered
    // §5.5: the deal sheet is promotional, so it leads with the warning worded for this person's category
    const warning = warningFor(pack, (await d.eligibilityFacts(c, p.user_id, pack)).statement?.category)
    if (!warning.text) throw new Refused('This document cannot be shown without its warning.')
    // COBS: the signed copy carries the full risk summary too (§5.5)
    const lead = [warning.text, warning.sender && `Sent by: ${warning.sender}`, warning.risk_summary].filter(Boolean).join('\n')
    // the signed PDF draws the lead, the body and the signature line: all of it must fit, or the sheet is never offered (Codex round 11)
    if (!signedSheetFits(lead, body, PDF_MAX_CHARS)) throw new Refused(SHEET_AND_WARNING_TOO_LONG)
    return { template: tpl, body, warning, lead, date, sha256: sha(`${lead}\n\n${body}`) }
  }

  /** R-SIG-01: a click signature of exactly the sheet shown, with its warning lead, bound to the entity and terms versions. */
  async function recordSignature(c: Tx, p: ParticipationRow, sheet: Awaited<ReturnType<typeof dealSheetFor>>, signedName: string, ip: string, authMethod: string) {
    const id = randomUUID()
    await c.query(
      `INSERT INTO signature_record (id, participation_id, entity_version, terms_version, template_id, document, document_lead, document_sha256, provider, signed_name, ip, auth_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'click', $9, $10, $11)`,
      [
        id,
        p.id,
        p.entity_version,
        p.terms_version,
        sheet.template.id,
        `${sheet.lead}\n\n${sheet.body}`,
        sheet.lead,
        sheet.sha256,
        signedName,
        ip,
        authMethod,
      ],
    )
    return id
  }

  app.get<{ Params: { id: string } }>('/api/my/participations/:id/deal-sheet', verified, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    return tx(d.db, async (c) => {
      const p = await ownParticipation(c, pid, who.id)
      const { deal, pack } = await dealAndPack(c, p.deal_id)
      const gate = await dealGateFacts(c, deal)
      const { person } = await personFacts(c, who.id, deal, pack)
      const f = await ownFacts(c, p, await modeOf(c))
      if (!canContinueOwnParticipation(person, f, gate)) throw new Refused(NEUTRAL)
      const sheet = await dealSheetFor(c, p, deal, pack)
      return {
        warning: sheet.warning,
        document: sheet.body,
        document_sha256: sheet.sha256,
        needs_deed: sheet.template.needs_deed,
        can_sign: canSign(person, f, gate, kycFirst(pack)) && !sheet.template.needs_deed,
        signed: f.signed,
      }
    })
  })

  app.post<{ Params: { id: string } }>('/api/my/participations/:id/sign', verified, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = z
      .strictObject({ agree: z.literal(true), signed_name: z.string().trim().min(2).max(200), document_sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .parse(req.body)
    return personTx(who, async (c) => {
      const p0 = await ownParticipation(c, pid, who.id)
      const deal = (await dealById(c, p0.deal_id, true))!
      const p = await ownParticipation(c, pid, who.id, true)
      const pack = (await packOf(c, deal))!
      const gate = await dealGateFacts(c, deal)
      const { person } = await personFacts(c, who.id, deal, pack)
      const f = await ownFacts(c, p, await modeOf(c))
      if (!canSign(person, f, gate, kycFirst(pack))) throw new Refused('This cannot be signed now.')
      const sheet = await dealSheetFor(c, p, deal, pack)
      // R-SIG-04: a deed is not click-signed
      if (sheet.template.needs_deed) throw new Refused('This document must be signed outside this site. The operator will send it.')
      // what is signed is what the page showed
      if (sheet.sha256 !== b.document_sha256) throw new Refused('The document has changed since you opened it. Open it again.')
      const id = await recordSignature(c, p, sheet, b.signed_name, req.ip, who.authMethod)
      await logParticipation(c, p.id, 'signed', who.id, { signature: id })
      await appendAudit(c, d.k, { actor: who.id, action: 'participation.signed', entity: id })
      return { ok: true }
    })
  })

  // R-SIG-06: the signed document, whatever the eligibility (narrow exception)
  app.get<{ Params: { id: string } }>('/api/my/participations/:id/signed', verified, async (req, reply) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const doc = await tx(d.db, async (c) => {
      const p = await ownParticipation(c, pid, who.id)
      if (!canSeeOwnExecutedDocs(p.user_id === who.id)) throw new Refused(NOT_FOUND)
      const s = (
        await c.query<{ document: string; document_lead: string; signed_name: string; signed_at: Date }>(
          // only an executed document, the newest of them: a deed sent and not yet signed is not one, nor does it hide one (Codex round 6)
          `SELECT document, document_lead, signed_name, signed_at FROM signature_record WHERE participation_id = $1 AND ${EXECUTED} ORDER BY signed_at DESC LIMIT 1`,
          [p.id],
        )
      ).rows[0]
      if (!s) throw new Refused(NOT_FOUND)
      return s
    })
    // the warning as it was shown, however many paragraphs, then the body: never guessed from blank lines
    const body =
      doc.document_lead && doc.document.startsWith(doc.document_lead) ? doc.document.slice(doc.document_lead.length).replace(/^\n\n/, '') : doc.document
    const pdf = await renderPdf(
      [
        ...(doc.document_lead ? [{ text: doc.document_lead, bold: true, boxed: true }] : []),
        { text: body },
        { text: `Signed by ${doc.signed_name} on ${new Date(doc.signed_at).toISOString()}` },
      ],
      'Signed deal sheet',
    )
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'attachment; filename="deal-sheet.pdf"')
    return reply.send(pdf)
  })

  // ---------- Payment instructions (R-PAY-01 to R-PAY-05, R-OP-05) ----------

  app.post<{ Params: { id: string } }>('/api/my/participations/:id/acknowledge-account', verified, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    const b = z.strictObject({ account_sha256: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.body)
    return personTx(who, async (c) => {
      const p = await ownParticipation(c, pid, who.id, true)
      const deal = (await dealById(c, p.deal_id))!
      const snap = (await approvedSnapshot(c, deal))!
      const acct = await currentAccount(c, snap.snapshot.terms?.currency ?? 'GBP', await modeOf(c))
      if (!acct || acct.sha256 !== b.account_sha256) throw new Refused('The account details have changed. Open the page again.')
      if (acct.id)
        await c.query('INSERT INTO instruction_ack (participation_id, payment_instruction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.id, acct.id])
      await appendAudit(c, d.k, { actor: who.id, action: 'instruction.account_acknowledged', entity: p.id })
      return { ok: true }
    })
  })

  /** R-PAY-03: the instruction in force, issued now if conditions allow and none is valid. */
  async function instructionFor(c: Tx, who: SessionUser, pid: string) {
    // an approved account change holds this row for update: the account read here is the one the issue is bound to (R-OP-05)
    await lockInstanceShare(c)
    const p0 = await ownParticipation(c, pid, who.id)
    const deal = (await dealById(c, p0.deal_id, true))!
    const p = await ownParticipation(c, pid, who.id, true)
    const pack = (await packOf(c, deal))!
    const gate = await dealGateFacts(c, deal)
    const mode = await modeOf(c)
    const f = await ownFacts(c, p, mode)
    const snap = (await approvedSnapshot(c, deal))!
    const currency = snap.snapshot.terms?.currency ?? 'GBP'
    const acct = await currentAccount(c, currency, mode)
    let issued = (
      await c.query<{
        id: string
        cash_due_minor: string
        verify_sealed: Buffer
        verify_key_id: string
        verify_wrapped_key: Buffer
        warning: ReturnType<typeof warningFor> | Record<string, never>
        created_at: Date
        account_sha256: string
      }>('SELECT * FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL', [p.id])
    ).rows[0]
    if (activeHold(gate.holds)) return { kind: 'held' as const, deal }
    const { person } = await personFacts(c, who.id, deal, pack)
    // R-ALO-01: nothing new is issued while a proposed amount waits for an answer
    if (!issued && (await openProposal(c, alloc, p.id))) throw new Refused('The lead has proposed a new amount. Answer that first.')
    if (!issued) {
      if (!acct) throw new Refused('The operator has not set up a receiving account for this currency.')
      // R-PAY-01.1: no instructions without the "your money" panel's wording
      if (!textOf(pack, acct.yourMoneyKey)) throw new Refused('Payment details are not available yet: the operator has not finished setting them up.')
      // the gate first: the account itself is payment detail, so nobody short of it sees even the acknowledgement
      if (!canSeePaymentInstructions(person, { ...f, accountAcknowledged: true }, gate)) throw new Refused('Payment details are not available yet.')
      // R-OP-05: a new account is shown only once the person has confirmed they saw it changed
      if (!f.accountAcknowledged) return { kind: 'acknowledge' as const, acknowledge: true, account_sha256: acct.sha256 }
      const warningNow = warningFor(pack, (await d.eligibilityFacts(c, who.id, pack)).statement?.category)
      if (!warningNow.text) throw new Refused('Payment details cannot be shown without their warning.')
      const token = newToken()
      const sealed = d.k.encrypt(Buffer.from(token))
      await c.query(
        `INSERT INTO issued_instruction (id, participation_id, payment_instruction_id, account_sha256, cash_due_minor, terms_version, signature_id, entity_version, deal_version, verify_hmac, verify_sealed, verify_key_id, verify_wrapped_key, warning)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          randomUUID(),
          p.id,
          acct.id,
          acct.sha256,
          p.cash_due_minor,
          p.terms_version,
          f.signatureId,
          p.entity_version,
          snap.n,
          d.k.hmac(`verify\0${token}`),
          sealed.ciphertext,
          sealed.keyId,
          sealed.wrappedDek,
          JSON.stringify(warningNow),
        ],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'instruction.issued', entity: p.id })
      issued = (await c.query('SELECT * FROM issued_instruction WHERE participation_id = $1 AND voided_at IS NULL', [p.id])).rows[0]
    } else if (!canSeeIssuedInstructions(true, { voided: false }, gate)) return { kind: 'held' as const, deal }
    const token = d.k.decrypt(issued!.verify_key_id, issued!.verify_wrapped_key, issued!.verify_sealed).toString()
    const due = BigInt(p.cash_due_minor)
    const held = f.held > 0n ? f.held : 0n
    return {
      kind: 'ok' as const,
      deal,
      pack,
      // the warning this issue was made with: a later change of category never leaves it without one
      warning: (issued!.warning as ReturnType<typeof warningFor>).text
        ? (issued!.warning as ReturnType<typeof warningFor>)
        : warningFor(pack, (await d.eligibilityFacts(c, who.id, pack)).statement?.category),
      deal_code: deal.public_code,
      currency,
      // R-PAY-01: the biggest number on the page
      still_to_pay_minor: String(due > held ? due - held : 0n),
      due_minor: p.cash_due_minor,
      received_minor: String(f.held),
      refunded_minor: '0',
      reference: p.reference,
      pay_by: snap.snapshot.terms?.pay_by ?? null,
      account: acct?.fields ?? null,
      your_money: {
        text: textOf(pack, acct?.yourMoneyKey ?? 'your_money'),
        operator_statement: 'Stated by the operator. This software has not checked it.',
        refund_days: acct?.refundDays ?? null,
        // R-PAY-01.1: what the operator says about the account, shown as its statement
        client_money: acct && typeof acct.fields.asserted_client_money === 'boolean' ? acct.fields.asserted_client_money : null,
        holder_frn: (acct?.fields.holder_frn as string | null | undefined) ?? null,
      },
      breakdown: breakdown(BigInt(p.commitment_minor), linkFee((await termsOfParticipation(c, p))!), pack.regime === 'uk-fpo').lines,
      no_money_held: 'This software does not receive money. Pay only to the account shown, which the operator set up.',
      reminders: [
        'Do not use a payee saved earlier; type the details from this page.',
        'Pay from an account in the name of the investing person or entity.',
        'Account changes are never sent by email. Do not act on one.',
        `Pay in ${currency} only. Cryptocurrency is not accepted.`,
      ],
      verify_url: linkTo(`/verify-instruction?token=${token}`),
      verify_note: 'Before paying, check that these details are still valid.',
      issued_at: issued!.created_at,
      transfer_marked: f.transferMarked,
    }
  }
  const termsOfParticipation = async (c: Q, p: ParticipationRow) =>
    (await c.query<InvitationRow>('SELECT * FROM deal_invitation WHERE id = $1', [p.invitation_id])).rows[0]!.terms_snapshot

  app.get<{ Params: { id: string } }>('/api/my/participations/:id/instructions', verified, async (req) => {
    const r = await tx(d.db, (c) => instructionFor(c, req.user!, Uuid.parse(req.params.id)))
    if (r.kind === 'held') return { held: true, deal_code: r.deal.public_code, message: DONT_PAY }
    if (r.kind === 'acknowledge') return r
    const { deal: _d, pack: _p, kind: _k, ...rest } = r
    // R-PAY-07: what to do when a payment sent has not arrived
    return { ...rest, stuck_payment_help: STUCK_PAYMENT_HELP }
  })

  app.get<{ Params: { id: string } }>('/api/my/participations/:id/instructions.pdf', verified, async (req, reply) => {
    const r = await tx(d.db, (c) => instructionFor(c, req.user!, Uuid.parse(req.params.id)))
    if (r.kind !== 'ok') throw new Refused('Payment details are not available now.')
    const acct = Object.entries(r.account ?? {})
      .filter(([k]) => !['asserted_client_money', 'fictional'].includes(k))
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v ?? ''}`)
      .join('\n')
    const pdf = await renderPdf(
      [
        { text: [r.warning.text, r.warning.sender && `Sent by: ${r.warning.sender}`].filter(Boolean).join('\n'), bold: true, boxed: true },
        ...(r.warning.risk_summary ? [{ text: r.warning.risk_summary }] : []),
        { text: `Payment details for deal ${r.deal_code}`, bold: true, size: 14 },
        { text: `${r.verify_note} ${r.verify_url}`, bold: true },
        { text: `Still to pay: ${money(BigInt(r.still_to_pay_minor), r.currency)}`, bold: true, size: 16 },
        {
          text: `Amount to pay in total: ${money(BigInt(r.due_minor), r.currency)}\nReceived so far: ${money(BigInt(r.received_minor), r.currency)}\nPayment reference: ${r.reference}${r.pay_by ? `\nPay by: ${r.pay_by}` : ''}`,
        },
        {
          text: [
            'Your money',
            r.your_money.text,
            r.your_money.client_money === null ? '' : `The operator says this ${r.your_money.client_money ? 'is' : 'is not'} a client money account.`,
            r.your_money.holder_frn ? `Holder's FRN: ${r.your_money.holder_frn}` : '',
            r.your_money.refund_days === null ? '' : `If the deal does not close, the operator says money is returned within ${r.your_money.refund_days} days.`,
            r.your_money.operator_statement,
          ]
            .filter(Boolean)
            .join('\n'),
        },
        { text: `Receiving account\n${acct}` },
        { text: r.breakdown.map((l) => `${l.label}: ${money(BigInt(l.minor), r.currency)}`).join('\n') },
        { text: [r.no_money_held, ...r.reminders].join('\n') },
        { text: `Issued ${new Date(r.issued_at).toISOString()}` },
      ],
      `Payment details ${r.deal_code}`,
    )
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="payment-${r.deal_code}.pdf"`)
    return reply.send(pdf)
  })

  /** R-PAY-03: anyone holding the link learns only whether this issue is still valid. */
  app.get<{ Querystring: { token?: string } }>('/api/instructions/verify', pub, async (req, reply) => {
    reply.header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer')
    const token = z.string().min(10).max(200).safeParse(req.query.token)
    if (!token.success) return { valid: false, message: 'These payment details are not valid. Do not pay using them.' }
    const r = (
      await d.db.query<{ participation_id: string; voided_at: Date | null }>(
        'SELECT participation_id, voided_at FROM issued_instruction WHERE verify_hmac = $1',
        [d.k.hmac(`verify\0${token.data}`)],
      )
    ).rows[0]
    if (!r || r.voided_at) return { valid: false, message: 'These payment details are not valid. Do not pay using them.' }
    const p = (await d.db.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [r.participation_id])).rows[0]!
    const deal = (await dealById(d.db, p.deal_id))!
    if (activeHold((await dealGateFacts(d.db, deal)).holds)) return { valid: false, held: true, message: DONT_PAY }
    return { valid: true, message: 'These payment details are still valid.' }
  })

  // R-PAY-04: "I have paid" tells the lead. It is not a receipt.
  app.post<{ Params: { id: string } }>('/api/my/participations/:id/paid', verified, async (req) => {
    const who = req.user!
    const pid = Uuid.parse(req.params.id)
    await personTx(who, async (c) => {
      const p = await ownParticipation(c, pid, who.id, true)
      if (p.outcome !== 'active') throw new Refused(NEUTRAL)
      const issued = (await c.query('SELECT 1 FROM issued_instruction WHERE participation_id = $1', [p.id])).rowCount! > 0
      if (!issued) throw new Refused('Open the payment details first.')
      await c.query('INSERT INTO transfer_mark (id, participation_id, actor) VALUES ($1, $2, $3)', [randomUUID(), p.id, who.id])
      await logParticipation(c, p.id, 'transfer_marked', who.id)
      await appendAudit(c, d.k, { actor: who.id, action: 'participation.transfer_marked', entity: p.id })
      const deal = (await dealById(c, p.deal_id))!
      await d.mail.queue(
        c,
        await toLead(
          c,
          deal.lead_user,
          deal.id,
          `Deal ${deal.public_code}: an investor says they have paid`,
          'An investor says they have sent their payment. This is not a receipt: the operator records money when it arrives.',
        ),
      )
    })
    await d.mail.flush()
    return { ok: true }
  })

  // R-LNK-09: the country a person gives, asked with eligibility; used only for the lead's reminders
  app.get('/api/my/country', verified, async (req) => ({
    country: (await d.db.query<{ country: string | null }>('SELECT country FROM user_account WHERE id = $1', [req.user!.id])).rows[0]!.country,
  }))
  app.put('/api/my/country', verified, async (req) => {
    const b = z
      .strictObject({
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .nullable(),
      })
      .parse(req.body)
    const who = req.user!
    return personTx(who, async (c) => {
      await c.query('UPDATE user_account SET country = $2 WHERE id = $1', [who.id, b.country])
      await appendAudit(c, d.k, { actor: who.id, action: 'account.country_set', entity: who.id })
      return { ok: true }
    })
  })

  // R-PAGE-06: a note to the lead
  app.post<{ Params: { id: string } }>('/api/my/deals/:id/message', verified, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ body: z.string().trim().min(1).max(5000) }).parse(req.body)
    await personTx(who, async (c) => {
      const deal = await dealById(c, id)
      if (!deal) throw new Refused(NOT_FOUND)
      const inv = await activeInvitation(c, deal.id, who.id)
      const committed = (await ownParticipations(c, deal.id, who.id)).some((p) => p.outcome === 'active')
      if (!inv && !committed) throw new Refused(NOT_FOUND)
      await c.query('INSERT INTO deal_message (id, deal_id, author, body) VALUES ($1, $2, $3, $4)', [randomUUID(), deal.id, who.id, b.body])
      await appendAudit(c, d.k, { actor: who.id, action: 'deal.message_sent', entity: deal.id })
      await d.mail.queue(c, await toLead(c, deal.lead_user, deal.id, `Deal ${deal.public_code}: a message from an investor`, 'An investor sent you a message. Sign in to read it.'))
    })
    await d.mail.flush()
    return { ok: true }
  })

  return {
    attachPending,
    previewSheet,
    previewPage,
    sharedContent,
    /** The deal sheet as this person would sign it now, dated `date` if given (for a deed signed outside the site, R-SIG-04). */
    async sheetFor(c: Q, pid: string, date?: string) {
      const p = (await c.query<ParticipationRow>('SELECT * FROM participation WHERE id = $1', [pid])).rows[0]
      if (!p) throw new Refused(NOT_FOUND)
      const { deal, pack } = await dealAndPack(c, p.deal_id)
      return dealSheetFor(c, p, deal, pack, date)
    },
    /** isQualified for a person on a deal's pack (§5.5). */
    async qualified(c: Q, userId: string, dealId: string) {
      const { deal, pack } = await dealAndPack(c, dealId)
      return (await personFacts(c, userId, deal, pack)).person.qualified
    },
    /** R-COM-04: what a lead's message is for this person today (the message, a sign-in notice, or nothing), and their warning. */
    async messageFor(c: Q, userId: string, dealId: string): Promise<{ delivery: Delivery; warning: PromoWarning | null }> {
      const deal = await dealById(c, dealId)
      const pack = deal && (await packOf(c, deal))
      if (!deal || !pack) return { delivery: { kind: 'excluded', reason: 'ended' }, warning: null }
      const u = (await c.query<{ open: boolean }>('SELECT (disabled_at IS NULL AND anonymised_at IS NULL) AS open FROM user_account WHERE id = $1', [userId])).rows[0]
      const { person, eligibility } = await personFacts(c, userId, deal, pack)
      const committed = await c.query(`SELECT 1 FROM participation WHERE deal_id = $1 AND user_id = $2 AND outcome = 'active' AND created_at >= ${REAL_SINCE}`, [
        dealId,
        userId,
      ])
      const delivery = deliveryFor({ reachable: !!u?.open, person, activeCommitment: !!committed.rowCount, deal: await dealGateFacts(c, deal) })
      const w = warningFor(pack, eligibility.statement?.category)
      return { delivery, warning: w.text ? { text: [w.text, w.risk_summary].filter(Boolean).join('\n\n'), sender: w.sender } : null }
    },
    /** R-COM-04: whether a person passes for a deal today, and the warning block their category gets (§5.5). */
    async promotion(c: Q, userId: string, dealId: string) {
      const deal = await dealById(c, dealId)
      const pack = deal && (await packOf(c, deal))
      if (!deal || !pack) return { passes: false, warning: null }
      const { person, eligibility } = await personFacts(c, userId, deal, pack)
      const w = warningFor(pack, eligibility.statement?.category)
      return {
        passes: canReceivePromotion(person, await dealGateFacts(c, deal)),
        warning: w.text ? { text: [w.text, w.risk_summary].filter(Boolean).join('\n\n'), sender: w.sender } : null,
      }
    },
  }
}

/** As D1 names an entity: a person's full name, or the entity's name. */
export const entityName = (type: string, fields: Record<string, string>) => (type === 'individual' ? fields.full_name : fields.name) ?? ''
