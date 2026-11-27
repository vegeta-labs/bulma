// P step 3 (plan 05 §5.2, §5.6, §5.7): plays the demo scenario on a throwaway database under a fixed clock and records what
// the screens read, for the static demo pack. Export only: run by hand, never by the app, its tests or a deployment.
//
//   node --experimental-strip-types --no-warnings scripts/demo-snapshot.ts
//
// Needs Docker (the faketime Postgres of scripts/demo-export/Dockerfile, on its own port) and Playwright's Chromium. Writes
// `.demo-export/` (snapshot.json and files/); the container and its data go at the end, whatever happens.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import pg from 'pg'
import { demoScenario } from '../src/demo/scenario.ts'
import { printedAddress } from '../src/demo/snapshot.ts'
import { base32, codeAt, stepOf } from '../src/lib/totp.ts'
import { buildServer } from '../src/server/app.ts'
import { bootstrapAdmin, createUser, grantRole } from '../src/server/auth.ts'
import { instructionsPdf, type InstructionsForPdf } from '../src/server/d3Invest.ts'
import { demoSignIns, seedDemo } from '../src/server/demoSeed.ts'
import { fileFace, fileProblems, firstDifference, keyShown } from './demo-export/files.ts'
import { Keyring } from '../src/store/crypto.ts'
import { pool, tx } from '../src/store/db.ts'
import { migrate, ROLES, type RolePasswords } from '../src/store/migrate.ts'
import { ensureInstance } from '../src/store/packs.ts'
import { exportClock } from './demo-export/clock.ts'
import { holdLock } from './demo-export/lock.ts'
import { EXPORT_SOURCE, noteSource, sourceState } from './demo-export/source.ts'
import { ALLOWED_FIELDS } from './demo-export/fields.ts'
import {
  filePath,
  getKey,
  postKey,
  replaceSecrets,
  scenarioProblems,
  secretsIn,
  tokensIn,
  unknownFields,
  type Answer,
  type Snapshot,
  type View,
} from './demo-export/record.ts'

/** The fixed clock of the pack: what "today" is on every screen. A Monday, 10:00 in London (GMT = UTC in November). */
export const DEMO_CLOCK = '2026-11-02T10:00:00.000Z'
const DAY = 86_400_000
const HOUR = 3_600_000
const OUT = '.demo-export'
const IMAGE = 'bulma-demo-export-pg'
const CONTAINER = `bulma-demo-export-${randomBytes(4).toString('hex')}`
const DB_PORT = Number(process.env.DEMO_EXPORT_DB_PORT ?? 55491)
const PORT = Number(process.env.DEMO_EXPORT_PORT ?? 4329)
const BASE = `http://127.0.0.1:${PORT}`
/** Fixed amounts the investor's "Show what I would pay" answers in the pack (plan §5.2); any other shows the demo sentence. */
const QUOTE_AMOUNTS = [500_000n, 1_000_000n, 2_500_000n]
/** The only changes the screens may send while being read; both change nothing once the investors are in. */
const CRAWL_MAY_SEND = new Set(['/api/invite/accept', '/api/invite/open'])

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString()

