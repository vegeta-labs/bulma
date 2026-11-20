// D4 on screen: the lead's list from a pasted list to the panel, and a message to a group with approval (E2E-04).
import { expect, test, type Browser } from '@playwright/test'
import { addEntity, dealSetup, liveDeal, noSideScroll, person, readableInBothThemes, qualifyOnScreen, saved, section, sql, staff } from './helpers.ts'

test.beforeEach(dealSetup)
test.afterEach(async () => {
  await sql('UPDATE deal_config SET content_approval_in_sandbox = false')
})

/** The latest mail to an address, as the sandbox kept it. */
async function lastMail(to: string) {
  await expect.poll(async () => (await sql('SELECT 1 FROM sandbox_outbox WHERE lower(to_address) = lower($1)', [to])).length).toBeGreaterThan(0)
  return (
    await sql<{ subject: string; body: string }>(
      'SELECT subject, body FROM sandbox_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at DESC LIMIT 1',
      [to],
    )
  )[0]!
}

/** Someone with an account, renamed so the list tells them apart. */
async function investor(browser: Browser, who: string, name: string) {
  const p = await person(browser, who)
  await sql('UPDATE user_account SET name = $2 WHERE email = $1', [p.email, name])
  return p
}

test('E2E-04 a lead pastes a list and invites it in one go; the panel shows status and who it waits on change; a group message, once approved, reaches someone who does not pass only as a sign-in notice', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const { lead, dealId } = await liveDeal(browser)
  const ann = await investor(browser, 'ann', 'Ann Able')
  const ben = await investor(browser, 'ben', 'Ben Baker')
  const p = lead.page
  const tools = p.getByTestId('live-tools')

  // R-PIP-06: the operator's text on whom to invite is confirmed first; then the list is pasted and sent in one go
  const policy = tools.getByTestId('invitee-policy')
  await policy.getByLabel(/I have read this text/).check()
  await policy.getByRole('button', { name: 'Confirm' }).click()
  await expect(tools).toContainText('You confirmed the operator')
  const pipeline = tools.getByTestId('pipeline')
  await pipeline.getByLabel(/^Paste rows/).fill(`Ann Able, ${ann.email}, 10000\nBen Baker, ${ben.email}, 5000`)
  await pipeline.getByRole('button', { name: 'Add to the list' }).click()
  for (const name of ['Ann Able', 'Ben Baker']) await pipeline.getByLabel(`Terms for ${name}`).selectOption({ index: 1 })
  await pipeline.getByRole('button', { name: 'Check before sending' }).click()
  await expect(pipeline.getByTestId('send-plan')).toContainText('2 invitations will be sent')
  await pipeline.getByRole('button', { name: 'Send 2' }).click()

  // each opens the invitation from the mail and lands in their list
  for (const x of [ann, ben]) {
    await expect.poll(async () => (await lastMail(x.email)).body).toMatch(/\/invite\?token=/)
    const link = /\/invite\?token=[\w-]+/.exec((await lastMail(x.email)).body)![0]
    await x.page.goto(link)
    await expect(x.page.getByTestId('invite-page')).toBeVisible()
    await x.page.goto('/')
    await expect(x.page.getByTestId('my-deals')).toBeVisible()
  }

  const panel = tools.getByTestId('lead-panel')
  const row = (name: string) => panel.getByTestId('panel-row').filter({ hasText: name })
  await p.reload()
  await expect(row('Ann Able').getByTestId('row-status')).toHaveText('Getting set up')
  await expect(row('Ann Able').getByTestId('row-waiting')).toHaveText('The investor')
  await expect(row('Ben Baker').getByTestId('row-status')).toHaveText('Getting set up')

  // Ann qualifies and commits before her identity is checked: "Verifying", waiting on her
  await qualifyOnScreen(ann.page)
  await addEntity(ann.page, 'Ann Able')
  await ann.page.goto('/')
  await ann.page.getByTestId('my-deals').getByRole('link', { name: 'Seedling Round' }).click()
  const commit = ann.page.getByTestId('commit')
  await commit.getByLabel(/^Amount/).fill('10,000')
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  await expect(commit.getByTestId('quote')).toBeVisible()
  await commit.getByLabel('Who is investing').selectOption({ label: 'Ann Able' })
  await commit.getByRole('button', { name: /^Commit / }).click()
  await expect(ann.page.getByTestId('participation')).toBeVisible()
  await p.reload()
  await expect(row('Ann Able').getByTestId('row-status')).toHaveText('Verifying')
  await expect(row('Ann Able').getByTestId('row-waiting')).toHaveText('The investor')
  // her identity check goes to a reviewer: the row now waits on the reviewer, and says nothing more about it (R-KYC-02.1)
  await sql(
    "INSERT INTO kyc_case (id, entity_id, entity_version, provider, status) SELECT gen_random_uuid(), e.id, e.current_version, 'manual', 'pending_review' FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.email = $1",
    [ann.email],
  )
  await p.reload()
  await expect(row('Ann Able').getByTestId('row-waiting')).toHaveText('A reviewer')
  await expect(row('Ben Baker').getByTestId('row-waiting')).toHaveText('The investor')
  // filters: only those waiting on the investor
  await panel.getByLabel('Waiting on').selectOption('investor')
  await expect(panel.getByTestId('panel-row')).toHaveCount(1)
  await expect(panel.getByTestId('panel-row')).toContainText('Ben Baker')
  await panel.getByLabel('Waiting on').selectOption('')
  await expect(panel.getByTestId('panel-row')).toHaveCount(2)
  // row actions: allowed or with the action's own words
  await row('Ben Baker').getByRole('button', { name: 'Actions for Ben Baker' }).click()
  await expect(row('Ben Baker').getByTestId('action-remove')).toContainText('This person has not committed.')
  await expect(row('Ben Baker').getByTestId('action-email').getByRole('button')).toBeEnabled()

  // a message to everyone on the list needs an approver (R-CMP-02)
  await sql('UPDATE deal_config SET content_approval_in_sandbox = true')
  const compose = tools.getByTestId('compose')
  await expect(compose.getByTestId('audience')).toContainText('2 people are in this group')
  // the names to copy are those with a step still to do: Ben, not Ann, who waits on a reviewer
  await expect(compose.getByTestId('unfinished-names')).toHaveText('Ben Baker')
  await compose.getByLabel('Subject').fill('Round update')
  await compose.getByLabel('Message').fill('We have reached half of the round.')
  await compose.getByRole('button', { name: 'Save the message' }).click()
  await expect(compose).toContainText('An approver must approve it')
  const archive = tools.getByTestId('mail-archive')
  await expect(archive.getByTestId('message-state')).toHaveText('Waiting for an approver')
  await expect(archive.getByRole('button', { name: 'Send' })).toBeDisabled()

  const approver = await staff(browser, 'approver', ['approver'])
  await approver.page.goto('/approvals')
  const queue = approver.page.getByTestId('mail-approvals')
  await expect(queue.getByTestId('mail-approval-notice')).toContainText('not the statutory approval')
  await readableInBothThemes(approver.page, 'approvals, messages')
  const item = queue.getByTestId('mail-approval').filter({ hasText: 'Round update' })
  await item.getByLabel(/^Your name/).fill('Avery Approver')
  await item.getByRole('button', { name: 'Approve this message' }).click()
  await expect(queue.getByTestId('mail-approval').filter({ hasText: 'Round update' })).toHaveCount(0)

  await p.reload()
  await expect(archive.getByTestId('message-state')).toHaveText('Ready to send')
  await archive.getByRole('button', { name: 'Send' }).click()
  await expect(archive.getByTestId('send-result')).toContainText('Sent to 2.')
  await expect(archive.getByTestId('archive-message')).toContainText('Ann Able:')
  await expect(archive.getByTestId('archive-message')).toContainText('Ben Baker:')

  // R-COM-04: Ann, still taking part and able to see the deal, gets the text after the warning; Ben, who has not qualified,
  // gets a notice with nothing of the deal in it
  await expect.poll(async () => (await lastMail(ann.email)).subject).toBe('Round update')
  const annMail = await lastMail(ann.email)
  expect(annMail.body).toContain('We have reached half of the round.')
  await expect.poll(async () => (await lastMail(ben.email)).body).toContain('sign in')
  const benMail = await lastMail(ben.email)
  expect(benMail.body).not.toContain('We have reached')
  expect(benMail.subject).not.toBe('Round update')

  // the investor's own archive: the text only for someone who may see it today
  await ann.page.goto('/')
  await expect(ann.page.getByTestId('my-message')).toContainText('We have reached half of the round.')
  await expect(ann.page.getByTestId('my-message').getByTestId('promotion-warning')).toBeVisible()
  await readableInBothThemes(ann.page, 'investor home, messages')
  await ben.page.goto('/')
  await expect(ben.page.getByTestId('my-message')).toContainText('You cannot see this message today')
  await expect(ben.page.getByTestId('my-message')).not.toContainText('We have reached')

  // the lead's page at 375px: the panel and messages fit with no sideways scroll
  await p.setViewportSize({ width: 375, height: 800 })
  await p.goto(`/deals/${dealId}`)
  await expect(panel.getByTestId('panel-row')).toHaveCount(2)
  await row('Ann Able').getByRole('button', { name: 'Actions for Ann Able' }).click()
  await readableInBothThemes(p, 'lead panel, row actions, 375px')
  await noSideScroll(p)
})

