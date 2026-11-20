// D4 money screens (chunk 9d2): one bank statement for every deal with its rows to decide (R-OPS-07), money nobody's yet
// (R-OPS-04: assign, split, return with a second person), refunds from preparing to recording with a second person approving
// (R-OPS-05), hold steps and release (R-KYC-02.1), payments to check (R-PAY-07/08), and per deal the Goten roster and ledger
// read-back (§5.7). The software never pays: these are the operator's records. Every rule is checked on the server; the
// screens only show its answer.
import { useEffect, useState, type FormEvent } from 'react'
import { money } from '../lib/dealSheet.ts'
import { typedAmountToDraft } from '../lib/pounds.ts'
import { api } from './api.ts'
import { Link, useData } from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'

const amount = (m: string | null, c: string) => (m === null ? 'none' : money(BigInt(m), c))
const today = () => new Date().toISOString().slice(0, 10)
/** What was typed as an amount, in minor units for the server; text that is not an amount goes as typed and is refused there. */
const typed = (s: string) => typedAmountToDraft(s) ?? ''
const asTyped = (m: string) => {
  const p = m.padStart(3, '0')
  return `${p.slice(0, -2).replace(/^0+(?=\d)/, '')}.${p.slice(-2)}`
}

// ---------------------------------------------------------------- imports (statement and ledger)

interface PairDetail {
  id: string
  received_on: string
  amount_minor: string
  payer_name: string
  source: string
}
interface ImportRow {
  n: number
  kind: 'match' | 'unallocated' | 'added' | 'changed' | 'gone'
  line: number | null
  received_on: string | null
  amount_minor: string | null
  payer: string | null
  reference: string | null
  transaction_id: string | null
  deal_code: string | null
  investor: string | null
  reason?: string
  late?: boolean
  possible_duplicate?: boolean
  pair_details: PairDetail[]
  decision: string | null
  choices: string[]
}
interface ImportData {
  import_id: string
  currency: string
  rows: ImportRow[]
}
interface FileError {
  line: number
  column: string
  message: string
}

const ROW_KIND: Record<ImportRow['kind'], string> = {
  match: 'Matches a reference',
  unallocated: 'Nobody to match',
  added: 'New in the ledger',
  changed: 'Changed in the ledger',
  gone: 'No longer in the ledger',
}
const DECISION: Record<string, string> = {
  record: 'Record it for this person',
  pair: 'Same transfer as a receipt already recorded',
  unallocated: 'List it as unallocated money',
  skip: 'Skip it',
  reverse: 'Reverse the receipt',
  keep: 'Keep the receipt as it is',
}
const REASON: Record<string, string> = {
  no_match: 'No reference in the line matched anyone.',
  several: 'The reference matched more than one person.',
  currency_column: 'The line is marked with another currency.',
  deal_currency: 'The reference belongs to a deal in another currency.',
}
const SOURCE: Record<string, string> = {
  manual: 'by hand',
  unallocated: 'from unallocated money',
  moved: 'moved from someone else',
  statement: 'from a statement',
  ledger: 'from a ledger',
}

