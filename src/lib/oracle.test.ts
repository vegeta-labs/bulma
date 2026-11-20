// TS against the independent Python oracle (T6). Random cases from a fixed seed, plus every boundary near a half and a limit.
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { feeConfigErrors, platformFee, type FeeConfig } from './fees.ts'
import { reviewStatement, type BankLine, type ReferenceHolder } from './statement.ts'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
}

it('TC-FEE-10 platform fee and config validity match the oracle on 4000 cases', () => {
  const r = rng(20261106)
  const big = () => (BigInt(r()) * BigInt(r())) % 10n ** BigInt(1 + (r() % 15))
  const bps = () => [0, 1, 5, 10, 250, 9999, 10000][r() % 7] ?? r() % 10001
  const cases: Array<Record<string, unknown>> = []
  const local: Array<bigint | boolean> = []
  const wire = (c: FeeConfig) => ({
    rate_bps: c.rate_bps,
    min_minor: String(c.min_minor),
    max_minor: String(c.max_minor),
    surcharge_threshold_minor: String(c.surcharge_threshold_minor),
    surcharge_bps: c.surcharge_bps,
  })
  for (let i = 0; i < 4000; i++) {
    const a = big()
    const b = big()
    const validOne = i % 4 !== 0
    const c: FeeConfig = {
      rate_bps: bps(),
      min_minor: validOne && a > b ? b : a,
      max_minor: validOne && a > b ? a : b,
      surcharge_threshold_minor: big(),
      surcharge_bps: bps(),
    }
    if (feeConfigErrors(c).length === 0) {
      const base = i % 5 === 0 ? c.surcharge_threshold_minor + BigInt(r() % 3) : big()
      cases.push({ id: `f${i}`, op: 'platform_fee', config: wire(c), base_minor: String(base) })
      local.push(platformFee(c, base))
    }
    cases.push({ id: `v${i}`, op: 'validate_fee_config', config: wire(c) })
    local.push(feeConfigErrors(c).length === 0)
  }
  const out = JSON.parse(execFileSync('python3', ['scripts/oracle/oracle.py'], { input: JSON.stringify({ cases }), encoding: 'utf8', maxBuffer: 1 << 28 })) as {
    results: Array<{ id: string; fee_minor?: string; valid?: boolean }>
  }
  expect(out.results.length).toBe(cases.length)
  out.results.forEach((res, i) => {
    expect(res.id).toBe(cases[i]!.id)
    const mine = local[i]
    if (typeof mine === 'boolean') expect(res.valid, res.id).toBe(mine)
    else expect(res.fee_minor, res.id).toBe(String(mine))
  })
  expect(local.filter((x) => x === false).length).toBeGreaterThan(100)
})

