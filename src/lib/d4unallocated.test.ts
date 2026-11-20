import { describe, expect, it } from 'vitest'
import { daysOpen, MAX_SUGGESTIONS, partsRefusal, sameName, STUCK_PAYMENT_HELP, suggestAllocation, type AllocationCandidate } from './unallocated.ts'

const cand = (participation: string, owed: bigint, names: string[], currency = 'GBP'): AllocationCandidate => ({
  participation,
  currency,
  owedMinor: owed,
  names,
})

describe('R-OPS-04 unallocated money', () => {
  it('TC-OPS-03 suggestions by amount and payer name across deals: both first, then amount, then name; same currency only; never "unknown"', () => {
    const row = { amountMinor: 985000n, currency: 'GBP', payerName: '  fay  FICTIONAL. ' }
    const out = suggestAllocation(row, [
      cand('name-only', 1n, ['Fay Fictional']),
      cand('amount-only', 985000n, ['Someone Else']),
      cand('both', 985000n, ['Other', 'Fay, Fictional']),
      cand('euro', 985000n, ['Fay Fictional'], 'EUR'),
      cand('neither', 985001n, ['Fay Fictionals']),
    ])
    expect(out).toEqual([
      { participation: 'both', byAmount: true, byName: true },
      { participation: 'amount-only', byAmount: true, byName: false },
      { participation: 'name-only', byAmount: false, byName: true },
    ])
    expect(suggestAllocation({ ...row, payerName: 'unknown' }, [cand('x', 1n, ['Unknown'])])).toEqual([])
    expect(suggestAllocation({ ...row, payerName: '' }, [cand('x', 1n, [''])])).toEqual([])
    const many = Array.from({ length: 9 }, (_, i) => cand(`p${i}`, 985000n, []))
    expect(suggestAllocation(row, many).map((s) => s.participation)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
    expect(MAX_SUGGESTIONS).toBe(5)
  })

  it('TC-OPS-03 split parts add up exactly (£5,000 + £4,850 = £9,850), a move takes at most the receipt, each part above 0 and to a different place', () => {
    const total = 985000n
    expect(
      partsRefusal(
        total,
        [
          { to: 'a', amount: 500000n },
          { to: 'b', amount: 485000n },
        ],
        true,
      ),
    ).toBeNull()
    expect(
      partsRefusal(
        total,
        [
          { to: 'a', amount: 500000n },
          { to: 'b', amount: 484999n },
        ],
        true,
      ),
    ).toMatch(/add up/)
    expect(
      partsRefusal(
        total,
        [
          { to: 'a', amount: 500000n },
          { to: 'b', amount: 485001n },
        ],
        true,
      ),
    ).toMatch(/add up/)
    expect(partsRefusal(total, [{ to: 'a', amount: 1n }], false)).toBeNull()
    expect(partsRefusal(total, [{ to: 'a', amount: total }], false)).toBeNull()
    expect(partsRefusal(total, [{ to: 'a', amount: total + 1n }], false)).toMatch(/more than/)
    expect(partsRefusal(total, [], true)).toMatch(/at least one/)
    expect(
      partsRefusal(
        total,
        [
          { to: 'a', amount: 0n },
          { to: 'b', amount: total },
        ],
        true,
      ),
    ).toMatch(/above 0/)
    expect(
      partsRefusal(
        total,
        [
          { to: 'a', amount: 1n },
          { to: 'a', amount: total - 1n },
        ],
        true,
      ),
    ).toMatch(/different place/)
    const twenty = Array.from({ length: 20 }, (_, i) => ({ to: `p${i}`, amount: 1n }))
    expect(partsRefusal(20n, twenty, true)).toBeNull()
    expect(partsRefusal(21n, [...twenty, { to: 'x', amount: 1n }], true)).toMatch(/At most 20/)
  })

  it('TC-OPS-03 days open are whole days; names compare without case, spaces, full stops or commas', () => {
    expect(daysOpen('2026-11-01T10:00:00Z', '2026-11-01T09:00:00Z')).toBe(0)
    expect(daysOpen('2026-11-01T10:00:00Z', '2026-11-02T09:59:59Z')).toBe(0)
    expect(daysOpen('2026-11-01T10:00:00Z', '2026-11-02T10:00:00Z')).toBe(1)
    expect(daysOpen('2026-11-01T10:00:00Z', '2026-11-11T10:00:00Z')).toBe(10)
    expect(sameName('J. Smith', 'j smith')).toBe(true)
    expect(sameName('J Smith', 'J Smyth')).toBe(false)
    expect(sameName('Unknown', 'unknown')).toBe(false)
  })

  it('TC-PAY-05 the trace text for a payment that has not arrived is Goten’s, word for word', () => {
    expect(STUCK_PAYMENT_HELP).toBe(
      'If you have already sent this payment, please ask your bank for the MT103 (or equivalent) for the transfer, showing its UETR, and send it to us so we can trace the payment.',
    )
  })
})
