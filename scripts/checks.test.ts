import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain script
import { dueCases, results } from './check-coverage.mjs'
// @ts-expect-error plain script
import { findings, loadNames, NAMES_FILE } from './check-identity.mjs'
// @ts-expect-error plain script
import { isDevOnly } from './public-files.mjs'

const read = (p: string) => readFileSync(p, 'utf8')

describe('documents', () => {
  it('TC-CMP-05 the responsibilities table and the due-diligence note exist with every listed item, in our own words', () => {
    const table = read('docs/en/responsibilities.md')
    for (const item of ['Sanctions and PEP screening', 'Ongoing monitoring', 'Client money reconciliation', 'Offline and social media promotion', 'Appointed representative oversight', 'Complaints and incidents', 'Training', 'Keeping legal text up to date']) {
      expect(table, item).toContain(item)
    }
    for (const who of ['Software does', 'Operator does', 'Nobody']) expect(table, who).toContain(who)
    const dd = read('docs/en/due-diligence.md')
    for (const item of ['no vendor', 'no SLA', 'no warranty', 'no penetration test', 'report a vulnerability', 'regulatory status of the project', 'one operator', 'cannot supervise appointed representatives']) {
      expect(dd.toLowerCase(), item).toContain(item.toLowerCase())
    }
    expect(read('SECURITY.md')).toMatch(/report/i)
  })
  it('TC-CMP-05 nothing published names the reference platform, and the check really catches it', () => {
    const names = /\bplatformx\b/i
    expect(findings(names, 'x', 'A note about PlatformX and its help centre').length).toBe(1)
    expect(findings(names, 'x', 'PLATFORMX').length).toBe(1)
    expect(findings(names, 'x', 'platformxyz and myplatformx are fine').length).toBe(0)
  })
  it.skipIf(!existsSync(NAMES_FILE))('TC-CMP-05 the private name list loads and catches its own first name, not ordinary words', () => {
    const names = loadNames()!
    const first = readFileSync(NAMES_FILE, 'utf8')
      .split('\n')
      .find((l) => l && !l.startsWith('#'))!
      .split('|')[0]!
      .replaceAll('\\b', '')
    expect(findings(names, 'x', `A note about ${first.toUpperCase()} here`).length).toBe(1)
    expect(findings(names, 'x', 'origin, nodding and coding are fine').length).toBe(0)
  })
  it('TC-CMP-05 the public file list keeps internal records out and publishes the code and English docs', () => {
    for (const p of ['CLAUDE.md', 'docs/HANDOFF.md', 'docs/PROGRESS.md', 'docs/milestone.txt', 'docs/01_PRD.md', 'docs/04_TEST_PLAN.md', 'docs/review/a.md', 'private/identity-names.txt']) {
      expect(isDevOnly(p), p).toBe(true)
    }
    for (const p of ['README.md', 'docs/en/README.md', 'docs/en/RELEASE_NOTES.md', 'src/lib/gate.ts', 'scripts/oracle/SCHEMA.md', 'package.json']) {
      expect(isDevOnly(p), p).toBe(false)
    }
  })
  it('TC-CMP-04 the release notes template has the three kinds of change; the upgrade guide covers backup, live deals and rollback', () => {
    const notes = read('docs/en/release-notes-template.md')
    for (const part of ['Gates', 'Warnings', 'Calculations']) expect(notes, part).toContain(part)
    const up = read('docs/en/upgrade-and-backup.md').toLowerCase()
    for (const part of ['back up', 'deals in progress', 'roll back', 'restore']) expect(up, part).toContain(part)
  })
})

describe('due-case reader', () => {
  const plan = ['| TC-A-01 | R | x | D0 |', '| TC-A-02 | R | x | D1 |', '| E2E-01 | flow | D0 |', '| TC-A-03 | R | x | 演示 |', '| R-OP-01 | not a case | D0 |', 'text TC-A-04 D0'].join('\n')
  it('reads the milestone from the last cell and ignores other rows', () => {
    expect(dueCases(plan, 'D0')).toEqual(['TC-A-01', 'E2E-01'])
    expect(dueCases(plan, 'D1')).toEqual(['TC-A-01', 'TC-A-02', 'E2E-01'])
  })
  it('counts vitest and playwright reports, several ids in one title, and failures', () => {
    const r = results([
      { testResults: [{ assertionResults: [{ title: 'TC-A-01 / TC-A-02 thing', status: 'passed' }, { title: 'TC-A-02 other', status: 'failed' }, { title: 'mentions TC-A-09 later', status: 'passed' }] }] },
      {
        suites: [{
          specs: [
            { title: 'E2E-01 flow', ok: true, tests: [{ expectedStatus: 'passed', results: [{ status: 'failed' }, { status: 'passed' }] }] },
            { title: 'TC-S-01 skipped', ok: true, tests: [{ expectedStatus: 'skipped', results: [{ status: 'skipped' }] }] },
            { title: 'TC-S-02 expected failure', ok: true, tests: [{ expectedStatus: 'failed', results: [{ status: 'failed' }] }] },
            { title: 'TC-S-03 no tests', ok: true, tests: [] },
          ],
          suites: [{ specs: [{ title: 'TC-A-03 x', ok: false, tests: [{ expectedStatus: 'passed', results: [{ status: 'failed' }] }] }] }],
        }],
      },
    ])
    expect(r.get('TC-A-01')).toEqual(['passed'])
    expect(r.get('TC-A-02')).toEqual(['passed', 'failed'])
    expect(r.get('E2E-01')).toEqual(['passed'])
    expect(r.get('TC-A-03')).toEqual(['failed'])
    expect(r.has('TC-A-09')).toBe(false)
    for (const id of ['TC-S-01', 'TC-S-02', 'TC-S-03']) expect(r.get(id), id).toEqual(['failed'])
  })
})
