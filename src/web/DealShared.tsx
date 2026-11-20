// What the D2 screens share: navigation, words for states and fields, and a read-only view of a deal. All wording is ours.
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import type { Draft } from '../lib/draft.ts'
import { draftAmountToTyped, draftPercentToTyped, draftPriceToTyped } from '../lib/pounds.ts'
import { safeHttpsUrl, validRichText } from '../lib/richText.ts'
import { api } from './api.ts'

export function go(path: string) {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo(0, 0)
}

export function usePath() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const on = () => setPath(window.location.pathname)
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return path
}

export function Link({ to, children }: { to: string; children: ReactNode }) {
  const open = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    go(to)
  }
  return (
    <a href={to} onClick={open}>
      {children}
    </a>
  )
}

export function useData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const reload = useCallback(async () => {
    if (!path) return
    try {
      setData(await api<T>(path))
      setError(null)
    } catch (x) {
      setError(x)
    }
  }, [path])
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, reload, setData }
}

/** No prototype: a value saved through the API as `__proto__` looks up nothing, instead of an object that breaks the page. */
const words = (o: Record<string, string>): Record<string, string> => Object.assign(Object.create(null) as Record<string, string>, o)

export const STATE_WORDS: Record<string, string> = words({
  draft: 'Draft',
  in_review: 'With the reviewer',
  changes_requested: 'Changes asked for',
  rejected: 'Not accepted',
  approved: 'Approved, waiting for the lead to confirm',
  live: 'Live',
})

export const EVENT_WORDS: Record<string, string> = words({
  submit: 'Submitted for review',
  resubmit: 'Sent back for review',
  withdraw: 'Withdrawn by the lead',
  request_changes: 'Changes asked for',
  lead_edit: 'Changed by the lead, so the review started again',
  reject: 'Not accepted',
  approve: 'Approved',
  lapse: 'Not confirmed in time, so it went back to draft',
  launch: 'Went live',
})

export const INVESTEE_WORDS: Record<string, string> = words({
  waiting: 'Waiting for the company',
  submitted: 'Sent, waiting for a reviewer',
  approved: 'Passed',
  returned: 'Sent back to the company',
})

export const DOCUMENT_WORDS: Record<string, string> = words({
  incorporation_certificate: 'Certificate of incorporation',
  bank_statement: 'Recent bank statement',
  address_proof: 'Proof of address',
  seis_eis_advance_assurance: 'SEIS or EIS advance assurance letter',
})

export const STRUCTURES: Record<string, string> = words({ uk_bare_trust: 'UK bare trust' })
export const INSTRUMENTS: Record<string, string> = words({
  equity: 'Equity',
  cln: 'Convertible loan note (CLN)',
  safe: 'SAFE',
  asa: 'Advance subscription agreement (ASA)',
  fund_units: 'Fund units',
})
export const ROUNDS: Record<string, string> = words({
  pre_seed: 'Pre-seed',
  pre_seed_bridge: 'Pre-seed bridge',
  seed: 'Seed',
  seed_bridge: 'Seed bridge',
  series_a: 'Series A',
  series_a_bridge: 'Series A bridge',
  series_b: 'Series B',
  series_b_bridge: 'Series B bridge',
  series_c: 'Series C',
  series_c_bridge: 'Series C bridge',
  series_d_plus: 'Series D+',
  series_d_plus_bridge: 'Series D+ bridge',
})
export const SHARE_CLASSES: Record<string, string> = words({ ordinary: 'Ordinary', preferred: 'Preferred' })
export const CAP_TYPES: Record<string, string> = words({ none: 'No cap', pre_money: 'Pre-money cap', post_money: 'Post-money cap' })
export const OVER_ALLOCATION: Record<string, string> = words({ alert: 'Tell me and keep accepting', stop_and_waitlist: 'Stop and start a waiting list' })
export const VOTERS: Record<string, string> = words({ lead: 'The lead', chair: 'The chair', founder: 'The founder' })
export const FEE_PAYERS: Record<string, string> = words({ investors: 'The investors, in proportion', lead: 'The lead', company: 'The company' })