test('TC-AUTHZ-05 / TC-PIP-04 / TC-ADM-01 on screen: the lead previews the investor page, copies the deal to a new draft and works out the raise', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const { lead, dealId } = await liveDeal(browser)
  const p = lead.page
  await p.goto(`/deals/${dealId}`)
  // R-ADM-01: the investor page on the default link's terms, with nothing to do on it
  const preview = p.getByTestId('investor-preview')
  await preview.getByRole('button', { name: 'Show the investor page' }).click()
  await expect(preview.getByRole('status')).toContainText('nothing here can be done')
  await expect(preview.getByTestId('promotion-warning').first()).toBeVisible()
  await expect(preview).toContainText('Key terms')
  await expect(preview.getByRole('button', { name: /^Commit/ })).toHaveCount(0)
  await readableInBothThemes(p, 'lead deal page, investor preview')
  // nothing recorded as a view
  expect(await sql('SELECT 1 FROM deal_view v JOIN deal d ON d.id = v.deal_id WHERE d.id = $1', [dealId])).toHaveLength(0)

  // a team member runs the deal too: the calculator and copying are on the live deal's page for them, as their routes allow
  const mia = await person(browser, 'mia')
  await sql("INSERT INTO deal_member (deal_id, user_id, role) SELECT $1, id, 'member' FROM user_account WHERE email = $2", [dealId, mia.email])
  await mia.page.goto(`/deals/${dealId}`)
  const miaCalc = mia.page.getByTestId('raise-calculator')
  await expect(miaCalc).toBeVisible()
  await miaCalc.getByLabel('The company should receive').fill('100,000')
  await miaCalc.getByRole('button', { name: 'Work it out' }).click()
  await expect(miaCalc.getByTestId('raise-answer')).toContainText('104,000')
  await expect(mia.page.getByTestId('copy-deal').getByRole('button', { name: 'Make the copy' })).toBeVisible()

  // R-PIP-05: a new draft, the lead its lead
  await p.getByTestId('copy-deal').getByRole('button', { name: 'Make the copy' }).click()
  await expect(p).not.toHaveURL(new RegExp(`/deals/${dealId}$`))
  await expect(p.getByTestId('section-economics')).toBeVisible()
  const copyId = new URL(p.url()).pathname.split('/').pop()!
  expect((await sql<{ state: string }>('SELECT state FROM deal WHERE id = $1', [copyId]))[0]!.state).toBe('draft')

  // R-ADM-03: investors pay 2.5%, at least 4,000: 100,000 to the company needs 104,000
  await section(p, 'economics')
  const calc = p.getByTestId('raise-calculator')
  await calc.getByLabel('The company should receive').fill('100,000')
  await calc.getByRole('button', { name: 'Work it out' }).click()
  await expect(calc.getByTestId('raise-answer')).toContainText('104,000')
  await expect(calc.getByTestId('raise-answer')).toContainText('4,000')
  // the lead paying: the fee goes on top, the raise is the sum itself
  await p.getByLabel(/^Who pays the platform fee/).selectOption('lead')
  await saved(p)
  await calc.getByLabel('The company should receive').fill('100,000')
  await calc.getByRole('button', { name: 'Work it out' }).click()
  await expect(calc.getByTestId('raise-answer')).toContainText('the lead pays the platform fee on top')
  await expect(calc.getByTestId('raise-answer').locator('dd').first()).toHaveText('100,000')
  await p.setViewportSize({ width: 375, height: 800 })
  await readableInBothThemes(p, 'deal economics, calculator, 375px')
  await noSideScroll(p)

  // a new draft with nobody chosen to pay the fee: no calculator, since its route would only refuse
  await p.setViewportSize({ width: 1280, height: 800 })
  await p.getByRole('link', { name: 'Deals', exact: true }).click()
  await p.getByRole('button', { name: 'Start a deal' }).click()
  await expect(p.getByTestId('section-basics')).toBeVisible()
  await expect(p.getByTestId('raise-calculator')).toHaveCount(0)
})

test('TC-OPS-02 / TC-AUD-03 on screen: the to-do list across deals with who is on it, the deal board, the operator’s list with each evidence pack, a complaint from the form to its acknowledgement; the transaction period and the complaints address', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const { lead, reviewer, dealId } = await liveDeal(browser)
  const olga = await investor(browser, 'olga', 'Olga Ops')
  const rita = `Rita ${Date.now()}`
  await sql('UPDATE user_account SET name = $1 WHERE email = $2', [rita, reviewer.email])

  // Olga opens the deal's link, so she has a row on the list
  const tools = lead.page.getByTestId('live-tools')
  const first = tools.getByTestId('link-row').first()
  await first.getByRole('button', { name: 'Show link' }).click()
  const url = new URL(await first.getByTestId('link-url').innerText(), 'http://127.0.0.1')
  await olga.page.goto(`${url.pathname}${url.search}`)
  await expect(olga.page.getByTestId('invite-page')).toBeVisible()

  // R-AUD-05: she complains through the form; where else to send it is shown with it
  await olga.page.goto('/')
  const mine = olga.page.getByTestId('my-complaints')
  await expect(mine).toContainText('acknowledged within 30 days')
  await mine.getByRole('button', { name: 'Make a complaint' }).click()
  await mine.getByLabel('Your complaint').fill('Nobody answered my question about the fee.')
  await mine.getByRole('button', { name: 'Send the complaint' }).click()
  await expect(mine.getByRole('status')).toContainText('It will be acknowledged by')
  await expect(mine).toContainText('not yet acknowledged')

  // R-OPS-02: the reviewer finds it on the to-do list, puts themselves on it, and the filter follows
  const p = reviewer.page
  await p.goto('/')
  await p.getByRole('link', { name: 'Operations' }).click()
  const work = p.getByTestId('work-list')
  const item = work.getByTestId('work-item').filter({ hasText: 'Olga Ops' }).filter({ hasText: 'Complaint to acknowledge' })
  await expect(item).toContainText('Sent through the complaint form.')
  await readableInBothThemes(p, 'to-do list')
  await expect(item.getByLabel('Assigned to')).toHaveValue('')
  await item.getByLabel('Assigned to').selectOption({ label: rita })
  await expect(item.getByLabel('Assigned to')).not.toHaveValue('')
  await work.getByLabel('Who is on it').selectOption('none')
  await expect(item).toHaveCount(0)
  await work.getByLabel('Who is on it').selectOption({ label: 'Me' })
  await expect(item).toHaveCount(1)
  await work.getByLabel('Kind').selectOption('complaint')
  await expect(item).toHaveCount(1)

  // R-OPS-03: the deal board row: stage, target date, money received and due
  const board = p.locator(`[data-testid="board-row"]:has(a[href="/ops/${dealId}"])`)
  await expect(board).toContainText('live')
  await expect(board).toContainText('Received')
  await expect(board).toContainText('Due from active investors')
  // nobody has paid yet, so closing still lacks something, and the board says what
  await expect(board).toContainText('Closing still needs')

  // R-OPS-01, R-AUD-02: the deal's list for staff, read only, with Olga's evidence pack
  await board.getByRole('link', { name: 'Seedling Round' }).click()
  const row = p.getByTestId('ops-deal').getByTestId('panel-row').filter({ hasText: 'Olga Ops' })
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: /Actions for/ })).toHaveCount(0)
  const evidence = row.getByTestId('row-evidence')
  const pdf = await p.request.get((await evidence.getByRole('link', { name: 'PDF' }).getAttribute('href'))!)
  expect(pdf.status()).toBe(200)
  expect(pdf.headers()['content-type']).toContain('application/pdf')
  const json = await p.request.get((await evidence.getByRole('link', { name: 'JSON' }).getAttribute('href'))!)
  expect(json.status()).toBe(200)
  expect(JSON.stringify(await json.json())).toContain('Olga Ops')
  // the lead is not staff: the operator's pack is refused to them
  expect((await lead.page.request.get((await evidence.getByRole('link', { name: 'JSON' }).getAttribute('href'))!)).status()).toBe(403)

  // the complaint is acknowledged: she gets the fixed email, and it leaves the to-do list
  await p.getByRole('link', { name: 'Back to operations' }).click()
  const complaint = p.getByTestId('complaints').getByTestId('complaint').filter({ hasText: 'Nobody answered my question' })
  await complaint.getByRole('button', { name: 'Acknowledge and email them' }).click()
  await expect(p.getByTestId('complaints').getByRole('status')).toContainText('sent the acknowledgement email')
  await expect(complaint).toContainText('acknowledged')
  await expect(item).toHaveCount(0)
  expect((await lastMail(olga.email)).subject).toBe('We have received your complaint')
  await olga.page.reload()
  await expect(mine).toContainText('acknowledged')
  await expect(mine).not.toContainText('not yet acknowledged')

  // the page reads on a phone
  await p.setViewportSize({ width: 375, height: 800 })
  await p.reload()
  await expect(work).toBeVisible()
  await readableInBothThemes(p, 'to-do list, 375px')
  await noSideScroll(p)

  // an admin sets the complaints address (shown with the form) and the transaction period
  const admin = await staff(browser, 'admin', ['admin'])
  try {
    const policy = admin.page.getByTestId('policy')
    await policy.getByLabel(/^Address for complaints/).fill('complaints@example.test')
    await policy.getByRole('button', { name: 'Save' }).click()
    await expect(policy).toContainText('Saved.')
    await olga.page.reload()
    await expect(mine).toContainText('You can also email it to complaints@example.test.')
    const keep = admin.page.locator('form', { has: admin.page.getByLabel(/^Years payment details are kept/) })
    await keep.getByLabel(/^Years payment details are kept/).fill('7')
    await keep.getByRole('button', { name: 'Save' }).click()
    await expect(keep.getByRole('status')).toHaveText('Saved.')
    expect((await sql<{ y: number }>('SELECT transaction_years AS y FROM retention_config'))[0]!.y).toBe(7)
  } finally {
    await sql('UPDATE retention_config SET transaction_years = 10')
  }
})

