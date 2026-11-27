import { randomInt } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { STATUSES, deriveStatus, stepsAfterCommit, type StatusFacts } from './participation.ts'
import {
  canCommit,
  canContinueOwnParticipation,
  canReceiveCompanyUpdate,
  canReceivePromotion,
  canSeeIssuedInstructions,
  canSeeOwnExecutedDocs,
  canSeePaymentInstructions,
  canSign,
  type AnyDealState,
  type DealGateFacts,
  type OwnParticipationFacts,
  type PersonGateFacts,
} from './gate.ts'
import { csvCell, MAX_PIPELINE_ROWS, parsePipeline, PIPELINE_BODY_MAX, PIPELINE_CSV_HEADER, PIPELINE_TEXT_MAX, pipelineTotals } from './pipeline.ts'
import {
  COUNTRY_CHOICES,
  EEA,
  OTHER_COUNTRY,
  countPeople,
  countWarnings,
  decideAccept,
  needsTermsApproval,
  newLinkRefusal,
  type AcceptFacts,
  type NewLinkFacts,
} from './invite.ts'

const FPO = {
  steps: ['statement', 'assessment', 'warning_block', 'view_deal', 'commit', 'kyc', 'sign', 'payment_instructions'].map((kind) => ({ kind })),
} as never
const SIGN_FIRST = { steps: ['statement', 'warning_block', 'view_deal', 'commit', 'sign', 'kyc', 'payment_instructions'].map((kind) => ({ kind })) } as never

const part = (over: Partial<NonNullable<StatusFacts['participation']>> = {}): NonNullable<StatusFacts['participation']> => ({
  outcome: 'active',
  kycPassed: true,
  reconfirmPending: false,
  amountProposalPending: false,
  signed: true,
  transferMarked: false,
  held: 0n,
  due: 1_100_000n,
  invested: null,
  identityReview: false,
  ...over,
})
const facts = (p: StatusFacts['participation'], over: Partial<StatusFacts> = {}): StatusFacts => ({
  invitation: 'active',
  qualified: true,
  statementExpired: false,
  waitlisted: false,
  participation: p,
  ...over,
})

describe('§5.2 investor status', () => {
  it('TC-STAT-01 before committing', () => {
    expect(deriveStatus(facts(null, { invitation: null }), FPO).status).toBe('not_responded')
    expect(deriveStatus(facts(null, { qualified: false }), FPO).status).toBe('getting_set_up')
    expect(deriveStatus(facts(null), FPO).status).toBe('deciding')
    expect(deriveStatus(facts(null, { waitlisted: true }), FPO).status).toBe('waitlisted')
    expect(deriveStatus(facts(null, { invitation: 'passed' }), FPO).status).toBe('declined')
  })
  it('TC-STAT-01 terminal outcomes come first', () => {
    expect(deriveStatus(facts(part({ outcome: 'rejected_kyc', held: 500n })), FPO).status).toBe('not_approved')
    expect(deriveStatus(facts(part({ outcome: 'withdrawn' })), FPO).status).toBe('withdrawn')
    expect(deriveStatus(facts(part({ outcome: 'deal_cancelled' })), FPO).status).toBe('cancelled')
  })
  it('TC-STAT-01 steps in pack order, then the money', () => {
    expect(deriveStatus(facts(part({ kycPassed: false, signed: false })), FPO).status).toBe('verifying')
    expect(deriveStatus(facts(part({ signed: false })), FPO).status).toBe('to_sign')
    expect(deriveStatus(facts(part({ reconfirmPending: true, signed: false })), FPO).status).toBe('reconfirm')
    expect(deriveStatus(facts(part()), FPO).status).toBe('to_pay')
    expect(deriveStatus(facts(part({ transferMarked: true })), FPO).status).toBe('payment_sent')
    expect(deriveStatus(facts(part({ held: 500n, transferMarked: true })), FPO).status).toBe('part_paid')
    expect(deriveStatus(facts(part({ held: 1_100_000n })), FPO).status).toBe('funded')
    expect(deriveStatus(facts(part({ held: 1_100_001n })), FPO).status).toBe('refund_due')
    expect(deriveStatus(facts(part({ held: 1_100_000n, invested: 1_000_000n })), FPO).status).toBe('invested')
  })
  it('TC-STAT-01 £11,000 in, £1,000 back, then D raised to £11,000: part paid, £1,000 short', () => {
    expect(deriveStatus(facts(part({ held: 1_000_000n, due: 1_100_000n })), FPO).status).toBe('part_paid')
  })
  it('TC-STAT-01 N below zero: the overlay, and underneath it as if nothing were held', () => {
    expect(deriveStatus(facts(part({ held: -1n })), FPO)).toEqual({ status: 'to_pay', overlays: ['needs_check'] })
    expect(deriveStatus(facts(part({ held: -1n, transferMarked: true })), FPO)).toEqual({ status: 'payment_sent', overlays: ['needs_check'] })
  })
  it('TC-STAT-02 a pack that signs before KYC: the status follows the pack', () => {
    expect(stepsAfterCommit(SIGN_FIRST)).toEqual(['reconfirm', 'confirm_amount', 'sign', 'kyc', 'pay'])
    expect(deriveStatus(facts(part({ kycPassed: false, signed: false })), SIGN_FIRST).status).toBe('to_sign')
    expect(deriveStatus(facts(part({ kycPassed: false })), SIGN_FIRST).status).toBe('verifying')
  })
  it('TC-STAT-01 property: any facts give exactly one known status', () => {
    const b = () => randomInt(2) === 1
    for (let i = 0; i < 5000; i++) {
      const p = b()
        ? part({
            outcome: (['active', 'removed', 'withdrawn', 'deal_cancelled', 'rejected_kyc', 'excluded_at_close'] as const)[randomInt(6)],
            kycPassed: b(),
            reconfirmPending: b(),
            amountProposalPending: b(),
            signed: b(),
            transferMarked: b(),
            held: BigInt(randomInt(-3, 4)),
            due: BigInt(randomInt(1, 4)),
            invested: b() ? null : BigInt(randomInt(0, 3)),
            identityReview: b(),
          })
        : null
      const f = facts(p, { invitation: ([null, 'active', 'passed', 'revoked'] as const)[randomInt(4)], qualified: b(), statementExpired: b(), waitlisted: b() })
      const got = deriveStatus(f, b() ? FPO : SIGN_FIRST)
      expect(STATUSES).toContain(got.status)
    }
  })
})