function FileErrors({ errors }: { errors: FileError[] }) {
  if (!errors.length) return null
  return (
    <div className="problem" role="alert" data-testid="file-errors">
      <p>Nothing was taken in. Fix the file and try again.</p>
      <ul>
        {errors.map((e) => (
          <li key={`${e.line}-${e.column}-${e.message}`}>
            {e.line ? `Line ${e.line}` : 'The file'}
            {e.column ? `, ${e.column}` : ''}: {e.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A CSV pasted or chosen from a file; the file is read here and sent as text. */
function CsvField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label>
        {label}
        <textarea required value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      <label>
        Or choose the file
        <input type="file" accept=".csv,text/csv" onChange={(e) => void e.target.files?.[0]?.text().then(onChange)} />
      </label>
    </>
  )
}

function ImportRowItem({ importId, row, currency, onDone }: { importId: string; row: ImportRow; currency: string; onDone: () => Promise<void> }) {
  const [pairWith, setPairWith] = useState(row.pair_details[0]?.id ?? '')
  const { error, run } = useRun()
  const decide = (decision: string) =>
    void run(async () => {
      await api(`/api/review/imports/${importId}/rows/${row.n}`, 'POST', decision === 'pair' ? { decision, receipt_id: pairWith } : { decision })
      await onDone()
    })
  const choices = row.choices.filter((c) => c !== 'pair' || row.pair_details.length > 0)
  return (
    <li data-testid="import-row">
      <div className="panel-head">
        <strong>{row.line ? `Line ${row.line}` : 'Receipt'}</strong>
        <span className="pill">{ROW_KIND[row.kind]}</span>
        {row.late && <span className="pill flag">after settlement</span>}
        {row.possible_duplicate && <span className="pill flag">possible duplicate</span>}
        {row.decision && <span className="pill">decided: {DECISION[row.decision] ?? row.decision}</span>}
      </div>
      <dl className="details">
        {row.received_on && (
          <div>
            <dt>Date</dt>
            <dd>{row.received_on}</dd>
          </div>
        )}
        {row.amount_minor !== null && (
          <div>
            <dt>Amount</dt>
            <dd>{amount(row.amount_minor, currency)}</dd>
          </div>
        )}
        {row.payer && (
          <div>
            <dt>Payer</dt>
            <dd>{row.payer}</dd>
          </div>
        )}
        {row.reference && (
          <div>
            <dt>Reference</dt>
            <dd className="mono">{row.reference}</dd>
          </div>
        )}
        {row.transaction_id && (
          <div>
            <dt>Transaction ID</dt>
            <dd className="mono">{row.transaction_id}</dd>
          </div>
        )}
        {row.investor && (
          <div>
            <dt>Person</dt>
            <dd>
              {row.investor} · {row.deal_code}
            </dd>
          </div>
        )}
      </dl>
      {row.reason && <p className="hint">{REASON[row.reason] ?? row.reason}</p>}
      {row.late && <p className="hint">The deal is settled: the money is recorded and then listed for refund.</p>}
      {row.possible_duplicate && (
        <p className="hint">
          Another line in this file has the same date, amount, payer and reference and there is no transaction ID: check it is not the same payment.
        </p>
      )}
      {!row.decision && row.pair_details.length > 0 && (
        <label>
          Possibly the same transfer as
          <select value={pairWith} onChange={(e) => setPairWith(e.target.value)}>
            {row.pair_details.map((p) => (
              <option key={p.id} value={p.id}>
                {amount(p.amount_minor, currency)} on {p.received_on} from {p.payer_name}, {SOURCE[p.source] ?? p.source}
              </option>
            ))}
          </select>
        </label>
      )}
      {choices.length > 0 && (
        <div className="row">
          {choices.map((c) => (
            <button key={c} type="button" className={c === choices[0] ? 'small' : 'secondary small'} onClick={() => decide(c)}>
              {DECISION[c] ?? c}
            </button>
          ))}
        </div>
      )}
      <Problem error={error} />
    </li>
  )
}

/** The rows of one import, each decided by a person; nothing counts until it is. */
export function ImportRows({ importId, onChange }: { importId: string; onChange: () => void }) {
  const { data, error, reload } = useData<ImportData>(`/api/review/imports/${importId}`)
  const done = async () => {
    await reload()
    onChange()
  }
  if (!data) return <Problem error={error} />
  const open = data.rows.filter((r) => !r.decision).length
  return (
    <div data-testid="import-rows">
      <p className="hint" role="status">
        {data.rows.length === 0
          ? 'Nothing in this file needs a decision.'
          : open === 0
            ? 'Every row is decided.'
            : `${open} of ${data.rows.length} rows to decide.`}
      </p>
      <ul className="list stacked">
        {data.rows.map((r) => (
          <ImportRowItem key={r.n} importId={importId} row={r} currency={data.currency} onDone={done} />
        ))}
      </ul>
    </div>
  )
}

interface Account {
  account: string
  currency: string
  fields: Record<string, unknown>
}
const accountWords = (a: Account) =>
  `${a.currency} · ${Object.values(a.fields)
    .filter((v) => typeof v === 'string' && v)
    .join(' · ')}`

interface StatementResult {
  import_id?: string
  errors?: FileError[]
  already_imported?: number[]
  skipped?: Array<{ line: number; amount_minor: string }>
  repeats?: number[]
  ignored_columns?: string[]
  currency?: string
}

/** R-OPS-07: the receiving account first, then the statement; every line is matched across every deal. */
export function StatementImport({ openImport, onChange }: { openImport: string | null; onChange: () => void }) {
  const { data } = useData<{ accounts: Account[] }>('/api/review/receiving-accounts')
  const [account, setAccount] = useState('')
  const [csv, setCsv] = useState('')
  const [result, setResult] = useState<StatementResult | null>(null)
  const [shown, setShown] = useState<string | null>(openImport)
  const { error, run } = useRun()
  useEffect(() => setShown(openImport), [openImport])
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api<StatementResult>('/api/review/statement-imports', 'POST', { account, csv })
      setResult(r)
      if (r.import_id) {
        setShown(r.import_id)
        setCsv('')
        onChange()
      }
    })
  }
  const c = result?.currency ?? 'GBP'
  return (
    <section className="card" data-testid="statement-import">
      <h2>Bank statement</h2>
      <p className="hint">
        One statement covers every deal paid into the account. Lines are matched by reference; a line already taken in from this account is not counted again.
        Nothing is recorded until you decide each row.
      </p>
      <form onSubmit={send}>
        <label>
          Receiving account
          <select required value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">Choose the account</option>
            {data?.accounts.map((a) => (
              <option key={a.account} value={a.account}>
                {accountWords(a)}
              </option>
            ))}
          </select>
        </label>
        <CsvField label="Statement (CSV)" value={csv} onChange={setCsv} />
        <button type="submit">Check the statement</button>
      </form>
      <Problem error={error} />
      {result?.errors && <FileErrors errors={result.errors} />}
      {result?.import_id && (
        <ul className="hint" data-testid="statement-summary">
          {!!result.already_imported?.length && <li>Already taken in before, so not counted again: lines {result.already_imported.join(', ')}.</li>}
          {!!result.skipped?.length && (
            <li>Left out as not money in: {result.skipped.map((s) => `line ${s.line} (${amount(s.amount_minor, c)})`).join(', ')}.</li>
          )}
          {!!result.repeats?.length && <li>The same details as an earlier line in this file: lines {result.repeats.join(', ')}.</li>}
          {!!result.ignored_columns?.length && <li>Columns not read: {result.ignored_columns.join(', ')}.</li>}
        </ul>
      )}
      {shown && <ImportRows key={shown} importId={shown} onChange={onChange} />}
    </section>
  )
}

// ---------------------------------------------------------------- unallocated money (R-OPS-04)

interface Person {
  participation_id: string
  currency: string
  owed_minor: string
  deal_code: string
  reference: string
  investor: string
}
interface Unallocated {
  id: string
  currency: string
  amount_minor: string
  received_on: string
  payer_name: string
  payer_account: string
  bank_ref: string
  owner: string
  owner_name: string
  days_open: number
  return_requested_by: string | null
  return_basis: string | null
  suggestions: Array<Omit<Person, 'currency' | 'owed_minor'> & { by_amount: boolean; by_name: boolean }>
}

const personWords = (p: { investor: string; deal_code: string; reference: string }) => `${p.investor} · ${p.deal_code} · ${p.reference}`

function Allocate({ row, people, onDone }: { row: Unallocated; people: Person[]; onDone: () => Promise<void> }) {
  const mine = people.filter((p) => p.currency === row.currency)
  const [parts, setParts] = useState([{ to: '', amount: asTyped(row.amount_minor) }])
  const { error, run } = useRun()
  const set = (i: number, k: 'to' | 'amount', v: string) => setParts(parts.map((p, j) => (j === i ? { ...p, [k]: v } : p)))
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/review/unallocated/${row.id}/allocate`, 'POST', { parts: parts.map((p) => ({ participation_id: p.to, amount_minor: typed(p.amount) })) })
      await onDone()
    })
  }
  return (
    <form onSubmit={send}>
      <h3>Assign it, or split it between people</h3>
      {parts.map((p, i) => (
        <div className="row" key={i}>
          <label>
            {parts.length > 1 ? `Person ${i + 1}` : 'Person'}
            <select required value={p.to} onChange={(e) => set(i, 'to', e.target.value)}>
              <option value="">Choose who it is for</option>
              {mine.map((x) => (
                <option key={x.participation_id} value={x.participation_id}>
                  {personWords(x)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount ({row.currency})
            <input required inputMode="decimal" value={p.amount} onChange={(e) => set(i, 'amount', e.target.value)} />
          </label>
        </div>
      ))}
      <div className="row">
        <button type="submit" className="small">
          {parts.length > 1 ? 'Split it' : 'Assign it'}
        </button>
        {parts.length < 20 && (
          <button type="button" className="secondary small" onClick={() => setParts([...parts, { to: '', amount: '' }])}>
            Add another person
          </button>
        )}
        {parts.length > 1 && (
          <button type="button" className="secondary small" onClick={() => setParts(parts.slice(0, -1))}>
            Remove the last person
          </button>
        )}
      </div>
      <p className="hint">A split must add up to the whole amount.</p>
      <Problem error={error} />
    </form>
  )
}

function UnallocatedItem({ row, people, me, onDone }: { row: Unallocated; people: Person[]; me: string; onDone: () => Promise<void> }) {
  const [basis, setBasis] = useState('')
  const { error, run } = useRun()
  const post = (path: string, body: unknown = {}) =>
    void run(async () => {
      await api(`/api/review/unallocated/${row.id}${path}`, 'POST', body)
      await onDone()
    })
  return (
    <li data-testid="unallocated-row">
      <div className="panel-head">
        <strong>{amount(row.amount_minor, row.currency)}</strong>
        <span className="pill">received {row.received_on}</span>
        <span className="pill">{row.days_open === 1 ? 'open 1 day' : `open ${row.days_open} days`}</span>
        {row.return_requested_by && <span className="pill flag">return asked for</span>}
      </div>
      <dl className="details">
        <div>
          <dt>Payer</dt>
          <dd>{row.payer_name}</dd>
        </div>
        <div>
          <dt>Payer account</dt>
          <dd>{row.payer_account}</dd>
        </div>
        {row.bank_ref && (
          <div>
            <dt>Bank reference</dt>
            <dd className="mono">{row.bank_ref}</dd>
          </div>
        )}
        <div>
          <dt>Who is on it</dt>
          <dd>{row.owner === me ? 'You' : row.owner_name}</dd>
        </div>
      </dl>
      {row.owner !== me && (
        <button type="button" className="secondary small" onClick={() => post('/claim')}>
          Take it over
        </button>
      )}
      {row.return_requested_by ? (
        <div className="warning">
          <p>Return to the payer asked for: {row.return_basis}</p>
          {row.return_requested_by === me ? (
            <p className="hint">Someone else must approve the return.</p>
          ) : (
            <button type="button" className="small" onClick={() => post('/return/approve')}>
              Approve the return
            </button>
          )}
          <button type="button" className="secondary small" onClick={() => post('/return/decline')}>
            Do not return it
          </button>
        </div>
      ) : (
        <>
          {row.suggestions.length > 0 && (
            <div data-testid="suggestions">
              <p className="hint">Who it may be for:</p>
              <ul className="list">
                {row.suggestions.map((s) => (
                  <li key={s.participation_id}>
                    <span>
                      {personWords(s)}{' '}
                      <span className="hint">
                        ({s.by_amount && s.by_name ? 'amount and name match' : s.by_amount ? 'the amount matches' : 'the name matches'})
                      </span>
                    </span>
                    <button
                      type="button"
                      className="small"
                      onClick={() => post('/allocate', { parts: [{ participation_id: s.participation_id, amount_minor: row.amount_minor }] })}
                    >
                      Assign all to {s.investor}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Allocate row={row} people={people} onDone={onDone} />
          <form
            onSubmit={(e) => {
              e.preventDefault()
              post('/return', { basis })
            }}
          >
            <label>
              Why it goes back to the payer (nobody could be identified)
              <textarea required minLength={3} maxLength={2000} value={basis} onChange={(e) => setBasis(e.target.value)} />
            </label>
            <button type="submit" className="secondary small">
              Ask to return it
            </button>
          </form>
        </>
      )}
      <Problem error={error} />
    </li>
  )
}

function ListByHand({ onDone }: { onDone: () => Promise<void> }) {
  const blank = { currency: 'GBP', amount: '', date: today(), payer: '', account: '', ref: '', note: '' }
  const [f, setF] = useState(blank)
  const [open, setOpen] = useState(false)
  const { error, run } = useRun()
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('/api/review/unallocated', 'POST', {
        currency: f.currency,
        amount_minor: typed(f.amount),
        received_on: f.date,
        payer_name: f.payer,
        payer_account: f.account,
        bank_ref: f.ref,
        ...(f.note.trim() ? { note: f.note } : {}),
      })
      setF(blank)
      setOpen(false)
      await onDone()
    })
  }
  if (!open)
    return (
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        List money that came in by hand
      </button>
    )
  return (
    <form onSubmit={send}>
      <h3>List money that came in</h3>
      <div className="row">
        <label>
          Currency
          <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            {['GBP', 'USD', 'EUR'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Amount
          <input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label>
          Received on
          <input required type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label>
          Payer name (or "unknown")
          <input required maxLength={200} value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })} />
        </label>
        <label>
          Payer account (or "unknown")
          <input required maxLength={200} value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} />
        </label>
        <label>
          Bank reference
          <input maxLength={500} value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} />
        </label>
      </div>
      <label>
        Note
        <textarea maxLength={2000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </label>
      <div className="row">
        <button type="submit" className="small">
          List it
        </button>
        <button type="button" className="secondary small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Problem error={error} />
    </form>
  )
}

/** R-OPS-04: money nobody's yet, oldest first, with who it may be for. */
export function UnallocatedSection({ me, version, onChange }: { me: string; version: number; onChange: () => void }) {
  const { data, error, reload } = useData<{ people: Person[]; rows: Unallocated[] }>('/api/review/unallocated')
  useEffect(() => {
    if (version) void reload()
  }, [version, reload])
  const done = async () => {
    await reload()
    onChange()
  }
  return (
    <section className="card" data-testid="unallocated">
      <h2>Money not yet assigned</h2>
      <Problem error={error} />
      {data && !data.rows.length && <p className="hint">None.</p>}
      <ul className="list stacked">
        {data?.rows.map((r) => (
          <UnallocatedItem key={r.id} row={r} people={data.people} me={me} onDone={done} />
        ))}
      </ul>
      <ListByHand onDone={done} />
    </section>
  )
}

// ---------------------------------------------------------------- refunds and holds (R-OPS-05, R-KYC-02.1)

interface RefundPayment {
  id: string
  state: 'prepared' | 'approved' | 'sent' | 'recorded' | 'cancelled'
  reason: string
  currency: string
  amount_minor: string | null
  actual_minor: string | null
  dest_name: string
  dest_account: string
  differs_from_source: boolean
  evidence: string | null
  prepared_by: string | null
  approved_by: string | null
  sent_on: string | null
  exceptions: string[] | null
}
interface MoneyRow {
  participation_id: string
  deal_id: string
  currency: string
  receipts: Array<{ id: string; received_on: string; left_minor: string; released_minor: string }>
  payer_account_known: boolean
  deal_code: string
  reference: string
  investor: string
  outcome: string
  reason: string
  reason_history: string[]
  late_money: boolean
  on_hand_minor: string
  effective_minor: string
  hold_minor: string
  released_unused_minor: string | null
  in_flight_minor: string
  refunded_minor: string
  refund_due_minor: string | null
  needs_check: boolean
  hold_step: string | null
  refunds: RefundPayment[]
}

const REFUND_STATE: Record<RefundPayment['state'], string> = {
  prepared: 'Prepared, waiting for a second person',
  approved: 'Approved, to send',
  sent: 'Sent, to record',
  recorded: 'Recorded',
  cancelled: 'Cancelled',
}
const REFUND_REASON: Record<string, string> = {
  overpaid: 'Paid more than due',
  after_allocation: 'Left after the allocation',
  released: 'Released after a refused identity check',
  withdrawn: 'Withdrew',
  removed: 'Removed by the lead',
  deal_cancelled: 'The deal was cancelled',
  excluded_at_close: 'Left out at closing',
}
const EXCEPTION: Record<string, string> = {
  no_approval: 'recorded with no approval',
  amount_differs: 'the amount differs from the approval',
  commitment_changed: 'the amount due changed after approval',
  held_meanwhile: 'a hold started after approval',
  account_differs: 'sent to another account with no evidence',
}
const HOLD_STEP: Record<string, string> = {
  none: 'No hold',
  considering: 'Being considered',
  disclosure_consent: 'Disclosure made, consent decision recorded',
  release_allowed: 'Release allowed',
}

function Prepare({ row, onDone }: { row: MoneyRow; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ amount: asTyped(row.refund_due_minor ?? '0'), other: false, name: '', account: '', evidence: '' })
  const { error, run } = useRun()
  // plan R28 (3): with no known payer account there is nothing to send it back to by default
  const other = f.other || !row.payer_account_known
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/review/participations/${row.participation_id}/refunds`, 'POST', {
        amount_minor: typed(f.amount),
        ...(other ? { dest_name: f.name, dest_account: f.account, evidence: f.evidence } : {}),
      })
      await onDone()
    })
  }
  return (
    <form onSubmit={send}>
      <h3>Prepare a refund</h3>
      <label>
        Amount ({row.currency})
        <input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
      </label>
      {row.payer_account_known ? (
        <label className="check block">
          <input type="checkbox" checked={f.other} onChange={(e) => setF({ ...f, other: e.target.checked })} />
          Send it to another account than the one the money came from
        </label>
      ) : (
        <p className="hint">The account the money came from is not known. Type the account to send it to, with the evidence for it.</p>
      )}
      {other && (
        <>
          <div className="row">
            <label>
              Account holder
              <input required maxLength={200} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <label>
              Account
              <input required maxLength={200} value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} />
            </label>
          </div>
          <label>
            Evidence for sending it there
            <textarea required minLength={3} maxLength={2000} value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} />
          </label>
        </>
      )}
      <button type="submit" className="small">
        Prepare the refund
      </button>
      <p className="hint">Someone else approves it before it is sent.</p>
      <Problem error={error} />
    </form>
  )
}