test('E2E-08 the operator takes in one statement: one line is recorded, one goes to unallocated money and is assigned, and its to-do item goes; the overpayment is refunded: prepared, approved by a second person, sent and recorded', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const { lead, reviewer } = await liveDeal(browser)
  const olga = await investor(browser, 'olga', 'Olga Ops')

  // Olga opens the deal's link, qualifies and commits
  const tools = lead.page.getByTestId('live-tools')
  const first = tools.getByTestId('link-row').first()
  await first.getByRole('button', { name: 'Show link' }).click()
  const url = new URL(await first.getByTestId('link-url').innerText(), 'http://127.0.0.1')
  await olga.page.goto(`${url.pathname}${url.search}`)
  await expect(olga.page.getByTestId('invite-page')).toBeVisible()
  await qualifyOnScreen(olga.page)
  await addEntity(olga.page, 'Olga Ops')
  await olga.page.goto('/')
  await olga.page.getByTestId('my-deals').getByRole('link', { name: 'Seedling Round' }).click()
  const commit = olga.page.getByTestId('commit')
  await commit.getByLabel(/^Amount/).fill('10,000')
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  await expect(commit.getByTestId('quote')).toBeVisible()
  await commit.getByLabel('Who is investing').selectOption({ label: 'Olga Ops' })
  await commit.getByRole('button', { name: /^Commit / }).click()
  await expect(olga.page.getByTestId('participation')).toBeVisible()
  const { reference, due } = (
    await sql<{ reference: string; due: string }>(
      'SELECT p.reference, p.cash_due_minor::text AS due FROM participation p JOIN user_account u ON u.id = p.user_id WHERE u.email = $1',
      [olga.email],
    )
  )[0]!
  const pounds = (m: bigint) => `${m / 100n}.${String(m % 100n).padStart(2, '0')}`
  const day = new Date().toISOString().slice(0, 10)

  // R-OPS-07: the reviewer picks the receiving account and takes in one statement: her payment, and 250.00 with no reference
  const p = reviewer.page
  await p.goto('/ops')
  await p.getByRole('link', { name: /^Money:/ }).click()
  const st = p.getByTestId('statement-import')
  await st.getByLabel('Receiving account').selectOption({ index: 1 })
  await st
    .getByLabel('Statement (CSV)')
    .fill(
      `transaction_id,date,amount,payer,reference\nE8-${Date.now()}-1,${day},${pounds(BigInt(due))},Olga Ops,${reference}\nE8-${Date.now()}-2,${day},250.00,Olga Ops,NO-SUCH-REF`,
    )
  await st.getByRole('button', { name: 'Check the statement' }).click()
  await expect(st.getByTestId('import-rows')).toContainText('2 of 2 rows to decide')

  // the import is on the to-do list until every row is decided, and its link opens it again
  await p.getByRole('link', { name: 'Back to operations' }).click()
  const work = p.getByTestId('work-list')
  const importItem = work.getByTestId('work-item').filter({ hasText: 'Statement import to confirm' })
  await expect(importItem).toContainText('2 rows to decide')
  await expect(importItem.getByRole('link', { name: 'Open' })).toBeVisible()
  await importItem.getByRole('link', { name: 'Open' }).click()
  const rows = st.getByTestId('import-row')
  const matched = rows.filter({ hasText: 'Line 2' })
  await expect(matched).toContainText('Matches a reference')
  await expect(matched).toContainText('Olga Ops')
  await matched.getByRole('button', { name: 'Record it for this person' }).click()
  await expect(matched).toContainText('decided: Record it for this person')
  const loose = rows.filter({ hasText: 'Line 3' })
  await expect(loose).toContainText('No reference in the line matched anyone.')
  await loose.getByRole('button', { name: 'List it as unallocated money' }).click()
  await expect(st.getByTestId('import-rows')).toContainText('Every row is decided.')

  // R-OPS-04: the 250.00 waits as money nobody's yet, on the to-do list
  const un = p.getByTestId('unallocated').getByTestId('unallocated-row').filter({ hasText: '£250.00' })
  await expect(un).toContainText('Olga Ops')
  await p.getByRole('link', { name: 'Back to operations' }).click()
  const unItem = work.getByTestId('work-item').filter({ hasText: 'Money not yet assigned' })
  await expect(unItem).toHaveCount(1)
  await expect(importItem).toHaveCount(0)
  await expect(unItem.getByRole('link', { name: 'Open' })).toBeVisible()
  await unItem.getByRole('link', { name: 'Open' }).click()
  // the name matches her entity: one click assigns it all to her
  await un.getByTestId('suggestions').getByRole('button', { name: 'Assign all to Olga Ops' }).click()
  await expect(un).toHaveCount(0)
  await p.getByRole('link', { name: 'Back to operations' }).click()
  await expect(unItem).toHaveCount(0)

  // R-OPS-05: she has paid 250.00 more than due; the reviewer prepares the refund and cannot approve it
  const refundItem = work.getByTestId('work-item').filter({ hasText: 'Olga Ops' }).filter({ hasText: 'Refund' })
  await expect(refundItem).toContainText('Refund to prepare.')
  await expect(refundItem.getByRole('link', { name: 'Open' })).toBeVisible()
  await refundItem.getByRole('link', { name: 'Open' }).click()
  const mine = p.getByTestId('refunds').getByTestId('money-row').filter({ hasText: 'Olga Ops' })
  await expect(mine).toContainText('Paid more than due')
  await expect(mine.getByTestId('due-back')).toHaveText('£250.00')
  // a bank statement gives no payer account (plan R28 (3)): the account to send it to is typed, with the evidence
  await expect(mine).toContainText('The account the money came from is not known.')
  await mine.getByLabel('Account holder').fill('Olga Ops')
  await mine.getByLabel('Account', { exact: true }).fill('20-00-00 12345678')
  await mine.getByLabel('Evidence for sending it there').fill('Olga emailed her account details on 12 November.')
  await mine.getByRole('button', { name: 'Prepare the refund' }).click()
  const refund = mine.getByTestId('refund')
  await expect(refund.getByTestId('refund-state')).toHaveText('Prepared, waiting for a second person')
  await expect(refund).toContainText('You prepared it, so someone else approves it.')
  // one refund at a time: no second one is offered while this one is under way
  await expect(mine.getByRole('button', { name: 'Prepare the refund' })).toHaveCount(0)
  await expect(refund.getByRole('button', { name: 'Approve the refund' })).toHaveCount(0)
  await expect(refund).toContainText('To Olga Ops')

  // a second person approves it
  const admin = await staff(browser, 'admin', ['admin'])
  await admin.page.goto('/ops/money')
  const theirs = admin.page.getByTestId('refunds').getByTestId('money-row').filter({ hasText: 'Olga Ops' })
  await theirs.getByRole('button', { name: 'Approve the refund' }).click()
  await expect(theirs.getByTestId('refund-state')).toHaveText('Approved, to send')
  await readableInBothThemes(admin.page, 'money page, refunds')

  // the reviewer sends it at the bank, then records what went
  await p.reload()
  await expect(refund.getByTestId('refund-state')).toHaveText('Approved, to send')
  await refund.getByRole('button', { name: 'Mark as sent' }).click()
  await expect(refund.getByTestId('refund-state')).toHaveText('Sent, to record')
  await refund.getByLabel(/^Amount actually sent/).fill('250.00')
  await refund.getByRole('button', { name: 'Record the refund' }).click()
  await expect(mine).toHaveCount(0)
  expect(
    (
      await sql<{ state: string; actual: string; exceptions: string[] }>(
        'SELECT r.state, r.actual_minor::text AS actual, r.exceptions FROM refund_payment r JOIN participation p ON p.id = r.participation_id JOIN user_account u ON u.id = p.user_id WHERE u.email = $1',
        [olga.email],
      )
    )[0],
  ).toEqual({ state: 'recorded', actual: '25000', exceptions: [] })
  await p.getByRole('link', { name: 'Back to operations' }).click()
  await expect(refundItem).toHaveCount(0)

  // the money page reads on a phone
  await p.setViewportSize({ width: 375, height: 800 })
  await p.goto('/ops/money')
  await expect(p.getByTestId('statement-import')).toBeVisible()
  await readableInBothThemes(p, 'money page, 375px')
  await noSideScroll(p)
})

