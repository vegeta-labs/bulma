import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SumsubKyc } from '../adapters/sumsub.ts'
import {
  coolingOffCounts, coolingOffOver, statementClosed, warningVariant, isQualified, judgeStatement, lockAfterFailure, lockedUntil, markAssessment, nextEligibilityStep, pickQuestions, preparation, statementAnswers, statementExpiry, stepOpen, type EligibilityFacts, type StatementAnswers,
} from './eligibility.ts'
import { addYears, afterProviderDecision, entityGaps, bankDetailsGiven, entityStatus, isBeneficialOwner, kycPassed, relationshipEnd, retentionDue, sameHolder } from './entity.ts'
import { textParts } from './legalText.ts'
import { bpsToPercent, minorToPounds, percentToBps, typedWhole, wholePoundsToMinor } from './pounds.ts'
import { fillText, parsePack, type RegimePack } from './regimePack.ts'
import { MemoryStorage, StorageFull } from '../adapters/index.ts'
import { realAdaptersFromEnv } from '../adapters/fromEnv.ts'
import { UploadSlots } from '../server/uploadSlots.ts'
import { base32, codeAt, matchStep, otpauthUri, stepOf } from './totp.ts'

const load = (key: string): RegimePack => parsePack(JSON.parse(readFileSync(new URL(`../../packs/${key}/pack.json`, import.meta.url), 'utf8'))).pack!
const fpo = load('uk-fpo-template')
const cobs = load('uk-cobs-template')
const hnw = (income?: string, assets?: string): StatementAnswers => ({
  category: 'high_net_worth',
  high_net_worth: { income: income ? { yes: true, amount_minor: income } : { yes: false }, net_assets: assets ? { yes: true, amount_minor: assets } : { yes: false } },
})
const NO = { yes: false } as const
const soph = (o: Partial<NonNullable<StatementAnswers['sophisticated']>>): StatementAnswers => ({ category: 'sophisticated', sophisticated: { worked_in_private_finance: NO, director: NO, unlisted_investments: NO, network_member: NO, ...o } })

describe('statement', () => {
  it('TC-ELG-01 figures at, under and beside the pack threshold, and to the rounding asked for', () => {
    expect(judgeStatement(fpo, hnw('10000000')).qualifies).toBe(true) // £100,000
    expect(judgeStatement(fpo, hnw('9000000'))).toEqual({ qualifies: false, problems: [] }) // nothing says which figure, or by how much
    expect(judgeStatement(fpo, hnw('10000100')).problems.join()).toMatch(/nearest £10,000/)
    expect(judgeStatement(fpo, hnw(undefined, '25000000')).qualifies).toBe(true) // £250,000
    expect(judgeStatement(fpo, hnw(undefined, '20000000'))).toEqual({ qualifies: false, problems: [] })
    expect(judgeStatement(fpo, hnw(undefined, '25000100')).problems.join()).toMatch(/nearest £100,000/)
    expect(judgeStatement(fpo, hnw(undefined, '30000000')).qualifies).toBe(true)
    expect(judgeStatement(fpo, hnw('11000000')).qualifies).toBe(true)
    expect(judgeStatement(fpo, hnw('10000000', '20000000')).qualifies).toBe(false) // one good answer does not excuse a bad one
    expect(judgeStatement(fpo, hnw()).qualifies).toBe(false)
    expect(judgeStatement({ ...fpo, thresholds: { ...fpo.thresholds, hnw_income_minor: '20000000', hnw_net_assets_minor: '1' } }, hnw('10000000')).qualifies).toBe(false)
    expect(judgeStatement(fpo, { category: 'high_net_worth' }).problems.join()).toMatch(/Answer each question/)
    expect(judgeStatement(fpo, hnw()).problems).toEqual([])
    // a rounding error and a low figure together: the format is what is said
    expect(judgeStatement(fpo, hnw('1000100')).problems.join()).toMatch(/nearest £10,000/)
  })
  it('TC-ELG-01 sophisticated: company number under FPO only; two investments count even in one company; membership', () => {
    const d = { director: { yes: true as const, name: 'Co' } }
    expect(judgeStatement(fpo, soph(d)).problems.join()).toMatch(/company number/)
    expect(judgeStatement(cobs, soph(d)).qualifies).toBe(true)
    expect(judgeStatement(fpo, soph({ director: { yes: true, name: 'Co', company_number: '123' } })).qualifies).toBe(true)
    expect(judgeStatement(fpo, soph({ unlisted_investments: { yes: true, count: 1 } })).qualifies).toBe(false)
    expect(judgeStatement(fpo, soph({ unlisted_investments: { yes: true, count: 2 } })).qualifies).toBe(true)
    const net = (months: number, still_member: boolean) => soph({ network_member: { yes: true, name: 'N', months, still_member } })
    // never answered is not a yes, and not a no: it is a form to correct, with nothing signed
    expect(judgeStatement(fpo, soph({ network_member: { yes: true, name: 'N', months: 7 } }))).toEqual({ qualifies: false, problems: ['Answer each question.'] })
    expect(judgeStatement(cobs, soph({ network_member: { yes: true, name: 'N', months: 7 } }))).toEqual({ qualifies: true, problems: [] })
    expect(judgeStatement(fpo, net(6, true)).qualifies).toBe(false)
    expect(judgeStatement(fpo, net(7, true)).qualifies).toBe(true)
    expect(judgeStatement(fpo, net(7, false))).toEqual({ qualifies: false, problems: [] })
    expect(judgeStatement(cobs, net(7, false)).qualifies).toBe(true)
    expect(judgeStatement(fpo, soph({ worked_in_private_finance: { yes: true, name: 'F' } })).qualifies).toBe(true)
    expect(judgeStatement(fpo, soph({})).qualifies).toBe(false)
    expect(judgeStatement(fpo, { category: 'sophisticated' }).problems.join()).toMatch(/Answer each question/)
    expect(judgeStatement(fpo, soph({})).problems).toEqual([]) // no to everything is an answer, not a format error
    expect(judgeStatement(fpo, soph({ unlisted_investments: { yes: true, count: 1 } })).problems).toEqual([])
  })
  it('TC-ELG-02 choosing none fails with nothing that suggests another answer', () => {
    expect(judgeStatement(cobs, { category: 'neither' })).toEqual({ qualifies: false, problems: [] })
    expect(judgeStatement(fpo, { category: 'neither' })).toEqual({ qualifies: false, problems: [] })
  })
  it('hostile answers are refused by the schema', () => {
    for (const bad of [{}, { category: 'x' }, { category: 'neither', extra: 1 }, hnw('-1'), hnw('1.5'), hnw('1e9'), { ...soph({}), sophisticated: { ...soph({}).sophisticated, director: { yes: true, name: '' } } }]) expect(statementAnswers.safeParse(bad).success).toBe(false)
  })
  it('expires twelve months on, and the 29th of February falls back', () => {
    expect(statementExpiry(new Date('2026-03-10T12:00:00Z')).toISOString()).toBe('2027-03-10T12:00:00.000Z')
    expect(statementExpiry(new Date('2028-02-29T12:00:00Z')).toISOString()).toBe('2029-02-28T12:00:00.000Z')
  })
})

