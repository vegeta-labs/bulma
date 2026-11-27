// D1 routes and services: accounts, entities, eligibility, KYC (PRD §4.1 to 4.4). Rules stay in lib/; this is transactions.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import argon2 from 'argon2'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { selectAdapters, StorageFull, type Adapters, type RealAdapters } from '../adapters/index.ts'
import {
  attemptsUsedUp, coolingOffCounts, coolingOffOver, isQualified, judgeStatement, lockAfterFailure, lockedUntil, markAssessment, nextEligibilityStep, pickQuestions, preparation, statementAnswers, statementClosed, statementExpiry, stepDone, stepOpen, warningVariant,
  type AttemptFact, type EligibilityFacts,
} from '../lib/eligibility.ts'
import { addYears, afterProviderDecision, allowedRequirement, BANK_DETAILS_NEEDED, BANK_PROOF, bankDetailsGiven, entityGaps, entityStatus, kycPassed, sameHolder, type EntityType, type KycFact, type Party } from '../lib/entity.ts'
import type { Mode } from '../lib/instance.ts'
import { GATES } from '../lib/gate.ts'
import { bpsToPercent, minorToPounds } from '../lib/pounds.ts'
import { fillText, statementQuestionKeys, thresholds, type RegimePack, type StepKind } from '../lib/regimePack.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { packContent } from '../store/packs.ts'
import { checkSecondFactor, clearPendingMfa, confirmMfa, createUser, passwordProblem, reserveAttempt, SESSION, sessionStillLive, sessionUser, startMfa, voidTokens } from './auth.ts'
import { changeRetentionPeriods, Refused, reviewerTx, setRetentionHold, type Ctx } from './requests.ts'
import { openHold } from './ledger.ts'
import { endProposal, refreshRelationship, tellLeadsOfRoom } from './allocation.ts'
import { mailQueue, type MailQueue, type OutboxDeps } from './outbox.ts'
import { UploadSlots } from './uploadSlots.ts'

export interface D1Deps {
  db: Db
  k: Keyring
  real?: RealAdapters
  sandboxAdapters: Adapters
  now?: () => Date
  /** Where people reach this instance; links in mail start with it. */
  publicUrl?: string
  uploadDeadlineMs?: number
  downloadDeadlineMs?: number
}