async function main() {
  holdLock('the demo export')
  const at = Date.parse(DEMO_CLOCK)
  const source = sourceState()
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(`${OUT}/files`, { recursive: true })
  console.log('building the web app and the export database image')
  sh('npm', ['run', 'build', '--silent'])
  sh('docker', ['build', '-q', '-t', IMAGE, 'scripts/demo-export'])
  // the container goes even when the export dies outside the try below (an error thrown from a browser callback, Ctrl-C, a
  // `docker run` that made it and then failed); removing one that is not there does nothing
  const removeContainer = () => {
    try {
      execFileSync('docker', ['rm', '-f', '-v', CONTAINER], { stdio: 'ignore' })
    } catch {
      console.error(`could not remove the export database ${CONTAINER}: remove it by hand`)
    }
  }
  // Ctrl-C or a kill ends through 'exit' (the lock's signal handlers, lock.ts), so this runs then too (Codex P r4 #2)
  process.once('exit', removeContainer)
  const pgPassword = randomBytes(12).toString('hex')
  sh('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-p', `127.0.0.1:${DB_PORT}:5432`, IMAGE])
  const clock = exportClock(CONTAINER)
  let browser: Browser | undefined
  let close: (() => Promise<void>) | undefined
  try {
    const ownerUrl = `postgres://postgres:${pgPassword}@127.0.0.1:${DB_PORT}/postgres`
    await ready(ownerUrl)
    // a day before the first investor's step, all the set-up happens; then each investor on their own day
    clock.set(at - (Math.max(...demoScenario.investors.map((x) => x.daysAtStep)) + 1) * DAY)
    const passwords = Object.fromEntries(ROLES.map((r) => [r, randomBytes(12).toString('hex')])) as RolePasswords
    await migrate(ownerUrl, passwords)
    const db = pool(`postgres://bulma_app:${passwords.bulma_app}@127.0.0.1:${DB_PORT}/postgres`)
    const keys = [randomBytes(32), randomBytes(32)] as const
    const k = new Keyring([{ id: 'k', key: keys[0] }], 'k', keys[1])
    await ensureInstance(db, k)
    const adminPassword = randomBytes(16).toString('hex')
    await bootstrapAdmin(db, k, 'admin@export.demo.invalid', adminPassword)
    // the reviewer's view: an ordinary staff reviewer (plan §4.3's exception), since the run's own reviewer is retired when
    // the run ends and the screens are read after it
    const reviewer = { email: 'reviewer@export.demo.invalid', password: randomBytes(16).toString('hex'), secret: randomBytes(20) }
    await tx(db, async (c) => {
      const id = await createUser(c, k, { email: reviewer.email, name: 'Sample reviewer', password: reviewer.password, by: null })
      const e = k.encrypt(reviewer.secret)
      await c.query(
        'UPDATE user_account SET must_change_password = false, mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1',
        [id, e.ciphertext, e.keyId, e.wrappedDek],
      )
      await grantRole(c, k, id, 'reviewer', null)
    })
    const app = await buildServer({ db, k, webRoot: 'dist/web', secureCookies: false })
    close = async () => {
      await app.close()
      await db.end()
    }
    console.log('playing the scenario')
    const seeded = await seedDemo(app, db, k, {
      by: null,
      via: 'env',
      // an hour before the day boundary, so every step of the walk lies inside its day: the days shown are the same at the
      // fixed clock and whenever the screens are read after it (Codex P r1 #6)
      beforeInvestor: async (x) => clock.set(at - x.daysAtStep * DAY - HOUR),
    })
    clock.set(at)
    // what the export made up and never shows (plan §5.7): no answer or file may hold any of these, in any usual spelling
    const neverShown = [
      pgPassword,
      adminPassword,
      reviewer.password,
      ...Object.values(passwords),
      ...demoSignIns(seeded.accounts).map((x) => x.password),
      seeded.accounts.reviewer.password,
      ...[reviewer.secret, seeded.accounts.reviewer.mfaSecret, ...keys].flatMap((b) => [b.toString('hex'), b.toString('base64'), base32(b)]),
    ]
    await app.listen({ host: '127.0.0.1', port: PORT })

    const goku = seeded.accounts.investors[0]!
    const sessions: Record<View, Session> = {
      investor: await signIn(goku.email, goku.password),
      lead: await signIn(seeded.accounts.lead.email, seeded.accounts.lead.password),
      reviewer: await signIn(reviewer.email, reviewer.password, reviewer.secret),
    }
    const { live, draft, inReview } = seeded.deals
    const syndicate = ((await getJson(sessions.lead, '/api/syndicates')) as { managed: Array<{ id: string; name: string }> }).managed.find(
      (s) => s.name === demoScenario.syndicate.name,
    )!.id
    const links = (await getJson(sessions.lead, `/api/deals/${live}/links`)) as { links: Array<{ id: string; label: string }> }
    const link = links.links.find((l) => l.label === demoScenario.link.name)!
    const inviteUrl = ((await getJson(sessions.lead, `/api/deals/${live}/links/${link.id}/url`)) as { url: string }).url
    const inviteToken = new URL(inviteUrl, BASE).searchParams.get('token')!

    // the payment details' "Check these details" page: its link carries a token, so it is read as the investor opens it
    const mine = (await getJson(sessions.investor, `/api/my/deals/${live}`)) as { participations: Array<{ id: string }> }
    const verifyUrl = ((await getJson(sessions.investor, `/api/my/participations/${mine.participations[0]!.id}/instructions`)) as { verify_url?: string })
      .verify_url
    if (!verifyUrl?.startsWith('/verify-instruction?')) throw new Error(`the payment details gave no check link: ${String(verifyUrl)}`)

    const pages: Snapshot['pages'] = [
      { n: '1', view: 'lead', path: `/deals/${inReview}`, what: 'Kame House Ltd with the reviewer' },
      { n: '2', view: 'reviewer', path: `/review/${inReview}`, what: 'Kame House Ltd review' },
      { n: '3', view: 'lead', path: `/deals/${draft}`, what: 'Dragon Radar Ltd draft' },
      { n: '4', view: 'lead', path: `/deals/${live}`, what: 'Senzu Labs live: investors, links' },
      { n: '5', view: 'investor', path: `/invite?token=${inviteToken}`, what: 'the invitation' },
      { n: '6', view: 'investor', path: `/invest/${live}`, what: 'Senzu Labs as Goku sees it: key terms' },
      // the site's items 7 to 10 (plan §5.5), each with its own address: the quote is typed on the deal page; the payment step
      // opens from its address in the pack (the app has no such address, so the export presses the button; Codex P r1 #9)
      { n: '7', view: 'investor', path: `/invest/${live}`, what: 'Senzu Labs as Goku sees it: Show what I would pay' },
      { n: '8', view: 'investor', path: `/invest/${live}?step=pay`, what: 'the payment step', click: ['Payment details'] },
      { n: '9', view: 'lead', path: `/deals/${live}`, what: 'Senzu Labs investors: totals' },
      { n: '10', view: 'lead', path: `/deals/${live}`, what: 'Senzu Labs investors: rows and days' },
      { n: 'home-lead', view: 'lead', path: '/', what: 'lead home' },
      { n: 'deals-lead', view: 'lead', path: '/deals', what: 'lead deals' },
      { n: 'syndicates-lead', view: 'lead', path: '/syndicates', what: 'lead syndicates' },
      { n: 'syndicate-lead', view: 'lead', path: `/syndicates/${syndicate}`, what: 'Capsule Angels' },
      { n: 'home-reviewer', view: 'reviewer', path: '/', what: 'reviewer home' },
      { n: 'review-queue', view: 'reviewer', path: '/review', what: 'deal review queue' },
      { n: 'review-live', view: 'reviewer', path: `/review/${live}`, what: 'Senzu Labs review record' },
      { n: 'ops', view: 'reviewer', path: '/ops', what: 'operations' },
      { n: 'ops-live', view: 'reviewer', path: `/ops/${live}`, what: 'Senzu Labs operations' },
      { n: 'ops-money', view: 'reviewer', path: '/ops/money', what: 'money' },
      { n: 'money-live', view: 'reviewer', path: `/money/${live}`, what: 'Senzu Labs money' },
      { n: 'home-investor', view: 'investor', path: '/', what: 'investor home' },
      { n: 'deals-investor', view: 'investor', path: '/deals', what: 'investor deals' },
      { n: 'verify-investor', view: 'investor', path: verifyUrl, what: 'payment details check' },
    ]

    browser = await chromium.launch()
    console.log('reading the screens: once to settle, once to record, once to compare')
    await crawl(browser, sessions, pages) // a first open may make something (payment details), so it is not recorded
    // the read-only POSTs (fixed quotes, the invitation the link opens) are sent in both measured passes too (Codex P r1 #7)
    const first = await crawl(browser, sessions, pages)
    const firstPosts = await readOnlyPosts(sessions.investor, live, inviteToken)
    const again = await crawl(browser, sessions, pages)
    const againPosts = await readOnlyPosts(sessions.investor, live, inviteToken)
    const moved: string[] = []
    // the report names the view, the route (tokens hidden) and the place that moved, never a value (Codex P r2 #12)
    const compare = async (what: string, a: Record<string, Answer>, b: Record<string, Answer>, face = async (x: Answer) => x as unknown) => {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(key in a) || !(key in b)) moved.push(`${what} ${keyShown(key)} (${key in a ? 'only first' : 'only second'})`)
        else {
          const d = firstDifference(await face(a[key]!), await face(b[key]!))
          if (d) moved.push(`${what} ${keyShown(key)} (differs at ${d})`)
        }
      }
    }
    await compare('answer', first.answers, again.answers)
    await compare('quote or invitation', firstPosts, againPosts)
    await compare('file', first.files, again.files, async (x) => fileFace(x, x.file ? (first.blobs.get(x.file.path) ?? again.blobs.get(x.file.path)) : undefined))
    if (moved.length) throw new Error(`reading the screens again changed these:\n${moved.join('\n')}`)
    if (first.changes.length)
      console.log(`screens tried these changes, stopped (the pack answers them with the demo sentence):\n${[...new Set(first.changes)].join('\n')}`)

    const snap: Snapshot = {
      format: 1,
      clock: DEMO_CLOCK,
      views: { investor: { name: goku.name }, lead: { name: seeded.accounts.lead.name }, reviewer: { name: 'Sample reviewer' } },
      get: Object.fromEntries(Object.entries(first.answers).filter(([key]) => key.includes(' GET '))),
      post: { ...Object.fromEntries(Object.entries(first.answers).filter(([key]) => key.includes(' POST '))), ...firstPosts },
      pages,
    }
    // files the screens link to or embed
    for (const [key, f] of Object.entries(first.files)) snap.get[key] = f

    const secrets = new Map<string, string>()
    const stand = (s: string, kind: string) => secrets.has(s) || secrets.set(s, `demo-${kind}-${secrets.size + 1}`)
    for (const v of Object.values(sessions)) {
      stand(v.cookie, 'session')
      stand(v.csrf, 'csrf')
    }
    for (const t of new Set([inviteToken, ...tokensIn(snap)])) stand(t, 'token')
    const clean = replaceSecrets(snap, secrets)
    const blobs = await rebuildInstructions(clean, first.blobs)
    // kept under another name until it passes, to look at
    writeFileSync(`${OUT}/snapshot.rejected.json`, `${JSON.stringify(clean, null, 1)}\n`)
    const wrong = scenarioProblems(clean, { live })
    if (wrong.length) throw new Error(`the export does not match the scenario:\n${wrong.join('\n')}`)
    const unknown = unknownFields(
      [...Object.values(clean.get), ...Object.values(clean.post)].map((a) => a.body),
      ALLOWED_FIELDS,
    )
    if (unknown.length) throw new Error(`answers carry fields not on the list in scripts/demo-export/fields.ts; check each and add it:\n${unknown.join('\n')}`)
    if (secretsIn(JSON.stringify(clean), [...secrets.keys(), ...neverShown]).length) throw new Error('the snapshot still holds a secret')
    // only the files the snapshot names, and none that still holds a secret (a PDF's printed link included; plan §5.7); a
    // JSON or CSV file's field names are on a reviewed list too (evidence packs, the investors list)
    for (const a of Object.values(clean.get)) {
      if (!a.file) continue
      const bytes = blobs.get(a.file.path)!
      const wrong = await fileProblems(a.file.path, a.file.type, bytes, [...secrets.keys(), ...neverShown])
      if (wrong.length) throw new Error(wrong.join('\n'))
      mkdirSync(dirname(`${OUT}/${a.file.path}`), { recursive: true })
      writeFileSync(`${OUT}/${a.file.path}`, bytes)
    }
    renameSync(`${OUT}/snapshot.rejected.json`, `${OUT}/snapshot.json`)
    noteSource(EXPORT_SOURCE, source)
    console.log(`recorded ${Object.keys(clean.get).length} reads, ${Object.keys(clean.post).length} quotes and invitations; ${secrets.size} secrets replaced`)
  } finally {
    clock.uninstall()
    await browser?.close().catch(() => undefined)
    await close?.().catch(() => undefined)
    removeContainer()
    process.off('exit', removeContainer)
  }
}

