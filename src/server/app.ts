// HTTP server (tech design T1, T7, T11, §6): API, sign-in, CSRF, security headers, static UI.
// Every route names a gate from lib/gate.ts; a route without one stops the server starting (default deny, TC-AUTHZ-07).
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'
import { selectAdapters, type RealAdapters, type Storage } from '../adapters/index.ts'
import { feeConfigErrors } from '../lib/fees.ts'
import { GATES, isGateName, type GateName } from '../lib/gate.ts'
import { sandboxPaymentInstruction } from '../lib/instance.ts'
import { parsePack, placeholderTexts, type RegimePack } from '../lib/regimePack.ts'
import { appendAudit, chainHead, recentAudit, SOFTWARE_VERSION, verifyAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db } from '../store/db.ts'
import { insertPack, isReservedPackKey } from '../store/packs.ts'
import {
  changeOwnPassword, createSession, createUser, csrfOk, endSession, passwordProblem, SESSION, SESSION_HOURS, sessionUser, verifyLogin, type SessionUser,
} from './auth.ts'
import {
  adminTx, changeRole, currentBlockers, decideRequest, describeRequest, disableUser, Refused, requestMfaReset, requestModeSwitch, requestPackActivate, requestProfileChange, type Ctx, type InstanceRow,
} from './requests.ts'
import { registerD1 } from './d1.ts'
import { startWorker } from './outbox.ts'
import { startReminders } from './reminders.ts'
import { registerMailTemplates } from './mailTemplates.ts'
import { registerD2 } from './d2.ts'
import { registerD3Invest } from './d3Invest.ts'
import { registerD3Lead } from './d3Lead.ts'
import { registerD3Ops } from './d3Ops.ts'
import { registerD4Money } from './d4Money.ts'
import { registerD4Import } from './d4Import.ts'
import { registerD4Unallocated } from './d4Unallocated.ts'
import { registerD4Life } from './d4Life.ts'
import { registerD4Panel } from './d4Panel.ts'
import { registerD4Work } from './d4Work.ts'
import { registerD4Evidence } from './d4Evidence.ts'
import { registerD4Complaints } from './d4Complaints.ts'
import { registerD4Messages } from './d4Messages.ts'
import type { DropFiles } from './demo.ts'
import { demoState, registerDemo } from './demoSeed.ts'

declare module 'fastify' {
  interface FastifyContextConfig {
    gate?: GateName
  }
  interface FastifyRequest {
    user: SessionUser | null
  }
}

export interface ServerDeps {
  /** How long an upload may take to arrive; a test shortens it. */
  uploadDeadlineMs?: number
  downloadDeadlineMs?: number
  db: Db
  k: Keyring
  webRoot?: string
  paymentFile?: string
  logger?: boolean
  secureCookies?: boolean // false only for local development over plain http
  trustProxy?: boolean | string
  real?: RealAdapters
  now?: () => Date // fixed clock for tests
  publicUrl?: string
  extraRoutes?: (app: FastifyInstance) => void // lets the route check prove a bad route is caught
  /** R23: how often the mail worker looks for due mail and retries; unset, only the sends after each change run (tests). */
  mailEveryMs?: number
}

// The only routes anyone can reach with no session. Declaring `public` on another route stops the start.
export const PUBLIC_ROUTES = new Set([
  '/api/health', '/api/instance/notice', '/api/login', '/*',
  '/api/register', '/api/verify-email', '/api/password/forgot', '/api/password/reset', '/api/account/email/confirm', '/api/party-links/confirm', '/api/kyc/webhook/:provider', '/api/investee/view', '/api/investee/files', '/api/investee/files/remove', '/api/investee/submit',
  '/api/invite/open', '/api/invite/pending', '/api/instructions/verify', '/api/complaints/channel',
])

/** Nothing the application accepts is nested this deeply, and walking something that is can overflow the stack. */
const MAX_BODY_DEPTH = 64
/** Postgres text cannot hold NUL or half of a surrogate pair: refuse them here rather than fail later. */
function unsafeBody(body: unknown): boolean {
  if (body === undefined || Buffer.isBuffer(body)) return false
  const stack: Array<[unknown, number]> = [[body, 1]]
  while (stack.length) {
    const [v, depth] = stack.pop()!
    if (typeof v !== 'object' || v === null) continue
    if (depth > MAX_BODY_DEPTH) return true
    for (const x of Object.values(v)) stack.push([x, depth + 1])
  }
  // JSON.stringify writes a proper pair as itself, so an escaped surrogate here is a lone one
  return /\\u0000|\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(body))
}

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
/** The policy with frames allowed from these sites only, over https. Hostnames are checked to be plain names when saved. */
export const frameAllowing = (hosts: readonly string[]) => {
  const plain = hosts.filter((h) => /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h))
  return plain.length ? `${CSP}; frame-src ${plain.map((h) => `https://${h}`).join(' ')}` : CSP
}

