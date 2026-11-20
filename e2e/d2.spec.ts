// D2 on screen: the wizard, review, content approval, launch, syndicates and the company's page. Every step goes through what a person sees.
import { readFileSync } from 'node:fs'
import { renderPdf } from '../src/server/pdf.ts'
import { randomUUID } from 'node:crypto'
import { expect, test, type Browser, type Page } from '@playwright/test'
import pg from 'pg'
import { codeAt, stepOf } from '../src/lib/totp.ts'
import { roleUrl, TEST_URL } from '../src/store/testdb.ts'

const PW = 'a-long-enough-password'
// a real PDF: deal files are checked for a warning cover on upload (decision R26)
const PDF = { name: 'agreement.pdf', mimeType: 'application/pdf', buffer: await renderPdf([{ text: 'fictional agreement' }], 'Agreement') }
const fileNamed = (name: string) => ({ ...PDF, name })

async function sql<T extends pg.QueryResultRow>(text: string, args: unknown[] = []) {
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  try {
    return (await c.query<T>(text, args)).rows
  } finally {
    await c.end()
  }
}

async function ready() {
  await sql('DELETE FROM login_throttle')
  await sql(
    'INSERT INTO fee_config (id, version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, changed_by) SELECT $1, (SELECT coalesce(max(version), 0) + 1 FROM fee_config), 250, 400000, 2000000, 500000000, 10, (SELECT id FROM user_account ORDER BY created_at LIMIT 1)',
    [randomUUID()],
  )
}

let n = 0
const address = (who: string) => `${who}${Date.now()}${n++}@example.test`

async function register(page: Page, who: string, first = 'Fay') {
  const email = address(who)
  await sql('DELETE FROM login_throttle')
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('First name').fill(first)
  await page.getByLabel('Last name').fill('Fictional')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel(/^Password/).fill(PW)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByTestId('sandbox-link').click()
  await page.getByLabel(/password you chose/).fill(PW)
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.getByRole('link', { name: 'Continue to sign in' }).click()
  return email
}

async function signIn(page: Page, email: string) {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PW)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** A new person in a window of their own, signed in. */
async function person(browser: Browser, who: string, first?: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = await register(page, who, first)
  await signIn(page, email)
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
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

/** Someone with a role sets up two-step before anything else. */
async function staff(browser: Browser, who: string, roles: string[], first?: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = await register(page, who, first)
  for (const role of roles) await sql('INSERT INTO role_grant (user_id, role) SELECT id, $2 FROM user_account WHERE email = $1', [email, role])
  await signIn(page, email)
  await page.getByLabel('Your password').fill(PW)
  await page.getByRole('button', { name: 'Start' }).click()
  const secret = fromBase32(await page.getByTestId('mfa-secret').innerText())
  await page.getByLabel('Code from the app').fill(codeAt(secret, stepOf(Date.now())))
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.getByRole('button', { name: 'I have kept them' }).click()
  return { page, email, context }
}

async function addEntity(page: Page) {
  await page.goto('/')
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Add', exact: true }) })
  for (const [k, v] of [
    ['Full name', 'Fay Fictional'],
    ['Address', '1 Seed Street'],
    ['Tax residence', 'UK'],
    ['Tax ID', 'T1'],
  ] as const)
    await form.getByLabel(k, { exact: true }).fill(v)
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByTestId('entity')).toBeVisible()
}

const section = (page: Page, s: string) => page.getByTestId(`section-${s}`).click()
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved.')

async function startDeal(page: Page) {
  await page.getByRole('link', { name: 'Deals', exact: true }).click()
  await page.getByRole('button', { name: 'Start a deal' }).click()
  await expect(page.getByTestId('section-basics')).toBeVisible()
  return new URL(page.url()).pathname.split('/').at(-1)!
}

async function fillDeal(page: Page, contact: string, name = 'Seedling Round') {
  await section(page, 'basics')
  await page.getByLabel(/^Legal structure/).selectOption('uk_bare_trust')
  await page.getByLabel(/^Deal type/).selectOption('primary')
  await page.getByLabel(/^Deal name/).fill(name)
  await page.getByLabel('A new one').check()
  await page.getByLabel(/^Syndicate name/).fill(`Friends of ${name}`)
  await page.getByLabel(/^Lead entity/).selectOption({ label: 'Fay Fictional' })
  await saved(page)
  await section(page, 'company')
  await page.getByLabel(/^Legal name/).fill('Seedling Ltd')
  await page.getByLabel(/^Contact name/).fill('Sam Founder')
  await page.getByLabel(/^Contact email/).fill(contact)
  await page.getByLabel(/^Jurisdiction/).fill('England and Wales')
  await saved(page)
  await section(page, 'terms')
  await page.getByLabel(/^Currency/).selectOption('GBP')
  await page.getByLabel(/^Instrument/).selectOption('equity')
  await page.getByLabel(/^Share price/).fill('0.015')
  await page.getByLabel(/^Pre-money valuation/).fill('5,000,000')
  await page.getByLabel(/^SPV allocation/).fill('300,000')
  await page.getByLabel(/^Default voter/).selectOption('lead')
  await saved(page)
  await section(page, 'files')
  await page.getByLabel('Add files').setInputFiles(PDF)
  await expect(page.getByTestId('legal-files')).toContainText('agreement.pdf')
  await section(page, 'economics')
  await page.getByLabel(/^Default carry/).fill('20')
  await page.getByRole('button', { name: 'Add a recipient' }).click()
  const r = page.getByTestId('recipient-0')
  await r.getByLabel(/^Type/).selectOption('person')
  await r.getByLabel(/^First name/).fill('Cara')
  await r.getByLabel(/^Last name/).fill('Carry')
  await r.getByLabel(/^Email/).fill('cara.carry@example.test')
  await r.getByLabel(/^Share of the carry/).fill('100')
  await page.getByLabel(/^Who pays the platform fee/).selectOption('lead')
  await saved(page)
  await section(page, 'review')
  await page.getByTestId('attest-board').check()
  await saved(page)
  await expect(page.getByTestId('gaps')).toContainText('Nothing is missing.')
}

