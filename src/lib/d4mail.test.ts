import { describe, expect, it } from 'vitest'
import {
  BODY_MAX,
  COMMIT_REMINDER_EVERY_DAYS,
  commitReminderDue,
  defaultTemplate,
  EDITABLE,
  endOfDay,
  escapeHtml,
  messageHtml,
  INVESTOR_ACTIONS,
  periodicReminderDue,
  pickContent,
  promotionalHtml,
  SAFETY_LINE,
  SUBJECT_MAX,
  templateKey,
  templateProblems,
  transactional,
  URGENT,
  urgent,
  type InvestorAction,
  type UrgentKind,
} from './mailContent.ts'
import { decideSend, MAX_ATTEMPTS, nextAttemptAt, RETRY_MINUTES, type Audience, type SendFacts } from './outbox.ts'

const user = (over: Partial<NonNullable<SendFacts['user']>> = {}) => ({ email: 'now@example.test', disabled: false, anonymised: false, ...over })
const sandbox = (over: Partial<SendFacts> = {}): SendFacts => ({ modeNow: 'sandbox', ...over })
const U = '00000000-0000-4000-8000-000000000001'
const D = '00000000-0000-4000-8000-000000000002'
const I = '00000000-0000-4000-8000-000000000003'

describe('mail queue rules (R23, R-NTF-02)', () => {
  it('TC-NTF-02 a mail queued in one mode never goes out in the other, whoever it is for', () => {
    const all: Audience[] = [
      { kind: 'address' },
      { kind: 'urgent', userId: U },
      { kind: 'account', userId: U },
      { kind: 'invite', inviteId: I, dealId: D },
      { kind: 'lead', userId: U, dealId: D },
      { kind: 'reminder', userId: U, dealId: D, about: 'payment', aboutId: I },
      { kind: 'message', userId: U, dealId: D, messageId: I },
    ]
    const fine: SendFacts = { modeNow: 'real', user: user(), stillHolds: true, dealLive: true, held: false }
    for (const a of all) {
      expect(decideSend(a, 'then@example.test', 'sandbox', fine)).toEqual({ send: false, reason: 'mode_changed' })
      expect(decideSend(a, 'then@example.test', 'real', fine).send).toBe(true)
    }
  })

  it('TC-NTF-02 an address mail goes to the address written; mail to an account goes to its current address', () => {
    expect(decideSend({ kind: 'address' }, 'typed@example.test', 'sandbox', sandbox())).toEqual({ send: true, to: 'typed@example.test' })
    expect(decideSend({ kind: 'account', userId: U }, 'then@example.test', 'sandbox', sandbox({ user: user() }))).toEqual({
      send: true,
      to: 'now@example.test',
    })
    expect(decideSend({ kind: 'lead', userId: U, dealId: D }, 'then@example.test', 'sandbox', sandbox({ user: user(), stillHolds: true }))).toEqual({
      send: true,
      to: 'now@example.test',
    })
  })

  it('TC-NTF-02 a closed or emptied account, or a role that ended, is not written to; the reason is given', () => {
    const acc: Audience = { kind: 'account', userId: U }
    expect(decideSend(acc, 'x@example.test', 'sandbox', sandbox({ user: null }))).toEqual({ send: false, reason: 'no_recipient' })
    expect(decideSend(acc, 'x@example.test', 'sandbox', sandbox({ user: user({ anonymised: true }) }))).toEqual({ send: false, reason: 'no_recipient' })
    expect(decideSend(acc, 'x@example.test', 'sandbox', sandbox({ user: user({ disabled: true }) }))).toEqual({ send: false, reason: 'recipient_disabled' })
    const lead: Audience = { kind: 'lead', userId: U, dealId: D }
    expect(decideSend(lead, 'x@example.test', 'sandbox', sandbox({ user: user(), stillHolds: false }))).toEqual({ send: false, reason: 'role_ended' })
    expect(decideSend(lead, 'x@example.test', 'sandbox', sandbox({ user: user({ disabled: true }), stillHolds: true }))).toEqual({
      send: false,
      reason: 'recipient_disabled',
    })
  })

  it('TC-NTF-01 / TC-NTF-03 an urgent notice is never stopped by a hold or a closed account, only by having no address', () => {
    const a: Audience = { kind: 'urgent', userId: U }
    expect(decideSend(a, 'then@example.test', 'sandbox', sandbox({ user: user({ disabled: true }), held: true }))).toEqual({
      send: true,
      to: 'now@example.test',
    })
    expect(decideSend(a, 'then@example.test', 'sandbox', sandbox({ user: user({ anonymised: true }) }))).toEqual({ send: false, reason: 'no_recipient' })
    expect(decideSend(a, 'then@example.test', 'sandbox', sandbox({ user: null }))).toEqual({ send: false, reason: 'no_recipient' })
  })

  it('TC-NTF-02 an invitation goes only while it is open, the deal live and nothing held', () => {
    const a: Audience = { kind: 'invite', inviteId: I, dealId: D }
    const ok = sandbox({ stillHolds: true, dealLive: true, held: false })
    expect(decideSend(a, 'invitee@example.test', 'sandbox', ok)).toEqual({ send: true, to: 'invitee@example.test' })
    expect(decideSend(a, 'invitee@example.test', 'sandbox', { ...ok, stillHolds: false })).toEqual({ send: false, reason: 'role_ended' })
    expect(decideSend(a, 'invitee@example.test', 'sandbox', { ...ok, held: true })).toEqual({ send: false, reason: 'held' })
    expect(decideSend(a, 'invitee@example.test', 'sandbox', { ...ok, dealLive: false })).toEqual({ send: false, reason: 'deal_not_live' })
  })

  it('TC-NTF-02 five retries after the first attempt, waiting at most 24 hours, then none', () => {
    const t = new Date('2026-11-12T10:00:00.000Z')
    expect(MAX_ATTEMPTS).toBe(6)
    expect(nextAttemptAt(0, t)).toBeNull()
    const waits = [1, 2, 3, 4, 5].map((n) => (nextAttemptAt(n, t)!.getTime() - t.getTime()) / 60_000)
    expect(waits).toEqual([1, 10, 60, 360, 1440])
    expect(Math.max(...RETRY_MINUTES)).toBe(24 * 60)
    for (let i = 1; i < waits.length; i++) expect(waits[i]!).toBeGreaterThan(waits[i - 1]!)
    expect(nextAttemptAt(6, t)).toBeNull()
    expect(nextAttemptAt(7, t)).toBeNull()
  })
})

