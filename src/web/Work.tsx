// D4 operator screens (chunk 9d1): one to-do list across every deal with who is on each item (R-OPS-02), the deal board
// (R-OPS-03), every deal's investor list read only with each person's evidence pack (R-OPS-01, R-AUD-02), complaints for
// staff and the person's own form (R-AUD-05). Nothing here judges: the lists, deadlines and flags are worked out on the server.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { COMPLAINT_MAX } from '../lib/complaint.ts'
import { money } from '../lib/dealSheet.ts'
import { parseWorkKey } from '../lib/workQueue.ts'
import { api } from './api.ts'
import { Link, useData } from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'
import { LeadPanel } from './LeadPanel.tsx'
import { ChangeReviews } from './DealChange.tsx'
import { DealDecisions } from './Life.tsx'
import { GotenSection } from './Money.tsx'

interface WorkItem {
  key: string
  kind: string
  label: string
  deal_id: string | null
  deal_code: string | null
  deal_name: string | null
  person: string | null
  amount_minor: string | null
  currency: string | null
  days: number
  deadline: string | null
  note: string
  assignee: { id: string; name: string } | null
}
interface WorkData {
  kinds: Array<{ kind: string; label: string }>
  counts: Partial<Record<string, number>>
  items: WorkItem[]
  left_out: number
  staff: Array<{ id: string; name: string }>
}
interface BoardDeal {
  id: string
  public_code: string
  name: string | null
  state: string
  target_close: string | null
  days_left: number | null
  target_changes: number
  flags: string[]
  flag_labels: string[]
  currency: string
  received_minor: string
  due_minor: string
  closing_gaps: string[] | null
}

/** A deadline is a day, or an instant shown to the minute (UTC, as stored). */
const when = (d: string) => (d.length > 10 ? `${d.slice(0, 16).replace('T', ' ')} UTC` : d)
const dealTitle = (d: { name: string | null; public_code: string }) => d.name ?? d.public_code

/** Where an item is worked on: money items on the money page (a statement import opened there), the rest on the deal's page. */
function workPage(i: WorkItem): string | null {
  const key = parseWorkKey(i.key)
  if (i.kind === 'statement_import' && key) return `/ops/money?import=${key.subject}`
  if (i.kind === 'unallocated' || i.kind === 'refund' || i.kind === 'payer_check' || (i.kind === 'hold' && i.person)) return '/ops/money'
  // decided on the deal's staff page (chunk 9d3a)
  if ((i.kind === 'cancel_request' || i.kind === 'withdrawal' || i.kind === 'reconfirm_silent' || i.kind === 'change') && i.deal_id) return `/ops/${i.deal_id}`
  return null
}

function Assign({ item, staff, onDone }: { item: WorkItem; staff: WorkData['staff']; onDone: () => Promise<void> }) {
  const { error, run } = useRun()
  const choose = (v: string) =>
    void run(async () => {
      await api('/api/ops/work/assign', 'POST', { key: item.key, assignee: v || null })
      await onDone()
    })
  return (
    <>
      <label>
        Assigned to
        <select value={item.assignee?.id ?? ''} onChange={(e) => choose(e.target.value)}>
          <option value="">Nobody</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <Problem error={error} />
    </>
  )
}

