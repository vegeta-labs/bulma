// The lead's screens: the list of deals, the six-section wizard (any section, in any order, saved as typed) and the page of a submitted deal.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { LiveDealTools } from './LeadLive.tsx'
import { DealLifecycle } from './Life.tsx'
import { LeadChanges } from './DealChange.tsx'
import { InvestorPreview } from './Invest.tsx'
import { type Draft, type Problem as DraftProblem, type Section, SECTIONS, withEffectiveMinimum } from '../lib/draft.ts'
import { platformFee, type FeeConfig } from '../lib/fees.ts'
import { draftAmountToTyped, draftPercentToTyped, draftPriceToTyped, typedAmountToDraft, typedPercentToDraft, typedPriceToDraft } from '../lib/pounds.ts'
import { markupToRichText, richTextToMarkup } from '../lib/richText.ts'
import { api, uploadFile } from './api.ts'
import {
  CAP_TYPES,
  Changes,
  DealPart,
  DealRead,
  type DealEvent,
  type DealFile,
  FEE_PAYERS,
  feeWords,
  FileLinks,
  go,
  History,
  INSTRUMENTS,
  INVESTEE_WORDS,
  Link,
  NOTICES,
  OVER_ALLOCATION,
  PART_WORDS,
  RichView,
  ROUNDS,
  SHARE_CLASSES,
  STATE_WORDS,
  STRUCTURES,
  useData,
  VOTERS,
} from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'

interface Settings {
  enabled_structures: string[]
  required_company_fields: string[]
  min_commitment_floor_minor: string
  default_carry_bps: number
  draft_restore_days: number
  embed_hosts: string[]
  fee: { rate_bps: number; min_minor: string; max_minor: string; surcharge_threshold_minor: string; surcharge_bps: number } | null
}
interface Deal {
  id: string
  state: string
  public_code: string
  draft: Draft
  problems: DraftProblem[]
  progress: Record<Section, boolean>
  notices: string[]
  events: DealEvent[]
  changes: Array<{ field: string; before: string | null; after: string | null }>
  files: DealFile[]
  folders: Array<{ id: string; parent_id: string | null; name: string }>
  team: Array<{ user_id: string; role: string; name: string }>
  investee: { status: string; return_reason: string | null; last_reminded_at: string | null; link_expires_at: string | null; documents_received: number } | null
  draft_rev: number
  approved_sha256: string | null
  approved_version: number | null
  effective_min_commitment_minor: string | null
  can_manage: boolean
  review_target_days: number
  settings: Settings
  can_edit: boolean
}
interface ListRow {
  id: string
  state: string
  public_code: string
  name: string | null
  deleted_at: string | null
  restore_until: string | null
}

const SECTION_WORDS: Record<Section, string> = { ...PART_WORDS, review: 'Review' }

export function DealsHome() {
  const { data, error, reload } = useData<{ deals: ListRow[] }>('/api/deals')
  const { error: actionError, run } = useRun()
  const start = () =>
    run(async () => {
      const { id } = await api<{ id: string }>('/api/deals', 'POST')
      go(`/deals/${id}`)
    })
  const live = data?.deals.filter((d) => !d.deleted_at) ?? []
  const deleted = data?.deals.filter((d) => d.deleted_at) ?? []
  return (
    <section className="card">
      <h1>Deals</h1>
      <Problem error={error ?? actionError} />
      <button type="button" onClick={start}>
        Start a deal
      </button>
      {data && !live.length && <p>You have no deals yet.</p>}
      <ul className="list" data-testid="deal-list">
        {live.map((d) => (
          <li key={d.id}>
            <span>
              <Link to={`/deals/${d.id}`}>{d.name || 'Untitled deal'}</Link> <span className="hint">{d.public_code}</span>
            </span>
            <span className="pill">{STATE_WORDS[d.state] ?? d.state}</span>
          </li>
        ))}
      </ul>
      {deleted.length > 0 && (
        <>
          <h2>Deleted drafts</h2>
          <ul className="list" data-testid="deleted-deals">
            {deleted.map((d) => (
              <li key={d.id}>
                <span>
                  {d.name || 'Untitled deal'} <span className="hint">can be restored until {new Date(d.restore_until!).toLocaleDateString()}</span>
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      await api(`/api/deals/${d.id}/restore`, 'POST')
                      await reload()
                    })
                  }
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function FieldProblems({ problems, field }: { problems: DraftProblem[]; field: string }) {
  const list = problems.filter((p) => p.field === field && p.kind === 'invalid')
  if (!list.length) return null
  return (
    <p className="field-error" data-testid={`error-${field}`}>
      {[...new Set(list.map((p) => p.message))].join(' ')}
    </p>
  )
}

interface FieldProps {
  label: string
  field: string
  problems: DraftProblem[]
  required?: boolean
  hint?: string
}
const star = (required?: boolean) => (required ? ' *' : '')

function Text({
  label,
  field,
  problems,
  required,
  hint,
  value,
  onChange,
  type = 'text',
  rows,
}: FieldProps & { value: string | undefined; onChange: (v: string | undefined) => void; type?: string; rows?: number }) {
  const change = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value === '' ? undefined : e.target.value)
  return (
    <>
      <label>
        {label}
        {star(required)}
        {rows ? <textarea rows={rows} value={value ?? ''} onChange={change} /> : <input type={type} value={value ?? ''} onChange={change} />}
      </label>
      {hint && <p className="hint">{hint}</p>}
      <FieldProblems problems={problems} field={field} />
    </>
  )
}

function Choice({
  label,
  field,
  problems,
  required,
  hint,
  value,
  options,
  onChange,
}: FieldProps & { value: string | undefined; options: Record<string, string>; onChange: (v: string | undefined) => void }) {
  return (
    <>
      <label>
        {label}
        {star(required)}
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">Choose</option>
          {Object.entries(options).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {hint && <p className="hint">{hint}</p>}
      <FieldProblems problems={problems} field={field} />
    </>
  )
}

/** Keeps the characters as typed while the draft holds the exact value, so a half-typed figure is not rewritten under the cursor. */
function Typed({
  label,
  field,
  problems,
  required,
  hint,
  stored,
  read,
  write,
  onChange,
  disabled,
}: FieldProps & {
  stored: unknown
  read: (v: unknown) => string
  write: (t: string) => string | number | null
  onChange: (v: never) => void
  disabled?: boolean
}) {
  const [typed, setTyped] = useState(() => read(stored))
  return (
    <>
      <label>
        {label}
        {star(required)}
        <input
          inputMode="decimal"
          disabled={disabled}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value)
            onChange((write(e.target.value) ?? undefined) as never)
          }}
        />
      </label>
      {hint && <p className="hint">{hint}</p>}
      <FieldProblems problems={problems} field={field} />
    </>
  )
}

const Money = (p: FieldProps & { stored: unknown; onChange: (v: string | undefined) => void }) => (
  <Typed {...p} read={draftAmountToTyped} write={typedAmountToDraft} onChange={p.onChange as (v: never) => void} />
)
const Percent = (p: FieldProps & { stored: unknown; onChange: (v: number | undefined) => void }) => (
  <Typed {...p} read={draftPercentToTyped} write={typedPercentToDraft} onChange={p.onChange as (v: never) => void} />
)

function Check({ label, checked, onChange, testid }: { label: ReactNode; checked: boolean | undefined; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <label className="check block">
      <input type="checkbox" data-testid={testid} checked={!!checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  )
}

function Writing({ label, field, problems, doc, onChange, hint }: FieldProps & { doc: unknown; onChange: (d: unknown) => void }) {
  const [text, setText] = useState(() => richTextToMarkup(doc))
  const [preview, setPreview] = useState(false)
  return (
    <>
      <label>
        {label}
        <textarea
          rows={8}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onChange(markupToRichText(e.target.value) ?? undefined)
          }}
        />
      </label>
      <p className="hint">{hint ?? 'Write plainly. # starts a heading, - starts a list, **bold**, *italic*, and [words](secure web address) makes a link.'}</p>
      <FieldProblems problems={problems} field={field} />
      <button type="button" className="secondary" onClick={() => setPreview(!preview)}>
        {preview ? 'Hide the preview' : 'Preview'}
      </button>
      {preview && <RichView doc={markupToRichText(text)} />}
    </>
  )
}

