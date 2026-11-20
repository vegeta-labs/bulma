import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { csvRows } from './csv.ts'
import {
  lineKeys,
  parseLedger,
  parseStatement,
  readDate,
  readMoney,
  reviewLedger,
  reviewStatement,
  rosterExport,
  ROSTER_HEADER,
  type BankLine,
  type ReferenceHolder,
  type RosterPerson,
  type StoredReceipt,
} from './statement.ts'

const fixture = (f: string) => readFileSync(new URL(`../../fixtures/goten/${f}`, import.meta.url), 'utf8')

const holders: ReferenceHolder[] = [
  { participation: 'p-amelia', reference: 'NW-7K2M9Q', currency: 'GBP', settled: false },
  { participation: 'p-ben', reference: 'NW-AB3CD4', currency: 'GBP', settled: false },
  { participation: 'p-chloe', reference: 'NW-QR5ST6', currency: 'GBP', settled: false },
  { participation: 'p-euro', reference: 'EU-HJ7KM8', currency: 'EUR', settled: false },
  { participation: 'p-late', reference: 'NW-ZX9YW8', currency: 'GBP', settled: true },
]

function statement(rows: string[], header = 'transaction_id,date,amount,payer,reference') {
  const p = parseStatement([header, ...rows].join('\n'), 'GBP')
  expect(p.errors).toEqual([])
  return p.lines
}

const review = (lines: BankLine[], extra: { known?: Map<string, string>; receipts?: StoredReceipt[] } = {}) =>
  reviewStatement({ lines, accountCurrency: 'GBP', scope: 'account:a1', holders, known: extra.known ?? new Map(), receipts: extra.receipts ?? [] })

describe('readers (Goten I-01, I-04)', () => {
  it('TC-OPS-06 amounts: symbol of the account only, strict groups, two decimals, money out read as negative', () => {
    expect(readMoney('£1,250.5', 'GBP')).toBe(125050n)
    expect(readMoney(' 10000 ', 'GBP')).toBe(1000000n)
    expect(readMoney('-45.00', 'GBP')).toBe(-4500n)
    expect(readMoney('£-45', 'GBP')).toBe(-4500n)
    expect(readMoney('-£-45', 'GBP')).toBeNull()
    expect(readMoney('€10', 'GBP')).toBeNull()
    expect(readMoney('$10', 'USD')).toBe(1000n)
    expect(readMoney('1,25.00', 'GBP')).toBeNull()
    expect(readMoney('1.234', 'GBP')).toBeNull()
    expect(readMoney('1000000000.00', 'GBP')).toBe(100_000_000_000n)
    expect(readMoney('1000000000.01', 'GBP')).toBeNull()
    expect(readMoney('1 000', 'GBP')).toBeNull()
  })

  it('TC-OPS-06 dates: ISO or day first, a day that does not exist refused', () => {
    expect(readDate('06/10/2026')).toBe('2026-10-06')
    expect(readDate('6/1/2026')).toBe('2026-01-06')
    expect(readDate('2026-10-06')).toBe('2026-10-06')
    expect(readDate('31/02/2026')).toBeNull()
    expect(readDate('2026-13-01')).toBeNull()
    expect(readDate('10-06-2026')).toBeNull()
  })

  it('TC-OPS-06 hostile input: a statement or ledger line dated before 2000 refuses the file, 2000-01-01 is read', () => {
    const bank = (date: string) => parseStatement(`transaction_id,date,amount,payer,reference\nT1,${date},10.00,X,Y`, 'GBP')
    const ledger = (date: string) =>
      parseLedger(`transaction_id,date,amount,payer,reference,status,investor_id,currency\nT1,${date},10.00,X,Y,auto,p-amelia,GBP`, 'GBP', new Set(['p-amelia']))
    for (const read of [bank, ledger]) {
      expect(read('1999-12-31').errors).toEqual([{ line: 2, column: 'date', message: 'A date before 2000 is not read as money received.' }])
      expect(read('31/12/1999').lines).toEqual([])
      expect(read('2000-01-01').errors).toEqual([])
      expect(read('2000-01-01').lines).toHaveLength(1)
    }
  })

  it('TC-ADM-05 CSV rows: mixed line endings, a line break inside quotes kept, doubled quotes, an open quote refused', () => {
    expect(csvRows('a,b\r\n1,"x\ny"\r2,"say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['1', 'x\ny'],
      ['2', 'say "hi"'],
    ])
    expect(() => csvRows('a\n"open')).toThrow()
  })
})