const Uuid = z.uuid()
const ALLOWED_FILES: Array<{ type: string; magic: Buffer }> = [
  { type: 'application/pdf', magic: Buffer.from('%PDF-') },
  { type: 'image/png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { type: 'image/jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
]
const FILE_LIMIT = 15 * 1024 * 1024
export const ENTITY_FILE_LIMIT = 40
export const ENTITY_BYTES_LIMIT = 200 * 1024 * 1024
export const USER_ENTITY_LIMIT = 20
const UPLOAD_DEADLINE_MS = 120_000
export const USER_BYTES_LIMIT = 1024 * 1024 * 1024
const DOWNLOAD_DEADLINE_MS = 120_000
const TOKEN_HOURS = { verify_email: 72, reset_password: 2, change_email: 24 } as const
const Password = z.string().max(4096)
/** The one test of a link: not used and not expired. $3 is the clock. */
const TOKEN_OPEN = 'consumed_at IS NULL AND expires_at > $3::timestamptz'

/** Decision R13: what happened before the switch to the real mode does not count. No value in a sandbox, so everything counts. */
const LIVE = "coalesce((SELECT real_since FROM instance_profile WHERE id = 1), '-infinity'::timestamptz)"

const SECOND_FACTOR_GIVEN = new Set(['ok', 'recovery'])

const hashToken = (k: Keyring, t: string) => k.hmac(`account-token\0${t}`)
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export function registerD1(app: FastifyInstance, d: D1Deps) {
  const x: Ctx = { db: d.db, k: d.k }
  const now = () => d.now?.() ?? new Date()
  const modeOf = async (q: Pick<Tx, 'query'>) => (await q.query<{ mode: Mode }>('SELECT mode FROM instance_profile WHERE id = 1')).rows[0]!.mode
  const adapters = async (): Promise<Adapters> => {
    const mode = await modeOf(d.db)
    return mode === 'sandbox' ? d.sandboxAdapters : selectAdapters('real', d.db, d.real)
  }
  const pub = { config: { gate: 'public' as const } }
  const signedIn = { config: { gate: 'signedIn' as const } }
  const active = { config: { gate: 'active' as const } }
  const verified = { config: { gate: 'verified' as const } }
  const reviewer = { config: { gate: 'canReviewKyc' as const } }
  const admin = { config: { gate: 'canAdministerInstance' as const } }

  /** Writers whose result depends on the mode take this first: the switch holds the row for update, so they finish before it or wait and then see the real mode (decision R13). */
  const modeShare = (c: Tx) => c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')

  /**
   * For a signed-in person's write. The route's checks ran before the wait, and the switch ends sessions and clears addresses, so
   * they are made again once the row is held.
   */
  const heldAccount = async (c: Tx, who: { id: string; sessionHmac: string }) => {
    // the instance before the account, as the switch takes them: the other way round the two can deadlock
    await modeShare(c)
    // a password change or reset holds this row: wait for it here, so what is checked next is what is true after the wait
    const u = (await c.query<{ mfa_enabled_at: Date | null; email_verified_at: Date | null }>('SELECT mfa_enabled_at, email_verified_at FROM user_account WHERE id = $1 FOR UPDATE', [who.id])).rows[0]
    // closing and retention end the sessions, so this also stops a write to an account that is gone
    if (!u || !(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
    return u
  }
  const liveShare = async (c: Tx, who: { id: string; sessionHmac: string }) => {
    const u = await heldAccount(c, who)
    if (!u.email_verified_at) throw new Refused('Confirm your email address first.')
    return u
  }
  const TWO_STEP_CAME_ON = 'Two-step sign-in has been turned on. Ask again with your code.'

  async function issueToken(c: Tx, userId: string, kind: keyof typeof TOKEN_HOURS, extra: { newEmail?: string; pending?: { hash: string; first: string; last: string } } = {}): Promise<string> {
    // every caller has already taken modeShare, before the account: a link asked for during the switch waits and is not a sandbox link (decision R13)
    const t = randomBytes(32).toString('base64url')
    await c.query(
      'INSERT INTO account_token (token_hmac, user_id, kind, new_email, pending_password_hash, pending_first_name, pending_last_name, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)',
      [hashToken(d.k, t), userId, kind, extra.newEmail ?? null, extra.pending?.hash ?? null, extra.pending?.first ?? null, extra.pending?.last ?? null, new Date(now().getTime() + TOKEN_HOURS[kind] * 3_600_000).toISOString()],
    )
    return t
  }

  async function consumeToken(c: Tx, token: string, kind: keyof typeof TOKEN_HOURS): Promise<{ user_id: string; new_email: string | null } | null> {
    const r = await c.query<{ user_id: string; new_email: string | null }>(
      `UPDATE account_token SET consumed_at = $3::timestamptz WHERE token_hmac = $1 AND kind = $2 AND ${TOKEN_OPEN} RETURNING user_id, new_email`,
      [hashToken(d.k, token), kind, now().toISOString()],
    )
    return r.rows[0] ?? null
  }

  /** Looks without using the link up, so expensive work and wrong passwords do not spend it. */
  const peekToken = async (token: string, kind: keyof typeof TOKEN_HOURS) =>
    (await d.db.query<{ user_id: string; pending_password_hash: string | null; pending_first_name: string | null; pending_last_name: string | null }>(
      `SELECT user_id, pending_password_hash, pending_first_name, pending_last_name FROM account_token WHERE token_hmac = $1 AND kind = $2 AND ${TOKEN_OPEN}`,
      [hashToken(d.k, token), kind, now().toISOString()],
    )).rows[0] ?? null

  /**
   * R23: mail is queued in the transaction of the change it reports and sent after the commit (outbox.ts). A failure never undoes
   * what was done; the log has the error code only, never an address.
   */
  const mailDeps: OutboxDeps = { db: d.db, k: d.k, now, publicUrl: d.publicUrl, mailer: async (mode) => (mode === 'sandbox' ? d.sandboxAdapters : selectAdapters('real', d.db, d.real)).mailer }
  const mail: MailQueue = mailQueue(mailDeps, (code) => app.log.error(`mail failed: ${code}`))
  const toAddress = (c: Tx, to: string, subject: string, body: string) => mail.queue(c, { audience: { kind: 'address' }, to, subject, body })

  const linkTo = (path: string) => `${d.publicUrl ?? ''}${path}`

  /** Without a way to send the link an account could never be confirmed, so refuse before storing anything. */
  const mailReady = async () => (await modeOf(d.db)) === 'sandbox' || !!d.real?.mailer

  // ---------- accounts (R-ACC-*) ----------
  const Register = z.strictObject({ first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), email: z.email().max(320), password: Password })
  app.post('/api/register', pub, async (req, reply) => {
    const b = Register.parse(req.body)
    const problem = passwordProblem(b.password)
    if (problem) return reply.code(400).send({ error: problem })
    if (!(await mailReady())) return reply.code(503).send({ error: 'Email is not set up on this instance yet.' })
    if (!(await reserveAttempt(d.db, [d.k.hmac(`register-ip\0${req.ip}`)]))) return reply.code(429).send({ error: 'too many attempts, try later' })
    const mailOk = await reserveAttempt(d.db, [d.k.hmac(`register-email\0${b.email.trim().toLowerCase()}`)])
    // the same work and the same answer whatever the address, so this cannot be used to test addresses
    const hash = await argon2.hash(b.password, { type: argon2.argon2id })
    const decide = async (c: Tx) => {
      await modeShare(c)
      const u = (await c.query<{ id: string; email_verified_at: Date | null; disabled_at: Date | null }>('SELECT id, email_verified_at, disabled_at FROM user_account WHERE lower(email) = lower($1) FOR UPDATE', [b.email])).rows[0]
      if (!u) {
        const id = await createUser(c, d.k, { email: b.email, name: `${b.first_name} ${b.last_name}`, passwordHash: hash, by: null, selfRegistered: true, firstName: b.first_name, lastName: b.last_name })
        // R-LNK-10: an invitation opened in this browser is attached to the new account on the server, so it survives another device
        const opened = req.cookies?.bulma_invite
        if (opened) await c.query('UPDATE pending_invite SET user_id = $2 WHERE browser_hmac = $1 AND user_id IS NULL AND expires_at > now()', [d.k.hmac(`pending\0${opened}`), id])
        return issueToken(c, id, 'verify_email')
      }
      if (u.disabled_at) return 'closed' as const
      if (u.email_verified_at || !mailOk) return 'known' as const
      // R-LNK-10: an invitation opened in this browser goes with this address too. Only whoever proves the mailbox can use
      // it, so attaching it here gives nothing to someone who merely typed the address (D3, Codex round 5).
      const reopened = req.cookies?.bulma_invite
      if (reopened) await c.query('UPDATE pending_invite SET user_id = $2 WHERE browser_hmac = $1 AND user_id IS NULL AND expires_at > now()', [d.k.hmac(`pending\0${reopened}`), u.id])
      // An unconfirmed address, perhaps claimed by someone else: this credential waits on its own link and needs the mailbox (R-ACC-01).
      // Earlier links stay: each opens only with its own password, so nobody without the mailbox can spoil the owner's.
      return issueToken(c, u.id, 'verify_email', { pending: { hash, first: b.first_name, last: b.last_name } })
    }
    const registerMail = async (c: Tx, token: string) => {
      if (!mailOk) return
      if (token === 'closed') return toAddress(c, b.email, 'This address belongs to a closed account', 'Someone tried to register with this address, which belongs to a closed account. To use it again, contact your operator. If this was not you, you can ignore this.')
      if (token === 'known') return toAddress(c, b.email, 'You already have an account', 'Someone tried to register with this address. If it was you, sign in, or choose a new password from the sign-in page. If not, you can ignore this.')
      return toAddress(c, b.email, 'Confirm your email address', `Confirm your email address: ${linkTo(`/verify-email?token=${token}`)}`)
    }
    const token = await tx(d.db, async (c) => {
      const out = await decide(c)
      await registerMail(c, out)
      return out
    }).catch(async (e: { code?: string }) => {
      if (e.code !== '23505') throw e
      // two at once: the other won
      await tx(d.db, (c) => registerMail(c, 'known'))
      return 'known' as const
    })
    await mail.flush()
    // A sandbox sends no mail, so the page carries the link. A known address gets a dead one: the answer looks the same, and it opens nothing.
    if ((await modeOf(d.db)) !== 'sandbox') return { ok: true }
    return { ok: true, sandbox_link: `/verify-email?token=${token === 'closed' || token === 'known' ? randomBytes(32).toString('base64url') : token}` }
  })
  // R-ACC-01: needs the mailbox and the password chosen at registration. Whoever claimed someone else's address has only the second;
  // the owner of the address, clicking a mail they did not ask for, has only the first.
  app.post('/api/verify-email', pub, async (req, reply) => {
    const { token, password } = z.strictObject({ token: z.string().max(200), password: Password }).parse(req.body)
    const invalid = () => reply.code(400).send({ error: 'this link or password is not right' })
    if (!(await reserveAttempt(d.db, [d.k.hmac(`verify-ip\0${req.ip}`), d.k.hmac(`verify-token\0${token}`)]))) return reply.code(429).send({ error: 'too many attempts, try later' })
    const t = await peekToken(token, 'verify_email')
    if (!t) return invalid()
    const u = (await d.db.query<{ password_hash: string | null }>('SELECT password_hash FROM user_account WHERE id = $1', [t.user_id])).rows[0]
    const held = t.pending_password_hash ?? u?.password_hash
    if (!held || !(await argon2.verify(held, password))) return invalid()
    const done = await tx(d.db, async (c) => {
      if (!(await consumeToken(c, token, 'verify_email'))) return false
      await c.query('UPDATE user_account SET email_verified_at = $2::timestamptz WHERE id = $1', [t.user_id, now().toISOString()])
      if (t.pending_password_hash) {
        // the new credential takes over; every session of the earlier one ends
        await c.query("UPDATE user_account SET password_hash = $2, first_name = $3, last_name = $4, name = $3 || ' ' || $4, credential_version = credential_version + 1 WHERE id = $1", [t.user_id, t.pending_password_hash, t.pending_first_name, t.pending_last_name])
        await c.query('DELETE FROM app_session WHERE user_id = $1', [t.user_id])
      }
      // the address is settled: any other link and the credential it held go
      await voidTokens(c, t.user_id, t.pending_password_hash ? undefined : 'verify_email')
      await appendAudit(c, d.k, { actor: t.user_id, action: 'user.email_verified', entity: t.user_id })
      return true
    })
    return done ? { ok: true } : invalid()
  })
  // R-ACC-01: the page for someone signed in whose link was lost or has expired
  app.post('/api/account/resend-verification', signedIn, async (req, reply) => {
    if (req.user!.emailVerified) return { ok: true }
    if (!(await mailReady())) return reply.code(503).send({ error: 'Email is not set up on this instance yet.' })
    if (!(await reserveAttempt(d.db, [d.k.hmac(`resend\0${req.user!.id}`)]))) return reply.code(429).send({ error: 'too many attempts, try later' })
    const token = await tx(d.db, async (c) => {
      await heldAccount(c, req.user!)
      const t = await issueToken(c, req.user!.id, 'verify_email')
      await toAddress(c, req.user!.email, 'Confirm your email address', `Confirm your email address: ${linkTo(`/verify-email?token=${t}`)}`)
      return t
    })
    await mail.flush()
    return (await modeOf(d.db)) === 'sandbox' ? { ok: true, sandbox_link: `/verify-email?token=${token}` } : { ok: true }
  })
  // the link goes only to the mailbox; in a sandbox that is the outbox an admin reads, never this reply
  app.post('/api/password/forgot', pub, async (req, reply) => {
    const { email } = z.strictObject({ email: z.string().max(320) }).parse(req.body)
    if (!(await mailReady())) return reply.code(503).send({ error: 'Email is not set up on this instance yet.' })
    if (!(await reserveAttempt(d.db, [d.k.hmac(`forgot-ip\0${req.ip}`), d.k.hmac(`forgot-email\0${email.trim().toLowerCase()}`)]))) return { ok: true }
    await tx(d.db, async (c) => {
      await modeShare(c)
      // locked: if the address is being changed this waits, and then finds no account at the old one
      const u = (await c.query<{ id: string }>('SELECT id FROM user_account WHERE lower(email) = lower($1) AND disabled_at IS NULL AND anonymised_at IS NULL FOR UPDATE', [email.trim()])).rows[0]
      if (!u) return
      const token = await issueToken(c, u.id, 'reset_password')
      await toAddress(c, email.trim(), 'Choose a new password', `Choose a new password: ${linkTo(`/reset-password?token=${token}`)}`)
    })
    await mail.flush()
    return { ok: true }
  })
  app.post('/api/password/reset', pub, async (req, reply) => {
    const b = z.strictObject({ token: z.string().max(200), password: Password }).parse(req.body)
    const problem = passwordProblem(b.password)
    if (problem) return reply.code(400).send({ error: problem })
    if (!(await reserveAttempt(d.db, [d.k.hmac(`reset-ip\0${req.ip}`)]))) return reply.code(429).send({ error: 'too many attempts, try later' })
    // the link first: password work costs CPU, and this route is public
    if (!(await peekToken(b.token, 'reset_password'))) return reply.code(400).send({ error: 'this link is not valid any more' })
    const hash = await argon2.hash(b.password, { type: argon2.argon2id })
    const done = await tx(d.db, async (c) => {
      const t = await consumeToken(c, b.token, 'reset_password')
      if (!t) return false
      // the link came through the mailbox, so it also proves the address
      await c.query('UPDATE user_account SET password_hash = $2, must_change_password = false, credential_version = credential_version + 1, email_verified_at = coalesce(email_verified_at, $3::timestamptz) WHERE id = $1', [t.user_id, hash, now().toISOString()])
      await c.query('DELETE FROM app_session WHERE user_id = $1', [t.user_id])
      await voidTokens(c, t.user_id)
      await clearPendingMfa(c, t.user_id)
      await appendAudit(c, d.k, { actor: t.user_id, action: 'user.password_reset', entity: t.user_id })
      return true
    })
    return done ? { ok: true } : reply.code(400).send({ error: 'this link is not valid any more' })
  })
  const verifyPassword = async (userId: string, password: string, ip: string) => {
    if (!(await reserveAttempt(d.db, [d.k.hmac(`reauth-ip\0${ip}`), d.k.hmac(`reauth-user\0${userId}`)]))) return false
    const u = (await d.db.query<{ password_hash: string | null }>('SELECT password_hash FROM user_account WHERE id = $1', [userId])).rows[0]
    return !!u?.password_hash && argon2.verify(u.password_hash, password)
  }
  // R-ACC-03: a stolen session, or someone who claimed an address, must not be able to lock the owner out
  app.post('/api/mfa/start', verified, async (req, reply) => {
    const { password } = z.strictObject({ password: Password }).parse(req.body)
    if (!(await verifyPassword(req.user!.id, password, req.ip))) return reply.code(400).send({ error: 'wrong password' })
    try {
      const started = await startMfa(d.db, d.k, req.user!.id, req.user!.email, req.user!.sessionHmac)
      return started ?? reply.code(409).send({ error: 'Your session has ended.' })
    } catch {
      return reply.code(409).send({ error: 'two-step sign-in is already on' })
    }
  })
  app.post('/api/mfa/confirm', verified, async (req, reply) => {
    const { code } = z.strictObject({ code: z.string().max(20) }).parse(req.body)
    if (!(await reserveAttempt(d.db, [d.k.hmac(`mfa-confirm\0${req.user!.id}`)]))) return reply.code(429).send({ error: 'too many attempts, try later' })
    const codes = await confirmMfa(d.db, d.k, req.user!.id, code, now().getTime(), req.user!.sessionHmac)
    return codes ? { recovery_codes: codes } : reply.code(400).send({ error: 'that code is not right' })
  })
  app.post('/api/account/name', active, async (req) => {
    const b = z.strictObject({ first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100) }).parse(req.body)
    await tx(d.db, async (c) => {
      // R-ACC-04: statements carry the signed name, so the affected one must be confirmed again. The time is read with the lock held:
      // a signature this waited for must count as before the change
      await heldAccount(c, req.user!)
      await c.query('UPDATE user_account SET first_name = $2, last_name = $3, name = $4, identity_changed_at = clock_timestamp() WHERE id = $1', [req.user!.id, b.first_name, b.last_name, `${b.first_name} ${b.last_name}`])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'user.name_changed', entity: req.user!.id })
    })
    return { ok: true }
  })
  app.post('/api/account/email', active, async (req, reply) => {
    const b = z.strictObject({ email: z.email().max(320), password: Password, code: z.string().max(20).optional() }).parse(req.body)
    if (!(await mailReady())) return reply.code(503).send({ error: 'Email is not set up on this instance yet.' })
    if (!(await verifyPassword(req.user!.id, b.password, req.ip))) return reply.code(400).send({ error: 'wrong password' })
    if (req.user!.mfaOn && !SECOND_FACTOR_GIVEN.has(await checkSecondFactor(d.db, d.k, req.user!.id, b.code, now().getTime()))) return reply.code(400).send({ error: 'enter the code from your authenticator' })
    await tx(d.db, async (c) => {
      // locked, with the session and two-step read again: either may have changed since the route looked
      const { mfa_enabled_at: on } = await heldAccount(c, req.user!)
      if (on && !req.user!.mfaOn) throw new Refused(TWO_STEP_CAME_ON)
      const taken = await c.query('SELECT 1 FROM user_account WHERE lower(email) = lower($1)', [b.email])
      if (taken.rowCount) return null
      await voidTokens(c, req.user!.id, 'change_email')
      const t = await issueToken(c, req.user!.id, 'change_email', { newEmail: b.email })
      await toAddress(c, b.email, 'Confirm your new email address', `Confirm your new email address: ${linkTo(`/confirm-email?token=${t}`)}`)
      return t
    })
    await mail.flush()
    return { ok: true }
  })
  app.post('/api/account/email/confirm', pub, async (req, reply) => {
    const { token, password } = z.strictObject({ token: z.string().max(200), password: Password }).parse(req.body)
    const invalid = () => reply.code(400).send({ error: 'this link or password is not right' })
    if (!(await reserveAttempt(d.db, [d.k.hmac(`confirm-email-ip\0${req.ip}`), d.k.hmac(`confirm-email-token\0${token}`)]))) return reply.code(429).send({ error: 'too many attempts, try later' })
    // as at registration: the owner of the address, clicking a mail they did not ask for, must not be enough
    const pending = await peekToken(token, 'change_email')
    if (!pending) return invalid()
    const held = (await d.db.query<{ password_hash: string | null }>('SELECT password_hash FROM user_account WHERE id = $1', [pending.user_id])).rows[0]?.password_hash
    if (!held || !(await argon2.verify(held, password))) return invalid()
    try {
      const old = await tx(d.db, async (c) => {
        const t = await consumeToken(c, token, 'change_email')
        if (!t) return null
        const before = (await c.query<{ email: string }>('SELECT email FROM user_account WHERE id = $1 FOR UPDATE', [t.user_id])).rows[0]!.email
        await c.query('INSERT INTO user_email_history (user_id, email) VALUES ($1, $2)', [t.user_id, before])
        await c.query('UPDATE user_account SET email = $2, email_verified_at = $3::timestamptz, identity_changed_at = clock_timestamp(), credential_version = credential_version + 1 WHERE id = $1', [t.user_id, t.new_email, now().toISOString()])
        await c.query('DELETE FROM app_session WHERE user_id = $1', [t.user_id])
        await voidTokens(c, t.user_id)
        await appendAudit(c, d.k, { actor: t.user_id, action: 'user.email_changed', entity: t.user_id })
        // to the old address on purpose: whoever lost the account must hear of it
        await toAddress(c, before, 'Your email address was changed', 'The email address on your account was changed and your sessions were ended. If this was not you, tell your operator at once.')
        return before
      })
      if (!old) return invalid()
      await mail.flush()
      return { ok: true }
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return invalid()
      throw e
    }
  })
  // R-ACC-04, §5.6: stops the account now; the data goes when its retention ends, and the page says so
  // needs a proven address: otherwise someone who claimed an address could close it and shut its owner out
  app.post('/api/account/delete', verified, async (req, reply) => {
    const { password, code } = z.strictObject({ password: Password, code: z.string().max(20).optional() }).parse(req.body)
    if (!(await verifyPassword(req.user!.id, password, req.ip))) return reply.code(400).send({ error: 'wrong password' })
    if (req.user!.roles.length) return reply.code(409).send({ error: 'Someone holding a role must have it removed first.' })
    if (req.user!.mfaOn && !SECOND_FACTOR_GIVEN.has(await checkSecondFactor(d.db, d.k, req.user!.id, code, now().getTime()))) return reply.code(400).send({ error: 'enter the code from your authenticator' })
    await tx(d.db, async (c) => {
      // the answers above were read before the password check, which takes a while; a role grant goes through the instance row this waits on
      const u = await liveShare(c, req.user!)
      if (u.mfa_enabled_at && !req.user!.mfaOn) throw new Refused(TWO_STEP_CAME_ON)
      if ((await c.query('SELECT 1 FROM role_grant WHERE user_id = $1 LIMIT 1', [req.user!.id])).rowCount) throw new Refused('Someone holding a role must have it removed first.')
      await c.query('UPDATE user_account SET deletion_requested_at = $2::timestamptz, disabled_at = $2::timestamptz WHERE id = $1', [req.user!.id, now().toISOString()])
      await c.query('DELETE FROM app_session WHERE user_id = $1', [req.user!.id])
      await voidTokens(c, req.user!.id)
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'user.deletion_requested', entity: req.user!.id })
    })
    return { ok: true, note: 'Your account is closed. Records the law requires are kept until their retention ends, then deleted.' }
  })
  app.post<{ Params: { id: string } }>('/api/users/:id/retention-hold', admin, async (req) => {
    const { hold } = z.strictObject({ hold: z.boolean() }).parse(req.body)
    return { ok: true, ...(await setRetentionHold(x, req.user!, Uuid.parse(req.params.id), hold)) }
  })
  // R-KYC-04, R-ENT-03: the periods are the operator's to set
  app.get('/api/retention-config', admin, async () => (await d.db.query('SELECT relationship_years, idle_months, kyc_valid_years, transaction_years FROM retention_config')).rows[0])
  app.put('/api/retention-config', admin, async (req) => {
    // zero is allowed: how long is the operator's and its lawyers' call, and the real mode has a second admin (R-KYC-04)
    const b = z.strictObject({ relationship_years: z.number().int().min(0).max(100), idle_months: z.number().int().min(1).max(1200), kyc_valid_years: z.number().int().min(1).max(100), transaction_years: z.number().int().min(0).max(10).optional() }).parse(req.body)
    return { ok: true, ...(await changeRetentionPeriods(x, req.user!, b)) }
  })
  // R-OP-01: mail stays here in a sandbox. Links that act on an account are for an admin to see, not for whoever asked.
  app.get('/api/sandbox/outbox', admin, async (_req, reply) => {
    if ((await modeOf(d.db)) !== 'sandbox') return reply.code(404).send({ error: 'not a sandbox' })
    return { mail: (await d.db.query('SELECT id, to_address, subject, body, is_html, created_at FROM sandbox_outbox ORDER BY created_at DESC LIMIT 200')).rows }
  })

  // ---------- entities (R-ENT-*) ----------
  const FieldValue = z.string().trim().max(2000)
  const PartyBody = z.strictObject({ name: z.string().trim().min(1).max(200), email: z.email().max(320).nullable(), kind: z.enum(['owner', 'controller', 'director', 'representative']), ownership_bps: z.number().int().min(0).max(10000) })
  const EntityBody = z.strictObject({ fields: z.record(z.string().regex(/^[a-z_]{1,40}$/), FieldValue), parties: z.array(PartyBody).max(100).default([]) })

  const entityName = (type: string, fields: Record<string, string>) => (type === 'individual' ? fields.full_name : fields.name) ?? ''

  async function ownEntity(c: Pick<Tx, 'query'>, id: string, user: string, lock = false) {
    const r = await c.query<{ id: string; type: EntityType; current_version: number }>(`SELECT id, type, current_version FROM legal_entity WHERE id = $1 AND owner_user = $2 AND created_at >= ${LIVE}${lock ? ' FOR UPDATE' : ''}`, [id, user])
    // the same answer for someone else's entity and one that does not exist
    if (!r.rows[0]) throw new Refused('No such entity.')
    return r.rows[0]
  }

  async function latestCase(c: Pick<Tx, 'query'>, entity: string) {
    return (await c.query<{ id: string; status: KycFact['status'] | 'superseded'; entity_version: number; expires_on: string | null; return_reason: string | null; decided_at: Date | null; provider: string; provider_ref: string | null; provider_external_id: string | null; provider_suggestion: string | null; unapplied_result: string | null }>(
      'SELECT id, status, entity_version, expires_on, return_reason, decided_at, provider, provider_ref, provider_external_id, provider_suggestion, unapplied_result FROM kyc_case WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1',
      [entity],
    )).rows[0] ?? null
  }

  /** A reviewer named on an entity is not independent of it, whoever owns it. Conflicts in general are R-REV-04. */
  const refuseIfNamed = async (c: Pick<Tx, 'query'>, entity: string, email: string) => {
    const r = await c.query('SELECT 1 FROM entity_party p JOIN legal_entity e ON e.id = p.entity_id AND e.current_version = p.entity_version WHERE p.entity_id = $1 AND lower(p.email) = lower($2)', [entity, email])
    if (r.rowCount) throw new Refused('You cannot decide on an entity you are named on.')
  }

  const entityRejected = async (c: Pick<Tx, 'query'>, id: string) => !!(await c.query<{ rejected_at: Date | null }>('SELECT rejected_at FROM legal_entity WHERE id = $1', [id])).rows[0]?.rejected_at
  const refuseIfRejected = async (c: Pick<Tx, 'query'>, id: string) => {
    if (await entityRejected(c, id)) throw new Refused('This entity cannot be used any more.')
  }

  /** The newest file for each requirement: what would go to review. Bank proof is not part of the identity. */
  const currentFiles = async (c: Pick<Tx, 'query'>, id: string) =>
    (await c.query<{ id: string; requirement: string; display_name: string }>("SELECT DISTINCT ON (requirement) id, requirement, display_name FROM stored_file WHERE owner_id = $1 AND scope = 'entity_kyc' ORDER BY requirement, created_at DESC", [id])).rows

  async function describeEntity(q: Pick<Tx, 'query'>, id: string, type: EntityType, version: number) {
    const v = (await q.query<{ fields: Record<string, string> }>('SELECT fields FROM legal_entity_version WHERE entity_id = $1 AND version = $2', [id, version])).rows[0]!
    const parties = (await q.query<{ id: string; name: string; email: string | null; kind: Party['kind']; ownership_bps: number; verified_at: string | null }>('SELECT id, name, email, kind, ownership_bps, verified_at FROM entity_party WHERE entity_id = $1 AND entity_version = $2 ORDER BY created_at', [id, version])).rows
    const files = await currentFiles(q, id)
    const bank = (await q.query("SELECT id, holder, account_fields, status FROM entity_bank_account WHERE entity_id = $1 AND status IN ('pending', 'confirmed') ORDER BY created_at", [id])).rows
    const kyc = await latestCase(q, id)
    const today = now().toISOString().slice(0, 10)
    const known: KycFact | null = kyc && kyc.status !== 'superseded' ? { status: kyc.status, entityVersion: kyc.entity_version, expiresOn: kyc.expires_on } : null
    // refusal stands whichever case it was given on, and newer ones cannot undo it
    const fact: KycFact | null = (await entityRejected(q, id)) ? { status: 'rejected', entityVersion: version, expiresOn: null } : known
    return {
      id, type, version, fields: v.fields, parties, files, bank,
      status: entityStatus(fact, version, today),
      return_reason: kyc?.status === 'returned' ? kyc.return_reason : null,
      // R-KYC-02: only while the pass counts, and with its date. Sanctions and PEP screening happen outside the software (R-CMP-05).
      passed_on: kycPassed(fact, version, today) ? kyc!.decided_at!.toISOString().slice(0, 10) : null,
      gaps: entityGaps({ type, fields: v.fields, files: files.map((f) => f.requirement), parties: parties.map((p) => ({ kind: p.kind, ownershipBps: p.ownership_bps, verified: !!p.verified_at })) }, thresholds((await activePack(q)).pack).uboOverBps),
    }
  }

  type PartyRow = z.infer<typeof PartyBody> & { verified_at?: string | null }
  const samePerson = (a: PartyRow, b: PartyRow) => a.name === b.name && a.email === b.email && a.kind === b.kind && a.ownership_bps === b.ownership_bps

  /** A new identity version. Someone unchanged keeps their confirmation; anyone changed confirms again (R-ENT-03, R-ENT-04). */
  async function newVersion(c: Tx, id: string, type: EntityType, version: number, fields: Record<string, string>, parties: PartyRow[]) {
    const before = (await c.query<PartyRow>('SELECT name, email, kind, ownership_bps, verified_at FROM entity_party WHERE entity_id = $1 AND entity_version = $2', [id, version])).rows
    const v = version + 1
    await c.query('INSERT INTO legal_entity_version (entity_id, version, fields) VALUES ($1, $2, $3)', [id, v, JSON.stringify(fields)])
    await c.query('UPDATE legal_entity SET current_version = $2 WHERE id = $1', [id, v])
    await writeParties(c, id, v, parties.map((p) => ({ ...p, verified_at: before.find((x) => samePerson(x, p))?.verified_at ?? null })))
    await c.query("UPDATE kyc_case SET status = 'returned', return_reason = 'The details changed, so they need checking again.' WHERE entity_id = $1 AND status IN ('in_progress', 'pending_review')", [id])
    // R-ENT-06: an account must be in the entity's own name, so one in the old name no longer stands
    const banks = (await c.query<{ id: string; holder: string }>("SELECT id, holder FROM entity_bank_account WHERE entity_id = $1 AND status IN ('pending', 'confirmed')", [id])).rows
    for (const b of banks) {
      if (sameHolder(b.holder, entityName(type, fields))) continue
      await c.query("UPDATE entity_bank_account SET status = 'replaced' WHERE id = $1", [b.id])
      await appendAudit(c, d.k, { actor: 'system', action: 'entity.bank_no_longer_in_name', entity: b.id })
    }
    await appendAudit(c, d.k, { actor: 'system', action: 'entity.version_created', entity: id })
    // R-ENT-03: nothing signed and no money in: the participation follows the entity and waits for the new check (a deed only
    // sent is not signed: it no longer matches, so it is sent again, Codex round 6)
    await c.query(
      `UPDATE participation p SET entity_version = $2, updated_at = clock_timestamp() FROM deal dl
        WHERE p.entity_id = $1 AND p.outcome = 'active' AND dl.id = p.deal_id AND dl.state NOT IN ('settled', 'closed') AND p.entity_version <> $2
          AND NOT EXISTS (SELECT 1 FROM signature_record s WHERE s.participation_id = p.id AND s.superseded_at IS NULL AND (s.provider <> 'external' OR s.external_status = 'signed')) AND NOT EXISTS (SELECT 1 FROM receipt r WHERE r.participation_id = p.id AND r.reversed_at IS NULL)`,
      [id, v],
    )
    // §5.2, R-ENT-03: before settlement, anyone who signed or has money in goes to identity review and loses their instructions
    const review = (await c.query<{ id: string }>(
      `UPDATE participation p SET identity_review = 'pending', updated_at = clock_timestamp() FROM deal dl
        WHERE p.entity_id = $1 AND p.outcome = 'active' AND dl.id = p.deal_id AND dl.state NOT IN ('settled', 'closed') AND p.identity_review <> 'pending'
          AND (EXISTS (SELECT 1 FROM signature_record s WHERE s.participation_id = p.id AND s.superseded_at IS NULL AND (s.provider <> 'external' OR s.external_status = 'signed')) OR EXISTS (SELECT 1 FROM receipt r WHERE r.participation_id = p.id AND r.reversed_at IS NULL))
        RETURNING p.id`,
      [id],
    )).rows
    for (const p of review) {
      const voided = await c.query("UPDATE issued_instruction SET voided_at = clock_timestamp(), void_reason = 'identity_review' WHERE participation_id = $1 AND voided_at IS NULL", [p.id])
      await appendAudit(c, d.k, { actor: 'system', action: 'participation.identity_review', entity: p.id })
      // R-PAY-03: the urgent notice, queued with the change and sent by the caller's flush
      if (voided.rowCount) {
        const who = (await c.query<{ user_id: string; email: string; deal_id: string }>('SELECT u.id AS user_id, u.email, x.deal_id FROM participation x JOIN user_account u ON u.id = x.user_id WHERE x.id = $1', [p.id])).rows[0]!
        await mail.urgent(c, 'void_details_changed', { userId: who.user_id, to: who.email, dealId: who.deal_id })
      }
    }
    return v
  }

  async function writeParties(c: Tx, entity: string, version: number, parties: PartyRow[]) {
    for (const p of parties) {
      await c.query('INSERT INTO entity_party (id, entity_id, entity_version, name, email, kind, ownership_bps, verified_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), entity, version, p.name, p.email, p.kind, p.ownership_bps, p.verified_at ?? null])
    }
  }

  app.get('/api/entities', verified, async (req) => {
    const rows = (await d.db.query<{ id: string; type: EntityType; current_version: number }>(`SELECT id, type, current_version FROM legal_entity WHERE owner_user = $1 AND created_at >= ${LIVE} ORDER BY created_at`, [req.user!.id])).rows
    return { entities: await Promise.all(rows.map((e) => describeEntity(d.db, e.id, e.type, e.current_version))) }
  })
  app.post('/api/entities', verified, async (req) => {
    const b = z.strictObject({ type: z.enum(['individual', 'company', 'trust', 'other']), fields: EntityBody.shape.fields, parties: EntityBody.shape.parties }).parse(req.body)
    if (!(await reserveAttempt(d.db, [d.k.hmac(`entity-edit\0${req.user!.id}`)]))) throw new Refused('Too many changes. Try later.')
    const id = randomUUID()
    await tx(d.db, async (c) => {
      await liveShare(c, req.user!)
      // entities from before the switch are out of use, so they do not take up room
      const held = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM legal_entity WHERE owner_user = $1 AND created_at >= ${LIVE}`, [req.user!.id])).rows[0]!
      if (Number(held.n) >= USER_ENTITY_LIMIT) throw new Refused('You have too many entities.')
      await c.query('INSERT INTO legal_entity (id, owner_user, type) VALUES ($1, $2, $3)', [id, req.user!.id, b.type])
      await c.query('INSERT INTO legal_entity_version (entity_id, version, fields) VALUES ($1, 1, $2)', [id, JSON.stringify(b.fields)])
      await writeParties(c, id, 1, b.parties)
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'entity.created', entity: id })
    })
    return { id }
  })
  // R-ENT-03: any change makes a new identity version; a pass on the old one stops counting, and an open case goes back
  app.put<{ Params: { id: string } }>('/api/entities/:id', verified, async (req) => {
    const b = EntityBody.parse(req.body)
    const id = Uuid.parse(req.params.id)
    if (!(await reserveAttempt(d.db, [d.k.hmac(`entity-edit\0${req.user!.id}`)]))) throw new Refused('Too many changes. Try later.')
    const version = await tx(d.db, async (c) => {
      await liveShare(c, req.user!)
      const e = await ownEntity(c, id, req.user!.id, true)
      await refuseIfRejected(c, id)
      return newVersion(c, id, e.type, e.current_version, b.fields, b.parties)
    })
    await mail.flush()
    return { version }
  })

  const slots = new UploadSlots()
  const downloads = new UploadSlots(4, 16)
  type UploadRoute = { Params: { id: string }; Querystring: { requirement?: string; name?: string } }
  const slotOf = new WeakMap<object, { who: string; timer: NodeJS.Timeout; working: boolean; gone: boolean }>()
  const freeSlot = (req: object) => {
    const held = slotOf.get(req)
    if (!held) return
    slotOf.delete(req)
    clearTimeout(held.timer)
    slots.give(held.who)
  }
  // files come as raw bytes; the name is display only (§5.8), the type is judged from the content. The parser exists only here.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: FILE_LIMIT }, (_r, body, done) => done(null, body))
    const addFile = async (req: FastifyRequest<UploadRoute>, reply: FastifyReply) => {
      const id = Uuid.parse(req.params.id)
      const requirement = z.string().regex(/^[a-z_]{1,40}$/).parse(req.query.requirement)
      const name = z.string().trim().min(1).max(200).refine((s) => !s.includes('\0')).parse(req.query.name)
      const data = req.body
      if (!Buffer.isBuffer(data) || !data.length) return reply.code(400).send({ error: 'send the file as raw bytes' })
      const kind = ALLOWED_FILES.find((f) => data.subarray(0, f.magic.length).equals(f.magic))
      if (!kind) return reply.code(415).send({ error: 'only PDF, PNG and JPEG files are accepted' })
      const owned = await ownEntity(d.db, id, req.user!.id)
      if (!allowedRequirement(owned.type, requirement)) return reply.code(400).send({ error: 'this entity does not need that document' })
      await refuseIfRejected(d.db, id)
      const held = (await d.db.query<{ n: string; bytes: string }>('SELECT count(*) AS n, coalesce(sum(size_bytes), 0) AS bytes FROM stored_file WHERE owner_id = $1', [id])).rows[0]!
      if (Number(held.n) >= ENTITY_FILE_LIMIT || Number(held.bytes) + data.length > ENTITY_BYTES_LIMIT) return reply.code(413).send({ error: 'this entity has too many files' })
      const mine = (await d.db.query<{ bytes: string }>(`SELECT coalesce(sum(size_bytes), 0) AS bytes FROM stored_file WHERE uploaded_by = $1 AND created_at >= ${LIVE}`, [req.user!.id])).rows[0]!
      if (Number(mine.bytes) + data.length > USER_BYTES_LIMIT) return reply.code(413).send({ error: 'you have too many files' })
      const a = await adapters()
      const scan = await a.scanner.scan(data)
      if (!scan.clean) return reply.code(422).send({ error: 'this file did not pass the virus check' })
      const fileId = randomUUID()
      const sealed = d.k.encrypt(data)
      const key = `kyc/${id}/${fileId}`
      try {
        await a.storage.put(key, sealed.ciphertext)
      } catch (e) {
        if (e instanceof StorageFull) return reply.code(507).send({ error: e.message })
        throw e
      }
      await tx(d.db, async (c) => {
        await liveShare(c, req.user!)
        // the limits again, under locks: the checks above let parallel uploads past together
        const e = await ownEntity(c, id, req.user!.id, true)
        await refuseIfRejected(c, id)
        const now2 = (await c.query<{ n: string; bytes: string }>('SELECT count(*) AS n, coalesce(sum(size_bytes), 0) AS bytes FROM stored_file WHERE owner_id = $1', [id])).rows[0]!
        const all = (await c.query<{ bytes: string }>(`SELECT coalesce(sum(size_bytes), 0) AS bytes FROM stored_file WHERE uploaded_by = $1 AND created_at >= ${LIVE}`, [req.user!.id])).rows[0]!
        if (Number(now2.n) >= ENTITY_FILE_LIMIT || Number(now2.bytes) + data.length > ENTITY_BYTES_LIMIT || Number(all.bytes) + data.length > USER_BYTES_LIMIT) throw new Refused('There are too many files.')
        const isProof = requirement === BANK_PROOF
        await c.query('INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)', [
          fileId, isProof ? 'entity_bank' : 'entity_kyc', id, requirement, name, kind.type, createHash('sha256').update(data).digest('hex'), data.length, 'clean', key, sealed.keyId, sealed.wrappedDek, req.user!.id,
        ])
        // R-ENT-03: what was reviewed and what is held must be the same, so a new document after sending is a new version
        const last = await latestCase(c, id)
        if (!isProof && last && last.entity_version === e.current_version && (last.status === 'in_progress' || last.status === 'pending_review' || last.status === 'approved')) {
          const v = (await c.query<{ fields: Record<string, string> }>('SELECT fields FROM legal_entity_version WHERE entity_id = $1 AND version = $2', [id, e.current_version])).rows[0]!
          const parties = (await c.query<PartyRow>('SELECT name, email, kind, ownership_bps FROM entity_party WHERE entity_id = $1 AND entity_version = $2', [id, e.current_version])).rows
          await newVersion(c, id, e.type, e.current_version, v.fields, parties)
        }
        await appendAudit(c, d.k, { actor: req.user!.id, action: 'entity.file_added', entity: fileId })
      }).catch(async (e) => {
        // without its row nothing could ever find this file again, and retention finds files by their row
        await a.storage.delete(key).catch(() => undefined)
        throw e
      })
      await mail.flush()
      return { id: fileId }
    }
    scope.post<UploadRoute>('/api/entities/:id/files', {
      ...verified,
      bodyLimit: FILE_LIMIT,
      // before the body is read: a stranger must not be able to make the server hold 15 MB
      onRequest: async (req, reply) => {
        const who = await sessionUser(d.db, d.k, req.cookies[SESSION])
        if (!who) return reply.code(401).send({ error: 'not signed in' })
        if (!GATES.verified(who)) return reply.code(403).send({ error: 'not allowed' })
        if (!(await reserveAttempt(d.db, [d.k.hmac(`upload\0${who.id}`)]))) return reply.code(429).send({ error: 'too many uploads, try later' })
        if (!slots.take(who.id)) return reply.code(429).send({ error: 'too many uploads at once, try again in a moment' })
        // a body that never finishes must not keep its slot: at the deadline the connection goes and the slot comes back
        const timer = setTimeout(() => req.raw.destroy(), d.uploadDeadlineMs ?? UPLOAD_DEADLINE_MS)
        timer.unref()
        const slot = { who: who.id, timer, working: false, gone: false }
        slotOf.set(req, slot)
        // 'close' comes however the request ends: answered, body unfinished, or dropped. A file being worked on is still in memory, so it keeps its slot until the work ends
        reply.raw.once('close', () => {
          slot.gone = true
          if (!slot.working) freeSlot(req)
        })
      },
    }, async (req, reply) => {
      const slot = slotOf.get(req)
      if (!slot) return reply.code(400).send({ error: 'the connection went before this was read' }) // gone before the work began: none is done
      slot.working = true
      try {
        return await addFile(req, reply)
      } finally {
        slot.working = false
        if (slot.gone) freeSlot(req)
      }
    })
  })
  // R-KYC-03, TC-AUTHZ-02: the owner or a reviewer. A lead gets a refusal however they ask; each reviewer view is audited.
  app.get<{ Params: { id: string } }>('/api/files/:id', verified, async (req, reply) => {
    const f = (await d.db.query<{ id: string; owner_id: string; owner_user: string; content_type: string; storage_key: string; key_id: string; wrapped_key: Buffer; display_name: string }>(
      `SELECT f.id, f.owner_id, e.owner_user, f.content_type, f.storage_key, f.key_id, f.wrapped_key, f.display_name FROM stored_file f JOIN legal_entity e ON e.id = f.owner_id WHERE f.id = $1 AND e.created_at >= ${LIVE}`,
      [Uuid.parse(req.params.id)],
    )).rows[0]
    const isOwner = f?.owner_user === req.user!.id
    const isReviewer = req.user!.roles.includes('reviewer') && req.user!.mfaOn
    if (!f || (!isOwner && !isReviewer)) return reply.code(404).send({ error: 'no such file' })
    // a whole file is held in memory until it has gone, so a reader who stops reading must not hold it for long, or many of them at once
    if (!downloads.take(req.user!.id)) return reply.code(429).send({ error: 'too many downloads at once, try again in a moment' })
    const timer = setTimeout(() => req.raw.destroy(), d.downloadDeadlineMs ?? DOWNLOAD_DEADLINE_MS)
    let held = true
    const release = () => {
      if (!held) return
      held = false
      clearTimeout(timer)
      downloads.give(req.user!.id)
    }
    reply.raw.once('finish', release)
    reply.raw.once('close', release)
    const a = await adapters()
    const sealed = await a.storage.get(f.storage_key)
    if (!sealed) return reply.code(404).send({ error: 'no such file' })
    if (!isOwner) await tx(d.db, (c) => appendAudit(c, d.k, { actor: req.user!.id, action: 'kyc.file_viewed', entity: f.id }))
    return reply.header('content-disposition', 'attachment; filename="document"').type(f.content_type).send(d.k.decrypt(f.key_id, f.wrapped_key, sealed))
  })

  // R-ENT-04: a beneficial owner confirms through a link of their own, which goes to them and not to whoever asked
  app.post<{ Params: { id: string; party: string } }>('/api/entities/:id/parties/:party/link', verified, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const partyId = Uuid.parse(req.params.party)
    if (!(await mailReady())) return reply.code(503).send({ error: 'Email is not set up on this instance yet.' })
    if (!(await reserveAttempt(d.db, [d.k.hmac(`party-link\0${partyId}`), d.k.hmac(`party-link-user\0${req.user!.id}`)]))) return reply.code(429).send({ error: 'too many attempts, try later' })
    const token = randomBytes(32).toString('base64url')
    await tx(d.db, async (c) => {
      await liveShare(c, req.user!)
      await ownEntity(c, id, req.user!.id)
      await refuseIfRejected(c, id)
      const p = (await c.query<{ email: string | null }>('UPDATE entity_party SET verify_token_hmac = $3 WHERE id = $1 AND entity_id = $2 RETURNING email', [partyId, id, d.k.hmac(`party\0${token}`)])).rows[0]
      if (!p?.email) throw new Refused('This person has no email address.')
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'entity.party_link_sent', entity: partyId })
      await toAddress(c, p.email, 'Please confirm your details', `Please confirm your details: ${linkTo(`/party?token=${token}`)}`)
    })
    await mail.flush()
    return { ok: true }
  })
  app.post('/api/party-links/confirm', pub, async (req, reply) => {
    const { token } = z.strictObject({ token: z.string().max(200) }).parse(req.body)
    const ok = await tx(d.db, async (c) => {
      // only someone on the current version: a link from before a change would confirm nothing that counts
      const r = await c.query<{ id: string }>(
        'UPDATE entity_party p SET verified_at = $2::timestamptz, verify_token_hmac = NULL FROM legal_entity e WHERE p.verify_token_hmac = $1 AND e.id = p.entity_id AND e.current_version = p.entity_version RETURNING p.id',
        [d.k.hmac(`party\0${token}`), now().toISOString()],
      )
      if (!r.rows[0]) return false
      await appendAudit(c, d.k, { actor: 'system', action: 'entity.party_confirmed', entity: r.rows[0].id })
      return true
    })
    return ok ? { ok: true } : reply.code(400).send({ error: 'this link is not valid any more' })
  })

  // a replacement is any account after one a person confirmed, even if that one has since been retired (R-ENT-06)
  const CONFIRMED_BEFORE = "SELECT 1 FROM entity_bank_account WHERE entity_id = $1 AND status IN ('confirmed', 'replaced') AND confirmed_by IS NOT NULL"
  // R-ENT-06: in the entity's own name; a change brings evidence and a person confirms it
  app.post<{ Params: { id: string } }>('/api/entities/:id/bank', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const b = z.strictObject({ holder: z.string().trim().min(1).max(200), account_fields: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.string().trim().min(1).max(100)), evidence_file: Uuid.nullable() }).parse(req.body)
    if (!bankDetailsGiven(b.account_fields)) throw new Refused(BANK_DETAILS_NEEDED)
    const bankId = randomUUID()
    await tx(d.db, async (c) => {
      await liveShare(c, req.user!)
      const e = await ownEntity(c, id, req.user!.id, true)
      await refuseIfRejected(c, id)
      const v = (await c.query<{ fields: Record<string, string> }>('SELECT fields FROM legal_entity_version WHERE entity_id = $1 AND version = $2', [id, e.current_version])).rows[0]!
      if (!sameHolder(b.holder, entityName(e.type, v.fields))) throw new Refused('The account must be in the name of this entity.')
      const existing = await c.query(CONFIRMED_BEFORE, [id])
      if (existing.rowCount && !b.evidence_file) throw new Refused('Changing the account needs proof of the new one.')
      if (b.evidence_file) {
        const f = await c.query('SELECT 1 FROM stored_file WHERE id = $1 AND owner_id = $2', [b.evidence_file, id])
        if (!f.rowCount) throw new Refused('That proof is not a file of this entity.')
      }
      await c.query('INSERT INTO entity_bank_account (id, entity_id, holder, account_fields, evidence_file) VALUES ($1, $2, $3, $4, $5)', [bankId, id, b.holder, JSON.stringify(b.account_fields), b.evidence_file])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'entity.bank_added', entity: bankId })
    })
    return { id: bankId }
  })
  app.get('/api/review/bank', reviewer, async () => {
    const r = await d.db.query<{ id: string; entity_id: string; holder: string; account_fields: object; evidence_file: string | null; created_at: Date; type: string; fields: Record<string, string>; owner_name: string; has_confirmed: boolean }>(
      `SELECT b.id, b.entity_id, b.holder, b.account_fields, b.evidence_file, b.created_at, e.type, v.fields, u.name AS owner_name,
              EXISTS (SELECT 1 FROM entity_bank_account o WHERE o.entity_id = b.entity_id AND o.status = 'confirmed') AS has_confirmed
         FROM entity_bank_account b JOIN legal_entity e ON e.id = b.entity_id JOIN user_account u ON u.id = e.owner_user
         JOIN legal_entity_version v ON v.entity_id = e.id AND v.version = e.current_version
        WHERE b.status = 'pending' AND b.created_at >= ${LIVE} ORDER BY b.created_at LIMIT 200`,
    )
    return { accounts: r.rows }
  })
  app.post<{ Params: { id: string } }>('/api/review/bank/:id/decide', reviewer, async (req) => {
    const id = Uuid.parse(req.params.id)
    const { decision } = z.strictObject({ decision: z.enum(['confirm', 'refuse']) }).parse(req.body)
    await reviewerTx(x, req.user!, async (c, recheck) => {
      // the entity first: two decisions at once must not each see no confirmed account
      const entity = (await c.query<{ entity_id: string }>(`SELECT entity_id FROM entity_bank_account WHERE id = $1 AND created_at >= ${LIVE}`, [id])).rows[0]
      if (!entity) throw new Refused('No such account waiting.')
      await c.query('SELECT 1 FROM legal_entity WHERE id = $1 FOR UPDATE', [entity.entity_id])
      await recheck() // the wait for that lock can be long
      const r = (await c.query<{ entity_id: string; owner_user: string; status: string; evidence_file: string | null }>(`SELECT b.entity_id, e.owner_user, b.status, b.evidence_file FROM entity_bank_account b JOIN legal_entity e ON e.id = b.entity_id WHERE b.id = $1 AND b.created_at >= ${LIVE} FOR UPDATE OF b`, [id])).rows[0]
      if (!r || r.status !== 'pending') throw new Refused('No such account waiting.')
      if (r.owner_user === req.user!.id) throw new Refused('You cannot decide on your own entity.')
      await refuseIfNamed(c, r.entity_id, req.user!.email)
      // several can wait at once, so whether this one is a change is known only now
      const confirmed = await c.query(CONFIRMED_BEFORE, [r.entity_id])
      if (decision === 'confirm') {
        const now2 = (await c.query<{ type: string; fields: Record<string, string>; holder: string; account_fields: Record<string, string> }>('SELECT e.type, v.fields, b.holder, b.account_fields FROM entity_bank_account b JOIN legal_entity e ON e.id = b.entity_id JOIN legal_entity_version v ON v.entity_id = e.id AND v.version = e.current_version WHERE b.id = $1', [id])).rows[0]!
        if (!sameHolder(now2.holder, entityName(now2.type, now2.fields))) throw new Refused('The account is not in the name of this entity any more.')
        if (!bankDetailsGiven(now2.account_fields)) throw new Refused(BANK_DETAILS_NEEDED)
      }
      if (decision === 'confirm' && confirmed.rowCount && !r.evidence_file) throw new Refused('Changing the account needs proof of the new one.')
      if (decision === 'confirm') await c.query("UPDATE entity_bank_account SET status = 'replaced' WHERE entity_id = $1 AND status = 'confirmed'", [r.entity_id])
      await c.query('UPDATE entity_bank_account SET status = $2, confirmed_by = $3 WHERE id = $1', [id, decision === 'confirm' ? 'confirmed' : 'refused', req.user!.id])
      await appendAudit(c, d.k, { actor: req.user!.id, action: `entity.bank_${decision}`, entity: id })
    })
    return { ok: true }
  })

  // ---------- KYC (R-KYC-*) ----------
  const activePack = async (c: Pick<Tx, 'query'>) => {
    const id = (await c.query<{ active_pack_id: string }>('SELECT active_pack_id FROM instance_profile WHERE id = 1')).rows[0]!.active_pack_id
    return { id, pack: (await packContent(c, id))! }
  }
  const textOf = (p: RegimePack, key: string, variant = 'default') => p.legal_texts.find((t) => t.text_key === key && t.variant === variant)
  const realProvider = async () => ((await modeOf(d.db)) === 'real' ? d.real?.kyc : undefined)

  // what the person agrees to is shown before they agree, and it is the text whose hash is kept (R-KYC-01)
  app.get('/api/kyc/routes', verified, async () => {
    const provider = await realProvider()
    if (!provider) return { provider: false, uses_biometrics: false, consent_text: null, consent_format: null, consent_sha256: null }
    const { pack } = await activePack(d.db)
    const consent = textOf(pack, pack.biometric_consent_text_key)!
    return { provider: true, uses_biometrics: provider.usesBiometrics, consent_text: consent.body, consent_format: consent.format, consent_sha256: sha(consent.body) }
  })
  const SubmitKyc = z.strictObject({ path: z.enum(['provider', 'manual']), biometric_consent: z.boolean().default(false), biometric_consent_sha256: z.string().max(64).optional(), confirm_true: z.literal(true) })
  app.post<{ Params: { id: string } }>('/api/entities/:id/kyc', verified, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const b = SubmitKyc.parse(req.body)
    const mode = await modeOf(d.db)
    const provider = await realProvider()
    if (b.path === 'provider' && mode === 'real' && !provider) throw new Refused('This instance has no provider set up. Choose the route without a face scan.')
    // R-KYC-01: a provider using biometrics needs a recorded consent, and there is always the manual path without them
    const useProvider = b.path === 'provider' ? provider : undefined
    const refuseIfConsentStale = async (c: Tx) => {
      const { pack } = await activePack(c)
      if (b.biometric_consent_sha256 !== sha(textOf(pack, pack.biometric_consent_text_key)!.body)) throw new Refused('The wording you agreed to has changed. Read it again.')
    }
    const ready = async (c: Tx) => {
      const e = await ownEntity(c, id, req.user!.id, true)
      const info = await describeEntity(c, id, e.type, e.current_version) // this transaction's connection: never ask the pool for a second one here
      if (info.gaps.length) throw new Refused(`Still missing: ${info.gaps.join(', ')}.`)
      const last = await latestCase(c, id)
      await refuseIfRejected(c, id)
      if (info.status === 'passed') throw new Refused('This entity has already passed.')
      if (last && (last.status === 'in_progress' || last.status === 'pending_review')) throw new Refused('A check is already under way.')
      return { version: e.current_version, files: info.files.map((f) => f.id) }
    }
    let checkedVersion = 0
    // Checked first without the provider, whose call must not hold a lock or a connection. A resubmission keeps the same applicant.
    const known = await tx(d.db, async (c) => {
      const first = await ready(c)
      checkedVersion = first.version
      if (!useProvider) return null
      if (useProvider.usesBiometrics && !b.biometric_consent) throw new Refused('This route uses your face. Agree to it, or choose the route without it.')
      // what they agreed to must be what is current (R-KYC-01)
      if (useProvider.usesBiometrics) await refuseIfConsentStale(c)
      // A retry on the same identity carries on with the same applicant, as the provider means it to. Anything else is a new check, with a
      // new applicant: an old result then has nothing to match.
      const e = await ownEntity(c, id, req.user!.id)
      const last = await latestCase(c, id)
      return last?.status === 'returned' && last.provider === useProvider.name && last.provider_ref && last.provider_suggestion === 'provider_retry' && last.entity_version === e.current_version
        ? { ref: last.provider_ref, external: last.provider_external_id ?? randomUUID() }
        : null
    })
    let ref = known?.ref ?? null
    const external = known?.external ?? randomUUID()
    if (useProvider && !ref) {
      try {
        ref = (await useProvider.start(external, req.user!.email)).ref
        const started = ref
        // with the person locked: either retention has not reached them, and will find this row, or it has, and it is reported here
        await tx(d.db, async (c) => {
          const gone = (await c.query<{ anonymised_at: Date | null }>('SELECT anonymised_at FROM user_account WHERE id = $1 FOR UPDATE', [req.user!.id])).rows[0]?.anonymised_at
          if (gone) await appendAudit(c, d.k, { actor: 'system', action: `retention.provider_followup.${useProvider.name}`, entity: started })
          else await c.query('INSERT INTO kyc_provider_ref (provider, provider_ref, entity_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [useProvider.name, started, id])
        })
      } catch {
        return reply.code(502).send({ error: 'The identity provider cannot be reached. Try later, or choose the route without a face scan.' })
      }
    }
    const caseId = await tx(d.db, async (c) => {
      await liveShare(c, req.user!)
      const r = await ready(c)
      // the applicant belongs to what was checked: new details need a new look
      if (r.version !== checkedVersion) throw new Refused('The details changed while this was being sent. Send it again.')
      // Read again with the entity held, as the webhook holds it: a result delivered since the first look is seen here, or finds the new case.
      const resumed = known ? await latestCase(c, id) : null
      if (known && !(resumed?.status === 'returned' && resumed.provider_ref === known.ref && resumed.provider_suggestion === 'provider_retry')) throw new Refused('This check changed while this was being sent. Send it again.')
      const kept = resumed?.unapplied_result ?? null
      // the pack may have changed during the provider call: what was agreed to must still be what is recorded
      if (useProvider?.usesBiometrics) await refuseIfConsentStale(c)
      const { pack } = await activePack(c)
      const consent = useProvider?.usesBiometrics ? { at: now().toISOString(), sha: sha(textOf(pack, pack.biometric_consent_text_key)!.body) } : null
      const created = randomUUID()
      await c.query("UPDATE kyc_case SET status = 'superseded' WHERE entity_id = $1 AND status = 'returned'", [id])
      await c.query('INSERT INTO kyc_case (id, entity_id, entity_version, provider, provider_ref, provider_external_id, status, provider_suggestion, biometric_consent_at, biometric_consent_text_sha256, file_ids, information_confirmed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::timestamptz)', [
        created, id, r.version, useProvider ? useProvider.name : mode === 'sandbox' ? 'fake' : 'manual', ref, useProvider ? external : null, kept ? 'pending_review' : useProvider ? 'in_progress' : 'pending_review', kept, consent?.at ?? null, consent?.sha ?? null, JSON.stringify(r.files), now().toISOString(),
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'kyc.submitted', entity: created })
      return created
    }).catch((e: { code?: string }) => {
      if (e.code === '23505') throw new Refused('A check is already under way.')
      throw e
    })
    return { id: caseId, url: await providerLink(external, useProvider) }
  })
  const providerLink = async (external: string, p: Awaited<ReturnType<typeof realProvider>>) => {
    if (!p?.link) return undefined
    return p.link(external).catch(() => undefined) // the person can ask again from their entity
  }
  // R-KYC-01: leave and come back, or carry on on a phone: the same page opens anywhere
  app.post<{ Params: { id: string } }>('/api/entities/:id/kyc/link', verified, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    await ownEntity(d.db, id, req.user!.id)
    const last = await latestCase(d.db, id)
    if (last?.status !== 'in_progress' || !last.provider_external_id) throw new Refused('No check is waiting for you at the provider.')
    const url = await providerLink(last.provider_external_id, await realProvider())
    return url ? { url } : reply.code(502).send({ error: 'The identity provider cannot be reached. Try later.' })
  })
  app.get('/api/review/kyc', reviewer, async () => {
    const r = await d.db.query(
      `SELECT k.id, k.entity_id, k.entity_version, k.provider, k.status, k.provider_suggestion, k.late_provider_result, k.created_at, e.type, v.fields, u.name AS owner_name
         FROM kyc_case k JOIN legal_entity e ON e.id = k.entity_id JOIN user_account u ON u.id = e.owner_user
         JOIN legal_entity_version v ON v.entity_id = k.entity_id AND v.version = k.entity_version
        WHERE (k.status = 'pending_review' OR (k.status = 'approved' AND k.late_provider_result IS NOT NULL AND k.entity_version = e.current_version)) AND k.created_at >= ${LIVE} ORDER BY k.created_at LIMIT 200`,
    )
    return { cases: r.rows }
  })
  // R-KYC-01, R-KYC-03, R-ENT-04: what the reviewer decides on: the case's own version and its own files. Every look is audited.
  app.get<{ Params: { id: string } }>('/api/review/kyc/:id', reviewer, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const k = (await d.db.query<{ id: string; entity_id: string; entity_version: number; provider: string; status: string; provider_suggestion: string | null; late_provider_result: string | null; file_ids: string[]; information_confirmed_at: Date | null; biometric_consent_at: Date | null; fields: Record<string, string>; type: string; owner_name: string; owner_email: string }>(
      `SELECT k.id, k.entity_id, k.entity_version, k.provider, k.status, k.provider_suggestion, k.late_provider_result, k.file_ids, k.information_confirmed_at, k.biometric_consent_at, v.fields, e.type, u.name AS owner_name, u.email AS owner_email
         FROM kyc_case k JOIN legal_entity e ON e.id = k.entity_id JOIN user_account u ON u.id = e.owner_user
         JOIN legal_entity_version v ON v.entity_id = k.entity_id AND v.version = k.entity_version
        WHERE k.id = $1 AND k.created_at >= ${LIVE}`,
      [id],
    )).rows[0]
    if (!k) return reply.code(404).send({ error: 'no such case' })
    const parties = (await d.db.query('SELECT name, email, kind, ownership_bps, verified_at FROM entity_party WHERE entity_id = $1 AND entity_version = $2 ORDER BY created_at', [k.entity_id, k.entity_version])).rows
    const rows = (await d.db.query<{ id: string; requirement: string; display_name: string; storage_key: string }>('SELECT id, requirement, display_name, storage_key FROM stored_file WHERE id = ANY($1::uuid[]) ORDER BY requirement', [k.file_ids])).rows
    const a = await adapters()
    // sandbox files live in memory and go on a restart: say so rather than show a dead link
    const sandbox = (await modeOf(d.db)) === 'sandbox'
    const files = await Promise.all(rows.map(async (f) => ({ id: f.id, requirement: f.requirement, display_name: f.display_name, gone: sandbox && !(await a.storage.get(f.storage_key)) })))
    await tx(d.db, (c) => appendAudit(c, d.k, { actor: req.user!.id, action: 'kyc.case_viewed', entity: id }))
    return { ...k, parties, files, file_ids: undefined }
  })
  const Decide = z.discriminatedUnion('decision', [
    z.strictObject({ decision: z.literal('approve') }),
    z.strictObject({ decision: z.literal('return'), reason: z.string().trim().min(1).max(1000) }),
    z.strictObject({ decision: z.literal('reject'), reason: z.string().trim().min(1).max(1000) }),
  ])
  // R-KYC-02: this route is the only way to a pass or a rejection, and only a reviewer reaches it
  app.post<{ Params: { id: string } }>('/api/review/kyc/:id/decide', reviewer, async (req) => {
    const id = Uuid.parse(req.params.id)
    const b = Decide.parse(req.body)
    await reviewerTx(x, req.user!, async (c, recheck) => {
      // the entity first: every decision on any of its cases goes one at a time, so a refusal cannot be overtaken
      const owner = (await c.query<{ entity_id: string }>(`SELECT entity_id FROM kyc_case WHERE id = $1 AND created_at >= ${LIVE}`, [id])).rows[0]
      if (!owner) throw new Refused('No such case waiting for a decision.')
      await c.query('SELECT 1 FROM legal_entity WHERE id = $1 FOR UPDATE', [owner.entity_id])
      await recheck() // the wait for that lock can be long
      await refuseIfRejected(c, owner.entity_id)
      const k = (await c.query<{ status: string; entity_id: string; entity_version: number; owner_user: string; current_version: number; late_provider_result: string | null }>(
        `SELECT k.status, k.entity_id, k.entity_version, e.owner_user, e.current_version, k.late_provider_result FROM kyc_case k JOIN legal_entity e ON e.id = k.entity_id WHERE k.id = $1 AND k.created_at >= ${LIVE} FOR UPDATE OF k`, [id],
      )).rows[0]
      const lateOnPass = k?.status === 'approved' && !!k.late_provider_result
      if (!k || (k.status !== 'pending_review' && !lateOnPass)) throw new Refused('No such case waiting for a decision.')
      if (k.owner_user === req.user!.id) throw new Refused('You cannot decide on your own entity.')
      if (k.entity_version !== k.current_version) throw new Refused('The details changed after this was sent.')
      await refuseIfNamed(c, k.entity_id, req.user!.email)
      if (b.decision === 'approve' && lateOnPass) {
        // a person looked at the late "no" and the pass stands, with its original date
        await c.query('UPDATE kyc_case SET late_provider_result = NULL WHERE id = $1', [id])
        await appendAudit(c, d.k, { actor: req.user!.id, action: 'kyc.late_result_kept', entity: id })
        return
      }
      const today = now().toISOString().slice(0, 10)
      const years = (await c.query<{ y: number }>('SELECT kyc_valid_years AS y FROM retention_config')).rows[0]!.y
      if (b.decision === 'reject') {
        await c.query('UPDATE legal_entity SET rejected_at = $2::timestamptz WHERE id = $1', [k.entity_id, now().toISOString()])
        await c.query("UPDATE kyc_case SET status = 'superseded' WHERE entity_id = $1 AND id <> $2 AND status IN ('in_progress', 'pending_review', 'returned')", [k.entity_id, id])
        // §5.2: the participations with this entity end; the invitation stays, so another entity can commit on the same terms
        const ended = (await c.query<{ id: string; user_id: string; email: string; public_code: string; deal_id: string; lead_user: string }>(
          `UPDATE participation p SET outcome = 'rejected_kyc', ended_at = clock_timestamp(), updated_at = clock_timestamp() FROM user_account u, deal dl
            WHERE p.entity_id = $1 AND p.outcome = 'active' AND u.id = p.user_id AND dl.id = p.deal_id AND dl.state NOT IN ('settled', 'closed') RETURNING p.id, p.user_id, u.email, dl.public_code, p.deal_id, dl.lead_user`,
          [k.entity_id],
        )).rows
        for (const p of ended) {
          const voided = await c.query("UPDATE issued_instruction SET voided_at = clock_timestamp(), void_reason = 'kyc_rejected' WHERE participation_id = $1 AND voided_at IS NULL RETURNING id", [p.id])
          await c.query("INSERT INTO participation_event (id, participation_id, event, actor) VALUES ($1, $2, 'kyc_rejected', $3)", [randomUUID(), p.id, req.user!.id])
          // R-KYC-02.1: the hold record is made whether or not there is money; any money on it is held from now on
          await openHold(c, p.id, req.user!.id)
          await appendAudit(c, d.k, { actor: req.user!.id, action: 'participation.kyc_rejected', entity: p.id })
          if (voided.rowCount) await mail.urgent(c, 'void_kyc', { userId: p.user_id, to: p.email, dealId: p.deal_id })
          await endProposal(c, { k: d.k, mail, now }, p.id, 'part_ended', req.user!.id)
          // as any other end of a part (d4Life `endParticipation`): an open withdrawal lapses, leads with a waiting list hear of room
          await c.query("UPDATE withdrawal_request SET decision = 'lapsed', decided_at = clock_timestamp() WHERE participation_id = $1 AND decision IS NULL", [p.id])
          await tellLeadsOfRoom(c, mail, { id: p.deal_id, lead_user: p.lead_user })
          await refreshRelationship(c, p.user_id, now())
        }
      }
      if (b.decision === 'approve') {
        await c.query("UPDATE kyc_case SET status = 'approved', late_provider_result = NULL, decided_by = $2, decided_at = $3::timestamptz, expires_on = $4 WHERE id = $1", [id, req.user!.id, now().toISOString(), addYears(today, years)])
      } else {
        await c.query('UPDATE kyc_case SET status = $2, late_provider_result = NULL, decided_by = $3, decided_at = $4::timestamptz, return_reason = $5 WHERE id = $1', [id, b.decision === 'return' ? 'returned' : 'rejected', req.user!.id, now().toISOString(), b.reason])
      }
      // the reason can hold personal information, so it is not in the audit row
      await appendAudit(c, d.k, { actor: req.user!.id, action: `kyc.${b.decision}`, entity: id })
      // R-NTF-01: passed or returned, the fixed fields only (a kept pass after a late result was already told)
      if ((b.decision === 'approve' && !lateOnPass) || b.decision === 'return') {
        const to = (await c.query<{ email: string }>('SELECT email FROM user_account WHERE id = $1', [k.owner_user])).rows[0]!.email
        await mail.investor(c, { action: b.decision === 'approve' ? 'kyc_passed' : 'kyc_returned', audience: { kind: 'account', userId: k.owner_user }, to })
      }
    })
    await mail.flush()
    return { ok: true }
  })
  // Signed by the provider, not by a session. A result never decides by itself: it goes to a reviewer (R-KYC-02).
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_r, body, done) => done(null, body))
    scope.post<{ Params: { provider: string } }>('/api/kyc/webhook/:provider', pub, async (req, reply) => {
      const provider = d.real?.kyc
      if (!provider || provider.name !== req.params.provider || (await modeOf(d.db)) !== 'real') return reply.code(404).send({ error: 'not found' })
      let decision
      try {
        decision = provider.parseWebhook({ rawBody: req.body as Buffer, headers: req.headers })
      } catch {
        return reply.code(401).send({ error: 'not accepted' })
      }
      if (!decision) return { ok: true }
      const next = afterProviderDecision(decision)
      const bodyHash = createHash('sha256').update(req.body as Buffer).digest('hex')
      await tx(d.db, async (c) => {
        // the provider retries deliveries: the same signed body changes nothing the second time
        const first = await c.query('INSERT INTO kyc_webhook_event (provider, body_sha256) VALUES ($1, $2) ON CONFLICT DO NOTHING', [provider.name, bodyHash])
        if (!first.rowCount) return
        // the entity first, as a resubmission holds it: a result arriving while the case is replaced must find the new one, not the one it replaced
        const owner = (await c.query<{ entity_id: string }>('SELECT entity_id FROM kyc_case WHERE provider = $1 AND provider_ref = $2 LIMIT 1', [provider.name, decision.ref])).rows[0]
        if (!owner) return
        await c.query('SELECT 1 FROM legal_entity WHERE id = $1 FOR UPDATE', [owner.entity_id])
        const k = (await c.query<{ id: string; status: string; provider_suggestion: string | null }>('SELECT id, status, provider_suggestion FROM kyc_case WHERE provider = $1 AND provider_ref = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [provider.name, decision.ref])).rows[0]
        if (!k) return
        if (k.status === 'in_progress') {
          await c.query('UPDATE kyc_case SET status = $2, provider_suggestion = $3, return_reason = $4 WHERE id = $1', [k.id, next.status, next.suggestion, next.returnReason])
          await appendAudit(c, d.k, { actor: 'system', action: `kyc.provider_${next.suggestion}`, entity: k.id })
        } else if (k.status === 'returned' && k.provider_suggestion === 'provider_retry') {
          // the person finished at the provider before coming back here: keep it for when they resubmit. A newer one replaces it, and a
          // further "send it again" means there is nothing to carry over
          await c.query('UPDATE kyc_case SET unapplied_result = $2 WHERE id = $1', [k.id, next.status === 'returned' ? null : next.suggestion])
          await appendAudit(c, d.k, { actor: 'system', action: `kyc.provider_kept_${next.suggestion}`, entity: k.id })
        } else if (decision.answer === 'RED' && (k.status === 'pending_review' || k.status === 'approved')) {
          // the case has moved on, so this changes nothing by itself; a reviewer is asked to look
          await c.query('UPDATE kyc_case SET late_provider_result = $2 WHERE id = $1', [k.id, next.suggestion])
          await appendAudit(c, d.k, { actor: 'system', action: `kyc.provider_late_${next.suggestion}`, entity: k.id })
        }
      })
      return { ok: true }
    })
  })

  // ---------- eligibility (R-ELG-*) ----------
  const fullNameCaptured = async (c: Pick<Tx, 'query'>, userId: string) => (await c.query<{ n: string | null }>("SELECT CASE WHEN first_name IS NOT NULL THEN first_name || ' ' || last_name ELSE name END AS n FROM user_account WHERE id = $1", [userId])).rows[0]?.n ?? null

  const warningBlockText = (pack: RegimePack, category: string | undefined) => textOf(pack, 'promotion_warning', warningVariant(pack, category))
  const personalisedText = (pack: RegimePack, name: string | null) => fillText(textOf(pack, 'personalised_warning')!.body, { full_name: name ?? '' })

  /** Only what was done under this regime and since the switch counts (R-ELG-02, decision R13). A new version of the same regime keeps it (R-OP-04.2). */
  async function facts(c: Pick<Tx, 'query'>, userId: string, pack: RegimePack): Promise<EligibilityFacts> {
    const st = (await c.query<{ category: string; qualifies: boolean; expires_at: Date; reopened: boolean; stale: boolean }>(
      `SELECT s.category, s.qualifies, s.expires_at, EXISTS (SELECT 1 FROM eligibility_reopen r WHERE r.user_id = s.user_id AND r.created_at > s.created_at) AS reopened,
              s.created_at < coalesce((SELECT identity_changed_at FROM user_account u WHERE u.id = s.user_id), '-infinity'::timestamptz) AS stale
         FROM eligibility_statement s WHERE s.user_id = $1 AND s.regime = $2 AND s.created_at >= ${LIVE} ORDER BY s.created_at DESC LIMIT 1`,
      [userId, pack.regime],
    )).rows[0]
    const attempts = (await c.query<{ questions_used: string[]; passed: boolean | null; locked_until: Date | null }>(
      `SELECT a.questions_used, a.passed, a.locked_until FROM assessment_attempt a JOIN regime_pack p ON p.id = a.pack_id WHERE a.user_id = $1 AND p.regime = $2 AND a.created_at >= ${LIVE} ORDER BY a.created_at`,
      [userId, pack.regime],
    )).rows
    // once per person for this operator, whichever pack is active (R-ELG-06)
    const co = (await c.query<{ started_at: Date; ends_at: Date; decision: 'continue' | 'leave' | null }>(`SELECT started_at, ends_at, decision FROM cooling_off WHERE user_id = $1 AND created_at >= ${LIVE}`, [userId])).rows[0]
    const w = (await c.query<{ kind: string; decision: 'continue' | 'leave'; legal_text_sha256: string }>(
      `SELECT w.kind, w.decision, w.legal_text_sha256 FROM warning_ack w JOIN regime_pack p ON p.id = w.pack_id WHERE w.user_id = $1 AND p.regime = $2 AND w.created_at >= ${LIVE} ORDER BY w.shown_at, w.created_at`,
      [userId, pack.regime],
    )).rows
    const pw = w.filter((x) => x.kind === 'personalised_warning')
    const blockText = warningBlockText(pack, st?.category)
    return {
      statement: st ? { qualifies: st.qualifies, expiresAt: new Date(st.expires_at), category: st.category, reopened: st.reopened } : null,
      needsReconfirm: !!st?.stale,
      attempts: attempts.map((a): AttemptFact => ({ questions: a.questions_used, passed: a.passed, lockedUntil: a.locked_until ? new Date(a.locked_until) : null })),
      coolingOff: co && coolingOffCounts({ startedAt: new Date(co.started_at), endsAt: new Date(co.ends_at) }, pack.cooling_off.hours) ? { startedAt: new Date(co.started_at), endsAt: new Date(co.ends_at), decision: co.decision } : null,
      fullName: await fullNameCaptured(c, userId),
      personalisedWarning: pw.at(-1)?.decision ?? null,
      // the words the person saw: another category or new wording asks again (§5.5)
      warningBlockAcked: !!blockText && w.some((x) => x.kind === 'warning_block' && x.decision === 'continue' && x.legal_text_sha256 === sha(blockText.body)),
    }
  }

  /**
   * The pack a person qualifies under: the instance's current one, or for a demo account its run's demo pack (R-DEMO-07,
   * owner 2026-11-24). A demo account only ever takes part in demo deals, which are bound to that pack, so the warning it
   * confirms here is the one those deals ask for.
   */
  async function eligibilityPack(c: Pick<Tx, 'query'>, userId: string) {
    const demo = (
      await c.query<{ pack_id: string }>(
        'SELECT r.pack_id FROM user_account u JOIN demo_run r ON r.id = u.demo_run JOIN regime_pack p ON p.id = r.pack_id WHERE u.id = $1 AND p.demo_only',
        [userId],
      )
    ).rows[0]
    return demo ? { id: demo.pack_id, pack: (await packContent(c, demo.pack_id))! } : activePack(c)
  }

  /** Run one step inside the person's lock, refused unless it is the step their pack has them on. */
  async function onStep<T>(who: { id: string; sessionHmac: string }, kinds: readonly StepKind[], fn: (c: Tx, pack: RegimePack, packId: string, f: EligibilityFacts) => Promise<T>): Promise<T> {
    return tx(d.db, async (c) => {
      await liveShare(c, who)
      const { id, pack } = await eligibilityPack(c, who.id)
      const f = await facts(c, who.id, pack)
      if (!kinds.some((k) => stepOpen(pack, k, f, now()))) throw new Refused('This step is not open yet.')
      return fn(c, pack, id, f)
    })
  }

  /** Exactly what the person's current step shows, so what they sign can be tied to it. */
  function shownTexts(pack: RegimePack, f: EligibilityFacts, t: Date): Record<string, string> {
    const next = nextEligibilityStep(pack, f, t)
    if (statementClosed(f, t)) return {}
    const shown = (keys: string[]) => Object.fromEntries(keys.flatMap((k) => pack.legal_texts.filter((x) => x.text_key === k).map((x) => [`${x.text_key}/${x.variant}`, x.body])))
    const signing = ['statement_high_net_worth', 'statement_sophisticated', 'unsupported_categories', ...(pack.regime === 'uk-fpo' ? ['company_route_note'] : []), ...statementQuestionKeys(pack)]
    if (next === 'statement' || next === 'classification') return shown(signing)
    if (next === 'personalised_warning') return { 'personalised_warning/default': personalisedText(pack, f.fullName), ...shown(['risk_summary']) }
    if (next === 'warning_block') {
      const block = warningBlockText(pack, f.statement?.category)!
      return { [`promotion_warning/${block.variant}`]: block.body }
    }
    return {}
  }
  const shownHash = (texts: Record<string, string>) => sha(JSON.stringify(texts))
  const STALE = 'The wording has changed. Read it again.'

  app.get('/api/eligibility', verified, async (req) => {
    const { pack } = await eligibilityPack(d.db, req.user!.id)
    const f = await facts(d.db, req.user!.id, pack)
    const t = now()
    const next = nextEligibilityStep(pack, f, t)
    const ended = statementClosed(f, t)
    const steps = pack.steps.slice(0, pack.steps.findIndex((s) => s.kind === 'view_deal')).map((s) => ({ kind: s.kind, done: stepDone(s.kind, f, t) }))
    const prep = (type: 'individual' | 'company') => {
      const x = preparation(pack, type)
      return {
        steps: x.steps, minutes: x.minutes, reviewDays: x.reviewDays, coolingOffHours: x.coolingOffHours,
        text: textOf(pack, x.textKey)!.body,
        overview: fillText(textOf(pack, x.overviewKey)!.body, { steps: String(x.steps), review_days: String(x.reviewDays) }),
        cooling_note: x.coolingOffHours === null ? null : fillText(textOf(pack, 'cooling_off_note')?.body ?? '', { cooling_off_hours: String(x.coolingOffHours) }),
      }
    }
    const texts = shownTexts(pack, f, t)
    const lock = lockedUntil(f.attempts, t)
    return {
      // the format of each text, so required bold survives on the screen (R-OP-04.1 h)
      text_formats: Object.fromEntries(Object.keys(texts).map((k) => { const [key, variant] = k.split('/'); return [k, textOf(pack, key!, variant)?.format ?? 'plain'] })),
      // someone who chose to leave is not put back in front of the same choice (R-ELG-06)
      left: (next === 'personalised_warning' && f.personalisedWarning === 'leave') || (next === 'cooling_off_decision' && f.coolingOff?.decision === 'leave'),
      shown_sha256: shownHash(texts),
      regime: pack.regime,
      qualified: isQualified(pack, f, t),
      next,
      steps,
      texts,
      rounding: { income: minorToPounds(thresholds(pack).incomeRounding), net_assets: minorToPounds(thresholds(pack).assetsRounding) },
      notices: { not_qualified: textOf(pack, 'not_qualified_notice')!.body, assessment_not_passed: textOf(pack, 'assessment_not_passed')!.body, assessment_unavailable: textOf(pack, 'assessment_unavailable')!.body },
      preparation: { individual: prep('individual'), company: prep('company') },
      // says only that the person cannot go on: no date and no hint of what would change it (R-ELG-04)
      ended,
      statement_expires_at: f.statement?.qualifies ? f.statement.expiresAt.toISOString() : null,
      party_guidance: fillText(textOf(pack, 'party_guidance')!.body, { ubo_percent: bpsToPercent(thresholds(pack).uboOverBps) }),
      // used up is for good, so no date is promised
      assessment_used_up: attemptsUsedUp(pack, f.attempts),
      assessment_locked_until: attemptsUsedUp(pack, f.attempts) ? null : lock?.toISOString() ?? null,
      cooling_off_ends_at: f.coolingOff?.endsAt.toISOString() ?? null,
      cooling_off_over: f.coolingOff ? coolingOffOver(f.coolingOff, t) : false,
    }
  })
  app.post('/api/eligibility/request', verified, async (req) => {
    await onStep(req.user!, ['request_access', 'cooling_off_start'], async (c, pack) => {
      const t = now()
      // a row here is from before the switch to the real mode, or a wait shorter than this pack asks: neither counts, so it starts again
      await c.query(
        'INSERT INTO cooling_off (user_id, started_at, ends_at) VALUES ($1, $2::timestamptz, $3::timestamptz) ON CONFLICT (user_id) DO UPDATE SET started_at = EXCLUDED.started_at, ends_at = EXCLUDED.ends_at, decision = NULL, decided_at = NULL, created_at = clock_timestamp()',
        [req.user!.id, t.toISOString(), new Date(t.getTime() + pack.cooling_off.hours * 3_600_000).toISOString()],
      )
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'eligibility.cooling_off_started', entity: req.user!.id })
    })
    return { ok: true }
  })
  app.post('/api/eligibility/warning', verified, async (req) => {
    const b = z.strictObject({ kind: z.enum(['personalised_warning', 'warning_block']), decision: z.enum(['continue', 'leave']), shown_sha256: z.string().max(64) }).parse(req.body)
    await onStep(req.user!, [b.kind], async (c, pack, packId, f) => {
      if (b.shown_sha256 !== shownHash(shownTexts(pack, f, now()))) throw new Refused(STALE)
      const name = await fullNameCaptured(c, req.user!.id)
      // the hash is of the words this person was shown
      const body = b.kind === 'personalised_warning' ? personalisedText(pack, name) : warningBlockText(pack, f.statement?.category)!.body
      await c.query('INSERT INTO warning_ack (id, user_id, pack_id, kind, full_name, legal_text_sha256, shown_at, decision) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)', [
        randomUUID(), req.user!.id, packId, b.kind, name, sha(body), now().toISOString(), b.decision,
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'eligibility.warning_answered', entity: req.user!.id, detail: { kind: b.kind, decision: b.decision } })
    })
    return { ok: true }
  })
  const StatementBody = z.strictObject({ answers: statementAnswers, signed_name: z.string().trim().min(1).max(200), shown_sha256: z.string().max(64) })
  app.post('/api/eligibility/statement', verified, async (req, reply) => {
    const b = StatementBody.parse(req.body)
    const result = await onStep(req.user!, ['statement', 'classification'], async (c, pack, packId, f) => {
      if (b.shown_sha256 !== shownHash(shownTexts(pack, f, now()))) throw new Refused(STALE)
      const name = await fullNameCaptured(c, req.user!.id)
      if (!sameHolder(b.signed_name, name ?? '')) return { stored: false as const, problems: ['Type your full name as it is on your account.'] }
      const judged = judgeStatement(pack, b.answers)
      // a format error is corrected and nothing is kept. Any other answer is what the person signed (R-ELG-04)
      if (judged.problems.length) return { stored: false as const, problems: judged.problems }
      const t = now()
      const signedOn = t.toISOString().slice(0, 10) // the server's date: the evidence must not be what the client says
      const legal = b.answers.category === 'neither' ? null : textOf(pack, b.answers.category === 'high_net_worth' ? 'statement_high_net_worth' : 'statement_sophisticated')!
      // what was asked is part of what was signed (R-ELG-02)
      const questions = sha(JSON.stringify(statementQuestionKeys(pack).map((k) => textOf(pack, k)!.body)))
      const payload = JSON.stringify({ answers: b.answers, signed_name: b.signed_name, signed_on: signedOn, legal: legal ? sha(legal.body) : null, questions })
      await c.query(
        'INSERT INTO eligibility_statement (id, user_id, regime, pack_id, category, qualifies, answers, legal_text_sha256, signed_name, signed_on, payload_sha256, ip, auth_method, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)',
        [randomUUID(), req.user!.id, pack.regime, packId, b.answers.category, judged.qualifies, JSON.stringify(b.answers), legal ? sha(legal.body) : null, b.signed_name, signedOn, sha(payload), req.ip, req.user!.authMethod, statementExpiry(t).toISOString()],
      )
      // the audit row outlives the person, so what they answered goes in the detail, which retention removes (§5.6)
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'eligibility.statement_signed', entity: req.user!.id, detail: { category: b.answers.category, qualifies: judged.qualifies } })
      // R-ELG-03: a renewal that does not qualify ends the commitments with no money in; those with money go to the operator.
      // Only deals bound to this statement's regime: a deal under another regime is judged by that regime's own record
      if (!judged.qualifies) {
        const unpaid = (await c.query<{ id: string; invitation_id: string; public_code: string; email: string; deal_id: string; lead_user: string }>(
          `SELECT p.id, p.invitation_id, dl.public_code, u.email, p.deal_id, dl.lead_user FROM participation p JOIN deal dl ON dl.id = p.deal_id JOIN user_account u ON u.id = p.user_id
            JOIN regime_pack rp ON rp.id = dl.pack_id
            WHERE p.user_id = $1 AND p.outcome = 'active' AND dl.state NOT IN ('settled', 'closed') AND rp.regime = $2
              AND NOT EXISTS (SELECT 1 FROM receipt r WHERE r.participation_id = p.id AND r.reversed_at IS NULL AND r.amount_minor > r.moved_out_minor) FOR UPDATE OF p`,
          [req.user!.id, pack.regime],
        )).rows
        for (const p of unpaid) {
          await c.query("UPDATE participation SET outcome = 'withdrawn', ended_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1", [p.id])
          const voided = await c.query("UPDATE issued_instruction SET voided_at = clock_timestamp(), void_reason = 'not_eligible' WHERE participation_id = $1 AND voided_at IS NULL", [p.id])
          await c.query("UPDATE deal_invitation SET state = 'revoked', ended_at = clock_timestamp() WHERE id = $1 AND state = 'active' AND NOT EXISTS (SELECT 1 FROM participation o WHERE o.invitation_id = $1 AND o.outcome = 'active')", [p.invitation_id])
          await c.query("INSERT INTO participation_event (id, participation_id, event, actor) VALUES ($1, $2, 'ended_not_eligible', $3)", [randomUUID(), p.id, req.user!.id])
          await appendAudit(c, d.k, { actor: req.user!.id, action: 'participation.ended_not_eligible', entity: p.id })
          if (voided.rowCount) await mail.urgent(c, 'void_commitment_ended', { userId: req.user!.id, to: p.email, dealId: p.deal_id })
          // as any other end of a part: an amount proposal ends, leads with a waiting list hear of room
          await endProposal(c, { k: d.k, mail, now }, p.id, 'part_ended', req.user!.id)
          await tellLeadsOfRoom(c, mail, { id: p.deal_id, lead_user: p.lead_user })
        }
        // §5.6: the parts ended here may have been the last thing going on
        if (unpaid.length) await refreshRelationship(c, req.user!.id, now())
      }
      return { stored: true as const, qualifies: judged.qualifies }
    })
    if (!result.stored) return reply.code(400).send({ error: 'the statement is not complete', errors: result.problems })
    await mail.flush()
    return { qualifies: result.qualifies }
  })
  /** R-ELG-05: the lock and the limit, checked on the way in and again on the way out. */
  const assessmentRefusal = (pack: RegimePack, f: EligibilityFacts) => {
    if (lockedUntil(f.attempts, now())) return 'The assessment is not available yet.'
    return attemptsUsedUp(pack, f.attempts) ? 'The assessment is not available.' : null
  }
  const questionsOf = (pack: RegimePack, asked: readonly string[]) => asked.map((q) => {
    const x = pack.assessment.questions.find((y) => y.id === q)!
    return { id: x.id, prompt: x.prompt, options: x.options } // no correct option leaves the server
  })
  app.post('/api/eligibility/assessment/start', verified, async (req) => {
    return onStep(req.user!, ['assessment'], async (c, pack, packId, f) => {
      const refusal = assessmentRefusal(pack, f)
      if (refusal) throw new Refused(refusal)
      // one open attempt: leaving and coming back gets the same questions, so opening more cannot show the rest of the bank
      const open = (await c.query<{ id: string; questions_used: string[]; pack_id: string }>(
        `SELECT a.id, a.questions_used, a.pack_id FROM assessment_attempt a JOIN regime_pack p ON p.id = a.pack_id WHERE a.user_id = $1 AND p.regime = $2 AND a.passed IS NULL AND a.created_at >= ${LIVE} ORDER BY a.created_at DESC LIMIT 1`,
        [req.user!.id, pack.regime],
      )).rows[0]
      // handed out as it was issued, also from a bank stored before the pack check (Codex group B r5 #1: refusing it left the
      // investor with no way on, even after the operator fixed the bank); a new set from such a bank is refused by pickQuestions
      if (open) return { id: open.id, questions: questionsOf((await packContent(c, open.pack_id))!, open.questions_used) }
      // R-ELG-05: the wording of the latest attempt's questions, from the version it was asked from (only here, not on every read)
      const lastAsked = (await c.query<{ prompts: string[] }>(
        `SELECT coalesce(jsonb_agg(q->>'prompt'), '[]'::jsonb) AS prompts
           FROM (SELECT a.questions_used, a.pack_id FROM assessment_attempt a JOIN regime_pack p ON p.id = a.pack_id
                  WHERE p.regime = $2 AND a.user_id = $1 AND a.created_at >= ${LIVE} ORDER BY a.created_at DESC LIMIT 1) l
           JOIN regime_pack r ON r.id = l.pack_id, jsonb_array_elements(r.content->'assessment'->'questions') q
          WHERE l.questions_used ? (q->>'id')`,
        [req.user!.id, pack.regime],
      )).rows[0]!.prompts
      const asked = pickQuestions(pack, lastAsked, (n) => randomBytes(4).readUInt32BE(0) % n)
      // R-ELG-05: the active version has too few questions not asked last time; the operator adds some, nothing is repeated
      if (!asked) throw new Refused('The assessment is not available yet.')
      const id = randomUUID()
      await c.query('INSERT INTO assessment_attempt (id, user_id, pack_id, questions_used) VALUES ($1, $2, $3, $4)', [id, req.user!.id, packId, JSON.stringify(asked)])
      return { id, questions: questionsOf(pack, asked) }
    })
  })
  app.post('/api/eligibility/assessment/answer', verified, async (req) => {
    const b = z.strictObject({ attempt_id: Uuid, answers: z.record(z.string(), z.number().int().min(0).max(20)) }).parse(req.body)
    const out = await onStep(req.user!, ['assessment'], async (c, pack, _packId, f) => {
      const a = (await c.query<{ questions_used: string[]; passed: boolean | null; pack_id: string; regime: string }>(
        `SELECT a.questions_used, a.passed, a.pack_id, p.regime FROM assessment_attempt a JOIN regime_pack p ON p.id = a.pack_id WHERE a.id = $1 AND a.user_id = $2 AND a.created_at >= ${LIVE} FOR UPDATE OF a`,
        [b.attempt_id, req.user!.id],
      )).rows[0]
      if (!a || a.passed !== null || a.regime !== pack.regime) throw new Refused('No such assessment open.')
      const refusal = assessmentRefusal(pack, f)
      if (refusal) throw new Refused(refusal)
      const t = now()
      // marked against the version it was asked from
      const passed = markAssessment((await packContent(c, a.pack_id))!, a.questions_used, b.answers)
      const failures = f.attempts.filter((x) => x.passed === false).length + (passed ? 0 : 1)
      const lock = passed ? null : lockAfterFailure(failures, t)
      await c.query('UPDATE assessment_attempt SET passed = $2, answered_at = $3::timestamptz, locked_until = $4::timestamptz WHERE id = $1', [b.attempt_id, passed, t.toISOString(), lock?.toISOString() ?? null])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'eligibility.assessment_answered', entity: req.user!.id, detail: { passed } })
      // COBS 4.12A.35G(5): the notice is neutral and does not urge another try; the result stands whether or not it goes
      // R-NTF-01: neutral, the fixed fields only; the page says the rest
      if (!passed) await mail.investor(c, { action: 'assessment_retake', audience: { kind: 'account', userId: req.user!.id }, to: req.user!.email })
      return { result: { passed, locked_until: lock?.toISOString() ?? null } }
    })
    await mail.flush()
    return out.result
  })
  app.post('/api/eligibility/cooling-off', verified, async (req) => {
    const { decision } = z.strictObject({ decision: z.enum(['continue', 'leave']) }).parse(req.body)
    await onStep(req.user!, ['cooling_off_decision'], async (c, _p, _id, f) => {
      if (!f.coolingOff || !coolingOffOver(f.coolingOff, now())) throw new Refused('The waiting period has not finished.')
      await c.query('UPDATE cooling_off SET decision = $2, decided_at = $3::timestamptz WHERE user_id = $1', [req.user!.id, decision, now().toISOString()])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'eligibility.cooling_off_answered', entity: req.user!.id, detail: { decision } })
    })
    return { ok: true }
  })
  // R-ELG-04, decision R12: people who signed as not qualifying, for a reviewer they have contacted. Nothing goes to the person from here.
  app.get('/api/review/eligibility/closed', reviewer, async () => {
    const { pack } = await activePack(d.db)
    const r = await d.db.query<{ user_id: string; name: string; email: string; signed_on: string; category: string }>(
      `SELECT s.user_id, u.name, u.email, s.signed_on::text AS signed_on, s.category
         FROM eligibility_statement s JOIN user_account u ON u.id = s.user_id
        WHERE s.regime = $1 AND s.qualifies = false AND s.expires_at > $2::timestamptz AND s.created_at >= ${LIVE}
          AND s.created_at = (SELECT max(x.created_at) FROM eligibility_statement x WHERE x.user_id = s.user_id AND x.regime = s.regime)
          AND NOT EXISTS (SELECT 1 FROM eligibility_reopen o WHERE o.user_id = s.user_id AND o.created_at > s.created_at)
        ORDER BY s.created_at LIMIT 200`,
      [pack.regime, now().toISOString()],
    )
    return { people: r.rows }
  })
  app.post<{ Params: { id: string } }>('/api/review/users/:id/reopen-eligibility', reviewer, async (req) => {
    const id = Uuid.parse(req.params.id)
    const { reason } = z.strictObject({ reason: z.string().trim().min(1).max(1000) }).parse(req.body)
    if (id === req.user!.id) throw new Refused('You cannot decide on your own statement.')
    await reviewerTx(x, req.user!, async (c, recheck) => {
      await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [id])
      await recheck() // the wait for that lock can be long
      const { pack } = await activePack(c)
      if (!statementClosed(await facts(c, id, pack), now())) throw new Refused('This person has no closed statement to reopen.')
      await c.query('INSERT INTO eligibility_reopen (id, user_id, reason, decided_by) VALUES ($1, $2, $3, $4)', [randomUUID(), id, reason, req.user!.id])
      // the reason can hold personal information, so it is not in the audit row; nor is the fact that this person did not qualify
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'eligibility.review_action', entity: id, detail: { action: 'reopened' } })
    })
    return { ok: true }
  })
  // TC-ELG-01: evidence exists for anyone who signed, even someone who never committed. No question answers.
  app.get<{ Params: { id: string } }>('/api/review/users/:id/evidence', reviewer, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    // R-DEMO-06: a retired demo account's records are gone from every page, an id typed by hand included
    if ((await d.db.query<{ gone: boolean }>('SELECT demo_retired_user($1) AS gone', [id])).rows[0]!.gone) return reply.code(404).send({ error: 'No such person.' })
    await tx(d.db, (c) => appendAudit(c, d.k, { actor: req.user!.id, action: 'evidence.exported', entity: id }))
    const q = (sql: string) => d.db.query(sql, [id]).then((r) => r.rows)
    return {
      limits: 'The system knows what it showed and what was clicked. It does not know whether anything was read.',
      statements: await q(`SELECT category, qualifies, answers, legal_text_sha256, signed_name, signed_on, payload_sha256, ip, auth_method, expires_at, pack_id FROM eligibility_statement WHERE user_id = $1 AND created_at >= ${LIVE} ORDER BY created_at`),
      reopened: await q(`SELECT reason, decided_by, created_at FROM eligibility_reopen WHERE user_id = $1 AND created_at >= ${LIVE} ORDER BY created_at`),
      warnings: await q(`SELECT kind, full_name, legal_text_sha256, shown_at, decision, pack_id FROM warning_ack WHERE user_id = $1 AND created_at >= ${LIVE} ORDER BY shown_at`),
      cooling_off: await q(`SELECT started_at, ends_at, decision, decided_at FROM cooling_off WHERE user_id = $1 AND created_at >= ${LIVE}`),
      assessments: await q(`SELECT passed, answered_at, locked_until, pack_id FROM assessment_attempt WHERE user_id = $1 AND created_at >= ${LIVE} ORDER BY created_at`),
      kyc: await q(`SELECT k.status, k.provider, k.decided_at, k.entity_version, k.biometric_consent_at, k.biometric_consent_text_sha256, k.information_confirmed_at FROM kyc_case k JOIN legal_entity e ON e.id = k.entity_id WHERE e.owner_user = $1 AND k.created_at >= ${LIVE} ORDER BY k.created_at`),
    }
  })

  return { mail, mailDeps, adapters, eligibilityFacts: facts }
}
