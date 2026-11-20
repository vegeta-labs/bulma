import { randomInt } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { commitmentRefusal, dueFor, linkFeeErrors, platformFee, type FeeConfig, type LinkFee } from './fees.ts'
import { expectedInvestment, leastInvestment, type EstimateInput } from './estimate.ts'
import { DEAL_SHEET_MAX_CHARS, dealSheetLength, renderDealSheet, SIGNED_LINE_MAX, signedSheetFits, type SheetValues } from './dealSheet.ts'
import { CODE_ALPHABET, REFERENCE_PATTERN, issueReference, memoMatches, newReference, normaliseReference } from './reference.ts'

const P = (pounds: string) => BigInt(pounds.replace(/[£,]/g, '').replace('.', '')) * (pounds.includes('.') ? 1n : 100n)
const pct = (bps: number, mode: 'on_top' | 'deducted' = 'on_top'): LinkFee => ({ kind: 'percent', bps, mode })
const fixed = (minor: bigint, mode: 'on_top' | 'deducted' = 'on_top'): LinkFee => ({ kind: 'fixed', minor, mode })
const STD: FeeConfig = { rate_bps: 250, min_minor: P('4,000'), max_minor: P('20,000'), surcharge_threshold_minor: P('5,000,000'), surcharge_bps: 10 }

describe('C-FEE-1 amount to pay', () => {
  it('TC-FEE-01 4% on top of £10,000', () => {
    expect(dueFor(P('10,000'), pct(400))).toEqual({ due: P('10,400'), invest: P('10,000'), leadFee: P('400'), rounding: 0n })
  })
  it('TC-FEE-02 4% on top of £333.33 leaves a penny of rounding', () => {
    expect(dueFor(P('333.33'), pct(400))).toEqual({ due: P('346.67'), invest: P('333.33'), leadFee: P('13.33'), rounding: 1n })
  })
  it('TC-FEE-03 £250 fixed on top', () => {
    expect(dueFor(P('10,000'), fixed(P('250')))).toEqual({ due: P('10,250'), invest: P('10,000'), leadFee: P('250'), rounding: 0n })
  })
  it('TC-FEE-04 4% taken from £10,000', () => {
    expect(dueFor(P('10,000'), pct(400, 'deducted'))).toEqual({ due: P('10,000'), invest: P('9,600'), leadFee: P('400'), rounding: 0n })
  })
  it('TC-FEE-05 4% taken from £333.33', () => {
    expect(dueFor(P('333.33'), pct(400, 'deducted'))).toEqual({ due: P('333.33'), invest: P('319.99'), leadFee: P('13.33'), rounding: 1n })
  })
  it('TC-FEE-06 £250 fixed taken from the payment; £250 itself is refused', () => {
    expect(dueFor(P('10,000'), fixed(P('250'), 'deducted'))).toMatchObject({ due: P('10,000'), invest: P('9,750') })
    expect(commitmentRefusal(P('250'), fixed(P('250'), 'deducted'), 0n)).toMatch(/Nothing would be invested/)
    expect(commitmentRefusal(P('250.01'), fixed(P('250'), 'deducted'), 0n)).toBeNull()
  })
  it('TC-FEE-07 the rate limit and the extreme rates', () => {
    expect(linkFeeErrors(pct(5001), 5000)).not.toEqual([])
    expect(linkFeeErrors(pct(2501), 2500)).not.toEqual([])
    expect(linkFeeErrors(pct(2500), 2500)).toEqual([])
    expect(linkFeeErrors(pct(5000), 5000)).toEqual([])
    expect(linkFeeErrors(pct(400), 5001)).not.toEqual([])
    expect(linkFeeErrors(pct(0), 5000)).not.toEqual([])
    expect(linkFeeErrors(fixed(0n), 5000)).not.toEqual([])
    expect(linkFeeErrors({ kind: 'none' }, 2500)).toEqual([])
    expect(dueFor(P('1,000.01'), pct(5000, 'deducted'))).toEqual({ due: P('1,000.01'), invest: P('500.00'), leadFee: P('500.00'), rounding: 1n })
    expect(dueFor(P('1,049.99'), pct(4999, 'deducted'))).toEqual({ due: P('1,049.99'), invest: P('525.09'), leadFee: P('524.88'), rounding: 2n })
  })
  it('TC-FEE-08 zero, negative, too large and nothing invested are refused', () => {
    expect(commitmentRefusal(0n, { kind: 'none' }, 0n)).not.toBeNull()
    expect(commitmentRefusal(-1n, { kind: 'none' }, 0n)).not.toBeNull()
    expect(commitmentRefusal(P('1,000,000,000'), { kind: 'none' }, 0n)).toBeNull()
    expect(commitmentRefusal(P('1,000,000,000.01'), { kind: 'none' }, 0n)).not.toBeNull()
    // D over the limit although C is not
    expect(commitmentRefusal(P('1,000,000,000'), pct(1), 0n)).toMatch(/to pay/)
    expect(commitmentRefusal(1n, pct(400, 'deducted'), 0n)).toMatch(/Nothing would be invested/)
  })
  it('TC-CMT-02 below the minimum is refused, the minimum itself is not', () => {
    expect(commitmentRefusal(P('999.99'), { kind: 'none' }, P('1,000'))).toMatch(/minimum/)
    expect(commitmentRefusal(P('1,000'), { kind: 'none' }, P('1,000'))).toBeNull()
  })
  it('TC-CMT-05 the breakdown always adds up to the amount to pay', () => {
    for (let i = 0; i < 5000; i++) {
      const c = BigInt(randomInt(1, 2 ** 40))
      const fees: LinkFee[] = [
        { kind: 'none' },
        pct(randomInt(1, 5001)),
        pct(randomInt(1, 5001), 'deducted'),
        fixed(BigInt(randomInt(1, 2 ** 30))),
        fixed(BigInt(randomInt(1, 2 ** 30)), 'deducted'),
      ]
      for (const f of fees) {
        const d = dueFor(c, f)
        expect(d.invest + d.leadFee + d.rounding).toBe(d.due)
        expect(d.rounding >= 0n && d.rounding <= 2n).toBe(true)
        if (f.kind !== 'none' && f.mode === 'deducted') expect(d.due).toBe(c)
        else expect(d.invest).toBe(c)
      }
    }
  })
})