/**
 * TC-DEMO-09's figures, from the answers the pack will show: the lead's totals, each investor's step and days, what Goku has
 * to pay. The export stops if any differs from the scenario (plan §3).
 */
interface Session {
  cookie: string
  csrf: string
}

async function ready(url: string) {
  for (let i = 0; i < 60; i++) {
    const c = new pg.Client({ connectionString: url })
    try {
      await c.connect()
      await c.query('SELECT 1')
      await c.end()
      // the image's first start stops and starts the server once; wait for the second
      if (i > 0) return
    } catch {
      await c.end().catch(() => undefined)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('the export database did not start')
}

async function signIn(email: string, password: string, secret?: Buffer): Promise<Session> {
  const code = secret ? codeAt(secret, stepOf(Date.now())) : undefined
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, ...(code ? { code } : {}) }),
  })
  if (!r.ok) throw new Error(`sign-in of ${email} refused (${r.status})`)
  const cookie = /bulma_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]
  if (!cookie) throw new Error(`sign-in of ${email} gave no session`)
  return { cookie, csrf: ((await r.json()) as { csrf: string }).csrf }
}

async function getJson(s: Session, url: string): Promise<unknown> {
  const a = await send(s, 'GET', url)
  if (a.status !== 200) throw new Error(`GET ${url} answered ${a.status}`)
  return a.body
}

