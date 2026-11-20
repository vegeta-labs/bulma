import { describe, expect, it } from 'vitest'
import type { LinkFee } from './fees.ts'
import {
  isLateMoney,
  refundExceptions,
  refundReason,
  acceptProposalRefusal,
  applyMoney,
  capacity,
  EMPTY_LEDGER,
  figures,
  holdStepAfter,
  holdStepAllowed,
  largestCommitmentWithin,
  leadFeeOn,
  leadMetrics,
  movable,
  operatorMetrics,
  proposalRefusal,
  refundCap,
  scaleBack,
  type Ledger,
  type MoneyEvent,
  type Position,
  type Settlement,
} from './money.ts'

const P = (pounds: string) => BigInt(pounds.replace(/[£,]/g, '').replace('.', '')) * (pounds.includes('.') ? 1n : 100n)
const pct = (bps: number, mode: 'on_top' | 'deducted' = 'on_top'): LinkFee => ({ kind: 'percent', bps, mode })
const fixed = (minor: bigint, mode: 'on_top' | 'deducted' = 'on_top'): LinkFee => ({ kind: 'fixed', minor, mode })
const NONE: LinkFee = { kind: 'none' }

const HELD: Position = { outcome: 'rejected_kyc', due: P('10,000') }
const ACTIVE = (due: string): Position => ({ outcome: 'active', due: P(due) })

/** Applies events in order; every one must be accepted. Short names keep the PRD sequences readable. */
function run(p: Position, events: MoneyEvent[], start: Ledger = EMPTY_LEDGER, s?: Settlement): Ledger {
  let l = start
  for (const e of events) {
    const r = applyMoney(l, e, p, s)
    if (!r.ok) throw new Error(`${e.kind} refused: ${r.reason}`)
    l = r.ledger
  }
  return l
}
const refused = (l: Ledger, e: MoneyEvent, p: Position, s?: Settlement) => {
  const r = applyMoney(l, e, p, s)
  return r.ok ? null : r.reason
}
const rx = (id: string, amount: string): MoneyEvent => ({ kind: 'receive', id, amount: P(amount) })
const rel = (receipt: string, amount: string): MoneyEvent => ({ kind: 'release', receipt, amount: P(amount), basis: 'no disclosure needed' })
const approve = (id: string, amount: string): MoneyEvent => ({ kind: 'approve_refund', id, amount: P(amount) })
const record = (refund: string | null, actual: string, id = `rec-${refund}`): MoneyEvent => ({ kind: 'record_refund', refund, id, actual: P(actual) })
const cancel = (refund: string): MoneyEvent => ({ kind: 'cancel_refund', refund })
const reverse = (receipt: string): MoneyEvent => ({ kind: 'reverse', receipt })
const pick = (l: Ledger, p: Position = HELD, s?: Settlement) => {
  const f = figures(l, p, s)
  return { N: f.onHand, R: f.usable, H: f.hold, due: f.refundDue }
}

