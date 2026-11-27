// TC-DEMO-09/10/11 (plan 05 §5.1–§5.5, test plan v0.26): the packed static demo (.demo-pack, scanned by scripts/demo-pack.ts)
// as the website serves it, at /bulma/demo/ with the site's headers (e2e-demo/serve.ts). The pages come from the pack's own
// list in data/snapshot.js, so every page the export recorded is opened; the figures come from the scenario.
import { runInNewContext } from 'node:vm'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { pdfStrings } from '../scripts/demo-export/pack.ts'
import { demoScenario } from '../src/demo/scenario.ts'
import { DEMO_NO_CHANGE, DEMO_NOT_RECORDED, PACK_HOME, parseAddress, VIEWS, type DemoPack, type View } from '../src/demo/snapshot.ts'
import { money } from '../src/lib/dealSheet.ts'
import { SITE_HEADERS } from './serve.ts'

let pack: DemoPack
let origin: string

test.beforeAll(async ({ playwright }) => {
  origin = String(test.info().project.use.baseURL)
  const r = await playwright.request.newContext({ baseURL: origin })
  const g = {} as { BULMA_DEMO?: DemoPack }
  runInNewContext(await (await r.get(`${PACK_HOME}data/snapshot.js`)).text(), { globalThis: g })
  await r.dispose()
  if (!g.BULMA_DEMO) throw new Error('data/snapshot.js set nothing')
  pack = g.BULMA_DEMO
})

const ROLE: Record<View, string> = { investor: 'Investor', lead: 'Lead', reviewer: 'Reviewer' }
const page_ = (n: string) => {
  const p = pack.pages.find((x) => x.n === n)
  if (!p) throw new Error(`the pack has no page ${n}`)
  return p
}

/** What a page does that the site would not allow or a visitor should not see: requests, console errors, CSP violations. */
function watch(page: Page) {
  const seen = { requests: [] as Array<{ url: string; type: string; method: string }>, problems: [] as string[] }
  page.on('request', (r) => seen.requests.push({ url: r.url(), type: r.resourceType(), method: r.method() }))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') seen.problems.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', (e) => seen.problems.push(`page error: ${e.message}`))
  // added by the browser tool, not the page, so the site's CSP does not apply to it
  void page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)),
  )
  return seen
}

/** Requests the site would not serve or the CSP should have stopped: only the pack's own files, and the site's Bulma page. */
const offPack = (requests: Array<{ url: string; type: string; method: string }>) =>
  requests.filter(
    (r) =>
      r.method !== 'GET' ||
      !['document', 'script', 'stylesheet'].includes(r.type) ||
      !(r.url.startsWith(`${origin}${PACK_HOME}`) || r.url === `${origin}/bulma/`),
  )

async function settled(page: Page) {
  await expect(page.locator('#demo-bar')).toBeVisible()
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect(page.getByText('Loading…')).toHaveCount(0)
}

/** A page by its deep link, as a fresh load (from the site, a bookmark or a new tab). */
async function open(page: Page, view: View, path: string) {
  await page.goto('about:blank')
  await page.goto(`${PACK_HOME}#/${view}${path}`)
  await settled(page)
}

async function nothingStored(page: Page, context: BrowserContext) {
  const state = await context.storageState({ indexedDB: true })
  expect(state.cookies).toEqual([])
  expect(state.origins).toEqual([])
  const local = await page.evaluate(async () => ({
    session: sessionStorage.length,
    local: localStorage.length,
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }))
  expect(local).toEqual({ session: 0, local: 0, cookie: '', databases: 0, caches: 0, workers: 0 })
}