/** Someone opens the deal's first link, qualifies, commits 10,000, is passed KYC and signs: payment details are issued. */
/** Someone through the invitation, qualified, with a checked entity, on the deal page and not yet committed. */
/** The page catches up as it does when the investor comes back to it (focus), without a reload. */
const caughtUp = (page: import('@playwright/test').Page) => page.evaluate(() => void window.dispatchEvent(new Event('focus')))

async function onTheDeal(browser: Browser, lead: { page: import('@playwright/test').Page }, who: string, name: string, kycPassed = true) {
  const inv = await investor(browser, who, name)
  const first = lead.page.getByTestId('live-tools').getByTestId('link-row').first()
  await first.getByRole('button', { name: 'Show link' }).click()
  const url = new URL(await first.getByTestId('link-url').innerText(), 'http://127.0.0.1')
  await inv.page.goto(`${url.pathname}${url.search}`)
  await expect(inv.page.getByTestId('invite-page')).toBeVisible()
  await qualifyOnScreen(inv.page)
  await addEntity(inv.page, name)
  if (kycPassed) await approveKyc(inv.email)
  await inv.page.goto('/')
  await inv.page.getByTestId('my-deals').getByRole('link', { name: 'Seedling Round' }).click()
  return inv
}

const approveKyc = (email: string) =>
  sql(
    "INSERT INTO kyc_case (id, entity_id, entity_version, provider, status, decided_at, expires_on) SELECT gen_random_uuid(), e.id, e.current_version, 'manual', 'approved', now(), '2029-01-01' FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.email = $1",
    [email],
  )

async function committedAndSigned(browser: Browser, lead: { page: import('@playwright/test').Page }, who: string, name: string, amount = '10,000') {
  const inv = await onTheDeal(browser, lead, who, name)
  const commit = inv.page.getByTestId('commit')
  await commit.getByLabel(/^Amount/).fill(amount)
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  await expect(commit.getByTestId('quote')).toBeVisible()
  await commit.getByLabel('Who is investing').selectOption({ label: name })
  await commit.getByRole('button', { name: /^Commit / }).click()
  const card = inv.page.getByTestId('participation')
  await card.getByRole('button', { name: 'Deal sheet' }).click()
  await card.getByLabel(/I have read this document/).check()
  await card.getByLabel('Type your full name to sign').fill(name)
  await card.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(inv.page.getByTestId('instructions')).toBeVisible()
  return inv
}

test('E2E-07 the lead asks to cancel and sees the operator’s note on fees; another person confirms; whoever has paid has a refund to-do, everyone’s payment details are void and they are told not to pay', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const { lead, reviewer, dealId } = await liveDeal(browser)

  // the operator's note on fees, set by an admin
  const admin = await staff(browser, 'admin', ['admin'])
  await admin.page.goto('/')
  const policy = admin.page.getByTestId('policy')
  await policy.getByLabel(/^Note on fees when a deal is cancelled/).fill('Fees already incurred by the operator are charged to the lead.')
  await policy.getByRole('button', { name: 'Save' }).click()
  await expect(policy).toContainText('Saved.')

  const paid = await committedAndSigned(browser, lead, 'paula', 'Paula Paid')
  const unpaid = await committedAndSigned(browser, lead, 'umar', 'Umar Unpaid')
  const due = (
    await sql<{ due: string }>('SELECT p.cash_due_minor::text AS due FROM participation p JOIN user_account u ON u.id = p.user_id WHERE u.email = $1', [
      paid.email,
    ])
  )[0]!.due
  // the reviewer records Paula's money
  await reviewer.page.goto(`/review/${dealId}`)
  const rec = reviewer.page.getByTestId('receipts')
  await rec
    .getByLabel(/^Amount/)
    .first()
    .fill(`${BigInt(due) / 100n}.${String(BigInt(due) % 100n).padStart(2, '0')}`)
  await rec
    .getByLabel(/^Payer name/)
    .first()
    .fill('Paula Paid')
  await rec
    .getByLabel(/^Payer account/)
    .first()
    .fill('12345678')
  await rec.getByRole('button', { name: 'Record money received' }).first().click()
  await expect(rec).toContainText(' on ')

  // the lead asks to cancel and reads the note first
  await lead.page.reload()
  const life = lead.page.getByTestId('deal-life')
  await life.getByRole('button', { name: 'Ask to cancel the deal' }).click()
  await expect(life.getByTestId('cancel-fee-note')).toHaveText('Fees already incurred by the operator are charged to the lead.')
  await life.getByLabel(/^Reason/).fill('The company found another investor.')
  await life.getByRole('button', { name: 'Send the request to cancel' }).click()
  await expect(life.getByTestId('cancel-asked')).toBeVisible()
  // nothing changes before it is confirmed
  expect((await sql<{ state: string }>('SELECT state FROM deal WHERE id = $1', [dealId]))[0]!.state).toBe('live')

  // the request is on the to-do list; its link opens the deal's staff page, where another person confirms it
  const p = reviewer.page
  await p.goto('/ops')
  const item = p.getByTestId('work-list').getByTestId('work-item').filter({ hasText: 'Asked by the lead.' })
  await expect(item.getByRole('link', { name: 'Open' })).toBeVisible()
  await item.getByRole('link', { name: 'Open' }).click()
  const req = p.getByTestId('deal-decisions').getByTestId('cancel-request')
  await expect(req).toContainText('The company found another investor.')
  await req.getByRole('button', { name: 'Confirm the cancellation' }).click()
  await expect(req).toHaveCount(0)
  await expect(p.getByTestId('ops-deal')).toContainText('cancelled')

  // whoever has paid has a refund to do; the request is gone
  await p.getByRole('link', { name: 'Back to operations' }).click()
  const work = p.getByTestId('work-list')
  await expect(work.getByTestId('work-item').filter({ hasText: 'Asked by the lead.' })).toHaveCount(0)
  const refund = work.getByTestId('work-item').filter({ hasText: 'Paula Paid' }).filter({ hasText: 'Refund' })
  await expect(refund).toContainText('Refund to prepare.')
  await expect(work.getByTestId('work-item').filter({ hasText: 'Umar Unpaid' }).filter({ hasText: 'Refund' })).toHaveCount(0)

  // every payment detail is void, and the one who has not paid is told not to pay
  const open = await sql<{ n: string }>(
    'SELECT count(*)::text AS n FROM issued_instruction i JOIN participation p ON p.id = i.participation_id WHERE p.deal_id = $1 AND i.voided_at IS NULL',
    [dealId],
  )
  expect(open[0]!.n).toBe('0')
  expect((await lastMail(unpaid.email)).subject).toMatch(/^Do not send money: this deal has been cancelled/)
  // the lead is told, with the note
  const leadMail = await sql<{ body: string }>(
    "SELECT o.body FROM sandbox_outbox o JOIN user_account u ON lower(u.email) = lower(o.to_address) JOIN deal d ON d.lead_user = u.id WHERE d.id = $1 AND o.subject LIKE 'Your deal has been cancelled%'",
    [dealId],
  )
  expect(leadMail[0]!.body).toContain('Fees already incurred by the operator are charged to the lead.')

  // the lead's page no longer offers to close or cancel; the staff page reads on a phone
  await lead.page.reload()
  await expect(lead.page.getByTestId('live-tools')).toBeVisible()
  await expect(lead.page.getByTestId('deal-state')).not.toHaveText('Live')
  await expect(lead.page.getByTestId('deal-life')).toHaveCount(0)
  await p.setViewportSize({ width: 375, height: 800 })
  await p.goto(`/ops/${dealId}`)
  await expect(p.getByTestId('deal-decisions')).toBeVisible()
  await readableInBothThemes(p, 'deal staff page, 375px')
  await noSideScroll(p)
})

