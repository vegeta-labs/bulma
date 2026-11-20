// For tests only: the text lines a PDF made by pdf-lib draws, read back through each font's ToUnicode map.
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib'

const raw = (s: unknown) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString('latin1')
const utf16 = (hex: string) => Buffer.from(hex, 'hex').swap16().toString('utf16le')

function toUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(m[1]!.toUpperCase(), utf16(m[2]!))
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const [lo, hi, first] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
      for (let c = lo; c <= hi; c++) map.set(c.toString(16).toUpperCase().padStart(m[1]!.length, '0'), String.fromCodePoint(first + c - lo))
    }
  return map
}

/** The lines of text, page by page, top to bottom as drawn; runs within 3 points of the same height make one line. */
export async function pdfText(pdf: Buffer | Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf)
  const out: string[] = []
  for (const page of doc.getPages()) {
    const fonts = new Map<string, Map<string, string>>()
    const dict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)
    for (const [name, ref] of dict?.entries() ?? []) {
      const font = doc.context.lookup(ref as PDFRef) as PDFDict
      const tu = font.lookup(PDFName.of('ToUnicode'))
      fonts.set(name.asString().slice(1), tu instanceof PDFRawStream ? toUnicode(raw(tu)) : new Map())
    }
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : contents ? [contents] : []
    const ops = streams.map(raw).join('\n')
    let font = new Map<string, string>()
    let y = ''
    for (const m of ops.matchAll(/\/(\S+) [\d.]+ Tf|[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ ([\d.-]+) Tm|<([0-9A-Fa-f]*)> Tj/g)) {
      if (m[1]) font = fonts.get(m[1]) ?? new Map()
      else if (m[2]) {
        // a combining mark is drawn a little above or below its base: same line unless the height moves by a line's worth
        if (y === '' || Math.abs(Number(m[2]) - Number(y)) > 3) out.push('')
        y = m[2]
      } else {
        const hex = m[3]!.toUpperCase()
        let s = ''
        for (let i = 0; i < hex.length; i += 4) s += font.get(hex.slice(i, i + 4)) ?? '�'
        out[out.length - 1] += s
      }
    }
    y = ''
  }
  return out
}
