import { describe, expect, it } from 'vitest'
import { DECK_LIMIT_BYTES, judgeDealFile, LEGAL_LIMIT_BYTES } from './dealFiles.ts'
import {
  draftGaps,
  draftNotices,
  draftProblems,
  reviewChecklist,
  sectionProgress,
  type CarryRecipient,
  type Draft,
  type DraftContext,
  withEffectiveMinimum,
} from './draft.ts'
import {
  draftAmountToTyped,
  draftPercentToTyped,
  draftPriceToTyped,
  microsToPrice,
  priceToMicros,
  typedAmountToDraft,
  typedPercentToDraft,
  typedPriceToDraft,
  UNREADABLE_PERCENT,
} from './pounds.ts'
import { markupToRichText, richTextPlain, richTextToMarkup, validRichText } from './richText.ts'

const FEE = { rate_bps: 250, min_minor: 400_000n, max_minor: 2_000_000n, surcharge_threshold_minor: 500_000_000n, surcharge_bps: 10 }
const ctx = (o: Partial<DraftContext> = {}): DraftContext => ({
  today: '2026-11-09',
  enabledStructures: ['uk_bare_trust'],
  requiredCompanyFields: [],
  minCommitmentFloorMinor: 100_000n,
  feeConfig: FEE,
  embedHosts: ['docs.example.test'],
  adminSyndicateIds: ['syn-1'],
  ownedEntityIds: ['ent-1'],
  cleanLegalFiles: 1,
  cleanDeckFile: false,
  ...o,
})
const PERSON: CarryRecipient = { kind: 'person', first_name: 'Ada', last_name: 'Example', email: 'ada@example.test', share_bps: 10_000 }
const doc = (words: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: words }] }] })
const full = (): Draft => ({
  basics: { structure: 'uk_bare_trust', deal_type: 'primary', name: 'Example Round', syndicate: { mode: 'existing', id: 'syn-1' } },
  company: { legal_name: 'Example Ltd', contact_name: 'Sam Founder', contact_email: 'sam@example.test', jurisdiction: 'England and Wales' },
  terms: { currency: 'GBP', instrument: 'equity', share_price_micros: '15000', pre_money_minor: '500000000', allocation_minor: '30000000', voter: 'lead' },
  files: {},
  economics: { default_carry_bps: 2000, recipients: [PERSON], fee_payer: 'lead' },
  attestations: { board_and_shareholders: true },
})
type Terms = NonNullable<Draft['terms']>
const withTerms = (t: Partial<Terms>): Draft => ({ ...full(), terms: { ...full().terms, ...t } })
const withEconomics = (e: Partial<NonNullable<Draft['economics']>>): Draft => ({ ...full(), economics: { ...full().economics, ...e } })
const problem = (d: Draft, field: string, c = ctx()) => draftProblems(d, c).find((p) => p.field === field)

