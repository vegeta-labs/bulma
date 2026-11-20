// D1 screens: account actions, two-step sign-in, entities, eligibility, the reviewer's queue. Words from the pack are shown as
// given. Warnings are never styled in a brand colour, never preselected and never smaller than the page (R-ELG-06).
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BANK_DETAILS_NEEDED, bankDetailsGiven, requiredFields, requiredFiles, type EntityType } from '../lib/entity.ts'
import { textParts } from '../lib/legalText.ts'
import qrcode from 'qrcode-generator'
import { bpsToPercent, percentToBps, wholePoundsToMinor, typedWhole } from '../lib/pounds.ts'
import { api, ApiError, uploadFile, type Blocker } from './api.ts'

export function Problem({ error }: { error: unknown }) {
  if (!error) return null
  const e = error as ApiError
  const blockers: Blocker[] = e.blockers ?? []
  const list = [...blockers.map((b) => b.message), ...(e.errors ?? [])]
  return (
    <div className="problem" role="alert">
      <p>{e.message}</p>
      {list.length > 0 && <ul>{list.map((m) => <li key={m}>{m}</li>)}</ul>}
    </div>
  )
}

export function useRun() {
  const [error, setError] = useState<unknown>(null)
  const run = useCallback(async (f: () => Promise<unknown>) => {
    setError(null)
    try {
      await f()
    } catch (x) {
      setError(x)
    }
  }, [])
  return { error, run }
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const reload = useCallback(() => {
    api<T>(path).then(setData, () => setData(null))
  }, [path])
  useEffect(reload, [reload])
  return { data, reload }
}

const Card = ({ title, children }: { title: string; children: ReactNode }) => <section className="card"><h2>{title}</h2>{children}</section>

export function Register({ onBack }: { onBack: () => void }) {
  const [f, setF] = useState({ first_name: '', last_name: '', email: '', password: '' })
  const [done, setDone] = useState<{ sandbox_link?: string } | null>(null)
  const { error, run } = useRun()
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  if (done) {
    return (
      <div className="card narrow">
        <h1>Check your email</h1>
        <p>We sent a link to confirm your address. You will need the password you just chose.</p>
        {done.sandbox_link && <p>In the sandbox no email leaves. <a href={done.sandbox_link} data-testid="sandbox-link">Open the link here</a>.</p>}
      </div>
    )
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => setDone(await api('/api/register', 'POST', f)))
  }
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Create an account</h1>
      <label>First name<input required autoComplete="given-name" value={f.first_name} onChange={set('first_name')} /></label>
      <label>Last name<input required autoComplete="family-name" value={f.last_name} onChange={set('last_name')} /></label>
      <label>Email<input type="email" required autoComplete="username" value={f.email} onChange={set('email')} /></label>
      <label>Password (12+ characters)<input type="password" required minLength={12} autoComplete="new-password" value={f.password} onChange={set('password')} /></label>
      <Problem error={error} />
      <div className="row"><button type="submit">Create account</button><button type="button" className="secondary" onClick={onBack}>Back to sign in</button></div>
    </form>
  )
}

export function Forgot({ onBack, sandbox }: { onBack: () => void; sandbox: boolean }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const { error, run } = useRun()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('/api/password/forgot', 'POST', { email })
      setSent(true)
    })
  }
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Forgot your password</h1>
      {sent
        ? <p data-testid="forgot-sent">If that address has an account, a link is on its way.{sandbox && ' In the sandbox no email leaves: an admin can read it in the outbox.'}</p>
        : <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>}
      <Problem error={error} />
      <div className="row">{!sent && <button type="submit">Send the link</button>}<button type="button" className="secondary" onClick={onBack}>Back to sign in</button></div>
    </form>
  )
}

/** The pages an emailed link opens. */
export function TokenPage({ path, token }: { path: string; token: string }) {
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  const { error, run } = useRun()
  const title: Record<string, string> = { '/verify-email': 'Confirm your email address', '/confirm-email': 'Confirm your new email address', '/party': 'Confirm your details', '/reset-password': 'Choose a new password' }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      if (path === '/reset-password') await api('/api/password/reset', 'POST', { token, password })
      else if (path === '/verify-email') await api('/api/verify-email', 'POST', { token, password })
      else if (path === '/confirm-email') await api('/api/account/email/confirm', 'POST', { token, password })
      else await api('/api/party-links/confirm', 'POST', { token })
      setDone(true)
    })
  }
  if (done) return <div className="card narrow"><h1>Done</h1><p><a href="/">Continue to sign in</a></p></div>
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>{title[path]}</h1>
      {path === '/reset-password' && <label>New password (12+ characters)<input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>}
      {path === '/verify-email' && <label>The password you chose when you registered<input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>}
      {path === '/confirm-email' && <label>The password of your account<input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>}
      <Problem error={error} />
      <button type="submit">Confirm</button>
    </form>
  )
}

export function CheckEmail() {
  const [sent, setSent] = useState<{ sandbox_link?: string } | null>(null)
  const { error, run } = useRun()
  return (
    <div className="card narrow">
      <h1>Check your email</h1>
      <p>Open the link we sent you to carry on.</p>
      <Problem error={error} />
      {sent ? <p role="status" data-testid="resent">A new link is on its way.{sent.sandbox_link && <> <a href={sent.sandbox_link}>Open it here</a> (sandbox).</>}</p>
        : <button type="button" className="secondary" onClick={() => run(async () => setSent(await api('/api/account/resend-verification', 'POST')))}>Send the link again</button>}
    </div>
  )
}

/** Drawn as squares, so nothing is injected into the page and the CSP stays as it is. */
function QrCode({ text }: { text: string }) {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  const n = q.getModuleCount()
  const cells: ReactNode[] = []
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(<rect key={`${r}-${c}`} x={c + 4} y={r + 4} width={1} height={1} />)
  return <svg className="qr" data-testid="mfa-qr" viewBox={`0 0 ${n + 8} ${n + 8}`} role="img" aria-label="QR code for your authenticator app"><rect className="qr-bg" width={n + 8} height={n + 8} />{cells}</svg>
}

