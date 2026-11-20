import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import pg from 'pg'
import { codeAt, stepOf } from '../src/lib/totp.ts'
import { roleUrl, TEST_URL } from '../src/store/testdb.ts'

const FIRST = { email: 'first.admin@example.test', temp: 'temporary-password-1', next: 'first-admin-new-password' }

function fromBase32(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let v = 0
  const out: number[] = []
  for (const ch of s) {
    v = (v << 5) | A.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255)
      bits -= 8
      v &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

let secret: Buffer | null = null

/** A code can be used once per step, so forget the last step between sign-ins in one test run. */
async function forgetLastStep() {
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  await c.query('UPDATE user_account SET mfa_last_step = NULL')
  await c.end()
}

async function signInFirst(page: Page) {
  await forgetLastStep()
  await page.goto('/')
  await page.getByLabel('Email').fill(FIRST.email)
  await page.getByLabel('Password', { exact: true }).fill(secret ? FIRST.next : FIRST.temp)
  if (secret) {
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByLabel(/Code from your authenticator/).fill(codeAt(secret, stepOf(Date.now())))
    await page.getByRole('button', { name: 'Sign in' }).click()
  } else {
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByLabel('Current password').fill(FIRST.temp)
    await page.getByLabel('New password').fill(FIRST.next)
    await page.getByRole('button', { name: 'Save' }).click()
    await page.getByLabel('Your password').fill(FIRST.next)
    await page.getByRole('button', { name: 'Start' }).click()
    secret = fromBase32(await page.getByTestId('mfa-secret').innerText())
    await page.getByLabel('Code from the app').fill(codeAt(secret, stepOf(Date.now())))
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByTestId('recovery')).toBeVisible()
    await page.getByRole('button', { name: 'I have kept them' }).click()
  }
  await expect(page.getByTestId('mode')).toHaveText('Sandbox')
}

test('TC-OP-01 sandbox banner on every page state, no payment input, no outside request', async ({ page }) => {
  const outside: string[] = []
  const cspErrors: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith(`http://127.0.0.1:${process.env.E2E_PORT ?? 4318}/`)) outside.push(r.url())
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && /content security policy/i.test(m.text())) cspErrors.push(m.text())
  })
  await page.goto('/')
  await expect(page.getByTestId('sandbox-banner')).toContainText('fictional data')
  await signInFirst(page)
  await expect(page.getByTestId('sandbox-banner')).toContainText('fictional data')
  await expect(page.getByLabel(/account (name|number)|sort code|iban|holder/i)).toHaveCount(0)
  expect(outside).toEqual([])
  expect(cspErrors).toEqual([])
})

test('TC-OP-02 / TC-OP-03 the switch page lists what is missing and carries the required wording', async ({ page }) => {
  await signInFirst(page)
  await expect(page.getByTestId('switch-warning')).toContainText('does not make anyone compliant')
  await expect(page.getByTestId('switch-warning')).toContainText('legal advice')
  await expect(page.getByLabel('Operator accountable person')).toBeVisible()
  await expect(page.getByTestId('format-passed')).toContainText('Format check passed. This does not say whether the pack is compliant.')
  await expect(page.getByTestId('blockers')).toContainText('two admins and a reviewer')
  await page.getByRole('button', { name: 'Ask to switch to the real mode' }).click()
  await expect(page.getByRole('alert')).toContainText('Replace the placeholder legal text')
  await expect(page.getByTestId('mode')).toHaveText('Sandbox')
})

test('E2E-D0 phone width has no sideways page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await signInFirst(page)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('TC-KYC-03 a setting left blank is an error, not a zero: retention periods and fee rates', async ({ page }) => {
  await signInFirst(page)
  const years = page.getByLabel('Years after a relationship ends')
  const before = await years.inputValue()
  await years.fill('   ')
  await page.locator('form', { has: years }).getByRole('button').click()
  await expect(page.getByRole('alert')).toContainText('whole number')
  await page.reload()
  await expect(years).toHaveValue(before)
  const rate = page.getByLabel('Rate (basis points)', { exact: true })
  await rate.fill('   ')
  await page.locator('form', { has: rate }).getByRole('button').click()
  await expect(page.getByRole('alert')).toContainText('whole number')
})

test('E2E-D0 approving a change shows at once on the page, with what is being approved beside the button', async ({ page }) => {
  await signInFirst(page)
  await expect(page.getByTestId('active-pack')).toContainText('uk-fpo-template')
  const pack = page.getByRole('listitem').filter({ hasText: 'uk-cobs-template' }).last()
  await pack.getByRole('button', { name: 'Ask to activate' }).click()
  const request = page.getByRole('listitem').filter({ hasText: 'Activate a regime pack' })
  await expect(request).toContainText('Changed setting steps')
  await request.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByTestId('active-pack')).toContainText('uk-cobs-template')
  await expect(request).toContainText('approved')
})
