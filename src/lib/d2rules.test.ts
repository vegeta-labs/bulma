import { describe, expect, it } from 'vitest'
import {
  DEAL_EVENTS,
  DEAL_STATES,
  decideTransition,
  launchContentApproved,
  type DealActor,
  type DealEvent,
  type DealState,
  type TransitionFacts,
} from './dealState.ts'
import { contentOf, diffContent, stableJson } from './snapshot.ts'
import { investeeCanChange, investeeGaps, investeeLinkOpen, reminderAllowed, requiredInvesteeDocs, type InvesteeStatus } from './investee.ts'
import { canAdministerDeal, canApproveDealContent, canReviewDeal, isInterestedParty, type Actor, type DealParties } from './gate.ts'

const person = (over: Partial<Actor> = {}): Actor => ({ id: 'u1', roles: [], mustChangePassword: false, emailVerified: true, mfaOn: true, ...over })
const NO_STAKE: DealParties = { leadUserIds: ['lead'], memberUserIds: ['member'], carryRecipientEmails: ['carry@example.test'] }

describe('who may act on a deal', () => {
  const reviewer = person({ roles: ['reviewer'] })

  it.each([
    ['the lead', { ...NO_STAKE, leadUserIds: ['u1'] }, 'r@example.test'],
    ['a team member', { ...NO_STAKE, memberUserIds: ['u1'] }, 'r@example.test'],
    ['a carry recipient', NO_STAKE, 'carry@example.test'],
    ['a carry recipient whose address differs only in case and spaces', NO_STAKE, '  CARRY@Example.Test '],
  ])('TC-AUTHZ-04 %s cannot review or approve the content', (_who, parties, email) => {
    expect(canReviewDeal(reviewer, email, parties)).toBe(false)
    expect(canApproveDealContent(person({ roles: ['approver'] }), email, parties)).toBe(false)
  })

  it('TC-AUTHZ-04 a reviewer with no stake can review', () => {
    expect(isInterestedParty({ id: 'u1', email: 'r@example.test' }, NO_STAKE)).toBe(false)
    expect(canReviewDeal(reviewer, 'r@example.test', NO_STAKE)).toBe(true)
  })

  it('TC-AUTHZ-04 review needs the role and two-step sign-in, and nobody signed in can do nothing', () => {
    expect(canReviewDeal(person(), 'r@example.test', NO_STAKE)).toBe(false)
    expect(canReviewDeal(person({ roles: ['admin', 'approver'] }), 'r@example.test', NO_STAKE)).toBe(false)
    expect(canReviewDeal(person({ roles: ['reviewer'], mfaOn: false }), 'r@example.test', NO_STAKE)).toBe(false)
    expect(canReviewDeal(null, 'r@example.test', NO_STAKE)).toBe(false)
  })

  it('TC-OP-07 content approval needs the approver role; a reviewer alone does not have it', () => {
    expect(canApproveDealContent(person({ roles: ['approver'] }), 'a@example.test', NO_STAKE)).toBe(true)
    expect(canApproveDealContent(reviewer, 'a@example.test', NO_STAKE)).toBe(false)
  })

  it('TC-AUTHZ-03 only the lead and assigned members administer a deal', () => {
    expect(canAdministerDeal(person({ id: 'lead' }), NO_STAKE)).toBe(true)
    expect(canAdministerDeal(person({ id: 'member' }), NO_STAKE)).toBe(true)
    expect(canAdministerDeal(person({ id: 'someone-else' }), NO_STAKE)).toBe(false)
    expect(canAdministerDeal(person({ id: 'lead', emailVerified: false }), NO_STAKE)).toBe(false)
    expect(canAdministerDeal(person({ id: 'lead', mustChangePassword: true }), NO_STAKE)).toBe(false)
    expect(canAdministerDeal(null, NO_STAKE)).toBe(false)
  })
})

const NOW = new Date('2026-11-09T12:00:00Z')
const JUST_APPROVED = new Date('2026-11-08T12:00:00Z')
const good = (actor: DealActor): TransitionFacts => ({
  actor,
  now: NOW,
  gaps: [],
  reason: 'Because.',
  reviewerConflicted: false,
  contentApproved: true,
  leadConfirmed: true,
  approvedAt: JUST_APPROVED,
  confirmDays: 30,
})
const lapsed = (): TransitionFacts => ({ ...good('system'), approvedAt: new Date('2026-10-01T00:00:00Z') })