describe('assessment', () => {
  const pack = { assessment: { enabled: true, max_attempts: null, questions: ['a', 'b', 'c', 'd'].map((id) => ({ id, prompt: id, options: ['1', '2', '3'], correct_option: 1, is_placeholder: false })) } }
  const first = () => 0
  it('TC-ELG-03 an odd bank still gives a wholly new set: three questions ask one, never repeating the last', () => {
    const three = { assessment: { ...pack.assessment, questions: pack.assessment.questions.slice(0, 3) } }
    for (const last of ['a', 'b', 'c']) for (const n of [0, 1]) {
      const asked = pickQuestions(three, [{ questions: [last], passed: false, lockedUntil: null }], () => n)
      expect(asked.length).toBe(1)
      expect(asked).not.toContain(last)
    }
    const five = { assessment: { ...pack.assessment, questions: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ ...pack.assessment.questions[0]!, id })) } }
    expect(pickQuestions(five, [], first).length).toBe(2)
    // a retake after one left open counts it as asked
    expect(pickQuestions(pack, [{ questions: ['a', 'b'], passed: null, lockedUntil: null }], first)).toEqual(['c', 'd'])
  })
  it('TC-ELG-03 half the bank, a different set next time, and any bank size works', () => {
    expect(pickQuestions(pack, [], first)).toEqual(['a', 'b'])
    expect(pickQuestions(pack, [{ questions: ['a', 'b'], passed: false, lockedUntil: null }], first)).toEqual(['c', 'd'])
    expect(pickQuestions(pack, [], (n) => n - 1)).toEqual(['d', 'c'])
  })
  it('TC-ELG-03 all must be right; a missing answer or a proto key is wrong', () => {
    expect(markAssessment(pack, ['a', 'b'], { a: 1, b: 1 })).toBe(true)
    expect(markAssessment(pack, ['a', 'b'], { a: 1, b: 0 })).toBe(false)
    expect(markAssessment(pack, ['a', 'b'], { a: 1 })).toBe(false)
    expect(markAssessment(pack, ['nope'], { nope: 1 })).toBe(false)
    expect(markAssessment(pack, ['a'], JSON.parse('{"__proto__": 1}'))).toBe(false)
  })
  it('TC-ELG-03 the second failure and each later one lock for 24 hours; the first does not', () => {
    const t = new Date('2026-01-01T00:00:00Z')
    expect(lockAfterFailure(1, t)).toBeNull()
    expect(lockAfterFailure(2, t)!.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(lockAfterFailure(5, t)!.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    const until = new Date('2026-01-02T00:00:00Z')
    const a = [{ questions: [], passed: false, lockedUntil: until }]
    expect(lockedUntil(a, t)).toEqual(until)
    expect(lockedUntil(a, until)).toBeNull()
    expect(lockedUntil([], t)).toBeNull()
  })
  it('TC-ELG-03 a bank under four questions does not load: an attempt must ask two or more, and a retake a wholly different set', () => {
    const qs = cobs.assessment.questions
    expect(qs.length).toBeGreaterThanOrEqual(4)
    for (const n of [1, 2, 3]) expect(parsePack({ ...cobs, assessment: { ...cobs.assessment, questions: qs.slice(0, n) } }).errors.join(), String(n)).toMatch(/at least 4 questions/)
    expect(parsePack({ ...cobs, assessment: { ...cobs.assessment, questions: qs.slice(0, 4) } }).pack).not.toBeNull()
  })
  it('TC-ELG-01 zero rounding does not load', () => {
    for (const k of ['income_rounding_minor', 'assets_rounding_minor']) expect(parsePack({ ...fpo, thresholds: { ...fpo.thresholds, [k]: '0' } }).pack, k).toBeNull()
  })
  it('TC-ELG-03 a question with fewer than three options does not load', () => {
    const q = cobs.assessment.questions[0]!
    expect(parsePack({ ...cobs, assessment: { ...cobs.assessment, questions: [{ ...q, options: ['a', 'b'] }] } }).pack).toBeNull()
  })
})

