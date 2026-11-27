import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { renderPdf } from '../../src/server/pdf.ts'
import { evidenceBlocks, evidenceManifest, hashOfKept, SECTION_TITLE, SECTION_TITLE_SIZE, SECTIONS } from '../../src/lib/evidence.ts'
import { pdfLines, pdfText } from '../../src/server/pdfText.ts'
import { fileFace, fileProblems, firstDifference, keyShown } from './files.ts'

const SECRET = 'f3a9c2e17b6d4a0e9c8b7a6f5e4d3c2b'

describe("demo export: the pack's files (scripts/demo-export/files.ts)", () => {
  it('TC-DEMO-12 a secret in a PDF title kept compressed in an object stream is found; JSON and CSV field names are on the list', async () => {
    const plain = await renderPdf([{ text: 'Payment details' }], 'Payment details')
    expect(await fileProblems('files/a/p.pdf', 'application/pdf', Buffer.from(plain), [SECRET])).toEqual([])
    const doc = await PDFDocument.load(plain, { updateMetadata: false })
    doc.setTitle(`Payment details ${SECRET}`)
    const hidden = Buffer.from(await doc.save({ useObjectStreams: true }))
    // not in the raw bytes, so only reading the decoded objects finds it (Codex P r1 #3)
    expect(hidden.toString('latin1')).not.toContain(SECRET)
    expect(await fileProblems('files/a/p.pdf', 'application/pdf', hidden, [SECRET])).toEqual(['files/a/p.pdf still holds a secret'])
    expect(await fileProblems('files/b/e.json', 'application/json', Buffer.from(`{"note":"${SECRET}"}`), [SECRET])).toEqual([
      'files/b/e.json still holds a secret',
    ])
    expect(await fileProblems('files/b/n.json', 'application/json', Buffer.from('{"note":"Unit%20sample"}'), ['Unit sample'])).toEqual(['files/b/n.json still holds a secret'])
    expect((await fileProblems('files/b/e.json', 'application/json', Buffer.from('{"home_address":"x"}'), [SECRET]))[0]).toMatch(
      /^files\/b\/e\.json carries fields not on FILE_FIELDS[\s\S]*\nhome_address$/,
    )
    expect((await fileProblems('files/c/l.csv', 'text/csv', Buffer.from('home_address\nx\n'), [SECRET]))[0]).toMatch(/carries fields not on FILE_FIELDS/)
  })

  it('TC-DEMO-09 a file read twice is the same file: only the evidence pack’s generation time and last-action time may differ', async () => {
    const file = (type: string, name = type === 'application/pdf' ? 'evidence-pack.pdf' : 'evidence-pack.json') => ({
      status: 200,
      file: { path: 'files/x/e', type, name },
    })
    const json = (o: object) => Buffer.from(JSON.stringify(o))
    const j = file('application/json')
    const T1 = '2026-11-02T10:00:01Z'
    const T2 = '2026-11-02T10:00:09Z'
    const VERSION = "Software version 0.1.0 in use for this person's actions"
    const pack = (o: { made?: string; until?: string; deadline?: string; version?: string; key?: string } = {}) => ({
      generated_at: o.made ?? T1,
      software_version: o.version ?? '0.1.0',
      sections: [
        { key: 'link_terms', items: [{ at: null, what: 'Deadline', fields: { until: o.deadline ?? T1 } }] },
        { key: o.key ?? 'versions', items: [{ at: T1, what: VERSION, fields: { until: o.until ?? T1 } }] },
      ],
    })
    const same = async (a: object, b: object, f = j) => expect(await fileFace(f, json(a))).toEqual(await fileFace(f, json(b)))
    const differ = async (a: object, b: object, f = j) => expect(await fileFace(f, json(a))).not.toEqual(await fileFace(f, json(b)))
    // the two values the export's own reading moves are left out (Codex P r1 #7)
    await same(pack(), pack({ made: T2, until: T2 }))
    // and nothing else (Codex P r2 #3): another deadline, the software version, a version item outside its section, a
    // generated_at below the top, another download with the same fields
    await differ(pack(), pack({ deadline: T2 }))
    await differ(pack(), pack({ version: '0.2.0' }))
    await differ(pack({ key: 'other' }), pack({ key: 'other', until: T2 }))
    await differ({ ...pack(), deal: { generated_at: T1, software_version: '0.1.0' } }, { ...pack(), deal: { generated_at: T2, software_version: '0.1.0' } })
    await differ(pack(), pack({ made: T2 }), file('application/json', 'investors.json'))
    expect(await fileFace(j, json({ a: 1 }))).not.toEqual(await fileFace({ ...j, status: 403 }, json({ a: 1 })))
    // the PDF: the time on the Made: line and the until: line of the version item only; made by the pack's own blocks and
    // renderer (Codex P r6 #5), so the titles are where and at the size the real pack draws them
    const p = file('application/pdf')
    const pdf = async (
      o: { made?: string; until?: string; deadline?: string; version?: string; said?: string; terms?: string; rules?: string; heading?: false; named?: string; titled?: boolean } = {},
    ) => {
      const kept = `Made: ${o.said ?? T1}, software version 0.1.0`
      const m = evidenceManifest({
        person: { id: 'p1', name: 'A', email: 'a@example.com' },
        // a deal name may hold lines of its own: a Made: line (Codex P r4 #3), and one reading as a section's title (r5 #3)
        deal: { id: 'd1', code: 'D1', name: o.named === undefined ? 'B' : `B\nMade: ${o.named}, software version 0.1.0${o.titled ? `\n${SECTION_TITLE.link_terms}\nand more` : ''}` },
        generatedAt: new Date(o.made ?? T1),
        softwareVersion: o.version ?? '0.1.0',
        sections: {
          link_terms: [
            { at: T1, what: 'Deadline', fields: { until: o.deadline ?? T1 } },
            { at: T1, what: VERSION, fields: { until: o.terms ?? T1 } },
          ],
          messages: [{ at: T1, what: 'Message from the lead', shown: { hashed: 'utf8', text: kept, sha256: hashOfKept({ hashed: 'utf8', text: kept, sha256: '' }) } }],
          versions: [
            { at: T1, what: 'Rule pack uk-1 in use', fields: { until: o.rules ?? T1 } },
            { at: T1, what: VERSION, fields: { until: o.until ?? T1 } },
          ],
        },
      })
      const blocks = evidenceBlocks(m)
      // a heading without its Made: line (the heading is the block after the pack's title)
      const heading = blocks.findIndex((b) => b.text === 'Evidence pack') + 1
      if (o.heading === false) blocks[heading] = { ...blocks[heading]!, text: blocks[heading]!.text.replace(/\nMade: [^\n]*$/m, '') }
      return Buffer.from(await renderPdf(blocks, 'Evidence pack'))
    }
    // the section titles, and only they, are drawn at the title size, each on one line; the deal name's line that reads as
    // one is not
    const titles = async (b: Buffer) => (await pdfLines(b)).filter((l) => l.size === SECTION_TITLE_SIZE).map((l) => l.text)
    expect(await titles(await pdf({ named: T1, titled: true }))).toEqual(SECTIONS.map((k) => SECTION_TITLE[k]))
    expect(await pdfText(await pdf({ named: T1, titled: true }))).toContain(SECTION_TITLE.link_terms)
    expect((await pdfText(await pdf({ heading: false }))).some((l) => l.startsWith('Made: 2026'))).toBe(true)
    const face = async (b: Buffer, f = p) => fileFace(f, b)
    expect(await face(await pdf())).toEqual(await face(await pdf({ made: T2, until: T2 })))
    expect(await face(await pdf())).not.toEqual(await face(await pdf({ version: '0.2.0' })))
    expect(await face(await pdf())).not.toEqual(await face(await pdf({ deadline: T2 })))
    // by where they are, not what the line says (Codex P r3 #3): a kept text's Made: line, a version-like item in another section
    expect(await face(await pdf())).not.toEqual(await face(await pdf({ said: T2 })))
    expect(await face(await pdf())).not.toEqual(await face(await pdf({ terms: T2 })))
    // in the versions section, another item's until; with no Made: in the heading, a kept text's is not taken for it
    expect(await face(await pdf())).not.toEqual(await face(await pdf({ rules: T2 })))
    expect(await face(await pdf({ heading: false }))).not.toEqual(await face(await pdf({ heading: false, said: T2 })))
    // a deal name holding a Made: line of its own, above the heading's (Codex P r4 #3): that one is compared, the heading's
    // time still left out
    expect(await face(await pdf({ named: T1 }))).not.toEqual(await face(await pdf({ named: T2 })))
    expect(await face(await pdf({ named: T1 }))).toEqual(await face(await pdf({ named: T1, made: T2 })))
    // and one that also holds a line reading as a section's title (Codex P r5 #3): drawn at the name's size, not a title's
    expect(await face(await pdf({ named: T1, titled: true }))).not.toEqual(await face(await pdf({ named: T2, titled: true })))
    expect(await face(await pdf({ named: T1, titled: true }))).toEqual(await face(await pdf({ named: T1, titled: true, made: T2 })))
    // any other file: byte for byte
    const c = file('text/csv', 'investors.csv')
    expect(await fileFace(c, Buffer.from('a\n1\n'))).not.toEqual(await fileFace(c, Buffer.from('a\n2\n')))
    const plain = await renderPdf([{ text: 'Payment details' }], 'Payment details')
    const pay = file('application/pdf', 'payment-3E44XN.pdf')
    expect(await fileFace(pay, Buffer.from(plain))).toEqual({ status: 200, type: 'application/pdf', name: 'payment-3E44XN.pdf', bytes: Buffer.from(plain).toString('base64') })
  })

  it('TC-DEMO-09 the export reports where two readings differ and which answer, never a value or a token (Codex P r2 #12)', () => {
    const SESSION = 'Zq8w3e5r7t9y1u2i4o6p8a0s'
    expect(firstDifference({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBeNull()
    expect(firstDifference({ csrf: SESSION, n: 1 }, { csrf: 'demo-x', n: 1 })).toBe('$.csrf')
    expect(firstDifference({ s: [{ u: 1 }] }, { s: [{ u: 2 }] })).toBe('$.s[0].u')
    expect(firstDifference({ s: [1] }, { s: [1, 2] })).toBe('$.s (length)')
    expect(firstDifference({ a: 1 }, { b: 1 })).toBe('$.a (only in one)')
    expect(firstDifference({ a: null }, { a: {} })).toBe('$.a')
    expect(keyShown(`investor GET /api/verify-instruction?token=${SESSION}&x=1`)).toBe('investor GET /api/verify-instruction?token=…&x=…')
    expect(keyShown(`investor POST /api/invite/open {"token":"${SESSION}"}`)).toBe('investor POST /api/invite/open {"token":…}')
    // a token inside another link, percent-encoded, and any other value: names only (Codex P r3 #12)
    const shown = keyShown(`lead GET /api/x?next=%2Finvite%3Ftoken%3D${SESSION}&n=2`)
    expect(shown).toBe('lead GET /api/x?next=…&n=…')
    expect(keyShown(`lead POST /api/y {"note":"${SESSION}","n":[1]}`)).toBe('lead POST /api/y {"note":…,"n":…}')
    expect(keyShown('lead GET /api/deals')).toBe('lead GET /api/deals')
  })
})
