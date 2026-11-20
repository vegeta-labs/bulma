import { describe, expect, it } from 'vitest'
import { GATES } from './gate.ts'
import { assignRefusal, boardRow, daysLeft, parseWorkKey, targetChanges, WORK_KINDS, workCounts, workItems, workKey, type WorkFact } from './workQueue.ts'

const NOW = new Date('2026-11-17T12:00:00Z')
const fact = (o: Partial<WorkFact> & Pick<WorkFact, 'kind' | 'subject'>): WorkFact => ({
  dealId: 'd1',
  dealCode: 'ABC',
  dealName: 'Deal',
  person: null,
  amountMinor: null,
  currency: 'GBP',
  since: new Date('2026-11-10T12:00:00Z'),
  deadline: null,
  note: '',
  ...o,
})

describe('D4 operator to-do list (R-OPS-02)', () => {
  it('TC-OPS-01 each fact is one item with its deal, person, amount, days, deadline and who is on it; order is by deadline then wait', () => {
    const facts = [
      fact({ kind: 'refund', subject: 'r1', person: 'Ann', amountMinor: 12345n, since: new Date('2026-11-14T13:00:00Z') }),
      fact({ kind: 'kyc', subject: 'k1', person: 'Ben', since: new Date('2026-11-01T00:00:00Z') }),
      fact({ kind: 'reconfirm_silent', subject: 'c1', person: 'Cat', deadline: '2026-11-20' }),
      fact({ kind: 'change', subject: 'c2', deadline: '2026-11-19T10:00:00.000Z' }),
    ]
    const items = workItems(facts, [{ key: 'kyc:k1', assignee: 'u9', assigneeName: 'Rita' }], NOW)
    expect(items.map((i) => i.key)).toEqual(['change:c2', 'reconfirm_silent:c1', 'kyc:k1', 'refund:r1'])
    const r = items.find((i) => i.kind === 'refund')!
    expect(r).toMatchObject({ person: 'Ann', amount_minor: '12345', currency: 'GBP', days: 2, deal_code: 'ABC', assignee: null, label: 'Refund' })
    expect(items.find((i) => i.kind === 'kyc')!).toMatchObject({ days: 16, assignee: { id: 'u9', name: 'Rita' } })
    // no amount, no currency shown
    expect(items.find((i) => i.kind === 'kyc')!.currency).toBeNull()
    // resolved = the fact is gone, so the item is gone even if someone was on it
    expect(workItems(facts.slice(0, 1), [{ key: 'kyc:k1', assignee: 'u9', assigneeName: 'Rita' }], NOW).map((i) => i.key)).toEqual(['refund:r1'])
  })

  it('TC-OPS-01 filters by kind, deal and who is on it; counts per kind', () => {
    const facts = [fact({ kind: 'refund', subject: 'a' }), fact({ kind: 'refund', subject: 'b', dealId: 'd2' }), fact({ kind: 'hold', subject: 'c' })]
    const asg = [{ key: 'refund:b', assignee: 'u1', assigneeName: 'X' }]
    expect(workItems(facts, asg, NOW, { kind: 'refund' }).map((i) => i.key)).toEqual(['refund:a', 'refund:b'])
    expect(workItems(facts, asg, NOW, { deal: 'd2' }).map((i) => i.key)).toEqual(['refund:b'])
    expect(workItems(facts, asg, NOW, { assignee: 'u1' }).map((i) => i.key)).toEqual(['refund:b'])
    expect(workItems(facts, asg, NOW, { assignee: 'none' }).map((i) => i.key)).toEqual(['hold:c', 'refund:a'])
    expect(workItems(facts, asg, NOW, { assignee: 'u2' })).toEqual([])
    expect(workCounts(workItems(facts, asg, NOW))).toEqual({ refund: 2, hold: 1 })
  })

  it('TC-OPS-01 keys: every kind round-trips, anything else is refused', () => {
    for (const k of WORK_KINDS)
      expect(parseWorkKey(workKey(k, '0b7c3c1e-1111-4222-8333-944445555666'))).toEqual({ kind: k, subject: '0b7c3c1e-1111-4222-8333-944445555666' })
    for (const bad of ['', 'refund', 'nope:abc', 'refund:', 'refund:ABC', 'refund:a b', 'x'.repeat(200), 5, null]) expect(parseWorkKey(bad)).toBeNull()
  })

  it('TC-OPS-01 assigning: only staff with no stake, only while open', () => {
    expect(assignRefusal({ itemOpen: true, assigneeIsStaff: true, assigneeHasStake: false })).toBeNull()
    expect(assignRefusal({ itemOpen: false, assigneeIsStaff: true, assigneeHasStake: false })).toMatch(/no longer open/)
    expect(assignRefusal({ itemOpen: true, assigneeIsStaff: false, assigneeHasStake: false })).toMatch(/reviewer or an admin/)
    expect(assignRefusal({ itemOpen: true, assigneeIsStaff: true, assigneeHasStake: true })).toMatch(/stake/)
  })
})

