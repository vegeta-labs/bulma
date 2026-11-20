// R-OP-06 / TC-OP-06: no telemetry and no request to the project. Only the adapter file may open a connection, and no
// source file may name an outside host. Scans application source and the dependency list; the browser test covers what the built pages request.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN_CALLS = /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|new\s+EventSource|from\s+'node:(?:http|https|net|tls|dgram)'|from\s+'nodemailer'|require\(['"](?:node:)?(?:http|https|net|tls|dgram)['"]\)/g
const ALLOWED_CALLS = new Set(['src/adapters/index.ts', 'src/adapters/sumsub.ts', 'src/adapters/smtp.ts', 'src/web/api.ts'])
const TELEMETRY_PACKAGES = /sentry|posthog|mixpanel|segment|amplitude|datadog|newrelic|opentelemetry|google-analytics|plausible|hotjar/i
const URL = /https?:\/\/(?!(?:localhost|127\.0\.0\.1|www\.w3\.org)(?:[:/'"`]|$))[a-z0-9.-]+/gi

// the only outside hosts the code may name: an adapter the operator chooses to configure, never the project
const ALLOWED_HOSTS = new Map([['src/adapters/sumsub.ts', new Set(['https://api.sumsub.com'])]])

export function scan(path, text) {
  const out = []
  if (!ALLOWED_CALLS.has(path) && FORBIDDEN_CALLS.test(text)) out.push(`${path}: network call outside the adapters`)
  FORBIDDEN_CALLS.lastIndex = 0
  for (const m of text.matchAll(URL)) if (!ALLOWED_HOSTS.get(path)?.has(m[0])) out.push(`${path}: names an outside host ${m[0]}`)
  return out
}

export function scanPackages(pkg) {
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) => TELEMETRY_PACKAGES.test(n)).map((n) => `package.json: telemetry package ${n}`)
}

const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  return statSync(p).isDirectory() ? walk(p) : [p]
}) : [])

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = walk('src').filter((f) => /\.(ts|tsx|html)$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'src/store/testdb.ts')
  const findings = [...files.flatMap((f) => scan(f, readFileSync(f, 'utf8'))), ...scanPackages(JSON.parse(readFileSync('package.json', 'utf8')))]
  for (const f of findings) console.log(f)
  console.log(findings.length ? `outbound check FAILED (${findings.length})` : `outbound check passed (${files.length} files)`)
  process.exit(findings.length ? 1 : 0)
}
