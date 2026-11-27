// D3 investor screens: the invitation page, the deal list and page, committing, signing, payment details, the verify page.
// The warning comes before anything else on every promotional page (§5.5). All wording is ours; legal text comes from the pack.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { money, percent } from '../lib/dealSheet.ts'
import { COUNTRY_CHOICES, OTHER_COUNTRY } from '../lib/invite.ts'
import { textParts } from '../lib/legalText.ts'
import { typedAmountToDraft } from '../lib/pounds.ts'
import { api } from './api.ts'
import { fileLink, openPage, openStep, pageHref, setAddress } from './browser.ts'
import { INSTRUMENTS, Link, RichView, ROUNDS, SHARE_CLASSES, VOTERS, useData } from './DealShared.tsx'
import { DealUpdates, Differences } from './DealChange.tsx'
import { Problem, useRun } from './Investor.tsx'

export interface Warning {
  regime: 'uk-fpo' | 'uk-cobs'
  text: string
  format?: 'plain' | 'bold_markup'
  risk_summary: string | null
  sender?: string
}

/** §5.5: FPO — a black-bordered bold block before anything; COBS — a fixed bordered warning with a risk summary. Never dismissable. */
/** The pack's wording, with its required bold kept (§5.5). */
const Legal = ({ w }: { w: Warning }) => (
  <p className="legal">{w.format === 'bold_markup' ? textParts(w.text).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : p.text)) : w.text}</p>
)