it('TC-FEE-21 / TC-FEE-11 / TC-FEE-01 amounts to pay, commitment checks and estimates match the oracle on random cases', async () => {
  const { commitmentRefusal, dueFor, feeConfigErrors: errs } = await import('./fees.ts')
  const { expectedInvestment, leastInvestment } = await import('./estimate.ts')
  type LinkFee = Parameters<typeof dueFor>[1]
  const r = rng(20261110)
  const amt = (digits: number) => (BigInt(r()) * BigInt(r())) % 10n ** BigInt(1 + (r() % digits))
  const pick = <T>(xs: readonly T[]) => xs[r() % xs.length]!
  const wireFee = (f: LinkFee) => (f.kind === 'none' ? f : f.kind === 'percent' ? f : { kind: 'fixed', minor: String(f.minor), mode: f.mode })
  const wire = (c: FeeConfig) => ({
    rate_bps: c.rate_bps,
    min_minor: String(c.min_minor),
    max_minor: String(c.max_minor),
    surcharge_threshold_minor: String(c.surcharge_threshold_minor),
    surcharge_bps: c.surcharge_bps,
  })
  const cases: Array<Record<string, unknown>> = []
  const local: unknown[] = []
  for (let i = 0; i < 4000; i++) {
    const mode = pick(['on_top', 'deducted'] as const)
    const fee: LinkFee = pick([
      { kind: 'none' },
      { kind: 'percent', bps: 1 + (r() % 5000), mode },
      { kind: 'percent', bps: pick([1, 400, 4999, 5000]), mode },
      { kind: 'fixed', minor: 1n + amt(8), mode },
    ] as LinkFee[])
    const c = i % 7 === 0 ? 1n + BigInt(r() % 3) : amt(12)
    const minimum = i % 3 === 0 ? amt(8) : 0n
    cases.push({ id: `k${i}`, op: 'commitment_ok', commitment_minor: String(c), fee: wireFee(fee), minimum_minor: String(minimum) })
    local.push({ ok: commitmentRefusal(c, fee, minimum) === null })
    if (commitmentRefusal(c, fee, 0n) !== null) continue
    const d = dueFor(c, fee)
    cases.push({ id: `d${i}`, op: 'due', commitment_minor: String(c), fee: wireFee(fee) })
    local.push({ due_minor: String(d.due), invest_minor: String(d.invest), lead_fee_minor: String(d.leadFee), rounding_minor: String(d.rounding) })
    let cfg: FeeConfig
    do {
      const a = amt(9)
      const b = amt(9)
      cfg = {
        rate_bps: pick([0, 1, 250, 1000, r() % 10001]),
        min_minor: a < b ? a : b,
        max_minor: a < b ? b : a,
        surcharge_threshold_minor: amt(10),
        surcharge_bps: pick([0, 10, r() % 1001]),
      }
    } while (errs(cfg).length)
    const payer = pick(['investors', 'investors', 'investors', 'lead', 'company'] as const)
    const allocation = amt(11)
    const total = d.invest + (i % 2 ? amt(11) : 0n)
    const stage = pick(['live', 'closing'] as const)
    if (stage === 'live' || total > 0n) {
      const e = expectedInvestment({ config: cfg, payer, allocation, invest: d.invest, totalInvest: total, stage })
      if (!(stage === 'live' && allocation === 0n && total === 0n)) {
        cases.push({
          id: `e${i}`,
          op: 'expected_investment',
          config: wire(cfg),
          payer,
          allocation_minor: String(allocation),
          invest_minor: String(d.invest),
          total_invest_minor: String(total),
          stage,
        })
        local.push({ share_minor: String(e.share), expected_minor: String(e.expected) })
      }
    }
    const minRaise = i % 3 === 0 ? null : amt(11)
    const l = leastInvestment({ config: cfg, payer, allocation, minRaise, invest: d.invest })
    cases.push({
      id: `l${i}`,
      op: 'least_investment',
      config: wire(cfg),
      payer,
      allocation_minor: String(allocation),
      min_raise_minor: minRaise === null ? null : String(minRaise),
      invest_minor: String(d.invest),
    })
    local.push({ least_minor: l === null ? null : String(l) })
  }
  const out = JSON.parse(execFileSync('python3', ['scripts/oracle/oracle.py'], { input: JSON.stringify({ cases }), encoding: 'utf8', maxBuffer: 1 << 28 })) as {
    results: Array<Record<string, unknown>>
  }
  expect(out.results.length).toBe(cases.length)
  out.results.forEach((res, i) => {
    const { id, ...rest } = res
    expect(id).toBe(cases[i]!.id)
    expect(rest, String(id)).toEqual(local[i])
  })
  expect(local.filter((x) => (x as { least_minor?: unknown }).least_minor === null).length).toBeGreaterThan(100)
  expect(local.filter((x) => typeof (x as { least_minor?: unknown }).least_minor === 'string').length).toBeGreaterThan(100)
  expect(local.filter((x) => (x as { ok?: boolean }).ok === false).length).toBeGreaterThan(100)
})