async function mailBody(to: string) {
  await expect.poll(async () => (await sql('SELECT 1 FROM sandbox_outbox WHERE lower(to_address) = lower($1)', [to])).length).toBeGreaterThan(0)
  return (await sql<{ body: string }>('SELECT body FROM sandbox_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at DESC LIMIT 1', [to]))[0]!.body
}
const linkIn = (body: string) => {
  const u = new URL(/https?:\/\/\S+|\/\S*token=\S+/.exec(body)![0], 'http://127.0.0.1:4318')
  return `${u.pathname}${u.search}`
}

test.beforeEach(ready)

test('TC-DRF-06 sections open in any order, each says if it is finished, what is typed survives a reload, and a phone needs no sideways scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 })
  const email = await register(page, 'wizard')
  await signIn(page, email)
  await startDeal(page)
  // straight to the fifth section, with nothing done before it
  await section(page, 'economics')
  await expect(page.getByRole('heading', { name: 'Economics' })).toBeVisible()
  await section(page, 'company')
  await page.getByLabel(/^Legal name/).fill('Seedling Ltd')
  await saved(page)
  await page.getByLabel(/^Contact name/).fill('Sam Founder')
  await page.getByLabel(/^Contact email/).fill('sam@example.test')
  await expect(page.getByTestId('section-company')).toContainText('to finish')
  await page.getByLabel(/^Jurisdiction/).fill('Scotland')
  await saved(page)
  await expect(page.getByTestId('section-company')).toContainText('done')
  await expect(page.getByTestId('section-basics')).toContainText('to finish')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await page.reload()
  await section(page, 'company')
  await expect(page.getByLabel(/^Legal name/)).toHaveValue('Seedling Ltd')
  await section(page, 'review')
  // nothing is locked; the review says what is missing and can take you there
  const gaps = page.getByTestId('gaps')
  await expect(gaps).toContainText('Deal name is required.')
  await expect(gaps).toContainText('Upload at least one investment agreement')
  await page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(page.getByRole('alert')).toContainText('Deal name')
  await expect(page.getByTestId('deal-state')).toHaveText('Draft')
  await gaps.getByRole('button', { name: 'Terms' }).click()
  await expect(page.getByLabel(/^Currency/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
})

test('TC-DRF-01 a wrong value is saved and answered in the words the rules use; required fields carry a star', async ({ page }) => {
  const email = await register(page, 'errors')
  await signIn(page, email)
  await startDeal(page)
  await expect(page.locator('label', { hasText: 'Deal name' })).toContainText('Deal name *')
  await section(page, 'company')
  await page.getByLabel(/^Website/).fill('http://seedling.example')
  await expect(page.getByTestId('error-website')).toHaveText('Website must be a secure web address, starting with https.')
  await section(page, 'terms')
  await page.getByLabel(/^SPV allocation/).fill('300,000')
  await page.getByLabel(/^Minimum raise/).fill('400,000')
  await expect(page.getByTestId('error-min_raise_minor')).toHaveText('Minimum raise cannot be above the SPV allocation.')
  await page.getByLabel(/^Payment deadline/).fill('2020-01-01')
  await expect(page.getByTestId('error-pay_by')).toHaveText('Payment deadline must be a real date after today.')
  await page.getByLabel(/^SPV allocation/).fill('lots')
  await expect(page.getByTestId('error-allocation_minor')).toContainText('SPV allocation must be')
  await saved(page)
  await page.reload()
  await section(page, 'terms')
  // what was typed is still there, for the person to correct
  await expect(page.getByLabel(/^SPV allocation/)).toHaveValue('lots')
})

test('TC-DRF-02 each instrument asks for its own fields, and a price of 0.015 is the same after a reload', async ({ page }) => {
  const email = await register(page, 'instrument')
  await signIn(page, email)
  await startDeal(page)
  await section(page, 'terms')
  await expect(page.getByLabel(/^Share price/)).toHaveCount(0)
  await page.getByLabel(/^Instrument/).selectOption('safe')
  await expect(page.getByLabel(/^Valuation cap type/)).toBeVisible()
  await expect(page.getByLabel(/^Share price/)).toHaveCount(0)
  await page.getByLabel(/^Instrument/).selectOption('fund_units')
  await expect(page.getByLabel(/^Fund description/)).toBeVisible()
  await page.getByLabel(/^Instrument/).selectOption('equity')
  await page.getByTestId('placeholder-price').check()
  await expect(page.getByLabel(/^Share price/)).toHaveValue('1.00')
  await expect(page.getByTestId('notice-placeholder_price')).toBeVisible()
  await page.getByTestId('placeholder-price').uncheck()
  await page.getByLabel(/^Share price/).fill('0.015')
  await page.getByLabel(/^Pre-money valuation/).fill('999')
  await expect(page.getByTestId('error-pre_money_minor')).toContainText('at least 1,000')
  await saved(page)
  await page.reload()
  await section(page, 'terms')
  await expect(page.getByLabel(/^Share price/)).toHaveValue('0.015')
  const id = new URL(page.url()).pathname.split('/').at(-1)!
  expect((await sql<{ p: string }>("SELECT draft->'terms'->>'share_price_micros' AS p FROM deal WHERE id = $1", [id]))[0]!.p).toBe('15000')
})

test('TC-DRF-03 documents: added to a folder, a wrong type refused, removal, a warning for an outside link, and only the allowed sites to embed', async ({
  page,
}) => {
  const email = await register(page, 'files')
  await signIn(page, email)
  await startDeal(page)
  await section(page, 'files')
  await page.getByLabel('New folder').fill('Round documents')
  await page.getByRole('button', { name: 'Add the folder' }).click()
  await page.getByLabel('Put new files in').selectOption({ label: 'Round documents' })
  await page.getByLabel('Add files').setInputFiles([fileNamed('one.pdf'), fileNamed('two.pdf')])
  const files = page.getByTestId('legal-files')
  await expect(files).toContainText('one.pdf')
  await expect(files).toContainText('two.pdf')
  await expect(files).toContainText('in Round documents')
  await page.getByLabel('Add files').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('not a document at all') })
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Remove one.pdf' }).click()
  await expect(files).not.toContainText('one.pdf')
  await page.getByLabel('A link', { exact: true }).check()
  await page.getByLabel('Pitch deck link').fill('https://decks.example.test/ours')
  await expect(page.getByTestId('notice-external_deck')).toContainText('not behind the eligibility steps')
  await page.getByLabel('Embed address').fill('https://elsewhere.example.test/embed')
  await expect(page.getByTestId('error-deck.embed_url')).toContainText('on a site the operator allows')
})