describe('reminders in the queue (R-NTF-01, R-NTF-02)', () => {
  it('TC-NTF-02 a reminder goes to the current address only while the step is still to do, the deal open and not paused', () => {
    const a: Audience = { kind: 'reminder', userId: U, dealId: D, about: 'payment', aboutId: I }
    const ok = sandbox({ user: user(), stillHolds: true, dealLive: true, held: false })
    expect(decideSend(a, 'then@example.test', 'sandbox', ok)).toEqual({ send: true, to: 'now@example.test' })
    expect(decideSend(a, 'x', 'sandbox', { ...ok, stillHolds: false })).toEqual({ send: false, reason: 'role_ended' })
    expect(decideSend(a, 'x', 'sandbox', { ...ok, held: true })).toEqual({ send: false, reason: 'held' })
    expect(decideSend(a, 'x', 'sandbox', { ...ok, dealLive: false })).toEqual({ send: false, reason: 'deal_not_live' })
    expect(decideSend(a, 'x', 'sandbox', { ...ok, user: user({ disabled: true }) })).toEqual({ send: false, reason: 'recipient_disabled' })
    expect(decideSend(a, 'x', 'sandbox', { ...ok, user: null })).toEqual({ send: false, reason: 'no_recipient' })
    // an account notice is not held back by a pause (it asks nothing)
    expect(decideSend({ kind: 'account', userId: U }, 'x', 'sandbox', { ...ok, held: true, dealLive: false, stillHolds: false }).send).toBe(true)
  })
})

