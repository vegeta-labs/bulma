// Accounts, roles and sessions for D0 (tech design §6, as Trunks). Passwords: argon2id. Session tokens live only in the
// cookie; the database keeps their HMAC. Self-registration, email verification, reset and two-step sign-in arrive in D1.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import type { Actor } from '../lib/gate.ts'
import { base32, matchStep, otpauthUri } from '../lib/totp.ts'
import type { InstanceRole, Staff } from '../lib/instance.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'

export const SESSION = 'bulma_session'
export const MIN_PASSWORD = 12
const MAX_PASSWORD = 1024
export const SESSION_HOURS = 12
const THROTTLE_MAX = 10
const THROTTLE_WINDOW_MINUTES = 15

type Q = Pick<Tx, 'query'>

export const passwordProblem = (p: string) =>
  p.length < MIN_PASSWORD ? `The password must have at least ${MIN_PASSWORD} characters.` : p.length > MAX_PASSWORD ? 'The password is too long.' : null

export async function createUser(c: Tx, k: Keyring, o: { email: string; name: string; password?: string; passwordHash?: string; by: string | null; selfRegistered?: boolean; firstName?: string; lastName?: string; demoRun?: string }): Promise<string> {
  const problem = o.passwordHash ? null : passwordProblem(o.password ?? '')
  if (problem) throw new Error(problem)
  const id = randomUUID()
  // an account an admin creates has a temporary password and an address the admin vouches for; a registration proves its own.
  // A demo account carries its run from the start, and its password is the one the admin is shown once (R-DEMO-08).
  await c.query('INSERT INTO user_account (id, email, name, password_hash, must_change_password, email_verified_at, first_name, last_name, demo_run) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
    id, o.email.trim(), o.name.trim(), o.passwordHash ?? (await argon2.hash(o.password!, { type: argon2.argon2id })), !o.selfRegistered && !o.demoRun, o.selfRegistered ? null : new Date().toISOString(), o.firstName ?? null, o.lastName ?? null, o.demoRun ?? null,
  ])
  await appendAudit(c, k, { actor: o.by ?? 'system', action: 'user.created', entity: id, detail: { email: o.email.trim(), name: o.name.trim() } })
  return id
}