test('TC-DRF-05 who pays: choosing investors says the fee is an estimate, and a fee that eats the allocation stops it', async ({ page }) => {
  const email = await register(page, 'payer')
  await signIn(page, email)
  await startDeal(page)
  await section(page, 'terms')
  await page.getByLabel(/^SPV allocation/).fill('3,000')
  await saved(page)
  await section(page, 'economics')
  await expect(page.getByTestId('fee-summary')).toContainText('2.5%, at least 4,000 and at most 20,000')
  await page.getByLabel(/^Who pays the platform fee/).selectOption('investors')
  await expect(page.getByTestId('notice-fee_estimate')).toBeVisible()
  await expect(page.getByTestId('notice-min_raise_helps')).toBeVisible()
  await expect(page.getByTestId('error-fee_payer')).toContainText('could never close')
  await page.getByLabel('Try an amount raised').fill('1,000,000')
  await expect(page.getByTestId('fee-try')).toContainText('20,000')
  await page.getByLabel(/^Who pays the platform fee/).selectOption('lead')
  await expect(page.getByTestId('error-fee_payer')).toHaveCount(0)
})

test('TC-DRF-08 / TC-REV-01 / TC-REV-02 / TC-OP-07 / TC-INV-01 from draft to live on screen: review, a change shown, the company, content approval, launch', async ({
  browser,
}) => {
  const lead = await person(browser, 'lead')
  await addEntity(lead.page)
  const contact = address('company')
  const dealId = await startDeal(lead.page)
  await fillDeal(lead.page, contact)
  await section(lead.page, 'terms')
  await lead.page.getByLabel('Custom terms').fill('Investors must **also** attend the annual dinner.')
  await saved(lead.page)
  await section(lead.page, 'review')
  await expect(lead.page.getByText('What happens next')).toBeVisible()
  // a second page, left open on the draft, must not be able to touch the deal once it is submitted
  const stale = await lead.context.newPage()
  await stale.goto(`/deals/${dealId}`)
  await expect(stale.getByTestId('section-basics')).toBeVisible()
  await lead.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(lead.page.getByTestId('deal-state')).toHaveText('With the reviewer')
  await stale.getByLabel(/^Deal name/).fill('Typed in a forgotten tab')
  await expect(stale.getByTestId('save-status')).toHaveText('Not saved.')
  await expect(stale.getByRole('alert')).toContainText('Someone has changed this deal')
  await stale.close()

  const reviewer = await staff(browser, 'reviewer', ['reviewer'], 'Rae')
  await reviewer.page.getByRole('link', { name: 'Deal review' }).click()
  await reviewer.page.getByTestId('deal-queue').getByRole('link', { name: 'Seedling Round' }).click()
  await expect(reviewer.page.getByTestId('custom-terms-check')).toContainText('annual dinner')
  await expect(reviewer.page.getByTestId('custom-terms-check').locator('strong', { hasText: 'also' })).toBeVisible()
  await expect(reviewer.page.getByTestId('file-links')).toContainText('agreement.pdf')
  await expect(reviewer.page.getByTestId('bound-fee')).toContainText('2.5%')
  await expect(reviewer.page.getByRole('button', { name: 'Ask for changes' })).toBeDisabled()
  await reviewer.page.getByLabel(/^Reason, shown to the lead/).fill('Say more about the use of funds.')
  await reviewer.page.getByLabel(/^Internal note/).fill('secret-note-for-staff')
  await reviewer.page.getByRole('button', { name: 'Ask for changes' }).click()
  await expect(reviewer.page.getByTestId('no-decision')).toBeVisible()

  await lead.page.reload()
  await expect(lead.page.getByTestId('deal-state')).toHaveText('Changes asked for')
  await expect(lead.page.getByTestId('deal-reason')).toContainText('Say more about the use of funds.')
  await expect(lead.page.locator('body')).not.toContainText('secret-note-for-staff')
  await section(lead.page, 'terms')
  await lead.page.getByLabel(/^SPV allocation/).fill('350,000')
  await saved(lead.page)
  await section(lead.page, 'review')
  await lead.page.getByRole('button', { name: 'Send back for review' }).click()
  await expect(lead.page.getByTestId('deal-state')).toHaveText('With the reviewer')

  await reviewer.page.reload()
  await expect(reviewer.page.getByTestId('changes')).toContainText('SPV allocation: 300,000 → 350,000')
  await expect(reviewer.page.getByTestId('history')).toContainText('secret-note-for-staff')

  // the lead changes the deal while the reviewer has it open: the old page cannot approve what it did not show
  await lead.page.reload()
  await expect(lead.page.getByText('Saving a change here starts the review again')).toBeVisible()
  await section(lead.page, 'basics')
  // what is typed while a save is on its way is kept, and still counts as not saved
  await lead.page.getByLabel(/^Deal name/).fill('Seedling Round Two')
  await lead.page.route('**/api/deals/*/draft?base=*', async (r) => {
    await new Promise((done) => setTimeout(done, 400))
    await r.continue()
  })
  await lead.page.getByRole('button', { name: 'Save changes and restart the review' }).click()
  await lead.page.getByLabel(/^Deal name/).fill('Typed while saving')
  await expect(lead.page.getByTestId('changes')).toContainText('Seedling Round Two')
  await expect(lead.page.getByLabel(/^Deal name/)).toHaveValue('Typed while saving')
  await expect(lead.page.getByRole('button', { name: 'Save changes and restart the review' })).toBeEnabled()
  await lead.page.unroute('**/api/deals/*/draft?base=*')
  await lead.page.reload()
  await section(lead.page, 'basics')
  await expect(lead.page.getByLabel(/^Deal name/)).toHaveValue('Seedling Round Two')
  // from the server, not the box just typed in: until the save has landed the old page is still the current one
  await expect(lead.page.getByTestId('changes')).toContainText('Seedling Round Two')
  await reviewer.page.getByRole('button', { name: 'Approve' }).click()
  await expect(reviewer.page.getByRole('alert')).toContainText('changed since you opened it')
  await reviewer.page.reload()
  await expect(reviewer.page.getByTestId('changes')).toContainText('Name: Seedling Round → Seedling Round Two')

  // the company, with no account
  const company = await (await browser.newContext()).newPage()
  await company.goto(linkIn(await mailBody(contact)))
  await expect(company.getByRole('heading', { name: 'Documents for Seedling Ltd' })).toBeVisible()
  await company.getByRole('button', { name: 'Send the documents' }).click()
  await expect(company.getByRole('alert')).toContainText('Still missing')
  await company.getByLabel(/^Add Certificate of incorporation/).setInputFiles(PDF)
  await expect(company.getByTestId('doc-incorporation_certificate')).toContainText('agreement.pdf')
  await company.getByLabel(/^Add Recent bank statement/).setInputFiles([fileNamed('june.pdf'), fileNamed('july.pdf')])
  await expect(company.getByTestId('doc-bank_statement')).toContainText('june.pdf')
  await expect(company.getByTestId('doc-bank_statement')).toContainText('july.pdf')
  await company.getByRole('button', { name: 'Remove june.pdf' }).click()
  await expect(company.getByTestId('doc-bank_statement')).not.toContainText('june.pdf')
  await company.getByLabel(/^Add Proof of address/).setInputFiles(PDF)
  await expect(company.getByTestId('doc-address_proof')).toContainText('agreement.pdf')
  await company.getByLabel('No', { exact: true }).check()
  await company.getByRole('button', { name: 'Send the documents' }).click()
  await expect(company.getByTestId('investee-sent')).toBeVisible()
  await expect(company.getByRole('button', { name: 'Send the documents' })).toHaveCount(0)

  // the lead sees how far it got and never the documents
  await lead.page.reload()
  await expect(lead.page.getByTestId('investee-status')).toHaveText('Sent, waiting for a reviewer')
  await expect(lead.page.getByTestId('investee-count')).toHaveText('3')
  await expect(lead.page.locator('body')).not.toContainText('july.pdf')

  await reviewer.page.reload()
  await expect(reviewer.page.getByTestId('investee-documents')).toContainText('july.pdf')
  await expect(reviewer.page.getByTestId('checked-company')).toContainText('Seedling Ltd')
  await reviewer.page.getByRole('button', { name: 'Pass the company' }).click()
  await expect(reviewer.page.getByTestId('review-investee-status')).toHaveText('Passed')
  await reviewer.page.getByRole('button', { name: 'Approve' }).click()
  await expect(reviewer.page.getByTestId('review-state')).toContainText('Approved')

  // content approval is required here, so going live waits for it
  await sql('UPDATE deal_config SET content_approval_in_sandbox = true')
  try {
    await lead.page.reload()
    await lead.page.getByLabel('I confirm this deal should go live').check()
    await lead.page.getByRole('button', { name: 'Go live' }).click()
    await expect(lead.page.getByRole('alert')).toBeVisible()
    await expect(lead.page.getByTestId('deal-state')).toContainText('Approved')

    const approver = await staff(browser, 'approver', ['approver'], 'Ana')
    await approver.page.getByRole('link', { name: 'Content approval' }).click()
    await expect(approver.page.getByTestId('approval-notice')).toContainText('not the statutory approval')
    await approver.page.getByTestId('approval-queue').getByRole('link', { name: 'Seedling Round Two' }).click()
    await expect(approver.page.getByTestId('approval-notice')).toContainText('not the statutory approval')
    await expect(approver.page.getByTestId('approval-ar-notice')).toContainText('An appointed representative is not an authorised person')
    await approver.page.getByLabel(/^Your name/).fill('Ana Approver')
    await approver.page.getByLabel(/^FRN/).fill('1234567')
    await approver.page.getByRole('button', { name: 'Record the approval' }).click()
    await expect(approver.page.getByTestId('approval-done')).toBeVisible()
    const row = (
      await sql<{ self_declared_name: string; self_declared_frn: string; content_sha256: string }>(
        'SELECT self_declared_name, self_declared_frn, content_sha256 FROM promotion_approval WHERE subject_id LIKE $1',
        [`${dealId}:%`],
      )
    )[0]!
    expect(row).toEqual({
      self_declared_name: 'Ana Approver',
      self_declared_frn: '1234567',
      content_sha256: await approver.page.getByTestId('approval-hash').innerText(),
    })

    await lead.page.reload()
    await lead.page.getByLabel('I confirm this deal should go live').check()
    await lead.page.getByRole('button', { name: 'Go live' }).click()
    await expect(lead.page.getByTestId('deal-state')).toHaveText('Live')
    await expect(lead.page.getByTestId('section-basics')).toHaveCount(0)
    await expect(lead.page.getByTestId('file-links')).toContainText('agreement.pdf')
  } finally {
    await sql('UPDATE deal_config SET content_approval_in_sandbox = false')
  }
})

