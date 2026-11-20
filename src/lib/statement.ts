// Money coming in from files (PRD R-OPS-07, §5.7, R-PAY-09) and the roster going out to Goten (§5.7, TC-IO-01/03).
// Pure: the server reads what is stored, calls these, and writes only what a person confirms.
//
// Three files, all Goten I-09 CSV:
// - a bank statement (Goten §5.5 columns) for one receiving account, matched across the whole instance by payment reference
//   (C-REC-1, C-REC-2); a period, not a full snapshot, so rows it lacks are never offered for reversal;
// - Goten's exported reconciliation ledger for one deal (its `ledgerCsv`), read back as one receipt per booked bank line; a full
//   snapshot within its ledger, so a booked line that is gone is offered for reversal;
// - the roster Bulma exports for Goten to import (Goten §5.5 commitments columns, plus `refund_only`, decision R28 (2)).
import { csvCell, CsvError, csvRows, trimAscii, uncell } from './csv.ts'
import { normaliseReference } from './reference.ts'

export const MAX_FILE_ROWS = 5000
/** Goten LIMITS: transaction ID 80, payer and reference 200 characters. */
const TXN_MAX = 80
const TEXT_MAX = 200
/** The receipt table's limit, which is Goten I-01's 1,000,000,000.00. */
const AMOUNT_MAX = 100_000_000_000n

export interface FileError {
  /** 1-based row number in the file, the header being row 1; 0 for the file as a whole. */
  line: number
  column: string
  message: string
}

// ---------------------------------------------------------------- shared readers

const SYMBOLS: Record<string, string[]> = { GBP: ['£'], EUR: ['€'], USD: ['US$', '$'] }

