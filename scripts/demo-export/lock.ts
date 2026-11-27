// One demo step at a time in a worktree (Codex P r2 #2, #7): the export, the build and the pack each hold this lock while they
// run, so a build never reads an export being written, a pack never reads a build being written, and two packs never
// publish over each other.
//
// Codex P r6 (owner 2026-11-26, simplified): the lock is a file created only if none has its name, and never taken over. A
// step that ends normally, by Ctrl-C or by a kill removes it; one ended by `kill -9` or a power cut leaves it, and the owner
// removes it by hand, as the refusal says. Rounds 3 to 5 each found a way round the takeover of an ended step's lock.
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

export const LOCK = '.demo.lock'

const code = (e: unknown) => (e as NodeJS.ErrnoException).code

/** What the lock in `file` says, for the refusal; any content, or none, since a step may be writing it at that moment. */
const holder = (file: string) => {
  try {
    return readFileSync(file, 'utf8').split('\n')[0]!.trim().slice(0, 200) || 'a demo step'
  } catch {
    return 'a demo step'
  }
}

/** Takes the lock for `step`, or throws naming what holds it. Released when this process exits, by Ctrl-C or by a kill. */
export function holdLock(step: string, file = LOCK): () => void {
  const text = `${step} (process ${process.pid}, mark ${randomBytes(12).toString('hex')})\n`
  try {
    writeFileSync(file, text, { flag: 'wx' })
  } catch (e) {
    if (code(e) !== 'EEXIST') throw e
    throw new Error(`${holder(file)} holds ${file}: wait for it to end; if no demo step is running, remove ${file}`)
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      // only while it is still ours: one removed by hand and taken since by another step stays
      if (readFileSync(file, 'utf8') === text) rmSync(file, { force: true })
    } catch {
      // gone already
    }
  }
  process.once('exit', release)
  // Ctrl-C or a kill: end with the signal's own code (128 + its number), through 'exit', so the lock and whatever else the
  // step undoes on 'exit' go; the step leaves signals to this (Codex P r4 #2)
  for (const [signal, n] of [['SIGINT', 2], ['SIGTERM', 15]] as const) process.once(signal, () => process.exit(128 + n))
  return release
}