test('TC-WDR-02 / R-CLS-00 on screen: the lead asks to close and a reviewer takes it back; a withdrawal with written consent is accepted by a reviewer from the to-do list and leaves a refund to do', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const { lead, reviewer, dealId } = await liveDeal(browser)
  const wanda = await committedAndSigned(browser, lead, 'wanda', 'Wanda Withdraws')
  const due = (
    await sql<{ due: string }>('SELECT p.cash_due_minor::text AS due FROM participation p JOIN user_account u ON u.id = p.user_id WHERE u.email = $1', [
      wanda.email,
    ])
  )[0]!.due
  await reviewer.page.goto(`/review/${dealId}`)
  const rec = reviewer.page.getByTestId('receipts')
  await rec
    .getByLabel(/^Amount/)
    .first()
    .fill(`${BigInt(due) / 100n}.${String(BigInt(due) % 100n).padStart(2, '0')}`)
  await rec
    .getByLabel(/^Payer name/)
    .first()
    .fill('Wanda Withdraws')
  await rec
    .getByLabel(/^Payer account/)
    .first()
    .fill('12345678')
  await rec.getByRole('button', { name: 'Record money received' }).first().click()
  await expect(rec).toContainText(' on ')

  // closing: what is missing, or the confirmation and the request
  await lead.page.reload()
  const closing = lead.page.getByTestId('deal-life').getByTestId('closing')
  await expect(closing).toContainText('Committed so far: £')
  const gaps = closing.getByTestId('closing-gaps')
  // what is missing is listed and nothing can be asked; once the company and the lead are checked, the lead can ask
  await expect(gaps).toContainText('The company has not confirmed the deal.')
  await expect(gaps).toContainText('The lead has not passed identity checks.')
  await expect(closing.getByRole('button', { name: 'Ask to close' })).toHaveCount(0)
  await sql("UPDATE investee_company SET verified_at = now(), verified_until = '2029-01-01' WHERE id IN (SELECT company_id FROM investee WHERE deal_id = $1)", [
    dealId,
  ])
  expect((await sql("UPDATE investee SET status = 'approved' WHERE deal_id = $1 RETURNING 1", [dealId])).length).toBe(1)
  await sql(
    "INSERT INTO kyc_case (id, entity_id, entity_version, provider, status, decided_at, expires_on) SELECT gen_random_uuid(), e.id, e.current_version, 'manual', 'approved', now(), '2029-01-01' FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.email = $1",
    [lead.email],
  )
  await lead.page.reload()
  await expect(gaps).toHaveCount(0)
  await expect(closing.getByRole('button', { name: 'Ask to close' })).toBeDisabled()
  await closing.getByRole('checkbox', { name: /I want to close/ }).check()
  await closing.getByRole('button', { name: 'Ask to close' }).click()
  // the answer first, then a fresh page: a reload straight after the click could cut the request off
  await expect(closing.getByTestId('closing-asked')).toBeVisible()
  await lead.page.reload()
  await expect(closing.getByTestId('closing-asked')).toBeVisible()

  // a reviewer takes it back from the deal's staff page; the lead sees it live again
  const p = reviewer.page
  await p.goto(`/ops/${dealId}`)
  await p.getByTestId('deal-decisions').getByRole('button', { name: 'Take back the request to close' }).click()
  await expect(p.getByTestId('deal-decisions')).toContainText('The request to close is taken back.')
  await readableInBothThemes(p, 'deal staff page, closing taken back')
  await lead.page.reload()
  await expect(lead.page.getByTestId('deal-state')).toHaveText('Live')

  // the lead records her written wish to withdraw
  const row = lead.page.getByTestId('lead-panel').getByTestId('panel-row').filter({ hasText: 'Wanda Withdraws' })
  await row.getByRole('button', { name: 'Actions for Wanda Withdraws' }).click()
  await row.getByRole('button', { name: 'Record a withdrawal' }).click()
  await row.getByLabel(/^Their written consent/).fill('Email of 1 March: "Please take me out of this deal."')
  await row.getByLabel('They asked in writing to withdraw').check()
  await row.getByRole('button', { name: 'Send to a reviewer' }).click()
  // the form closes once the server has the request; the reviewer's list is read only after that
  await expect(row.getByRole('button', { name: 'Send to a reviewer' })).toHaveCount(0)

  // the reviewer opens it from the to-do list and accepts it
  await p.goto('/ops')
  const work = p.getByTestId('work-list')
  const item = work.getByTestId('work-item').filter({ hasText: 'Wanda Withdraws' }).filter({ hasText: 'Waiting for a reviewer.' })
  await expect(item.getByRole('link', { name: 'Open' })).toBeVisible()
  await item.getByRole('link', { name: 'Open' }).click()
  const w = p.getByTestId('deal-decisions').getByTestId('withdrawal')
  await expect(w).toContainText('Please take me out of this deal.')
  await expect(w).toContainText('Wanda Withdraws')
  await w.getByRole('button', { name: 'Accept the withdrawal' }).click()
  await expect(w).toHaveCount(0)
  await p.getByRole('link', { name: 'Back to operations' }).click()
  await expect(work.getByTestId('work-item').filter({ hasText: 'Wanda Withdraws' }).filter({ hasText: 'Refund' })).toContainText('Refund to prepare.')
  expect(
    (await sql<{ outcome: string }>('SELECT p.outcome FROM participation p JOIN user_account u ON u.id = p.user_id WHERE u.email = $1', [wanda.email]))[0]!
      .outcome,
  ).toBe('withdrawn')

  // a reviewer may ask to cancel too, and then is not the one to confirm it
  await p.goto(`/ops/${dealId}`)
  const dec = p.getByTestId('deal-decisions')
  await dec.getByText('Ask to cancel this deal').click()
  await dec.getByLabel(/^Reason/).fill('The company stopped answering.')
  await dec.getByRole('button', { name: 'Send the request to cancel' }).click()
  const mine = dec.getByTestId('cancel-request')
  await expect(mine).toContainText('You asked, so someone else decides.')
  await expect(mine.getByRole('button', { name: 'Confirm the cancellation' })).toHaveCount(0)
})