describe('C-FEE-2 platform fee', () => {
  it.each([
    ['100,000', '4,000'],
    ['500,000', '12,500'],
    ['1,000,000', '20,000'],
    ['6,000,000', '21,000'],
  ])('TC-FEE-09 base £%s gives £%s', (b, fee) => {
    expect(platformFee(STD, P(b))).toBe(P(fee))
  })
})

describe('C-FEE-3 estimates', () => {
  const base = (over: Partial<EstimateInput>): EstimateInput => ({
    config: STD,
    payer: 'investors',
    allocation: P('300,000'),
    invest: P('10,000'),
    totalInvest: P('10,000'),
    stage: 'live',
    ...over,
  })

  it('TC-FEE-11 while live the fee at the target is spread over the target', () => {
    expect(expectedInvestment(base({}))).toEqual({ share: P('250'), expected: P('9,750') })
    expect(expectedInvestment(base({ totalInvest: P('400,000') }))).toEqual({ share: P('187.50'), expected: P('9,812.50') })
  })
  it('TC-FEE-11 from the close request the real total is used', () => {
    const at = (invest: string, total: string) => expectedInvestment(base({ stage: 'closing', invest: P(invest), totalInvest: P(total) })).share
    expect([at('60,000', '100,000'), at('40,000', '100,000')]).toEqual([P('2,400'), P('1,600')])
    expect([at('60,000', '200,000'), at('40,000', '200,000'), at('100,000', '200,000')]).toEqual([P('1,500'), P('1,000'), P('2,500')])
    expect(at('60,000', '60,000')).toBe(P('4,000'))
  })
  it('TC-FEE-11 the estimate is never negative', () => {
    expect(expectedInvestment(base({ stage: 'closing', invest: P('100'), totalInvest: P('100') }))).toEqual({ share: P('4,000'), expected: 0n })
  })
  it('TC-FEE-11 a lead or the company paying takes nothing from the investor', () => {
    expect(expectedInvestment(base({ payer: 'lead' }))).toEqual({ share: 0n, expected: P('10,000') })
    expect(expectedInvestment(base({ payer: 'company' }))).toEqual({ share: 0n, expected: P('10,000') })
  })

  const least = (invest: string, minRaise: string | null, over: Partial<FeeConfig> = {}, allocation = '300,000') =>
    leastInvestment({
      config: { ...STD, ...over },
      payer: 'investors',
      allocation: P(allocation),
      minRaise: minRaise === null ? null : P(minRaise),
      invest: P(invest),
    })

  it('TC-FEE-21 least possible investment, from the hand-worked cases', () => {
    expect(least('10,000', null)).toBe(P('5,999.99'))
    expect(least('10,000', '100,000')).toBe(P('9,599.99'))
    expect(least('3,000', null)).toBeNull()
    expect(least('4,000.01', null)).toBeNull()
    expect(least('10,000', null, { min_minor: 0n })).toBe(P('9,749.99'))
    expect(leastInvestment({ config: STD, payer: 'lead', allocation: P('300,000'), minRaise: null, invest: P('10,000') })).toBeNull()
  })
  it('TC-FEE-21 a person still gets at least £0.01 with £4,000.01 alone, although no number is shown', () => {
    const fee = platformFee(STD, P('4,000.01'))
    expect(P('4,000.01') - fee).toBe(1n)
  })
  it('TC-FEE-21 rounding: the real amount is not below the number shown', () => {
    const cfg = { ...STD, min_minor: 0n }
    const shown = least('10,000', null, { min_minor: 0n })!
    const ts = [P('10,000'), P('1,000.10'), P('1,000.10')]
    const b = ts.reduce((a, x) => a + x, 0n)
    const fee = platformFee(cfg, b)
    expect(fee).toBe(P('300.01'))
    const s = largestRemainder(fee, ts)
    expect(s[0]).toBe(P('250.01'))
    expect(ts[0]! - s[0]!).toBe(P('9,749.99'))
    expect(ts[0]! - s[0]!).toBeGreaterThanOrEqual(shown)
  })
  it('TC-FEE-21 oversubscription: a person alone over the target', () => {
    // the number assumes no scale-back; the screen says so (R-CMT-05.1)
    expect(least('200,000', null, {}, '100,000')).toBe(P('200,000') - P('5,000') - 1n)
  })
  it('TC-FEE-21 a surcharge makes the fee rate rise with the base: the upper end counts', () => {
    const cfg: Partial<FeeConfig> = { rate_bps: 100, min_minor: 0n, max_minor: P('1,000,000'), surcharge_threshold_minor: P('100,000'), surcharge_bps: 500 }
    // at £300,000: 1% + 5% of £200,000 = £3,000 + £10,000 = £13,000, a rate of 4.33%, above 1% at the lower end
    const got = least('10,000', null, cfg)!
    expect(got).toBe(P('10,000') - (P('13,000') * P('10,000') + P('300,000') - 1n) / P('300,000') - 1n)
  })
  it('TC-FEE-21 property: a full, valid allocation never gives less than the number shown', () => {
    let checked = 0
    for (let i = 0; i < 3000; i++) {
      const cfg: FeeConfig = {
        rate_bps: randomInt(0, 1001),
        min_minor: BigInt(randomInt(0, 2_000_000)),
        max_minor: 0n,
        surcharge_threshold_minor: BigInt(randomInt(0, 50_000_000)),
        surcharge_bps: randomInt(0, 600),
      }
      cfg.max_minor = cfg.min_minor + BigInt(randomInt(0, 5_000_000))
      const allocation = BigInt(randomInt(1, 50_000_000))
      const minRaise = randomInt(0, 2) ? BigInt(randomInt(1, Number(allocation) + 1)) : null
      const n = randomInt(1, 8)
      const ts = Array.from({ length: n }, () => BigInt(randomInt(1, 10_000_000)))
      const b = ts.reduce((a, x) => a + x, 0n)
      // valid: no scale-back and the minimum raise met
      if (b > allocation || (minRaise !== null && b < minRaise)) continue
      const fee = platformFee(cfg, b)
      if (fee > b) continue
      const s = largestRemainder(fee, ts)
      ts.forEach((t, k) => {
        const shown = leastInvestment({ config: cfg, payer: 'investors', allocation, minRaise, invest: t })
        if (shown === null) return
        checked++
        expect(t - s[k]!, JSON.stringify({ cfg: String(cfg.rate_bps), t: String(t), b: String(b) })).toBeGreaterThanOrEqual(shown)
      })
    }
    expect(checked).toBeGreaterThan(1000)
  })
})