test('TC-REV-01 a refusal is final and takes a second step; someone with a stake cannot open the deal', async ({ browser }) => {
  const reviewer = await staff(browser, 'refuser', ['reviewer'], 'Rae')
  await addEntity(reviewer.page)
  const own = await startDeal(reviewer.page)
  await fillDeal(reviewer.page, address('owncompany'), 'My Own Round')
  await reviewer.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(reviewer.page.getByTestId('deal-state')).toHaveText('With the reviewer')

  const lead = await person(browser, 'refused')
  await addEntity(lead.page)
  const other = await startDeal(lead.page)
  await fillDeal(lead.page, address('refusedcompany'), 'Round To Refuse')
  await lead.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(lead.page.getByTestId('deal-state')).toHaveText('With the reviewer')

  await reviewer.page.getByRole('link', { name: 'Deal review' }).click()
  const queue = reviewer.page.getByTestId('deal-queue')
  await expect(queue.locator('li', { hasText: 'My Own Round' })).toContainText('you cannot review it')
  await expect(queue.getByRole('link', { name: 'My Own Round' })).toHaveCount(0)
  await reviewer.page.goto(`/review/${own}`)
  await expect(reviewer.page.getByRole('alert')).toContainText('Deal not found')

  await reviewer.page.goto(`/review/${other}`)
  await reviewer.page.getByLabel(/^Reason, shown to the lead/).fill('Outside what we take on.')
  await reviewer.page.getByRole('button', { name: 'Refuse', exact: true }).click()
  await expect(reviewer.page.getByTestId('review-state')).toHaveText('With the reviewer')
  await reviewer.page.getByRole('button', { name: 'Yes, refuse this deal for good' }).click()
  await expect(reviewer.page.getByTestId('review-state')).toHaveText('Not accepted')
  await lead.page.reload()
  await expect(lead.page.getByTestId('deal-reason')).toContainText('Outside what we take on.')
  await expect(lead.page.getByTestId('section-basics')).toHaveCount(0)
})