describe('C-FEE-4 lead fee and usable gross', () => {
  it('TC-FEE-17 4% on top, D £10,400: received £10,400 / £5,200 / £11,000', () => {
    const row = (got: string) => figures(run(ACTIVE('10,400'), [rx('a', got)]), ACTIVE('10,400'))
    for (const [got, fee, gross, due] of [
      ['10,400', '400', '10,000', '0'],
      ['5,200', '200', '5,000', '0'],
      ['11,000', '400', '10,000', '600'],
    ] as const) {
      const f = row(got)
      expect(leadFeeOn(f.effective, pct(400))).toBe(P(fee))
      expect(f.effective - leadFeeOn(f.effective, pct(400))).toBe(P(gross))
      expect(f.refundDue).toBe(P(due))
    }
  })
  it('TC-FEE-18 fixed £250: received £5,125 → fee 250, gross 4,875; £200 → fee 0, gross 200', () => {
    expect(leadFeeOn(P('5,125'), fixed(P('250')))).toBe(P('250'))
    expect(leadFeeOn(P('200'), fixed(P('250')))).toBe(0n)
    expect(leadFeeOn(P('250'), fixed(P('250')))).toBe(0n)
    expect(leadFeeOn(P('250.01'), fixed(P('250'), 'deducted'))).toBe(P('250'))
  })
  it('TC-FEE-17 percent taken from the payment follows Goten C-ALL-6 and C-ALL-7', () => {
    expect(leadFeeOn(P('10,000'), pct(400, 'deducted'))).toBe(P('400'))
    expect(leadFeeOn(P('333.33'), pct(400, 'deducted'))).toBe(P('13.33'))
    expect(leadFeeOn(0n, pct(400))).toBe(0n)
    expect(leadFeeOn(1n, pct(400))).toBe(0n)
    expect(leadFeeOn(P('10,000'), NONE)).toBe(0n)
    // exactly half a penny: E = 5p at 50% on top, I = 3p, fee 1.5p rounds half up to 2p, and I + fee is E exactly
    expect(leadFeeOn(5n, pct(5000))).toBe(2n)
    // the fee is never negative and never more than E (I is E less the fee)
    for (let e = 1n; e < 3000n; e += 7n) {
      for (const f of [pct(400), pct(400, 'deducted'), pct(5000), pct(5000, 'deducted'), pct(1)]) {
        const fee = leadFeeOn(e, f)
        expect(fee).toBeGreaterThanOrEqual(0n)
        expect(fee).toBeLessThanOrEqual(e)
      }
    }
  })
  it('TC-FEE-17 R-ADM-02 lead metrics: commitments of active people, all money received, held people only as operator handling', () => {
    const a = ACTIVE('10,400')
    const rows = [
      { outcome: 'active' as const, commitment: P('10,000'), fee: pct(400), figures: figures(run(a, [rx('a', '11,000')]), a) },
      {
        outcome: 'withdrawn' as const,
        commitment: P('5,000'),
        fee: NONE,
        figures: figures(run(a, [rx('b', '5,000')]), { outcome: 'withdrawn', due: P('5,000') }),
      },
      { outcome: 'rejected_kyc' as const, commitment: P('10,000'), fee: NONE, figures: figures(run(HELD, [rx('c', '10,000'), rel('c', '4,000')]), HELD) },
    ]
    const m = leadMetrics(rows)
    expect(m).toEqual({
      committed: P('10,000'),
      received: P('26,000'),
      refundDue: P('600') + P('5,000'),
      refunded: 0n,
      operatorHandling: P('10,000'),
      leadFees: P('400'),
      usableGross: P('10,000'),
      needsCheck: 0,
    })
    expect(Object.keys(m).some((k) => /hold/i.test(k))).toBe(false)
    const o = operatorMetrics(rows)
    expect(o.hold).toBe(P('6,000'))
    expect(o.heldRefundDue).toBe(P('4,000'))
  })
})