/** Goten I-01: `£1,250.50`, `-45.00`, `10000`; the symbol, when written, is the account's. Minor units, or null when unreadable. */
export function readMoney(raw: string, currency: string): bigint | null {
  const m = /^(-)?(£|€|US\$|\$)?(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(trimAscii(raw))
  if (!m || (m[1] && m[3])) return null
  if (m[2] && !(SYMBOLS[currency] ?? []).includes(m[2])) return null
  const v = BigInt(m[4]!.replace(/,/g, '')) * 100n + BigInt((m[5] ?? '').padEnd(2, '0'))
  if (v > AMOUNT_MAX) return null
  return m[1] || m[3] ? -v : v
}

/** The earliest day money is recorded as received, as the routes that take a typed day refuse anything earlier. */
export const MIN_MONEY_DATE = '2000-01-01'

/** Goten I-04: `YYYY-MM-DD` or `D/M/YYYY` (always day first); a day that does not exist is refused. ISO out, or null. */
export function readDate(raw: string): string | null {
  const t = trimAscii(raw)
  let y: number, mo: number, d: number
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else return null
  const at = new Date(Date.UTC(y, mo - 1, d))
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Goten I-01 export: `-45.00`, `5000.00`; no symbol, no separators. */
export const plainMoney = (minor: bigint) =>
  `${minor < 0n ? '-' : ''}${(minor < 0n ? -minor : minor) / 100n}.${String((minor < 0n ? -minor : minor) % 100n).padStart(2, '0')}`

const MARKS: Record<string, string[]> = { GBP: ['£', 'gbp'], EUR: ['€', 'eur'], USD: ['$', 'us$', 'usd'] }
const ANY_MARK = new Set(Object.values(MARKS).flat())

/**
 * Goten §5.5 headers: lower case, trimmed; a trailing `(£)` or ` gbp` is a currency mark and must be the account's. Returns the
 * bare name, or an error message.
 */
function headerName(raw: string, currency: string): { name: string } | { error: string } {
  let h = raw.trim().toLowerCase()
  const own = MARKS[currency] ?? [currency.toLowerCase()]
  const bracket = /\s*\(([^)]*)\)\s*$/.exec(h)
  const word = /\s+([a-z]{3})$/.exec(h)
  // a bracket or last word that is no currency mark stays part of the name, as in Goten
  if (bracket && (ANY_MARK.has(bracket[1]!.trim()) || bracket[1]!.trim() === currency.toLowerCase())) {
    const mark = bracket[1]!.trim()
    if (!own.includes(mark) && mark !== currency.toLowerCase()) return { error: `The column is marked ${bracket[1]}, but the account is in ${currency}.` }
    h = h.slice(0, bracket.index).trim()
  } else if (word && (ANY_MARK.has(word[1]!) || word[1] === currency.toLowerCase())) {
    if (!own.includes(word[1]!) && word[1] !== currency.toLowerCase()) return { error: `The column is marked ${word[1]}, but the account is in ${currency}.` }
    h = h.slice(0, word.index).trim()
  }
  return { name: h }
}

interface Field {
  key: string
  required: boolean
  aliases: string[]
}

interface Table {
  rows: Array<{ line: number; cells: Record<string, string> }>
  ignored: string[]
  errors: FileError[]
}

/** Reads the header against `fields` (plus `currency`/`ccy`), then every row into its named cells, ' guard taken off. */
function readTable(text: string, fields: Field[], currency: string): Table {
  const errors: FileError[] = []
  let raw: string[][]
  try {
    raw = csvRows(text)
  } catch (e) {
    if (e instanceof CsvError) return { rows: [], ignored: [], errors: [{ line: 0, column: '', message: e.message }] }
    throw e
  }
  if (!raw.length) return { rows: [], ignored: [], errors: [{ line: 0, column: '', message: 'The file is empty.' }] }
  if (raw.length - 1 > MAX_FILE_ROWS)
    return { rows: [], ignored: [], errors: [{ line: 0, column: '', message: `A file holds at most ${MAX_FILE_ROWS} rows.` }] }
  const all: Field[] = [...fields, { key: 'currency', required: false, aliases: ['ccy'] }]
  const at = new Map<string, number>()
  const ignored: string[] = []
  raw[0]!.forEach((h, i) => {
    const r = headerName(h, currency)
    if ('error' in r) return errors.push({ line: 1, column: h, message: r.error })
    const f = all.find((x) => x.key === r.name || x.aliases.includes(r.name))
    if (!f) return ignored.push(h)
    if (at.has(f.key)) return errors.push({ line: 1, column: h, message: `Two columns are both ${f.key}.` })
    at.set(f.key, i)
  })
  for (const f of fields) if (f.required && !at.has(f.key)) errors.push({ line: 1, column: f.key, message: `The column ${f.key} is missing.` })
  if (errors.length) return { rows: [], ignored, errors }
  const width = raw[0]!.length
  const rows: Table['rows'] = []
  raw.slice(1).forEach((r, i) => {
    const line = i + 2
    if (r.length !== width) return errors.push({ line, column: '', message: `This row has ${r.length} cells; the header has ${width}.` })
    if (r.every((c) => trimAscii(c) === '')) return
    const cells: Record<string, string> = {}
    for (const [k, idx] of at) cells[k] = uncell(r[idx]!)
    rows.push({ line, cells })
  })
  return { rows, ignored, errors }
}

// ---------------------------------------------------------------- bank statement

const STATEMENT_FIELDS: Field[] = [
  { key: 'transaction_id', required: false, aliases: ['id', 'transaction id', 'txn id'] },
  { key: 'date', required: true, aliases: ['value date', 'booking date'] },
  { key: 'amount', required: true, aliases: ['credit', 'paid in'] },
  { key: 'payer', required: false, aliases: ['payer name', 'counterparty', 'from', 'name'] },
  { key: 'reference', required: false, aliases: ['description', 'payment reference', 'narrative'] },
]

export interface BankLine {
  line: number
  transactionId: string | null
  date: string
  amountMinor: bigint
  /** Free text, exactly as in the file (I-09). */
  payer: string
  reference: string
  /** R-OPS-07: the row's own currency cell, upper case, when it names one other than the account's. Such a row counts in no N. */
  otherCurrency: string | null
}

export interface ParsedStatement {
  lines: BankLine[]
  /** Goten R-REC-02.3: money out or zero, listed and left out. */
  skipped: Array<{ line: number; amountMinor: bigint }>
  /** Goten R-REC-02.2: a row repeating an earlier one of the same transaction ID and the same details, counted once. */
  repeats: number[]
  ignoredColumns: string[]
  /** Non-empty: nothing in the file is taken (Goten R-REC-02.4). */
  errors: FileError[]
}

const sameDetails = (a: BankLine, b: BankLine) => a.date === b.date && a.amountMinor === b.amountMinor && a.payer === b.payer && a.reference === b.reference

/**
 * R-OPS-07: a statement of the receiving account chosen first; its currency is the account's. Goten §5.5 columns and I-01, I-04,
 * I-09. Unlike Goten, a currency cell naming another currency is not an error: the row goes to unallocated money (R-OPS-04).
 */
export function parseStatement(text: string, accountCurrency: string): ParsedStatement {
  const t = readTable(text, STATEMENT_FIELDS, accountCurrency)
  const out: ParsedStatement = { lines: [], skipped: [], repeats: [], ignoredColumns: t.ignored, errors: t.errors }
  const byId = new Map<string, BankLine>()
  for (const { line, cells } of t.rows) {
    const err = (column: string, message: string) => out.errors.push({ line, column, message })
    const id = trimAscii(cells.transaction_id ?? '') || null
    const date = readDate(cells.date ?? '')
    const amount = readMoney(cells.amount ?? '', accountCurrency)
    const payer = cells.payer ?? ''
    const reference = cells.reference ?? ''
    const ccy = trimAscii(cells.currency ?? '').toUpperCase()
    if (id && id.length > TXN_MAX) err('transaction_id', `A transaction ID is at most ${TXN_MAX} characters.`)
    if (!date) err('date', 'Write the date as YYYY-MM-DD or DD/MM/YYYY.')
    else if (date < MIN_MONEY_DATE) err('date', 'A date before 2000 is not read as money received.')
    if (amount === null) err('amount', 'The amount is not a valid amount in the account currency.')
    if (payer.length > TEXT_MAX) err('payer', `The payer is at most ${TEXT_MAX} characters.`)
    if (reference.length > TEXT_MAX) err('reference', `The reference is at most ${TEXT_MAX} characters.`)
    if (ccy && !/^[A-Z]{3}$/.test(ccy)) err('currency', 'The currency is not a three-letter code.')
    if (!date || amount === null || out.errors.some((e) => e.line === line)) continue
    if (amount <= 0n) {
      out.skipped.push({ line, amountMinor: amount })
      continue
    }
    const l: BankLine = { line, transactionId: id, date, amountMinor: amount, payer, reference, otherCurrency: ccy && ccy !== accountCurrency ? ccy : null }
    if (id) {
      const first = byId.get(id)
      if (first) {
        if (sameDetails(first, l) && first.otherCurrency === l.otherCurrency) out.repeats.push(line)
        else err('transaction_id', `Transaction ${id} is also on row ${first.line} with other details.`)
        continue
      }
      byId.set(id, l)
    }
    out.lines.push(l)
  }
  if (out.errors.length) out.lines = []
  return out
}

/**
 * §5.7 identity of one bank line within its scope (a ledger, or a receiving account for statements): the transaction ID, or
 * when there is none the date, amount, payer and reference with which time that combination appears in the file, since two
 * identical transfers on one day are real (TC-IO-02). Re-importing the same file gives the same keys.
 */
export function lineKeys(lines: ReadonlyArray<Pick<BankLine, 'transactionId' | 'date' | 'amountMinor' | 'payer' | 'reference'>>): string[] {
  const seen = new Map<string, number>()
  return lines.map((l) => {
    if (l.transactionId) return `t:${l.transactionId}`
    const combo = JSON.stringify([l.date, String(l.amountMinor), l.payer, l.reference])
    const n = (seen.get(combo) ?? 0) + 1
    seen.set(combo, n)
    return `c:${combo}#${n}`
  })
}

/** What a key's line held, so a stored key seen again with other details is a conflict, not a repeat (Goten R-REC-02.2). */
export const lineFingerprint = (l: Pick<BankLine, 'date' | 'amountMinor' | 'payer' | 'reference'>) =>
  JSON.stringify([l.date, String(l.amountMinor), l.payer, l.reference])

/** Goten C-REC-2 run over the memo: every 1 to 3 neighbouring parts joined, C-REC-1 normalised. */
function memoRuns(memo: string): Set<string> {
  const parts = memo
    // C-REC-1: every ASCII character other than a letter or digit separates, control characters included
    // oxlint-disable-next-line no-control-regex
    .split(/[\x00-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/)
    .filter(Boolean)
    .map(normaliseReference)
  const runs = new Set<string>()
  for (let i = 0; i < parts.length; i++) {
    let joined = ''
    for (let k = i; k < Math.min(parts.length, i + 3); k++) runs.add((joined += parts[k]))
  }
  return runs
}

/** A payment reference somewhere in the instance (C-REF-1 makes them unique once normalised). */
export interface ReferenceHolder {
  participation: string
  reference: string
  /** The deal's currency. */
  currency: string
  /** R-OPS-07: money for a `settled` deal is late money, listed for refund. */
  settled: boolean
}

/** A receipt already stored, for pairing (§5.7: the same transfer from another route is counted once). */
export interface StoredReceipt {
  id: string
  participation: string
  amountMinor: bigint
  /** null for a receipt recorded by hand; otherwise the ledger or account it was imported from. */
  scope: string | null
  reversed: boolean
  /** Already paired with another receipt, or another receipt already points at it. */
  paired: boolean
  /** The scopes whose lines are paired with it now: a receipt carries at most one line from each scope (§5.7). */
  pairedScopes: readonly string[]
}

export type UnallocatedReason = 'no_match' | 'several' | 'currency_column' | 'deal_currency'

export type StatementRow =
  | { line: number; key: string; kind: 'already_imported' }
  | { line: number; key: string; kind: 'unallocated'; reason: UnallocatedReason; possibleDuplicate: boolean }
  | {
      line: number
      key: string
      kind: 'match'
      participation: string
      /** Settled deal: recorded, then listed for refund. */
      late: boolean
      /** Receipts this may be the same transfer as; a person says yes (point the receipt at this line) or no. */
      pairWith: string[]
      possibleDuplicate: boolean
    }

export interface StatementReview {
  rows: StatementRow[]
  /** A stored key with other details: the whole file is refused, as Goten refuses an import conflict. */
  errors: FileError[]
}

/**
 * R-OPS-07 review table. Nothing here is written: a match is a proposal until a person confirms it (Goten R-REC-04.3).
 * `known` holds every key already taken from this account (receipts and unallocated rows alike) with its fingerprint.
 */
export function reviewStatement(i: {
  lines: readonly BankLine[]
  accountCurrency: string
  scope: string
  holders: readonly ReferenceHolder[]
  known: ReadonlyMap<string, string>
  receipts: readonly StoredReceipt[]
}): StatementReview {
  const byRef = new Map<string, ReferenceHolder[]>()
  for (const h of i.holders) {
    const n = normaliseReference(h.reference)
    if (n) byRef.set(n, [...(byRef.get(n) ?? []), h])
  }
  const keys = lineKeys(i.lines)
  const combos = new Map<string, number>()
  for (const l of i.lines) if (!l.transactionId) combos.set(lineFingerprint(l), (combos.get(lineFingerprint(l)) ?? 0) + 1)
  const rows: StatementRow[] = []
  const errors: FileError[] = []
  i.lines.forEach((l, n) => {
    const key = keys[n]!
    const had = i.known.get(key)
    if (had !== undefined) {
      if (had !== lineFingerprint(l))
        errors.push({ line: l.line, column: 'transaction_id', message: `Transaction ${l.transactionId} was imported before with other details.` })
      else rows.push({ line: l.line, key, kind: 'already_imported' })
      return
    }
    // Goten R-REC-02.2: identical lines with no ID may be one transfer imported twice; a person looks before anything counts
    const possibleDuplicate = !l.transactionId && (combos.get(lineFingerprint(l)) ?? 0) > 1
    if (l.otherCurrency) return rows.push({ line: l.line, key, kind: 'unallocated', reason: 'currency_column', possibleDuplicate })
    const found = new Map<string, ReferenceHolder>()
    for (const run of memoRuns(l.reference)) for (const h of byRef.get(run) ?? []) found.set(h.participation, h)
    if (found.size === 0) return rows.push({ line: l.line, key, kind: 'unallocated', reason: 'no_match', possibleDuplicate })
    if (found.size > 1) return rows.push({ line: l.line, key, kind: 'unallocated', reason: 'several', possibleDuplicate })
    const h = [...found.values()][0]!
    // R-OPS-07: the currency is the account's, never taken from the deal the reference belongs to
    if (h.currency !== i.accountCurrency) return rows.push({ line: l.line, key, kind: 'unallocated', reason: 'deal_currency', possibleDuplicate })
    rows.push({
      line: l.line,
      key,
      kind: 'match',
      participation: h.participation,
      late: h.settled,
      pairWith: pairCandidates(i.receipts, h.participation, l.amountMinor, i.scope),
      possibleDuplicate,
    })
  })
  return { rows: errors.length ? [] : rows, errors }
}

/**
 * §5.7: a receipt of the same person and amount from another route (by hand, or another file) may be this same transfer. One
 * already paired with a line from a third route is still offered: the same transfer can come back from the bank and from Goten.
 */
export function pairCandidates(receipts: readonly StoredReceipt[], participation: string, amountMinor: bigint, scope: string): string[] {
  return receipts
    .filter((r) => r.participation === participation && r.amountMinor === amountMinor && !r.reversed && r.scope !== scope && !r.pairedScopes.includes(scope))
    .map((r) => r.id)
}

// ---------------------------------------------------------------- Goten ledger read-back

/** Goten `ledgerCsv`: `transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency`. */
const LEDGER_FIELDS: Field[] = [
  { key: 'transaction_id', required: true, aliases: [] },
  { key: 'date', required: true, aliases: [] },
  { key: 'amount', required: true, aliases: [] },
  { key: 'payer', required: true, aliases: [] },
  { key: 'reference', required: true, aliases: [] },
  { key: 'status', required: true, aliases: [] },
  { key: 'investor_id', required: true, aliases: [] },
]
const LEDGER_STATUSES = new Set(['auto', 'confirmed', 'suggested', 'unmatched', 'rejected', 'skipped', 'future'])
/** §5.7: only booked lines count; lines waiting for review or not booked do not. */
const BOOKED = new Set(['auto', 'confirmed'])

export interface LedgerLine extends Omit<BankLine, 'otherCurrency'> {
  status: string
  /** The participation ID exported as `investor_id`; set on booked lines only. */
  participation: string | null
}

export interface ParsedLedger {
  /** Every bank line in file order (keys count over all of them); `participation` set on booked ones. */
  lines: LedgerLine[]
  ignoredColumns: string[]
  errors: FileError[]
}

/**
 * Reads Goten's ledger export for one deal. Every row must carry the deal's currency, and a booked row must name a participation
 * of this deal (the roster exported `investor_id` = participation ID), else the file is refused whole: it is another deal's.
 */
export function parseLedger(text: string, dealCurrency: string, participations: ReadonlySet<string>): ParsedLedger {
  const t = readTable(text, LEDGER_FIELDS, dealCurrency)
  const out: ParsedLedger = { lines: [], ignoredColumns: t.ignored, errors: t.errors }
  for (const { line, cells } of t.rows) {
    const err = (column: string, message: string) => out.errors.push({ line, column, message })
    const id = trimAscii(cells.transaction_id ?? '') || null
    const date = readDate(cells.date ?? '')
    const amount = readMoney(cells.amount ?? '', dealCurrency)
    const status = trimAscii(cells.status ?? '')
    const investor = trimAscii(cells.investor_id ?? '')
    const ccy = trimAscii(cells.currency ?? '').toUpperCase()
    if (id && id.length > TXN_MAX) err('transaction_id', `A transaction ID is at most ${TXN_MAX} characters.`)
    if (!date) err('date', 'The date is not YYYY-MM-DD or DD/MM/YYYY.')
    else if (date < MIN_MONEY_DATE) err('date', 'A date before 2000 is not read as money received.')
    if (amount === null) err('amount', 'The amount is not a valid amount in the deal currency.')
    if (!LEDGER_STATUSES.has(status)) err('status', 'The status is not one Goten writes.')
    if (ccy !== dealCurrency) err('currency', `Every row must be in the deal currency, ${dealCurrency}.`)
    const booked = BOOKED.has(status)
    if (booked && !participations.has(investor)) err('investor_id', 'This investor is not in this deal.')
    if (booked && amount !== null && amount <= 0n) err('amount', 'A booked line must be money in.')
    if (out.errors.some((e) => e.line === line)) continue
    out.lines.push({
      line,
      transactionId: id,
      date: date!,
      amountMinor: amount!,
      payer: cells.payer ?? '',
      reference: cells.reference ?? '',
      status,
      participation: booked ? investor : null,
    })
  }
  if (out.errors.length) out.lines = []
  return out
}

/** A receipt that came from this ledger before, still counted (not reversed). */
export interface PriorLedgerReceipt {
  receipt: string
  key: string
  participation: string
  amountMinor: bigint
}

export interface LedgerReview {
  /** Booked now, not before: a proposed receipt, with receipts it may be the same transfer as. */
  added: Array<{ line: number; key: string; participation: string; amountMinor: bigint; pairWith: string[] }>
  unchanged: Array<{ line: number; key: string; receipt: string }>
  /** Booked before and now, but to another person or for another amount: reverse the old receipt and take the new line. */
  changed: Array<{ line: number; key: string; receipt: string; participation: string; amountMinor: bigint; pairWith: string[] }>
  /** Booked before, not booked (or absent) now: a person confirms before it is reversed (§5.7 full snapshot). */
  gone: Array<{ receipt: string; key: string }>
  /** Receipts recorded by hand for this deal that no import has been paired with; they stay, marked (TC-IO-02). */
  unpairedManual: string[]
}

/** §5.7 read-back: a suggestion only; nothing changes until a person confirms each part. */
export function reviewLedger(i: {
  lines: readonly LedgerLine[]
  scope: string
  prior: readonly PriorLedgerReceipt[]
  receipts: readonly StoredReceipt[]
}): LedgerReview {
  const keys = lineKeys(i.lines)
  const prior = new Map(i.prior.map((p) => [p.key, p]))
  const out: LedgerReview = { added: [], unchanged: [], changed: [], gone: [], unpairedManual: [] }
  const still = new Set<string>()
  i.lines.forEach((l, n) => {
    if (!l.participation) return
    const key = keys[n]!
    const p = prior.get(key)
    if (!p)
      return out.added.push({
        line: l.line,
        key,
        participation: l.participation,
        amountMinor: l.amountMinor,
        pairWith: pairCandidates(i.receipts, l.participation, l.amountMinor, i.scope),
      })
    still.add(key)
    if (p.participation === l.participation && p.amountMinor === l.amountMinor) return out.unchanged.push({ line: l.line, key, receipt: p.receipt })
    out.changed.push({
      line: l.line,
      key,
      receipt: p.receipt,
      participation: l.participation,
      amountMinor: l.amountMinor,
      pairWith: pairCandidates(i.receipts, l.participation, l.amountMinor, i.scope),
    })
  })
  for (const p of i.prior) if (!still.has(p.key)) out.gone.push({ receipt: p.receipt, key: p.key })
  out.unpairedManual = i.receipts.filter((r) => r.scope === null && !r.reversed && !r.paired).map((r) => r.id)
  return out
}

// ---------------------------------------------------------------- roster export

export interface RosterPerson {
  participation: string
  name: string
  email: string
  /** The payment reference issued, or null when none was ever issued. */
  reference: string | null
  /** D; null for someone who never committed. */
  dueMinor: bigint | null
  scheme: 'none' | 'seis' | 'eis'
  /** In a terminal state (§5.2): exported with `refund_only` so their money is matched, not chased. */
  terminal: boolean
  /** Refunds recorded plus in flight (approved or sent), the same measure as N (§5.7). */
  refundedMinor: bigint
  /** N. */
  onHandMinor: bigint
}

export interface RosterExport {
  csv: string
  /** Committed but no reference issued: Goten needs one, so the row is left out and named. */
  noReference: string[]
  /**
   * §5.7: Goten counts gross money received, so for anyone with money refunded or on its way back its chase figures are smaller
   * than Bulma's. Shown before the download.
   */
  refundWarnings: Array<{ participation: string; refundedMinor: bigint; bulmaShortMinor: bigint; gotenShortMinor: bigint }>
}

export const ROSTER_HEADER = 'investor_id,name,email,reference,cash_due,scheme,refund_only,currency'
const SCHEME_OUT = { none: 'none', seis: 'SEIS', eis: 'EIS' } as const

/**
 * §5.7 roster for Goten's commitments import (Goten §5.5 columns, I-09). Everyone with a reference and a D; terminal people
 * flagged `refund_only` (decision R28 (2): Goten ignores the column and says so, so the export also warns). Only before
 * `settled`: after it Bulma is the only ledger.
 */
export function rosterExport(people: readonly RosterPerson[], currency: string, settled: boolean): RosterExport {
  if (settled) throw new RangeError('the roster is not exported once the deal is settled')
  const out: RosterExport = { csv: '', noReference: [], refundWarnings: [] }
  const lines = [ROSTER_HEADER]
  for (const p of people) {
    if (p.dueMinor === null) continue
    if (!p.reference) {
      out.noReference.push(p.participation)
      continue
    }
    lines.push(
      [
        csvCell(p.participation),
        csvCell(p.name),
        csvCell(p.email),
        csvCell(p.reference),
        plainMoney(p.dueMinor),
        SCHEME_OUT[p.scheme],
        p.terminal ? 'yes' : '',
        currency,
      ].join(','),
    )
    if (p.refundedMinor > 0n) {
      const short = (got: bigint) => (p.dueMinor! > got ? p.dueMinor! - got : 0n)
      out.refundWarnings.push({
        participation: p.participation,
        refundedMinor: p.refundedMinor,
        bulmaShortMinor: short(p.onHandMinor),
        gotenShortMinor: short(p.onHandMinor + p.refundedMinor),
      })
    }
  }
  out.csv = lines.join('\r\n') + '\r\n'
  return out
}
