// The files the export writes into the pack (plan 05 §5.3, §5.7): what each must not hold, and what must stay the same when
// it is read twice. Kept out of scripts/demo-snapshot.ts so each rule is tested on its own (files.test.ts; Codex P r1 #3, #7).
import { SECTION_TITLE, SECTION_TITLE_SIZE, SECTIONS } from '../../src/lib/evidence.ts'
import { pdfLines, pdfText } from '../../src/server/pdfText.ts'
import { FILE_FIELDS } from './fields.ts'
import { pdfStrings } from './pack.ts'
import { csvFields, secretsIn, unknownFields, type Answer } from './record.ts'

/**
 * Why a file may not go into the pack: it still holds one of `secrets` (a PDF in its drawn text, any decoded string, name or
 * stream, metadata in an object stream too, and its raw bytes), or a JSON or CSV file names a field not on FILE_FIELDS.
 */
export async function fileProblems(path: string, type: string, bytes: Buffer, secrets: readonly string[]): Promise<string[]> {
  const pdf = type === 'application/pdf'
  const text = pdf ? (await pdfText(bytes)).join('\n') : bytes.toString('utf8')
  const seen = pdf ? `${await pdfStrings(bytes)}\n${bytes.toString('latin1')}` : `${text}\n${bytes.toString('latin1')}`
  if (secretsIn(seen, secrets).length) return [`${path} still holds a secret`]
  const fields = type === 'application/json' ? unknownFields(JSON.parse(text), FILE_FIELDS) : type === 'text/csv' ? csvFields(text, FILE_FIELDS) : []
  return fields.length ? [`${path} carries fields not on FILE_FIELDS in scripts/demo-export/fields.ts; check each and add it:\n${fields.join('\n')}`] : []
}

/** The evidence pack's item for the software version in use, whose `until` is the person's last action. */
const VERSION_ITEM = /^Software version \S+ in use for this person's actions$/
const SECTION_TITLES = new Set(SECTIONS.map((k) => SECTION_TITLE[k]))
const VERSIONS_TITLE = SECTION_TITLE.versions

/**
 * What must be the same when a file is read twice: its status, type, name and bytes. The evidence pack is made afresh on each
 * download and says when, and how late the person's last action was, which the export's own reading moves (opening and
 * accepting the invitation). So for the evidence download only, two values are left out and nothing else (Codex P r2 #3): the
 * JSON's top-level `generated_at` and the `until` of the versions section's software-version item; in the PDF the time on the
 * "Made:" line (its software version stays) and the "until:" line right after that item.
 */
export async function fileFace(a: Answer, bytes: Buffer | undefined): Promise<unknown> {
  if (!a.file || !bytes) return a
  const { status, file } = a
  const face = { status, type: file.type, name: file.name }
  const evidence = /^evidence-pack\.(json|pdf)$/.test(file.name ?? '')
  if (evidence && file.type === 'application/json') {
    const j = JSON.parse(bytes.toString('utf8')) as {
      generated_at?: unknown
      software_version?: unknown
      sections?: Array<{ key?: unknown; items?: Array<{ what?: unknown; fields?: Record<string, unknown> }> }>
    }
    if ('software_version' in j) delete j.generated_at
    for (const s of j.sections ?? [])
      if (s.key === 'versions') for (const item of s.items ?? []) if (typeof item.what === 'string' && VERSION_ITEM.test(item.what) && item.fields) delete item.fields.until
    return { ...face, json: j }
  }
  if (evidence && file.type === 'application/pdf') {
    const lines = await pdfLines(bytes)
    const text = lines.map((l) => l.text)
    // where they are, not what a line looks like (Codex P r3 #3): the Made: line of the heading, before the first section,
    // and the until: lines after the last section's title, which is the versions section's, so no kept text can look like them.
    // A section's title is a line of that text drawn at the title's size, which nothing else is (Codex P r5 #3: a deal name
    // may hold a line that reads as a title). The heading's own Made: line is its last one: the person's and the deal's names
    // come before it and may hold one of their own (Codex P r4 #3); only the fixed sentence on the kept texts' hashes follows it.
    const title = (i: number) => lines[i]!.size === SECTION_TITLE_SIZE && SECTION_TITLES.has(text[i]!)
    const first = text.findIndex((_, i) => title(i))
    const made = text.slice(0, first < 0 ? text.length : first).findLastIndex((l) => l.startsWith('Made: '))
    if (made >= 0) text[made] = text[made]!.replace(/^Made: \S+, (software version .*)$/, 'Made: (when), $1')
    const versions = text.findLastIndex((l, i) => title(i) && l === VERSIONS_TITLE)
    if (versions >= 0 && versions > text.findLastIndex((l, i) => title(i) && l !== VERSIONS_TITLE))
      for (let i = versions + 1; i < text.length; i++)
        if (/^until: \S+$/.test(text[i]!) && VERSION_ITEM.test(text[i - 1]!.replace(/^\S+ {1,2}/, ''))) text[i] = 'until: (when)'
    return { ...face, text }
  }
  return { ...face, bytes: bytes.toString('base64') }
}

/**
 * Where two values first differ, as a path (`$.sections[2].items[0].fields.until`), or null when they are the same: the
 * export's report names the place only, never the values, which may hold a secret not yet replaced (Codex P r2 #12). Objects
 * compare by their keys, not their order.
 */
export function firstDifference(a: unknown, b: unknown, at = '$'): string | null {
  if (a === b) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at} (length)`
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${at}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>]
    for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
      if (!(k in x) || !(k in y)) return `${at}.${k} (only in one)`
      const d = firstDifference(x[k], y[k], `${at}.${k}`)
      if (d) return d
    }
    return null
  }
  return at
}

/**
 * A recorded answer's key for the export's report: the view, the method, the path and the names of its query's parameters
 * and its body's fields, never a value (a token may sit in any, encoded inside another link too; Codex P r3 #12).
 */
export function keyShown(key: string): string {
  const [view = '', method = '', url = '', ...rest] = key.split(' ')
  const [path = '', query] = url.split(/\?(.*)/s)
  const names = query === undefined ? '' : `?${[...new URLSearchParams(query).keys()].map((k) => `${k}=…`).join('&')}`
  let body = ''
  if (rest.length) {
    try {
      const b = JSON.parse(rest.join(' ')) as unknown
      body = b && typeof b === 'object' && !Array.isArray(b) ? ` {${Object.keys(b).map((k) => `${JSON.stringify(k)}:…`).join(',')}}` : ' (body)'
    } catch {
      body = ' (body)'
    }
  }
  return `${view} ${method} ${path}${names}${body}`
}
