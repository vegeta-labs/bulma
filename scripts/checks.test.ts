import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain script
import { dueCases, results, unknownIds, untagged, unusedAllowed } from './check-coverage.mjs'
// @ts-expect-error plain script
import { mutantsOf, newMutants, picks, testBlocks, touchedTests } from './mutation-select.mjs'
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
    for (const p of ['CLAUDE.md', 'docs/HANDOFF.md', 'docs/PROGRESS.md', 'docs/milestone.txt', 'docs/demo-milestone.txt', 'docs/01_PRD.md', 'docs/04_TEST_PLAN.md', 'docs/review/a.md', 'private/identity-names.txt']) {
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
    // Demo blocks: before S, after S, after P, and with D5 merged in (demo plan §6)
    const demoPlan = ['| TC-A-01 | R | x | D4 |', '| TC-A-05 | R | x | D5 |', '| TC-D-01 | R | x | S |', '| TC-D-02 | R | x | P |', '| TC-D-03 | R | x | Q |']
      .join('\n')
    expect(dueCases(demoPlan, 'D4')).toEqual(['TC-A-01'])
    expect(dueCases(demoPlan, 'D4', 'none')).toEqual(['TC-A-01'])
    expect(dueCases(demoPlan, 'D4', 'S')).toEqual(['TC-A-01', 'TC-D-01'])
    expect(dueCases(demoPlan, 'D4', 'P')).toEqual(['TC-A-01', 'TC-D-01', 'TC-D-02'])
    expect(dueCases(demoPlan, 'D5', 'S')).toEqual(['TC-A-01', 'TC-A-05', 'TC-D-01'])
    expect(dueCases(demoPlan, 'D5', 'P')).toEqual(['TC-A-01', 'TC-A-05', 'TC-D-01', 'TC-D-02'])
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
  it('a test name with no case id is reported unless it is on the allow-list, and an allow-list entry no test uses is reported', () => {
    const reports = [
      { testResults: [{ assertionResults: [{ title: 'TC-A-01 / TC-A-02 thing', status: 'passed' }, { title: 'mentions TC-A-09 later', status: 'passed' }, { title: 'generic', status: 'passed' }] }] },
      { suites: [{ specs: [{ title: 'E2E-01 flow', tests: [] }], suites: [{ specs: [{ title: 'loose spec', tests: [] }, { title: 'tc-a-01 lower case is not an id', tests: [] }] }] }] },
      { testResults: [{ assertionResults: [{ title: 'loose spec', status: 'failed' }, { title: 'TC-A-01 / TC-A-O2 malformed second id', status: 'passed' }, { title: 'TC-A-04 / R-X-01 names a requirement', status: 'passed' }] }] },
      { testResults: [{ assertionResults: [{ title: 'TC-A-05 / TC-A-06-extra reads', status: 'passed' }, { title: 'TC-A-07-2 runs on', status: 'passed' }, { title: 'TC-A-08 / TC-A-02\uff12 reads', status: 'passed' }] }] },
    ]
    expect(untagged(reports, ['generic'])).toEqual(['mentions TC-A-09 later', 'loose spec', 'tc-a-01 lower case is not an id', 'TC-A-01 / TC-A-O2 malformed second id', 'TC-A-05 / TC-A-06-extra reads', 'TC-A-07-2 runs on', 'TC-A-08 / TC-A-02\uff12 reads'])
    for (const id of ['TC-A-05', 'TC-A-06', 'TC-A-07', 'TC-A-08']) expect(results(reports).has(id), id).toBe(false)
    expect(results(reports).get('TC-A-01')).toEqual(['passed'])
    expect(results(reports).get('TC-A-04')).toEqual(['passed'])
    expect(untagged(reports, ['generic', 'mentions TC-A-09 later', 'loose spec', 'tc-a-01 lower case is not an id', 'TC-A-05 / TC-A-06-extra reads', 'TC-A-07-2 runs on', 'TC-A-08 / TC-A-02\uff12 reads'])).toEqual(['TC-A-01 / TC-A-O2 malformed second id'])
    expect(unusedAllowed(reports, ['generic', 'gone'])).toEqual(['gone'])
  })
  it('a case id in a test name with no row in the test plan is reported, whatever the row\'s milestone', () => {
    const plan = ['| TC-A-01 | a | D0 |', '| TC-A-02 | b | D5 |', '| E2E-01 | c | D3 |', 'TC-A-07 mentioned in prose only'].join('\n')
    const reports = [
      { testResults: [{ assertionResults: [{ title: 'TC-A-01 / TC-A-02 thing', status: 'passed' }, { title: 'TC-A-07 / TC-A-01 prose is not a row', status: 'passed' }] }] },
      { suites: [{ specs: [{ title: 'E2E-01 flow', tests: [] }, { title: 'TC-B-03 typo', tests: [] }, { title: 'mentions TC-A-09 later', tests: [] }] }] },
    ]
    expect(unknownIds(reports, plan)).toEqual(['TC-A-07', 'TC-B-03'])
  })
})