export function PromotionWarning({ w }: { w: Warning }) {
  const [open, setOpen] = useState(false)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) close.current?.focus()
  }, [open])
  if (w.regime === 'uk-cobs')
    return (
      <div className="warning-fixed" role="note" data-testid="promotion-warning">
        <Legal w={w} />
        {w.sender && <p className="legal">Sent by: {w.sender}</p>}
        {w.risk_summary && (
          <button type="button" className="link-button" onClick={() => setOpen(true)}>
            Take 2 mins to learn more
          </button>
        )}
        {open && (
          <div className="modal-back" role="dialog" aria-modal="true" aria-label="Risk summary">
            <div className="modal">
              <p className="legal">{w.risk_summary}</p>
              <button type="button" ref={close} onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    )
  return (
    <div className="warning-block" role="note" data-testid="promotion-warning">
      <Legal w={w} />
      {w.sender && <p className="legal">Sent by: {w.sender}</p>}
    </div>
  )
}

/**
 * §5.5: on a promotional page the warning comes before everything, the banner, logo and navigation included. The app puts an
 * empty slot first in the document; promotional pages fill it. Without the slot the warning stays where it is drawn.
 */
export function TopWarning({ children }: { children: ReactNode }) {
  const slot = typeof document === 'undefined' ? null : document.getElementById('promotion-top')
  return slot ? createPortal(children, slot) : <>{children}</>
}

const ccy = (minor: string | null | undefined, c: string) => (minor === null || minor === undefined ? '' : money(BigInt(minor), c))

// ---------- The invitation page: nothing about the deal (R-LNK-08, R-ELG-08) ----------

interface Prep {
  overview: string
  steps: number
  individual: string
  company: string
  minutes: number
  review_days: number
  cooling_off_hours: number | null
}

export function InvitePage({ token, signedIn }: { token: string; signedIn: boolean }) {
  const [state, setState] = useState<{ ok: boolean; code?: string; prep?: Prep | null; message?: string } | null>(null)
  useEffect(() => {
    api<{ ok: boolean; deal_code: string; preparation: Prep | null }>('/api/invite/open', 'POST', { token }).then(
      (r) => {
        // the token leaves the address bar once the browser holds the invitation (tech design §5)
        setAddress('/invite', 'replace')
        setState({ ok: true, code: r.deal_code, prep: r.preparation })
      },
      () => setState({ ok: false, message: 'This link does not work. Ask whoever sent it for a new one.' }),
    )
  }, [token])
  if (!state) return <p className="card narrow">Opening the invitation…</p>
  if (!state.ok)
    return (
      <p className="card narrow" role="alert">
        {state.message}
      </p>
    )
  const p = state.prep
  return (
    <div className="card narrow" data-testid="invite-page">
      <h1>You have been invited</h1>
      <p>
        Invitation reference <strong>{state.code}</strong>. The details are shown once you have an account and have completed a few checks.
      </p>
      <h2>Before you start</h2>
      {p ? (
        <div data-testid="preparation">
          <p className="legal">{p.overview}</p>
          <p>
            {p.steps} steps in all. Roughly {p.minutes} minutes of your time, then up to {p.review_days} days for the operator's checks. These are estimates.
          </p>
          {p.cooling_off_hours !== null && (
            <p className="warning">There is a waiting period of at least {p.cooling_off_hours} hours before you can see any investment.</p>
          )}
          <h3>Investing as yourself</h3>
          <p className="legal">{p.individual}</p>
          <h3>Investing through a company or trust</h3>
          <p className="legal">{p.company}</p>
        </div>
      ) : (
        <ul className="steps">
          <li>Create an account and confirm your email address.</li>
          <li>Answer a short statement about your experience as an investor, and any questions the operator asks.</li>
          <li>To invest, you will need proof of identity and address for whoever invests: you, or a company or trust.</li>
        </ul>
      )}
      <p className="hint">This page holds no details of any investment.</p>
      <p>
        <a href={pageHref('/')}>{signedIn ? 'Continue' : 'Sign in or create an account'}</a>
      </p>
    </div>
  )
}

/** R-PAY-03: anyone with the link learns only whether the details still stand. */
/** Checks again every 15 seconds and whenever the page comes back into view. */
export function useRefresh(reload: () => unknown) {
  useEffect(() => {
    const again = () => void reload()
    const timer = setInterval(again, 15_000)
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [reload])
}

export function VerifyInstructionPage({ token }: { token: string }) {
  const { data, reload, error } = useData<{ valid: boolean; message: string }>(`/api/instructions/verify?token=${encodeURIComponent(token)}`)
  useRefresh(reload)
  if (error)
    return (
      <p className="card narrow warning" role="alert">
        These details cannot be checked at the moment. Do not pay until they can.
      </p>
    )
  if (!data) return <p className="card narrow">Checking…</p>
  return (
    <div className="card narrow" role="status" data-testid="verify-result">
      <h1>{data.valid ? 'Still valid' : 'Not valid'}</h1>
      <p className={data.valid ? '' : 'warning'}>{data.message}</p>
    </div>
  )
}

// ---------- The investor's deals (R-PAGE-05) ----------

interface ListRow {
  deal_id: string
  deal_code: string
  name: string | null
  company: string | null
  visible: boolean
  kind: 'invited' | 'committed' | 'not_investing'
  note: string | null
}

export function CountryForm() {
  const { data, reload } = useData<{ country: string | null }>('/api/my/country')
  const [value, setValue] = useState<string | null>(null)
  const { error, run } = useRun()
  if (!data) return null
  const v = value ?? data.country ?? ''
  // R-LNK-09 is self-declared: a code saved that is not in the list is shown as another country
  const shown = !v || COUNTRY_CHOICES.some(([c]) => c === v) ? v : OTHER_COUNTRY
  return (
    <form
      className="card"
      data-testid="country"
      onSubmit={(e) => {
        e.preventDefault()
        void run(async () => (await api('/api/my/country', 'PUT', { country: v || null }), await reload(), setValue(null)))
      }}
    >
      <label>
        The country you live in
        <select value={shown} onChange={(e) => setValue(e.target.value)}>
          <option value="">Not given</option>
          {COUNTRY_CHOICES.map(([c, name]) => (
            <option key={c} value={c}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">Used only to count how many people in each country a deal reaches.</p>
      {value !== null && value !== (data.country ?? '') && (
        <button type="submit" className="secondary">
          Save
        </button>
      )}
      <Problem error={error} />
    </form>
  )
}

export function MyDeals() {
  const [rows, setRows] = useState<ListRow[] | null>(null)
  const [warning, setWarning] = useState<Warning | null>(null)
  const [results, setResults] = useState<Array<{ deal_code: string; result: string }>>([])
  const [round, setRound] = useState(0)
  useEffect(() => {
    // the checks finished on this page: the list is read again, so the deal opens without a reload (Codex round 3)
    const again = () => setRound((n) => n + 1)
    window.addEventListener('bulma:eligibility', again)
    return () => window.removeEventListener('bulma:eligibility', again)
  }, [])
  // the list alone, on the same schedule as the deal page, so a pause takes the companies off an open list too (Codex round 5)
  const loadList = useCallback(
    () =>
      api<{ deals: ListRow[]; warning: Warning | null }>('/api/my/deals').then(
        (d) => (setRows(d.deals), setWarning(d.warning)),
        // fail closed: a list that cannot be checked is not left on screen
        () => (setRows([]), setWarning(null)),
      ),
    [],
  )
  useRefresh(loadList)
  useEffect(() => {
    // binds any invitation opened in this browser or attached at sign-up (R-LNK-10)
    void api<{ results: Array<{ deal_code: string; result: string }> }>('/api/invite/accept', 'POST', {})
      .then((r) => setResults(r.results.filter((x) => x.result !== 'invited')))
      .catch(() => undefined)
      .finally(() =>
        api<{ deals: ListRow[]; warning: Warning | null }>('/api/my/deals').then(
          (d) => (setRows(d.deals), setWarning(d.warning)),
          // fail closed: a list that cannot be checked is not left on screen
          () => (setRows([]), setWarning(null)),
        ),
      )
  }, [round])
  const RESULT: Record<string, string> = {
    already_invited: 'You were already invited to this deal. Your terms have not changed.',
    ended_before: 'You cannot rejoin this deal through a link. Contact the lead.',
    wrong_address: 'This invitation was sent to another email address.',
    consumed: 'This invitation has been used already.',
    link_unusable: 'This link is no longer in use.',
    deal_not_open: 'This deal is not open.',
    held: 'This deal is not available at the moment.',
    demo_apart: 'Demo records and ordinary records stay apart: this account cannot take part here.',
  }
  if (!rows) return null
  const group = (k: ListRow['kind']) => rows.filter((r) => r.kind === k)
  return (
    <section className="card" data-testid="my-deals">
      {warning && (
        <TopWarning>
          <PromotionWarning w={warning} />
        </TopWarning>
      )}
      <h2>Your deals</h2>
      {results.map((r) => (
        <p key={r.deal_code} className="notice">
          {r.deal_code}: {RESULT[r.result] ?? 'This invitation could not be used.'}
        </p>
      ))}
      {!rows.length && <p className="hint">No invitations yet.</p>}
      {(['committed', 'invited', 'not_investing'] as const).map((k) =>
        group(k).length ? (
          <div key={k}>
            <h3>{k === 'committed' ? 'Committed' : k === 'invited' ? 'Invited' : 'Not investing'}</h3>
            <ul className="list">
              {group(k).map((r) => (
                <li key={r.deal_id}>
                  {r.visible ? <Link to={`/invest/${r.deal_id}`}>{r.name ?? r.deal_code}</Link> : <span>{r.deal_code}</span>}
                  <span className="hint">{r.visible ? r.company : r.note}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  )
}

// ---------- The deal page (R-PAGE-01 to R-PAGE-07) and committing (R-CMT-*) ----------

interface KeyTerms {
  instrument: string | null
  round: string | null
  share_class: string | null
  pre_money_minor: string | null
  cap_type: string | null
  cap_minor: string | null
  discount_bps: number | null
  custom_terms: unknown
  round_size_minor: string | null
  allocation_minor: string | null
  min_commitment_minor: string | null
  min_raise_minor: string | null
  target_close: string | null
  pay_by: string | null
  voter: string | null
  currency: string
  seis: boolean
  eis: boolean
  carry: string
  lead_fee: string
  platform_fee: { rate: string; min: string; max: string; surcharge: string | null; payer: string | null } | null
}
interface Participation {
  id: string
  entity: { id: string; name: string }
  status: string
  status_label: string
  overlays: string[]
  amount_proposal_open: boolean
  commitment_minor: string
  due_minor: string
  held_minor: string
  still_to_pay_minor: string
  reference: string
  expected_minor: string | null
  least_minor: string | null
  payer: string
  can_sign: boolean
}
interface DealView {
  warning: Warning
  held?: boolean
  message?: string
  deal_code: string
  name: string | null
  company: { legal_name: string | null; website: string | null }
  memo: unknown
  deck: { kind?: string; url?: string; embed_url?: string | null } | null
  documents: Array<{ id: string; display_name: string; requirement: string }>
  key_terms: KeyTerms
  commitment_effect: string
  estimate_note: string
  can_commit: boolean
  // R-ALO-04: what the person asked for and whether the lead let them in; no participation, no amount to pay
  waitlist: { desired_minor: string; state: 'waiting' | 'released' } | null
  participations: Participation[]
}

const PAYERS: Record<string, string> = { investors: 'Investors, in proportion, at close', lead: 'The lead', company: 'The company' }

function Terms({ k }: { k: KeyTerms }) {
  const c = k.currency
  const rows: Array<[string, string | null]> = [
    ['Instrument', k.instrument ? (INSTRUMENTS[k.instrument] ?? k.instrument) : null],
    ['Round', k.round ? (ROUNDS[k.round] ?? k.round) : null],
    ['Share class', k.share_class ? (SHARE_CLASSES[k.share_class] ?? k.share_class) : null],
    ['Pre-money valuation', k.pre_money_minor ? ccy(k.pre_money_minor, c) : null],
    // a convertible's own terms (R-PAGE-02)
    [
      'Valuation cap',
      k.cap_minor && k.cap_type && k.cap_type !== 'none' ? `${ccy(k.cap_minor, c)} (${k.cap_type === 'pre_money' ? 'pre-money' : 'post-money'})` : null,
    ],
    ['Discount', k.discount_bps !== null && k.discount_bps !== undefined ? percent(k.discount_bps) : null],
    ['Round size', k.round_size_minor ? ccy(k.round_size_minor, c) : null],
    ['Allocation for this deal', k.allocation_minor ? ccy(k.allocation_minor, c) : null],
    ['Minimum commitment', k.min_commitment_minor ? ccy(k.min_commitment_minor, c) : null],
    ['Minimum raise', k.min_raise_minor ? ccy(k.min_raise_minor, c) : null],
    ['Target close', k.target_close],
    ['Pay by', k.pay_by],
    ['Who votes', k.voter ? (VOTERS[k.voter] ?? k.voter) : null],
    ['Carry on your terms', k.carry],
    ['Lead fee on your terms', k.lead_fee],
    [
      'Platform fee',
      k.platform_fee
        ? `${k.platform_fee.rate}, at least ${k.platform_fee.min}, at most ${k.platform_fee.max}${k.platform_fee.surcharge ? `, plus ${k.platform_fee.surcharge}` : ''}. Paid by: ${PAYERS[k.platform_fee.payer ?? ''] ?? 'not set'}`
        : null,
    ],
    ['Tax schemes', [k.seis && 'SEIS', k.eis && 'EIS'].filter(Boolean).join(', ') || null],
  ]
  return (
    <dl className="details" data-testid="key-terms">
      {rows
        .filter(([, v]) => v)
        .map(([label, v]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  )
}

/** R-DRF-04, R-PAGE-02: approved custom terms, as approved. */
function CustomTerms({ k }: { k: KeyTerms }) {
  if (!k.custom_terms) return null
  return (
    <div data-testid="custom-terms">
      <h3>Custom terms</h3>
      <RichView doc={k.custom_terms} />
    </div>
  )
}

interface Quote {
  ok: boolean
  error?: string
  currency: string
  minimum_minor: string
  lines?: Array<{ key: string; label: string; minor: string }>
  due_minor?: string
  expected_minor?: string | null
  least_minor?: string | null
  payer?: string
  estimate_label?: string
  least_assumes?: string
  oversubscription?: string
  scheme_note?: string | null
  terms_link_id?: string
  fixed_total?: string | null
  capacity?: string
  capacity_refusal?: string | null
  commitment_effect?: string
}

/** R-CMT-05, R-CMT-05.1: everything shown before a commitment is made or changed. */
function QuoteDetails({ quote, c }: { quote: Quote; c: string }) {
  return (
    <>
      <dl className="details">
        {quote.lines!.map((l) => (
          <div key={l.key}>
            <dt>{l.label}</dt>
            <dd>{ccy(l.minor, c)}</dd>
          </div>
        ))}
      </dl>
      {quote.fixed_total && <p className="hint">{quote.fixed_total}</p>}
      {quote.payer === 'investors' ? (
        <>
          <p>
            Expected investment: <strong>{ccy(quote.expected_minor, c)}</strong> <span className="hint">{quote.estimate_label}</span>
          </p>
          <p data-testid="least">
            {quote.least_minor ? (
              <>
                At least about {ccy(quote.least_minor, c)}. {quote.least_assumes}
              </>
            ) : (
              'No amount of investment can be promised: if the platform fee reaches your investment at close, the deal cannot close and your money is returned.'
            )}
          </p>
        </>
      ) : (
        <p>{quote.estimate_label}</p>
      )}
      <p className="hint">{quote.oversubscription}</p>
      {quote.scheme_note && <p className="hint">{quote.scheme_note}</p>}
      {quote.commitment_effect && <p className="legal">{quote.commitment_effect}</p>}
    </>
  )
}

/** R-ALO-04: a full deal; the person asks for an amount and waits. Nothing is created to pay. */
function JoinWaitlist({ dealId, minor, c, onDone }: { dealId: string; minor: string; c: string; onDone: () => void }) {
  const { error, run } = useRun()
  return (
    <>
      <p className="hint">On the waiting list you are not asked to pay anything. If the lead lets you in, you are told and can commit then.</p>
      <button
        type="button"
        onClick={() =>
          void run(async () => {
            await api(`/api/my/deals/${dealId}/waitlist`, 'POST', { desired_minor: minor })
            onDone()
          })
        }
      >
        Join the waiting list for {ccy(minor, c)}
      </button>
      <Problem error={error} />
    </>
  )
}

/** R-ALO-04: where the person stands on the waiting list, and leaving it. */
function WaitlistCard({ dealId, w, c, onDone }: { dealId: string; w: NonNullable<DealView['waitlist']>; c: string; onDone: () => void }) {
  const { error, run } = useRun()
  return (
    <section className="card" data-testid="waitlist-me">
      <h2>
        Waiting list <span className="pill">{w.state === 'released' ? 'Let in' : 'Waiting'}</span>
      </h2>
      {w.state === 'released' ? (
        <p>The lead has let you in for {ccy(w.desired_minor, c)}. You can commit below; whether there is room is checked again when you commit.</p>
      ) : (
        <p>
          You asked for {ccy(w.desired_minor, c)}. The deal is full, so nothing is created for you to pay for this amount. The lead decides who is let in, not
          in any set order; you are told if you are.
        </p>
      )}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          void run(async () => {
            await api(`/api/my/deals/${dealId}/waitlist/leave`, 'POST', {})
            onDone()
          })
        }
      >
        Leave the waiting list
      </button>
      <Problem error={error} />
    </section>
  )
}

function CommitForm({ dealId, k, onList, onDone }: { dealId: string; k: KeyTerms; onList: boolean; onDone: () => void }) {
  const [typed, setTyped] = useState('')
  const [entity, setEntity] = useState('')
  const [scheme, setScheme] = useState<'none' | 'seis' | 'eis'>('none')
  // the quote belongs to the amount it was asked for: a reply for an amount no longer typed is dropped (TC-CMT-05)
  const [quote, setQuote] = useState<(Quote & { for: string }) | null>(null)
  const asked = useRef(0)
  const { error, run } = useRun()
  const entities = useData<{ entities: Array<{ id: string; type: string; fields: Record<string, string>; status: string }> }>('/api/entities')
  const minor = typedAmountToDraft(typed)
  const check = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      if (!minor || !/^\d+$/.test(minor)) throw new Error('Type an amount, such as 10,000.')
      const n = ++asked.current
      const q = await api<Quote>(`/api/my/deals/${dealId}/quote`, 'POST', { commitment_minor: minor })
      if (n === asked.current) setQuote({ ...q, for: minor })
    })
  }
  const commit = () =>
    run(async () => {
      if (!quote || quote.for !== minor) throw new Error('Check the amount again before you commit.')
      // what was shown is what is committed: the server refuses if the amount to pay or the terms have moved since
      await api(`/api/my/deals/${dealId}/commit`, 'POST', {
        commitment_minor: quote.for,
        entity_id: entity,
        quoted_due_minor: quote.due_minor,
        terms_link_id: quote.terms_link_id,
        ...(k.seis || k.eis ? { scheme } : {}),
      })
      onDone()
    })
  const c = quote?.currency ?? k.currency
  return (
    <section className="card" data-testid="commit">
      <h2>Invest</h2>
      <form onSubmit={check}>
        <label>
          Amount ({c}){k.min_commitment_minor && <span className="hint"> Minimum {ccy(k.min_commitment_minor, c)}</span>}
          <input inputMode="decimal" required value={typed} onChange={(e) => (setTyped(e.target.value), setQuote(null), asked.current++)} />
        </label>
        <button type="submit" className="secondary">
          Show what I would pay
        </button>
      </form>
      {quote && !quote.ok && <p className="problem">{quote.error}</p>}
      {/* R-ALO-03: when the amount does not fit, say why and what can be done; the server refuses the commitment anyway */}
      {quote?.ok && quote.capacity_refusal && (
        <div data-testid="capacity">
          <p className="problem">{quote.capacity_refusal}</p>
          {/* one entry per invitation: someone already let in keeps their place and cannot join again */}
          {quote.capacity === 'waitlist' && !onList && <JoinWaitlist dealId={dealId} minor={quote.for} c={c} onDone={onDone} />}
        </div>
      )}
      {quote?.ok && !quote.capacity_refusal && (
        <div data-testid="quote">
          <QuoteDetails quote={quote} c={c} />
          <label>
            Who is investing
            <select required value={entity} onChange={(e) => setEntity(e.target.value)}>
              <option value="">Choose</option>
              {entities.data?.entities.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.fields.full_name ?? x.fields.name}
                </option>
              ))}
            </select>
          </label>
          {(k.seis || k.eis) && (
            <label>
              Tax scheme
              <select value={scheme} onChange={(e) => setScheme(e.target.value as 'none')}>
                <option value="none">None</option>
                {k.seis && <option value="seis">SEIS</option>}
                {k.eis && <option value="eis">EIS</option>}
              </select>
            </label>
          )}
          <button type="button" disabled={!entity} onClick={() => void commit()}>
            Commit {ccy(quote.due_minor, c)}
          </button>
        </div>
      )}
      <Problem error={error} />
    </section>
  )
}

function Sheet({ p, onDone }: { p: Participation; onDone: () => void }) {
  const [name, setName] = useState('')
  const [agree, setAgree] = useState(false)
  const { data } = useData<{ warning: Warning; document: string; document_sha256: string; needs_deed: boolean; can_sign: boolean; signed: boolean }>(
    `/api/my/participations/${p.id}/deal-sheet`,
  )
  const { error, run } = useRun()
  if (!data) return null
  const sign = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/my/participations/${p.id}/sign`, 'POST', { agree: true, signed_name: name, document_sha256: data.document_sha256 })
      onDone()
    })
  }
  return (
    <div data-testid="deal-sheet">
      <h3>Your deal sheet</h3>
      <PromotionWarning w={data.warning} />
      <p className="legal mono">{data.document}</p>
      {data.needs_deed && <p className="notice">This document is signed outside this site. The operator will send it to you.</p>}
      {data.can_sign && (
        <form onSubmit={sign}>
          <label className="check block">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I have read this document and agree to sign it.
          </label>
          <label>
            Type your full name to sign
            <input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <button type="submit" disabled={!agree}>
            Sign
          </button>
        </form>
      )}
      {!data.can_sign && !data.signed && !data.needs_deed && <p className="hint">You can sign once your identity check has passed.</p>}
      <Problem error={error} />
    </div>
  )
}

interface Instructions {
  held?: boolean
  message?: string
  acknowledge?: boolean
  account?: Record<string, unknown>
  account_sha256?: string
  warning?: Warning
  currency?: string
  still_to_pay_minor?: string
  due_minor?: string
  received_minor?: string
  reference?: string
  pay_by?: string | null
  your_money?: { text: string; operator_statement: string; refund_days: number | null; client_money: boolean | null; holder_frn: string | null }
  breakdown?: Array<{ key: string; label: string; minor: string }>
  no_money_held?: string
  reminders?: string[]
  verify_url?: string
  verify_note?: string
  transfer_marked?: boolean
  stuck_payment_help?: string
}

function Pay({ p }: { p: Participation }) {
  const { data, reload, error: loadError } = useData<Instructions>(`/api/my/participations/${p.id}/instructions`)
  const { error, run } = useRun()
  // an open page learns of a pause or an account change: checked again every 15 seconds and when the page is looked at again
  useRefresh(reload)
  // fail closed: when the details cannot be checked, they are not left on screen
  if (loadError)
    return (
      <p className="warning" role="alert">
        Payment details cannot be shown at the moment. Do not pay until they are shown again.
      </p>
    )
  if (!data) return <Problem error={error} />
  if (data.held)
    return (
      <p className="warning" role="alert">
        {data.message}
      </p>
    )
  const ack = () =>
    run(async () => {
      await api(`/api/my/participations/${p.id}/acknowledge-account`, 'POST', { account_sha256: data.account_sha256 })
      await reload()
    })
  if (data.acknowledge)
    return (
      <div className="warning" data-testid="account-changed">
        <p>
          The receiving account for this deal has changed. Earlier details must not be used. Confirm that you know this to see the new details, and check them
          against this page before you pay.
        </p>
        <button type="button" onClick={() => void ack()}>
          I understand: show the new details
        </button>
      </div>
    )
  const c = data.currency!
  return (
    <div data-testid="instructions">
      <PromotionWarning w={data.warning!} />
      <p className="big-number" data-testid="still-to-pay">
        Still to pay: {ccy(data.still_to_pay_minor, c)}
      </p>
      <dl className="details">
        <div>
          <dt>Amount to pay in total</dt>
          <dd>{ccy(data.due_minor, c)}</dd>
        </div>
        <div>
          <dt>Received so far</dt>
          <dd>{ccy(data.received_minor, c)}</dd>
        </div>
        <div>
          <dt>Payment reference</dt>
          <dd className="mono">{data.reference}</dd>
        </div>
        {data.pay_by && (
          <div>
            <dt>Pay by</dt>
            <dd>{data.pay_by}</dd>
          </div>
        )}
      </dl>
      {/* R-PAY-01: how the amount to pay is made up, the same lines as the signed deal sheet */}
      <h3>How the amount is made up</h3>
      <dl className="details" data-testid="pay-breakdown">
        {data.breakdown!.map((l) => (
          <div key={l.key}>
            <dt>{l.label}</dt>
            <dd>{ccy(l.minor, c)}</dd>
          </div>
        ))}
      </dl>
      <div className="notice" data-testid="your-money">
        <h3>Your money</h3>
        <p className="legal">{data.your_money!.text}</p>
        {data.your_money!.client_money !== null && <p>The operator says this {data.your_money!.client_money ? 'is' : 'is not'} a client money account.</p>}
        {data.your_money!.holder_frn && <p>Holder's FRN: {data.your_money!.holder_frn}</p>}
        {data.your_money!.refund_days !== null && (
          <p>If the deal does not close, the operator says money is returned within {data.your_money!.refund_days} days.</p>
        )}
        <p className="hint">{data.your_money!.operator_statement}</p>
      </div>
      <h3>Receiving account</h3>
      <AccountRows a={data.account!} />
      <p className="hint">{data.no_money_held}</p>
      <ul>
        {data.reminders!.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p>
        {data.verify_note} <a href={data.verify_url ? pageHref(data.verify_url) : undefined}>Check these details</a>
      </p>
      <p>
        <a {...fileLink(`/api/my/participations/${p.id}/instructions.pdf`)}>Download as PDF</a>
      </p>
      {data.transfer_marked ? (
        <p className="hint">You said you have paid. The operator records money when it arrives.</p>
      ) : (
        <button
          type="button"
          className="secondary"
          onClick={() => void run(async () => (await api(`/api/my/participations/${p.id}/paid`, 'POST', {}), await reload()))}
        >
          I have paid
        </button>
      )}
      <Problem error={error} />
      {data.stuck_payment_help && <p className="hint">{data.stuck_payment_help}</p>}
      <ReportReference p={p} />
    </div>
  )
}

/** R-PAY-07: a payment sent with the wrong reference goes on the reviewers' list of payments to check. */
function ReportReference({ p }: { p: { id: string } }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [sent, setSent] = useState(false)
  const [blank, setBlank] = useState(false)
  const { error, run } = useRun()
  if (sent) return <p className="notice">Thank you. The operator will check the payment and be in touch.</p>
  if (!open)
    return (
      <button type="button" className="secondary small" onClick={() => setOpen(true)}>
        I used the wrong reference
      </button>
    )
  return (
    <form
      data-testid="reference-report"
      onSubmit={(e) => {
        e.preventDefault()
        // the server trims the note; a note of only spaces would come back as a bare "not valid"
        setBlank(!note.trim())
        if (!note.trim()) return
        void run(async () => {
          await api(`/api/my/participations/${p.id}/reference-report`, 'POST', { note })
          setSent(true)
        })
      }}
    >
      <label>
        What did you send? Say the date, the amount, the name on your account and the reference you used.
        <textarea required maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {blank && <p className="problem">Say what you sent.</p>}
      <button type="submit">Tell the operator</button>
      <Problem error={error} />
    </form>
  )
}

function AccountRows({ a }: { a: Record<string, unknown> }) {
  return (
    <dl className="details">
      {Object.entries(a)
        .filter(([k, v]) => v !== null && v !== undefined && k !== 'fictional' && k !== 'asserted_client_money')
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
    </dl>
  )
}

function ParticipationCard({ p, c, fpo, dealId, onChange }: { p: Participation; c: string; fpo: boolean; dealId: string; onChange: () => void }) {
  const signedStates = ['to_pay', 'payment_sent', 'part_paid', 'funded', 'refund_due']
  // the static demo's payment-step link opens the payment details (openStep is always null in the app)
  const [step, setStep] = useState<'none' | 'sheet' | 'pay' | 'change'>(() => (openStep() === 'pay' && signedStates.includes(p.status) ? 'pay' : 'none'))
  // the lead's proposal is answered first: a deal sheet or amount change opened before it arrived no longer applies (Codex D4 screens round 1)
  const proposal = p.amount_proposal_open
  useEffect(() => {
    if (proposal) setStep('none')
  }, [proposal])
  return (
    <section className="card" data-testid="participation">
      <h2>
        {p.entity.name} <span className="pill">{p.status_label}</span>
      </h2>
      {p.overlays.includes('identity_review') && (
        <p className="warning">Your details changed after you signed. The operator is checking them; payment details are paused.</p>
      )}
      {p.overlays.includes('renew_statement') && <p className="warning">Your investor statement has expired. Renew it to continue.</p>}
      {p.overlays.includes('no_response') && (
        <p className="warning">The time to answer the changed terms has passed with no answer. Silence is not agreement: answer now, or the operator may end this commitment.</p>
      )}
      {p.status === 'reconfirm' && <Reconfirm p={p} c={c} onDone={onChange} />}
      {proposal && <AnswerProposal p={p} c={c} fpo={fpo} onDone={onChange} />}
      <dl className="details">
        {fpo ? (
          // R-LNK-03: under FPO the amount to pay is the total commitment
          <div>
            <dt>Total commitment: the amount to pay</dt>
            <dd>{ccy(p.due_minor, c)}</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>Commitment</dt>
              <dd>{ccy(p.commitment_minor, c)}</dd>
            </div>
            <div>
              <dt>Amount to pay</dt>
              <dd>{ccy(p.due_minor, c)}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Received</dt>
          <dd>{ccy(p.held_minor, c)}</dd>
        </div>
        <div>
          <dt>Payment reference</dt>
          <dd className="mono">{p.reference}</dd>
        </div>
        {p.payer === 'investors' && p.expected_minor && (
          <div>
            <dt>Expected investment (estimate)</dt>
            <dd>{ccy(p.expected_minor, c)}</dd>
          </div>
        )}
      </dl>
      <div className="row">
        {(p.status === 'to_sign' || p.status === 'verifying') && !proposal && (
          <button type="button" className="secondary" onClick={() => setStep('sheet')}>
            Deal sheet
          </button>
        )}
        {signedStates.includes(p.status) && (
          <button type="button" className="secondary" onClick={() => setStep('pay')}>
            Payment details
          </button>
        )}
        {signedStates.includes(p.status) && <a {...fileLink(`/api/my/participations/${p.id}/signed`)}>Signed deal sheet</a>}
        {/* the server refuses a change of one's own while the lead's proposal is open: answer that first */}
        {!proposal && (
          <button type="button" className="secondary" onClick={() => setStep('change')}>
            Change the amount
          </button>
        )}
      </div>
      {step === 'sheet' && <Sheet p={p} onDone={() => (setStep('pay'), onChange())} />}
      {step === 'pay' && <Pay p={p} />}
      {step === 'change' && <ChangeAmount p={p} c={c} dealId={dealId} onDone={() => (setStep('none'), onChange())} />}
    </section>
  )
}

interface Reconfirmation {
  id: string
  summary: string
  differences: Array<{ field: string; before: string | null; after: string | null }>
  deadline: string | null
  clock: 'open' | 'paused' | 'lapsed' | 'unknown'
  working_days: number
  sign_again: boolean
  deal_sheet: { warning: Warning; document: string; document_sha256: string; needs_deed: boolean } | null
}

/** The last day to answer: the deadline is the end of that day. */
const lastDay = (iso: string) => new Date(new Date(iso).getTime() - 1).toISOString().slice(0, 10)

/** §5.3: one screen to see what changed, agree (signing again when the deal sheet changed) or say no. */
function Reconfirm({ p, c, onDone }: { p: Participation; c: string; onDone: () => void }) {
  const { data } = useData<{ reconfirmation: Reconfirmation | null }>(`/api/my/participations/${p.id}/reconfirmation`)
  const [name, setName] = useState('')
  const [read, setRead] = useState(false)
  const [sure, setSure] = useState(false)
  const { error, run } = useRun()
  const rc = data?.reconfirmation
  if (!rc) return null
  const signing = rc.sign_again && rc.deal_sheet && !rc.deal_sheet.needs_deed
  const agree = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/my/participations/${p.id}/reconfirmation/agree`, 'POST', {
        reconfirmation_id: rc.id,
        agree: true,
        ...(signing ? { signed_name: name, document_sha256: rc.deal_sheet!.document_sha256 } : {}),
      })
      onDone()
    })
  }
  const decline = () =>
    void run(async () => {
      await api(`/api/my/participations/${p.id}/reconfirmation/decline`, 'POST', { reconfirmation_id: rc.id })
      onDone()
    })
  return (
    <div data-testid="reconfirm">
      <h3>The terms have changed</h3>
      <p>In the lead&apos;s words: {rc.summary}</p>
      {rc.clock === 'open' && rc.deadline && (
        <p className="hint">Answer by the end of {lastDay(rc.deadline)} ({rc.working_days} working days; bank holidays are not counted out).</p>
      )}
      {rc.clock === 'paused' && <p className="hint">The time to answer is paused until your investor statement is renewed.</p>}
      <Differences
        rows={rc.differences}
        testid="reconfirm-differences"
        currency={c}
        empty="This change has no line-by-line comparison (a new pitch deck, for example). Read the lead's words above and the deal page before you agree."
      />
      <form onSubmit={agree}>
        {rc.sign_again && rc.deal_sheet && (
          <>
            <p>Your deal sheet changed, so agreeing means signing it again.</p>
            <PromotionWarning w={rc.deal_sheet.warning} />
            <p className="legal mono">{rc.deal_sheet.document}</p>
            {rc.deal_sheet.needs_deed && <p className="notice">This document is signed outside this site. The operator will send it to you.</p>}
          </>
        )}
        <label className="check block">
          <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I have read the changes and agree to them
          {signing ? ', and I sign the new deal sheet.' : '.'}
        </label>
        {signing && (
          <label>
            Type your full name to sign
            <input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <button type="submit" disabled={!read}>
          Agree
        </button>
      </form>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I do not agree, and understand my commitment ends
          {BigInt(p.held_minor) > 0n ? ' and the money I sent will be refunded.' : '.'}
        </label>
        <button type="button" className="secondary" disabled={!sure} onClick={decline}>
          Do not agree
        </button>
      </div>
      <Problem error={error} />
    </div>
  )
}

interface Proposal {
  id: string
  current_commitment_minor: string
  current_due_minor: string
  proposed_commitment_minor: string
  deadline_at: string
  quote: Quote
  sign_again: boolean
}

/**
 * R-ALO-01: one screen to answer the lead's proposed amount: the new amount to pay, the investment and the estimate. Nothing
 * changes until the person agrees; a signed deal sheet is signed again after. Silence is not agreement.
 */
function AnswerProposal({ p, c, fpo, onDone }: { p: Participation; c: string; fpo: boolean; onDone: () => void }) {
  const { data, error: loadError, reload } = useData<{ proposal: Proposal | null }>(`/api/my/participations/${p.id}/amount-proposal`)
  // room in the deal comes and goes while the page is open: follow it as the page does (Codex D4 screens round 1)
  useRefresh(reload)
  const [read, setRead] = useState(false)
  const { error, run } = useRun()
  const o = data?.proposal
  // an increase needs room in the deal; the server refuses it otherwise (R-ALO-03), so say why instead of offering Agree
  const noRoom = !!o && o.quote.ok && !!o.quote.capacity_refusal && BigInt(o.proposed_commitment_minor) > BigInt(o.current_commitment_minor)
  // a tick given for one amount, or before the room ran out, is not agreement now
  const shown = o ? `${o.id}/${o.quote.ok ? o.quote.due_minor : ''}/${noRoom}` : ''
  useEffect(() => setRead(false), [shown])
  if (loadError) return <Problem error={loadError} />
  // a proposal that ended while open still says why the answer was refused, until the page catches up
  if (!o) return <Problem error={error} />
  const answer = (how: 'accept' | 'decline') =>
    void run(async () => {
      try {
        await api(
          `/api/my/participations/${p.id}/amount-proposal/${how}`,
          'POST',
          // what was shown is what is agreed: the server refuses if the amount to pay has moved since
          how === 'accept' ? { proposal_id: o.id, quoted_due_minor: o.quote.due_minor } : { proposal_id: o.id },
        )
      } catch (x) {
        // refused: show what is true now (the room, the amount, or that the proposal ended) beside the reason
        void reload()
        throw x
      }
      onDone()
    })
  return (
    <div data-testid="amount-proposal">
      <h3>The lead proposes a new amount</h3>
      <p className="hint">Answer by the end of {lastDay(o.deadline_at)}. If you do not answer, or say no, your amount stays as it is.</p>
      <table className="diff">
        <thead>
          <tr>
            <th>What</th>
            <th>Now</th>
            <th>Proposed</th>
          </tr>
        </thead>
        <tbody>
          {!fpo && (
            <tr>
              <td>Commitment</td>
              <td>{ccy(o.current_commitment_minor, c)}</td>
              <td>{ccy(o.proposed_commitment_minor, c)}</td>
            </tr>
          )}
          <tr>
            <td>{fpo ? 'Total commitment: the amount to pay' : 'Amount to pay'}</td>
            <td>{ccy(o.current_due_minor, c)}</td>
            <td data-testid="proposed-due">{o.quote.ok ? ccy(o.quote.due_minor, c) : '—'}</td>
          </tr>
        </tbody>
      </table>
      {noRoom ? (
        <p className="problem" data-testid="proposal-no-room">
          There is no longer room in the deal for this amount, so you cannot agree to it now.
        </p>
      ) : o.quote.ok ? (
        <>
          <QuoteDetails quote={o.quote} c={c} />
          <p>Your earlier payment details are no longer valid. {o.sign_again ? 'If you agree, you sign the deal sheet again with the new amount.' : ''}</p>
          <label className="check block">
            <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I agree to the new amount of {ccy(o.quote.due_minor, c)} to
            pay.
          </label>
          <button type="button" disabled={!read} onClick={() => answer('accept')}>
            Agree
          </button>
        </>
      ) : (
        <p className="problem">{o.quote.error}</p>
      )}
      <button type="button" className="secondary" onClick={() => answer('decline')}>
        Keep my amount
      </button>
      <Problem error={error} />
    </div>
  )
}

/** R-CMT-06: a new amount, quoted first; the server refuses a lower one once money has arrived. */
function ChangeAmount({ p, c, dealId, onDone }: { p: Participation; c: string; dealId: string; onDone: () => void }) {
  const [typed, setTyped] = useState('')
  const [quote, setQuote] = useState<(Quote & { for: string }) | null>(null)
  const asked = useRef(0)
  const { error, run } = useRun()
  const minor = typedAmountToDraft(typed)
  return (
    <form
      data-testid="change-amount"
      onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          if (!minor || !/^\d+$/.test(minor)) throw new Error('Type an amount, such as 12,000.')
          const n = ++asked.current
          const q = await api<Quote>(`/api/my/deals/${dealId}/quote`, 'POST', { commitment_minor: minor, replacing: p.id })
          if (n === asked.current) setQuote({ ...q, for: minor })
        })
      }}
    >
      <label>
        New amount ({c})
        <input inputMode="decimal" required value={typed} onChange={(e) => (setTyped(e.target.value), setQuote(null), asked.current++)} />
      </label>
      <button type="submit" className="secondary">
        Show what I would pay
      </button>
      {quote && !quote.ok && <p className="problem">{quote.error}</p>}
      {quote?.ok && (
        <>
          <QuoteDetails quote={quote} c={c} />
          <p>
            New amount to pay: <strong>{ccy(quote.due_minor, c)}</strong>. A signed deal sheet must be signed again, and earlier payment details stop being
            valid.
          </p>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                await api(`/api/my/participations/${p.id}/commitment`, 'PUT', { commitment_minor: quote.for, quoted_due_minor: quote.due_minor })
                onDone()
              })
            }
          >
            Change to {ccy(quote.due_minor, c)}
          </button>
        </>
      )}
      <Problem error={error} />
    </form>
  )
}