interface SectionProps {
  draft: Draft
  deal: Deal
  problems: DraftProblem[]
  part: <K extends keyof Draft>(k: K, v: Partial<NonNullable<Draft[K]>>) => void
}

const NoticeList = ({ notices, only }: { notices: string[]; only: string[] }) => (
  <>
    {notices
      .filter((n) => only.includes(n))
      .map((n) => (
        <p key={n} className="notice" data-testid={`notice-${n}`}>
          {NOTICES[n]}
        </p>
      ))}
  </>
)

function Basics({ draft, deal, problems, part }: SectionProps) {
  const syndicates = useData<{ managed: Array<{ id: string; name: string; status: string }> }>('/api/syndicates')
  const entities = useData<{ entities: Array<{ id: string; type: string; fields: Record<string, string> }> }>('/api/entities')
  const b = draft.basics ?? {}
  const s = (b.syndicate ?? {}) as { mode?: string; id?: string; name?: string; lead_entity_id?: string }
  const usable = syndicates.data?.managed.filter((m) => m.status === 'active') ?? []
  const options = Object.fromEntries(deal.settings.enabled_structures.map((x) => [x, STRUCTURES[x] ?? x]))
  const entityName = (e: { type: string; fields: Record<string, string> }) => e.fields.full_name ?? e.fields.legal_name ?? e.fields.name ?? e.type
  const fixed = deal.state !== 'draft'
  return (
    <>
      <Choice
        label="Legal structure"
        field="structure"
        problems={problems}
        required
        value={b.structure}
        options={options}
        onChange={(v) => part('basics', { structure: v })}
      />
      <Choice
        label="Deal type"
        field="deal_type"
        problems={problems}
        required
        value={b.deal_type}
        options={{ primary: 'Primary' }}
        onChange={(v) => part('basics', { deal_type: v })}
      />
      <Text
        label="Deal name"
        field="name"
        problems={problems}
        required
        hint="Investors see this name."
        value={b.name}
        onChange={(v) => part('basics', { name: v })}
      />
      <fieldset disabled={fixed}>
        <legend>Syndicate *</legend>
        {fixed && <p className="hint">Once a deal is submitted it stays with its syndicate.</p>}
        <label className="check block">
          <input type="radio" name="syndicate-mode" checked={s.mode === 'existing'} onChange={() => part('basics', { syndicate: { mode: 'existing' } })} /> One
          I manage
        </label>
        <label className="check block">
          <input type="radio" name="syndicate-mode" checked={s.mode === 'new'} onChange={() => part('basics', { syndicate: { mode: 'new' } })} /> A new one
        </label>
        {s.mode === 'existing' && (
          <label>
            Syndicate *
            <select value={s.id ?? ''} onChange={(e) => part('basics', { syndicate: { mode: 'existing', id: e.target.value || undefined } })}>
              <option value="">Choose</option>
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {s.mode === 'new' && (
          <>
            <label>
              Syndicate name *
              <input value={s.name ?? ''} onChange={(e) => part('basics', { syndicate: { ...s, mode: 'new', name: e.target.value || undefined } })} />
            </label>
            <FieldProblems problems={problems} field="syndicate.name" />
            <label>
              Lead entity *
              <select
                value={s.lead_entity_id ?? ''}
                onChange={(e) => part('basics', { syndicate: { ...s, mode: 'new', lead_entity_id: e.target.value || undefined } })}
              >
                <option value="">Choose</option>
                {entities.data?.entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {entityName(e)}
                  </option>
                ))}
              </select>
            </label>
            {entities.data && !entities.data.entities.length && <p className="hint">Add an investing entity on your home page first.</p>}
            <FieldProblems problems={problems} field="syndicate.lead_entity_id" />
            <p className="hint">The syndicate is created only when this deal is submitted. Deleting the draft leaves nothing behind.</p>
          </>
        )}
        <FieldProblems problems={problems} field="syndicate" />
      </fieldset>
    </>
  )
}