const NOW = new Date('2026-06-01T00:00:00Z')
const blank: EligibilityFacts = { statement: null, needsReconfirm: false, attempts: [], coolingOff: null, fullName: null, personalisedWarning: null, warningBlockAcked: false }
const good = { qualifies: true, expiresAt: new Date('2027-06-01T00:00:00Z'), category: 'high_net_worth', reopened: false }
const passed = [{ questions: [], passed: true, lockedUntil: null }]

describe('order of steps', () => {
  it('TC-ELG-04 uk-cobs: nothing before the warning; classification and assessment only after continue; the decision after them', () => {
    expect(nextEligibilityStep(cobs, blank, NOW)).toBe('request_access')
    const co = { startedAt: NOW, endsAt: new Date('2026-06-02T00:00:00Z'), decision: null }
    const started = { ...blank, coolingOff: co, fullName: 'A B' }
    expect(nextEligibilityStep(cobs, started, NOW)).toBe('personalised_warning')
    expect(stepOpen(cobs, 'classification', started, NOW)).toBe(false)
    expect(stepOpen(cobs, 'assessment', started, NOW)).toBe(false)
    expect(stepOpen(cobs, 'classification', { ...started, personalisedWarning: 'leave' }, NOW)).toBe(false)
    const on = { ...started, personalisedWarning: 'continue' as const }
    expect(nextEligibilityStep(cobs, on, NOW)).toBe('classification')
    expect(stepOpen(cobs, 'assessment', on, NOW)).toBe(false)
    expect(nextEligibilityStep(cobs, { ...on, statement: good }, NOW)).toBe('assessment')
    const late = { ...on, statement: good, attempts: passed }
    expect(nextEligibilityStep(cobs, late, NOW)).toBe('cooling_off_decision')
    expect(isQualified(cobs, late, NOW)).toBe(false)
    const done = { ...late, coolingOff: { ...co, decision: 'continue' as const } }
    expect(nextEligibilityStep(cobs, done, NOW)).toBeNull()
    expect(isQualified(cobs, done, NOW)).toBe(true)
    expect(isQualified(cobs, { ...done, coolingOff: { ...co, decision: 'leave' as const } }, NOW)).toBe(false)
  })
  it('TC-ELG-04 the 24-hour boundary is exact', () => {
    const c = { endsAt: new Date('2026-06-02T00:00:00.000Z') }
    expect(coolingOffOver(c, new Date('2026-06-01T23:59:59.999Z'))).toBe(false)
    expect(coolingOffOver(c, new Date('2026-06-02T00:00:00.000Z'))).toBe(true)
  })
  it('TC-ELG-04 uk-fpo: statement, assessment, warning, in that order', () => {
    expect(nextEligibilityStep(fpo, blank, NOW)).toBe('statement')
    expect(nextEligibilityStep(fpo, { ...blank, statement: good }, NOW)).toBe('assessment')
    expect(nextEligibilityStep(fpo, { ...blank, statement: good, attempts: passed }, NOW)).toBe('warning_block')
    const done = { ...blank, statement: good, attempts: passed, warningBlockAcked: true }
    expect(isQualified(fpo, done, NOW)).toBe(true)
    // R-ELG-03: an expired statement, none-of-these and a changed name each stop it
    expect(isQualified(fpo, done, good.expiresAt)).toBe(false)
    expect(isQualified(fpo, { ...done, statement: { ...good, qualifies: false } }, NOW)).toBe(false)
    expect(isQualified(fpo, { ...done, needsReconfirm: true }, NOW)).toBe(false)
    expect(isQualified(fpo, { ...blank, attempts: [{ questions: [], passed: false, lockedUntil: null }], statement: good, warningBlockAcked: true }, NOW)).toBe(false)
    expect(isQualified({ steps: [{ kind: 'view_deal', qualifying: false }] }, done, NOW)).toBe(false)
  })
  it('TC-ELG-05 preparation comes from the pack, says the wait for cobs, and holds no deal content', () => {
    const c = preparation(cobs, 'individual')
    expect(c.coolingOffHours).toBe(24)
    expect(c.textKey).toBe('preparation_individual')
    expect(preparation(cobs, 'company').textKey).toBe('preparation_company')
    expect(preparation(fpo, 'individual').coolingOffHours).toBeNull()
    expect(c.minutes.assessment).toBe(10)
    expect(c.reviewDays).toBe(2)
    expect(parsePack({ ...cobs, preparation: { ...cobs.preparation, individual_text_key: 'nope' } }).pack).toBeNull()
    expect(parsePack({ ...cobs, biometric_consent_text_key: 'nope' }).pack).toBeNull()
  })
})

