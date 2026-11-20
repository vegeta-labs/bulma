import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { acknowledgementMail, complaintChannelText, complaintDue, complaintProblem, receivedOnProblem } from './complaint.ts'
import {
  EVIDENCE_LIMITS,
  evidenceBlocks,
  evidenceManifest,
  forbiddenClaims,
  hashOfKept,
  printedText,
  SECTION_NOTE,
  SECTION_TITLE,
  SECTIONS,
  type EvidenceInput,
} from './evidence.ts'
import { ARCHIVE_NOTE, INTERNAL_APPROVAL_NOTE } from './message.ts'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const person = { id: 'u1', name: 'Fay Fictional', email: 'fay@example.test' }
const input = (sections: EvidenceInput['sections']): EvidenceInput => ({
  person,
  deal: { id: 'd1', code: 'ABC123', name: 'Acme' },
  generatedAt: new Date('2026-11-17T10:00:00Z'),
  softwareVersion: '0.4.0',
  sections,
})

describe('D4 evidence pack rules (R-AUD-02)', () => {
  it('TC-AUD-02 each kept text is hashed again the way it was hashed when shown', () => {
    expect(hashOfKept({ hashed: 'utf8', text: 'Risk: you may lose all of it.', sha256: '' })).toBe(sha('Risk: you may lose all of it.'))
    // keys sorted, no spaces, whatever order they arrived in
    expect(hashOfKept({ hashed: 'stable_json', value: { b: 1, a: [2, { d: null, c: 'x' }] }, sha256: '' })).toBe(sha('{"a":[2,{"c":"x","d":null}],"b":1}'))
    expect(hashOfKept({ hashed: 'subject_and_text', subject: 'Call', text: 'Friday {link}', sha256: '' })).toBe(sha('["Call","Friday {link}"]'))
    expect(printedText({ hashed: 'subject_and_text', subject: 'Call', text: 'Friday', sha256: '' })).toBe('Subject: Call\n\nFriday')
    expect(printedText({ hashed: 'stable_json', value: { b: 1, a: 2 }, sha256: '' })).toBe('{"a":2,"b":1}')
  })

  it('TC-AUD-02 every section in a fixed order, empty ones kept, items by time, a changed text counted and named', () => {
    const m = evidenceManifest(
      input({
        messages: [{ at: '2026-11-02T00:00:00Z', what: 'Message', shown: { hashed: 'subject_and_text', subject: 'S', text: 'T', sha256: sha('["S","T"]') } }],
        warnings: [
          { at: '2026-11-03T00:00:00Z', what: 'later', shown: { hashed: 'utf8', text: 'changed since', sha256: sha('as shown') } },
          { at: '2026-11-01T00:00:00Z', what: 'earlier', fields: { choice: 'continue' }, shown: { hashed: 'utf8', text: 'as shown', sha256: sha('as shown') } },
        ],
        versions: [{ at: null, what: 'Rule pack x version 2' }],
      }),
    )
    expect(m.sections.map((s) => s.key)).toEqual([...SECTIONS])
    expect(m.sections.find((s) => s.key === 'kyc')!.items).toEqual([])
    const w = m.sections.find((s) => s.key === 'warnings')!.items
    expect(w.map((i) => i.what)).toEqual(['earlier', 'later'])
    expect(w[0]!.shown).toMatchObject({
      matches: true,
      sha256_recorded: sha('as shown'),
      sha256_now: sha('as shown'),
      text: 'as shown',
      hashed_as: 'sha256 of the text as UTF-8',
    })
    expect(w[1]!.shown).toMatchObject({ matches: false, sha256_recorded: sha('as shown'), sha256_now: sha('changed since') })
    expect(m.mismatches).toBe(1)
    expect(m.sections.find((s) => s.key === 'messages')!.items[0]!.shown).toMatchObject({ subject: 'S', text: 'T', matches: true })
    expect(m).toMatchObject({
      format: 'bulma-evidence-pack/1',
      generated_at: '2026-11-17T10:00:00.000Z',
      software_version: '0.4.0',
      person,
      limits: EVIDENCE_LIMITS,
    })
    // the approval note and the archive note are said where approvals and messages are listed
    expect(m.sections.find((s) => s.key === 'deal_versions')!.note).toBe(INTERNAL_APPROVAL_NOTE)
    expect(m.sections.find((s) => s.key === 'messages')!.note).toContain(ARCHIVE_NOTE)
    expect(m.sections.find((s) => s.key === 'messages')!.note).toContain(INTERNAL_APPROVAL_NOTE)
  })

  it('TC-AUD-02 the PDF starts with the limits in a box, then says how many texts do not match', () => {
    const ok = evidenceBlocks(
      evidenceManifest(input({ statements: [{ at: null, what: 'Statement', shown: { hashed: 'utf8', text: 'X', sha256: sha('X') } }] })),
    )
    expect(ok[0]).toEqual({ text: EVIDENCE_LIMITS.join('\n\n'), bold: true, boxed: true })
    expect(ok.slice(1).some((b) => b.boxed)).toBe(false)
    expect(ok.map((b) => b.text).join('\n')).toContain('Every kept text has the hash recorded when it was shown.')
    expect(ok.map((b) => b.text)).toContain('Nothing recorded.')
    const bad = evidenceBlocks(
      evidenceManifest(input({ statements: [{ at: null, what: 'Statement', shown: { hashed: 'utf8', text: 'Y', sha256: sha('X') } }] })),
    )
    const all = bad.map((b) => b.text).join('\n')
    expect(all).toContain('1 kept text(s) do not have the hash recorded')
    expect(bad.find((b) => b.text.startsWith('Text kept'))).toMatchObject({ bold: true, text: expect.stringContaining('does not match') })
    expect(all).toContain('Deal: Acme (ABC123)')
  })

  it('TC-AUD-02 the wording never says anyone saw or read something, or that every exchange is kept', () => {
    for (const bad of [
      'The investor saw the warning.',
      'Version 3 was viewed on 2 Nov.',
      'She has read the terms.',
      'All communications are archived here.',
      '全部沟通已存档',
      '投资人看到了',
    ])
      expect(forbiddenClaims(bad), bad).not.toEqual([])
    const ours = [
      ...EVIDENCE_LIMITS,
      ...Object.values(SECTION_TITLE),
      ...Object.values(SECTION_NOTE),
      ...evidenceBlocks(evidenceManifest(input({}))).map((b) => b.text),
    ]
    expect(forbiddenClaims(ours.join('\n'))).toEqual([])
    // the limits say first what the record cannot show
    expect(EVIDENCE_LIMITS.join(' ')).toMatch(/cannot tell whether they read/)
    expect(EVIDENCE_LIMITS.join(' ')).toMatch(/Replies, and anything said outside the site .* are not in this pack/)
  })
})