describe('C-FEE-4 refunds and money on hand', () => {
  it('TC-FEE-19 withdrawn £10,000: E 0, refund due £10,000; recorded → 0', () => {
    const w: Position = { outcome: 'withdrawn', due: P('10,000') }
    const l = run(w, [rx('a', '10,000')])
    expect(figures(l, w)).toMatchObject({ effective: 0n, refundDue: P('10,000') })
    const done = run(w, [approve('r1', '10,000'), { kind: 'send_refund', refund: 'r1' }, record('r1', '10,000')], l)
    expect(figures(done, w)).toMatchObject({ onHand: 0n, refundDue: 0n, refunded: P('10,000') })
  })
  it('TC-FEE-19 no fee, D £10,000, received £11,000, refund £1,000, raise to £11,000 → E £10,000, £1,000 short', () => {
    const l = run(ACTIVE('10,000'), [rx('a', '11,000'), approve('r', '1,000'), record('r', '1,000')])
    expect(figures(l, ACTIVE('10,000'))).toMatchObject({ onHand: P('10,000'), effective: P('10,000'), refundDue: 0n })
    const raised = figures(l, ACTIVE('11,000'))
    expect(raised.effective).toBe(P('10,000'))
    expect(P('11,000') - raised.onHand).toBe(P('1,000'))
  })
  it('TC-FEE-19 a receipt reversed after a refund gives N < 0: needs check, not 0', () => {
    const p = ACTIVE('10,000')
    const l = run(p, [rx('a', '11,000'), approve('r', '1,000'), record('r', '1,000'), reverse('a'), rx('b', '500')])
    const f = figures(l, p)
    expect(f.onHand).toBe(-P('500'))
    expect(f.needsCheck).toBe(true)
    expect(f.refundDue).toBeNull()
    expect(refused(l, approve('r2', '1'), p)).toMatch(/checking/)
    expect(refundCap(l, p)).toBe(0n)
    expect(movable(l, p)).toBe(0n)
    expect(refused(l, { kind: 'move_out', receipt: 'b', amount: 1n }, p)).toMatch(/checking/)
  })
  it('TC-FEE-19 overpaid → withdrawn → part refund → late money: always one obligation with the right total', () => {
    const l1 = run(ACTIVE('10,000'), [rx('a', '12,000')])
    expect(figures(l1, ACTIVE('10,000')).refundDue).toBe(P('2,000'))
    const w: Position = { outcome: 'withdrawn', due: P('10,000') }
    expect(figures(l1, w).refundDue).toBe(P('12,000'))
    const l2 = run(w, [approve('r', '5,000'), record('r', '5,000'), rx('late', '3,000')], l1)
    expect(figures(l2, w).refundDue).toBe(P('10,000'))
    expect(refused(l2, approve('r2', '10,000.01'), w)).toMatch(/more than/)
  })
  it('TC-FEE-23 in flight: approval £1,000 counts against N; cancel returns it; a sent refund needs recall evidence', () => {
    const p = ACTIVE('10,000')
    const l = run(p, [rx('a', '11,000'), approve('r', '1,000')])
    expect(figures(l, p).onHand).toBe(P('10,000'))
    expect(P('11,000') - figures(l, ACTIVE('11,000')).onHand).toBe(P('1,000'))
    expect(figures(run(p, [cancel('r')], l), p).onHand).toBe(P('11,000'))
    const sent = run(p, [{ kind: 'send_refund', refund: 'r' }], l)
    expect(refused(sent, cancel('r'), p)).toMatch(/evidence/)
    const back = run(p, [{ kind: 'cancel_refund', refund: 'r', recallEvidence: 'bank recall reference 991' }], sent)
    expect(figures(back, p).onHand).toBe(P('11,000'))
  })
  it('TC-FEE-23 one refund in flight at a time; recorded refunds are never refused', () => {
    const p = ACTIVE('10,000')
    const l = run(p, [rx('a', '13,000'), approve('r', '1,000')])
    expect(refused(l, approve('r2', '1,000'), p)).toMatch(/already in progress/)
    // more or less than approved, or with no approval at all: recorded as it happened
    const l2 = run(p, [record('r', '1,500'), record(null, '200', 'manual')], l)
    expect(figures(l2, p).onHand).toBe(P('11,300'))
  })
  it('TC-FEE-19 after settled the cap follows the confirmed allocation', () => {
    const p = ACTIVE('200,000')
    const l = run(p, [rx('a', '200,000')])
    expect(figures(l, p).refundDue).toBe(0n)
    const s: Settlement = { settled: true, allocatedCash: P('100,000') }
    expect(figures(l, p, s).refundDue).toBe(P('100,000'))
    expect(refused(l, approve('r', '100,000.01'), p, s)).toMatch(/more than/)
    expect(movable(l, p, s)).toBe(P('100,000'))
  })
})