describe('draft fields', () => {
  it('TC-DRF-01 a complete draft has no problems', () => {
    expect(draftProblems(full(), ctx())).toEqual([])
  })

  it('TC-DRF-01 an empty draft names every required field, each with a matching message', () => {
    const p = draftProblems({}, ctx({ cleanLegalFiles: 0 }))
    expect(draftGaps(p)).toEqual([
      'Legal structure',
      'Deal type',
      'Deal name',
      'Syndicate',
      'Legal name',
      'Contact name',
      'Contact email',
      'Jurisdiction',
      'Currency',
      'Instrument',
      'SPV allocation',
      'Default voter',
      'Investment agreement and legal documents',
      'Default carry',
      'Who pays the platform fee',
      'Board and shareholder confirmation',
    ])
    for (const x of p) if (x.field !== 'legal_files' && x.section !== 'review') expect(x.message).toBe(`${x.label} is required.`)
  })

  it.each([['   '], ['']])('TC-DRF-01 a name of %j is missing, not accepted', (name) => {
    expect(problem({ ...full(), basics: { ...full().basics, name } }, 'name')?.kind).toBe('missing')
  })

  it('TC-DRF-01 text over the limit is refused, and exactly at it is fine', () => {
    expect(problem({ ...full(), basics: { ...full().basics, name: 'x'.repeat(200) } }, 'name')).toBeUndefined()
    expect(problem({ ...full(), basics: { ...full().basics, name: 'x'.repeat(201) } }, 'name')?.message).toBe(
      'Deal name must be text of 200 characters or fewer.',
    )
  })

  it('TC-DRF-01 a structure the operator has not enabled, and any other deal type, are refused', () => {
    expect(problem({ ...full(), basics: { ...full().basics, structure: 'lp' } }, 'structure')?.kind).toBe('invalid')
    expect(problem({ ...full(), basics: { ...full().basics, deal_type: 'secondary' } }, 'deal_type')?.kind).toBe('invalid')
    expect(problem({ ...full(), basics: { ...full().basics, structure: '__proto__' } }, 'structure')?.kind).toBe('invalid')
  })

  it("TC-DRF-01 someone else's syndicate or entity cannot be used", () => {
    expect(problem({ ...full(), basics: { ...full().basics, syndicate: { mode: 'existing', id: 'other' } } }, 'syndicate')?.message).toBe(
      'Choose a syndicate you manage.',
    )
    expect(
      problem({ ...full(), basics: { ...full().basics, syndicate: { mode: 'new', name: 'New', lead_entity_id: 'other' } } }, 'syndicate.lead_entity_id')?.kind,
    ).toBe('invalid')
    expect(draftProblems({ ...full(), basics: { ...full().basics, syndicate: { mode: 'new', name: 'New', lead_entity_id: 'ent-1' } } }, ctx())).toEqual([])
  })

  it('TC-DRF-01 contact email and website formats', () => {
    expect(problem({ ...full(), company: { ...full().company, contact_email: 'nope' } }, 'contact_email')?.message).toBe(
      'Contact email must be an email address.',
    )
    expect(problem({ ...full(), company: { ...full().company, contact_email: 'a@b.test\r\nBcc: x@y.test' } }, 'contact_email')?.kind).toBe('invalid')
    for (const website of ['http://example.test', 'javascript:alert(1)', 'example.test', 'https://user:pw@example.test'])
      expect(problem({ ...full(), company: { ...full().company, website } }, 'website')?.message).toBe(
        'Website must be a secure web address, starting with https.',
      )
    expect(problem({ ...full(), company: { ...full().company, website: 'https://example.test' } }, 'website')).toBeUndefined()
  })

  it('TC-DRF-01 the fields an operator adds become required', () => {
    const c = ctx({ requiredCompanyFields: ['registration_number', 'address'] })
    expect(problem(full(), 'registration_number', c)?.kind).toBe('missing')
    expect(problem(full(), 'address', c)?.kind).toBe('missing')
    expect(problem(full(), 'registration_number')).toBeUndefined()
  })

  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['1e5'], ['007'], [' 5'], ['100000000001'], ['99999999999999999999']])(
    'TC-DRF-01 an allocation of %s is refused',
    (v) => {
      expect(problem(withTerms({ allocation_minor: v }), 'allocation_minor')?.message).toBe('SPV allocation must be more than 0 and at most 1,000,000,000.')
    },
  )

  it('TC-DRF-01 an allocation of exactly the limit is accepted', () => {
    expect(problem(withTerms({ allocation_minor: '100000000000' }), 'allocation_minor')).toBeUndefined()
  })

  it('TC-DRF-01 an empty minimum commitment means the operator minimum, which it may equal but not go under', () => {
    expect(problem(withTerms({ min_commitment_minor: '' }), 'min_commitment_minor')).toBeUndefined()
    expect(problem(withTerms({ min_commitment_minor: '100000' }), 'min_commitment_minor')).toBeUndefined()
    expect(problem(withTerms({ min_commitment_minor: '99999' }), 'min_commitment_minor')?.message).toBe(
      'Minimum commitment must be at least the operator minimum of 1,000 and at most 1,000,000,000.',
    )
  })

  it('TC-DRF-01 the minimum commitment cannot exceed the allocation, even when it comes from the operator minimum', () => {
    expect(problem(withTerms({ min_commitment_minor: '30000001' }), 'min_commitment_minor')?.kind).toBe('invalid')
    expect(problem(withTerms({ min_commitment_minor: '30000000' }), 'min_commitment_minor')).toBeUndefined()
    expect(problem(withTerms({ allocation_minor: '99999' }), 'min_commitment_minor')?.message).toBe(
      'The minimum commitment of 1,000 cannot be above the SPV allocation.',
    )
  })

  it('TC-DRF-01 minimum raise above the allocation is refused; equal is fine', () => {
    expect(problem(withTerms({ min_raise_minor: '30000001' }), 'min_raise_minor')?.message).toBe('Minimum raise cannot be above the SPV allocation.')
    expect(problem(withTerms({ min_raise_minor: '30000000' }), 'min_raise_minor')).toBeUndefined()
    expect(problem(withTerms({ min_raise_minor: '0' }), 'min_raise_minor')?.kind).toBe('invalid')
  })

  it.each([['2026-11-09'], ['2026-11-08'], ['2026-02-30'], ['tomorrow']])('TC-DRF-01 a payment deadline of %s is refused', (pay_by) => {
    expect(problem(withTerms({ pay_by }), 'pay_by')?.message).toBe('Payment deadline must be a real date after today.')
  })

  it('TC-DRF-01 a payment deadline of tomorrow is accepted, and none at all', () => {
    expect(problem(withTerms({ pay_by: '2026-11-10' }), 'pay_by')).toBeUndefined()
    expect(problem(withTerms({ pay_by: undefined }), 'pay_by')).toBeUndefined()
  })

  it('TC-DRF-01 currency, round and voter must come from their lists', () => {
    expect(problem(withTerms({ currency: 'JPY' }), 'currency')?.kind).toBe('invalid')
    expect(problem(withTerms({ round: 'series_z' }), 'round')?.kind).toBe('invalid')
    expect(problem(withTerms({ round: 'series_d_plus_bridge' }), 'round')).toBeUndefined()
    expect(problem(withTerms({ voter: 'anyone' }), 'voter')?.kind).toBe('invalid')
  })
})