export const NOTICES: Record<string, string> = words({
  tax_relief_not_judged: 'Ticking SEIS or EIS records what you say. The software does not judge whether the company qualifies.',
  voter_scope: 'The default voter only votes. A sale needs an instruction from each investor.',
  placeholder_price: 'Marked as a placeholder. Investors are not shown it before closing.',
  external_deck: 'An external link is not behind the eligibility steps: anyone holding the address can open it.',
  fee_estimate: 'The final investment amount is exact only at closing, because the platform fee depends on what is finally raised.',
  min_raise_helps: 'Setting a minimum raise lets investors see a higher figure for the least they could end up investing.',
})

const FIELD_WORDS: Record<string, string> = words({
  structure: 'Legal structure',
  deal_type: 'Deal type',
  name: 'Name',
  legal_name: 'Legal name',
  website: 'Website',
  contact_name: 'Contact name',
  contact_email: 'Contact email',
  jurisdiction: 'Jurisdiction',
  registration_number: 'Registration number',
  address: 'Address',
  currency: 'Currency',
  seis: 'SEIS',
  eis: 'EIS',
  round: 'Round',
  instrument: 'Instrument',
  share_class: 'Share class',
  share_price_micros: 'Share price',
  price_is_placeholder: 'Placeholder price',
  pre_money_minor: 'Pre-money valuation',
  cap_type: 'Valuation cap type',
  cap_minor: 'Valuation cap',
  discount_bps: 'Discount',
  fund_description: 'Fund description',
  round_size_minor: 'Total round size',
  allocation_minor: 'SPV allocation',
  over_allocation: 'When the allocation is full',
  min_commitment_minor: 'Minimum commitment',
  min_raise_minor: 'Minimum raise',
  target_close: 'Target close date',
  pay_by: 'Payment deadline',
  voter: 'Default voter',
  default_carry_bps: 'Default carry',
  fee_payer: 'Who pays the platform fee',
  share_bps: 'Share',
  rate_bps: 'Platform fee rate',
  min_minor: 'Platform fee minimum',
  max_minor: 'Platform fee maximum',
  surcharge_threshold_minor: 'Platform fee surcharge starts above',
  surcharge_bps: 'Platform fee surcharge',
})

/** "terms.allocation_minor" as a person would say it. Anything not known is shown as it stands rather than hidden. */
export function fieldWords(path: string) {
  const parts = path.split('.')
  const last = parts.at(-1)!
  const recipient = /recipients\.(\d+)/.exec(path)
  const prefix = recipient ? `Carry recipient ${Number(recipient[1]) + 1}: ` : ''
  if (path.startsWith('files.documents.')) return `Document ${Number(parts[2]) + 1}: ${last.replaceAll('_', ' ')}`
  if (path.startsWith('terms.custom_terms')) return 'Custom terms'
  if (path.startsWith('files.memo')) return 'Memo'
  return `${prefix}${FIELD_WORDS[last] ?? last.replaceAll('_', ' ')}`
}

export function changeValue(path: string, v: string | null) {
  if (v === null) return 'nothing'
  if (path.endsWith('_minor')) return draftAmountToTyped(v)
  if (path.endsWith('_micros')) return draftPriceToTyped(v)
  if (path.endsWith('_bps')) return `${draftPercentToTyped(Number(v)) || v}%`
  return v
}

export function Changes({ changes }: { changes: Array<{ field: string; before: string | null; after: string | null }> }) {
  if (!changes.length) return null
  return (
    <>
      <h3>What changed last</h3>
      <ul data-testid="changes">
        {changes.map((c) => (
          <li key={c.field}>
            {fieldWords(c.field)}: {changeValue(c.field, c.before)} → {changeValue(c.field, c.after)}
          </li>
        ))}
      </ul>
    </>
  )
}

export interface DealEvent {
  event: string
  reason: string | null
  created_at: string
  actor?: string | null
  internal_note?: string | null
}

export function History({ events }: { events: DealEvent[] }) {
  if (!events.length) return null
  return (
    <>
      <h3>History</h3>
      <ul data-testid="history">
        {events.map((e) => (
          <li key={`${e.created_at}${e.event}`}>
            {new Date(e.created_at).toLocaleString()}: {EVENT_WORDS[e.event] ?? e.event}
            {e.reason ? `. Reason: ${e.reason}` : ''}
            {e.internal_note ? <span className="hint"> Internal note: {e.internal_note}</span> : null}
          </li>
        ))}
      </ul>
    </>
  )
}

interface Node {
  type: string
  text?: string
  attrs?: { level?: number; href?: string }
  marks?: Array<{ type: string; attrs?: { href?: string } }>
  content?: Node[]
}

