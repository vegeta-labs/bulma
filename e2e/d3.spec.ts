// D3 on screen: links, the investor's path from an invitation to payment details on a phone, privacy before the gate, a hold.
import { expect, test, type Response } from '@playwright/test'
import { addEntity, dealSetup, liveDeal, noSideScroll, qualifyOnScreen, registerHere, sql, staff } from './helpers.ts'

/** Words from the deal that must not reach the browser before the gate (E2E-03). */
const SEEDS = ['Seedling', 'Sam Founder', '300,000', '30000000', 'Cara Carry']

test.beforeEach(dealSetup)

test('E2E-01 / E2E-02 / E2E-03 / TC-X-01 / TC-GATE-05 / TC-LNK-12 a lead makes two links; an investor on a phone goes from the link to payment details, with nothing leaked before the gate and the warning first', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const { lead, reviewer, dealId } = await liveDeal(browser)
  const tools = lead.page.getByTestId('live-tools')
  await expect(tools.getByTestId('link-row')).toHaveCount(2)
  // a second set of terms: 10% carry and a 4% fee on top, shown before it is saved
  const form = tools.getByTestId('new-link')
  await form.getByLabel('Note (who it is for)').fill('Angels')
  await form.getByLabel('Carry %').fill('10')
  await form.getByLabel('Cash fee').selectOption('percent')
  await form.getByLabel('Fee %').fill('4')
  await form.getByLabel(/^Why these terms differ/).fill('Early backers')
  await form.getByRole('button', { name: 'Check the terms' }).click()
  await expect(form.getByTestId('link-preview')).toContainText('cannot be changed')
  await form.getByRole('button', { name: 'Save these terms' }).click()
  await expect(tools.getByTestId('link-row')).toHaveCount(3)
  const angels = tools.getByTestId('link-row').filter({ hasText: 'Angels' })
  await angels.getByRole('button', { name: 'Show link' }).click()
  const url = new URL(await angels.getByTestId('link-url').innerText(), 'http://127.0.0.1:4318')

  // the investor, on a phone, with every response recorded until the deal page
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } })
  const page = await context.newPage()
  const bodies: string[] = []
  let gated = true
  page.on('response', async (r: Response) => {
    if (!gated || !r.url().includes('/api/')) return
    const body = await r.text().catch(() => '')
    if (gated) bodies.push(`${r.url()} ${body}`)
  })
  // the page's other data arrives after the invitation has been opened and the token taken out of the address bar
  await page.route('**/api/instance/notice', async (r) => {
    await new Promise((done) => setTimeout(done, 800))
    await r.continue()
  })
  await page.goto(`${url.pathname}${url.search}`)
  await expect(page.getByTestId('invite-page')).toContainText('Invitation reference')
  await page.waitForResponse('**/api/instance/notice')
  await expect(page.getByTestId('invite-page')).toBeVisible()
  await page.unroute('**/api/instance/notice')
  expect(new URL(page.url()).search).toBe('')
  await expect(page).toHaveTitle(/Bulma/)
  await noSideScroll(page)
  await page.getByRole('link', { name: 'Sign in or create an account' }).click()
  const investorEmail = await registerHere(page, 'investor')
  // recorded up to the last step before the gate: the link, sign-up, the statement and the assessment
  await qualifyOnScreen(page, () => {
    gated = false
  })
  for (const b of bodies) for (const s of SEEDS) expect(b, b.slice(0, 80)).not.toContain(s)
  expect(bodies.length).toBeGreaterThan(8)
  // the list on the same page opens the deal once the checks are done, with no reload (Codex round 3)
  await expect(page.getByTestId('my-deals').getByRole('link', { name: 'Seedling Round' })).toBeVisible()
  await addEntity(page)
  // KYC is passed by the reviewer here; D1 tests that path on screen
  await sql(
    "INSERT INTO kyc_case (id, entity_id, entity_version, provider, status, decided_at, expires_on) SELECT gen_random_uuid(), e.id, e.current_version, 'manual', 'approved', now(), '2029-01-01' FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.email = $1",
    [investorEmail],
  )

  await page.goto('/')
  await page.getByTestId('my-deals').getByRole('link', { name: 'Seedling Round' }).click()
  // FPO: the warning block comes before anything else on the page, the banner, logo and navigation included (§5.5)
  await expect(page.getByTestId('deal-page')).toBeVisible()
  // R-PAGE-01: the approved deck is embedded below the warning, and the page may frame that site only
  await expect(page.getByTitle('Pitch deck')).toHaveAttribute('src', 'https://decks.example.test/embed/1')
  expect((await page.request.get('/')).headers()['content-security-policy']).toContain('frame-src https://decks.example.test')
  const order = await page.evaluate(() => {
    const warning = document.querySelector('[data-testid="promotion-warning"]')!
    const others = [
      document.querySelector('[data-testid="sandbox-banner"]'),
      document.querySelector('header'),
      document.querySelector('nav'),
      document.querySelector('main'),
    ]
    return others.every((o) => !o || !!(warning.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  expect(order).toBe(true)
  await expect(page.getByTestId('key-terms')).toContainText('10.00%')
  await expect(page.getByTestId('key-terms')).toContainText('4.00% added on top')
  await noSideScroll(page)
  const commit = page.getByTestId('commit')
  await commit.getByLabel(/^Amount/).fill('10,000')
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  const quote = commit.getByTestId('quote')
  await expect(quote).toContainText('Investment part (before the platform fee)£10,000.00')
  await expect(quote).toContainText('Lead fee£400.00')
  await expect(quote).toContainText('Total commitment: the amount to pay£10,400.00')
  await expect(quote).toContainText('Expected investment: £9,750.00')
  await expect(quote.getByTestId('least')).toContainText('£5,999.99')
  await commit.getByLabel('Who is investing').selectOption({ label: 'Fay Fictional' })
  await commit.getByRole('button', { name: 'Commit £10,400.00' }).click()
  const card = page.getByTestId('participation')
  await expect(card).toContainText('To sign')
  await noSideScroll(page)
  await card.getByRole('button', { name: 'Deal sheet' }).click()
  await expect(card.getByTestId('deal-sheet')).toContainText('£10,400.00')
  await card.getByLabel(/I have read this document/).check()
  await card.getByLabel('Type your full name to sign').fill('Fay Fictional')
  await card.getByRole('button', { name: 'Sign', exact: true }).click()
  const pay = page.getByTestId('instructions')
  await expect(pay.getByTestId('still-to-pay')).toHaveText('Still to pay: £10,400.00')
  // R-PAY-01: the fee breakdown is on the payment screen, not only in the data
  const parts = pay.getByTestId('pay-breakdown')
  await expect(parts).toContainText('Investment part (before the platform fee)£10,000.00')
  await expect(parts).toContainText('Lead fee£400.00')
  await expect(parts).toContainText('Total commitment: the amount to pay£10,400.00')
  await expect(pay.getByTestId('your-money')).toBeVisible()
  await expect(pay).toContainText('does not receive money')
  await expect(pay.getByTestId('promotion-warning')).toBeVisible()
  await noSideScroll(page)
  await pay.getByRole('button', { name: 'I have paid' }).click()
  await expect(pay).toContainText('You said you have paid')

  // the reviewer records the money; the investor sees it
  await reviewer.page.goto(`/review/${dealId}`)
  const rec = reviewer.page.getByTestId('receipts')
  await rec.getByLabel(/^Amount/).fill('10,400')
  await rec.getByLabel(/^Payer name/).fill('Fay Fictional')
  await rec.getByLabel(/^Payer account/).fill('12345678')
  await rec.getByRole('button', { name: 'Record money received' }).click()
  await expect(rec).toContainText('£10,400.00 on')
  await page.reload()
  await expect(page.getByTestId('participation')).toContainText('Funded')
  await context.close()
})

test('E2E-09 a hold: the investor sees neutral words and "do not pay" at once; after release things return', async ({ browser }) => {
  test.setTimeout(240_000)
  const { lead, dealId } = await liveDeal(browser)
  const tools = lead.page.getByTestId('live-tools')
  const def = tools.getByTestId('link-row').filter({ hasText: '20.00%' })
  await def.getByRole('button', { name: 'Show link' }).click()
  const url = new URL(await def.getByTestId('link-url').innerText(), 'http://127.0.0.1:4318')
  const inv = await browser.newContext()
  const page = await inv.newPage()
  await page.goto(`${url.pathname}${url.search}`)
  await page.getByRole('link', { name: 'Sign in or create an account' }).click()
  const heldEmail = await registerHere(page, 'held')
  await qualifyOnScreen(page)
  await addEntity(page)
  await sql(
    "INSERT INTO kyc_case (id, entity_id, entity_version, provider, status, decided_at, expires_on) SELECT gen_random_uuid(), e.id, e.current_version, 'manual', 'approved', now(), '2029-01-01' FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.email = $1",
    [heldEmail],
  )
  await page.getByTestId('my-deals').getByRole('link', { name: 'Seedling Round' }).click()
  await expect(page.getByTestId('deal-page')).toBeVisible()
  // committed, signed, and the payment details open on screen
  const commit = page.getByTestId('commit')
  await commit.getByLabel(/^Amount/).fill('10,000')
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  await commit.getByLabel('Who is investing').selectOption({ label: 'Fay Fictional' })
  await commit.getByRole('button', { name: /^Commit/ }).click()
  const card = page.getByTestId('participation')
  await card.getByRole('button', { name: 'Deal sheet' }).click()
  await card.getByLabel(/I have read this document/).check()
  await card.getByLabel('Type your full name to sign').fill('Fay Fictional')
  await card.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(page.getByTestId('still-to-pay')).toBeVisible()

  const r1 = await staff(browser, 'pauser', ['reviewer'])
  await r1.page.goto(`/review/${dealId}`)
  await r1.page
    .getByTestId('holds')
    .getByLabel(/^Reason/)
    .fill('Checking something')
  await r1.page.getByRole('button', { name: 'Pause now' }).click()
  await expect(r1.page.getByRole('button', { name: 'End the pause' })).toBeVisible()
  // no reload: the open payment details turn into "do not pay" by themselves (Codex round 3)
  await expect(page.getByTestId('still-to-pay')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByRole('alert').first()).toContainText('Do not send money')
  // and the deal itself leaves the open page, with nothing about the company left on screen (Codex round 4)
  await expect(page.getByTestId('deal-page')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('body')).not.toContainText('Seedling')
  await page.reload()
  await expect(page.getByRole('alert')).toContainText(/do not send money/i)
  await expect(page.locator('body')).not.toContainText('Seedling')
  await expect(page.locator('body')).not.toContainText('Checking something')
  // the one who paused cannot end it; someone else can
  await r1.page.getByRole('button', { name: 'End the pause' }).click()
  await expect(r1.page.getByTestId('holds').getByRole('alert')).toContainText('Someone else')
  const r2 = await staff(browser, 'releaser', ['reviewer'])
  await r2.page.goto(`/review/${dealId}`)
  await r2.page.getByRole('button', { name: 'End the pause' }).click()
  await expect(r2.page.getByRole('button', { name: 'End the pause' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('deal-page')).toBeVisible()
  await inv.close()
})
