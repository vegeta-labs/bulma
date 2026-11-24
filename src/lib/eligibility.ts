// Eligibility: the statement, the assessment, cooling-off and the order of steps (PRD R-ELG-*). Pure, with a fixed clock
// passed in. Only rules live here; every word shown to a person comes from the pack.
import { z } from 'zod'
import { minorToPounds } from './pounds.ts'
import { hasDefaultWording, promptKey, thresholds, type RegimePack, type StepKind } from './regimePack.ts'

const yesNoText = z.discriminatedUnion('yes', [
  z.strictObject({ yes: z.literal(false) }),
  z.strictObject({ yes: z.literal(true), name: z.string().trim().min(1).max(200) }),
])

const amount = z.string().regex(/^\d{1,15}$/)

export const statementAnswers = z.strictObject({
  category: z.enum(['high_net_worth', 'sophisticated', 'neither']),
  high_net_worth: z.strictObject({
    income: z.discriminatedUnion('yes', [z.strictObject({ yes: z.literal(false) }), z.strictObject({ yes: z.literal(true), amount_minor: amount })]),
    net_assets: z.discriminatedUnion('yes', [z.strictObject({ yes: z.literal(false) }), z.strictObject({ yes: z.literal(true), amount_minor: amount })]),
  }).optional(),
  sophisticated: z.strictObject({
    worked_in_private_finance: yesNoText,
    director: z.discriminatedUnion('yes', [
      z.strictObject({ yes: z.literal(false) }),
      z.strictObject({ yes: z.literal(true), name: z.string().trim().min(1).max(200), company_number: z.string().trim().max(32).optional() }),
    ]),
    unlisted_investments: z.discriminatedUnion('yes', [z.strictObject({ yes: z.literal(false) }), z.strictObject({ yes: z.literal(true), count: z.number().int().min(0).max(100000) })]),
    network_member: z.discriminatedUnion('yes', [
      z.strictObject({ yes: z.literal(false) }),
      z.strictObject({ yes: z.literal(true), name: z.string().trim().min(1).max(200), months: z.number().int().min(0).max(1200), still_member: z.boolean().optional() }),
    ]),
  }).optional(),
})
export type StatementAnswers = z.infer<typeof statementAnswers>

export type StatementResult = { qualifies: boolean; problems: string[] }

/**
 * R-ELG-02, R-ELG-04. `problems` holds only format errors, which the person corrects and nothing is kept. An answer that does
 * not meet the test has no problem listed: it is signed as not qualifying, so no message can suggest which answer to change.
 * A "yes" that fails, or any other part failing, fails the whole statement.
 */
export function judgeStatement(p: Pick<RegimePack, 'thresholds' | 'regime'>, a: StatementAnswers): StatementResult {
  const problems: string[] = []
  if (a.category === 'neither') return { qualifies: false, problems }
  let meets = true
  const t = thresholds(p)
  if (a.category === 'high_net_worth') {
    const h = a.high_net_worth
    if (!h) return { qualifies: false, problems: ['Answer each question.'] }
    if (!h.income.yes && !h.net_assets.yes) return { qualifies: false, problems }
    if (h.income.yes) {
      const v = BigInt(h.income.amount_minor)
      // a figure exactly at the threshold is always fine: £250,000 is no multiple of £100,000, yet it must not be refused
      if (v % t.incomeRounding !== 0n && v !== t.incomeMinor) problems.push(`Give income to the nearest ${minorToPounds(t.incomeRounding)}.`)
      if (v < t.incomeMinor) meets = false
    }
    if (h.net_assets.yes) {
      const v = BigInt(h.net_assets.amount_minor)
      if (v % t.assetsRounding !== 0n && v !== t.netAssetsMinor) problems.push(`Give net assets to the nearest ${minorToPounds(t.assetsRounding)}.`)
      if (v < t.netAssetsMinor) meets = false
    }
    return { qualifies: problems.length === 0 && meets, problems }
  }
  const s = a.sophisticated
  if (!s) return { qualifies: false, problems: ['Answer each question.'] }
  const yeses = [s.worked_in_private_finance, s.director, s.unlisted_investments, s.network_member].filter((x) => x.yes)
  if (!yeses.length) return { qualifies: false, problems }
  if (s.director.yes && p.regime === 'uk-fpo' && !s.director.company_number) problems.push('Give the company number.')
  // two investments in the same company count as two; the count is of investments, not companies
  if (s.unlisted_investments.yes && s.unlisted_investments.count < t.minInvestments) meets = false
  if (s.network_member.yes) {
    if (s.network_member.months <= t.networkMonthsOver) meets = false
    // left out is a form to correct (R-ELG-04); a No is an answer, signed and kept
    if (p.regime === 'uk-fpo' && s.network_member.still_member === undefined) problems.push('Answer each question.')
    if (p.regime === 'uk-fpo' && !s.network_member.still_member) meets = false
  }
  return { qualifies: problems.length === 0 && meets, problems }
}

