// What the static demo reads (plan 05 §5.2): each answer the screens got, by view and request; the keys live in
// src/demo/snapshot.ts, shared with the static build. Pure functions only, so the rules for keys, secrets and allowed fields
// are tested on their own (scripts/demo-export/record.test.ts).

import { createHash } from 'node:crypto'

import { demoScenario } from '../../src/demo/scenario.ts'
import { getKey, postKey, type Snapshot } from '../../src/demo/snapshot.ts'

export { canonical, getKey, postKey, type Answer, type Snapshot, type View } from '../../src/demo/snapshot.ts'

/**
 * Every secret the export saw (session values, CSRF values, link tokens) becomes a fixed stand-in that works nowhere, in keys
 * and values alike, longest first so a secret inside another is not half replaced (plan §5.7).
 */
export function replaceSecrets<T>(value: T, secrets: ReadonlyMap<string, string>): T {
  const order = [...secrets.keys()].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length)
  if (secrets.size !== order.length) throw new Error('a secret shorter than 8 characters cannot be replaced safely')
  const swap = (s: string) => order.reduce((acc, secret) => acc.split(secret).join(secrets.get(secret)!), s)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return swap(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [swap(k), walk(x)]))
    return v
  }
  return walk(value) as T
}

/** `token=` values in any string of an answer: links the screens show carry them. */
export function tokensIn(value: unknown): string[] {
  const found = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/[?&]token=([A-Za-z0-9_\-.~%]+)/g)) found.add(decodedOrAsIs(m[1]!))
      // a link inside another link's query is percent-encoded once (`?next=%2Finvite%3Ftoken%3D…`); its value is cut at the
      // encoded `&` and decoded twice
      for (const m of v.matchAll(/%(?:3F|26)token%3D([A-Za-z0-9_\-.~%]+?)(?=%26|[^A-Za-z0-9_\-.~%]|$)/gi)) found.add(decodedOrAsIs(decodedOrAsIs(m[1]!)))
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(value)
  return [...found]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Field names in JSON answers that are not on the list (plan §5.7: the snapshot's fields are a whitelist). Ids as keys pass. */
export function unknownFields(value: unknown, allowed: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (!UUID.test(k) && !allowed.has(k)) out.add(k)
        walk(x)
      }
  }
  walk(value)
  return [...out].sort()
}

const EXTENSION: Record<string, string> = { 'application/pdf': '.pdf', 'text/csv': '.csv', 'application/json': '.json', 'image/png': '.png', 'image/jpeg': '.jpg' }

/**
 * Where a file goes in the pack (plan §5.3): `files/<32 hex of its sha256>/<name>`. The folder keeps files of one name apart
 * (four evidence packs); the name is the server's, cut to letters, digits, dot, dash and underscore and given its type's
 * extension, so a link without a `download` name still saves under it.
 */
export function filePath(bytes: Uint8Array, type: string, name?: string): string {
  const ext = EXTENSION[type] ?? '.bin'
  const base = (name ?? 'file').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'file'
  return `files/${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}/${base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`}`
}

const decodedOrAsIs = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** `%xx` written as the character, leaving any other `%` alone (a malformed one does not throw). */
// each run of `%xx` is decoded as UTF-8 bytes, so `Caf%C3%A9` reads `Café` (Codex P r2 #5); an escape that is not one is left
export const percentDecoded = (s: string) =>
  s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'))

/** The column names of a CSV's first line that are not on the list (plan §5.7, as for JSON). */
export function csvFields(text: string, allowed: ReadonlySet<string>): string[] {
  const head = (text.split(/\r?\n/, 1)[0] ?? '').split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
  return [...new Set(head.filter((c) => !allowed.has(c)))].sort()
}

/** The secrets a file's text still holds (plan §5.7): the export stops on any, a PDF's printed link included. */
// as written and with `%xx` decoded once, as the archive's scan reads it (Codex P r3 #5)
export function secretsIn(text: string, secrets: Iterable<string>): string[] {
  const decoded = percentDecoded(text)
  return [...secrets].filter((s) => text.includes(s) || decoded.includes(s))
}

/**
 * Where the recorded screens differ from the shared scenario (plan §3): the lead's totals, the four rows (status, days at the
 * step, amounts), Goku's amount to pay, the £10,000 quote and the payment check. The export stops on any.
 */
export function scenarioProblems(snap: Snapshot, ids: { live: string }): string[] {
  const wrong: string[] = []
  const want = (what: string, got: unknown, expected: unknown) => got === expected || wrong.push(`${what}: ${String(got)}, expected ${String(expected)}`)
  const panel = snap.get[getKey('lead', `/api/deals/${ids.live}/panel`)]?.body as
    { metrics: Record<string, string>; rows: Array<{ name: string; status: string; days: number | null; commitment_minor: string }> } | undefined
  if (!panel) return ["the lead's investor list was not read"]
  const s = demoScenario
  want('committed', panel.metrics.committed_minor, String(s.investors.reduce((n, x) => n + x.commitmentMinor, 0n)))
  want('received', panel.metrics.received_minor, '1530000')
  want('lead fees', panel.metrics.lead_fees_minor, '30000')
  const status = { kyc_in_review: 'verifying', to_sign: 'to_sign', to_pay: 'to_pay', funded: 'funded' } as const
  want('rows', panel.rows.map((r) => r.name).join(', '), 'Son Goku, Yamcha, Krillin, Tien')
  for (const x of s.investors) {
    const r = panel.rows.find((row) => row.name === x.name)
    want(`${x.name} status`, r?.status, status[x.stage])
    want(`${x.name} days`, r?.days, x.daysAtStep)
    want(`${x.name} commitment`, r?.commitment_minor, String(x.commitmentMinor))
  }
  const pay = Object.entries(snap.get).find(([key]) => /^investor GET \/api\/my\/participations\/[^/]+\/instructions$/.test(key))?.[1].body as
    { due_minor?: string; received_minor?: string } | undefined
  want("Goku's amount to pay", pay?.due_minor, '1020000')
  const quote = snap.post[postKey('investor', `/api/my/deals/${ids.live}/quote`, { commitment_minor: '1000000' })]?.body as { due_minor?: string } | undefined
  want('quote for £10,000.00', quote?.due_minor, '1020000')
  const check = Object.entries(snap.get).find(([key]) => key.startsWith('investor GET /api/instructions/verify?token=demo-'))?.[1].body as
    { valid?: boolean } | undefined
  want('payment details check', check?.valid, true)
  return wrong
}
