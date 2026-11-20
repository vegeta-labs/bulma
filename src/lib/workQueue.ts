// Operator to-do list and deal board (PRD R-OPS-02, R-OPS-03). Pure. Every item is worked out from stored facts each time it
// is read, never typed in, so it is there while the fact is and gone once it is resolved; only who works on it is stored
// (`work_item_assignment`, tech design §3).
import { daysInStatus } from './participation.ts'

/** R-OPS-02's list, in its order. Release orders and payout exceptions come with D5. */
export const WORK_KINDS = [
  'deal_review',
  'content_approval',
  'kyc',
  'investee',
  'change',
  'cancel_request',
  'payer_check',
  'refund',
  'hold',
  'reconfirm_silent',
  'withdrawal',
  'closing',
  'unallocated',
  'statement_import',
  'complaint',
] as const
export type WorkKind = (typeof WORK_KINDS)[number]

export const WORK_LABEL: Record<WorkKind, string> = {
  deal_review: 'Deal to review',
  content_approval: 'Content to approve',
  kyc: 'Identity check',
  investee: 'Company details to review',
  change: 'Change to the terms',
  cancel_request: 'Cancellation asked for',
  payer_check: 'Payment to check',
  refund: 'Refund',
  hold: 'Compliance hold',
  reconfirm_silent: 'No answer to a reconfirmation',
  withdrawal: 'Withdrawal to decide',
  closing: 'Closing',
  unallocated: 'Money not yet assigned',
  statement_import: 'Statement import to confirm',
  complaint: 'Complaint to acknowledge',
}

/** One fact that needs someone, as the server reads it. `subject` is the row that makes it (stable while it is open). */
export interface WorkFact {
  kind: WorkKind
  subject: string
  dealId: string | null
  dealCode: string | null
  dealName: string | null
  person: string | null
  amountMinor: bigint | null
  currency: string | null
  since: Date
  /** YYYY-MM-DD, or an instant as ISO text; null when nothing is due by a date. */
  deadline: string | null
  /** What the item is about, in a few words with no personal detail beyond the name. */
  note: string
}

export interface Assignment {
  key: string
  assignee: string
  assigneeName: string
}

export interface WorkItem {
  key: string
  kind: WorkKind
  label: string
  deal_id: string | null
  deal_code: string | null
  deal_name: string | null
  person: string | null
  amount_minor: string | null
  currency: string | null
  days: number
  deadline: string | null
  note: string
  /** Who is working on it; null when nobody is. */
  assignee: { id: string; name: string } | null
}

export interface WorkFilter {
  kind?: WorkKind
  deal?: string
  /** `none` = nobody is on it. */
  assignee?: string | 'none'
}

export const workKey = (kind: WorkKind, subject: string) => `${kind}:${subject}`

const KEY = /^([a-z_]+):([0-9a-f-]{36}|[0-9a-z_-]{1,80})$/
export function parseWorkKey(key: unknown): { kind: WorkKind; subject: string } | null {
  if (typeof key !== 'string') return null
  const m = KEY.exec(key)
  if (!m || !(WORK_KINDS as readonly string[]).includes(m[1]!)) return null
  return { kind: m[1] as WorkKind, subject: m[2]! }
}

/** Earliest deadline first, then the longest wait, then by key so the order never shifts between reads. */
export function workItems(facts: readonly WorkFact[], assignments: readonly Assignment[], now: Date, f: WorkFilter = {}): WorkItem[] {
  const who = new Map(assignments.map((a) => [a.key, a]))
  const out: WorkItem[] = []
  for (const x of facts) {
    const key = workKey(x.kind, x.subject)
    const a = who.get(key)
    const item: WorkItem = {
      key,
      kind: x.kind,
      label: WORK_LABEL[x.kind],
      deal_id: x.dealId,
      deal_code: x.dealCode,
      deal_name: x.dealName,
      person: x.person,
      amount_minor: x.amountMinor === null ? null : String(x.amountMinor),
      currency: x.amountMinor === null ? null : x.currency,
      days: daysInStatus(x.since, now) ?? 0,
      deadline: x.deadline,
      note: x.note,
      assignee: a ? { id: a.assignee, name: a.assigneeName } : null,
    }
    if (workMatches(item, f)) out.push(item)
  }
  return out.sort(
    (p, q) =>
      (p.deadline === null ? 1 : 0) - (q.deadline === null ? 1 : 0) ||
      (p.deadline !== null && q.deadline !== null ? p.deadline.localeCompare(q.deadline) : 0) ||
      q.days - p.days ||
      p.key.localeCompare(q.key),
  )
}

