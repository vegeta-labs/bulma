// Shared by the D3 and D4 browser tests: people, staff with two-step sign-in, a deal made live on screen, qualifying on screen.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { expect, type Browser, type Page } from '@playwright/test'
import pg from 'pg'
import { renderPdf } from '../src/server/pdf.ts'
import { codeAt, stepOf } from '../src/lib/totp.ts'
import { roleUrl, TEST_URL } from '../src/store/testdb.ts'

export const PW = 'a-long-enough-password'
// a real PDF: deal files are checked for a warning cover on upload (decision R26)
export const PDF = { name: 'agreement.pdf', mimeType: 'application/pdf', buffer: await renderPdf([{ text: 'fictional agreement' }], 'Agreement') }

export async function sql<T extends pg.QueryResultRow>(text: string, args: unknown[] = []) {
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  try {
    return (await c.query<T>(text, args)).rows
  } finally {
    await c.end()
  }
}

/** Each deal test starts on the FPO template pack with a fee config of its own. */
export async function dealSetup() {
  await sql('DELETE FROM login_throttle')
  await sql("UPDATE instance_profile SET active_pack_id = (SELECT id FROM regime_pack WHERE key = 'uk-fpo-template' ORDER BY version DESC LIMIT 1)")
  await sql(
    'INSERT INTO fee_config (id, version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, changed_by) SELECT $1, (SELECT coalesce(max(version), 0) + 1 FROM fee_config), 250, 400000, 2000000, 500000000, 10, (SELECT id FROM user_account ORDER BY created_at LIMIT 1)',
    [randomUUID()],
  )
}

let n = 0
export const address = (who: string) => `${who}${Date.now()}${n++}@example.test`

