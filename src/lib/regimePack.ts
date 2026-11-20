// Regime packs (PRD R-OP-04, R-OP-04.1, R-OP-04.2; tech design T8). Pure: parsing and the machine-checked invariants.
// A pack passing here has a valid format. It says nothing about whether the pack is compliant.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CONTENT_ITEMS } from './change.ts'
import { textParts } from './legalText.ts'

export const STEP_KINDS = [
  'request_access', 'cooling_off_start', 'capture_full_name', 'personalised_warning', 'classification', 'assessment', 'cooling_off_decision',
  'statement', 'warning_block', 'view_deal', 'commit', 'kyc', 'sign', 'payment_instructions',
] as const
export type StepKind = (typeof STEP_KINDS)[number]

const text = z.string().trim().min(1)
const amount = z.string().regex(/^\d{1,18}$/)
const positiveAmount = z.string().regex(/^0*[1-9]\d{0,17}$/)

const legalText = z.strictObject({
  text_key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  variant: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).default('default'),
  version: z.number().int().positive().max(2147483647),
  format: z.enum(['plain', 'bold_markup']),
  body: z.string().min(1).max(100_000),
  required_bold: z.array(text).max(100).default([]),
  is_placeholder: z.boolean(),
})

const question = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  prompt: text,
  options: z.array(text).min(3).max(10),
  correct_option: z.number().int().nonnegative(),
  is_placeholder: z.boolean(),
})

export const packSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  version: z.number().int().positive().max(2147483647),
  regime: z.enum(['uk-fpo', 'uk-cobs']),
  // R-OP-04: whose understanding this is, as of when, that no lawyer reviewed it, and the known open questions
  author_note: z.strictObject({
    as_of: z.iso.date(),
    no_lawyer_review: z.literal(true),
    text: text,
    known_open_questions: z.array(text).min(1),
  }),
  steps: z.array(z.strictObject({ kind: z.enum(STEP_KINDS), qualifying: z.boolean().default(false) })).min(1).max(30),
  promotion_surfaces: z.array(z.strictObject({ surface: z.string().regex(/^[a-z_]{1,64}$/), warning_text_key: z.string() })).min(1),
  terminal_can_see_promotion: z.boolean(),
  sender: z.strictObject({ name_text_key: z.string() }),
  thresholds: z.strictObject({ hnw_income_minor: amount, hnw_net_assets_minor: amount, income_rounding_minor: positiveAmount, assets_rounding_minor: positiveAmount, min_unlisted_investments: z.number().int().positive().max(1000), network_months_over: z.number().int().nonnegative().max(1200), ubo_over_bps: z.number().int().min(0).max(10000) }),
  assessment: z.strictObject({ enabled: z.boolean(), questions: z.array(question).max(200), max_attempts: z.number().int().positive().nullable().default(null) }),
  cooling_off: z.strictObject({ enabled: z.boolean(), hours: z.number().int().nonnegative().max(8760) }),
  // R-ELG-08: what to prepare and how long, shown before anything else. Operator's numbers, written as estimates.
  preparation: z.strictObject({
    individual_text_key: z.string(),
    company_text_key: z.string(),
    step_minutes: z.partialRecord(z.enum(STEP_KINDS), z.number().int().min(0).max(100000)),
    review_days: z.number().int().min(0).max(365),
  }),
  biometric_consent_text_key: z.string(),
  incentive_attestation_required: z.boolean(),
  // R-CHG-02: content items this pack always reconfirms; a name the code does not know would silently do nothing, so it is refused
  must_reconfirm_extra: z.array(z.enum(CONTENT_ITEMS)).max(100),
  policy_defaults: z.strictObject({ per_link_terms: z.boolean(), generic_links: z.boolean(), bulk_promo: z.boolean() }),
  legal_texts: z.array(legalText).min(1).max(500),
})
export type RegimePack = z.infer<typeof packSchema>

