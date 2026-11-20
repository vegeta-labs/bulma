// TC-CMP-05, M-05: nothing that would be published names the reference platform or the owner's private context. Every
// tracked file that goes to the public repository is scanned (scripts/public-files.mjs). The list of names is itself
// private (private/identity-names.txt), so the public repository has no list and the check says so instead of passing.
import { existsSync, readFileSync } from 'node:fs'
import { publicFiles } from './public-files.mjs'

export const NAMES_FILE = 'private/identity-names.txt'

export const loadNames = (file = NAMES_FILE) => {
  if (!existsSync(file)) return null
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  return line ? new RegExp(line, 'i') : null
}

export const findings = (names, path, text) => (names.test(text) ? [`${path}: names something that must not be published`] : [])

if (import.meta.url === `file://${process.argv[1]}`) {
  const names = loadNames()
  if (!names) {
    console.log('identity check skipped: the private name list is kept in the development repository only')
    process.exit(0)
  }
  const files = publicFiles().filter((f) => !/\.(woff2|png|ico|jpg)$/.test(f) && existsSync(f))
  const out = files.flatMap((f) => findings(names, f, readFileSync(f, 'utf8')))
  for (const l of out) console.log(l)
  console.log(out.length ? `identity check FAILED (${out.length})` : `identity check passed (${files.length} files)`)
  process.exit(out.length ? 1 : 0)
}
