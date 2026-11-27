import { describe, expect, it } from 'vitest'
import { ALLOWED_FIELDS, FILE_FIELDS } from './fields.ts'
import { demoScenario } from '../../src/demo/scenario.ts'
import {
  canonical,
  csvFields,
  filePath,
  scenarioProblems,
  type Snapshot,
  getKey,
  postKey,
  replaceSecrets,
  secretsIn,
  tokensIn,
  unknownFields,
} from './record.ts'

describe('demo export: what the pack records', () => {
  it('TC-DEMO-10 a quote is looked up by its body whatever the key order; a read by its exact path and query', () => {
    expect(canonical({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"e":0,"f":1}]},"b":1}')
    expect(postKey('investor', '/api/my/deals/x/quote', { replace: false, commitment_minor: '1000000' })).toBe(
      postKey('investor', '/api/my/deals/x/quote', { commitment_minor: '1000000', replace: false }),
    )
    // another amount, or the same amount as a number, is another entry: the pack shows the demo sentence for it
    expect(postKey('investor', '/q', { commitment_minor: '1000000' })).not.toBe(postKey('investor', '/q', { commitment_minor: 1000000 }))
    expect(postKey('investor', '/q', undefined)).toBe('investor POST /q {}')
    expect(getKey('lead', '/api/deals/x/panel?status=to_pay&waiting=investor')).toBe('lead GET /api/deals/x/panel?status=to_pay&waiting=investor')
    expect(getKey('lead', '/p')).not.toBe(getKey('reviewer', '/p'))
  })

  it('TC-DEMO-12 every secret the export saw is replaced in keys and values, the longest first; a short one is refused', () => {
    const secrets = new Map([
      ['abcdefgh12345678', 'demo-token-1'],
      ['abcdefgh1234567890', 'demo-token-2'],
      ['csrf-value-xyz', 'demo-csrf-3'],
    ])
    const got = replaceSecrets(
      {
        verify_url: '/verify-instruction?token=abcdefgh1234567890',
        list: ['x abcdefgh12345678 y', 7, null, true],
        'investor POST /api/invite/open {"token":"abcdefgh12345678"}': { csrf: 'csrf-value-xyz' },
      },
      secrets,
    )
    expect(got).toEqual({
      verify_url: '/verify-instruction?token=demo-token-2',
      list: ['x demo-token-1 y', 7, null, true],
      'investor POST /api/invite/open {"token":"demo-token-1"}': { csrf: 'demo-csrf-3' },
    })
    expect(JSON.stringify(got)).not.toMatch(/abcdefgh|csrf-value/)
    expect(() => replaceSecrets({}, new Map([['short', 'x']]))).toThrow(/shorter than 8/)
  })

  it('TC-DEMO-12 link tokens are found in any string of an answer, decoded', () => {
    expect(
      tokensIn({
        a: '/verify-instruction?token=AbC_d-9.~x',
        b: ['https://x.invalid/invite?x=1&token=Zm9v%2Bbar', 'no token here', 'tokenless?token='],
        c: { d: 5 },
      }).sort(),
    ).toEqual(['AbC_d-9.~x', 'Zm9v+bar'])
    // a link inside another link's query; a malformed escape is kept as written, not thrown on
    expect(tokensIn(['/login?next=%2Finvite%3Ftoken%3DQ1w2E3r4%26x%3D1', '/x?token=a%zz']).sort()).toEqual(['Q1w2E3r4', 'a%zz'])
  })

  it('TC-DEMO-12 a field not on the reviewed list stops the export; ids as keys pass; the list holds no secret-looking name', () => {
    const allowed = new Set(['rows', 'name', 'counts'])
    expect(
      unknownFields(
        [{ rows: [{ name: 'Tien', password_hash: 'x' }], counts: { '0b8f8c1e-2b1e-4f3a-9c55-0a5b1d1e2f3a': 1 } }, { session_token: { name: 1 } }],
        allowed,
      ),
    ).toEqual(['password_hash', 'session_token'])
    expect(unknownFields({ rows: [], name: null }, allowed)).toEqual([])
    const risky = [...ALLOWED_FIELDS].filter((f) => /token|secret|password|recovery|cookie|session|hash|mfa_|private|key_id|wrapped/i.test(f))
    // looked at: a yes/no of the session, and the name of a question's text
    expect(risky).toEqual(['mustChangePassword', 'question_private_finance/default'])
    // the files' list adds the evidence packs' and the investors list's names; looked at: how a content hash was made, a
    // signature's id, the name of a text
    const riskyInFiles = [...FILE_FIELDS].filter(
      (f) => !ALLOWED_FIELDS.has(f) && /token|secret|password|recovery|cookie|session|hash|mfa_|private|key|wrapped|signature/i.test(f),
    )
    expect(riskyInFiles).toEqual(['hashed_as', 'signature', 'text_key'])
  })

  it('TC-DEMO-12 a JSON or CSV file is held to a field list too: the first line of a CSV is its names', () => {
    const allowed = new Set(['name', 'status'])
    expect(csvFields('name,"status",session_token\r\nGoku,To pay,x\n', allowed)).toEqual(['session_token'])
    expect(csvFields('name,status\n', allowed)).toEqual([])
    expect(csvFields('', allowed)).toEqual([''])
  })

  it("TC-DEMO-11 a file is kept under its sha256 and the server's name, made safe and given its type's extension", () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 sample')
    const p = filePath(bytes, 'application/pdf', 'payment-XW3GSJ.pdf')
    expect(p).toMatch(/^files\/[0-9a-f]{32}\/payment-XW3GSJ\.pdf$/)
    // the same bytes, the same folder; other bytes, another
    expect(filePath(bytes, 'application/pdf', 'x.pdf').split('/')[1]).toBe(p.split('/')[1])
    expect(filePath(new TextEncoder().encode('other'), 'application/pdf', 'x.pdf').split('/')[1]).not.toBe(p.split('/')[1])
    const at = (name: string | undefined, type = 'application/pdf') => filePath(bytes, type, name).split('/')[2]
    expect(at('document')).toBe('document.pdf')
    expect(at('Evidence PACK.PDF')).toBe('Evidence-PACK.PDF')
    expect(at('../../etc/passwd')).toBe('etc-passwd.pdf')
    expect(at('ünïcode name.csv', 'text/csv')).toBe('n-code-name.csv')
    expect(at(undefined, 'text/csv')).toBe('file.csv')
    expect(at('...', 'application/zip')).toBe('file.bin')
    expect(at('a'.repeat(200))).toBe(`${'a'.repeat(80)}.pdf`)
  })

  it('TC-DEMO-12 a file that still holds any secret is named, so the export stops before writing it', () => {
    const secrets = ['D83SNsWCMXkkcs514MvTZveEElAnKY5A', 'csrf-value-123456']
    expect(secretsIn('Before paying, check: /verify-instruction?token=D83SNsWCMXkkcs514MvTZveEElAnKY5A', secrets)).toEqual([secrets[0]])
    expect(secretsIn('Before paying, check: /verify-instruction?token=demo-token-8', secrets)).toEqual([])
    // percent-encoded, as in a link inside another link's query or a note's text (Codex P r3 #5)
    expect(secretsIn('Unit%20sample', ['Unit sample'])).toEqual(['Unit sample'])
    expect(secretsIn('Caf%C3%A9 Ltd', ['Café Ltd'])).toEqual(['Café Ltd'])
  })
})

