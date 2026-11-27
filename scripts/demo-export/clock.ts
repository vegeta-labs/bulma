// The export's fixed clock (plan 05 §5.6): the throwaway Postgres reads libfaketime's offset file, this process fakes `Date`
// alone with @sinonjs/fake-timers. Both are moved together to the same instant and then run on at real speed, so every time
// the app and the database write is a real one, in order. Export only: nothing in src/ knows about it.
import { execFileSync } from 'node:child_process'
import FakeTimers from '@sinonjs/fake-timers'

const RealDate = Date

export interface ExportClock {
  /** Moves both clocks to `at` (ms since the epoch). */
  set(at: number): void
  uninstall(): void
}

/** libfaketime's offset file: seconds with a sign always, zero too. */
export const offsetText = (seconds: number) => `${seconds < 0 ? '-' : '+'}${Math.abs(seconds)}`

/**
 * Why the database's time `db` is not this process's, read between `before` and `after` (fake times, ms), or null. Whole
 * seconds in the offset file and the time between the reads allow a second either side.
 */
export function clockProblem(db: number, before: number, after: number): string | null {
  return db >= before - 1000 && db <= after + 1000
    ? null
    : `the export database's clock reads ${Number.isFinite(db) ? new RealDate(db).toISOString() : String(db)}, not between ${new RealDate(before).toISOString()} and ${new RealDate(after).toISOString()}`
}

/** `container` runs the image from scripts/demo-export/Dockerfile; its offset file is whole seconds from the real time. */
export function exportClock(container: string): ExportClock {
  const clock = FakeTimers.withGlobal(globalThis).install({ now: RealDate.now(), toFake: ['Date'] })
  // the fake time is set again from the real one every few ms, so it runs at real speed and never falls behind the database's
  // (fake-timers' own advanceTime adds a fixed step per tick and loses the ticks a busy process misses; reviewer m3)
  let offsetMs = 0
  const follow = () => clock.setSystemTime(RealDate.now() + offsetMs)
  const timer = setInterval(follow, 5)
  timer.unref()
  return {
    set(at) {
      const offset = Math.round((at - RealDate.now()) / 1000)
      // libfaketime reads a move only with its sign ("+86400"); without one it is not a move (Codex P r1 #8)
      execFileSync('docker', ['exec', container, 'sh', '-c', `echo ${offsetText(offset)} > /faketime/offset`])
      offsetMs = offset * 1000
      follow()
      // the database must now read the same time as this process. The fake `Date` stands still while this process waits for
      // docker (no timer runs), so the database's answer is held against the real time read before and after the query,
      // moved by the offset (Codex P r2 #9)
      const before = RealDate.now() + offsetMs
      const db = Number(
        execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-tAc', 'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint'], {
          encoding: 'utf8',
        }).trim(),
      )
      const after = RealDate.now() + offsetMs
      follow()
      const problem = clockProblem(db, before, after)
      if (problem) throw new Error(problem)
    },
    uninstall: () => {
      clearInterval(timer)
      clock.uninstall()
    },
  }
}
