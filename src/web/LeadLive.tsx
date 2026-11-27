// D3 lead screens for a live deal: links, invitations to an address, the expected-investor list, messages (R-LNK-*, R-PIP-*).
// A link is shown for a person to copy; nothing writes to the clipboard.
import { fileLink } from './browser.ts'
import { useState, type FormEvent } from 'react'
import { money } from '../lib/dealSheet.ts'
import { percentToBps, typedAmountToDraft } from '../lib/pounds.ts'
import { api } from './api.ts'
import { useData } from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'
import { LeadPanel, type PanelRow } from './LeadPanel.tsx'
import { DealMail } from './Mail.tsx'

interface LinkRow {
  id: string
  kind: 'open' | 'terms_only'
  label: string
  carry: string
  fee: string
  reason: string | null
  is_default: boolean
  awaiting_approval: boolean
  disabled: boolean
  usable: boolean
  invited: number
  committed: number
  opened_unbound: number
}
interface Reach {
  counts: { uk: number; eea: Record<string, number>; unknown: number; other: number }
  warnings: { ukPeopleNear: boolean; ukAmountNear: boolean; eeaOver: string[]; unknown: number }
  note: string
}
interface LinksData {
  deal_state: string
  policy: { per_link_terms: boolean; generic_links: boolean }
  default_carry_bps: number
  active_count: number
  max: number
  links: LinkRow[]
  reach: Reach
}

