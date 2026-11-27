import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib'
import { pdfLines, pdfText } from '../../src/server/pdfText.ts'
import { renderPdf } from '../../src/server/pdf.ts'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { packDir, testVersion } from '../demo-pack.ts'
import { BUILT_FROM, codeDiffers, commitProblem, inventory, noteSource, packPath, sourceProblem, sourceState } from './source.ts'
import { holdLock, LOCK } from './lock.ts'
import { clockProblem, offsetText } from './clock.ts'
import { readTar, splitName, tarProblems, writeTar } from './tar.ts'
import { companiesIn, fictionalHost, hostsIn, manifestProblems, manifestText, pdfStrings, scanText } from './pack.ts'

const rules = { names: /forbidden-platform|owner-secret-place/i, companies: new Set(['Senzu Labs Ltd', 'Fictional Holder Ltd']) }
const bytes = (s: string) => Buffer.from(s, 'utf8')
/** The glyph codes that draw `word` on a renderPdf page, from the letters its first line draws (each letter its own code). */
async function glyphHex(pdf: Uint8Array, word: string): Promise<string> {
  const doc = await PDFDocument.load(pdf)
  const c = doc.getPage(0).node.Contents()
  const streams = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c]
  const ops = streams.map((x) => Buffer.from(decodePDFRawStream(x as PDFRawStream).decode()).toString('latin1')).join('\n')
  const [line] = await pdfText(pdf)
  const hex = /<([0-9A-Fa-f]*)> Tj/.exec(ops)![1]!
  return [...word].map((ch) => hex.slice(line!.indexOf(ch) * 4, line!.indexOf(ch) * 4 + 4)).join('')
}
const PAGE = '<!doctype html><html><head><meta name="robots" content="noindex" /><script src="x.js"></script></head><body></body></html>'

