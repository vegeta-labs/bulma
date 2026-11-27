// P step 6 (plan 05 §5.7, TC-DEMO-12): packs dist-demo/ for the site, in the format it already takes from Trunks. Run after
// scripts/demo-build.ts:
//
//   node --experimental-strip-types --no-warnings scripts/demo-pack.ts [--commit <public commit>]
//
// Takes dist-demo/ exactly as the build listed it, adds snapshot-info.json (version, commit, built_at) and MANIFEST.sha256,
// and writes .demo-pack/bulma-demo-v<version>.tar.gz (no outer directory). The archive itself is then unpacked into a temporary
// directory and scanned (scripts/demo-export/pack.ts): only plain files of the kinds the pack holds, every file against the
// manifest, no secret, no other host, no company outside the scenario, nothing on the private name list. Only when all of
// that passes are the archive and its .sha256 put in place; otherwise nothing changes in .demo-pack/. The worktree must be clean and the export and the
// build must both have run on its HEAD with no changes (scripts/demo-export/source.ts). The commit named defaults to HEAD;
// a release passes the public repository's commit, which the site checks against its pin.
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
// @ts-expect-error plain script
import { loadNames } from './check-identity.mjs'
import { holdLock } from './demo-export/lock.ts'
import { BUILD_SOURCE, commitProblem, EXPORT_SOURCE, inventoryProblem, packPath, sourceProblem } from './demo-export/source.ts'
import { manifestProblems, manifestText, pdfStrings, scanText, type ScanRules } from './demo-export/pack.ts'
import { readTar, tarProblems, writeTar } from './demo-export/tar.ts'
import { demoScenario } from '../src/demo/scenario.ts'
import { sandboxPaymentInstruction } from '../src/lib/instance.ts'

const FROM = 'dist-demo'
const OUT = '.demo-pack'
const TEXT = /\.(html|js|css|json|csv|txt)$/

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

async function main() {
  holdLock('the demo pack')
  const args = process.argv.slice(2)
  const withoutNames = args[0] === '--without-names' && args.length === 1
  if (!(args.length === 0 || withoutNames || (args.length === 2 && args[0] === '--commit' && /^[0-9a-f]{40}$/.test(args[1]!))))
    throw new Error('usage: demo-pack.ts [--commit <40-character commit> | --without-names]')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const commit = args[0] === '--commit' ? args[1]! : head
  // the files must come from this worktree's HEAD with nothing changed, whichever commit the pack names (a release names the
  // public repository's commit of the same code)
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
    throw new Error('the worktree has changes: commit them first, so the pack names what it was built from')
  const stale = [sourceProblem('the export', EXPORT_SOURCE, head), sourceProblem('the build', BUILD_SOURCE, head), commitProblem(commit, head)].filter(Boolean)
  if (stale.length) throw new Error(stale.join('\n'))
  const names = loadNames() as RegExp | null
  // a checkout without the private name list (the public repository, its CI) can make a test archive only: every other rule
  // runs, and its version is `<version>-test` in its name and in snapshot-info.json (with names_checked false), so it never
  // passes for a release file, renamed or not (Codex P r1 #13, r2 #1)
  if (names && withoutNames) throw new Error('--without-names is for a checkout without the private name list; this one has it')
  if (!names && !withoutNames)
    throw new Error('the private name list is missing (private/identity-names.txt): a release pack is built in the development repository only (--without-names makes a test archive)')
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  const companies = new Set([demoScenario.investee.company, ...demoScenario.otherDeals.map((d) => d.company), sandboxPaymentInstruction('GBP').holder])
  const rules = { names: names ?? /(?!)/, companies }
  const { tar, files } = await packDir({
    from: FROM,
    out: OUT,
    version: withoutNames ? testVersion(version) : version,
    commit,
    rules,
    noted: BUILD_SOURCE,
    extra: withoutNames ? { names_checked: false } : undefined,
  })
  console.log(`packed ${tar}: ${files} files, scanned and matching MANIFEST.sha256; commit ${commit.slice(0, 7)}; .sha256 written${withoutNames ? ' (test archive: names not checked, not for release)' : ''}`)
}

/** A test archive's version: never one the site pins. */
export const testVersion = (version: string) => `${version}-test`