function RichNode({ n }: { n: Node }): ReactNode {
  const kids = n.content?.map((c, i) => <RichNode key={i} n={c} />)
  switch (n.type) {
    case 'doc':
      return <>{kids}</>
    case 'paragraph':
      return <p>{kids}</p>
    case 'heading':
      return n.attrs?.level === 1 ? <h3>{kids}</h3> : <h4>{kids}</h4>
    case 'bullet_list':
      return <ul>{kids}</ul>
    case 'ordered_list':
      return <ol>{kids}</ol>
    case 'list_item':
      return <li>{kids}</li>
    case 'hard_break':
      return <br />
    case 'text': {
      const mark = n.marks?.[0]
      if (mark?.type === 'strong') return <strong>{n.text}</strong>
      if (mark?.type === 'em') return <em>{n.text}</em>
      const url = mark?.type === 'link' ? safeHttpsUrl(mark.attrs?.href) : null
      return url ? (
        <a href={url.href} target="_blank" rel="noopener noreferrer">
          {n.text}
        </a>
      ) : (
        <>{n.text}</>
      )
    }
    default:
      return null
  }
}

/** Only what the whitelist allows, built as elements: nothing a lead typed reaches the page as markup. */
export function RichView({ doc }: { doc: unknown }) {
  if (!validRichText(doc)) return null
  return (
    <div className="rich" data-testid="rich">
      <RichNode n={doc as Node} />
    </div>
  )
}

type Row = [label: string, value: ReactNode]
const percent = (v: unknown) => (typeof v !== 'number' ? undefined : draftPercentToTyped(v) ? `${draftPercentToTyped(v)}%` : 'Could not be read')
const yes = (b: unknown) => (b === true ? 'Yes' : 'No')