describe('instruments', () => {
  it('TC-DRF-02 equity needs a price and a pre-money valuation of at least 1,000', () => {
    expect(problem(withTerms({ share_price_micros: undefined }), 'share_price_micros')?.kind).toBe('missing')
    expect(problem(withTerms({ pre_money_minor: undefined }), 'pre_money_minor')?.kind).toBe('missing')
    expect(problem(withTerms({ pre_money_minor: '99999' }), 'pre_money_minor')?.message).toBe(
      'Pre-money valuation must be at least 1,000, and no more than the system can hold.',
    )
    expect(problem(withTerms({ pre_money_minor: '100000' }), 'pre_money_minor')).toBeUndefined()
    expect(problem(withTerms({ share_price_micros: '0' }), 'share_price_micros')?.kind).toBe('invalid')
  })

  it('TC-DRF-02 a placeholder price is 1.00 and nothing else, and is announced', () => {
    const d = withTerms({ share_price_micros: '1000000', price_is_placeholder: true })
    expect(draftProblems(d, ctx())).toEqual([])
    expect(draftNotices(d)).toContain('placeholder_price')
    expect(problem(withTerms({ share_price_micros: '15000', price_is_placeholder: true }), 'share_price_micros')?.message).toBe(
      'A placeholder share price must be 1.00.',
    )
  })

  it('TC-DRF-02 a price of £0.015 survives typing, storing as text and reading back', () => {
    const micros = priceToMicros('0.015')
    expect(micros).toBe('15000')
    expect(microsToPrice(BigInt(JSON.parse(JSON.stringify(micros))))).toBe('0.015')
    expect(microsToPrice(1_000_000n)).toBe('1.00')
    expect(microsToPrice(1_500_000n)).toBe('1.50')
    expect(microsToPrice(1n)).toBe('0.000001')
  })

  it.each([['0.0000001'], ['abc'], ['-1'], [''], ['1.'], ['1e3']])('TC-DRF-02 a price typed as %j is not read', (typed) => {
    expect(priceToMicros(typed)).toBeNull()
  })

  it.each(['cln', 'safe', 'asa'] as const)('TC-DRF-02 %s has no price, and a cap type asks for its amount', (instrument) => {
    const base = { instrument, share_price_micros: undefined, pre_money_minor: undefined }
    expect(draftProblems(withTerms(base), ctx())).toEqual([])
    expect(problem(withTerms({ ...base, cap_type: 'pre_money' }), 'cap_minor')?.kind).toBe('missing')
    expect(problem(withTerms({ ...base, cap_type: 'none' }), 'cap_minor')).toBeUndefined()
    expect(problem(withTerms({ ...base, cap_type: 'post_money', cap_minor: '500000000' }), 'cap_minor')).toBeUndefined()
    expect(problem(withTerms({ ...base, discount_bps: 10_000 }), 'discount_bps')?.kind).toBe('invalid')
    expect(problem(withTerms({ ...base, discount_bps: 0 }), 'discount_bps')).toBeUndefined()
    expect(problem(withTerms({ ...base, discount_bps: 2.5 }), 'discount_bps')?.kind).toBe('invalid')
  })

  it('TC-DRF-02 fund units need only the fund confirmation', () => {
    const d = withTerms({ instrument: 'fund_units', share_price_micros: undefined, pre_money_minor: undefined })
    expect(draftGaps(draftProblems(d, ctx()))).toEqual(['Fund investment confirmation'])
    expect(draftProblems({ ...d, attestations: { board_and_shareholders: true, fund_mainly_unlisted: true } }, ctx())).toEqual([])
  })

  it('TC-DRF-02 a value left over from another instrument is not judged', () => {
    expect(draftProblems(withTerms({ instrument: 'safe', share_price_micros: 'junk', pre_money_minor: 'junk' }), ctx())).toEqual([])
  })
})

