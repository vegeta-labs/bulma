// Decision R27: generated PDFs and the warning cover draw text with Noto Sans (Latin, Greek, Cyrillic) and Noto Sans SC
// (Chinese), so a name or a warning is drawn as written. Each character uses Noto Sans when it has the glyph, else Noto Sans SC.
// pdf-lib's own subsetting breaks the CJK font, and the whole font is 8 to 15 MB per file, so each document's characters are
// cut from the fonts with HarfBuzz (weight pinned to 400 or 700) and embedded as they are. Fonts and licence: assets/fonts.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import fontkit from '@pdf-lib/fontkit'
import type { PDFDocument, PDFFont, PDFPage, RGB } from 'pdf-lib'

const DIR = new URL('../../assets/fonts/', import.meta.url)
const WDTH = 0x77647468 // 'wdth'
const WGHT = 0x77676874 // 'wght'
const GSUB = 0x47535542 // 'GSUB'
const DROP_TABLES = 3 // HB_SUBSET_SETS_DROP_TABLE_TAG

interface Hb {
  memory: WebAssembly.Memory
  malloc(n: number): number
  free(p: number): void
  hb_blob_create(p: number, n: number, mode: number, u: number, d: number): number
  hb_blob_destroy(b: number): void
  hb_blob_get_data(b: number, len: number): number
  hb_blob_get_length(b: number): number
  hb_face_create(b: number, i: number): number
  hb_face_destroy(f: number): void
  hb_face_reference_blob(f: number): number
  hb_set_add(s: number, c: number): void
  hb_subset_input_create_or_fail(): number
  hb_subset_input_destroy(i: number): void
  hb_subset_input_unicode_set(i: number): number
  hb_subset_input_set(i: number, which: number): number
  hb_subset_input_pin_axis_location(i: number, f: number, tag: number, v: number): number
  hb_subset_or_fail(f: number, i: number): number
}

interface Source {
  face: number
  has(cp: number): boolean
  axes: number[] // pinned besides the weight
}

let loaded: { hb: Hb; latin: Source; sc: Source } | null = null

function load() {
  if (loaded) return loaded
  const wasm = readFileSync(createRequire(import.meta.url).resolve('harfbuzzjs/dist/harfbuzz-subset.wasm'))
  // the subsetter has no imports: it cannot reach the file system or the network
  const hb = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}).exports as unknown as Hb
  const open = (file: string, axes: number[]): Source => {
    const bytes = readFileSync(new URL(file, DIR))
    const cmap = fontkit.create(bytes) as unknown as { hasGlyphForCodePoint(cp: number): boolean }
    // the font stays in the subsetter's memory for the life of the process; the face reads it in place
    const p = hb.malloc(bytes.length)
    new Uint8Array(hb.memory.buffer).set(bytes, p)
    const blob = hb.hb_blob_create(p, bytes.length, 1, 0, 0)
    const face = hb.hb_face_create(blob, 0)
    hb.hb_blob_destroy(blob)
    return { face, has: (cp) => cmap.hasGlyphForCodePoint(cp), axes }
  }
  loaded = { hb, latin: open('NotoSans-wdth-wght.ttf', [WDTH, 100]), sc: open('NotoSansSC-wght.ttf', []) }
  return loaded
}

function subset(hb: Hb, src: Source, chars: Set<number>, weight: number): Uint8Array {
  const input = hb.hb_subset_input_create_or_fail()
  if (!input) throw new Error('font subsetting failed')
  try {
    const set = hb.hb_subset_input_unicode_set(input)
    for (const cp of chars) hb.hb_set_add(set, cp)
    // no glyph substitution: a ligature such as "ffi" would be drawn with a glyph pdf-lib gives no width and no ToUnicode entry,
    // so the text would read back wrong and be wider on the page than measured. Each character is drawn by its own glyph.
    hb.hb_set_add(hb.hb_subset_input_set(input, DROP_TABLES), GSUB)
    for (let i = 0; i < src.axes.length; i += 2)
      if (!hb.hb_subset_input_pin_axis_location(input, src.face, src.axes[i]!, src.axes[i + 1]!)) throw new Error('axis')
    if (!hb.hb_subset_input_pin_axis_location(input, src.face, WGHT, weight)) throw new Error('font weight could not be set')
    const out = hb.hb_subset_or_fail(src.face, input)
    if (!out) throw new Error('font subsetting failed')
    const blob = hb.hb_face_reference_blob(out)
    const at = hb.hb_blob_get_data(blob, 0)
    const bytes = new Uint8Array(hb.memory.buffer).slice(at, at + hb.hb_blob_get_length(blob))
    hb.hb_blob_destroy(blob)
    hb.hb_face_destroy(out)
    return bytes
  } finally {
    hb.hb_subset_input_destroy(input)
  }
}