function ReachNote({ r }: { r: Reach }) {
  return (
    <div className="hint" data-testid="reach">
      <p>
        People invited: UK {r.counts.uk}, other EEA {Object.values(r.counts.eea).reduce((a, b) => a + b, 0)}, elsewhere {r.counts.other}, country not given{' '}
        {r.counts.unknown}. {r.note}
      </p>
      {r.warnings.ukPeopleNear && <p className="warning">Nearly 150 people in the UK have been invited.</p>}
      {r.warnings.ukAmountNear && <p className="warning">Commitments from the UK are near £5,000,000.</p>}
      {r.warnings.eeaOver.length > 0 && <p className="warning">Over the operator's number in: {r.warnings.eeaOver.join(', ')}.</p>}
    </div>
  )
}

function NewLink({ dealId, data, onDone }: { dealId: string; data: LinksData; onDone: () => void }) {
  const [f, setF] = useState({
    label: '',
    carry: String(data.default_carry_bps / 100),
    feeKind: 'none',
    fee: '',
    mode: 'on_top',
    reason: '',
    attested: false,
    kind: data.policy.generic_links ? 'open' : 'terms_only',
  })
  const [preview, setPreview] = useState(false)
  const [made, setMade] = useState<{ url: string | null; awaiting_approval: boolean } | null>(null)
  const { error, run } = useRun()
  const fee = () =>
    f.feeKind === 'percent'
      ? { kind: 'percent', bps: percentToBps(f.fee) ?? -1, mode: f.mode }
      : f.feeKind === 'fixed'
        ? { kind: 'fixed', minor: typedAmountToDraft(f.fee) ?? '', mode: f.mode }
        : { kind: 'none' }
  const save = () =>
    run(async () => {
      setMade(
        await api(`/api/deals/${dealId}/links`, 'POST', {
          kind: f.kind,
          label: f.label,
          carry_bps: percentToBps(f.carry) ?? -1,
          fee: fee(),
          reason: f.reason || null,
          incentive_attested: f.attested,
          confirm: true,
        }),
      )
      setPreview(false)
      onDone()
    })
  const show = (e: FormEvent) => {
    e.preventDefault()
    setPreview(true)
  }
  return (
    <form onSubmit={show} data-testid="new-link">
      <h3>New terms</h3>
      <div className="row">
        <label>
          Note (who it is for)
          <input value={f.label} maxLength={200} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </label>
        <label>
          Carry %
          <input required inputMode="decimal" value={f.carry} onChange={(e) => setF({ ...f, carry: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label>
          Cash fee
          <select value={f.feeKind} onChange={(e) => setF({ ...f, feeKind: e.target.value })}>
            <option value="none">None</option>
            <option value="percent">Percentage</option>
            <option value="fixed">Fixed amount per person</option>
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
        Kind of link
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {data.policy.generic_links && <option value="open">A link anyone with it can open</option>}
          <option value="terms_only">Terms only, for invitations sent to an address</option>
        </select>
      </label>
      <label>
        Why these terms differ from the default (needed when they do)
        <textarea maxLength={2000} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </label>
      <label className="check block">
        <input type="checkbox" checked={f.attested} onChange={(e) => setF({ ...f, attested: e.target.checked })} /> These terms are not an incentive: not a
        discount for the amount invested or for introductions, not time-limited, and not only for one channel.
      </label>
      <button type="submit" className="secondary">
        Check the terms
      </button>
      {preview && (
        <div className="notice" data-testid="link-preview">
          <p>
            Carry {f.carry}%. Fee:{' '}
            {f.feeKind === 'none'
              ? 'none'
              : `${f.fee}${f.feeKind === 'percent' ? '%' : ''}, ${f.mode === 'on_top' ? 'added on top' : 'taken from the payment'}`}
            . These terms cannot be changed once saved.
          </p>
          <button type="button" onClick={() => void save()}>
            Save these terms
          </button>
        </div>
      )}
      {made && (
        <p className="notice" role="status">
          {made.awaiting_approval ? 'Saved. A reviewer must approve these terms before the link can be used.' : 'Saved.'}{' '}
          {made.url && <span className="mono">{made.url}</span>}
        </p>
      )}
      <Problem error={error} />
    </form>
  )
}

function LinkItem({ dealId, l, onChange }: { dealId: string; l: LinkRow; onChange: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const { error, run } = useRun()
  return (
    <li data-testid="link-row">
      <span>
        <strong>{l.label || (l.is_default ? 'Default' : 'Terms')}</strong>: carry {l.carry}, {l.fee}
        {l.kind === 'terms_only' && <span className="pill">terms only</span>}
        {l.awaiting_approval && <span className="pill">waiting for a reviewer</span>}
        {l.disabled && <span className="pill">off</span>}
        <span className="hint">
          {' '}
          {l.invited} invited, {l.committed} committed, {l.opened_unbound} opened and not yet signed in
        </span>
        {url && (
          <span className="mono" data-testid="link-url">
            {' '}
            {url}
          </span>
        )}
      </span>
      <span className="row">
        {l.kind === 'open' && !l.disabled && (
          <button
            type="button"
            className="secondary small"
            onClick={() => void run(async () => setUrl((await api<{ url: string }>(`/api/deals/${dealId}/links/${l.id}/url`)).url))}
          >
            Show link
          </button>
        )}
        {!l.disabled && (
          <button
            type="button"
            className="secondary small"
            onClick={() => void run(async () => (await api(`/api/deals/${dealId}/links/${l.id}/disable`, 'POST', {}), onChange()))}
          >
            Turn off
          </button>
        )}
      </span>
      <Problem error={error} />
    </li>
  )
}

function Targeted({ dealId, links }: { dealId: string; links: LinkRow[] }) {
  const usable = links.filter((l) => l.usable)
  const [f, setF] = useState({ email: '', link: usable[0]?.id ?? '', reentry: false })
  const [sent, setSent] = useState(false)
  const { error, run } = useRun()
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/deals/${dealId}/targeted`, 'POST', { email: f.email, link_id: f.link, allows_reentry: f.reentry })
      setSent(true)
      setF({ ...f, email: '' })
    })
  }
  return (
    <form onSubmit={send} data-testid="targeted">
      <h3>Invite by email</h3>
      <p className="hint">The email holds no details of the deal. Only an account that confirmed this address can use it.</p>
      <div className="row">
        <label>
          Email
          <input type="email" required value={f.email} onChange={(e) => (setF({ ...f, email: e.target.value }), setSent(false))} />
        </label>
        <label>
          Terms
          <select value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })}>
            {usable.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label || 'Terms'}: carry {l.carry}, {l.fee}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check block">
        <input type="checkbox" checked={f.reentry} onChange={(e) => setF({ ...f, reentry: e.target.checked })} /> This person left the deal before and may come
        back
      </label>
      <button type="submit" className="secondary">
        Send invitation
      </button>
      {sent && <p className="hint" role="status">Sent.</p>}
      <Problem error={error} />
    </form>
  )
}

interface PipeRow {
  id: string
  name: string
  email: string
  expected_minor: string | null
  terms_label: string
  private_note: string | null
  targeted_invite: string | null
  status: string
  status_label: string
}

function Pipeline({ dealId, links, live }: { dealId: string; links: LinkRow[]; live: boolean }) {
  const { data, reload } = useData<{
    currency: string
    rows: PipeRow[]
    not_responded: string[]
    totals: { committed_minor: string; expected_minor: string; expected_note: string; allocation_minor: string | null }
  }>(`/api/deals/${dealId}/pipeline`)
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<{ errors: Array<{ line: number; message: string }>; duplicates: string[]; added: number } | null>(null)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [resendTo, setResendTo] = useState<Record<string, string | undefined>>({})
  // the plan holds the exact choices it was made for: changing any choice drops it, and sending sends what it showed
  const [plan, setPlan] = useState<{
    count: number
    skipped: Array<{ name: string; why: string }>
    by_terms: Record<string, number>
    plan_sha256: string
    entries: Array<{ id: string; link_id: string }>
  } | null>(null)
  const { error, run } = useRun()
  const usable = links.filter((l) => l.usable)
  const add = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api<{ errors: Array<{ line: number; message: string }>; duplicates: string[]; added: number }>(`/api/deals/${dealId}/pipeline`, 'POST', {
        text,
      })
      setParsed(r)
      if (r.added) setText('')
      await reload()
    })
  }
  // a row set back to "Do not send" is left out, not sent with no terms
  const entries = () =>
    Object.entries(chosen)
      .filter(([, link_id]) => link_id)
      .map(([id, link_id]) => ({ id, link_id }))
  // a draft can hold anything typed; only a whole number of pence is shown as money
  const fmt = (m: string | null) => (m && /^\d{1,19}$/.test(m) ? money(BigInt(m), data?.currency ?? 'GBP') : '')
  return (
    <div data-testid="pipeline">
      <h3>Expected investors</h3>
      {data && (
        <p className="hint">
          Committed {fmt(data.totals.committed_minor)} · expected {fmt(data.totals.expected_minor)} ({data.totals.expected_note}) · allocation{' '}
          {fmt(data.totals.allocation_minor)}
        </p>
      )}
      <form onSubmit={add}>
        <label>
          Paste rows: name, email, expected amount, terms label, note (one person per line; commas or tabs)
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />
        </label>
        <button type="submit" className="secondary">
          Add to the list
        </button>
      </form>
      {parsed && parsed.errors.length > 0 && (
        <ul className="problem" role="alert">
          {parsed.errors.map((e) => (
            <li key={e.line}>
              Line {e.line}: {e.message}
            </li>
          ))}
        </ul>
      )}
      {parsed && parsed.duplicates.length > 0 && <p className="warning">Listed more than once: {parsed.duplicates.join(', ')}</p>}
      <ul className="list">
        {data?.rows.map((r) => (
          <li key={r.id}>
            <span>
              {r.name} <span className="hint">{r.email}</span> {r.expected_minor && <span className="hint">{fmt(r.expected_minor)}</span>}{' '}
              <span className="pill">{r.status_label}</span>
            </span>
            {live && r.targeted_invite && (r.status === 'not_responded' || r.status === 'invited') && (
              <span className="row">
                <label>
                  Send again to
                  <input type="email" value={resendTo[r.id] ?? r.email} onChange={(e) => setResendTo({ ...resendTo, [r.id]: e.target.value })} />
                </label>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/deals/${dealId}/targeted/${r.targeted_invite}/resend`, 'POST', { email: (resendTo[r.id] ?? r.email).trim() })
                      setResendTo({ ...resendTo, [r.id]: undefined })
                      await reload()
                    })
                  }
                >
                  Send again
                </button>
              </span>
            )}
            {live && !r.targeted_invite && r.status === 'not_responded' && (
              <select
                aria-label={`Terms for ${r.name}`}
                value={chosen[r.id] ?? ''}
                onChange={(e) => (setChosen({ ...chosen, [r.id]: e.target.value }), setPlan(null))}
              >
                <option value="">Do not send</option>
                {usable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label || 'Terms'}: carry {l.carry}, {l.fee}
                  </option>
                ))}
              </select>
            )}
          </li>
        ))}
      </ul>
      {data && data.not_responded.length > 0 && <p className="hint">Not responded: {data.not_responded.join(', ')}</p>}
      {live && entries().length > 0 && (
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void run(async () => {
              const sent = entries()
              const r = await api<{ count: number; skipped: Array<{ name: string; why: string }>; by_terms: Record<string, number>; plan_sha256: string }>(
                `/api/deals/${dealId}/pipeline/preview`,
                'POST',
                { entries: sent },
              )
              setPlan({ ...r, entries: sent })
            })
          }
        >
          Check before sending
        </button>
      )}
      {plan && (
        <div className="notice" data-testid="send-plan">
          <p>
            {plan.count} invitation{plan.count === 1 ? '' : 's'} will be sent:{' '}
            {Object.entries(plan.by_terms)
              .map(([k, v]) => `${v} on ${k}`)
              .join('; ')}
            .
          </p>
          {plan.skipped.map((s) => (
            <p key={s.name} className="hint">
              {s.name}: {s.why}
            </p>
          ))}
          <button
            type="button"
            disabled={!plan.count}
            onClick={() =>
              void run(async () => {
                await api(`/api/deals/${dealId}/pipeline/invite`, 'POST', { entries: plan.entries, confirm_count: plan.count, plan_sha256: plan.plan_sha256 })
                setPlan(null)
                setChosen({})
                await reload()
              })
            }
          >
            Send {plan.count}
          </button>
        </div>
      )}
      <p>
        <a {...fileLink(`/api/deals/${dealId}/pipeline.csv`)}>Download the list</a>
      </p>
      <Problem error={error} />
    </div>
  )
}