describe('files', () => {
  it('TC-DRF-03 no scanned legal document, no submission', () => {
    expect(problem(full(), 'legal_files', ctx({ cleanLegalFiles: 0 }))?.kind).toBe('missing')
  })

  it('TC-DRF-03 a linked deck carries the warning that links are outside the gate', () => {
    const d: Draft = { ...full(), files: { deck: { kind: 'link', url: 'https://deck.example.test/a' } } }
    expect(draftProblems(d, ctx())).toEqual([])
    expect(draftNotices(d)).toContain('external_deck')
  })

  it.each([
    ['https://evil.test/x'],
    ['http://docs.example.test/x'],
    ['https://docs.example.test:8443/x'],
    ['https://docs.example.test@evil.test/x'],
    ['https://sub.docs.example.test/x'],
    ['not a url'],
  ])('TC-DRF-03 an embed address of %s is refused', (embed_url) => {
    const d: Draft = { ...full(), files: { deck: { kind: 'link', url: 'https://deck.example.test/a', embed_url } } }
    expect(problem(d, 'deck.embed_url')?.kind).toBe('invalid')
  })

  it('TC-DRF-03 an embed on the operator list is accepted, in any case; an empty list allows none', () => {
    const d: Draft = { ...full(), files: { deck: { kind: 'link', url: 'https://deck.example.test/a', embed_url: 'https://DOCS.example.test/x' } } }
    expect(draftProblems(d, ctx())).toEqual([])
    expect(problem(d, 'deck.embed_url', ctx({ embedHosts: [] }))?.kind).toBe('invalid')
  })

  it('TC-DRF-03 a deck file must have passed the scan', () => {
    const d: Draft = { ...full(), files: { deck: { kind: 'file' } } }
    expect(problem(d, 'deck')?.kind).toBe('invalid')
    expect(problem(d, 'deck', ctx({ cleanDeckFile: true }))).toBeUndefined()
  })

  it('TC-DRF-03 a memo can be empty, but not contain what the renderer does not know', () => {
    expect(problem({ ...full(), files: { memo: doc('Hello') } }, 'memo')).toBeUndefined()
    expect(problem({ ...full(), files: { memo: { type: 'doc', content: [{ type: 'script', text: 'x' }] } } }, 'memo')?.kind).toBe('invalid')
  })
})

describe('rich text', () => {
  const para = (node: unknown) => ({ type: 'doc', content: [{ type: 'paragraph', content: [node] }] })

  it('TC-DRF-03 headings, lists and marks are allowed', () => {
    expect(
      validRichText({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'T' }] },
          {
            type: 'bullet_list',
            content: [
              { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'strong' }, { type: 'em' }] }] }] },
            ],
          },
        ],
      }),
    ).toBe(true)
    expect(validRichText(para({ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'https://example.test' } }] }))).toBe(true)
  })

  it.each([
    ['a javascript link', para({ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] })],
    ['a plain http link', para({ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'http://example.test' } }] })],
    ['an extra link attribute', para({ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'https://example.test', onclick: 'x' } }] })],
    ['an unknown node', para({ type: 'image', attrs: { src: 'x' } })],
    ['an unknown mark', para({ type: 'text', text: 'a', marks: [{ type: 'html' }] })],
    ['an extra key', para({ type: 'text', text: 'a', style: 'x' })],
    ['a heading level outside the list', { type: 'doc', content: [{ type: 'heading', attrs: { level: 7 } }] }],
    ['text directly under the document', { type: 'doc', content: [{ type: 'text', text: 'a' }] }],
    ['something that is not a document', { type: 'paragraph' }],
    ['a __proto__ key', JSON.parse('{"type":"doc","__proto__":{"x":1}}')],
    ['a string', 'hello'],
    ['null', null],
  ])('TC-DRF-03 %s is refused', (_what, value) => {
    expect(validRichText(value)).toBe(false)
  })

  it('TC-DRF-03 very deep or very long documents are refused', () => {
    let deep: unknown = { type: 'paragraph' }
    for (let i = 0; i < 20; i++) deep = { type: 'bullet_list', content: [{ type: 'list_item', content: [deep] }] }
    expect(validRichText({ type: 'doc', content: [deep] })).toBe(false)
    expect(validRichText(para({ type: 'text', text: 'x'.repeat(200_001) }))).toBe(false)
  })

  it('TC-DRF-08 plain words are pulled out in order', () => {
    expect(
      richTextPlain({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
        ],
      }),
    ).toBe('One\nTwo')
  })

  it('TC-SIG-02 a line break inside a paragraph, and paragraphs inside one list item, stay apart in the plain words', () => {
    const p = (...content: object[]) => ({ type: 'paragraph', content })
    expect(richTextPlain({ type: 'doc', content: [p({ type: 'text', text: 'due in' }, { type: 'hard_break' }, { type: 'text', text: '30 days.' })] })).toBe(
      'due in\n30 days.',
    )
    expect(
      richTextPlain({
        type: 'doc',
        content: [{ type: 'bullet_list', content: [{ type: 'list_item', content: [p({ type: 'text', text: 'A' }), p({ type: 'text', text: 'B' })] }] }],
      }),
    ).toBe('A\nB')
  })
})