/**
 * Packs `from` into `out/bulma-demo-v<version>.tar.gz` with its info and manifest (made here, not written into `from`),
 * unpacks the archive and scans it; only when every file passes are the archive and its .sha256 put in place, replacing an
 * earlier pair. Otherwise throws with every problem found and leaves `out` as it was. `noted`: the build's note, whose list of
 * files `from` must match exactly.
 */
export async function packDir(o: {
  from: string
  out: string
  version: string
  commit: string
  rules: ScanRules
  noted?: string
  extra?: Record<string, unknown>
}): Promise<{ tar: string; files: number }> {
  const { from, out, version, commit } = o
  const problems: string[] = []
  const built = new Map<string, Buffer>()
  for (const f of walk(from)) {
    const p = packPath(from, f)
    if (!lstatSync(f).isFile()) problems.push(`${p}: not a plain file`)
    else built.set(p, readFileSync(f))
  }
  if (o.noted) {
    const stale = inventoryProblem(o.noted, built)
    if (stale) throw new Error(stale)
  }
  for (const p of ['snapshot-info.json', 'MANIFEST.sha256']) if (built.has(p)) problems.push(`${p}: the build wrote it; only the pack does`)
  // what the archive holds: the build, its info and the manifest
  const now = Math.floor(Date.now() / 1000)
  const info = { version, commit, built_at: new Date(now * 1000).toISOString(), ...o.extra }
  built.set('snapshot-info.json', Buffer.from(`${JSON.stringify(info, null, 2)}\n`))
  built.set('MANIFEST.sha256', Buffer.from(manifestText(built)))
  const name = `bulma-demo-v${version}.tar.gz`
  const tar = join(out, name)
  mkdirSync(out, { recursive: true })

  // written, unpacked, scanned and hashed in a folder of this run's own; only a passing pair is moved into place (Codex P r1
  // #16) (inside out/, so the move is on one file system)
  const tmp = mkdtempSync(join(out, '.packing-'))
  try {
    const archive = writeTar(built, now)
    writeFileSync(join(tmp, name), archive)
    // the scan reads the archive, not the directory it came from: its own headers, then the files the system's tar unpacks
    const entries = readTar(archive)
    problems.push(...tarProblems(entries, now))
    const unpacked = join(tmp, 'x')
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', join(tmp, name), '-C', unpacked])
    const files = new Map<string, Buffer>()
    for (const f of walk(unpacked)) {
      const p = packPath(unpacked, f)
      if (!lstatSync(f).isFile()) problems.push(`${p}: not a plain file`)
      else if (!TEXT.test(p) && !p.endsWith('.pdf') && p !== 'MANIFEST.sha256') problems.push(`${p}: a kind of file the scan cannot read`)
      else files.set(p, readFileSync(f))
    }
    for (const e of entries) if (e.type === '0' && !files.get(e.name)?.equals(e.data)) problems.push(`${e.name}: unpacks differently from its header`)
    problems.push(...manifestProblems(files.get('MANIFEST.sha256')?.toString('utf8') ?? '', files))
    const said = JSON.parse(files.get('snapshot-info.json')?.toString('utf8') ?? '{}') as { version?: string; commit?: string }
    if (said.version !== version || said.commit !== commit) problems.push('snapshot-info.json: not this version and commit')
    for (const [p, bytes] of files) {
      const text = p.endsWith('.pdf')
        ? await pdfStrings(bytes).catch((e: Error) => (problems.push(`${p}: cannot be read (${e.message})`), ''))
        : bytes.toString('utf8')
      problems.push(...scanText(p, text, o.rules))
    }
    if (problems.length) throw new Error(`the archive is refused (${problems.length}):\n${[...new Set(problems)].join('\n')}`)
    // the earlier pair goes only now, the hash first, so at no moment does a .sha256 sit beside an archive it does not match
    writeFileSync(join(tmp, `${name}.sha256`), `${sha256(archive)}  ${name}\n`)
    rmSync(`${tar}.sha256`, { force: true })
    renameSync(join(tmp, name), tar)
    renameSync(join(tmp, `${name}.sha256`), `${tar}.sha256`)
    return { tar, files: files.size }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e: Error) => {
    console.error(`demo pack: ${e.message}`)
    process.exit(1)
  })