describe('mail content (R-NTF-01, R-COM-04, R-COM-06)', () => {
  const f = { code: 'ABC234', deadline: '2026-12-31', operator: 'Example Operator Ltd', link: 'https://deals.example.test/' }
  // every line an investor mail may have: the fixed fields and nothing else
  const FIXED = [/^Hello,$/, /^$/, /^Deadline for this step: \d{4}-\d{2}-\d{2}$/, /^Deal reference: [A-Z0-9]+$/, /^From: .+$/, /^Sign in: https?:\/\/\S+$/, new RegExp(`^${SAFETY_LINE.replace(/\./g, '\\.')}$`)]

  it('TC-NTF-01 an investor mail has only the fixed fields: greeting, action, deadline, code, operator, link, safety line', () => {
    for (const action of Object.keys(INVESTOR_ACTIONS) as InvestorAction[]) {
      const r = transactional(action, f)
      expect(r.subject).toBe(`${INVESTOR_ACTIONS[action]} (deal ABC234)`)
      for (const line of r.text.split('\n')) expect(line === `${INVESTOR_ACTIONS[action]}.` || FIXED.some((p) => p.test(line)), line).toBe(true)
      expect(r.text).toContain('Deadline for this step: 2026-12-31')
      expect(r.text).toContain('Deal reference: ABC234')
      expect(r.text).toContain('From: Example Operator Ltd')
      expect(r.text).toContain('Sign in: https://deals.example.test/')
      expect(r.text.endsWith(SAFETY_LINE)).toBe(true)
    }
    // a field left out leaves no line behind
    const bare = transactional('kyc_passed', { operator: 'Op', link: 'https://x.test/' })
    expect(bare.subject).toBe('Identity check passed')
    expect(bare.text).not.toMatch(/Deadline|Deal reference/)
    // the assessment notice is neutral (TC-ELG-03)
    expect(JSON.stringify(transactional('assessment_retake', f))).not.toMatch(/try again|retake|last chance|hurry|soon|don't miss/i)
  })

  it('TC-NTF-01 / TC-NTF-03 urgent notices say the action in the title and hold nothing about the deal but its code', () => {
    for (const kind of Object.keys(URGENT) as UrgentKind[]) {
      const r = urgent(kind, f)
      if (kind !== 'hold_ended') expect(r.subject).toMatch(/^Do not (send money|pay)/)
      expect(r.subject.endsWith('(deal ABC234)')).toBe(true)
      for (const line of r.text.split('\n')) expect(line === URGENT[kind].line || FIXED.some((p) => p.test(line)), line).toBe(true)
      // no amount, date or name of anything
      expect(URGENT[kind].line).not.toMatch(/\d/)
    }
    expect(urgent('void_kyc', f).subject).toBe('Do not send money: your earlier payment instructions are no longer valid (deal ABC234)')
    expect(urgent('hold', f).subject).toBe('Do not send money for now (deal ABC234)')
  })

  it('TC-NTF-03 an urgent notice, an invitation or an unknown mail cannot be edited; a template uses only the fixed fields', () => {
    expect(templateProblems('urgent.hold', 'Hi', 'Text')).toEqual(['Urgent notices cannot be changed.'])
    expect(templateProblems('urgent.anything', 'Hi', 'Text')).toEqual(['Urgent notices cannot be changed.'])
    expect(templateProblems('investor.invitation', 'Hi', 'Text')).toEqual(['This mail cannot be changed.'])
    expect(templateProblems('investor.nope', 'Hi', 'Text')).toEqual(['This mail cannot be changed.'])
    expect(templateProblems('lead.co_lead', 'Hi', 'Text')).toEqual(['This mail cannot be changed.'])
    for (const a of EDITABLE) expect(templateProblems(templateKey(a), 'Pay for {code}', 'Hello {link} {operator} {deadline} {code}')).toEqual([])
    // a variable that could carry deal content is refused, in the subject or the text
    expect(templateProblems('investor.payment_reminder', 'Hi {company_name}', 'x').join(' ')).toMatch(/\{company_name\} is not a field/)
    expect(templateProblems('investor.payment_reminder', 'Hi', 'You owe {amount}').join(' ')).toMatch(/\{amount\} is not a field/)
    expect(templateProblems('investor.payment_reminder', 'Hi', 'Odd {} braces').join(' ')).toMatch(/\{\} is not a field/)
    // a line break in the subject would start a new header
    for (const s of ['Hi\r\nBcc: x@example.test', 'Hi\u202eereht', 'Hi\u200bthere', 'Hi\nthere', 'Hi there', '', ' ', 'x'.repeat(SUBJECT_MAX + 1)])
      expect(templateProblems('investor.payment_reminder', s, 'Text').join(' ')).toMatch(/one line/)
    expect(templateProblems('investor.payment_reminder', 'x'.repeat(SUBJECT_MAX), 'Text')).toEqual([])
    expect(templateProblems('investor.payment_reminder', 'Hi', 'x'.repeat(BODY_MAX + 1)).join(' ')).toMatch(/1 to 5000/)
    expect(templateProblems('investor.payment_reminder', 'Hi', ' \n ').join(' ')).toMatch(/1 to 5000/)
    // what the operator starts from is accepted as it is
    for (const a of EDITABLE) expect(templateProblems(templateKey(a), defaultTemplate(a).subject, defaultTemplate(a).body)).toEqual([])
  })

  it('TC-COM-04 a promotional mail is HTML only, the warning block first, everything the operator wrote escaped', () => {
    const w = { text: 'Risk: **you could lose all the money you invest**.\n\nSecond <para>.', sender: 'Example & Co' }
    const r = promotionalHtml('Pay {code} <now>', 'Hello <script>alert(1)</script>\n\nRef {code} from {operator}, by {deadline}: {link}', f, w)
    expect(r.subject).toBe('Pay ABC234 <now>')
    const body = r.text.slice(r.text.indexOf('<body>') + '<body>'.length)
    // nothing before the warning block, and the operator's words only after it
    expect(body.startsWith('<div role="note" id="warning"><p>Risk: <strong>you could lose all the money you invest</strong>.</p><p>Second &lt;para&gt;.</p><p>Sent by: Example &amp; Co</p></div>')).toBe(true)
    expect(body.indexOf('Hello')).toBeGreaterThan(body.indexOf('</div>'))
    expect(r.text).not.toContain('<script>')
    expect(r.text).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(r.text).toContain('Ref ABC234 from Example Operator Ltd, by 2026-12-31: https://deals.example.test/')
    expect(r.text).toContain('<title>Pay ABC234 &lt;now&gt;</title>')
    expect(r.text).toContain(escapeHtml(SAFETY_LINE))
    // no styles: nothing for a mail program to theme the warning away with
    expect(r.text).not.toMatch(/style|class=/i)
    // a value is escaped too
    expect(promotionalHtml('S', '{operator}', { ...f, operator: '<b>Op</b>' }, w).text).toContain('&lt;b&gt;Op&lt;/b&gt;')
  })

  it('TC-COM-04 the edited version goes only with approved wording, to someone who passes today, under the warning they get now', () => {
    for (const approved of [true, false])
      for (const recipientPasses of [true, false])
        for (const warningCurrent of [true, false])
          expect(pickContent({ approved, recipientPasses, warningCurrent })).toBe(approved && recipientPasses && warningCurrent ? 'promo' : 'fixed')
  })

  it('TC-NTF-01 commitment reminders: the operator\'s count, which can be 0, every three days from the invitation', () => {
    const sent = new Date('2026-11-01T10:00:00.000Z')
    const at = (days: number) => new Date(sent.getTime() + days * 86_400_000)
    expect(COMMIT_REMINDER_EVERY_DAYS).toBe(3)
    expect(commitReminderDue(sent, 0, 0, at(100))).toBe(false)
    expect(commitReminderDue(sent, 0, 2, at(3))).toBe(true)
    expect(commitReminderDue(sent, 0, 2, new Date(at(3).getTime() - 1))).toBe(false)
    expect(commitReminderDue(sent, 1, 2, at(5.9))).toBe(false)
    expect(commitReminderDue(sent, 1, 2, at(6))).toBe(true)
    expect(commitReminderDue(sent, 2, 2, at(100))).toBe(false)
  })

  it('TC-NTF-01 payment and reconfirmation reminders: every so many days until the deadline; none without one, none at 0', () => {
    const from = new Date('2026-11-01T10:00:00.000Z')
    const at = (days: number) => new Date(from.getTime() + days * 86_400_000)
    const until = endOfDay('2026-11-10')
    expect(until.toISOString()).toBe('2026-11-10T23:59:59.999Z')
    expect(periodicReminderDue(from, null, 3, until, at(3))).toBe(true)
    expect(periodicReminderDue(from, null, 3, until, new Date(at(3).getTime() - 1))).toBe(false)
    expect(periodicReminderDue(from, at(3), 3, until, at(5))).toBe(false)
    expect(periodicReminderDue(from, at(3), 3, until, at(6))).toBe(true)
    expect(periodicReminderDue(from, at(6), 3, until, at(9))).toBe(true)
    // the deadline has passed: nothing more
    expect(periodicReminderDue(from, at(9), 3, until, new Date(until.getTime() + 1))).toBe(false)
    expect(periodicReminderDue(from, null, 3, until, until)).toBe(true)
    // due by the interval, but the deadline has gone
    expect(periodicReminderDue(from, at(6), 3, until, at(12))).toBe(false)
    expect(periodicReminderDue(from, null, 3, null, at(30))).toBe(false)
    expect(periodicReminderDue(from, null, 0, until, at(5))).toBe(false)
  })
})

describe('a lead\'s message in the queue (R-COM-02, R-COM-04, R-CMP-01)', () => {
  const a: Audience = { kind: 'message', userId: U, dealId: D, messageId: I }
  const f = (over: Partial<SendFacts> = {}): SendFacts => ({ modeNow: 'sandbox', user: user(), stillHolds: true, held: false, ...over })

  it('TC-COM-02 decided again before each attempt: the current address; not when paused, ended or closed', () => {
    expect(decideSend(a, 'then@example.test', 'sandbox', f())).toEqual({ send: true, to: 'now@example.test' })
    expect(decideSend(a, 'then@example.test', 'sandbox', f({ held: true }))).toEqual({ send: false, reason: 'held' })
    expect(decideSend(a, 'then@example.test', 'sandbox', f({ stillHolds: false }))).toEqual({ send: false, reason: 'role_ended' })
    // a hold is said first: the person may still take part once it ends
    expect(decideSend(a, 'then@example.test', 'sandbox', f({ held: true, stillHolds: false }))).toEqual({ send: false, reason: 'held' })
    expect(decideSend(a, 'then@example.test', 'sandbox', f({ user: user({ disabled: true }) }))).toEqual({ send: false, reason: 'recipient_disabled' })
    expect(decideSend(a, 'then@example.test', 'sandbox', f({ user: user({ anonymised: true }) }))).toEqual({ send: false, reason: 'no_recipient' })
    expect(decideSend(a, 'then@example.test', 'sandbox', f({ user: null }))).toEqual({ send: false, reason: 'no_recipient' })
  })

  it('TC-COM-04 the message as HTML, the warning first, the text as typed: braces stay, markup is escaped', () => {
    const r = messageHtml('Call {code} <soon>', 'Hi {link}\n\n<b>x</b>', { code: 'AB12', operator: 'Op', link: 'https://x.test/' }, { text: '**Warning** text', sender: 'Op Ltd' })
    expect(r.subject).toBe('Call {code} <soon>')
    const body = r.text.slice(r.text.indexOf('<body>') + 6)
    expect(body.startsWith('<div role="note" id="warning"><p><strong>Warning</strong> text</p><p>Sent by: Op Ltd</p></div><hr>')).toBe(true)
    expect(r.text).toContain('<p>Hi {link}</p><p>&lt;b&gt;x&lt;/b&gt;</p>')
    expect(r.text).toContain('<title>Call {code} &lt;soon&gt;</title>')
  })

  it('TC-COM-02 the sign-in notice holds only the fixed fields', () => {
    const n = transactional('new_message', { code: 'AB12', operator: 'Op', link: 'https://x.test/' })
    expect(n.subject).toBe('You have a new message about a deal: sign in to read it (deal AB12)')
    expect(n.text.endsWith(SAFETY_LINE)).toBe(true)
  })
})