export async function registerHere(page: Page, who: string) {
  const email = address(who)
  await sql('DELETE FROM login_throttle')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('First name').fill('Fay')
  await page.getByLabel('Last name').fill('Fictional')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel(/^Password/).fill(PW)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByTestId('sandbox-link').click()
  await page.getByLabel(/password you chose/).fill(PW)
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.getByRole('link', { name: 'Continue to sign in' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PW)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  return email
}

export async function person(browser: Browser, who: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/')
  const email = await registerHere(page, who)
  return { page, email, context }
}

function fromBase32(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of s.replace(/=+$/, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0')
  const out: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(out)
}

export async function staff(browser: Browser, who: string, roles: string[]) {
  const s = await person(browser, who)
  for (const role of roles) await sql('INSERT INTO role_grant (user_id, role) SELECT id, $2 FROM user_account WHERE email = $1', [s.email, role])
  await s.page.reload()
  await s.page.getByLabel('Your password').fill(PW)
  await s.page.getByRole('button', { name: 'Start' }).click()
  const secret = fromBase32(await s.page.getByTestId('mfa-secret').innerText())
  await s.page.getByLabel('Code from the app').fill(codeAt(secret, stepOf(Date.now())))
  await s.page.getByRole('button', { name: 'Confirm' }).click()
  await s.page.getByRole('button', { name: 'I have kept them' }).click()
  return s
}

export async function addEntity(page: Page, name = 'Fay Fictional') {
  await page.goto('/')
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Add', exact: true }) })
  for (const [k, v] of [
    ['Full name', name],
    ['Address', '1 Seed Street'],
    ['Tax residence', 'UK'],
    ['Tax ID', 'T1'],
  ] as const)
    await form.getByLabel(k, { exact: true }).fill(v)
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByTestId('entity').first()).toBeVisible()
}

export const section = (page: Page, s: string) => page.getByTestId(`section-${s}`).click()
export const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved.')

/** A lead's deal, made on screen, approved by a reviewer on screen and launched (E2E-01). */
/** A live deal; `full: 'stop'` stops at the allocation and opens a waiting list (R-ALO-03, R-ALO-04). */
export async function liveDeal(browser: Browser, opts: { full?: 'stop' } = {}) {
  await sql("UPDATE deal_config SET embed_hosts = ARRAY['decks.example.test'] WHERE id = 1")
  const lead = await person(browser, 'lead')
  await addEntity(lead.page)
  await lead.page.getByRole('link', { name: 'Deals', exact: true }).click()
  await lead.page.getByRole('button', { name: 'Start a deal' }).click()
  const p = lead.page
  await section(p, 'basics')
  await p.getByLabel(/^Legal structure/).selectOption('uk_bare_trust')
  await p.getByLabel(/^Deal type/).selectOption('primary')
  await p.getByLabel(/^Deal name/).fill('Seedling Round')
  await p.getByLabel('A new one').check()
  await p.getByLabel(/^Syndicate name/).fill(`Friends ${Date.now()}`)
  await p.getByLabel(/^Lead entity/).selectOption({ label: 'Fay Fictional' })
  await saved(p)
  await section(p, 'company')
  await p.getByLabel(/^Legal name/).fill('Seedling Ltd')
  await p.getByLabel(/^Contact name/).fill('Sam Founder')
  await p.getByLabel(/^Contact email/).fill(address('company'))
  await p.getByLabel(/^Jurisdiction/).fill('England and Wales')
  await saved(p)
  await section(p, 'terms')
  await p.getByLabel(/^Currency/).selectOption('GBP')
  await p.getByLabel(/^Instrument/).selectOption('equity')
  await p.getByLabel(/^Share price/).fill('0.015')
  await p.getByLabel(/^Pre-money valuation/).fill('5,000,000')
  await p.getByLabel(/^SPV allocation/).fill('300,000')
  if (opts.full === 'stop') await p.getByLabel(/^When the allocation is full/).selectOption('stop_and_waitlist')
  await p.getByLabel(/^Default voter/).selectOption('lead')
  await saved(p)
  await section(p, 'files')
  await p.getByLabel('Add files').setInputFiles(PDF)
  await expect(p.getByTestId('legal-files')).toContainText('agreement.pdf')
  // R-PAGE-01: a deck by link, embedded from a site the operator allows
  await p.getByLabel('A link').check()
  await p.getByLabel(/^Pitch deck link/).fill('https://decks.example.test/view/1')
  await p.getByLabel(/^Embed address/).fill('https://decks.example.test/embed/1')
  await saved(p)
  await section(p, 'economics')
  await p.getByLabel(/^Default carry/).fill('20')
  await p.getByRole('button', { name: 'Add a recipient' }).click()
  const r = p.getByTestId('recipient-0')
  await r.getByLabel(/^Type/).selectOption('person')
  await r.getByLabel(/^First name/).fill('Cara')
  await r.getByLabel(/^Last name/).fill('Carry')
  await r.getByLabel(/^Email/).fill('cara.carry@example.test')
  await r.getByLabel(/^Share of the carry/).fill('100')
  await p.getByLabel(/^Who pays the platform fee/).selectOption('investors')
  await saved(p)
  await section(p, 'review')
  await p.getByTestId('attest-board').check()
  await saved(p)
  await p.getByRole('button', { name: 'Submit for review' }).click()
  await expect(p.getByTestId('deal-state')).toHaveText('With the reviewer')
  const dealId = new URL(p.url()).pathname.split('/').at(-1)!

  const reviewer = await staff(browser, 'reviewer', ['reviewer'])
  await reviewer.page.goto(`/review/${dealId}`)
  await reviewer.page.getByRole('button', { name: 'Approve' }).click()
  await expect(reviewer.page.getByTestId('review-state')).toContainText('Approved')

  await p.reload()
  await p.getByLabel('I confirm this deal should go live').check()
  await p.getByRole('button', { name: 'Go live' }).click()
  await expect(p.getByTestId('deal-state')).toHaveText('Live')
  return { lead, reviewer, dealId }
}

export async function qualifyOnScreen(page: Page, beforeLastStep: () => void = () => undefined) {
  await page.goto('/')
  await page.getByLabel('high net worth').check()
  await page
    .getByRole('group', { name: /Income of the amount/ })
    .getByLabel('Yes')
    .check()
  await page
    .getByRole('group', { name: /Net assets of the amount/ })
    .getByLabel('No')
    .check()
  await page.getByLabel(/Income, to the nearest/).fill('100,000')
  await page.getByLabel(/as your signature/).fill('Fay Fictional')
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  await page.getByRole('button', { name: 'Start the assessment' }).click()
  // the template pack's answer is the first option of every question
  await expect(page.locator('fieldset').first()).toBeVisible()
  for (const group of await page.locator('fieldset').all()) await group.getByRole('radio').first().check()
  await page.getByRole('button', { name: 'Send answers' }).click()
  await expect(page.getByRole('button', { name: 'I have read this' })).toBeVisible()
  beforeLastStep()
  await page.getByRole('button', { name: 'I have read this' }).click()
  await expect(page.getByTestId('qualified')).toBeVisible()
}

export const noSideScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)

