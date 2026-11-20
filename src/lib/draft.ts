// What a deal draft still lacks (PRD §4.6, §5.8). Pure. One list drives the review page, the section ticks and the refusal to
// submit, so what the screen says and what is enforced cannot differ (R-DRF-06). An empty field is never read as 0.
import { z } from 'zod'
import { MAX_MINOR, platformFee, type FeeConfig } from './fees.ts'
import { richTextPlain, richTextTooLong, safeHttpsUrl, validRichText } from './richText.ts'

export const SECTIONS = ['basics', 'company', 'terms', 'files', 'economics', 'review'] as const
export type Section = (typeof SECTIONS)[number]

export const CURRENCIES = ['GBP', 'USD', 'EUR'] as const
export const ROUNDS = [
  'pre_seed',
  'pre_seed_bridge',
  'seed',
  'seed_bridge',
  'series_a',
  'series_a_bridge',
  'series_b',
  'series_b_bridge',
  'series_c',
  'series_c_bridge',
  'series_d_plus',
  'series_d_plus_bridge',
] as const
export const INSTRUMENTS = ['equity', 'cln', 'safe', 'asa', 'fund_units'] as const
export const SHARE_CLASSES = ['ordinary', 'preferred'] as const
export const CAP_TYPES = ['none', 'pre_money', 'post_money'] as const
export const OVER_ALLOCATION = ['alert', 'stop_and_waitlist'] as const
export const VOTERS = ['lead', 'chair', 'founder'] as const
export const FEE_PAYERS = ['investors', 'lead', 'company'] as const
export const COMPANY_EXTRAS = ['registration_number', 'address'] as const

/** Goten I-01: the largest amount of money a person or a deal can be asked for (£1,000,000,000). */
export const MAX_DEAL_AMOUNT_MINOR = 100_000_000_000n
export const MIN_PRE_MONEY_MINOR = 100_000n
export const PLACEHOLDER_PRICE_MICROS = 1_000_000n
export const MAX_CARRY_RECIPIENTS = 20
const MOST = 'no more than the system can hold'
const TEXT_MAX = 200
const LONG_TEXT_MAX = 5_000

export interface CarryRecipient {
  kind?: 'person' | 'company'
  first_name?: string
  last_name?: string
  email?: string
  trading_name?: string
  legal_name?: string
  registration_number?: string
  contact_name?: string
  contact_email?: string
  share_bps?: number
}

/** Every field may be absent: a draft saves as it is typed. Amounts are minor units as strings; a price is micros. */
export interface Draft {
  basics?: {
    structure?: string
    deal_type?: string
    name?: string
    syndicate?: { mode?: 'existing'; id?: string } | { mode?: 'new'; name?: string; lead_entity_id?: string }
  }
  company?: {
    legal_name?: string
    website?: string
    contact_name?: string
    contact_email?: string
    jurisdiction?: string
    registration_number?: string
    address?: string
  }
  terms?: {
    currency?: string
    seis?: boolean
    eis?: boolean
    round?: string
    instrument?: string
    share_class?: string
    share_price_micros?: string
    price_is_placeholder?: boolean
    pre_money_minor?: string
    cap_type?: string
    cap_minor?: string
    discount_bps?: number
    fund_description?: string
    round_size_minor?: string
    allocation_minor?: string
    over_allocation?: string
    min_commitment_minor?: string
    min_raise_minor?: string
    target_close?: string
    pay_by?: string
    voter?: string
    custom_terms?: unknown
  }
  files?: { memo?: unknown; deck?: { kind?: 'file' } | { kind?: 'link'; url?: string; embed_url?: string } }
  economics?: { default_carry_bps?: number; recipients?: CarryRecipient[]; fee_payer?: string }
  attestations?: { board_and_shareholders?: boolean; fund_mainly_unlisted?: boolean }
}

export interface DraftContext {
  today: string // YYYY-MM-DD
  enabledStructures: readonly string[]
  /** The extra company fields this operator asks for. */
  requiredCompanyFields: readonly (typeof COMPANY_EXTRAS)[number][]
  minCommitmentFloorMinor: bigint
  feeConfig: FeeConfig
  embedHosts: readonly string[]
  adminSyndicateIds: readonly string[]
  ownedEntityIds: readonly string[]
  /** Files in the legal documents area that have passed the scan. */
  cleanLegalFiles: number
  cleanDeckFile: boolean
}

export interface Problem {
  section: Section
  field: string
  label: string
  kind: 'missing' | 'invalid'
  message: string
}

