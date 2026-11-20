// D4 chunk 9d3a: a deal's life after launch on screen. The lead asks to close or takes it back (R-CLS-00, R-CLS-01), asks to
// cancel with the operator's note on fees (§5.1, R28 (10)) and lets people in from the waiting list (R-ALO-04). Staff decide:
// a cancellation by someone other than who asked, withdrawals with written consent (R-WDR-02), people who did not reconfirm in
// time (§5.3), taking back a closing request, archiving a cancelled deal. Nothing here judges: the server decides and says why not.
import { useEffect, useState } from 'react'
import { money } from '../lib/dealSheet.ts'
import { api } from './api.ts'
import { useData } from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'

const amount = (m: string, c: string) => money(BigInt(m), c)
const day = (d: string) => d.slice(0, 10)
const minute = (d: string) => `${d.slice(0, 16).replace('T', ' ')} UTC`

// ---------- the lead ----------

interface Closing {
  state: string
  gaps: string[]
  committed_minor: string
  min_raise_minor: string | null
  allocation_minor: string
  received_minor: string
  lead_fees_minor: string
  estimated_investment_minor: string
  platform_fee_note: string
}

/** R-CLS-00: what closing still needs; asking needs the confirmation, and pauses the links until closing or taken back. */
function ClosingBox({ dealId, state, currency, onChange }: { dealId: string; state: string; currency: string; onChange: () => void }) {
  const { data, reload } = useData<Closing>(`/api/deals/${dealId}/closing`)
  const [sure, setSure] = useState(false)
  const { error, run } = useRun()
  useEffect(() => {
    void reload()
  }, [state, reload])
  if (!data) return null
  const move = (path: string, body?: unknown) =>
    void run(async () => {
      await api(`/api/deals/${dealId}/${path}`, 'POST', body)
      setSure(false)
      onChange()
    })
  return (
    <div data-testid="closing">
      <h3>Closing</h3>
      <p>
        Committed so far: {amount(data.committed_minor, currency)}
        {data.min_raise_minor !== null && <> of a minimum raise of {amount(data.min_raise_minor, currency)}</>}
      </p>
      <dl className="figures" data-testid="closing-figures">
        <dt>SPV allocation</dt>
        <dd>{amount(data.allocation_minor, currency)}</dd>
        <dt>Received</dt>
        <dd>{amount(data.received_minor, currency)}</dd>
        <dt>Lead fees</dt>
        <dd>{amount(data.lead_fees_minor, currency)}</dd>
        <dt>Estimated investment, before the platform fee</dt>
        <dd>{amount(data.estimated_investment_minor, currency)}</dd>
      </dl>
      <p className="hint">{data.platform_fee_note}</p>
      {state === 'live' && data.gaps.length > 0 && (
        <>
          <p>Before you can ask to close:</p>
          <ul data-testid="closing-gaps">
            {data.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </>
      )}
      {state === 'live' && data.gaps.length === 0 && (
        <>
          <label className="check block">
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I want to close. Links stop taking new commitments, proposed
            amounts not yet answered end, and nobody more is let in from the waiting list.
          </label>
          <button type="button" disabled={!sure} onClick={() => move('request-closing', { confirm: true })}>
            Ask to close
          </button>
        </>
      )}
      {state === 'closing_requested' && (
        <>
          <p data-testid="closing-asked">You asked to close. A reviewer will take it from here.</p>
          <button type="button" className="secondary" onClick={() => move('withdraw-closing')}>
            Take back the request to close
          </button>
        </>
      )}
      <Problem error={error} />
    </div>
  )
}

/** §5.1: the lead asks; a reviewer with no stake confirms. The operator's note on fees is shown before asking. */
function CancelBox({ dealId }: { dealId: string }) {
  const { data } = useData<{ cancel_fee_note: string | null }>(`/api/deals/${dealId}/cancel-note`)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [asked, setAsked] = useState(false)
  const { error, run } = useRun()
  if (!data) return null
  const ask = () =>
    void run(async () => {
      await api(`/api/deals/${dealId}/cancel-request`, 'POST', reason.trim() ? { reason: reason.trim() } : {})
      setAsked(true)
      setOpen(false)
    })
  return (
    <div data-testid="cancel-deal">
      <h3>Cancel the deal</h3>
      {asked ? (
        <p data-testid="cancel-asked">Your request is waiting. A reviewer must confirm it before anything changes.</p>
      ) : !open ? (
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          Ask to cancel the deal
        </button>
      ) : (
        <>
          <p>
            If a reviewer confirms, every commitment ends, payment details stop being valid, investors are told not to pay, and money already received is
            refunded.
          </p>
          {data.cancel_fee_note && (
            <p className="notice prewrap" data-testid="cancel-fee-note">
              {data.cancel_fee_note}
            </p>
          )}
          <label>
            Reason (optional, for the reviewer)
            <textarea maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row">
            <button type="button" onClick={ask}>
              Send the request to cancel
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              Keep the deal
            </button>
          </div>
        </>
      )}
      <Problem error={error} />
    </div>
  )
}

interface Waitlist {
  mode: string
  room_minor: string
  entries: Array<{ id: string; name: string; desired_minor: string; state: string; created_at: string; released_at: string | null }>
}

/** R-ALO-03, R-ALO-04: who is waiting, the room left, and letting someone in. */
function WaitlistBox({ dealId, currency }: { dealId: string; currency: string }) {
  const { data, reload } = useData<Waitlist>(`/api/deals/${dealId}/waitlist`)
  const { error, run } = useRun()
  if (!data || (data.mode !== 'stop' && !data.entries.length)) return null
  const release = (wid: string) =>
    void run(async () => {
      await api(`/api/deals/${dealId}/waitlist/${wid}/release`, 'POST')
      await reload()
    })
  return (
    <div data-testid="waitlist">
      <h3>Waiting list</h3>
      <p className="hint">Room left in the deal: {amount(data.room_minor, currency)}</p>
      {data.entries.length ? (
        <ul className="list">
          {data.entries.map((w) => (
            <li key={w.id} data-testid="waitlist-row">
              <strong>{w.name}</strong> would like {amount(w.desired_minor, currency)} · since {day(w.created_at)}
              {w.state === 'released' ? (
                <span className="pill">let in{w.released_at ? ` on ${day(w.released_at)}` : ''}</span>
              ) : (
                <button type="button" className="secondary small" onClick={() => release(w.id)}>
                  Let them in
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Nobody is waiting.</p>
      )}
      <Problem error={error} />
    </div>
  )
}

const CLOSABLE = ['live', 'closing_requested']
const CANCELLABLE = ['live', 'closing_requested', 'closing']

/** On the lead's deal page once it is live. */
export function DealLifecycle({ dealId, state, currency, onChange }: { dealId: string; state: string; currency: string; onChange: () => void }) {
  if (!CANCELLABLE.includes(state)) return null
  return (
    <section className="card" data-testid="deal-life">
      <h2>Closing and cancelling</h2>
      {CLOSABLE.includes(state) && <ClosingBox dealId={dealId} state={state} currency={currency} onChange={onChange} />}
      {CLOSABLE.includes(state) && <WaitlistBox dealId={dealId} currency={currency} />}
      <CancelBox dealId={dealId} />
    </section>
  )
}

// ---------- staff ----------

interface CancelRequest {
  id: string
  deal_id: string
  public_code: string
  state: string
  asked_as: 'lead' | 'reviewer'
  reason: string | null
  created_at: string
  mine: boolean
}
interface Withdrawal {
  id: string
  participation_id: string
  deal_id: string
  public_code: string
  reference: string
  evidence: string
  name: string
  created_at: string
}
interface Reconfirmation {
  id: string
  deal_id: string
  deal_code: string
  participation_id: string
  reference: string
  name: string
  clock: 'open' | 'paused' | 'lapsed' | 'unknown'
  deadline: string | null
  held_minor: string
  next: 'may_remove' | 'operator_decides' | null
}

const CLOCK: Record<Reconfirmation['clock'], string> = {
  open: 'Waiting for their answer',
  paused: 'Clock paused: no valid statement covers them',
  lapsed: 'The deadline has passed',
  unknown: 'The deadline cannot be worked out',
}

function CancelItem({ r, onDone }: { r: CancelRequest; onDone: () => void }) {
  const [note, setNote] = useState('')
  const { error, run } = useRun()
  const post = (path: string, body: unknown) =>
    void run(async () => {
      await api(`/api/review/cancel-requests/${r.id}/${path}`, 'POST', body)
      onDone()
    })
  return (
    <li data-testid="cancel-request">
      <div className="panel-head">
        <strong>Request to cancel</strong>
        <span className="pill">asked by {r.asked_as === 'lead' ? 'the lead' : 'a reviewer'}</span>
        <span className="pill">{day(r.created_at)}</span>
      </div>
      {r.reason && <p className="prewrap">{r.reason}</p>}
      {r.mine ? (
        <p className="hint">You asked, so someone else decides.</p>
      ) : (
        <>
          <p className="hint">
            Confirming ends every commitment, voids payment details with an urgent mail, and puts a refund on the to-do list for everyone whose money arrived.
          </p>
          <button type="button" onClick={() => post('confirm', {})}>
            Confirm the cancellation
          </button>
          <label>
            Note to decline (the lead reads it)
            <textarea minLength={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="button" className="secondary" disabled={note.trim().length < 3} onClick={() => post('decline', { note })}>
            Decline
          </button>
        </>
      )}
      <Problem error={error} />
    </li>
  )
}

function WithdrawalItem({ w, onDone }: { w: Withdrawal; onDone: () => void }) {
  const [note, setNote] = useState('')
  const { error, run } = useRun()
  const post = (path: string, body: unknown) =>
    void run(async () => {
      await api(`/api/review/withdrawals/${w.id}/${path}`, 'POST', body)
      onDone()
    })
  return (
    <li data-testid="withdrawal">
      <div className="panel-head">
        <strong>{w.name}</strong>
        <span className="pill">{w.reference}</span>
        <span className="pill">{day(w.created_at)}</span>
      </div>
      <p className="prewrap">Evidence: {w.evidence}</p>
      <p className="hint">Accepting ends their commitment and puts their refund on the to-do list.</p>
      <button type="button" onClick={() => post('accept', undefined)}>
        Accept the withdrawal
      </button>
      <label>
        Note to decline
        <textarea minLength={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button type="button" className="secondary" disabled={note.trim().length < 3} onClick={() => post('decline', { note })}>
        Decline
      </button>
      <Problem error={error} />
    </li>
  )
}

function ReconfirmItem({ r, currency, onDone }: { r: Reconfirmation; currency: string; onDone: () => void }) {
  const [evidence, setEvidence] = useState('')
  const { error, run } = useRun()
  const exclude = () =>
    void run(async () => {
      await api(`/api/review/reconfirmations/${r.id}/exclude`, 'POST', { evidence })
      onDone()
    })
  return (
    <li data-testid="reconfirmation">
      <div className="panel-head">
        <strong>{r.name}</strong>
        <span className="pill">{r.reference}</span>
        <span className="pill">{CLOCK[r.clock]}</span>
      </div>
      <p className="hint">
        {r.deadline && <>Deadline {minute(r.deadline)} · </>}
        Money held: {amount(r.held_minor, currency)}
      </p>
      {r.next === 'may_remove' && <p className="hint">No money has arrived: the lead can remove them.</p>}
      {r.next === 'operator_decides' && (
        <>
          <label>
            How they were told and why they are excluded
            <textarea minLength={3} maxLength={5000} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          <button type="button" disabled={evidence.trim().length < 3} onClick={exclude}>
            Exclude them and refund
          </button>
        </>
      )}
      <Problem error={error} />
    </li>
  )
}

/** On a deal's staff page: what waits for a staff decision on it, and the staff's own moves. */
export function DealDecisions({ dealId, state, currency, onChange }: { dealId: string; state: string | null; currency: string; onChange: () => void }) {
  const cancels = useData<{ requests: CancelRequest[] }>('/api/review/cancel-requests')
  const wds = useData<{ withdrawals: Withdrawal[] }>('/api/review/withdrawals')
  const rcs = useData<{ reconfirmations: Reconfirmation[] }>('/api/review/reconfirmations')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const { error, run } = useRun()
  const done = () => {
    void cancels.reload()
    void wds.reload()
    void rcs.reload()
    onChange()
  }
  const act = (path: string, body: unknown, said: string) =>
    void run(async () => {
      await api(`/api/review/deals/${dealId}/${path}`, 'POST', body)
      setNote(said)
      done()
    })
  const cancel = cancels.data?.requests.filter((r) => r.deal_id === dealId) ?? []
  const withdrawals = wds.data?.withdrawals.filter((w) => w.deal_id === dealId) ?? []
  const reconfirm = rcs.data?.reconfirmations.filter((r) => r.deal_id === dealId) ?? []
  return (
    <div data-testid="deal-decisions">
      <h3>Decisions</h3>
      {cancel.length + withdrawals.length + reconfirm.length === 0 && <p className="hint">Nothing on this deal waits for a decision.</p>}
      {cancel.length > 0 && (
        <ul className="list stacked">
          {cancel.map((r) => (
            <CancelItem key={r.id} r={r} onDone={done} />
          ))}
        </ul>
      )}
      {withdrawals.length > 0 && (
        <>
          <h4>Withdrawals</h4>
          <ul className="list stacked">
            {withdrawals.map((w) => (
              <WithdrawalItem key={w.id} w={w} onDone={done} />
            ))}
          </ul>
        </>
      )}
      {reconfirm.length > 0 && (
        <>
          <h4>Reconfirmations</h4>
          <ul className="list stacked">
            {reconfirm.map((r) => (
              <ReconfirmItem key={r.id} r={r} currency={currency} onDone={done} />
            ))}
          </ul>
        </>
      )}
      {state === 'closing_requested' && (
        <button type="button" className="secondary" onClick={() => act('withdraw-closing', undefined, 'The request to close is taken back.')}>
          Take back the request to close
        </button>
      )}
      {state === 'cancelled' && (
        <>
          <p className="hint">A cancelled deal can be archived once every refund is done and no money is held.</p>
          <button type="button" className="secondary" onClick={() => act('archive', undefined, 'Archived.')}>
            Archive the deal
          </button>
        </>
      )}
      {state !== null && CANCELLABLE.includes(state) && !cancel.length && (
        <details>
          <summary>Ask to cancel this deal</summary>
          <p className="hint">Another reviewer must confirm it.</p>
          <label>
            Reason
            <textarea maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() => act('cancel-request', reason.trim() ? { reason: reason.trim() } : {}, 'Your request to cancel is waiting for another reviewer.')}
          >
            Send the request to cancel
          </button>
        </details>
      )}
      {note && (
        <p role="status" className="hint">
          {note}
        </p>
      )}
      <Problem error={error} />
    </div>
  )
}
