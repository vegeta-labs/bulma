// Generated documents (payment instructions, deal sheets; PRD R-PAY-03, R-SIG-02), drawn with the fonts of decision R27.
// The first block can be a boxed bold warning, so nothing comes before it (§5.5).
import { PDFDocument, rgb } from 'pdf-lib'
import { fontKit } from './pdfFonts.ts'

export interface PdfBlock {
  text: string
  bold?: boolean
  /** A black border around the block (§5.5 warning). */
  boxed?: boolean
  size?: number
}

const PAGE: [number, number] = [595, 842]
const MARGIN = 50
const LINE = 1.35
const BLACK = rgb(0, 0, 0)
const MISSING = 'Some characters in this document cannot be drawn in a PDF and are shown as "?". The text kept on the site is the record.'

/** The most text one generated PDF draws; callers check their own limits first, this is the last stop (Codex round 9). */
export const PDF_MAX_CHARS = 500_000

export async function renderPdf(input: readonly PdfBlock[], title: string): Promise<Buffer> {
  if (input.reduce((n, b) => n + b.text.length, 0) > PDF_MAX_CHARS) throw new Error('too much text for one PDF')
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setTitle(title)
  doc.setProducer('Bulma')
  const kit = await fontKit(doc, [...input, { text: MISSING, bold: true }])
  // a character the fonts cannot draw is never silently replaced: the document says that the site's text is the record
  const blocks = kit.missing ? [...input, { text: MISSING, bold: true }] : input
  let page = doc.addPage(PAGE)
  let y = PAGE[1] - MARGIN
  const newPage = () => {
    page = doc.addPage(PAGE)
    y = PAGE[1] - MARGIN
  }
  for (const b of blocks) {
    const size = b.size ?? 10
    const bold = !!b.bold
    const pad = b.boxed ? 8 : 0
    const lines = kit.wrap(b.text, bold, size, PAGE[0] - 2 * MARGIN - 2 * pad)
    const height = lines.length * size * LINE + 2 * pad
    if (y - height < MARGIN && y < PAGE[1] - MARGIN) newPage()
    // a boxed block that runs onto the next page gets a border on every page it is on, around its part there
    let top = y
    const border = (bottom: number) =>
      b.boxed && page.drawRectangle({ x: MARGIN, y: bottom, width: PAGE[0] - 2 * MARGIN, height: top - bottom, borderColor: BLACK, borderWidth: 1 })
    y -= pad
    for (const l of lines) {
      if (y - size * LINE < MARGIN) {
        border(y - pad)
        newPage()
        top = y
        y -= pad
      }
      y -= size * LINE
      kit.draw(page, l, { x: MARGIN + pad, y, size, bold, color: BLACK })
    }
    y -= pad
    border(y)
    y -= size * 0.8
  }
  return Buffer.from(await doc.save())
}