test('TC-SYN-01 a syndicate named in a draft is not created until submission, and deleting the draft leaves nothing; it can be restored', async ({
  browser,
}) => {
  const lead = await person(browser, 'deleter')
  await addEntity(lead.page)
  await startDeal(lead.page)
  await section(lead.page, 'basics')
  await lead.page.getByLabel(/^Deal name/).fill('Passing Thought')
  await lead.page.getByLabel('A new one').check()
  await lead.page.getByLabel(/^Syndicate name/).fill('Never Made')
  await saved(lead.page)
  await lead.page.getByRole('link', { name: 'Syndicates', exact: true }).click()
  await expect(lead.page.getByTestId('syndicates-managed')).not.toContainText('Never Made')
  await lead.page.getByRole('link', { name: 'Deals', exact: true }).click()
  await lead.page.getByRole('link', { name: 'Passing Thought' }).click()
  await lead.page.getByRole('button', { name: 'Delete this draft' }).click()
  await expect(lead.page.getByTestId('deleted-deals')).toContainText('Passing Thought')
  await expect(lead.page.getByTestId('deal-list')).not.toContainText('Passing Thought')
  expect((await sql("SELECT 1 FROM syndicate WHERE name = 'Never Made'")).length).toBe(0)
  await lead.page.getByRole('button', { name: 'Restore' }).click()
  await expect(lead.page.getByTestId('deal-list')).toContainText('Passing Thought')
})

