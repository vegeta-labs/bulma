// Decision R26, PRD §5.5: a third-party PDF is served with a warning cover page in front of it. Nothing comes before the
// warning, and nothing on the cover but the warning and the operator's sender line.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, rgb } from 'pdf-lib'
import { LEGAL_LIMIT_BYTES } from '../lib/dealFiles.ts'
import { fontKit } from './pdfFonts.ts'

const PAGE: [number, number] = [595, 842]
const MARGIN = 50
const SIZE = 11
const LEADING = 15

const MISSING = 'Some characters of this warning cannot be drawn in a PDF and are shown as "?". The warning on the site is the record.'

/** Returns the PDF with the cover in front, or null when the file cannot be read as a PDF (it is then not served). */
export async function withWarningCover(original: Buffer, warning: string, title: string): Promise<Buffer | null> {
  try {
    return await build(original, warning, title)
  } catch {
    // a file pdf-lib cannot read or rewrite, wherever it fails: never served without its warning
    return null
  }
}

/** Limits on what is rewritten in the server process: a hostile file must not hold it (Codex round 2). */
// the same size a legal file may be uploaded at, so an agreement that was accepted can always be served (Codex round 4)
export const COVER_LIMITS = { bytes: LEGAL_LIMIT_BYTES, pages: 2_000, objects: 100_000, decodedPerStream: 32 * 1024 * 1024, decodedTotal: 128 * 1024 * 1024 }

/**
 * Bounded unpacking (Codex rounds 4 to 7). Loading a PDF unpacks its object streams and cross-reference streams; page contents
 * and images are copied as they are. Finding those streams in the file's text, as rounds 4 to 6 did, misses what the parser
 * still accepts (escaped names, other line endings after `stream`, a /Length past a decoy `endstream`). So the cap is put where
 * the parser itself unpacks: every buffer pdf-lib's decoders grow during our load is counted, whatever the filters or chain,
 * and the cross-reference parser may not make more entries than the cap or read fields wider than eight bytes. Outside a
 * load made here nothing is counted. pdf-lib is pinned to 1.17.1; the check below refuses to start if the parser we patch is not
 * the one we load.
 */
const pdfInternals = createRequire(import.meta.url)
// the parser skips an object whose parsing throws, so a tripped cap is also noted here and the whole file refused after loading
const budget = new AsyncLocalStorage<{ total: number; refused: string | null }>()
const refuse = (b: { refused: string | null }, why: string): never => {
  b.refused ??= why
  throw new Error(why)
}
const DecodeStream = pdfInternals('pdf-lib/cjs/core/streams/DecodeStream.js').default as {
  prototype: { ensureBuffer(this: { buffer: Uint8Array; minBufferLength: number }, requested: number): Uint8Array }
}
const XRefStreamParser = pdfInternals('pdf-lib/cjs/core/parser/PDFXRefStreamParser.js').default as {
  prototype: { parseEntries(this: { subsections: Array<{ length: number }>; byteWidths: number[] }): unknown }
}
if ((pdfInternals('pdf-lib') as { PDFDocument: unknown }).PDFDocument !== PDFDocument)
  throw new Error('pdf-lib is loaded twice: the unpacking cap would not apply')

const grow = DecodeStream.prototype.ensureBuffer
DecodeStream.prototype.ensureBuffer = function (requested) {
  const b = budget.getStore()
  if (b && requested > this.buffer.byteLength) {
    if (requested > COVER_LIMITS.decodedPerStream) refuse(b, 'a part unpacks too large')
    let size = this.minBufferLength
    while (size < requested) size *= 2
    b.total += size - this.buffer.byteLength
    if (b.total > COVER_LIMITS.decodedTotal) refuse(b, 'the parts unpack too large')
  }
  return grow.call(this, requested)
}

const entries = XRefStreamParser.prototype.parseEntries
XRefStreamParser.prototype.parseEntries = function () {
  const b = budget.getStore()
  if (b) {
    // the parser makes one entry per number in /Size or /Index, whatever the data holds
    // each count on its own: a negative count is skipped by the parser, so it must not offset a large one in a sum
    let n = 0
    for (const s of this.subsections) {
      if (!(Number.isSafeInteger(s.length) && s.length >= 0)) refuse(b, 'a cross-reference count is not a whole number')
      n += s.length
      if (n > COVER_LIMITS.objects) refuse(b, 'too many objects')
    }
    if (!this.byteWidths.every((w) => w >= -1 && w <= 8)) refuse(b, 'a cross-reference field too wide')
  }
  return entries.call(this)
}

