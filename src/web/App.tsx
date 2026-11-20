// Operator console for D0. Investor and lead screens arrive with D1 to D4. All text is ours; nothing is inlined (CSP).
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError, setCsrf, type Blocker } from './api.ts'
import { CheckEmail, Forgot, InvestorHome, MfaSetup, Register, RetentionSettings, ReviewQueue, SandboxOutbox, TokenPage } from './Investor.tsx'
import { CountryForm, InvitePage, MyDealPage, MyDeals, MyDocuments, VerifyInstructionPage } from './Invest.tsx'
import { HoldsSection, LinkApprovals, MoneyDeals, PolicySection, ReceiptsSection, ReceivingAccountSection, TemplateApprovals, TemplateSection } from './Ops.tsx'
import { typedWhole } from '../lib/pounds.ts'
import { DealPage, DealsHome } from './Deals.tsx'
import { Link, usePath } from './DealShared.tsx'
import { ApprovalQueue, ContentApproval, DealQueue, DealReview, DealSettings } from './Review.tsx'
import { ChangeApproval, ChangeApprovalQueue } from './DealChange.tsx'
import { MailApprovals, MyMail } from './Mail.tsx'
import { MailTemplatesSection, MailWordingApprovals } from './MailWording.tsx'
import { MyComplaints, OpsDeal, OpsHome } from './Work.tsx'
import { OpsMoney } from './Money.tsx'
import { InvesteePage, JoinSyndicate, SyndicatePage, SyndicatesHome } from './Syndicates.tsx'

interface User { id: string; email: string; name: string; roles: string[]; mustChangePassword: boolean; emailVerified: boolean; mfaOn: boolean }
interface Notice { mode: 'sandbox' | 'real'; banner: string | null; version: string }
interface Instance {
  mode: string; regulatory_status: string | null; accountable_person: string | null; accountable_confirmed_on: string | null; active_pack: string; blockers: Blocker[]
  switch_warning: string; accountable_label: string; accountable_note: string
}
interface Req { id: string; kind: string; status: string; requested_by: string; requested_by_name: string; decided_by_name: string | null; single_admin_exception: boolean; details: Array<{ label: string; value: string }> }
interface Pack { id: string; key: string; version: number; regime: string; active: boolean; placeholders: string[]; author_note: { as_of: string; text: string; known_open_questions: string[] }; steps: string[] }
interface Person { id: string; email: string; name: string; roles: string[]; disabled_at: string | null; mfa_on: boolean }
interface Fee { version: number; rate_bps: number; min_minor: string; max_minor: string; surcharge_threshold_minor: string; surcharge_bps: number }

const KIND: Record<string, string> = { mode_switch: 'Switch to the real mode', profile_change: 'Change the operator profile', pack_activate: 'Activate a regime pack', role_change: 'Change a role', user_disable: 'Disable an account', mfa_reset: 'Clear two-step sign-in', retention_config: 'Change how long things are kept', retention_hold_off: 'Lift a retention hold' }
const STATUS_LABEL: Record<string, string> = { authorised_firm: 'Authorised firm', unauthorised_relying_on_exemption: 'Unauthorised, says it relies on an exemption (the software has not checked)', appointed_representative: 'Appointed representative (not an authorised firm)' }

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    api<T>(path).then(setData, (e: Error) => setError(e.message))
  }, [path])
  useEffect(reload, [reload])
  return { data, error, reload }
}

function Problem({ error }: { error: unknown }) {
  if (!error) return null
  const e = error as ApiError
  return (
    <div className="problem" role="alert">
      <p>{e.message}</p>
      {e.blockers?.length || e.errors?.length ? <ul>{[...(e.blockers ?? []).map((b) => b.message), ...(e.errors ?? [])].map((m) => <li key={m}>{m}</li>)}</ul> : null}
    </div>
  )
}