test('TC-SYN-03 / TC-SYN-02 / TC-AUTHZ-03 a member link is shown first, nothing touches the clipboard, it can be stopped, and each person sees only their own', async ({
  browser,
}) => {
  const admin = await person(browser, 'synadmin')
  await addEntity(admin.page)
  await admin.page.getByRole('link', { name: 'Syndicates', exact: true }).click()
  await admin.page.getByLabel('Name').fill('Open Garden')
  await admin.page.getByLabel('Lead entity').selectOption({ label: 'Fay Fictional' })
  await admin.page.getByRole('button', { name: 'Create the syndicate' }).click()
  await expect(admin.page.getByTestId('syndicate-name')).toHaveText('Open Garden')
  const page = new URL(admin.page.url()).pathname

  await admin.context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await admin.page.evaluate(() => navigator.clipboard.writeText('what the person had copied'))
  await admin.page.getByRole('button', { name: 'Make a member link' }).click()
  const shown = await admin.page.getByTestId('member-link').inputValue()
  expect(shown).toContain('/join-syndicate?token=')
  expect(await admin.page.evaluate(() => navigator.clipboard.readText())).toBe('what the person had copied')

  // a stranger cannot read the page, and opening a link alone joins nobody
  const member = await person(browser, 'synmember', 'Mo')
  await member.page.goto(page)
  await expect(member.page.getByRole('alert')).toContainText('Syndicate not found')
  await member.page.goto(new URL(shown).pathname + new URL(shown).search)
  await expect(member.page.getByRole('heading', { name: 'Join a syndicate' })).toBeVisible()
  await admin.page.reload()
  await expect(admin.page.getByTestId('syndicate-team')).not.toContainText('Mo Fictional')
  await member.page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(member.page.getByTestId('syndicate-name')).toHaveText('Open Garden')
  await member.page.getByRole('link', { name: 'Syndicates', exact: true }).click()
  await expect(member.page.getByTestId('syndicates-joined')).toContainText('Open Garden')
  await expect(member.page.getByTestId('syndicates-managed')).not.toContainText('Open Garden')

  // a deal the member is not on stays out of their view
  await admin.page.goto(page)
  await admin.page.getByRole('button', { name: 'Start a deal' }).click()
  await expect(admin.page.getByTestId('section-basics')).toBeVisible()
  await admin.page.getByLabel(/^Deal name/).fill('Quiet Deal')
  await saved(admin.page)
  const deal = new URL(admin.page.url()).pathname
  await member.page.goto(deal)
  await expect(member.page.getByRole('alert')).toContainText('Deal not found')

  await admin.page.goto(page)
  await admin.page.getByTestId('invites').getByRole('button', { name: 'Stop this link' }).click()
  await expect(admin.page.getByTestId('invites').getByRole('button')).toHaveCount(0)
  const late = await person(browser, 'synlate', 'Lee')
  await late.page.goto(new URL(shown).pathname + new URL(shown).search)
  await late.page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(late.page.getByRole('alert')).toContainText('not valid')
})

