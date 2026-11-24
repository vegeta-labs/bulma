// Rules §2 / test plan: every case due at the current milestone must have run and passed. Reads test reports, not source.
// A case is a table row "| TC-X-01 | ... | D0 |" or "| E2E-01 | ... | D3 |"; its last cell is its milestone.
import { existsSync, readFileSync } from 'node:fs'
import { UNTAGGED } from './untagged-tests.mjs'

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

/** Every case id the test plan has a row for, whatever its milestone. */
export function planIds(plan) {
  const ids = new Set()
  for (const line of plan.split('\n')) {
    const m = new RegExp(String.raw`^\| (${ID}) \|`).exec(line)
    if (m) ids.add(m[1])
  }
  return ids
}

/** Case ids that test names carry but the test plan has no row for (a typo or a removed case would otherwise count for nothing). */
export function unknownIds(reports, plan) {
  const known = planIds(plan)
  return [...results(reports).keys()].filter((id) => !known.has(id))
}

const LEAD = new RegExp(String.raw`^${ID}(?:\s*/\s*${ID})*\b`)

/**
 * The case ids a title starts with, or null. A slash and something shaped like a case id after them is a malformed id
 * ("TC-A-01 / TC-A-O2"), and so is an id that runs on ("TC-A-01 / TC-A-02-extra"): the whole title counts as untagged. A requirement or decision after a slash ("/ R-CLS-00") is fine.
 */
function leadIds(title) {
  const m = LEAD.exec(title)
  // an id running on into more of an id ("TC-A-02-extra", "TC-A-02-2", a full-width digit) is malformed too (Codex group B r2 #11, r3 #10)
  if (!m || /^(?:[-_\p{L}\p{N}]|\s*\/\s*(?:TC|E2E)-)/iu.test(title.slice(m[0].length))) return null
  return m[0].match(new RegExp(ID, 'g'))
}

/** Every test in the reports as [title, status]. */
function eachTest(reports, record) {
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
}

export function results(reports) {
  const out = new Map()
  eachTest(reports, (title, status) => {
    for (const id of leadIds(title) ?? []) out.set(id, [...(out.get(id) ?? []), status])
  })
  return out
}

/** Test titles that do not start with a case id and are not on the allow-list (CLAUDE.md: test names start with their TC id). */
export function untagged(reports, allowed = UNTAGGED) {
  const allow = new Set(allowed)
  const out = []
  eachTest(reports, (title) => {
    if (!leadIds(title) && !allow.has(title) && !out.includes(title)) out.push(title)
  })
  return out
}

/** Allow-list entries that no test in the reports carries: a renamed or removed test must leave the list too. */
export function unusedAllowed(reports, allowed = UNTAGGED) {
  const seen = new Set()
  eachTest(reports, (title) => seen.add(title))
  return allowed.filter((t) => !seen.has(t))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2).length ? process.argv.slice(2) : ['test-report.json']
  const reports = paths.map((p) => JSON.parse(readFileSync(p, 'utf8')))
  const loose = untagged(reports)
  if (loose.length) {
    console.log(`test names with no case id (add the id, or the exact title to scripts/untagged-tests.mjs if it owns no requirement):\n  ${loose.join('\n  ')}`)
    process.exit(1)
  }
  const unused = unusedAllowed(reports)
  if (unused.length) {
    console.log(`allow-list entries in scripts/untagged-tests.mjs that no test carries:\n  ${unused.join('\n  ')}`)
    process.exit(1)
  }
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
  const plan = readFileSync('docs/04_TEST_PLAN.md', 'utf8')
  const unknown = unknownIds(reports, plan)
  if (unknown.length) {
    console.log(`case ids in test names with no row in docs/04_TEST_PLAN.md: ${unknown.join(', ')}`)
    process.exit(1)
  }
  const due = dueCases(plan, current)
  if (!due.length) {
    console.log('no cases are due: the test plan could not be read')
    process.exit(1)
  }
  const r = results(reports)
  const missing = due.filter((id) => !r.has(id))
  const failed = due.filter((id) => r.has(id) && r.get(id).some((s) => s !== 'passed'))
  console.log(`milestone ${current}: ${due.length} cases due, ${due.length - missing.length - failed.length} passed`)
  if (missing.length) console.log(`NOT RUN: ${missing.join(', ')}`)
  if (failed.length) console.log(`FAILED: ${failed.join(', ')}`)
  process.exit(missing.length || failed.length ? 1 : 0)
}