export function MfaSetup({ required, onDone }: { required: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [secret, setSecret] = useState('')
  const [uri, setUri] = useState('')
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const { error, run } = useRun()
  if (recovery) {
    return (
      <div className="card narrow">
        <h1>Keep these recovery codes</h1>
        <p>Each one works once if you lose your authenticator. They will not be shown again.</p>
        <ul className="mono" data-testid="recovery">{recovery.map((r) => <li key={r}>{r}</li>)}</ul>
        <div className="row">
          <button type="button" className="secondary" onClick={() => {
            // no clipboard on plain http or under some browser policies: say so, so nobody leaves thinking they are kept
            try {
              void navigator.clipboard.writeText(recovery.join('\n')).then(() => setCopied('yes'), () => setCopied('no'))
            } catch {
              setCopied('no')
            }
          }}>Copy the codes</button>
          <button type="button" onClick={onDone}>I have kept them</button>
        </div>
        {copied && <p role="status" data-testid="copied">{copied === 'yes' ? 'Copied. Keep them somewhere other than this computer.' : 'Could not copy. Write them down or save them now.'}</p>}
      </div>
    )
  }
  return (
    <div className="card narrow">
      <h1>Set up two-step sign-in</h1>
      {required && <p>Your role needs this before you can do anything else.</p>}
      {!secret && (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ secret: string; uri: string }>('/api/mfa/start', 'POST', { password }); setUri(r.uri); setSecret(r.secret) }) }}>
          <label>Your password<input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button type="submit">Start</button>
        </form>
      )}
      {secret && (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => setRecovery((await api<{ recovery_codes: string[] }>('/api/mfa/confirm', 'POST', { code })).recovery_codes)) }}>
          <p>Scan this with your authenticator app, or type the key below it:</p>
          <QrCode text={uri} />  {/* the server's own link: this account's name, and the settings it checks codes with */}
          <p className="mono" data-testid="mfa-secret">{secret}</p>
          <label>Code from the app<input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button type="submit">Confirm</button>
        </form>
      )}
      <Problem error={error} />
    </div>
  )
}

interface PartyRow { name: string; email: string | null; kind: string; ownership_bps: number }
interface BankRow { id: string; holder: string; account_fields: Record<string, string>; status: string }
interface Entity {
  id: string; type: string; fields: Record<string, string>; status: string; gaps: string[]; return_reason: string | null; passed_on: string | null
  parties: Array<PartyRow & { id: string; verified_at: string | null }>
  files: Array<{ id: string; requirement: string; display_name: string }>
  bank: BankRow[]
}
const STATUS: Record<string, string> = { to_do: 'To do', in_progress: 'With the provider', in_review: 'In review', passed: 'Passed', returned: 'Sent back', expired: 'Expired', rejected: 'Cannot be used' }
const KINDS = ['director', 'owner', 'controller', 'representative']
const words = (s: string) => s.replaceAll('_', ' ')
// what a person reads as a label: the internal name made plain, with the few that need more than a capital
const LABELS: Record<string, string> = { kyc: 'Identity check', warning_block: 'Risk warning', tax_id: 'Tax ID', iban: 'IBAN', view_deal: 'See the deal', sign: 'Signing', commit: 'Commitment' }
const plain = (s: string) => LABELS[s] ?? words(s).replace(/^./, (c) => c.toUpperCase())