export async function grantRole(c: Tx, k: Keyring, userId: string, role: InstanceRole, by: string | null): Promise<void> {
  const r = await c.query('INSERT INTO role_grant (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, role, by])
  if (r.rowCount) await appendAudit(c, k, { actor: by ?? 'system', action: `role.granted.${role}`, entity: userId })
}

/** Everyone who can act: disabled accounts count for nothing, and a demo account never counts (R-DEMO-08). */
export async function currentStaff(c: Q): Promise<Staff[]> {
  const r = await c.query<{ user_id: string; roles: InstanceRole[] }>(
    'SELECT g.user_id, array_agg(g.role) AS roles FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND u.demo_run IS NULL GROUP BY g.user_id',
  )
  return r.rows.map((x) => ({ userId: x.user_id, roles: x.roles }))
}

// the address first: once it is over its limit, nothing more is stored, so changing the email cannot grow the table
const throttleKeys = (k: Keyring, email: string, ip: string) => [k.hmac(`login-ip\0${ip}`), k.hmac(`login-email\0${email.trim().toLowerCase()}`)]

/**
 * Counts the attempt before any password work, in one statement, so parallel guesses cannot all pass a check made before
 * the first failure is recorded. Refused attempts cost no password work either.
 */
export async function reserveAttempt(db: Db, keys: string[], max = THROTTLE_MAX): Promise<boolean> {
  await db.query("DELETE FROM login_throttle WHERE window_started_at < now() - $1 * interval '1 minute'", [THROTTLE_WINDOW_MINUTES])
  for (const key of keys) {
    const r = await db.query<{ failures: number }>(
      `INSERT INTO login_throttle (key_hmac, failures, window_started_at) VALUES ($1, 1, now())
       ON CONFLICT (key_hmac) DO UPDATE SET
         failures = CASE WHEN login_throttle.window_started_at < now() - $2 * interval '1 minute' THEN 1 ELSE login_throttle.failures + 1 END,
         window_started_at = CASE WHEN login_throttle.window_started_at < now() - $2 * interval '1 minute' THEN now() ELSE login_throttle.window_started_at END
       RETURNING failures`,
      [key, THROTTLE_WINDOW_MINUTES],
    )
    if (r.rows[0]!.failures > max) return false
  }
  return true
}

export type AuthMethod = 'password' | 'password+totp' | 'password+recovery_code'
export type LoginResult = { kind: 'ok'; id: string; credentialVersion: number; authMethod: AuthMethod } | { kind: 'mfa_required' } | { kind: 'failed' } | { kind: 'throttled' }

/** The caller gives the same answer for all three failures: unknown user, wrong password, too many attempts. */
export async function verifyLogin(db: Db, k: Keyring, email: string, password: string, ip: string, code?: string, nowMs = Date.now()): Promise<LoginResult> {
  const keys = throttleKeys(k, email, ip)
  if (!(await reserveAttempt(db, keys))) return { kind: 'throttled' }
  const u = password.length <= MAX_PASSWORD
    ? (await db.query<{ id: string; password_hash: string | null; disabled_at: string | null; credential_version: number }>('SELECT id, password_hash, disabled_at, credential_version FROM user_account WHERE lower(email) = lower($1)', [email.trim()])).rows[0]
    : undefined
  if (!u?.password_hash || u.disabled_at) {
    await argon2.hash('similar timing', { type: argon2.argon2id })
    return { kind: 'failed' }
  }
  if (!(await argon2.verify(u.password_hash, password))) return { kind: 'failed' }
  const second = await checkSecondFactor(db, k, u.id, code, nowMs)
  if (second === 'wrong') return { kind: 'failed' }
  await db.query('UPDATE login_throttle SET failures = greatest(failures - 1, 0) WHERE key_hmac = ANY($1)', [keys]) // a right password does not count
  if (second === 'needed') return { kind: 'mfa_required' }
  await db.query('UPDATE user_account SET last_login_at = now() WHERE id = $1', [u.id])
  return { kind: 'ok', id: u.id, credentialVersion: u.credential_version, authMethod: second === 'recovery' ? 'password+recovery_code' : second === 'ok' ? 'password+totp' : 'password' }
}

/**
 * For a transaction that waited for a lock: the session, account and credential version as they are now. The clock is the
 * statement's, because `now()` stays at the start of the transaction, before the wait.
 */
export async function sessionStillLive(c: Q, hmac: string, userId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM app_session s JOIN user_account u ON u.id = s.user_id
      WHERE s.id_hmac = $1 AND s.user_id = $2 AND s.expires_at > statement_timestamp() AND u.disabled_at IS NULL AND u.credential_version = s.credential_version`,
    [hmac, userId],
  )
  return (r.rowCount ?? 0) > 0
}

/** 'none' when two-step sign-in is off; a one-time code or an unused recovery code otherwise, each good once. */
export async function checkSecondFactor(db: Db, k: Keyring, userId: string, code: string | undefined, nowMs: number): Promise<'none' | 'needed' | 'ok' | 'recovery' | 'wrong'> {
  return tx(db, async (c) => {
    const u = (await c.query<MfaRow>('SELECT mfa_secret, mfa_key_id, mfa_wrapped_key, mfa_enabled_at, mfa_last_step FROM user_account WHERE id = $1 FOR UPDATE', [userId])).rows[0]!
    if (!u.mfa_enabled_at) return 'none'
    if (!code) return 'needed'
    const step = matchStep(openSecret(k, u), code, nowMs, u.mfa_last_step === null ? null : Number(u.mfa_last_step))
    if (step !== null) {
      await c.query('UPDATE user_account SET mfa_last_step = $2 WHERE id = $1', [userId, step])
      return 'ok'
    }
    const r = await c.query('UPDATE mfa_recovery_code SET used_at = now() WHERE code_hmac = $1 AND user_id = $2 AND used_at IS NULL', [k.hmac(`recovery\0${code.trim()}`), userId])
    if (!r.rowCount) return 'wrong'
    await appendAudit(c, k, { actor: userId, action: 'user.recovery_code_used', entity: userId })
    return 'recovery'
  })
}

interface MfaRow { mfa_secret: Buffer | null; mfa_key_id: string | null; mfa_wrapped_key: Buffer | null; mfa_enabled_at: string | null; mfa_last_step: string | null }
const openSecret = (k: Keyring, u: MfaRow) => k.decrypt(u.mfa_key_id!, u.mfa_wrapped_key!, u.mfa_secret!)

/** Starts setup: the secret is stored encrypted and does nothing until a code from it is confirmed. */
export async function startMfa(db: Db, k: Keyring, userId: string, account: string, sessionHmac: string): Promise<{ secret: string; uri: string } | null> {
  const secret = randomBytes(20)
  const e = k.encrypt(secret)
  const live = await tx(db, async (c) => {
    await c.query('SELECT 1 FROM user_account WHERE id = $1 FOR UPDATE', [userId])
    // the session may have ended while this waited for the password check and the row
    if (!(await sessionStillLive(c, sessionHmac, userId))) return false
    const r = await c.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4 WHERE id = $1 AND mfa_enabled_at IS NULL', [userId, e.ciphertext, e.keyId, e.wrappedDek])
    if (!r.rowCount) throw new Error('two-step sign-in is already on')
    return true
  })
  if (!live) return null
  const b32 = base32(secret)
  return { secret: b32, uri: otpauthUri(b32, account) }
}

/** Switches it on with a code that proves the app holds the secret; returns recovery codes, shown once. */
export async function confirmMfa(db: Db, k: Keyring, userId: string, code: string, nowMs: number, keepSessionHmac: string): Promise<string[] | null> {
  return tx(db, async (c) => {
    const u = (await c.query<MfaRow>('SELECT mfa_secret, mfa_key_id, mfa_wrapped_key, mfa_enabled_at, mfa_last_step FROM user_account WHERE id = $1 FOR UPDATE', [userId])).rows[0]!
    if (u.mfa_enabled_at || !u.mfa_secret) return null
    // the session may have ended while this waited for the row
    if (!(await sessionStillLive(c, keepSessionHmac, userId))) return null
    const step = matchStep(openSecret(k, u), code, nowMs, null)
    if (step === null) return null
    // a session that signed in with only the password must not go on acting with a second factor it never gave
    const { version } = (await c.query<{ version: number }>('UPDATE user_account SET mfa_enabled_at = now(), mfa_last_step = $2, credential_version = credential_version + 1 WHERE id = $1 RETURNING credential_version AS version', [userId, step])).rows[0]!
    await c.query('DELETE FROM app_session WHERE user_id = $1 AND id_hmac <> $2', [userId, keepSessionHmac])
    await c.query('UPDATE app_session SET credential_version = $2 WHERE id_hmac = $1', [keepSessionHmac, version])
    await voidTokens(c, userId) // a link asked for without the second factor must not work once it is on
    const codes = Array.from({ length: 10 }, () => randomBytes(8).toString('hex'))
    for (const r of codes) await c.query('INSERT INTO mfa_recovery_code (code_hmac, user_id) VALUES ($1, $2)', [k.hmac(`recovery\0${r}`), userId])
    await appendAudit(c, k, { actor: userId, action: 'user.mfa_enabled', entity: userId })
    return codes
  })
}

const sessionHmac = (k: Keyring, token: string) => k.hmac(`session\0${token}`)

/** The CSRF token comes from the session token with the deployment key, so every tab can fetch it again and it ends with the session. */
export const csrfFor = (k: Keyring, session: string) => k.hmac(`csrf-token\0${session}`)

export async function createSession(db: Q, k: Keyring, userId: string, credentialVersion: number, authMethod: AuthMethod = 'password'): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.query("INSERT INTO app_session (id_hmac, user_id, credential_version, expires_at, auth_method) VALUES ($1, $2, $3, now() + $4 * interval '1 hour', $5)", [sessionHmac(k, token), userId, credentialVersion, SESSION_HOURS, authMethod])
  return token
}

export interface SessionUser extends Actor {
  email: string
  name: string
  csrf: string
  sessionHmac: string
  authMethod: AuthMethod
}

export async function sessionUser(db: Db, k: Keyring, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  const sh = sessionHmac(k, token)
  const r = await db.query<{ id: string; email: string; name: string; must_change_password: boolean; email_verified_at: string | null; mfa_enabled_at: string | null; roles: InstanceRole[]; auth_method: AuthMethod }>(
    `SELECT u.id, u.email, u.name, u.must_change_password, u.email_verified_at, u.mfa_enabled_at, s.auth_method, coalesce((SELECT array_agg(g.role) FROM role_grant g WHERE g.user_id = u.id), '{}') AS roles
       FROM app_session s JOIN user_account u ON u.id = s.user_id
      WHERE s.id_hmac = $1 AND s.expires_at > now() AND u.disabled_at IS NULL AND u.credential_version = s.credential_version`,
    [sh],
  )
  const u = r.rows[0]
  return u ? { id: u.id, email: u.email, name: u.name, roles: u.roles, mustChangePassword: u.must_change_password, emailVerified: !!u.email_verified_at, mfaOn: !!u.mfa_enabled_at, csrf: csrfFor(k, token), sessionHmac: sh, authMethod: u.auth_method } : null
}

export function csrfOk(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const endSession = (db: Q, sh: string) => db.query('DELETE FROM app_session WHERE id_hmac = $1', [sh])

/** R-ACC-03, R-ACC-04: a link issued before a credential change must not outlive it. */
export const voidTokens = (c: Q, userId: string, kind?: string) =>
  c.query('UPDATE account_token SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL AND ($2::text IS NULL OR kind = $2)', [userId, kind ?? null])

/** A setup of two-step begun under the old credential must not finish under the new one. */
export const clearPendingMfa = (c: Q, userId: string) => c.query('UPDATE user_account SET mfa_secret = NULL, mfa_key_id = NULL, mfa_wrapped_key = NULL WHERE id = $1 AND mfa_enabled_at IS NULL', [userId])

/** Change one's own password; every other session of the user ends. */
export async function changeOwnPassword(db: Db, k: Keyring, userId: string, current: string, next: string, keepSessionHmac: string, ip: string): Promise<boolean> {
  if (passwordProblem(next) || next === current || current.length > MAX_PASSWORD) return false
  // a stolen session must not become an unlimited way to guess the password
  const keys = [k.hmac(`reauth-ip\0${ip}`), k.hmac(`reauth-user\0${userId}`)]
  if (!(await reserveAttempt(db, keys))) return false
  return tx(db, async (c) => {
    const u = (await c.query<{ password_hash: string | null; credential_version: number }>('SELECT password_hash, credential_version FROM user_account WHERE id = $1 FOR UPDATE', [userId])).rows[0]
    // the session may have ended while this waited for the row
    if (!(await sessionStillLive(c, keepSessionHmac, userId))) return false
    if (!u?.password_hash || !(await argon2.verify(u.password_hash, current))) return false
    await c.query('UPDATE login_throttle SET failures = greatest(failures - 1, 0) WHERE key_hmac = ANY($1)', [keys])
    const version = u.credential_version + 1
    await c.query('UPDATE user_account SET password_hash = $2, must_change_password = false, credential_version = $3 WHERE id = $1', [userId, await argon2.hash(next, { type: argon2.argon2id }), version])
    await c.query('DELETE FROM app_session WHERE user_id = $1 AND id_hmac <> $2', [userId, keepSessionHmac])
    await voidTokens(c, userId)
    await clearPendingMfa(c, userId)
    await c.query('UPDATE app_session SET credential_version = $2 WHERE id_hmac = $1', [keepSessionHmac, version])
    await appendAudit(c, k, { actor: userId, action: 'user.password_changed', entity: userId })
    return true
  })
}

/** R-OP-08: the first admin comes from a deployment secret and must change the password at the first sign-in. */
export async function bootstrapAdmin(db: Db, k: Keyring, email: string | undefined, password: string | undefined): Promise<'created' | 'exists'> {
  return tx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7440003)')
    const n = await c.query('SELECT 1 FROM user_account LIMIT 1')
    if (n.rowCount) return 'exists' as const
    if (!email || !password) throw new Error('INITIAL_ADMIN_EMAIL and the initial admin password file are required on first start')
    const id = await createUser(c, k, { email, name: 'Initial admin', password, by: null })
    await grantRole(c, k, id, 'admin', null)
    return 'created' as const
  })
}
