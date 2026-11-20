// Syndicate pages, the member link, and the page a company uses to send its documents (no account needed).
import { useEffect, useState, type FormEvent } from 'react'
import { markupToRichText, richTextToMarkup } from '../lib/richText.ts'
import { api, uploadFile } from './api.ts'
import { DOCUMENT_WORDS, go, INVESTEE_WORDS, Link, RichView, STATE_WORDS, useData } from './DealShared.tsx'
import { Problem, useRun } from './Investor.tsx'

interface Row {
  id: string
  name: string
  status: string
  role: string
}

export function SyndicatesHome() {
  const { data, error } = useData<{ managed: Row[]; joined: Row[] }>('/api/syndicates')
  const entities = useData<{ entities: Array<{ id: string; type: string; fields: Record<string, string> }> }>('/api/entities')
  const [name, setName] = useState('')
  const [entity, setEntity] = useState('')
  const { error: actionError, run } = useRun()
  const create = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const { id } = await api<{ id: string }>('/api/syndicates', 'POST', { name, lead_entity_id: entity })
      go(`/syndicates/${id}`)
    })
  }
  const list = (rows: Row[] | undefined, testid: string) => (
    <ul className="list" data-testid={testid}>
      {rows?.map((s) => (
        <li key={s.id}>
          <Link to={`/syndicates/${s.id}`}>{s.name}</Link>
          {s.status === 'archived' && <span className="pill">Archived</span>}
        </li>
      ))}
    </ul>
  )
  return (
    <>
      <section className="card">
        <h1>Syndicates</h1>
        <Problem error={error} />
        <h2>I manage</h2>
        {data && !data.managed.length && <p className="hint">None yet.</p>}
        {list(data?.managed, 'syndicates-managed')}
        <h2>I have joined</h2>
        {data && !data.joined.length && <p className="hint">None yet.</p>}
        {list(data?.joined, 'syndicates-joined')}
      </section>
      <form className="card" onSubmit={create}>
        <h2>Create a syndicate</h2>
        <label>
          Name *
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Lead entity *
          <select required value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Choose</option>
            {entities.data?.entities.map((x) => (
              <option key={x.id} value={x.id}>
                {x.fields.full_name ?? x.fields.legal_name ?? x.fields.name ?? x.type}
              </option>
            ))}
          </select>
        </label>
        {entities.data && !entities.data.entities.length && <p className="hint">Add an investing entity on your home page first.</p>}
        <Problem error={actionError} />
        <button type="submit" className="secondary">
          Create the syndicate
        </button>
      </form>
    </>
  )
}

interface Page {
  id: string
  name: string
  thesis: unknown
  status: string
  role: string
  team: Array<{ user_id: string; role: string; name: string }>
  deals: Array<{ id: string; state: string; public_code: string; name: string | null }>
  can_start_deal: boolean
}