function PartiesEditor({ guidance, parties, onChange }: { guidance: string; parties: Array<{ name: string; email: string; kind: string; percent: string }>; onChange: (p: Array<{ name: string; email: string; kind: string; percent: string }>) => void }) {
  const set = (i: number, k: string, v: string) => onChange(parties.map((p, j) => (j === i ? { ...p, [k]: v } : p)))
  return (
    <fieldset data-testid="parties">
      <legend>{guidance}</legend>
      {parties.map((p, i) => (
        <div key={i} className="party">
          <label>Name<input required value={p.name} onChange={(e) => set(i, 'name', e.target.value)} /></label>
          <label>Email<input type="email" value={p.email} onChange={(e) => set(i, 'email', e.target.value)} /></label>
          <label>Role<select value={p.kind} onChange={(e) => set(i, 'kind', e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label>Share (%)<input inputMode="decimal" value={p.percent} onChange={(e) => set(i, 'percent', e.target.value)} /></label>
          <button type="button" className="secondary" onClick={() => onChange(parties.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" className="secondary" onClick={() => onChange([...parties, { name: '', email: '', kind: 'director', percent: '0' }])}>Add a person</button>
    </fieldset>
  )
}

const partiesFrom = (list: Array<{ name: string; email: string; kind: string; percent: string }>): PartyRow[] => list.map((p) => {
  const ownership_bps = percentToBps(p.percent || '0')
  if (ownership_bps === null) throw new Error(`The share for ${p.name || 'a person'} must be a percentage from 0 to 100.`)
  return { name: p.name, email: p.email.trim() || null, kind: p.kind, ownership_bps }
})

function EntityForm({ guidance, type, fields, parties, label, onSave }: { guidance: string; type: string; fields: Record<string, string>; parties: Array<{ name: string; email: string; kind: string; percent: string }>; label: string; onSave: (fields: Record<string, string>, parties: PartyRow[]) => Promise<unknown> }) {
  const [f, setF] = useState(fields)
  const [p, setP] = useState(parties)
  const { error, run } = useRun()
  const individual = type === 'individual'
  return (
    <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await onSave(f, individual ? [] : partiesFrom(p)); setF({}); setP([]) }) }}>
      {requiredFields(type as EntityType).map((k) => <label key={k}>{plain(k)}<input value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
      {!individual && <PartiesEditor guidance={guidance} parties={p} onChange={setP} />}
      <Problem error={error} />
      <button type="submit" className="secondary">{label}</button>
    </form>
  )
}

function BankForm({ e, reload, sandbox }: { e: Entity; reload: () => void; sandbox: boolean }) {
  const [holder, setHolder] = useState('')
  const [sort, setSort] = useState('')
  const [account, setAccount] = useState('')
  const [iban, setIban] = useState('')
  const [proof, setProof] = useState<File | null>(null)
  const { error, run } = useRun()
  const submit = (x: FormEvent) => {
    x.preventDefault()
    void run(async () => {
      const account_fields = Object.fromEntries(Object.entries({ sort_code: sort, account_number: account, iban }).filter(([, v]) => v.trim()))
      if (!bankDetailsGiven(account_fields)) throw new Error(BANK_DETAILS_NEEDED)
      const uploaded = proof ? await uploadFile(`/api/entities/${e.id}/files?requirement=bank_proof&name=${encodeURIComponent(proof.name)}`, proof) as { id: string } : null
      await api(`/api/entities/${e.id}/bank`, 'POST', { holder, account_fields, evidence_file: uploaded?.id ?? null })
      setHolder(''); setSort(''); setAccount(''); setIban(''); setProof(null)
      reload()
    })
  }
  return (
    <form onSubmit={submit} data-testid="bank-form">
      <h3>Bank account for refunds</h3>
      {sandbox && <p className="hint">This is a sandbox: use made-up details.</p>}
      <p className="hint">It must be in this entity's name. A person checks it. Changing it needs proof of the new account.</p>
      <label>Account holder<input required value={holder} onChange={(x) => setHolder(x.target.value)} /></label>
      <label>Sort code<input value={sort} onChange={(x) => setSort(x.target.value)} /></label>
      <label>Account number<input value={account} onChange={(x) => setAccount(x.target.value)} /></label>
      <label>IBAN<input value={iban} onChange={(x) => setIban(x.target.value)} /></label>
      <label>Proof of the account<input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(x) => setProof(x.target.files?.[0] ?? null)} /></label>
      <Problem error={error} />
      <button type="submit" className="secondary">Save the account</button>
    </form>
  )
}

interface KycRoutes { provider: boolean; uses_biometrics: boolean; consent_text: string | null; consent_format: string | null; consent_sha256: string | null }

function SendForReview({ e, reload, routes }: { e: Entity; reload: () => void; routes: KycRoutes | null }) {
  const [isTrue, setIsTrue] = useState(false)
  const [consent, setConsent] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const { error, run } = useRun()
  const send = (path: 'manual' | 'provider') => run(async () => {
    const r = await api<{ url?: string }>(`/api/entities/${e.id}/kyc`, 'POST', { path, confirm_true: true, ...(path === 'provider' ? { biometric_consent: consent, biometric_consent_sha256: routes?.consent_sha256 ?? undefined } : {}) })
    setLink(r.url ?? null)
    reload()
  })
  if (link) return <ProviderLink url={link} />
  return (
    <div>
      <label className="check"><input type="checkbox" checked={isTrue} onChange={(x) => setIsTrue(x.target.checked)} />This information is true</label>
      {routes?.provider && routes.uses_biometrics && <p className="legal" data-testid="biometric-consent"><LegalText body={routes.consent_text ?? ''} format={routes.consent_format ?? undefined} /></p>}
      {routes?.provider && routes.uses_biometrics && <label className="check"><input type="checkbox" checked={consent} onChange={(x) => setConsent(x.target.checked)} />I agree to this</label>}
      <Problem error={error} />
      <div className="row">
        <button type="button" disabled={!isTrue} onClick={() => send('manual')}>Send for review, no face scan</button>
        {routes?.provider && <button type="button" className="secondary" disabled={!isTrue || (routes.uses_biometrics && !consent)} onClick={() => send('provider')}>Check me through the provider</button>}
      </div>
    </div>
  )
}

const ProviderLink = ({ url }: { url: string }) => (
  <p data-testid="provider-link">Carry on at the provider, here or on your phone: <a href={url} target="_blank" rel="noreferrer">{url}</a></p>
)

function EntityCard({ guidance, e, reload, routes, sandbox }: { guidance: string; e: Entity; reload: () => void; routes: KycRoutes | null; sandbox: boolean }) {
  const [editing, setEditing] = useState(false)
  const [changingBank, setChangingBank] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const { error, run } = useRun()
  const usable = e.status !== 'rejected'
  const upload = (requirement: string, file: File | undefined) => {
    if (!file) return
    void run(async () => {
      await uploadFile(`/api/entities/${e.id}/files?requirement=${requirement}&name=${encodeURIComponent(file.name)}`, file)
      reload()
    })
  }
  const address = e.fields.address ?? e.fields.registered_address
  return (
    <li>
      <div className="entity" data-testid="entity">
        <strong>{e.fields.full_name ?? e.fields.name ?? 'Unnamed'}</strong>, {e.type}: <span data-testid="entity-status">{STATUS[e.status]}</span>
        {address && <p className="hint">{address}</p>}
        {e.passed_on && <p data-testid="passed-on">Document review passed ({e.passed_on}). Sanctions and PEP screening are the operator's, outside this software.</p>}
        {e.return_reason && <p className="hint">Sent back: {e.return_reason}</p>}
        {e.gaps.length > 0 && <p className="hint">Still needed: {e.gaps.map((g) => words(g.split(':')[1]!)).join(', ')}.</p>}
        {usable && requiredFiles(e.type as EntityType).map((r) => {
          const held = e.files.find((f) => f.requirement === r)
          return <label key={r}>{plain(r)}{held ? ` (added: ${held.display_name})` : ''}<input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(x) => upload(r, x.target.files?.[0])} /></label>
        })}
        {e.parties.map((p) => (
          <p key={p.id} className="row">{p.name}, {words(p.kind)}{p.ownership_bps ? `, ${bpsToPercent(p.ownership_bps)}%` : ''}{p.verified_at ? ', confirmed' : ''}
            {usable && !p.verified_at && p.email && <button type="button" className="secondary" onClick={() => run(async () => { await api(`/api/entities/${e.id}/parties/${p.id}/link`, 'POST'); setSent(`A link went to ${p.email}.${sandbox ? ' In the sandbox an admin reads it in the outbox.' : ''}`) })}>Send their link</button>}
          </p>
        ))}
        {sent && <p role="status" data-testid="party-sent">{sent}</p>}
        {e.bank.map((b) => <p key={b.id} data-testid="bank-row">Account in the name of {b.holder}: {Object.values(b.account_fields).join(', ')} ({b.status === 'confirmed' ? 'confirmed' : 'waiting for a person to check'})</p>)}
        <Problem error={error} />
        {e.gaps.length === 0 && ['to_do', 'returned', 'expired'].includes(e.status) && <SendForReview e={e} reload={reload} routes={routes} />}
        {e.status === 'in_progress' && link && <ProviderLink url={link} />}
        {e.status === 'in_progress' && !link && <button type="button" className="secondary" onClick={() => run(async () => setLink((await api<{ url: string }>(`/api/entities/${e.id}/kyc/link`, 'POST')).url))}>Get my link to the provider</button>}
        {usable && <button type="button" className="secondary" onClick={() => setEditing(!editing)}>{editing ? 'Stop changing' : 'Change these details'}</button>}
        {editing && (
          <>
            <p className="hint">Any change sends this back to be checked again.</p>
            <EntityForm guidance={guidance} type={e.type} fields={e.fields} parties={e.parties.map((p) => ({ name: p.name, email: p.email ?? '', kind: p.kind, percent: bpsToPercent(p.ownership_bps) }))} label="Save the changes"
              onSave={async (fields, parties) => { await api(`/api/entities/${e.id}`, 'PUT', { fields, parties }); setEditing(false); reload() }} />
          </>
        )}
        {usable && e.bank.length > 0 && !changingBank && <button type="button" className="secondary" onClick={() => setChangingBank(true)}>Change the bank account</button>}
        {usable && (e.bank.length === 0 || changingBank) && <BankForm e={e} reload={() => { setChangingBank(false); reload() }} sandbox={sandbox} />}
      </div>
    </li>
  )
}

function Entities({ guidance, preparation, sandbox }: { guidance: string; preparation?: { individual: { text: string }; company: { text: string } }; sandbox: boolean }) {
  const { data, reload } = useLoad<{ entities: Entity[] }>('/api/entities')
  const routes = useLoad<KycRoutes>('/api/kyc/routes')
  const [type, setType] = useState('individual')
  return (
    <Card title="Who you invest as">
      {preparation && <p className="hint" data-testid="prep-before-entity">{(type === 'individual' ? preparation.individual : preparation.company).text}</p>}
      <ul className="list">{data?.entities.map((e) => <EntityCard key={e.id} guidance={guidance} e={e} reload={reload} routes={routes.data} sandbox={sandbox} />)}</ul>
      <h3>Add one</h3>
      <label>Type
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="individual">Myself</option>
          <option value="company">A company</option>
          <option value="trust">A trust</option>
          <option value="other">Another entity</option>
        </select>
      </label>
      <EntityForm key={type} guidance={guidance} type={type} fields={{}} parties={[]} label="Add" onSave={async (fields, parties) => { await api('/api/entities', 'POST', { type, fields, parties }); reload() }} />
    </Card>
  )
}

interface Prep { overview: string; text: string; cooling_note: string | null; steps: number; coolingOffHours: number | null; minutes: Record<string, number>; reviewDays: number }
interface Eligibility {
  regime: string; qualified: boolean; next: string | null; steps: Array<{ kind: string; done: boolean }>; texts: Record<string, string>; ended: boolean
  notices: { not_qualified: string; assessment_not_passed: string; assessment_unavailable: string }
  assessment_used_up: boolean; party_guidance: string
  rounding: { income: string; net_assets: string }
  text_formats: Record<string, string>; left: boolean; shown_sha256: string
  preparation: { individual: Prep; company: { text: string } }
  assessment_locked_until: string | null; cooling_off_ends_at: string | null; cooling_off_over: boolean
}

type YN = '' | 'yes' | 'no'
function YesNo({ name, value, onChange, label, children }: { name: string; value: YN; onChange: (v: YN) => void; label: ReactNode; children?: ReactNode }) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <label className="check"><input type="radio" name={name} checked={value === 'yes'} onChange={() => onChange('yes')} />Yes</label>
      <label className="check"><input type="radio" name={name} checked={value === 'no'} onChange={() => onChange('no')} />No</label>
      {value === 'yes' && children}
    </fieldset>
  )
}

function Statement({ texts, formats, rounding, shown, onDone }: { texts: Record<string, string>; formats: Record<string, string>; rounding: Eligibility['rounding']; shown: string; onDone: () => void }) {
  const q = (key: string) => <LegalText body={texts[`question_${key}/default`] ?? ''} format={formats[`question_${key}/default`]} />
  const [category, setCategory] = useState<'' | 'high_net_worth' | 'sophisticated' | 'neither'>('')
  const [a, setA] = useState<Record<string, YN>>({})
  const [v, setV] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const { error, run } = useRun()
  const yn = (k: string) => a[k] ?? ''
  const setYn = (k: string) => (x: YN) => setA({ ...a, [k]: x })
  const text = (k: string, label: ReactNode, numeric = false) => <label>{label}<input inputMode={numeric ? 'numeric' : undefined} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></label>
  const pounds = (k: string, label: string) => {
    const minor = wholePoundsToMinor(v[k] ?? '')
    if (minor === null) throw new Error(`${label}: give whole pounds, with no pence, such as 250,000.`)
    return minor
  }
  const whole = (k: string, label: string) => {
    if (!/^\d{1,6}$/.test((v[k] ?? '').trim())) throw new Error(`${label}: give a whole number.`)
    return Number(v[k])
  }
  const named = (k: string, label: string) => {
    if (!(v[k] ?? '').trim()) throw new Error(`${label}: give the name.`)
    return v[k]!
  }
  const answersFor = () => {
    const asked = category === 'high_net_worth' ? ['income', 'assets'] : category === 'sophisticated' ? ['finance', 'director', 'investments', 'network'] : []
    if (asked.some((k) => !yn(k))) throw new Error('Answer each question.')
    const when = <T extends object>(k: string, more: () => T) => (yn(k) === 'yes' ? { yes: true as const, ...more() } : { yes: false as const })
    if (category === 'high_net_worth') return { category, high_net_worth: { income: when('income', () => ({ amount_minor: pounds('income_v', 'Income') })), net_assets: when('assets', () => ({ amount_minor: pounds('assets_v', 'Net assets') })) } }
    if (category === 'sophisticated') {
      return { category, sophisticated: {
        worked_in_private_finance: when('finance', () => ({ name: named('finance_v', 'Employer') })),
        director: when('director', () => ({ name: named('director_v', 'Company'), ...(v.number?.trim() ? { company_number: v.number } : {}) })),
        unlisted_investments: when('investments', () => ({ count: whole('investments_v', 'Investments') })),
        network_member: when('network', () => {
          const answer = yn('still_member')
          // asked only where the pack asks it, and never answered for the person
          if (texts['question_still_member/default'] && !answer) throw new Error('Answer each question.')
          return { name: named('network_v', 'Network'), months: whole('months', 'Months'), ...(answer ? { still_member: answer === 'yes' } : {}) }
        }),
      } }
    }
    return { category }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      try {
        await api('/api/eligibility/statement', 'POST', { answers: answersFor(), signed_name: name, shown_sha256: shown })
      } catch (x) {
        // new wording arrived: show it, keeping what was typed
        if ((x as ApiError).status === 409) onDone()
        throw x
      }
      onDone()
    })
  }
  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>Which describes you?</legend>
        {(['high_net_worth', 'sophisticated', 'neither'] as const).map((c) => (
          <label key={c} className="check"><input type="radio" name="category" checked={category === c} onChange={() => setCategory(c)} />{c === 'neither' ? 'None of these' : plain(c)}</label>
        ))}
      </fieldset>
      {category === 'high_net_worth' && (
        <>
          <YesNo name="income" label={q('income')} value={yn('income')} onChange={setYn('income')}>{text('income_v', `Income, to the nearest ${rounding.income}`, true)}</YesNo>
          <YesNo name="assets" label={q('net_assets')} value={yn('assets')} onChange={setYn('assets')}>{text('assets_v', `Net assets, to the nearest ${rounding.net_assets}`, true)}</YesNo>
        </>
      )}
      {category === 'sophisticated' && (
        <>
          <YesNo name="finance" label={q('private_finance')} value={yn('finance')} onChange={setYn('finance')}>{text('finance_v', 'Employer')}</YesNo>
          <YesNo name="director" label={q('director')} value={yn('director')} onChange={setYn('director')}>{text('director_v', 'Company')}{texts['question_company_number/default'] && text('number', q('company_number'))}</YesNo>
          <YesNo name="investments" label={q('unlisted_investments')} value={yn('investments')} onChange={setYn('investments')}>{text('investments_v', 'How many investments', true)}</YesNo>
          <YesNo name="network" label={q('network')} value={yn('network')} onChange={setYn('network')}>
            {text('network_v', 'Network or syndicate')}{text('months', 'Months a member', true)}
            {texts['question_still_member/default'] && <YesNo name="still_member" label={q('still_member')} value={yn('still_member')} onChange={setYn('still_member')} />}
          </YesNo>
        </>
      )}
      {category && <label>{category === 'neither' ? 'Your full name' : 'Your full name, as your signature'}<input required value={name} onChange={(e) => setName(e.target.value)} /></label>}
      <Problem error={error} />
      <button type="submit" disabled={!category}>Sign</button>
    </form>
  )
}

