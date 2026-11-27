// The static demo pack's snapshot (plan 05 §5.1, §5.2): what the export records and what the static build reads back. Pure
// functions only, shared by the export (scripts/demo-export/record.ts) and the browser (src/web/static-api.ts), so both look an
// answer up by the same key.
import { money } from '../lib/dealSheet.ts'

export type View = 'investor' | 'lead' | 'reviewer'
export const VIEWS: readonly View[] = ['investor', 'lead', 'reviewer']

export interface Answer {
  status: number
  /** JSON answers keep their body; files point into `files/`. */
  body?: unknown
  file?: { path: string; type: string; name?: string }
}

export interface Snapshot {
  format: 1
  /** The fixed clock the data was made at (ISO, UTC). */
  clock: string
  views: Record<View, { name: string }>
  /** `${view} GET ${path}?${query}` → answer */
  get: Record<string, Answer>
  /** `${view} POST ${path} ${canonical body}` → answer; only the read-only POSTs of the whitelist */
  post: Record<string, Answer>
  /** The pages of plan §5.5, as paths of the normal build, with the ids of this export. */
  /** `click`: what the export presses in the app to reach the page's state; the pack opens it from the address alone. */
  pages: Array<{ n: string; view: View; path: string; what: string; click?: string[] }>
}

/** What the static build loads from `data/snapshot.js`: the export's snapshot plus the pack's version. */
export interface DemoPack extends Snapshot {
  version: string
  /** `${view} ${sentence}` → the pack's page that says it (data/notes/), for links that have no file (plan §5.3). */
  notes: Record<string, string>
}

/** The request as the browser sends it: path and query exactly, so the static build looks up what it asks. */
export const getKey = (view: View, url: string) => `${view} GET ${url}`

/** A body's keys sorted, so `{a, b}` and `{b, a}` are one entry; values as given. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

export const postKey = (view: View, path: string, body: unknown) => `${view} POST ${path} ${canonical(body ?? {})}`

/** The one sentence every change gets in the pack (owner 2026-11-23); nothing is sent. */
export const DEMO_NO_CHANGE = 'Demo: nothing can be changed here.'
/** A read the export did not record: the pack says so rather than showing an empty page as if it were real. */
export const DEMO_NOT_RECORDED = 'Demo: this part is not in the demo.'

/**
 * The recorded answer to a request, or none. Reads by view, path and query; the only POSTs answered are the read-only ones
 * the export recorded with their exact body (fixed quotes, the invitation); PUT, PATCH and DELETE never are.
 */
export function answerFor(snap: Snapshot, view: View, method: string, url: string, body?: unknown): Answer | undefined {
  const u = new URL(url, 'http://localhost')
  const at = `${u.pathname}${u.search}`
  if (method === 'GET') return Object.hasOwn(snap.get, getKey(view, at)) ? snap.get[getKey(view, at)] : undefined
  if (method === 'POST') return Object.hasOwn(snap.post, postKey(view, at, body)) ? snap.post[postKey(view, at, body)] : undefined
  return undefined
}

/**
 * What the pack says to a change it has no answer for. A quote for another amount names the amounts the pack does work out
 * (plan §5.2: no money is worked out in the browser); anything else gets the demo sentence. Only quotes are recorded with an
 * amount, so a path with recorded amounts is a quote; a request with other fields (a change of amount, `replacing`) is
 * not one of those quotes, so it gets the demo sentence too.
 */
export function refusalFor(snap: Snapshot, view: View, url: string, body?: unknown): string {
  const path = new URL(url, 'http://localhost').pathname
  const prefix = `${view} POST ${path} `
  const fields = (b: unknown) => (b && typeof b === 'object' ? Object.keys(b).sort().join(',') : '')
  const amounts = Object.keys(snap.post)
    .filter((k) => k.startsWith(prefix))
    .map((k) => JSON.parse(k.slice(prefix.length)) as { commitment_minor?: unknown })
    .filter((b) => fields(b) === fields(body))
    .map((b) => b.commitment_minor)
    .filter((m): m is string => typeof m === 'string' && /^\d+$/.test(m))
    .map(BigInt)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (!amounts.length) return DEMO_NO_CHANGE
  const named = amounts.map((m) => money(m, 'GBP'))
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
  return `Demo: the demo works out what you would pay for ${list} only.`
}

