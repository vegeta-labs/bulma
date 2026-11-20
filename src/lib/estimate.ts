// Estimates shown before close (PRD C-FEE-3, R-CMT-05, R-CMT-05.1). Pure; integer minor units and exact fractions, no floating
// point. Until decision J's engine change, everything here is labelled an estimate; only the amount to pay (C-FEE-1) is exact.
import { feeConfigErrors, MAX_MINOR, mulDivHalfUp, platformFee, type FeeConfig } from './fees.ts'

export type FeePayer = 'investors' | 'lead' | 'company'

/** Whether the deal is still taking commitments, or a close has been asked for (the estimate then uses the real total). */
export type EstimateStage = 'live' | 'closing'

export interface EstimateInput {
  config: FeeConfig
  payer: FeePayer
  /** SPV allocation (the target). */
  allocation: bigint
  /** This person's T (C-FEE-1). */
  invest: bigint
  /** Σ T of every active participation, this one included. */
  totalInvest: bigint
  stage: EstimateStage
}

/** C-FEE-3: the expected investment after the platform fee. Never below 0. A lead or the company paying takes nothing here. */
export function expectedInvestment(i: EstimateInput): { share: bigint; expected: bigint } {
  if (i.invest < 1n) throw new RangeError('nothing is invested')
  if (i.totalInvest < i.invest) throw new RangeError('the total cannot be below this person')
  if (i.allocation < 0n) throw new RangeError('the allocation cannot be negative')
  if (i.payer !== 'investors') return { share: 0n, expected: i.invest }
  // live: the fee at the target, spread over the target or the real total if larger, so no one carries the minimum fee alone
  const live = i.stage === 'live'
  const base = live ? i.allocation : i.allocation < i.totalInvest ? i.allocation : i.totalInvest
  const denominator = live ? (i.allocation > i.totalInvest ? i.allocation : i.totalInvest) : i.totalInvest
  const fee = platformFee(i.config, base)
  const share = mulDivHalfUp(fee, i.invest, denominator)
  return { share, expected: share >= i.invest ? 0n : i.invest - share }
}

/** A non-negative fraction n / d with d > 0. */
interface Fraction {
  n: bigint
  d: bigint
}
const frac = (n: bigint, d = 1n): Fraction => ({ n, d })
const add = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d })
const sub = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d })
const mul = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.n, d: a.d * b.d })
const div = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d, d: a.d * b.n })
const less = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d
const ceil = (a: Fraction) => (a.n + a.d - 1n) / a.d

const BPS = frac(10_000n)

/** The platform fee before rounding, at an exact base (C-FEE-2). */
function rawFee(c: FeeConfig, b: Fraction): Fraction {
  const byRate = div(mul(b, frac(BigInt(c.rate_bps))), BPS)
  const min = frac(c.min_minor)
  const max = frac(c.max_minor)
  const clamped = less(byRate, min) ? min : less(max, byRate) ? max : byRate
  const t = frac(c.surcharge_threshold_minor)
  const over = less(t, b) ? sub(b, t) : frac(0n)
  return add(clamped, div(mul(over, frac(BigInt(c.surcharge_bps))), BPS))
}

export interface LeastInput {
  config: FeeConfig
  payer: FeePayer
  allocation: bigint
  /** Minimum raise, or null when the deal has none. */
  minRaise: bigint | null
  invest: bigint
}

/**
 * R-CMT-05.1, C-FEE-3: the least this person can end up with, or null when no positive amount can be promised. The base runs
 * from max(T, minimum raise) to max(that, allocation). Between the fee's turning points fee(B) ÷ B is a + b ÷ B, so it is
 * monotone, and its largest value is at an end or a turning point. The bound adds a penny for rounding: the fee's two
 * half-up roundings add at most one penny, and the largest-remainder share is never above the share rounded up.
 * Returns null as well when a lead or the company pays: that row is not shown.
 */