function Assessment({ onDone }: { onDone: () => void }) {
  const [attempt, setAttempt] = useState<{ id: string; questions: Array<{ id: string; prompt: string; options: string[] }> } | null>(null)
  const [answers, setAnswers] = useState<Record<string, number>>({})
  const { error, run } = useRun()
  if (!attempt) {
    return (
      <div>
        <Problem error={error} />
        <button type="button" onClick={() => run(async () => { setAnswers({}); setAttempt(await api('/api/eligibility/assessment/start', 'POST')) })}>Start the assessment</button>
      </div>
    )
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('/api/eligibility/assessment/answer', 'POST', { attempt_id: attempt.id, answers })
      setAttempt(null)
      onDone()
    })
  }
  return (
    <form onSubmit={submit}>
      {attempt.questions.map((q) => (
        <fieldset key={q.id}>
          <legend>{q.prompt}</legend>
          {q.options.map((o, i) => <label key={o} className="check"><input type="radio" name={q.id} checked={answers[q.id] === i} onChange={() => setAnswers({ ...answers, [q.id]: i })} />{o}</label>)}
        </fieldset>
      ))}
      <Problem error={error} />
      {/* an empty answer is a failed attempt, and two lock the assessment: not something to do by a slip */}
      <button type="submit" disabled={attempt.questions.some((q) => answers[q.id] === undefined)}>Send answers</button>
    </form>
  )
}