/**
 * The pack's addresses are hashes, `#/<view><path>?<query>` (plan §5.1), so a deep link, a refresh and a new tab all work
 * on a static host under any folder. A hash that names no view is none.
 */
export function parseAddress(hash: string): { view: View; path: string; search: string } | null {
  const m = /^#\/(investor|lead|reviewer)(\/[^?#]*)?(\?[^#]*)?$/.exec(hash)
  if (!m) return null
  return { view: m[1] as View, path: m[2] || '/', search: m[3] ?? '' }
}

/** The hash for a page of the normal build (`/deals/x?y=1`) in a view. */
export function addressFor(view: View, page: string): string {
  const p = page.startsWith('/') ? page : `/${page}`
  return `#/${view}${p}`
}

/** Where the site serves the pack (agreed with the site, plan 05 §5.5). The pack's own links are relative; only text printed in a file, which no browser resolves, needs the full path. */
export const PACK_HOME = '/bulma/demo/'

/**
 * A page of the normal build as printed in one of the pack's files (the payment details PDF's "check these details" line):
 * the pack's address on the site, so a reader who types it lands on that page of the demo (TC-DEMO-11).
 */
export function printedAddress(view: View, page: string): string {
  if (!page.startsWith('/') || page.startsWith('//')) throw new Error(`not a page of this site: ${page}`)
  return `${PACK_HOME}${addressFor(view, page)}`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2 November 2026, 10:00 UTC": the snapshot's time in words, the same for every visitor. */
export function clockInWords(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`
}

/** A link's place in `notes`: the sentence a view's link leads to when the pack has no file for it. */
export const noteKey = (view: View, sentence: string) => `${view} ${sentence}`

/**
 * The note pages the pack needs, by view: "not in the demo" for links the export did not record, and each refusal a view's
 * reads got (a list the operator does not let leads export). Their order is fixed, so the same snapshot builds the same pack.
 */
export function notesFor(snap: Snapshot): Array<{ view: View; sentence: string; path: string }> {
  return VIEWS.flatMap((view) => {
    const refusals = Object.entries(snap.get)
      .filter(([key, a]) => key.startsWith(`${view} GET `) && a.status >= 400)
      .map(([, a]) => refusalText(a))
      .filter((t): t is string => t !== null)
    return [...new Set([DEMO_NOT_RECORDED, ...refusals.sort()])].map((sentence, i) => ({ view, sentence, path: `data/notes/${view}-${i + 1}.html` }))
  })
}

const refusalText = (a: Answer) => {
  const error = (a.body as { error?: unknown } | undefined)?.error
  return typeof error === 'string' && error.trim() ? error : null
}

/**
 * Where a link to a file the server sends (`/api/...`) goes in the pack, as `href` (and `download`) of the link: the recorded
 * file under data/, or the note page with the recorded refusal or "not in the demo". A plain address either way, so a new tab
 * and "save link as" work too (plan §5.3).
 */
export function fileLinkFor(pack: DemoPack, view: View, url: string, name?: string): { href: string; download?: string } {
  const a = answerFor(pack, view, 'GET', url)
  if (a?.file && a.status === 200) {
    const download = name ?? a.file.name
    return { href: `data/${a.file.path}`, ...(download ? { download } : {}) }
  }
  const why = a && a.status >= 400 ? refusalText(a) : null
  const note = (why !== null && pack.notes[noteKey(view, why)]) || pack.notes[noteKey(view, DEMO_NOT_RECORDED)]
  if (!note) throw new Error(`the pack has no note page for ${view}`)
  return { href: note }
}
