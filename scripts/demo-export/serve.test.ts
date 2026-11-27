import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unpack } from '../../e2e-demo/serve.ts'
import { codeDiffers } from './source.ts'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const served = () => readdirSync(tmpdir()).filter((n) => n.startsWith('bulma-demo-serve-')).length

/** A pack as demo-pack.ts writes it: the archive, and its .sha256 once the scan passed. */
function packAt(commit: string, scanned = true, o: { says?: Record<string, unknown>; file?: string; named?: string; version?: string } = {}) {
  const from = mkdtempSync(join(tmpdir(), 'pack-from-'))
  const out = mkdtempSync(join(tmpdir(), 'pack-out-'))
  made.push(from, out)
  writeFileSync(join(from, 'snapshot-info.json'), JSON.stringify({ version: o.version ?? version, commit, built_at: '2026-11-25T00:00:00.000Z', ...o.says }))
  mkdirSync(join(from, 'data'))
  writeFileSync(join(from, 'index.html'), '<!doctype html>')
  const name = o.file ?? `bulma-demo-v${o.version ?? version}.tar.gz`
  const tar = join(out, name)
  execFileSync('tar', ['-czf', tar, '-C', from, 'index.html', 'snapshot-info.json', 'data'])
  if (scanned) writeFileSync(`${tar}.sha256`, `${createHash('sha256').update(readFileSync(tar)).digest('hex')}  ${o.named ?? name}\n`)
  return { out, tar }
}

describe('demo pack server: only the scanned pack of this code', () => {
  it('TC-DEMO-09 a pack the scan did not pass, or changed after it, is not served', () => {
    expect(() => unpack(packAt('HEAD', false).out)).toThrow(/no scanned pack/)
    const { out, tar } = packAt('HEAD')
    writeFileSync(tar, Buffer.concat([readFileSync(tar), Buffer.from('x')]))
    expect(() => unpack(out)).toThrow(/does not match its .sha256/)
  })

  it('TC-DEMO-09 a test archive is served only as one: renamed as the release, or its .sha256 for another file, it is refused (Codex P r2 #1)', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const before = served()
    // a test archive and its .sha256 renamed to the release names
    expect(() => unpack(packAt(head, true, { says: { version: `${version}-test`, names_checked: false } }).out)).toThrow(/says it is version .*-test with names not checked/)
    // or one that kept the release version but says the names were not checked
    expect(() => unpack(packAt(head, true, { says: { names_checked: false } }).out)).toThrow(/with names not checked/)
    // a release archive renamed as the test one
    expect(() => unpack(packAt(head, true, { file: `bulma-demo-v${version}-test.tar.gz` }).out)).toThrow(new RegExp(`says it is version ${version.replace(/\./g, '\\.')}:`))
    // a .sha256 written for another file
    expect(() => unpack(packAt(head, true, { named: 'other.tar.gz' }).out)).toThrow(/\.sha256 is for other\.tar\.gz/)
    // the version on its own (Codex P r3 #1): a release archive, names checked, that says another version
    expect(() => unpack(packAt(head, true, { says: { version: '0.0.1', names_checked: true } }).out)).toThrow(/says it is version 0\.0\.1:/)
    expect(() => unpack(packAt(head, true, { file: `bulma-demo-v${version}-test.tar.gz`, says: { version: '0.0.1', names_checked: false } }).out)).toThrow(
      /says it is version 0\.0\.1 with names not checked/,
    )
    // and a test archive that says what it is, under its own name, is served (where the app code here is as committed)
    if (!codeDiffers(head)) made.push(unpack(packAt(head, true, { file: `bulma-demo-v${version}-test.tar.gz`, says: { version: `${version}-test`, names_checked: false } }).out))
    expect(served()).toBe(before + made.filter((d) => d.includes('bulma-demo-serve-')).length)
  })

  it('TC-DEMO-09 a pack built from other app code is not served, and nothing is left unpacked', () => {
    const before = served()
    expect(() => unpack(packAt('0000000000000000000000000000000000000000').out)).toThrow(/app code differs/)
    // the first commit of the repository has none of the demo code; a checkout of one commit has no other (Codex P r3 #13:
    // the check itself is tested on commits of its own in pack.test.ts, codeDiffers)
    const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim().split('\n')[0]!
    if (codeDiffers(root)) expect(() => unpack(packAt(root).out)).toThrow(/app code differs/)
    expect(served()).toBe(before)
  })

  it('TC-DEMO-09 in a checkout of one commit: served while its app code is as committed, refused once a file git does not track is there (Codex P r4 #6)', () => {
    const r = mkdtempSync(join(tmpdir(), 'bulma-serve-repo-'))
    made.push(r)
    const g = (...a: string[]) => execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@x.invalid', ...a], { encoding: 'utf8' }).trim()
    g('init', '-q')
    mkdirSync(join(r, 'src/web/public'), { recursive: true })
    writeFileSync(join(r, 'src/web/public/a.txt'), 'a')
    writeFileSync(join(r, '.gitignore'), '*.local\n')
    // a version of its own: the archive's name and version are the checkout's, not the caller's (Codex P r5 #7)
    writeFileSync(join(r, 'package.json'), JSON.stringify({ version: '9.9.9' }))
    g('add', '-A')
    g('commit', '-qm', 'one')
    const head = g('rev-parse', 'HEAD')
    const before = served()
    const dir = unpack(packAt(head, true, { version: '9.9.9' }).out, r)
    made.push(dir)
    expect(readdirSync(dir).sort()).toEqual(['data', 'index.html', 'snapshot-info.json'])
    // an ordinary new file, one git ignores, and one hidden by status.showUntrackedFiles=no
    for (const [file, config] of [['guide.txt', false], ['guide.local', false], ['guide.txt', true]] as const) {
      if (config) g('config', 'status.showUntrackedFiles', 'no')
      writeFileSync(join(r, 'src/web/public', file), 'x')
      expect(() => unpack(packAt(head, true, { version: '9.9.9' }).out, r), file).toThrow(/app code differs/)
      rmSync(join(r, 'src/web/public', file))
    }
    expect(served()).toBe(before + 1)
  })

  it('TC-DEMO-09 a pack built from the code here is unpacked whole', () => {
    // the app code as it is here, committed: HEAD if nothing in it changed since, else the test cannot name such a commit
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    // as the server asks it (Codex P r4 #6: untracked files too); the check itself is tested in a repository of its own above
    const clean = !codeDiffers(head)
    if (!clean) return expect(() => unpack(packAt(head).out)).toThrow(/app code differs/)
    const dir = unpack(packAt(head).out)
    made.push(dir)
    expect(readdirSync(dir).sort()).toEqual(['data', 'index.html', 'snapshot-info.json'])
    expect(existsSync(join(dir, 'index.html'))).toBe(true)
  })
})
