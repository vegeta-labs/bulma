// P step 6 (plan 05 §5.7, TC-DEMO-12): what the final archive may hold, and its manifest. Pure functions (the PDF reader
// aside), so each rule is tested on its own (scripts/demo-export/pack.test.ts); scripts/demo-pack.ts runs them over the
// files unpacked from the archive itself, not over dist-demo/.
//
// The scan does not know the export's secret values (the export checked those, plan §5.2): it looks for their shapes.
// Real company names: a name with a company suffix (Ltd, plc, Inc, …) must be one of the scenario's; a real name without a
// suffix is caught only if it is on the private name list (check-identity.mjs), which every file is also matched against.

import { createHash } from 'node:crypto'
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFRawStream, PDFRef, PDFString } from 'pdf-lib'
import { pdfText } from '../../src/server/pdfText.ts'
import { percentDecoded } from './record.ts'

/** Hosts that may appear only inside the built screens (assets/*.js), each written by a library or by our own code. */
export const LIBRARY_HOSTS: Readonly<Record<string, string>> = {
  'www.w3.org': 'SVG and XML namespaces in React',
  'react.dev': "React's error-message links",
  'json-schema.org': "zod's JSON Schema output, never called by the screens",
  localhost: 'the base static-api.ts parses request paths against; nothing is fetched',
}

/** A host any file may name: reserved for documentation and tests (RFC 2606, RFC 6761), so nobody's real address. */
export const fictionalHost = (host: string) => /(^|\.)(invalid|example|test|localhost)$/.test(host) || /^example\.(com|org|net)$/.test(host)

const TLD = 'com|org|net|io|co|uk|dev|app|ai|eu|us|de|fr|me|info|biz|vc|fund|capital|finance|xyz|tech|ly|gg|sh|so'
const HOSTS = [
  /\b[a-z][a-z0-9+.-]*:\/\/([a-z0-9.-]+)/gi, // any URL
  /[a-z0-9._%+-]@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi, // an email address
  new RegExp(`\\b((?:[a-z0-9-]+\\.)+(?:${TLD}))\\b(?![.\\w-]*\\()`, 'gi'), // a bare domain (not a call like a.co(…))
]

/**
 * Every host the text names, lower case. In minified code `t.io` is a property, not a domain, so there (`code`) only URLs
 * and email addresses count; a host the code itself writes is always one of those.
 */
export function hostsIn(text: string, code = false): string[] {
  const out = new Set<string>()
  for (const re of code ? HOSTS.slice(0, 2) : HOSTS) for (const m of text.matchAll(re)) out.add(m[1]!.toLowerCase().replace(/\.+$/, ''))
  return [...out].filter(Boolean)
}

/** A folder of a person or a machine: a home folder (macOS, Linux, Windows), macOS's temporary folders, a file address (Windows in any case). */
const LOCAL_PATH = /\/Users\/[\w.-]+|\/home\/[\w.-]+|[A-Za-z]:\\{1,2}[Uu][Ss][Ee][Rr][Ss]\\{1,2}[\w.-]+|\/private\/var\/folders\/|\/var\/folders\/|file:\/\//g