describe('C-FEE-4 and R-KYC-02.1 money held for a rejected person', () => {
  it('TC-FEE-22 received £50,000: H £50,000, nothing due, no refund; release → due £50,000; refund all, then £10,000 more is held', () => {
    const l = run(HELD, [rx('a', '50,000')])
    expect(pick(l)).toEqual({ N: P('50,000'), R: 0n, H: P('50,000'), due: 0n })
    expect(refused(l, approve('r', '1'), HELD)).toMatch(/more than/)
    const l2 = run(HELD, [rel('a', '50,000')], l)
    expect(pick(l2)).toEqual({ N: P('50,000'), R: P('50,000'), H: 0n, due: P('50,000') })
    const l3 = run(HELD, [approve('r', '50,000'), record('r', '50,000'), rx('b', '10,000')], l2)
    expect(pick(l3).H).toBe(P('10,000'))
  })
  it('TC-FEE-22 refunded before rejection (got £11,000, refunded £1,000): H £10,000; release £10,000 → due £10,000', () => {
    const before = run(ACTIVE('10,000'), [rx('a', '11,000'), approve('r', '1,000'), record('r', '1,000')])
    expect(pick(before).H).toBe(P('10,000'))
    expect(pick(run(HELD, [rel('a', '10,000')], before))).toEqual({ N: P('10,000'), R: P('10,000'), H: 0n, due: P('10,000') })
  })
  it('TC-FEE-22 released, then moved away whole, then new money: new money is held', () => {
    const l = run(HELD, [rx('a', '10,000'), rel('a', '10,000'), { kind: 'move_out', receipt: 'a', amount: P('10,000') }, rx('b', '10,000')])
    expect(pick(l)).toEqual({ N: P('10,000'), R: 0n, H: P('10,000'), due: 0n })
  })
  it('TC-FEE-22 release £10,000, approve £5,000, £10,000 actually sent, then £5,000 more: H £5,000', () => {
    const l = run(HELD, [rx('a', '10,000'), rel('a', '10,000'), approve('r', '5,000'), record('r', '10,000'), rx('b', '5,000')])
    expect(pick(l)).toEqual({ N: P('5,000'), R: 0n, H: P('5,000'), due: 0n })
  })
  it('TC-FEE-22 £2,000 refunded by mistake with nothing released (N £8,000), then release £8,000: H 0', () => {
    const l = run(HELD, [rx('a', '10,000'), record(null, '2,000', 'mistake')])
    expect(pick(l)).toEqual({ N: P('8,000'), R: 0n, H: P('8,000'), due: 0n })
    expect(pick(run(HELD, [rel('a', '8,000')], l))).toEqual({ N: P('8,000'), R: P('8,000'), H: 0n, due: P('8,000') })
  })
  it('TC-FEE-22 a refund recorded with no approval uses the released money first', () => {
    const l = run(HELD, [rx('a', '10,000'), rel('a', '4,000'), record(null, '5,000', 'unapproved')])
    expect(pick(l)).toEqual({ N: P('5,000'), R: 0n, H: P('5,000'), due: 0n })
  })
  it('TC-FEE-22 two £5,000 released, the duplicate reversed, £5,000 more: N £10,000, R £5,000, H £5,000', () => {
    const l = run(HELD, [rx('a', '5,000'), rx('b', '5,000'), rel('a', '5,000'), rel('b', '5,000'), reverse('b'), rx('c', '5,000')])
    expect(pick(l)).toEqual({ N: P('10,000'), R: P('5,000'), H: P('5,000'), due: P('5,000') })
  })
  it('TC-FEE-22 release £10,000, approve £10,000, £5,000 actually sent: N £5,000, R £5,000, H 0', () => {
    const l = run(HELD, [rx('a', '10,000'), rel('a', '10,000'), approve('r', '10,000'), record('r', '5,000')])
    expect(pick(l)).toEqual({ N: P('5,000'), R: P('5,000'), H: 0n, due: P('5,000') })
  })
  it('TC-FEE-22 approved £10,000 before rejection, £5,000 actually sent: H £5,000', () => {
    const w: Position = { outcome: 'withdrawn', due: P('10,000') }
    const before = run(w, [rx('a', '10,000'), approve('r', '10,000')])
    const l = run(HELD, [record('r', '5,000')], before)
    expect(pick(l)).toEqual({ N: P('5,000'), R: 0n, H: P('5,000'), due: 0n })
  })
  it('TC-FEE-22 two £5,000 released, approve £10,000, reverse the duplicate, £5,000 more, cancel: H £5,000 in both orders', () => {
    const start = run(HELD, [rx('a', '5,000'), rx('b', '5,000'), rel('a', '5,000'), rel('b', '5,000'), approve('r', '10,000'), reverse('b')])
    const first = run(HELD, [rx('c', '5,000'), cancel('r')], start)
    const second = run(HELD, [cancel('r'), rx('c', '5,000')], start)
    expect(pick(first)).toEqual({ N: P('10,000'), R: P('5,000'), H: P('5,000'), due: P('5,000') })
    expect(pick(second)).toEqual(pick(first))
  })
  it('TC-FEE-22 N = 0 at rejection, money after it is held', () => {
    expect(pick(run(HELD, [rx('a', '7,000')])).H).toBe(P('7,000'))
  })
  it('TC-FEE-22 a release above the hold of the time, or with no reason, is refused', () => {
    const l = run(HELD, [rx('a', '10,000'), rx('b', '5,000'), rel('a', '6,000')])
    expect(refused(l, rel('a', '4,000.01'), HELD)).toMatch(/not yet released/)
    const short = run(HELD, [rx('a', '10,000'), record(null, '2,000', 'mistake')])
    expect(refused(short, rel('a', '8,000.01'), HELD)).toMatch(/held now/)
    expect(refused(short, rel('a', '8,000'), HELD)).toBeNull()
    expect(refused(l, { kind: 'release', receipt: 'b', amount: 1n, basis: '  ' }, HELD)).toMatch(/reason/)
    expect(refused(run(ACTIVE('10,000'), [rx('a', '10,000')]), rel('a', '1'), ACTIVE('10,000'))).toMatch(/Only held/)
  })
  it('TC-FEE-22 refund approval with nothing released is refused', () => {
    expect(refused(run(HELD, [rx('a', '10,000')]), approve('r', '0.01'), HELD)).toMatch(/more than/)
  })
  it('TC-FEE-22 two £5,000 released and refunded, £10,000 new, duplicate reversed, release £5,000: H 0, due £5,000', () => {
    const l = run(HELD, [
      rx('a', '5,000'),
      rx('b', '5,000'),
      rel('a', '5,000'),
      rel('b', '5,000'),
      approve('r', '10,000'),
      record('r', '10,000'),
      rx('c', '10,000'),
      reverse('b'),
    ])
    expect(pick(l)).toEqual({ N: P('5,000'), R: 0n, H: P('5,000'), due: 0n })
    expect(pick(run(HELD, [rel('c', '5,000')], l))).toEqual({ N: P('5,000'), R: P('5,000'), H: 0n, due: P('5,000') })
  })
  it('TC-FEE-22 a receipt restored after reversal is new money', () => {
    const l = run(HELD, [rx('a', '5,000'), rel('a', '5,000'), reverse('a'), { kind: 'restore', receipt: 'a' }])
    expect(pick(l)).toEqual({ N: P('5,000'), R: 0n, H: P('5,000'), due: 0n })
  })
  it('TC-FEE-22 two £5,000 released, £5,000 refunded, £5,000 approved not sent, £5,000 new, duplicate reversed, approval cancelled: H £5,000', () => {
    const l = run(HELD, [
      rx('a', '5,000'),
      rx('b', '5,000'),
      rel('a', '5,000'),
      rel('b', '5,000'),
      approve('r1', '5,000'),
      record('r1', '5,000'),
      approve('r2', '5,000'),
      rx('c', '5,000'),
      reverse('b'),
      cancel('r2'),
    ])
    expect(pick(l)).toEqual({ N: P('5,000'), R: 0n, H: P('5,000'), due: 0n })
  })
  it('TC-KYC-05 held money cannot be moved before a release; released money moves first', () => {
    const l = run(HELD, [rx('a', '10,000')])
    expect(refused(l, { kind: 'move_out', receipt: 'a', amount: 1n }, HELD)).toMatch(/free to move/)
    const l2 = run(HELD, [rel('a', '4,000')], l)
    expect(movable(l2, HELD)).toBe(P('4,000'))
    expect(refused(l2, { kind: 'move_out', receipt: 'a', amount: P('4,000.01') }, HELD)).not.toBeNull()
    // money free on one receipt does not let held money on another move
    const two = run(HELD, [rx('b', '5,000')], l2)
    expect(refused(two, { kind: 'move_out', receipt: 'b', amount: 1n }, HELD)).toMatch(/Held money/)
    const moved = run(HELD, [{ kind: 'move_out', receipt: 'a', amount: P('4,000') }], l2)
    expect(pick(moved)).toEqual({ N: P('6,000'), R: 0n, H: P('6,000'), due: 0n })
  })
  it('TC-KYC-05 the hold steps: considering → disclosure and consent → release; later money goes back to considering', () => {
    expect(holdStepAllowed('considering', 'disclosure_consent')).toBe(true)
    expect(holdStepAllowed('considering', 'release_allowed')).toBe(true)
    expect(holdStepAllowed('disclosure_consent', 'release_allowed')).toBe(true)
    expect(holdStepAllowed('disclosure_consent', 'considering')).toBe(false)
    expect(holdStepAllowed('release_allowed', 'considering')).toBe(false)
    expect(holdStepAfter('release_allowed', 0n, P('10'))).toBe('considering')
    expect(holdStepAfter('disclosure_consent', P('10'), P('10'))).toBe('disclosure_consent')
    expect(holdStepAfter('release_allowed', P('10'), 0n)).toBe('release_allowed')
  })
  it('TC-KYC-05 a cancelled deal does not free held money', () => {
    // a cancellation changes nothing about the hold: the outcome stays rejected_kyc and only a release lets money go
    const l = run(HELD, [rx('a', '10,000')])
    expect(refundCap(l, HELD)).toBe(0n)
  })
})