function walkPageTree(doc: PDFDocument) {
  const seen = new Set<string>()
  let pages = 0
  const visit = (ref: PDFRef) => {
    const key = ref.toString()
    if (seen.has(key)) throw new Error('a page tree node is reached twice')
    seen.add(key)
    if (seen.size > COVER_LIMITS.objects) throw new Error('too many page tree nodes')
    const node = doc.context.lookup(ref)
    if (!(node instanceof PDFDict)) throw new Error('not a page tree node')
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray)
    if (!kids) {
      if (++pages > COVER_LIMITS.pages) throw new Error('too many pages')
      return
    }
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.get(i)
      if (!(kid instanceof PDFRef)) throw new Error('a page tree kid is not a reference')
      visit(kid)
    }
  }
  const root = doc.catalog.get(PDFName.of('Pages'))
  if (!(root instanceof PDFRef)) throw new Error('no page tree')
  visit(root)
}

// Counts `n g R` references, stopping once past `limit`. A match starts only where a number starts (the lookbehind),
// so a long run of digits or spaces is passed over once: linear in the file. The plain pattern backtracked over every
// start inside a digit run and took 25 minutes on 2 MB of digits (Codex round 9).
export function countReferences(raw: string, limit: number): number {
  let n = 0
  for (const _ of raw.matchAll(/(?<!\d)\d+\s+\d+\s+R\b/g)) if (++n > limit) break
  return n
}

async function build(original: Buffer, warning: string, title: string): Promise<Buffer> {
  if (original.length > COVER_LIMITS.bytes) throw new Error('too large')
  // a page tree can name one page a hundred thousand times in a small file: count references before reading the tree
  if (countReferences(original.toString('latin1'), COVER_LIMITS.objects) > COVER_LIMITS.objects) throw new Error('too many references')
  const b = { total: 0, refused: null as string | null }
  const source = await budget.run(b, () => PDFDocument.load(original, { updateMetadata: false }))
  if (b.refused) throw new Error(b.refused)
  if (source.context.enumerateIndirectObjects().length > COVER_LIMITS.objects) throw new Error('too many objects')
  // the page tree walked once, each node at most once: a node reached twice (a repeated subtree or a cycle) is refused,
  // so the work grows with the file, never with what the tree claims to expand to (Codex round 3)
  walkPageTree(source)
  if (source.getPageCount() > COVER_LIMITS.pages) throw new Error('too many pages')
  // no library name, link or build time in the file's details, as renderPdf (pdf.ts); only the title and Bulma
  const out = await PDFDocument.create({ updateMetadata: false })
  out.setTitle(title)
  out.setProducer('Bulma')
  // the warning in the fonts of decision R27, so a Chinese or Polish warning is drawn as written
  const kit = await fontKit(out, [
    { text: warning, bold: true },
    { text: MISSING, bold: true },
  ])
  const width = PAGE[0] - 2 * MARGIN - 20
  const lines = kit.wrap(warning, true, SIZE, width)
  if (kit.missing) lines.push('', ...kit.wrap(MISSING, true, SIZE, width))
  // as many cover pages as the words need: a long warning is never cut off (§5.5)
  const perPage = Math.floor((PAGE[1] - 2 * MARGIN - 20) / LEADING)
  for (let at = 0; at < lines.length; at += perPage) {
    const chunk = lines.slice(at, at + perPage)
    const cover = out.addPage(PAGE)
    const top = PAGE[1] - MARGIN
    const height = chunk.length * LEADING + 20
    // black on white with a black border, whatever the reader's theme (§5.5)
    cover.drawRectangle({ x: MARGIN, y: top - height, width: PAGE[0] - 2 * MARGIN, height, borderColor: rgb(0, 0, 0), borderWidth: 1.5, color: rgb(1, 1, 1) })
    chunk.forEach((l, i) => kit.draw(cover, l, { x: MARGIN + 10, y: top - 10 - (i + 1) * LEADING + 4, size: SIZE, bold: true, color: rgb(0, 0, 0) }))
  }
  const pages = await out.copyPages(source, source.getPageIndices())
  for (const p of pages) out.addPage(p)
  return Buffer.from(await out.save())
}
