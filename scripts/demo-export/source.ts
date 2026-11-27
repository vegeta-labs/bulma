// What code a demo pack was made from (plan 05 §5.7; reviewer finding M1, 2026-11-26). The export and the build each note
// the commit and whether the app code was clean when they ran; the pack is made only when both name its own commit and
// both were clean, so the pack never names a commit its files were not built from. A run on changed code (a mutation run
// does this on purpose) still works: it just cannot be packed.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, sep } from 'node:path'

/** The app code a pack is built from (tests are not): a change here after packing means the pack tests other code. */
export const BUILT_FROM = [
  'src',
  'scripts/demo-build.ts',
  'scripts/demo-snapshot.ts',
  // what writes the archive and its info (Codex P r2 #6)
  'scripts/demo-pack.ts',
  'scripts/demo-export',
  // the private name list's loader, which the pack imports (Codex P r3 #6)
  'scripts/check-identity.mjs',
  'vite.config.ts',
  'vite.demo.config.ts',
  // what the export and the build read besides the code: rule packs, fonts, dependencies, the compiler's settings (Codex P r1 #14)
  'packs',
  'assets',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  ':(exclude,glob)**/*.test.ts',
]

/** The notes, next to the export's output: a new export removes both, so a build of an older export cannot be packed. */
export const EXPORT_SOURCE = '.demo-export/export-source.json'
export const BUILD_SOURCE = '.demo-export/build-source.json'

export interface SourceState {
  commit: string
  clean: boolean
  /** The build's note only: every file it wrote into dist-demo/ and its sha256, so the pack takes exactly that build. */
  files?: Record<string, string>
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { encoding: 'utf8', cwd }).trim()

/**
 * Whether the app code here differs from `commit`: a tracked file changed (staged or not), or any file git does not track,
 * ignored or not (Vite copies whatever is in src/web/public/; Codex P r2 #6). Untracked files are listed by `ls-files`, which
 * `status.showUntrackedFiles=no` does not hide (Codex P r3 #6). The export, the build and the demo's server all ask this.
 */
export function codeDiffers(commit: string, cwd = process.cwd()): boolean {
  try {
    execFileSync('git', ['diff', '--quiet', commit, '--', ...BUILT_FROM], { stdio: 'ignore', cwd })
  } catch {
    return true
  }
  return git(cwd, 'ls-files', '--others', '--', ...BUILT_FROM) !== ''
}

/**
 * HEAD, and whether the app code is as committed there: the files and the index both (a change staged and then undone in the
 * file is still a change the next commit would carry; Codex P r4 #6). The server compares the files only.
 */
export function sourceState(cwd = process.cwd()): SourceState {
  const commit = git(cwd, 'rev-parse', 'HEAD')
  let staged = false
  try {
    execFileSync('git', ['diff', '--quiet', '--cached', commit, '--', ...BUILT_FROM], { stdio: 'ignore', cwd })
  } catch {
    staged = true
  }
  return { commit, clean: !staged && !codeDiffers(commit, cwd) }
}

/**
 * `file`'s path under `root` as the archive writes it, `/` between folders: only this system's separator is turned into one,
 * and a name holding a backslash is refused, so two files never take one path (Codex P r3 #7: `data/a.txt` and `data\a.txt`).
 */
export function packPath(root: string, file: string): string {
  const rel = relative(root, file)
  if (sep !== '\\' && rel.includes('\\')) throw new Error(`${rel}: a file name holding "\\", which a tar on Windows reads as folders: rename it`)
  return rel.split(sep).join('/')
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** Path → sha256 of each file, sorted: what the build's note records. */
export const inventory = (files: ReadonlyMap<string, Uint8Array>): Record<string, string> =>
  Object.fromEntries([...files.keys()].sort().map((p) => [p, sha256(files.get(p)!)]))

/**
 * Why `files` (read from dist-demo/ by the pack) are not exactly what the build noted in `file` it wrote: one missing, added
 * or changed since (a build running at the same time, a file removed by hand; Codex P r2 #7), or null.
 */
export function inventoryProblem(file: string, files: ReadonlyMap<string, Uint8Array>): string | null {
  const noted = (JSON.parse(readFileSync(file, 'utf8')) as SourceState).files
  if (!noted) return 'the build noted no list of its files: run it again'
  const now = inventory(files)
  const diff = [...new Set([...Object.keys(noted), ...Object.keys(now)])].filter((p) => noted[p] !== now[p]).sort()
  return diff.length ? `dist-demo/ is not what the build wrote (${diff.slice(0, 5).join(', ')}${diff.length > 5 ? ', …' : ''}): run the build again` : null
}

export const noteSource = (file: string, state: SourceState = sourceState()) => writeFileSync(file, `${JSON.stringify(state)}\n`)

/** Why `step`'s output cannot be packed at `commit`, or null when it can. */
export function sourceProblem(step: string, file: string, commit: string): string | null {
  if (!existsSync(file)) return `${step}: no note of the code it ran on (${file}): run it again`
  const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<SourceState>
  if (s.clean !== true) return `${step} ran on app code with changes not committed: commit, then run it again`
  if (s.commit !== commit) return `${step} ran at ${String(s.commit).slice(0, 7)}, not at ${commit.slice(0, 7)}: run it again`
  return null
}

/**
 * Why `commit` (a release names the public repository's) cannot be named for a pack built at `head`, or null: it must be a
 * commit this repository has (fetch the public repository first) with the same app code (Codex P r1 #17).
 */
export function commitProblem(commit: string, head: string, cwd = process.cwd()): string | null {
  if (commit === head) return null
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore', cwd })
  } catch {
    return `commit ${commit.slice(0, 7)} is not in this repository: fetch the public repository first`
  }
  try {
    execFileSync('git', ['diff', '--quiet', commit, head, '--', ...BUILT_FROM], { stdio: 'ignore', cwd })
  } catch {
    return `commit ${commit.slice(0, 7)} has other app code than ${head.slice(0, 7)}`
  }
  return null
}
