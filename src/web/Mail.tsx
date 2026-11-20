// D4 messages on screen (chunk 8e): the lead writes to a group of the list or one row, sees how many it reaches and the names
// of those with a step to do (to copy), an approver approves the text, the lead sends; the archive for the lead and for the
// investor (R-COM-01..04, R-CMP-02, R-CMP-03). Whom it reaches and in what form is decided by the server at the send.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MESSAGE_BODY_MAX, MESSAGE_SUBJECT_MAX } from '../lib/message.ts'
import { STATUS_LABEL, type Status } from '../lib/participation.ts'
import { api } from './api.ts'
import { Link, useData } from './DealShared.tsx'
import { PromotionWarning, type Warning } from './Invest.tsx'
import { Problem, useRun } from './Investor.tsx'
import { WAITING_WORDS, type PanelRow } from './LeadPanel.tsx'

interface Filter {
  status?: string
  waiting?: string
  committed?: boolean
}
interface SentTo {
  name: string
  sent: boolean
  why?: string
  mail?: 'queued' | 'sent' | 'not_delivered'
}
interface ArchiveMessage {
  id: string
  kind: 'bulk' | 'single'
  filter: Filter | null
  to: string | null
  author: string
  subject: string | null
  body: string | null
  content_sha256: string | null
  created_at: string
  sent_at: string | null
  approved: boolean | null
  recipients: SentTo[]
}

const MAIL_WORDS = { queued: 'on its way', sent: 'sent', not_delivered: 'could not be delivered' }

const statusWords = (s: string) => (s === 'with_operator' ? 'With the operator' : (STATUS_LABEL[s as Status] ?? s))