const SUFFIX = /\b((?:[A-Z][\w&'’-]*\s+){1,4})(Ltd|LTD|Limited|LIMITED|plc|Plc|PLC|Inc|INC|LLC|LLP|LP|GmbH|GMBH|AG|SA|BV|Corp|CORP|Corporation|CORPORATION)\b/g

/** Names with a company suffix, as written. */
export const companiesIn = (text: string) => [...new Set([...text.matchAll(SUFFIX)].map((m) => `${m[1]!.trim().replace(/\s+/g, ' ')} ${m[2]}`))]

export interface ScanRules {
  /** The private name list (the reference platform, the owner's private context): check-identity.mjs. */
  names: RegExp
  /** Every company name the pack may show: the scenario's and the sandbox's fixed payee. */
  companies: ReadonlySet<string>
}

/**
 * What one file of the archive must not hold (plan §5.7): a secret's shape (a link token, a session or CSRF value, a
 * password, key material) unless it is the export's `demo-…` stand-in; a host that is not fictional (library hosts only in
 * assets/*.js); a company name outside the scenario; anything on the private name list. HTML pages must be fit for the
 * site's CSP and not for search engines.
 */
export function scanText(path: string, text: string, rules: ScanRules): string[] {
  const out = new Set<string>()
  const say = (what: string) => out.add(`${path}: ${what}`)
  // secrets are looked for as written and with `%xx` decoded once (a link inside another link's query)
  for (const t of new Set([text, percentDecoded(text)])) {
    // a token is long (the app's are 32+ characters); shorter matches are the code that builds or reads a link
    for (const m of t.matchAll(/[?&#]token=([A-Za-z0-9_\-.~%]{16,})/g)) if (!m[1]!.startsWith('demo-')) say(`a link token (${m[1]!.slice(0, 8)}…)`)
    // any key that names one (`invite_token`, `sessionId`, `x-csrf-token`), not only the exact names
    for (const m of t.matchAll(/"([\w-]*(?:csrf|token|session|password|secret|cookie|api_key)[\w-]*)"\s*:\s*"([^"]*)"/gi))
      if (m[2] && !m[2].startsWith('demo-')) say(`a "${m[1]}" value that is not a demo stand-in`)
  }
  for (const m of text.matchAll(/\bbulma_(session|invite)=([^;\s"']+)/g)) if (!m[2]!.startsWith('demo-')) say(`a bulma_${m[1]} cookie value`)
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) say('key material')
  const library = /^assets\/[^/]+\.js$/.test(path)
  // what names a person, a place or a machine: as written and `%xx`-decoded too (Codex P r1 #4)
  for (const t of new Set([text, percentDecoded(text)])) {
    for (const h of hostsIn(t, library)) if (!fictionalHost(h) && !(library && h in LIBRARY_HOSTS)) say(`names the host ${h}`)
    for (const c of companiesIn(t)) if (!rules.companies.has(c)) say(`names the company ${c}, which is not in the scenario`)
    if (rules.names.test(t)) say('names something that must not be published (private name list)')
    for (const m of t.matchAll(LOCAL_PATH)) say(`a path on someone's machine (${m[0].slice(0, 12)}…)`)
  }
  if (path.endsWith('.html')) {
    if (!/<meta name="robots" content="noindex"/.test(text)) say('no noindex')
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(text)) say('an inline script')
    if (/<style\b|\sstyle=/i.test(text)) say('an inline style')
  }
  return [...out]
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** `MANIFEST.sha256` (the site's format, plan §5.7): `<sha256>  <path>` per file, sorted by path, not listing itself. */
export function manifestText(files: ReadonlyMap<string, Uint8Array>): string {
  const paths = [...files.keys()].filter((p) => p !== 'MANIFEST.sha256').sort()
  return paths.map((p) => `${sha256(files.get(p)!)}  ${p}\n`).join('')
}

/** Where the unpacked files and the manifest disagree (TC-DEMO-12): a file missing from it, listed but absent, or changed. */
export function manifestProblems(manifest: string, files: ReadonlyMap<string, Uint8Array>): string[] {
  const out: string[] = []
  const listed = new Map<string, string>()
  for (const line of manifest.split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line)
    if (!m) out.push(`MANIFEST.sha256: a line not in the format: ${line}`)
    else if (m[2] === 'MANIFEST.sha256') out.push('MANIFEST.sha256: lists itself')
    else if (listed.has(m[2]!)) out.push(`MANIFEST.sha256: lists ${m[2]} twice`)
    else listed.set(m[2]!, m[1]!)
  }
  const sorted = [...listed.keys()]
  if (sorted.join('\n') !== [...sorted].sort().join('\n')) out.push('MANIFEST.sha256: not sorted by path')
  for (const [p, bytes] of files) if (p !== 'MANIFEST.sha256' && listed.get(p) !== sha256(bytes)) out.push(`${p}: not in MANIFEST.sha256 or differs`)
  for (const p of listed.keys()) if (!files.has(p)) out.push(`${p}: in MANIFEST.sha256 but not in the archive`)
  // and nothing else: the manifest is exactly the one these files make (Codex P r1 #18)
  if (!out.length && manifest !== manifestText(files)) out.push('MANIFEST.sha256: not exactly the manifest of these files')
  return out
}

/**
 * Everything a PDF says that a reader can see or follow: the text drawn on each page (through each font's Unicode map) and
 * every string and name in every object outside font and image data (link annotations, document info), decoded, whether
 * written as (literal) or <hex> or inside an object stream. A font without a Unicode map, or a stream that cannot be
 * decoded, is an error: the scan never passes what it could not read.
 */
export async function pdfStrings(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const objects = doc.context.enumerateIndirectObjects()
  const skip = new Set<string>()
  for (const [ref, obj] of objects) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream ? obj.dict : null
    if (!dict) continue
    for (const k of ['FontFile', 'FontFile2', 'FontFile3', 'ToUnicode']) {
      const r = dict.get(PDFName.of(k))
      if (r instanceof PDFRef) skip.add(r.toString())
    }
    if (dict.get(PDFName.of('Subtype'))?.toString() === '/Image') skip.add(ref.toString())
    const type = dict.get(PDFName.of('Type'))?.toString()
    const sub = dict.get(PDFName.of('Subtype'))?.toString()
    // a CID font's map is on the Type0 font above it
    if (type === '/Font' && !['/CIDFontType0', '/CIDFontType2'].includes(sub ?? '') && !dict.has(PDFName.of('ToUnicode')))
      throw new Error(`font ${ref.toString()} has no Unicode map`)
  }
  const parts = await pdfText(bytes)
  const walk = (o: PDFObject | undefined): void => {
    if (o instanceof PDFString || o instanceof PDFHexString) parts.push(o.decodeText())
    else if (o instanceof PDFName) parts.push(o.decodeText())
    else if (o instanceof PDFArray) o.asArray().forEach(walk)
    else if (o instanceof PDFDict)
      for (const [k, v] of o.entries()) {
        walk(k)
        walk(v)
      }
  }
  for (const [ref, obj] of objects) {
    if (obj instanceof PDFRawStream) {
      walk(obj.dict)
      // content streams draw text as glyph codes (read above through pdfText); decoded anyway, so a stream that cannot be
      // read stops the scan and plain strings in it are seen
      if (!skip.has(ref.toString())) parts.push(Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1'))
    } else walk(obj)
  }
  return parts.join('\n')
}