const LEGAL: Array<[DealState, DealEvent, DealState, DealActor]> = [
  ['draft', 'submit', 'in_review', 'lead'],
  ['in_review', 'withdraw', 'draft', 'lead'],
  ['in_review', 'request_changes', 'changes_requested', 'reviewer'],
  ['in_review', 'lead_edit', 'in_review', 'lead'],
  ['changes_requested', 'resubmit', 'in_review', 'lead'],
  ['in_review', 'reject', 'rejected', 'reviewer'],
  ['in_review', 'approve', 'approved', 'reviewer'],
  ['approved', 'lead_edit', 'in_review', 'lead'],
  ['approved', 'lapse', 'draft', 'system'],
  ['approved', 'launch', 'live', 'lead'],
]
const factsFor = (e: DealEvent, a: DealActor) => (e === 'lapse' ? { ...lapsed(), actor: a } : good(a))

describe('deal states', () => {
  it.each(LEGAL)('TC-DEAL-01 %s + %s goes to %s for the %s', (from, event, to, actor) => {
    expect(decideTransition(from, event, factsFor(event, actor))).toEqual({ ok: true, to })
  })

  it('TC-DEAL-01 every other state and event is refused, whoever asks and however good the facts', () => {
    let refused = 0
    for (const from of DEAL_STATES) {
      for (const event of DEAL_EVENTS) {
        for (const actor of ['lead', 'reviewer', 'system'] as const) {
          if (LEGAL.some((l) => l[0] === from && l[1] === event && l[3] === actor)) continue
          expect(decideTransition(from, event, factsFor(event, actor)).ok, `${from} ${event} ${actor}`).toBe(false)
          refused++
        }
      }
    }
    expect(refused).toBe(DEAL_STATES.length * DEAL_EVENTS.length * 3 - LEGAL.length)
  })

  it('TC-DEAL-01 a state or event that is not in the table is refused, not read off an object', () => {
    for (const bad of ['__proto__', 'constructor', 'toString']) {
      expect(decideTransition(bad as DealState, 'submit', good('lead')).ok).toBe(false)
      expect(decideTransition('draft', bad as DealEvent, good('lead')).ok).toBe(false)
    }
  })

  it.each(['submit', 'lead_edit', 'resubmit'] as const)('TC-DEAL-01 %s needs every required field, and refuses when that was not checked', (event) => {
    const from: DealState = event === 'submit' ? 'draft' : event === 'resubmit' ? 'changes_requested' : 'in_review'
    const r = decideTransition(from, event, { ...good('lead'), gaps: ['Deal name', 'SPV allocation'] })
    expect(r).toEqual({ ok: false, reason: 'Still missing: Deal name, SPV allocation.' })
    expect(decideTransition(from, event, { ...good('lead'), gaps: undefined }).ok).toBe(false)
  })

  it.each(['request_changes', 'reject'] as const)('TC-DEAL-01 %s needs a reason that is not blank', (event) => {
    expect(decideTransition('in_review', event, { ...good('reviewer'), reason: '   ' }).ok).toBe(false)
    expect(decideTransition('in_review', event, { ...good('reviewer'), reason: undefined }).ok).toBe(false)
  })

  it('TC-DEAL-01 approval needs no reason', () => {
    expect(decideTransition('in_review', 'approve', { ...good('reviewer'), reason: undefined })).toEqual({ ok: true, to: 'approved' })
  })

  it('TC-DEAL-01 content that is not approved cannot go live, and neither can an unconfirmed launch', () => {
    expect(decideTransition('approved', 'launch', { ...good('lead'), contentApproved: false })).toEqual({
      ok: false,
      reason: 'The content has not been approved.',
    })
    expect(decideTransition('approved', 'launch', { ...good('lead'), contentApproved: undefined }).ok).toBe(false)
    expect(decideTransition('approved', 'launch', { ...good('lead'), leadConfirmed: false }).ok).toBe(false)
    expect(decideTransition('approved', 'launch', { ...good('lead'), leadConfirmed: undefined }).ok).toBe(false)
  })

  it('TC-DEAL-01 the real mode needs the approved hash; a sandbox only when turned on', () => {
    const base = { contentSha256: 'abc', approvedSha256: ['old'] }
    expect(launchContentApproved({ ...base, mode: 'real', requiredInSandbox: false })).toBe(false)
    expect(launchContentApproved({ ...base, mode: 'real', approvedSha256: ['old', 'abc'], requiredInSandbox: false })).toBe(true)
    expect(launchContentApproved({ ...base, mode: 'sandbox', requiredInSandbox: false })).toBe(true)
    expect(launchContentApproved({ ...base, mode: 'sandbox', requiredInSandbox: true })).toBe(false)
  })

  const approvedAt = new Date('2026-10-01T00:00:00Z')
  const day30 = new Date('2026-10-31T00:00:00Z')
  const justBefore = new Date(day30.getTime() - 1)

  it('TC-DEAL-04 an approval lapses to draft at 30 days, not a moment before', () => {
    expect(decideTransition('approved', 'lapse', { ...good('system'), approvedAt, now: justBefore }).ok).toBe(false)
    expect(decideTransition('approved', 'lapse', { ...good('system'), approvedAt, now: day30 })).toEqual({ ok: true, to: 'draft' })
  })

  it('TC-DEAL-04 the period is the operator setting', () => {
    expect(decideTransition('approved', 'lapse', { ...good('system'), approvedAt, confirmDays: 10, now: new Date('2026-10-11T00:00:00Z') }).ok).toBe(true)
  })

  it('TC-DEAL-04 launch stops when the period ends, even if the job has not run yet', () => {
    expect(decideTransition('approved', 'launch', { ...good('lead'), approvedAt, now: justBefore }).ok).toBe(true)
    expect(decideTransition('approved', 'launch', { ...good('lead'), approvedAt, now: day30 })).toEqual({
      ok: false,
      reason: 'The time to confirm launch has run out.',
    })
  })

  it.each([[undefined], [0], [-1], [1.5], [Number.NaN]])('TC-DEAL-04 a period of %s neither lapses nor launches', (confirmDays) => {
    expect(decideTransition('approved', 'lapse', { ...good('system'), approvedAt, confirmDays }).ok).toBe(false)
    expect(decideTransition('approved', 'launch', { ...good('lead'), approvedAt, confirmDays }).ok).toBe(false)
  })

  it('TC-DEAL-04 an unknown approval date or clock neither lapses nor launches', () => {
    for (const a of [undefined, new Date('nonsense')]) {
      expect(decideTransition('approved', 'lapse', { ...good('system'), approvedAt: a }).ok).toBe(false)
      expect(decideTransition('approved', 'launch', { ...good('lead'), approvedAt: a }).ok).toBe(false)
    }
    expect(decideTransition('approved', 'launch', { ...good('lead'), now: new Date('nonsense') }).ok).toBe(false)
  })

  it('TC-DEAL-04 an edit after approval goes back to review', () => {
    expect(decideTransition('approved', 'lead_edit', good('lead'))).toEqual({ ok: true, to: 'in_review' })
  })

  it.each(['approve', 'request_changes', 'reject'] as const)(
    'TC-AUTHZ-04 a conflicted reviewer cannot %s, and an unchecked reviewer counts as conflicted',
    (event) => {
      expect(decideTransition('in_review', event, { ...good('reviewer'), reviewerConflicted: true }).ok).toBe(false)
      expect(decideTransition('in_review', event, { ...good('reviewer'), reviewerConflicted: undefined }).ok).toBe(false)
    },
  )
})

