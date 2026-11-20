import { PDFDocument } from 'pdf-lib'
import { expect, it } from 'vitest'
import { COVER_LIMITS, countReferences, withWarningCover } from './pdfCover.ts'
import { pdfText } from './pdfText.ts'

it('TC-GATE-05 a long warning runs onto more cover pages instead of being cut off; a very long word is broken', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300])
  const original = Buffer.from(await doc.save())
  const warning = Array.from({ length: 200 }, (_, i) => `Line ${i} of a long risk summary that keeps going.`).join('\n') + `\n${'x'.repeat(500)}`
  const out = await withWarningCover(original, warning, 'Deal ABC123')
  const pages = (await PDFDocument.load(out!)).getPageCount()
  expect(pages).toBeGreaterThan(2)
  expect(await withWarningCover(Buffer.from('%PDF-1.7 broken'), 'w', 't')).toBeNull()
})

it('TC-GATE-05 a page tree naming one page 100,000 times is refused at once, without rewriting it', async () => {
  const kids = Array.from({ length: 100_000 }, () => '3 0 R').join(' ')
  const body = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count 100000 >> endobj`,
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n')
  const started = Date.now()
  expect(await withWarningCover(Buffer.from(body, 'latin1'), 'w', 't')).toBeNull()
  expect(Date.now() - started).toBeLessThan(2000)
})

it('TC-GATE-05 the warning is the text of the first page', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300]).drawText('Company agreement page')
  const out = (await withWarningCover(Buffer.from(await doc.save()), 'Capital at risk warning', 'Deal X'))!
  expect((await pdfText(out))[0]).toBe('Capital at risk warning')
})

it('TC-GATE-05 a Chinese or Polish warning is drawn as written (decision R27); a character no font has is flagged', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300])
  const original = Buffer.from(await doc.save())
  const out = (await withWarningCover(original, '风险警告：您可能损失全部投资。 Łódź', 'Deal X'))!
  expect(await pdfText(out)).toEqual(['风险警告：您可能损失全部投资。 Łódź'])
  const odd = await pdfText((await withWarningCover(original, 'Risk \u{1F600}', 'Deal X'))!)
  expect(odd[0]).toBe('Risk ?')
  expect(odd.join(' ')).toContain('cannot be drawn')
})

it('TC-GATE-05 a small file with more references than the limit is refused before it is read, whatever its pages', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([10, 10])
  const refs = Array.from({ length: 150_000 }, () => '1 0 R').join(' ')
  const base = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1')
  // one extra object holding the references: one page, few objects, many references
  const padded = base.replace('%%EOF', `999 0 obj [${refs}] endobj\n%%EOF`)
  expect(await withWarningCover(Buffer.from(padded, 'latin1'), 'w', 't')).toBeNull()
})

it('TC-GATE-05 a small page tree that names each subtree twice is refused at once, however deep', async () => {
  // node k's Kids are [k+1, k+1]: 2^depth pages from a few dozen objects (Codex round 3)
  const depth = 28
  const objs = ['1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj']
  for (let k = 0; k < depth; k++) objs.push(`${k + 2} 0 obj << /Type /Pages /Kids [${k + 3} 0 R ${k + 3} 0 R] /Count ${2 ** (depth - k)} >> endobj`)
  objs.push(`${depth + 2} 0 obj << /Type /Page /MediaBox [0 0 10 10] >> endobj`)
  const body = ['%PDF-1.4', ...objs, 'trailer << /Root 1 0 R >>', '%%EOF'].join('\n')
  const started = Date.now()
  expect(await withWarningCover(Buffer.from(body, 'latin1'), 'w', 't')).toBeNull()
  expect(Date.now() - started).toBeLessThan(1000)
})

it('TC-GATE-05 a page tree that expands without pages is refused at the first repeat, not walked', async () => {
  // two levels of 10,000 references to one node each, and no pages at all: a hundred million visits if walked blindly
  const many = (n: number) => Array.from({ length: 10_000 }, () => `${n} 0 R`).join(' ')
  const body = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    `2 0 obj << /Type /Pages /Kids [${many(3)}] /Count 0 >> endobj`,
    `3 0 obj << /Type /Pages /Kids [${many(4)}] /Count 0 >> endobj`,
    '4 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n')
  const started = Date.now()
  expect(await withWarningCover(Buffer.from(body, 'latin1'), 'w', 't')).toBeNull()
  expect(Date.now() - started).toBeLessThan(1000)
})

it('TC-GATE-05 a small part that would unpack beyond the cap is refused before the parser unpacks it', async () => {
  const { deflateSync } = await import('node:zlib')
  // 200 MB of zeros compresses to about 200 KB; the cap is 128 MB for one part
  const packed = deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 })
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n3 0 obj << /Type /ObjStm /N 1 /First 4 /Length ${packed.length} /Filter /FlateDecode /DecodeParms << /Columns 4 >> >>\nstream\n`,
    'latin1',
  )
  const tail = Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1')
  const started = Date.now()
  expect(await withWarningCover(Buffer.concat([head, packed, tail]), 'w', 't')).toBeNull()
  expect(Date.now() - started).toBeLessThan(3000)
})