const absent = (v: unknown) => v === undefined || v === null || v === ''
const isEmail = (v: string) => v.length <= 320 && z.email().safeParse(v).success
/** Exactly: a limit of 1,000.01 must not be described as 1,000. */
const whole = (n: bigint) => `${String(n / 100n).replace(/\B(?=(\d{3})+$)/g, ',')}${n % 100n ? `.${String(n % 100n).padStart(2, '0')}` : ''}`

function readAmount(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(v)) return null
  const n = BigInt(v)
  return n <= MAX_MINOR ? n : null
}

/** R-PAGE-01: a deck embed address the page may frame: https, no port, on a site the operator allows. Otherwise null. */
export function allowedEmbed(v: unknown, hosts: readonly string[]): string | null {
  const u = safeHttpsUrl(v)
  return u && !u.port && hosts.map((h) => h.toLowerCase()).includes(u.hostname.toLowerCase()) ? u.href : null
}

export function realDate(v: unknown): v is string {
  // the year is checked as well: a date Postgres cannot store is not a real one
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '1900-01-01') return false
  const t = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v
}

const validBps = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max

/** Every problem in the draft; empty means it can go to review. */
export function draftProblems(d: Draft, c: DraftContext): Problem[] {
  const out: Problem[] = []
  const add = (section: Section, field: string, label: string, kind: Problem['kind'], message: string) => out.push({ section, field, label, kind, message })

  const text = (section: Section, field: string, label: string, v: unknown, required: boolean, max = TEXT_MAX) => {
    if (absent(v) || (typeof v === 'string' && !v.trim())) {
      if (required) add(section, field, label, 'missing', `${label} is required.`)
    } else if (typeof v !== 'string' || v.length > max) add(section, field, label, 'invalid', `${label} must be text of ${max} characters or fewer.`)
  }
  const choice = (section: Section, field: string, label: string, v: unknown, options: readonly string[], required: boolean) => {
    if (absent(v)) {
      if (required) add(section, field, label, 'missing', `${label} is required.`)
    } else if (typeof v !== 'string' || !options.includes(v)) add(section, field, label, 'invalid', `Choose a value from the list for ${label}.`)
  }
  const email = (section: Section, field: string, label: string, v: unknown) => {
    if (absent(v) || (typeof v === 'string' && !v.trim())) add(section, field, label, 'missing', `${label} is required.`)
    else if (typeof v !== 'string' || !isEmail(v)) add(section, field, label, 'invalid', `${label} must be an email address.`)
  }
  /** The value when it is valid, null otherwise (absent included). `rule` is the whole of what is checked, so the words match. */
  const amount = (section: Section, field: string, label: string, v: unknown, required: boolean, min: bigint, max: bigint, rule: string): bigint | null => {
    if (absent(v)) {
      if (required) add(section, field, label, 'missing', `${label} is required.`)
      return null
    }
    const n = readAmount(v)
    if (n === null || n < min || n > max) {
      add(section, field, label, 'invalid', `${label} must be ${rule}.`)
      return null
    }
    return n
  }

  // basics (R-DRF-01, R-SYN-01)
  const b = d.basics ?? {}
  choice('basics', 'structure', 'Legal structure', b.structure, c.enabledStructures, true)
  choice('basics', 'deal_type', 'Deal type', b.deal_type, ['primary'], true)
  text('basics', 'name', 'Deal name', b.name, true)
  const s = b.syndicate
  if (!s || absent(s.mode)) add('basics', 'syndicate', 'Syndicate', 'missing', 'Syndicate is required.')
  else if (s.mode === 'existing') {
    if (!s.id || !c.adminSyndicateIds.includes(s.id)) add('basics', 'syndicate', 'Syndicate', 'invalid', 'Choose a syndicate you manage.')
  } else if (s.mode === 'new') {
    text('basics', 'syndicate.name', 'Syndicate name', s.name, true)
    if (absent(s.lead_entity_id)) add('basics', 'syndicate.lead_entity_id', 'Lead entity', 'missing', 'Lead entity is required.')
    else if (!s.lead_entity_id || !c.ownedEntityIds.includes(s.lead_entity_id))
      add('basics', 'syndicate.lead_entity_id', 'Lead entity', 'invalid', 'Choose one of your own entities as the lead entity.')
  } else add('basics', 'syndicate', 'Syndicate', 'invalid', 'Choose a syndicate you manage, or create one.')

  // company (R-DRF-03)
  const co = d.company ?? {}
  text('company', 'legal_name', 'Legal name', co.legal_name, true)
  text('company', 'contact_name', 'Contact name', co.contact_name, true)
  email('company', 'contact_email', 'Contact email', co.contact_email)
  text('company', 'jurisdiction', 'Jurisdiction', co.jurisdiction, true)
  if (!absent(co.website) && safeHttpsUrl(co.website) === null)
    add('company', 'website', 'Website', 'invalid', 'Website must be a secure web address, starting with https.')
  text('company', 'registration_number', 'Registration number', co.registration_number, c.requiredCompanyFields.includes('registration_number'))
  text('company', 'address', 'Address', co.address, c.requiredCompanyFields.includes('address'), LONG_TEXT_MAX)

  // terms (R-DRF-04, R-DRF-05)
  const t = d.terms ?? {}
  choice('terms', 'currency', 'Currency', t.currency, CURRENCIES, true)
  choice('terms', 'round', 'Round', t.round, ROUNDS, false)
  choice('terms', 'instrument', 'Instrument', t.instrument, INSTRUMENTS, true)
  if (t.instrument === 'equity') {
    choice('terms', 'share_class', 'Share class', t.share_class, SHARE_CLASSES, false)
    const price = amount('terms', 'share_price_micros', 'Share price', t.share_price_micros, true, 1n, MAX_MINOR, `more than 0, and ${MOST}`)
    if (t.price_is_placeholder === true && price !== null && price !== PLACEHOLDER_PRICE_MICROS)
      add('terms', 'share_price_micros', 'Share price', 'invalid', 'A placeholder share price must be 1.00.')
    amount(
      'terms',
      'pre_money_minor',
      'Pre-money valuation',
      t.pre_money_minor,
      true,
      MIN_PRE_MONEY_MINOR,
      MAX_MINOR,
      `at least ${whole(MIN_PRE_MONEY_MINOR)}, and ${MOST}`,
    )
  } else if (t.instrument === 'cln' || t.instrument === 'safe' || t.instrument === 'asa') {
    choice('terms', 'cap_type', 'Valuation cap type', t.cap_type, CAP_TYPES, false)
    if (t.cap_type === 'pre_money' || t.cap_type === 'post_money')
      amount('terms', 'cap_minor', 'Valuation cap', t.cap_minor, true, 1n, MAX_MINOR, `more than 0, and ${MOST}`)
    if (!absent(t.discount_bps) && !validBps(t.discount_bps, 9_999)) add('terms', 'discount_bps', 'Discount', 'invalid', 'Discount must be from 0% to 99.99%.')
  } else if (t.instrument === 'fund_units') text('terms', 'fund_description', 'Fund description', t.fund_description, false, LONG_TEXT_MAX)

  amount('terms', 'round_size_minor', 'Total round size', t.round_size_minor, false, 1n, MAX_MINOR, `more than 0, and ${MOST}`)
  const dealLimit = `more than 0 and at most ${whole(MAX_DEAL_AMOUNT_MINOR)}`
  const allocation = amount('terms', 'allocation_minor', 'SPV allocation', t.allocation_minor, true, 1n, MAX_DEAL_AMOUNT_MINOR, dealLimit)
  choice('terms', 'over_allocation', 'When the allocation is full', t.over_allocation, OVER_ALLOCATION, false)

  const floor = c.minCommitmentFloorMinor
  const minCommitment = amount(
    'terms',
    'min_commitment_minor',
    'Minimum commitment',
    t.min_commitment_minor,
    false,
    floor,
    MAX_DEAL_AMOUNT_MINOR,
    `at least the operator minimum of ${whole(floor)} and at most ${whole(MAX_DEAL_AMOUNT_MINOR)}`,
  )
  const commitmentInvalid = !absent(t.min_commitment_minor) && minCommitment === null
  const effectiveMin = minCommitment ?? floor
  if (allocation !== null && !commitmentInvalid && effectiveMin > allocation)
    add(
      'terms',
      'min_commitment_minor',
      'Minimum commitment',
      'invalid',
      `The minimum commitment of ${whole(effectiveMin)} cannot be above the SPV allocation.`,
    )

  const minRaise = amount('terms', 'min_raise_minor', 'Minimum raise', t.min_raise_minor, false, 1n, MAX_DEAL_AMOUNT_MINOR, dealLimit)
  if (minRaise !== null && allocation !== null && minRaise > allocation)
    add('terms', 'min_raise_minor', 'Minimum raise', 'invalid', 'Minimum raise cannot be above the SPV allocation.')

  if (!absent(t.target_close) && !realDate(t.target_close))
    add('terms', 'target_close', 'Target close date', 'invalid', 'Target close date must be a real date.')
  if (!absent(t.pay_by) && (!realDate(t.pay_by) || t.pay_by <= c.today))
    add('terms', 'pay_by', 'Payment deadline', 'invalid', 'Payment deadline must be a real date after today.')
  choice('terms', 'voter', 'Default voter', t.voter, VOTERS, true)
  if (!absent(t.custom_terms) && !validRichText(t.custom_terms))
    add(
      'terms',
      'custom_terms',
      'Custom terms',
      'invalid',
      richTextTooLong(t.custom_terms) ? 'Custom terms are too long.' : 'Custom terms contain formatting that is not allowed.',
    )

  // files (R-DRF-07)
  const f = d.files ?? {}
  if (!absent(f.memo) && !validRichText(f.memo))
    add('files', 'memo', 'Memo', 'invalid', richTextTooLong(f.memo) ? 'Memo is too long.' : 'Memo contains formatting that is not allowed.')
  if (c.cleanLegalFiles < 1)
    add(
      'files',
      'legal_files',
      'Investment agreement and legal documents',
      'missing',
      'Upload at least one investment agreement or legal document, and let it finish scanning.',
    )
  const deck = f.deck
  if (deck?.kind === 'file') {
    if (!c.cleanDeckFile) add('files', 'deck', 'Pitch deck', 'invalid', 'Upload the pitch deck PDF and let it finish scanning, or remove it.')
  } else if (deck?.kind === 'link') {
    if (safeHttpsUrl(deck.url) === null)
      add('files', 'deck.url', 'Pitch deck link', 'invalid', 'Pitch deck link must be a secure web address, starting with https.')
    if (!absent(deck.embed_url)) {
      if (allowedEmbed(deck.embed_url, c.embedHosts) === null)
        add('files', 'deck.embed_url', 'Pitch deck embed address', 'invalid', 'Pitch deck embed address must be https:// on a site the operator allows.')
    }
  } else if (!absent(deck)) add('files', 'deck', 'Pitch deck', 'invalid', 'Choose a PDF or a link for the pitch deck.')

  // economics (R-DRF-08, R-DRF-09)
  const e = d.economics ?? {}
  const carry = e.default_carry_bps
  const carryValid = validBps(carry, 10_000)
  if (absent(carry)) add('economics', 'default_carry_bps', 'Default carry', 'missing', 'Default carry is required.')
  else if (!carryValid) add('economics', 'default_carry_bps', 'Default carry', 'invalid', 'Default carry must be from 0% to 100%.')
  const recipients = e.recipients ?? []
  if (recipients.length > MAX_CARRY_RECIPIENTS)
    add('economics', 'recipients', 'Carry recipients', 'invalid', `There can be at most ${MAX_CARRY_RECIPIENTS} carry recipients.`)
  if (carryValid && carry > 0 && recipients.length === 0) add('economics', 'recipients', 'Carry recipients', 'missing', 'Add who receives the carry.')
  let total = 0
  recipients.slice(0, MAX_CARRY_RECIPIENTS).forEach((r, i) => {
    const at = `recipients.${i}`
    const n = `Carry recipient ${i + 1}`
    if (r.kind === 'person') {
      text('economics', `${at}.first_name`, `${n} first name`, r.first_name, true)
      text('economics', `${at}.last_name`, `${n} last name`, r.last_name, true)
      email('economics', `${at}.email`, `${n} email`, r.email)
    } else if (r.kind === 'company') {
      text('economics', `${at}.trading_name`, `${n} trading name`, r.trading_name, true)
      text('economics', `${at}.legal_name`, `${n} legal name`, r.legal_name, true)
      text('economics', `${at}.registration_number`, `${n} registration number`, r.registration_number, true)
      text('economics', `${at}.contact_name`, `${n} contact name`, r.contact_name, true)
      email('economics', `${at}.contact_email`, `${n} contact email`, r.contact_email)
    } else add('economics', `${at}.kind`, `${n} type`, 'missing', `${n} must be a person or a company.`)
    if (!validBps(r.share_bps, 10_000) || r.share_bps === 0)
      add('economics', `${at}.share_bps`, `${n} share`, 'invalid', `${n} share must be more than 0% and at most 100%.`)
    else total += r.share_bps
  })
  const sharesAllValid = recipients.every((r) => validBps(r.share_bps, 10_000) && r.share_bps > 0)
  if (recipients.length > 0 && recipients.length <= MAX_CARRY_RECIPIENTS && sharesAllValid && total !== 10_000)
    add('economics', 'recipients', 'Carry recipient shares', 'invalid', 'Carry recipient shares must add up to exactly 100%.')

  choice('economics', 'fee_payer', 'Who pays the platform fee', e.fee_payer, FEE_PAYERS, true)
  if (e.fee_payer === 'investors' && allocation !== null) {
    let fee: bigint | null
    try {
      fee = platformFee(c.feeConfig, allocation)
    } catch {
      fee = null
    }
    if (fee === null || fee >= allocation)
      add(
        'economics',
        'fee_payer',
        'Who pays the platform fee',
        'invalid',
        'With investors paying, the platform fee would use up the whole SPV allocation, so this deal could never close. Raise the allocation or choose another payer.',
      )
  }

  // review (R-DRF-13)
  const a = d.attestations ?? {}
  if (a.board_and_shareholders !== true)
    add(
      'review',
      'board_and_shareholders',
      'Board and shareholder confirmation',
      'missing',
      'Confirm the deal has board and shareholder approval and that pre-emption rights are dealt with.',
    )
  if (t.instrument === 'fund_units' && a.fund_mainly_unlisted !== true)
    add('review', 'fund_mainly_unlisted', 'Fund investment confirmation', 'missing', 'Confirm the fund invests wholly or mainly in unlisted companies.')
  return out
}

