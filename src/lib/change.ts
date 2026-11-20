// Changes to a live deal (PRD R-CHG-01, R-CHG-02, R-CHG-05, §5.1's action table). Pure. Every field is sorted into one of
// four kinds: what investors get (always reconfirmed; neither a reviewer nor a pack may lower it), content and limits (a
// reviewer judges "notice only" or "reconfirm", with a reason; a pack may make an item always reconfirmed), the lead's own
// choices (the two dates and, by R-ALO-03, what happens when the allocation is full: a version and a notice, no reviewer),
// and the currency once anyone has committed (never). A field not named below counts as what investors get, so a field
// added later is reconfirmed until someone decides otherwise.
import type { Draft } from './draft.ts'
import type { AnyDealState } from './gate.ts'
import { dueFor } from './fees.ts'
import { newLinkRefusal, type LinkPolicy, type LinkTerms } from './invite.ts'
import { contentOf, diffContent, type FieldChange } from './snapshot.ts'

/** Items a pack may list in `must_reconfirm_extra` to make them always reconfirmed. */
export const CONTENT_ITEMS = [
  'memo',
  'deck',
  'company_details',
  'deal_name',
  'round',
  'round_size',
  'allocation_increase',
  'allocation_decrease',
  'min_commitment_raise',
  'min_commitment_lower',
  'min_raise_raise',
  'price_set',
  'price_lower',
] as const
export type ContentItem = (typeof CONTENT_ITEMS)[number]

export type ItemKind = 'reconfirm' | 'content' | 'self_service'

export interface ChangeItem {
  /** The field, as the top two parts of its path (e.g. `terms.min_commitment_minor`). */
  field: string
  kind: ItemKind
  item?: ContentItem
  /** One of SPV allocation, minimum commitment, minimum raise, over-allocation: only in `live`. */
  limit: boolean
  /** What the reviewer's choice starts at; null where the reviewer must choose (a smaller allocation). */
  suggested?: 'notice' | null
}

/** R-CHG-01; R-ALO-03 names the allocation mode as the lead's own choice (owner 2026-11-17, PRD v0.23). */
const SELF_SERVICE = new Set(['terms.target_close', 'terms.pay_by', 'terms.over_allocation'])
const CONTENT: ReadonlyMap<string, ContentItem> = new Map([
  ['files.memo', 'memo'],
  ['files.deck', 'deck'],
  ['company.website', 'company_details'],
  ['company.contact_name', 'company_details'],
  ['company.contact_email', 'company_details'],
  ['company.address', 'company_details'],
  ['basics.name', 'deal_name'],
  ['terms.round', 'round'],
  ['terms.round_size_minor', 'round_size'],
])
const LIMITS = new Set(['terms.allocation_minor', 'terms.min_commitment_minor', 'terms.min_raise_minor', 'terms.over_allocation'])
const PRICE = new Set(['terms.share_price_micros', 'terms.price_is_placeholder'])
/** What the deal sheet shows, so a change there means signing again (any signed document's content, R-CHG-02). */
const ON_DEAL_SHEET = new Set(['company.legal_name', 'terms.instrument', 'terms.currency', 'economics.default_carry_bps', 'terms.custom_terms'])

const top = (path: string) => path.split('.').slice(0, 2).join('.')

function amount(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d{1,19}$/.test(v)) return null
  return BigInt(v)
}

type Terms = Record<string, unknown>
const termsOf = (c: Record<string, unknown>): Terms => (typeof c.terms === 'object' && c.terms !== null ? (c.terms as Terms) : {})

/** R-CHG-05: setting a placeholder price, or lowering a price, is not material; raising a published price, or hiding one, is. */
function priceItem(b: Terms, a: Terms): ChangeItem {
  const field = 'terms.share_price_micros'
  const beforePlaceholder = b.price_is_placeholder === true || b.share_price_micros === undefined
  const afterPlaceholder = a.price_is_placeholder === true
  if (beforePlaceholder) return { field, kind: 'content', item: 'price_set', limit: false, suggested: 'notice' }
  const was = amount(b.share_price_micros)
  const now = amount(a.share_price_micros)
  if (afterPlaceholder || was === null || now === null || now > was) return { field, kind: 'reconfirm', limit: false }
  return { field, kind: 'content', item: 'price_lower', limit: false, suggested: 'notice' }
}

export interface ChangeInput {
  before: Draft
  after: Draft
  state: AnyDealState
  /** Anyone has ever committed to this deal. */
  anyCommitment: boolean
  /** The pack's `must_reconfirm_extra`. */
  stricter: readonly string[]
  /** The operator's minimum commitment, which a blank minimum means. */
  floorMinor: bigint
  /** People who have committed and are not in a final status, with their commitment C. */
  people: ReadonlyArray<{ id: string; commitment: bigint }>
}