test('E2E-05 a typo: the lead sends it, a reviewer judges it a notice, the investor sees the difference with nothing to do; a new valuation: reviewed, approved, the investor reconfirms and signs again', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const { lead, reviewer, dealId } = await liveDeal(browser)
  const inv = await committedAndSigned(browser, lead, 'tina', 'Tina Typo')
  const lp = lead.page
  const ip = inv.page
  const myDeal = async () => {
    await ip.goto('/')
    await ip.getByTestId('my-deals').getByRole('link', { name: 'Seedling Round' }).click()
    await expect(ip.getByTestId('participation')).toBeVisible()
  }
  await myDeal()
  await expect(ip.getByTestId('deal-updates')).toHaveCount(0)

  // the lead fixes the memo and says so in one sentence
  await lp.goto(`/deals/${dealId}`)
  await expect(lp.getByRole('button', { name: 'Change this deal' })).toBeVisible()
  await lp.getByRole('button', { name: 'Change this deal' }).click()
  const editor = lp.getByTestId('change-editor')
  await expect(editor.getByTestId('section-review')).toHaveCount(0)
  await editor.getByTestId('section-files').click()
  await editor.getByLabel('Memo').fill('Seedling grows tomatoes.')
  await editor.getByLabel(/^What changes and why/).fill('Fixed a typo in the memo.')
  await editor.getByRole('button', { name: 'Send this change' }).click()
  await expect(lp.getByTestId('change-note')).toContainText('A reviewer decides')
  const sent = lp.getByTestId('lead-changes').getByTestId('lead-change').first()
  await expect(sent).toContainText('Waiting for a reviewer')
  await expect(sent).toContainText('Fixed a typo in the memo.')

  // the to-do item opens the deal's staff page; the reviewer judges it a notice, with a reason
  const rp = reviewer.page
  await rp.goto('/ops')
  const item = rp.getByTestId('work-list').getByTestId('work-item').filter({ hasText: 'Waiting for a reviewer.' })
  await expect(item.getByRole('link', { name: 'Open' })).toBeVisible()
  await item.getByRole('link', { name: 'Open' }).click()
  const review = rp.getByTestId('change-reviews').getByTestId('change-review')
  await expect(review).toContainText('Fixed a typo in the memo.')
  await readableInBothThemes(rp, 'change review')
  await expect(review.getByTestId('differences')).toContainText('Seedling grows tomatoes.')
  await review.getByRole('button', { name: 'Record the decision' }).click()
  await expect(review.getByRole('alert')).toBeVisible()
  await review.getByLabel('Tell them; nothing is asked').check()
  await review.getByLabel(/^Reason/).first().fill('A spelling fix.')
  await review.getByRole('button', { name: 'Record the decision' }).click()
  await expect(rp.getByTestId('change-reviews')).toHaveCount(0)

  // the investor sees what changed and has nothing to do; the lead sees it in force
  await myDeal()
  const update = ip.getByTestId('deal-updates').getByTestId('deal-update')
  await expect(update).toHaveCount(1)
  await expect(update).toContainText('nothing for you to do')
  await expect(update).toContainText('Fixed a typo in the memo.')
  await expect(update.getByTestId('differences')).toContainText('Seedling grows tomatoes.')
  // a memo that was empty before reads as nothing, not as a word
  await expect(update.getByTestId('differences')).not.toContainText('null')
  await expect(ip.getByTestId('reconfirm')).toHaveCount(0)
  expect((await lastMail(inv.email)).subject).toMatch(/^A deal you committed to has been updated/)
  await lp.reload()
  await expect(lp.getByTestId('lead-changes').getByTestId('lead-change').first()).toContainText('In force')
  await expect(lp.getByTestId('lead-changes').getByTestId('lead-change').first()).toContainText('A spelling fix.')

  // a new valuation with content approval on: reviewed, then approved by an approver
  await sql('UPDATE deal_config SET content_approval_in_sandbox = true')
  await expect(lp.getByRole('button', { name: 'Change this deal' })).toBeVisible()
  await lp.getByRole('button', { name: 'Change this deal' }).click()
  await editor.getByTestId('section-terms').click()
  await editor.getByLabel(/^Pre-money valuation/).fill('6,000,000')
  // the company's name is on the deal sheet, so people who signed sign again
  await editor.getByTestId('section-company').click()
  await editor.getByLabel(/^Legal name/).fill('Seedling Holdings Ltd')
  await editor.getByLabel(/^What changes and why/).fill('The company raised its valuation.')
  await editor.getByRole('button', { name: 'Send this change' }).click()
  await expect(lp.getByTestId('change-note')).toBeVisible()
  // one change at a time: the button stays, the server refuses a second; taking back is offered while open
  await expect(lp.getByTestId('lead-changes').getByTestId('lead-change').first().getByRole('button', { name: 'Take back this change' })).toBeVisible()

  await rp.goto(`/ops/${dealId}`)
  const second = rp.getByTestId('change-reviews').getByTestId('change-review')
  await expect(second).toContainText('People must reconfirm')
  await expect(second).toContainText('sign again')
  await expect(second.getByRole('button', { name: 'Pass the review' })).toBeVisible()
  await second.getByRole('button', { name: 'Pass the review' }).click()
  await expect(second).toContainText('Waiting for an approver')
  await expect(second.getByRole('button', { name: 'Pass the review' })).toHaveCount(0)

  const approver = await staff(browser, 'approver', ['approver'])
  const ap = approver.page
  await ap.goto('/approvals')
  await expect(ap.getByTestId('change-approval-queue').getByRole('link', { name: 'The company raised its valuation.' })).toBeVisible()
  await ap.getByTestId('change-approval-queue').getByRole('link', { name: 'The company raised its valuation.' }).click()
  const appr = ap.getByTestId('change-approval')
  await expect(appr.getByTestId('differences')).toContainText('6,000,000')
  await readableInBothThemes(ap, 'change approval')
  await ap.getByLabel(/^Your name, as you state it/).fill('Avery Approver')
  await ap.getByRole('button', { name: 'Approve the change' }).click()
  await expect(ap.getByTestId('change-approved')).toBeVisible()
  // with approval on, the deal sheet's template would need its own approval too (not this test's subject)
  await sql('UPDATE deal_config SET content_approval_in_sandbox = false')

  // the investor reconfirms and signs the new deal sheet
  expect((await lastMail(inv.email)).subject).toMatch(/^(The terms of a deal you committed to have changed|Do not send money)/)
  await myDeal()
  const rc = ip.getByTestId('reconfirm')
  await expect(rc).toContainText('The company raised its valuation.')
  // the changed terms as on the payment page: pounds with the sign and pence, not raw pence, and no unit suffix
  await expect(rc.getByTestId('reconfirm-differences')).toContainText('£6,000,000.00')
  await expect(rc.getByTestId('reconfirm-differences')).not.toContainText('600000000')
  await expect(rc.getByTestId('reconfirm-differences')).not.toContainText('minor')
  await readableInBothThemes(ip, 'investor reconfirm')
  await expect(rc).toContainText('Your deal sheet changed')
  await rc.getByLabel(/I have read the changes and agree/).check()
  await rc.getByLabel('Type your full name to sign').fill('Tina Typo')
  await rc.getByRole('button', { name: 'Agree', exact: true }).click()
  await expect(ip.getByTestId('reconfirm')).toHaveCount(0)
  const signed = await sql<{ n: string }>(
    'SELECT count(*)::text AS n FROM signature_record s JOIN participation p ON p.id = s.participation_id WHERE p.deal_id = $1 AND s.superseded_at IS NULL',
    [dealId],
  )
  expect(signed[0]!.n).toBe('1')
  expect((await sql<{ n: string }>("SELECT count(*)::text AS n FROM reconfirmation WHERE deal_id = $1 AND state = 'pending'", [dealId]))[0]!.n).toBe('0')
  await expect(ip.getByTestId('deal-updates').getByTestId('deal-update')).toHaveCount(2)
  await readableInBothThemes(ip, 'investor deal updates')

  // the pages read on a phone
  for (const page of [lp, ip]) {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.reload()
    await noSideScroll(page)
  }
})

