import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { PDF_MAX_CHARS, renderPdf } from './pdf.ts'
import { fontKit } from './pdfFonts.ts'
import { pdfText } from './pdfText.ts'

describe('generated PDFs (decision R27)', () => {
  it('TC-PAY-02 / TC-SIG-03 names in Latin, Polish, Greek, Cyrillic and Chinese are drawn as written, with nothing flagged', async () => {
    const name = 'José García, Société Œuvre, Straße, Łukasz Żółć, Ελένη, Пётр, 张伟（北京）'
    const text = await pdfText(await renderPdf([{ text: 'Warning', bold: true, boxed: true }, { text: `Investor: ${name}` }], 't'))
    expect(text).toEqual(['Warning', `Investor: ${name}`])
  })

  it('TC-PAY-02 / TC-SIG-03 a character neither font has is shown as "?" and the document says so', async () => {
    const text = await pdfText(await renderPdf([{ text: 'Investor: Ann \u{1F600}' }], 't'))
    expect(text[0]).toBe('Investor: Ann ?')
    expect(text.join(' ')).toContain('cannot be drawn')
  })

  it('TC-PAY-02 long text wraps inside the margins, Chinese without spaces too, and runs onto more pages', async () => {
    const zh = '投资'.repeat(200)
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ')
    const pdf = await renderPdf([{ text: zh }, { text: words }], 't')
    const text = await pdfText(pdf)
    expect(text.join('')).toContain(zh)
    expect(text.join(' ')).toContain(words)
    expect(text.length).toBeGreaterThan(20)
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1)
  })

  it('TC-PAY-02 only the characters used are embedded: a Chinese document stays small', async () => {
    const pdf = await renderPdf([{ text: '风险警告：您可能损失全部投资。', bold: true, boxed: true }, { text: '张伟 £10,000' }], 't')
    expect(pdf.length).toBeLessThan(100_000)
  })
})