describe('investee rules', () => {
  it('TC-INV-02 the advance assurance letter is asked for only with tax relief', () => {
    expect(requiredInvesteeDocs(false)).toEqual(['incorporation_certificate', 'bank_statement', 'address_proof'])
    expect(requiredInvesteeDocs(true)).toContain('seis_eis_advance_assurance')
  })

  it('TC-INV-02 what is missing is listed, including the signature question', () => {
    expect(investeeGaps(['a', 'b'], ['a'], false)).toEqual(['b', 'needs_notarised_signature'])
    expect(investeeGaps(['a'], ['a'], true)).toEqual([])
  })

  it('TC-INV-01 a link is open until the moment it expires, and never once revoked', () => {
    const expiresAt = new Date('2026-11-20T00:00:00Z')
    expect(investeeLinkOpen({ expiresAt, revokedAt: null }, new Date(expiresAt.getTime() - 1))).toBe(true)
    expect(investeeLinkOpen({ expiresAt, revokedAt: null }, expiresAt)).toBe(false)
    expect(investeeLinkOpen({ expiresAt, revokedAt: new Date('2026-11-01T00:00:00Z') }, new Date('2026-11-02T00:00:00Z'))).toBe(false)
  })

  it('TC-INV-01 a reminder waits for the whole period', () => {
    const last = new Date('2026-11-09T00:00:00Z')
    expect(reminderAllowed(null, last, 24)).toBe(true)
    expect(reminderAllowed(last, new Date(last.getTime() + 24 * 3_600_000 - 1), 24)).toBe(false)
    expect(reminderAllowed(last, new Date(last.getTime() + 24 * 3_600_000), 24)).toBe(true)
  })

  it('TC-INV-02 documents can change only while waiting or returned', () => {
    expect(['waiting', 'submitted', 'approved', 'returned'].map((s) => investeeCanChange(s as InvesteeStatus))).toEqual([true, false, false, true])
  })

  it('TC-AUTHZ-04 being anywhere in the syndicate is a stake, but gives no access', () => {
    const p: DealParties = { ...NO_STAKE, otherSyndicateMemberIds: ['u1'] }
    expect(isInterestedParty({ id: 'u1', email: 'r@example.test' }, p)).toBe(true)
    expect(canAdministerDeal(person(), p)).toBe(false)
  })
})

