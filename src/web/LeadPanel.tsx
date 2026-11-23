// D4 lead panel on screen (chunk 8e): the figures, the investor list with status, who it waits on and days at the step, its
// filters, and each row's actions with the words the action itself refuses with (R-ADM-02, R-ADM-05, R-ADM-06, R-ADM-11).
// Nothing here judges: every rule is the server's, and a refusal is shown as the server words it.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { money } from '../lib/dealSheet.ts'
import { STATUS_LABEL, type Status } from '../lib/participation.ts'
import { percentToBps, typedAmountToDraft } from '../lib/pounds.ts'
import { api } from './api.ts'
import { useData } from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'

type Waiter = 'investor' | 'reviewer' | 'lead'
type Action = 'email' | 'view_documents' | 'remove' | 'withdrawal' | 'replace_link' | 'amount_proposal' | 'change_terms'
interface ActionView {
  action: Action
  allowed: boolean
  why: string | null
  confirm?: 'money_checked'
}
export interface PanelRow {
  status: Status | 'with_operator'
  label: string
  waiting: Waiter | null
  noResponse: boolean
  invitation_id: string
  participation_id: string | null
  name: string
  entity: string | null
  /** Left out of the operator's copy, which has no actions. */
  own?: boolean
  days: number | null
  commitment_minor: string | null
  received_minor: string
  lead_fee_minor: string
  carry_bps: number
  actions?: ActionView[]
}
interface PanelData {
  currency: string
  metrics: Record<
    'committed_minor' | 'received_minor' | 'refund_due_minor' | 'refunded_minor' | 'operator_handling_minor' | 'lead_fees_minor' | 'usable_gross_minor',
    string
  >
  with_operator_label: string
  counts: { status: Partial<Record<string, number>>; waiting: Partial<Record<string, number>> }
  rows: PanelRow[]
}
interface LinkChoice {
  id: string
  label: string
  carry: string
  fee: string
  usable: boolean
}

export const WAITING_WORDS: Record<Waiter | 'none', string> = { investor: 'The investor', reviewer: 'A reviewer', lead: 'The lead', none: 'Nobody' }
const ACTION_WORDS: Record<Action, string> = {
  email: 'Email',
  view_documents: 'Signed documents',
  remove: 'Remove',
  withdrawal: 'Record a withdrawal',
  replace_link: 'Change their link',
  amount_proposal: 'Propose a new amount',
  change_terms: 'Change their terms',
}
const FIGURES: Array<[keyof PanelData['metrics'], string]> = [
  ['committed_minor', 'Committed'],
  ['received_minor', 'Received'],
  ['refund_due_minor', 'Refund due'],
  ['refunded_minor', 'Refunded'],
  ['operator_handling_minor', 'With the operator'],
  ['lead_fees_minor', 'Lead fees'],
  ['usable_gross_minor', 'Usable for the deal'],
]

/** Carry from basis points, by whole-number maths: 2050 → "20.50%". */
const carry = (bps: number) => `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`

/** The words under a refused action, and whether the button can be pressed. */
function ActionButton({ v, open, onOpen }: { v: ActionView; open: boolean; onOpen: () => void }) {
  return (
    <div className="action" data-testid={`action-${v.action}`}>
      <button type="button" className="secondary small" disabled={!v.allowed} aria-expanded={open} onClick={onOpen}>
        {ACTION_WORDS[v.action]}
      </button>
      {!v.allowed && v.why && <p className="hint">{v.why}</p>}
    </div>
  )
}

