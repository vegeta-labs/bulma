// Rules §2 / test plan: every case due at the current milestone must have run and passed. Reads test reports, not source.
// A case is a table row "| TC-X-01 | ... | D0 |" or "| E2E-01 | ... | D3 |"; its last cell is its milestone.
import { existsSync, readFileSync } from 'node:fs'

const ORDER = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5']
const ID = String.raw`(?:TC-[A-Z0-9]+-\d+[a-z]?|E2E-\d+)`

export function dueCases(plan, milestone) {
  const due = []
  for (const line of plan.split('\n')) {
    const m = new RegExp(String.raw`^\| (${ID}) \|.*\| *([^|]+?) *\|$`).exec(line)
    if (!m) continue
    if (ORDER.includes(m[2]) && ORDER.indexOf(m[2]) <= ORDER.indexOf(milestone)) due.push(m[1])
  }
  return due
}

export function results(reports) {
  const out = new Map()
  const lead = new RegExp(String.raw`^${ID}(?:\s*/\s*${ID})*\b`)
  const record = (title, status) => {
    for (const id of lead.exec(title)?.[0].match(new RegExp(ID, 'g')) ?? []) out.set(id, [...(out.get(id) ?? []), status])
  }
  for (const report of reports) {
    if (report.testResults) {
      for (const file of report.testResults) for (const t of file.assertionResults) record(t.title, t.status)
    } else {
      const walk = (suite) => {
        // `spec.ok` is also true for a skipped test or an expected failure: only a test that ran and passed counts
        for (const spec of suite.specs ?? []) {
          const ran = (spec.tests ?? []).length > 0 && spec.tests.every((t) => t.expectedStatus === 'passed' && t.results?.at(-1)?.status === 'passed')
          record(spec.title, ran ? 'passed' : 'failed')
        }
        for (const s of suite.suites ?? []) walk(s)
      }
      for (const s of report.suites ?? []) walk(s)
    }
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // The test plan and milestone are internal documents kept in the development repository only (scripts/public-files.mjs).
  if (!existsSync('docs/04_TEST_PLAN.md') || !existsSync('docs/milestone.txt')) {
    console.log('due-case check skipped: the test plan is kept in the development repository only; the tests above ran')
    process.exit(0)
  }
  const current = readFileSync('docs/milestone.txt', 'utf8').trim()
  if (!ORDER.includes(current)) {
    console.log(`invalid milestone "${current}"`)
    process.exit(1)
  }
  const due = dueCases(readFileSync('docs/04_TEST_PLAN.md', 'utf8'), current)
  if (!due.length) {
    console.log('no cases are due: the test plan could not be read')
    process.exit(1)
  }
  const paths = process.argv.slice(2).length ? process.argv.slice(2) : ['test-report.json']
  const r = results(paths.map((p) => JSON.parse(readFileSync(p, 'utf8'))))
  const missing = due.filter((id) => !r.has(id))
  const failed = due.filter((id) => r.has(id) && r.get(id).some((s) => s !== 'passed'))
  console.log(`milestone ${current}: ${due.length} cases due, ${due.length - missing.length - failed.length} passed`)
  if (missing.length) console.log(`NOT RUN: ${missing.join(', ')}`)
  if (failed.length) console.log(`FAILED: ${failed.join(', ')}`)
  process.exit(missing.length || failed.length ? 1 : 0)
}
