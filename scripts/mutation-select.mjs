// Which tests a change touches, by test group, for `mutation-check.mjs --since` (rules §3 「变异检查」).

// a slash after one of these words starts a regex literal, not a division (`return /[{]/.test(x)`, Codex group B r2 #3)
// (`of` is left out: it is also a name, `of / 2` a division; Codex group B r3 #5)
const AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|case|throw|void|delete|in|instanceof|new|yield|await|else|do)\s*$/
/** The code before a slash on its line, block comments taken out (`return /* note *\/ /[{]/`, Codex group B r3 #5). */
const codeBefore = (line, k) => line.slice(0, k).replace(/\/\*.*?\*\//g, '')

/** Bracket depth before and after each line, skipping strings, template text and comments (a template's ${...} counts). */
function depths(text) {
  const before = []
  const after = []
  let depth = 0
  let quote = null // "'", '"' or '`'
  const tpl = [] // depth at each open ${ inside a template
  let block = false
  for (const line of text.split('\n')) {
    before.push(depth)
    for (let k = 0; k < line.length; k++) {
      const c = line[k]
      if (block) {
        if (c === '*' && line[k + 1] === '/') [block, k] = [false, k + 1]
      } else if (quote) {
        if (c === '\\') k++
        else if (c === quote) quote = null
        else if (quote === '`' && c === '$' && line[k + 1] === '{') {
          tpl.push(depth++)
          quote = null
          k++
        }
      } else if (c === '/' && line[k + 1] === '/') break
      else if (c === '/' && line[k + 1] === '*') [block, k] = [true, k + 1]
      else if ((c === '/' && /[(,=:[!&|?{};+\-*%<>~^]/.test(codeBefore(line, k).trimEnd().at(-1) ?? '(')) || (c === '/' && AFTER_WORD.test(codeBefore(line, k)))) {
        // a regex literal: skip to its closing slash, outside any [...] class
        for (let cls = false, j = k + 1; j < line.length; j++) {
          if (line[j] === '\\') j++
          else if (line[j] === '[') cls = true
          else if (line[j] === ']') cls = false
          else if (line[j] === '/' && !cls) {
            k = j
            break
          }
        }
      } else if (c === "'" || c === '"' || c === '`') quote = c
      else if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) {
        depth--
        if (c === '}' && tpl.length && depth === tpl.at(-1)) {
          tpl.pop()
          quote = '`'
        }
      }
    }
    if (quote && quote !== '`') quote = null // an unclosed ' or " ends with its line
    after.push(depth)
  }
  return { before, after }
}

/** The describe/it/test blocks of a test file: a block ends on the line where its brackets balance again. */
export function testBlocks(text) {
  const lines = text.split('\n')
  const { before, after } = depths(text)
  const blocks = []
  const START = /^(\s*)(describe|it|test)((?:\.(?:each\(.*?\)|skip|only|describe|serial))*)\(\s*(['"`])(.*?)\4/
  for (let i = 0; i < lines.length; i++) {
    let m = START.exec(lines[i])
    let title = m?.[5]
    let each = !!m?.[3].includes('each')
    let kind = m?.[2]
    if (!m) {
      // it.each(rows)(\n  'title', ...
      const e = /^(\s*)(it|test)\.each\(.*\)\($/.exec(lines[i])
      const t = e && /^\s*(['"`])(.*?)\1/.exec(lines[i + 1] ?? '')
      if (!t) continue
      ;[title, each, kind] = [t[2], true, e[2]]
    }
    const titleLine = m ? i + 1 : i + 2
    let last = i
    while (last < lines.length - 1 && after[last] > before[i]) last++
    blocks.push({ first: i + 1, last: last + 1, titleLine, kind: kind === 'describe' || m?.[3].includes('describe') ? 'describe' : 'test', title, each })
  }
  for (const b of blocks) b.chain = [...blocks.filter((p) => p.kind === 'describe' && p !== b && p.first <= b.first && p.last >= b.last).map((p) => p.title), b.title]
  return blocks
}
/** The tests a set of lines touches: 'all' when a line is outside every describe and test. */
export function touchedTests(text, lineNumbers) {
  const blocks = testBlocks(text)
  const out = []
  for (const n of lineNumbers) {
    const inner = blocks.filter((b) => b.first <= n && b.last >= n).sort((a, b) => a.last - a.first - (b.last - b.first))[0]
    if (!inner) return 'all'
    const tests = inner.kind === 'test' ? [inner] : blocks.filter((b) => b.kind === 'test' && b.first >= inner.first && b.last <= inner.last)
    if (!tests.length) out.push({ name: inner.chain.join(' '), each: true })
    for (const b of tests) out.push({ name: b.chain.join(' '), each: b.each })
  }
  return out
}
/**
 * Whether a test command's -t / -g name picks one of these tests; a command with no name runs them all.
 * A title with a placeholder (%s, $name) is many tests whose full names only the run knows (vitest list does not expand them).
 * It counts if the name fits its fixed text or its describes, or if the name appears in the test file (`text`) anywhere but
 * another test's title: in the rows, say. Without the file text it counts whatever the name (Codex group B r1 #7).
 */
export function picks(cmd, tests, text) {
  if (tests === 'all') return true
  if (!tests.length) return false
  const name = /(?:-t|-g) "([^"]*)"/.exec(cmd)?.[1]
  if (name === undefined) return true
  const re = new RegExp(name)
  const PLACEHOLDER = /%[sdifjo#%]|\$\w+/g
  const placeholder = /%[sdifjo#]|\$\w/
  let inRows
  const elsewhere = () => {
    if (text === undefined) return true
    if (inRows === undefined) {
      const titles = new Set(testBlocks(text).map((b) => b.titleLine))
      inRows = text.split('\n').some((l, i) => !titles.has(i + 1) && re.test(l))
    }
    return inRows
  }
  return tests.some(
    (t) =>
      re.test(t.name) ||
      (t.each &&
        (re.test(t.name.replace(PLACEHOLDER, '')) ||
          t.name.split(' ').some((_, i, w) => re.test(w.slice(0, i).join(' '))) ||
          (placeholder.test(t.name) && elsewhere()))),
  )
}

/** The mutants a copy of mutation-check.mjs defines, as [file, original, replacement, label, command]; null when they cannot be read. */
export function mutantsOf(script) {
  const start = script.indexOf('\nconst MUTANTS = [\n')
  const end = script.indexOf('\n]\n', start)
  if (start < 0 || end < 0) return null
  const consts = script
    .slice(0, start)
    .split('\n')
    .filter((l) => /^const [A-Z0-9_]+ = (?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")$/.test(l)) // either quote style, escapes too (Codex group B r2 #4, r3 #6)
    .join('\n')
  try {
    const list = new Function(`${consts}\nreturn ${script.slice(start + 17, end + 2)}`)()
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}
/** The mutants not in the base list. A mutant is its file, original, replacement, label and command, counted with repeats; no base list: all new. */
export function newMutants(mutants, base) {
  if (!base) return new Set(mutants)
  const key = (m) => JSON.stringify(m.slice(0, 5))
  const left = new Map()
  for (const m of base) left.set(key(m), (left.get(key(m)) ?? 0) + 1)
  const out = new Set()
  for (const m of mutants) {
    if (left.get(key(m))) left.set(key(m), left.get(key(m)) - 1)
    else out.add(m)
  }
  return out
}