test("TC-DEMO-09 / TC-DEMO-01 every page of every view opens under the site's headers: banner, noindex, no request off the pack, no CSP violation, nothing stored", async ({
  page,
  context,
}) => {
  const seen = watch(page)
  const first = await page.goto(PACK_HOME)
  for (const [k, v] of Object.entries(SITE_HEADERS)) expect(first?.headers()[k], k).toBe(v)
  await settled(page)
  // the front door is the investor's home
  expect(parseAddress(new URL(page.url()).hash)).toEqual({ view: 'investor', path: '/', search: '' })
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
  const bar = page.getByRole('region', { name: 'Demo' })
  await expect(bar.locator('p').first()).toHaveText(
    `Demo: fictional data. Software demo, not a service, not an offer. Snapshot v${pack.version}, data as of 2 November 2026, 10:00 UTC. Back to Bulma`,
  )
  const views = page.getByRole('navigation', { name: 'Demo view' }).getByRole('link')
  await expect(views).toHaveText(VIEWS.map((v) => `${ROLE[v]} (${pack.views[v].name})`))

  // the site's list (plan §5.5) is all there, and every view has pages
  for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) page_(n)
  for (const v of VIEWS) expect(pack.pages.filter((p) => p.view === v).length, v).toBeGreaterThan(2)
  for (const p of pack.pages) {
    await test.step(`${p.n}: ${p.view} ${p.what}`, async () => {
      // each page from its address alone, the payment step too (no press first: the site links it; Codex P r1 #9)
      await open(page, p.view, p.path)
      if (p.n === '8') await expect(page.getByTestId('instructions').getByTestId('still-to-pay')).toBeVisible()
      await expect(page.locator('#root')).not.toContainText(DEMO_NOT_RECORDED)
      await expect(page.locator('#root [role="alert"]')).toHaveCount(0)
      await expect(page.locator('#demo-note')).toBeEmpty()
      await expect(views.and(page.locator('[aria-current="page"]'))).toHaveText(`${ROLE[p.view]} (${pack.views[p.view].name})`)
      expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0)
    })
  }
  // a page the export did not record (the draft's money, typed in) is not left blank: the demo note says so (Codex P r1 #11)
  await open(page, 'reviewer', page_('3').path.replace(/^\/deals\//, '/money/'))
  await expect(page.locator('#demo-note')).toHaveText(DEMO_NOT_RECORDED)
  // the same page with a query added: still blank, so the note stays (Codex P r3 #11)
  await page.evaluate(() => (window.location.hash += '?tab=1'))
  await settled(page)
  await expect(page.locator('#demo-note')).toHaveText(DEMO_NOT_RECORDED)
  // another page of the same view, in the same tab: the note was about the page left, and comes back with it (Codex P r2 #11)
  await page.evaluate(() => (window.location.hash = '#/reviewer/ops'))
  await settled(page)
  await expect(page.locator('#demo-note')).toBeEmpty()
  await page.goBack()
  await expect(page.locator('#demo-note')).toHaveText(DEMO_NOT_RECORDED)
  await nothingStored(page, context)

  // the payment step's link and the deal page in one tab, back and forward: each shows what its address says (Codex P r2 #10)
  const paid = () => page.getByTestId('instructions').getByTestId('still-to-pay')
  await open(page, 'investor', page_('6').path)
  await expect(page.getByTestId('instructions')).toHaveCount(0)
  await page.evaluate((h) => (window.location.hash = h), `#/investor${page_('8').path}`)
  await settled(page)
  await expect(paid()).toBeVisible()
  await page.goBack()
  await settled(page)
  await expect(page.getByTestId('instructions')).toHaveCount(0)
  await page.goForward()
  await settled(page)
  await expect(paid()).toBeVisible()
  // by way of the app's own links (no hashchange): Home, then the deal, then the payment step's link typed (Codex P r3 #10)
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await page.getByRole('link', { name: 'Senzu Labs' }).first().click()
  await settled(page)
  await expect(page.getByTestId('instructions')).toHaveCount(0)
  await page.evaluate((h) => (window.location.hash = h), `#/investor${page_('8').path}`)
  await settled(page)
  await expect(paid()).toBeVisible()

  // the banner's way back is the site's Bulma page
  await open(page, 'lead', '/')
  await bar.getByRole('link', { name: 'Back to Bulma' }).click()
  await expect(page).toHaveURL(`${origin}/bulma/`)

  expect(seen.problems).toEqual([])
  expect(offPack(seen.requests)).toEqual([])
  expect(seen.requests.filter((r) => r.type === 'document').length).toBeGreaterThan(pack.pages.length)
})

