import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { filesOf, notePage, snapshotScript } from '../../scripts/demo-build.ts'
import {
  addressFor,
  answerFor,
  clockInWords,
  DEMO_NO_CHANGE,
  DEMO_NOT_RECORDED,
  fileLinkFor,
  getKey,
  noteKey,
  notesFor,
  parseAddress,
  postKey,
  printedAddress,
  refusalFor,
  type DemoPack,
  type Snapshot,
} from './snapshot.ts'

const snap: Snapshot = {
  format: 1,
  clock: '2026-11-02T10:00:00.000Z',
  views: { investor: { name: 'Son Goku' }, lead: { name: 'Lead' }, reviewer: { name: 'Reviewer' } },
  get: {
    [getKey('lead', '/api/deals/d/panel')]: { status: 200, body: { all: true } },
    [getKey('lead', '/api/deals/d/panel?status=to_pay')]: { status: 200, body: { to_pay: true } },
    [getKey('lead', '/api/deals/d/investors.csv')]: { status: 409, body: { error: 'not allowed' } },
  },
  post: {
    [postKey('investor', '/api/my/deals/d/quote', { commitment_minor: '2500000' })]: { status: 200, body: { due_minor: '2550000' } },
    [postKey('investor', '/api/my/deals/d/quote', { commitment_minor: '1000000' })]: { status: 200, body: { due_minor: '1020000' } },
    [postKey('investor', '/api/my/deals/d/quote', { commitment_minor: '500000' })]: { status: 200, body: { due_minor: '510000' } },
  },
  pages: [],
}