/** R-OPS-02: every open item across every deal, deadline first; filters by kind, deal and who is on it. */
export function WorkList({ me, deals, version }: { me: string; deals: BoardDeal[]; version: number }) {
  const [kind, setKind] = useState('')
  const [deal, setDeal] = useState('')
  const [assignee, setAssignee] = useState('')
  const q = new URLSearchParams({ ...(kind ? { kind } : {}), ...(deal ? { deal } : {}), ...(assignee ? { assignee } : {}) }).toString()
  const { data, error, reload } = useData<WorkData>(`/api/ops/work${q ? `?${q}` : ''}`)
  // read again when something elsewhere on the page resolved an item (a complaint acknowledged)
  const again = useRef(reload)
  again.current = reload
  const first = useRef(true)
  useEffect(() => {
    if (first.current) first.current = false
    else void again.current()
  }, [version])
  const total = data ? Object.values(data.counts).reduce<number>((a, n) => a + (n ?? 0), 0) : 0
  return (
    <section className="card" data-testid="work-list">
      <h2>To do</h2>
      <Problem error={error} />
      {data && (
        <>
          <p className="hint">
            {total === 1 ? 'One open item' : `${total} open items`} across every deal.
            {data.left_out > 0 &&
              ` ${data.left_out === 1 ? 'One item is' : `${data.left_out} items are`} left out because you have a stake in the deal; someone else handles ${data.left_out === 1 ? 'it' : 'them'}.`}
          </p>
          <div className="row">
            <label>
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">All ({total})</option>
                {data.kinds.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label} ({data.counts[k.kind] ?? 0})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Deal
              <select value={deal} onChange={(e) => setDeal(e.target.value)}>
                <option value="">Every deal</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {dealTitle(d)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Who is on it
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Anyone</option>
                <option value="none">Nobody</option>
                <option value={me}>Me</option>
                {data.staff
                  .filter((s) => s.id !== me)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {!data.items.length && <p className="hint">Nothing to do here.</p>}
          <ul className="list stacked">
            {data.items.map((i) => (
              <li key={i.key} data-testid="work-item">
                <div className="panel-head">
                  <strong>{i.label}</strong>
                  {i.deadline && <span className="pill">due {when(i.deadline)}</span>}
                  {workPage(i) && <Link to={workPage(i)!}>Open</Link>}
                </div>
                <dl className="details">
                  {i.deal_id && (
                    <div>
                      <dt>Deal</dt>
                      <dd>
                        <Link to={`/ops/${i.deal_id}`}>{i.deal_name ?? i.deal_code}</Link>
                      </dd>
                    </div>
                  )}
                  {i.person && (
                    <div>
                      <dt>Person</dt>
                      <dd>{i.person}</dd>
                    </div>
                  )}
                  {i.amount_minor !== null && i.currency && (
                    <div>
                      <dt>Amount</dt>
                      <dd>{money(BigInt(i.amount_minor), i.currency)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Days waiting</dt>
                    <dd>{i.days}</dd>
                  </div>
                  <div>
                    <dt>About</dt>
                    <dd>{i.note}</dd>
                  </div>
                </dl>
                <Assign item={i} staff={data.staff} onDone={reload} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** R-OPS-03: every deal with its stage, target date, money received and due, what closing still lacks, and the flags. */
export function DealBoard({ deals }: { deals: BoardDeal[] | null }) {
  if (!deals) return null
  return (
    <section className="card" data-testid="deal-board">
      <h2>Deals</h2>
      {!deals.length && <p className="hint">No deals yet.</p>}
      <ul className="list stacked">
        {deals.map((d) => (
          <li key={d.id} data-testid="board-row">
            <div className="panel-head">
              <Link to={`/ops/${d.id}`}>{dealTitle(d)}</Link>
              <span className="pill">{d.state}</span>
              {d.flag_labels.map((f) => (
                <span key={f} className="pill flag">
                  {f}
                </span>
              ))}
            </div>
            <dl className="details">
              <div>
                <dt>Target date</dt>
                <dd>{d.target_close ?? 'Not set'}</dd>
              </div>
              {d.days_left !== null && (
                <div>
                  <dt>Days left</dt>
                  <dd>{d.days_left < 0 ? `${-d.days_left} days past` : d.days_left}</dd>
                </div>
              )}
              <div>
                <dt>Received</dt>
                <dd>{money(BigInt(d.received_minor), d.currency)}</dd>
              </div>
              <div>
                <dt>Due from active investors</dt>
                <dd>{money(BigInt(d.due_minor), d.currency)}</dd>
              </div>
            </dl>
            {d.closing_gaps && d.closing_gaps.length > 0 && (
              <div>
                <p className="hint">Closing still needs:</p>
                <ul>
                  {d.closing_gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

interface StaffComplaint {
  id: string
  channel: 'form' | 'email'
  from: { name: string | null; email: string | null }
  body: string
  received_at: string
  acknowledge_by: string
  acknowledged_at: string | null
}

/** R-AUD-05: every complaint, open ones first; acknowledge, or enter one that came by email with the day it arrived. */
export function ComplaintsSection({ onChange = () => undefined }: { onChange?: () => void }) {
  const { data, reload } = useData<{ complaints: StaffComplaint[] }>('/api/ops/complaints')
  const [from, setFrom] = useState('')
  const [on, setOn] = useState('')
  const [body, setBody] = useState('')
  const [note, setNote] = useState('')
  const { error, run } = useRun()
  const record = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api<{ acknowledge_by: string }>('/api/ops/complaints', 'POST', { from_address: from, received_on: on, body })
      setFrom('')
      setOn('')
      setBody('')
      setNote(`Recorded. Acknowledge it by ${r.acknowledge_by}.`)
      await reload()
      onChange()
    })
  }
  const acknowledge = (c: StaffComplaint) =>
    void run(async () => {
      const r = await api<{ emailed: boolean }>(`/api/ops/complaints/${c.id}/acknowledge`, 'POST', {})
      setNote(r.emailed ? 'Acknowledged. The person has been sent the acknowledgement email.' : 'Acknowledged. Answer them by email if you have not yet.')
      await reload()
      onChange()
    })
  return (
    <section className="card" data-testid="complaints">
      <h2>Complaints</h2>
      {!data?.complaints.length && <p className="hint">No complaints.</p>}
      <ul className="list stacked">
        {data?.complaints.map((c) => (
          <li key={c.id} data-testid="complaint">
            <div className="panel-head">
              <strong>{c.from.name ?? c.from.email ?? 'Removed'}</strong>
              <span className="pill">{c.channel === 'form' ? 'through the site' : 'by email'}</span>
              {c.acknowledged_at ? (
                <span className="pill">acknowledged {c.acknowledged_at.slice(0, 10)}</span>
              ) : (
                <span className="pill flag">acknowledge by {c.acknowledge_by}</span>
              )}
            </div>
            <p className="hint">
              Received {c.received_at.slice(0, 10)}
              {c.from.name && c.from.email ? ` from ${c.from.email}` : ''}
            </p>
            <p className="prewrap">{c.body}</p>
            {!c.acknowledged_at && (
              <button type="button" className="small" onClick={() => acknowledge(c)}>
                {c.channel === 'form' ? 'Acknowledge and email them' : 'Record that it was acknowledged by email'}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={record}>
        <h3>Enter a complaint that came by email</h3>
        <div className="row">
          <label>
            From
            <input type="email" required maxLength={320} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Day it arrived
            <input type="date" required value={on} onChange={(e) => setOn(e.target.value)} />
          </label>
        </div>
        <label>
          What it says
          <textarea required maxLength={COMPLAINT_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Record it
        </button>
      </form>
      {note && <p role="status">{note}</p>}
      <Problem error={error} />
    </section>
  )
}

/** The operations page: the to-do list, the deal board and complaints. */
export function OpsHome({ me }: { me: string }) {
  const { data, error } = useData<{ deals: BoardDeal[] }>('/api/ops/deals')
  const [version, setVersion] = useState(0)
  return (
    <>
      <Problem error={error} />
      <p className="card">
        <Link to="/ops/money">Money: bank statements, unassigned money, refunds and held money</Link>
      </p>
      <WorkList me={me} deals={data?.deals ?? []} version={version} />
      <DealBoard deals={data?.deals ?? null} />
      <ComplaintsSection onChange={() => setVersion((v) => v + 1)} />
    </>
  )
}

/** One deal for staff: its board row and every investor, read only, with each person's evidence pack. */
export function OpsDeal({ id }: { id: string }) {
  const { data, reload } = useData<{ deals: BoardDeal[] }>('/api/ops/deals')
  const d = data?.deals.find((x) => x.id === id)
  return (
    <section className="card" data-testid="ops-deal">
      <p>
        <Link to="/ops">Back to operations</Link>
      </p>
      <h2>{d ? dealTitle(d) : 'Deal'}</h2>
      {d && (
        <p className="hint">
          {d.public_code} · {d.state}
        </p>
      )}
      <DealDecisions dealId={id} state={d?.state ?? null} currency={d?.currency ?? 'GBP'} onChange={() => void reload()} />
      <ChangeReviews dealId={id} onChange={() => void reload()} />
      <LeadPanel dealId={id} operator />
      <GotenSection dealId={id} />
    </section>
  )
}

interface MyComplaint {
  id: string
  body: string
  received_at: string
  acknowledged_at: string | null
}

/** R-AUD-05: the person's own complaints and the form, with where else a complaint can go. */
export function MyComplaints() {
  const { data, reload } = useData<{ complaints: MyComplaint[] }>('/api/my/complaints')
  const channel = useData<{ email: string | null; text: string }>('/api/complaints/channel')
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [note, setNote] = useState('')
  const { error, run } = useRun()
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api<{ acknowledge_by: string }>('/api/my/complaints', 'POST', { body })
      setBody('')
      setOpen(false)
      setNote(`Received. It will be acknowledged by ${r.acknowledge_by}.`)
      await reload()
    })
  }
  return (
    <section className="card" data-testid="my-complaints">
      <h2>Complaints</h2>
      {channel.data && <p className="hint">{channel.data.text}</p>}
      {!!data?.complaints.length && (
        <ul className="list stacked">
          {data.complaints.map((c) => (
            <li key={c.id}>
              <p className="hint">
                Sent {c.received_at.slice(0, 10)} · {c.acknowledged_at ? `acknowledged ${c.acknowledged_at.slice(0, 10)}` : 'not yet acknowledged'}
              </p>
              <p className="prewrap">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <form onSubmit={send}>
          <label>
            Your complaint
            <textarea required maxLength={COMPLAINT_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="row">
            <button type="submit">Send the complaint</button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          Make a complaint
        </button>
      )}
      {note && <p role="status">{note}</p>}
      <Problem error={error} />
    </section>
  )
}