function Rows({ rows }: { rows: Row[] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!shown.length) return <p className="hint">Nothing here yet.</p>
  return (
    <dl className="details">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export interface FeeTerms {
  rate_bps: number
  min_minor: string
  max_minor: string
  surcharge_threshold_minor: string
  surcharge_bps: number
}

export const feeWords = (f: FeeTerms) =>
  `${draftPercentToTyped(f.rate_bps)}%, at least ${draftAmountToTyped(f.min_minor)} and at most ${draftAmountToTyped(f.max_minor)}${f.surcharge_bps > 0 ? `, plus ${draftPercentToTyped(f.surcharge_bps)}% of anything above ${draftAmountToTyped(f.surcharge_threshold_minor)}` : ''}.`

export type SummaryPart = 'basics' | 'company' | 'terms' | 'files' | 'economics'

/** One part of a deal for reading, from a working draft or a stored version alike. */
export function DealPart({ part, d }: { part: SummaryPart; d: Draft }) {
  if (part === 'basics') {
    const s = d.basics?.syndicate as { mode?: string; name?: string } | undefined
    return (
      <Rows
        rows={[
          ['Legal structure', STRUCTURES[d.basics?.structure ?? ''] ?? d.basics?.structure],
          ['Deal type', d.basics?.deal_type === 'primary' ? 'Primary' : d.basics?.deal_type],
          ['Deal name', d.basics?.name],
          ['New syndicate', s?.mode === 'new' ? s.name : undefined],
        ]}
      />
    )
  }
  if (part === 'company') {
    const c = d.company ?? {}
    return (
      <Rows
        rows={[
          ['Legal name', c.legal_name],
          ['Website', c.website],
          ['Contact name', c.contact_name],
          ['Contact email', c.contact_email],
          ['Jurisdiction', c.jurisdiction],
          ['Registration number', c.registration_number],
          ['Address', c.address],
        ]}
      />
    )
  }
  if (part === 'terms') {
    const t = d.terms ?? {}
    const cur = t.currency ? `${t.currency} ` : ''
    const money = (v?: string) => (v ? `${cur}${draftAmountToTyped(v)}` : undefined)
    // only what belongs to this instrument: the same rule as for what is hashed and approved (contentOf)
    const convertible = !!t.instrument && ['cln', 'safe', 'asa'].includes(t.instrument)
    return (
      <>
        <Rows
          rows={[
            ['Currency', t.currency],
            ['SEIS', t.seis ? yes(t.seis) : undefined],
            ['EIS', t.eis ? yes(t.eis) : undefined],
            ['Round', ROUNDS[t.round ?? ''] ?? t.round],
            ['Instrument', INSTRUMENTS[t.instrument ?? ''] ?? t.instrument],
            ['Share class', t.instrument === 'equity' ? SHARE_CLASSES[t.share_class ?? ''] : undefined],
            [
              'Share price',
              t.instrument === 'equity' && t.share_price_micros
                ? `${cur}${draftPriceToTyped(t.share_price_micros)}${t.price_is_placeholder ? ' (placeholder)' : ''}`
                : undefined,
            ],
            ['Pre-money valuation', t.instrument === 'equity' ? money(t.pre_money_minor) : undefined],
            ['Valuation cap type', t.instrument && ['cln', 'safe', 'asa'].includes(t.instrument) ? CAP_TYPES[t.cap_type ?? ''] : undefined],
            ['Valuation cap', convertible && (t.cap_type === 'pre_money' || t.cap_type === 'post_money') ? money(t.cap_minor) : undefined],
            ['Discount', convertible ? percent(t.discount_bps) : undefined],
            ['Fund description', t.instrument === 'fund_units' ? t.fund_description : undefined],
            ['Total round size', money(t.round_size_minor)],
            ['SPV allocation', money(t.allocation_minor)],
            ['When the allocation is full', OVER_ALLOCATION[t.over_allocation ?? '']],
            ['Minimum commitment', money(t.min_commitment_minor)],
            ['Minimum raise', money(t.min_raise_minor)],
            ['Target close date', t.target_close],
            ['Payment deadline', t.pay_by],
            ['Default voter', VOTERS[t.voter ?? '']],
          ]}
        />
        {t.custom_terms ? (
          <>
            <h4>Custom terms</h4>
            <RichView doc={t.custom_terms} />
          </>
        ) : null}
      </>
    )
  }
  if (part === 'files') {
    const deck = d.files?.deck as { kind?: string; url?: string; embed_url?: string } | undefined
    return (
      <>
        <Rows
          rows={[
            ['Pitch deck', deck?.kind === 'file' ? 'PDF, see the files' : deck?.kind === 'link' ? deck.url : undefined],
            ['Embed address', deck?.kind === 'link' ? deck.embed_url : undefined],
          ]}
        />
        {d.files?.memo ? (
          <>
            <h4>Memo</h4>
            <RichView doc={d.files.memo} />
          </>
        ) : null}
      </>
    )
  }
  const e = d.economics ?? {}
  return (
    <>
      <Rows
        rows={[
          ['Default carry', percent(e.default_carry_bps)],
          ['Who pays the platform fee', FEE_PAYERS[e.fee_payer ?? '']],
        ]}
      />
      {e.recipients?.length ? (
        <ul>
          {e.recipients.map((r, i) => (
            <li key={i}>
              {r.kind === 'company'
                ? `${r.trading_name ?? ''} (${r.legal_name ?? ''}, ${r.registration_number ?? ''}), ${r.contact_name ?? ''}, ${r.contact_email ?? ''}`
                : `${r.first_name ?? ''} ${r.last_name ?? ''}, ${r.email ?? ''}`}
              : {percent(r.share_bps) ?? 'no share given'}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

export const PART_WORDS: Record<SummaryPart, string> = { basics: 'Basics', company: 'Company', terms: 'Terms', files: 'Files', economics: 'Economics' }

export function DealRead({ d, fee }: { d: Draft; fee?: FeeTerms | null }) {
  return (
    <>
      {fee && <p data-testid="bound-fee">Platform fee for this deal: {feeWords(fee)}</p>}
      {(Object.keys(PART_WORDS) as SummaryPart[]).map((p) => (
        <div key={p} className="part">
          <h3>{PART_WORDS[p]}</h3>
          <DealPart part={p} d={d} />
        </div>
      ))}
    </>
  )
}

export interface DealFile {
  id: string
  requirement: string
  display_name: string
  folder_id: string | null
}

export function FileLinks({ dealId, files }: { dealId: string; files: DealFile[] }) {
  if (!files.length) return <p className="hint">No files.</p>
  return (
    <ul data-testid="file-links">
      {files.map((f) => (
        <li key={f.id}>
          <a href={`/api/deals/${dealId}/files/${f.id}`} download={f.display_name}>
            {f.display_name}
          </a>{' '}
          <span className="hint">{f.requirement === 'deck' ? 'pitch deck' : 'legal document'}</span>
        </li>
      ))}
    </ul>
  )
}