// The pack's figures do not depend on who looks: a London visitor on the snapshot's day, and one in another language, a time
// zone a day ahead and years later. Dates in the app's history lists follow the visitor's language and zone, as in the app.
const VISITORS = [
  { who: 'London, on the day', locale: 'en-GB', timezoneId: 'Europe/London', at: '2026-11-02T10:00:00Z' },
  { who: 'US English, UTC+14, years later', locale: 'en-US', timezoneId: 'Pacific/Kiritimati', at: '2029-03-01T23:30:00Z' },
]
for (const visitor of VISITORS) {
  test.describe(`a visitor in ${visitor.who}`, () => {
    test.use({ locale: visitor.locale, timezoneId: visitor.timezoneId })

    test("TC-DEMO-09 the scenario's figures and days, unchanged after reading again and after the files are made", async ({ page, context }) => {
      await page.clock.setFixedTime(visitor.at)
      const seen = watch(page)
      const s = demoScenario
      const live = page_('4')
      const WORDS = {
        to_pay: ['To pay', 'The investor'],
        to_sign: ['To sign', 'The investor'],
        kyc_in_review: ['Verifying', 'A reviewer'],
        funded: ['Funded', 'Nobody'],
      } as const
      const item = (scope: ReturnType<Page['locator']>, words: string) =>
        scope
          .locator('div')
          .filter({ has: page.locator('dt', { hasText: new RegExp(`^${words}$`) }) })
          .locator('dd')

      const leadList = async () => {
        await open(page, 'lead', live.path)
        const panel = page.getByTestId('lead-panel')
        const figures = panel.getByTestId('figures')
        await expect(item(figures, 'Committed')).toHaveText(
          money(
            s.investors.reduce((n, x) => n + x.commitmentMinor, 0n),
            'GBP',
          ),
        )
        await expect(item(figures, 'Committed')).toHaveText('£55,000.00')
        await expect(item(figures, 'Received')).toHaveText('£15,300.00')
        await expect(item(figures, 'Lead fees')).toHaveText('£300.00')
        const rows = panel.getByTestId('panel-row')
        await expect(rows.locator('.panel-head strong')).toHaveText(['Son Goku', 'Yamcha', 'Krillin', 'Tien'])
        for (const x of s.investors) {
          const row = rows.filter({ has: page.locator('.panel-head strong', { hasText: new RegExp(`^${x.name}$`) }) })
          await expect(row.getByTestId('row-status')).toHaveText(WORDS[x.stage][0])
          await expect(row.getByTestId('row-waiting')).toHaveText(WORDS[x.stage][1])
          await expect(item(row, 'Days at this step')).toHaveText(String(x.daysAtStep))
          await expect(item(row, 'Commitment')).toHaveText(money(x.commitmentMinor, 'GBP'))
        }
        await expect(rows.locator('dd').filter({ hasText: /^\d+$/ })).toHaveText(['1', '4', '2', '3'])
        return panel.innerText()
      }
      const payment = async () => {
        await open(page, 'investor', page_('8').path)
        const pay = page.getByTestId('instructions')
        await expect(pay.getByTestId('still-to-pay')).toHaveText('Still to pay: £10,200.00')
        const parts = pay.getByTestId('pay-breakdown')
        await expect(item(parts, 'Investment part \\(before the platform fee\\)')).toHaveText('£10,000.00')
        await expect(item(parts, 'Lead fee')).toHaveText('£200.00')
        await expect(item(parts, 'Total commitment: the amount to pay')).toHaveText('£10,200.00')
        await expect(item(pay, 'Received so far')).toHaveText('£0.00')
        return pay.innerText()
      }
      const banner = () => page.getByRole('region', { name: 'Demo' }).locator('p').first().innerText()

      const lead1 = await leadList()
      const time1 = await banner()
      expect(time1).toContain('data as of 2 November 2026, 10:00 UTC')
      const pay1 = await payment()
      // read again: a reload, and the pages in another order
      await page.reload()
      await settled(page)
      expect(await leadList()).toBe(lead1)
      expect(await payment()).toBe(pay1)
      // the files: the payment details PDF, the signed deal sheet, the lead's list
      const saved: string[] = []
      for (const name of ['Download as PDF', 'Signed deal sheet']) {
        const [d] = await Promise.all([page.waitForEvent('download'), page.locator('#root').getByRole('link', { name, exact: true }).first().click()])
        saved.push(d.suggestedFilename())
      }
      expect(saved).toEqual([expect.stringMatching(/^payment-[A-Z0-9]+\.pdf$/), expect.stringMatching(/\.pdf$/)])
      expect(await leadList()).toBe(lead1)
      await page.locator('#root').getByRole('link', { name: 'Download this list (CSV)' }).click()
      await expect(page.locator('body')).toContainText('The operator does not allow leads to export this list.')
      expect(await leadList()).toBe(lead1)
      expect(await payment()).toBe(pay1)
      expect(await banner()).toBe(time1)

      await nothingStored(page, context)
      expect(seen.problems).toEqual([])
      expect(offPack(seen.requests)).toEqual([])
    })
  })
}