async function send(s: Session, method: 'GET' | 'POST', url: string, body?: object): Promise<Answer> {
  const cookie = `bulma_session=${s.cookie}`
  const init: RequestInit =
    method === 'GET'
      ? { headers: { cookie } }
      : { method, headers: { cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }
  const r = await fetch(`${BASE}${url}`, init)
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

/** The read-only POSTs the pack answers besides the screens' own (plan §5.2): the fixed quotes and the invitation's opening. */
async function readOnlyPosts(investor: Session, live: string, inviteToken: string): Promise<Record<string, Answer>> {
  const out: Record<string, Answer> = {}
  for (const amount of QUOTE_AMOUNTS) {
    const body = { commitment_minor: String(amount) }
    out[postKey('investor', `/api/my/deals/${live}/quote`, body)] = await send(investor, 'POST', `/api/my/deals/${live}/quote`, body)
  }
  // opened as the browser opens it: the invitation it holds is then accepted, so no opened-but-unbound invitation is left
  // to count on the lead's links (a browser's home page accepts it)
  const r = await fetch(`${BASE}/api/invite/open`, {
    method: 'POST',
    headers: { cookie: `bulma_session=${investor.cookie}`, 'x-csrf-token': investor.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ token: inviteToken }),
  })
  out[postKey('investor', '/api/invite/open', { token: inviteToken })] = { status: r.status, body: await r.json().catch(() => ({})) }
  const held = r.headers.getSetCookie().find((c) => c.startsWith('bulma_invite='))?.split(';')[0]
  if (!held) throw new Error('opening the invitation gave the browser nothing to hold')
  const accepted = await fetch(`${BASE}/api/invite/accept`, {
    method: 'POST',
    headers: { cookie: `bulma_session=${investor.cookie}; ${held}`, 'x-csrf-token': investor.csrf, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!accepted.ok) throw new Error(`accepting the opened invitation answered ${accepted.status}`)
  return out
}

/** One pass over the pages, each view in its own browser: every /api answer the screens read, and the files they point to. */
async function crawl(browser: Browser, sessions: Record<View, Session>, pages: Snapshot['pages']) {
  const answers: Record<string, Answer> = {}
  const files: Record<string, Answer> = {}
  const blobs = new Map<string, Buffer>()
  const changes: string[] = []
  for (const view of ['investor', 'lead', 'reviewer'] as const) {
    const context = await browser.newContext({ viewport: { width: 880, height: 550 } })
    await context.addCookies([{ name: 'bulma_session', value: sessions[view].cookie, domain: '127.0.0.1', path: '/' }])
    const hrefs = new Set<string>()
    // every /api request goes through here: answered from the server as usual, its body kept before the page can move on.
    // The page has settled when none has been in flight for a while (waitForLoadState returns at once after a press).
    let inFlight = 0
    let lastChange = Date.now()
    let closing = false
    await context.route(
      (u) => u.pathname.startsWith('/api/'),
      async (route) => {
        const req = route.request()
        const u = new URL(req.url())
        inFlight++
        lastChange = Date.now()
        try {
          if (req.method() !== 'GET') {
            // the home page accepts held invitations and the invitation page opens one; any other change is stopped
            if (CRAWL_MAY_SEND.has(u.pathname)) await route.continue()
            else {
              changes.push(`${view} ${req.method()} ${u.pathname}`)
              await route.abort()
            }
            return
          }
          const r = await route.fetch()
          const type = r.headers()['content-type'] ?? ''
          if (type.startsWith('application/json')) answers[getKey(view, `${u.pathname}${u.search}`)] = { status: r.status(), body: await r.json() }
          else hrefs.add(`${u.pathname}${u.search}`)
          await route.fulfill({ response: r })
        } catch (e) {
          // a timed re-read (every 15 seconds) still out when the view's browser closes is dropped; anything else is a failure
          if (!closing) throw e
        } finally {
          inFlight--
          lastChange = Date.now()
        }
      },
    )
    const settled = async () => {
      const start = Date.now()
      // counted from now: the page's first request may start a moment after the navigation or press
      lastChange = start
      while (inFlight > 0 || Date.now() - lastChange < 1000) {
        if (Date.now() - start > 30_000) throw new Error('a page kept loading for 30 seconds')
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    const page = await context.newPage()
    for (const p of pages.filter((x) => x.view === view)) {
      await page.goto(`${BASE}${p.path}`)
      await settled()
      // a step the page shows only after a press (the payment details): read as the screen reads it
      for (const name of p.click ?? []) {
        await page.getByRole('button', { name, exact: true }).first().click()
        await settled()
      }
      for (const h of await page.$$eval('a[href^="/api/"], iframe[src^="/api/"], embed[src^="/api/"], object[data^="/api/"]', (els) =>
        els.map((e) => e.getAttribute('href') ?? e.getAttribute('src') ?? e.getAttribute('data') ?? ''),
      ))
        hrefs.add(h)
      if (process.env.DEMO_EXPORT_DEBUG) console.log(view, p.n, (await page.locator('main').innerText()).slice(0, 300).replace(/\s+/g, ' '))
    }
    closing = true
    await context.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
    // the investor list's filters: every choice the screen offers (its options come from the counts), read from the server
    // rather than filtered in the browser, so the pack's lists are the server's own (plan §5.2)
    for (const [key, a] of Object.entries(answers)) {
      const m = new RegExp(`^${view} GET (/api/(?:deals/[^/]+/panel|ops/deals/[^/]+/investors))$`).exec(key)
      const counts = (a.body as { counts?: { status: Record<string, number>; waiting: Record<string, number> } }).counts
      if (!m || !counts) continue
      for (const status of ['', ...Object.keys(counts.status)])
        for (const waiting of ['', ...Object.keys(counts.waiting)]) {
          const q = new URLSearchParams({ ...(status ? { status } : {}), ...(waiting ? { waiting } : {}) }).toString()
          if (q) answers[getKey(view, `${m[1]}?${q}`)] = await send(sessions[view], 'GET', `${m[1]}?${q}`)
        }
    }
    // the home page accepts any invitation the browser holds; with none it changes nothing, and the pack answers it as here
    answers[postKey(view, '/api/invite/accept', {})] = await send(sessions[view], 'POST', '/api/invite/accept', {})
    for (const h of hrefs) {
      const r = await fetch(`${BASE}${h}`, { headers: { cookie: `bulma_session=${sessions[view].cookie}` } })
      const type = (r.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!
      // a refusal (a list the operator does not let leads export) is an answer the pack shows, not a file
      if (!r.ok && type === 'application/json') {
        files[getKey(view, h)] = { status: r.status, body: await r.json() }
        continue
      }
      const bytes = Buffer.from(await r.arrayBuffer())
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1]
      const path = filePath(bytes, type, name)
      blobs.set(path, bytes)
      files[getKey(view, h)] = { status: r.status, file: { path, type, ...(name ? { name } : {}) } }
    }
  }
  return { answers, files, blobs, changes }
}

/**
 * The payment details PDF prints the verification link with its token (plan §5.3): rebuilt from the recorded answer, whose
 * token is already the stand-in, by the function the server uses, with the link as the pack's address. Every other file is kept as the server sent it.
 */
async function rebuildInstructions(snap: Snapshot, blobs: ReadonlyMap<string, Buffer>): Promise<Map<string, Buffer>> {
  const out = new Map(blobs)
  for (const [key, a] of Object.entries(snap.get)) {
    const m = /^(\w+) GET (\/api\/my\/participations\/[^/]+\/instructions)\.pdf$/.exec(key)
    if (!m || !a.file) continue
    const page = snap.get[`${m[1]} GET ${m[2]}`]
    if (page?.status !== 200) throw new Error(`no payment details answer for ${key}`)
    // printed as the pack's own address of the check page, not the server's, which the site does not have (TC-DEMO-11)
    const body = page.body as InstructionsForPdf
    const bytes = await instructionsPdf({ ...body, verify_url: printedAddress(m[1] as View, body.verify_url) })
    a.file = { ...a.file, path: filePath(bytes, a.file.type, a.file.name) }
    out.set(a.file.path, bytes)
  }
  return out
}

await main()
// a stray pool or browser timer must not keep the export open once it has written or failed
process.exit(process.exitCode ?? 0)
