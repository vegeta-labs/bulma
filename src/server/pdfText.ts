// For tests and the demo pack's scan only: the text lines a PDF draws, read by pdf.js (Mozilla's reader, `pdfjs-dist`, a dev
// dependency; Codex P r6 #1: our own reader of content streams missed text drawn in ways it did not know, round after round).
// pdf.js reads every text operator, Form XObjects and each run's full transform; grouping its runs into lines stays ours.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** A line of text and the font size its first run is drawn at. */
export interface PdfLine {
  text: string
  size: number
}

/** A run of text as pdf.js gives it: the string and its transform (a, b, c, d, x, y) on the page. */
interface Run {
  str: string
  transform: number[]
}

/**
 * The lines of text, page by page, in the order drawn, with their sizes. A run more than 3 points above or below its line's
 * first run starts a line of its own, so a combining mark drawn a little above or below its base stays on its line; the
 * line's size is its first run's height on the page (its transform's vertical scale), rounded to 1/100 point.
 */
export async function pdfLines(pdf: Buffer | Uint8Array): Promise<PdfLine[]> {
  // pdf.js takes ownership of the bytes it is given, so it gets a copy. Its default recovery is kept: with stopAtErrors, text
  // drawn in a font it cannot load is dropped without an error, where by default it is read with a stand-in font
  const task = getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  try {
    const doc = await task.promise
    const out: PdfLine[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      // the height of the line being read; none at the top of a page, so its first words always start a line (Codex P r3 #4)
      let line: number | null = null
      for (const item of (await page.getTextContent()).items) {
        if (!('str' in item) || item.str === '') continue
        const run = item as Run
        const y = run.transform[5]!
        if (line === null || Math.abs(y - line) > 3) {
          out.push({ text: '', size: Math.round(Math.hypot(run.transform[2]!, run.transform[3]!) * 100) / 100 })
          line = y
        }
        out[out.length - 1]!.text += run.str
      }
    }
    return out
  } finally {
    await task.destroy()
  }
}

/** The lines of text, page by page, in the order drawn (pdfLines without the sizes). */
export async function pdfText(pdf: Buffer | Uint8Array): Promise<string[]> {
  return (await pdfLines(pdf)).map((l) => l.text)
}