test('TC-REV-02 / TC-DRF-04 what a page shows is what is held: figures stay with their person, dropped terms go, an older page cannot overwrite, and unsaved edits stop the launch', async ({
  browser,
}) => {
  const lead = await person(browser, 'pageheld')
  await addEntity(lead.page)
  const id = await startDeal(lead.page)
  await fillDeal(lead.page, address('heldcompany'))

  await section(lead.page, 'economics')
  await lead.page
    .getByTestId('recipient-0')
    .getByLabel(/^Share of the carry/)
    .fill('60')
  await lead.page.getByRole('button', { name: 'Add a recipient' }).click()
  const second = lead.page.getByTestId('recipient-1')
  await second.getByLabel(/^Type/).selectOption('person')
  await second.getByLabel(/^First name/).fill('Bo')
  await second.getByLabel(/^Last name/).fill('Second')
  await second.getByLabel(/^Email/).fill('bo.second@example.test')
  await second.getByLabel(/^Share of the carry/).fill('40')
  // another type starts clean: a leftover address would count as a stake nobody can see
  await second.getByLabel(/^Type/).selectOption('company')
  await second.getByLabel(/^Type/).selectOption('person')
  await expect(second.getByLabel(/^First name/)).toHaveValue('')
  await expect(second.getByLabel(/^Share of the carry/)).toHaveValue('40')
  await second.getByLabel(/^First name/).fill('Bo')
  await second.getByLabel(/^Last name/).fill('Second')
  await second.getByLabel(/^Email/).fill('bo.second@example.test')
  await saved(lead.page)
  await lead.page.getByRole('button', { name: 'Remove recipient 1' }).click()
  const left = lead.page.getByTestId('recipient-0')
  await expect(left.getByLabel(/^First name/)).toHaveValue('Bo')
  await expect(left.getByLabel(/^Share of the carry/)).toHaveValue('40')
  await left.getByLabel(/^Share of the carry/).fill('100')
  await saved(lead.page)

  await section(lead.page, 'terms')
  await lead.page.getByLabel(/^Instrument/).selectOption('safe')
  await lead.page.getByLabel(/^Valuation cap type/).selectOption('pre_money')
  await lead.page.getByLabel(/^Valuation cap *\*/).fill('2,000,000')
  await lead.page.getByLabel(/^Discount/).fill('20')
  await saved(lead.page)
  await lead.page.getByLabel(/^Instrument/).selectOption('equity')
  await saved(lead.page)
  await section(lead.page, 'review')
  await expect(lead.page.locator('.part').filter({ hasText: 'Terms' })).not.toContainText('Discount')
  await expect(lead.page.locator('.part').filter({ hasText: 'Terms' })).not.toContainText('Valuation cap')

  // a long file name, on a phone
  await section(lead.page, 'files')
  await lead.page.setViewportSize({ width: 375, height: 800 })
  await lead.page.getByLabel('Add files').setInputFiles(fileNamed(`Investment_Agreement_Final_Version_Three_Signed_By_Everyone_${'x'.repeat(60)}.pdf`))
  await expect(lead.page.getByTestId('legal-files')).toContainText('Signed_By_Everyone')
  expect(await lead.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await lead.page.setViewportSize({ width: 1280, height: 720 })

  await section(lead.page, 'basics')
  await lead.page.setViewportSize({ width: 375, height: 800 })
  await lead.page.getByLabel(/^Deal name/).fill('W'.repeat(200))
  await saved(lead.page)
  expect(await lead.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await lead.page.setViewportSize({ width: 1280, height: 720 })

  // two pages on the same draft: the second one written cannot undo the first
  const older = await lead.context.newPage()
  await older.goto(`/deals/${id}`)
  await expect(older.getByTestId('section-basics')).toBeVisible()
  await section(lead.page, 'basics')
  await lead.page.getByLabel(/^Deal name/).fill('Written on the newer page')
  await saved(lead.page)
  await older.getByLabel(/^Deal name/).fill('Typed on the older page')
  await expect(older.getByTestId('save-status')).toHaveText('Not saved.')
  await expect(older.getByRole('alert')).toContainText('Someone has changed this deal')
  await older.close()

  await section(lead.page, 'review')
  await lead.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(lead.page.getByTestId('deal-state')).toHaveText('With the reviewer')
  await expect(lead.page.getByRole('button', { name: 'Submit for review' })).toHaveCount(0)

  // typing after a save has landed, while the page is still fetching the saved copy
  await section(lead.page, 'basics')
  await lead.page.getByLabel(/^Deal name/).fill('Saved on the server')
  await lead.page.route(`**/api/deals/${id}`, async (r) => {
    await new Promise((done) => setTimeout(done, 700))
    await r.continue()
  })
  const landed = lead.page.waitForResponse((r) => r.url().includes('/draft?base=') && r.ok())
  await lead.page.getByRole('button', { name: 'Save changes and restart the review' }).click()
  await landed
  await lead.page.getByLabel(/^Deal name/).fill('Typed after the save')
  // someone else writes while the page is still waiting for its copy
  const other = await lead.context.newPage()
  await other.goto(`/deals/${id}`)
  await other.getByTestId('section-basics').click()
  await other.getByLabel(/^Deal name/).fill('Written by someone else')
  await other.getByRole('button', { name: 'Save changes and restart the review' }).click()
  await expect(other.getByTestId('changes')).toContainText('Written by someone else')
  await other.close()
  await lead.page.waitForTimeout(1200)
  await expect(lead.page.getByLabel(/^Deal name/)).toHaveValue('Typed after the save')
  await lead.page.unroute(`**/api/deals/${id}`)
  await lead.page.getByRole('button', { name: 'Save changes and restart the review' }).click()
  await expect(lead.page.getByRole('alert')).toContainText('Someone has changed this deal')
  await lead.page.reload()

  const reviewer = await staff(browser, 'pageheldrev', ['reviewer'], 'Rae')
  await reviewer.page.setViewportSize({ width: 375, height: 800 })
  await reviewer.page.goto(`/review/${id}`)
  await expect(reviewer.page.getByTestId('file-links')).toContainText('Signed_By_Everyone')
  expect(await reviewer.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await reviewer.page.setViewportSize({ width: 1280, height: 720 })
  await reviewer.page.getByRole('button', { name: 'Approve' }).click()
  await expect(reviewer.page.getByTestId('review-state')).toContainText('Approved')

  await lead.page.reload()
  await section(lead.page, 'terms')
  await lead.page.getByLabel(/^SPV allocation/).fill('999,999')
  await lead.page.getByLabel('I confirm this deal should go live').check()
  await expect(lead.page.getByTestId('unsaved-changes')).toBeVisible()
  await expect(lead.page.getByRole('button', { name: 'Go live' })).toBeDisabled()
  await lead.page.reload()
  await lead.page.getByLabel('I confirm this deal should go live').check()
  await lead.page.getByRole('button', { name: 'Go live' }).click()
  await expect(lead.page.getByTestId('deal-state')).toHaveText('Live')
})

test('TC-DRF-01 hostile text stays text, odd addresses end in a plain refusal, and nothing trips the content security policy', async ({ page }) => {
  const blocked: string[] = []
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) blocked.push(m.text())
  })
  const email = await register(page, 'hostile')
  await signIn(page, email)
  const id = await startDeal(page)
  const attack = '<img src=x onerror="window.__hit=1">'
  await page.getByLabel(/^Deal name/).fill(attack)
  await saved(page)
  await section(page, 'company')
  await page.getByLabel(/^Legal name/).fill('__proto__')
  await saved(page)
  await section(page, 'files')
  await page.getByLabel('Memo').fill(`<script>window.__hit=1</script>\n\n[click](javascript:window.__hit=1)\n\n[plain](http://example.test/a)`)
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByTestId('rich')).toContainText('<script>window.__hit=1</script>')
  await expect(page.getByTestId('rich').locator('a, script, img')).toHaveCount(0)
  await saved(page)
  await page.getByLabel('Add files').setInputFiles({ ...PDF, name: `../../"odd<b>'name.pdf` })
  await expect(page.getByTestId('legal-files')).toContainText('odd<b>')
  await expect(page.getByTestId('legal-files').locator('b')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(attack)
  await section(page, 'company')
  await expect(page.getByLabel(/^Legal name/)).toHaveValue('__proto__')
  await section(page, 'review')
  await expect(page.locator('.part img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __hit?: number }).__hit)).toBeUndefined()

  // a value only the API can save must not break the page
  await page.evaluate(
    async ([deal]) => {
      const { csrf } = await (await fetch('/api/session')).json()
      await fetch(`/api/deals/${deal}/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ basics: { structure: '__proto__', name: 'Odd' }, terms: { round: 'constructor', voter: '__proto__', instrument: 'toString' } }),
      })
    },
    [id],
  )
  await page.reload()
  await section(page, 'review')
  await expect(page.getByTestId('gaps')).toBeVisible()
  await expect(page.locator('.part').filter({ hasText: 'Basics' })).toContainText('__proto__')

  // addresses nobody should be sending: each ends in a plain answer
  await page.goto('/deals/not-an-id')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.goto(`/deals/${randomUUID()}`)
  await expect(page.getByRole('alert')).toContainText('Deal not found')
  await page.goto('/syndicates/not-an-id')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.goto('/join-syndicate?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('not valid')
  await page.goto('/investee?token=short')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.goto('/investee?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  await expect(page.getByRole('alert')).toBeVisible()
  // no role for these pages: the home page, not an empty one
  await page.goto('/review')
  await expect(page.getByRole('heading', { name: 'Who you invest as' })).toBeVisible()
  await page.goto(`/approvals/${id}`)
  await expect(page.getByRole('heading', { name: 'Who you invest as' })).toBeVisible()
  expect(blocked).toEqual([])
})

test('TC-OP-07 the operator deal settings load, save, and reach the wizard', async ({ browser }) => {
  const admin = await staff(browser, 'settings', ['admin'], 'Ada')
  await admin.page.goto('/')
  const form = admin.page.getByTestId('deal-settings')
  await form.getByLabel('Days a review usually takes').fill('9')
  await form.getByLabel("Leads must give the company's registration number").check()
  await form.getByRole('button', { name: 'Save the deal settings' }).click()
  await expect(form.getByRole('status')).toHaveText('Saved.')
  try {
    const lead = await person(browser, 'seesettings')
    await startDeal(lead.page)
    await section(lead.page, 'company')
    await expect(lead.page.locator('label', { hasText: 'Registration number' })).toContainText('Registration number *')
    await section(lead.page, 'review')
    await expect(lead.page.getByText('usually within 9 days')).toBeVisible()
    await expect(lead.page.getByTestId('gaps')).toContainText('Registration number is required.')
  } finally {
    await sql("UPDATE deal_config SET required_company_fields = '{}', review_target_days = 5")
  }
})