describe('TC-FEE-22 property: random legal events', () => {
  // deterministic generator so a failure can be replayed
  function rng(seed: number) {
    let s = seed >>> 0
    return (n: number) => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s % n
    }
  }
  const amounts = [P('1'), P('500'), P('2,000'), P('5,000'), P('10,000')]

  function randomEvent(r: (n: number) => number, l: Ledger, step: number, allowRefunds: boolean): MoneyEvent {
    const live = l.receipts.filter((x) => !x.reversed)
    const dead = l.receipts.filter((x) => x.reversed)
    const flying = l.refunds.find((x) => x.state === 'approved' || x.state === 'sent')
    const f = figures(l, HELD)
    const choice = r(allowRefunds ? 9 : 5)
    const any = <T>(xs: T[]) => xs[r(xs.length)]!
    if (choice === 1 && live.length) return reverse(any(live).id)
    if (choice === 2 && dead.length) return { kind: 'restore', receipt: any(dead).id }
    if (choice === 3 && live.length) {
      const x = any(live)
      const room = x.amount - x.released < f.hold ? x.amount - x.released : f.hold
      if (room > 0n) return { kind: 'release', receipt: x.id, amount: 1n + BigInt(r(Number(room))), basis: 'ok' }
    }
    if (choice === 4 && live.length) {
      const x = any(live)
      const most = movable(l, HELD) < x.released ? movable(l, HELD) : x.released
      if (most > 0n) return { kind: 'move_out', receipt: x.id, amount: 1n + BigInt(r(Number(most))) }
    }
    if (choice === 5 && !flying && (f.refundDue ?? 0n) > 0n) return { kind: 'approve_refund', id: `p${step}`, amount: 1n + BigInt(r(Number(f.refundDue))) }
    if (choice === 6 && flying) return cancel(flying.id)
    if (choice === 7 && flying) return { kind: 'record_refund', refund: flying.id, id: `x${step}`, actual: 1n + BigInt(r(Number(flying.approved! * 2n))) }
    if (choice === 8 && flying?.state === 'approved') return { kind: 'send_refund', refund: flying.id }
    return { kind: 'receive', id: `r${step}`, amount: any(amounts) }
  }

  it('TC-FEE-22 invariants after every event: 0 ≤ R ≤ max(N, 0), occupied ≤ released, H + due = N, receipts and releases move H exactly', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      let l = EMPTY_LEDGER
      for (let step = 0; step < 40; step++) {
        const e = randomEvent(r, l, step, true)
        const before = figures(l, HELD)
        const res = applyMoney(l, e, HELD)
        if (!res.ok) continue
        l = res.ledger
        const f = figures(l, HELD)
        expect(f.usable).toBeGreaterThanOrEqual(0n)
        expect(f.usable).toBeLessThanOrEqual(f.onHand > 0n ? f.onHand : 0n)
        expect(f.occupied).toBeLessThanOrEqual(f.released)
        if (f.onHand >= 0n) {
          expect(f.hold + f.refundDue!).toBe(f.onHand)
          if (e.kind === 'receive' && before.onHand >= 0n) expect(f.hold - before.hold).toBeGreaterThanOrEqual(e.amount)
          if (e.kind === 'release') expect(before.hold - f.hold).toBe(e.amount)
        } else {
          expect(f.needsCheck).toBe(true)
          expect(f.refundDue).toBeNull()
          expect(f.hold).toBe(0n)
          expect(refused(l, approve('z', '0.01'), HELD)).not.toBeNull()
        }
      }
    }
  })

  it('TC-FEE-22 an approval later cancelled never leaves less held than if it had never happened (catches the wrong cut order)', () => {
    let compared = 0
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed)
      // a prefix with released money and maybe completed refunds
      let l = run(HELD, [rx('a', '5,000'), rx('b', '5,000'), rel('a', '5,000'), rel('b', '5,000')])
      for (let step = 0; step < 8; step++) {
        const res = applyMoney(l, randomEvent(r, l, step, true), HELD)
        if (res.ok) l = res.ledger
      }
      const flying = l.refunds.find((x) => x.state === 'approved' || x.state === 'sent')
      if (flying) l = run(HELD, [{ kind: 'record_refund', refund: flying.id, id: 'settle', actual: flying.approved! }], l)
      const cap = figures(l, HELD).refundDue ?? 0n
      if (cap < 1n) continue
      // the same events with and without an approval that is cancelled at the end
      const withApproval = run(HELD, [{ kind: 'approve_refund', id: 'A', amount: 1n + BigInt(r(Number(cap))) }], l)
      let a = withApproval
      let b = l
      for (let step = 100; step < 106; step++) {
        const e = randomEvent(r, a, step, false)
        const ra = applyMoney(a, e, HELD)
        const rb = applyMoney(b, e, HELD)
        if (ra.ok) a = ra.ledger
        if (rb.ok) b = rb.ledger
      }
      a = run(HELD, [cancel('A')], a)
      const ha = figures(a, HELD)
      const hb = figures(b, HELD)
      if (ha.onHand < 0n || hb.onHand < 0n) continue
      compared++
      expect(ha.hold).toBeGreaterThanOrEqual(hb.hold)
    }
    expect(compared).toBeGreaterThan(100)
  })
})