test('TC-DEMO-10 / TC-DEMO-01 every button on every page: nothing is sent, a change gets the demo sentence, nothing says it was saved', async ({ page }) => {
  const seen = watch(page)
  // what the app says after a change went through; none may appear in the pack
  const success = /^(Saved\b|Sent\b|Recorded\b|Copied\b|Removed\b|Approved\b|Done\b|Signed out\b)/
  const lines = async () =>
    new Set(
      (await page.locator('#root').innerText())
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
  let clicked = 0
  for (const p of pack.pages) {
    await open(page, p.view, p.path)
    const shown = await lines()
    const at = page.url()
    const buttons = page.locator('#root button')
    const n = await buttons.count()
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i)
      if (!(await b.isVisible()) || !(await b.isEnabled())) continue
      const name = (await b.innerText()).replace(/\s+/g, ' ').trim()
      await b.click()
      clicked++
      await page.waitForTimeout(80)
      expect(page.url(), `${p.n} ${name}`).toBe(at)
      const fresh = [...(await lines())].filter((l) => !shown.has(l))
      expect(
        fresh.filter((l) => success.test(l)),
        `${p.n} ${name}`,
      ).toEqual([])
      for (const l of fresh) shown.add(l)
    }
  }
  expect(clicked).toBeGreaterThan(100)

  // the changes the site shows: each says the sentence where everyone sees it, and the screen keeps what it showed
  for (const [n, name] of [
    ['2', 'Approve'],
    ['4', 'Turn off'],
    ['deals-lead', 'Start a deal'],
    ['home-investor', 'Sign out'],
  ] as const) {
    const p = page_(n)
    await open(page, p.view, p.path)
    await page.locator('#root').getByRole('button', { name, exact: true }).first().click()
    await expect(page.locator('#demo-note')).toHaveText(DEMO_NO_CHANGE)
    await expect(page.locator('#root')).toContainText(DEMO_NO_CHANGE)
    await expect(page.locator('header')).toContainText(pack.views[p.view].name)
  }
  expect(seen.problems).toEqual([])
  expect(offPack(seen.requests)).toEqual([])
  expect(seen.requests.filter((r) => r.type === 'fetch' || r.type === 'xhr')).toEqual([])
})