describe('economics', () => {
  it('TC-DRF-04 shares must add up to exactly 100%', () => {
    const r = (share_bps: number) => ({ ...PERSON, share_bps })
    expect(problem(withEconomics({ recipients: [r(6000), r(3999)] }), 'recipients')?.message).toBe('Carry recipient shares must add up to exactly 100%.')
    expect(problem(withEconomics({ recipients: [r(6000), r(4001)] }), 'recipients')?.kind).toBe('invalid')
    expect(problem(withEconomics({ recipients: [r(6000), r(4000)] }), 'recipients')).toBeUndefined()
  })

  it('TC-DRF-04 carry above 0 needs a recipient; 0 is a real answer and needs none', () => {
    expect(problem(withEconomics({ recipients: [] }), 'recipients')?.kind).toBe('missing')
    expect(draftProblems(withEconomics({ default_carry_bps: 0, recipients: [] }), ctx())).toEqual([])
  })

  it.each([[10_001], [-1], [12.5]])('TC-DRF-04 carry of %s bps is refused', (default_carry_bps) => {
    expect(problem(withEconomics({ default_carry_bps }), 'default_carry_bps')?.message).toBe('Default carry must be from 0% to 100%.')
  })

  it('TC-DRF-04 carry of exactly 100% is accepted; no carry entered is missing', () => {
    expect(problem(withEconomics({ default_carry_bps: 10_000 }), 'default_carry_bps')).toBeUndefined()
    expect(problem(withEconomics({ default_carry_bps: undefined }), 'default_carry_bps')?.kind).toBe('missing')
  })

  it('TC-DRF-04 a person needs names and an email; a company needs its five details', () => {
    expect(draftGaps(draftProblems(withEconomics({ recipients: [{ kind: 'person', share_bps: 10_000 }] }), ctx()))).toEqual([
      'Carry recipient 1 first name',
      'Carry recipient 1 last name',
      'Carry recipient 1 email',
    ])
    expect(draftGaps(draftProblems(withEconomics({ recipients: [{ kind: 'company', share_bps: 10_000 }] }), ctx()))).toEqual([
      'Carry recipient 1 trading name',
      'Carry recipient 1 legal name',
      'Carry recipient 1 registration number',
      'Carry recipient 1 contact name',
      'Carry recipient 1 contact email',
    ])
    expect(problem(withEconomics({ recipients: [{ share_bps: 10_000 }] }), 'recipients.0.kind')?.kind).toBe('missing')
  })

  it.each([[0], [10_001], [1.5], [undefined]])('TC-DRF-04 a share of %s is refused without a second message about the total', (share_bps) => {
    const d = withEconomics({ recipients: [{ ...PERSON, share_bps }] })
    expect(problem(d, 'recipients.0.share_bps')?.kind).toBe('invalid')
    expect(problem(d, 'recipients')).toBeUndefined()
  })

  it('TC-DRF-04 more than 20 recipients are refused', () => {
    const many = Array.from({ length: 21 }, () => ({ ...PERSON, share_bps: 476 }))
    expect(problem(withEconomics({ recipients: many }), 'recipients')?.message).toBe('There can be at most 20 carry recipients.')
  })

  const small = { terms: { ...full().terms, allocation_minor: '300000' } }

  it('TC-DRF-05 SPV £3,000 with a £4,000 minimum fee: investors cannot pay it', () => {
    expect(problem({ ...full(), ...small, economics: { ...full().economics, fee_payer: 'investors' } }, 'fee_payer')?.kind).toBe('invalid')
  })

  it.each(['lead', 'company'] as const)('TC-DRF-05 the same deal is fine when the %s pays', (fee_payer) => {
    expect(draftProblems({ ...full(), ...small, economics: { ...full().economics, fee_payer } }, ctx())).toEqual([])
  })

  it('TC-DRF-05 a fee exactly equal to the allocation is refused; a penny less is fine', () => {
    const d = (allocation_minor: string): Draft => ({ ...withTerms({ allocation_minor }), economics: { ...full().economics, fee_payer: 'investors' } })
    expect(problem(d('400000'), 'fee_payer')?.kind).toBe('invalid')
    expect(problem(d('400001'), 'fee_payer')).toBeUndefined()
  })

  it('TC-DRF-05 a payer outside the three is refused, and none is missing', () => {
    expect(problem(withEconomics({ fee_payer: 'split' }), 'fee_payer')?.kind).toBe('invalid')
    expect(problem(withEconomics({ fee_payer: undefined }), 'fee_payer')?.kind).toBe('missing')
  })

  it('TC-DRF-05 a broken fee setting refuses rather than letting the deal through', () => {
    expect(problem(withEconomics({ fee_payer: 'investors' }), 'fee_payer', ctx({ feeConfig: { ...FEE, min_minor: 3n, max_minor: 2n } }))?.kind).toBe('invalid')
  })

  it('TC-DRF-05 investors paying brings the estimate notice, and the minimum raise hint until one is set', () => {
    const d = withEconomics({ fee_payer: 'investors' })
    expect(draftNotices(d)).toEqual(expect.arrayContaining(['fee_estimate', 'min_raise_helps']))
    expect(draftNotices({ ...d, terms: { ...d.terms, min_raise_minor: '10000000' } })).not.toContain('min_raise_helps')
    expect(draftNotices(full())).not.toContain('fee_estimate')
  })
})