describe('R-ALO-02 scale-back preview', () => {
  it('TC-ALO-02 A £200,000 and B £200,000 with £300,000: £150,000 each', () => {
    const s = scaleBack(
      [
        { id: 'A', invest: P('200,000') },
        { id: 'B', invest: P('200,000') },
      ],
      P('300,000'),
    )!
    expect(s.over).toBe(P('100,000'))
    expect([...s.scaled]).toEqual([
      ['A', P('150,000')],
      ['B', P('150,000')],
    ])
  })
  it('TC-ALO-02 largest remainder, equal remainders by joining order, sum equals the allocation', () => {
    const s = scaleBack(
      [
        { id: 'A', invest: 1n },
        { id: 'B', invest: 1n },
        { id: 'C', invest: 1n },
      ],
      2n,
    )!
    expect([...s.scaled.values()]).toEqual([1n, 1n, 0n])
    const t = scaleBack(
      [
        { id: 'A', invest: 100n },
        { id: 'B', invest: 200n },
        { id: 'C', invest: 50n },
      ],
      101n,
    )!
    // exact shares 28.857, 57.714, 14.428: floors 28 + 57 + 14 = 99, two pennies to the largest remainders (A .857, B .714)
    expect([...t.scaled.values()]).toEqual([29n, 58n, 14n])
  })
  it('TC-ALO-02 C totals £310,000, 4% taken from the payment (T £297,600): not over, nothing shown', () => {
    expect(scaleBack([{ id: 'X', invest: P('297,600') }], P('300,000'))).toBeNull()
    expect(scaleBack([{ id: 'X', invest: P('300,000') }], P('300,000'))).toBeNull()
  })
})