// Steps each regime must gate on, and surfaces every pack must warn on. These are rules, so they live in code; the words
// are the operator's data (T8). Otherwise a pack could pass by marking nothing as qualifying.
const REQUIRED_QUALIFYING: Record<RegimePack['regime'], readonly StepKind[]> = {
  'uk-fpo': ['statement', 'warning_block'],
  'uk-cobs': ['personalised_warning', 'classification', 'assessment', 'cooling_off_decision'],
}
// PRD §5.5's list. Company updates are left out: there the pack decides whether a warning is needed.
const REQUIRED_SURFACES = ['deal_page', 'memorandum', 'embedded_deck', 'document_download', 'deal_sheet', 'payment_instructions_page', 'payment_instructions_pdf', 'promotional_email', 'investor_preview']
// the wording people read at each outcome is the operator's too (R-ELG-02.2, R-ELG-04, R-ELG-05, R-ELG-08)
// R-PIP-06: the operator's own words on whom a lead may invite, confirmed by each lead per version before a list or an invitation
export const INVITEE_POLICY_KEY = 'invitee_policy'
const REQUIRED_NOTICES = ['party_guidance', 'not_qualified_notice', 'assessment_not_passed', 'assessment_unavailable', 'assessment_retake_notice', 'preparation_overview', 'unsupported_categories', INVITEE_POLICY_KEY]
// R-ELG-02: what a person answers yes or no to is part of what they sign, and the two regimes differ
const REQUIRED_QUESTIONS = ['question_income', 'question_net_assets', 'question_private_finance', 'question_director', 'question_unlisted_investments', 'question_network']
export const statementQuestionKeys = (p: Pick<RegimePack, 'regime'>) => [...REQUIRED_QUESTIONS, ...(p.regime === 'uk-fpo' ? ['question_company_number', 'question_still_member'] : [])]
const REQUIRED_TEXTS: Record<RegimePack['regime'], readonly string[]> = {
  'uk-fpo': ['promotion_warning', 'commitment_effect', 'company_route_note', ...REQUIRED_NOTICES, ...statementQuestionKeys({ regime: 'uk-fpo' })],
  'uk-cobs': ['promotion_warning', 'commitment_effect', 'personalised_warning', 'risk_summary', 'cooling_off_note', ...REQUIRED_NOTICES, ...statementQuestionKeys({ regime: 'uk-cobs' })],
}
const STATEMENT_TEXTS = ['statement_high_net_worth', 'statement_sophisticated']

const position = (p: RegimePack, kind: StepKind) => p.steps.findIndex((s) => s.kind === kind)
const before = (p: RegimePack, a: StepKind, b: StepKind) => position(p, a) >= 0 && position(p, b) >= 0 && position(p, a) < position(p, b)

/** Bold phrases are written **like this** in `bold_markup` bodies. */
const isBold = (body: string, phrase: string) => textParts(body).some((p) => p.bold && p.text === phrase)

/** A text under some other variant could never be shown where no recipient category chooses between them. */
export const hasDefaultWording = (p: Pick<RegimePack, 'legal_texts'>, key: string) => p.legal_texts.some((t) => t.text_key === key && t.variant === 'default')

