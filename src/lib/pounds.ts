// Reads a figure typed as whole pounds (§5.8). Used by the statement form; the server still judges the result.

/** Minor units as a string, or null for anything but whole pounds: "250,000" and "£250000" read, "50000.00", "-1" and "1,000.5" do not. */
/** A whole number typed into a form, or null. `Number('   ')` is 0, which in a setting means something quite different from nothing typed. */
export function typedWhole(typed: string): number | null {
  const t = typed.trim()
  return /^\d{1,9}$/.test(t) ? Number(t) : null
}

export function wholePoundsToMinor(typed: string): string | null {
  const t = typed.trim().replace(/^£/, '')
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(t)) return null
  const pounds = t.replaceAll(',', '')
  if (pounds.length > 13) return null
  return String(BigInt(pounds) * 100n)
}

/** A share typed as a percentage, up to two decimals, as basis points: "25" and "25.01" read; anything over 100 does not. */
export function percentToBps(typed: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(typed.trim())
  if (!m) return null
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return bps <= 10_000 ? bps : null
}

export function bpsToPercent(bps: number): string {
  const part = String(bps % 100).padStart(2, '0').replace(/0+$/, '')
  return `${Math.floor(bps / 100)}${part ? `.${part}` : ''}`
}

/** A share price as typed, up to six decimals, as micros in a string: "0.015" reads "15000". Exact: no floating point (tech design §3). */
export function priceToMicros(typed: string): string | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(typed.trim())
  if (!m) return null
  return String(BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0'))
}

/** Micros back to the shortest exact price, at least two decimals: 15000n reads "0.015", 1000000n reads "1.00". */
export function microsToPrice(micros: bigint): string {
  const part = String(micros % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')
  return `${micros / 1_000_000n}.${part}`
}

/** Minor units as whole pounds for a sentence: 1000000n reads "£10,000". */
export function minorToPounds(minor: bigint): string {
  return `£${withCommas(String(minor / 100n))}`
}

const noLeadingZeros = (digits: string) => digits.replace(/^0+(?=\d)/, '')
const withCommas = (digits: string) => digits.replace(/\B(?=(\d{3})+$)/g, ',')

/**
 * An amount in a deal draft, as the draft keeps it: minor units for anything that reads as money, whatever its size, so that the
 * draft rules give the one answer about limits. Blank is absent, never 0. Anything else stays as typed: it always holds a character
 * that is not a digit, so it can never be read as an amount, and the review page says what is wrong with it.
 */
export function typedAmountToDraft(typed: string): string | null {
  const raw = typed.trim()
  if (!raw) return null
  const m = /^((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?$/.exec(raw)
  if (!m) return raw
  return noLeadingZeros(`${m[1]!.replaceAll(',', '')}${(m[2] ?? '').padEnd(2, '0')}`)
}

/** What the amount field shows for a stored value: "100000" reads "1,000", "12345" reads "123.45". Text kept as typed comes back as typed. */
export function draftAmountToTyped(v: unknown): string {
  if (typeof v !== 'string') return ''
  if (!/^\d+$/.test(v)) return v
  const padded = v.padStart(3, '0')
  const pence = padded.slice(-2)
  const whole = withCommas(noLeadingZeros(padded.slice(0, -2)))
  return pence === '00' ? whole : `${whole}.${pence}`
}

/** A share price in a draft, as micros. The same promise as `typedAmountToDraft`: exact, blank is absent, and what cannot be read stays as typed. */
export function typedPriceToDraft(typed: string): string | null {
  const raw = typed.trim()
  if (!raw) return null
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw)
  if (!m) return raw
  return noLeadingZeros(`${m[1]}${(m[2] ?? '').padEnd(6, '0')}`)
}

export function draftPriceToTyped(v: unknown): string {
  if (typeof v !== 'string') return ''
  return /^\d+$/.test(v) ? microsToPrice(BigInt(v)) : v
}

/** A percentage a draft cannot read: out of every range the rules allow, so the rule for that field is the one that answers. */
export const UNREADABLE_PERCENT = -1

/** A draft percentage field holds a number or nothing, so text that cannot be read is kept as a value the rules refuse, not as blank. */
export function typedPercentToDraft(typed: string): number | null {
  if (!typed.trim()) return null
  return percentToBps(typed) ?? UNREADABLE_PERCENT
}

export function draftPercentToTyped(v: unknown): string {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? bpsToPercent(v) : ''
}