test('TC-NTF-01 / TC-NTF-03 on screen: an admin edits an investor mail, which waits for an approver; urgent notices cannot be changed; the fixed wording can be put back', async ({
  browser,
}) => {
  const admin = await staff(browser, 'admin', ['admin'])
  const p = admin.page
  await p.goto('/')
  const box = p.getByTestId('mail-templates')
  const item = box.getByTestId('mail-template').filter({ hasText: 'Payment needed' })
  await expect(item).toContainText('Fixed wording')
  await readableInBothThemes(p, 'admin home, mail wording')
  await item.getByText('Edit the wording').click()
  await item.getByLabel(/^Text/).fill('Hello,\n\nPlease pay for deal {code} by {deadline}. {company}')
  await item.getByRole('button', { name: 'Save this wording' }).click()
  await expect(item.getByRole('alert')).toContainText('{company} is not a field')
  await item.getByLabel(/^Text/).fill('Hello,\n\nPlease pay for deal {code} by {deadline}.\n{operator}')
  await item.getByRole('button', { name: 'Save this wording' }).click()
  await expect(item).toContainText('waiting for approval')
  await box.getByText('Urgent notices (cannot be changed)').click()
  await expect(box).toContainText('Do not send money')

  const approver = await staff(browser, 'approver', ['approver'])
  await approver.page.goto('/approvals')
  const w = approver.page.getByTestId('wording-approvals').getByTestId('wording-approval')
  await expect(w).toContainText('Please pay for deal {code} by {deadline}.')
  await readableInBothThemes(approver.page, 'approvals, wording')
  await w.getByLabel(/^Your name, as you state it/).fill('Avery Approver')
  await w.getByRole('button', { name: 'Approve this wording' }).click()
  await expect(approver.page.getByTestId('wording-approvals')).toHaveCount(0)

  await p.reload()
  const again = p.getByTestId('mail-templates').getByTestId('mail-template').filter({ hasText: 'Payment needed' })
  await expect(again).toContainText('approved')
  await again.getByText('Edit the wording').click()
  await expect(again.getByRole('button', { name: 'Put the fixed wording back' })).toBeVisible()
  await again.getByRole('button', { name: 'Put the fixed wording back' }).click()
  await expect(p.getByTestId('mail-templates').getByTestId('mail-template').filter({ hasText: 'Payment needed' })).toContainText('Fixed wording')
})

test('TC-ALO-01 / TC-ALO-04 / R-PAY-07 on screen: a full deal; one investor joins the waiting list and leaves and joins again; the lead proposes a lower amount to another, who cannot agree to an increase with no room, keeps hers, then agrees and signs again; the lead lets the first in; another takes the room and he is not offered the list again; once there is room he commits; a wrong reference reaches the reviewers', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const { lead, reviewer, dealId } = await liveDeal(browser, { full: 'stop' })
  const ann = await committedAndSigned(browser, lead, 'ann', 'Ann Full', '300,000')
  // both investors are on a phone throughout
  await ann.page.setViewportSize({ width: 375, height: 800 })

  // R-ALO-03, R-ALO-04: the deal is full, so no commit button: the waiting list instead, with nothing to pay
  const bo = await onTheDeal(browser, lead, 'bo', 'Bo Waits')
  await bo.page.setViewportSize({ width: 375, height: 800 })
  const join = async () => {
    const commit = bo.page.getByTestId('commit')
    await commit.getByLabel(/^Amount/).fill('50,000')
    await commit.getByRole('button', { name: 'Show what I would pay' }).click()
    const full = commit.getByTestId('capacity')
    await expect(full).toContainText('This deal is full. You can join the waiting list instead.')
    await expect(commit.getByTestId('quote')).toHaveCount(0)
    await expect(commit.getByRole('button', { name: /^Commit / })).toHaveCount(0)
    const ask = full.getByRole('button', { name: 'Join the waiting list for £50,000.00' })
    await expect(ask).toBeVisible()
    await ask.click()
  }
  await join()
  const me = bo.page.getByTestId('waitlist-me')
  await expect(me).toContainText('Waiting')
  await expect(me).toContainText('You asked for £50,000.00')
  await expect(bo.page.getByTestId('commit')).toHaveCount(0)
  await expect(bo.page.getByTestId('participation')).toHaveCount(0)
  await noSideScroll(bo.page)
  await me.getByRole('button', { name: 'Leave the waiting list' }).click()
  await expect(me).toHaveCount(0)
  await join()
  await expect(me).toContainText('Waiting')
  expect(
    (await sql('SELECT state FROM waitlist_entry WHERE user_id = (SELECT id FROM user_account WHERE email = $1) ORDER BY created_at', [bo.email])).map(
      (r) => r.state,
    ),
  ).toEqual(['ended', 'waiting'])

  // no room, so the lead cannot let him in yet
  const lp = lead.page
  await lp.goto(`/deals/${dealId}`)
  const wl = lp.getByTestId('deal-life').getByTestId('waitlist')
  const boRow = wl.getByTestId('waitlist-row').filter({ hasText: 'Bo Waits' })
  await expect(wl).toContainText('Room left in the deal: £0.00')
  await boRow.getByRole('button', { name: 'Let them in' }).click()
  await expect(wl.getByRole('alert')).toBeVisible()

  // R-ALO-01: the lead proposes a new amount to Ann
  const propose = async (amount = '250,000') => {
    await lp.reload()
    const row = lp.getByTestId('lead-panel').getByTestId('panel-row').filter({ hasText: 'Ann Full' })
    await row.getByRole('button', { name: 'Actions for Ann Full' }).click()
    await row.getByRole('button', { name: 'Propose a new amount' }).click()
    await row.getByLabel('New amount').fill(amount)
    await row.getByRole('button', { name: 'Send the proposal' }).click()
    await expect(row.getByLabel('New amount')).toHaveCount(0)
  }
  await propose()

  // one screen: now and proposed; she keeps her amount, and nothing changes
  const ap = ann.page
  await ap.reload()
  const card = ap.getByTestId('participation')
  await expect(card).toContainText('Confirm amount')
  const box = card.getByTestId('amount-proposal')
  await expect(box.getByTestId('proposal-no-room')).toHaveCount(0)
  await expect(box).toContainText('£300,000.00')
  await expect(box.getByTestId('proposed-due')).toHaveText('£250,000.00')
  await expect(box).toContainText('If you do not answer, or say no, your amount stays as it is.')
  await expect(card.getByRole('button', { name: 'Change the amount' })).toHaveCount(0)
  await expect(box.getByRole('button', { name: 'Agree' })).toBeDisabled()
  await noSideScroll(ap)
  await readableInBothThemes(ap, 'investor answers a proposed amount')
  await box.getByRole('button', { name: 'Keep my amount' }).click()
  await expect(box).toHaveCount(0)
  await expect(card).toContainText('To pay')
  await expect(card).toContainText('£300,000.00')

  // asked again, she agrees, and signs the deal sheet again with the new amount
  await propose()
  await ap.reload()
  await box.getByLabel(/I agree to the new amount of £250,000.00 to pay/).check()
  await box.getByRole('button', { name: 'Agree' }).click()
  await expect(box).toHaveCount(0)
  await expect(card).toContainText('To sign')
  await card.getByRole('button', { name: 'Deal sheet' }).click()
  await card.getByLabel(/I have read this document/).check()
  await card.getByLabel('Type your full name to sign').fill('Ann Full')
  await card.getByRole('button', { name: 'Sign', exact: true }).click()
  const pay = ap.getByTestId('instructions')
  await expect(pay.getByTestId('still-to-pay')).toHaveText('Still to pay: £250,000.00')

  // now there is room: the lead lets Bo in, and he commits as anyone would
  await lp.reload()
  await expect(wl).toContainText('Room left in the deal: £50,000.00')
  await boRow.getByRole('button', { name: 'Let them in' }).click()
  await expect(boRow).toContainText('let in')

  // someone else takes the room first: £60,000 does not fit and offers no waiting list (only a smaller amount would);
  // then £49,500 leaves less than the minimum, so Bo, already let in, is told the deal is full and is not offered to join again
  // meanwhile the lead proposes £260,000 to Ann while it still fits
  await propose('260,000')
  const cy = await onTheDeal(browser, lead, 'cy', 'Cy Takes')
  const cyCommit = cy.page.getByTestId('commit')
  await cyCommit.getByLabel(/^Amount/).fill('60,000')
  await cyCommit.getByRole('button', { name: 'Show what I would pay' }).click()
  await expect(cyCommit.getByTestId('capacity')).toContainText('This deal has room only for a commitment of up to £50,000.00.')
  await expect(cyCommit.getByRole('button', { name: /^Join the waiting list/ })).toHaveCount(0)
  await cyCommit.getByLabel(/^Amount/).fill('49,500')
  await cyCommit.getByRole('button', { name: 'Show what I would pay' }).click()
  await cyCommit.getByLabel('Who is investing').selectOption({ label: 'Cy Takes' })
  // Ann opens the proposal while it still fits and ticks; Cy commits before she presses Agree.
  // Her page's clock is held, so its 15-second refresh cannot remove Agree first or show the refusal for it
  await ap.clock.install()
  await ap.reload()
  await ap.clock.pauseAt((await ap.evaluate(() => Date.now())) + 1000)
  await box.getByLabel(/I agree to the new amount of £260,000.00 to pay/).check()
  await cyCommit.getByRole('button', { name: /^Commit / }).click()
  await expect(cy.page.getByTestId('participation')).toContainText('£49,500.00')
  await box.getByRole('button', { name: 'Agree' }).click()
  // refused, and her page shows why and what is true now without a reload
  await expect(box.getByRole('alert')).toBeVisible()
  await expect(box.getByTestId('proposal-no-room')).toBeVisible()
  await bo.page.reload()
  await expect(me).toContainText('Let in')
  const commit = bo.page.getByTestId('commit')
  await commit.getByLabel(/^Amount/).fill('50,000')
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  await expect(commit.getByTestId('capacity')).toContainText('This deal is full.')
  await expect(commit.getByRole('button', { name: /^Join the waiting list/ })).toHaveCount(0)
  // Ann's increase no longer fits: her open page says so and offers no Agree (R-ALO-03)
  await expect(box.getByTestId('proposal-no-room')).toContainText('There is no longer room in the deal for this amount')
  await expect(box.getByRole('button', { name: 'Agree' })).toHaveCount(0)

  // the lead removes Cy, and the room is back
  await lp.reload()
  const cyRow = lp.getByTestId('lead-panel').getByTestId('panel-row').filter({ hasText: 'Cy Takes' })
  await cyRow.getByRole('button', { name: 'Actions for Cy Takes' }).click()
  await cyRow.getByRole('button', { name: 'Remove', exact: true }).click()
  await cyRow.getByRole('button', { name: 'Remove from this deal' }).click()
  await expect(cyRow.getByRole('button', { name: 'Remove from this deal' })).toHaveCount(0)
  // Ann's open page offers Agree again, not ticked, at its next 15-second refresh; she keeps her amount
  await expect(box.getByTestId('proposal-no-room')).toBeVisible()
  await ap.clock.runFor(15_000)
  await expect(box.getByTestId('proposal-no-room')).toHaveCount(0)
  await expect(box.getByRole('button', { name: 'Agree' })).toBeDisabled()
  await ap.clock.resume()
  await box.getByRole('button', { name: 'Keep my amount' }).click()
  await expect(box).toHaveCount(0)
  await card.getByRole('button', { name: 'Payment details' }).click()
  await expect(pay.getByTestId('still-to-pay')).toHaveText('Still to pay: £250,000.00')
  await bo.page.reload()
  await commit.getByLabel(/^Amount/).fill('50,000')
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  await expect(commit.getByTestId('quote')).toBeVisible()
  await commit.getByLabel('Who is investing').selectOption({ label: 'Bo Waits' })
  await commit.getByRole('button', { name: /^Commit / }).click()
  await expect(bo.page.getByTestId('participation')).toContainText('£50,000.00')
  await expect(me).toHaveCount(0)

  // R-PAY-07: what to do when a payment has not arrived, and a wrong reference goes on the reviewers' list
  await expect(pay).toContainText('MT103')
  const wrong = pay.getByRole('button', { name: 'I used the wrong reference' })
  await expect(wrong).toBeVisible()
  await wrong.click()
  // a note of only spaces is stopped on the screen with a plain reason
  await pay.getByLabel(/^What did you send/).fill('   ')
  await pay.getByRole('button', { name: 'Tell the operator' }).click()
  await expect(pay).toContainText('Say what you sent.')
  await noSideScroll(ap)
  await pay.getByLabel(/^What did you send/).fill('On 2 March I sent £250,000 from A Full with the reference ANN-WRONG.')
  await pay.getByRole('button', { name: 'Tell the operator' }).click()
  await expect(pay).toContainText('The operator will check the payment and be in touch.')
  await reviewer.page.goto('/ops/money')
  await expect(reviewer.page.getByTestId('payment-checks')).toContainText('ANN-WRONG')
})