/** The eight invariants of R-OP-04.1. Rules follow `regime`, never `key`, so renaming a pack does not escape them. */
export function invariantViolations(p: RegimePack): string[] {
  const out: string[] = []
  // (a) every qualifying step before the deal can be seen, and the regime's own steps really qualify
  const viewAt = position(p, 'view_deal')
  if (viewAt < 0) out.push('a: the pack has no view_deal step')
  p.steps.forEach((s, i) => {
    if (s.qualifying && viewAt >= 0 && i >= viewAt) out.push(`a: qualifying step ${s.kind} must come before view_deal`)
  })
  const qualifies = (kind: StepKind) => p.steps.some((s) => s.kind === kind && s.qualifying)
  for (const kind of REQUIRED_QUALIFYING[p.regime]) if (!qualifies(kind)) out.push(`a: ${kind} must be a qualifying step for ${p.regime}`)
  if (p.assessment.enabled && !qualifies('assessment')) out.push('a: the assessment is on, so it must be a qualifying step')
  if (!p.assessment.enabled && position(p, 'assessment') >= 0) out.push('a: the assessment is off but still a step')
  // FPO's warning is worded for the category signed for, so there is nothing to show before the statement
  if (p.regime === 'uk-fpo' && !before(p, 'statement', 'warning_block')) out.push('a: the statement must come before the warning under uk-fpo')
  // (b) every promotion surface has a warning text that exists and is a warning
  // one warning key, the one whose variants are checked below; a surface pointing elsewhere would escape that check
  for (const s of p.promotion_surfaces) if (s.warning_text_key !== 'promotion_warning') out.push(`b: surface ${s.surface} must use promotion_warning`)
  for (const surface of REQUIRED_SURFACES) if (!p.promotion_surfaces.some((s) => s.surface === surface)) out.push(`b: ${surface} is not listed as a promotion surface`)
  // a text under some other variant could never be shown: with no category to choose by, the default is what is read.
  // The FPO warning alone goes by the recipient's category, checked below.
  const reachable = (key: string) => hasDefaultWording(p, key)
  for (const key of REQUIRED_TEXTS[p.regime]) {
    if (p.regime === 'uk-fpo' && key === 'promotion_warning') continue
    if (!reachable(key)) out.push(`b: ${p.regime} needs the text ${key}`)
  }
  if (!reachable(p.sender.name_text_key)) out.push('the sender text has no default wording')
  for (const key of [p.preparation.individual_text_key, p.preparation.company_text_key, p.biometric_consent_text_key]) if (!reachable(key)) out.push(`the pack has no text ${key}`)
  if (p.incentive_attestation_required && !reachable('incentive_attestation')) out.push('the incentive attestation is on but has no text')
  // §5.5: the FPO wording depends on the recipient's declared category, so a pack holds both
  if (p.regime === 'uk-fpo') {
    for (const variant of ['high_net_worth', 'sophisticated']) {
      if (!p.legal_texts.some((t) => t.text_key === 'promotion_warning' && t.variant === variant)) out.push(`b: uk-fpo needs promotion_warning for ${variant}`)
    }
  }
  // (c) KYC passed and signed before payment instructions
  for (const k of ['kyc', 'sign'] as const) if (!before(p, k, 'payment_instructions')) out.push(`c: ${k} must come before payment_instructions`)
  // (d) a terminal participation sees no promotion
  if (p.terminal_can_see_promotion) out.push('d: a terminal status must not see promotion')
  if (p.regime === 'uk-cobs') {
    // (e) assessment on, and before the deal
    if (!p.assessment.enabled) out.push('e: uk-cobs needs the assessment')
    if (!before(p, 'assessment', 'view_deal')) out.push('e: uk-cobs assessment must come before view_deal')
    // (f) cooling-off on, at least 24 hours (R-ELG-06)
    if (!p.cooling_off.enabled || p.cooling_off.hours < 24) out.push('f: uk-cobs needs a cooling-off period of at least 24 hours')
    if (!before(p, 'cooling_off_start', 'personalised_warning')) out.push('f: uk-cobs cooling-off must start before the personalised warning')
    for (const k of ['classification', 'assessment'] as const) if (!before(p, k, 'cooling_off_decision')) out.push(`f: uk-cobs decision after cooling-off must come after ${k}`)
    // (g) personalised warning before classification and assessment
    for (const k of ['classification', 'assessment'] as const) {
      if (!before(p, 'personalised_warning', k)) out.push(`g: uk-cobs personalised warning must come before ${k}`)
    }
    // a `statement` step records the same fact as classification, so it must not come first either
    if (position(p, 'statement') >= 0 && !before(p, 'personalised_warning', 'statement')) out.push('g: uk-cobs personalised warning must come before statement')
    // R-ELG-06: the name comes first, and the warning really carries it
    if (!before(p, 'capture_full_name', 'personalised_warning')) out.push('g: uk-cobs needs the full name before the personalised warning')
    for (const t of p.legal_texts) if (t.text_key === 'personalised_warning' && !t.body.includes('{full_name}')) out.push('g: the personalised warning must contain {full_name}')
  }
  // (h) required bold phrases still there and still bold. The phrases themselves are legal wording, so the pack lists them;
  // the code can only insist each statement lists at least one. Whether they are the right ones is for the operator's lawyers.
  for (const key of STATEMENT_TEXTS) {
    const variants = p.legal_texts.filter((x) => x.text_key === key)
    if (!reachable(key)) out.push(`h: the pack has no ${key}`)
    for (const t of variants) if (t.required_bold.length === 0) out.push(`h: ${key}/${t.variant} lists no required bold phrase`)
  }
  for (const t of p.legal_texts) {
    for (const phrase of t.required_bold) {
      if (t.format !== 'bold_markup' || !isBold(t.body, phrase)) out.push(`h: ${t.text_key} lost the required bold phrase "${phrase}"`)
    }
  }
  return out
}

const MIN_QUESTIONS = 4

export interface PackIssues { ok: boolean; errors: string[] }