/** C-FEE-3: the fee split in proportion to T, largest remainder, ties by joining order. A test helper; the real split is D5's. */
function largestRemainder(fee: bigint, ts: readonly bigint[]): bigint[] {
  const b = ts.reduce((a, x) => a + x, 0n)
  const floors = ts.map((t) => (fee * t) / b)
  let left = fee - floors.reduce((a, x) => a + x, 0n)
  const order = ts.map((t, i) => ({ i, r: (fee * t) % b })).sort((x, y) => (y.r > x.r ? 1 : y.r < x.r ? -1 : x.i - y.i))
  for (const o of order) {
    if (left === 0n) break
    floors[o.i]! += 1n
    left -= 1n
  }
  return floors
}

describe('C-REF-1 payment references', () => {
  it('TC-REF-01 10,000 references: the format, unique once normalised, each matches itself, no 0 O 1 I L', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i++) {
      const r = issueReference('AB', randomInt, (n) => seen.has(n))
      expect(r).toMatch(REFERENCE_PATTERN)
      expect(r).not.toMatch(/-.*[0O1IL]/)
      const n = normaliseReference(r)
      expect(n.length >= 8 && n.length <= 10).toBe(true)
      seen.add(n)
      expect(memoMatches(r, r)).toBe(true)
      expect(memoMatches(`spv ${r.toLowerCase()} payment`, r)).toBe(true)
    }
    expect(seen.size).toBe(10_000)
    expect(CODE_ALPHABET).not.toMatch(/[0O1IL]/)
  })
  it('TC-REF-01 Goten C-REC-1 and C-REC-2 examples', () => {
    expect(normaliseReference('nw-001')).toBe('NW001')
    expect(memoMatches('NW001 SPV', 'NW-001')).toBe(true)
    expect(memoMatches('nw 001', 'NW-001')).toBe(true)
    expect(memoMatches('NW-0019', 'NW-001')).toBe(false)
    expect(memoMatches('SS001É', 'SS-001')).toBe(false)
  })
  it('TC-REF-01 a prefix must be 2 to 4 letters', () => {
    expect(() => newReference('A', randomInt)).toThrow()
    expect(() => newReference('ABCDE', randomInt)).toThrow()
    expect(() => newReference('ab', randomInt)).toThrow()
    expect(newReference('ABCD', () => 0)).toBe('ABCD-AAAAAA')
  })
  it('TC-REF-01 a clash draws again, and gives up rather than reuse one', () => {
    let k = 0
    const seq = () => (k++ < 6 ? 0 : 1)
    expect(issueReference('AB', seq, (n) => n === 'ABAAAAAA')).toBe('AB-BBBBBB')
    expect(() =>
      issueReference(
        'AB',
        () => 0,
        () => true,
      ),
    ).toThrow()
  })
})