describe('R-ALO-03 when the allocation is full', () => {
  const base = { allocation: P('300,000'), minimum: P('1,000') }
  it('TC-ALO-03 remind: not blocked, warned', () => {
    expect(capacity({ ...base, mode: 'remind', others: P('299,000'), commitment: P('5,000'), fee: NONE })).toEqual({ kind: 'warn' })
    expect(capacity({ ...base, mode: 'remind', others: P('295,000'), commitment: P('5,000'), fee: NONE })).toEqual({ kind: 'ok' })
  })
  it('TC-ALO-03 stop: £5,000 left, minimum £1,000 → up to T £5,000; £500 left → waitlist only', () => {
    expect(capacity({ ...base, mode: 'stop', others: P('295,000'), commitment: P('10,000'), fee: NONE })).toEqual({ kind: 'limit', maxCommitment: P('5,000') })
    expect(capacity({ ...base, mode: 'stop', others: P('299,500'), commitment: P('1,000'), fee: NONE })).toEqual({ kind: 'waitlist' })
    expect(capacity({ ...base, mode: 'stop', others: P('301,000'), commitment: P('1,000'), fee: NONE })).toEqual({ kind: 'waitlist' })
  })
  it('TC-ALO-03 4% taken from the payment, £960 left: C £1,000 → T £960 fits', () => {
    const c = capacity({ ...base, mode: 'stop', others: P('299,040'), commitment: P('1,000'), fee: pct(400, 'deducted') })
    expect(c).toEqual({ kind: 'ok' })
    expect(largestCommitmentWithin(P('960'), pct(400, 'deducted'), P('1,000'))).toBe(P('1,000.01'))
  })
  it('TC-ALO-03 fixed £250 taken from the payment, £750 left: C £1,000 → T £750 fits', () => {
    expect(capacity({ ...base, mode: 'stop', others: P('299,250'), commitment: P('1,000'), fee: fixed(P('250'), 'deducted') })).toEqual({ kind: 'ok' })
    expect(largestCommitmentWithin(P('750'), fixed(P('250'), 'deducted'), P('1,000'))).toBe(P('1,000'))
  })
  it('TC-ALO-03 4% on top, £960 left: waitlist only', () => {
    expect(capacity({ ...base, mode: 'stop', others: P('299,040'), commitment: P('1,000'), fee: pct(400) })).toEqual({ kind: 'waitlist' })
  })
  it('TC-ALO-03 the limit found is the largest that fits', () => {
    for (const fee of [NONE, pct(400), pct(400, 'deducted'), pct(4999, 'deducted'), fixed(P('250')), fixed(P('250'), 'deducted')]) {
      for (const room of [P('960'), P('1,000'), P('5,000.37'), P('123,456.78')]) {
        const c = largestCommitmentWithin(room, fee, P('1,000'))
        if (c === null) continue
        expect(capacity({ ...base, allocation: room, mode: 'stop', others: 0n, commitment: c, fee })).toEqual({ kind: 'ok' })
        expect(capacity({ ...base, allocation: room, mode: 'stop', others: 0n, commitment: c + 1n, fee }).kind).not.toBe('ok')
      }
    }
  })
  it('TC-ALO-03 an increase is judged the same way', () => {
    // 4% on top, £960 left once this person's own T is set aside: raising to £1,000 does not fit
    expect(capacity({ ...base, mode: 'stop', others: P('299,040'), commitment: P('1,000'), fee: pct(400) }).kind).toBe('waitlist')
    expect(acceptProposalRefusal({ onHand: 0n, current: P('900'), proposed: P('1,000'), capacity: { kind: 'waitlist' } })).toMatch(/no longer room/)
    expect(acceptProposalRefusal({ onHand: 0n, current: P('900'), proposed: P('1,000'), capacity: { kind: 'warn' } })).toBeNull()
  })
})