export interface Classified {
  changes: FieldChange[]
  items: ChangeItem[]
  /** People below a raised minimum commitment, who reconfirm whatever the reviewer decides. */
  belowNewMinimum: string[]
  /** The deal sheet changes, so people who signed sign again. */
  resign: boolean
}

export type Classification = { ok: true; c: Classified } | { ok: false; reason: string }

const CHANGE_STATES: readonly AnyDealState[] = ['live', 'closing_requested', 'closing']

/** R-CHG-01, R-CHG-02, §5.1: what kind of change this is, or why it cannot be made in this state. */
export function classifyChange(i: ChangeInput): Classification {
  if (!CHANGE_STATES.includes(i.state)) return { ok: false, reason: 'This deal cannot be changed in its state.' }
  const b = contentOf(i.before)
  const a = contentOf(i.after)
  const changes = diffContent(b, a)
  if (!changes.length) return { ok: false, reason: 'Nothing has changed.' }
  const bt = termsOf(b)
  const at = termsOf(a)
  const items = new Map<string, ChangeItem>()
  const belowNewMinimum: string[] = []
  for (const field of new Set(changes.map((c) => top(c.field)))) {
    if (field === 'terms.currency' && i.anyCommitment) return { ok: false, reason: 'The currency cannot change once anyone has committed.' }
    let item: ChangeItem
    if (SELF_SERVICE.has(field)) item = { field, kind: 'self_service', limit: LIMITS.has(field) }
    else if (PRICE.has(field)) item = priceItem(bt, at)
    else if (field === 'terms.allocation_minor') {
      const was = amount(bt.allocation_minor)
      const now = amount(at.allocation_minor)
      if (was === null || now === null) item = { field, kind: 'reconfirm', limit: true }
      else if (now > was) item = { field, kind: 'content', item: 'allocation_increase', limit: true, suggested: 'notice' }
      else item = { field, kind: 'content', item: 'allocation_decrease', limit: true, suggested: null }
    } else if (field === 'terms.min_commitment_minor') {
      const was = bt.min_commitment_minor === undefined ? i.floorMinor : amount(bt.min_commitment_minor)
      const now = at.min_commitment_minor === undefined ? i.floorMinor : amount(at.min_commitment_minor)
      if (was === null || now === null) item = { field, kind: 'reconfirm', limit: true }
      else if (now > was) {
        // Goten C-ALL-2 would leave them out at close, so these people must agree whatever the reviewer decides
        for (const p of i.people) if (p.commitment < now) belowNewMinimum.push(p.id)
        item = { field, kind: 'content', item: 'min_commitment_raise', limit: true, suggested: 'notice' }
      } else item = { field, kind: 'content', item: 'min_commitment_lower', limit: true, suggested: 'notice' }
    } else if (field === 'terms.min_raise_minor') {
      const was = bt.min_raise_minor === undefined ? 0n : amount(bt.min_raise_minor)
      const now = at.min_raise_minor === undefined ? 0n : amount(at.min_raise_minor)
      // a lower minimum raise, or none, lets the deal close with less money than investors were told
      if (was === null || now === null || now < was) item = { field, kind: 'reconfirm', limit: true }
      else item = { field, kind: 'content', item: 'min_raise_raise', limit: true, suggested: 'notice' }
    } else {
      const content = CONTENT.get(field)
      item = content
        ? { field, kind: 'content', item: content, limit: LIMITS.has(field), suggested: 'notice' }
        : { field, kind: 'reconfirm', limit: LIMITS.has(field) }
    }
    if (item.kind === 'content' && item.item && i.stricter.includes(item.item)) item = { ...item, kind: 'reconfirm', suggested: undefined }
    items.set(item.field, item) // the price and its placeholder mark are one item
  }
  const list = [...items.values()]
  if (i.state !== 'live') {
    if (list.some((x) => x.limit))
      return { ok: false, reason: 'The allocation, the minimums and what happens when it is full can only change while the deal is live.' }
    if (list.some((x) => x.kind === 'reconfirm')) return { ok: false, reason: notLiveReason(i.state) }
  }
  const resign = changes.some((c) => ON_DEAL_SHEET.has(top(c.field)))
  return { ok: true, c: { changes, items: list, belowNewMinimum: [...new Set(belowNewMinimum)].sort(), resign } }
}

