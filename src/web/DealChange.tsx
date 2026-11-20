// R-CHG-01, R-CHG-02, R-CHG-03, R-CMP-02, §5.3: changes to a deal after launch on screen. The lead's own list of changes,
// the reviewer's decision (notice or reconfirm, with a reason) or return, the approver's approval of what passed review,
// and what an investor is shown changed.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChangeItem } from '../lib/change.ts'
import type { FieldChange } from '../lib/snapshot.ts'
import { api } from './api.ts'
import { DealRead, Link, useData } from './DealShared.tsx'
import { useRefresh } from './Invest.tsx'
import { Problem, useRun } from './Investor.tsx'
import { NOT_AUTHORISED, OPERATOR_NOTICE } from './Review.tsx'
import type { Draft } from '../lib/draft.ts'
import { draftAmountToTyped, draftPercentToTyped } from '../lib/pounds.ts'
import { money } from '../lib/dealSheet.ts'

/** The field as people read it: no path punctuation, no unit suffix. */
const fieldWords = (f: string) =>
  f
    .replace(/^key_terms\./, '')
    .replace(/_(minor|bps)$/, '')
    .replace(/[._]/g, ' ')
/** A stored amount in minor units or a rate in basis points, as typed on the deal form (as on the payment page, with the
 *  currency, when one is given); anything else as it comes. */
function valueWords(field: string, v: string | null, currency?: string): string {
  if (v === null) return '—'
  if (field.endsWith('_minor') && /^\d+$/.test(v)) return currency ? money(BigInt(v), currency) : draftAmountToTyped(v)
  if (field.endsWith('_bps') && /^\d+$/.test(v)) return `${draftPercentToTyped(Number(v))}%`
  return v
}