test('TC-ALO-01 / R-PAY-07 on screen, on a phone: a proposal answered while the identity check is still open; a deal sheet left open closes when the proposal arrives, and the one signed after names the new amount; once the deal page is closed to her, a wrong reference is still reported from her documents', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const { lead, reviewer } = await liveDeal(browser)
  const di = await onTheDeal(browser, lead, 'di', 'Di Pending', false)
  const dp = di.page
  await dp.setViewportSize({ width: 375, height: 800 })
  const commit = dp.getByTestId('commit')
  await commit.getByLabel(/^Amount/).fill('20,000')
  await commit.getByRole('button', { name: 'Show what I would pay' }).click()
  await expect(commit.getByTestId('quote')).toBeVisible()
  await commit.getByLabel('Who is investing').selectOption({ label: 'Di Pending' })
  await commit.getByRole('button', { name: /^Commit / }).click()
  const card = dp.getByTestId('participation')
  await expect(card).toContainText('Verifying')
  await card.getByRole('button', { name: 'Deal sheet' }).click()
  await expect(card.getByTestId('deal-sheet')).toBeVisible()

  // the lead proposes less; her open page shows it although her identity check is still open (R-ALO-01)
  const lp = lead.page
  await lp.reload()
  const row = lp.getByTestId('lead-panel').getByTestId('panel-row').filter({ hasText: 'Di Pending' })
  await row.getByRole('button', { name: 'Actions for Di Pending' }).click()
  await row.getByRole('button', { name: 'Propose a new amount' }).click()
  await row.getByLabel('New amount').fill('10,000')
  await row.getByRole('button', { name: 'Send the proposal' }).click()
  await expect(row.getByLabel('New amount')).toHaveCount(0)
  await caughtUp(dp)
  const box = card.getByTestId('amount-proposal')
  await expect(box.getByTestId('proposed-due')).toHaveText('£10,000.00')
  await expect(card).toContainText('Verifying')
  await expect(card.getByTestId('deal-sheet')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Deal sheet' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Change the amount' })).toHaveCount(0)
  await noSideScroll(dp)
  await box.getByLabel(/I agree to the new amount of £10,000.00 to pay/).check()
  await box.getByRole('button', { name: 'Agree' }).click()
  await expect(box).toHaveCount(0)

  // the identity check passes; the deal sheet she signs now is for the new amount
  await approveKyc(di.email)
  await caughtUp(dp)
  await expect(card).toContainText('To sign')
  await card.getByRole('button', { name: 'Deal sheet' }).click()
  await card.getByLabel(/I have read this document/).check()
  await card.getByLabel('Type your full name to sign').fill('Di Pending')
  await card.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(dp.getByTestId('instructions').getByTestId('still-to-pay')).toHaveText('Still to pay: £10,000.00')

  // her investor statement expires: the deal page is closed to her, her documents still take a wrong-reference report
  await sql("UPDATE eligibility_statement SET expires_at = now() - interval '1 day' WHERE user_id = (SELECT id FROM user_account WHERE email = $1)", [di.email])
  await dp.reload()
  await expect(dp.getByTestId('participation')).toHaveCount(0)
  await dp.goto('/')
  const docs = dp.getByTestId('my-documents')
  const report = docs.getByRole('button', { name: 'I used the wrong reference' })
  await expect(report).toBeVisible({ timeout: 5_000 })
  await report.click()
  await docs.getByLabel(/^What did you send/).fill('On 3 March I sent £10,000 from D Pending with the reference DI-WRONG.')
  await noSideScroll(dp)
  await docs.getByRole('button', { name: 'Tell the operator' }).click()
  await expect(docs).toContainText('The operator will check the payment and be in touch.')
  await reviewer.page.goto('/ops/money')
  await expect(reviewer.page.getByTestId('payment-checks')).toContainText('DI-WRONG')
})