const person = (over: Partial<PersonGateFacts> = {}): PersonGateFacts => ({ qualified: true, invitationActive: true, ...over })
const deal = (over: Partial<DealGateFacts> = {}): DealGateFacts => ({
  state: 'live',
  holds: { deal: false, lead: false, instance: false },
  finalConfirmed: false,
  ...over,
})
const own = (over: Partial<OwnParticipationFacts> = {}): OwnParticipationFacts => ({
  outcome: 'active',
  kycPassed: true,
  signed: true,
  identityReview: false,
  entityVersionCurrent: true,
  reconfirmPending: false,
  needsCheck: false,
  accountAcknowledged: true,
  ...over,
})

describe('§5.5 gates', () => {
  const unqualified: Array<[string, Partial<PersonGateFacts>]> = [
    ['no statement, expired, chose neither, assessment locked, cooling-off not over, warning not confirmed', { qualified: false }],
    ['no invitation in progress', { invitationActive: false }],
  ]
  const holds: Array<[string, Partial<DealGateFacts>]> = [
    ['deal hold', { holds: { deal: true, lead: false, instance: false } }],
    ['lead hold', { holds: { deal: false, lead: true, instance: false } }],
    ['instance hold', { holds: { deal: false, lead: false, instance: true } }],
  ]

  it.each(unqualified)('TC-GATE-02 promotion is refused: %s', (_w, p) => {
    expect(canReceivePromotion(person(p), deal())).toBe(false)
    expect(canCommit(person(p), deal(), true)).toBe(false)
  })
  it.each(holds)('TC-GATE-02 / TC-CMP-01 every new step stops under a %s', (_w, d) => {
    expect(canReceivePromotion(person(), deal(d))).toBe(false)
    expect(canContinueOwnParticipation(person(), own(), deal(d))).toBe(false)
    expect(canSign(person(), own({ signed: false }), deal(d), true)).toBe(false)
    expect(canSeePaymentInstructions(person(), own(), deal(d))).toBe(false)
    expect(canSeeIssuedInstructions(true, { voided: false }, deal(d))).toBe(false)
    expect(canReceiveCompanyUpdate(5n, deal({ ...d, state: 'closed' }))).toBe(false)
    // signed files stay the person's own
    expect(canSeeOwnExecutedDocs(true)).toBe(true)
  })
  it('TC-GATE-02 continuing needs the current eligibility as well', () => {
    expect(canContinueOwnParticipation(person({ qualified: false }), own(), deal())).toBe(false)
    expect(canContinueOwnParticipation(person(), own({ outcome: 'withdrawn' }), deal())).toBe(false)
    // a link turned off does not matter once committed
    expect(canContinueOwnParticipation(person({ invitationActive: false }), own(), deal())).toBe(true)
  })
  it('TC-GATE-03 narrow exceptions: signed files and issued instructions without eligibility; nothing else', () => {
    const lapsed = person({ qualified: false })
    expect(canSeeOwnExecutedDocs(true)).toBe(true)
    expect(canSeeOwnExecutedDocs(false)).toBe(false)
    expect(canSeeIssuedInstructions(true, { voided: false }, deal())).toBe(true)
    expect(canSeeIssuedInstructions(true, { voided: true }, deal())).toBe(false)
    expect(canSeeIssuedInstructions(false, { voided: false }, deal())).toBe(false)
    expect(canSeePaymentInstructions(lapsed, own(), deal())).toBe(false)
    expect(canSign(lapsed, own({ signed: false }), deal(), true)).toBe(false)
    expect(canReceivePromotion(lapsed, deal())).toBe(false)
  })

  const STATES: AnyDealState[] = ['draft', 'in_review', 'approved', 'live', 'closing_requested', 'closing', 'settled', 'closed', 'cancelled', 'archived']
  it.each(STATES)('TC-GATE-04 each gate in state %s', (state) => {
    const d = deal({ state })
    expect(canReceivePromotion(person(), d)).toBe(state === 'live')
    const goes = ['live', 'closing_requested', 'closing'].includes(state)
    expect(canContinueOwnParticipation(person(), own(), d)).toBe(goes)
    expect(canSign(person(), own({ signed: false }), d, true)).toBe(goes)
    expect(canSeePaymentInstructions(person(), own(), d)).toBe(goes)
    expect(canReceiveCompanyUpdate(5n, d)).toBe(state === 'closed')
    // after the final amounts are confirmed, closing allows neither
    expect(canSign(person(), own({ signed: false }), deal({ state, finalConfirmed: true }), true)).toBe(goes && state !== 'closing')
  })
  it('TC-SIG-01 signing waits for KYC unless the pack signs first', () => {
    expect(canSign(person(), own({ kycPassed: false, signed: false }), deal(), true)).toBe(false)
    expect(canSign(person(), own({ kycPassed: false, signed: false }), deal(), false)).toBe(true)
    expect(canSign(person(), own({ signed: true }), deal(), true)).toBe(false)
  })
  it('TC-STAT-02 instructions stay blocked until KYC passes, whatever the order', () => {
    expect(canSeePaymentInstructions(person(), own({ kycPassed: false }), deal())).toBe(false)
    expect(canSeePaymentInstructions(person(), own({ signed: false }), deal())).toBe(false)
  })
  it.each([
    ['identity review', { identityReview: true }],
    ['an older entity version', { entityVersionCurrent: false }],
    ['a reconfirmation pending', { reconfirmPending: true }],
    ['N below zero', { needsCheck: true }],
    ['the new account not acknowledged', { accountAcknowledged: false }],
  ] as const)('TC-ENT-01 / TC-OP-05 no new instructions with %s', (_w, o) => {
    expect(canSeePaymentInstructions(person(), own(o), deal())).toBe(false)
  })
  it('TC-GATE-10 an entity without what the pack asks cannot commit', () => {
    expect(canCommit(person(), deal(), false)).toBe(false)
    expect(canCommit(person(), deal(), true)).toBe(true)
  })
})