describe('content and differences', () => {
  it('TC-PUB-01 the same content gives the same text whatever order its keys came in', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(stableJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }))
    expect(stableJson({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it('TC-REV-02 an empty field is no change, and confirmations are not content', () => {
    const a = { basics: { name: 'X', structure: '' }, terms: { seis: false, round: null as unknown as string }, attestations: { board_and_shareholders: true } }
    const b = { basics: { name: 'X' }, company: {}, economics: { recipients: [] } }
    expect(stableJson(contentOf(a))).toBe(stableJson(contentOf(b)))
    expect(contentOf(a)).toEqual({ basics: { name: 'X' } })
  })

  it('TC-REV-02 a value left from another instrument is no change', () => {
    const safe = (extra: object) => stableJson(contentOf({ terms: { instrument: 'safe', ...extra } }))
    expect(safe({ share_price_micros: '5', pre_money_minor: '9', fund_description: 'x' })).toBe(safe({}))
    expect(safe({ cap_type: 'none', cap_minor: '5' })).toBe(safe({ cap_type: 'none' }))
    expect(safe({ cap_type: 'pre_money', cap_minor: '5' })).not.toBe(safe({ cap_type: 'pre_money' }))
    expect(stableJson(contentOf({ terms: { instrument: 'equity', share_price_micros: '5' } }))).toContain('share_price_micros')
  })

  it('TC-REV-02 each changed field is listed once, with what it was and is', () => {
    expect(diffContent({ a: { b: '1' }, c: ['x'] }, { a: { b: '2' }, c: ['x', 'y'] })).toEqual([
      { field: 'a.b', before: '1', after: '2' },
      { field: 'c.1', before: null, after: 'y' },
    ])
    expect(diffContent({ a: 1 }, { a: 1 })).toEqual([])
  })

  it('TC-CHG-02 an empty value is shown as nothing, never as the word null; empty and absent still differ, and text "null" stays text', () => {
    expect(diffContent({ memo: null }, { memo: 'Fixed.' })).toEqual([{ field: 'memo', before: null, after: 'Fixed.' }])
    expect(diffContent({ memo: 'Old.' }, { memo: null })).toEqual([{ field: 'memo', before: 'Old.', after: null }])
    expect(diffContent({}, { memo: null })).toEqual([{ field: 'memo', before: null, after: null }])
    expect(diffContent({ memo: null }, { memo: 'null' })).toEqual([{ field: 'memo', before: null, after: 'null' }])
  })
})