/** Consistency checks the schema cannot express. */
function structuralErrors(p: RegimePack): string[] {
  const out: string[] = []
  if (p.key.includes('cobs') && p.regime !== 'uk-cobs') out.push('a pack named cobs must have the uk-cobs regime')
  if (p.key.includes('fpo') && p.regime !== 'uk-fpo') out.push('a pack named fpo must have the uk-fpo regime')
  for (const t of p.legal_texts) if (!t.body.trim()) out.push(`legal text ${t.text_key} is blank`)
  const ids = p.legal_texts.map((t) => `${t.text_key}/${t.variant}`)
  if (new Set(ids).size !== ids.length) out.push('legal text appears twice for one key and variant')
  const stepKinds = p.steps.map((s) => s.kind)
  if (new Set(stepKinds).size !== stepKinds.length) out.push('a step kind appears twice')
  for (const q of p.assessment.questions) if (q.correct_option >= q.options.length) out.push(`question ${q.id} points at an option that does not exist`)
  if (new Set(p.assessment.questions.map((q) => q.id)).size !== p.assessment.questions.length) out.push('a question id appears twice')
  if (p.assessment.enabled && p.assessment.questions.length === 0) out.push('the assessment is on but has no questions')
  // R-ELG-05: half the bank is asked. Fewer than four means one question at a time, and a failure then says which was wrong
  else if (p.assessment.enabled && p.assessment.questions.length < MIN_QUESTIONS) out.push(`the assessment needs at least ${MIN_QUESTIONS} questions, so an attempt asks two or more and a retake is a different set`)
  return out
}

/** Parse untrusted JSON into a pack, or list every reason it cannot load. */
export function parsePack(input: unknown): { pack: RegimePack; errors: [] } | { pack: null; errors: string[] } {
  const r = packSchema.safeParse(input)
  if (!r.success) return { pack: null, errors: r.error.issues.map((i) => `${i.path.join('.') || 'pack'}: ${i.message}`) }
  const errors = [...structuralErrors(r.data), ...invariantViolations(r.data)]
  return errors.length ? { pack: null, errors } : { pack: r.data, errors: [] }
}

// The words every shipped placeholder carries. The pack's own flag is not enough: flipping it must not reach the real mode.
const PLACEHOLDER_WORDS = /not legal text|placeholder option/i
const isPlaceholder = (flag: boolean, ...texts: string[]) => flag || texts.some((x) => !x.trim() || PLACEHOLDER_WORDS.test(x))
/** One legal text still holding a placeholder, judged as `placeholderTexts` judges it. */
export const textIsPlaceholder = (t: Pick<RegimePack['legal_texts'][number], 'is_placeholder' | 'body'>) => isPlaceholder(t.is_placeholder, t.body)

/**
 * Legal texts and questions still holding a placeholder; R-OP-02 refuses the switch while any remain. Judged from the
 * content as well as the flag. Friction only: the software cannot tell whether replacement text is any good.
 */
export const placeholderTexts = (p: Pick<RegimePack, 'legal_texts' | 'assessment'>) => [
  ...p.legal_texts.filter(textIsPlaceholder).map((t) => t.text_key),
  ...p.assessment.questions.filter((q) => isPlaceholder(q.is_placeholder, q.prompt, ...q.options)).map((q) => `question:${q.id}`),
]

/** Puts values into `{name}` slots of a pack's wording, on the server, so what is hashed is what was shown. */
export const fillText = (body: string, values: Readonly<Record<string, string>>) => body.replace(/\{([a-z_]+)\}/g, (slot, key: string) => (Object.hasOwn(values, key) ? values[key]! : slot))

export const textSha256 = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex')

/** Eligibility thresholds come from the pack, never from code (R-OP-04). */
export const thresholds = (p: Pick<RegimePack, 'thresholds'>) => ({
  incomeMinor: BigInt(p.thresholds.hnw_income_minor),
  netAssetsMinor: BigInt(p.thresholds.hnw_net_assets_minor),
  incomeRounding: BigInt(p.thresholds.income_rounding_minor),
  assetsRounding: BigInt(p.thresholds.assets_rounding_minor),
  minInvestments: p.thresholds.min_unlisted_investments,
  networkMonthsOver: p.thresholds.network_months_over,
  uboOverBps: p.thresholds.ubo_over_bps,
})

/** R-OP-04.2: a deal keeps the pack version bound when it went live; only a deal not yet live follows the instance. */
export function effectivePackId(deal: { boundPackId: string | null }, instance: { activePackId: string }): string {
  return deal.boundPackId ?? instance.activePackId
}
