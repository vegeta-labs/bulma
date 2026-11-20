// The lead's list of expected investors (PRD R-PIP-01 to R-PIP-04). Pure: parsing what was pasted or uploaded, and the counts.
import { z } from 'zod'
import { uncell } from './csv.ts'

export const MAX_PIPELINE_ROWS = 500

/**
 * The longest text an export of a full list can be (Codex round 11). A cell of n characters is at most 2n + 4 once csvCell
 * has quoted it; a row is name 200, email 320, amount, label 100, note 2,000 and status, with five commas and a newline.
 */
export const PIPELINE_TEXT_MAX = 3_000_000
/** The request that carries it: JSON writes one character as at most 6 bytes (a control character as \u0000). */
export const PIPELINE_BODY_MAX = 6 * PIPELINE_TEXT_MAX + 1024

export interface PipelineRow {
  name: string
  email: string
  expected_minor: string | null
  terms_label: string
  private_note: string | null
}

export interface ParseResult {
  rows: PipelineRow[]
  /** 1-based line numbers as the person sees them. */
  errors: Array<{ line: number; message: string }>
  /** Addresses that appear more than once, here or already on the list. */
  duplicates: string[]
}

/** Splits one line of CSV (quotes allowed) or tab-separated text. */
function cells(line: string): string[] {
  if (line.includes('\t') && !line.includes('"')) return line.split('\t')
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"' && !cur.trim()) quoted = true
    else if (ch === ',' || ch === '\t') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** "£10,000", "10000", "10,000.50" → minor units; blank → null; anything else → undefined (an error). */
export function readAmount(raw: string): string | null | undefined {
  const t = raw.trim().replace(/^[£$€]/, '')
  if (!t) return null
  const m = /^(\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return undefined
  const minor = BigInt(m[1]!.replace(/,/g, '')) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0')
  return minor > 0n && minor <= 100_000_000_000n ? String(minor) : undefined
}

const isEmail = (v: string) => v.length <= 320 && z.email().safeParse(v).success

/**
 * R-PIP-01: name, email, expected amount, terms label, private note. A header row is skipped. A bad row names its line and
 * adds nothing; the good rows are still returned so the person can decide. `existing` are the addresses already listed.
 */
export function parsePipeline(text: string, existing: readonly string[], room: number): ParseResult {
  const errors: ParseResult['errors'] = []
  const rows: PipelineRow[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const seen = new Map<string, number>()
  for (const e of existing) seen.set(e.trim().toLowerCase(), 0)
  const duplicates = new Set<string>()
  // the list as exported (PIPELINE_CSV_HEADER) reads back: its status column is the app's, so it is left out (Codex round 9)
  let statusColumn = false
  lines.forEach((line, i) => {
    const n = i + 1
    if (!line.trim()) return
    const c = cells(line).map((x) => uncell(x.trim()))
    if (i === 0 && /^name$/i.test(c[0] ?? '') && /mail/i.test(c[1] ?? '')) {
      statusColumn = /^status$/i.test(c[5] ?? '')
      return
    }
    const [name = '', email = '', amount = '', label = '', note = ''] = c
    if (c.slice(statusColumn ? 6 : 5).some((x) => x))
      return errors.push({ line: n, message: 'This line has more than five columns: name, email, expected amount, terms label, note.' })
    if (!name || name.length > 200) return errors.push({ line: n, message: 'Give a name of up to 200 characters.' })
    if (!isEmail(email)) return errors.push({ line: n, message: 'Give a valid email address.' })
    const expected = readAmount(amount)
    if (expected === undefined) return errors.push({ line: n, message: 'The expected amount is not a valid amount.' })
    if (label.length > 100) return errors.push({ line: n, message: 'The terms label is longer than 100 characters.' })
    if (note.length > 2000) return errors.push({ line: n, message: 'The note is longer than 2000 characters.' })
    const key = email.toLowerCase()
    if (seen.has(key)) duplicates.add(key)
    seen.set(key, n)
    if (rows.length >= room) return errors.push({ line: n, message: `The list holds at most ${MAX_PIPELINE_ROWS} people.` })
    rows.push({ name, email, expected_minor: expected, terms_label: label, private_note: note || null })
  })
  return { rows, errors, duplicates: [...duplicates] }
}

/** The columns of the exported list; the file reads back through parsePipeline with nothing lost. */
export const PIPELINE_CSV_HEADER = 'name,email,expected,terms,note,status'

export { csvCell } from './csv.ts'

/** One version of the operator's text on whom to invite (R-PIP-06), as shown and as confirmed. */
export interface PolicyVersion {
  version: number
  sha256: string
}

/**
 * R-PIP-06: a list is imported and a targeted invitation sent only after this lead confirmed the version in force now.
 * A confirmation of an older version, or with other words under the same number, does not count. The software cannot
 * tell whether the lead really knows these people; this is friction and evidence only.
 */
export function inviteePolicyRefusal(current: PolicyVersion | null, confirmed: readonly PolicyVersion[]): string | null {
  if (!current) return 'The operator has not written whom leads may invite, so no list can be imported and no invitation sent. Ask the operator.'
  if (confirmed.some((x) => x.version === current.version && x.sha256 === current.sha256)) return null
  return confirmed.length
    ? 'The operator changed its text on whom you may invite. Read the new version and confirm it first.'
    : 'Read the operator’s text on whom you may invite and confirm it first.'
}

/**
 * R-PIP-04: committed is Σ T of the active participations (the allocation's measure); expected is what the lead typed for
 * the rows not yet committed, so a row that committed is never counted twice; allocation is the deal's SPV allocation.
 */
export function pipelineTotals(activeInvest: readonly bigint[], rows: readonly { committed: boolean; expected_minor: string | null }[]) {
  return {
    committed: activeInvest.reduce((a, t) => a + t, 0n),
    expected: rows.filter((r) => !r.committed).reduce((a, r) => a + BigInt(r.expected_minor ?? '0'), 0n),
  }
}