const link = (over: Partial<NewLinkFacts> = {}): NewLinkFacts => ({
  dealLive: true,
  activeLinks: 2,
  defaultCarryBps: 2000,
  feeMaxBps: 2500,
  policy: { perLinkTerms: true, genericLinks: true },
  kind: 'open',
  terms: { carryBps: 2000, fee: { kind: 'none' } },
  reason: null,
  incentiveAttested: false,
  attestationRequired: false,
  ...over,
})

describe('R-LNK links', () => {
  it('TC-LNK-01 only while live', () => {
    expect(newLinkRefusal(link({ dealLive: false }))).toMatch(/live/)
  })
  it('TC-LNK-02 the 500th link can be made, the 501st cannot', () => {
    expect(newLinkRefusal(link({ activeLinks: 499 }))).toBeNull()
    expect(newLinkRefusal(link({ activeLinks: 500 }))).toMatch(/500/)
  })
  it('TC-LNK-08 COBS: different terms need a reason and the attestation, then a reviewer', () => {
    const terms = { carryBps: 1000, fee: { kind: 'none' as const } }
    expect(newLinkRefusal(link({ terms, attestationRequired: true }))).toMatch(/why/)
    expect(newLinkRefusal(link({ terms, attestationRequired: true, reason: 'Early backer' }))).toMatch(/incentive/)
    expect(newLinkRefusal(link({ terms, attestationRequired: true, reason: 'Early backer', incentiveAttested: true }))).toBeNull()
    expect(needsTermsApproval(terms, 2000, true)).toBe(true)
    expect(needsTermsApproval(terms, 2000, false)).toBe(false)
    expect(needsTermsApproval({ carryBps: 2000, fee: { kind: 'none' } }, 2000, true)).toBe(false)
  })
  it('TC-CMP-03 / TC-LNK-11 the switches', () => {
    const terms = { carryBps: 0, fee: { kind: 'none' as const } }
    expect(newLinkRefusal(link({ terms, reason: 'x', policy: { perLinkTerms: false, genericLinks: true } }))).toMatch(/differ/)
    expect(newLinkRefusal(link({ policy: { perLinkTerms: false, genericLinks: true } }))).toBeNull()
    expect(newLinkRefusal(link({ policy: { perLinkTerms: true, genericLinks: false } }))).toMatch(/named address/)
    expect(newLinkRefusal(link({ kind: 'terms_only', policy: { perLinkTerms: true, genericLinks: false } }))).toBeNull()
  })
  it('TC-FEE-07 a link above the operator fee limit is refused', () => {
    expect(newLinkRefusal(link({ terms: { carryBps: 2000, fee: { kind: 'percent', bps: 2501, mode: 'on_top' } }, reason: 'x' }))).toMatch(/above/)
  })

  const accept = (over: Partial<AcceptFacts> = {}): AcceptFacts => ({
    dealLive: true,
    held: false,
    link: { disabled: false, closingPaused: false, awaitingApproval: false },
    person: { activeInvitation: false, endedBefore: false },
    targeted: null,
    verifiedEmail: 'a@example.test',
    sameDemoSide: true,
    ...over,
  })
  const t = (over: Partial<NonNullable<AcceptFacts['targeted']>> = {}) => ({
    email: 'a@example.test',
    consumed: false,
    revoked: false,
    allowsReentry: false,
    ...over,
  })

  it('TC-LNK-04 / TC-LNK-10 accepting', () => {
    expect(decideAccept(accept())).toEqual({ ok: true, kind: 'new' })
    expect(decideAccept(accept({ targeted: t({ email: ' A@Example.test ' }) }))).toEqual({ ok: true, kind: 'new' })
    expect(decideAccept(accept({ targeted: t({ email: 'b@example.test' }) }))).toEqual({ ok: false, reason: 'wrong_address' })
    expect(decideAccept(accept({ targeted: t({ consumed: true }) }))).toEqual({ ok: false, reason: 'consumed' })
    expect(decideAccept(accept({ dealLive: false }))).toEqual({ ok: false, reason: 'deal_not_open' })
    expect(decideAccept(accept({ held: true }))).toEqual({ ok: false, reason: 'held' })
    expect(decideAccept(accept({ link: { disabled: true, closingPaused: false, awaitingApproval: false } }))).toEqual({ ok: false, reason: 'link_unusable' })
    expect(decideAccept(accept({ link: { disabled: false, closingPaused: false, awaitingApproval: true } }))).toEqual({ ok: false, reason: 'link_unusable' })
  })
  it('TC-LNK-05 a second link keeps the terms already held', () => {
    expect(decideAccept(accept({ person: { activeInvitation: true, endedBefore: false } }))).toEqual({ ok: true, kind: 'already_invited' })
  })
  it('TC-LNK-10 §5.2 someone whose invitation ended comes back only by a targeted re-entry invitation', () => {
    const ended = { activeInvitation: false, endedBefore: true }
    expect(decideAccept(accept({ person: ended }))).toEqual({ ok: false, reason: 'ended_before' })
    expect(decideAccept(accept({ person: ended, targeted: t() }))).toEqual({ ok: false, reason: 'ended_before' })
    expect(decideAccept(accept({ person: ended, targeted: t({ allowsReentry: true }) }))).toEqual({ ok: true, kind: 'new' })
  })
  it('TC-LNK-09 people counted once, by country; warnings only', () => {
    const c = countPeople([
      { userId: 'a', country: 'GB' },
      { userId: 'a', country: 'GB' },
      { userId: 'b', country: 'fr' },
      { userId: 'c', country: null },
      { userId: 'd', country: 'US' },
    ])
    expect(c).toEqual({ uk: 1, eea: { FR: 1 }, unknown: 1, other: 1 })
    const many = countPeople(Array.from({ length: 150 }, (_, i) => ({ userId: `u${i}`, country: i < 135 ? 'GB' : 'DE' })))
    expect(countWarnings(many, 0n, 149)).toEqual({ ukPeopleNear: true, ukAmountNear: false, eeaOver: [], unknown: 0 })
    expect(countWarnings(many, 450_000_000n, 14).eeaOver).toEqual(['DE'])
    expect(countWarnings(countPeople([]), 449_999_999n, 149).ukAmountNear).toBe(false)
  })
  it('TC-LNK-09 every EEA state and the UK can be chosen, each counted as itself; another country counts as other (Codex round 9)', () => {
    const codes = COUNTRY_CHOICES.map(([c]) => c)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of ['GB', ...EEA]) expect(codes, c).toContain(c)
    const c = countPeople(COUNTRY_CHOICES.map(([code]) => ({ userId: code, country: code })))
    expect(c.uk).toBe(1)
    expect(Object.keys(c.eea).sort()).toEqual([...EEA].sort())
    expect(c.unknown).toBe(0)
    expect(c.other).toBe(codes.length - 1 - EEA.length)
    expect(countPeople([{ userId: 'x', country: OTHER_COUNTRY }]).other).toBe(1)
  })
})