function Company({ draft, deal, problems, part }: SectionProps) {
  const c = draft.company ?? {}
  const extra = deal.settings.required_company_fields
  const set = (k: keyof NonNullable<Draft['company']>) => (v: string | undefined) => part('company', { [k]: v })
  return (
    <>
      <div className="logo" aria-hidden="true">
        {(c.legal_name ?? '?').trim().charAt(0).toUpperCase() || '?'}
      </div>
      <p className="hint">A logo is made from the company's name for now.</p>
      <Text label="Legal name" field="legal_name" problems={problems} required value={c.legal_name} onChange={set('legal_name')} />
      <Text label="Website" field="website" problems={problems} hint="Must start with https." value={c.website} onChange={set('website')} />
      <Text label="Contact name" field="contact_name" problems={problems} required value={c.contact_name} onChange={set('contact_name')} />
      <Text
        label="Contact email"
        field="contact_email"
        problems={problems}
        required
        type="email"
        hint="This person is sent a link to provide the company's documents, once the deal is submitted."
        value={c.contact_email}
        onChange={set('contact_email')}
      />
      <Text label="Jurisdiction" field="jurisdiction" problems={problems} required value={c.jurisdiction} onChange={set('jurisdiction')} />
      <Text
        label="Registration number"
        field="registration_number"
        problems={problems}
        required={extra.includes('registration_number')}
        value={c.registration_number}
        onChange={set('registration_number')}
      />
      <Text label="Address" field="address" problems={problems} required={extra.includes('address')} rows={2} value={c.address} onChange={set('address')} />
    </>
  )
}

function Terms({ draft, deal, problems, part }: SectionProps) {
  const t = draft.terms ?? {}
  const set =
    <K extends keyof NonNullable<Draft['terms']>>(k: K) =>
    (v: NonNullable<Draft['terms']>[K]) =>
      part('terms', { [k]: v })
  const money = { problems }
  const floor = draftAmountToTyped(deal.settings.min_commitment_floor_minor)
  return (
    <>
      <Choice
        label="Currency"
        field="currency"
        problems={problems}
        required
        value={t.currency}
        options={{ GBP: 'GBP', USD: 'USD', EUR: 'EUR' }}
        hint="Amounts below are in this currency. Nothing is converted."
        onChange={set('currency')}
      />
      <Check label="SEIS" checked={t.seis} onChange={set('seis')} />
      <Check label="EIS" checked={t.eis} onChange={set('eis')} />
      <NoticeList notices={deal.notices} only={['tax_relief_not_judged']} />
      <Choice label="Round" field="round" problems={problems} value={t.round} options={ROUNDS} onChange={set('round')} />
      <Choice label="Instrument" field="instrument" problems={problems} required value={t.instrument} options={INSTRUMENTS} onChange={set('instrument')} />
      {t.instrument === 'equity' && (
        <>
          <Choice label="Share class" field="share_class" problems={problems} value={t.share_class} options={SHARE_CLASSES} onChange={set('share_class')} />
          <Check
            label="I do not know the price yet: use 1.00 as a placeholder"
            testid="placeholder-price"
            checked={t.price_is_placeholder}
            onChange={(v) => part('terms', v ? { price_is_placeholder: true, share_price_micros: '1000000' } : { price_is_placeholder: false })}
          />
          <NoticeList notices={deal.notices} only={['placeholder_price']} />
          <Typed
            key={`price-${t.price_is_placeholder === true}`}
            label="Share price"
            field="share_price_micros"
            {...money}
            required
            disabled={t.price_is_placeholder === true}
            hint="Up to six decimal places."
            stored={t.share_price_micros}
            read={draftPriceToTyped}
            write={typedPriceToDraft}
            onChange={set('share_price_micros') as (v: never) => void}
          />
          <Money
            label="Pre-money valuation"
            field="pre_money_minor"
            {...money}
            required
            hint="At least 1,000."
            stored={t.pre_money_minor}
            onChange={set('pre_money_minor')}
          />
        </>
      )}
      {t.instrument && ['cln', 'safe', 'asa'].includes(t.instrument) && (
        <>
          <Choice label="Valuation cap type" field="cap_type" problems={problems} value={t.cap_type} options={CAP_TYPES} onChange={set('cap_type')} />
          {(t.cap_type === 'pre_money' || t.cap_type === 'post_money') && (
            <Money label="Valuation cap" field="cap_minor" {...money} required stored={t.cap_minor} onChange={set('cap_minor')} />
          )}
          <Percent label="Discount (%)" field="discount_bps" {...money} hint="From 0 to 99.99." stored={t.discount_bps} onChange={set('discount_bps')} />
        </>
      )}
      {t.instrument === 'fund_units' && (
        <Text
          label="Fund description"
          field="fund_description"
          problems={problems}
          rows={3}
          hint="For the review only. Investors do not see it."
          value={t.fund_description}
          onChange={set('fund_description')}
        />
      )}
      <Money label="Total round size (estimate)" field="round_size_minor" {...money} stored={t.round_size_minor} onChange={set('round_size_minor')} />
      <Money
        label="SPV allocation"
        field="allocation_minor"
        {...money}
        required
        hint="At most 1,000,000,000."
        stored={t.allocation_minor}
        onChange={set('allocation_minor')}
      />
      <Choice
        label="When the allocation is full"
        field="over_allocation"
        problems={problems}
        value={t.over_allocation}
        options={OVER_ALLOCATION}
        onChange={set('over_allocation')}
      />
      <Money
        label="Minimum commitment"
        field="min_commitment_minor"
        {...money}
        hint={`Leave empty for the operator's minimum of ${floor}.`}
        stored={t.min_commitment_minor}
        onChange={set('min_commitment_minor')}
      />
      <Money
        label="Minimum raise"
        field="min_raise_minor"
        {...money}
        hint="Optional. If set, it is a condition of closing, and cannot be above the SPV allocation."
        stored={t.min_raise_minor}
        onChange={set('min_raise_minor')}
      />
      <Text label="Target close date" field="target_close" problems={problems} type="date" value={t.target_close} onChange={set('target_close')} />
      <Text
        label="Payment deadline"
        field="pay_by"
        problems={problems}
        type="date"
        hint="Optional, and after today. It is a reminder only: nothing happens by itself on that day."
        value={t.pay_by}
        onChange={set('pay_by')}
      />
      <Choice label="Default voter" field="voter" problems={problems} required value={t.voter} options={VOTERS} onChange={set('voter')} />
      <NoticeList notices={deal.notices} only={['voter_scope']} />
      <Writing
        label="Custom terms"
        field="custom_terms"
        problems={problems}
        doc={t.custom_terms}
        hint="These bind everyone in the deal. A reviewer will read them. # starts a heading, - starts a list, **bold**, *italic*."
        onChange={(d) => part('terms', { custom_terms: d })}
      />
    </>
  )
}