describe('R-ALO-01 proposing a new amount', () => {
  const ok = { dealState: 'live', onHand: 0n, transferMarked: false, current: P('10,000'), proposed: P('8,000'), fee: NONE, minimum: P('1,000') }
  it('TC-ALO-01 only live, N = 0, no "I have paid", not below the minimum', () => {
    expect(proposalRefusal(ok)).toBeNull()
    expect(proposalRefusal({ ...ok, dealState: 'closing_requested' })).toMatch(/live/)
    expect(proposalRefusal({ ...ok, onHand: 1n })).toMatch(/Money/)
    expect(proposalRefusal({ ...ok, onHand: -1n })).toMatch(/Money/)
    expect(proposalRefusal({ ...ok, transferMarked: true })).toMatch(/paid/)
    expect(proposalRefusal({ ...ok, proposed: P('999.99') })).toMatch(/minimum/)
    expect(proposalRefusal({ ...ok, proposed: P('10,000') })).toMatch(/different/)
    expect(acceptProposalRefusal({ onHand: 1n, current: P('10,000'), proposed: P('8,000'), capacity: { kind: 'ok' } })).toMatch(/ended/)
    expect(acceptProposalRefusal({ onHand: 0n, current: P('10,000'), proposed: P('8,000'), capacity: { kind: 'waitlist' } })).toBeNull()
  })
})

describe('refund reason, late money and record exceptions (R-OPS-05, R-WDR-04)', () => {
  it('TC-FEE-19 one obligation, its reason from the outcome; after settled an active person’s refund is what the allocation left', () => {
    expect(refundReason('active', false)).toBe('overpaid')
    expect(refundReason('active', true)).toBe('after_allocation')
    expect(refundReason('rejected_kyc', false)).toBe('released')
    expect(refundReason('withdrawn', true)).toBe('withdrawn')
    expect(refundReason('deal_cancelled', false)).toBe('deal_cancelled')
  })

  it('TC-WDR-03 money after the part ended is late; before it, or with no end (active), it is not', () => {
    const ended = '2026-11-10T10:00:00.000Z'
    expect(isLateMoney(ended, '2026-11-10T10:00:00.001Z')).toBe(true)
    expect(isLateMoney(ended, ended)).toBe(false)
    expect(isLateMoney(ended, '2026-11-09T10:00:00.000Z')).toBe(false)
    expect(isLateMoney(null, '2026-11-10T10:00:00.001Z')).toBe(false)
  })

  it('TC-OPS-04 recording is never refused: what differs is named', () => {
    const base = { approved: 100000n, actual: 100000n, dueAtApproval: 500000n, dueNow: 500000n, heldAtApproval: false, heldNow: false }
    expect(refundExceptions(base)).toEqual([])
    expect(refundExceptions({ ...base, actual: 60000n })).toEqual(['amount_differs'])
    expect(refundExceptions({ ...base, actual: 100001n })).toEqual(['amount_differs'])
    expect(refundExceptions({ ...base, dueNow: 500001n })).toEqual(['commitment_changed'])
    expect(refundExceptions({ ...base, heldNow: true })).toEqual(['held_meanwhile'])
    // held already when approved: not a change
    expect(refundExceptions({ ...base, heldAtApproval: true, heldNow: true })).toEqual([])
    expect(refundExceptions({ ...base, approved: null, dueAtApproval: null })).toEqual(['no_approval'])
    expect(refundExceptions({ ...base, approved: null, dueAtApproval: null, heldNow: true })).toEqual(['no_approval', 'held_meanwhile'])
    expect(refundExceptions({ ...base, dueAtApproval: null, dueNow: 1n })).toEqual([])
  })
})