describe('R-SIG-02 deal sheet size', () => {
  const v = (custom: string): SheetValues => ({
    deal_code: 'ABC123',
    company_name: 'Co',
    instrument: 'equity',
    investor_name: 'Ann',
    entity_name: 'Ann',
    commitment: '£1',
    investment_part: '£1',
    lead_fee: '£0',
    rounding: '£0',
    breakdown: 'x',
    amount_to_pay: '£1',
    carry: '20%',
    fee_terms: 'none',
    reference: 'R',
    date: '2026-11-11',
    custom_terms: custom,
  })
  it('TC-SIG-02 the filled-in length is counted from the slots; one slot past the limit is refused before anything is built (Codex round 9)', () => {
    expect(dealSheetLength('Terms: {custom_terms} {unknown}', v('abc'))).toBe('Terms: abc {unknown}'.length)
    expect(renderDealSheet('Terms: {custom_terms}', v('abc'))).toBe('Terms: abc')
    // 6,000 slots of 199,000 characters would be over a billion characters
    expect(renderDealSheet('{custom_terms}'.repeat(6_000), v('x'.repeat(199_000)))).toBeNull()
    const at = 'x'.repeat(DEAL_SHEET_MAX_CHARS - 2)
    expect(renderDealSheet('{custom_terms}ab', v(at))).toHaveLength(DEAL_SHEET_MAX_CHARS)
    expect(renderDealSheet('{custom_terms}abc', v(at))).toBeNull()
  })
  it('TC-SIG-02 custom terms added at the end (no slot) count towards the limit (Codex round 10)', () => {
    expect(renderDealSheet('Sheet', v('abc'))).toBe('Sheet\n\nCustom terms of this deal:\nabc')
    expect(renderDealSheet('Sheet', v(''))).toBe('Sheet')
    const added = '\n\nCustom terms of this deal:\n'.length
    const terms = 'x'.repeat(DEAL_SHEET_MAX_CHARS - 'Sheet'.length - added)
    expect(renderDealSheet('Sheet', v(terms))).toHaveLength(DEAL_SHEET_MAX_CHARS)
    expect(renderDealSheet('Sheet', v(terms + 'x'))).toBeNull()
    // the Codex example: a template at the limit by itself, terms added after
    expect(renderDealSheet('{company_name}'.repeat(2000), { ...v('t'.repeat(140_000)), company_name: 'c'.repeat(200) })).toBeNull()
  })
  it('TC-SIG-02 a sheet is offered only when its warning, body and signature line fit one PDF (Codex round 11)', () => {
    // the signature line at its longest (a 200-character name) fits the room kept for it
    expect(`Signed by ${'n'.repeat(200)} on ${new Date(0).toISOString()}`.length).toBeLessThanOrEqual(SIGNED_LINE_MAX)
    const body = 'b'.repeat(DEAL_SHEET_MAX_CHARS)
    // the Codex example: a 100,121-character lead with a sheet at its own limit
    expect(signedSheetFits('l'.repeat(100_121), body, 500_000)).toBe(false)
    const room = 500_000 - DEAL_SHEET_MAX_CHARS - SIGNED_LINE_MAX
    expect(signedSheetFits('l'.repeat(room), body, 500_000)).toBe(true)
    expect(signedSheetFits('l'.repeat(room + 1), body, 500_000)).toBe(false)
  })
})