describe('TC-OPS-06 statement import (R-OPS-07, lib)', () => {
  it('TC-OPS-06 the Goten fixture: money out listed and left out, formula guard taken off, free text kept as it is', () => {
    const p = parseStatement(fixture('bank.csv'), 'GBP')
    expect(p.errors).toEqual([])
    expect(p.skipped).toEqual([{ line: 5, amountMinor: -4500n }])
    expect(p.lines.map((l) => [l.transactionId, l.date, l.amountMinor, l.payer])).toEqual([
      ['T1', '2026-10-06', 1040000n, 'A HART'],
      [null, '2026-10-07', 250000n, 'B OKAFOR'],
      [null, '2026-10-07', 250000n, 'B OKAFOR'],
      ['T5', '2026-10-09', 100000n, 'UNKNOWN'],
      ['T6', '2026-10-09', 30000n, '=cmd'],
    ])
  })

  it('TC-OPS-06 three references in one statement each matched; no match and several go to unallocated; nothing is written', () => {
    const lines = statement([
      'A,2026-10-06,100.00,X,NW-7K2M9Q',
      'B,2026-10-06,200.00,X,nw ab3cd4 spv',
      'C,2026-10-06,300.00,X,NWQR5ST6',
      'D,2026-10-06,400.00,X,NW-7K2M9Q9',
      'E,2026-10-06,500.00,X,NW-7K2M9Q and NW-AB3CD4',
    ])
    const r = review(lines)
    expect(r.errors).toEqual([])
    expect(r.rows.map((x) => (x.kind === 'match' ? x.participation : x.kind === 'unallocated' ? x.reason : x.kind))).toEqual([
      'p-amelia',
      'p-ben',
      'p-chloe',
      'no_match',
      'several',
    ])
  })

  it('TC-OPS-06 a GBP statement with no currency column: a reference of a EUR deal goes to unallocated, never £ counted as €', () => {
    const r = review(statement(['A,2026-10-06,"10,000.00",X,EU-HJ7KM8']))
    expect(r.rows[0]).toMatchObject({ kind: 'unallocated', reason: 'deal_currency' })
  })

  it('TC-OPS-06 a currency cell other than the account: unallocated even when the reference matches; blank means the account', () => {
    const lines = statement(
      ['A,2026-10-06,100.00,X,NW-7K2M9Q,eur', 'B,2026-10-06,100.00,X,NW-AB3CD4,', 'C,2026-10-06,100.00,X,NW-QR5ST6,gbp'],
      'transaction_id,date,amount,payer,reference,ccy',
    )
    expect(review(lines).rows.map((x) => x.kind)).toEqual(['unallocated', 'match', 'match'])
    expect(review(lines).rows[0]).toMatchObject({ reason: 'currency_column' })
  })

  it('TC-OPS-06 a header marked with another currency refuses the file; the account currency mark is accepted', () => {
    expect(parseStatement('date,Amount (€),reference\n2026-10-06,10,X', 'GBP').errors[0]).toMatchObject({ line: 1 })
    expect(parseStatement('date,Amount (£),reference\n2026-10-06,10,X', 'GBP').errors).toEqual([])
    expect(parseStatement('date,amount gbp,reference\n2026-10-06,10,X', 'GBP').errors).toEqual([])
    expect(parseStatement('date,amount usd,reference\n2026-10-06,10,X', 'GBP').errors[0]).toMatchObject({ line: 1, column: 'amount usd' })
    // a bracket that is no currency stays part of the name, so the column is just not known
    expect(parseStatement('date,amount,note (abc)\n2026-10-06,10,X', 'GBP').ignoredColumns).toEqual(['note (abc)'])
  })

  it('TC-OPS-06 a bad row refuses the whole file and names row and column; a missing column is named', () => {
    const p = parseStatement('date,amount\n2026-10-06,10\n31/02/2026,10\n2026-10-06,ten', 'GBP')
    expect(p.lines).toEqual([])
    expect(p.errors.map((e) => [e.line, e.column])).toEqual([
      [3, 'date'],
      [4, 'amount'],
    ])
    expect(parseStatement('date,payer\n2026-10-06,X', 'GBP').errors[0]).toMatchObject({ column: 'amount' })
    expect(parseStatement('date,amount\n2026-10-06,10,extra', 'GBP').errors[0]).toMatchObject({ line: 2 })
  })

  it('TC-OPS-06 the same transaction twice in one file counts once; with other details the file is refused', () => {
    expect(parseStatement('date,amount\n2026-10-06,0\n2026-10-06,0.01', 'GBP')).toMatchObject({
      skipped: [{ line: 2, amountMinor: 0n }],
      lines: [{ amountMinor: 1n }],
    })
    const p = parseStatement('transaction_id,date,amount\nT1,2026-10-06,10\nT1 ,06/10/2026,10.00', 'GBP')
    expect(p.lines).toHaveLength(1)
    expect(p.repeats).toEqual([3])
    expect(parseStatement('transaction_id,date,amount\nT1,2026-10-06,10\nT1,2026-10-06,11', 'GBP').errors[0]).toMatchObject({
      line: 3,
      column: 'transaction_id',
    })
  })

  it('TC-OPS-06 importing again counts nothing twice; a stored transaction with other details refuses the file', () => {
    const lines = statement(['T1,2026-10-06,100.00,X,NW-7K2M9Q', ',2026-10-06,50.00,X,NW-AB3CD4'])
    const first = review(lines)
    const known = new Map(lines.map((l, i) => [first.rows[i]!.key, JSON.stringify([l.date, String(l.amountMinor), l.payer, l.reference])]))
    expect(review(lines, { known }).rows.map((x) => x.kind)).toEqual(['already_imported', 'already_imported'])
    const changed = statement(['T1,2026-10-06,101.00,X,NW-7K2M9Q'])
    expect(review(changed, { known }).errors[0]).toMatchObject({ column: 'transaction_id' })
    expect(review(changed, { known }).rows).toEqual([])
  })

  it('TC-OPS-06 the next statement lacking the old rows offers no reversal: it only lists its own rows', () => {
    const r = review(statement(['T9,2026-10-20,10.00,X,NW-7K2M9Q']))
    expect(r.rows).toHaveLength(1)
    expect(Object.keys(r)).toEqual(['rows', 'errors'])
  })

  it('TC-OPS-06 already read back from Goten or recorded by hand: offered for pairing, once; reversed ones, or ones already paired in this account, are not', () => {
    const receipts: StoredReceipt[] = [
      { id: 'manual', participation: 'p-amelia', amountMinor: 10000n, scope: null, reversed: false, paired: false, pairedScopes: [] },
      { id: 'ledger', participation: 'p-amelia', amountMinor: 10000n, scope: 'ledger:L1', reversed: false, paired: false, pairedScopes: [] },
      { id: 'same-file', participation: 'p-amelia', amountMinor: 10000n, scope: 'account:a1', reversed: false, paired: false, pairedScopes: [] },
      { id: 'reversed', participation: 'p-amelia', amountMinor: 10000n, scope: null, reversed: true, paired: false, pairedScopes: [] },
      { id: 'paired', participation: 'p-amelia', amountMinor: 10000n, scope: null, reversed: false, paired: true, pairedScopes: ['account:a1'] },
      // by hand, then paired with a Goten line: the bank's line for the same transfer may still be it
      { id: 'paired-ledger', participation: 'p-amelia', amountMinor: 10000n, scope: null, reversed: false, paired: true, pairedScopes: ['ledger:L1'] },
      { id: 'other-amount', participation: 'p-amelia', amountMinor: 10001n, scope: null, reversed: false, paired: false, pairedScopes: [] },
      { id: 'other-person', participation: 'p-ben', amountMinor: 10000n, scope: null, reversed: false, paired: false, pairedScopes: [] },
    ]
    const r = review(statement(['T1,2026-10-06,100.00,X,NW-7K2M9Q']), { receipts })
    expect(r.rows[0]).toMatchObject({ kind: 'match', pairWith: ['manual', 'ledger', 'paired-ledger'] })
  })

  it('TC-OPS-06 late money for a settled deal is matched and listed for refund', () => {
    expect(review(statement(['T1,2026-10-06,100.00,X,NW-ZX9YW8'])).rows[0]).toMatchObject({ kind: 'match', participation: 'p-late', late: true })
    expect(review(statement(['T1,2026-10-06,100.00,X,NW-7K2M9Q'])).rows[0]).toMatchObject({ late: false })
  })

  it('TC-OPS-06 identical lines with no ID are both kept, with their own keys, and flagged for a look', () => {
    const lines = statement([',2026-10-07,25.00,B,NW-AB3CD4', ',2026-10-07,25.00,B,NW-AB3CD4', ',2026-10-07,25.00,B,NW-7K2M9Q'])
    const r = review(lines)
    expect(new Set(r.rows.map((x) => x.key)).size).toBe(3)
    expect(r.rows.map((x) => (x.kind === 'match' ? x.possibleDuplicate : null))).toEqual([true, true, false])
  })
})