describe('entities', () => {
  it('TC-ENT-02 exactly 25% is no beneficial owner, over it is, and control counts whatever the share', () => {
    expect(isBeneficialOwner({ kind: 'owner', ownershipBps: 2500 })).toBe(false)
    expect(isBeneficialOwner({ kind: 'owner', ownershipBps: 2501 })).toBe(true)
    expect(isBeneficialOwner({ kind: 'controller', ownershipBps: 0 })).toBe(true)
    expect(isBeneficialOwner({ kind: 'director', ownershipBps: 9000 })).toBe(true) // the share counts, whatever else the person is
    expect(isBeneficialOwner({ kind: 'director', ownershipBps: 0 })).toBe(false)
    expect(isBeneficialOwner({ kind: 'representative', ownershipBps: 2500 })).toBe(false)
    expect(isBeneficialOwner({ kind: 'owner', ownershipBps: 1001 }, 1000)).toBe(true)
  })
  it('TC-ENT-02 required material', () => {
    const company = { type: 'company' as const, fields: { name: 'C', company_number: '1', registered_address: 'a', tax_residence: 'UK', tax_id: '1', source_of_wealth: 's' }, files: ['registration_proof', 'address_proof', 'structure_chart'], parties: [{ kind: 'director' as const, ownershipBps: 0, verified: false }, { kind: 'owner' as const, ownershipBps: 5000, verified: true }, { kind: 'representative' as const, ownershipBps: 0, verified: false }] }
    expect(entityGaps(company)).toEqual([])
    expect(entityGaps({ ...company, fields: { ...company.fields, company_number: ' ' } })).toEqual(['field:company_number'])
    expect(entityGaps({ ...company, files: ['address_proof', 'structure_chart'] })).toEqual(['file:registration_proof'])
    expect(entityGaps({ ...company, parties: company.parties.filter((p) => p.kind !== 'director') })).toEqual(['party:director'])
    expect(entityGaps({ ...company, parties: company.parties.filter((p) => p.kind !== 'representative') })).toEqual(['party:representative'])
    expect(entityGaps({ ...company, parties: [company.parties[0]!, company.parties[2]!] })).toEqual(['party:beneficial_owner'])
    expect(entityGaps({ ...company, parties: [company.parties[0]!, company.parties[2]!, { kind: 'owner', ownershipBps: 5000, verified: false }] })).toEqual(['party:beneficial_owner_unverified'])
    const person = { type: 'individual' as const, fields: { full_name: 'A', address: 'a', tax_residence: 'UK', tax_id: '1' }, files: ['identity_proof', 'address_proof', 'source_of_wealth'], parties: [] }
    expect(entityGaps(person)).toEqual([])
    expect(entityGaps({ ...person, files: [] }).length).toBe(3)
  })
  it('TC-ENT-03 the account must be in the entity\'s name', () => {
    expect(sameHolder('ACME  Ltd.', 'Acme Ltd')).toBe(true)
    expect(sameHolder('Someone Else', 'Acme Ltd')).toBe(false)
    expect(sameHolder('', '')).toBe(false)
    // R-ENT-06: enough to pay into
    expect(bankDetailsGiven({})).toBe(false)
    expect(bankDetailsGiven({ iban: 'GB00' })).toBe(true)
    expect(bankDetailsGiven({ iban: '  ' })).toBe(false)
    expect(bankDetailsGiven({ sort_code: '11-22-33' })).toBe(false)
    expect(bankDetailsGiven({ account_number: '12345678' })).toBe(false)
    expect(bankDetailsGiven({ sort_code: '11-22-33', account_number: '12345678' })).toBe(true)
    expect(sameHolder('---', '...')).toBe(false)
  })
  it('a pass belongs to one identity version and ends on its date', () => {
    const c = { status: 'approved' as const, entityVersion: 2, expiresOn: '2029-01-01' }
    expect(kycPassed(c, 2, '2028-12-31')).toBe(true)
    expect(kycPassed(c, 2, '2029-01-01')).toBe(false)
    expect(kycPassed(c, 3, '2028-01-01')).toBe(false)
    expect(kycPassed(null, 1, '2028-01-01')).toBe(false)
    expect(kycPassed({ ...c, expiresOn: null }, 2, '2028-01-01')).toBe(false)
    expect(kycPassed({ ...c, status: 'returned' }, 2, '2028-01-01')).toBe(false)
    expect(entityStatus(c, 2, '2028-01-01')).toBe('passed')
    expect(entityStatus(c, 3, '2028-01-01')).toBe('to_do')
    expect(entityStatus(c, 2, '2030-01-01')).toBe('expired')
    expect(entityStatus(null, 1, '2028-01-01')).toBe('to_do')
    expect(entityStatus({ ...c, status: 'rejected' }, 3, '2028-01-01')).toBe('rejected')
    expect(entityStatus({ ...c, status: 'returned' }, 2, '2028-01-01')).toBe('returned')
    expect(entityStatus({ ...c, status: 'pending_review' }, 2, '2028-01-01')).toBe('in_review')
    expect(entityStatus({ ...c, status: 'in_progress' }, 2, '2028-01-01')).toBe('in_progress')
    expect(addYears('2026-11-06', 3)).toBe('2029-11-06')
    expect(addYears('2028-02-29', 3)).toBe('2031-02-28')
  })
  it('TC-KYC-02 a provider result never decides by itself', () => {
    expect(afterProviderDecision({ answer: 'GREEN' })).toEqual({ status: 'pending_review', suggestion: 'provider_green', returnReason: null })
    expect(afterProviderDecision({ answer: 'RED', rejectType: 'FINAL' })).toEqual({ status: 'pending_review', suggestion: 'provider_final', returnReason: null })
    expect(afterProviderDecision({ answer: 'RED', rejectType: 'RETRY', comment: 'Blurry' })).toEqual({ status: 'returned', suggestion: 'provider_retry', returnReason: 'Blurry' })
    expect(afterProviderDecision({ answer: 'RED', rejectType: 'RETRY' }).returnReason).toMatch(/check your documents/)
  })
  const base = { lastLogin: null, createdAt: new Date('2020-01-15T00:00:00Z'), deletionRequestedAt: null, relationshipEndedAt: null, retentionHold: false, hasOngoingRelationship: false }
  const cfg = { relationshipYears: 5, idleMonths: 24 }
  it('TC-KYC-03 the end date: the earliest of ended, asked to delete and idle; none while something is ongoing', () => {
    expect(relationshipEnd(base, 24)!.toISOString()).toBe('2022-01-15T00:00:00.000Z')
    expect(relationshipEnd({ ...base, lastLogin: new Date('2021-01-15T00:00:00Z') }, 24)!.toISOString()).toBe('2023-01-15T00:00:00.000Z')
    expect(relationshipEnd({ ...base, deletionRequestedAt: new Date('2021-01-01T00:00:00Z') }, 24)!.toISOString()).toBe('2021-01-01T00:00:00.000Z')
    expect(relationshipEnd({ ...base, relationshipEndedAt: new Date('2020-06-01T00:00:00Z') }, 24)!.toISOString()).toBe('2020-06-01T00:00:00.000Z')
    expect(relationshipEnd({ ...base, hasOngoingRelationship: true, deletionRequestedAt: new Date('2021-01-01T00:00:00Z') }, 24)).toBeNull()
  })
  it('TC-KYC-03 due exactly at the end of the years; never during a hold', () => {
    const asked = { ...base, createdAt: new Date('2026-01-01T00:00:00Z'), deletionRequestedAt: new Date('2026-01-01T00:00:00Z') }
    expect(retentionDue(asked, cfg, new Date('2030-12-31T23:59:59Z'))).toBe(false)
    expect(retentionDue(asked, cfg, new Date('2031-01-01T00:00:00Z'))).toBe(true)
    expect(retentionDue({ ...asked, retentionHold: true }, cfg, new Date('2040-01-01T00:00:00Z'))).toBe(false)
    expect(retentionDue({ ...asked, hasOngoingRelationship: true }, cfg, new Date('2040-01-01T00:00:00Z'))).toBe(false)
  })
})