it('TC-GATE-05 a filter chain is unpacked under the same cap: within it the file is read, past it refused; an image is not unpacked', async () => {
  const { deflateSync } = await import('node:zlib')
  const objStm = (filter: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n3 0 obj << /Type /ObjStm /N 1 /First 4 /Length ${data.length} /Filter ${filter} >>\nstream\n`,
        'latin1',
      ),
      data,
      Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1'),
    ])
  const inner = Buffer.from(Buffer.from('4 0 << /A 1 >>').toString('hex') + '>', 'latin1')
  expect(await withWarningCover(objStm('[/FlateDecode /ASCIIHexDecode]', deflateSync(inner)), 'w', 't')).not.toBeNull()
  // compressed twice: small on disk, small after the first stage, 200 MB after the second
  const twice = deflateSync(deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 }), { level: 9 })
  const started = Date.now()
  expect(await withWarningCover(objStm('[/FlateDecode /FlateDecode]', twice), 'w', 't')).toBeNull()
  expect(Date.now() - started).toBeLessThan(5000)
  const doc = await PDFDocument.create()
  doc.addPage([100, 100])
  doc.context.register(doc.context.stream(Buffer.alloc(10), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, Filter: 'JPXDecode' }))
  expect(await withWarningCover(Buffer.from(await doc.save()), 'w', 't')).not.toBeNull()
})

it('TC-GATE-05 the cap holds however the file is written: escaped names, another line ending, a decoy end of stream', async () => {
  const { deflateSync } = await import('node:zlib')
  const big = deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 })
  const file = (dict: string, keyword: string, data: Buffer, decoy = '') =>
    Buffer.concat([
      Buffer.from(
        `%PDF-1.5\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n3 0 obj << ${dict} /Length ${data.length + decoy.length} >>${keyword}`,
        'latin1',
      ),
      data,
      Buffer.from(decoy, 'latin1'),
      Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1'),
    ])
  const started = Date.now()
  expect(await withWarningCover(file('/Type /Obj#53tm /N 1 /First 4 /Filter /Fl#61teDecode', '\nstream\n', big), 'w', 't')).toBeNull()
  // after a lone carriage return the parser keeps the object raw and unpacks nothing: it must only finish quickly
  await withWarningCover(file('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', '\nstream\r', big), 'w', 't')
  // a decoy `endstream` inside /Length: the parser reads to /Length, not to the first `endstream`
  expect(await withWarningCover(file('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', '\nstream\n', big, 'endstream\n'), 'w', 't')).toBeNull()
  expect(
    await withWarningCover(
      file('/Type /XRef /Si#7Ae 50000000 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', '\nstream\n', deflateSync(Buffer.alloc(16))),
      'w',
      't',
    ),
  ).toBeNull()
  expect(Date.now() - started).toBeLessThan(8000)
})

it('TC-GATE-05 each cap holds on its own: one part past its cap, and parts each within it but past the total', async () => {
  const { deflateSync } = await import('node:zlib')
  const MB = 1024 * 1024
  expect(COVER_LIMITS.decodedPerStream).toBe(32 * MB)
  expect(COVER_LIMITS.decodedTotal).toBe(128 * MB)
  const objStms = (parts: Buffer[]) => {
    let body = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n'
    const chunks: Buffer[] = []
    parts.forEach((data, i) => {
      chunks.push(Buffer.from(`${body}${i + 3} 0 obj << /Type /ObjStm /N 1 /First 4 /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data)
      body = '\nendstream\nendobj\n'
    })
    chunks.push(Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1'))
    return Buffer.concat(chunks)
  }
  // 40 MB in one part: past the part's cap, well within the total
  expect(await withWarningCover(objStms([deflateSync(Buffer.alloc(40 * MB), { level: 9 })]), 'w', 't')).toBeNull()
  // five parts of 30 MB: each within its cap, together past the total
  const part = deflateSync(Buffer.alloc(30 * MB), { level: 9 })
  expect(await withWarningCover(objStms([part, part, part, part, part]), 'w', 't')).toBeNull()
  // and one part of 30 MB alone is read
  expect(await withWarningCover(objStms([part]), 'w', 't')).not.toBeNull()
})