describe('demo pack: the scan of the final archive (plan 05 §5.7)', () => {
  it('TC-DEMO-12 a link token, session, CSRF or password value is refused unless it is a demo stand-in', () => {
    const token = 'Ab3_dE5-gH7iJ9kLmN0pQrStUvWxYz12'
    expect(scanText('data/snapshot.js', `{"verify_url":"/verify-instruction?token=${token}"}`, rules)).toEqual(['data/snapshot.js: a link token (Ab3_dE5-…)'])
    expect(scanText('data/files/a/b.csv', `x#/investor/verify?token=${token}`, rules)).toHaveLength(1)
    expect(scanText('data/snapshot.js', '{"verify_url":"/verify-instruction?token=demo-token-7"}', rules)).toEqual([])
    // the code that builds or reads a link is not a token
    expect(scanText('assets/i.js', 'a=`?token=${encodeURIComponent(t)}`;/[?&]token=([\\w-]+)/.exec(h)', rules)).toEqual([])
    expect(scanText('data/snapshot.js', '{"csrf":"Zz9-real-value"}', rules)).toEqual(['data/snapshot.js: a "csrf" value that is not a demo stand-in'])
    expect(scanText('data/snapshot.js', '{"csrf":"demo-csrf-2","password":"","Token" : "x1"}', rules)).toEqual([
      'data/snapshot.js: a "Token" value that is not a demo stand-in',
    ])
    expect(scanText('data/snapshot.js', 'cookie: bulma_session=abc123; bulma_invite=demo-x', rules)).toEqual(['data/snapshot.js: a bulma_session cookie value'])
    expect(scanText('x.txt', '-----BEGIN EC PRIVATE KEY-----', rules)).toEqual(['x.txt: key material'])
    // a link inside another link's query, percent-encoded once; any key that names a secret
    expect(scanText('data/snapshot.js', `{"next":"/login?next=%2Finvite%3Ftoken%3D${token}"}`, rules)).toEqual(['data/snapshot.js: a link token (Ab3_dE5-…)'])
    expect(scanText('data/files/a/e.json', `{"invite_token":"${token}","sessionId":"s1","x-csrf-token":"demo-csrf-1"}`, rules)).toEqual([
      'data/files/a/e.json: a "invite_token" value that is not a demo stand-in',
      'data/files/a/e.json: a "sessionId" value that is not a demo stand-in',
    ])
    expect(scanText('data/snapshot.js', '{"u":"100%","p":"%zz"}', rules)).toEqual([])
  })

  it('TC-DEMO-12 only fictional hosts anywhere; library hosts only inside the built screens; bare domains outside code', () => {
    expect(hostsIn('see https://Senzu-Labs.com/deck and mail goku@run-1.demo.invalid or visit capsule.co.uk.')).toEqual([
      'senzu-labs.com',
      'run-1.demo.invalid',
      'capsule.co.uk',
    ])
    expect(hostsIn('e.info;t.io(x)', true)).toEqual([])
    expect(hostsIn('e.info', false)).toEqual(['e.info'])
    for (const h of ['a.invalid', 'x.example', 'example.com', 'localhost', 'b.test']) expect(fictionalHost(h)).toBe(true)
    for (const h of ['example.co', 'notexample.com', 'invalid.com', 'react.dev', 'latest', 'notlocalhost', 'myexample']) expect(fictionalHost(h)).toBe(false)
    expect(scanText('assets/index-1.js', 'u="http://www.w3.org/2000/svg";r="https://react.dev/errors/"', rules)).toEqual([])
    expect(scanText('data/snapshot.js', '{"u":"https://react.dev/x"}', rules)).toEqual(['data/snapshot.js: names the host react.dev'])
    expect(scanText('assets/index-1.js', 'fetch("https://telemetry.example.org.uk/x")', rules)).toEqual([
      'assets/index-1.js: names the host telemetry.example.org.uk',
    ])
    expect(scanText('data/files/a/deck.pdf', 'Website: senzulabs.io', rules)).toEqual(['data/files/a/deck.pdf: names the host senzulabs.io'])
  })

  it('TC-DEMO-12 / TC-DEMO-02 a company name outside the scenario and anything on the private name list are refused', () => {
    expect(companiesIn('Senzu Labs Ltd and Real Widgets plc, also  Acme   Holdings Inc.')).toEqual(['Senzu Labs Ltd', 'Real Widgets plc', 'Acme Holdings Inc'])
    // the registry's upper-case form
    expect(companiesIn('ACME WIDGETS LIMITED, Acme Widgets LTD, CAPSULE CORP, Plain Words Plc')).toEqual([
      'ACME WIDGETS LIMITED',
      'Acme Widgets LTD',
      'CAPSULE CORP',
      'Plain Words Plc',
    ])
    expect(scanText('data/snapshot.js', '{"company":"Senzu Labs Ltd","holder":"Fictional Holder Ltd"}', rules)).toEqual([])
    expect(scanText('data/snapshot.js', '{"company":"Senzu Labs Limited"}', rules)).toEqual([
      'data/snapshot.js: names the company Senzu Labs Limited, which is not in the scenario',
    ])
    expect(scanText('index.html', PAGE.replace('<body>', '<body>Built like Forbidden-Platform'), rules)).toEqual([
      'index.html: names something that must not be published (private name list)',
    ])
  })

  it('TC-DEMO-12 every HTML page is not for search engines and has no inline script or style (the site CSP)', () => {
    expect(scanText('index.html', PAGE, rules)).toEqual([])
    expect(scanText('data/notes/a.html', PAGE.replace('<meta name="robots" content="noindex" />', ''), rules)).toEqual(['data/notes/a.html: no noindex'])
    expect(scanText('index.html', PAGE.replace('<body>', '<body><script>alert(1)</script>'), rules)).toEqual(['index.html: an inline script'])
    expect(scanText('index.html', PAGE.replace('<body>', '<body style="x">'), rules)).toEqual(['index.html: an inline style'])
    expect(scanText('index.html', PAGE.replace('<body>', '<body><style>p{}</style>'), rules)).toEqual(['index.html: an inline style'])
  })

  it('TC-DEMO-12 the manifest lists every file but itself, sorted; any change, extra or missing file is found', () => {
    const files = new Map([
      ['snapshot-info.json', bytes('{}')],
      ['assets/a.js', bytes('a')],
      ['data/files/x/b.pdf', bytes('b')],
    ])
    const text = manifestText(files)
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(66)),
    ).toEqual(['assets/a.js', 'data/files/x/b.pdf', 'snapshot-info.json'])
    expect(text).toMatch(/^ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb {2}assets\/a\.js\n/)
    const withManifest = new Map([...files, ['MANIFEST.sha256', bytes(text)]])
    // an old manifest in the directory is never listed in the new one
    expect(manifestText(withManifest)).toBe(text)
    expect(manifestProblems(text, withManifest)).toEqual([])
    expect(manifestProblems(text, new Map([...withManifest, ['assets/a.js', bytes('changed')]]))).toEqual(['assets/a.js: not in MANIFEST.sha256 or differs'])
    expect(manifestProblems(text, new Map([...withManifest, ['extra.txt', bytes('')]]))).toEqual(['extra.txt: not in MANIFEST.sha256 or differs'])
    const less = new Map(withManifest)
    less.delete('data/files/x/b.pdf')
    expect(manifestProblems(text, less)).toEqual(['data/files/x/b.pdf: in MANIFEST.sha256 but not in the archive'])
    const lines = text.split('\n').filter(Boolean)
    expect(manifestProblems(`${lines[1]}\n${lines[0]}\n${lines[2]}\n`, withManifest)).toEqual(['MANIFEST.sha256: not sorted by path'])
    expect(manifestProblems(`${text}bad line\n`, withManifest)).toEqual(['MANIFEST.sha256: a line not in the format: bad line'])
    // a path twice (a wrong digest first), the manifest listing itself, anything but exactly its own text (Codex P r1 #18)
    const wrong = `${'0'.repeat(64)}  assets/a.js\n`
    expect(manifestProblems(`${wrong}${text}`, withManifest)).toContain('MANIFEST.sha256: lists assets/a.js twice')
    expect(manifestProblems(`${text}${'0'.repeat(64)}  MANIFEST.sha256\n`, withManifest)).toEqual(['MANIFEST.sha256: lists itself'])
    expect(manifestProblems(`${text}\n`, withManifest)).toEqual(['MANIFEST.sha256: not exactly the manifest of these files'])
  })

  it('TC-DEMO-12 a path on someone\'s machine, and a host, company or listed name written %xx-encoded, are refused', () => {
    for (const p of ['/Users/someone/bulma/x.ts', '/home/runner/work', 'C:\\Users\\someone\\x', 'c:\\users\\someone\\x', '/private/var/folders/ab/T/x', 'file:///etc/x'])
      expect(scanText('data/snapshot.js', `{"error":"failed at ${p}"}`, rules), p).toEqual([expect.stringMatching(/^data\/snapshot\.js: a path on someone's machine \(/)])
    expect(scanText('data/snapshot.js', '{"route":"/home","page":"/deals/users"}', rules)).toEqual([])
    expect(scanText('data/snapshot.js', '{"next":"%2Fgo%3Fto%3Dhttps%3A%2F%2Freal-bank.com%2Fx"}', rules)).toContain('data/snapshot.js: names the host real-bank.com')
    expect(scanText('data/snapshot.js', '{"q":"Real%20Widgets%20plc"}', rules)).toEqual([
      'data/snapshot.js: names the company Real Widgets plc, which is not in the scenario',
    ])
    expect(scanText('data/snapshot.js', '{"q":"forbidden%2Dplatform"}', rules)).toEqual(['data/snapshot.js: names something that must not be published (private name list)'])
    // a name outside ASCII, %xx-encoded as UTF-8 the usual way; an escape that is not one is left as it is (Codex P r2 #5)
    const accented = { ...rules, names: /Café Gris/ }
    expect(scanText('data/snapshot.js', '{"q":"Caf%C3%A9%20Gris"}', accented)).toEqual(['data/snapshot.js: names something that must not be published (private name list)'])
    expect(scanText('data/snapshot.js', '{"q":"Caf%C3%A9%20Gris %E9 100%"}', accented)).toHaveLength(1)
    expect(scanText('data/snapshot.js', '{"q":"Caf%C3%A9%20Noir"}', accented)).toEqual([])
  })

  it('TC-DEMO-12 a PDF is read for its drawn text and for a link that is only an annotation, hex-written, in an object stream', async () => {
    const doc = await PDFDocument.load(await renderPdf([{ text: 'Payment details for Senzu Labs Ltd' }], 'Payment details'), { updateMetadata: false })
    const page = doc.getPage(0)
    const link = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [0, 0, 100, 20],
      A: { Type: 'Action', S: 'URI', URI: PDFHexString.fromText('https://bank.example.co.uk/verify?token=Ab3_dE5-gH7iJ9kLmN0pQrStUvWxYz12') },
    })
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]))
    const saved = await doc.save({ useObjectStreams: true })
    expect(Buffer.from(saved).toString('latin1')).not.toContain('bank.example')
    const text = await pdfStrings(saved)
    expect(text).toContain('Payment details for Senzu Labs Ltd')
    expect(scanText('data/files/a/p.pdf', text, rules)).toEqual([
      'data/files/a/p.pdf: a link token (Ab3_dE5-…)',
      'data/files/a/p.pdf: names the host bank.example.co.uk',
    ])
  })

  it('TC-DEMO-12 a PDF whose text cannot be read (a font without a Unicode map) is refused, not passed', async () => {
    const doc = await PDFDocument.create()
    doc.addPage().drawText('Real Widgets plc', { font: await doc.embedFont(StandardFonts.Helvetica) })
    await expect(pdfStrings(await doc.save())).rejects.toThrow(/has no Unicode map/)
  })

  it('TC-DEMO-12 text drawn by any text operator, after a comment or inside a Form XObject is read by the page reader and the scan (Codex P r6 #1)', async () => {
    const plain = await renderPdf([{ text: 'Payment details' }], 'Payment details')
    const lines = await pdfText(plain)
    const font = (await PDFDocument.load(plain)).getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0]!.asString().slice(1)
    // a word the page does not hold already, so only reading the new text finds it
    const hex = await glyphHex(plain, 'tailed')
    expect(await pdfStrings(plain)).not.toContain('tailed')
    const at = `BT /${font} 12 Tf 1 0 0 1 50 300 Tm`
    const forms: Record<string, string> = {
      Tj: `${at} <${hex}> Tj ET`,
      'line breaks between operands': `BT\n/${font}\n12\nTf\n1 0 0 1 50\n300 Tm\n<${hex}>\nTj\nET`,
      "a comment before '": `${at} 14 TL <${hex}> %x\n' ET`,
      'a comment before Tj': `${at} <${hex}> %x\nTj ET`,
      TJ: `${at} [<${hex}> -200 <${hex}>] TJ ET`,
    }
    for (const [name, ops] of Object.entries(forms)) {
      const doc = await PDFDocument.load(plain, { updateMetadata: false })
      doc.getPage(0).node.addContentStream(doc.context.register(doc.context.flateStream(ops)))
      const saved = await doc.save()
      expect((await pdfText(saved)).slice(lines.length), name).toEqual([name === 'TJ' ? 'tailed tailed' : 'tailed'])
      await expect(pdfStrings(saved), name).resolves.toContain('tailed')
    }
    // the same words inside a Form XObject the page draws with Do
    const doc = await PDFDocument.load(plain, { updateMetadata: false })
    const res = doc.getPage(0).node.Resources()!
    const form = doc.context.flateStream(`${at} <${hex}> Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: { Font: res.get(PDFName.of('Font'))! } })
    res.set(PDFName.of('XObject'), doc.context.obj({ Fx9: doc.context.register(form) }))
    doc.getPage(0).node.addContentStream(doc.context.register(doc.context.flateStream('q /Fx9 Do Q')))
    const saved = await doc.save()
    expect((await pdfText(saved)).slice(lines.length)).toEqual(['tailed'])
    await expect(pdfStrings(saved)).resolves.toContain('tailed')
  })

  it('TC-DEMO-12 the page reader starts a line where a run is more than 3 points from its line\'s first run; the line has that run\'s size', async () => {
    const plain = await renderPdf([{ text: 'Payment details' }], 'Payment details')
    const font = (await PDFDocument.load(plain)).getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0]!.asString().slice(1)
    const hex = await glyphHex(plain, 'tailed')
    // runs drawn ahead of the page's own text, so they are its first lines
    const ahead = async (ops: string) => {
      const doc = await PDFDocument.load(plain, { updateMetadata: false })
      const was = doc.getPage(0).node.Contents()!
      const s = doc.context.register(doc.context.flateStream(`BT /${font} 12 Tf ${ops} ET`))
      doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.obj([s, ...(was instanceof PDFArray ? was.asArray() : [doc.context.getObjectRef(was)!])]))
      return pdfLines(await doc.save())
    }
    const run = `<${hex}> Tj`
    // the page's first words, placed by Td alone before any Tm, are a line of their own (Codex P r3 #4)
    expect((await ahead(`50 300 Td ${run}`))[0]).toEqual({ text: 'tailed', size: 12 })
    // a second run 20 points down or up is a line of its own (Codex P r4 #4); a move of 0 keeps one; two moves of 2 points
    // down are 4 (Codex P r5 #6); a new BT at the same height is the same line (pdf.js puts a space where the gap is)
    const two = async (moves: string) => (await ahead(`50 300 Td ${run} ${moves} ${run}`)).slice(0, 2).map((l) => l.text)
    expect(await two('0 -20 Td')).toEqual(['tailed', 'tailed'])
    expect(await two('0 +20 Td')).toEqual(['tailed', 'tailed'])
    expect((await two('0 0 Td'))[0]).toBe('tailedtailed')
    expect(await two('0 -2 Td 0 -2 Td')).toEqual(['tailed', 'tailed'])
    expect((await two('0 -2 Td 0 +2 Td'))[0]).toBe('tailedtailed')
    expect((await two('ET BT 100 300 Td'))[0]).toBe('tailed tailed')
    // runs at 100, 102 and 104, the size changed on the second: the third is 4 points from the line's first run (2 from the
    // one before it) and starts a line; the first line keeps its first run's size (Codex P r6 #6)
    const three = await ahead(`1 0 0 1 50 100 Tm ${run} /${font} 20 Tf 1 0 0 1 50 102 Tm ${run} 1 0 0 1 50 104 Tm ${run}`)
    expect(three.slice(0, 2)).toEqual([
      { text: 'tailedtailed', size: 12 },
      { text: 'tailed', size: 20 },
    ])
    // a size set by the text matrix, not the font size, is the size drawn, and Td moves in its scaled units (Codex P r6 #2)
    expect((await ahead(`/${font} 1 Tf 12 0 0 12 50 300 Tm ${run} 0 -2 Td ${run}`)).slice(0, 2)).toEqual([
      { text: 'tailed', size: 12 },
      { text: 'tailed', size: 12 },
    ])
  })
})

describe('demo pack: the archive itself (scripts/demo-export/tar.ts; Codex P r1 #1)', () => {
  it('TC-DEMO-12 the archive names no owner, user or group and has no extended header; one the system tar made is refused', () => {
    const files = new Map([
      ['index.html', bytes(PAGE)],
      ['data/files/ab/x.pdf', bytes('%PDF-1.7 x'.repeat(100))],
    ])
    const entries = readTar(writeTar(files, 1_793_613_600))
    expect(entries.map((e) => [e.name, e.type, e.mode.toString(8), e.uid, e.gid, e.uname, e.gname])).toEqual([
      ['data/', '5', '755', 0, 0, '', ''],
      ['data/files/', '5', '755', 0, 0, '', ''],
      ['data/files/ab/', '5', '755', 0, 0, '', ''],
      ['data/files/ab/x.pdf', '0', '644', 0, 0, '', ''],
      ['index.html', '0', '644', 0, 0, '', ''],
    ])
    expect(entries.find((e) => e.name === 'data/files/ab/x.pdf')!.data).toEqual(files.get('data/files/ab/x.pdf'))
    expect(tarProblems(entries, 1_793_613_600)).toEqual([])
    expect(() => writeTar(new Map([['../x', bytes('')]]), 0)).toThrow(/not a plain relative path/)
    // a file name as long as the export allows (80) under data/files/<hash>/: over ustar's 100 bytes, so split at a folder
    // (Codex P r2 #8); the system's tar unpacks it where it belongs
    const long = `data/files/${'a'.repeat(32)}/${'b'.repeat(76)}.pdf`
    expect(splitName(long)).toEqual(['data/files/' + 'a'.repeat(32), `${'b'.repeat(76)}.pdf`])
    expect(() => splitName(`${'c'.repeat(160)}/x`)).toThrow(/too long/)
    const t = mkdtempSync(join(tmpdir(), 'bulma-tar-long-'))
    try {
      writeFileSync(join(t, 'x.tar.gz'), writeTar(new Map([[long, bytes('%PDF')]]), 0))
      execFileSync('tar', ['-xzf', join(t, 'x.tar.gz'), '-C', t])
      expect(readFileSync(join(t, long), 'utf8')).toBe('%PDF')
      expect(readTar(readFileSync(join(t, 'x.tar.gz'))).map((e) => e.name)).toContain(long)
      // a folder of exactly 100 bytes: its header drops the closing `/` (Codex P r3 #8), and it still unpacks as a folder
      const dir100 = `${'d'.repeat(100)}/guide.txt`
      expect(splitName(`${'d'.repeat(100)}/`)).toEqual(['', 'd'.repeat(100)])
      writeFileSync(join(t, 'y.tar.gz'), writeTar(new Map([[dir100, bytes('guide')]]), 0))
      execFileSync('tar', ['-xzf', join(t, 'y.tar.gz'), '-C', t])
      expect(readFileSync(join(t, dir100), 'utf8')).toBe('guide')
      // and one of 100 bytes under another folder: prefix x, the name without its `/` (Codex P r4 #8)
      const nested = `x/${'e'.repeat(100)}/guide.txt`
      expect(splitName(`x/${'e'.repeat(100)}/`)).toEqual(['x', 'e'.repeat(100)])
      writeFileSync(join(t, 'z.tar.gz'), writeTar(new Map([[nested, bytes('nested')]]), 0))
      // unpacked under umask 022, so the modes asserted are the archive's, not cut by the caller's umask (Codex P r5 #9)
      execFileSync('sh', ['-c', 'umask 022 && tar -xzf "$1" -C "$2"', 'sh', join(t, 'z.tar.gz'), t])
      expect(readFileSync(join(t, nested), 'utf8')).toBe('nested')
      expect(statSync(join(t, `x/${'e'.repeat(100)}`)).isDirectory()).toBe(true)
      expect((statSync(join(t, `x/${'e'.repeat(100)}`)).mode & 0o777).toString(8)).toBe('755')
      expect((statSync(join(t, nested)).mode & 0o777).toString(8)).toBe('644')
    } finally {
      rmSync(t, { recursive: true, force: true })
    }
    // what the system's tar writes: this machine's user (and on macOS its extended attributes)
    const d = mkdtempSync(join(tmpdir(), 'bulma-tar-test-'))
    try {
      writeFileSync(join(d, 'a.txt'), 'a')
      execFileSync('tar', ['-czf', join(d, 'x.tar.gz'), '-C', d, 'a.txt'])
      const made = readTar(readFileSync(join(d, 'x.tar.gz')))
      expect(tarProblems(made, 0).join('\n')).toMatch(/names the user or group|names owner|of type x/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
    const one = entries[4]!
    expect(tarProblems([{ ...one, type: 'x' }, { ...one, uid: 501 }, { ...one, uname: 'someone' }, { ...one, mode: 0o755 }, { ...one, mtime: 5 }], 1_793_613_600)).toEqual([
      'index.html: the archive\'s header is of type x (an extended header, a link or a device), not a file or folder',
      'index.html: the archive\'s header names owner 501:0',
      'index.html: the archive\'s header names the user or group someone:',
      'index.html: the archive\'s header has mode 755',
      'index.html: the archive\'s header has another time than the pack',
    ])
  })
})

describe('demo pack: packing and its refusals (scripts/demo-pack.ts)', () => {
  const made: string[] = []
  const folder = () => {
    const d = mkdtempSync(join(tmpdir(), 'bulma-pack-test-'))
    made.push(d)
    return d
  }
  afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))
  const build = () => {
    const from = folder()
    writeFileSync(join(from, 'index.html'), PAGE)
    mkdirSync(join(from, 'data'))
    writeFileSync(join(from, 'data/snapshot.js'), 'globalThis.BULMA_DEMO = {"csrf":"demo-csrf-1"}\n')
    return from
  }
  const commit = 'a'.repeat(40)

  it('TC-DEMO-12 a clean build is packed with its info and manifest, and only then gets its .sha256', async () => {
    const out = folder()
    const { tar, files } = await packDir({ from: build(), out, version: '9.9.9', commit, rules })
    expect(files).toBe(4)
    expect(tar).toBe(join(out, 'bulma-demo-v9.9.9.tar.gz'))
    const [sum, name] = readFileSync(`${tar}.sha256`, 'utf8').trim().split(/ {2}/)
    expect(name).toBe('bulma-demo-v9.9.9.tar.gz')
    expect(sum).toBe(createHash('sha256').update(readFileSync(tar)).digest('hex'))
    const listed = execFileSync('tar', ['-tzf', tar], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
    expect(listed).toEqual(['MANIFEST.sha256', 'data/', 'data/snapshot.js', 'index.html', 'snapshot-info.json'])
    // its headers are ours: no owner, no user, nothing extended; nothing else is left beside the pair
    // one time in every header: the pack's built_at (Codex P r2 #8)
    const entries = readTar(readFileSync(tar))
    const info = JSON.parse(entries.find((e) => e.name === 'snapshot-info.json')!.data.toString('utf8')) as { built_at: string }
    expect(tarProblems(entries, Date.parse(info.built_at) / 1000)).toEqual([])
    expect(readTar(readFileSync(tar)).every((e) => e.uid === 0 && !e.uname && (e.type === '0' || e.type === '5'))).toBe(true)
    expect(readdirSync(out).sort()).toEqual(['bulma-demo-v9.9.9.tar.gz', 'bulma-demo-v9.9.9.tar.gz.sha256'])
  })

  it('TC-DEMO-12 a test archive (no private name list) has its own name and says the names were not checked', async () => {
    const out = folder()
    const { tar } = await packDir({ from: build(), out, version: testVersion('9.9.9'), commit, rules, extra: { names_checked: false } })
    expect(tar).toBe(join(out, 'bulma-demo-v9.9.9-test.tar.gz'))
    // its own version inside too, so renamed it is still no release (Codex P r2 #1)
    const info = readTar(readFileSync(tar)).find((e) => e.name === 'snapshot-info.json')!
    expect(JSON.parse(info.data.toString('utf8'))).toMatchObject({ version: '9.9.9-test', commit, names_checked: false })
  })

  it('TC-DEMO-12 the pack takes the build exactly as the build listed it, and writes nothing into it (Codex P r2 #2, #7)', async () => {
    const from = build()
    const listed = (files: string[]) => {
      const note = join(folder(), 'build-source.json')
      noteSource(note, { commit, clean: true, files: inventory(new Map(files.map((f) => [f, existsSync(join(from, f)) ? readFileSync(join(from, f)) : bytes(f)]))) })
      return note
    }
    const all = ['data/snapshot.js', 'index.html']
    // a file missing (a build running at the same time, or removed by hand), one added, one changed
    for (const [what, note, says] of [
      ['missing', listed([...all, 'data/a.js']), /data\/a\.js/],
      ['added', listed(['index.html']), /data\/snapshot\.js/],
      ['none', (() => { const n = join(folder(), 'n.json'); noteSource(n, { commit, clean: true }); return n })(), /noted no list of its files/],
    ] as const) {
      const out = folder()
      await expect(packDir({ from, out, version: '9.9.9', commit, rules, noted: note }), what).rejects.toThrow(says)
      expect(readdirSync(out), what).toEqual([])
    }
    const note = listed(all)
    writeFileSync(join(from, 'index.html'), PAGE.replace('<body>', '<body>x'))
    await expect(packDir({ from, out: folder(), version: '9.9.9', commit, rules, noted: note })).rejects.toThrow(/not what the build wrote \(index\.html\)/)
    writeFileSync(join(from, 'index.html'), PAGE)
    const out = folder()
    await packDir({ from, out, version: '9.9.9', commit, rules, noted: note })
    // the build's folder is as it was: info and manifest are only in the archive
    expect(readdirSync(from).sort()).toEqual(['data', 'index.html'])
    // a second run that fails leaves the first pair as it was
    const pair = readdirSync(out).sort().map((f) => readFileSync(join(out, f)))
    writeFileSync(join(from, 'data/e.json'), '{"invite_token":"Ab3_dE5-gH7iJ9kLmN0pQrStUvWxYz12"}')
    await expect(packDir({ from, out, version: '9.9.9', commit, rules })).rejects.toThrow(/invite_token/)
    expect(readdirSync(out).sort().map((f) => readFileSync(join(out, f)))).toEqual(pair)
  })

  it('TC-DEMO-12 a file name holding a backslash is refused, so it never shares a path with a file in a folder (Codex P r3 #7)', async () => {
    const from = build()
    writeFileSync(join(from, 'data\\e.json'), '{}')
    await expect(packDir({ from, out: folder(), version: '9.9.9', commit, rules })).rejects.toThrow(/data\\e\.json: a file name holding "\\"/)
    expect(packPath(from, join(from, 'data/e.json'))).toBe('data/e.json')
  })

  it('TC-DEMO-12 git ignores the lock and nothing else that starts with its name (Codex P r5 #4, r6 #4)', () => {
    const ignored = (path: string) => {
      try {
        execFileSync('git', ['check-ignore', '--no-index', '-q', path])
        return true
      } catch {
        return false
      }
    }
    expect(ignored(LOCK)).toBe(true)
    expect(['.demo.lock.1-notes.md', '.demo.lock.4242.a1b2c3d4e5f6', '.demo.lock-notes.md', '.demo.lockdocs/readme.md', '.demo.locks', 'x/.demo.lock'].filter(ignored)).toEqual([])
  })

  it('TC-DEMO-12 one demo step at a time: a second one is refused while the first holds the lock, and so is any lock left behind', () => {
    const lock = join(folder(), 'demo.lock')
    const release = holdLock('the demo build', lock)
    expect(() => holdLock('the demo pack', lock)).toThrow(`the demo build (process ${process.pid}, mark `)
    expect(() => holdLock('the demo pack', lock)).toThrow(/holds .*demo\.lock: wait for it to end; if no demo step is running, remove /)
    release()
    expect(readdirSync(join(lock, '..'))).toEqual([])
    // a lock left by a step that cannot have removed it (kill -9), or anything else by that name: refused and kept, never
    // taken over (Codex P r3–r5: each takeover had a way round it); the owner removes it, as the refusal says
    for (const left of ['the demo export (process 999999, mark 0)\n', '{"pid":', 'null', '']) {
      writeFileSync(lock, left)
      expect(() => holdLock('the demo pack', lock), left).toThrow(/if no demo step is running, remove /)
      expect(readFileSync(lock, 'utf8')).toBe(left)
    }
    // an empty one (a step that has created it and not yet written it) is named as a demo step
    expect(() => holdLock('the demo pack', lock)).toThrow(/^a demo step holds /)
    // a name that is taken by a link to nothing: refused, the link kept
    rmSync(lock)
    symlinkSync(join(lock, '..', 'nowhere'), lock)
    expect(() => holdLock('the demo pack', lock)).toThrow(/holds .*remove /)
    expect(lstatSync(lock).isSymbolicLink()).toBe(true)
    rmSync(lock)
    // released only while still its own: a lock removed by hand and taken since by another step stays
    const mine = holdLock('the demo pack', lock)
    writeFileSync(lock, 'the demo export (process 1, mark 1)\n')
    mine()
    expect(readFileSync(lock, 'utf8')).toBe('the demo export (process 1, mark 1)\n')
    rmSync(lock)
  })

  it('TC-DEMO-12 steps started at the same moment: exactly one holds the lock, none when one was left behind; Ctrl-C or a kill lets it go', async () => {
    const lockTs = join(import.meta.dirname, 'lock.ts')
    const child = (lock: string, start: number) =>
      new Promise<string>((done) => {
        const code = `import { holdLock } from ${JSON.stringify(lockTs)}
while (Date.now() < ${start});
try { holdLock('step ' + process.pid, ${JSON.stringify(lock)}); console.log('held'); setTimeout(() => {}, 1500) } catch (e) { console.log('refused') }`
        execFile(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], (_e, out) => done(out.trim()))
      })
    for (const left of [null, 'the demo export (process 999999, mark 0)\n']) {
      const lock = join(folder(), 'demo.lock')
      if (left) writeFileSync(lock, left)
      const start = Date.now() + 1500
      const said = await Promise.all(Array.from({ length: 6 }, () => child(lock, start)))
      // with none: one holds it and lets it go; with one left behind: all are refused and it stays
      expect(said.filter((s) => s === 'held'), String(left)).toHaveLength(left ? 0 : 1)
      expect(said.filter((s) => s === 'refused')).toHaveLength(left ? 6 : 5)
      expect(readdirSync(join(lock, '..')), String(left)).toEqual(left ? ['demo.lock'] : [])
    }
    // a step stopped by Ctrl-C (no handler of its own) lets the lock go
    const lock = join(folder(), 'demo.lock')
    const code = `import { holdLock } from ${JSON.stringify(lockTs)}
holdLock('the demo build', ${JSON.stringify(lock)}); console.log('held'); setTimeout(() => {}, 20000)`
    const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code])
    await new Promise<void>((ok) => p.stdout.on('data', () => ok()))
    expect(existsSync(lock)).toBe(true)
    const ended2 = new Promise<number | null>((ok) => p.on('exit', (c) => ok(c)))
    p.kill('SIGINT')
    expect(await ended2).toBe(130)
    expect(existsSync(lock)).toBe(false)
    // a kill: its own code, 143, and what the step undoes on 'exit' runs too (Codex P r4 #2: the export's container)
    const undone = join(folder(), 'undone')
    const code3 = `import { writeFileSync } from 'node:fs'
import { holdLock } from ${JSON.stringify(lockTs)}
holdLock('the demo export', ${JSON.stringify(lock)}); process.once('exit', () => writeFileSync(${JSON.stringify(undone)}, 'x')); console.log('held'); setTimeout(() => {}, 20000)`
    const q = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code3])
    await new Promise<void>((ok) => q.stdout.on('data', () => ok()))
    const ended3 = new Promise<number | null>((ok) => q.on('exit', (c) => ok(c)))
    q.kill('SIGTERM')
    expect(await ended3).toBe(143)
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(undone)).toBe(true)
  }, 30_000)

  it('TC-DEMO-12 a secret, a kind of file the scan cannot read or a link instead of a file: the archive is deleted, no .sha256', async () => {
    const cases: Array<[string, (from: string) => void, string]> = [
      ['a token', (f) => writeFileSync(join(f, 'data/e.json'), '{"invite_token":"Ab3_dE5-gH7iJ9kLmN0pQrStUvWxYz12"}'), 'data/e.json: a "invite_token" value'],
      ['a .bin', (f) => writeFileSync(join(f, 'data/x.bin'), 'x'), 'data/x.bin: a kind of file the scan cannot read'],
      ['a link', (f) => symlinkSync('../index.html', join(f, 'data/y.html')), 'data/y.html: not a plain file'],
    ]
    for (const [what, plant, says] of cases) {
      const from = build()
      plant(from)
      const out = folder()
      await expect(packDir({ from, out, version: '9.9.9', commit, rules }), what).rejects.toThrow(says)
      expect(readdirSync(out), what).toEqual([])
    }
  })
})

describe('demo pack: only output of the committed code is packed (scripts/demo-export/source.ts)', () => {
  it('TC-DEMO-12 the export and the build must both have run on this commit with no changes, or the pack is refused', () => {
    const d = mkdtempSync(join(tmpdir(), 'bulma-source-test-'))
    try {
      const head = 'b'.repeat(40)
      const f = join(d, 'x.json')
      expect(sourceProblem('the build', f, head)).toMatch(/^the build: no note of the code it ran on/)
      noteSource(f, { commit: head, clean: true })
      expect(sourceProblem('the build', f, head)).toBeNull()
      expect(sourceProblem('the build', f, 'c'.repeat(40))).toBe('the build ran at bbbbbbb, not at ccccccc: run it again')
      noteSource(f, { commit: head, clean: false })
      expect(sourceProblem('the export', f, head)).toBe('the export ran on app code with changes not committed: commit, then run it again')
      // what is noted: this worktree's HEAD, and clean only when the app code has no change
      expect(sourceState().commit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
      expect(sourceState().clean).toBe(
        !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...BUILT_FROM], { encoding: 'utf8' }).trim() &&
          !execFileSync('git', ['ls-files', '--others', '--', ...BUILT_FROM], { encoding: 'utf8' }).trim(),
      )
      // the private name list's loader, which the pack imports (Codex P r3 #6)
      expect(BUILT_FROM).toContain('scripts/check-identity.mjs')
      // what reaches the pack besides the code is part of it (Codex P r1 #14)
      for (const p of ['packs', 'assets', 'package.json', 'package-lock.json', 'tsconfig.json']) expect(BUILT_FROM).toContain(p)
      // a commit named for a release: this one, or one with the same app code; not one this repository lacks (Codex P r1 #17)
      expect(BUILT_FROM).toContain('scripts/demo-pack.ts')
      // in a repository of its own (any checkout, one commit or many; Codex P r2 #13): commits with the same app code, with
      // other app code, with only the pack writer changed (Codex P r2 #6)
      const r = join(d, 'repo')
      mkdirSync(join(r, 'src'), { recursive: true })
      mkdirSync(join(r, 'scripts'))
      const g = (...a: string[]) => execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@x.invalid', ...a], { encoding: 'utf8' }).trim()
      g('init', '-q')
      const commitWith = (file: string, text: string) => {
        writeFileSync(join(r, file), text)
        g('add', '-A')
        g('commit', '-qm', file)
        return g('rev-parse', 'HEAD')
      }
      const c1 = commitWith('src/a.ts', '1')
      const c2 = commitWith('README.md', 'docs only')
      const c3 = commitWith('scripts/demo-pack.ts', 'x')
      const c4 = commitWith('src/a.ts', '2')
      expect(commitProblem(c2, c2, r)).toBeNull()
      expect(commitProblem(c1, c2, r)).toBeNull()
      expect(commitProblem(c2, c3, r)).toBe(`commit ${c2.slice(0, 7)} has other app code than ${c3.slice(0, 7)}`)
      expect(commitProblem(c3, c4, r)).toBe(`commit ${c3.slice(0, 7)} has other app code than ${c4.slice(0, 7)}`)
      expect(commitProblem('0'.repeat(40), c4, r)).toBe('commit 0000000 is not in this repository: fetch the public repository first')
      // a file git ignores where the build reads (Vite copies src/web/public/ whole, ignored or not) is a change too, though
      // git status says nothing (Codex P r2 #6)
      writeFileSync(join(r, '.gitignore'), '*.local\n')
      g('add', '-A')
      g('commit', '-qm', 'ignore')
      expect(sourceState(r)).toEqual({ commit: g('rev-parse', 'HEAD'), clean: true })
      writeFileSync(join(r, 'src/public-x.local'), 'x')
      expect(g('status', '--porcelain')).toBe('')
      expect(sourceState(r).clean).toBe(false)
      rmSync(join(r, 'src/public-x.local'))
      writeFileSync(join(r, 'notes.local'), 'x')
      expect(sourceState(r).clean).toBe(true)
      // a new file git does not ignore, with git told not to show such files (Codex P r3 #6); and against an older commit, as
      // the demo's server asks
      g('config', 'status.showUntrackedFiles', 'no')
      writeFileSync(join(r, 'src/guide.txt'), 'x')
      expect(g('status', '--porcelain')).toBe('')
      expect(sourceState(r).clean).toBe(false)
      expect(codeDiffers(g('rev-parse', 'HEAD'), r)).toBe(true)
      rmSync(join(r, 'src/guide.txt'))
      expect(codeDiffers(g('rev-parse', 'HEAD'), r)).toBe(false)
      expect(codeDiffers(c3, r)).toBe(true)
      expect(codeDiffers('0'.repeat(40), r)).toBe(true)
      // a change staged and then undone in the file: the next commit would carry it, so not clean; the server, which
      // compares the files, still finds them as committed (Codex P r4 #6)
      writeFileSync(join(r, 'src/a.ts'), '3')
      g('add', 'src/a.ts')
      writeFileSync(join(r, 'src/a.ts'), '2')
      expect(g('status', '--porcelain', '--', 'src/a.ts')).toBe('MM src/a.ts')
      expect(sourceState(r).clean).toBe(false)
      expect(codeDiffers(g('rev-parse', 'HEAD'), r)).toBe(false)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('demo export: the database clock (scripts/demo-export/clock.ts; Codex P r1 #8)', () => {
  it('TC-DEMO-09 the offset file always has a sign, so libfaketime reads a forward move as one', () => {
    expect([86_400, 0, -2_000_000].map(offsetText)).toEqual(['+86400', '+0', '-2000000'])
  })

  it('TC-DEMO-09 the database clock is held against the time before and after the query, so a slow docker call is no mismatch (Codex P r2 #9)', () => {
    const t = Date.parse('2026-11-02T10:00:00Z')
    expect(clockProblem(t + 3000, t, t + 4000)).toBeNull()
    expect(clockProblem(t - 900, t, t + 10)).toBeNull()
    expect(clockProblem(t - 1500, t, t + 10)).toMatch(/^the export database's clock reads 2026-11-02T09:59:58\.500Z, not between/)
    expect(clockProblem(t + 6000, t, t + 4000)).toMatch(/not between/)
    expect(clockProblem(Number.NaN, t, t)).toMatch(/reads NaN/)
  })
})