describe('one-time codes', () => {
  const secret = Buffer.from('12345678901234567890')
  it('TC-ACC-02 RFC 6238 test vectors, and RFC 4648 base32', () => {
    expect(codeAt(secret, stepOf(59_000))).toBe('287082')
    expect(codeAt(secret, stepOf(1_111_111_109_000))).toBe('081804')
    expect(codeAt(secret, stepOf(2_000_000_000_000))).toBe('279037')
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    expect(base32(Buffer.from('f'))).toBe('MY')
    expect(otpauthUri('ABC', 'a@b')).toContain('secret=ABC')
  })
  it('TC-ACC-02 one step either way; used steps and anything else are refused', () => {
    const t = 1_700_000_000_000
    const s = stepOf(t)
    expect(matchStep(secret, codeAt(secret, s), t, null)).toBe(s)
    expect(matchStep(secret, codeAt(secret, s - 1), t, null)).toBe(s - 1)
    expect(matchStep(secret, codeAt(secret, s + 1), t, null)).toBe(s + 1)
    expect(matchStep(secret, codeAt(secret, s + 2), t, null)).toBeNull()
    expect(matchStep(secret, codeAt(secret, s - 2), t, null)).toBeNull()
    expect(matchStep(secret, codeAt(secret, s), t, s)).toBeNull()
    expect(matchStep(secret, codeAt(secret, s), t, s - 1)).toBe(s)
    for (const bad of ['', '12345', '1234567', 'abcdef']) expect(matchStep(secret, bad, t, null)).toBeNull()
  })
})

