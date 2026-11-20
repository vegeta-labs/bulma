// D3 operator screens: compliance holds, link terms waiting for a reviewer, recording money by hand, the switches and the
// deal sheet template (R-CMP-01, R-LNK-06, R-PAY-09, R-CMP-03, R-SIG-02).
import { useState, type FormEvent } from 'react'
import { money, percent } from '../lib/dealSheet.ts'
import { typedAmountToDraft } from '../lib/pounds.ts'
import { api } from './api.ts'
import { useData } from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'
import { MoveReceipt } from './Money.tsx'

interface Hold {
  id: string
  level: string
  target_id: string | null
  reason: string
  applied_at: string
  released_at: string | null
  applied_by: string
  released_by: string | null
}

export function HoldsSection({ dealId }: { dealId?: string }) {
  const { data, reload } = useData<{ holds: Hold[] }>('/api/holds')
  const [reason, setReason] = useState('')
  const [level, setLevel] = useState<'deal' | 'lead' | 'instance'>(dealId ? 'deal' : 'instance')
  const [target, setTarget] = useState(dealId ?? '')
  const { error, run } = useRun()
  const apply = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('/api/holds', 'POST', { level, target_id: level === 'instance' ? null : target, reason })
      setReason('')
      await reload()
    })
  }
  const open = data?.holds.filter((h) => !h.released_at && (!dealId || h.target_id === dealId || h.level === 'instance')) ?? []
  return (
    <section className="card" data-testid="holds">
      <h2>Pause</h2>
      <p className="hint">A pause takes effect at once and stops everything new. Someone else must end it. Investors and the lead never see the reason.</p>
      <ul className="list">
        {open.map((h) => (
          <li key={h.id}>
            <span>
              <strong>{h.level}</strong> since {h.applied_at.slice(0, 16).replace('T', ' ')} by {h.applied_by}: {h.reason}
            </span>
            <button
              type="button"
              className="secondary small"
              onClick={() => void run(async () => (await api(`/api/holds/${h.id}/release`, 'POST', {}), await reload()))}
            >
              End the pause
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={apply}>
        <div className="row">
          {!dealId && (
            <label>
              Level
              <select value={level} onChange={(e) => setLevel(e.target.value as 'deal')}>
                <option value="deal">One deal</option>
                <option value="lead">All deals of one lead</option>
                <option value="instance">Everything</option>
              </select>
            </label>
          )}
          {!dealId && level !== 'instance' && (
            <label>
              {level === 'deal' ? 'Deal id' : 'Lead account id'}
              <input required value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
          )}
        </div>
        <label>
          Reason (kept for the operator only)
          <textarea required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="submit" className="danger">
          Pause now
        </button>
      </form>
      <Problem error={error} />
    </section>
  )
}

export function LinkApprovals() {
  const { data, reload } = useData<{
    links: Array<{
      id: string
      public_code: string
      currency: string
      label: string
      carry_bps: number
      fee_kind: string
      fee_bps: number | null
      fee_minor: string | null
      fee_mode: string | null
      reason: string | null
      incentive_attested: boolean
    }>
  }>('/api/review/links')
  const { error, run } = useRun()
  if (!data?.links.length) return null
  return (
    <section className="card" data-testid="link-approvals">
      <h2>Link terms waiting for you</h2>
      <ul className="list">
        {data.links.map((l) => (
          <li key={l.id}>
            <span>
              {l.public_code} · {l.label || 'Terms'}: carry {percent(l.carry_bps)}, fee{' '}
              {l.fee_kind === 'none' ? 'none' : l.fee_kind === 'percent' ? percent(l.fee_bps!) : money(BigInt(l.fee_minor!), l.currency)}
              {l.fee_mode ? ` (${l.fee_mode === 'on_top' ? 'on top' : 'from the payment'})` : ''}. Reason: {l.reason}.{' '}
              {l.incentive_attested ? 'The lead confirmed it is not an incentive.' : ''}
            </span>
            <button
              type="button"
              className="small"
              onClick={() => void run(async () => (await api(`/api/review/links/${l.id}/approve`, 'POST', {}), await reload()))}
            >
              Approve
            </button>
          </li>
        ))}
      </ul>
      <Problem error={error} />
    </section>
  )
}

interface StaffParticipation {
  status: string | null
  identity_review: string
  deed_status: 'sent' | 'signed' | null
  id: string
  reference: string
  name: string
  email: string
  cash_due_minor: string
  held_minor: string
  status_label: string | null
  receipts: Array<{ id: string; amount_minor: string; received_on: string; payer_name: string; payer_mismatch: boolean; reversed_at: string | null }>
}

function ReceiptForm({ p, c, onDone }: { p: StaffParticipation; c: string; onDone: () => void }) {
  const [f, setF] = useState({ amount: '', date: new Date().toISOString().slice(0, 10), payer: '', account: '' })
  const { error, run } = useRun()
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/review/participations/${p.id}/receipts`, 'POST', {
        amount_minor: typedAmountToDraft(f.amount),
        received_on: f.date,
        payer_name: f.payer,
        payer_account: f.account,
      })
      setF({ ...f, amount: '' })
      onDone()
    })
  }
  return (
    <form onSubmit={save}>
      <div className="row">
        <label>
          Amount ({c})
          <input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label>
          Received on
          <input required type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label>
          Payer name (or "unknown")
          <input required value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })} />
        </label>
        <label>
          Payer account (or "unknown")
          <input required value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} />
        </label>
      </div>
      <button type="submit" className="secondary small">
        Record money received
      </button>
      <Problem error={error} />
    </form>
  )
}

export function ReceiptsSection({ dealId }: { dealId: string }) {
  const { data, reload } = useData<{ deal_code: string; currency: string; participations: StaffParticipation[] }>(`/api/review/deals/${dealId}/participations`)
  const [reason, setReason] = useState('')
  const { error, run } = useRun()
  if (!data) return null
  const c = data.currency
  return (
    <section className="card" data-testid="receipts">
      <h2>Money received</h2>
      <p className="hint">Each payment is one record. Leads cannot record money. A reversal keeps the record and moves the status back.</p>
      <ul className="list">
        {data.participations.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{p.name}</strong> <span className="mono">{p.reference}</span> <span className="pill">{p.status_label}</span>
              <p className="hint">
                Due {money(BigInt(p.cash_due_minor), c)} · held {money(BigInt(p.held_minor), c)}
              </p>
              <ul>
                {p.receipts.map((r) => (
                  <li key={r.id}>
                    {money(BigInt(r.amount_minor), c)} on {r.received_on.slice(0, 10)} from {r.payer_name}
                    {r.payer_mismatch && <span className="pill">payer to check</span>}
                    {r.reversed_at ? (
                      <span className="pill">reversed</span>
                    ) : (
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => void run(async () => (await api(`/api/review/receipts/${r.id}/reverse`, 'POST', { reason }), await reload()))}
                      >
                        Reverse
                      </button>
                    )}
                    {!r.reversed_at && (
                      <MoveReceipt
                        receiptId={r.id}
                        currency={c}
                        people={data.participations.filter((x) => x.id !== p.id).map((x) => ({ id: x.id, name: x.name, reference: x.reference }))}
                        onDone={() => void reload()}
                      />
                    )}
                  </li>
                ))}
              </ul>
              {p.identity_review === 'pending' && (
                <div className="warning" data-testid="identity-review">
                  <p>The investor changed their details after signing or paying. Decide what the change is.</p>
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() =>
                      void run(
                        async () => (
                          await api(`/api/review/participations/${p.id}/identity`, 'POST', { decision: 'same_entity', reason: reason || 'Same legal entity' }),
                          await reload()
                        ),
                      )
                    }
                  >
                    Same entity: sign again
                  </button>{' '}
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() =>
                      void run(
                        async () => (
                          await api(`/api/review/participations/${p.id}/identity`, 'POST', { decision: 'other_entity', reason: reason || 'Another entity' }),
                          await reload()
                        ),
                      )
                    }
                  >
                    Another entity: end this commitment
                  </button>
                </div>
              )}
              {p.status === 'to_sign' && (
                <span className="row">
                  {p.deed_status === 'sent' && (
                    <>
                      <span className="pill">Deed sent, not yet signed</span>
                      <a href={`/api/review/participations/${p.id}/deed`} download="deed.pdf">
                        Download the deed sent
                      </a>
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => void run(async () => (await api(`/api/review/participations/${p.id}/deed-signed`, 'POST', {}), await reload()))}
                      >
                        Record this deed as signed
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => void run(async () => (await api(`/api/review/participations/${p.id}/deed-sent`, 'POST', {}), await reload()))}
                  >
                    {p.deed_status === 'sent' ? 'Make a new deed (the one sent is replaced)' : 'Make the deed to sign outside this site'}
                  </button>
                </span>
              )}
              {p.deed_status === 'signed' && (
                <a href={`/api/review/participations/${p.id}/deed`} download="deed.pdf">
                  Download the signed deed
                </a>
              )}
              <ReceiptForm p={p} c={c} onDone={() => void reload()} />
            </div>
          </li>
        ))}
      </ul>
      <label>
        Reason for a reversal or an identity decision
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <Problem error={error} />
    </section>
  )
}

interface Policy {
  version: number
  per_link_terms: boolean
  generic_links: boolean
  bulk_promo: boolean
  export_roles: string[]
  reminder_count: number
  reminder_every_days: number
  complaints_email: string | null
  cancel_fee_note: string | null
  amount_proposal_days: number
  reconfirm_days: number
}

export function PolicySection() {
  const { data, reload } = useData<Policy>('/api/admin/policy')
  const [f, setF] = useState<Policy | null>(null)
  const [note, setNote] = useState('')
  const { error, run } = useRun()
  const v = f ?? data
  if (!v) return null
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api<{ requestId?: string }>('/api/admin/policy', 'PUT', {
        per_link_terms: v.per_link_terms,
        generic_links: v.generic_links,
        bulk_promo: v.bulk_promo,
        export_roles: v.export_roles,
        reminder_count: v.reminder_count,
        reminder_every_days: v.reminder_every_days,
        complaints_email: v.complaints_email?.trim() ? v.complaints_email.trim() : null,
        cancel_fee_note: v.cancel_fee_note?.trim() ? v.cancel_fee_note.trim() : null,
        amount_proposal_days: v.amount_proposal_days,
        reconfirm_days: v.reconfirm_days,
      })
      setNote(r.requestId ? 'Loosening a switch waits for a second admin. The request is in the list above.' : 'Saved.')
      setF(null)
      await reload()
    })
  }
  const box = (k: 'per_link_terms' | 'generic_links' | 'bulk_promo', label: string) => (
    <label className="check block">
      <input type="checkbox" checked={v[k]} onChange={(e) => setF({ ...v, [k]: e.target.checked })} /> {label}
    </label>
  )
  return (
    <form className="card" onSubmit={save} data-testid="policy">
      <h2>Switches</h2>
      <p className="hint">Tightening takes effect at once. Loosening needs a second admin.</p>
      {box('per_link_terms', 'Links may have their own carry and fee')}
      {box('generic_links', 'Links anyone with them can open (off: invitations to a named address only)')}
      {box('bulk_promo', 'Promotional messages to many investors at once')}
      <fieldset>
        <legend>Who may export investor lists</legend>
        {(['admin', 'reviewer', 'lead'] as const).map((r) => (
          <label key={r} className="check block">
            <input
              type="checkbox"
              checked={v.export_roles.includes(r)}
              onChange={(e) => setF({ ...v, export_roles: e.target.checked ? [...v.export_roles, r] : v.export_roles.filter((x) => x !== r) })}
            />{' '}
            {r === 'admin' ? 'Admins' : r === 'reviewer' ? 'Reviewers' : 'Leads, for their own deals'}
          </label>
        ))}
      </fieldset>
      <label>
        Reminders
        <input type="number" min={0} max={10} value={v.reminder_count} onChange={(e) => setF({ ...v, reminder_count: Number(e.target.value) })} />
      </label>
      <label>
        Days between payment reminders (0 for none)
        <input type="number" min={0} max={30} value={v.reminder_every_days} onChange={(e) => setF({ ...v, reminder_every_days: Number(e.target.value) })} />
      </label>
      <label>
        Address for complaints (shown with the complaint form; R-AUD-05)
        <input type="email" maxLength={320} value={v.complaints_email ?? ''} onChange={(e) => setF({ ...v, complaints_email: e.target.value })} />
      </label>
      <label>
        Working days to answer a proposed new amount
        <input
          type="number"
          min={1}
          max={30}
          value={v.amount_proposal_days}
          onChange={(e) => setF({ ...v, amount_proposal_days: Number(e.target.value) })}
        />
      </label>
      <label>
        Working days to reconfirm changed terms
        <input type="number" min={1} max={30} value={v.reconfirm_days} onChange={(e) => setF({ ...v, reconfirm_days: Number(e.target.value) })} />
      </label>
      <label>
        Note on fees when a deal is cancelled (shown to the lead before asking, and in the mail when it is cancelled)
        <textarea maxLength={2000} value={v.cancel_fee_note ?? ''} onChange={(e) => setF({ ...v, cancel_fee_note: e.target.value })} />
      </label>
      <button type="submit" className="secondary">
        Save
      </button>
      {note && <p className="hint" role="status">{note}</p>}
      <Problem error={error} />
    </form>
  )
}

export function TemplateSection() {
  const { data, reload } = useData<{ template: { version: number; body: string; needs_deed: boolean; is_placeholder: boolean } | null; slots: string[] }>(
    '/api/admin/templates/deal-sheet',
  )
  const [body, setBody] = useState<string | null>(null)
  const [deed, setDeed] = useState<boolean | null>(null)
  const { error, run } = useRun()
  if (!data) return null
  const text = body ?? data.template?.body ?? ''
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('/api/admin/templates/deal-sheet', 'PUT', { body: text, needs_deed: deed ?? data.template?.needs_deed ?? false })
      setBody(null)
      await reload()
    })
  }
  return (
    <form className="card" onSubmit={save} data-testid="template">
      <h2>Deal sheet</h2>
      {data.template?.is_placeholder && <p className="warning">This is placeholder text. The real mode does not let anyone sign it.</p>}
      <p className="hint">Slots: {data.slots.map((s) => `{${s}}`).join(' ')}</p>
      <label>
        Text (version {data.template?.version ?? 0})
        <textarea rows={10} aria-label="Deal sheet text" value={text} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="check block">
        <input type="checkbox" checked={deed ?? data.template?.needs_deed ?? false} onChange={(e) => setDeed(e.target.checked)} /> Must be signed as a deed or
        witnessed, outside this site
      </label>
      <button type="submit" className="secondary">
        Save as a new version
      </button>
      <Problem error={error} />
    </form>
  )
}

/** R-PAY-09: where reviewers and admins find the deals they record money for. */
export function MoneyDeals() {
  const { data } = useData<{ deals: Array<{ id: string; public_code: string; name: string | null }> }>('/api/review/live-deals')
  if (!data?.deals.length) return null
  return (
    <section className="card" data-testid="money-deals">
      <h2>Live deals</h2>
      <ul className="list">
        {data.deals.map((d) => (
          <li key={d.id}>
            <a href={`/money/${d.id}`}>{d.name ?? d.public_code}</a>
            <span className="hint">{d.public_code}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** R-CMP-02: an approver approves the deal sheet wording before investors get it. */
export function TemplateApprovals() {
  const { data, reload } = useData<{
    templates: Array<{ id: string; version: number; body: string; sha256: string; approved: boolean; is_placeholder: boolean }>
  }>('/api/approvals/templates')
  const [name, setName] = useState('')
  const [frn, setFrn] = useState('')
  const { error, run } = useRun()
  const waiting = data?.templates.find((t) => !t.approved && !t.is_placeholder)
  if (!waiting) return null
  return (
    <section className="card" data-testid="template-approval">
      <h2>Deal sheet wording, version {waiting.version}</h2>
      <p className="legal mono">{waiting.body}</p>
      <div className="row">
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          FRN (if any)
          <input value={frn} onChange={(e) => setFrn(e.target.value)} />
        </label>
      </div>
      <button
        type="button"
        onClick={() =>
          void run(async () => {
            await api(`/api/approvals/templates/${waiting.id}`, 'POST', {
              content_sha256: waiting.sha256,
              self_declared_name: name,
              self_declared_frn: frn || null,
            })
            await reload()
          })
        }
      >
        Approve this wording
      </button>
      <Problem error={error} />
    </section>
  )
}

/** R-OP-05: new receiving-account details are read from the mounted file and wait for a second admin (real mode). */
export function ReceivingAccountSection() {
  const [done, setDone] = useState<string | null>(null)
  const { error, run } = useRun()
  return (
    <section className="card" data-testid="receiving-account">
      <h2>Receiving accounts</h2>
      <p className="hint">
        In the real mode the details come from the payment details file mounted with the deployment, never from a form. After changing the file, ask for the
        change here; a second admin sees the new and current details before approving. Every payment instruction on a changed account then stops being valid.
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() => void run(async () => setDone((await api<{ request_id: string }>('/api/admin/receiving-accounts/reload', 'POST', {})).request_id))}
      >
        Ask to use the details in the file
      </button>
      {done && <p className="hint" role="status">Asked. It is in the list of requests waiting for a second admin.</p>}
      <Problem error={error} />
    </section>
  )
}