function PersonalisedWarning({ texts, formats, answer }: { texts: Record<string, string>; formats: Record<string, string>; answer: (decision: string) => Promise<void> }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => dialog.current?.focus(), [])
  return (
    <div className="modal-back">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pw-title" data-testid="personalised-warning" ref={dialog} tabIndex={-1}>
        <h2 id="pw-title">Before you go on</h2>
        {Object.entries(texts).filter(([k]) => k.startsWith('personalised_warning')).map(([k, v]) => <p key={k}><LegalText body={v} format={formats[k]} /></p>)}
        <details><summary>Risk summary</summary>{Object.entries(texts).filter(([k]) => k.startsWith('risk_summary')).map(([k, v]) => <p key={k}><LegalText body={v} format={formats[k]} /></p>)}</details>
        <div className="row equal">
          <button type="button" onClick={() => answer('leave')}>Leave</button>
          <button type="button" onClick={() => answer('continue')}>Continue</button>
        </div>
      </div>
    </div>
  )
}

/** Rendered as elements, so nothing in a pack can inject markup. */
function LegalText({ body, format }: { body: string; format?: string }) {
  if (format !== 'bold_markup') return <>{body}</>
  return <>{textParts(body).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : p.text))}</>
}

function EligibilityFlow() {
  const { data, reload } = useLoad<Eligibility>('/api/eligibility')
  // the deal list on the same page reads itself again once the checks are done (D3, Codex round 3)
  const qualified = !!data?.qualified
  useEffect(() => {
    if (qualified) window.dispatchEvent(new Event('bulma:eligibility'))
  }, [qualified])
  const [failed, setFailed] = useState(false)
  const [back, setBack] = useState(false)
  const { error, run } = useRun()
  if (!data) return null
  const away = data.left && !back
  const act = (path: string, body?: { decision?: string }) => run(async () => {
    // each new Leave counts, however many times the person came back
    if (body?.decision === 'leave') setBack(false)
    try {
      await api(path, 'POST', body)
    } finally {
      reload() // new wording, if that is why it was refused
    }
  })
  const warning = (kind: string, decision: string) => act('/api/eligibility/warning', { kind, decision, shown_sha256: data.shown_sha256 } as { decision: string })
  const prep = data.preparation.individual
  const left = data.steps.filter((s) => !s.done).length
  const failedNote = failed && <p role="status" data-testid="assessment-result">{data.notices.assessment_not_passed}</p>
  return (
    <>
      <Card title="Before you start">
        <div data-testid="preparation">
          <p>{prep.overview}</p>
          <p>If you invest yourself: {prep.text}</p>
          <p>If you invest through a company or trust: {data.preparation.company.text}</p>
          {Object.keys(prep.minutes).length > 0 && <><p className="hint">The ones that take longest:</p><ul data-testid="minutes">{Object.entries(prep.minutes).map(([k, m]) => <li key={k}>{plain(k)}: about {m} minutes</li>)}</ul></>}
          {prep.cooling_note && <p>{prep.cooling_note}</p>}
        </div>
      </Card>
      <Card title="Eligibility">
        <ol className="steps">{data.steps.map((s) => <li key={s.kind}>{plain(s.kind)}{s.done ? ' (done)' : ''}{s.kind === data.next ? ' (next)' : ''}</li>)}</ol>
        <p className="hint">{left === 0 ? '' : `${left} left. These are needed before you can see a deal.`}</p>
        <Problem error={error} />
        {data.ended && <p data-testid="ended">{data.notices.not_qualified}</p>}
        {!data.ended && data.qualified && <p data-testid="qualified">You have finished these steps.</p>}
        {!data.ended && (data.next === 'request_access' || data.next === 'cooling_off_start') && <button type="button" onClick={() => act('/api/eligibility/request')}>Ask to see deals</button>}
        {!data.ended && (data.next === 'statement' || data.next === 'classification') && (
          <>
            {Object.entries(data.texts).filter(([k]) => !k.startsWith('question_')).map(([k, v]) => <p key={k} className="legal"><LegalText body={v} format={data.text_formats[k]} /></p>)}
            <Statement texts={data.texts} formats={data.text_formats} rounding={data.rounding} shown={data.shown_sha256} onDone={reload} />
          </>
        )}
        {!data.ended && data.next === 'assessment' && !data.assessment_used_up && failedNote}
        {!data.ended && data.next === 'assessment' && data.assessment_used_up && <p data-testid="assessment-unavailable">{data.notices.assessment_unavailable}</p>}
        {!data.ended && data.next === 'assessment' && !data.assessment_used_up && (data.assessment_locked_until
          ? <p data-testid="locked">The assessment opens again on {new Date(data.assessment_locked_until).toLocaleString('en-GB')}.</p>
          : <Assessment onDone={() => { void api<Eligibility>('/api/eligibility').then((n) => setFailed(n.next === 'assessment')); reload() }} />)}
        {!data.ended && data.next === 'warning_block' && (
          <div className="warning-block">
            {Object.entries(data.texts).map(([k, v]) => <p key={k}><LegalText body={v} format={data.text_formats[k]} /></p>)}
            <button type="button" onClick={() => warning('warning_block', 'continue')}>I have read this</button>
          </div>
        )}
        {away && (
          <div data-testid="left">
            <p>You have left. Nothing more is asked of you, and you will not see any deals.</p>
            <button type="button" className="secondary" onClick={() => setBack(true)}>Go back to this step</button>
          </div>
        )}
        {!data.ended && !away && data.next === 'cooling_off_decision' && (data.cooling_off_over ? (
          <div className="row equal">
            <button type="button" onClick={() => act('/api/eligibility/cooling-off', { decision: 'continue' })}>Continue</button>
            <button type="button" onClick={() => act('/api/eligibility/cooling-off', { decision: 'leave' })}>Leave</button>
          </div>
        ) : <p data-testid="waiting">You can decide after {new Date(data.cooling_off_ends_at!).toLocaleString('en-GB')}.</p>)}
      </Card>
      {!data.ended && !away && data.next === 'personalised_warning' && <PersonalisedWarning texts={data.texts} formats={data.text_formats} answer={(decision) => warning('personalised_warning', decision)} />}
    </>
  )
}