// R-OP-01, R-OP-03: wording shown to people; here so the API and the tests share one source
export const SANDBOX_BANNER = 'Sandbox: fictional data only. No email leaves this instance and nothing here is a real offer.'
export const SWITCH_WARNING = 'This software does not make anyone compliant. The operator must get its own legal advice before using the real mode. The switch and any change of regulatory status are written to the audit log. Everything done in the sandbox stops counting at the switch, and people without a role confirm their address again.'
export const PACK_FORMAT_PASSED = 'Format check passed. This does not say whether the pack is compliant.'
export const ACCOUNTABLE_LABEL = 'Operator accountable person'
export const ACCOUNTABLE_NOTE = 'Written by the operator. It does not mean a lawyer has looked at anything.'

const LoginBody = z.strictObject({ email: z.string().max(320), password: z.string().max(4096), code: z.string().max(40).optional() })
const PasswordBody = z.strictObject({ current: z.string().max(4096), next: z.string().max(4096) })
const UserBody = z.strictObject({ email: z.email().max(320), name: z.string().trim().min(1).max(200), password: z.string().max(4096) })
const FeeBody = z.strictObject({
  rate_bps: z.number(),
  min_minor: z.string().regex(/^\d{1,19}$/),
  max_minor: z.string().regex(/^\d{1,19}$/),
  surcharge_threshold_minor: z.string().regex(/^\d{1,19}$/),
  surcharge_bps: z.number(),
})
const Uuid = z.uuid()
const Role = z.enum(['admin', 'reviewer', 'approver'])
const Currency = z.enum(['GBP', 'USD', 'EUR'])

/**
 * TRUST_PROXY is the proxy's address or CIDR. Anything else would make every visitor share one address for the sign-in
 * limit, or let visitors choose their own.
 */
export function parseTrustProxy(raw: string | undefined): string | false {
  const v = raw?.trim()
  if (!v) return false
  if (!v.split(',').every((part) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(part.trim()) && /[.:]/.test(part))) throw new Error('TRUST_PROXY must be the address or CIDR of your proxy')
  return v
}

export interface RouteRow { method: string; url: string; gate: GateName | undefined }