describe('D4 complaint rules (R-AUD-05)', () => {
  it('TC-AUD-03 acknowledge by the 30th day after the day of receipt, across months and years, late in the day too', () => {
    expect(complaintDue(new Date('2026-11-17T09:00:00Z'))).toBe('2026-12-17')
    expect(complaintDue(new Date('2026-11-17T23:59:59Z'))).toBe('2026-12-17')
    expect(complaintDue(new Date('2026-12-15T00:00:00Z'))).toBe('2027-01-14')
    expect(complaintDue(new Date('2028-02-01T12:00:00Z'))).toBe('2028-03-02')
  })

  it('TC-AUD-03 text, the day an email arrived, the fixed acknowledgement and the channel line', () => {
    expect(complaintProblem('  ')).toMatch(/Write what/)
    expect(complaintProblem('x'.repeat(10_001))).toMatch(/at most 10000/)
    expect(complaintProblem('x'.repeat(10_000))).toBeNull()
    expect(receivedOnProblem('2026-11-17', '2026-11-17')).toBeNull()
    expect(receivedOnProblem('2026-11-18', '2026-11-17')).toMatch(/future/)
    for (const bad of ['2026-02-30', '17/11/2026', '2026-1-1', '']) expect(receivedOnProblem(bad, '2026-11-17'), bad).toMatch(/YYYY-MM-DD/)
    const m = acknowledgementMail('2026-11-17')
    expect(m.subject).toBe('We have received your complaint')
    expect(m.body).toContain('2026-11-17')
    expect(complaintChannelText(null)).toBe('Your complaint is kept on this site and acknowledged within 30 days.')
    expect(complaintChannelText('complaints@op.test')).toBe(
      'Your complaint is kept on this site and acknowledged within 30 days. You can also email it to complaints@op.test.',
    )
  })
})