export function workMatches(i: Pick<WorkItem, 'kind' | 'deal_id' | 'assignee'>, f: WorkFilter): boolean {
  if (f.kind !== undefined && i.kind !== f.kind) return false
  if (f.deal !== undefined && i.deal_id !== f.deal) return false
  if (f.assignee === 'none') return i.assignee === null
  if (f.assignee !== undefined && i.assignee?.id !== f.assignee) return false
  return true
}

/** How many open items of each kind, for the filter. */
export function workCounts(items: readonly WorkItem[]): Partial<Record<WorkKind, number>> {
  const c: Partial<Record<WorkKind, number>> = {}
  for (const i of items) c[i.kind] = (c[i.kind] ?? 0) + 1
  return c
}

/**
 * Who may be put on an item: a colleague who reviews or administers, not someone with a stake in the item's deal (R-REV-04),
 * and only while the item is open. Null when allowed.
 */
export function assignRefusal(i: { itemOpen: boolean; assigneeIsStaff: boolean; assigneeHasStake: boolean }): string | null {
  if (!i.itemOpen) return 'This item is no longer open.'
  if (!i.assigneeIsStaff) return 'Only a reviewer or an admin can work on this.'
  if (i.assigneeHasStake) return 'They have a stake in this deal and cannot work on it.'
  return null
}

// ---------- R-OPS-03: the deal board ----------

export const BOARD_FLAGS = ['target_passed', 'target_moved', 'money_cannot_close'] as const
export type BoardFlag = (typeof BOARD_FLAGS)[number]
export const BOARD_FLAG_LABEL: Record<BoardFlag, string> = {
  target_passed: 'Target date passed',
  target_moved: 'Target date moved more than once',
  money_cannot_close: 'Money received but cannot close now',
}

/** States where the deal still runs to a close, so a target date and closing gaps mean something. */
const RUNNING = new Set(['draft', 'in_review', 'returned', 'approved', 'live', 'closing_requested', 'closing'])
/** States where money is taken and closing is the next step (R-CLS-01 is checked from here). */
const TO_CLOSE = new Set(['live', 'closing_requested', 'closing'])

/** Calendar days from `today` to `target` (both YYYY-MM-DD); negative once passed. */
export function daysLeft(target: string | null, today: string): number | null {
  if (target === null) return null
  const a = Date.parse(`${today}T00:00:00Z`)
  const b = Date.parse(`${target}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86_400_000)
}

/** How many times the target date changed, read from each approved set of terms in order (the first one is not a change). */
export function targetChanges(history: readonly (string | null)[]): number {
  let n = 0
  for (let i = 1; i < history.length; i++) if (history[i] !== history[i - 1]) n += 1
  return n
}

export interface BoardFacts {
  state: string
  targetClose: string | null
  today: string
  /** The target date in each approved or self-service version, oldest first. */
  targetHistory: readonly (string | null)[]
  receivedMinor: bigint
  /** R-CLS-01's reasons, for a deal that is live or closing; null where closing does not apply. */
  gaps: readonly string[] | null
}

export function boardRow(f: BoardFacts): { days_left: number | null; target_changes: number; flags: BoardFlag[] } {
  const left = RUNNING.has(f.state) ? daysLeft(f.targetClose, f.today) : null
  const changes = targetChanges(f.targetHistory)
  const flags: BoardFlag[] = []
  if (left !== null && left < 0) flags.push('target_passed')
  if (changes >= 2) flags.push('target_moved')
  if (TO_CLOSE.has(f.state) && f.receivedMinor > 0n && (f.gaps?.length ?? 0) > 0) flags.push('money_cannot_close')
  return { days_left: left, target_changes: changes, flags }
}