/** Twelve calendar months on; the 31st falls back to the end of a shorter month. */
export function statementExpiry(signedAt: Date): Date {
  const d = new Date(signedAt.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCFullYear(d.getUTCFullYear() + 1)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d
}

export interface AttemptFact {
  questions: readonly string[]
  passed: boolean | null // null: asked, not answered
  lockedUntil: Date | null
}

export const LOCK_HOURS = 24

/** R-ELG-05: half the bank rounded down, at least one; a retake is always a wholly new set. A question is its wording (promptKey),
 * not its id: `lastAsked` is the wording of the questions asked in the latest attempt, read from the version they were asked
 * from, so a question re-filed under a new id is still asked and a new question under an old id is new.
 * No set (null) when the bank is not askable (bankAskable) or, after a switch to
 * another version of the same regime, when it holds too few questions not asked last time: never a repeat. */
/** R-ELG-05: a bank stored before the pack check refused it may hold one wording twice or a prompt with nothing to read; no new
 * set is asked from it. An attempt already issued from it is handed out and marked as any other (Codex group B r5 #1). */
export function bankAskable(p: Pick<RegimePack, 'assessment'>): boolean {
  const keys = p.assessment.questions.map((q) => promptKey(q.prompt))
  return new Set(keys).size === keys.length && keys.every((k) => k !== '')
}

export function pickQuestions(p: Pick<RegimePack, 'assessment'>, lastAsked: readonly string[], random: (n: number) => number): string[] | null {
  const bank = p.assessment.questions
  if (!bankAskable(p)) return null
  const size = Math.max(1, Math.floor(bank.length / 2))
  const asked = new Set(lastAsked.map(promptKey))
  const fresh = bank.filter((q) => !asked.has(promptKey(q.prompt))).map((q) => q.id)
  if (fresh.length < size) return null
  const left = [...fresh]
  const out: string[] = []
  while (out.length < size && left.length) out.push(left.splice(random(left.length), 1)[0]!)
  return out
}

/** All correct passes (this product's rule). The answer says only pass or fail, never which question. */
export function markAssessment(p: Pick<RegimePack, 'assessment'>, asked: readonly string[], answers: Readonly<Record<string, number>>): boolean {
  return asked.every((id) => {
    const q = p.assessment.questions.find((x) => x.id === id)
    return !!q && Object.hasOwn(answers, id) && answers[id] === q.correct_option
  })
}

/** COBS 4.12A.32R: the second failure and every one after it locks for at least 24 hours; a pass in between resets nothing. */
export function lockAfterFailure(failuresIncludingThis: number, now: Date): Date | null {
  return failuresIncludingThis >= 2 ? new Date(now.getTime() + LOCK_HOURS * 3_600_000) : null
}

/** R-ELG-05: a pack's limit on failures, reached for good. A lock only says when; this says never. */
export const attemptsUsedUp = (p: Pick<RegimePack, 'assessment'>, attempts: readonly AttemptFact[]) =>
  p.assessment.max_attempts !== null && attempts.filter((a) => a.passed === false).length >= p.assessment.max_attempts

export const lockedUntil = (attempts: readonly AttemptFact[], now: Date): Date | null => {
  const until = attempts.map((a) => a.lockedUntil).filter((d): d is Date => !!d && d > now).sort((a, b) => b.getTime() - a.getTime())[0]
  return until ?? null
}

export interface EligibilityFacts {
  statement: { qualifies: boolean; expiresAt: Date; category: string; reopened: boolean } | null
  needsReconfirm: boolean
  attempts: readonly AttemptFact[]
  coolingOff: { startedAt: Date; endsAt: Date; decision: 'continue' | 'leave' | null } | null
  fullName: string | null
  personalisedWarning: 'continue' | 'leave' | null
  warningBlockAcked: boolean
}

/**
 * R-ELG-04, decision R12: a signed statement that does not qualify stands for its twelve months, unless a reviewer reopens it
 * with a recorded reason. After that the person may sign again; nothing prompts them to.
 */
export const statementClosed = (f: Pick<EligibilityFacts, 'statement'>, now: Date) => !!f.statement && !f.statement.qualifies && f.statement.expiresAt > now && !f.statement.reopened

const passedAssessment = (f: EligibilityFacts) => f.attempts.some((a) => a.passed === true)
const statementGood = (f: EligibilityFacts, now: Date) => !!f.statement?.qualifies && f.statement.expiresAt > now && !f.needsReconfirm

export function stepDone(kind: StepKind, f: EligibilityFacts, now: Date): boolean {
  switch (kind) {
    case 'request_access':
    case 'cooling_off_start':
      return !!f.coolingOff
    case 'capture_full_name':
      return !!f.fullName
    case 'personalised_warning':
      return f.personalisedWarning === 'continue'
    case 'classification':
    case 'statement':
      return statementGood(f, now)
    case 'assessment':
      return passedAssessment(f)
    case 'cooling_off_decision':
      return f.coolingOff?.decision === 'continue'
    case 'warning_block':
      return f.warningBlockAcked
    default:
      return false
  }
}

const ELIGIBILITY_STEPS = (p: Pick<RegimePack, 'steps'>): StepKind[] => {
  const at = p.steps.findIndex((s) => s.kind === 'view_deal')
  return p.steps.slice(0, at).map((s) => s.kind)
}

/** Steps run strictly in the pack's order, so nothing can be done before the one ahead of it (R-ELG-06). */
export function nextEligibilityStep(p: Pick<RegimePack, 'steps'>, f: EligibilityFacts, now: Date): StepKind | null {
  return ELIGIBILITY_STEPS(p).find((k) => !stepDone(k, f, now)) ?? null
}

export const stepOpen = (p: Pick<RegimePack, 'steps'>, kind: StepKind, f: EligibilityFacts, now: Date) =>
  nextEligibilityStep(p, f, now) === kind && !((kind === 'statement' || kind === 'classification') && statementClosed(f, now))

/** §5.5: the FPO warning goes by the category signed for; every other pack has one wording. */
export const warningVariant = (p: Pick<RegimePack, 'regime'>, category: string | undefined) => (p.regime === 'uk-fpo' && category ? category : 'default')

/** tech design §4: shared by every deal gate from D3. Fails closed: a pack with no eligibility steps qualifies no one. */
export function isQualified(p: Pick<RegimePack, 'steps'>, f: EligibilityFacts, now: Date): boolean {
  const steps = ELIGIBILITY_STEPS(p)
  return steps.length > 0 && steps.every((k) => stepDone(k, f, now))
}

/** R-ELG-06: the choice opens only when the full period has passed. */
/** R-ELG-06: once per person, but only a wait as long as the active pack asks counts; a shorter one under another pack starts again. */
export const coolingOffCounts = (c: { startedAt: Date; endsAt: Date }, hours: number) => c.endsAt.getTime() - c.startedAt.getTime() >= hours * 3_600_000

export const coolingOffOver = (c: { endsAt: Date }, now: Date) => now >= c.endsAt

export interface Preparation {
  steps: number
  coolingOffHours: number | null
  textKey: string
  overviewKey: string
  minutes: Partial<Record<StepKind, number>>
  reviewDays: number
}

/** R-ELG-08: what to prepare and how long. Holds no deal content. */
export function preparation(p: RegimePack, entityType: 'individual' | 'company'): Preparation {
  const textKey = entityType === 'individual' ? p.preparation.individual_text_key : p.preparation.company_text_key
  if (!hasDefaultWording(p, textKey)) throw new Error('pack without preparation text')
  return { steps: p.steps.length, coolingOffHours: p.cooling_off.enabled ? p.cooling_off.hours : null, textKey, overviewKey: 'preparation_overview', minutes: p.preparation.step_minutes, reviewDays: p.preparation.review_days }
}