export interface Piece {
  text: string
  bold?: boolean
}

type Which = 'latin' | 'sc'

/** Text measured and drawn in the document's fonts. */
export interface FontKit {
  /** Whether some character could not be drawn by either font and is shown as "?". */
  missing: boolean
  width(text: string, bold: boolean, size: number): number
  /** Lines no wider than `width`: breaks at spaces, between Chinese characters, and inside a word only when it does not fit alone. */
  wrap(text: string, bold: boolean, size: number, width: number): string[]
  draw(page: PDFPage, text: string, at: { x: number; y: number; size: number; bold: boolean; color: RGB }): void
}

/** Prepares the fonts for every piece of text the document will draw (call once per document, before drawing). */
export async function fontKit(doc: PDFDocument, pieces: readonly Piece[]): Promise<FontKit> {
  const f = load()
  let missing = false
  const memo = new Map<string, Which | null>()
  const pick = (ch: string): Which | null => {
    let w = memo.get(ch)
    if (w === undefined) {
      const cp = ch.codePointAt(0)!
      w = cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || BIDI.test(ch) ? null : f.latin.has(cp) ? 'latin' : f.sc.has(cp) ? 'sc' : null
      memo.set(ch, w)
    }
    return w
  }
  // what is drawn for a character: itself, or "?" when neither font has it
  const shown = (ch: string) => {
    if (pick(ch)) return ch
    missing = true
    return '?'
  }
  // a combining mark a font draws (no advance); one neither font has is drawn as "?", which has a width (Codex round 10)
  const isMark = (ch: string) => MARK.test(ch) && pick(ch) !== null
  const sets = new Map<string, Set<number>>([['latin400', new Set([0x20, 0x3f])]])
  for (const p of pieces)
    for (const ch of prepare(p.text)) {
      // a line break is layout, not a character to draw
      if (ch === '\n') continue
      const s = shown(ch)
      const key = `${pick(s)}${p.bold ? 700 : 400}`
      if (!sets.has(key)) sets.set(key, new Set([0x20]))
      sets.get(key)!.add(s.codePointAt(0)!)
    }
  const fonts = new Map<string, PDFFont>()
  // the same subset read by fontkit, for the positions of combining marks (its GPOS table)
  const faces = new Map<PDFFont, Face>()
  doc.registerFontkit(fontkit)
  for (const [key, chars] of sets) {
    const src = key.startsWith('latin') ? f.latin : f.sc
    const bytes = subset(f.hb, src, chars, Number(key.slice(-3)))
    const embedded = await doc.embedFont(bytes, { subset: false })
    fonts.set(key, embedded)
    faces.set(embedded, fontkit.create(bytes) as unknown as Face)
  }
  const font = (w: Which, bold: boolean) => fonts.get(`${w}${bold ? 700 : 400}`) ?? fonts.get(`${w}400`) ?? fonts.get('latin400')!
  // runs of characters in one font
  const runs = (text: string, bold: boolean) => {
    const out: Array<{ font: PDFFont; text: string }> = []
    for (const raw of text) {
      const ch = shown(raw)
      const ft = font(pick(ch)!, bold)
      const last = out[out.length - 1]
      if (last?.font === ft) last.text += ch
      else out.push({ font: ft, text: ch })
    }
    return out
  }
  // without substitution a glyph's advance does not depend on its neighbours, so a text's width is the sum of its characters'
  const widths = new Map<string, number>()
  const charWidth = (raw: string, bold: boolean) => {
    const key = `${bold ? 'b' : 'r'}${raw}`
    let w = widths.get(key)
    if (w === undefined) {
      const ch = shown(raw)
      w = font(pick(ch)!, bold).widthOfTextAtSize(ch, 1000) / 1000
      widths.set(key, w)
    }
    return w
  }
  // `measure` takes prepared text (see `prepare`); `width` prepares it first
  const measure = (text: string, bold: boolean, size: number) => {
    let w = 0
    for (const ch of text) w += charWidth(ch, bold)
    return w * size
  }
  const width = (text: string, bold: boolean, size: number) => measure(prepare(text), bold, size)
  const wrap = (text: string, bold: boolean, size: number, max: number) => {
    const fits = (t: string) => measure(t, bold, size) <= max
    const out: string[] = []
    for (const para of prepare(text).split('\n')) {
      // tokens: a word of Latin-font characters, or a single Chinese character; `gap` says whether a space came before it
      const tokens: Array<{ text: string; gap: boolean }> = []
      let gap = false
      for (const ch of para) {
        if (ch === ' ') {
          gap = true
          continue
        }
        const last = tokens[tokens.length - 1]
        // a combining mark stays with the character before it
        if (last && !gap && (isMark(ch) || (pick(shown(ch)) === 'latin' && pick(shown(lastChar(last.text))) === 'latin'))) last.text += ch
        else tokens.push({ text: ch, gap })
        gap = false
      }
      let line = ''
      for (const t of tokens) {
        const next = line ? `${line}${t.gap ? ' ' : ''}${t.text}` : t.text
        if (fits(next)) {
          line = next
          continue
        }
        if (line) out.push(line)
        // a word wider than the line is cut, so nothing runs past the margin or a border
        // one pass over the word, so the work grows with its length only
        let piece = ''
        let used = 0
        for (const ch of t.text) {
          const w = charWidth(ch, bold) * size
          // only a mark that takes no room may run past the line with its character; one with a width wraps like any other (Codex round 11)
          if (piece && used + w > max && !(isMark(ch) && w === 0)) {
            out.push(piece)
            piece = ''
            used = 0
          }
          piece += ch
          used += w
        }
        line = piece
      }
      out.push(line)
    }
    return out
  }
  const draw = (page: PDFPage, text: string, at: { x: number; y: number; size: number; bold: boolean; color: RGB }) => {
    let x = at.x
    for (const r of runs(prepare(text), at.bold)) {
      const opts = { y: at.y, size: at.size, font: r.font, color: at.color }
      if (!MARK.test(r.text)) {
        page.drawText(r.text, { ...opts, x })
        x += r.font.widthOfTextAtSize(r.text, at.size)
        continue
      }
      // A mark left after NFC has no precomposed form (such as "ẹ́" or "q́"). pdf-lib draws each glyph at its advance only,
      // so a mark would sit where the font's default puts it, off its base. Each mark is drawn alone at the offset the font's
      // GPOS gives it within its cluster (base plus marks); the pen still moves by the advances, as `measure` counts them.
      const face = faces.get(r.font)!
      const scale = at.size / face.unitsPerEm
      for (const cluster of r.text.match(CLUSTER)!) {
        if (cluster.length === 1 || !MARK.test(cluster)) {
          page.drawText(cluster, { ...opts, x })
          x += r.font.widthOfTextAtSize(cluster, at.size)
          continue
        }
        const laid = face.layout(cluster)
        let pen = 0
        laid.glyphs.forEach((g, i) => {
          const p = laid.positions[i]!
          const chars = String.fromCodePoint(...g.codePoints)
          page.drawText(chars, { ...opts, x: x + (pen + p.xOffset) * scale, y: at.y + p.yOffset * scale })
          pen += p.xAdvance
        })
        x += r.font.widthOfTextAtSize(cluster, at.size)
      }
    }
  }
  return {
    get missing() {
      return missing
    },
    width,
    wrap,
    draw,
  }
}

interface Face {
  unitsPerEm: number
  layout(text: string): { glyphs: Array<{ codePoints: number[] }>; positions: Array<{ xAdvance: number; xOffset: number; yOffset: number }> }
}

const MARK = /\p{M}/u
// a character and the combining marks after it
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu
// direction controls change how the site shows the text; a PDF draws it in stored order, so they are shown as "?" with the note
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
// the last character, a surrogate pair counted as one; constant time, as words can be long
const lastChar = (s: string) => {
  const c = s.charCodeAt(s.length - 1)
  return c >= 0xdc00 && c <= 0xdfff ? s.slice(-2) : s.slice(-1)
}

/**
 * Text as it is drawn (Codex round 9): line and paragraph separators are line breaks; tabs and other spaces are a space;
 * invisible format characters (zero-width space and joiners, soft hyphen, byte order mark, variation selectors) are left out,
 * as no font draws them and the subsetter drops them; then NFC, so "i" plus a combining acute is the one character "í",
 * drawn by its own glyph. Direction controls are kept, to be shown as "?".
 */
const prepare = (s: string) =>
  s
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/[\t\v\f\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/(?![\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069])\p{Default_Ignorable_Code_Point}/gu, '')
    .normalize('NFC')