describe('review page', () => {
  it('TC-DRF-06 each section shows whether it is finished, and any section can be incomplete on its own', () => {
    expect(sectionProgress(draftProblems(full(), ctx()))).toEqual({ basics: true, company: true, terms: true, files: true, economics: true, review: true })
    expect(sectionProgress(draftProblems({ ...full(), company: {} }, ctx()))).toEqual({
      basics: true,
      company: false,
      terms: true,
      files: true,
      economics: true,
      review: true,
    })
  })

  it('TC-DRF-06 a label appears once however many problems share it', () => {
    expect(
      draftGaps([
        { section: 'terms', field: 'a', label: 'Share price', kind: 'invalid', message: '' },
        { section: 'terms', field: 'b', label: 'Share price', kind: 'invalid', message: '' },
      ]),
    ).toEqual(['Share price'])
  })

  it('TC-DRF-08 no lead confirmation, no submission', () => {
    expect(problem({ ...full(), attestations: {} }, 'board_and_shareholders')?.kind).toBe('missing')
    expect(problem({ ...full(), attestations: { board_and_shareholders: 'yes' as unknown as boolean } }, 'board_and_shareholders')?.kind).toBe('missing')
  })

  it('TC-DRF-08 the reviewer checklist shows the custom terms to read', () => {
    expect(reviewChecklist(withTerms({ custom_terms: doc('Investors also indemnify the lead.') }))).toEqual({
      customTerms: 'Investors also indemnify the lead.',
    })
    expect(reviewChecklist(full())).toEqual({ customTerms: null })
  })

  it('TC-DRF-08 tax relief and voter notices appear with their fields', () => {
    expect(draftNotices(withTerms({ seis: true }))).toContain('tax_relief_not_judged')
    expect(draftNotices(withTerms({ seis: false, eis: false }))).not.toContain('tax_relief_not_judged')
    expect(draftNotices(full())).toContain('voter_scope')
  })
})

describe('the words match the rule', () => {
  it('TC-DRF-06 a figure too large to hold says so, whichever field it is in', () => {
    const huge = '9999999999999999999'
    expect(problem(withTerms({ share_price_micros: huge }), 'share_price_micros')?.message).toBe(
      'Share price must be more than 0, and no more than the system can hold.',
    )
    expect(problem(withTerms({ round_size_minor: huge }), 'round_size_minor')?.message).toBe(
      'Total round size must be more than 0, and no more than the system can hold.',
    )
    expect(problem(withTerms({ instrument: 'safe', cap_type: 'pre_money', cap_minor: huge }), 'cap_minor')?.message).toBe(
      'Valuation cap must be more than 0, and no more than the system can hold.',
    )
  })

  it.each([['0000-01-01'], ['1899-12-31']])('TC-DRF-01 a target close date of %s is not a real date', (target_close) => {
    expect(problem(withTerms({ target_close }), 'target_close')?.kind).toBe('invalid')
  })
})

