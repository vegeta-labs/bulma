// Staff screens for deals: the review queue and page, the content approver's page, and the operator's deal settings.
// A decision always names the content the person was shown, so a deal that changed meanwhile is refused and not approved unread.
import { useEffect, useState, type FormEvent } from 'react'
import { type Draft, withEffectiveMinimum } from '../lib/draft.ts'
import { draftAmountToTyped, draftPercentToTyped, typedAmountToDraft, typedPercentToDraft, typedWhole } from '../lib/pounds.ts'
import { api } from './api.ts'
import {
  Changes,
  DealRead,
  type DealEvent,
  type DealFile,
  DOCUMENT_WORDS,
  FileLinks,
  History,
  INVESTEE_WORDS,
  Link,
  RichView,
  STATE_WORDS,
  useData,
  type FeeTerms,
} from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'

interface QueueRow {
  id: string
  public_code: string
  name: string | null
  target_close: string | null
  submitted_at: string
  can_review: boolean
}

export function DealQueue() {
  const { data, error } = useData<{ deals: QueueRow[] }>('/api/review/deals')
  return (
    <section className="card">
      <h1>Deals waiting for review</h1>
      <Problem error={error} />
      {data && !data.deals.length && <p>Nothing is waiting.</p>}
      <ul className="list" data-testid="deal-queue">
        {data?.deals.map((d) => (
          <li key={d.id}>
            <span>
              {d.can_review ? <Link to={`/review/${d.id}`}>{d.name || 'Untitled deal'}</Link> : d.name || 'Untitled deal'}{' '}
              <span className="hint">{d.public_code}</span>
              <span className="hint"> Target close: {d.target_close ?? 'none given'}</span>
            </span>
            {!d.can_review && <span className="hint">You have a stake in this deal, so you cannot review it.</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

interface ReviewData {
  id: string
  state: string
  public_code: string
  draft: Draft
  checklist: { customTerms: string | null }
  files: DealFile[]
  investee: {
    status: string
    check_sha256: string
    reused_earlier_check: boolean
    company: { legal_name: string; jurisdiction: string; registration_number: string | null }
    needs_notarised_signature: boolean | null
    return_reason: string | null
    documents: Array<{ id: string; requirement: string; display_name: string }>
  } | null
  events: DealEvent[]
  changes: Array<{ field: string; before: string | null; after: string | null }>
  latest_sha256: string | null
  platform_fee: FeeTerms | null
  effective_min_commitment_minor: string | null
}

function CompanyReview({ id, data, reload }: { id: string; data: ReviewData; reload: () => Promise<unknown> }) {
  const [reason, setReason] = useState('')
  const { error, run } = useRun()
  const i = data.investee
  if (!i) return null
  const decide = (path: string, body?: unknown) =>
    run(async () => {
      await api(`/api/review/deals/${id}/investee/${path}`, 'POST', { reviewed_sha256: i.check_sha256, ...(body as object) })
      setReason('')
      await reload()
    })
  return (
    <section className="card">
      <h2>Company check</h2>
      <p data-testid="checked-company">
        This check is about: {i.company.legal_name}, {i.company.jurisdiction}
        {i.company.registration_number ? `, number ${i.company.registration_number}` : ''}
      </p>
      <p>
        <span className="pill" data-testid="review-investee-status">
          {INVESTEE_WORDS[i.status] ?? i.status}
        </span>
      </p>
      {i.needs_notarised_signature !== null && <p>Needs a notarised or handwritten signature: {i.needs_notarised_signature ? 'Yes' : 'No'}</p>}
      {i.reused_earlier_check && <p data-testid="reused-check">Passed on an earlier check of this company. The documents are with that check.</p>}
      {i.return_reason && <p>Sent back because: {i.return_reason}</p>}
      <ul data-testid="investee-documents">
        {i.documents.map((f) => (
          <li key={f.id}>
            <a href={`/api/review/deals/${id}/investee/files/${f.id}`} download={f.display_name}>
              {f.display_name}
            </a>{' '}
            <span className="hint">{DOCUMENT_WORDS[f.requirement] ?? f.requirement}</span>
          </li>
        ))}
      </ul>
      <Problem error={error} />
      {i.status === 'submitted' && (
        <>
          <label>
            If something is missing, say what
            <textarea rows={2} maxLength={5000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row">
            <button type="button" onClick={() => decide('approve')}>
              Pass the company
            </button>
            <button type="button" className="secondary" disabled={!reason.trim()} onClick={() => decide('return', { reason })}>
              Send back to the company
            </button>
          </div>
        </>
      )}
    </section>
  )
}

export function DealReview({ id }: { id: string }) {
  const { data, error: loadError, reload } = useData<ReviewData>(`/api/review/deals/${id}`)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [sureReject, setSureReject] = useState(false)
  const { error, run } = useRun()
  if (loadError && !data)
    return (
      <section className="card">
        <Problem error={loadError} />
        <Link to="/review">Back to the queue</Link>
      </section>
    )
  if (!data) return <p>Loading…</p>
  const decide = (path: 'approve' | 'request-changes' | 'reject') =>
    run(async () => {
      const internal = note.trim() ? { internal_note: note } : {}
      await api(`/api/review/deals/${id}/${path}`, 'POST', { reviewed_sha256: data.latest_sha256, ...internal, ...(path === 'approve' ? {} : { reason }) })
      setReason('')
      setNote('')
      setSureReject(false)
      await reload()
    })
  return (
    <>
      <section className="card">
        <p>
          <Link to="/review">Back to the queue</Link>
        </p>
        <h1>{data.draft.basics?.name || 'Untitled deal'}</h1>
        <p>
          <span className="pill" data-testid="review-state">
            {STATE_WORDS[data.state] ?? data.state}
          </span>{' '}
          <span className="hint">Reference {data.public_code}</span>
        </p>
        {data.checklist.customTerms ? (
          <div className="warning" data-testid="custom-terms-check">
            <p>
              <strong>Read the custom terms.</strong> Do they add to what an investor is liable for? The software cannot tell.
            </p>
            <RichView doc={data.draft.terms?.custom_terms} />
          </div>
        ) : null}
        <Changes changes={data.changes} />
        <DealRead d={withEffectiveMinimum(data.draft, data.effective_min_commitment_minor)} fee={data.platform_fee} />
        <h3>Files</h3>
        <FileLinks dealId={id} files={data.files} />
        <History events={data.events} />
      </section>
      <CompanyReview id={id} data={data} reload={reload} />
      <section className="card">
        <h2>Your decision</h2>
        <Problem error={error} />
        {data.state === 'in_review' ? (
          <>
            <label>
              Reason, shown to the lead (needed to ask for changes or to refuse)
              <textarea rows={3} maxLength={5000} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <label>
              Internal note, never shown to the lead
              <textarea rows={2} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="row">
              <button type="button" onClick={() => decide('approve')}>
                Approve
              </button>
              <button type="button" className="secondary" disabled={!reason.trim()} onClick={() => decide('request-changes')}>
                Ask for changes
              </button>
              {sureReject ? (
                <button type="button" className="danger" disabled={!reason.trim()} onClick={() => decide('reject')}>
                  Yes, refuse this deal for good
                </button>
              ) : (
                <button type="button" className="secondary" disabled={!reason.trim()} onClick={() => setSureReject(true)}>
                  Refuse
                </button>
              )}
            </div>
            {sureReject && <p className="hint">Refusing is final. The deal cannot come back.</p>}
          </>
        ) : (
          <p data-testid="no-decision">There is nothing to decide while the deal is in this state.</p>
        )}
      </section>
    </>
  )
}

export const OPERATOR_NOTICE = "This is the operator's internal record that the content was approved. It is not the statutory approval of a financial promotion."
export const NOT_AUTHORISED =
  'An appointed representative is not an authorised person. Record an appointed representative as what it is, not as an authorised firm. The name and number below are as you state them; nothing here checks them.'

export function ApprovalQueue() {
  const { data, error } = useData<{ deals: Array<{ id: string; public_code: string; name: string | null; approved_at: string }> }>('/api/approvals/deals')
  return (
    <section className="card">
      <h1>Content waiting for approval</h1>
      <p data-testid="approval-notice">{OPERATOR_NOTICE}</p>
      <Problem error={error} />
      {data && !data.deals.length && <p>Nothing is waiting.</p>}
      <ul className="list" data-testid="approval-queue">
        {data?.deals.map((d) => (
          <li key={d.id}>
            <span>
              <Link to={`/approvals/${d.id}`}>{d.name || 'Untitled deal'}</Link> <span className="hint">{d.public_code}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ContentApproval({ id }: { id: string }) {
  const { data, error: loadError } = useData<{ id: string; public_code: string; content: Draft; content_sha256: string; files: DealFile[] }>(
    `/api/approvals/deals/${id}`,
  )
  const [name, setName] = useState('')
  const [frn, setFrn] = useState('')
  const [done, setDone] = useState(false)
  const { error, run } = useRun()
  if (loadError && !data)
    return (
      <section className="card">
        <Problem error={loadError} />
        <Link to="/approvals">Back to the list</Link>
      </section>
    )
  if (!data) return <p>Loading…</p>
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/review/deals/${id}/content-approval`, 'POST', {
        content_sha256: data.content_sha256,
        self_declared_name: name,
        ...(frn.trim() ? { self_declared_frn: frn.trim() } : {}),
      })
      setDone(true)
    })
  }
  return (
    <>
      <section className="card">
        <p>
          <Link to="/approvals">Back to the list</Link>
        </p>
        <h1>{data.content.basics?.name || 'Untitled deal'}</h1>
        <p className="hint">Reference {data.public_code}. This is the version that passed review.</p>
        <DealRead d={data.content} fee={(data.content as { platform_fee?: FeeTerms }).platform_fee} />
        <h3>Files</h3>
        <FileLinks dealId={id} files={data.files} />
      </section>
      <section className="card">
        <h2>Approve this content</h2>
        <p className="warning" data-testid="approval-notice">
          {OPERATOR_NOTICE}
        </p>
        <p className="hint" data-testid="approval-ar-notice">
          {NOT_AUTHORISED}
        </p>
        <p className="mono" data-testid="approval-hash">
          {data.content_sha256}
        </p>
        <Problem error={error} />
        {done ? (
          <p role="status" data-testid="approval-done">
            Recorded. The lead can now confirm that the deal should go live.
          </p>
        ) : (
          <form onSubmit={submit}>
            <label>
              Your name, as you state it *
              <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              FRN, as you state it (optional, 6 or 7 digits)
              <input inputMode="numeric" pattern="\d{6,7}" value={frn} onChange={(e) => setFrn(e.target.value)} />
            </label>
            <button type="submit">Record the approval</button>
          </form>
        )}
      </section>
    </>
  )
}

interface DealConfig {
  required_company_fields: string[]
  min_commitment_floor_minor: string
  default_carry_bps: number
  embed_hosts: string[]
  review_target_days: number
  launch_confirm_days: number
  draft_restore_days: number
  investee_link_days: number
  investee_reminder_hours: number
  investee_valid_days: number
  content_approval_in_sandbox: boolean
}
const DAY_FIELDS = [
  ['review_target_days', 'Days a review usually takes (shown to leads)'],
  ['launch_confirm_days', 'Days a lead has to confirm going live'],
  ['draft_restore_days', 'Days a deleted draft can be restored'],
  ['investee_link_days', "Days the company's link works"],
  ['investee_reminder_hours', 'Hours between reminders to the company'],
  ['investee_valid_days', 'Days a company check stays valid'],
] as const

export function DealSettings() {
  const { data, reload } = useData<DealConfig>('/api/deal-config')
  const [form, setForm] = useState<Record<string, string> | null>(null)
  const [fields, setFields] = useState<string[]>([])
  const [approval, setApproval] = useState(false)
  const [saved, setSaved] = useState(false)
  const { error, run } = useRun()
  useEffect(() => {
    if (!data) return
    setForm({
      floor: draftAmountToTyped(data.min_commitment_floor_minor),
      carry: draftPercentToTyped(data.default_carry_bps),
      hosts: data.embed_hosts.join('\n'),
      ...Object.fromEntries(DAY_FIELDS.map(([k]) => [k, String(data[k])])),
    })
    setFields(data.required_company_fields)
    setApproval(data.content_approval_in_sandbox)
  }, [data])
  if (!form) return null
  const set = (k: string, v: string) => setForm({ ...form, [k]: v })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSaved(false)
    void run(async () => {
      const floor = typedAmountToDraft(form.floor ?? '')
      const carry = typedPercentToDraft(form.carry ?? '')
      if (!floor || !/^\d+$/.test(floor)) throw new Error('Give the lowest minimum commitment as an amount.')
      if (carry === null || carry < 0) throw new Error('Give the default carry as a percentage from 0 to 100.')
      const days = Object.fromEntries(
        DAY_FIELDS.map(([k, label]) => {
          const n = typedWhole(form[k] ?? '')
          if (n === null) throw new Error(`Give a whole number for: ${label}.`)
          return [k, n]
        }),
      )
      await api('/api/deal-config', 'PUT', {
        required_company_fields: fields,
        min_commitment_floor_minor: floor,
        default_carry_bps: carry,
        embed_hosts: form
          .hosts!.split(/\s+/)
          .filter(Boolean)
          .map((h) => h.toLowerCase()),
        content_approval_in_sandbox: approval,
        ...days,
      })
      setSaved(true)
      await reload()
    })
  }
  const toggle = (k: string, on: boolean) => setFields(on ? [...fields, k] : fields.filter((f) => f !== k))
  return (
    <section className="card">
      <h2>Deal settings</h2>
      <form onSubmit={submit} data-testid="deal-settings">
        <label className="check block">
          <input type="checkbox" checked={fields.includes('registration_number')} onChange={(e) => toggle('registration_number', e.target.checked)} /> Leads
          must give the company's registration number
        </label>
        <label className="check block">
          <input type="checkbox" checked={fields.includes('address')} onChange={(e) => toggle('address', e.target.checked)} /> Leads must give the company's
          address
        </label>
        <label>
          Lowest minimum commitment *
          <input inputMode="decimal" required value={form.floor} onChange={(e) => set('floor', e.target.value)} />
        </label>
        <label>
          Default carry (%) *
          <input inputMode="decimal" required value={form.carry} onChange={(e) => set('carry', e.target.value)} />
        </label>
        <label>
          Sites a pitch deck may be embedded from, one per line
          <textarea rows={3} value={form.hosts} onChange={(e) => set('hosts', e.target.value)} />
        </label>
        {DAY_FIELDS.map(([k, label]) => (
          <label key={k}>
            {label} *
            <input inputMode="numeric" required value={form[k]} onChange={(e) => set(k, e.target.value)} />
          </label>
        ))}
        <label className="check block">
          <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> Require content approval in the sandbox as well, to try
          it out
        </label>
        <Problem error={error} />
        {saved && <p role="status">Saved.</p>}
        <button type="submit" className="secondary">
          Save the deal settings
        </button>
      </form>
    </section>
  )
}
