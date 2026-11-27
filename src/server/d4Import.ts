// D4 statement import, Goten ledger read-back and roster export (PRD R-OPS-07, §5.7; tech design `goten_import`).
// A file is read and reviewed into a staging area; nothing counts until a person decides each row (Goten R-REC-04.3).
// Every bank line taken in is remembered per scope (a receiving account, or a named ledger) by its §5.7 identity, so a second
// import counts nothing twice; a receipt already recorded another way is paired with the line, not counted again.
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sandboxPaymentInstruction, type Mode } from '../lib/instance.ts'
import {
  lineFingerprint,
  lineKeys,
  pairCandidates,
  parseLedger,
  parseStatement,
  reviewLedger,
  reviewStatement,
  rosterExport,
  type BankLine,
  type FileError,
  type ReferenceHolder,
  type StoredReceipt,
} from '../lib/statement.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import type { Db, Tx } from '../store/db.ts'
import type { SessionUser } from './auth.ts'
import { dealById, REAL_SINCE, type Q } from './d3Core.ts'
import { staffMoneyTx } from './d4Money.ts'
import { dealCurrency, hasStake, loadMoney, NO_ACCOUNT, recordReceipt, reverseReceipt, TAKES_MONEY } from './ledger.ts'
import type { MailQueue } from './outbox.ts'
import { Refused } from './requests.ts'
import { DEMO_MIXED_STATEMENT, DEMO_MONEY_APART, DEMO_RETIRED_STATEMENT, sameDemoSide, statementSide } from '../lib/demo.ts'

export interface D4ImportDeps {
  db: Db
  k: Keyring
  mail: MailQueue
}

const Uuid = z.uuid()
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const NOT_FOUND = 'Not found.'
const STAKE = 'You cannot change money records for a deal you lead, work on, receive carry from or invest in.'
/** §5.7: the ledger read-back and the roster are for before `settled`; after it Bulma is the only ledger. */
const AFTER_SETTLED = ['settled', 'closed']
const Csv = z.string().min(1).max(1_500_000)
/** Statements carry no payer account; R-PAY-09 always writes one. */

export interface ReceivingAccount {
  account: string
  currency: string
  fields: Record<string, unknown>
}

/** R-OP-05: every receiving account the instance has had, by currency; its identity is the currency and the account fields. */
export async function receivingAccounts(c: Q): Promise<ReceivingAccount[]> {
  const mode = (await c.query<{ mode: Mode }>('SELECT mode FROM instance_profile WHERE id = 1')).rows[0]!.mode
  const out: ReceivingAccount[] = []
  const add = (currency: string, fields: Record<string, unknown>) => {
    const account = `acct:${sha(JSON.stringify([currency, Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1))]))}`
    if (!out.some((a) => a.account === account)) out.push({ account, currency, fields })
  }
  if (mode === 'sandbox') {
    for (const ccy of ['GBP', 'USD', 'EUR'] as const) {
      const { currency: _c, ...fields } = sandboxPaymentInstruction(ccy)
      add(ccy, fields)
    }
    return out
  }
  const rows = (
    await c.query<{ currency: string; account_fields: Record<string, string> }>(
      `SELECT currency, account_fields FROM payment_instruction WHERE created_at >= ${REAL_SINCE} ORDER BY currency, version DESC`,
    )
  ).rows
  for (const r of rows) add(r.currency, r.account_fields)
  return out
}

/** Receipts of these participations as the pairing rules see them: origin scope, reversed, already paired. */
async function storedReceipts(c: Q, participations: readonly string[]): Promise<StoredReceipt[]> {
  if (!participations.length) return []
  const rows = (
    await c.query<{ id: string; participation_id: string; amount_minor: string; reversed: boolean; scope: string | null; paired: boolean; paired_scopes: string[] }>(
      `SELECT r.id, r.participation_id, r.amount_minor, r.reversed_at IS NOT NULL AS reversed,
              (SELECT l.scope FROM imported_line l WHERE l.receipt_id = r.id AND l.origin) AS scope,
              EXISTS (SELECT 1 FROM imported_line l WHERE l.receipt_id = r.id AND NOT l.origin AND l.ended_at IS NULL) AS paired,
              ARRAY(SELECT l.scope FROM imported_line l WHERE l.receipt_id = r.id AND NOT l.origin AND l.ended_at IS NULL) AS paired_scopes
         FROM receipt r WHERE r.participation_id = ANY($1::uuid[]) ORDER BY r.created_at, r.id`,
      [participations],
    )
  ).rows
  return rows.map((r) => ({
    id: r.id,
    participation: r.participation_id,
    amountMinor: BigInt(r.amount_minor),
    scope: r.scope,
    reversed: r.reversed,
    paired: r.paired,
    pairedScopes: r.paired_scopes,
  }))
}

