// Test plan §15: every requirement row in PRD §4 must appear in the test plan.
import { existsSync, readFileSync } from 'node:fs'

// The PRD and test plan are internal documents kept in the development repository only (scripts/public-files.mjs).
if (!existsSync('docs/01_PRD.md') || !existsSync('docs/04_TEST_PLAN.md')) {
  console.log('requirements check skipped: the PRD and test plan are kept in the development repository only')
  process.exit(0)
}

const prd = readFileSync('docs/01_PRD.md', 'utf8')
const plan = readFileSync('docs/04_TEST_PLAN.md', 'utf8')
const section = prd.slice(prd.indexOf('## 4. 功能需求'), prd.indexOf('\n## 5'))
const ids = [...section.matchAll(/^\| (R-[A-Z]+-[0-9.]+) /gm)].map((m) => m[1])
const missing = ids.filter((id) => !new RegExp(`${id.replaceAll('.', '\\.')}(?![0-9.])`).test(plan))
console.log(`${ids.length} requirements, ${missing.length} missing from the test plan${missing.length ? `: ${missing.join(', ')}` : ''}`)
process.exit(!ids.length || missing.length ? 1 : 0)
