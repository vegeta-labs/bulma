// Deadlines counted in working days (PRD §5.3, R-ALO-01; plan R28 (4)). Pure. A working day is Monday to Friday by the UTC
// calendar; bank holidays are not counted out in D4, and the screens say so. The number of days is the operator's setting.
const DAY_MS = 86_400_000
export const MAX_WORKING_DAYS = 260

/**
 * The end of the `days`-th working day after the day `start` falls on: approved on a Friday afternoon with 5 days, the deadline
 * is the end of the next Friday. The day of the start never counts, so a person always has the whole of each day.
 */
export function workingDayDeadline(start: Date, days: number): Date | null {
  const t = start.getTime()
  if (!Number.isFinite(t) || !Number.isInteger(days) || days < 1 || days > MAX_WORKING_DAYS) return null
  let day = Math.floor(t / DAY_MS)
  for (let left = days; left > 0;) {
    day += 1
    const weekday = new Date(day * DAY_MS).getUTCDay()
    if (weekday !== 0 && weekday !== 6) left -= 1
  }
  return new Date((day + 1) * DAY_MS)
}

export interface Pause {
  from: Date
  /** null while the pause is still on. */
  to: Date | null
}

export type DeadlineState = { state: 'open'; deadline: Date } | { state: 'paused' } | { state: 'lapsed'; deadline: Date } | { state: 'unknown' }

/**
 * §5.3: a reconfirmation's deadline. While a person's statement has run out the clock stops: the deadline moves on by the time
 * paused (from the start at the earliest; overlapping pauses count once; a pause beginning after the deadline as moved
 * so far gives no time back), and an open pause that began before it means no deadline yet. Silence is
 * never agreement: once the deadline has passed, the state is `lapsed`.
 */
export function deadlineState(i: { start: Date; days: number; pauses: readonly Pause[]; now: Date }): DeadlineState {
  const base = workingDayDeadline(i.start, i.days)
  const now = i.now.getTime()
  if (base === null || !Number.isFinite(now)) return { state: 'unknown' }
  const s = i.start.getTime()
  const spans: Array<[number, number]> = []
  let openFrom: number | null = null
  for (const p of i.pauses) {
    const a = p.from.getTime()
    const b = p.to === null ? null : p.to.getTime()
    if (!Number.isFinite(a) || (b !== null && (!Number.isFinite(b) || b < a))) return { state: 'unknown' }
    if (b === null) {
      // a pause not begun yet by this clock does not count
      if (a <= now) openFrom = Math.max(s, Math.min(openFrom ?? Infinity, a))
      continue
    }
    const from = Math.max(a, s)
    if (b > from) spans.push([from, b])
  }
  if (openFrom !== null) spans.push([openFrom, Infinity])
  spans.sort((x, y) => x[0] - y[0])
  // the clock stops only for a pause that begins before the deadline as moved so far: one after a lapse gives no time back
  let deadline = base.getTime()
  let reach = -Infinity
  for (const [a, b] of spans) {
    const from = Math.max(a, reach)
    if (from >= deadline) break
    if (b === Infinity) return { state: 'paused' }
    if (b > from) deadline += b - from
    reach = Math.max(reach, b)
  }
  const at = new Date(deadline)
  return now >= deadline ? { state: 'lapsed', deadline: at } : { state: 'open', deadline: at }
}

/** §5.3: what an answer of "no" leads to. With money on hand it is a withdrawal with a refund to-do; without, `withdrawn`. */
export const onDisagree = (held: bigint): 'withdrawn' | 'withdrawal_with_refund' => (held > 0n ? 'withdrawal_with_refund' : 'withdrawn')

/**
 * §5.3: after the deadline. A person with no money on hand may be removed; one with money on hand stays until the operator
 * records a decision (exclude and refund after the pack's notice, or take the change back), and until then the deal cannot close.
 */
export const onLapse = (held: bigint): 'may_remove' | 'operator_decides' => (held > 0n ? 'operator_decides' : 'may_remove')

export interface Cover {
  from: Date
  to: Date
}

/**
 * §5.3: the pauses of a reconfirmation's clock, from the times a valid statement covered the person. Every stretch after `start`
 * with no statement is a pause; one still running at `now` is open. Statements that overlap count once.
 */
export function statementPauses(covers: readonly Cover[], start: Date, now: Date): Pause[] {
  const s = start.getTime()
  const n = now.getTime()
  if (!Number.isFinite(s) || !Number.isFinite(n) || n <= s) return []
  const spans: Array<[number, number]> = []
  for (const c of covers) {
    const a = Math.max(c.from.getTime(), s)
    const b = Math.min(c.to.getTime(), n)
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) spans.push([a, b])
  }
  spans.sort((x, y) => x[0] - y[0])
  const out: Pause[] = []
  let at = s
  for (const [a, b] of spans) {
    if (a > at) out.push({ from: new Date(at), to: new Date(a) })
    at = Math.max(at, b)
  }
  if (at < n) out.push({ from: new Date(at), to: null })
  return out
}

/**
 * §5.3: why the operator may not yet record that a silent person with money is excluded and refunded. Only after the deadline,
 * only with money on hand (without, the lead removes them), only with the pack's notice to give and a written basis.
 */
export function exclusionRefusal(i: { clock: DeadlineState; held: bigint; notice: string | null; evidence: string }): string | null {
  if (i.clock.state !== 'lapsed') return 'The deadline to reconfirm has not passed.'
  if (onLapse(i.held) !== 'operator_decides') return 'No money has arrived for this person: the lead can remove them instead.'
  if (!i.notice?.trim()) return 'The rules pack has no notice for this. Add the text reconfirm_exclusion_notice to the pack first.'
  if (i.evidence.trim().length < 3) return 'Write down how the person was told and why they are excluded.'
  return null
}