/** One row of the staging area as it was proposed. */
interface ImportRow {
  import_id: string
  n: number
  kind: 'match' | 'unallocated' | 'added' | 'changed' | 'gone'
  file_line: number | null
  key_sha256: string | null
  fingerprint_sha256: string | null
  received_on: string | null
  amount_minor: string | null
  payer: string | null
  reference: string | null
  transaction_id: string | null
  participation_id: string | null
  receipt_id: string | null
  proposal: Record<string, unknown>
  decision: string | null
  // from goten_import
  import_kind: 'statement' | 'ledger'
  /** The import's side of the demo line (R-DEMO-05). */
  demo_run: string | null
  scope: string
  currency: string
  ledger_id: string | null
}

interface StagedRow {
  kind: ImportRow['kind']
  line?: Omit<BankLine, 'otherCurrency'>
  key?: string
  participation?: string | null
  receipt?: string | null
  proposal: Record<string, unknown>
}

const DECISIONS: Record<ImportRow['kind'], readonly string[]> = {
  match: ['record', 'pair', 'unallocated', 'skip'],
  unallocated: ['unallocated', 'skip'],
  added: ['record', 'pair', 'skip'],
  changed: ['record', 'pair', 'keep'],
  gone: ['reverse', 'keep'],
}

export function registerD4Import(app: FastifyInstance, d: D4ImportDeps) {
  const money = { config: { gate: 'canRecordMoney' as const } }
  const moneyTx = <T>(who: SessionUser, fn: (c: Tx) => Promise<T>) => staffMoneyTx(d.db, who, fn)

  /** Writes the staging rows; returns the import's ID. */
  async function stage(
    c: Tx,
    who: SessionUser,
    head: { kind: 'statement' | 'ledger'; scope: string; currency: string; ledgerId: string | null; csv: string; demoRun: string | null },
    rows: StagedRow[],
  ): Promise<string> {
    const id = randomUUID()
    await c.query('INSERT INTO goten_import (id, kind, scope, currency, ledger_id, file_sha256, uploaded_by, demo_run) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      id,
      head.kind,
      head.scope,
      head.currency,
      head.ledgerId,
      sha(head.csv),
      who.id,
      head.demoRun,
    ])
    let n = 0
    for (const r of rows) {
      const l = r.line
      await c.query(
        `INSERT INTO goten_import_row (import_id, n, kind, file_line, key_sha256, fingerprint_sha256, received_on, amount_minor, payer, reference, transaction_id,
                                       participation_id, receipt_id, proposal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          ++n,
          r.kind,
          l?.line ?? null,
          r.key ? sha(r.key) : null,
          l ? sha(lineFingerprint(l)) : null,
          l?.date ?? null,
          l ? String(l.amountMinor) : null,
          l?.payer ?? null,
          l?.reference ?? null,
          l?.transactionId ?? null,
          r.participation ?? null,
          r.receipt ?? null,
          JSON.stringify(r.proposal),
        ],
      )
    }
    await appendAudit(c, d.k, { actor: who.id, action: `import.${head.kind}`, entity: id, detail: { rows: rows.length } })
    return id
  }

  // ---------- R-OPS-07: one statement for every deal ----------

  app.get('/api/review/receiving-accounts', money, async () => ({ accounts: await receivingAccounts(d.db) }))

  app.post('/api/review/statement-imports', money, async (req) => {
    const who = req.user!
    const b = z.strictObject({ account: z.string().max(200).default(''), csv: Csv }).parse(req.body)
    return moneyTx(who, async (c) => {
      // R-OPS-07: the receiving account first; the currency is the account's, never the matched deal's
      const acct = (await receivingAccounts(c)).find((a) => a.account === b.account)
      if (!acct) throw new Refused('Choose the receiving account the statement is from.')
      const parsed = parseStatement(b.csv, acct.currency)
      if (parsed.errors.length) return { errors: parsed.errors }
      const holders: ReferenceHolder[] = []
      const currencies = new Map<string, string>()
      const people = (
        await c.query<{ id: string; deal_id: string; reference: string; state: string; demo_run: string | null }>(
          `SELECT p.id, p.deal_id, p.reference, dl.state, dl.demo_run FROM participation p JOIN deal dl ON dl.id = p.deal_id WHERE p.created_at >= ${REAL_SINCE}`,
        )
      ).rows
      for (const p of people) {
        if (!currencies.has(p.deal_id)) currencies.set(p.deal_id, await dealCurrency(c, p.deal_id))
        holders.push({ participation: p.id, reference: p.reference, currency: currencies.get(p.deal_id)!, settled: AFTER_SETTLED.includes(p.state) })
      }
      const keys = lineKeys(parsed.lines)
      const known = await knownKeys(c, acct.account, parsed.lines, keys)
      const first = reviewStatement({ lines: parsed.lines, accountCurrency: acct.currency, scope: acct.account, holders, known, receipts: [] })
      if (first.errors.length) return { errors: first.errors }
      const matched = [...new Set(first.rows.flatMap((r) => (r.kind === 'match' ? [r.participation] : [])))]
      // R-DEMO-05: the statement is on the side of the people it matches; both sides at once is refused whole. A line
      // remembered from an earlier upload, recorded or skipped, keeps counting for the side of the import that took it, so
      // the same file uploaded again cannot leave its other lines on the other side (Codex r1 #1, r2 #1)
      const runOf = new Map(people.map((p) => [p.id, p.demo_run]))
      const remembered = first.rows.flatMap((r) => (r.kind === 'already_imported' ? [sha(r.key)] : []))
      const rememberedSides = remembered.length
        ? (
            await c.query<{ demo_run: string | null; hidden: boolean }>(
              `SELECT g.demo_run, g.id IS NULL AS hidden FROM imported_line l LEFT JOIN goten_import g ON g.id = l.import_id
               WHERE l.scope = $1 AND l.key_sha256 = ANY($2::text[])`,
              [acct.account, remembered],
            )
          ).rows
        : []
      // the import of a retired run is hidden from the app: what the file was cannot be told, so it is not guessed
      if (rememberedSides.some((r) => r.hidden)) throw new Refused(DEMO_RETIRED_STATEMENT)
      const side = statementSide([...matched.map((m) => runOf.get(m)!), ...rememberedSides.map((r) => r.demo_run)])
      if (!side) throw new Refused(DEMO_MIXED_STATEMENT)
      const review = reviewStatement({
        lines: parsed.lines,
        accountCurrency: acct.currency,
        scope: acct.account,
        holders,
        known,
        receipts: await storedReceipts(c, matched),
      })
      const byLine = new Map(parsed.lines.map((l) => [l.line, l]))
      const already = review.rows.filter((r) => r.kind === 'already_imported').map((r) => r.line)
      const staged = review.rows.flatMap((r): StagedRow[] =>
        r.kind === 'match'
          ? [
              {
                kind: 'match' as const,
                line: byLine.get(r.line)!,
                key: r.key,
                participation: r.participation,
                proposal: { late: r.late, pair_with: r.pairWith, possible_duplicate: r.possibleDuplicate },
              },
            ]
          : r.kind === 'unallocated'
            ? [{ kind: 'unallocated' as const, line: byLine.get(r.line)!, key: r.key, proposal: { reason: r.reason, possible_duplicate: r.possibleDuplicate } }]
            : [],
      )
      const id = await stage(c, who, { kind: 'statement', scope: acct.account, currency: acct.currency, ledgerId: null, csv: b.csv, demoRun: side.side }, staged)
      return {
        import_id: id,
        currency: acct.currency,
        rows: await rowsOf(c, id),
        already_imported: already,
        skipped: parsed.skipped.map((s) => ({ line: s.line, amount_minor: String(s.amountMinor) })),
        repeats: parsed.repeats,
        ignored_columns: parsed.ignoredColumns,
      }
    })
  })

  /** Keys already taken in this scope, keyed by this file's own keys (only their hashes are stored). */
  async function knownKeys(c: Q, scope: string, lines: readonly BankLine[], keys: readonly string[]): Promise<Map<string, string>> {
    const stored = new Map(
      (
        await c.query<{ key_sha256: string; fingerprint_sha256: string }>('SELECT key_sha256, fingerprint_sha256 FROM imported_line WHERE scope = $1', [scope])
      ).rows.map((r) => [r.key_sha256, r.fingerprint_sha256]),
    )
    const out = new Map<string, string>()
    lines.forEach((l, i) => {
      const had = stored.get(sha(keys[i]!))
      if (had === undefined) return
      const fp = lineFingerprint(l)
      out.set(keys[i]!, had === sha(fp) ? fp : 'other details')
    })
    return out
  }

  // ---------- §5.7: Goten ledger read-back, one named ledger per file ----------

  app.get<{ Params: { id: string } }>('/api/review/deals/:id/ledgers', money, async (req) => {
    const deal = Uuid.parse(req.params.id)
    const rows = (await d.db.query<{ id: string; name: string }>('SELECT id, name FROM goten_ledger WHERE deal_id = $1 ORDER BY created_at, id', [deal])).rows
    return { ledgers: rows }
  })

  app.post<{ Params: { id: string } }>('/api/review/deals/:id/ledger-imports', money, async (req) => {
    const who = req.user!
    const dealId = Uuid.parse(req.params.id)
    const b = z
      .strictObject({ ledger_id: Uuid.optional(), ledger_name: z.string().trim().min(1).max(100).optional(), csv: Csv })
      .refine((x) => (x.ledger_id === undefined) !== (x.ledger_name === undefined), 'Choose a ledger, or name a new one.')
      .parse(req.body)
    return moneyTx(who, async (c) => {
      const deal = await dealById(c, dealId, true)
      if (!deal || deal.from_sandbox) throw new Refused(NOT_FOUND)
      await ledgerDealOpen(c, who, dealId)
      let ledgerId = b.ledger_id
      if (ledgerId) {
        if (!(await c.query('SELECT 1 FROM goten_ledger WHERE id = $1 AND deal_id = $2', [ledgerId, dealId])).rowCount) throw new Refused(NOT_FOUND)
      } else {
        // R28 (1): the operator names the ledger at its first import
        if ((await c.query('SELECT 1 FROM goten_ledger WHERE deal_id = $1 AND name = $2', [dealId, b.ledger_name])).rowCount)
          throw new Refused('This deal already has a ledger with that name. Choose it instead.')
        ledgerId = randomUUID()
        await c.query('INSERT INTO goten_ledger (id, deal_id, name, created_by) VALUES ($1, $2, $3, $4)', [ledgerId, dealId, b.ledger_name, who.id])
      }
      const scope = `ledger:${ledgerId}`
      const currency = await dealCurrency(c, dealId)
      const pids = (await c.query<{ id: string }>('SELECT id FROM participation WHERE deal_id = $1', [dealId])).rows.map((r) => r.id)
      const parsed = parseLedger(b.csv, currency, new Set(pids))
      if (parsed.errors.length) return { errors: parsed.errors as FileError[] }
      const keys = lineKeys(parsed.lines)
      const shaToKey = new Map(keys.map((k) => [sha(k), k]))
      const prior = (
        await c.query<{ receipt_id: string; key_sha256: string; participation_id: string; amount_minor: string }>(
          `SELECT l.receipt_id, l.key_sha256, r.participation_id, r.amount_minor FROM imported_line l JOIN receipt r ON r.id = l.receipt_id
            WHERE l.scope = $1 AND l.ended_at IS NULL AND r.reversed_at IS NULL`,
          [scope],
        )
      ).rows.map((p) => ({
        receipt: p.receipt_id,
        key: shaToKey.get(p.key_sha256) ?? p.key_sha256,
        participation: p.participation_id,
        amountMinor: BigInt(p.amount_minor),
      }))
      const review = reviewLedger({ lines: parsed.lines, scope, prior, receipts: await storedReceipts(c, pids) })
      const byLine = new Map(parsed.lines.map((l) => [l.line, l]))
      const id = await stage(c, who, { kind: 'ledger', scope, currency, ledgerId, csv: b.csv, demoRun: deal.demo_run }, [
        ...review.added.map((a) => ({
          kind: 'added' as const,
          line: byLine.get(a.line)!,
          key: a.key,
          participation: a.participation,
          proposal: { pair_with: a.pairWith },
        })),
        ...review.changed.map((a) => ({
          kind: 'changed' as const,
          line: byLine.get(a.line)!,
          key: a.key,
          participation: a.participation,
          receipt: a.receipt,
          proposal: { pair_with: a.pairWith },
        })),
        ...review.gone.map((g) => ({ kind: 'gone' as const, receipt: g.receipt, proposal: {} })),
      ])
      return {
        import_id: id,
        ledger_id: ledgerId,
        rows: await rowsOf(c, id),
        unchanged: review.unchanged.length,
        not_booked: parsed.lines.filter((l) => !l.participation).map((l) => l.line),
        // TC-IO-02: receipts recorded by hand that no import has been paired with stay, marked
        unpaired_manual: review.unpairedManual,
        ignored_columns: parsed.ignoredColumns,
      }
    })
  })

  /** The ledger read-back is for a deal taking money and not yet settled, by someone with no stake in it. */
  async function ledgerDealOpen(c: Q, who: SessionUser, dealId: string): Promise<void> {
    const state = (await c.query<{ state: string }>('SELECT state FROM deal WHERE id = $1', [dealId])).rows[0]!.state
    if (!TAKES_MONEY.includes(state)) throw new Refused('Money is recorded for a deal only from launch on.')
    if (AFTER_SETTLED.includes(state)) throw new Refused('Once the deal is settled, Bulma is the only ledger: record money here, not from Goten.')
    if (await hasStake(c, who, dealId)) throw new Refused(STAKE)
  }

  // ---------- the review table and each decision ----------

  async function rowsOf(c: Q, importId: string) {
    const rows = (
      await c.query<ImportRow & { deal_code: string | null; investor: string | null }>(
        `SELECT x.n, x.kind, x.file_line, to_char(x.received_on, 'YYYY-MM-DD') AS received_on, x.amount_minor, x.payer, x.reference, x.transaction_id,
                x.participation_id, x.receipt_id, x.proposal, x.decision, dl.public_code AS deal_code, u.name AS investor
           FROM goten_import_row x
           LEFT JOIN participation p ON p.id = coalesce(x.participation_id, (SELECT participation_id FROM receipt WHERE id = x.receipt_id))
           LEFT JOIN deal dl ON dl.id = p.deal_id LEFT JOIN user_account u ON u.id = p.user_id
          WHERE x.import_id = $1 ORDER BY x.n`,
        [importId],
      )
    ).rows
    // what a person needs to say "the same transfer": each receipt offered for pairing, as recorded
    const offered = [...new Set(rows.flatMap((r) => (r.proposal as { pair_with?: string[] }).pair_with ?? []))]
    const details = new Map(
      (offered.length
        ? await c.query<{ id: string; received_on: string; amount_minor: string; payer_name: string; source: string }>(
            "SELECT id, to_char(received_on, 'YYYY-MM-DD') AS received_on, (amount_minor - moved_out_minor)::text AS amount_minor, payer_name, source FROM receipt WHERE id = ANY($1::uuid[])",
            [offered],
          )
        : { rows: [] }
      ).rows.map((x) => [x.id, x]),
    )
    return rows.map((r) => ({
      n: r.n,
      kind: r.kind,
      line: r.file_line,
      received_on: r.received_on,
      amount_minor: r.amount_minor,
      payer: r.payer,
      reference: r.reference,
      transaction_id: r.transaction_id,
      participation_id: r.participation_id,
      receipt_id: r.receipt_id,
      deal_code: r.deal_code,
      investor: r.investor,
      ...r.proposal,
      pair_details: ((r.proposal as { pair_with?: string[] }).pair_with ?? []).flatMap((id) => (details.has(id) ? [details.get(id)!] : [])),
      decision: r.decision,
      choices: r.decision ? [] : DECISIONS[r.kind],
    }))
  }

  app.get<{ Params: { id: string } }>('/api/review/imports/:id', money, async (req) => {
    const id = Uuid.parse(req.params.id)
    const head = (
      await d.db.query<{ kind: string; currency: string; ledger_id: string | null }>(
        `SELECT kind, currency, ledger_id FROM goten_import WHERE id = $1 AND created_at >= ${REAL_SINCE}`,
        [id],
      )
    ).rows[0]
    if (!head) throw new Refused(NOT_FOUND)
    return { import_id: id, kind: head.kind, currency: head.currency, ledger_id: head.ledger_id, rows: await rowsOf(d.db, id) }
  })

  app.post<{ Params: { id: string; n: string } }>('/api/review/imports/:id/rows/:n', money, async (req) => {
    const who = req.user!
    const id = Uuid.parse(req.params.id)
    const n = z.coerce.number().int().min(1).max(20_000).parse(req.params.n)
    const b = z.strictObject({ decision: z.enum(['record', 'pair', 'unallocated', 'skip', 'reverse', 'keep']), receipt_id: Uuid.optional() }).parse(req.body)
    const out = await moneyTx(who, async (c) => {
      const row = (
        await c.query<ImportRow>(
          `SELECT x.*, to_char(x.received_on, 'YYYY-MM-DD') AS received_on, g.kind AS import_kind, g.scope, g.currency, g.ledger_id, g.demo_run
             FROM goten_import_row x JOIN goten_import g ON g.id = x.import_id
            WHERE x.import_id = $1 AND x.n = $2 AND g.created_at >= ${REAL_SINCE} FOR UPDATE OF x`,
          [id, n],
        )
      ).rows[0]
      if (!row) throw new Refused(NOT_FOUND)
      if (row.decision) throw new Refused('This row has already been decided.')
      if (!DECISIONS[row.kind].includes(b.decision)) throw new Refused('That is not a choice for this row.')
      if (b.decision === 'pair' && !b.receipt_id) throw new Refused('Choose the receipt this line is the same transfer as.')
      const result = await decide(c, who, row, b.decision, b.receipt_id)
      await c.query('UPDATE goten_import_row SET decision = $3, decided_by = $4, decided_at = clock_timestamp() WHERE import_id = $1 AND n = $2', [
        id,
        n,
        b.decision,
        who.id,
      ])
      await appendAudit(c, d.k, { actor: who.id, action: 'import.decided', entity: id, detail: { n, decision: b.decision } })
      return { ok: true, ...result }
    }).catch((e: { code?: string; constraint?: string }) => {
      // two people taking the same line, or the same receipt paired twice, at once
      if (e.code === '23505' && (e.constraint === 'imported_line_once' || e.constraint === 'imported_line_receipt_scope'))
        throw new Refused('This line, or that receipt, was taken in meanwhile.')
      throw e
    })
    await d.mail.flush()
    return out
  })

  async function decide(c: Tx, who: SessionUser, row: ImportRow, decision: string, receiptId: string | undefined): Promise<Record<string, unknown>> {
    const ledgerName = row.ledger_id ? (await c.query<{ name: string }>('SELECT name FROM goten_ledger WHERE id = $1', [row.ledger_id])).rows[0]!.name : ''
    const reason = `No longer booked in the Goten ledger "${ledgerName}"; confirmed by a person.`
    if (row.kind === 'gone' || row.kind === 'changed') {
      const pid = (await c.query<{ participation_id: string }>('SELECT participation_id FROM receipt WHERE id = $1', [row.receipt_id])).rows[0]!
        .participation_id
      const dealId = (await c.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [pid])).rows[0]!.deal_id
      await dealById(c, dealId, true)
      await ledgerDealOpen(c, who, dealId)
      if (decision === 'keep') return {}
      // §5.7: a full snapshot; what is gone (or now different) is undone only now that a person has said so
      await endLine(c, who, row.scope, row.receipt_id!, reason)
      if (row.kind === 'gone') return {}
    }
    if (row.import_kind === 'statement' && row.participation_id) {
      // matched to someone's deal: whoever has a stake in it decides nothing about the line, not even to set it aside or skip it
      const dealId = (await c.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [row.participation_id])).rows[0]!.deal_id
      const deal = (await dealById(c, dealId, true))!
      // R-DEMO-05: checked again when a person decides (plan 05 §4.3), not only when the statement was read
      if (!sameDemoSide(deal.demo_run, row.demo_run)) throw new Refused(DEMO_MONEY_APART)
      if (await hasStake(c, who, dealId)) throw new Refused(STAKE)
    }
    if (row.kind === 'unallocated' || (row.kind === 'match' && decision === 'unallocated')) return toUnallocated(c, who, row, decision)
    if (decision === 'skip') {
      // a statement is never read again in full, so its line is remembered as looked at; a ledger line comes back next import
      if (row.import_kind === 'statement') {
        await freeKey(c, who, row)
        await takeLine(c, who, row, { origin: false })
      }
      return {}
    }
    const pid = row.participation_id!
    const dealId = (await c.query<{ deal_id: string }>('SELECT deal_id FROM participation WHERE id = $1', [pid])).rows[0]!.deal_id
    await dealById(c, dealId, true)
    if (row.import_kind === 'ledger') await ledgerDealOpen(c, who, dealId)
    else {
      const state = (await c.query<{ state: string }>('SELECT state FROM deal WHERE id = $1', [dealId])).rows[0]!.state
      if (!TAKES_MONEY.includes(state)) throw new Refused('Money is recorded for a deal only from launch on.')
      if (await hasStake(c, who, dealId)) throw new Refused(STAKE)
    }
    if ((await dealCurrency(c, dealId)) !== row.currency) throw new Refused('The money is in another currency from the deal.')
    await freeKey(c, who, row)
    if (decision === 'pair') {
      // §5.7: the same transfer recorded another way; counted once, by the receipt already there
      await loadMoney(c, pid, true)
      const candidates = pairCandidates(await storedReceipts(c, [pid]), pid, BigInt(row.amount_minor!), row.scope)
      if (!candidates.includes(receiptId!)) throw new Refused('That receipt cannot be paired with this line.')
      await takeLine(c, who, row, { origin: false, receipt: receiptId })
      await appendAudit(c, d.k, { actor: who.id, action: 'receipt.paired', entity: receiptId!, detail: { import: row.import_id, n: row.n } })
      return { receipt_id: receiptId }
    }
    if (row.import_kind === 'ledger') {
      // §5.7: this line was once paired with money recorded another way (by hand, a statement, another ledger), which stays when
      // the pairing ends; while that record counts, recording the line (`changed` now, or `added` after it was gone) would count
      // one transfer twice. That record is put right first; the transaction undoes the pairing just ended.
      const paired = await c.query(
        `SELECT 1 FROM imported_line l JOIN receipt r ON r.id = l.receipt_id
          WHERE l.scope = $1 AND l.key_sha256 = $2 AND NOT l.origin AND r.reversed_at IS NULL`,
        [row.scope, row.key_sha256],
      )
      if (paired.rowCount)
        throw new Refused(
          'This line was paired with money recorded another way, which still counts. Reverse that receipt first if the ledger is right, then import the ledger again; or choose another answer for this line.',
        )
    }
    const r = await recordReceipt(c, d.k, d.mail, who.id, {
      participationId: pid,
      amount: BigInt(row.amount_minor!),
      currency: row.currency,
      receivedOn: row.received_on!,
      payerName: row.payer?.trim() || 'unknown',
      payerAccount: NO_ACCOUNT,
      note: row.reference?.trim() ? row.reference.slice(0, 2000) : null,
      source: row.import_kind,
    })
    await takeLine(c, who, row, { origin: true, receipt: r.id })
    return { receipt_id: r.id, payer_mismatch: r.payerMismatch }
  }

  /** R-OPS-04: a statement line nobody can be matched to (or a person says so) goes to the unallocated list. */
  async function toUnallocated(c: Tx, who: SessionUser, row: ImportRow, decision: string): Promise<Record<string, unknown>> {
    await freeKey(c, who, row)
    if (decision === 'skip') {
      await takeLine(c, who, row, { origin: false })
      return {}
    }
    const id = randomUUID()
    await c.query(
      `INSERT INTO unallocated_receipt (id, currency, amount_minor, received_on, payer_name, payer_account, bank_ref, note, owner, entered_by, demo_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)`,
      [
        id,
        row.currency,
        row.amount_minor,
        row.received_on,
        row.payer?.trim() || 'unknown',
        NO_ACCOUNT,
        (row.reference ?? '').slice(0, 500),
        row.proposal.reason === 'currency_column' ? 'The statement row names another currency.' : null,
        who.id,
        // R-DEMO-05: the money keeps its statement's side
        row.demo_run,
      ],
    )
    await takeLine(c, who, row, { origin: true, unallocated: id })
    await appendAudit(c, d.k, { actor: who.id, action: 'unallocated.listed', entity: id, detail: { import: row.import_id } })
    return { unallocated_id: id }
  }

  /** The line's key in its scope must be free; a ledger line whose receipt someone reversed by hand frees it. */
  async function freeKey(c: Tx, who: SessionUser, row: ImportRow): Promise<void> {
    const live = (
      await c.query<{ id: string; reversed: boolean | null }>(
        `SELECT l.id, (SELECT r.reversed_at IS NOT NULL FROM receipt r WHERE r.id = l.receipt_id) AS reversed
           FROM imported_line l WHERE l.scope = $1 AND l.key_sha256 = $2 AND l.ended_at IS NULL FOR UPDATE`,
        [row.scope, row.key_sha256],
      )
    ).rows[0]
    if (row.import_kind === 'statement') {
      if ((await c.query('SELECT 1 FROM imported_line WHERE scope = $1 AND key_sha256 = $2', [row.scope, row.key_sha256])).rowCount)
        throw new Refused('This line was taken in already.')
      return
    }
    if (!live) return
    if (!live.reversed) throw new Refused('This line was taken in already.')
    await c.query('UPDATE imported_line SET ended_at = clock_timestamp(), ended_by = $2 WHERE id = $1', [live.id, who.id])
  }

  async function takeLine(c: Tx, who: SessionUser, row: ImportRow, t: { origin: boolean; receipt?: string; unallocated?: string }): Promise<void> {
    await c.query(
      `INSERT INTO imported_line (id, scope, key_sha256, fingerprint_sha256, receipt_id, unallocated_id, origin, import_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), row.scope, row.key_sha256, row.fingerprint_sha256, t.receipt ?? null, t.unallocated ?? null, t.origin, row.import_id, who.id],
    )
  }

  /** Ends the receipt's live line in this ledger; a receipt made from that line is reversed, one paired from elsewhere stays. */
  async function endLine(c: Tx, who: SessionUser, scope: string, receiptId: string, reason: string): Promise<void> {
    const l = (
      await c.query<{ id: string; origin: boolean }>(
        'SELECT id, origin FROM imported_line WHERE scope = $1 AND receipt_id = $2 AND ended_at IS NULL FOR UPDATE',
        [scope, receiptId],
      )
    ).rows[0]
    if (!l) throw new Refused('This receipt has changed since the import. Import the ledger again.')
    await c.query('UPDATE imported_line SET ended_at = clock_timestamp(), ended_by = $2 WHERE id = $1', [l.id, who.id])
    if (l.origin) await reverseReceipt(c, d.k, who.id, receiptId, reason)
  }

  // ---------- §5.7 roster for Goten ----------

  app.get<{ Params: { id: string } }>('/api/review/deals/:id/roster', money, async (req) => {
    const dealId = Uuid.parse(req.params.id)
    const deal = (await d.db.query<{ state: string }>(`SELECT state FROM deal WHERE id = $1 AND created_at >= ${REAL_SINCE}`, [dealId])).rows[0]
    if (!deal) throw new Refused(NOT_FOUND)
    if (!TAKES_MONEY.includes(deal.state)) throw new Refused('The roster is exported from launch on.')
    if (AFTER_SETTLED.includes(deal.state)) throw new Refused('Once the deal is settled, Bulma is the only ledger: the roster is no longer exported.')
    const people = (
      await d.db.query<{
        id: string
        outcome: string
        scheme: 'none' | 'seis' | 'eis'
        cash_due_minor: string
        reference: string
        issued: boolean
        name: string
        email: string
      }>(
        `SELECT p.id, p.outcome, p.scheme, p.cash_due_minor, p.reference, u.email,
                EXISTS (SELECT 1 FROM issued_instruction i WHERE i.participation_id = p.id) AS issued,
                coalesce(v.fields->>'full_name', v.fields->>'name', '') AS name
           FROM participation p JOIN user_account u ON u.id = p.user_id
           JOIN legal_entity e ON e.id = p.entity_id JOIN legal_entity_version v ON v.entity_id = e.id AND v.version = e.current_version
          WHERE p.deal_id = $1 ORDER BY p.join_seq`,
        [dealId],
      )
    ).rows
    const roster = []
    for (const p of people) {
      const m = (await loadMoney(d.db, p.id))!
      roster.push({
        participation: p.id,
        name: p.name,
        email: p.email,
        // §5.7: everyone a reference was issued to, so their money matches someone
        reference: p.issued ? p.reference : null,
        dueMinor: BigInt(p.cash_due_minor),
        scheme: p.scheme,
        terminal: p.outcome !== 'active',
        refundedMinor: m.figures.refunded + m.figures.inFlight,
        onHandMinor: m.figures.onHand,
      })
    }
    const out = rosterExport(roster, await dealCurrency(d.db, dealId), false)
    return {
      csv: out.csv,
      no_reference: out.noReference,
      refund_warnings: out.refundWarnings.map((w) => ({
        participation_id: w.participation,
        refunded_minor: String(w.refundedMinor),
        bulma_short_minor: String(w.bulmaShortMinor),
        goten_short_minor: String(w.gotenShortMinor),
      })),
      // R28 (2): Goten does not read the column yet; it says so and ignores it
      refund_only_note: roster.some((r) => r.terminal && r.reference) ? 'Goten ignores the refund_only column for now: mark those people by hand there.' : null,
    }
  })
}