function SignIn({ onIn, sandbox }: { onIn: (u: User) => void; sandbox: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needCode, setNeedCode] = useState(false)
  const [other, setOther] = useState<'register' | 'forgot' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const r = await api<{ csrf: string; user: User }>('/api/login', 'POST', { email, password, ...(needCode ? { code } : {}) })
      setCsrf(r.csrf)
      onIn(r.user)
    } catch (x) {
      if ((x as ApiError).mfaRequired) setNeedCode(true)
      else setError(x)
    }
  }
  if (other === 'register') return <Register onBack={() => setOther(null)} />
  if (other === 'forgot') return <Forgot sandbox={sandbox} onBack={() => setOther(null)} />
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Sign in</h1>
      <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {needCode && <label>Code from your authenticator, or a recovery code<input autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></label>}
      <Problem error={error} />
      <div className="row">
        <button type="submit">Sign in</button>
        <button type="button" className="secondary" onClick={() => setOther('register')}>Create an account</button>
        <button type="button" className="secondary" onClick={() => setOther('forgot')}>Forgot password</button>
      </div>
    </form>
  )
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<unknown>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api('/api/password', 'POST', { current, next })
      onDone()
    } catch (x) {
      setError(x)
    }
  }
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Choose a new password</h1>
      <p>Your password was temporary. Choose one with at least 12 characters.</p>
      <label>Current password<input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
      <label>New password<input type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} /></label>
      <Problem error={error} />
      <button type="submit">Save</button>
    </form>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card"><h2>{title}</h2>{children}</section>
}

