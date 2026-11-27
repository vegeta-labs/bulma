// P step 4 (plan 05 §5.1): builds the static demo pack from the export's snapshot. Run after scripts/demo-snapshot.ts:
//
//   node --experimental-strip-types --no-warnings scripts/demo-build.ts
//
// Writes dist-demo/: the screens built with vite.demo.config.ts, data/snapshot.js (the answers, frozen, loaded as a plain
// script before the app), data/files/ (the PDFs and other files the screens link to; only those the snapshot names) and
// data/notes/ (a page for each link that has no file: a refusal the export recorded, or "not in the demo").
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { holdLock } from './demo-export/lock.ts'
import { BUILD_SOURCE, inventory, noteSource, packPath, sourceState } from './demo-export/source.ts'
import { noteKey, notesFor, type DemoPack, type Snapshot } from '../src/demo/snapshot.ts'

const FROM = '.demo-export'
const OUT = 'dist-demo'

/** The script the pack loads first: the snapshot as one frozen object, nothing else. */
export function snapshotScript(pack: DemoPack): string {
  return [
    `// Bulma static demo v${pack.version}: fictional data recorded at ${pack.clock}. Software demo, not a service, not an offer.`,
    'globalThis.BULMA_DEMO = (function freeze(o) {',
    "  if (o && typeof o === 'object') {",
    '    Object.values(o).forEach(freeze)',
    '    Object.freeze(o)',
    '  }',
    '  return o',
    `})(${JSON.stringify(pack)})`,
    '',
  ].join('\n')
}

const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A page a link without a file opens (plan 05 §5.3): the banner's sentence, why there is no file, and the way back to the
 * view it came from. Plain HTML, no script and no style attribute (the site's CSP); its own small stylesheet.
 */
export function notePage(view: string, sentence: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="robots" content="noindex" />',
    '<title>Bulma demo</title>',
    '<link rel="stylesheet" href="note.css" />',
    '</head>',
    '<body>',
    '<main>',
    '<p><strong>Demo: fictional data. Software demo, not a service, not an offer.</strong></p>',
    `<p role="status">${escape(sentence)}</p>`,
    `<p><a href="../../#/${escape(view)}/">Back to the demo</a></p>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

const NOTE_CSS = 'body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; line-height: 1.5; }\nmain { max-width: 40rem; margin: 0 auto; }\n'

/** The files the snapshot points to, each once; the build refuses a snapshot that names a file the export did not write. */
export function filesOf(snap: Snapshot): string[] {
  const paths = Object.values(snap.get).flatMap((a) => (a.file ? [a.file.path] : []))
  for (const p of paths) if (!/^files\/[0-9a-f]{32}\/[A-Za-z0-9._-]+$/.test(p)) throw new Error(`a file path the pack does not take: ${p}`)
  return [...new Set(paths)].sort()
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

function main() {
  holdLock('the demo build')
  if (!existsSync(`${FROM}/snapshot.json`)) throw new Error(`${FROM}/snapshot.json is missing: run scripts/demo-snapshot.ts first`)
  const snap = JSON.parse(readFileSync(`${FROM}/snapshot.json`, 'utf8')) as Snapshot
  if (snap.format !== 1) throw new Error(`snapshot format ${String(snap.format)} is not one this build reads`)
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  const source = sourceState()
  // no note until this build has finished: a build that stops part way leaves nothing to pack (Codex P r1 #15)
  rmSync(BUILD_SOURCE, { force: true })
  execFileSync('npx', ['vite', 'build', '--config', 'vite.demo.config.ts', '--logLevel', 'warn'], { stdio: 'inherit' })
  const notes = notesFor(snap)
  mkdirSync(`${OUT}/data/notes`, { recursive: true })
  writeFileSync(`${OUT}/data/notes/note.css`, NOTE_CSS)
  for (const n of notes) writeFileSync(`${OUT}/${n.path}`, notePage(n.view, n.sentence))
  for (const f of filesOf(snap)) {
    if (!existsSync(`${FROM}/${f}`)) throw new Error(`${FROM}/${f} is missing: run scripts/demo-snapshot.ts again`)
    mkdirSync(dirname(`${OUT}/data/${f}`), { recursive: true })
    cpSync(`${FROM}/${f}`, `${OUT}/data/${f}`)
  }
  const pack: DemoPack = { ...snap, version, notes: Object.fromEntries(notes.map((n) => [noteKey(n.view, n.sentence), n.path])) }
  writeFileSync(`${OUT}/data/snapshot.js`, snapshotScript(pack))
  // outside dist-demo/ so it is not packed; next to the export, which a new export removes with it. It lists every file this
  // build wrote, so the pack takes exactly these (Codex P r2 #7)
  const files = new Map(walk(OUT).map((f) => [packPath(OUT, f), readFileSync(f)]))
  noteSource(BUILD_SOURCE, { ...source, files: inventory(files) })
  console.log(`built ${OUT}/ from the snapshot of ${snap.clock} (v${version})`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