test('TC-DEMO-10 / TC-DEMO-01 a quote for a recorded amount is answered, another amount gets the sentence; file choosers never open or read', async ({
  page,
}) => {
  const seen = watch(page)
  await open(page, 'investor', page_('6').path)
  const commit = page.getByTestId('commit')
  for (const [typed, due] of [
    ['10000', '£10,200.00'],
    ['5000', '£5,100.00'],
    ['25000', '£25,500.00'],
  ] as const) {
    await commit.getByLabel(/Amount/).fill(typed)
    await commit.getByRole('button', { name: 'Show what I would pay' }).click()
    await expect(commit.getByTestId('quote')).toContainText(due)
  }
  await commit.getByLabel(/Amount/).fill('7000')
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  const only = 'Demo: the demo works out what you would pay for £5,000.00, £10,000.00 and £25,000.00 only.'
  await expect(page.locator('#demo-note')).toHaveText(only)
  await expect(commit).toContainText(only)
  await expect(commit.getByTestId('quote')).toHaveCount(0)

  // the lists' filters show what the real page showed for each choice (all recorded, plan §5.2)
  const stage = Object.fromEntries(demoScenario.investors.map((x) => [x.name, x.stage]))
  const STATUS = { to_pay: 'to_pay', to_sign: 'to_sign', kyc_in_review: 'verifying', funded: 'funded' } as const
  const WAITING = { to_pay: 'investor', to_sign: 'investor', kyc_in_review: 'reviewer', funded: 'none' } as const
  for (const [view, n] of [
    ['lead', '4'],
    ['reviewer', 'ops-live'],
  ] as const) {
    await open(page, view, page_(n).path)
    const panel = page.getByTestId('lead-panel')
    const status = panel.getByLabel('Status')
    const waiting = panel.getByLabel('Waiting on')
    const names = panel.getByTestId('panel-row').locator('.panel-head strong')
    const want = (s: string, w: string) =>
      demoScenario.investors.filter((x) => (!s || STATUS[stage[x.name]!] === s) && (!w || WAITING[stage[x.name]!] === w)).map((x) => x.name)
    const statuses = await status.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))
    const waits = await waiting.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))
    expect(statuses.length).toBeGreaterThan(4)
    expect(waits.length).toBeGreaterThan(3)
    for (const s of statuses)
      for (const w of waits) {
        await status.selectOption(s)
        await waiting.selectOption(w)
        await expect(names, `${view} ${s}/${w}`).toHaveText(want(s, w))
      }
    await expect(page.locator('#root')).not.toContainText(DEMO_NOT_RECORDED)
  }

  // file choosers: a click never opens one, a file set anyway is dropped unread, a drop is never read
  let choosers = 0
  page.on('filechooser', () => choosers++)
  const withFiles: Array<[string, string]> = []
  for (const p of pack.pages) {
    await open(page, p.view, p.path)
    for (const c of p.click ?? []) await page.locator('#root').getByRole('button', { name: c, exact: true }).click()
    // open every form a button opens (in the pack a button changes nothing, the test above), so hidden choosers show
    const buttons = page.locator('#root button')
    for (let i = 0, n = await buttons.count(); i < n; i++) {
      const b = buttons.nth(i)
      if ((await b.isVisible()) && (await b.isEnabled())) await b.click()
    }
    const inputs = page.locator('#root input[type="file"]')
    const count = await inputs.count()
    if (!count) continue
    withFiles.push([p.n, String(count)])
    await page.evaluate(() => {
      const w = window as unknown as { read: number }
      w.read = 0
      const count = () => w.read++
      for (const m of ['text', 'arrayBuffer', 'stream', 'bytes'] as const) {
        const was = Blob.prototype[m] as (...a: unknown[]) => unknown
        Object.defineProperty(Blob.prototype, m, {
          configurable: true,
          value: function (this: Blob, ...a: unknown[]) {
            count()
            return was.apply(this, a)
          },
        })
      }
      const fr = FileReader.prototype
      for (const m of ['readAsText', 'readAsArrayBuffer', 'readAsDataURL', 'readAsBinaryString'] as const) {
        const was = fr[m] as (...a: unknown[]) => unknown
        Object.defineProperty(fr, m, {
          configurable: true,
          value: function (this: FileReader, ...a: unknown[]) {
            count()
            return was.apply(this, a)
          },
        })
      }
    })
    // every chooser on the page, the ones a button opened included
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i)
      if (await input.isVisible()) {
        await input.click()
        await expect(page.locator('#demo-note')).toHaveText(DEMO_NO_CHANGE)
      }
      await input.setInputFiles({ name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from('date,amount\n2026-11-01,10200.00\n') })
      await expect(page.locator('#demo-note')).toHaveText(DEMO_NO_CHANGE)
      expect(await input.evaluate((e) => (e as HTMLInputElement).files?.length ?? 0), `${p.n} chooser ${i + 1}`).toBe(0)
      await input.evaluate((e) => {
        const t = new DataTransfer()
        t.items.add(new File(['x'], 'drop.pdf', { type: 'application/pdf' }))
        e.dispatchEvent(new DragEvent('drop', { dataTransfer: t, bubbles: true, cancelable: true }))
      })
    }
    await page.waitForTimeout(150)
    expect(await page.evaluate(() => (window as unknown as { read: number }).read), p.n).toBe(0)
  }
  expect(withFiles.length, 'pages with a file chooser').toBeGreaterThan(0)
  expect(choosers).toBe(0)
  expect(seen.problems).toEqual([])
  expect(offPack(seen.requests)).toEqual([])
})

