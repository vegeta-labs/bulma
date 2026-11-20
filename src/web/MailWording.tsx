// R-NTF-01, R-CMP-02, R-COM-04: the operator's wording for investor mail on screen. An admin edits the mails that may be
// edited (an edited one becomes promotional: sent only as approved, only to someone who passes that day, warning first) or
// puts the fixed wording back; urgent notices are shown and cannot be changed. An approver approves an edited wording.
import { useState, type FormEvent } from 'react'
import { BODY_MAX, SUBJECT_MAX, TEMPLATE_VARS } from '../lib/mailContent.ts'
import { api } from './api.ts'
import { useData } from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'
import { NOT_AUTHORISED, OPERATOR_NOTICE } from './Review.tsx'

interface Edited {
  version: number
  subject: string
  body: string
  sha256: string
  approved: boolean
}
interface Template {
  key: string
  action: string
  fixed: { subject: string; body: string }
  edited: Edited | null
}
interface Templates {
  templates: Template[]
  urgent: Array<{ key: string; subject: string; line: string }>
}

const FIELDS = TEMPLATE_VARS.map((v) => `{${v}}`).join(', ')

function TemplateItem({ t, onDone }: { t: Template; onDone: () => void }) {
  const now = t.edited ?? t.fixed
  const [subject, setSubject] = useState(now.subject)
  const [body, setBody] = useState(now.body)
  const { error, run } = useRun()
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/admin/mail-templates/${t.key}`, 'PUT', { subject, body })
      onDone()
    })
  }
  const reset = () =>
    void run(async () => {
      await api(`/api/admin/mail-templates/${t.key}`, 'PUT', { reset: true })
      onDone()
    })
  return (
    <li data-testid="mail-template">
      <p>
        <strong>{t.action}</strong>{' '}
        <span className="pill">
          {!t.edited
            ? 'Fixed wording'
            : t.edited.approved
              ? `Edited, version ${t.edited.version}, approved`
              : `Edited, version ${t.edited.version}, waiting for approval`}
        </span>
      </p>
      {t.edited && !t.edited.approved && <p className="hint">Until it is approved this mail is not sent.</p>}
      <details>
        <summary>Edit the wording</summary>
        <p className="warning">
          An edited mail is promotional: it is sent only once an approver approves it, only to someone who passes that day, and with the warning first.
        </p>
        <form onSubmit={save}>
          <label>
            Subject (one line, up to {SUBJECT_MAX} characters)
            <input required maxLength={SUBJECT_MAX} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            Text (up to {BODY_MAX} characters; fields you may use: {FIELDS})
            <textarea required maxLength={BODY_MAX} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="row">
            <button type="submit">Save this wording</button>
            {t.edited && (
              <button type="button" className="secondary" onClick={reset}>
                Put the fixed wording back
              </button>
            )}
          </div>
        </form>
      </details>
      <Problem error={error} />
    </li>
  )
}

/** The admin's list of investor mails: the editable ones, and the urgent notices that cannot be changed. */
export function MailTemplatesSection() {
  const { data, error, reload } = useData<Templates>('/api/admin/mail-templates')
  return (
    <section className="card" data-testid="mail-templates">
      <h2>Mail to investors</h2>
      <Problem error={error} />
      <ul className="list stacked">
        {data?.templates.map((t) => (
          <TemplateItem key={`${t.key}:${t.edited?.version ?? 0}`} t={t} onDone={() => void reload()} />
        ))}
      </ul>
      {data && (
        <details>
          <summary>Urgent notices (cannot be changed)</summary>
          <ul>
            {data.urgent.map((u) => (
              <li key={u.key}>
                <strong>{u.subject}</strong> {u.line}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

interface Waiting {
  key: string
  version: number
  subject: string
  body: string
  sha256: string
  approved: boolean
}

function WordingApproval({ t, onDone }: { t: Waiting; onDone: () => void }) {
  const [name, setName] = useState('')
  const [frn, setFrn] = useState('')
  const { error, run } = useRun()
  const approve = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/approvals/mail-templates/${t.key}/${t.version}`, 'POST', {
        content_sha256: t.sha256,
        self_declared_name: name,
        ...(frn.trim() ? { self_declared_frn: frn.trim() } : {}),
      })
      onDone()
    })
  }
  return (
    <li data-testid="wording-approval">
      <p>
        <strong>{t.subject}</strong> <span className="hint">version {t.version}</span>
      </p>
      <p className="legal mono">{t.body}</p>
      <form onSubmit={approve}>
        <label>
          Your name, as you state it *
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          FRN, as you state it (optional, 6 or 7 digits)
          <input inputMode="numeric" pattern="\d{6,7}" value={frn} onChange={(e) => setFrn(e.target.value)} />
        </label>
        <button type="submit">Approve this wording</button>
      </form>
      <Problem error={error} />
    </li>
  )
}

/** Edited mail wording not yet approved, for an approver. */
export function MailWordingApprovals() {
  const { data, reload } = useData<{ templates: Waiting[] }>('/api/approvals/mail-templates')
  const waiting = data?.templates.filter((t) => !t.approved) ?? []
  if (!waiting.length) return null
  return (
    <section className="card" data-testid="wording-approvals">
      <h2>Mail wording waiting for approval</h2>
      <p className="warning">{OPERATOR_NOTICE}</p>
      <p className="hint">{NOT_AUTHORISED}</p>
      <ul className="list stacked">
        {waiting.map((t) => (
          <WordingApproval key={`${t.key}:${t.version}`} t={t} onDone={() => void reload()} />
        ))}
      </ul>
    </section>
  )
}