describe('TC-IO-02 ledger read-back (§5.7)', () => {
  const parts = new Set(['p-amelia', 'p-ben', 'p-chloe'])
  const ledger = () => {
    const p = parseLedger(fixture('ledger.csv'), 'GBP', parts)
    expect(p.errors).toEqual([])
    return p.lines
  }

  it('TC-IO-02 only booked lines count: not booked, waiting for review, money out and unmatched lines do not', () => {
    const r = reviewLedger({ lines: ledger(), scope: 'ledger:L1', prior: [], receipts: [] })
    expect(r.added.map((a) => [a.participation, a.amountMinor])).toEqual([
      ['p-amelia', 1040000n],
      ['p-ben', 250000n],
      ['p-ben', 250000n],
      ['p-chloe', 30000n],
    ])
    const suggested = parseLedger(
      'transaction_id,date,amount,payer,reference,status,investor_id,currency\nT1,2026-10-06,10.00,X,Y,suggested,p-ben,GBP\nT2,2026-10-06,10.00,X,Y,rejected,p-ben,GBP\nT3,2026-10-06,10.00,X,Y,future,p-ben,GBP',
      'GBP',
      parts,
    )
    expect(reviewLedger({ lines: suggested.lines, scope: 'ledger:L1', prior: [], receipts: [] }).added).toEqual([])
  })

  it('TC-IO-02 importing again counts nothing twice; two identical confirmed transfers on one day stay two', () => {
    const lines = ledger()
    const first = reviewLedger({ lines, scope: 'ledger:L1', prior: [], receipts: [] })
    const prior = first.added.map((a, i) => ({ receipt: `r${i}`, key: a.key, participation: a.participation, amountMinor: a.amountMinor }))
    const again = reviewLedger({ lines: ledger(), scope: 'ledger:L1', prior, receipts: [] })
    expect(again.added).toEqual([])
    expect(again.unchanged).toHaveLength(4)
    expect(again.gone).toEqual([])
    expect(new Set(first.added.map((a) => a.key)).size).toBe(4)
  })

  it('TC-IO-02 the same transaction ID in another ledger does not clash: keys are within one ledger', () => {
    const a = parseLedger('transaction_id,date,amount,payer,reference,status,investor_id,currency\nT1,2026-10-06,10.00,X,Y,auto,p-amelia,GBP', 'GBP', parts)
    const prior = [{ receipt: 'r-other-ledger', key: 't:T1', participation: 'p-x', amountMinor: 1000n }]
    // the caller gives only this ledger's own receipts as prior; another ledger's T1 is someone else's money
    expect(reviewLedger({ lines: a.lines, scope: 'ledger:L2', prior: [], receipts: [] }).added).toHaveLength(1)
    expect(lineKeys(a.lines)).toEqual(['t:T1'])
    expect(prior[0]!.key).toBe('t:T1')
  })

  it('TC-IO-02 hand £5,000 + ledger £5,000 (the same) + £5,000: the pair is offered, the hand record never overwritten', () => {
    const text =
      'transaction_id,date,amount,payer,reference,status,investor_id,currency\nT1,2026-10-06,5000.00,X,Y,auto,p-ben,GBP\nT2,2026-10-08,5000.00,X,Y,auto,p-ben,GBP'
    const receipts: StoredReceipt[] = [{ id: 'hand', participation: 'p-ben', amountMinor: 500000n, scope: null, reversed: false, paired: false, pairedScopes: [] }]
    const r = reviewLedger({ lines: parseLedger(text, 'GBP', parts).lines, scope: 'ledger:L1', prior: [], receipts })
    expect(r.added.map((a) => a.pairWith)).toEqual([['hand'], ['hand']])
    expect(r.unpairedManual).toEqual(['hand'])
    // once a person pairs it with T1, the hand record is paired: no longer offered, no longer listed as unpaired; total £10,000
    const after = reviewLedger({ lines: parseLedger(text, 'GBP', parts).lines, scope: 'ledger:L1', prior: [], receipts: [{ ...receipts[0]!, paired: true, pairedScopes: ['ledger:L1'] }] })
    expect(after.added.map((a) => a.pairWith)).toEqual([[], []])
    expect(after.unpairedManual).toEqual([])
    expect(after.added.reduce((s, a) => s + a.amountMinor, 0n)).toBe(1_000_000n)
  })

  it('TC-IO-02 a corrected import lacking one line offers that receipt for reversal; one moved to another person is changed', () => {
    const lines = ledger()
    const first = reviewLedger({ lines, scope: 'ledger:L1', prior: [], receipts: [] })
    const prior = first.added.map((a, i) => ({ receipt: `r${i}`, key: a.key, participation: a.participation, amountMinor: a.amountMinor }))
    const text = fixture('ledger.csv')
      .split('\r\n')
      .filter((l) => !l.startsWith('T1,'))
      .join('\r\n')
      .replace('auto,p-chloe', 'confirmed,p-amelia')
    const r = reviewLedger({ lines: parseLedger(text, 'GBP', parts).lines, scope: 'ledger:L1', prior, receipts: [] })
    expect(r.gone).toEqual([{ receipt: 'r0', key: 't:T1' }])
    expect(r.changed).toMatchObject([{ receipt: 'r3', participation: 'p-amelia', amountMinor: 30000n }])
    expect(r.unchanged).toHaveLength(2)
  })

  it('TC-IO-02 a ledger of another deal or currency is refused whole', () => {
    expect(parseLedger(fixture('ledger.csv'), 'GBP', new Set(['p-amelia'])).errors.map((e) => e.column)).toEqual(['investor_id', 'investor_id', 'investor_id'])
    expect(parseLedger(fixture('ledger.csv'), 'EUR', parts).lines).toEqual([])
    expect(
      parseLedger('transaction_id,date,amount,payer,reference,status,investor_id,currency\nT1,2026-10-06,10.00,X,Y,booked,p-ben,GBP', 'GBP', parts).errors[0],
    ).toMatchObject({
      column: 'status',
    })
  })

  it('TC-ADM-05 a formula guard in the ledger is taken off on reading', () => {
    expect(ledger().find((l) => l.transactionId === 'T6')!.payer).toBe('=cmd')
  })
})