describe('demo export: the recorded screens match the scenario', () => {
  const live = 'd1'
  const status = { kyc_in_review: 'verifying', to_sign: 'to_sign', to_pay: 'to_pay', funded: 'funded' } as const
  const good = (): Snapshot => ({
    format: 1,
    clock: '2026-11-02T10:00:00.000Z',
    views: { investor: { name: 'Son Goku' }, lead: { name: 'Lead' }, reviewer: { name: 'Sample reviewer' } },
    pages: [],
    get: {
      [getKey('lead', `/api/deals/${live}/panel`)]: {
        status: 200,
        body: {
          metrics: {
            committed_minor: String(demoScenario.investors.reduce((n, x) => n + x.commitmentMinor, 0n)),
            received_minor: '1530000',
            lead_fees_minor: '30000',
          },
          rows: ['Son Goku', 'Yamcha', 'Krillin', 'Tien'].map((name) => {
            const x = demoScenario.investors.find((i) => i.name === name)!
            return { name, status: status[x.stage], days: x.daysAtStep, commitment_minor: String(x.commitmentMinor) }
          }),
        },
      },
      'investor GET /api/my/participations/p1/instructions': { status: 200, body: { due_minor: '1020000' } },
      'investor GET /api/instructions/verify?token=demo-token-1': { status: 200, body: { valid: true } },
    },
    post: { [postKey('investor', `/api/my/deals/${live}/quote`, { commitment_minor: '1000000' })]: { status: 200, body: { due_minor: '1020000' } } },
  })

  it('TC-DEMO-10 the export stops when a total, a row, the amount to pay, the quote or the check differs from the scenario', () => {
    expect(scenarioProblems(good(), { live })).toEqual([])
    expect(scenarioProblems(good(), { live: 'other' })).toEqual(["the lead's investor list was not read"])
    const tamper = (f: (s: Snapshot) => void) => {
      const s = good()
      f(s)
      return scenarioProblems(s, { live })
    }
    const panel = (s: Snapshot) =>
      s.get[getKey('lead', `/api/deals/${live}/panel`)]!.body as { metrics: Record<string, string>; rows: Array<Record<string, unknown>> }
    expect(tamper((s) => (panel(s).metrics.received_minor = '1530001'))).toEqual(['received: 1530001, expected 1530000'])
    expect(tamper((s) => (panel(s).rows[1]!.days = 5))).toEqual(['Yamcha days: 5, expected 4'])
    expect(tamper((s) => panel(s).rows.reverse())).toEqual(['rows: Tien, Krillin, Yamcha, Son Goku, expected Son Goku, Yamcha, Krillin, Tien'])
    expect(tamper((s) => delete s.get['investor GET /api/my/participations/p1/instructions'])).toEqual(["Goku's amount to pay: undefined, expected 1020000"])
    expect(tamper((s) => (s.post = {}))).toEqual(['quote for £10,000.00: undefined, expected 1020000'])
    expect(tamper((s) => (s.get['investor GET /api/instructions/verify?token=demo-token-1']!.body = { valid: false }))).toEqual([
      'payment details check: false, expected true',
    ])
  })
})