describe('mutation --since picks mutants by the test group a change touches (rules §3 「变异检查」)', () => {
  const FILE = [
    "import { x } from 'y'", // 1
    "describe('Money in', () => {", // 2
    '  const helper = 1', // 3
    "  it('TC-PAY-01 a receipt counts', () => {", // 4
    '    expect(1).toBe(1)', // 5
    '  })', // 6
    "  it.each(rows)(", // 7
    "    'TC-PAY-02 %s is refused',", // 8
    '    async () => {', // 9
    '      expect(2).toBe(2)', // 10
    '    },', // 11
    '  )', // 12
    '})', // 13
    "describe('Links', () => {", // 14
    "  it('TC-LNK-01 one line', () => expect(3).toBe(3))", // 15
    "  it('TC-LNK-02 shown', () => {", // 16
    '    expect(4).toBe(4)', // 17
    '  })', // 18
    '})', // 19
  ].join('\n')
  const names = (lines: number[]) => {
    const t = touchedTests(FILE, lines)
    return t === 'all' ? 'all' : t.map((x: { name: string }) => x.name)
  }
  const cmd = (name?: string) => `npx vitest run src/server/a.test.ts${name === undefined ? '' : ` -t "${name}"`} --reporter=dot`
  it('a line inside a test touches that test; inside a describe, all its tests; outside every describe, the whole file', () => {
    expect(names([5])).toEqual(['Money in TC-PAY-01 a receipt counts'])
    expect(names([10])).toEqual(['Money in TC-PAY-02 %s is refused'])
    expect(names([3])).toEqual(['Money in TC-PAY-01 a receipt counts', 'Money in TC-PAY-02 %s is refused'])
    expect(names([15])).toEqual(['Links TC-LNK-01 one line'])
    expect(names([17])).toEqual(['Links TC-LNK-02 shown'])
    expect(names([1])).toBe('all')
  })
  it('a block ends where its brackets balance: multi-line parameters, brackets in strings, templates and comments do not end it', () => {
    const SPEC = [
      "test('TC-LNK-02 a lead (shown) makes a link', async ({", // 1
      '  browser,', // 2
      '}) => {', // 3
      "  const s = ')}' + `${'}'} )`", // 4
      '  // }) a comment', // 5
      "  expect(s).not.toMatch(/don't [)}]\\/ })/)", // 6
      '})', // 7
      "test('TC-LNK-03 next', async () => {", // 8
      '  expect(1).toBe(1)', // 9
      '})', // 10
      'const after = 1', // 11
    ].join('\n')
    const at = (n: number) => {
      const t = touchedTests(SPEC, [n])
      return t === 'all' ? 'all' : t.map((x: { name: string }) => x.name)
    }
    for (const n of [1, 3, 4, 6, 7]) expect(at(n), String(n)).toEqual(['TC-LNK-02 a lead (shown) makes a link'])
    expect(at(9)).toEqual(['TC-LNK-03 next'])
    expect(at(11)).toBe('all')
  })
  it('a slash after a keyword starts a regex: its brackets do not stretch the test over a shared helper (Codex group B r2 #3)', () => {
    const SPEC = [
      "it('A', () => {", // 1
      '  const x = 1', // 2
      '  return /[{(]/.test(String(x)) || typeof /[[]/ === "object"', // 3
      '})', // 4
      'function helper() {', // 5
      '  return 1', // 6
      '}', // 7
      "it('B', () => expect(helper()).toBe(1))", // 8
    ].join('\n')
    expect(touchedTests(SPEC, [3])).toEqual([{ name: 'A', each: false }])
    expect(touchedTests(SPEC, [6])).toBe('all')
    expect(picks('npx vitest run a.test.ts -t "B" --reporter=dot', touchedTests(SPEC, [6]))).toBe(true)
    // a division after a name is still a division
    expect(touchedTests("it('C', () => {\n  const r = a / b / c\n  return (r)\n})\nconst z = 1", [5])).toBe('all')
    // `of` as a name before a division, and a comment between return and a regex (Codex group B r3 #5)
    expect(touchedTests("it('D', () => {\n  const of = 8\n  return (of / 2) / 3\n})\nconst z = 1", [5])).toBe('all')
    expect(touchedTests("it('E', () => {\n  return /* note */ /[{]/.test('x')\n})\nconst z = 1", [4])).toBe('all')
  })
  it('a command picks the touched tests its -t / -g name matches; a command with no name, or a whole-file change, runs them', () => {
    const lnk = touchedTests(FILE, [17])
    expect(picks(cmd('Links'), lnk)).toBe(true)
    expect(picks(cmd('TC-LNK-02'), lnk)).toBe(true)
    expect(picks(cmd('Money in'), lnk)).toBe(false)
    expect(picks(cmd('TC-LNK-01|TC-PAY-01'), lnk)).toBe(false)
    expect(picks(cmd(), lnk)).toBe(true)
    expect(picks(cmd('Money in'), 'all')).toBe(true)
    expect(picks(cmd(), [])).toBe(false)
    // a title with %s: matched without the placeholder, by its describe, or by a name found in the file outside every title (the
    // rows); without the file, any name counts (Codex group B r1 #7)
    const each = touchedTests(FILE, [10])
    expect(picks(cmd('TC-PAY-02  is refused'), each, FILE)).toBe(true)
    expect(picks(cmd('Money in'), each, FILE)).toBe(true)
    expect(picks(cmd('TC-PAY-01'), each, FILE)).toBe(false)
    expect(picks(cmd('Links'), each, FILE)).toBe(false)
    expect(picks(cmd('TC-PAY-01'), each)).toBe(true)
    const rows = FILE.replace("it.each(rows)(", "it.each(['COBS, assessment locked'])(")
    expect(picks(cmd('COBS, assessment locked'), touchedTests(rows, [10]), rows)).toBe(true)
    expect(picks(cmd('COBS, assessment locked'), touchedTests(rows, [5]), rows)).toBe(false)
    expect(picks('npx playwright test e2e/d3.spec.ts -g "Links" --reporter=dot', lnk)).toBe(true)
  })
  it('every mutant command with a -t / -g name matches a test or describe by its fixed text, or a row on its own, not only a %s title the run expands (Codex group B r2 #2)', () => {
    const list = mutantsOf(readFileSync('scripts/mutation-check.mjs', 'utf8')) as string[][]
    const fixed = (b: { chain: string[] }) => b.chain.join(' ').replace(/%[sdifjo#%]|\$\w+/g, '')
    /** A regex's top-level `|` alternatives (not those inside brackets or escaped). */
    const alternatives = (re: string) => {
      const out = ['']
      for (let i = 0, depth = 0, cls = false; i < re.length; i++) {
        const c = re[i]!
        if (c === '\\') {
          out[out.length - 1] += c + (re[++i] ?? '')
          continue
        }
        if (cls) cls = c !== ']'
        else if (c === '[') cls = true
        else if (c === '(') depth++
        else if (c === ')') depth--
        else if (c === '|' && depth === 0) {
          out.push('')
          continue
        }
        out[out.length - 1] += c
      }
      return out
    }
    expect(alternatives('a|(b|c)|[|]|d\\|e')).toEqual(['a', '(b|c)', '[|]', 'd\\|e'])
    const matchesFixedText = (cmd: string) => {
      const name = /(?:-t|-g) "([^"]*)"/.exec(cmd)?.[1]
      if (name === undefined) return true
      const files = cmd.split(' ').filter((w) => /\.(test|spec)\.tsx?$/.test(w))
      // each alternative of the name on its own (Codex group B r3 #4): one that matches cannot vouch for another
      return alternatives(name).every((alt) => {
        const re = new RegExp(alt)
        // or, for a row of a %s title, the name stands whole on a line that is no title (`picks` finds the row there)
        return files.some((f) => {
          const text = readFileSync(f, 'utf8')
          const blocks = testBlocks(text)
          const titles = new Set(blocks.map((b: { titleLine: number }) => b.titleLine))
          return blocks.some((b: { chain: string[] }) => re.test(fixed(b))) || text.split('\n').some((l, i) => !titles.has(i + 1) && re.test(l))
        })
      })
    }
    // a gate-matrix row name plus the title's own text: only the run's expanded title has it
    expect(matchesFixedText('npx vitest run src/server/d3.test.ts -t "COBS, assessment locked: every new step" --reporter=dot')).toBe(false)
    expect(matchesFixedText('npx vitest run src/server/d3.test.ts -t "route-by-condition gate matrix" --reporter=dot')).toBe(true)
    expect(matchesFixedText('npx vitest run src/server/d3.test.ts -t "COBS, assessment locked" --reporter=dot')).toBe(true)
    expect(matchesFixedText('npx vitest run src/server/d3.test.ts -t "COBS, assessment locked: every new step|a quote for a changed amount replaces" --reporter=dot')).toBe(false)
    const unmatched = [...new Set(list.map((m) => m[4]!))].filter((cmd) => !matchesFixedText(cmd))
    expect(list.length).toBeGreaterThan(1000)
    expect(unmatched).toEqual([])
  })
  it('a mutant is new unless the base defines the same file, original, replacement, label and command', () => {
    const script = (rows: string[]) => ["import x from 'y'", "const A = 'npx vitest run a.test.ts'", 'const MUTANTS = [', ...rows, ']', 'run()', ''].join('\n')
    const one = "  ['f.ts', 'a', 'b', 'same label', A],"
    const two = "  ['g.ts', 'c', 'd', 'same label', A],"
    const base = mutantsOf(script([one]))
    expect(base).toEqual([['f.ts', 'a', 'b', 'same label', 'npx vitest run a.test.ts']])
    // a second mutant under a label the base already has
    expect([...newMutants(mutantsOf(script([one, two]))!, base)].map((m) => m[0])).toEqual(['g.ts'])
    // the replacement edited under the same label
    expect(newMutants(mutantsOf(script(["  ['f.ts', 'a', 'B', 'same label', A],"]))!, base).size).toBe(1)
    // a script against itself, labels in either quote style: none new
    const mixed = mutantsOf(script([one, '  ["h.ts", "e", "f", "it\'s double", A],']))!
    expect(newMutants(mixed, mixed).size).toBe(0)
    // a command constant in double quotes is read too, so the same list in the other quote style is not new (Codex group B r2 #4)
    const double = script([one]).replace("const A = 'npx vitest run a.test.ts'", 'const A = "npx vitest run a.test.ts"')
    expect(mutantsOf(double)).toEqual(base)
    expect(newMutants(mutantsOf(double)!, base).size).toBe(0)
    // a filtered command in double quotes carries escaped quotes (Codex group B r3 #6)
    const filtered = (decl: string) => ["import x from 'y'", decl, 'const MUTANTS = [', "  ['f.ts', 'a', 'b', 'label', G],", ']', ''].join('\n')
    const single = mutantsOf(filtered(`const G = 'npx vitest run a.test.ts -t "gate matrix" --reporter=dot'`))
    expect(single).toEqual([['f.ts', 'a', 'b', 'label', 'npx vitest run a.test.ts -t "gate matrix" --reporter=dot']])
    expect(mutantsOf(filtered(`const G = "npx vitest run a.test.ts -t \\"gate matrix\\" --reporter=dot"`))).toEqual(single)
    // a base that cannot be read: all new
    expect(mutantsOf('no list here')).toBeNull()
    expect(newMutants(mixed, mutantsOf('no list here')).size).toBe(2)
  })
})