describe('static demo pack: answers and addresses', () => {
  it('TC-DEMO-10 a read is answered by its view, path and query exactly; nothing else is', () => {
    expect(answerFor(snap, 'lead', 'GET', '/api/deals/d/panel')?.body).toEqual({ all: true })
    expect(answerFor(snap, 'lead', 'GET', '/api/deals/d/panel?status=to_pay')?.body).toEqual({ to_pay: true })
    // a filter the export did not record, another view: no answer
    expect(answerFor(snap, 'lead', 'GET', '/api/deals/d/panel?status=funded')).toBeUndefined()
    expect(answerFor(snap, 'investor', 'GET', '/api/deals/d/panel')).toBeUndefined()
  })

  it('TC-DEMO-10 a quote is answered only for a recorded amount, in any key order; any other change never', () => {
    expect(answerFor(snap, 'investor', 'POST', '/api/my/deals/d/quote', { commitment_minor: '1000000' })?.body).toEqual({ due_minor: '1020000' })
    expect(answerFor(snap, 'investor', 'POST', '/api/my/deals/d/quote', { commitment_minor: '700000' })).toBeUndefined()
    expect(answerFor(snap, 'investor', 'POST', '/api/my/deals/d/quote', { commitment_minor: '1000000', replacing: 'p' })).toBeUndefined()
    expect(answerFor(snap, 'lead', 'POST', '/api/my/deals/d/quote', { commitment_minor: '1000000' })).toBeUndefined()
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(answerFor(snap, 'lead', method, '/api/deals/d/panel')).toBeUndefined()
      expect(answerFor(snap, 'investor', method, '/api/my/deals/d/quote', { commitment_minor: '1000000' })).toBeUndefined()
    }
  })

  it('TC-DEMO-10 a quote for another amount names the amounts the pack works out, smallest first; other changes get the demo sentence', () => {
    expect(refusalFor(snap, 'investor', '/api/my/deals/d/quote', { commitment_minor: '700000' })).toBe(
      'Demo: the demo works out what you would pay for £5,000.00, £10,000.00 and £25,000.00 only.',
    )
    // a change of amount is not one of the recorded quotes, whatever amount is typed
    expect(refusalFor(snap, 'investor', '/api/my/deals/d/quote', { commitment_minor: '1000000', replacing: 'p' })).toBe(DEMO_NO_CHANGE)
    expect(refusalFor(snap, 'investor', '/api/my/deals/d/quote')).toBe(DEMO_NO_CHANGE)
    expect(refusalFor(snap, 'lead', '/api/my/deals/d/quote', { commitment_minor: '700000' })).toBe(DEMO_NO_CHANGE)
    expect(refusalFor(snap, 'investor', '/api/my/deals/other/quote')).toBe(DEMO_NO_CHANGE)
    expect(refusalFor(snap, 'investor', '/api/deals/d/submit')).toBe(DEMO_NO_CHANGE)
    expect(DEMO_NO_CHANGE).toBe('Demo: nothing can be changed here.')
  })

  it('TC-DEMO-11 an address is the view and the page of the normal build, and back again', () => {
    expect(addressFor('lead', '/deals/x')).toBe('#/lead/deals/x')
    expect(addressFor('investor', '/')).toBe('#/investor/')
    expect(parseAddress('#/lead/deals/x')).toEqual({ view: 'lead', path: '/deals/x', search: '' })
    expect(parseAddress('#/investor/invite?token=demo-token-1')).toEqual({ view: 'investor', path: '/invite', search: '?token=demo-token-1' })
    expect(parseAddress('#/reviewer')).toEqual({ view: 'reviewer', path: '/', search: '' })
    for (const page of ['/', '/deals/x', '/money/x?import=y', '/invite?token=t'])
      expect(parseAddress(addressFor('reviewer', page))).toEqual({
        view: 'reviewer',
        ...(([p, q]) => ({ path: p, search: q ? `?${q}` : '' }))(page.split('?')),
      })
    // the front door and anything without a known view: none, so the pack opens the investor's home
    for (const bad of ['', '#', '#/', '#/admin/', '#/leads/deals', '#lead/deals', '#/lead/x#y']) expect(parseAddress(bad)).toBeNull()
  })

  it("TC-DEMO-11 a link printed in a file is the pack's address on the site; a full address or another host is refused", () => {
    expect(printedAddress('investor', '/verify-instruction?token=demo-token-8')).toBe('/bulma/demo/#/investor/verify-instruction?token=demo-token-8')
    expect(printedAddress('lead', '/')).toBe('/bulma/demo/#/lead/')
    for (const bad of ['https://bulma.example/verify-instruction?token=t', '//other.example/x', 'verify-instruction'])
      expect(() => printedAddress('investor', bad)).toThrow(/not a page/)
  })

  it('TC-DEMO-09 the banner says when the data is from in words that do not depend on the visitor', () => {
    expect(clockInWords('2026-11-02T10:00:00.000Z')).toBe('2 November 2026, 10:00 UTC')
    expect(clockInWords('2027-01-09T07:05:00.000Z')).toBe('9 January 2027, 07:05 UTC')
  })

  it('TC-DEMO-09 data/snapshot.js sets one frozen object, frozen all the way down, and does nothing else', () => {
    const pack: DemoPack = { ...snap, version: '0.1.0', notes: {} }
    const sandbox: { globalThis?: unknown; BULMA_DEMO?: typeof pack } = {}
    sandbox.globalThis = sandbox
    runInNewContext(snapshotScript(pack), sandbox)
    const got = sandbox.BULMA_DEMO!
    expect(JSON.parse(JSON.stringify(got))).toEqual(pack)
    expect(Object.isFrozen(got)).toBe(true)
    expect(Object.isFrozen(got.get)).toBe(true)
    expect(Object.isFrozen(got.get[getKey('lead', '/api/deals/d/panel')]!.body)).toBe(true)
    expect(Object.keys(sandbox).sort()).toEqual(['BULMA_DEMO', 'globalThis'])
    expect(snapshotScript(pack).split('\n')[0]).toContain('Software demo, not a service, not an offer.')
  })

  it("TC-DEMO-11 a file link goes to the pack's copy, saved under its name; a refused or unrecorded one to a note page of its view", () => {
    const withFiles: Snapshot = {
      ...snap,
      get: {
        ...snap.get,
        [getKey('investor', '/api/my/participations/p/instructions.pdf')]: {
          status: 200,
          file: { path: 'files/0123456789abcdef0123456789abcdef/payment-XW3GSJ.pdf', type: 'application/pdf', name: 'payment-XW3GSJ.pdf' },
        },
        [getKey('investor', '/api/my/deals/d/files/f')]: {
          status: 200,
          file: { path: 'files/fedcba9876543210fedcba9876543210/document.pdf', type: 'application/pdf' },
        },
        [getKey('investor', '/api/my/deals/d/files/gone')]: { status: 404, body: { error: 'No such file.' } },
        [getKey('reviewer', '/api/x')]: { status: 403, body: {} },
      },
    }
    const notes = notesFor(withFiles)
    // each view says "not in the demo"; a view's refusals each get their own page, in a fixed order
    expect(notes).toEqual([
      { view: 'investor', sentence: DEMO_NOT_RECORDED, path: 'data/notes/investor-1.html' },
      { view: 'investor', sentence: 'No such file.', path: 'data/notes/investor-2.html' },
      { view: 'lead', sentence: DEMO_NOT_RECORDED, path: 'data/notes/lead-1.html' },
      { view: 'lead', sentence: 'not allowed', path: 'data/notes/lead-2.html' },
      { view: 'reviewer', sentence: DEMO_NOT_RECORDED, path: 'data/notes/reviewer-1.html' },
    ])
    const pack: DemoPack = { ...withFiles, version: '0.1.0', notes: Object.fromEntries(notes.map((n) => [noteKey(n.view, n.sentence), n.path])) }
    // a file: relative to the pack's page, so it works under /bulma/demo/ and in a new tab; the screen's name wins, else the server's
    expect(fileLinkFor(pack, 'investor', '/api/my/participations/p/instructions.pdf')).toEqual({
      href: 'data/files/0123456789abcdef0123456789abcdef/payment-XW3GSJ.pdf',
      download: 'payment-XW3GSJ.pdf',
    })
    expect(fileLinkFor(pack, 'investor', '/api/my/deals/d/files/f', 'Deck.pdf')).toEqual({
      href: 'data/files/fedcba9876543210fedcba9876543210/document.pdf',
      download: 'Deck.pdf',
    })
    expect(fileLinkFor(pack, 'investor', '/api/my/deals/d/files/f')).toEqual({ href: 'data/files/fedcba9876543210fedcba9876543210/document.pdf' })
    expect(fileLinkFor(pack, 'investor', '/api/my/participations/p/instructions.pdf', 'mine.pdf').download).toBe('mine.pdf')
    // a refusal shows its own words; never a download (the note page would be saved as the file)
    expect(fileLinkFor(pack, 'lead', '/api/deals/d/investors.csv')).toEqual({ href: 'data/notes/lead-2.html' })
    expect(fileLinkFor(pack, 'investor', '/api/my/deals/d/files/gone', 'Deck.pdf')).toEqual({ href: 'data/notes/investor-2.html' })
    // not recorded, recorded for another view only, or a refusal without words: "not in the demo"
    expect(fileLinkFor(pack, 'investor', '/api/my/deals/d/files/other', 'x.pdf')).toEqual({ href: 'data/notes/investor-1.html' })
    expect(fileLinkFor(pack, 'lead', '/api/my/participations/p/instructions.pdf')).toEqual({ href: 'data/notes/lead-1.html' })
    expect(fileLinkFor(pack, 'reviewer', '/api/x')).toEqual({ href: 'data/notes/reviewer-1.html' })
    expect(() => fileLinkFor({ ...pack, notes: {} }, 'lead', '/api/none')).toThrow('no note page for lead')
  })

  it('TC-DEMO-11 a note page says why there is no file and leads back to its view, with no script, style attribute or outside address', () => {
    const page = notePage('lead', 'The operator does not allow leads to export <this> list & "that".')
    expect(page).toContain('<p role="status">The operator does not allow leads to export &lt;this&gt; list &amp; &quot;that&quot;.</p>')
    expect(page).toContain('<a href="../../#/lead/">Back to the demo</a>')
    expect(page).toContain('<meta name="robots" content="noindex" />')
    expect(page).toContain('Demo: fictional data. Software demo, not a service, not an offer.')
    expect(page).not.toMatch(/<script|style=|\son[a-z]+=|https?:/i)
  })

  it('TC-DEMO-11 the build copies each file the snapshot names once, and refuses a path outside files/<hash>/<name>', () => {
    const f = (path: string) => ({ status: 200, file: { path, type: 'application/pdf' } })
    const ok = 'files/0123456789abcdef0123456789abcdef/a.pdf'
    expect(filesOf({ ...snap, get: { a: f(ok), b: f(ok), c: { status: 200, body: {} } } })).toEqual([ok])
    for (const bad of ['files/../../etc/passwd', 'files/0123456789abcdef0123456789abcdef/../x.pdf', '/tmp/x.pdf', 'files/abc/x.pdf', `${ok}/x`])
      expect(() => filesOf({ ...snap, get: { a: f(bad) } })).toThrow('a file path the pack does not take')
  })
})