describe('fonts (decision R27)', () => {
  // the x of each text drawn on the first page, with the hex of its glyphs
  const shows = async (pdf: Uint8Array) => {
    const doc = await PDFDocument.load(pdf)
    const contents = doc.getPages()[0]!.node.Contents()!
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents]
    const ops = streams.map((s) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString('latin1')).join('\n')
    return [...ops.matchAll(/[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ ([\d.-]+) ([\d.-]+) Tm\s+<([0-9A-Fa-f]*)> Tj/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
      hex: m[3]!,
    }))
  }

  it('TC-PAY-02 invisible and separator characters neither break the document nor turn into spaces (Codex round 9)', async () => {
    const text = await pdfText(await renderPdf([{ text: 'No\u200brefund \ufeffZo\u00ade a\u200db\u2028next\u2029last\u0085end' }], 't'))
    expect(text).toEqual(['Norefund Zoe ab', 'next', 'last', 'end'])
  })

  it('TC-PAY-02 a direction control is shown as "?" with the note, as the site may show the text in another order', async () => {
    const text = await pdfText(await renderPdf([{ text: 'Fee 2\u202e% x' }], 't'))
    expect(text[0]).toBe('Fee 2?% x')
    expect(text.join(' ')).toContain('cannot be drawn')
  })

  it('TC-PAY-02 a decomposed accent is drawn as the one composed character (NFC)', async () => {
    const pdf = await renderPdf([{ text: 'Wi\u0301told Jose\u0301' }], 't')
    expect(await pdfText(pdf)).toEqual(['Witold José'.replace('Wi', 'Wí')])
    expect((await shows(pdf)).length).toBe(1)
  })

  it('TC-PAY-02 a mark with no composed form is drawn at the offset the font gives it, not at the pen (Codex round 9)', async () => {
    const pdf = await renderPdf([{ text: 'q\u0301x Ade\u0323\u0301n' }], 't')
    expect(await pdfText(pdf)).toEqual(['q\u0301x Ade\u0323\u0301n'.normalize('NFC')])
    // drawn: q, its acute, x, space, A, d, ẹ (NFC composes e and the dot below), its acute, n
    const [q, acute, x, , , , e, acute2, n] = await shows(pdf)
    // the font moves each acute back over its base: right of where the base starts, left of where the pen stands after it
    expect(acute!.x).toBeGreaterThan(q!.x)
    expect(acute!.x).toBeLessThan(x!.x)
    expect(acute2!.x).toBeGreaterThan(e!.x)
    expect(acute2!.x).toBeLessThan(n!.x)
    // over a capital the font raises the acute; over q it does not
    const [B, high] = await shows(await renderPdf([{ text: 'B\u0301' }], 't'))
    expect(high!.y).toBeGreaterThan(B!.y)
    expect(acute!.y).toBe(q!.y)
  })

  it('TC-PAY-02 a word wider than the page is broken, not run past the margin', async () => {
    const text = await pdfText(await renderPdf([{ text: 'x'.repeat(500) }], 't'))
    expect(text.join('')).toBe('x'.repeat(500))
    expect(text.length).toBeGreaterThan(3)
  })

  it('TC-PAY-02 ligature letters are drawn one glyph each: they read back as written and every glyph drawn has a width', async () => {
    const pdf = await renderPdf([{ text: 'office affinity ffi fi fl Ŀl' }, { text: 'fi '.repeat(50).trim(), bold: true }], 't')
    const text = await pdfText(pdf)
    expect(text[0]).toBe('office affinity ffi fi fl Ŀl')
    expect(text.slice(1).join(' ')).toBe('fi '.repeat(50).trim())
    // without a width the viewer uses the default, and the line is wider than it was measured
    const doc = await PDFDocument.load(pdf)
    for (const page of doc.getPages()) {
      const fonts = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
      const covered = new Map<string, Set<number>>()
      for (const [name, ref] of fonts.entries()) {
        const cid = (doc.context.lookup(ref as PDFRef) as PDFDict).lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict)
        const w = cid.lookup(PDFName.of('W'), PDFArray).asArray()
        const ids = new Set<number>()
        for (let i = 0; i < w.length; i += 2) {
          const first = (w[i] as PDFNumber).asNumber()
          ;(w[i + 1] as PDFArray).asArray().forEach((_, k) => ids.add(first + k))
        }
        covered.set(name.asString().slice(1), ids)
      }
      const contents = page.node.Contents()
      const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents]
      const ops = streams.map((st) => Buffer.from(decodePDFRawStream(st as PDFRawStream).decode()).toString('latin1')).join('\n')
      let font = ''
      let drawn = 0
      for (const m of ops.matchAll(/\/(\S+) [\d.]+ Tf|<([0-9A-Fa-f]*)> Tj/g)) {
        if (m[1]) font = m[1]
        else
          for (const hex of m[2]!.match(/.{4}/g) ?? []) {
            drawn++
            expect(covered.get(font)!.has(parseInt(hex, 16))).toBe(true)
          }
      }
      expect(drawn).toBeGreaterThan(0)
    }
  })

  it('TC-PAY-02 a line break is not a character the fonts lack: no "?" note', async () => {
    const text = await pdfText(await renderPdf([{ text: 'First line\nSecond line\r\nThird' }], 't'))
    expect(text).toEqual(['First line', 'Second line', 'Third'])
  })

  it('TC-PAY-02 a very long unbroken word is wrapped in time that grows with its length only', async () => {
    const started = Date.now()
    const text = await pdfText(await renderPdf([{ text: 'x'.repeat(100_000) }], 't'))
    expect(text.join('')).toBe('x'.repeat(100_000))
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('TC-GATE-05 a boxed warning that runs onto a second page has its border on both pages', async () => {
    const warning = Array.from({ length: 60 }, (_, i) => `Warning line ${i + 1}`).join('\n')
    const doc = await PDFDocument.load(await renderPdf([{ text: warning, bold: true, boxed: true }], 't'))
    const pages = doc.getPages()
    expect(pages.length).toBe(2)
    for (const page of pages) {
      const contents = page.node.Contents()
      const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents]
      const ops = streams.map((st) => Buffer.from(decodePDFRawStream(st as PDFRawStream).decode()).toString('latin1')).join('\n')
      // pdf-lib draws a rectangle as a path of four lines closed and stroked
      expect(ops.match(/\bS\b/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    }
  })

  it('TC-GATE-05 bold text is drawn in the bold weight', async () => {
    const { fontKit } = await import('./pdfFonts.ts')
    const kit = await fontKit(await PDFDocument.create(), [
      { text: 'Warning 警告', bold: true },
      { text: 'Warning 警告', bold: false },
    ])
    expect(kit.width('Warning', true, 10)).toBeGreaterThan(kit.width('Warning', false, 10))
  })
})

it('TC-PAY-02 a PDF with more text than PDF_MAX_CHARS is refused before any font work (Codex round 9)', async () => {
  await expect(renderPdf([{ text: 'x'.repeat(PDF_MAX_CHARS) }, { text: 'y' }], 't')).rejects.toThrow('too much text')
  expect((await pdfText(await renderPdf([{ text: 'ok' }], 't')))[0]).toBe('ok')
})

it('TC-PAY-02 a mark no font has is drawn as "?" and wraps like any character, inside the line (Codex round 10)', async () => {
  const text = 'A'.repeat(77) + '\u064b'.repeat(20) + 'B'
  const kit = await fontKit(await PDFDocument.create(), [{ text }])
  const lines = kit.wrap(text, false, 10, 495)
  expect(lines.length).toBeGreaterThan(1)
  for (const l of lines) expect(kit.width(l, false, 10)).toBeLessThanOrEqual(495)
  // nothing lost: the lines hold the text; drawing shows each mark as "?"
  expect(lines.join('')).toBe(text)
})

it('TC-PAY-02 a mark a font draws with a width wraps like any character, inside the line (Codex round 11)', async () => {
  // U+302E: only the SC font has it, and it takes room
  const text = 'A'.repeat(77) + '\u302e'.repeat(20) + 'B'
  const kit = await fontKit(await PDFDocument.create(), [{ text }])
  const lines = kit.wrap(text, false, 10, 495)
  expect(lines.length).toBeGreaterThan(1)
  for (const l of lines) expect(kit.width(l, false, 10)).toBeLessThanOrEqual(495)
  expect(lines.join('')).toBe(text)
})
