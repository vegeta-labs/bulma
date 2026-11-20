// What counts as a deal's content, and what changed between two versions (R-REV-03, R-PUB-02). Pure.
import type { Draft } from './draft.ts'

/** The same value always gives the same text, whatever order its keys arrived in. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x === undefined ? null : x)).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    const parts = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(v)
}

const blank = (v: unknown) => v === undefined || v === null || v === '' || v === false

function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune)
  if (typeof v !== 'object' || v === null) return v
  const out: Record<string, unknown> = {}
  for (const [k, raw] of Object.entries(v)) {
    const x = prune(raw)
    if (blank(x)) continue
    if (typeof x === 'object' && !Array.isArray(x) && Object.keys(x as object).length === 0) continue
    if (Array.isArray(x) && x.length === 0) continue
    out[k] = x
  }
  return out
}

const EQUITY = ['share_class', 'share_price_micros', 'price_is_placeholder', 'pre_money_minor']
const CONVERTIBLE = ['cap_type', 'cap_minor', 'discount_bps']
const FUND = ['fund_description']

/**
 * The content a reviewer approves: no empty values, nothing left over from another instrument, and no confirmations, which are
 * recorded separately. An untouched field saved as empty is not a change.
 */
export function contentOf(d: Draft): Record<string, unknown> {
  const { attestations: _attestations, ...rest } = d
  const terms: Record<string, unknown> = { ...rest.terms }
  const kept = terms.instrument === 'equity' ? EQUITY : terms.instrument === 'fund_units' ? FUND : terms.instrument ? CONVERTIBLE : []
  for (const k of [...EQUITY, ...CONVERTIBLE, ...FUND]) if (!kept.includes(k)) delete terms[k]
  if (terms.cap_type !== 'pre_money' && terms.cap_type !== 'post_money') delete terms.cap_minor
  return prune({ ...rest, terms }) as Record<string, unknown>
}

/** An empty value: still a value for telling fields apart (empty and absent differ, as before), shown as nothing, never as "null". */
const EMPTY = '\u0000empty'

function flatten(v: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)
    for (const [k, x] of entries) flatten(x, path ? `${path}.${k}` : k, out)
  } else out.set(path, v === null || v === undefined ? EMPTY : String(v))
}

const shown = (v: string | undefined): string | null => (v === undefined || v === EMPTY ? null : v)

export interface FieldChange {
  field: string
  before: string | null
  after: string | null
}

/** Each field that differs, in a fixed order. */
export function diffContent(before: unknown, after: unknown): FieldChange[] {
  const a = new Map<string, string>()
  const b = new Map<string, string>()
  flatten(before, '', a)
  flatten(after, '', b)
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .filter((k) => a.get(k) !== b.get(k))
    .map((field) => ({ field, before: shown(a.get(field)), after: shown(b.get(field)) }))
}