interface Me { name: string; mfaOn: boolean; roles: string[] }

function Account({ me, onClosed, onChanged }: { me: Me; onClosed: () => void; onChanged: () => void }) {
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [email, setEmail] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [code, setCode] = useState('')
  const [emailSent, setEmailSent] = useState(false)
  const [password, setPassword] = useState('')
  const [closeCode, setCloseCode] = useState('')
  const [mfa, setMfa] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [changed, setChanged] = useState(false)
  const pass = useRun()
  const name = useRun()
  const change = useRun()
  const close = useRun()
  return (
    <Card title="Your account">
      <form onSubmit={(e) => { e.preventDefault(); void name.run(async () => { await api('/api/account/name', 'POST', { first_name: first, last_name: last }); setFirst(''); setLast(''); onChanged() }) }}>
        <h3>Change your name</h3>
        <p className="hint">You will need to sign your statement again.</p>
        <label>First name<input required value={first} onChange={(e) => setFirst(e.target.value)} /></label>
        <label>Last name<input required value={last} onChange={(e) => setLast(e.target.value)} /></label>
        <Problem error={name.error} />
        <button type="submit" className="secondary">Save the name</button>
      </form>
      <form onSubmit={(e) => { e.preventDefault(); void pass.run(async () => { setChanged(false); await api('/api/password', 'POST', { current, next }); setCurrent(''); setNext(''); setChanged(true) }) }}>
        <h3>Change your password</h3>
        <p className="hint">Your other sessions will end.</p>
        <label>Current password<input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label>New password (12+ characters)<input type="password" required minLength={12} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <Problem error={pass.error} />
        {changed && <p role="status" data-testid="password-changed">Your password is changed.</p>}
        <button type="submit" className="secondary">Change the password</button>
      </form>
      <form onSubmit={(e) => { e.preventDefault(); void change.run(async () => { await api('/api/account/email', 'POST', { email, password: emailPassword, ...(me.mfaOn ? { code } : {}) }); setEmailSent(true) }) }}>
        <h3>Change your email</h3>
        {emailSent ? <p role="status" data-testid="email-sent">If that address can be used, a link is on its way to it. Nothing changes until it is opened. You will then sign in again.</p> : (
          <>
            <label>New email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label>Your password, to change the email<input type="password" required autoComplete="current-password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} /></label>
            {me.mfaOn && <label>Code from your authenticator<input autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></label>}
            <Problem error={change.error} />
            <button type="submit" className="secondary">Send the link</button>
          </>
        )}
      </form>
      {!me.mfaOn && (mfa ? <MfaSetup required={false} onDone={onChanged} /> : <button type="button" className="secondary" onClick={() => setMfa(true)}>Turn on two-step sign-in</button>)}
      {me.roles.length === 0 && (
        <form onSubmit={(e) => { e.preventDefault(); void close.run(async () => { await api('/api/account/delete', 'POST', { password, ...(me.mfaOn ? { code: closeCode } : {}) }); onClosed() }) }}>
          <h3>Close my account</h3>
          <p className="hint">Records the law requires are kept until their retention ends, then deleted.</p>
          <label>Your password, to close the account<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {me.mfaOn && <label>Code from your authenticator, to close the account<input autoComplete="one-time-code" required value={closeCode} onChange={(e) => setCloseCode(e.target.value)} /></label>}
          <Problem error={close.error} />
          <button type="submit" className="secondary">Close my account</button>
        </form>
      )}
    </Card>
  )
}