function ModeSection({ version, onChange }: { version: number; onChange: () => void }) {
  const { data, reload } = useLoad<Instance>('/api/instance')
  useEffect(reload, [version, reload])
  const [status, setStatus] = useState('')
  const [person, setPerson] = useState('')
  const [on, setOn] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [sent, setSent] = useState(false)
  if (!data) return null
  const body = { regulatory_status: status || null, accountable_person: person || null, accountable_confirmed_on: on || null }
  const send = async (path: string) => {
    setError(null)
    setSent(false)
    try {
      await api(path, 'POST', body)
      setSent(true)
      reload()
      onChange()
    } catch (x) {
      setError(x)
    }
  }
  return (
    <Section title="Instance mode">
      <p>Mode: <strong data-testid="mode">{data.mode === 'real' ? 'Real' : 'Sandbox'}</strong>. Active pack: <span data-testid="active-pack">{data.active_pack}</span>.</p>
      {data.mode === 'sandbox' && data.blockers.length > 0 && (
        <>
          <h3>Still missing for the real mode</h3>
          <ul data-testid="blockers">{data.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>
        </>
      )}
      <p className="warning" data-testid="switch-warning">{data.switch_warning}</p>
      <form onSubmit={(e) => e.preventDefault()}>
        <label>Regulatory status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Choose</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>{data.accountable_label}<input value={person} maxLength={200} onChange={(e) => setPerson(e.target.value)} /></label>
        <p className="hint">{data.accountable_note}</p>
        <label>Date they confirmed<input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></label>
        <Problem error={error} />
        {sent && <p role="status">Sent. It takes effect when an admin approves it below.</p>}
        <div className="row">
          <button type="button" onClick={() => send('/api/requests/profile')}>Save the profile</button>
          {data.mode === 'sandbox' && <button type="button" className="secondary" onClick={() => send('/api/requests/mode-switch')}>Ask to switch to the real mode</button>}
        </div>
      </form>
    </Section>
  )
}

function RequestsSection({ me, version, onChange }: { me: User; version: number; onChange: () => void }) {
  const { data, reload } = useLoad<{ requests: Req[] }>('/api/requests')
  const [error, setError] = useState<unknown>(null)
  useEffect(reload, [version, reload])
  const decide = async (id: string, what: 'approve' | 'reject') => {
    setError(null)
    try {
      await api(`/api/requests/${id}/${what}`, 'POST')
      onChange()
    } catch (x) {
      setError(x)
    }
  }
  return (
    <Section title="Changes waiting for an admin">
      <Problem error={error} />
      {!data?.requests.length && <p>Nothing has been asked yet.</p>}
      <ul className="list">
        {data?.requests.map((r) => (
          <li key={r.id}>
            <div>
              <span>{KIND[r.kind] ?? r.kind}, asked by {r.requested_by === me.id ? 'you' : r.requested_by_name}: <strong>{r.status}</strong>{r.decided_by_name ? ` by ${r.decided_by_name}` : ''}{r.single_admin_exception ? ' (single-admin sandbox)' : ''}</span>
              <dl className="details">{r.details.map((d) => <div key={d.label}><dt>{d.label}</dt><dd>{d.value}</dd></div>)}</dl>
            </div>
            {r.status === 'pending' && (
              <span className="row">
                <button type="button" onClick={() => decide(r.id, 'approve')}>Approve</button>
                <button type="button" className="secondary" onClick={() => decide(r.id, 'reject')}>Reject</button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}

function PacksSection({ version, onChange }: { version: number; onChange: () => void }) {
  const { data, reload } = useLoad<{ format_passed: string; packs: Pack[] }>('/api/packs')
  const [json, setJson] = useState('')
  const [error, setError] = useState<unknown>(null)
  useEffect(reload, [version, reload])
  const activate = async (pack_id: string) => {
    setError(null)
    try {
      await api('/api/requests/pack-activate', 'POST', { pack_id })
      onChange()
    } catch (x) {
      setError(x)
    }
  }
  const upload = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api('/api/packs', 'POST', JSON.parse(json))
      setJson('')
      reload()
    } catch (x) {
      setError(x instanceof SyntaxError ? new Error('That is not valid JSON.') : x)
    }
  }
  return (
    <Section title="Regime packs">
      <p className="hint" data-testid="format-passed">{data?.format_passed}</p>
      <Problem error={error} />
      <ul className="list">
        {data?.packs.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{p.key}</strong> version {p.version}{p.active ? ' (active)' : ''}
              <p className="hint">{p.author_note.text} As of {p.author_note.as_of}.</p>
              <details><summary>Open questions and steps</summary>
                <ul>{p.author_note.known_open_questions.map((q) => <li key={q}>{q}</li>)}</ul>
                <p>{p.steps.join(' → ')}</p>
              </details>
              {p.placeholders.length > 0 && <p className="hint">{p.placeholders.length} placeholder texts still to replace.</p>}
            </div>
            {!p.active && <button type="button" className="secondary" onClick={() => activate(p.id)}>Ask to activate</button>}
          </li>
        ))}
      </ul>
      <form onSubmit={upload}>
        <label>Add a pack (JSON)<textarea rows={4} value={json} onChange={(e) => setJson(e.target.value)} /></label>
        <button type="submit" className="secondary" disabled={!json.trim()}>Check and add</button>
      </form>
    </Section>
  )
}

function PeopleSection({ me, onChange, version }: { me: User; onChange: () => void; version: number }) {
  const { data, reload } = useLoad<{ users: Person[] }>('/api/users')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  useEffect(reload, [version, reload])
  const run = async (f: () => Promise<unknown>) => {
    setError(null)
    try {
      await f()
      reload()
      onChange()
    } catch (x) {
      setError(x)
    }
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('/api/users', 'POST', { email, name, password })
      setEmail('')
      setName('')
      setPassword('')
    })
  }
  return (
    <Section title="People and roles">
      <Problem error={error} />
      <ul className="list">
        {data?.users.map((u) => (
          <li key={u.id}>
            <span>{u.name}{u.id === me.id ? ' (you)' : ''}, {u.email}{u.disabled_at ? ', disabled' : ''}</span>
            {!u.disabled_at && (
              <span className="row">
                {(['admin', 'reviewer', 'approver'] as const).map((role) => (
                  <label key={role} className="check">
                    <input type="checkbox" checked={u.roles.includes(role)} onChange={(e) => run(() => api(`/api/users/${u.id}/roles/${role}`, e.target.checked ? 'PUT' : 'DELETE'))} />
                    {role}
                  </label>
                ))}
                {u.mfa_on && <button type="button" className="secondary" onClick={() => run(() => api(`/api/users/${u.id}/mfa-reset`, 'POST'))}>Clear their two-step</button>}
              </span>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={add}>
        <h3>Add a person</h3>
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Temporary password (12+ characters)<input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button type="submit" className="secondary">Add</button>
      </form>
    </Section>
  )
}

function FeesSection() {
  const { data, reload } = useLoad<{ fee_config: Fee | null }>('/api/fee-config')
  const [f, setF] = useState({ rate_bps: '0', min_minor: '0', max_minor: '0', surcharge_threshold_minor: '0', surcharge_bps: '0' })
  const [error, setError] = useState<unknown>(null)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const rate = typedWhole(f.rate_bps)
      const surcharge = typedWhole(f.surcharge_bps)
      if (rate === null || surcharge === null) throw new Error('Give each rate as a whole number of basis points.')
      await api('/api/fee-config', 'POST', { ...f, rate_bps: rate, surcharge_bps: surcharge })
      reload()
    } catch (x) {
      setError(x)
    }
  }
  const field = (k: keyof typeof f, label: string) => (
    <label>{label}<input inputMode="numeric" required value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  )
  return (
    <Section title="Platform fee">
      <p>{data?.fee_config ? `Version ${data.fee_config.version}: ${data.fee_config.rate_bps} bps, minimum ${data.fee_config.min_minor}, maximum ${data.fee_config.max_minor} (minor units).` : 'Not configured. The software ships with no price.'}</p>
      <form onSubmit={save}>
        {field('rate_bps', 'Rate (basis points)')}
        {field('min_minor', 'Minimum (minor units)')}
        {field('max_minor', 'Maximum (minor units)')}
        {field('surcharge_threshold_minor', 'Surcharge threshold (minor units)')}
        {field('surcharge_bps', 'Surcharge rate (basis points)')}
        <Problem error={error} />
        <button type="submit" className="secondary">Save a new version</button>
      </form>
    </Section>
  )
}

function AuditSection({ version }: { version: number }) {
  const verify = useLoad<{ ok: boolean; count?: number; badSeq?: number }>('/api/audit/verify')
  const head = useLoad<{ head: { seq: number; hash: string } | null }>('/api/audit/head')
  useEffect(() => {
    verify.reload()
    head.reload()
  }, [version]) // eslint-disable-line
  return (
    <Section title="Audit log">
      <p data-testid="audit-state">{verify.data?.ok ? `Chain checks out: ${verify.data.count} records.` : verify.data ? `Chain broken at record ${verify.data.badSeq}.` : ''}</p>
      <p className="hint">This finds tampering; it cannot prevent it. Export the head below and keep it somewhere the database's operators cannot change.</p>
      <p className="mono">{head.data?.head ? `${head.data.head.seq} ${head.data.head.hash}` : ''}</p>
    </Section>
  )
}

export function App() {
  const [notice, setNotice] = useState<Notice | null>(null)
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])
  const loadSession = useCallback(() => {
    api<{ user: User; csrf: string }>('/api/session').then((s) => {
      setCsrf(s.csrf)
      setUser(s.user)
    }, () => setUser(null))
  }, [])
  useEffect(() => {
    api<Notice>('/api/instance/notice').then(setNotice, () => setNotice(null))
    loadSession()
  }, [loadSession, version])
  const out = async () => {
    await api('/api/logout', 'POST')
    setUser(null)
  }
  const isAdmin = !!user?.roles.includes('admin')
  // the operations page: reviewers and admins (gate canRunOperations; two-step sign-in is already needed for any role here)
  const isStaff = isAdmin || !!user?.roles.includes('reviewer')
  const path = usePath()
  // read once: a page may take the token out of the address bar (the invitation does), and a re-render must not lose it;
  // it belongs to the page it came with, so moving to another page leaves it behind
  const [loaded] = useState(() => ({ path: window.location.pathname, token: new URLSearchParams(window.location.search).get('token') }))
  const token = path === loaded.path ? loaded.token : null
  const joining = path === '/join-syndicate' && !!token
  const linkPage = !!token && !joining
  const under = (root: string) => path === root || path.startsWith(`${root}/`)
  // a page this person has no role for is the home page, not an empty one
  const home = !under('/deals') && !under('/invest') && !under('/money') && !under('/syndicates') && !(under('/review') && user?.roles.includes('reviewer')) && !(under('/approvals') && user?.roles.includes('approver')) && !(under('/ops') && isStaff)
  const inPath = (root: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null)
  const live = !!user && !user.mustChangePassword && user.emailVerified
  const needsMfa = live && user.roles.length > 0 && !user.mfaOn
  const ready = live && !needsMfa
  return (
    <>
      {/* §5.5: a promotional page puts its warning here, before the banner, the logo and the navigation */}
      <div id="promotion-top" />
      {notice?.banner && <div className="banner" role="status" data-testid="sandbox-banner">{notice.banner}</div>}
      <header className="top">
        <span><strong>Bulma</strong> — SPV Workspace</span>
        {user && <span className="row"><span>{user.name}</span><button type="button" className="secondary" onClick={out}>Sign out</button></span>}
      </header>
      {ready && !linkPage && (
        <nav className="nav" aria-label="Main">
          <Link to="/">Home</Link>
          <Link to="/deals">Deals</Link>
          <Link to="/syndicates">Syndicates</Link>
          {user.roles.includes('reviewer') && <Link to="/review">Deal review</Link>}
          {user.roles.includes('approver') && <Link to="/approvals">Content approval</Link>}
          {isStaff && <Link to="/ops">Operations</Link>}
        </nav>
      )}
      <main>
        {linkPage ? (path === '/investee' ? <InvesteePage token={token} /> : path === '/invite' ? <InvitePage token={token} signedIn={!!user} /> : path === '/verify-instruction' ? <VerifyInstructionPage token={token} /> : <TokenPage path={window.location.pathname} token={token} />) : (
        <>
        {joining && user === null && <p className="card narrow" data-testid="join-signin">Sign in to join the syndicate. If you need to create an account first, open this link again once you have.</p>}
        {user === null && <SignIn sandbox={notice?.mode === 'sandbox'} onIn={(u) => { setUser(u); bump() }} />}
        {user?.mustChangePassword && <ChangePassword onDone={loadSession} />}
        {user && !user.mustChangePassword && !user.emailVerified && <CheckEmail />}
        {needsMfa && <MfaSetup required onDone={loadSession} />}
        {ready && joining && <JoinSyndicate token={token} />}
        {ready && !joining && path === '/deals' && <DealsHome />}
        {ready && !joining && inPath('/deals') && <DealPage key={path} id={inPath('/deals')!} />}
        {ready && !joining && path === '/syndicates' && <SyndicatesHome />}
        {ready && !joining && inPath('/syndicates') && <SyndicatePage key={path} id={inPath('/syndicates')!} me={user.id} />}
        {ready && !joining && user.roles.includes('reviewer') && path === '/review' && <DealQueue />}
        {ready && !joining && user.roles.includes('reviewer') && inPath('/review') && <DealReview key={path} id={inPath('/review')!} />}
        {ready && !joining && (user.roles.includes('reviewer') || isAdmin) && inPath('/money') && <ReceiptsSection key={`r${path}`} dealId={inPath('/money')!} />}
        {ready && !joining && user.roles.includes('reviewer') && inPath('/review') && <ReceiptsSection key={`r${path}`} dealId={inPath('/review')!} />}
        {ready && !joining && user.roles.includes('reviewer') && inPath('/review') && <HoldsSection key={`h${path}`} dealId={inPath('/review')!} />}
        {ready && !joining && isStaff && path === '/ops' && <OpsHome me={user.id} />}
        {ready && !joining && isStaff && path === '/ops/money' && <OpsMoney me={user.id} />}
        {ready && !joining && isStaff && inPath('/ops') && path !== '/ops/money' && <OpsDeal key={path} id={inPath('/ops')!} />}
        {ready && !joining && inPath('/invest') && <MyDealPage key={path} id={inPath('/invest')!} />}
        {ready && !joining && user.roles.includes('approver') && path === '/approvals' && <ApprovalQueue />}
        {ready && !joining && user.roles.includes('approver') && path === '/approvals' && <ChangeApprovalQueue />}
        {ready && !joining && user.roles.includes('approver') && path === '/approvals' && <MailApprovals />}
        {ready && !joining && user.roles.includes('approver') && path === '/approvals' && <MailWordingApprovals />}
        {ready && !joining && user.roles.includes('approver') && inPath('/approvals/changes') && <ChangeApproval key={path} cid={inPath('/approvals/changes')!} />}
        {ready && !joining && user.roles.includes('approver') && inPath('/approvals') && !inPath('/approvals/changes') && <ContentApproval key={path} id={inPath('/approvals')!} />}
        {ready && !joining && home && user.roles.includes('reviewer') && <ReviewQueue />}
        {ready && !joining && home && user.roles.includes('reviewer') && <LinkApprovals />}
        {ready && !joining && home && (user.roles.includes('reviewer') || isAdmin) && <MoneyDeals />}
        {ready && !joining && home && user.roles.includes('approver') && <TemplateApprovals />}
        {ready && !joining && home && user.roles.includes('reviewer') && <HoldsSection />}
        {ready && !joining && home && isAdmin && (
          <>
            <ModeSection version={version} onChange={bump} />
            <RequestsSection me={user} version={version} onChange={bump} />
            <PacksSection version={version} onChange={bump} />
            <PeopleSection me={user} version={version} onChange={bump} />
            <FeesSection />
            <DealSettings />
            <PolicySection />
            <TemplateSection />
            <MailTemplatesSection />
            <ReceivingAccountSection />
            <AuditSection version={version} />
            <RetentionSettings />
            {notice?.mode === 'sandbox' && <SandboxOutbox />}
          </>
        )}
        {ready && !joining && home && <MyDeals />}
        {ready && !joining && home && <MyMail />}
        {ready && !joining && home && <MyDocuments />}
        {ready && !joining && home && <MyComplaints />}
        {ready && !joining && home && <CountryForm />}
        {ready && !joining && home && <InvestorHome me={user} sandbox={notice?.mode === 'sandbox'} onClosed={() => setUser(null)} onChanged={loadSession} />}
        </>
        )}
      </main>
    </>
  )
}
