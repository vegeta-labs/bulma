// Which files a deal accepts (R-DRF-07, §5.8). Pure. The type is judged from the content; a file name is display only.
export const DECK_LIMIT_BYTES = 10 * 1024 * 1024
export const LEGAL_LIMIT_BYTES = 100 * 1024 * 1024
export const MAX_DEAL_FILES = 200

export type DealFileKind = 'legal' | 'deck'
export type FileJudgement = { ok: true; contentType: string } | { ok: false; status: 413 | 415; error: string }

export const PDF = 'application/pdf'
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const startsWith = (data: Buffer, magic: string) => data.subarray(0, magic.length).equals(Buffer.from(magic, 'latin1'))
const isPdf = (data: Buffer) => startsWith(data, '%PDF-')
/** The names in a zip's central directory, or null if the file does not hold a well-formed one. Only the directory is read, so nothing is unpacked. */
function zipEntryNames(data: Buffer): Set<string> | null {
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--)
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  if (end < 0) return null
  const count = data.readUInt16LE(end + 10)
  let at = data.readUInt32LE(end + 16)
  const names = new Set<string>()
  for (let n = 0; n < count; n++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) return null
    const nameEnd = at + 46 + data.readUInt16LE(at + 28)
    if (nameEnd > data.length) return null
    names.add(data.toString('latin1', at + 46, nameEnd))
    at = nameEnd + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32)
  }
  return names
}

/** A Word file is a zip that really holds these parts; bytes that merely mention them are refused. */
function isDocx(data: Buffer): boolean {
  if (!startsWith(data, 'PK\x03\x04')) return false
  const names = zipEntryNames(data)
  return !!names && names.has('[Content_Types].xml') && names.has('word/document.xml')
}

export function judgeDealFile(kind: DealFileKind, data: Buffer): FileJudgement {
  const limit = kind === 'deck' ? DECK_LIMIT_BYTES : LEGAL_LIMIT_BYTES
  if (data.length > limit) return { ok: false, status: 413, error: `This file is over the ${limit / 1024 / 1024} MB limit.` }
  if (isPdf(data)) return { ok: true, contentType: PDF }
  if (kind === 'legal' && isDocx(data)) return { ok: true, contentType: DOCX }
  return { ok: false, status: 415, error: kind === 'deck' ? 'A pitch deck must be a PDF.' : 'Only PDF and Word (.docx) files are accepted.' }
}
