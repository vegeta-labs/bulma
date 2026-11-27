// P step 7 (plan 05 §5.5, §5.7; TC-DEMO-09/10/11): serves the packed demo the way the website will, for the browser tests.
// It unpacks the archive scripts/demo-pack.ts wrote (only one whose .sha256 matches: the scan passed), refuses one built from
// other app code than this worktree's, and serves it under /bulma/demo/ with the site's headers (deal-ops-site
// site/vercel.json: connect-src 'none', so the page can make no fetch or XHR). /bulma/ stands in for the site's Bulma page,
// the banner's way back. Nothing else is served. DEMO_E2E_DIR serves a built directory instead (dist-demo, just built from the
// worktree): only for the mutation check, whose mutants change the code a pack would be built from.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { codeDiffers } from '../scripts/demo-export/source.ts'

export const SITE_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), display-capture=()',
}
export const BASE = '/bulma/demo/'
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
}
export { BUILT_FROM } from '../scripts/demo-export/source.ts'

/** The scanned pack in `dir`, unpacked to a new folder; `cwd` is the checkout whose app code it must have been built from. */
export function unpack(dir = '.demo-pack', cwd = process.cwd()): string {
  const { version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { version: string }
  // the release archive, or where there is none the test archive of a checkout without the private name list (demo-pack.ts
  // --without-names: CI of the public repository)
  const release = join(dir, `bulma-demo-v${version}.tar.gz`)
  const test = existsSync(`${release}.sha256`) ? null : `${version}-test`
  const name = `bulma-demo-v${test ?? version}.tar.gz`
  const tar = join(dir, name)
  const again = 'build it again: demo-snapshot.ts, demo-build.ts, demo-pack.ts (see docs/HANDOFF.md)'
  if (!existsSync(`${tar}.sha256`)) throw new Error(`no scanned pack at ${release}: ${again}`)
  // the .sha256 names this archive, and the archive says it is this one: a test archive renamed as a release is refused
  // (Codex P r2 #1)
  const [want, named] = readFileSync(`${tar}.sha256`, 'utf8').trim().split(/ {2}/)
  if (named !== name) throw new Error(`${tar}.sha256 is for ${String(named)}: ${again}`)
  if (createHash('sha256').update(readFileSync(tar)).digest('hex') !== want) throw new Error(`${tar} does not match its .sha256: ${again}`)
  const out = mkdtempSync(join(tmpdir(), 'bulma-demo-serve-'))
  const refuse = (why: string): never => {
    rmSync(out, { recursive: true, force: true })
    throw new Error(`${why}: ${again}`)
  }
  execFileSync('tar', ['-xzf', tar, '-C', out])
  const info = JSON.parse(readFileSync(join(out, 'snapshot-info.json'), 'utf8')) as { version?: string; commit: string; names_checked?: boolean }
  if (info.version !== (test ?? version) || (info.names_checked === false) !== Boolean(test))
    refuse(`${name} says it is version ${String(info.version)}${info.names_checked === false ? ' with names not checked' : ''}`)
  // the same check as the export's and the build's, files git does not track included (Codex P r3 #6)
  if (codeDiffers(info.commit, cwd)) refuse(`the pack was built from ${info.commit.slice(0, 7)}, and the app code differs from it here (or that commit is unknown)`)
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.env.DEMO_E2E_DIR
  const root = dir ? mkdtempSync(join(tmpdir(), 'bulma-demo-serve-')) : unpack()
  if (dir) execFileSync('cp', ['-R', `${dir}/.`, root])
  const port = Number(process.env.DEMO_E2E_PORT ?? 4331)
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => process.exit(0))
  createServer((req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => res.writeHead(status, { ...SITE_HEADERS, 'content-type': type }).end(body)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'not allowed')
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    if (path === '/bulma/') return send(200, TYPES['.html']!, '<!doctype html><title>Bulma</title><h1>Bulma</h1>')
    if (!path.startsWith(BASE)) return send(404, 'text/plain', 'not found')
    const file = normalize(join(root, path.slice(BASE.length) || 'index.html'))
    if (!file.startsWith(root + sep) || !existsSync(file)) return send(404, 'text/plain', 'not found')
    try {
      return send(200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file))
    } catch {
      return send(404, 'text/plain', 'not found')
    }
  }).listen(port, '127.0.0.1', () => console.log(`demo ${dir ? `directory ${dir}` : 'pack'} on http://127.0.0.1:${port}${BASE}`))
}