it('TC-FEE-22 / TC-ALO-02 lead fee, scale-back and money sequences match the oracle on random cases', async () => {
  const { applyMoney, EMPTY_LEDGER, figures, leadFeeOn, scaleBack } = await import('./money.ts')
  const { OUTCOMES } = await import('./participation.ts')
  type LinkFee = Parameters<typeof leadFeeOn>[1]
  type MoneyEvent = Parameters<typeof applyMoney>[1]
  const r = rng(20261111)
  const amt = (digits: number) => (BigInt(r()) * BigInt(r())) % 10n ** BigInt(1 + (r() % digits))
  const pick = <T>(xs: readonly T[]) => xs[r() % xs.length]!
  const wireFee = (f: LinkFee) => (f.kind === 'fixed' ? { kind: 'fixed', minor: String(f.minor), mode: f.mode } : f)
  const cases: Array<Record<string, unknown>> = []
  const local: unknown[] = []

  for (let i = 0; i < 3000; i++) {
    const mode = pick(['on_top', 'deducted'] as const)
    const fee: LinkFee = pick([
      { kind: 'none' },
      { kind: 'percent', bps: 1 + (r() % 5000), mode },
      { kind: 'percent', bps: pick([1, 400, 4999, 5000]), mode },
      { kind: 'fixed', minor: 1n + amt(8), mode },
    ] as LinkFee[])
    const e = i % 9 === 0 ? BigInt(r() % 4) : fee.kind === 'fixed' && i % 3 === 0 ? fee.minor + BigInt(r() % 3) - 1n : amt(12)
    if (e < 0n) continue
    cases.push({ id: `lf${i}`, op: 'lead_fee', effective_minor: String(e), fee: wireFee(fee) })
    local.push({ fee_minor: String(leadFeeOn(e, fee)) })
  }

  for (let i = 0; i < 1500; i++) {
    const n = 1 + (r() % 8)
    const same = i % 4 === 0 ? amt(6) : null
    const entries = Array.from({ length: n }, (_, k) => ({ id: `p${k}`, invest: same ?? (i % 5 === 0 ? BigInt(r() % 4) : amt(9)) }))
    const total = entries.reduce((a, x) => a + x.invest, 0n)
    const allocation = i % 6 === 0 ? total : total === 0n ? 0n : (total * BigInt(r() % 1000)) / 1000n
    const s = scaleBack(entries, allocation)
    cases.push({
      id: `sb${i}`,
      op: 'scale_back',
      allocation_minor: String(allocation),
      entries: entries.map((x) => ({ id: x.id, invest_minor: String(x.invest) })),
    })
    local.push(
      s === null
        ? { over_minor: null, scaled: null }
        : { over_minor: String(s.over), scaled: entries.map((x) => ({ id: x.id, invest_minor: String(s.scaled.get(x.id)) })) },
    )
  }

  let accepted = 0
  let refused = 0
  let negative = 0
  for (let i = 0; i < 5000; i++) {
    const outcome = i % 3 === 0 ? 'rejected_kyc' : pick(OUTCOMES)
    const due = 1n + BigInt(r() % 1000)
    const allocated = outcome === 'active' && i % 4 === 0 ? BigInt(r() % Number(due + 1n)) : null
    const p = { outcome, due }
    const s = allocated === null ? undefined : { settled: true, allocatedCash: allocated }
    const small = () => BigInt(r() % 600) - (r() % 20 === 0 ? 1n : 0n)
    const receipts: string[] = []
    const refunds: string[] = []
    let nextRefund = 0
    const events: MoneyEvent[] = []
    const wire: Array<Record<string, unknown>> = []
    let ledger = EMPTY_LEDGER
    const steps: unknown[] = []
    const len = 1 + (r() % 24)
    for (let k = 0; k < len; k++) {
      const rc = () => (receipts.length && r() % 15 ? pick(receipts) : `r${r() % 9}`)
      const rf = () => (refunds.length && r() % 15 ? pick(refunds) : `f${r() % 9}`)
      const kind = pick([
        'receive',
        'receive',
        'reverse',
        'restore',
        'move_out',
        'release',
        'release',
        'release',
        'approve_refund',
        'approve_refund',
        'send_refund',
        'send_refund',
        'cancel_refund',
        'record_refund',
        'record_refund',
      ] as const)
      let ev: MoneyEvent
      let w: Record<string, unknown>
      if (kind === 'receive') {
        const id = r() % 10 ? `r${receipts.length}` : rc()
        ev = { kind, id, amount: small() }
        w = { kind, id, amount_minor: String(ev.amount) }
      } else if (kind === 'reverse' || kind === 'restore') {
        const receipt = rc()
        ev = { kind, receipt }
        w = { kind, receipt }
      } else if (kind === 'move_out') {
        ev = { kind, receipt: rc(), amount: small() }
        w = { kind, receipt: ev.receipt, amount_minor: String(ev.amount) }
      } else if (kind === 'release') {
        const basis = pick(['consent given', 'ok', '', '   '])
        ev = { kind, receipt: rc(), amount: small(), basis }
        w = { kind, receipt: ev.receipt, amount_minor: String(ev.amount), basis }
      } else if (kind === 'approve_refund') {
        const id = `f${nextRefund++}`
        ev = { kind, id, amount: small() }
        w = { kind, id, amount_minor: String(ev.amount) }
      } else if (kind === 'send_refund') {
        ev = { kind, refund: rf() }
        w = { kind, refund: ev.refund }
      } else if (kind === 'cancel_refund') {
        const evidence = pick([null, null, 'bank confirmed the recall', ' '])
        ev = evidence === null ? { kind, refund: rf() } : { kind, refund: rf(), recallEvidence: evidence }
        w = { kind, refund: ev.refund, recall_evidence: evidence }
      } else {
        const unapproved = r() % 4 === 0
        const id = `f${nextRefund++}`
        ev = { kind, refund: unapproved ? null : rf(), id, actual: small() }
        w = { kind, refund: ev.refund, id, actual_minor: String(ev.actual) }
      }
      const res = applyMoney(ledger, ev, p, s)
      if (res.ok) {
        ledger = res.ledger
        accepted++
        if (ev.kind === 'receive' && !receipts.includes(ev.id)) receipts.push(ev.id)
        if (ev.kind === 'approve_refund' && !refunds.includes(ev.id)) refunds.push(ev.id)
        if (ev.kind === 'record_refund' && ev.refund === null && !refunds.includes(ev.id)) refunds.push(ev.id)
      } else refused++
      const f = figures(ledger, p, s)
      if (f.needsCheck) negative++
      events.push(ev)
      wire.push(w)
      steps.push({
        accepted: res.ok,
        on_hand_minor: String(f.onHand),
        usable_minor: String(f.usable),
        hold_minor: String(f.hold),
        refund_due_minor: f.refundDue === null ? null : String(f.refundDue),
        needs_check: f.needsCheck,
      })
    }
    cases.push({
      id: `ms${i}`,
      op: 'money_sequence',
      outcome,
      due_minor: String(due),
      allocated_cash_minor: allocated === null ? null : String(allocated),
      events: wire,
    })
    local.push({ steps })
  }

  const out = JSON.parse(execFileSync('python3', ['scripts/oracle/oracle.py'], { input: JSON.stringify({ cases }), encoding: 'utf8', maxBuffer: 1 << 28 })) as {
    results: Array<Record<string, unknown>>
  }
  expect(out.results.length).toBe(cases.length)
  out.results.forEach((res, i) => {
    const { id, ...rest } = res
    expect(id).toBe(cases[i]!.id)
    expect(rest, String(id)).toEqual(local[i])
  })
  expect(accepted).toBeGreaterThan(12000)
  expect(refused).toBeGreaterThan(20000)
  expect(negative).toBeGreaterThan(500)
})

