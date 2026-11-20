import jsqrModule from 'jsqr'
import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import pg from 'pg'
import type { RegimePack } from '../src/lib/regimePack.ts'
import { codeAt, stepOf } from '../src/lib/totp.ts'
import type { Tx } from '../src/store/db.ts'
import { insertPack } from '../src/store/packs.ts'
import { roleUrl, TEST_URL } from '../src/store/testdb.ts'

async function activatePack(key: string) {
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  await c.query('UPDATE instance_profile SET active_pack_id = (SELECT id FROM regime_pack WHERE key = $1)', [key])
  await c.end()
}

let n = 0
async function register(page: import('@playwright/test').Page) {
  // the limit on registrations from one address is real, and every test here comes from the same one
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  await c.query('DELETE FROM login_throttle')
  await c.end()
  const email = `investor${Date.now()}${n++}@example.test`
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('First name').fill('Fay')
  await page.getByLabel('Last name').fill('Fictional')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel(/^Password/).fill('a-long-enough-password')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByTestId('sandbox-link').click()
  await page.getByLabel(/password you chose/).fill('a-long-enough-password')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.getByRole('link', { name: 'Continue to sign in' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('a-long-enough-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  return email
}

test('TC-ELG-05 preparation comes first, from the pack, with no deal content, on a phone', async ({ page }) => {
  await activatePack('uk-fpo-template')
  await page.setViewportSize({ width: 375, height: 800 })
  await register(page)
  const prep = page.getByTestId('preparation')
  await expect(prep).toContainText('preparation_individual')
  await expect(prep).toContainText('preparation_company')
  await expect(page.getByTestId('prep-before-entity')).toContainText('preparation_individual')
  await page.locator('label', { hasText: /^Type/ }).locator('select').selectOption('trust')
  await expect(page.getByTestId('prep-before-entity')).toContainText('preparation_company')
  await expect(page.getByLabel('company number', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
})

test('TC-ELG-02 choosing none ends it, with no suggestion of another answer', async ({ page }) => {
  await activatePack('uk-fpo-template')
  await register(page)
  await page.getByLabel('None of these').check()
  await page.getByLabel('Your full name').fill('Fay Fictional')
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(page.getByTestId('ended')).toContainText('You cannot continue.')
  await expect(page.getByRole('button', { name: 'Sign', exact: true })).toHaveCount(0)
})

test('TC-ELG-04 uk-cobs: the warning is a centred dialog, leave and continue look the same, nothing is preselected, and the wait is shown', async ({ page }) => {
  await activatePack('uk-cobs-template')
  await register(page)
  await expect(page.getByTestId('preparation')).toContainText('at least 24 hours')
  await page.getByRole('button', { name: 'Ask to see deals' }).click()
  const dialog = page.getByTestId('personalised-warning')
  await expect(dialog).toBeVisible()
  const leave = dialog.getByRole('button', { name: 'Leave' })
  const cont = dialog.getByRole('button', { name: 'Continue' })
  const style = (b: typeof leave) => b.evaluate((e) => { const s = getComputedStyle(e); return [s.backgroundColor, s.color, s.fontSize, s.fontWeight, s.borderColor].join() })
  expect(await style(leave)).toBe(await style(cont))
  const [lb, cb] = [await leave.boundingBox(), await cont.boundingBox()]
  expect(Math.abs(lb!.width - cb!.width)).toBeLessThan(1)
  expect(Math.abs(lb!.height - cb!.height)).toBeLessThan(1)
  const box = await dialog.boundingBox()
  const view = page.viewportSize()!
  expect(Math.abs(box!.x + box!.width / 2 - view.width / 2)).toBeLessThan(2)
  expect(Math.abs(box!.y + box!.height / 2 - view.height / 2)).toBeLessThan(2)
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  // leaving is a state of its own, with a way back
  await leave.click()
  await expect(page.getByTestId('left')).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Go back to this step' }).click()
  // and again, with no reload in between
  await leave.click()
  await expect(page.getByTestId('left')).toBeVisible()
  await page.getByRole('button', { name: 'Go back to this step' }).click()
  await cont.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByLabel('None of these')).not.toBeChecked()
  // required bold is bold, not asterisks
  await expect(page.locator('.legal strong', { hasText: 'PLACEHOLDER' }).first()).toBeVisible()
  await expect(page.locator('.legal').first()).not.toContainText('**')
  // the statement and the assessment, then the wait
  await page.getByLabel('high net worth').check()
  await page.getByRole('group', { name: /Income of the amount/ }).getByLabel('Yes').check()
  await page.getByRole('group', { name: /Net assets of the amount/ }).getByLabel('No').check()
  await page.getByLabel(/Income, to the nearest/).fill('100,000')
  await page.getByLabel(/as your signature/).fill('Fay Fictional')
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  await page.getByRole('button', { name: 'Start the assessment' }).click()
  await expect(page.getByRole('button', { name: 'Send answers' })).toBeDisabled() // nothing answered yet
  for (const group of await page.locator('fieldset').all()) await group.getByRole('radio').first().check()
  await page.getByRole('button', { name: 'Send answers' }).click()
  await expect(page.getByTestId('waiting')).toBeVisible()
  await expect(page.getByTestId('qualified')).toHaveCount(0)
  // the wait ends; leaving then is a state too; going on qualifies
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  await c.query("UPDATE cooling_off SET started_at = started_at - interval '2 days', ends_at = ends_at - interval '2 days'")
  await c.end()
  await page.reload()
  await page.getByRole('button', { name: 'Leave' }).click()
  await expect(page.getByTestId('left')).toBeVisible()
  await page.getByRole('button', { name: 'Go back to this step' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByTestId('qualified')).toBeVisible()
  await activatePack('uk-fpo-template')
})

test('TC-ENT-02 a company can be completed on the screen: people, documents, a bank account, then sent for review', async ({ page }) => {
  await activatePack('uk-fpo-template')
  await page.setViewportSize({ width: 375, height: 800 })
  await register(page)
  await page.locator('label', { hasText: /^Type/ }).locator('select').selectOption('company')
  const add = page.locator('form', { has: page.getByRole('button', { name: 'Add', exact: true }) })
  for (const [k, v] of [['Name', 'Seed Ltd'], ['Company number', '01234567'], ['Registered address', '1 Road'], ['Tax residence', 'UK'], ['Tax ID', 'X'], ['Source of wealth', 'Trading']] as const) await add.getByLabel(k, { exact: true }).fill(v)
  for (const [name, kind, share] of [['Dee Director', 'director', '0'], ['Rae Rep', 'representative', '0']] as const) {
    await add.getByRole('button', { name: 'Add a person' }).click()
    const row = add.locator('.party').last()
    await row.getByLabel('Name').fill(name)
    await row.getByLabel('Role').selectOption(kind)
    await row.getByLabel('Share (%)').fill(share)
  }
  await add.getByRole('button', { name: 'Add a person' }).click()
  const owner = add.locator('.party').last()
  await owner.getByLabel('Name').fill('Con Trol')
  await owner.getByLabel('Role').selectOption('controller')
  const controller = `control${Date.now()}@example.test`
  await owner.getByLabel('Email').fill(controller)
  await add.getByRole('button', { name: 'Add', exact: true }).click()
  const entity = page.getByTestId('entity')
  await expect(entity).toContainText('Seed Ltd')
  await expect(entity).toContainText('beneficial owner unverified')
  for (const label of ['Registration proof', 'Address proof', 'Structure chart']) {
    await entity.getByLabel(new RegExp(`^${label}`)).setInputFiles({ name: `${label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sample') })
    await expect(entity).toContainText(`${label} (added`)
  }
  await entity.getByRole('button', { name: 'Send their link' }).click()
  await expect(entity.getByTestId('party-sent')).toContainText('outbox')
  // the bank form takes the entity's own name, and shows a pending account
  await entity.getByLabel('Account holder').fill('Seed Ltd')
  await entity.getByLabel('Sort code').fill('11-22-33')
  await entity.getByLabel('Account number').fill('12345678')
  await entity.getByRole('button', { name: 'Save the account' }).click()
  await expect(entity.getByTestId('bank-row')).toContainText('waiting for a person')
  // once held, the form stays closed until the person asks to change the account
  await expect(entity.getByTestId('bank-form')).toHaveCount(0)
  await entity.getByRole('button', { name: 'Change the bank account' }).click()
  await expect(entity.getByTestId('bank-form')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  // the person named confirms from their own mail, in a page with no session
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  // a refused account is no account: the form is back without asking
  await c.query("UPDATE entity_bank_account SET status = 'refused' WHERE holder = 'Seed Ltd'")
  await page.reload()
  await expect(page.getByTestId('entity').getByTestId('bank-form')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change the bank account' })).toHaveCount(0)
  const mail = (await c.query<{ body: string }>('SELECT body FROM sandbox_outbox WHERE to_address = $1', [controller])).rows[0]!.body
  await c.end()
  const other = await page.context().browser()!.newPage({ baseURL: new URL(page.url()).origin })
  await other.goto(/\/party\?token=[\w-]+/.exec(mail)![0])
  await other.getByRole('button', { name: 'Confirm' }).click()
  await expect(other.getByRole('heading', { name: 'Done' })).toBeVisible()
  await other.close()
  await page.reload()
  const after = page.getByTestId('entity')
  await expect(after).not.toContainText('Still needed')
  await after.getByLabel('This information is true').check()
  await after.getByRole('button', { name: /Send for review/ }).click()
  await expect(after.getByTestId('entity-status')).toHaveText('In review')
})

test('TC-ELG-01 the statement form sends what was typed: pence are refused, and a good figure goes on', async ({ page }) => {
  await activatePack('uk-fpo-template')
  await register(page)
  await page.getByLabel('high net worth').check()
  await page.getByRole('group', { name: /Income of the amount/ }).getByLabel('Yes').check()
  await page.getByRole('group', { name: /Net assets of the amount/ }).getByLabel('No').check()
  await page.getByLabel(/Income, to the nearest/).fill('50000.00')
  await page.getByLabel(/as your signature/).fill('Fay Fictional')
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('whole pounds')
  await expect(page.getByLabel(/Income, to the nearest/)).toBeVisible() // nothing was signed
  await page.getByLabel(/Income, to the nearest/).fill('100,000')
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(page.getByText('assessment (next)')).toBeVisible()
})

test('TC-ELG-01 still being a member is asked, not assumed: unanswered stops, and a former member does not qualify', async ({ page }) => {
  await activatePack('uk-fpo-template')
  await register(page)
  await page.getByLabel('Sophisticated').check()
  for (const q of [/private/i, /director/i, /unlisted/i]) await page.getByRole('group', { name: q }).first().getByLabel('No', { exact: true }).check()
  const network = page.getByRole('group', { name: /network or syndicate/i }).first()
  await network.getByLabel('Yes', { exact: true }).first().check()
  await page.getByLabel('Network or syndicate').fill('Angels')
  await page.getByLabel('Months a member').fill('7')
  await page.getByLabel(/as your signature/).fill('Fay Fictional')
  const still = page.getByRole('group', { name: /still a member/i })
  await expect(still.getByLabel('Yes', { exact: true })).not.toBeChecked()
  await expect(still.getByLabel('No', { exact: true })).not.toBeChecked()
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Answer each question')
  await still.getByLabel('No', { exact: true }).check()
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(page.getByLabel(/as your signature/)).toHaveCount(0) // signed
  await expect(page.getByText('assessment (next)')).toHaveCount(0)
})

async function grant(email: string, roles: string[]) {
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  for (const role of roles) await c.query('INSERT INTO role_grant (user_id, role) SELECT id, $2 FROM user_account WHERE email = $1', [email, role])
  await c.end()
}

// a CommonJS package: its function sits on `default` or is the module itself, depending on who loads it
type Decode = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null
const jsQR: Decode = typeof jsqrModule === 'function' ? (jsqrModule as unknown as Decode) : (jsqrModule as unknown as { default: Decode }).default

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

test('TC-AUTHZ-02 the whole path on screen: a person sends documents, a reviewer opens them and passes the case, and the mail is in the admin outbox', async ({ page, context }) => {
  await activatePack('uk-fpo-template')
  await register(page)
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Add', exact: true }) })
  for (const [k, v] of [['Full name', 'Fay Fictional'], ['Address', '1 Seed Street'], ['Tax residence', 'UK'], ['Tax ID', 'T1']] as const) await form.getByLabel(k, { exact: true }).fill(v)
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  const entity = page.getByTestId('entity')
  for (const label of ['Identity proof', 'Address proof', 'Source of wealth']) {
    await entity.getByLabel(new RegExp(`^${label}`)).setInputFiles({ name: `${label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sample') })
    await expect(entity).toContainText(`${label} (added`)
  }
  await expect(entity.getByRole('button', { name: /Send for review/ })).toBeDisabled()
  await entity.getByLabel('This information is true').check()
  // the consent wording keeps the emphasis its pack requires: no provider runs here, so only this answer is stood in for
  await page.route('**/api/kyc/routes', (r) => r.fulfill({ json: { provider: true, uses_biometrics: true, consent_text: 'I consent to **processing my biometric data**.', consent_format: 'bold_markup', consent_sha256: 'x' } }))
  await page.reload()
  await expect(entity.getByTestId('biometric-consent').locator('strong')).toHaveText('processing my biometric data')
  await expect(entity.getByTestId('biometric-consent')).not.toContainText('**')
  await page.unroute('**/api/kyc/routes')
  await page.reload()
  await entity.getByLabel('This information is true').check()
  await entity.getByRole('button', { name: /Send for review/ }).click()
  await expect(entity.getByTestId('entity-status')).toHaveText('In review')
  await page.getByRole('button', { name: 'Sign out' }).click()

  // someone else, given roles, must set up two-step before anything else
  await context.clearCookies()
  const email = `staff${Date.now()}@example.test`
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('First name').fill('Sam')
  await page.getByLabel('Last name').fill('Staff')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel(/^Password/).fill('a-long-enough-password')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByTestId('sandbox-link').click()
  await page.getByLabel(/password you chose/).fill('a-long-enough-password')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await grant(email, ['reviewer', 'admin'])
  await page.getByRole('link', { name: 'Continue to sign in' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('a-long-enough-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByLabel('Your password').fill('a-long-enough-password')
  await page.getByRole('button', { name: 'Start' }).click()
  // a code to scan, drawn without anything injected into the page, beside the key to type
  await expect(page.getByTestId('mfa-qr')).toBeVisible()
  expect(await page.getByTestId('mfa-qr').locator('rect').count()).toBeGreaterThan(100)
  // what the squares themselves say, read by a separate decoder: this account's secret, under its name, with the settings the server checks codes with
  const png = PNG.sync.read(await page.getByTestId('mfa-qr').screenshot())
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
  expect(decoded).not.toBeNull()
  const shown = new URL(decoded!.data)
  expect(`${shown.protocol}//${shown.host}${shown.pathname}`).toBe(`otpauth://totp/${encodeURIComponent(`Bulma:${email}`)}`)
  expect(Object.fromEntries(shown.searchParams)).toEqual({ secret: await page.getByTestId('mfa-secret').innerText(), issuer: 'Bulma', algorithm: 'SHA1', digits: '6', period: '30' })
  // the code comes from what was scanned, as a person's app would make it
  const secret = fromBase32(shown.searchParams.get('secret')!)
  await page.getByLabel('Code from the app').fill(codeAt(secret, stepOf(Date.now())))
  await page.getByRole('button', { name: 'Confirm' }).click()
  // the recovery codes can be copied in one go, exactly as shown
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: 'Copy the codes' }).click()
  await expect(page.getByTestId('copied')).toContainText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe((await page.getByTestId('recovery').locator('li').allInnerTexts()).join('\n'))
  await page.getByRole('button', { name: 'I have kept them' }).click()

  const row = page.locator('li', { hasText: /Fay Fictional, individual, for Fay Fictional/ }).first()
  await row.getByRole('button', { name: 'Open the case' }).click()
  await expect(row.getByTestId('case-detail')).toContainText('1 Seed Street')
  const download = page.waitForEvent('download')
  await row.getByTestId('case-files').getByRole('link').first().click()
  expect((await (await download).path()).length).toBeGreaterThan(0)
  await row.getByRole('button', { name: 'Pass the documents' }).click()
  await expect(row).toHaveCount(0)

  // a role holder still has their own investor section, and an admin reads the sandbox mail
  await expect(page.getByRole('heading', { name: 'Who you invest as' })).toBeVisible()
  await expect(page.getByTestId('outbox')).toContainText('Confirm your email address')
  await expect(page.getByTestId('outbox').getByRole('link').first()).toHaveAttribute('href', /token=/)
})

/** A pack of the operator's own, made active directly: these two checks are about what the screen does with its contents. */
async function activateCustom(key: string, change: (p: RegimePack) => RegimePack) {
  const c = new pg.Client({ connectionString: roleUrl(TEST_URL, readFileSync('test-results-db.txt', 'utf8').trim()) })
  await c.connect()
  const base = (await c.query<{ content: RegimePack }>("SELECT content FROM regime_pack WHERE key = 'uk-fpo-template'")).rows[0]!.content
  const by = (await c.query<{ id: string }>('SELECT id FROM user_account LIMIT 1')).rows[0]!.id
  const id = await insertPack(c as unknown as Tx, change({ ...base, key }), { builtIn: false, by })
  await c.query('UPDATE instance_profile SET active_pack_id = $1', [id])
  await c.end()
}

test('TC-ELG-01 required emphasis in a statement question is shown as bold', async ({ page }) => {
  await activateCustom(`bold-question-${Date.now()}`, (p) => ({ ...p, legal_texts: p.legal_texts.map((t) => (t.text_key === 'question_income' ? { ...t, format: 'bold_markup', body: 'Income of **Required emphasis**?', required_bold: ['Required emphasis'] } : t)) }))
  await register(page)
  await page.getByLabel('high net worth').check()
  const legend = page.locator('fieldset legend', { hasText: 'Required emphasis' })
  await expect(legend.locator('strong')).toHaveText('Required emphasis')
  await expect(legend).not.toContainText('**')
  await activatePack('uk-fpo-template')
})

test('TC-ENT-02 the form says the threshold the pack sets', async ({ page }) => {
  await activateCustom(`ten-percent-${Date.now()}`, (p) => ({ ...p, thresholds: { ...p.thresholds, ubo_over_bps: 1050 } }))
  await register(page)
  await page.locator('label', { hasText: /^Type/ }).locator('select').selectOption('company')
  await expect(page.getByTestId('parties').locator('legend')).toContainText('over 10.5%')
  await activatePack('uk-fpo-template')
})

test('TC-ACC-02 someone who registered can change their password on the screen', async ({ page }) => {
  await activatePack('uk-fpo-template')
  const email = await register(page)
  await page.getByLabel('Current password').fill('a-long-enough-password')
  await page.getByLabel(/^New password/).fill('a-different-long-password')
  await page.getByRole('button', { name: 'Change the password' }).click()
  await expect(page.getByTestId('password-changed')).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('a-different-long-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Eligibility' })).toBeVisible()
})

test('TC-ELG-03 a limit reached for good promises no date and offers nothing', async ({ page }) => {
  await activateCustom(`one-try-${Date.now()}`, (p) => ({ ...p, assessment: { ...p.assessment, max_attempts: 1 } }))
  await register(page)
  await page.getByLabel('None of these').isVisible()
  await page.getByLabel('high net worth').check()
  await page.getByRole('group', { name: /Income of the amount/ }).getByLabel('Yes').check()
  await page.getByRole('group', { name: /Net assets of the amount/ }).getByLabel('No').check()
  await page.getByLabel(/Income, to the nearest/).fill('100,000')
  await page.getByLabel(/as your signature/).fill('Fay Fictional')
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  await page.getByRole('button', { name: 'Start the assessment' }).click()
  await expect(page.getByRole('button', { name: 'Send answers' })).toBeDisabled()
  for (const group of await page.locator('fieldset').all()) await group.getByRole('radio').last().check()
  await page.getByRole('button', { name: 'Send answers' }).click()
  await expect(page.getByTestId('assessment-unavailable')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start the assessment' })).toHaveCount(0)
  await expect(page.getByTestId('locked')).toHaveCount(0)
  await activatePack('uk-fpo-template')
})