describe('roster export for Goten (§5.7)', () => {
  const person = (over: Partial<RosterPerson>): RosterPerson => ({
    participation: 'p',
    name: 'N',
    email: 'n@example.com',
    reference: 'NW-7K2M9Q',
    dueMinor: 100000n,
    scheme: 'none',
    terminal: false,
    refundedMinor: 0n,
    onHandMinor: 0n,
    ...over,
  })
  const fixturePeople: RosterPerson[] = [
    person({ participation: 'p-amelia', name: 'Amelia Hart', email: 'amelia@example.com', reference: 'NW-7K2M9Q', dueMinor: 1040000n, scheme: 'seis' }),
    person({ participation: 'p-ben', name: '=HYPERLINK("x")', email: 'ben@example.com', reference: 'NW-AB3CD4', dueMinor: 500000n, scheme: 'eis' }),
    person({ participation: 'p-chloe', name: "O'Neil, Chloe", email: 'chloe@example.com', reference: 'NW-QR5ST6', dueMinor: 2000000n, terminal: true }),
    person({ participation: 'p-dan', name: 'Dan Never', email: 'dan@example.com', reference: null, dueMinor: null }),
  ]

  it('TC-IO-01 the export is the fixture Goten imported with no error, and it reads back the same', () => {
    const r = rosterExport(fixturePeople, 'GBP', false)
    expect(r.csv).toBe(fixture('roster.csv'))
    const rows = csvRows(r.csv)
    expect(rows[0]!.join(',')).toBe(ROSTER_HEADER)
    expect(rows.slice(1).map((x) => x[0])).toEqual(['p-amelia', 'p-ben', 'p-chloe'])
  })

  it('TC-IO-01 not exported once settled; before it, as usual', () => {
    expect(() => rosterExport(fixturePeople, 'GBP', true)).toThrow()
    expect(rosterExport(fixturePeople, 'GBP', false).noReference).toEqual([])
  })

  it('TC-IO-01 received £11,000, refund of £1,000 approved, D raised to £11,000: the export warns, Bulma short £1,000', () => {
    const r = rosterExport([person({ dueMinor: 1_100_000n, onHandMinor: 1_000_000n, refundedMinor: 100_000n })], 'GBP', false)
    expect(r.refundWarnings).toEqual([{ participation: 'p', refundedMinor: 100_000n, bulmaShortMinor: 100_000n, gotenShortMinor: 0n }])
    expect(rosterExport([person({})], 'GBP', false).refundWarnings).toEqual([])
  })

  it('TC-IO-03 a terminal person with a reference carries refund_only; someone who never committed is not exported', () => {
    const rows = csvRows(rosterExport(fixturePeople, 'GBP', false).csv)
    const at = rows[0]!.indexOf('refund_only')
    expect(rows.slice(1).map((x) => x[at])).toEqual(['', '', 'yes'])
    expect(rows.some((x) => x[0] === 'p-dan')).toBe(false)
  })

  it('TC-IO-03 committed with no reference issued: left out and named, since Goten needs one', () => {
    expect(rosterExport([person({ reference: null })], 'GBP', false)).toMatchObject({ noReference: ['p'] })
  })

  it('TC-ADM-05 text cells that a spreadsheet would run get a guard; amounts never do', () => {
    const r = rosterExport([person({ name: '+1 call', email: '@x', participation: '-p', reference: 'NW-7K2M9Q', dueMinor: 5n })], 'GBP', false)
    expect(r.csv.split('\r\n')[1]).toBe("'-p,'+1 call,'@x,NW-7K2M9Q,0.05,none,,GBP")
  })
})