describe('D4 deal board (R-OPS-03)', () => {
  const base = { state: 'live', targetClose: '2026-11-20', today: '2026-11-17', targetHistory: ['2026-11-20'], receivedMinor: 0n, gaps: [] as string[] }

  it('TC-OPS-02 days left, and the three flags', () => {
    expect(boardRow(base)).toEqual({ days_left: 3, target_changes: 0, flags: [] })
    expect(boardRow({ ...base, targetClose: '2026-11-17' })).toMatchObject({ days_left: 0, flags: [] })
    expect(boardRow({ ...base, targetClose: '2026-11-16' })).toMatchObject({ days_left: -1, flags: ['target_passed'] })
    expect(boardRow({ ...base, targetHistory: ['2026-11-01', '2026-11-10'] })).toMatchObject({ target_changes: 1, flags: [] })
    expect(boardRow({ ...base, targetHistory: ['2026-11-01', '2026-11-10', '2026-11-20'] })).toMatchObject({ target_changes: 2, flags: ['target_moved'] })
    expect(boardRow({ ...base, receivedMinor: 1n, gaps: ['x'] }).flags).toEqual(['money_cannot_close'])
    expect(boardRow({ ...base, receivedMinor: 1n, gaps: [] }).flags).toEqual([])
    expect(boardRow({ ...base, receivedMinor: 0n, gaps: ['x'] }).flags).toEqual([])
    for (const state of ['closing_requested', 'closing'])
      expect(boardRow({ ...base, state, receivedMinor: 5n, gaps: ['x'] }).flags).toEqual(['money_cannot_close'])
  })

  it('TC-OPS-02 a finished deal has no days left and no closing flag; no target date means none', () => {
    for (const state of ['cancelled', 'archived', 'settled', 'closed'])
      expect(boardRow({ ...base, state, targetClose: '2026-01-01', receivedMinor: 9n, gaps: ['x'] })).toEqual({ days_left: null, target_changes: 0, flags: [] })
    expect(boardRow({ ...base, targetClose: null }).days_left).toBeNull()
    expect(daysLeft('2026-12-01', '2026-11-17')).toBe(14)
    expect(daysLeft('bad', '2026-11-17')).toBeNull()
    expect(targetChanges([])).toBe(0)
    expect(targetChanges([null, '2026-11-01', null])).toBe(2)
    expect(targetChanges(['2026-11-01', '2026-11-01', '2026-11-02', '2026-11-02'])).toBe(1)
  })
})

describe('D4 workbench gate', () => {
  const actor = (roles: Array<'admin' | 'reviewer' | 'approver'>, mustChangePassword = false, mfaOn = true, emailVerified = true) => ({
    id: 'x',
    roles,
    mustChangePassword,
    mfaOn,
    emailVerified,
  })
  it('TC-AUTHZ-09 reviewers and admins with two-step sign-in; nobody else', () => {
    expect(GATES.canRunOperations(null)).toBe(false)
    expect(GATES.canRunOperations(actor([]))).toBe(false)
    expect(GATES.canRunOperations(actor(['approver']))).toBe(false)
    expect(GATES.canRunOperations(actor(['reviewer']))).toBe(true)
    expect(GATES.canRunOperations(actor(['admin']))).toBe(true)
    expect(GATES.canRunOperations(actor(['admin'], true))).toBe(false)
    expect(GATES.canRunOperations(actor(['reviewer'], false, false))).toBe(false)
    expect(GATES.canRunOperations(actor(['reviewer'], false, true, false))).toBe(false)
  })
})