/** A blank minimum as it was reviewed: the figure stored in the version. Every way of being blank counts as blank. */
export const withEffectiveMinimum = (d: Draft, minor: string | null | undefined): Draft =>
  minor ? { ...d, terms: { ...d.terms, min_commitment_minor: d.terms?.min_commitment_minor || minor } } : d

/** The words a blocked submit shows (dealState `gaps`). */
export const draftGaps = (p: readonly Problem[]): string[] => [...new Set(p.map((x) => x.label))]

/** Which sections are finished, for the ticks in the wizard (§4.6). */
export function sectionProgress(p: readonly Problem[]): Record<Section, boolean> {
  return Object.fromEntries(SECTIONS.map((s) => [s, !p.some((x) => x.section === s)])) as Record<Section, boolean>
}

export type NoticeCode = 'fee_estimate' | 'min_raise_helps' | 'external_deck' | 'placeholder_price' | 'tax_relief_not_judged' | 'voter_scope'

/** What the wizard must tell the lead. These never block. */
export function draftNotices(d: Draft): NoticeCode[] {
  const out: NoticeCode[] = []
  const t = d.terms ?? {}
  if (t.seis === true || t.eis === true) out.push('tax_relief_not_judged')
  if (!absent(t.voter)) out.push('voter_scope')
  if (t.instrument === 'equity' && t.price_is_placeholder === true) out.push('placeholder_price')
  if (d.files?.deck?.kind === 'link') out.push('external_deck')
  if (d.economics?.fee_payer === 'investors') {
    out.push('fee_estimate')
    if (absent(t.min_raise_minor)) out.push('min_raise_helps')
  }
  return out
}

