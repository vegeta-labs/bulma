// Unallocated money and payment queries (PRD R-OPS-04, R-PAY-07, R-PAY-08). Pure; integer minor units, BigInt only.

/** R-PAY-07: a payment that has not arrived. Goten C-REC-8 template A, its second paragraph, word for word. */
export const STUCK_PAYMENT_HELP =
  'If you have already sent this payment, please ask your bank for the MT103 (or equivalent) for the transfer, showing its UETR, and send it to us so we can trace the payment.'

/** Names compared as people write them: case, spaces and full stops or commas do not matter. */
export function sameName(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  const x = n(a)
  return x !== '' && x !== 'unknown' && x === n(b)
}

export interface AllocationCandidate {
  participation: string
  currency: string
  /** D − N: what the person still has to pay; 0 or below when paid up. */
  owedMinor: bigint
  /** The entity's name and the holders of its confirmed bank accounts. */
  names: readonly string[]
}

export interface Suggestion {
  participation: string
  byAmount: boolean
  byName: boolean
}

export const MAX_SUGGESTIONS = 5

/**
 * R-OPS-04: suggestions across every deal by amount and payer name; only suggestions. Same currency only (a different one cannot
 * be allocated). Amount and name together first, then amount, then name; within each, in the order given.
 */
export function suggestAllocation(row: { amountMinor: bigint; currency: string; payerName: string }, candidates: readonly AllocationCandidate[]): Suggestion[] {
  const out: Suggestion[] = []
  for (const c of candidates) {
    if (c.currency !== row.currency) continue
    const byAmount = c.owedMinor === row.amountMinor
    const byName = c.names.some((n) => sameName(n, row.payerName))
    if (byAmount || byName) out.push({ participation: c.participation, byAmount, byName })
  }
  const rank = (s: Suggestion) => (s.byAmount && s.byName ? 0 : s.byAmount ? 1 : 2)
  return out
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.s)
}

export const MAX_PARTS = 20

/**
 * R-OPS-04: allocating whole or split. The parts must add up to the money exactly (TC-OPS-03), each above 0, each to a different
 * place. `exact` false is a move, which may take part of a receipt.
 */
export function partsRefusal(total: bigint, parts: ReadonlyArray<{ to: string; amount: bigint }>, exact: boolean): string | null {
  if (parts.length === 0) return 'Give at least one part.'
  if (parts.length > MAX_PARTS) return `At most ${MAX_PARTS} parts.`
  if (parts.some((p) => p.amount < 1n)) return 'Every part must be above 0.'
  if (new Set(parts.map((p) => p.to)).size !== parts.length) return 'Each part must go to a different place.'
  const sum = parts.reduce((s, p) => s + p.amount, 0n)
  if (exact && sum !== total) return 'The parts must add up to the amount exactly.'
  if (!exact && sum > total) return 'The parts add up to more than the receipt.'
  return null
}

/** R-OPS-04: whole days since the money was listed. */
export function daysOpen(listedAt: string, now: string): number {
  const ms = Date.parse(now) - Date.parse(listedAt)
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000)
}
