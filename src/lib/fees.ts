// Fee configuration and platform fee (PRD R-OP-07, C-FEE-2). Pure; integer minor units and bps; no floating point.
export interface FeeConfig {
  rate_bps: number
  min_minor: bigint
  max_minor: bigint
  surcharge_threshold_minor: bigint
  surcharge_bps: number
}

const BPS = 10_000n
/** Largest value a Postgres bigint column holds. */
export const MAX_MINOR = 9_223_372_036_854_775_807n

/** floor(a × b ÷ d) for non-negative a, b and positive d. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (a < 0n || b < 0n || d <= 0n) throw new RangeError('mulDiv needs non-negative factors and a positive divisor')
  return (a * b) / d
}

/** a × b ÷ d rounded to the nearest integer, exact halves up (半数进位). */
export function mulDivHalfUp(a: bigint, b: bigint, d: bigint): bigint {
  if (a < 0n || b < 0n || d <= 0n) throw new RangeError('mulDivHalfUp needs non-negative factors and a positive divisor')
  return (2n * a * b + d) / (2n * d)
}

const validRate = (r: number) => Number.isInteger(r) && r >= 0 && r <= 10_000
const validAmount = (a: bigint) => a >= 0n && a <= MAX_MINOR

/** Every reason the configuration is refused; empty when valid. */
export function feeConfigErrors(c: FeeConfig): string[] {
  const errors: string[] = []
  if (!validRate(c.rate_bps)) errors.push('rate_bps must be a whole number from 0 to 10000')
  if (!validRate(c.surcharge_bps)) errors.push('surcharge_bps must be a whole number from 0 to 10000')
  for (const k of ['min_minor', 'max_minor', 'surcharge_threshold_minor'] as const) {
    if (!validAmount(c[k])) errors.push(`${k} must be from 0 to ${MAX_MINOR}`)
  }
  if (c.min_minor > c.max_minor) errors.push('the minimum fee must not be above the maximum fee')
  return errors
}

/**
 * C-FEE-2: fee = roundHalfUp(min(max, max(min, B × rate))) + roundHalfUp(max(0, B − threshold) × surcharge rate).
 * Clamping after rounding gives the same result as the PRD's order, because the limits are whole minor units.
 */
export function platformFee(c: FeeConfig, base: bigint): bigint {
  if (feeConfigErrors(c).length) throw new RangeError('invalid fee configuration')
  if (base > MAX_MINOR) throw new RangeError('the fee base is too large')
  const raw = mulDivHalfUp(base, BigInt(c.rate_bps), BPS)
  const clamped = raw < c.min_minor ? c.min_minor : raw > c.max_minor ? c.max_minor : raw
  const over = base > c.surcharge_threshold_minor ? base - c.surcharge_threshold_minor : 0n
  const fee = clamped + mulDivHalfUp(over, BigInt(c.surcharge_bps), BPS)
  if (fee > MAX_MINOR) throw new RangeError('the fee is too large to store')
  return fee
}

/** R-LNK-02: the highest cash fee rate an operator may allow on a link (50%). */
export const LINK_FEE_CEILING_BPS = 5_000
/** Goten I-01: the most a person can be asked to pay into one deal (£1,000,000,000). */
export const MAX_DUE_MINOR = 100_000_000_000n

export type FeeMode = 'on_top' | 'deducted'
/** A link's one-off cash fee (R-LNK-02, R-LNK-03). */
export type LinkFee = { kind: 'none' } | { kind: 'percent'; bps: number; mode: FeeMode } | { kind: 'fixed'; minor: bigint; mode: FeeMode }

/** R-LNK-02: every reason a link's fee is refused; empty when valid. `maxBps` is the operator's limit. */
export function linkFeeErrors(fee: LinkFee, maxBps: number): string[] {
  if (!Number.isInteger(maxBps) || maxBps < 0 || maxBps > LINK_FEE_CEILING_BPS) return ['The operator fee limit is not valid.']
  if (fee.kind === 'none') return []
  if (fee.mode !== 'on_top' && fee.mode !== 'deducted') return ['Choose how the fee is paid.']
  if (fee.kind === 'percent') {
    if (!Number.isInteger(fee.bps) || fee.bps < 1) return ['Give a fee rate above 0%.']
    return fee.bps > maxBps ? [`The fee rate must not be above ${Math.trunc(maxBps / 100)}.${String(maxBps % 100).padStart(2, '0')}%.`] : []
  }
  if (fee.kind === 'fixed')
    return fee.minor >= 1n && fee.minor <= MAX_DUE_MINOR ? [] : ['Give a fixed fee above 0 and no more than the largest amount allowed.']
  return ['Choose a fee.']
}

/**
 * C-FEE-1: what a person pays (D), what goes in before the platform fee (T), the lead's fee and the rounding difference,
 * from the commitment C. Always D = T + fee + rounding. The rounding is returned at close (C-FEE-1, Goten C-ALL-7).
 */
export interface Due {
  due: bigint
  invest: bigint
  leadFee: bigint
  rounding: bigint
}

export function dueFor(commitment: bigint, fee: LinkFee): Due {
  if (commitment < 1n) throw new RangeError('a commitment must be above 0')
  if (fee.kind === 'none') return { due: commitment, invest: commitment, leadFee: 0n, rounding: 0n }
  if (fee.kind === 'fixed') {
    if (fee.mode === 'on_top') return { due: commitment + fee.minor, invest: commitment, leadFee: fee.minor, rounding: 0n }
    const invest = commitment > fee.minor ? commitment - fee.minor : 0n
    return { due: commitment, invest, leadFee: commitment - invest, rounding: 0n }
  }
  if (!Number.isInteger(fee.bps) || fee.bps < 1 || fee.bps > LINK_FEE_CEILING_BPS) throw new RangeError('invalid fee rate')
  const bps = BigInt(fee.bps)
  if (fee.mode === 'on_top') {
    // ⌈C × (1 + f)⌉ = C + ⌈C × f⌉, so the person gets the amount they committed
    const due = commitment + (commitment * bps + BPS - 1n) / BPS
    const leadFee = mulDivHalfUp(commitment, bps, BPS)
    return { due, invest: commitment, leadFee, rounding: due - commitment - leadFee }
  }
  const invest = mulDiv(commitment, BPS - bps, BPS)
  const leadFee = mulDivHalfUp(invest, bps, BPS - bps)
  return { due: commitment, invest, leadFee, rounding: commitment - invest - leadFee }
}

/** R-CMT-02: why a commitment cannot be made, or null. `minimum` is the deal's minimum commitment. */
export function commitmentRefusal(commitment: bigint, fee: LinkFee, minimum: bigint): string | null {
  if (commitment < 1n) return 'Give an amount above 0.'
  if (commitment < minimum) return 'The amount is below the minimum for this deal.'
  if (commitment > MAX_DUE_MINOR) return 'The amount is above the largest allowed.'
  const d = dueFor(commitment, fee)
  if (d.due > MAX_DUE_MINOR) return 'The amount to pay is above the largest allowed.'
  if (d.invest < 1n) return 'Nothing would be invested after the fee.'
  return null
}
