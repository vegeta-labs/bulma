// Goten I-09 CSV reading and writing, shared by the statement import, the ledger read-back and the roster export (PRD §5.7, §5.8).
// Pure. A file is UTF-8 text; the first line is the header.

/** Splits a whole file into rows. CRLF, LF and CR may be mixed in any order; a line break inside quotes stays in the cell. */
export function csvRows(text: string): string[][] {
  const src = text.startsWith('﻿') ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const endRow = () => {
    row.push(cell)
    rows.push(row)
    row = []
    cell = ''
  }
  while (i < src.length) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (ch === '"') quoted = false
      else cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' || ch === '\n') {
      endRow()
      if (ch === '\r' && src[i + 1] === '\n') i++
    } else cell += ch
    i++
  }
  if (quoted) throw new CsvError('A quoted cell is not closed before the end of the file.')
  if (cell !== '' || row.length) endRow()
  // blank lines say nothing
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

export class CsvError extends Error {}

/** I-09 import: a ' in front of = + - @, a tab, a carriage return or another ' is the export's guard and comes off. */
export const uncell = (v: string) => (/^'[=+\-@\t\r']/.test(v) ? v.slice(1) : v)

/** I-09: identifiers and parsed fields lose leading and trailing ASCII whitespace only (space, tab, CR, LF). */
export const trimAscii = (v: string) => v.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')

/** Goten I-09 export: a text cell a spreadsheet would run as a formula, or one already starting with ', gets a ' in front. */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r']/.test(v) ? `'${v}` : v
  // a tab is quoted too: a line with an unquoted tab reads back as tab-separated in the lead's paste box (Codex round 10)
  return /[",\n\r\t]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