function Invites({ id }: { id: string }) {
  const { data, reload } = useData<{ invites: Array<{ id: string; role: string; created_at: string }> }>(`/api/syndicates/${id}/invites`)
  const [role, setRole] = useState('deal_member')
  const [link, setLink] = useState<string | null>(null)
  const { error, run } = useRun()
  const make = () =>
    run(async () => {
      const r = await api<{ link: string }>(`/api/syndicates/${id}/invites`, 'POST', { role })
      setLink(r.link.startsWith('/') ? `${window.location.origin}${r.link}` : r.link)
      await reload()
    })
  return (
    <section className="card">
      <h2>Invite people</h2>
      <Problem error={error} />
      <label>
        They join as
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="deal_member">Deal member: sees only deals they are added to</option>
          <option value="admin">Admin: sees every deal</option>
        </select>
      </label>
      <button type="button" className="secondary" onClick={make}>
        Make a member link
      </button>
      {link && (
        <>
          <label>
            Member link: select it and copy it yourself
            <input readOnly data-testid="member-link" value={link} onFocus={(e) => e.target.select()} />
          </label>
          <p className="hint">Nothing has been copied for you. This is the only time the link is shown.</p>
        </>
      )}
      {data && data.invites.length > 0 && <h3>Links still working</h3>}
      <ul className="list" data-testid="invites">
        {data?.invites.map((i) => (
          <li key={i.id}>
            <span>
              {i.role === 'admin' ? 'Admin' : 'Deal member'}, made {new Date(i.created_at).toLocaleDateString()}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                run(async () => {
                  await api(`/api/syndicates/${id}/invites/${i.id}/revoke`, 'POST')
                  setLink(null)
                  await reload()
                })
              }
            >
              Stop this link
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function SyndicatePage({ id, me }: { id: string; me: string }) {
  const { data, error: loadError, reload } = useData<Page>(`/api/syndicates/${id}`)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [thesis, setThesis] = useState('')
  const { error, run } = useRun()
  useEffect(() => {
    if (data) {
      setName(data.name)
      setThesis(richTextToMarkup(data.thesis))
    }
  }, [data])
  if (loadError && !data)
    return (
      <section className="card">
        <Problem error={loadError} />
        <Link to="/syndicates">Back to syndicates</Link>
      </section>
    )
  if (!data) return <p>Loading…</p>
  const admin = data.role === 'admin'
  const active = data.status === 'active'
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/syndicates/${id}`, 'PUT', { name, thesis: markupToRichText(thesis) })
      setEditing(false)
      await reload()
    })
  }
  const startDeal = () =>
    run(async () => {
      const deal = await api<{ id: string }>('/api/deals', 'POST')
      await api(`/api/deals/${deal.id}/draft`, 'PUT', { basics: { syndicate: { mode: 'existing', id } } })
      go(`/deals/${deal.id}`)
    })
  const member = (user: string, f: () => Promise<unknown>) =>
    run(async () => {
      await f()
      if (user === me) go('/syndicates')
      else await reload()
    })
  return (
    <>
      <section className="card">
        <p>
          <Link to="/syndicates">All syndicates</Link>
        </p>
        <div className="logo" aria-hidden="true">
          {data.name.trim().charAt(0).toUpperCase() || '?'}
        </div>
        <h1 data-testid="syndicate-name">{data.name}</h1>
        {!active && <p className="pill">Archived</p>}
        <Problem error={error} />
        {data.thesis ? <RichView doc={data.thesis} /> : <p className="hint">No investment thesis yet.</p>}
        {admin && active && (
          <div className="row">
            <button type="button" className="secondary" onClick={() => setEditing(!editing)}>
              {editing ? 'Stop changing' : 'Change the name and thesis'}
            </button>
            {data.deals.length === 0 && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  run(async () => {
                    await api(`/api/syndicates/${id}/archive`, 'POST')
                    await reload()
                  })
                }
              >
                Archive
              </button>
            )}
          </div>
        )}
        {editing && (
          <form onSubmit={save}>
            <label>
              Name *
              <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Investment thesis
              <textarea rows={6} value={thesis} onChange={(e) => setThesis(e.target.value)} />
            </label>
            <p className="hint"># starts a heading, - starts a list, **bold**, *italic*, and [words](secure web address) makes a link.</p>
            <button type="submit">Save</button>
          </form>
        )}
      </section>
      <section className="card">
        <h2>Deals</h2>
        {data.can_start_deal && (
          <button type="button" onClick={startDeal}>
            Start a deal
          </button>
        )}
        {!data.deals.length && <p className="hint">{admin ? 'No deals yet.' : 'You have not been added to a deal yet.'}</p>}
        <ul className="list" data-testid="syndicate-deals">
          {data.deals.map((d) => (
            <li key={d.id}>
              <Link to={`/deals/${d.id}`}>{d.name || 'Untitled deal'}</Link>
              <span className="pill">{STATE_WORDS[d.state] ?? d.state}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>Team</h2>
        <ul className="list" data-testid="syndicate-team">
          {data.team.map((m) => (
            <li key={m.user_id}>
              <span>
                {m.name}
                {m.user_id === me ? ' (you)' : ''} <span className="hint">{m.role === 'admin' ? 'admin' : 'deal member'}</span>
              </span>
              <span className="row">
                {admin && active && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      member('', () => api(`/api/syndicates/${id}/members/${m.user_id}`, 'PUT', { role: m.role === 'admin' ? 'deal_member' : 'admin' }))
                    }
                  >
                    {m.role === 'admin' ? `Make ${m.name} a deal member` : `Make ${m.name} an admin`}
                  </button>
                )}
                {(admin || m.user_id === me) && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => member(m.user_id, () => api(`/api/syndicates/${id}/members/${m.user_id}`, 'DELETE'))}
                  >
                    {m.user_id === me ? 'Leave' : `Remove ${m.name}`}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {admin && active && <Invites id={id} />}
    </>
  )
}

/** Joining is a button, not the opening of the link: a mail scanner following it must not join anyone. */
export function JoinSyndicate({ token }: { token: string }) {
  const { error, run } = useRun()
  const join = () =>
    run(async () => {
      const { syndicate_id } = await api<{ syndicate_id: string }>('/api/syndicate-invites/accept', 'POST', { token })
      go(`/syndicates/${syndicate_id}`)
    })
  return (
    <div className="card narrow">
      <h1>Join a syndicate</h1>
      <p>You have been given a link to join a syndicate.</p>
      <Problem error={error} />
      <button type="button" onClick={join}>
        Join
      </button>
    </div>
  )
}

interface Investee {
  public_code: string
  deal_name: string | null
  company: string | null
  status: string
  return_reason: string | null
  required: string[]
  uploaded: Array<{ id: string; requirement: string; display_name: string }>
  needs_notarised_signature: boolean | null
  link_expires_at: string
}

export function InvesteePage({ token }: { token: string }) {
  const [data, setData] = useState<Investee | null>(null)
  const [broken, setBroken] = useState<unknown>(null)
  const [notarised, setNotarised] = useState<boolean | null>(null)
  const { error, run } = useRun()
  const load = async () => {
    try {
      const v = await api<Investee>('/api/investee/view', 'POST', { token })
      setData(v)
      setNotarised((n) => n ?? v.needs_notarised_signature)
    } catch (x) {
      setBroken(x)
    }
  }
  useEffect(() => {
    void load()
    // once for this link
  }, [token]) // eslint-disable-line
  if (broken)
    return (
      <div className="card narrow">
        <h1>Company documents</h1>
        <Problem error={broken} />
      </div>
    )
  if (!data) return <p>Loading…</p>
  const open = data.status === 'waiting' || data.status === 'returned'
  const add = (requirement: string, files: File[]) =>
    run(async () => {
      for (const f of files)
        await uploadFile(`/api/investee/files?requirement=${requirement}&name=${encodeURIComponent(f.name)}`, f, { 'x-investee-token': token })
      await load()
    })
  return (
    <section className="card">
      <h1>Documents for {data.company ?? 'your company'}</h1>
      <p>
        Asked for the deal {data.deal_name ?? data.public_code}. You do not need an account.{' '}
        <span className="hint">This link works until {new Date(data.link_expires_at).toLocaleDateString()}.</span>
      </p>
      <p>
        <span className="pill" data-testid="investee-page-status">
          {INVESTEE_WORDS[data.status] ?? data.status}
        </span>
      </p>
      {data.return_reason && open && (
        <p className="warning" data-testid="investee-return-reason">
          We need more: {data.return_reason}
        </p>
      )}
      <Problem error={error} />
      {data.required.map((r) => (
        <div key={r} className="party" data-testid={`doc-${r}`}>
          <h3>{DOCUMENT_WORDS[r] ?? r} *</h3>
          <ul className="list">
            {data.uploaded
              .filter((f) => f.requirement === r)
              .map((f) => (
                <li key={f.id}>
                  <span>{f.display_name}</span>
                  {open && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        run(async () => {
                          await api('/api/investee/files/remove', 'POST', { token, file_id: f.id })
                          await load()
                        })
                      }
                    >
                      Remove {f.display_name}
                    </button>
                  )}
                </li>
              ))}
          </ul>
          {open && (
            <label>
              Add {DOCUMENT_WORDS[r] ?? r} (PDF, PNG or JPEG)
              <input
                type="file"
                multiple
                accept="application/pdf,image/png,image/jpeg"
                onChange={(e) => {
                  // a copy first: clearing the box empties the list it holds
                  void add(r, Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
            </label>
          )}
        </div>
      ))}
      {open ? (
        <>
          <fieldset>
            <legend>Does the company need a notarised or handwritten signature on its documents? *</legend>
            <label className="check block">
              <input type="radio" name="notarised" checked={notarised === true} onChange={() => setNotarised(true)} /> Yes
            </label>
            <label className="check block">
              <input type="radio" name="notarised" checked={notarised === false} onChange={() => setNotarised(false)} /> No
            </label>
          </fieldset>
          <button
            type="button"
            onClick={() =>
              run(async () => {
                await api('/api/investee/submit', 'POST', { token, needs_notarised_signature: notarised })
                await load()
              })
            }
          >
            Send the documents
          </button>
        </>
      ) : (
        <p role="status" data-testid="investee-sent">
          {data.status === 'approved' ? 'The company has passed this check. Nothing more is needed.' : 'Thank you. A reviewer will look at these next.'}
        </p>
      )}
    </section>
  )
}