export function Differences({
  rows,
  testid = 'differences',
  empty = 'No difference that people can see.',
  currency,
}: {
  rows: FieldChange[]
  testid?: string
  empty?: string
  /** Investors read amounts as on their payment page; reviewers as typed on the deal form. */
  currency?: string
}) {
  if (!rows.length) return <p className="hint">{empty}</p>
  return (
    <table className="diff" data-testid={testid}>
      <thead>
        <tr>
          <th>What</th>
          <th>Before</th>
          <th>Now</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => (
          <tr key={x.field}>
            <td>{fieldWords(x.field)}</td>
            <td>{valueWords(x.field, x.before, currency)}</td>
            <td>{valueWords(x.field, x.after, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const CHANGE_STATE: Record<string, string> = {
  submitted: 'Waiting for a reviewer',
  reviewed: 'Reviewed, waiting for approval',
  applied: 'In force',
  returned: 'Returned to you',
  withdrawn: 'Taken back',
}
const VERDICT: Record<string, string> = { notice: 'People are told', reconfirm: 'People must reconfirm' }

// ---------- the lead ----------

interface LeadChange {
  id: string
  state: string
  summary: string
  self_service: boolean
  changes: FieldChange[]
  verdict: 'notice' | 'reconfirm' | null
  verdict_reason: string | null
  return_reason: string | null
  version: number | null
  created_at: string
}

/** The lead's changes to a deal after launch: each one's state, what it changes, and taking back one still open. */
export function LeadChanges({ dealId, version }: { dealId: string; version: number }) {
  const { data, reload } = useData<{ changes: LeadChange[] }>(`/api/deals/${dealId}/changes`)
  const { error, run } = useRun()
  // a change sent from the editor above: read the list again (not on the first render, which already reads it)
  const seen = useRef(version)
  useEffect(() => {
    if (seen.current !== version) {
      seen.current = version
      void reload()
    }
  }, [version, reload])
  if (!data?.changes.length) return null
  return (
    <section className="card" data-testid="lead-changes">
      <h2>Changes after launch</h2>
      <ul className="list stacked">
        {data.changes.map((c) => (
          <li key={c.id} data-testid="lead-change">
            <p>
              <span className="pill">{CHANGE_STATE[c.state] ?? c.state}</span> {c.summary}
              {c.version !== null && <span className="hint"> · version {c.version}</span>}
              {c.self_service && <span className="hint"> · in force at once, no review needed</span>}
            </p>
            <Differences rows={c.changes} />
            {c.verdict && (
              <p className="hint">
                {VERDICT[c.verdict]}. Reason: {c.verdict_reason}
              </p>
            )}
            {c.return_reason && <p className="warning">Reason: {c.return_reason}</p>}
            {(c.state === 'submitted' || c.state === 'reviewed') && (
              <button
                type="button"
                className="secondary"
                onClick={() => void run(async () => (await api(`/api/deals/${dealId}/changes/${c.id}/withdraw`, 'POST'), await reload()))}
              >
                Take back this change
              </button>
            )}
          </li>
        ))}
      </ul>
      <Problem error={error} />
    </section>
  )
}

// ---------- review and approval ----------

interface ChangeDetails {
  id: string
  deal_id: string
  public_code: string
  deal_state: string
  state: string
  summary: string
  person?: { commitments: number }
  items: ChangeItem[]
  needs_judgement: boolean
  below_new_minimum: number
  resign: boolean
  differences: FieldChange[]
  proposed_sha256: string
  verdict: 'notice' | 'reconfirm' | null
  verdict_reason: string | null
  out_of_date: boolean
  created_at: string
}

const KIND: Record<ChangeItem['kind'], string> = {
  reconfirm: 'People must reconfirm',
  content: 'Your judgement: tell people, or ask them to reconfirm',
  self_service: "The lead's own choice: told, nothing asked",
}

/** What the reviewer and the approver both read: the lead's sentence, each item and its kind, and the differences. */
function ChangeFacts({ c }: { c: ChangeDetails }) {
  return (
    <>
      <p>
        In the lead&apos;s words: <strong>{c.summary}</strong>
      </p>
      {c.person && <p className="hint">One investor&apos;s terms: {c.person.commitments} commitment(s) under them reconfirm and sign again.</p>}
      {c.out_of_date && <p className="warning">The deal has changed since this was asked. It can only be returned.</p>}
      <ul data-testid="change-items">
        {c.items.map((i) => (
          <li key={i.field}>
            {fieldWords(i.field)}: {KIND[i.kind]}
          </li>
        ))}
      </ul>
      {c.below_new_minimum > 0 && <p className="hint">{c.below_new_minimum} person(s) below the new minimum reconfirm whatever you decide.</p>}
      {c.resign && <p className="hint">The deal sheet changes: people who signed sign again.</p>}
      <Differences rows={c.differences} />
    </>
  )
}

function ChangeReview({ cid, onDone }: { cid: string; onDone: () => void }) {
  const { data } = useData<ChangeDetails>(`/api/review/changes/${cid}`)
  const [verdict, setVerdict] = useState<'notice' | 'reconfirm' | ''>('')
  const [reason, setReason] = useState('')
  const [back, setBack] = useState('')
  const { error, run } = useRun()
  if (!data) return null
  const decide = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/review/changes/${cid}/decide`, 'POST', {
        proposed_sha256: data.proposed_sha256,
        ...(data.needs_judgement ? { verdict: verdict || undefined, reason: reason.trim() || undefined } : {}),
      })
      onDone()
    })
  }
  const giveBack = () =>
    void run(async () => {
      await api(`/api/review/changes/${cid}/return`, 'POST', { reason: back.trim() })
      onDone()
    })
  return (
    <li data-testid="change-review">
      <ChangeFacts c={data} />
      {data.state === 'submitted' && !data.out_of_date && (
        <form onSubmit={decide}>
          {data.needs_judgement && (
            <fieldset>
              <legend>What should happen to people who committed?</legend>
              <label className="check block">
                <input type="radio" name={`v-${cid}`} checked={verdict === 'notice'} onChange={() => setVerdict('notice')} /> Tell them; nothing is asked
              </label>
              <label className="check block">
                <input type="radio" name={`v-${cid}`} checked={verdict === 'reconfirm'} onChange={() => setVerdict('reconfirm')} /> They must reconfirm
              </label>
              <label>
                Reason (kept with the change)
                <textarea maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            </fieldset>
          )}
          <button type="submit">{data.needs_judgement ? 'Record the decision' : 'Pass the review'}</button>
        </form>
      )}
      {data.state === 'reviewed' && <p className="hint">Reviewed. Waiting for an approver.</p>}
      <details>
        <summary>Return it to the lead</summary>
        <label>
          Reason (the lead reads it)
          <textarea maxLength={2000} value={back} onChange={(e) => setBack(e.target.value)} />
        </label>
        <button type="button" className="secondary" onClick={giveBack}>
          Return the change
        </button>
      </details>
      <Problem error={error} />
    </li>
  )
}

/** Changes to this deal waiting for a reviewer, on the deal's staff page. */
export function ChangeReviews({ dealId, onChange }: { dealId: string; onChange: () => void }) {
  const { data, reload } = useData<{ changes: Array<{ id: string; deal_id: string; state: string }> }>('/api/review/changes')
  const mine = data?.changes.filter((c) => c.deal_id === dealId) ?? []
  if (!mine.length) return null
  return (
    <div data-testid="change-reviews">
      <h3>Changes to review</h3>
      <ul className="list stacked">
        {mine.map((c) => (
          <ChangeReview
            key={`${c.id}:${c.state}`}
            cid={c.id}
            onDone={() => {
              void reload()
              onChange()
            }}
          />
        ))}
      </ul>
    </div>
  )
}

export function ChangeApprovalQueue() {
  const { data } = useData<{ changes: Array<{ id: string; public_code: string; summary: string }> }>('/api/approvals/changes')
  if (!data?.changes.length) return null
  return (
    <section className="card" data-testid="change-approval-queue">
      <h2>Changes to live deals waiting for approval</h2>
      <ul className="list">
        {data.changes.map((c) => (
          <li key={c.id}>
            <span>
              <Link to={`/approvals/changes/${c.id}`}>{c.summary}</Link> <span className="hint">{c.public_code}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ChangeApproval({ cid }: { cid: string }) {
  const { data, error: loadError } = useData<ChangeDetails & { content: Draft }>(`/api/approvals/changes/${cid}`)
  const [name, setName] = useState('')
  const [frn, setFrn] = useState('')
  const [done, setDone] = useState<number | null>(null)
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
      const r = await api<{ version: number }>(`/api/approvals/changes/${cid}`, 'POST', {
        content_sha256: data.proposed_sha256,
        self_declared_name: name,
        ...(frn.trim() ? { self_declared_frn: frn.trim() } : {}),
      })
      setDone(r.version)
    })
  }
  return (
    <>
      <section className="card" data-testid="change-approval">
        <p>
          <Link to="/approvals">Back to the list</Link>
        </p>
        <h1>Change to deal {data.public_code}</h1>
        <ChangeFacts c={data} />
        {data.verdict && (
          <p>
            Reviewer: {VERDICT[data.verdict]}. Reason: {data.verdict_reason}
          </p>
        )}
        <h2>The deal with this change</h2>
        <DealRead d={data.content} />
      </section>
      <section className="card">
        <h2>Approve this change</h2>
        <p className="warning">{OPERATOR_NOTICE}</p>
        <p className="hint">{NOT_AUTHORISED}</p>
        <p className="mono">{data.proposed_sha256}</p>
        <Problem error={error} />
        {done !== null ? (
          <p role="status" data-testid="change-approved">
            Recorded. The change is in force as version {done}.
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
            <button type="submit">Approve the change</button>
          </form>
        )}
      </section>
    </>
  )
}

// ---------- the investor ----------

interface Update {
  version: number
  summary: string
  applied_at: string
  kind: 'reconfirm' | 'lead_choice' | 'notice'
  differences: FieldChange[]
}
const UPDATE_KIND: Record<Update['kind'], string> = {
  reconfirm: 'You were asked to reconfirm',
  lead_choice: "The lead's own choice: nothing for you to do",
  notice: 'For your information: nothing for you to do',
}

/** R-CHG-03: every change since the person committed, the lead's sentence and what they can see changed. */
export function DealUpdates({ dealId, currency }: { dealId: string; currency: string }) {
  const { data, reload } = useData<{ updates: Update[] }>(`/api/my/deals/${dealId}/updates`)
  useRefresh(reload)
  if (!data?.updates.length) return null
  return (
    <section className="card" data-testid="deal-updates">
      <h2>What changed since you committed</h2>
      <ul className="list stacked">
        {[...data.updates].reverse().map((u) => (
          <li key={u.version} data-testid="deal-update">
            <p>
              <span className="pill">{UPDATE_KIND[u.kind]}</span> In the lead&apos;s words: {u.summary}{' '}
              <span className="hint">({new Date(u.applied_at).toISOString().slice(0, 10)})</span>
            </p>
            <Differences rows={u.differences} currency={currency} />
          </li>
        ))}
      </ul>
    </section>
  )
}