/** Why a change investors must reconfirm cannot be made outside `live` (§5.1). */
export function notLiveReason(state: AnyDealState): string {
  if (state === 'closing_requested') return 'A change that investors must reconfirm needs the closing request withdrawn first.'
  if (state === 'closing') return 'A change that investors must reconfirm needs the deal back in live, or cancelled.'
  return 'This deal cannot be changed in its state.'
}

/** One change to a deal waits for a decision at a time. */
export const ONE_CHANGE_OPEN = 'Another change to this deal is waiting for a decision. Withdraw it or wait for the answer.'

/** Whether a reviewer must choose between notice and reconfirmation (and give a reason). */
export const needsJudgement = (c: Classified) => c.items.some((x) => x.kind === 'content')
/** The lead's own choices only: a version and a notice, no reviewer (R-CHG-01, R-ALO-03). */
export const selfServiceOnly = (c: Classified) => c.items.every((x) => x.kind === 'self_service')

export interface Judgement {
  verdict?: 'notice' | 'reconfirm'
  reason?: string
}

export interface ChangeEffect {
  /** A new terms version: only when someone reconfirms. A notice keeps the version, the signatures and the instructions. */
  newTermsVersion: boolean
  /** Who reconfirms: everyone committed and not in a final status, or only these. */
  reconfirm: 'all' | string[]
  /** People who signed sign again (only those who reconfirm). */
  resign: boolean
  /** Everyone is told and sees the differences. */
  notify: true
  reviewed: boolean
}

export type ChangeDecision = { ok: true; effect: ChangeEffect } | { ok: false; reason: string }

/** R-CHG-02: what the change does once approved. Takes effect in the same transaction as the content approval (R-CMP-02). */
export function decideChange(c: Classified, state: AnyDealState, j: Judgement): ChangeDecision {
  if (selfServiceOnly(c)) return { ok: true, effect: { newTermsVersion: false, reconfirm: [], resign: false, notify: true, reviewed: false } }
  const forced = c.items.some((x) => x.kind === 'reconfirm')
  let all = forced
  if (needsJudgement(c)) {
    if (j.verdict !== 'notice' && j.verdict !== 'reconfirm')
      return { ok: false, reason: 'Decide whether this is a correction to tell people about or a change they must reconfirm.' }
    if (!j.reason?.trim()) return { ok: false, reason: 'Give a reason for the decision.' }
    if (j.verdict === 'notice' && forced) return { ok: false, reason: 'Part of this change alters what investors get, so they must reconfirm it.' }
    all = all || j.verdict === 'reconfirm'
  }
  if (all && state !== 'live') return { ok: false, reason: notLiveReason(state) }
  const reconfirm: 'all' | string[] = all ? 'all' : c.belowNewMinimum
  const someone = reconfirm === 'all' || reconfirm.length > 0
  // every field on the deal sheet is one investors must reconfirm, so `resign` never comes with a notice alone
  return { ok: true, effect: { newTermsVersion: someone, reconfirm, resign: c.resign, notify: true, reviewed: true } }
}

/** R-CHG-02: a change to one person's terms (such as their link's carry or fee) is reconfirmed by that person only, and re-signed. */
export function personChangeRefusal(state: AnyDealState, before: LinkTerms, after: LinkTerms): string | null {
  if (state !== 'live') return notLiveReason(state)
  const same = before.carryBps === after.carryBps && JSON.stringify(before.fee, big) === JSON.stringify(after.fee, big)
  return same ? 'Nothing has changed.' : null
}
const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)

export interface PersonTermsFacts {
  state: AnyDealState
  before: LinkTerms
  after: LinkTerms
  /** The lead's sentence, which is also why the terms differ from the default (R-LNK-06). */
  reason: string
  defaultCarryBps: number
  feeMaxBps: number
  policy: LinkPolicy
  attestationRequired: boolean
  incentiveAttested: boolean
  /** C of each commitment still active under these terms. */
  commitments: readonly bigint[]
  /** R-ALO-03: the deal's allocation mode and Σ T of everyone else. */
  room: { stop: boolean; allocation: bigint; others: bigint }
}

/**
 * R-CHG-02, R-LNK-06, R-ALO-03: why one person's terms cannot change to these, or null. The new terms meet every rule a new link
 * with them would; a fee taken from the payment must leave something invested; with a stopping allocation, terms that raise what
 * is invested must still fit.
 */