describe('Sumsub adapter', () => {
  const secretKey = 'app-secret'
  const webhookSecret = 'hook-secret'
  const make = (fetcher?: typeof fetch) => new SumsubKyc({ appToken: 'tok', secretKey, webhookSecret, levelName: 'basic level', fetch: fetcher, now: () => 1_607_551_635_000 })
  const sign = (body: string, algo = 'sha256', key = webhookSecret) => createHmac(algo, key).update(body).digest('hex')
  const hook = (o: object, headers?: Record<string, string>) => {
    const body = JSON.stringify(o)
    return { rawBody: Buffer.from(body), headers: headers ?? { 'x-payload-digest': sign(body), 'x-payload-digest-alg': 'HMAC_SHA256_HEX' } }
  }
  it('TC-KYC-01 signs requests as documented and reads the applicant id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const k = make((async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 'app1', url: 'https://in.sumsub.example/p/1' }), { status: 200 })
    }) as unknown as typeof fetch)
    expect(await k.start('ext1', 'a@example.test')).toEqual({ ref: 'app1' })
    expect(await k.link('ext1')).toBe('https://in.sumsub.example/p/1')
    const c = calls[0]!
    expect(c.url).toBe('https://api.sumsub.com/resources/applicants?levelName=basic%20level')
    const h = c.init.headers as Record<string, string>
    expect(h['X-App-Token']).toBe('tok')
    expect(h['X-App-Access-Ts']).toBe('1607551635')
    expect(h['X-App-Access-Sig']).toBe(createHmac('sha256', secretKey).update(`1607551635POST/resources/applicants?levelName=basic%20level${c.init.body}`).digest('hex'))
    const bad = make((async () => new Response('{}', { status: 500 })) as unknown as typeof fetch)
    await expect(bad.start('e', 'a@example.test')).rejects.toThrow(/answered 500/)
    const none = make((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch)
    await expect(none.start('e', 'a@example.test')).rejects.toThrow(/no applicant id/)
    await expect(none.link('e')).rejects.toThrow(/no link/)
  })
  it('TC-KYC-01 a webhook must carry a right signature over the raw bytes; weak or absent algorithms are refused', () => {
    const k = make()
    const event = { type: 'applicantReviewed', applicantId: 'a1', reviewResult: { reviewAnswer: 'GREEN' } }
    expect(k.parseWebhook(hook(event))).toEqual({ ref: 'a1', answer: 'GREEN' })
    const body = JSON.stringify(event)
    expect(k.parseWebhook(hook(event, { 'x-payload-digest': sign(body, 'sha512'), 'x-payload-digest-alg': 'HMAC_SHA512_HEX' }))).toEqual({ ref: 'a1', answer: 'GREEN' })
    expect(() => k.parseWebhook(hook(event, { 'x-payload-digest': sign(body, 'sha1'), 'x-payload-digest-alg': 'HMAC_SHA1_HEX' }))).toThrow(/signature/)
    expect(() => k.parseWebhook(hook(event, { 'x-payload-digest': sign(body, 'sha256', 'other'), 'x-payload-digest-alg': 'HMAC_SHA256_HEX' }))).toThrow(/wrong/)
    expect(() => k.parseWebhook(hook(event, {}))).toThrow(/missing/)
    expect(() => k.parseWebhook({ rawBody: Buffer.from(`${body} `), headers: { 'x-payload-digest': sign(body), 'x-payload-digest-alg': 'HMAC_SHA256_HEX' } })).toThrow(/wrong/)
  })
  it('TC-KYC-01 reads results, ignores other events, and never takes the private comment', () => {
    const k = make()
    expect(k.parseWebhook(hook({ type: 'applicantCreated', applicantId: 'a1' }))).toBeNull()
    expect(k.parseWebhook(hook({ type: 'applicantReviewed', applicantId: 'a1', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY', moderationComment: 'Blurry', clientComment: 'private note' } }))).toEqual({ ref: 'a1', answer: 'RED', rejectType: 'RETRY', comment: 'Blurry' })
    expect(k.parseWebhook(hook({ type: 'applicantReviewed', applicantId: 'a1', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL', clientComment: 'private note' } }))).toEqual({ ref: 'a1', answer: 'RED', rejectType: 'FINAL', comment: undefined })
    expect(() => k.parseWebhook(hook({ type: 'applicantReviewed', applicantId: 'a1', reviewResult: {} }))).toThrow(/without a result/)
    expect(() => k.parseWebhook(hook({ type: 'applicantReviewed', reviewResult: { reviewAnswer: 'GREEN' } }))).toThrow(/without an applicant/)
  })
})

describe('statement closed, words and limits', () => {
  const closed = { qualifies: false, expiresAt: new Date('2027-06-01T00:00:00Z'), category: 'neither', reopened: false }
  const f = (statement: EligibilityFacts['statement']): EligibilityFacts => ({ statement, needsReconfirm: false, attempts: [], coolingOff: null, fullName: 'A', personalisedWarning: null, warningBlockAcked: false })
  it('TC-ELG-02 a statement that does not qualify closes the step for its twelve months, unless reopened', () => {
    const at = new Date('2026-06-01T00:00:00Z')
    expect(statementClosed(f(closed), at)).toBe(true)
    expect(stepOpen(fpo, 'statement', f(closed), at)).toBe(false)
    expect(statementClosed(f({ ...closed, reopened: true }), at)).toBe(false)
    expect(stepOpen(fpo, 'statement', f({ ...closed, reopened: true }), at)).toBe(true)
    expect(statementClosed(f(closed), new Date('2027-06-01T00:00:00Z'))).toBe(false)
    expect(statementClosed(f(closed), new Date('2027-05-31T23:59:59Z'))).toBe(true)
    expect(statementClosed(f({ ...closed, qualifies: true }), at)).toBe(false)
    expect(statementClosed(f(null), at)).toBe(false)
    expect(isQualified(fpo, f(closed), at)).toBe(false)
  })
  it('TC-ELG-01 the FPO warning goes by category; other packs have one wording', () => {
    expect(warningVariant(fpo, 'sophisticated')).toBe('sophisticated')
    expect(warningVariant(fpo, 'high_net_worth')).toBe('high_net_worth')
    expect(warningVariant(cobs, 'sophisticated')).toBe('default')
    expect(warningVariant(fpo, undefined)).toBe('default')
  })
  it('TC-ELG-01 money typed in the form: whole pounds or nothing (§5.8)', () => {
    expect(wholePoundsToMinor('250000')).toBe('25000000')
    // a setting: nothing typed is not zero
    for (const bad of ['', '   ', '1.5', '-1', '1e3', '0x10', '1234567890']) expect(typedWhole(bad)).toBeNull()
    expect(typedWhole(' 0 ')).toBe(0)
    expect(typedWhole('12')).toBe(12)
    expect(wholePoundsToMinor('250,000')).toBe('25000000')
    expect(wholePoundsToMinor(' £1,250,000 ')).toBe('125000000')
    expect(wholePoundsToMinor('0')).toBe('0')
    for (const bad of ['50000.00', '-50000', '1,000.5', '', '1,00', '1e5', '12,3456', '£', '99999999999999', 'abc']) expect(wholePoundsToMinor(bad), bad).toBeNull()
  })
  it('TC-ENT-02 shares typed and shown in percent, with no floating point in the screens', () => {
    expect(percentToBps('25')).toBe(2500)
    expect(percentToBps('25.01')).toBe(2501)
    expect(percentToBps('25.1')).toBe(2510)
    expect(percentToBps('100')).toBe(10000)
    for (const bad of ['100.01', '-1', '25.001', 'x', '']) expect(percentToBps(bad), bad).toBeNull()
    expect(bpsToPercent(2500)).toBe('25')
    expect(bpsToPercent(2501)).toBe('25.01')
    expect(bpsToPercent(2510)).toBe('25.1')
    expect(bpsToPercent(5)).toBe('0.05')
  })
  it('TC-ELG-04 uk-cobs: the name comes before the warning, and the warning has a place for it', () => {
    const dropName = { ...cobs, steps: cobs.steps.filter((x) => x.kind !== 'capture_full_name') }
    expect(parsePack(dropName).errors.join()).toMatch(/full name before/)
    const noSlot = { ...cobs, legal_texts: cobs.legal_texts.map((t) => (t.text_key === 'personalised_warning' ? { ...t, body: 'No name here.' } : t)) }
    expect(parsePack(noSlot).errors.join()).toMatch(/must contain \{full_name\}/)
    expect(fillText('{full_name}: read this. {other}', { full_name: 'A $& B' })).toBe('A $& B: read this. {other}')
  })
  it('TC-ELG-05 the wording of each outcome is the pack\'s, and a pack without it does not load', () => {
    for (const key of ['not_qualified_notice', 'assessment_not_passed', 'assessment_retake_notice', 'preparation_overview', 'unsupported_categories']) {
      for (const pack of [fpo, cobs]) expect(parsePack({ ...pack, legal_texts: pack.legal_texts.filter((t) => t.text_key !== key) }).pack, key).toBeNull()
    }
    expect(parsePack({ ...fpo, legal_texts: fpo.legal_texts.filter((t) => t.text_key !== 'company_route_note') }).pack).toBeNull()
    expect(parsePack({ ...cobs, legal_texts: cobs.legal_texts.filter((t) => t.text_key !== 'question_director') }).pack).toBeNull()
    expect(parsePack({ ...fpo, legal_texts: fpo.legal_texts.filter((t) => t.text_key !== 'question_company_number') }).pack).toBeNull()
    expect(cobs.legal_texts.some((t) => t.text_key === 'question_company_number')).toBe(false)
    expect(parsePack({ ...cobs, legal_texts: cobs.legal_texts.filter((t) => t.text_key !== 'cooling_off_note') }).pack).toBeNull()
    expect(fpo.legal_texts.find((t) => t.text_key === 'company_route_note')!.body).toMatch(/art 49/)
    expect(fpo.legal_texts.find((t) => t.text_key === 'unsupported_categories')!.body).toMatch(/restricted or certified/)
  })
  it('TC-ELG-01 the numbers are the pack\'s: rounding, investments, months', () => {
    const p = { ...fpo, thresholds: { ...fpo.thresholds, income_rounding_minor: '500000', min_unlisted_investments: 3, network_months_over: 12 } }
    expect(judgeStatement(p, hnw('10500000')).qualifies).toBe(true)
    expect(judgeStatement(p, hnw('10100000')).problems.join()).toMatch(/nearest £5,000/)
    expect(judgeStatement(p, soph({ unlisted_investments: { yes: true, count: 2 } })).qualifies).toBe(false)
    expect(judgeStatement(p, soph({ unlisted_investments: { yes: true, count: 3 } })).qualifies).toBe(true)
    expect(judgeStatement(p, soph({ network_member: { yes: true, name: 'N', months: 12, still_member: true } })).qualifies).toBe(false)
    expect(judgeStatement(p, soph({ network_member: { yes: true, name: 'N', months: 13, still_member: true } })).qualifies).toBe(true)
    expect(minorToPounds(1_000_000n)).toBe('£10,000')
    expect(minorToPounds(100n)).toBe('£1')
    expect(minorToPounds(123_456_700n)).toBe('£1,234,567')
  })
  it('TC-ELG-04 a cobs pack cannot sign before the warning through a statement step', () => {
    const early = { ...cobs, steps: [{ kind: 'statement' as const, qualifying: true }, ...cobs.steps] }
    expect(parsePack(early).errors.join()).toMatch(/warning must come before statement/)
  })
  it('TC-OP-04 bold across lines is one phrase, to validation and to the screen', () => {
    const body = 'Read **first line\nsecond line** now'
    expect(textParts(body)).toEqual([{ text: 'Read ', bold: false }, { text: 'first line\nsecond line', bold: true }, { text: ' now', bold: false }])
    expect(textParts('plain only')).toEqual([{ text: 'plain only', bold: false }])
    const pack = { ...fpo, legal_texts: fpo.legal_texts.map((t) => (t.text_key === 'statement_sophisticated' ? { ...t, body, required_bold: ['first line\nsecond line'] } : t)) }
    expect(parsePack(pack).pack).not.toBeNull()
  })
  it('TC-ENT-02 a trust gives what a trust has: no company number, no director', () => {
    const trust = { type: 'trust' as const, fields: { name: 'T', registered_address: 'a', tax_residence: 'UK', tax_id: '1', source_of_wealth: 's' }, files: ['constitution_proof', 'address_proof', 'structure_chart'], parties: [{ kind: 'controller' as const, ownershipBps: 0, verified: true }, { kind: 'representative' as const, ownershipBps: 0, verified: false }] }
    expect(entityGaps(trust)).toEqual([])
    expect(entityGaps({ ...trust, type: 'other' })).toEqual([])
    expect(entityGaps({ ...trust, type: 'company' })).toEqual(expect.arrayContaining(['field:company_number', 'party:director', 'file:registration_proof']))
    expect(entityGaps({ ...trust, parties: [trust.parties[1]!] })).toContain('party:beneficial_owner')
  })
  it('TC-ENT-02 the owner threshold can be set', () => {
    const company = { type: 'company' as const, fields: { name: 'C', company_number: '1', registered_address: 'a', tax_residence: 'UK', tax_id: '1', source_of_wealth: 's' }, files: ['registration_proof', 'address_proof', 'structure_chart'], parties: [{ kind: 'director' as const, ownershipBps: 0, verified: false }, { kind: 'representative' as const, ownershipBps: 0, verified: false }, { kind: 'owner' as const, ownershipBps: 2000, verified: false }] }
    expect(entityGaps(company)).toContain('party:beneficial_owner')
    expect(entityGaps(company, 1000)).toEqual(['party:beneficial_owner_unverified'])
  })
  it('TC-ELG-04 only a wait as long as the pack asks counts', () => {
    const a = { startedAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-01-02T00:00:00Z') }
    expect(coolingOffCounts(a, 24)).toBe(true)
    expect(coolingOffCounts(a, 25)).toBe(false)
    expect(coolingOffCounts({ ...a, endsAt: a.startedAt }, 24)).toBe(false)
    expect(coolingOffCounts({ ...a, endsAt: a.startedAt }, 0)).toBe(true)
  })
  it('TC-ENT-02 uploads in flight are limited per person and overall', () => {
    const s = new UploadSlots(2, 3)
    expect(s.take('a')).toBe(true)
    expect(s.take('a')).toBe(true)
    expect(s.take('a')).toBe(false)
    expect(s.take('b')).toBe(true)
    expect(s.take('c')).toBe(false)
    s.give('a')
    expect(s.take('c')).toBe(true)
    s.give('nobody')
    expect(s.take('d')).toBe(false)
  })
  it('TC-ENT-02 the sandbox store has a limit, and removing a file makes room', async () => {
    const m = new MemoryStorage(10)
    await m.put('a', Buffer.alloc(6))
    await expect(m.put('b', Buffer.alloc(5))).rejects.toBeInstanceOf(StorageFull)
    await m.delete('a')
    await m.put('b', Buffer.alloc(10))
    await m.put('b', Buffer.alloc(4))
    await m.put('c', Buffer.alloc(6))
    expect(await m.get('c')).not.toBeNull()
  })
  it('TC-KYC-01 a partial Sumsub setting stops the start instead of being ignored', () => {
    expect(() => realAdaptersFromEnv({ SUMSUB_LEVEL_NAME: 'basic' })).toThrow(/only partly configured/)
    expect(realAdaptersFromEnv({ SUMSUB_LEVEL_NAME: '', SUMSUB_APP_TOKEN_FILE: '' }).kyc).toBeUndefined()
  })
})