function Documents({ dealId, pid }: { dealId: string; pid: string }) {
  const { data, error } = useData<{
    signed: Array<{ document: string; document_sha256: string; terms_version: number; signed_at: string; replaced: boolean; awaiting_deed: boolean }>
  }>(`/api/deals/${dealId}/participations/${pid}/documents`)
  if (error) return <Problem error={error} />
  if (!data) return <p className="hint">Loading…</p>
  if (!data.signed.length) return <p className="hint">Nothing signed yet.</p>
  return (
    <ul className="list" data-testid="signed-documents">
      {data.signed.map((s) => (
        <li key={s.document_sha256 + s.signed_at}>
          <div>
            <strong>Terms version {s.terms_version}</strong> <span className="hint">signed {s.signed_at.slice(0, 10)}</span>
            {s.replaced && <span className="pill">replaced</span>}
            {s.awaiting_deed && <span className="pill">deed not yet signed back</span>}
            <p className="legal mono">{s.document}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

function Remove({ dealId, pid, confirm, onDone }: { dealId: string; pid: string; confirm: boolean; onDone: () => void }) {
  const [checked, setChecked] = useState(false)
  const [reason, setReason] = useState('')
  const { error, run } = useRun()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/deals/${dealId}/participations/${pid}/remove`, 'POST', { money_checked: checked, ...(reason.trim() ? { reason } : {}) })
      onDone()
    })
  }
  return (
    <form onSubmit={submit}>
      <label>
        Why (kept in the record, not sent to them)
        <textarea maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {confirm && (
        <label className="check block">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> They said they have paid. I have checked with the operator
          where the money is.
        </label>
      )}
      <button type="submit" className="danger">
        Remove from this deal
      </button>
      <Problem error={error} />
    </form>
  )
}

function Withdrawal({ dealId, pid, onDone }: { dealId: string; pid: string; onDone: () => void }) {
  const [consent, setConsent] = useState(false)
  const [evidence, setEvidence] = useState('')
  const { error, run } = useRun()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/deals/${dealId}/participations/${pid}/withdrawal`, 'POST', { consent_confirmed: consent, evidence })
      onDone()
    })
  }
  return (
    <form onSubmit={submit}>
      <label>
        Their written consent, as they gave it (a reviewer checks it)
        <textarea required maxLength={5000} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </label>
      <label className="check block">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> They asked in writing to withdraw
      </label>
      <button type="submit" className="secondary">
        Send to a reviewer
      </button>
      <Problem error={error} />
    </form>
  )
}

function ReplaceLink({ dealId, invitation, links, onDone }: { dealId: string; invitation: string; links: LinkChoice[]; onDone: () => void }) {
  const usable = links.filter((l) => l.usable)
  const [link, setLink] = useState(usable[0]?.id ?? '')
  const { error, run } = useRun()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/deals/${dealId}/invitations/${invitation}/link`, 'POST', { link_id: link })
      onDone()
    })
  }
  return (
    <form onSubmit={submit}>
      <label>
        New terms
        <select required value={link} onChange={(e) => setLink(e.target.value)}>
          {usable.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label || 'Terms'}: carry {l.carry}, {l.fee}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="secondary" disabled={!link}>
        Use these terms
      </button>
      <Problem error={error} />
    </form>
  )
}

function AmountProposal({ dealId, pid, onDone }: { dealId: string; pid: string; onDone: () => void }) {
  const [amount, setAmount] = useState('')
  const { error, run } = useRun()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/deals/${dealId}/participations/${pid}/amount-proposal`, 'POST', { commitment_minor: typedAmountToDraft(amount) ?? '' })
      onDone()
    })
  }
  return (
    <form onSubmit={submit}>
      <label>
        New amount
        <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <p className="hint">They are asked to accept or decline it. Nothing changes until they accept.</p>
      <button type="submit" className="secondary">
        Send the proposal
      </button>
      <Problem error={error} />
    </form>
  )
}