export function InvestorHome({ me, sandbox, onClosed, onChanged }: { me: Me; sandbox: boolean; onClosed: () => void; onChanged: () => void }) {
  const prep = useLoad<Eligibility>('/api/eligibility')
  return (
    <>
      <EligibilityFlow />
      <Entities guidance={prep.data?.party_guidance ?? ''} preparation={prep.data?.preparation} sandbox={sandbox} />
      <Account me={me} onClosed={onClosed} onChanged={onChanged} />
    </>
  )
}

interface KycRow { id: string; type: string; fields: Record<string, string>; owner_name: string; provider: string; provider_suggestion: string | null; late_provider_result: string | null; status: string }
interface KycDetail {
  fields: Record<string, string>; owner_name: string; owner_email: string; information_confirmed_at: string | null; biometric_consent_at: string | null
  parties: Array<{ name: string; email: string | null; kind: string; ownership_bps: number; verified_at: string | null }>
  files: Array<{ id: string; requirement: string; display_name: string; gone: boolean }>
}

function CaseRow({ c, reload }: { c: KycRow; reload: () => void }) {
  const [detail, setDetail] = useState<KycDetail | null>(null)
  const [reason, setReason] = useState('')
  const { error, run } = useRun()
  const decide = (decision: 'approve' | 'return' | 'reject') => run(async () => {
    await api(`/api/review/kyc/${c.id}/decide`, 'POST', decision === 'approve' ? { decision } : { decision, reason })
    reload()
  })
  return (
    <li>
      <div>
        <strong>{c.fields.full_name ?? c.fields.name}</strong>, {c.type}, for {c.owner_name}
        {c.provider_suggestion && <p className="hint">Provider says: {words(c.provider_suggestion)}. The decision is yours.</p>}
        {c.late_provider_result && <p className="warning" data-testid="late-result">The provider said no after this moved on ({words(c.late_provider_result)}). Look again. Nothing has changed by itself.</p>}
        {!detail && <button type="button" className="secondary" onClick={() => run(async () => setDetail(await api(`/api/review/kyc/${c.id}`)))}>Open the case</button>}
        {detail && (
          <div data-testid="case-detail">
            <p>Account: {detail.owner_name}, {detail.owner_email}. {detail.information_confirmed_at ? 'They confirmed the information is true.' : ''}</p>
            <dl className="details">{Object.entries(detail.fields).map(([k, v]) => <div key={k}><dt>{plain(k)}</dt><dd>{v}</dd></div>)}</dl>
            {detail.parties.length > 0 && <ul>{detail.parties.map((p, i) => <li key={i}>{p.name}, {words(p.kind)}{p.ownership_bps ? `, ${bpsToPercent(p.ownership_bps)}%` : ''}{p.email ? `, ${p.email}` : ''}: {p.verified_at ? `confirmed through their link on ${p.verified_at.slice(0, 10)}` : 'not confirmed'}</li>)}</ul>}
            <ul data-testid="case-files">{detail.files.map((f) => <li key={f.id}>{plain(f.requirement)}: {f.gone ? `${f.display_name} (gone: sandbox files do not survive a restart)` : <a href={`/api/files/${f.id}`}>{f.display_name}</a>}</li>)}</ul>
          </div>
        )}
        {detail && <label>Reason, for sending back or refusing<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
        <Problem error={error} />
      </div>
      {detail && (
        <div className="row">
          <button type="button" onClick={() => decide('approve')}>{c.status === 'approved' ? 'Keep the pass' : 'Pass the documents'}</button>
          <button type="button" className="secondary" onClick={() => decide('return')}>Send back</button>
          <button type="button" className="secondary" onClick={() => decide('reject')}>Refuse for good</button>
        </div>
      )}
    </li>
  )
}

function BankQueue() {
  const { data, reload } = useLoad<{ accounts: Array<{ id: string; holder: string; account_fields: Record<string, string>; evidence_file: string | null; fields: Record<string, string>; owner_name: string; has_confirmed: boolean }> }>('/api/review/bank')
  const { error, run } = useRun()
  if (!data?.accounts.length) return null
  return (
    <Card title="Bank accounts waiting">
      <Problem error={error} />
      <ul className="list" data-testid="bank-queue">
        {data.accounts.map((b) => (
          <li key={b.id}>
            <div>
              <strong>{b.holder}</strong>, for {b.fields.full_name ?? b.fields.name} ({b.owner_name}){b.has_confirmed ? ', replacing a confirmed account' : ''}
              <p>{Object.entries(b.account_fields).map(([k, v]) => `${plain(k)}: ${v}`).join(', ')}</p>
              {b.evidence_file ? <a href={`/api/files/${b.evidence_file}`}>Proof of the account</a> : <p className="hint">No proof given.</p>}
            </div>
            <div className="row">
              <button type="button" onClick={() => run(async () => { await api(`/api/review/bank/${b.id}/decide`, 'POST', { decision: 'confirm' }); reload() })}>Confirm</button>
              <button type="button" className="secondary" onClick={() => run(async () => { await api(`/api/review/bank/${b.id}/decide`, 'POST', { decision: 'refuse' }); reload() })}>Refuse</button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ClosedStatements() {
  const { data, reload } = useLoad<{ people: Array<{ user_id: string; name: string; email: string; signed_on: string }> }>('/api/review/eligibility/closed')
  const [reason, setReason] = useState<Record<string, string>>({})
  const { error, run } = useRun()
  if (!data?.people.length) return null
  return (
    <Card title="Statements that did not qualify">
      <p className="hint">For someone who has contacted you, for instance after a mistake. Reopening lets them sign again; nothing is sent to them from here.</p>
      <Problem error={error} />
      <ul className="list" data-testid="closed-statements">
        {data.people.map((p) => (
          <li key={p.user_id}>
            <div>
              {p.name}, {p.email}, signed {p.signed_on}
              <label>Why reopen<input value={reason[p.user_id] ?? ''} onChange={(e) => setReason({ ...reason, [p.user_id]: e.target.value })} /></label>
            </div>
            <button type="button" className="secondary" onClick={() => run(async () => { await api(`/api/review/users/${p.user_id}/reopen-eligibility`, 'POST', { reason: reason[p.user_id] ?? '' }); reload() })}>Reopen</button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function ReviewQueue() {
  const { data, reload } = useLoad<{ cases: KycRow[] }>('/api/review/kyc')
  return (
    <>
      <Card title="Identity checks waiting">
        {!data?.cases.length && <p>Nothing is waiting.</p>}
        <ul className="list">{data?.cases.map((c) => <CaseRow key={c.id} c={c} reload={reload} />)}</ul>
      </Card>
      <BankQueue />
      <ClosedStatements />
    </>
  )
}

export function SandboxOutbox() {
  const { data, reload } = useLoad<{ mail: Array<{ id: string; to_address: string; subject: string; body: string; created_at: string }> }>('/api/sandbox/outbox')
  const path = (body: string) => /\/[a-z-]+\?token=[\w-]+/.exec(body)?.[0]
  return (
    <Card title="Sandbox outbox">
      <p className="hint">No email leaves a sandbox. This is what would have been sent. Links here act on someone's account, so only admins see them.</p>
      <button type="button" className="secondary" onClick={reload}>Refresh</button>
      <ul className="list" data-testid="outbox">
        {data?.mail.map((m) => <li key={m.id}><div><strong>{m.subject}</strong>, to {m.to_address}{path(m.body) ? <p><a href={path(m.body)}>Open the link</a></p> : <p>{m.body}</p>}</div></li>)}
      </ul>
    </Card>
  )
}

export function RetentionSettings() {
  const { data } = useLoad<{ relationship_years: number; idle_months: number; kyc_valid_years: number; transaction_years: number }>('/api/retention-config')
  const [f, setF] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState('')
  const { error, run } = useRun()
  if (!data) return null
  const value = (k: keyof typeof data) => f[k] ?? String(data[k])
  const field = (k: keyof typeof data, label: string) => <label>{label}<input inputMode="numeric" required value={value(k)} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const period = (k: keyof typeof data) => {
        const n = typedWhole(value(k))
        if (n === null) throw new Error('Give each period as a whole number. Nothing was changed.')
        return n
      }
      const r = await api<{ requestId?: string }>('/api/retention-config', 'PUT', { relationship_years: period('relationship_years'), idle_months: period('idle_months'), kyc_valid_years: period('kyc_valid_years'), transaction_years: period('transaction_years') })
      setSaved(r.requestId ? 'Sent. It takes effect when a second admin approves it.' : 'Saved.')
    })
  }
  return (
    <Card title="How long things are kept">
      <form onSubmit={submit}>
        {field('relationship_years', 'Years after a relationship ends')}
        {field('idle_months', 'Months without sign-in that end a relationship')}
        {field('kyc_valid_years', 'Years an identity check stays valid')}
        {field('transaction_years', 'Years payment details are kept, counted from each payment (at most 10)')}
        <Problem error={error} />
        {saved && <p role="status">{saved}</p>}
        <button type="submit" className="secondary">Save</button>
      </form>
    </Card>
  )
}