function Files({ draft, deal, problems, part, refresh }: SectionProps & { refresh: () => Promise<unknown> }) {
  const deck = (draft.files?.deck ?? {}) as { kind?: string; url?: string; embed_url?: string }
  const { error, run } = useRun()
  const [folder, setFolder] = useState('')
  const [folderName, setFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const submitted = deal.state === 'in_review' || deal.state === 'approved'
  const upload = (kind: 'legal' | 'deck') => (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    setBusy(true)
    void run(async () => {
      try {
        for (const f of files)
          await uploadFile(
            `/api/deals/${deal.id}/files?kind=${kind}&name=${encodeURIComponent(f.name)}${kind === 'legal' && folder ? `&folder=${folder}` : ''}`,
            f,
          )
      } finally {
        setBusy(false)
        await refresh()
      }
    })
  }
  const remove = (file: string) =>
    run(async () => {
      await api(`/api/deals/${deal.id}/files/${file}`, 'DELETE')
      await refresh()
    })
  const addFolder = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/deals/${deal.id}/folders`, 'POST', { name: folderName, parent_id: folder || null })
      setFolderName('')
      await refresh()
    })
  }
  const legal = deal.files.filter((f) => f.requirement === 'legal')
  const deckFile = deal.files.find((f) => f.requirement === 'deck')
  const folderPath = (id: string | null): string => {
    const f = deal.folders.find((x) => x.id === id)
    return f ? `${f.parent_id ? `${folderPath(f.parent_id)} / ` : ''}${f.name}` : ''
  }
  const row = (f: DealFile) => (
    <li key={f.id}>
      <span>
        <a href={`/api/deals/${deal.id}/files/${f.id}`} download={f.display_name}>
          {f.display_name}
        </a>
        {f.folder_id && <span className="hint"> in {folderPath(f.folder_id)}</span>}
      </span>
      <button type="button" className="secondary" onClick={() => remove(f.id)}>
        Remove {f.display_name}
      </button>
    </li>
  )
  return (
    <>
      {submitted && <p className="warning">Adding or removing a file starts the review again.</p>}
      <Problem error={error} />
      <Writing label="Memo" field="memo" problems={problems} doc={draft.files?.memo} onChange={(d) => part('files', { memo: d })} />
      <h3>Pitch deck</h3>
      <label className="check block">
        <input type="radio" name="deck" checked={!deck.kind} onChange={() => part('files', { deck: undefined })} /> None
      </label>
      <label className="check block">
        <input type="radio" name="deck" checked={deck.kind === 'file'} onChange={() => part('files', { deck: { kind: 'file' } })} /> A PDF, up to 10 MB
      </label>
      <label className="check block">
        <input type="radio" name="deck" checked={deck.kind === 'link'} onChange={() => part('files', { deck: { kind: 'link' } })} /> A link
      </label>
      {deck.kind === 'file' && (
        <>
          <label>
            Pitch deck PDF *
            <input type="file" accept="application/pdf" disabled={busy} onChange={upload('deck')} />
          </label>
          {deckFile && <ul className="list">{row(deckFile)}</ul>}
          <FieldProblems problems={problems} field="deck" />
        </>
      )}
      {deck.kind === 'link' && (
        <>
          <Text
            label="Pitch deck link"
            required
            field="deck.url"
            problems={problems}
            value={deck.url}
            onChange={(v) => part('files', { deck: { ...deck, kind: 'link', url: v } as never })}
          />
          <Text
            label="Embed address"
            field="deck.embed_url"
            problems={problems}
            hint={
              deal.settings.embed_hosts.length
                ? `Optional. Only these sites: ${deal.settings.embed_hosts.join(', ')}.`
                : 'The operator has not allowed any site for embedding.'
            }
            value={deck.embed_url}
            onChange={(v) => part('files', { deck: { ...deck, kind: 'link', embed_url: v } as never })}
          />
          <NoticeList notices={deal.notices} only={['external_deck']} />
        </>
      )}
      <h3>Investment agreement and legal documents *</h3>
      <p className="hint">PDF or Word (.docx), up to 100 MB each. Drafts and term sheets are fine.</p>
      <label>
        Put new files in
        <select value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">No folder</option>
          {deal.folders.map((f) => (
            <option key={f.id} value={f.id}>
              {folderPath(f.id)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Add files
        <input
          type="file"
          multiple
          disabled={busy}
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={upload('legal')}
        />
      </label>
      {busy && <p role="status">Uploading and checking…</p>}
      <ul className="list" data-testid="legal-files">
        {legal.map(row)}
      </ul>
      <form className="row" onSubmit={addFolder}>
        <label>
          New folder *
          <input required maxLength={200} value={folderName} onChange={(e) => setFolderName(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Add the folder
        </button>
      </form>
    </>
  )
}

function FeeTry({ fee }: { fee: FeeConfig }) {
  const [typed, setTyped] = useState('')
  const value = typedAmountToDraft(typed)
  let line = ''
  if (value !== null && /^\d{1,18}$/.test(value)) {
    try {
      line = `Platform fee on that amount: ${draftAmountToTyped(String(platformFee(fee, BigInt(value))))}.`
    } catch {
      line = 'The fee cannot be worked out for that amount.'
    }
  }
  return (
    <>
      <label>
        Try an amount raised
        <input inputMode="decimal" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      {line && (
        <p role="status" data-testid="fee-try">
          {line}
        </p>
      )}
    </>
  )
}

interface RaiseAnswer {
  payer: string
  raise_minor: string
  fee_minor: string
  net_minor: string
  note: string
}

/** R-ADM-03: how much to raise so that a sum reaches the company, by the deal's fee and the payer as last saved. */
function RaiseCalculator({ dealId }: { dealId: string }) {
  const [typed, setTyped] = useState('')
  const [answer, setAnswer] = useState<RaiseAnswer | null>(null)
  const { error, run } = useRun()
  const work = (ev: FormEvent) => {
    ev.preventDefault()
    setAnswer(null)
    const target = typedAmountToDraft(typed)
    void run(async () => {
      if (target === null || !/^[1-9][0-9]{0,15}$/.test(target)) throw new Error('Type the amount the company should receive, such as 100000 or 100,000.00.')
      setAnswer(await api<RaiseAnswer>(`/api/deals/${dealId}/calculator`, 'POST', { target_minor: target }))
    })
  }
  return (
    <form onSubmit={work} className="card" data-testid="raise-calculator">
      <h2>How much to raise</h2>
      <p className="hint">Uses the platform fee and who pays it as last saved.</p>
      <div className="row">
        <label>
          The company should receive
          <input inputMode="decimal" required value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Work it out
        </button>
      </div>
      <Problem error={error} />
      {answer && (
        <div role="status" data-testid="raise-answer">
          <dl>
            <dt>Raise</dt>
            <dd>{draftAmountToTyped(answer.raise_minor)}</dd>
            <dt>Platform fee and surcharge</dt>
            <dd>{draftAmountToTyped(answer.fee_minor)}</dd>
            <dt>Reaches the company</dt>
            <dd>{draftAmountToTyped(answer.net_minor)}</dd>
          </dl>
          <p className="hint">{answer.note}</p>
        </div>
      )}
    </form>
  )
}

/** R-PIP-05: a new draft from this deal, with only the fields that carry over; people invited come along only if asked. */
function CopyDeal({ dealId }: { dealId: string }) {
  const [people, setPeople] = useState(false)
  const { error, run } = useRun()
  const copy = () =>
    void run(async () => {
      const r = await api<{ id: string }>(`/api/deals/${dealId}/copy`, 'POST', { import_invited: people })
      window.location.assign(`/deals/${r.id}`)
    })
  return (
    <section className="card" data-testid="copy-deal">
      <h2>Copy this deal</h2>
      <p className="hint">
        A new draft with this deal's terms and texts. The company, valuation, price, files and approvals are not copied; you are its lead.
      </p>
      <Check label="Also bring the people invited, as names and addresses on the new deal's list" checked={people} onChange={setPeople} />
      <p>
        <button type="button" className="secondary" onClick={copy}>
          Make the copy
        </button>
      </p>
      <Problem error={error} />
    </section>
  )
}

const asFee = (s: Settings['fee']): FeeConfig | null =>
  s
    ? {
        rate_bps: s.rate_bps,
        min_minor: BigInt(s.min_minor),
        max_minor: BigInt(s.max_minor),
        surcharge_threshold_minor: BigInt(s.surcharge_threshold_minor),
        surcharge_bps: s.surcharge_bps,
      }
    : null
type Recipient = NonNullable<NonNullable<Draft['economics']>['recipients']>[number]

function Economics({ draft, deal, problems, part }: SectionProps) {
  const e = draft.economics ?? {}
  const recipients = e.recipients ?? []
  const fee = asFee(deal.settings.fee)
  const setRecipient = (i: number, v: Partial<Recipient>) => part('economics', { recipients: recipients.map((r, n) => (n === i ? { ...r, ...v } : r)) })
  // stable identities for the boxes, which keep what was typed: without them removing one person shows the next person's figures wrongly
  const [keys, setKeys] = useState(() => recipients.map((_, i) => i))
  const nextKey = useRef(recipients.length)
  const [seeded, setSeeded] = useState(0)
  useEffect(() => {
    // the operator's default, as a starting point for a section never opened; once someone has cleared it, it stays cleared
    if (draft.economics === undefined) {
      part('economics', { default_carry_bps: deal.settings.default_carry_bps })
      setSeeded(1)
    }
    // only when the section first opens
  }, []) // eslint-disable-line
  return (
    <>
      <Percent
        key={seeded}
        label="Default carry (%)"
        field="default_carry_bps"
        problems={problems}
        required
        hint="From 0 to 100."
        stored={e.default_carry_bps}
        onChange={(v) => part('economics', { default_carry_bps: v })}
      />
      <h3>Who receives the carry</h3>
      <FieldProblems problems={problems} field="recipients" />
      {recipients.map((r, i) => {
        const at = `recipients.${i}`
        const text = (k: keyof Recipient, label: string, type = 'text') => (
          <Text
            label={`${label}`}
            field={`${at}.${String(k)}`}
            problems={problems}
            required
            type={type}
            value={r[k] as string | undefined}
            onChange={(v) => setRecipient(i, { [k]: v })}
          />
        )
        return (
          <fieldset key={keys[i]} data-testid={`recipient-${i}`}>
            <legend>Recipient {i + 1}</legend>
            <label>
              Type *
              <select
                value={r.kind ?? ''}
                onChange={(ev) =>
                  part('economics', {
                    recipients: recipients.map((x, n) => (n === i ? { kind: (ev.target.value || undefined) as Recipient['kind'], share_bps: x.share_bps } : x)),
                  })
                }
              >
                <option value="">Choose</option>
                <option value="person">A person</option>
                <option value="company">A company</option>
              </select>
            </label>
            {r.kind === 'person' && (
              <>
                {text('first_name', 'First name')}
                {text('last_name', 'Last name')}
                {text('email', 'Email', 'email')}
              </>
            )}
            {r.kind === 'company' && (
              <>
                {text('trading_name', 'Trading name')}
                {text('legal_name', 'Legal name')}
                {text('registration_number', 'Registration number')}
                {text('contact_name', 'Contact name')}
                {text('contact_email', 'Contact email', 'email')}
              </>
            )}
            <Percent
              label="Share of the carry (%)"
              field={`${at}.share_bps`}
              problems={problems}
              required
              stored={r.share_bps}
              onChange={(v) => setRecipient(i, { share_bps: v })}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setKeys(keys.filter((_, n) => n !== i))
                part('economics', { recipients: recipients.filter((_, n) => n !== i) })
              }}
            >
              Remove recipient {i + 1}
            </button>
          </fieldset>
        )
      })}
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setKeys([...keys, nextKey.current++])
          part('economics', { recipients: [...recipients, {}] })
        }}
      >
        Add a recipient
      </button>
      <h3>Platform fee</h3>
      <p data-testid="fee-summary">
        {deal.settings.fee ? feeWords(deal.settings.fee) : 'The operator has not set the platform fee yet. A deal cannot be submitted until it is set.'}
      </p>
      <Choice
        label="Who pays the platform fee"
        field="fee_payer"
        problems={problems}
        required
        value={e.fee_payer}
        options={FEE_PAYERS}
        onChange={(v) => part('economics', { fee_payer: v })}
      />
      <NoticeList notices={deal.notices} only={['fee_estimate', 'min_raise_helps']} />
      {e.fee_payer === 'investors' && fee && <FeeTry fee={fee} />}
    </>
  )
}

function Review({ draft, deal, problems, part, jump, submit, saving }: SectionProps & { jump: (s: Section) => void; submit: () => void; saving: boolean }) {
  const a = draft.attestations ?? {}
  const again = deal.state === 'changes_requested'
  const gaps = SECTIONS.map((s) => [s, problems.filter((p) => p.section === s)] as const).filter(([, l]) => l.length)
  return (
    <>
      {(Object.keys(PART_WORDS) as Array<keyof typeof PART_WORDS>).map((p) => (
        <div key={p} className="part">
          <h3>
            {PART_WORDS[p]}{' '}
            <button type="button" className="secondary small" onClick={() => jump(p)}>
              Edit {PART_WORDS[p]}
            </button>
          </h3>
          <DealPart part={p} d={withEffectiveMinimum(draft, deal.effective_min_commitment_minor)} />
        </div>
      ))}
      <h3>Before you submit</h3>
      <Check
        testid="attest-board"
        label="The company's board and shareholders have approved this deal, pre-emption rights are dealt with, and I can show evidence if asked. *"
        checked={a.board_and_shareholders}
        onChange={(v) => part('attestations', { board_and_shareholders: v })}
      />
      {draft.terms?.instrument === 'fund_units' && (
        <Check
          testid="attest-fund"
          label="The fund invests wholly or mainly in unlisted companies. The software cannot judge this. *"
          checked={a.fund_mainly_unlisted}
          onChange={(v) => part('attestations', { fund_mainly_unlisted: v })}
        />
      )}
      <div data-testid="gaps">
        {gaps.length > 0 ? (
          <>
            <h3>Still to do</h3>
            {gaps.map(([s, list]) => (
              <div key={s}>
                <button type="button" className="secondary small" onClick={() => jump(s)}>
                  {SECTION_WORDS[s]}
                </button>
                <ul>
                  {list.map((p) => (
                    <li key={`${p.field}${p.message}`}>{p.message}</li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        ) : (
          <p role="status">Nothing is missing.</p>
        )}
      </div>
      <h3>What happens next</h3>
      <ol className="steps">
        <li>A reviewer reads the deal, usually within {deal.review_target_days} days. You can still change it, but a change starts the review again.</li>
        <li>The company contact is sent a link to provide the company's documents. Without them the deal can raise money, but cannot close.</li>
        <li>Once it is approved, you confirm that it should go live.</li>
      </ol>
      {(deal.state === 'draft' || again) && (
        <button type="button" disabled={saving} onClick={submit}>
          {again ? 'Send back for review' : 'Submit for review'}
        </button>
      )}
    </>
  )
}

function Team({ deal, refresh }: { deal: Deal; refresh: () => Promise<unknown> }) {
  const s = deal.draft.basics?.syndicate as { mode?: string; id?: string } | undefined
  const syndicate = useData<{ team: Array<{ user_id: string; name: string }> }>(s?.mode === 'existing' && s.id ? `/api/syndicates/${s.id}` : null)
  const { error, run } = useRun()
  const [who, setWho] = useState('')
  const [role, setRole] = useState('member')
  const onDeal = new Set(deal.team.map((m) => m.user_id))
  const others = syndicate.data?.team.filter((m) => !onDeal.has(m.user_id)) ?? []
  const add = () =>
    run(async () => {
      await api(`/api/deals/${deal.id}/members/${who}`, 'PUT', { role })
      setWho('')
      await refresh()
    })
  const remove = (user: string) =>
    run(async () => {
      await api(`/api/deals/${deal.id}/members/${user}`, 'DELETE')
      await refresh()
    })
  if (s?.mode !== 'existing') return null
  return (
    <section className="card">
      <h2>People on this deal</h2>
      <Problem error={error} />
      {deal.team.length === 0 && <p className="hint">Only you so far.</p>}
      <ul className="list" data-testid="deal-team">
        {deal.team.map((m) => (
          <li key={m.user_id}>
            <span>
              {m.name} <span className="hint">{m.role === 'co_lead' ? 'co-lead' : 'member'}</span>
            </span>
            <button type="button" className="secondary" onClick={() => remove(m.user_id)}>
              Remove {m.name}
            </button>
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <div className="row">
          <label>
            Person
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Choose</option>
              {others.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="co_lead">Co-lead</option>
            </select>
          </label>
          <button type="button" className="secondary" disabled={!who} onClick={add}>
            Add to the deal
          </button>
        </div>
      )}
      <p className="hint">A co-lead shares the carry only if you add them as a recipient. Co-leads are told when the deal is submitted.</p>
    </section>
  )
}

function CompanyCheck({ deal, refresh }: { deal: Deal; refresh: () => Promise<unknown> }) {
  const { error, run } = useRun()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState('')
  const i = deal.investee
  if (!i) return null
  const canChase = deal.can_manage && (i.status === 'waiting' || i.status === 'returned')
  return (
    <section className="card">
      <h2>Company check</h2>
      <p>
        <span className="pill" data-testid="investee-status">
          {INVESTEE_WORDS[i.status] ?? i.status}
        </span>{' '}
        Documents received: <span data-testid="investee-count">{i.documents_received}</span>.
      </p>
      {i.return_reason && <p>Reason it was sent back: {i.return_reason}</p>}
      {i.link_expires_at && (i.status === 'waiting' || i.status === 'returned') && (
        <p className="hint">The company's link works until {new Date(i.link_expires_at).toLocaleDateString()}.</p>
      )}
      <p className="hint">
        You see how far this has got. The documents themselves go only to the reviewer. Without a pass the deal can raise money, but cannot close.
      </p>
      <Problem error={error} />
      {sent && <p role="status">{sent}</p>}
      {canChase && (
        <button
          type="button"
          className="secondary"
          onClick={() =>
            run(async () => {
              await api(`/api/deals/${deal.id}/investee/remind`, 'POST')
              setSent('A new link is on its way to the company.')
              await refresh()
            })
          }
        >
          Remind the company
        </button>
      )}
      {deal.can_manage && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await api(`/api/deals/${deal.id}/investee/contacts`, 'POST', { name, email })
              setName('')
              setEmail('')
              setSent('Contact recorded.')
            })
          }}
        >
          <h3>Record another contact</h3>
          <label>
            Name *
            <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Email *
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit" className="secondary">
            Record the contact
          </button>
        </form>
      )}
    </section>
  )
}

/** Saves in the background, one request at a time, the latest words last. `flush` says whether everything reached the server. */
function useAutosave(id: string, onSaved: () => void, rev: { current: number }) {
  const pending = useRef<Draft | null>(null)
  const running = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [status, setStatus] = useState<'saved' | 'saving' | 'failed'>('saved')
  const [error, setError] = useState<unknown>(null)
  const drain = useCallback((): Promise<boolean> => {
    if (running.current) return running.current
    // nothing to send: finished before it could be recorded as running, it would block every later save
    if (!pending.current) return Promise.resolve(true)
    const work = (async () => {
      try {
        while (pending.current) {
          const body = pending.current
          pending.current = null
          setStatus('saving')
          try {
            rev.current = (await api<{ rev: number }>(`/api/deals/${id}/draft?autosave=1&base=${rev.current}`, 'PUT', body)).rev
          } catch (x) {
            pending.current ??= body
            throw x
          }
        }
        setStatus('saved')
        setError(null)
        onSaved()
        return true
      } catch (x) {
        setStatus('failed')
        setError(x)
        return false
      } finally {
        running.current = null
      }
    })()
    running.current = work
    return work
  }, [id, onSaved, rev])
  const queue = useCallback(
    (d: Draft) => {
      pending.current = d
      setStatus('saving')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void drain(), 500)
    },
    [drain],
  )
  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    // a request already on its way may have been overtaken by newer words
    if (running.current && !(await running.current)) return false
    return pending.current ? drain() : status !== 'failed'
  }, [drain, status])
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      void drain()
    },
    [drain],
  )
  return { queue, flush, status, error }
}

export function DealPage({ id }: { id: string }) {
  const { data: deal, error: loadError, reload } = useData<Deal>(`/api/deals/${id}`)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [section, setSection] = useState<Section>('basics')
  const [dirty, setDirty] = useState(false)
  const [confirmLive, setConfirmLive] = useState(false)
  // R-CHG-01: a change to a deal after launch is typed here and sent with one sentence; it is not saved as the deal
  const [changing, setChanging] = useState(false)
  const [summary, setSummary] = useState('')
  const [changeNote, setChangeNote] = useState('')
  const [sent, setSent] = useState(0)
  const { error, run } = useRun()
  const refresh = useCallback(() => void reload(), [reload])
  const rev = useRef(0)
  // the approval that goes with the copy on screen; a later refresh of the page's other data must not swap it
  const shownApproval = useRef<string | null>(null)
  const edits = useRef(0)
  const editsAtLoad = useRef(0)
  const save = useAutosave(id, refresh, rev)
  const loaded = useRef(false)
  // the boxes keep what was typed, so a fresh copy of the deal needs fresh boxes
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    // once only: a refresh after saving must not write over what is being typed
    if (deal && !loaded.current) {
      loaded.current = true
      // typed since this copy was asked for: what is on screen is newer, and stays paired with the version it was typed on
      if (edits.current === editsAtLoad.current) {
        rev.current = deal.draft_rev
        shownApproval.current = deal.approved_sha256
        setDraft(deal.draft)
        setGeneration((g) => g + 1)
      }
    }
  }, [deal])
  if (loadError && !deal)
    return (
      <section className="card">
        <Problem error={loadError} />
        <Link to="/deals">Back to deals</Link>
      </section>
    )
  if (!deal || !draft) return <p>Loading…</p>
  const auto = deal.state === 'draft' || deal.state === 'changes_requested'
  const change = (d: Draft) => {
    edits.current++
    setDraft(d)
    if (auto) save.queue(d)
    else setDirty(true)
  }
  const part: SectionProps['part'] = (k, v) => change({ ...draft, [k]: { ...draft[k], ...v } })
  const start = () => {
    loaded.current = false
    editsAtLoad.current = edits.current
    setDirty(false)
    return reload()
  }
  const act = (f: () => Promise<unknown>) =>
    run(async () => {
      await f()
      await start()
    })
  const jump = (s: Section) => {
    void save.flush()
    setSection(s)
    window.scrollTo(0, 0)
  }
  const submit = () =>
    run(async () => {
      if (!(await save.flush())) return
      await api(`/api/deals/${id}/submit`, 'POST', { base: rev.current, file_ids: deal.files.map((f) => f.id) })
      await start()
      setSection('basics')
    })
  const saveChanges = () =>
    run(async () => {
      const sent = edits.current
      rev.current = (await api<{ rev: number }>(`/api/deals/${id}/draft?base=${rev.current}`, 'PUT', draft)).rev
      // typed while the save was on its way: keep it, and keep it marked as not saved
      if (edits.current === sent) await start()
      else await reload()
    })
  const sendChange = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api<{ state: 'applied' | 'submitted'; version: number | null }>(`/api/deals/${id}/changes`, 'POST', {
        draft,
        summary,
        base_version: deal.approved_version,
      })
      setChangeNote(
        r.state === 'applied'
          ? `In force now as version ${r.version}. Investors who committed are told.`
          : 'Sent. A reviewer decides what happens next; nothing changes for investors until then.',
      )
      setChanging(false)
      setSummary('')
      setSent((n) => n + 1)
      await start()
    })
  }
  const stopChanging = () => {
    setChanging(false)
    void start()
  }
  const remove = () =>
    run(async () => {
      await api(`/api/deals/${id}`, 'DELETE')
      go('/deals')
    })
  const props: SectionProps = { draft, deal, problems: deal.problems, part }
  const changeable = !deal.can_edit && deal.can_manage && deal.approved_version !== null && ['live', 'closing_requested', 'closing'].includes(deal.state)
  const editing = deal.can_edit || (changeable && changing)
  const lastReason = [...deal.events].reverse().find((e) => e.reason)?.reason
  return (
    <>
      <section className="card">
        <p>
          <Link to="/deals">All deals</Link>
        </p>
        <h1>{draft.basics?.name || 'Untitled deal'}</h1>
        <p>
          <span className="pill" data-testid="deal-state">
            {STATE_WORDS[deal.state] ?? deal.state}
          </span>{' '}
          <span className="hint">Reference {deal.public_code}</span>
        </p>
        {(deal.state === 'changes_requested' || deal.state === 'rejected') && lastReason && (
          <p className="warning" data-testid="deal-reason">
            Reason: {lastReason}
          </p>
        )}
        {deal.state === 'in_review' && <p className="hint">A reviewer usually reads a deal within {deal.review_target_days} days.</p>}
        <Problem error={error} />
        {deal.state === 'approved' && deal.can_edit && (
          <div data-testid="launch">
            <p>The deal passed review. It goes live only when you confirm it. Changing anything now sends it back to review.</p>
            <label className="check block">
              <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} /> I confirm this deal should go live
            </label>
            {dirty && (
              <p className="field-error" data-testid="unsaved-changes">
                You have changes that are not saved. Save them or reload the page before going live.
              </p>
            )}
            <button
              type="button"
              disabled={!confirmLive || dirty}
              onClick={() => act(() => api(`/api/deals/${id}/launch`, 'POST', { confirm: true, content_sha256: shownApproval.current }))}
            >
              Go live
            </button>
          </div>
        )}
        <div className="row">
          {deal.state === 'in_review' && deal.can_edit && (
            <button type="button" className="secondary" disabled={dirty} onClick={() => act(() => api(`/api/deals/${id}/withdraw`, 'POST'))}>
              Withdraw from review
            </button>
          )}
          {deal.state === 'draft' && deal.can_edit && (
            <button type="button" className="secondary" onClick={remove}>
              Delete this draft
            </button>
          )}
        </div>
        <Changes changes={deal.changes} />
        <History events={deal.events} />
      </section>
      {editing ? (
        <section className="card" data-testid={changing ? 'change-editor' : undefined}>
          <nav className="sections" aria-label="Sections of the deal">
            {SECTIONS.filter((s) => !changing || s !== 'review').map((s) => (
              <button
                key={s}
                type="button"
                className={s === section ? 'section-tab current' : 'section-tab'}
                aria-current={s === section ? 'step' : undefined}
                data-testid={`section-${s}`}
                onClick={() => jump(s)}
              >
                {SECTION_WORDS[s]} <span className={deal.progress[s] ? 'done' : 'todo'}>{deal.progress[s] ? '✓ done' : 'to finish'}</span>
              </button>
            ))}
          </nav>
          <h2>{SECTION_WORDS[section]}</h2>
          {changing ? (
            <p className="warning">
              You are changing a live deal. A new target close date, payment deadline or choice of what happens when the allocation is full takes
              effect at once and investors are told; anything else goes to a reviewer, who decides whether investors are only told or must reconfirm.
            </p>
          ) : auto ? (
            <p className={save.status === 'failed' ? 'field-error' : 'hint'} role="status" data-testid="save-status">
              {save.status === 'saving' ? 'Saving…' : save.status === 'failed' ? 'Not saved.' : 'Saved.'}
            </p>
          ) : (
            <p className="warning">Saving a change here starts the review again, and every required field must be filled.</p>
          )}
          {save.status === 'failed' && <Problem error={save.error} />}
          <div key={generation}>
            {section === 'basics' && <Basics {...props} />}
            {section === 'company' && <Company {...props} />}
            {section === 'terms' && <Terms {...props} />}
            {section === 'files' && <Files {...props} refresh={reload} />}
            {section === 'economics' && <Economics {...props} />}
            {section === 'review' && <Review {...props} jump={jump} submit={submit} saving={save.status === 'saving'} />}
          </div>
          {changing ? (
            <form onSubmit={sendChange} data-testid="send-change">
              <label>
                What changes and why, in one sentence (investors read it) *
                <input required maxLength={300} value={summary} onChange={(e) => setSummary(e.target.value)} />
              </label>
              <div className="row">
                <button type="submit" disabled={!dirty}>
                  Send this change
                </button>
                <button type="button" className="secondary" onClick={stopChanging}>
                  Stop without sending
                </button>
              </div>
            </form>
          ) : (
            !auto && (
              <p>
                <button type="button" disabled={!dirty} onClick={saveChanges}>
                  Save changes and restart the review
                </button>
              </p>
            )
          )}
        </section>
      ) : (
        <section className="card">
          <DealRead d={withEffectiveMinimum(draft, deal.effective_min_commitment_minor)} />
          <h3>Files</h3>
          <FileLinks dealId={id} files={deal.files} />
          {changeNote && (
            <p role="status" className="hint" data-testid="change-note">
              {changeNote}
            </p>
          )}
          {changeable && (
            <p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setChangeNote('')
                  setSection('basics')
                  setChanging(true)
                }}
              >
                Change this deal
              </button>
            </p>
          )}
        </section>
      )}
      {deal.can_manage && deal.approved_version !== null && <LeadChanges dealId={id} version={sent} />}
      {deal.can_edit && <Team deal={deal} refresh={reload} />}
      <CompanyCheck deal={deal} refresh={reload} />
      <DealLifecycle dealId={id} state={deal.state} currency={deal.draft.terms?.currency ?? 'GBP'} onChange={refresh} />
      {deal.state !== 'rejected' && <LiveDealTools dealId={id} state={deal.state} />}
      {deal.approved_version !== null && <InvestorPreview dealId={id} />}
      {/* both are for anyone who runs the deal, the lead and the team alike (canAdministerDeal), whatever the deal's state;
          the calculator only once the route has a payer to use: the approved version's (always set, it is required to submit) or the saved draft's */}
      {deal.settings.fee && (deal.approved_version !== null || deal.draft.economics?.fee_payer) && (
        <RaiseCalculator key={deal.draft.economics?.fee_payer ?? ''} dealId={id} />
      )}
      <CopyDeal dealId={id} />
    </>
  )
}