function PersonTerms({ dealId, pid, onDone }: { dealId: string; pid: string; onDone: () => void }) {
  const { data } = useData<{ version: number }>(`/api/deals/${dealId}/content`)
  const [f, setF] = useState({ carry: '', feeKind: 'none', fee: '', mode: 'on_top', summary: '', attested: false })
  const { error, run } = useRun()
  const fee = () =>
    f.feeKind === 'percent'
      ? { kind: 'percent', bps: percentToBps(f.fee) ?? -1, mode: f.mode }
      : f.feeKind === 'fixed'
        ? { kind: 'fixed', minor: typedAmountToDraft(f.fee) ?? '', mode: f.mode }
        : { kind: 'none' }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!data) return
    void run(async () => {
      await api(`/api/deals/${dealId}/participations/${pid}/terms`, 'POST', {
        carry_bps: percentToBps(f.carry) ?? -1,
        fee: fee(),
        summary: f.summary,
        base_version: data.version,
        incentive_attested: f.attested,
      })
      onDone()
    })
  }
  return (
    <form onSubmit={submit}>
      <p className="hint">A reviewer decides. If it is approved, they are asked to reconfirm. While it waits, no other change to this deal can be sent.</p>
      <div className="row">
        <label>
          Carry %
          <input required inputMode="decimal" value={f.carry} onChange={(e) => setF({ ...f, carry: e.target.value })} />
        </label>
        <label>
          Cash fee
          <select value={f.feeKind} onChange={(e) => setF({ ...f, feeKind: e.target.value })}>
            <option value="none">None</option>
            <option value="percent">Percentage</option>
            <option value="fixed">Fixed amount</option>
          </select>
        </label>
        {f.feeKind !== 'none' && (
          <>
            <label>
              {f.feeKind === 'percent' ? 'Fee %' : 'Fee amount'}
              <input required inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
            </label>
            <label>
              How it is paid
              <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
                <option value="on_top">Added on top of the commitment</option>
                <option value="deducted">Taken from the payment</option>
              </select>
            </label>
          </>
        )}
      </div>
      <label>
        What changes and why, in one sentence (they read it)
        <input required maxLength={300} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
      </label>
      <label className="check block">
        <input type="checkbox" checked={f.attested} onChange={(e) => setF({ ...f, attested: e.target.checked })} /> These terms are not an incentive: not a
        discount for the amount invested or for introductions, not time-limited, and not only for one channel.
      </label>
      <button type="submit" className="secondary" disabled={!data}>
        Ask a reviewer
      </button>
      <Problem error={error} />
    </form>
  )
}

function Row({
  dealId,
  r,
  currency,
  links,
  onChange,
  onEmail,
  operator,
}: {
  dealId: string
  r: PanelRow
  currency: string
  links: LinkChoice[]
  onChange: () => void
  onEmail: (r: PanelRow) => void
  operator: boolean
}) {
  const [open, setOpen] = useState(false)
  const [doing, setDoing] = useState<Action | null>(null)
  const fmt = (m: string | null) => (m === null ? '—' : money(BigInt(m), currency))
  const done = () => (setDoing(null), onChange())
  const pid = r.participation_id
  const choose = (a: Action) => (a === 'email' ? onEmail(r) : setDoing(doing === a ? null : a))
  return (
    <li className="panel-row" data-testid="panel-row">
      <div className="panel-head">
        <strong>{r.name}</strong>
        {r.own && <span className="pill">your own</span>}
        <span className="pill" data-testid="row-status">
          {r.label}
        </span>
        {r.noResponse && <span className="pill">no answer by the deadline</span>}
      </div>
      <dl className="details">
        {r.entity && (
          <div>
            <dt>Investing as</dt>
            <dd>{r.entity}</dd>
          </div>
        )}
        <div>
          <dt>Waiting on</dt>
          <dd data-testid="row-waiting">{WAITING_WORDS[r.waiting ?? 'none']}</dd>
        </div>
        <div>
          <dt>Days at this step</dt>
          <dd>{r.days ?? '—'}</dd>
        </div>
        <div>
          <dt>Commitment</dt>
          <dd>{fmt(r.commitment_minor)}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>{fmt(r.received_minor)}</dd>
        </div>
        <div>
          <dt>Lead fee</dt>
          <dd>{fmt(r.lead_fee_minor)}</dd>
        </div>
        <div>
          <dt>Carry</dt>
          <dd>{carry(r.carry_bps)}</dd>
        </div>
      </dl>
      {operator && (
        // R-AUD-02: one person's evidence pack for this deal; the server refuses staff with a stake
        <p className="row" data-testid="row-evidence">
          <span>Evidence pack for {r.name}:</span>
          <a href={`/api/ops/invitations/${r.invitation_id}/evidence.pdf`}>PDF</a>
          <a href={`/api/ops/invitations/${r.invitation_id}/evidence.json`}>JSON</a>
        </p>
      )}
      {!operator && (
        <button type="button" className="secondary small" aria-expanded={open} onClick={() => (setOpen(!open), setDoing(null))}>
          {open ? 'Hide actions' : `Actions for ${r.name}`}
        </button>
      )}
      {open && !operator && (
        <div className="actions" data-testid="row-actions">
          {(r.actions ?? []).map((v) => (
            <ActionButton key={v.action} v={v} open={doing === v.action} onOpen={() => choose(v.action)} />
          ))}
          {doing === 'view_documents' && pid && <Documents dealId={dealId} pid={pid} />}
          {doing === 'remove' && pid && (
            <Remove dealId={dealId} pid={pid} confirm={(r.actions ?? []).some((a) => a.action === 'remove' && a.confirm)} onDone={done} />
          )}
          {doing === 'withdrawal' && pid && <Withdrawal dealId={dealId} pid={pid} onDone={done} />}
          {doing === 'replace_link' && <ReplaceLink dealId={dealId} invitation={r.invitation_id} links={links} onDone={done} />}
          {doing === 'amount_proposal' && pid && <AmountProposal dealId={dealId} pid={pid} onDone={done} />}
          {doing === 'change_terms' && pid && <PersonTerms dealId={dealId} pid={pid} onDone={done} />}
        </div>
      )}
    </li>
  )
}