/** R-DRF-12: software cannot tell whether custom terms add to an investor's liability, so the reviewer is shown them to read. */
export function reviewChecklist(d: Draft): { customTerms: string | null } {
  const words = validRichText(d.terms?.custom_terms) ? richTextPlain(d.terms?.custom_terms) : ''
  return { customTerms: words || null }
}

/**
 * R-PIP-05: a new draft copied from an earlier deal carries the structure, the syndicate, the instrument, the carry and its
 * recipients, who pays the platform fee, and the custom terms. Nothing else: no company, valuation, price, files or approvals
 * (and no name, currency, dates or limits, which the list does not name). A syndicate the earlier deal created is already
 * named by id once it was submitted (submit rewrites it as an existing one), so it is carried as it stands.
 */
export function copiedDraft(src: Draft): Draft {
  const out: Draft = {}
  const syndicate = src.basics?.syndicate
  if (src.basics?.structure !== undefined || syndicate !== undefined)
    out.basics = {
      ...(src.basics?.structure !== undefined ? { structure: src.basics.structure } : {}),
      ...(syndicate !== undefined ? { syndicate: structuredClone(syndicate) } : {}),
    }
  if (src.terms?.instrument !== undefined || src.terms?.custom_terms !== undefined)
    out.terms = {
      ...(src.terms?.instrument !== undefined ? { instrument: src.terms.instrument } : {}),
      ...(src.terms?.custom_terms !== undefined ? { custom_terms: structuredClone(src.terms.custom_terms) } : {}),
    }
  const e = src.economics
  if (e && (e.default_carry_bps !== undefined || e.recipients !== undefined || e.fee_payer !== undefined))
    out.economics = {
      ...(e.default_carry_bps !== undefined ? { default_carry_bps: e.default_carry_bps } : {}),
      ...(e.recipients !== undefined ? { recipients: structuredClone(e.recipients) } : {}),
      ...(e.fee_payer !== undefined ? { fee_payer: e.fee_payer } : {}),
    }
  return out
}
