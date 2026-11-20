// Licence policy (tech design §6, as Trunks): application dependencies only MIT, MIT-0, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD
// (MIT-0 is MIT without the notice condition; added for nodemailer, plan decision R28 (8));
// development tools the same, plus the explicit exceptions below (each with its reason).
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'])
// package name → reason. Development tools only; never shipped.
const DEV_EXCEPTIONS = {
  // (none yet)
}
// package name → its exact licence expression, with the reason above it. Application dependencies, each approved by the owner (tech design §5).
const APP_EXCEPTIONS = {
  // decision R26: pulled in by pdf-lib (MIT) to read and write compressed PDFs. Zlib is a permissive licence with no
  // copyleft; it asks only that the notice stays and altered versions are marked. Approved by the owner on 2026-11-10 (「同意」).
  pako: '(MIT AND Zlib)',
}

const ok = (expr) => {
  if (!expr) return false
  const s = String(expr).replace(/^\((.*)\)$/, '$1')
  if (s.includes(' OR ')) return s.split(' OR ').some((p) => ok(p.trim()))
  if (s.includes(' AND ')) return s.split(' AND ').every((p) => ok(p.trim()))
  return ALLOWED.has(s.trim())
}

function tree(omitDev) {
  const args = ['ls', '--all', '--json', '--long', ...(omitDev ? ['--omit=dev'] : [])]
  const out = execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  const seen = new Map()
  const walk = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      if (!d.path || seen.has(d.path)) continue
      const pkgFile = join(d.path, 'package.json')
      const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) : {}
      const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : undefined)
      seen.set(d.path, { name, version: pkg.version, lic })
      walk(d.dependencies)
    }
  }
  walk(JSON.parse(out).dependencies)
  return [...seen.values()]
}

const prod = tree(true)
const prodNames = new Set(prod.map((p) => `${p.name}@${p.version}`))
const dev = tree(false).filter((p) => !prodNames.has(`${p.name}@${p.version}`))
const bad = [
  ...prod.filter((p) => !ok(p.lic) && APP_EXCEPTIONS[p.name] !== p.lic).map((p) => `app: ${p.name}@${p.version} ${p.lic ?? 'no licence'}`),
  ...dev.filter((p) => !ok(p.lic) && !(p.name in DEV_EXCEPTIONS)).map((p) => `dev: ${p.name}@${p.version} ${p.lic ?? 'no licence'}`),
]
for (const b of bad) console.log(b)
console.log(`${prod.length} application and ${dev.length} development packages checked; ${bad.length} not allowed`)
process.exit(bad.length ? 1 : 0)