function Messages({ dealId }: { dealId: string }) {
  const { data } = useData<{ messages: Array<{ id: string; body: string; author: string; created_at: string }> }>(`/api/deals/${dealId}/messages`)
  if (!data?.messages.length) return null
  return (
    <div>
      <h3>Messages from investors</h3>
      <ul className="list">
        {data.messages.map((m) => (
          <li key={m.id}>
            <span>
              <strong>{m.author}</strong>: {m.body}
            </span>
            <span className="hint">{m.created_at.slice(0, 10)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** R-SIG-02: the default deal sheet, read only, with each investor's details left blank. */
function SheetPreview({ dealId }: { dealId: string }) {
  const [sheet, setSheet] = useState<{ body: string; needs_deed: boolean; note: string } | null>(null)
  const { run, error } = useRun()
  return (
    <div>
      <h3>Deal sheet</h3>
      <button
        type="button"
        className="secondary"
        onClick={() =>
          void run(async () => setSheet(await api<{ body: string; needs_deed: boolean; note: string }>(`/api/deals/${dealId}/deal-sheet-preview`)))
        }
      >
        Preview the default deal sheet
      </button>
      {sheet && (
        <div data-testid="sheet-preview">
          <p className="hint">
            {sheet.note}
            {sheet.needs_deed ? ' It is signed as a deed, outside this site.' : ''}
          </p>
          <p className="legal mono">{sheet.body}</p>
        </div>
      )}
      <Problem error={error} />
    </div>
  )
}

/**
 * R-PIP-06: the operator's text on whom to invite, confirmed by this account per version before a list is imported or an
 * invitation sent. The words do not say that confirming makes anything compliant.
 */
function InviteePolicy({ dealId }: { dealId: string }) {
  const { data, reload } = useData<{
    text: { body: string; version: number; sha256: string; placeholder: boolean } | null
    confirmed: boolean
    confirmed_before: boolean
  }>(`/api/deals/${dealId}/invitee-policy`)
  const [read, setRead] = useState(false)
  const { error, run } = useRun()
  if (!data) return null
  if (!data.text) return <p className="hint">The operator has not written whom leads may invite, so no list can be imported and no invitation sent.</p>
  const text = data.text
  if (data.confirmed) return <p className="hint">You confirmed the operator’s text on whom you may invite (version {text.version}).</p>
  const confirm = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/deals/${dealId}/invitee-policy`, 'POST', { version: text.version, sha256: text.sha256 })
      setRead(false)
      await reload()
    })
  }
  return (
    <form onSubmit={confirm} data-testid="invitee-policy">
      <h3>Whom you may invite</h3>
      <p className="hint">
        {data.confirmed_before ? 'The operator changed this text. ' : ''}Read it and confirm before you add people to the list or send an invitation.
      </p>
      <p className="legal">{text.body}</p>
      <label className="check block">
        <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I have read this text (version {text.version}) and will invite only
        the people it allows
      </label>
      <button type="submit" className="secondary" disabled={!read}>
        Confirm
      </button>
      <Problem error={error} />
    </form>
  )
}

/** Once a deal has gone live it has a list of investors, figures and messages (D4). */
const LAUNCHED = ['live', 'closing_requested', 'closing', 'settled', 'closed', 'cancelled', 'archived']
const MESSAGES = ['live', 'closing_requested', 'closing']

/** Shown on the lead's deal page. The list can be prepared before launch; links and invitations only once live. */
export function LiveDealTools({ dealId, state }: { dealId: string; state: string }) {
  const live = state === 'live'
  const { data, reload } = useData<LinksData>(live ? `/api/deals/${dealId}/links` : null)
  // one counter: a message sent or a row changed reads the list and the archive again
  const [version, setVersion] = useState(0)
  const [single, setSingle] = useState<PanelRow | null>(null)
  const bump = () => setVersion((v) => v + 1)
  const email = (r: PanelRow) => {
    setSingle(r)
    document.getElementById('deal-mail')?.scrollIntoView()
  }
  return (
    <section className="card" data-testid="live-tools">
      <h2>Investors</h2>
      {state !== 'rejected' && <InviteePolicy dealId={dealId} />}
      {live && data && (
        <>
          <h3>Links</h3>
          <p className="hint">
            {data.active_count} of {data.max} links in use. Copy a link by hand from where it is shown.
          </p>
          <ul className="list">
            {data.links.map((l) => (
              <LinkItem key={l.id} dealId={dealId} l={l} onChange={() => void reload()} />
            ))}
          </ul>
          <ReachNote r={data.reach} />
          <NewLink dealId={dealId} data={data} onDone={() => void reload()} />
          <Targeted dealId={dealId} links={data.links} />
        </>
      )}
      {state !== 'rejected' && <Pipeline dealId={dealId} links={data?.links ?? []} live={live} />}
      {live && <SheetPreview dealId={dealId} />}
      {live && <Messages dealId={dealId} />}
      {LAUNCHED.includes(state) && <LeadPanel dealId={dealId} links={data?.links ?? []} onEmail={email} version={version} />}
      {MESSAGES.includes(state) && (
        <div id="deal-mail">
          <h3>Messages to investors</h3>
          <DealMail dealId={dealId} single={single} onClearSingle={() => setSingle(null)} version={version} onChange={bump} />
        </div>
      )}
    </section>
  )
}