export function leastInvestment(i: LeastInput): bigint | null {
  if (i.invest < 1n) throw new RangeError('nothing is invested')
  if (i.payer !== 'investors') return null
  if (feeConfigErrors(i.config).length) throw new RangeError('invalid fee configuration')
  const lo = i.minRaise !== null && i.minRaise > i.invest ? i.minRaise : i.invest
  const hi = i.allocation > lo ? i.allocation : lo
  const points: Fraction[] = [frac(lo), frac(hi)]
  const c = i.config
  if (c.rate_bps > 0) {
    points.push(frac(c.min_minor * 10_000n, BigInt(c.rate_bps)), frac(c.max_minor * 10_000n, BigInt(c.rate_bps)))
  }
  points.push(frac(c.surcharge_threshold_minor))
  const inRange = points.filter((p) => !less(p, frac(lo)) && !less(frac(hi), p) && p.n > 0n)
  let most = frac(0n)
  for (const b of inRange) {
    const share = div(mul(rawFee(c, b), frac(i.invest)), b)
    if (less(most, share)) most = share
  }
  const bound = ceil(most) + 1n
  return bound >= i.invest ? null : i.invest - bound
}

/** R-ADM-03's answer: how much to raise so that `target` reaches the company, the platform fee on that, and what is left. */
export interface RaiseFor {
  payer: FeePayer
  /** Σ T to raise (C-FEE-2's base B). */
  raise: bigint
  fee: bigint
  /** What reaches the company: raise − fee when investors or the company pay, the raise when the lead pays (the lead adds the fee). */
  net: bigint
}

/**
 * R-ADM-03 (decision R28 (7)): the net calculator, platform fee and surcharge only, an estimate. When investors pay, the
 * smallest B with B − fee(B) ≥ target, and the same when the company pays (C-FEE-3: the fee comes out of what is paid to
 * the company); when the lead pays, B = target and the fee is the lead's on top. Null when
 * no B can be promised (rate and surcharge rate together 100% or more, or past the largest stored amount).
 * Between turning points B − rawFee(B) rises with slope at least 1 − (rate + surcharge rate) > 0, and the two half-up roundings
 * move the fee by at most a penny, so the answer lies between the first B with B − rawFee ≥ target − 1 and the first with
 * B − rawFee ≥ target + 1: found by bisection on the exact fraction, then a walk over the rounded fee.
 */
export function raiseFor(config: FeeConfig, payer: FeePayer, target: bigint): RaiseFor | null {
  if (target < 1n) throw new RangeError('the target must be positive')
  if (feeConfigErrors(config).length) throw new RangeError('invalid fee configuration')
  if (target > MAX_TARGET) return null
  // C-FEE-3: a lead pays the fee on top; when the company pays, it comes out of what is paid to the company, as for investors
  if (payer === 'lead') return { payer, raise: target, fee: platformFee(config, target), net: target }
  if (config.rate_bps + config.surcharge_bps >= 10_000) return null
  const netRaw = (b: bigint) => sub(frac(b), rawFee(config, frac(b)))
  const first = (goal: bigint) => {
    let lo = 0n
    let hi = MAX_MINOR
    if (less(netRaw(hi), frac(goal < 0n ? 0n : goal))) return null
    while (lo < hi) {
      const mid = (lo + hi) / 2n
      if (less(netRaw(mid), frac(goal < 0n ? 0n : goal))) lo = mid + 1n
      else hi = mid
    }
    return lo
  }
  // up to the largest stored amount; when even that does not reach target + 1 the answer, if any, lies between `from` and it,
  // a short walk since B − rawFee(B) still rises by at least 1 − (rate + surcharge rate) a penny
  const from = first(target - 1n)
  if (from === null) return null
  const to = first(target + 1n) ?? MAX_MINOR
  for (let b = from; b <= to; b++) {
    const fee = platformFee(config, b)
    if (b - fee >= target) return { payer, raise: b, fee, net: b - fee }
  }
  return null
}

/** The largest target the calculator takes: Goten I-01's most one person may pay, a hundred times over. */
export const MAX_TARGET = 10_000_000_000_000n