/**
 * R-ADM-02, R-ADM-05: the lead's list. `onEmail` opens a message to one row (R-COM-02). With `operator`, the same list for
 * reviewers and admins (R-OPS-01): read only, with each row's evidence pack (R-AUD-02) and the operator's export.
 */
export function LeadPanel({
  dealId,
  links = [],
  onEmail = () => undefined,
  version = 0,
  operator = false,
}: {
  dealId: string
  links?: LinkChoice[]
  onEmail?: (r: PanelRow) => void
  version?: number
  operator?: boolean
}) {
  const [status, setStatus] = useState('')
  const [waiting, setWaiting] = useState('')
  const q = new URLSearchParams({ ...(status ? { status } : {}), ...(waiting ? { waiting } : {}) }).toString()
  const base = operator ? `/api/ops/deals/${dealId}/investors` : `/api/deals/${dealId}/panel`
  const { data, error, reload } = useData<PanelData>(`${base}${q ? `?${q}` : ''}`)
  // read again when something elsewhere on the page changed the list (a message sent, an invitation made)
  const again = useRef(reload)
  again.current = reload
  const first = useRef(true)
  useEffect(() => {
    if (first.current) first.current = false
    else void again.current()
  }, [version])
  const label = (s: string) => (s === 'with_operator' ? (data?.with_operator_label ?? s) : (STATUS_LABEL[s as Status] ?? s))
  return (
    <div data-testid="lead-panel">
      <h3>Investor list</h3>
      <Problem error={error} />
      {data && (
        <>
          <dl className="details figures" data-testid="figures">
            {FIGURES.map(([k, words]) => (
              <div key={k}>
                <dt>{words}</dt>
                <dd>{money(BigInt(data.metrics[k]), data.currency)}</dd>
              </div>
            ))}
          </dl>
          <div className="row">
            <label>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                {Object.entries(data.counts.status).map(([s, n]) => (
                  <option key={s} value={s}>
                    {label(s)} ({n})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Waiting on
              <select value={waiting} onChange={(e) => setWaiting(e.target.value)}>
                <option value="">Anyone</option>
                {Object.entries(data.counts.waiting).map(([w, n]) => (
                  <option key={w} value={w}>
                    {WAITING_WORDS[w as Waiter | 'none'] ?? w} ({n})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!data.rows.length && <p className="hint">Nobody here yet.</p>}
          <ul className="list">
            {data.rows.map((r) => (
              <Row
                key={r.participation_id ?? r.invitation_id}
                dealId={dealId}
                r={r}
                currency={data.currency}
                links={links}
                onChange={() => void reload()}
                onEmail={onEmail}
                operator={operator}
              />
            ))}
          </ul>
          <p>
            <a href={operator ? `/api/ops/deals/${dealId}/investors.csv` : `/api/deals/${dealId}/investors.csv`}>Download this list (CSV)</a>
          </p>
        </>
      )}
    </div>
  )
}
