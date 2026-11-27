import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { auditHash, GENESIS, verifyChain, type AuditRecord } from './auditChain.ts'
import { feeConfigErrors, MAX_MINOR, mulDiv, mulDivHalfUp, platformFee, type FeeConfig } from './fees.ts'
import { GATES, isGateName } from './gate.ts'
import { DEMO_PACK_TEXTS, demoPackContent, sameDemoSide, statementSide } from './demo.ts'
import { decideAccept } from './invite.ts'
import { approvalRefusal, hasDistinctAdminsAndReviewer, isSingleAdminException, roleChangeRefusal, sandboxPaymentInstruction, switchBlockers, type Staff, type SwitchFacts } from './instance.ts'
import { effectivePackId, invariantViolations, parsePack, placeholderTexts, thresholds, type RegimePack } from './regimePack.ts'

const POUND = 100n
const CONFIG: FeeConfig = { rate_bps: 250, min_minor: 4000n * POUND, max_minor: 20000n * POUND, surcharge_threshold_minor: 5000000n * POUND, surcharge_bps: 10 }
const ZERO: FeeConfig = { rate_bps: 0, min_minor: 0n, max_minor: 0n, surcharge_threshold_minor: 0n, surcharge_bps: 0 }

describe('fees', () => {
  it('TC-FEE-10 config: minimum above maximum refused; all zero is fee 0; rate 0 with a minimum charges the minimum', () => {
    expect(feeConfigErrors({ ...ZERO, min_minor: 2n, max_minor: 1n })).toContain('the minimum fee must not be above the maximum fee')
    expect(feeConfigErrors(ZERO)).toEqual([])
    expect(platformFee(ZERO, 100000n * POUND)).toBe(0n)
    expect(platformFee({ ...ZERO, min_minor: 4000n * POUND, max_minor: 20000n * POUND }, 100000n * POUND)).toBe(4000n * POUND)
    expect(feeConfigErrors({ ...ZERO, min_minor: 5n, max_minor: 5n })).toEqual([])
  })
  it('TC-FEE-10 decision R11: a maximum of 0 caps the fee at 0, not uncapped; a surcharge threshold of 0 charges from the first penny', () => {
    expect(platformFee({ ...ZERO, rate_bps: 250 }, 100000n * POUND)).toBe(0n)
    // 2.5% of £100,000 = £2,500, plus 0.1% of the whole £100,000 = £100
    expect(platformFee({ ...ZERO, rate_bps: 250, max_minor: 20000n * POUND, surcharge_bps: 10 }, 100000n * POUND)).toBe(2600n * POUND)
    // £10 at 0.1% is 1p: the first penny above a 0 threshold counts, and a 0 maximum does not cap the surcharge
    expect(platformFee({ ...ZERO, surcharge_bps: 10 }, 1000n)).toBe(1n)
  })
  it('TC-FEE-09 C-FEE-2 worked examples', () => {
    expect(platformFee(CONFIG, 100000n * POUND)).toBe(4000n * POUND)
    expect(platformFee(CONFIG, 500000n * POUND)).toBe(12500n * POUND)
    expect(platformFee(CONFIG, 1000000n * POUND)).toBe(20000n * POUND)
    expect(platformFee(CONFIG, 6000000n * POUND)).toBe(21000n * POUND)
  })
  it('TC-FEE-10 hostile config values are refused', () => {
    for (const rate_bps of [-1, 10001, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(feeConfigErrors({ ...ZERO, rate_bps }).length).toBeGreaterThan(0)
    for (const surcharge_bps of [-1, 10001, 0.5]) expect(feeConfigErrors({ ...ZERO, surcharge_bps }).length).toBeGreaterThan(0)
    expect(feeConfigErrors({ ...ZERO, rate_bps: 10000 })).toEqual([])
    expect(feeConfigErrors({ ...ZERO, surcharge_bps: 10000 })).toEqual([])
    expect(feeConfigErrors({ ...ZERO, min_minor: -1n }).length).toBeGreaterThan(0)
    expect(feeConfigErrors({ ...ZERO, surcharge_threshold_minor: -1n }).length).toBeGreaterThan(0)
    expect(feeConfigErrors({ ...ZERO, max_minor: MAX_MINOR + 1n }).length).toBeGreaterThan(0)
    expect(feeConfigErrors({ ...ZERO, max_minor: MAX_MINOR })).toEqual([])
    expect(() => platformFee({ ...ZERO, min_minor: 2n, max_minor: 1n }, 1n)).toThrow(RangeError)
    expect(() => platformFee(ZERO, -1n)).toThrow(RangeError)
    expect(() => platformFee({ ...ZERO, max_minor: MAX_MINOR }, MAX_MINOR + 1n)).toThrow(/too large/)
    expect(() => platformFee({ rate_bps: 10000, min_minor: 0n, max_minor: MAX_MINOR, surcharge_threshold_minor: 0n, surcharge_bps: 10000 }, MAX_MINOR)).toThrow(/too large to store/)
    expect(platformFee({ rate_bps: 10000, min_minor: 0n, max_minor: MAX_MINOR, surcharge_threshold_minor: 0n, surcharge_bps: 0 }, MAX_MINOR)).toBe(MAX_MINOR)
  })
  it('TC-FEE-09 rounding: exact half goes up in each part; base at the threshold has no surcharge', () => {
    const open: FeeConfig = { ...ZERO, rate_bps: 250, max_minor: MAX_MINOR }
    expect(platformFee(open, 100n)).toBe(3n) // 2.5
    expect(platformFee(open, 99n)).toBe(2n) // 2.475
    expect(platformFee({ ...open, rate_bps: 0, surcharge_bps: 10, surcharge_threshold_minor: 0n }, 500n)).toBe(1n) // 0.5
    expect(platformFee({ ...open, rate_bps: 250, surcharge_bps: 10 }, 500n)).toBe(14n) // 12.5 → 13 and 0.5 → 1, rounded apart
    expect(platformFee({ ...open, rate_bps: 0, surcharge_bps: 10000, surcharge_threshold_minor: 100n }, 100n)).toBe(0n)
    expect(platformFee({ ...open, rate_bps: 0, surcharge_bps: 10000, surcharge_threshold_minor: 100n }, 101n)).toBe(1n)
  })
  it('mulDiv works beyond 2^53 and rejects bad inputs', () => {
    expect(mulDiv(10n ** 18n, 10n ** 18n, 10n ** 18n)).toBe(10n ** 18n)
    expect(mulDivHalfUp(10n ** 18n + 1n, 1n, 2n)).toBe(5n * 10n ** 17n + 1n)
    for (const f of [mulDiv, mulDivHalfUp]) {
      expect(() => f(-1n, 1n, 1n)).toThrow(RangeError)
      expect(() => f(1n, -1n, 1n)).toThrow(RangeError)
      expect(() => f(1n, 1n, 0n)).toThrow(RangeError)
    }
  })
})

const load = (key: string): RegimePack => JSON.parse(readFileSync(new URL(`../../packs/${key}/pack.json`, import.meta.url), 'utf8'))
const reorder = (p: RegimePack, kinds: string[]): RegimePack => ({ ...p, steps: kinds.map((kind) => p.steps.find((s) => s.kind === kind)!).filter(Boolean) })
const kinds = (p: RegimePack) => p.steps.map((s) => s.kind as string)
const moved = (p: RegimePack, kind: string, beforeKind: string) => {
  const rest = kinds(p).filter((k) => k !== kind)
  rest.splice(rest.indexOf(beforeKind), 0, kind)
  return reorder(p, rest)
}

describe('regime packs', () => {
  const fpo = load('uk-fpo-template')
  const cobs = load('uk-cobs-template')

  it('TC-STAT-03 the shipped packs load', () => {
    expect(parsePack(fpo).errors).toEqual([])
    expect(parsePack(cobs).errors).toEqual([])
  })

  const cases: Array<[string, () => RegimePack, RegExp]> = [
    ['a no view step', () => reorder(fpo, kinds(fpo).filter((k) => k !== 'view_deal')), /^a: the pack has no view_deal/],
    ['a qualifying step after the deal', () => moved(fpo, 'view_deal', 'statement'), /^a: qualifying step/],
    ['a fpo warning before its statement', () => moved(fpo, 'warning_block', 'statement'), /^a: the statement must come before the warning/],
    ['b surface without a warning', () => ({ ...fpo, promotion_surfaces: [{ surface: 'deal_page', warning_text_key: 'no_such_warning' }] }), /^b: surface deal_page must use promotion_warning/],
    ['b deal page not a surface', () => ({ ...fpo, promotion_surfaces: [{ surface: 'promotional_email', warning_text_key: 'promotion_warning' }] }), /^b: deal_page is not listed/],
    ['b email not a surface', () => ({ ...fpo, promotion_surfaces: [{ surface: 'deal_page', warning_text_key: 'promotion_warning' }] }), /^b: promotional_email is not listed/],
    ['b payment page not a surface', () => ({ ...fpo, promotion_surfaces: fpo.promotion_surfaces.filter((x) => x.surface !== 'payment_instructions_pdf') }), /^b: payment_instructions_pdf is not listed/],
    ['b cobs without the personalised warning text', () => ({ ...cobs, legal_texts: cobs.legal_texts.filter((t) => t.text_key !== 'personalised_warning') }), /^b: uk-cobs needs the text personalised_warning/],
    ['b cobs without the risk summary', () => ({ ...cobs, legal_texts: cobs.legal_texts.filter((t) => t.text_key !== 'risk_summary') }), /^b: uk-cobs needs the text risk_summary/],
    ['b no text on whom to invite (R-PIP-06)', () => ({ ...cobs, legal_texts: cobs.legal_texts.filter((t) => t.text_key !== 'invitee_policy') }), /^b: uk-cobs needs the text invitee_policy/],
    ['b no commitment text', () => ({ ...fpo, legal_texts: fpo.legal_texts.filter((t) => t.text_key !== 'commitment_effect') }), /^b: uk-fpo needs the text commitment_effect/],
    ['b fpo warning for one category only', () => ({ ...fpo, legal_texts: fpo.legal_texts.filter((t) => t.variant !== 'sophisticated') }), /^b: uk-fpo needs promotion_warning for sophisticated/],
    ['incentive attestation without its text', () => ({ ...cobs, legal_texts: cobs.legal_texts.filter((t) => t.text_key !== 'incentive_attestation') }), /incentive attestation is on/],
    ['b cobs warning under an unreachable variant', () => ({ ...cobs, legal_texts: cobs.legal_texts.map((t) => (t.text_key === 'promotion_warning' ? { ...t, variant: 'unreachable' } : t)) }), /^b: uk-cobs needs the text promotion_warning/],
    ['sender text under an unreachable variant', () => ({ ...fpo, legal_texts: fpo.legal_texts.map((t) => (t.text_key === 'sender_name' ? { ...t, variant: 'unreachable' } : t)) }), /sender text has no default/],
    ['h statement only under another variant', () => ({ ...fpo, legal_texts: fpo.legal_texts.map((t) => (t.text_key === 'statement_sophisticated' ? { ...t, variant: 'unreachable' } : t)) }), /^h: the pack has no statement_sophisticated/],
    ['a the deal as its own prerequisite', () => ({ ...fpo, steps: fpo.steps.map((x) => (x.kind === 'view_deal' ? { ...x, qualifying: true } : x)) }), /^a: qualifying step view_deal must come before/],
    ['incentive attestation under an unreachable variant', () => ({ ...cobs, legal_texts: cobs.legal_texts.map((t) => (t.text_key === 'incentive_attestation' ? { ...t, variant: 'unreachable' } : t)) }), /incentive attestation is on/],
    ['b surface pointing at a text that is no warning', () => ({ ...fpo, promotion_surfaces: fpo.promotion_surfaces.map((x) => ({ ...x, warning_text_key: 'sender_name' })) }), /must use promotion_warning/],
    ['b surfaces pointing at another warning with one variant', () => ({ ...fpo, legal_texts: [...fpo.legal_texts, { ...fpo.legal_texts[0]!, text_key: 'alternate_warning', variant: 'high_net_worth' }], promotion_surfaces: fpo.promotion_surfaces.map((x) => ({ ...x, warning_text_key: 'alternate_warning' })) }), /must use promotion_warning/],
    ['a nothing marked qualifying', () => ({ ...fpo, steps: fpo.steps.map((x) => ({ ...x, qualifying: false })) }), /^a: statement must be a qualifying/],
    ['a cobs nothing marked qualifying', () => ({ ...cobs, steps: cobs.steps.map((x) => ({ ...x, qualifying: false })) }), /^a: personalised_warning must be a qualifying/],
    ['a assessment on without its step', () => reorder(fpo, kinds(fpo).filter((k) => k !== 'assessment')), /^a: the assessment is on/],
    ['a assessment off with its step', () => ({ ...fpo, assessment: { enabled: false, questions: [], max_attempts: null } }), /^a: the assessment is off/],
    ['f cobs without the cooling-off steps', () => reorder(cobs, kinds(cobs).filter((k) => k !== 'cooling_off_start')), /^f: uk-cobs cooling-off must start/],
    ['f cobs decision before classification', () => moved(cobs, 'cooling_off_decision', 'classification'), /^f: uk-cobs decision/],
    ['h statement missing', () => ({ ...fpo, legal_texts: fpo.legal_texts.filter((t) => t.text_key !== 'statement_sophisticated') }), /^h: the pack has no statement_sophisticated/],
    ['h an added statement variant lists no phrase', () => ({ ...fpo, legal_texts: [...fpo.legal_texts, { text_key: 'statement_high_net_worth', variant: 'other', version: 1, format: 'plain' as const, body: 'No bold phrases here.', required_bold: [], is_placeholder: false }] }), /statement_high_net_worth\/other lists no required bold/],
    ['h statement lists no phrase', () => ({ ...fpo, legal_texts: fpo.legal_texts.map((t) => (t.text_key === 'statement_sophisticated' ? { ...t, required_bold: [] } : t)) }), /lists no required bold/],
    ['c payment before KYC', () => moved(fpo, 'payment_instructions', 'kyc'), /^c: kyc/],
    ['c payment before signing', () => moved(fpo, 'payment_instructions', 'sign'), /^c: sign/],
    ['c no KYC', () => reorder(fpo, kinds(fpo).filter((k) => k !== 'kyc')), /^c: kyc/],
    ['c no signing', () => reorder(fpo, kinds(fpo).filter((k) => k !== 'sign')), /^c: sign/],
    ['d terminal sees promotion', () => ({ ...fpo, terminal_can_see_promotion: true }), /^d:/],
    ['e cobs without the assessment', () => ({ ...cobs, assessment: { ...cobs.assessment, enabled: false } }), /^e: uk-cobs needs/],
    ['e cobs assessment after the deal', () => moved(cobs, 'view_deal', 'assessment'), /^e: uk-cobs assessment/],
    ['f cobs without cooling-off', () => ({ ...cobs, cooling_off: { enabled: false, hours: 24 } }), /^f:/],
    ['f cobs with 23 hours', () => ({ ...cobs, cooling_off: { enabled: true, hours: 23 } }), /^f:/],
    ['g warning after classification', () => moved(cobs, 'classification', 'personalised_warning'), /^g: .* classification/],
    ['g warning after assessment', () => moved(cobs, 'assessment', 'personalised_warning'), /^g: .* assessment/],
    ['h bold phrase gone', () => ({ ...fpo, legal_texts: fpo.legal_texts.map((t) => (t.required_bold.length ? { ...t, body: 'no phrase' } : t)) }), /^h:/],
    ['h phrase there but not bold', () => ({ ...fpo, legal_texts: fpo.legal_texts.map((t) => (t.required_bold.length ? { ...t, body: t.body.replaceAll('**', '') } : t)) }), /^h:/],
    ['h bold needs the bold format', () => ({ ...fpo, legal_texts: fpo.legal_texts.map((t) => (t.required_bold.length ? { ...t, format: 'plain' as const } : t)) }), /^h:/],
  ]
  it.each(cases)('TC-STAT-03 a pack breaking invariant %s does not load', (_n, make, want) => {
    const r = parsePack(make())
    expect(r.pack).toBeNull()
    expect(r.errors.some((e) => want.test(e))).toBe(true)
  })
  it('TC-STAT-03 cobs rules follow the regime, so renaming a pack does not escape them', () => {
    const renamed = { ...cobs, key: 'my-friendly-pack', assessment: { ...cobs.assessment, enabled: false } }
    expect(invariantViolations(renamed).some((e) => e.startsWith('e:'))).toBe(true)
  })
  it('TC-STAT-03 hostile packs: junk, extra keys, proto keys, duplicates and bad references are refused without throwing', () => {
    for (const junk of [null, 1, 'x', [], {}, { key: '__proto__' }]) expect(parsePack(junk).pack).toBeNull()
    expect(parsePack({ ...fpo, extra: 1 }).pack).toBeNull()
    expect(parsePack(JSON.parse(JSON.stringify(fpo).replace('{', '{"__proto__":{"x":1},'))).pack).toBeNull()
    expect(parsePack({ ...fpo, key: '__proto__' }).pack).toBeNull()
    expect(parsePack({ ...fpo, legal_texts: [...fpo.legal_texts, fpo.legal_texts[0]] }).errors.join()).toContain('appears twice')
    expect(parsePack({ ...fpo, steps: [...fpo.steps, fpo.steps[0]] }).errors.join()).toContain('appears twice')
    const q = fpo.assessment.questions[0]!
    expect(parsePack({ ...fpo, assessment: { enabled: true, questions: [{ ...q, correct_option: 3 }] } }).errors.join()).toContain('does not exist')
    // the same id with another prompt: the id check itself, not the prompt check (Codex group B r3 #9)
    expect(parsePack({ ...fpo, assessment: { enabled: true, questions: [q, { ...q, prompt: `${q.prompt} (other)` }] } }).errors).toContain('a question id appears twice')
    // R-ELG-05: the same question under another id, other case and spacing, is the same question
    const bank = fpo.assessment.questions
    const copy = { ...q, id: 'copy', prompt: ` ${q.prompt.toUpperCase().replace(/ /g, '  ')} ` }
    expect(parsePack({ ...fpo, assessment: { ...fpo.assessment, questions: [...bank, copy] } }).errors).toContain('a question prompt appears twice')
    const hidden = { ...q, id: 'hidden', prompt: q.prompt.replace(' ', '\u00ad \u200b') }
    expect(parsePack({ ...fpo, assessment: { ...fpo.assessment, questions: [...bank, hidden] } }).errors).toContain('a question prompt appears twice')
    // the usual copy-paste differences (PRD v0.30; Codex group B r4 #1, r5 #2, #4)
    for (const [a, b] of [
      ['Café risk?', 'Cafe\u00ad\u0301 risk?'],
      ['Straße risk?', 'STRASSE RISK?'],
      ['Wie groß ist das Risiko?', 'WIE GROẞ IST DAS RISIKO?'],
      ['Risk level?', 'Risk\u0085level?'],
      ['\u26a0 What can you lose?', '\u26a0\ufe0f What can you lose?'],
      ["What's the risk?", 'What\u2019s the risk?'],
      ['Is it "safe"?', 'Is it \u201csafe\u201d?'],
      ['Lock-up period?', 'Lock\u2013up period?'],
    ] as [string, string][]) {
      const two = [{ ...q, id: 'one', prompt: a }, { ...q, id: 'two', prompt: b }]
      expect(parsePack({ ...fpo, assessment: { ...fpo.assessment, questions: [...bank, ...two] } }).errors).toContain('a question prompt appears twice')
    }
    // Codex group B r4 #5: a prompt of invisible characters only
    expect(parsePack({ ...fpo, assessment: { ...fpo.assessment, questions: [...bank, { ...q, id: 'blank', prompt: '\u00ad\u200b' }] } }).errors).toContain('a question prompt is blank')
    expect(parsePack(fpo).errors).not.toContain('a question prompt is blank')
    expect(parsePack({ ...fpo, assessment: { ...fpo.assessment, questions: [...bank, { ...copy, prompt: `${q.prompt} (again)` }] } }).errors).not.toContain('a question prompt appears twice')
    expect(parsePack({ ...fpo, assessment: { enabled: true, questions: [] } }).errors.join()).toContain('no questions')
    expect(parsePack({ ...fpo, assessment: { enabled: true, questions: [{ ...q, options: ['a', 'b'] }] } }).pack).toBeNull()
    expect(parsePack({ ...fpo, thresholds: { hnw_income_minor: 1, hnw_net_assets_minor: '1' } }).pack).toBeNull()
    expect(parsePack({ ...fpo, author_note: { ...fpo.author_note, no_lawyer_review: false } }).pack).toBeNull()
    expect(parsePack({ ...fpo, version: 2147483648 }).pack).toBeNull()
    expect(parsePack({ ...fpo, sender: { name_text_key: 'nope' } }).errors.join()).toContain('sender text')
    expect(parsePack({ ...fpo, legal_texts: fpo.legal_texts.map((t) => ({ ...t, body: '   ' })) }).errors.join()).toContain('is blank')
    expect(parsePack({ ...cobs, key: 'my-cobs', regime: 'uk-fpo' }).errors.join()).toContain('named cobs')
    expect(parsePack({ ...fpo, key: 'my-fpo', regime: 'uk-cobs' }).errors.join()).toContain('named fpo')
  })
  it('TC-OP-04 thresholds come from the pack; a live deal keeps its pack; shipped packs say no lawyer reviewed them', () => {
    expect(thresholds(fpo)).toMatchObject({ incomeMinor: 10_000_000n, netAssetsMinor: 25_000_000n, incomeRounding: 1_000_000n, assetsRounding: 10_000_000n, minInvestments: 2, networkMonthsOver: 6 })
    expect(thresholds({ thresholds: { ...fpo.thresholds, hnw_income_minor: '123', hnw_net_assets_minor: '456' } })).toMatchObject({ incomeMinor: 123n, netAssetsMinor: 456n })
    expect(effectivePackId({ boundPackId: 'old' }, { activePackId: 'new' })).toBe('old')
    expect(effectivePackId({ boundPackId: null }, { activePackId: 'new' })).toBe('new')
    for (const p of [fpo, cobs]) {
      expect(p.author_note.no_lawyer_review).toBe(true)
      expect(p.author_note.text).toMatch(/No lawyer has reviewed/)
      expect(p.author_note.known_open_questions.length).toBeGreaterThan(0)
    }
  })
  it('TC-OP-02 placeholders are found in legal text and in questions', () => {
    const p = parsePack(fpo).pack!
    const all = placeholderTexts(p)
    expect(all).toContain('your_money')
    expect(all).toContain('question:placeholder-1')
    const clean = { ...p, legal_texts: p.legal_texts.map((t) => ({ ...t, is_placeholder: false })), assessment: { ...p.assessment, questions: p.assessment.questions.map((q) => ({ ...q, is_placeholder: false })) } }
    // flipping the flag alone does not count: the shipped words are still there
    expect(placeholderTexts(clean)).toEqual(all)
    const real = {
      ...clean,
      legal_texts: clean.legal_texts.map((t) => ({ ...t, body: `Operator wording for ${t.text_key}.` })),
      assessment: { ...clean.assessment, questions: clean.assessment.questions.map((q) => ({ ...q, prompt: 'A real question?', options: ['One', 'Two', 'Three'] })) },
    }
    expect(placeholderTexts(real)).toEqual([])
    expect(placeholderTexts({ ...real, legal_texts: [{ ...real.legal_texts[0]!, body: '  ' }] })).toEqual([real.legal_texts[0]!.text_key])
    expect(placeholderTexts({ ...real, assessment: { ...real.assessment, questions: [{ ...real.assessment.questions[0]!, options: ['One', 'Placeholder option B', 'Three'] }] } })).toEqual(['question:placeholder-1'])
  })
})

const A: Staff = { userId: 'a', roles: ['admin'] }
const B: Staff = { userId: 'b', roles: ['admin', 'approver'] }
const R: Staff = { userId: 'r', roles: ['reviewer'] }
const READY: SwitchFacts = {
  regulatoryStatus: 'authorised_firm', accountablePerson: 'A Person', accountableConfirmedOn: '2026-11-01', today: '2026-11-06',
  placeholderTextKeys: [], packFormatErrors: [], paymentInstructionsConfigured: true, paymentFileInvalid: false, yourMoneyFilled: true, staff: [A, B, R], demoAdding: false,
}
const codes = (f: Partial<SwitchFacts>) => switchBlockers({ ...READY, ...f }).map((b) => b.code)

describe('instance rules', () => {
  it('TC-DEMO-07 the demo pack changes only the three texts, keeps them placeholders, and still loads under its kept name', () => {
    for (const key of ['uk-fpo-template', 'uk-cobs-template']) {
      const from = load(key)
      const demo = demoPackContent(from, 3)
      expect(parsePack(demo).errors).toEqual([])
      expect([demo.key, demo.version, demo.regime]).toEqual([`${from.regime}-demo-template`, 3, from.regime])
      expect([demo.steps, demo.assessment, demo.thresholds]).toEqual([from.steps, from.assessment, from.thresholds])
      const changed = demo.legal_texts.filter((t, i) => t.body !== from.legal_texts[i]!.body).map((t) => t.text_key)
      expect(new Set(changed)).toEqual(new Set(['promotion_warning', from.sender.name_text_key, 'your_money']))
      for (const t of demo.legal_texts.filter((x) => changed.includes(x.text_key))) {
        expect(t.is_placeholder).toBe(true)
        expect(Object.values(DEMO_PACK_TEXTS)).toContain(t.body)
      }
      expect(placeholderTexts(demo)).toEqual(expect.arrayContaining(changed))
    }
    // the sender is whichever text the pack names for it
    const fpo = load('uk-fpo-template')
    const renamed = { ...fpo, sender: { ...fpo.sender, name_text_key: 'risk_summary' } }
    expect(demoPackContent(renamed, 1).legal_texts.find((t) => t.text_key === 'risk_summary')!.body).toBe(DEMO_PACK_TEXTS.sender)
  })
  it('TC-DEMO-05 demo and ordinary meet only on the same run; an invitation across the line is refused before anything else', () => {
    expect([sameDemoSide(null, null), sameDemoSide('r1', 'r1'), sameDemoSide('r1', null), sameDemoSide(null, 'r1'), sameDemoSide('r1', 'r2')]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
    const facts = {
      dealLive: false,
      held: true,
      link: { disabled: true, closingPaused: false, awaitingApproval: false },
      person: { activeInvitation: true, endedBefore: false },
      targeted: null,
      verifiedEmail: 'a@example.test',
    }
    expect(decideAccept({ ...facts, sameDemoSide: false })).toEqual({ ok: false, reason: 'demo_apart' })
    expect(decideAccept({ ...facts, sameDemoSide: true })).toEqual({ ok: false, reason: 'held' })
    // a statement is on the side of the people it matches; none matched is ordinary; both sides, or two runs, refused
    expect(statementSide([])).toEqual({ side: null })
    expect(statementSide([null, null])).toEqual({ side: null })
    expect(statementSide(['r1', 'r1'])).toEqual({ side: 'r1' })
    expect([statementSide(['r1', null]), statementSide([null, 'r1']), statementSide(['r1', 'r2'])]).toEqual([null, null, null])
  })
  it('TC-DEMO-04 a demo deal being added blocks the switch, and is named', () => {
    expect(codes({ demoAdding: true })).toEqual(['demo_adding'])
    expect(switchBlockers({ ...READY, demoAdding: true })[0]!.message).toMatch(/demo deal is being added/)
  })
  it('TC-OP-02 each missing item blocks the switch and is named', () => {
    expect(codes({})).toEqual([])
    expect(codes({ regulatoryStatus: null })).toEqual(['regulatory_status'])
    expect(codes({ regulatoryStatus: 'unauthorised_relying_on_exemption' })).toEqual([])
    expect(codes({ accountablePerson: null })).toEqual(['accountable_person'])
    expect(codes({ accountablePerson: '   ' })).toEqual(['accountable_person'])
    expect(codes({ accountableConfirmedOn: null })).toEqual(['accountable_confirmed_on'])
    expect(codes({ accountableConfirmedOn: '2026-11-07' })).toEqual(['accountable_confirmed_on'])
    expect(codes({ accountableConfirmedOn: '2026-11-06' })).toEqual([])
    expect(codes({ accountableConfirmedOn: '2026-02-30' })).toEqual(['accountable_confirmed_on'])
    expect(codes({ accountableConfirmedOn: 'not a date' })).toEqual(['accountable_confirmed_on'])
    expect(codes({ placeholderTextKeys: ['your_money'] })).toEqual(['placeholder_texts'])
    expect(codes({ paymentInstructionsConfigured: false })).toEqual(['payment_instructions'])
    expect(codes({ yourMoneyFilled: false })).toEqual(['your_money'])
    expect(codes({ packFormatErrors: ['a: x'] })).toEqual(['pack_format'])
    const invalid = switchBlockers({ ...READY, paymentFileInvalid: true })
    expect(invalid.map((b) => b.code)).toEqual(['payment_instructions'])
    expect(invalid[0]!.message).toMatch(/documented format/)
    expect(codes({ staff: [A, { userId: 'b', roles: ['admin'] }, R] })).toEqual(['approver'])
  })
  it('TC-OP-02 an appointed representative is refused with the reason', () => {
    const b = switchBlockers({ ...READY, regulatoryStatus: 'appointed_representative' })
    expect(b.map((x) => x.code)).toEqual(['appointed_representative'])
    expect(b[0]!.message).toMatch(/cannot be used for an appointed representative/)
  })
  it('TC-OP-02 two admins and a reviewer must be three different people', () => {
    expect(hasDistinctAdminsAndReviewer([A, B, R])).toBe(true)
    expect(hasDistinctAdminsAndReviewer([A, B])).toBe(false)
    expect(hasDistinctAdminsAndReviewer([A, R])).toBe(false)
    expect(hasDistinctAdminsAndReviewer([A, { userId: 'b', roles: ['admin', 'reviewer'] }])).toBe(false)
    expect(hasDistinctAdminsAndReviewer([A, B, { userId: 'c', roles: ['admin', 'reviewer'] }])).toBe(true)
    expect(codes({ staff: [A, { userId: 'b', roles: ['admin', 'reviewer', 'approver'] }] })).toEqual(['separation'])
  })
  it('TC-OP-02 a second admin approves; only a sandbox with one admin may approve itself', () => {
    const base = { requestedBy: 'a', approver: 'a', approverIsAdmin: true }
    expect(approvalRefusal({ ...base, mode: 'sandbox', adminCount: 1 })).toBeNull()
    expect(isSingleAdminException({ ...base, mode: 'sandbox', adminCount: 1 })).toBe(true)
    expect(approvalRefusal({ ...base, mode: 'sandbox', adminCount: 2 })).toMatch(/second admin/)
    expect(approvalRefusal({ ...base, mode: 'real', adminCount: 1 })).toMatch(/second admin/)
    expect(isSingleAdminException({ ...base, mode: 'real', adminCount: 1 })).toBe(false)
    expect(isSingleAdminException({ ...base, mode: 'sandbox', adminCount: 2 })).toBe(false)
    expect(approvalRefusal({ ...base, approver: 'b', mode: 'real', adminCount: 2 })).toBeNull()
    expect(isSingleAdminException({ ...base, approver: 'b', mode: 'sandbox', adminCount: 1 })).toBe(false)
    expect(approvalRefusal({ ...base, approver: 'b', approverIsAdmin: false, mode: 'real', adminCount: 2 })).toMatch(/Only an admin/)
    expect(isSingleAdminException({ ...base, approverIsAdmin: false, mode: 'sandbox', adminCount: 1 })).toBe(false)
  })
  it('TC-OP-02 role changes cannot break the separation or remove the last admin', () => {
    expect(roleChangeRefusal('sandbox', [])).toMatch(/at least one admin/)
    expect(roleChangeRefusal('sandbox', [A])).toBeNull()
    expect(roleChangeRefusal('real', [A, B, R])).toBeNull()
    expect(roleChangeRefusal('real', [A, B])).toMatch(/three different/)
    expect(roleChangeRefusal('real', [A, { userId: 'b', roles: ['admin'] }, R])).toMatch(/approver/)
  })
  it('TC-OP-01 the sandbox payment details are fixed and fictional', () => {
    const p = sandboxPaymentInstruction('GBP')
    expect(p.fictional).toBe(true)
    expect(p.account_number).toBe('00000000')
    expect(p.holder_capacity).toMatch(/not a real account/)
    expect(sandboxPaymentInstruction('GBP')).toEqual(p)
    expect(sandboxPaymentInstruction('USD').currency).toBe('USD')
  })
})

describe('gates', () => {
  const actor = (roles: Array<'admin' | 'reviewer' | 'approver'>, mustChangePassword = false, mfaOn = true, emailVerified = true) => ({ id: 'x', roles, mustChangePassword, mfaOn, emailVerified })
  it('deny by default and refuse a temporary password', () => {
    expect(GATES.signedIn(null)).toBe(false)
    expect(GATES.active(null)).toBe(false)
    expect(GATES.canAdministerInstance(null)).toBe(false)
    expect(GATES.canReadAudit(null)).toBe(false)
    expect(GATES.signedIn(actor([], true))).toBe(true)
    expect(GATES.active(actor([], true))).toBe(false)
    expect(GATES.active(actor([]))).toBe(true)
    expect(GATES.canAdministerInstance(actor(['admin'], true))).toBe(false)
    expect(GATES.canAdministerInstance(actor(['reviewer', 'approver']))).toBe(false)
    expect(GATES.canAdministerInstance(actor(['admin']))).toBe(true)
    expect(GATES.canReadAudit(actor(['approver']))).toBe(false)
    expect(GATES.canReadAudit(actor(['reviewer']))).toBe(true)
    expect(GATES.canReadAudit(actor(['admin']))).toBe(true)
    expect(GATES.canReadAudit(actor(['admin'], true))).toBe(false)
    // TC-ACC-02: a role does nothing until two-step sign-in is on
    expect(GATES.canAdministerInstance(actor(['admin'], false, false))).toBe(false)
    expect(GATES.canReviewKyc(actor(['reviewer'], false, false))).toBe(false)
    expect(GATES.canReviewKyc(actor(['reviewer']))).toBe(true)
    expect(GATES.canReviewKyc(actor(['admin']))).toBe(false)
    expect(GATES.canReadAudit(actor(['admin'], false, false))).toBe(false)
    expect(GATES.verified(actor([], false, false, false))).toBe(false)
    expect(GATES.verified(actor([], true))).toBe(false)
    expect(GATES.verified(actor([], false, false))).toBe(true)
    expect(isGateName('__proto__')).toBe(false)
    expect(isGateName('toString')).toBe(false)
    expect(isGateName(undefined)).toBe(false)
    expect(isGateName('public')).toBe(true)
  })
})

describe('audit chain', () => {
  const rec = (seq: number, prev: string): AuditRecord => {
    const r = { seq, at: '2026-11-06T00:00:00.000Z', actor_id: 'system', action: 'x', entity_id: null, detail_hmac: null, software_version: '0.0.1', pack_version: 'p@1', prev_hash: prev }
    return { ...r, hash: auditHash(r) }
  }
  const one = rec(1, GENESIS)
  const two = rec(2, one.hash)
  it('TC-AUD-01 finds every kind of break', () => {
    expect(verifyChain([one, two])).toEqual({ ok: true, count: 2 })
    expect(verifyChain([])).toEqual({ ok: true, count: 0 })
    expect(verifyChain([two])).toEqual({ ok: false, badSeq: 2 })
    expect(verifyChain([one, { ...two, action: 'y' }])).toEqual({ ok: false, badSeq: 2 })
    expect(verifyChain([one, { ...two, pack_version: 'other@1' }])).toEqual({ ok: false, badSeq: 2 })
    expect(verifyChain([one, { ...two, software_version: '9' }])).toEqual({ ok: false, badSeq: 2 })
    expect(verifyChain([{ ...one, prev_hash: 'x'.repeat(64) }])).toEqual({ ok: false, badSeq: 1 })
  })
  it('TC-AUD-01 finds a record rewritten with a fresh hash, and a record removed with the next one re-linked', () => {
    const three = rec(3, two.hash)
    const { hash: _old, ...body } = two
    const forged = { ...body, action: 'forged', hash: auditHash({ ...body, action: 'forged' }) }
    expect(verifyChain([one, forged, three])).toEqual({ ok: false, badSeq: 3 })
    expect(verifyChain([one, rec(3, one.hash)])).toEqual({ ok: false, badSeq: 3 })
  })
})