export function personTermsRefusal(f: PersonTermsFacts): string | null {
  const same = personChangeRefusal(f.state, f.before, f.after)
  if (same) return same
  if (!f.commitments.length) return 'Nobody is committed under these terms any more.'
  const link = newLinkRefusal({
    dealLive: true,
    activeLinks: 0,
    defaultCarryBps: f.defaultCarryBps,
    feeMaxBps: f.feeMaxBps,
    policy: f.policy,
    kind: 'terms_only',
    terms: f.after,
    reason: f.reason,
    incentiveAttested: f.incentiveAttested,
    attestationRequired: f.attestationRequired,
  })
  if (link) return link
  let was = 0n
  let next = 0n
  for (const c of f.commitments) {
    const after = dueFor(c, f.after.fee).invest
    if (after < 1n) return 'This fee would take the whole of a commitment under these terms.'
    was += dueFor(c, f.before.fee).invest
    next += after
  }
  if (f.room.stop && next > was && f.room.others + next > f.room.allocation) return 'These terms would take the deal past its allocation.'
  return null
}

/** The differences one person is asked about when their terms change (R-CHG-05). */
export function termsChanges(before: LinkTerms, after: LinkTerms): FieldChange[] {
  const out: FieldChange[] = []
  if (before.carryBps !== after.carryBps) out.push({ field: 'carry_bps', before: String(before.carryBps), after: String(after.carryBps) })
  const fb = JSON.stringify(before.fee, big)
  const fa = JSON.stringify(after.fee, big)
  if (fb !== fa) out.push({ field: 'lead_fee', before: fb, after: fa })
  return out
}

export const PRICE_HIDDEN_TEXT = 'The price is set; it is shown after closing.'

/** R-CHG-05: the differences a person is shown. While the price stays hidden until closing, its values never appear. */
export function changesShown(changes: readonly FieldChange[], priceShown: boolean): FieldChange[] {
  if (priceShown) return [...changes]
  const out: FieldChange[] = []
  let priced = false
  for (const ch of changes) {
    if (!PRICE.has(top(ch.field))) out.push(ch)
    else if (!priced) {
      priced = true
      out.push({ field: 'terms.share_price_micros', before: null, after: PRICE_HIDDEN_TEXT })
    }
  }
  return out
}

// ---------- R-ADM-08: how each part of the deal can change, shown to the lead before they ask ----------

/** `yourself`: the lead's own choices (R-CHG-01, R-ALO-03); `reviewer`: a reviewer judges notice or reconfirm; `reconfirm`: always reconfirmed; `by_direction`: depends which way it moves. */
export type ChangeRoute = 'yourself' | 'reviewer' | 'reconfirm' | 'by_direction'

export interface HowToChange {
  field: string
  route: ChangeRoute
  /** Only while the deal is live (§5.1). */
  liveOnly: boolean
  /** Locked once anyone has committed (R-CHG-02's last line). */
  lockedAfterCommitment: boolean
}

const ALWAYS = 'reconfirm' as const
/** What each field can turn into, the same as `classifyChange` sorts it: a content item or always reconfirmed. */
const DIRECTIONS: ReadonlyMap<string, ReadonlyArray<ContentItem | typeof ALWAYS>> = new Map<string, ReadonlyArray<ContentItem | typeof ALWAYS>>([
  ['terms.allocation_minor', ['allocation_increase', 'allocation_decrease']],
  ['terms.min_commitment_minor', ['min_commitment_raise', 'min_commitment_lower']],
  // a lower minimum raise, or none, lets the deal close with less than investors were told
  ['terms.min_raise_minor', ['min_raise_raise', ALWAYS]],
  // R-CHG-05: setting a placeholder or lowering the price is content, raising a published one or hiding it is reconfirmed
  ['terms.share_price_micros', ['price_set', 'price_lower', ALWAYS]],
  ['terms.price_is_placeholder', ['price_set', 'price_lower', ALWAYS]],
])

/** R-ADM-08: the route a change to this field takes (a field the lead can only change through a request, or themselves). */
export function howToChange(path: string, stricter: readonly string[]): HowToChange {
  const field = top(path)
  const base = { field, liveOnly: LIMITS.has(field), lockedAfterCommitment: field === 'terms.currency' }
  if (SELF_SERVICE.has(field)) return { ...base, route: 'yourself' }
  const content = CONTENT.get(field)
  const ways = DIRECTIONS.get(field) ?? (content ? [content] : [ALWAYS])
  const routes = new Set(ways.map((w) => (w === ALWAYS || stricter.includes(w) ? 'reconfirm' : 'reviewer')))
  return { ...base, route: routes.size === 1 ? [...routes][0]! : 'by_direction' }
}

/** The lead's own choices, always listed even when blank, so the lead sees what they may change themselves. */
export const SELF_SERVICE_FIELDS: readonly string[] = [...SELF_SERVICE]