it('TC-GATE-05 a cross-reference stream is held to the same caps: too large unpacked, or counting more entries than allowed', async () => {
  const { deflateSync } = await import('node:zlib')
  const pdf = (dict: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `%PDF-1.5\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n3 0 obj << ${dict} /Length ${data.length} >>\nstream\n`,
        'latin1',
      ),
      data,
      Buffer.from('\nendstream\nendobj\nstartxref\n0\n%%EOF', 'latin1'),
    ])
  const started = Date.now()
  const big = deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 })
  expect(await withWarningCover(pdf('/Type /XRef /Size 4 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', big), 'w', 't')).toBeNull()
  // a few bytes of data, but fifty million entries to make
  const small = deflateSync(Buffer.alloc(16))
  expect(await withWarningCover(pdf('/Type /XRef /Size 50000000 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', small), 'w', 't')).toBeNull()
  expect(await withWarningCover(pdf('/Type /XRef /Size 4 /Index [0 50000000] /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', small), 'w', 't')).toBeNull()
  // a large count offset by a negative one: the parser skips the negative count and makes every entry of the large one
  expect(
    await withWarningCover(pdf('/Type /XRef /Size 4 /Index [0 50000000 0 -50000000] /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', small), 'w', 't'),
  ).toBeNull()
  expect(await withWarningCover(pdf('/Type /XRef /Size 4 /Index [0 2.5] /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', small), 'w', 't')).toBeNull()
  // a size given by reference to a large number
  const viaRef = pdf('/Type /XRef /Size 9 0 R /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', small)
  const at = viaRef.indexOf('3 0 obj')
  const withSize = Buffer.concat([viaRef.subarray(0, at), Buffer.from('9 0 obj 50000000 endobj\n', 'latin1'), viaRef.subarray(at)])
  expect(await withWarningCover(withSize, 'w', 't')).toBeNull()
  // fields wider than any number the parser can hold
  expect(await withWarningCover(pdf('/Type /XRef /Size 4 /W [1 200000000 1] /Root 1 0 R /Filter /FlateDecode', small), 'w', 't')).toBeNull()
  expect(Date.now() - started).toBeLessThan(5000)
  // an ordinary file saved with cross-reference streams still takes its cover
  const doc = await PDFDocument.create()
  doc.addPage([100, 100])
  const saved = Buffer.from(await doc.save({ useObjectStreams: true }))
  expect(saved.toString('latin1')).toMatch(/\/Type\s*\/XRef/)
  expect(await withWarningCover(saved, 'w', 't')).not.toBeNull()
})

it('TC-GATE-05 counting references is linear: long runs of digits or spaces in a file do not stall the server (Codex round 9)', async () => {
  const started = Date.now()
  expect(countReferences('1 ' + '2'.repeat(2_000_000) + ' x', 10)).toBe(0)
  expect(countReferences('1'.repeat(2_000_000), 10)).toBe(0)
  expect(countReferences('9 ' + ' '.repeat(2_000_000) + '9', 10)).toBe(0)
  expect(countReferences('12 0 R [3 0 R 4 0 R] /x 5 1 R', 10)).toBe(4)
  expect(countReferences('1 0 R '.repeat(1_000), 10)).toBe(11)
  // the same digits inside a valid file: the cover is still added
  const doc = await PDFDocument.create()
  doc.addPage([10, 10]).drawText('7 ' + '1'.repeat(200_000))
  expect(await withWarningCover(Buffer.from(await doc.save({ useObjectStreams: false })), 'w', 't')).not.toBeNull()
  expect(Date.now() - started).toBeLessThan(3000)
})