function RecordSent({ row, refund, onDone }: { row: MoneyRow; refund: RefundPayment; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ amount: asTyped(refund.amount_minor ?? '0'), on: today() })
  const { error, run } = useRun()
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/review/participations/${row.participation_id}/refund-records`, 'POST', {
        refund_id: refund.id,
        actual_minor: typed(f.amount),
        sent_on: f.on,
      })
      await onDone()
    })
  }
  return (
    <form onSubmit={send}>
      <div className="row">
        <label>
          Amount actually sent ({row.currency})
          <input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label>
          Sent on
          <input required type="date" value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} />
        </label>
      </div>
      <button type="submit" className="small">
        Record the refund
      </button>
      {refund.state === 'prepared' && <p className="hint">Recorded now, it is kept as a refund with no approval and reviewers are told.</p>}
      <Problem error={error} />
    </form>
  )
}

function RefundItem({ row, refund, me, onDone }: { row: MoneyRow; refund: RefundPayment; me: string; onDone: () => Promise<void> }) {
  const [recall, setRecall] = useState('')
  const { error, run } = useRun()
  const post = (path: string, body: unknown = {}) =>
    void run(async () => {
      await api(`/api/review/refunds/${refund.id}${path}`, 'POST', body)
      await onDone()
    })
  const open = refund.state === 'prepared' || refund.state === 'approved' || refund.state === 'sent'
  return (
    <li data-testid="refund">
      <div className="panel-head">
        <strong>{amount(refund.actual_minor ?? refund.amount_minor, row.currency)}</strong>
        <span className="pill" data-testid="refund-state">
          {REFUND_STATE[refund.state]}
        </span>
        {refund.differs_from_source && <span className="pill flag">another account</span>}
      </div>
      <p className="hint">
        To {refund.dest_name}, {refund.dest_account}
        {refund.sent_on ? ` · sent on ${refund.sent_on}` : ''}
      </p>
      {refund.evidence && <p className="hint">Evidence: {refund.evidence}</p>}
      {!!refund.exceptions?.length && <p className="warning">To check: {refund.exceptions.map((x) => EXCEPTION[x] ?? x).join('; ')}.</p>}
      {refund.state === 'prepared' &&
        (refund.prepared_by === me ? (
          <p className="hint">You prepared it, so someone else approves it.</p>
        ) : (
          <button type="button" className="small" onClick={() => post('/approve')}>
            Approve the refund
          </button>
        ))}
      {refund.state === 'approved' && (
        <button type="button" className="small" onClick={() => post('/sent')}>
          Mark as sent
        </button>
      )}
      {open && <RecordSent row={row} refund={refund} onDone={onDone} />}
      {open &&
        (refund.state === 'sent' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              post('/cancel', { recall_evidence: recall })
            }}
          >
            <label>
              Evidence the payment was recalled
              <textarea required minLength={3} maxLength={2000} value={recall} onChange={(e) => setRecall(e.target.value)} />
            </label>
            <button type="submit" className="secondary small">
              Cancel the refund
            </button>
          </form>
        ) : (
          <button type="button" className="secondary small" onClick={() => post('/cancel')}>
            Cancel the refund
          </button>
        ))}
      <Problem error={error} />
    </li>
  )
}

function HoldSteps({ row, onDone }: { row: MoneyRow; onDone: () => Promise<void> }) {
  const [basis, setBasis] = useState('')
  const left = (r: MoneyRow['receipts'][number]) => BigInt(r.left_minor) - BigInt(r.released_minor)
  const held = row.receipts.filter((r) => left(r) > 0n)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const { error, run } = useRun()
  const step = (to: string) =>
    void run(async () => {
      await api(`/api/review/participations/${row.participation_id}/hold-step`, 'POST', { step: to, basis })
      setBasis('')
      await onDone()
    })
  const release = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const items = held.flatMap((r) => (amounts[r.id]?.trim() ? [{ receipt: r.id, amount_minor: typed(amounts[r.id]!) }] : []))
      await api(`/api/review/participations/${row.participation_id}/release`, 'POST', { items, basis })
      setBasis('')
      setAmounts({})
      await onDone()
    })
  }
  const s = row.hold_step ?? 'none'
  return (
    <div className="warning" data-testid="hold">
      <p>
        Held after a refused identity check: {amount(row.hold_minor, row.currency)}. Step: {HOLD_STEP[s] ?? s}.
      </p>
      <label>
        Basis for the decision
        <textarea minLength={3} maxLength={2000} value={basis} onChange={(e) => setBasis(e.target.value)} />
      </label>
      {s === 'considering' && (
        <div className="row">
          <button type="button" className="secondary small" onClick={() => step('disclosure_consent')}>
            Record the disclosure and consent step
          </button>
          <button type="button" className="secondary small" onClick={() => step('release_allowed')}>
            Record that release is allowed
          </button>
        </div>
      )}
      {s === 'disclosure_consent' && (
        <button type="button" className="secondary small" onClick={() => step('release_allowed')}>
          Record that release is allowed
        </button>
      )}
      {s === 'release_allowed' && held.length > 0 && (
        <form onSubmit={release}>
          {held.map((r) => (
            <label key={r.id}>
              Release from {amount(r.left_minor, row.currency)} received {r.received_on} (held {amount(String(left(r)), row.currency)})
              <input inputMode="decimal" value={amounts[r.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [r.id]: e.target.value })} />
            </label>
          ))}
          <button type="submit" className="small">
            Release
          </button>
        </form>
      )}
      <Problem error={error} />
    </div>
  )
}

function MoneyItem({ row, me, onDone }: { row: MoneyRow; me: string; onDone: () => Promise<void> }) {
  const c = row.currency
  const open = row.refunds.some((r) => r.state === 'prepared' || r.state === 'approved' || r.state === 'sent')
  const due = BigInt(row.refund_due_minor ?? '0')
  return (
    <li data-testid="money-row">
      <div className="panel-head">
        <strong>{row.investor}</strong>
        <span className="pill">{row.deal_code}</span>
        <span className="pill">{REFUND_REASON[row.reason] ?? row.reason}</span>
        {row.late_money && <span className="pill flag">money after the part ended</span>}
        {row.needs_check && <span className="pill flag">needs checking</span>}
      </div>
      <p className="hint">
        <Link to={`/ops/${row.deal_id}`}>Deal page</Link> · reference <span className="mono">{row.reference}</span>
      </p>
      <dl className="details">
        <div>
          <dt>On hand</dt>
          <dd>{amount(row.on_hand_minor, c)}</dd>
        </div>
        <div>
          <dt>Counted for the deal</dt>
          <dd>{amount(row.effective_minor, c)}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{amount(row.hold_minor, c)}</dd>
        </div>
        <div>
          <dt>Being refunded</dt>
          <dd>{amount(row.in_flight_minor, c)}</dd>
        </div>
        <div>
          <dt>Refunded</dt>
          <dd>{amount(row.refunded_minor, c)}</dd>
        </div>
        <div>
          <dt>Due back</dt>
          <dd data-testid="due-back">{row.needs_check ? 'check first' : amount(row.refund_due_minor, c)}</dd>
        </div>
      </dl>
      {row.needs_check && <p className="warning">More was paid back than was received. Check the records before anything else.</p>}
      {row.reason_history.length > 1 && (
        <p className="hint">
          Earlier reasons:{' '}
          {row.reason_history
            .slice(0, -1)
            .map((r) => REFUND_REASON[r] ?? r)
            .join(', ')}
          .
        </p>
      )}
      {row.outcome === 'rejected_kyc' && BigInt(row.hold_minor) > 0n && <HoldSteps row={row} onDone={onDone} />}
      <ul className="list stacked">
        {row.refunds.map((r) => (
          <RefundItem key={r.id} row={row} refund={r} me={me} onDone={onDone} />
        ))}
      </ul>
      {!open && !row.needs_check && due > 0n && <Prepare row={row} onDone={onDone} />}
    </li>
  )
}

/** R-OPS-05: everyone with money due back, held, to check or a refund under way. */
export function RefundsSection({ me, version, onChange }: { me: string; version: number; onChange: () => void }) {
  const { data, error, reload } = useData<{ rows: MoneyRow[] }>('/api/review/refunds')
  useEffect(() => {
    if (version) void reload()
  }, [version, reload])
  const done = async () => {
    await reload()
    onChange()
  }
  return (
    <section className="card" data-testid="refunds">
      <h2>Refunds and held money</h2>
      <p className="hint">Bulma does not send money. Record here what you do at the bank; a refund needs a second person to approve it.</p>
      <Problem error={error} />
      {data && !data.rows.length && <p className="hint">Nothing due back or held.</p>}
      <ul className="list stacked">
        {data?.rows.map((r) => (
          <MoneyItem key={r.participation_id} row={r} me={me} onDone={done} />
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------- payments to check (R-PAY-07, R-PAY-08)

interface Query {
  id: string
  kind: 'wrong_reference' | 'third_party'
  status: string
  note: string | null
  decision_note: string | null
  deal_code: string
  reference: string
  investor: string
  amount_minor: string | null
  currency: string | null
  payer_name: string | null
  received_on: string | null
}

function QueryItem({ q, onDone }: { q: Query; onDone: () => Promise<void> }) {
  const [note, setNote] = useState('')
  const { error, run } = useRun()
  const decide = (decision: string) =>
    void run(async () => {
      await api(`/api/review/transfer-queries/${q.id}/decide`, 'POST', { decision, note })
      await onDone()
    })
  return (
    <li data-testid="payment-check">
      <div className="panel-head">
        <strong>{q.investor}</strong>
        <span className="pill">{q.deal_code}</span>
        <span className="pill">{q.kind === 'third_party' ? 'paid by someone else' : 'wrong reference reported'}</span>
        <span className="pill">{q.status}</span>
      </div>
      {q.amount_minor && q.currency && (
        <p className="hint">
          {amount(q.amount_minor, q.currency)} on {q.received_on} from {q.payer_name}
        </p>
      )}
      {q.note && <p className="prewrap">{q.note}</p>}
      {q.decision_note && <p className="hint">Decided: {q.decision_note}</p>}
      {q.status === 'open' && (
        <>
          <label>
            Note on the decision
            <textarea required minLength={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {q.kind === 'third_party' ? (
            <div className="row">
              <button type="button" className="small" onClick={() => decide('approved')}>
                Accept the payment
              </button>
              <button type="button" className="secondary small" onClick={() => decide('declined')}>
                Decline it
              </button>
            </div>
          ) : (
            <button type="button" className="small" onClick={() => decide('closed')}>
              Close it as dealt with
            </button>
          )}
        </>
      )}
      <Problem error={error} />
    </li>
  )
}

export function PaymentChecks({ version, onChange }: { version: number; onChange: () => void }) {
  const { data, reload } = useData<{ rows: Query[] }>('/api/review/transfer-queries')
  useEffect(() => {
    if (version) void reload()
  }, [version, reload])
  if (!data?.rows.length) return null
  const done = async () => {
    await reload()
    onChange()
  }
  return (
    <section className="card" data-testid="payment-checks">
      <h2>Payments to check</h2>
      <ul className="list stacked">
        {data.rows.map((q) => (
          <QueryItem key={q.id} q={q} onDone={done} />
        ))}
      </ul>
    </section>
  )
}

/** The import a link from the to-do list points at, read from the address and kept in step with it. */
function useImportParam() {
  const read = () => new URLSearchParams(window.location.search).get('import')
  const [v, setV] = useState(read)
  useEffect(() => {
    const on = () => setV(read())
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return v
}

/** The money page for staff: statement, unallocated money, refunds and holds, payments to check. */
export function OpsMoney({ me }: { me: string }) {
  const openImport = useImportParam()
  const [version, setVersion] = useState(0)
  const bump = () => setVersion((v) => v + 1)
  return (
    <div data-testid="ops-money">
      <p className="card">
        <Link to="/ops">Back to operations</Link>
      </p>
      <StatementImport openImport={openImport} onChange={bump} />
      <UnallocatedSection me={me} version={version} onChange={bump} />
      <RefundsSection me={me} version={version} onChange={bump} />
      <PaymentChecks version={version} onChange={bump} />
    </div>
  )
}

// ---------------------------------------------------------------- per deal: Goten roster and ledger read-back (§5.7)

interface LedgerResult {
  import_id?: string
  errors?: FileError[]
  unchanged?: number
  not_booked?: number[]
  unpaired_manual?: string[]
  ignored_columns?: string[]
}

export function GotenSection({ dealId }: { dealId: string }) {
  const ledgers = useData<{ ledgers: Array<{ id: string; name: string }> }>(`/api/review/deals/${dealId}/ledgers`)
  const [roster, setRoster] = useState<{ csv: string; no_reference: string[]; refund_warnings: unknown[]; refund_only_note: string | null } | null>(null)
  const [ledger, setLedger] = useState('')
  const [name, setName] = useState('')
  const [csv, setCsv] = useState('')
  const [result, setResult] = useState<LedgerResult | null>(null)
  const { error, run } = useRun()
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api<LedgerResult>(`/api/review/deals/${dealId}/ledger-imports`, 'POST', ledger ? { ledger_id: ledger, csv } : { ledger_name: name, csv })
      setResult(r)
      if (r.import_id) {
        setCsv('')
        await ledgers.reload()
      }
    })
  }
  return (
    <section className="card" data-testid="goten">
      <h2>Goten roster and ledger</h2>
      <button type="button" className="secondary small" onClick={() => void run(async () => setRoster(await api(`/api/review/deals/${dealId}/roster`)))}>
        Make the roster for Goten
      </button>
      {roster && (
        <>
          <label>
            Roster (CSV), to copy into Goten
            <textarea readOnly value={roster.csv} data-testid="roster" />
          </label>
          {roster.no_reference.length > 0 && <p className="hint">Left out, as no reference was issued to them: {roster.no_reference.join(', ')}.</p>}
          {roster.refund_warnings.length > 0 && <p className="warning">Some people have money refunded: check their rows in Goten.</p>}
          {roster.refund_only_note && <p className="hint">{roster.refund_only_note}</p>}
        </>
      )}
      <form onSubmit={send}>
        <h3>Read back a Goten ledger</h3>
        <label>
          Ledger
          <select value={ledger} onChange={(e) => setLedger(e.target.value)}>
            <option value="">A new ledger</option>
            {ledgers.data?.ledgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {!ledger && (
          <label>
            Name of the new ledger
            <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <CsvField label="Ledger (CSV)" value={csv} onChange={setCsv} />
        <button type="submit" className="secondary">
          Check the ledger
        </button>
      </form>
      <Problem error={error} />
      {result?.errors && <FileErrors errors={result.errors} />}
      {result?.import_id && (
        <>
          <ul className="hint">
            <li>{result.unchanged === 1 ? 'One line is unchanged.' : `${result.unchanged ?? 0} lines are unchanged.`}</li>
            {!!result.not_booked?.length && <li>Not booked in Goten, so not taken in: lines {result.not_booked.join(', ')}.</li>}
            {!!result.unpaired_manual?.length && (
              <li>Receipts recorded by hand with no ledger line: {result.unpaired_manual.length}. They stay as they are.</li>
            )}
            {!!result.ignored_columns?.length && <li>Columns not read: {result.ignored_columns.join(', ')}.</li>}
          </ul>
          <ImportRows key={result.import_id} importId={result.import_id} onChange={() => undefined} />
        </>
      )}
    </section>
  )
}

/** R-OPS-04: part or all of a receipt goes to someone else in the deal, or back to unallocated money, with the reason. */
export function MoveReceipt({
  receiptId,
  currency,
  people,
  onDone,
}: {
  receiptId: string
  currency: string
  people: Array<{ id: string; name: string; reference: string }>
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ to: 'unallocated', amount: '', reason: '' })
  const { error, run } = useRun()
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/review/receipts/${receiptId}/move`, 'POST', {
        parts: [{ participation_id: f.to === 'unallocated' ? null : f.to, amount_minor: typed(f.amount) }],
        reason: f.reason,
      })
      setOpen(false)
      onDone()
    })
  }
  if (!open)
    return (
      <button type="button" className="secondary small" onClick={() => setOpen(true)}>
        Move
      </button>
    )
  return (
    <form onSubmit={send}>
      <div className="row">
        <label>
          Move to
          <select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>
            <option value="unallocated">Back to unallocated money</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.reference}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount ({currency})
          <input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
      </div>
      <label>
        Reason
        <textarea required minLength={3} maxLength={2000} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </label>
      <div className="row">
        <button type="submit" className="small">
          Move the money
        </button>
        <button type="button" className="secondary small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Problem error={error} />
    </form>
  )
}