export async function buildServer(d: ServerDeps): Promise<FastifyInstance & { routeTable: RouteRow[]; dropSandboxFiles: DropFiles; sandboxStorage: Storage }> {
  // the logger never sees bodies, cookies or query strings
  const logger = d.logger ? { serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, path: r.url.split('?')[0] }), res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }) } } : false
  // a finite time to receive a whole request, so a slow or stalled client cannot hold a connection for ever
  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024, trustProxy: d.trustProxy ?? false, requestTimeout: 180_000 })
  await app.register(cookie)
  app.decorateRequest('user', null)
  const routeTable: RouteRow[] = []

  app.addHook('onRoute', (r) => {
    const gate = (r.config as { gate?: unknown } | undefined)?.gate
    const methods = [r.method].flat().join(',')
    if (!isGateName(gate)) throw new Error(`route ${methods} ${r.url} declares no gate`)
    if (gate === 'public' && !PUBLIC_ROUTES.has(r.url)) throw new Error(`route ${methods} ${r.url} is public but not listed in PUBLIC_ROUTES`)
    routeTable.push({ method: methods, url: r.url, gate })
  })

  app.addHook('onSend', async (_req, reply, payload) => {
    // R-PAGE-01: a page may frame a deck only from the sites the operator allows (hostnames, checked when saved)
    const html = String(reply.getHeader('content-type') ?? '').startsWith('text/html')
    const hosts = html ? ((await d.db.query<{ embed_hosts: string[] }>('SELECT embed_hosts FROM deal_config WHERE id = 1')).rows[0]?.embed_hosts ?? []) : []
    reply.header('content-security-policy', frameAllowing(hosts))
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-frame-options', 'DENY')
    reply.header('cache-control', 'no-store')
    return payload
  })

  app.addHook('preHandler', async (req, reply) => {
    // Postgres text cannot hold NUL: refuse it here rather than fail later
    if (unsafeBody(req.body)) return reply.code(400).send({ error: 'the request is not valid' })
    if (req.is404) return // no route matched, so nothing to protect: the plain not-found answer follows
    const name = req.routeOptions.config.gate
    // unreachable while the onRoute check stands; denying here keeps the default if it ever goes
    if (!isGateName(name)) return reply.code(403).send({ error: 'not allowed' })
    if (name === 'public') return
    req.user = await sessionUser(d.db, d.k, req.cookies[SESSION])
    if (!req.user) return reply.code(401).send({ error: 'not signed in' })
    if (req.method !== 'GET' && req.method !== 'HEAD' && !csrfOk(req.user.csrf, req.headers['x-csrf-token'])) return reply.code(403).send({ error: 'missing or wrong CSRF token' })
    if (!GATES[name](req.user)) return reply.code(403).send({ error: req.user.mustChangePassword ? 'change your password first' : 'not allowed' })
  })

  const x: Ctx = { db: d.db, k: d.k, paymentFile: d.paymentFile }
  const instance = async () => (await d.db.query<InstanceRow>('SELECT mode, regulatory_status, accountable_person, accountable_confirmed_on, active_pack_id FROM instance_profile WHERE id = 1')).rows[0]!
  const secure = d.secureCookies ?? true
  const pub = { config: { gate: 'public' as const } }
  const signedIn = { config: { gate: 'signedIn' as const } }
  const active = { config: { gate: 'active' as const } }
  const admin = { config: { gate: 'canAdministerInstance' as const } }
  const auditor = { config: { gate: 'canReadAudit' as const } }
  const me = (u: SessionUser) => ({ id: u.id, email: u.email, name: u.name, roles: u.roles, mustChangePassword: u.mustChangePassword, emailVerified: u.emailVerified, mfaOn: u.mfaOn })

  app.get('/api/health', pub, async () => ({ ok: true }))
  app.get('/api/instance/notice', pub, async () => {
    const i = await instance()
    return { mode: i.mode, banner: i.mode === 'sandbox' ? SANDBOX_BANNER : null, version: SOFTWARE_VERSION }
  })

  app.post('/api/login', pub, async (req, reply) => {
    const { email, password, code } = LoginBody.parse(req.body)
    const u = await verifyLogin(d.db, d.k, email, password, req.ip, code, d.now?.().getTime())
    if (u.kind === 'mfa_required') return reply.code(401).send({ error: 'enter your two-step code', mfa_required: true })
    if (u.kind !== 'ok') {
      // a throttled attempt writes nothing: the audit table cannot be grown by someone with no session
      if (u.kind === 'failed') await tx(d.db, (c) => appendAudit(c, d.k, { actor: 'system', action: 'user.login_failed' }))
      return reply.code(401).send({ error: 'wrong email or password' })
    }
    const token = await tx(d.db, async (c) => {
      const t = await createSession(c, d.k, u.id, u.credentialVersion, u.authMethod)
      await appendAudit(c, d.k, { actor: u.id, action: 'user.login', entity: u.id })
      return t
    })
    reply.setCookie(SESSION, token, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: SESSION_HOURS * 3600 })
    const s = (await sessionUser(d.db, d.k, token))!
    return { csrf: s.csrf, user: me(s) }
  })
  app.post('/api/logout', signedIn, async (req, reply) => {
    await tx(d.db, async (c) => {
      await endSession(c, req.user!.sessionHmac)
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'user.logout', entity: req.user!.id })
    })
    reply.clearCookie(SESSION, { path: '/' })
    return { ok: true }
  })
  app.get('/api/session', signedIn, async (req) => ({ user: me(req.user!), csrf: req.user!.csrf }))
  app.post('/api/password', signedIn, async (req, reply) => {
    const { current, next } = PasswordBody.parse(req.body)
    const ok = await changeOwnPassword(d.db, d.k, req.user!.id, current, next, req.user!.sessionHmac, req.ip)
    return ok ? { ok: true } : reply.code(400).send({ error: 'wrong current password, or the new one is too short (12+) or unchanged' })
  })

  // R-OP-01: only ever the fixed fictional values; nothing accepts payment details in a sandbox
  app.get<{ Params: { currency: string } }>('/api/sandbox/payment-instruction/:currency', active, async (req, reply) => {
    if ((await instance()).mode !== 'sandbox') return reply.code(404).send({ error: 'not a sandbox' })
    return sandboxPaymentInstruction(Currency.parse(req.params.currency))
  })

  app.get('/api/instance', admin, async () => {
    const i = await instance()
    const pack = (await d.db.query<{ key: string; version: number }>('SELECT key, version FROM regime_pack WHERE id = $1', [i.active_pack_id])).rows[0]!
    return {
      ...i,
      active_pack: `${pack.key} version ${pack.version}`,
      blockers: i.mode === 'sandbox' ? await currentBlockers(d.db, i, d.paymentFile) : [],
      demo: await demoState(d.db),
      switch_warning: SWITCH_WARNING,
      accountable_label: ACCOUNTABLE_LABEL,
      accountable_note: ACCOUNTABLE_NOTE,
    }
  })

  app.get('/api/requests', admin, async () => {
    const r = await d.db.query<{ id: string; kind: string; status: string; payload: Record<string, unknown> }>(
      `SELECT r.id, r.kind, r.status, r.payload, r.created_at, r.decided_at, r.single_admin_exception, r.requested_by, q.name AS requested_by_name, x.name AS decided_by_name
         FROM admin_request r JOIN user_account q ON q.id = r.requested_by LEFT JOIN user_account x ON x.id = r.decided_by ORDER BY r.created_at DESC LIMIT 100`,
    )
    // the approver must see exactly what they approve (R-OP-02, R-OP-08)
    return { requests: await Promise.all(r.rows.map(async ({ payload, ...row }) => ({ ...row, details: await describeRequest(x, row.kind, payload, row.status) }))) }
  })
  app.post('/api/requests/mode-switch', admin, async (req) => ({ id: await requestModeSwitch(x, req.user!, req.body) }))
  app.post('/api/requests/profile', admin, async (req) => ({ id: await requestProfileChange(x, req.user!, req.body) }))
  app.post('/api/requests/pack-activate', admin, async (req) => {
    const { pack_id } = z.strictObject({ pack_id: Uuid }).parse(req.body)
    return { id: await requestPackActivate(x, req.user!, pack_id) }
  })
  app.post<{ Params: { id: string } }>('/api/requests/:id/approve', admin, async (req) => {
    await decideRequest(x, req.user!, Uuid.parse(req.params.id), 'approve')
    return { ok: true }
  })
  app.post<{ Params: { id: string } }>('/api/requests/:id/reject', admin, async (req) => {
    await decideRequest(x, req.user!, Uuid.parse(req.params.id), 'reject')
    return { ok: true }
  })

  app.get('/api/packs', admin, async () => {
    const i = await instance()
    const r = await d.db.query<{ id: string; key: string; version: number; regime: string; built_in: boolean; demo_only: boolean; content: RegimePack }>(
      'SELECT id, key, version, regime, built_in, demo_only, content FROM regime_pack ORDER BY key, version',
    )
    return {
      format_passed: PACK_FORMAT_PASSED,
      packs: r.rows.map((p) => ({
        id: p.id, key: p.key, version: p.version, regime: p.regime, built_in: p.built_in, demo_only: p.demo_only, active: p.id === i.active_pack_id,
        placeholders: placeholderTexts(p.content), author_note: p.content.author_note,
        steps: p.content.steps.map((s) => s.kind), thresholds: p.content.thresholds,
      })),
    }
  })
  app.get<{ Params: { id: string } }>('/api/packs/:id', admin, async (req, reply) => {
    const r = await d.db.query<{ content: RegimePack; content_sha256: string }>('SELECT content, content_sha256 FROM regime_pack WHERE id = $1', [Uuid.parse(req.params.id)])
    return r.rows[0] ?? reply.code(404).send({ error: 'no such pack' })
  })
  // format-checked and stored; it does nothing until a second admin approves activating it (R-OP-04)
  app.post('/api/packs', admin, async (req, reply) => {
    const parsed = parsePack(req.body)
    if (!parsed.pack) return reply.code(400).send({ error: 'the pack does not load', errors: parsed.errors })
    const pack = parsed.pack
    if (isReservedPackKey(pack.key)) return reply.code(409).send({ error: 'this name is kept for packs shipped with the software; give your pack its own name' })
    try {
      const id = await adminTx(x, req.user!, async (c) => {
        // inside the lock: two uploads at once must not both pass
        const other = await c.query('SELECT 1 FROM regime_pack WHERE key = $1 AND regime <> $2', [pack.key, pack.regime])
        if (other.rowCount) throw new Refused('An earlier version of this pack has a different regime; a pack cannot change regime.')
        const packId = await insertPack(c, pack, { builtIn: false, by: req.user!.id })
        await appendAudit(c, d.k, { actor: req.user!.id, action: 'pack.added', entity: packId })
        return packId
      })
      return { id, format_passed: PACK_FORMAT_PASSED }
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'this pack version already exists; a stored version cannot change' })
      throw e
    }
  })

  const feeRow = (f: Record<string, unknown>) => f
  app.get('/api/fee-config', admin, async () => {
    const r = await d.db.query('SELECT version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, created_at FROM fee_config ORDER BY version DESC LIMIT 1')
    return { fee_config: r.rows[0] ? feeRow(r.rows[0]) : null }
  })
  app.post('/api/fee-config', admin, async (req, reply) => {
    const b = FeeBody.parse(req.body)
    const c = { rate_bps: b.rate_bps, surcharge_bps: b.surcharge_bps, min_minor: BigInt(b.min_minor), max_minor: BigInt(b.max_minor), surcharge_threshold_minor: BigInt(b.surcharge_threshold_minor) }
    const errors = feeConfigErrors(c)
    if (errors.length) return reply.code(400).send({ error: errors[0], errors })
    const version = await adminTx(x, req.user!, async (t) => {
      const v = Number((await t.query<{ v: number }>('SELECT coalesce(max(version), 0) + 1 AS v FROM fee_config')).rows[0]!.v)
      await t.query('INSERT INTO fee_config (id, version, rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        randomUUID(), v, c.rate_bps, b.min_minor, b.max_minor, b.surcharge_threshold_minor, c.surcharge_bps, req.user!.id,
      ])
      await appendAudit(t, d.k, { actor: req.user!.id, action: 'fee_config.changed', entity: String(v) })
      return v
    })
    return { version }
  })

  // R-DEMO-06: a retired demo account is kept as a row for the audit chain, and is no one's business on this page
  app.get('/api/users', admin, async () => {
    const r = await d.db.query(`SELECT u.id, u.email, u.name, u.disabled_at, u.mfa_enabled_at IS NOT NULL AS mfa_on, coalesce((SELECT array_agg(g.role) FROM role_grant g WHERE g.user_id = u.id), '{}') AS roles FROM user_account u WHERE NOT demo_retired_user(u.id) ORDER BY u.created_at`)
    return { users: r.rows }
  })
  app.post('/api/users', admin, async (req, reply) => {
    const b = UserBody.parse(req.body)
    const problem = passwordProblem(b.password)
    if (problem) return reply.code(400).send({ error: problem })
    try {
      return { id: await adminTx(x, req.user!, (c) => createUser(c, d.k, { ...b, by: req.user!.id })) }
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'this email already has an account' })
      throw e
    }
  })
  app.put<{ Params: { id: string; role: string } }>('/api/users/:id/roles/:role', admin, async (req) => changeRole(x, req.user!, Uuid.parse(req.params.id), Role.parse(req.params.role), true))
  app.delete<{ Params: { id: string; role: string } }>('/api/users/:id/roles/:role', admin, async (req) => changeRole(x, req.user!, Uuid.parse(req.params.id), Role.parse(req.params.role), false))
  app.post<{ Params: { id: string } }>('/api/users/:id/disable', admin, async (req) => disableUser(x, req.user!, Uuid.parse(req.params.id)))

  app.post<{ Params: { id: string } }>('/api/users/:id/mfa-reset', admin, async (req) => ({ requestId: await requestMfaReset(x, req.user!, Uuid.parse(req.params.id)) }))

  app.get('/api/audit/verify', auditor, async () => verifyAudit(d.db, d.k))
  app.get('/api/audit/head', auditor, async () => ({ head: await chainHead(d.db) }))
  app.get<{ Querystring: { limit?: string } }>('/api/audit/recent', auditor, async (req) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit)
    return { records: await recentAudit(d.db, limit) }
  })

  // one set of sandbox fakes for the life of the server, so a file stored in the sandbox can be read back
  const sandboxAdapters = selectAdapters('sandbox', d.db)
  // R-DEMO-06: a retired demo run's files go from this store at once; the expiry job empties the queue on disk
  const dropFiles = async (keys: readonly string[]) => {
    for (const key of keys) await sandboxAdapters.storage.delete(key)
  }
  x.dropFiles = dropFiles
  const d1 = registerD1(app, { db: d.db, k: d.k, real: d.real, sandboxAdapters, now: d.now, publicUrl: d.publicUrl, uploadDeadlineMs: d.uploadDeadlineMs, downloadDeadlineMs: d.downloadDeadlineMs })
  x.mail = d1.mail
  if (d.mailEveryMs) {
    const stop = startWorker(d1.mailDeps, d.mailEveryMs, (code) => app.log.error(`mail worker failed: ${code}`))
    app.addHook('onClose', async () => stop())
  }
  registerD2(app, { db: d.db, k: d.k, now: d.now, publicUrl: d.publicUrl, mail: d1.mail, adapters: d1.adapters, uploadDeadlineMs: d.uploadDeadlineMs, downloadDeadlineMs: d.downloadDeadlineMs })
  const d3 = registerD3Invest(app, { db: d.db, k: d.k, now: d.now, publicUrl: d.publicUrl, secureCookies: d.secureCookies, mail: d1.mail, eligibilityFacts: d1.eligibilityFacts, adapters: d1.adapters })
  registerD3Lead(app, { db: d.db, k: d.k, now: d.now, publicUrl: d.publicUrl, mail: d1.mail, previewSheet: d3.previewSheet })
  registerD3Ops(app, { db: d.db, k: d.k, now: d.now, paymentFile: d.paymentFile, mail: d1.mail, sheetFor: d3.sheetFor, qualified: d3.qualified })
  registerD4Money(app, { db: d.db, k: d.k, mail: d1.mail })
  registerD4Unallocated(app, { db: d.db, k: d.k, mail: d1.mail })
  registerD4Import(app, { db: d.db, k: d.k, mail: d1.mail })
  registerD4Life(app, { db: d.db, k: d.k, mail: d1.mail, now: d.now })
  const panel = registerD4Panel(app, { db: d.db, k: d.k, now: d.now, qualified: d3.qualified, previewPage: d3.previewPage, sharedContent: d3.sharedContent })
  registerD4Messages(app, { db: d.db, k: d.k, mail: d1.mail, audienceRows: panel.audienceRows, messageFor: d3.messageFor })
  registerMailTemplates(app, { db: d.db, k: d.k })
  registerD4Work(app, { db: d.db, k: d.k, now: d.now })
  registerD4Evidence(app, { db: d.db, k: d.k, now: d.now })
  registerDemo(app, { db: d.db, k: d.k })
  registerD4Complaints(app, { db: d.db, k: d.k, mail: d1.mail, now: d.now })
  // R-COM-04: from here an edited investor mail can be decided per person
  d1.mailDeps.promotion = d3.promotion
  d1.mailDeps.message = d3.messageFor
  if (d.mailEveryMs) {
    // R-NTF-01: reminders are queued hourly, alongside the queue's own worker
    const stop = startReminders({ db: d.db, k: d.k, now: d.now ?? (() => new Date()), mail: d1.mail }, 3_600_000, (code) => app.log.error(`reminders failed: ${code}`))
    app.addHook('onClose', async () => stop())
  }
  d.extraRoutes?.(app)

  if (d.webRoot) {
    const root = resolve(d.webRoot)
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
    app.get('/*', pub, async (req, reply) => {
      let path: string
      try {
        path = decodeURIComponent(req.url.split('?')[0]!)
      } catch {
        return reply.code(400).send({ error: 'bad path' })
      }
      if (path.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
      const file = normalize(join(root, path === '/' ? 'index.html' : path))
      const rel = relative(root, file)
      const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      const target = inside && extname(file) ? file : join(root, 'index.html')
      const body = await readFile(target).catch(() => null)
      if (body) return reply.type(types[extname(target)] ?? 'application/octet-stream').send(body)
      return reply.type(types['.html']!).send(await readFile(join(root, 'index.html')))
    })
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof Refused) return reply.code(409).send({ error: err.message, blockers: err.blockers })
    if (err instanceof ZodError) return reply.code(400).send({ error: 'the request is not valid', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status < 500) return reply.code(status).send({ error: 'the request is not valid' })
    const ref = randomUUID()
    app.log.error({ ref, code: (err as { code?: string }).code }, 'request failed')
    return reply.code(500).send({ error: 'request failed', ref })
  })
  // dropSandboxFiles: the demo seed's own retirement after a failure uses it too
  return Object.assign(app as unknown as FastifyInstance, { routeTable, dropSandboxFiles: dropFiles, sandboxStorage: sandboxAdapters.storage })
}