/**
 * M-04, the part a machine can check: the screen as it is now, in light and in dark, has every visible text at WCAG AA
 * contrast against what is behind it (4.5:1, large text 3:1; disabled controls are exempt) and every control a screen
 * reader can name. Hearing it with a screen reader stays a person's check. Returns to the browser's own setting after.
 */
export async function readableInBothThemes(page: Page, where: string) {
  const problems: string[] = []
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    const low = await page.evaluate(() => {
      const rgba = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number)
      const lum = ([r = 0, g = 0, b = 0]: number[]) => {
        const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      // the colour behind an element: its own and its ancestors' backgrounds, laid over each other from the page up
      const behind = (el: Element | null): number[] => {
        const layers: number[][] = []
        for (let e = el; e; e = e.parentElement) {
          const c = rgba(getComputedStyle(e).backgroundColor)
          if (c.length >= 3 && (c[3] ?? 1) > 0) {
            layers.push(c)
            if ((c[3] ?? 1) >= 1) break
          }
        }
        let out = rgba(getComputedStyle(document.body).backgroundColor).slice(0, 3)
        for (const c of layers.reverse()) out = out.map((v, i) => (c[i] ?? 0) * (c[3] ?? 1) + v * (1 - (c[3] ?? 1)))
        return out
      }
      const found: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const seen = new Set<Element>()
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const el = t.parentElement
        if (!el || seen.has(el) || !t.textContent?.trim()) continue
        seen.add(el)
        const s = getComputedStyle(el)
        const box = el.getBoundingClientRect()
        if (box.width === 0 || box.height === 0 || s.visibility === 'hidden' || el.closest('[aria-hidden="true"], :disabled, [hidden]')) continue
        if (el.closest('svg, canvas, img')) continue
        const fg = rgba(s.color)
        const bg = behind(el)
        const a = fg[3] ?? 1
        const shown = fg.slice(0, 3).map((v, i) => v * a + (bg[i] ?? 0) * (1 - a))
        const hi = Math.max(lum(shown), lum(bg))
        const lo = Math.min(lum(shown), lum(bg))
        const ratio = (hi + 0.05) / (lo + 0.05)
        const size = parseFloat(s.fontSize)
        const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
        if (ratio < (large ? 3 : 4.5))
          found.push(`${ratio.toFixed(2)}:1 "${t.textContent.trim().slice(0, 40)}" (${s.color} on rgb(${bg.map(Math.round).join(', ')}))`)
      }
      return found
    })
    for (const l of low) problems.push(`${colorScheme}: contrast ${l}`)
  }
  await page.emulateMedia({ colorScheme: null })
  // a screen reader moves by landmarks and headings: one main area with headings in it (pages are sections, each with its own)
  const marks = await page.evaluate(() => ({
    main: document.querySelectorAll('main').length,
    headings: document.querySelectorAll('main :is(h1, h2, h3)').length,
  }))
  if (marks.main !== 1 || marks.headings === 0) problems.push(`landmarks: ${marks.main} main, ${marks.headings} headings in it`)
  // a control or landmark with no name is read out as just "button" or "text field"
  const tree = await page.locator('body').ariaSnapshot()
  for (const line of tree.split('\n')) {
    if (/^\s*- (button|link|textbox|combobox|checkbox|radio|spinbutton|switch|slider|listbox|img|searchbox)(?! ")\b/.test(line))
      problems.push(`no name: ${line.trim()}`)
  }
  expect(problems, `M-04 at ${where}`).toEqual([])
}