/** The group a message went to, in words. */
export function groupWords(f: Filter | null) {
  if (!f) return ''
  const parts = [
    f.status && `status ${statusWords(f.status)}`,
    f.waiting && `waiting on ${WAITING_WORDS[f.waiting as keyof typeof WAITING_WORDS]?.toLowerCase() ?? f.waiting}`,
    f.committed === true && 'committed',
    f.committed === false && 'not committed',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'everyone on the list'
}

const query = (f: Filter) =>
  new URLSearchParams({
    ...(f.status ? { status: f.status } : {}),
    ...(f.waiting ? { waiting: f.waiting } : {}),
    ...(f.committed === undefined ? {} : { committed: String(f.committed) }),
  }).toString()

function Audience({ dealId, filter }: { dealId: string; filter: Filter }) {
  const q = query(filter)
  const { data, error } = useData<{ people: number; unfinished_names: string[]; bulk_allowed: boolean }>(
    `/api/deals/${dealId}/mail/audience${q ? `?${q}` : ''}`,
  )
  if (error) return <Problem error={error} />
  if (!data) return null
  return (
    <div className="notice" data-testid="audience">
      {!data.bulk_allowed && <p>The operator has turned off messages to groups. You can still write to one person from their row.</p>}
      <p>
        {data.people} {data.people === 1 ? 'person is' : 'people are'} in this group. Whether each gets the message is decided when it is sent.
      </p>
      {data.unfinished_names.length > 0 && (
        <>
          <p>Still to do a step (to copy into the message if you wish):</p>
          <p className="mono" data-testid="unfinished-names">
            {data.unfinished_names.join(', ')}
          </p>
        </>
      )}
    </div>
  )
}

function Compose({
  dealId,
  single,
  onClearSingle,
  onSaved,
}: {
  dealId: string
  single: { invitation_id: string; name: string } | null
  onClearSingle: () => void
  onSaved: () => void
}) {
  const [filter, setFilter] = useState<Filter>({})
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [saved, setSaved] = useState<{ needs_approval: boolean } | null>(null)
  const { error, run } = useRun()
  useEffect(() => setSaved(null), [single])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const to = single ? { invitation_id: single.invitation_id } : { filter }
      setSaved(await api<{ needs_approval: boolean }>(`/api/deals/${dealId}/mail`, 'POST', { to, subject, body }))
      setSubject('')
      setBody('')
      onSaved()
    })
  }
  return (
    <form onSubmit={submit} data-testid="compose">
      <h3>{single ? `Write to ${single.name}` : 'Write to a group'}</h3>
      {single ? (
        <button type="button" className="secondary small" onClick={onClearSingle}>
          Write to a group instead
        </button>
      ) : (
        <>
          <div className="row">
            <label>
              Status
              <select value={filter.status ?? ''} onChange={(e) => setFilter({ ...filter, status: e.target.value || undefined })}>
                <option value="">Any</option>
                {[...Object.keys(STATUS_LABEL), 'with_operator'].map((s) => (
                  <option key={s} value={s}>
                    {statusWords(s)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Waiting on
              <select value={filter.waiting ?? ''} onChange={(e) => setFilter({ ...filter, waiting: e.target.value || undefined })}>
                <option value="">Anyone</option>
                {Object.entries(WAITING_WORDS).map(([w, words]) => (
                  <option key={w} value={w}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Committed
              <select
                value={filter.committed === undefined ? '' : String(filter.committed)}
                onChange={(e) => setFilter({ ...filter, committed: e.target.value === '' ? undefined : e.target.value === 'true' })}
              >
                <option value="">Either</option>
                <option value="true">Committed</option>
                <option value="false">Not committed</option>
              </select>
            </label>
          </div>
          <Audience dealId={dealId} filter={filter} />
        </>
      )}
      <p className="hint">
        The message is a promotion: it opens with the risk warning, and it reaches only people who may see this deal today. Anyone else still taking part gets a
        notice with nothing in it but a link to sign in. Replies go to your own email address.
      </p>
      <label>
        Subject
        <input required maxLength={MESSAGE_SUBJECT_MAX} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label>
        Message
        <textarea required rows={6} maxLength={MESSAGE_BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <button type="submit" className="secondary">
        Save the message
      </button>
      {saved && (
        <p className="hint" role="status">
          {saved.needs_approval ? 'Saved. An approver must approve it before you can send it.' : 'Saved. Send it from the list below.'}
        </p>
      )}
      <Problem error={error} />
    </form>
  )
}

interface SendResult {
  sent: number
  excluded: Array<{ name: string; why: string }>
}

function Unsent({ dealId, m, onChange, onSent }: { dealId: string; m: ArchiveMessage; onChange: () => void; onSent: (r: SendResult) => void }) {
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(m.subject ?? '')
  const [body, setBody] = useState(m.body ?? '')
  const { error, run } = useRun()
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/deals/${dealId}/mail/${m.id}`, 'PUT', { subject, body })
      setEditing(false)
      onChange()
    })
  }
  const send = () =>
    run(async () => {
      onSent(await api<SendResult>(`/api/deals/${dealId}/mail/${m.id}/send`, 'POST', { content_sha256: m.content_sha256 }))
      onChange()
    })
  return (
    <div>
      <p className="pill" data-testid="message-state">
        {m.approved ? 'Ready to send' : 'Waiting for an approver'}
      </p>
      {editing ? (
        <form onSubmit={save}>
          <p className="hint">A changed message needs a new approval.</p>
          <label>
            Subject
            <input required maxLength={MESSAGE_SUBJECT_MAX} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            Message
            <textarea required rows={6} maxLength={MESSAGE_BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <button type="submit" className="secondary">
            Save changes
          </button>
        </form>
      ) : (
        <div className="row">
          <button type="button" disabled={!m.approved} onClick={() => void send()}>
            Send
          </button>
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            Change it
          </button>
        </div>
      )}
      <Problem error={error} />
    </div>
  )
}

function Archive({ dealId, version, onChange }: { dealId: string; version: number; onChange: () => void }) {
  const { data, error, reload } = useData<{ note: string; needs_approval: boolean; messages: ArchiveMessage[] }>(`/api/deals/${dealId}/mail`)
  const [result, setResult] = useState<SendResult | null>(null)
  const again = useRef(reload)
  again.current = reload
  const first = useRef(true)
  useEffect(() => {
    if (first.current) first.current = false
    else void again.current()
  }, [version])
  return (
    <div data-testid="mail-archive">
      <h3>Messages sent through this site</h3>
      <Problem error={error} />
      {result && (
        <div className="notice" role="status" data-testid="send-result">
          <p>Sent to {result.sent}.</p>
          {result.excluded.map((x) => (
            <p key={x.name} className="hint">
              Not sent to {x.name}: {x.why}
            </p>
          ))}
        </div>
      )}
      {data && <p className="hint">{data.note}</p>}
      {data && !data.messages.length && <p className="hint">None yet.</p>}
      <ul className="list">
        {data?.messages.map((m) => (
          <li key={m.id} data-testid="archive-message">
            <div>
              <strong>{m.subject}</strong>{' '}
              <span className="hint">
                {m.kind === 'single' ? `to ${m.to ?? 'one person'}` : `to ${groupWords(m.filter)}`}, by {m.author}
                {m.sent_at ? `, sent ${m.sent_at.slice(0, 10)}` : ''}
              </span>
              <p className="legal">{m.body}</p>
              {m.sent_at ? (
                <ul className="steps">
                  {m.recipients.map((r) => (
                    <li key={r.name}>
                      {r.name}: {r.sent ? MAIL_WORDS[r.mail ?? 'queued'] : `not sent. ${r.why}`}
                    </li>
                  ))}
                </ul>
              ) : (
                <Unsent dealId={dealId} m={m} onChange={onChange} onSent={setResult} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The lead's messages: write, then the archive. A row's "Email" sets `single`. */
export function DealMail({
  dealId,
  single,
  onClearSingle,
  version,
  onChange,
}: {
  dealId: string
  single: PanelRow | null
  onClearSingle: () => void
  version: number
  onChange: () => void
}) {
  return (
    <div data-testid="deal-mail">
      <Compose dealId={dealId} single={single && { invitation_id: single.invitation_id, name: single.name }} onClearSingle={onClearSingle} onSaved={onChange} />
      <Archive dealId={dealId} version={version} onChange={onChange} />
    </div>
  )
}

interface WaitingMessage {
  id: string
  deal_code: string
  kind: 'bulk' | 'single'
  filter: Filter | null
  subject: string
  body: string
  content_sha256: string
}

function MailApproval({ m, onDone }: { m: WaitingMessage; onDone: () => void }) {
  const [name, setName] = useState('')
  const [frn, setFrn] = useState('')
  const { error, run } = useRun()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/approvals/mail/${m.id}`, 'POST', {
        content_sha256: m.content_sha256,
        self_declared_name: name,
        ...(frn.trim() ? { self_declared_frn: frn.trim() } : {}),
      })
      onDone()
    })
  }
  return (
    <li data-testid="mail-approval">
      <div>
        <strong>{m.subject}</strong>{' '}
        <span className="hint">
          deal {m.deal_code}, {m.kind === 'single' ? 'to one person' : `to ${groupWords(m.filter)}`}
        </span>
        <p className="legal">{m.body}</p>
        <p className="mono">{m.content_sha256}</p>
        <form onSubmit={submit}>
          <div className="row">
            <label>
              Your name, as you state it *
              <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              FRN, as you state it (optional)
              <input inputMode="numeric" pattern="\d{6,7}" value={frn} onChange={(e) => setFrn(e.target.value)} />
            </label>
          </div>
          <button type="submit">Approve this message</button>
          <Problem error={error} />
        </form>
      </div>
    </li>
  )
}

/** R-CMP-02: messages waiting for an approver, with the words that this is the operator's internal record (TC-CMP-07). */
export function MailApprovals() {
  const { data, error, reload } = useData<{ note: string; messages: WaitingMessage[] }>('/api/approvals/mail')
  return (
    <section className="card" data-testid="mail-approvals">
      <h2>Messages waiting for approval</h2>
      {data && <p data-testid="mail-approval-notice">{data.note}</p>}
      <Problem error={error} />
      {data && !data.messages.length && <p>Nothing is waiting.</p>}
      <ul className="list">
        {data?.messages.map((m) => (
          <MailApproval key={m.id} m={m} onDone={() => void reload()} />
        ))}
      </ul>
    </section>
  )
}

/** R-COM-03: the investor's own messages; the text only while they may see the deal today, else a line to sign in again. */
export function MyMail() {
  const { data } = useData<{
    note: string
    messages: Array<{ id: string; deal_code: string; sent_at: string; hidden?: true; warning?: Warning | null; subject?: string; body?: string }>
  }>('/api/my/mail')
  if (!data?.messages.length) return null
  return (
    <section className="card" data-testid="my-mail">
      <h2>Messages from leads</h2>
      <p className="hint">{data.note}</p>
      <ul className="list">
        {data.messages.map((m) => (
          <li key={m.id} data-testid="my-message">
            <div>
              <span className="hint">
                Deal {m.deal_code}, {m.sent_at.slice(0, 10)}
              </span>
              {m.hidden ? (
                <p>
                  You cannot see this message today. It opens again once you may see this deal. <Link to="/">Check your steps</Link>
                </p>
              ) : (
                <>
                  {m.warning && <PromotionWarning w={m.warning} />}
                  <h3>{m.subject}</h3>
                  <p className="legal">{m.body}</p>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