it('TC-OPS-06 statement matching (C-REC-1, C-REC-2, R-OPS-07 currencies) matches the oracle on random memos', () => {
  const r = rng(20261111)
  const pick = <T,>(xs: readonly T[]) => xs[r() % xs.length]!
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const code = () => Array.from({ length: 6 }, () => ALPHA[r() % ALPHA.length]).join('')
  const SEPS = ['-', ' ', '/', '.', '_', ':', '  ', '\t', ',', '#']
  const ODD = ['É', 'ß', '–', ' ', '9', 'X', 'é', '0']
  const cases: Array<Record<string, unknown>> = []
  const local: Array<{ kind: string; participation: string | null; reason?: string }> = []
  for (let i = 0; i < 4000; i++) {
    const holders: ReferenceHolder[] = Array.from({ length: 1 + (r() % 6) }, (_, k) => ({
      participation: `p${i}-${k}`,
      reference: `${pick(['NW', 'AB', 'QRS', 'ZXYW'])}-${code()}`,
      currency: pick(['GBP', 'GBP', 'GBP', 'EUR']),
      settled: false,
    }))
    // sometimes two holders share a normalised reference written differently, to reach "several"
    if (i % 17 === 0 && holders.length > 1) holders[1]!.reference = holders[0]!.reference.replace('-', ' ').toLowerCase()
    const parts: string[] = []
    for (let n = r() % 4; n > 0; n--) {
      const h = pick(holders)
      const raw = h.reference
      const variant = r() % 8
      const piece =
        variant === 0 ? raw.toLowerCase() : variant === 1 ? raw.replace('-', '') : variant === 2 ? raw + pick(ODD) : variant === 3 ? pick(ODD) + raw : variant === 4 ? raw.split('').join(pick(SEPS)) : variant === 5 ? raw.slice(0, 5) + pick(SEPS) + raw.slice(5) : raw
      parts.push(piece)
    }
    if (r() % 3 === 0) parts.push(pick(['SPV', 'invest', 'ref', 'Ünï', '']))
    const memo = parts.join(pick(SEPS))
    const rowCurrency = pick([null, null, null, '', 'gbp', 'GBP', 'eur', 'USD'])
    const accountCurrency = pick(['GBP', 'GBP', 'EUR'])
    const line: BankLine = { line: 2, transactionId: null, date: '2026-10-06', amountMinor: 100n, payer: '', reference: memo, otherCurrency: rowCurrency && rowCurrency.toUpperCase() !== accountCurrency ? rowCurrency.toUpperCase() : null }
    const row = reviewStatement({ lines: [line], accountCurrency, scope: 's', holders, known: new Map(), receipts: [] }).rows[0]!
    local.push(row.kind === 'match' ? { kind: 'match', participation: row.participation } : { kind: 'unallocated', participation: null, reason: (row as { reason: string }).reason })
    cases.push({
      id: `m${i}`,
      op: 'statement_match',
      account_currency: accountCurrency,
      row_currency: rowCurrency === '' ? null : rowCurrency,
      memo,
      holders: holders.map((h) => ({ participation: h.participation, reference: h.reference, currency: h.currency })),
    })
  }
  const out = JSON.parse(execFileSync('python3', ['scripts/oracle/oracle.py'], { input: JSON.stringify({ cases }), encoding: 'utf8', maxBuffer: 1 << 28 })) as {
    results: Array<{ id: string; kind: string; participation: string | null; reason?: string }>
  }
  expect(out.results.length).toBe(cases.length)
  out.results.forEach((res, i) => expect({ kind: res.kind, participation: res.participation, reason: res.reason }, `${res.id} ${JSON.stringify(cases[i])}`).toEqual({ reason: undefined, ...local[i] }))
  const kinds = (k: string) => local.filter((x) => (x.reason ?? x.kind) === k).length
  for (const k of ['match', 'no_match', 'several', 'currency_column', 'deal_currency']) expect(kinds(k), k).toBeGreaterThan(50)
})