describe('what the wizard keeps from what is typed', () => {
  it.each([
    ['250,000', '25000000'],
    ['123.45', '12345'],
    ['1,000.5', '100050'],
    ['007', '700'],
    ['0', '0'],
    ['0.05', '5'],
  ])('TC-DRF-02 the amount %s is kept exactly as minor units', (typed, minor) => {
    expect(typedAmountToDraft(typed)).toBe(minor)
  })

  it.each([[''], ['   ']])('TC-DRF-06 an empty amount is absent, never 0: %j', (typed) => {
    expect(typedAmountToDraft(typed)).toBeNull()
    expect(typedPriceToDraft(typed)).toBeNull()
    expect(typedPercentToDraft(typed)).toBeNull()
  })

  it.each([['abc'], ['1,00'], ['12.345'], ['-5'], ['£'], ['1 000'], ['£250000'], ['€1,000'], ['$ 1000']])(
    'TC-DRF-06 %s is kept as typed and can never be read as an amount',
    (typed) => {
      expect(typedAmountToDraft(typed)).toBe(typed)
      expect(/^\d+$/.test(typed)).toBe(false)
      expect(problem(withTerms({ allocation_minor: typed }), 'allocation_minor')?.kind).toBe('invalid')
    },
  )

  it.each([
    ['1,000,000,000', undefined],
    ['1,000,000,000.01', 'invalid'],
    ['1,000,000,001', 'invalid'],
    ['0.01', undefined],
    ['0', 'invalid'],
    ['99999999999999999999999', 'invalid'],
  ])('TC-DRF-01 an SPV allocation typed as %s, at and either side of the limits', (typed, kind) => {
    expect(problem(withTerms({ allocation_minor: typedAmountToDraft(typed) ?? undefined }), 'allocation_minor')?.kind).toBe(kind)
  })

  it('TC-DRF-01 a limit with pence is described exactly', () => {
    const p = draftProblems(withTerms({ allocation_minor: '30000000', min_commitment_minor: '100000' }), ctx({ minCommitmentFloorMinor: 100_001n })).find(
      (x) => x.field === 'min_commitment_minor',
    )
    expect(p?.message).toContain('at least the operator minimum of 1,000.01')
  })

  it('TC-DRF-01 a price typed at and over what can be held', () => {
    expect(problem(withTerms({ instrument: 'equity', share_price_micros: typedPriceToDraft('0.000001') ?? undefined }), 'share_price_micros')).toBeUndefined()
    expect(problem(withTerms({ instrument: 'equity', share_price_micros: typedPriceToDraft('0') ?? undefined }), 'share_price_micros')?.kind).toBe('invalid')
    expect(
      problem(withTerms({ instrument: 'equity', share_price_micros: typedPriceToDraft('99999999999999999999') ?? undefined }), 'share_price_micros')?.kind,
    ).toBe('invalid')
  })

  it('TC-DRF-06 a figure too long for a whole-pound reading still reaches the rule about limits, and is not misread as pence', () => {
    const minor = typedAmountToDraft('99999999999999')!
    expect(minor).toBe('9999999999999900')
    expect(problem(withTerms({ allocation_minor: minor }), 'allocation_minor')?.message).toContain('at most 1,000,000,000')
    expect(typedPriceToDraft('9999999999999')).toBe('9999999999999000000')
  })

  it.each([
    ['100000', '1,000'],
    ['12345', '123.45'],
    ['5', '0.05'],
    ['0', '0'],
    ['25000000', '250,000'],
  ])('TC-DRF-02 the stored amount %s shows as %s, and reads back the same', (minor, typed) => {
    expect(draftAmountToTyped(minor)).toBe(typed)
    expect(typedAmountToDraft(typed)).toBe(minor)
  })

  it('TC-DRF-06 text kept as typed comes back as typed, and nothing stored shows as nothing', () => {
    expect(draftAmountToTyped('abc')).toBe('abc')
    expect(draftPriceToTyped('abc')).toBe('abc')
    expect(draftAmountToTyped(undefined)).toBe('')
    expect(draftPriceToTyped(undefined)).toBe('')
  })

  it('TC-DRF-02 a share price of 0.015 is exact on the way in and on the way out', () => {
    expect(typedPriceToDraft('0.015')).toBe('15000')
    expect(draftPriceToTyped('15000')).toBe('0.015')
    expect(typedPriceToDraft('1.00')).toBe('1000000')
    expect(typedPriceToDraft('€1.00')).toBe('€1.00')
    expect(draftPriceToTyped('1000000')).toBe('1.00')
    expect(typedPriceToDraft('0.0000001')).toBe('0.0000001')
  })

  it('TC-DRF-04 a percentage reads to basis points; what cannot be read is one the rules refuse, never blank', () => {
    expect(typedPercentToDraft('12.5')).toBe(1250)
    expect(typedPercentToDraft('0')).toBe(0)
    expect(typedPercentToDraft('150')).toBe(UNREADABLE_PERCENT)
    expect(typedPercentToDraft('abc')).toBe(UNREADABLE_PERCENT)
    expect(UNREADABLE_PERCENT).toBeLessThan(0)
    expect(draftPercentToTyped(1250)).toBe('12.5')
    expect(draftPercentToTyped(0)).toBe('0')
    expect(draftPercentToTyped(10_000)).toBe('100')
    expect(draftPercentToTyped(UNREADABLE_PERCENT)).toBe('')
    expect(draftPercentToTyped(10_001)).toBe('')
    expect(draftPercentToTyped(12.5)).toBe('')
    expect(draftPercentToTyped(undefined)).toBe('')
  })
})

describe('a minimum left blank', () => {
  it.each([[''], [null], [undefined]])('TC-DRF-01 %j shows as the figure it was reviewed with', (blank) => {
    const d = { terms: { min_commitment_minor: blank } } as unknown as Draft
    expect(withEffectiveMinimum(d, '100000').terms?.min_commitment_minor).toBe('100000')
  })
  it('TC-DRF-01 a figure given stays, and with no reviewed figure nothing is invented', () => {
    expect(withEffectiveMinimum({ terms: { min_commitment_minor: '500000' } }, '100000').terms?.min_commitment_minor).toBe('500000')
    expect(withEffectiveMinimum({}, null)).toEqual({})
  })
})