/** Narrow exceptions (§5.5): your own signed documents and valid instructions, whatever else has changed. No company named. */
export function MyDocuments() {
  const { data } = useData<{
    participations: Array<{ id: string; deal_code: string; signed: boolean; instruction: boolean; held: boolean; exclusion_notice: string | null }>
  }>('/api/my/participations')
  const rows = data?.participations.filter((p) => p.signed || p.instruction || p.held || p.exclusion_notice) ?? []
  if (!rows.length) return null
  return (
    <section className="card" data-testid="my-documents">
      <h2>Your documents</h2>
      <ul className="list">
        {rows.map((p) => (
          <li key={p.id}>
            <span className="mono">{p.deal_code}</span>
            <span className="row">
              {p.signed && <a {...fileLink(`/api/my/participations/${p.id}/signed`)}>Signed deal sheet</a>}
              {p.instruction && <a {...fileLink(`/api/my/participations/${p.id}/instructions.pdf`)}>Payment details</a>}
              {p.held && <span className="warning">Do not send money for this deal at the moment.</span>}
            </span>
            {/* R-PAY-07: reachable without the deal page, which closes when, say, the investor statement expires (Codex D4 screens round 1) */}
            {p.instruction && <ReportReference p={p} />}
            {p.exclusion_notice && <p className="notice">{p.exclusion_notice}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function MessageLead({ dealId }: { dealId: string }) {
  const [body, setBody] = useState('')
  const [sent, setSent] = useState(false)
  const { error, run } = useRun()
  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api(`/api/my/deals/${dealId}/message`, 'POST', { body })
      setBody('')
      setSent(true)
    })
  }
  return (
    <form className="card" onSubmit={send}>
      <h2>Ask the lead</h2>
      <label>
        Message
        <textarea required maxLength={5000} value={body} onChange={(e) => (setBody(e.target.value), setSent(false))} />
      </label>
      {sent && <p className="hint" role="status">Sent.</p>}
      <Problem error={error} />
      <button type="submit" className="secondary">
        Send
      </button>
    </form>
  )
}

export function MyDealPage({ id }: { id: string }) {
  const { data, error, reload } = useData<DealView>(`/api/my/deals/${id}`)
  // a pause or a lapse takes the deal off an open page too, not only on the next visit (Codex round 4)
  useRefresh(reload)
  const pass = useRun()
  if (error)
    return (
      <p className="card" role="alert">
        This deal is not available to you at the moment.
      </p>
    )
  if (!data) return null
  if (data.held)
    return (
      <p className="warning card" role="alert" data-testid="held">
        {data.deal_code}: {data.message}
      </p>
    )
  const c = data.key_terms.currency
  const fpo = data.warning.regime === 'uk-fpo'
  return (
    <>
      <TopWarning>
        <PromotionWarning w={data.warning} />
      </TopWarning>
      <section className="card" data-testid="deal-page">
        <h1>{data.name}</h1>
        <p>
          {data.company.legal_name}
          {data.company.website && (
            <>
              {' · '}
              <a href={data.company.website} rel="noreferrer noopener" target="_blank">
                Website
              </a>
            </>
          )}
          {' · '}
          <span className="hint">Reference {data.deal_code}</span>
        </p>
        <h2>Key terms</h2>
        <Terms k={data.key_terms} />
        <CustomTerms k={data.key_terms} />
        <p className="hint">{data.estimate_note}</p>
        {data.memo !== null && data.memo !== undefined && (
          <>
            <h2>Memo</h2>
            <RichView doc={data.memo} />
          </>
        )}
        {data.deck?.kind === 'link' && data.deck.embed_url && (
          <iframe
            className="deck-embed"
            src={data.deck.embed_url}
            title="Pitch deck"
            sandbox="allow-scripts allow-same-origin allow-popups"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        )}
        {data.deck?.kind === 'link' && data.deck.url && (
          <p>
            <a href={data.deck.url} rel="noreferrer noopener" target="_blank">
              Pitch deck
            </a>
          </p>
        )}
        {data.documents.length > 0 && (
          <>
            <h2>Documents</h2>
            <ul>
              {data.documents.map((f) => (
                <li key={f.id}>
                  <a {...fileLink(`/api/my/deals/${id}/files/${f.id}`)}>{f.display_name}</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {data.participations.length > 0 && <DealUpdates dealId={id} currency={c} />}
      {data.participations.map((p) => (
        <ParticipationCard key={p.id} p={p} c={c} fpo={fpo} dealId={id} onChange={() => void reload()} />
      ))}
      {data.waitlist && <WaitlistCard dealId={id} w={data.waitlist} c={c} onDone={() => void reload()} />}
      {data.can_commit && data.waitlist?.state !== 'waiting' && <CommitForm dealId={id} k={data.key_terms} onList={!!data.waitlist} onDone={() => void reload()} />}
      {data.can_commit && !data.participations.length && (
        <section className="card">
          <button
            type="button"
            className="secondary"
            onClick={() => void pass.run(async () => (await api(`/api/my/deals/${id}/pass`, 'POST', {}), openPage('/')))}
          >
            I will not invest
          </button>
          <Problem error={pass.error} />
        </section>
      )}
      <MessageLead dealId={id} />
    </>
  )
}

interface PreviewView {
  warnings: Array<Warning & { variant: string }>
  deal_code: string
  version: number
  name: string | null
  company: { legal_name: string | null; website: string | null }
  memo: unknown
  deck: { kind?: string; url?: string; embed_url?: string | null } | null
  documents: Array<{ id: string; display_name: string }>
  key_terms: KeyTerms
  commitment_effect: string
  note: string
}

/** R-ADM-01: the lead sees the investor page as it is on the default link's terms. Nothing on it can be done; nothing is recorded as a view. */
export function InvestorPreview({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false)
  const { data, error } = useData<PreviewView>(open ? `/api/deals/${dealId}/investor-preview` : null)
  return (
    <section className="card" data-testid="investor-preview">
      <h2>See it as an investor</h2>
      {!open ? (
        <p>
          <button type="button" className="secondary" onClick={() => setOpen(true)}>
            Show the investor page
          </button>
        </p>
      ) : (
        <>
          <p>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              Hide the investor page
            </button>
          </p>
          <Problem error={error} />
          {data && (
            <>
              <p className="hint" role="status">
                A preview of version {data.version}: nothing here can be done. {data.note}
              </p>
              {data.warnings.map((w) => (
                <div key={w.variant}>
                  <h3>Warning for {w.variant === 'default' ? 'everyone' : w.variant.replace(/_/g, ' ')}</h3>
                  <PromotionWarning w={w} />
                </div>
              ))}
              <h3>{data.name}</h3>
              <p>
                {data.company.legal_name}
                {data.company.website && <> · {data.company.website}</>} · <span className="hint">Reference {data.deal_code}</span>
              </p>
              <h3>Key terms</h3>
              <Terms k={data.key_terms} />
              <CustomTerms k={data.key_terms} />
              {data.memo !== null && data.memo !== undefined && (
                <>
                  <h3>Memo</h3>
                  <RichView doc={data.memo} />
                </>
              )}
              {data.deck?.kind === 'link' && data.deck.url && <p>Pitch deck: {data.deck.url}</p>}
              {data.documents.length > 0 && (
                <>
                  <h3>Documents</h3>
                  <ul>
                    {data.documents.map((f) => (
                      <li key={f.id}>{f.display_name}</li>
                    ))}
                  </ul>
                </>
              )}
              <p className="legal">{data.commitment_effect}</p>
            </>
          )}
        </>
      )}
    </section>
  )
}