test('TC-DEMO-11 links: deep link, refresh, back, new tab, downloads and the link printed in the PDF all work under /bulma/demo/', async ({
  page,
  context,
}) => {
  const seen = watch(page)
  // every link on every page, from the pages themselves
  const links = new Map<string, { from: string; download: string | null; text: string }>()
  for (const p of pack.pages) {
    await open(page, p.view, p.path)
    for (const c of p.click ?? []) await page.locator('#root').getByRole('button', { name: c, exact: true }).click()
    for (const a of await page
      .locator('a[href]')
      .evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href')!, download: a.getAttribute('download'), text: (a.textContent ?? '').trim() }))))
      if (!links.has(a.href)) links.set(a.href, { from: p.n, download: a.download, text: a.text })
  }
  const kinds = { page: [] as string[], file: [] as string[], note: [] as string[], back: [] as string[], other: [] as string[] }
  for (const href of links.keys()) {
    if (href.startsWith('#/')) kinds.page.push(href)
    else if (/^data\/files\/[0-9a-f]{32}\/[^/]+$/.test(href)) kinds.file.push(href)
    else if (/^data\/notes\/(investor|lead|reviewer)-\d+\.html$/.test(href)) kinds.note.push(href)
    else if (href === '../') kinds.back.push(href)
    else kinds.other.push(`${href} (on ${links.get(href)!.from})`)
  }
  expect(kinds.other).toEqual([])
  expect(kinds.file.length).toBeGreaterThan(5)
  expect(kinds.note.length).toBeGreaterThan(0)

  // every page link, in a new tab: it opens, as a page of the pack or with the demo sentence
  const tab = await context.newPage()
  const tabSeen = watch(tab)
  for (const href of kinds.page) {
    expect(parseAddress(href), href).not.toBeNull()
    await tab.goto(`${PACK_HOME}${href}`)
    await settled(tab)
    const alerts = await tab.locator('#root [role="alert"]').allInnerTexts()
    expect(
      alerts.filter((t) => t.trim() !== DEMO_NOT_RECORDED),
      href,
    ).toEqual([])
  }
  // every file: served as itself; a download saves it under its name, with the same bytes
  for (const href of kinds.file) {
    const got = await page.request.get(`${PACK_HOME}${href}`)
    expect(got.status(), href).toBe(200)
    // saved under a name: the file's own, or the name the screen shows for it
    const name = decodeURIComponent(href.split('/').pop()!)
    expect(links.get(href)!.download, href).toMatch(new RegExp(`\\.${name.split('.').pop()}$`))
    expect(got.headers()['content-type'], href).toBe(
      { pdf: 'application/pdf', json: 'application/json', csv: 'text/csv; charset=utf-8' }[name.split('.').pop()!] ?? 'missing',
    )
  }
  const file = kinds.file.find((h) => /payment-[A-Z0-9]+\.pdf$/.test(h))!
  const from = page_(links.get(file)!.from)
  await open(page, from.view, from.path)
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator(`#root a[href="${file}"]`).first().click()])
  expect(download.suggestedFilename()).toBe(links.get(file)!.download)
  const bytes = await (await page.request.get(`${PACK_HOME}${file}`)).body()
  const { readFileSync } = await import('node:fs')
  expect(readFileSync((await download.path())!).equals(bytes)).toBe(true)

  // every note page: plain, says the sentence, leads back to its view
  for (const href of kinds.note) {
    await tab.goto(`${PACK_HOME}${href}`)
    await expect(tab.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
    await expect(tab.locator('body')).toContainText(/^Demo: |does not allow/m)
    const back = tab.getByRole('link').last()
    await back.click()
    await settled(tab)
    const view = /notes\/(\w+)-/.exec(href)![1]
    expect(parseAddress(new URL(tab.url()).hash)?.view, href).toBe(view)
  }

  // links printed in the PDFs: only the pack's own addresses, and each opens its page
  const printed = new Set<string>()
  for (const href of kinds.file.filter((h) => h.endsWith('.pdf'))) {
    const text = await pdfStrings(await (await page.request.get(`${PACK_HOME}${href}`)).body())
    expect(text.match(/https?:\/\/\S+|\/api\/\S+/g) ?? [], href).toEqual([])
    for (const m of text.matchAll(/\S*token=\S*/g))
      expect(m[0], href).toMatch(new RegExp(`^${PACK_HOME.replaceAll('/', '\\/')}#\\/(investor|lead|reviewer)\\/`))
    for (const m of text.matchAll(/\/bulma\/demo\/\S*/g)) printed.add(m[0])
  }
  expect(printed.size).toBe(1)
  for (const addr of printed) {
    await tab.goto(addr)
    await settled(tab)
    await expect(tab.getByTestId('verify-result')).toContainText('Still valid')
  }
  await tab.close()

  // in the app: follow links, then back, forward and refresh; the payment check link (it carries a token) and back
  await open(page, 'lead', '/')
  await page.locator('#root nav').getByRole('link', { name: 'Deals', exact: true }).click()
  await expect(page).toHaveURL(/#\/lead\/deals$/)
  await page.locator('#root').getByRole('link', { name: 'Senzu Labs round' }).first().click()
  await expect(page).toHaveURL(new RegExp(`#/lead${page_('4').path}$`))
  await expect(page.getByTestId('lead-panel')).toBeVisible()
  await page.reload()
  await settled(page)
  await expect(page.getByTestId('lead-panel')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/#\/lead\/deals$/)
  await expect(page.locator('#root')).toContainText('Senzu Labs round')
  await page.goForward()
  await expect(page.getByTestId('lead-panel')).toBeVisible()
  // to another view and back again: each is that view's own load
  await page
    .getByRole('navigation', { name: 'Demo view' })
    .getByRole('link', { name: /^Investor/ })
    .click()
  await settled(page)
  await expect(page.locator('header')).toContainText(pack.views.investor.name)
  await page.goBack()
  await settled(page)
  await expect(page.locator('header')).toContainText(pack.views.lead.name)
  await expect(page.getByTestId('lead-panel')).toBeVisible()

  await open(page, 'investor', page_('8').path)
  await page.getByTestId('instructions').getByRole('link', { name: 'Check these details' }).click()
  await settled(page)
  await expect(page.getByTestId('verify-result')).toContainText('Still valid')
  await page.goBack()
  await settled(page)
  await expect(page).toHaveURL(new RegExp(`#/investor${page_('8').path.replace(/[?]/g, '\\?')}$`))
  // the same check from the card opened by its button (no step in the address): the token alone makes the page load again
  await open(page, 'investor', page_('6').path)
  await page.getByRole('button', { name: 'Payment details' }).click()
  await page.getByTestId('instructions').getByRole('link', { name: 'Check these details' }).click()
  await settled(page)
  await expect(page.getByTestId('verify-result')).toContainText('Still valid')

  expect([...seen.problems, ...tabSeen.problems]).toEqual([])
  expect(offPack([...seen.requests, ...tabSeen.requests]).filter((r) => !/data\/files\//.test(r.url))).toEqual([])
})