describe('what a lead uploads', () => {
  it('TC-DRF-03 a Word file must really be a zip holding the parts; bytes that mention them are refused', () => {
    const zip = (names: string[]) => {
      const dir = Buffer.concat(
        names.map((n) => {
          const b = Buffer.alloc(46 + n.length)
          b.writeUInt32LE(0x02014b50, 0)
          b.writeUInt16LE(n.length, 28)
          b.write(n, 46, 'latin1')
          return b
        }),
      )
      const end = Buffer.alloc(22)
      end.writeUInt32LE(0x06054b50, 0)
      end.writeUInt16LE(names.length, 10)
      end.writeUInt32LE(4, 16)
      return Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), dir, end])
    }
    expect(judgeDealFile('legal', zip(['[Content_Types].xml', 'word/document.xml'])).ok).toBe(true)
    expect(judgeDealFile('legal', zip(['[Content_Types].xml'])).ok).toBe(false)
    expect(judgeDealFile('legal', zip(['word/document.xml'])).ok).toBe(false)
    expect(judgeDealFile('legal', Buffer.from('PK\x03\x04junk[Content_Types].xmljunkword/document.xml', 'latin1')).ok).toBe(false)
    expect(judgeDealFile('legal', Buffer.from('PK\x03\x04', 'latin1')).ok).toBe(false)
    const broken = zip(['[Content_Types].xml', 'word/document.xml'])
    broken.writeUInt32LE(broken.length + 100, broken.length - 6)
    expect(judgeDealFile('legal', broken).ok).toBe(false)
    const notADirectory = zip(['[Content_Types].xml', 'word/document.xml'])
    notADirectory.writeUInt32LE(0, 4)
    expect(judgeDealFile('legal', notADirectory).ok).toBe(false)
    expect(judgeDealFile('deck', zip(['[Content_Types].xml', 'word/document.xml'])).ok).toBe(false)
  })

  const pdfOf = (bytes: number) => Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(bytes - 5)])
  it('TC-DRF-03 a legal document is taken at exactly 100 MB and refused one byte over; a deck at 10 MB', () => {
    expect(judgeDealFile('legal', pdfOf(LEGAL_LIMIT_BYTES)).ok).toBe(true)
    expect(judgeDealFile('legal', pdfOf(LEGAL_LIMIT_BYTES + 1)).ok).toBe(false)
    expect(judgeDealFile('deck', pdfOf(DECK_LIMIT_BYTES)).ok).toBe(true)
    expect(judgeDealFile('deck', pdfOf(DECK_LIMIT_BYTES + 1)).ok).toBe(false)
  })
})

describe('what a lead writes', () => {
  it('TC-DRF-03 plain writing becomes a document the rules accept, with each kind of formatting', () => {
    const doc = markupToRichText('# Title\n\nA **bold** and *soft* [link](https://example.test/a)\nsecond line\n\n- one\n- two\n\n1. first')!
    expect(validRichText(doc)).toBe(true)
    expect(doc.content.map((b) => b.type)).toEqual(['heading', 'paragraph', 'bullet_list', 'ordered_list'])
    const para = doc.content[1]!.content as Array<{ type: string; text?: string; marks?: Array<{ type: string }> }>
    expect(para.filter((n) => n.marks).map((n) => n.marks![0]!.type)).toEqual(['strong', 'em', 'link'])
    expect(para.some((n) => n.type === 'hard_break')).toBe(true)
    expect(doc.content[0]!.attrs).toEqual({ level: 1 })
  })

  it('TC-DRF-03 what is typed cannot become markup or a link anywhere but https', () => {
    for (const typed of ['<script>alert(1)</script>', '[x](javascript:alert(1))', '[x](http://example.test)', '![a](https://x.test/a.png)']) {
      const doc = markupToRichText(typed)!
      expect(validRichText(doc), typed).toBe(true)
      expect(JSON.stringify(doc), typed).not.toContain('"javascript')
      if (!typed.startsWith('!')) expect(JSON.stringify(doc), typed).not.toContain('"link"')
      expect(richTextPlain(doc), typed).toContain(typed.startsWith('!') ? 'a' : typed)
    }
  })

  it('TC-DRF-03 a link with a name and password hidden in front of the host stays as text', () => {
    const typed = '[x](https://user:secret@example.test/a)'
    expect(JSON.stringify(markupToRichText(typed))).not.toContain('"link"')
    expect(richTextPlain(markupToRichText(typed))).toBe(typed)
  })

  it('TC-DRF-03 stars used as ordinary characters stay as they are', () => {
    expect(richTextPlain(markupToRichText('2 * 3 * 4'))).toBe('2 * 3 * 4')
  })

  it('TC-DRF-03 a document that is too long says so, and is not blamed on its formatting', () => {
    const long = markupToRichText('word '.repeat(50_000))
    expect(problem({ files: { memo: long } } as Draft, 'memo')?.message).toBe('Memo is too long.')
    expect(problem(withTerms({ custom_terms: long }), 'custom_terms')?.message).toBe('Custom terms are too long.')
    expect(problem({ files: { memo: { type: 'doc', content: [{ type: 'script' }] } } } as Draft, 'memo')?.message).toBe(
      'Memo contains formatting that is not allowed.',
    )
  })

  it('TC-DRF-06 an empty memo is no document', () => {
    expect(markupToRichText('')).toBeNull()
    expect(markupToRichText('  \n \n')).toBeNull()
  })

  it('TC-DRF-03 writing comes back as it was typed, so reopening a draft changes nothing', () => {
    const typed = '# Title\n\n## Sub\n\nA **bold** and *soft* [link](https://example.test/a)\nsecond line\n\n- one\n- two\n\n1. first\n2. second'
    expect(richTextToMarkup(markupToRichText(typed))).toBe(typed)
    expect(markupToRichText(richTextToMarkup(markupToRichText(typed)))).toEqual(markupToRichText(typed))
  })

  it('TC-DRF-03 a stored document the rules refuse shows as nothing', () => {
    expect(richTextToMarkup({ type: 'doc', content: [{ type: 'script' }] })).toBe('')
    expect(richTextToMarkup(undefined)).toBe('')
  })
})