describe('R-PIP-01 the exported list reads back', () => {
  it('TC-PIP-01 a cell with a tab, comma, quote or formula character comes back as it was (Codex round 10)', () => {
    const cells = ['Ann', 'ann@example.test', '100.00', 'friends', 'Call\tFriday, "soon"', 'Not responded']
    const row = cells.map(csvCell).join(',')
    const back = parsePipeline(`${PIPELINE_CSV_HEADER}\n${row}\n=Bo,bo@example.test,,,'-x`, [], 10)
    expect(back.errors).toEqual([])
    expect(back.rows[0]).toMatchObject({
      name: 'Ann',
      email: 'ann@example.test',
      expected_minor: '10000',
      terms_label: 'friends',
      private_note: 'Call\tFriday, "soon"',
    })
    // a ' before a formula character is read as the export's guard and taken off
    expect(back.rows[1]).toMatchObject({ name: '=Bo', private_note: '-x' }) // a tab alone, with nothing else that needs quoting
    const tabOnly = ['Cy', 'cy@example.test', '', '', 'Call\tFriday'].map(csvCell).join(',')
    expect(parsePipeline(tabOnly, [], 10).rows[0]).toMatchObject({ email: 'cy@example.test', private_note: 'Call\tFriday' })
  })

  it('TC-PIP-01 the longest export a full list can make fits the import, as text and as a request (Codex round 11)', () => {
    // every cell at its maximum and made of quotes, so csvCell doubles it; a status label far longer than any the app uses
    const row = ['"'.repeat(200), `${'a'.repeat(64)}@${'b'.repeat(255)}`, '1,000,000,000.00', '"'.repeat(100), '"'.repeat(2000), '"'.repeat(100)]
      .map(csvCell)
      .join(',')
    const text = [PIPELINE_CSV_HEADER, ...Array.from({ length: MAX_PIPELINE_ROWS }, () => row)].join('\n')
    expect(text.length).toBeLessThanOrEqual(PIPELINE_TEXT_MAX)
    // the request at the text limit, every character written the longest way JSON can write one
    expect(Buffer.byteLength(JSON.stringify({ text: '\u0001'.repeat(PIPELINE_TEXT_MAX), dry_run: true }))).toBeLessThanOrEqual(PIPELINE_BODY_MAX)
  })
})

describe('R-PIP-04 the three figures', () => {
  it('TC-PIP-03 committed £180,000, expected £90,000 from the rows not committed, a committed row\'s expected amount not counted again', () => {
    const P = (x: number) => BigInt(x) * 100n
    const rows = [
      { committed: true, expected_minor: String(P(100_000)) },
      { committed: true, expected_minor: String(P(50_000)) },
      { committed: false, expected_minor: String(P(60_000)) },
      { committed: false, expected_minor: String(P(30_000)) },
      { committed: false, expected_minor: null },
    ]
    expect(pipelineTotals([P(120_000), P(60_000)], rows)).toEqual({ committed: P(180_000), expected: P(90_000) })
    expect(pipelineTotals([], [])).toEqual({ committed: 0n, expected: 0n })
  })
})
