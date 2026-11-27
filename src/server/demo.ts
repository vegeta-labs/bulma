// The demo deal seed's run and its interlock with the switch to the real mode (PRD R-DEMO-03, R-DEMO-04; decision R30;
// plan 05 §4.2). The seed plays many routes, each in its own transaction, so one look at the mode at the start is not
// enough: the run is marked on the instance row, with the row locked, and the switch refuses while the mark is set
// (`switchBlockers`). The process adding a run holds a session lock for its whole length, so a process starting up can
// tell a run still in hand from one left by a crash.
import { randomBytes, randomUUID } from 'node:crypto'
import { demoScenario } from '../demo/scenario.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { createUser, grantRole, voidTokens } from './auth.ts'
import { Refused } from './requests.ts'

/** Held by the process adding a demo run, for the run's whole length (session lock, released when its connection ends). */
export const DEMO_RUN_LOCK = 7440004

export type DemoVia = 'button' | 'env'

export interface DemoRun {
  readonly id: string
  /** The connection holding the run's session lock; ended with the run. */
  readonly hold: Tx
}

type Q = Pick<Tx, 'query'>

const lockRow = async (c: Q) =>
  (await c.query<{ mode: string; demo_adding: string | null }>('SELECT mode, demo_adding FROM instance_profile WHERE id = 1 FOR UPDATE')).rows[0]!

const liveRun = async (c: Q) =>
  (await c.query<{ id: string; state: 'adding' | 'added' }>("SELECT id, state FROM demo_run WHERE state IN ('adding', 'added')")).rows[0]

/** Drops the sandbox's in-memory copies of stored files, after the commit that removed their rows. */
export type DropFiles = (keys: readonly string[]) => Promise<void>

/**
 * R-DEMO-04, R-DEMO-06 (plan 05 §4.2, §4.5): what a run left behind is taken out of use, in the transaction that ends the
 * run or approves the switch to the real mode. The tokens it handed out are spent and its accounts retired while its rows
 * are still visible; then the run is marked retired, which hides every record it made from the app (migration 006
 * policies), and its files' rows and keys go, the stored bytes queued for the expiry job. The fictional rows and the audit
 * chain stay. Returns the storage keys, so the caller can drop the sandbox's in-memory copies once this commits.
 */
async function retireRun(c: Tx, k: Keyring, runId: string, failure: string | null): Promise<string[]> {
  const deals = '(SELECT id FROM deal WHERE demo_run = $1)'
  await c.query(`UPDATE investee_link SET revoked_at = now() WHERE revoked_at IS NULL AND investee_id IN (SELECT id FROM investee WHERE deal_id IN ${deals})`, [runId])
  await c.query(`UPDATE targeted_invite SET revoked_at = now() WHERE revoked_at IS NULL AND consumed_at IS NULL AND deal_id IN ${deals}`, [runId])
  // a link opened before the switch and not yet accepted: once its link is hidden it can never be decided (self-test review)
  await c.query(`DELETE FROM pending_invite WHERE invite_link IN (SELECT id FROM invite_link WHERE deal_id IN ${deals})`, [runId])
  await c.query('UPDATE member_invite SET revoked_at = now() WHERE revoked_at IS NULL AND syndicate_id IN (SELECT id FROM syndicate WHERE demo_run = $1)', [runId])
  await c.query(
    'UPDATE entity_party SET verify_token_hmac = NULL WHERE verify_token_hmac IS NOT NULL AND entity_id IN (SELECT e.id FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.demo_run = $1)',
    [runId],
  )
  const ids = (await c.query<{ id: string }>('SELECT id FROM user_account WHERE demo_run = $1 ORDER BY created_at, id', [runId])).rows
  for (const { id } of ids) await retireDemoAccount(c, k, id)
  await c.query("UPDATE demo_run SET state = 'retired', finished_at = clock_timestamp(), failure = $2 WHERE id = $1", [runId, failure])
  const keys = (await c.query<{ key: string }>('SELECT demo_remove_files($1) AS key', [runId])).rows.map((r) => r.key)
  await appendAudit(c, k, { actor: 'system', action: 'demo.data_cleared', entity: runId, detail: { files: keys.length } })
  return keys
}

/**
 * R-DEMO-06: approving the switch to the real mode retires the demo deal, in the same transaction. A run still being added
 * has already refused the switch (`demo_adding`), so only an added one is left. Returns its files' storage keys.
 */
export async function retireDemoAtSwitch(c: Tx, k: Keyring): Promise<string[]> {
  const live = await liveRun(c)
  if (!live) return []
  if (live.state !== 'added') throw new Refused('A demo deal is being added. Try again when it has finished.')
  return retireRun(c, k, live.id, null)
}

/**
 * R-DEMO-06, R-DEMO-08: the account can never act again. Deleting the password alone is not enough: a live session goes on
 * working and the reset link does not ask for the old password, so the sessions end, the links are spent, the credential
 * version moves on, and the roles, two-step secret and recovery codes go.
 */
async function retireDemoAccount(c: Tx, k: Keyring, userId: string): Promise<void> {
  const r = await c.query(
    `UPDATE user_account SET disabled_at = coalesce(disabled_at, now()), password_hash = NULL, credential_version = credential_version + 1,
       mfa_secret = NULL, mfa_key_id = NULL, mfa_wrapped_key = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL
     WHERE id = $1 AND demo_run IS NOT NULL`,
    [userId],
  )
  if (!r.rowCount) throw new Error('not a demo account')
  await c.query('DELETE FROM app_session WHERE user_id = $1', [userId])
  await voidTokens(c, userId)
  await c.query('DELETE FROM role_grant WHERE user_id = $1', [userId])
  await c.query('UPDATE mfa_recovery_code SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId])
  await appendAudit(c, k, { actor: 'system', action: 'demo.account_retired', entity: userId })
}

/** R-DEMO-04: starts a run, or says why not. The caller must end it with `endDemoRun`, whatever happens. */
export async function beginDemoRun(db: Db, k: Keyring, o: { by: string | null; via: DemoVia }): Promise<DemoRun> {
  const hold = await db.connect()
  try {
    // a second run started at the same time waits for nothing: it is refused at once
    const got = (await hold.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [DEMO_RUN_LOCK])).rows[0]!.ok
    if (!got) throw new Refused('A demo deal is being added.')
    const id = await tx(db, async (c) => {
      const row = await lockRow(c)
      if (row.mode !== 'sandbox') throw new Refused('A demo deal can be added in the sandbox only.')
      const live = await liveRun(c)
      if (live) throw new Refused(live.state === 'added' ? 'The demo deal has already been added.' : 'A demo deal is being added.')
      const runId = randomUUID()
      await c.query('INSERT INTO demo_run (id, started_by, via) VALUES ($1, $2, $3)', [runId, o.by, o.via])
      await c.query('UPDATE instance_profile SET demo_adding = $1 WHERE id = 1', [runId])
      await appendAudit(c, k, { actor: o.by ?? 'system', action: `demo.started.${o.via}`, entity: runId })
      return runId
    })
    return { id, hold }
  } catch (e) {
    await unlock(hold)
    throw e
  }
}

const unlock = async (hold: Tx) => {
  // ending the connection ends the session lock even if the unlock itself fails
  await hold.query('SELECT pg_advisory_unlock($1)', [DEMO_RUN_LOCK]).catch(() => {})
  hold.release(true)
}

/** Checked before every step of a run, in the step's own transaction: the run is still the one being added, in the sandbox. */
export async function demoStepAllowed(c: Q, runId: string): Promise<void> {
  const row = (await c.query<{ mode: string; demo_adding: string | null }>('SELECT mode, demo_adding FROM instance_profile WHERE id = 1')).rows[0]!
  if (row.mode !== 'sandbox' || row.demo_adding !== runId) throw new Refused('This demo run is no longer being added.')
}

/** Ends a run: added on success; otherwise everything it made is retired. Either way the mark is cleared in the same commit. */
export async function endDemoRun(db: Db, k: Keyring, run: DemoRun, outcome: { ok: true } | { ok: false; failure: string }): Promise<string[]> {
  try {
    return await tx(db, async (c) => {
      let keys: string[] = []
      const row = await lockRow(c)
      if (row.demo_adding !== run.id) throw new Refused('This demo run is no longer being added.')
      if (outcome.ok) await c.query("UPDATE demo_run SET state = 'added', finished_at = clock_timestamp() WHERE id = $1", [run.id])
      else keys = await retireRun(c, k, run.id, outcome.failure.slice(0, 500))
      // the reviewer was made for this run alone (R-DEMO-08); after a failure retireRun has already retired it
      if (outcome.ok) {
        const reviewer = (await c.query<{ reviewer: string | null }>('SELECT reviewer FROM demo_run WHERE id = $1', [run.id])).rows[0]!.reviewer
        if (reviewer) await retireDemoAccount(c, k, reviewer)
      }
      await c.query('UPDATE instance_profile SET demo_adding = NULL WHERE id = 1')
      await appendAudit(c, k, { actor: 'system', action: outcome.ok ? 'demo.added' : 'demo.failed', entity: run.id })
      return keys
    })
  } finally {
    await unlock(run.hold)
  }
}

/**
 * Before the server takes requests: a mark left by a run no process holds (a crash part-way) is retired and cleared.
 * A run another process still holds is left alone. Returns the run retired, if any. Also called before a run starts and
 * before the switch is asked or a request approved, so a run whose own clean-up failed (the database away throughout)
 * is retired as soon as the database is back, not at the next restart (Codex r2 #3).
 */
export async function recoverDemoRun(db: Db, k: Keyring, drop?: DropFiles): Promise<string | null> {
  if (!(await db.query<{ demo_adding: string | null }>('SELECT demo_adding FROM instance_profile WHERE id = 1')).rows[0]?.demo_adding) return null
  const hold = await db.connect()
  try {
    const got = (await hold.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [DEMO_RUN_LOCK])).rows[0]!.ok
    if (!got) return null
    const done = await tx(db, async (c) => {
      const row = await lockRow(c)
      const left = row.demo_adding
      if (!left) return null
      const keys = await retireRun(c, k, left, 'interrupted')
      await c.query('UPDATE instance_profile SET demo_adding = NULL WHERE id = 1')
      await appendAudit(c, k, { actor: 'system', action: 'demo.interrupted', entity: left })
      return { left, keys }
    })
    // at start-up the in-memory sandbox store is empty; inside a running server it may still hold the run's copies (Codex r1 #8)
    if (done) await drop?.(done.keys).catch(() => {})
    return done?.left ?? null
  } finally {
    await unlock(hold)
  }
}

/** One step of the seed: a call through the real routes. */
export type DemoStep = (runId: string) => Promise<void>

/** Plays the steps in order as one run; the first failure retires the run and is thrown on. */
export async function runDemo(db: Db, k: Keyring, o: { by: string | null; via: DemoVia; drop?: DropFiles }, steps: readonly DemoStep[]): Promise<string> {
  const run = await beginDemoRun(db, k, o)
  try {
    for (const step of steps) {
      await tx(db, (c) => demoStepAllowed(c, run.id))
      await step(run.id)
    }
  } catch (e) {
    try {
      const keys = await endDemoRun(db, k, run, { ok: false, failure: e instanceof Error ? e.message : 'failed' })
      await o.drop?.(keys).catch(() => {}) // the rows and keys are gone already: a copy left behind can never be read
    } catch {
      // the retiring commit failed too: its lock is released by now, so retire the run at once as a start-up would, rather
      // than leave the mark, the accounts and the deals live until the next restart (Codex r1 #4)
      await recoverDemoRun(db, k, o.drop).catch(() => null)
    }
    throw e
  }
  try {
    await endDemoRun(db, k, run, { ok: true })
  } catch (e) {
    // the run's lock is released by now: retire it at once, as a start-up would, rather than leave the mark blocking the
    // button and the switch until the next restart (self-test review 2026-11-24)
    await recoverDemoRun(db, k, o.drop).catch(() => null)
    throw e
  }
  return run.id
}

export interface DemoAccount {
  readonly id: string
  readonly name: string
  readonly email: string
  /** Random, held in memory: shown once to the admin who started the run, never stored in clear or logged (R-DEMO-08). */
  readonly password: string
}

export interface DemoAccounts {
  readonly lead: DemoAccount
  readonly investors: readonly DemoAccount[]
  /** The two-step secret lives only in this process for the run; the account is retired when the run ends. */
  readonly reviewer: DemoAccount & { readonly mfaSecret: Buffer }
}

/** R-DEMO-05: the demo run an account belongs to, or null for an ordinary account. */
export const demoRunOfUser = async (c: Q, userId: string): Promise<string | null> =>
  (await c.query<{ demo_run: string | null }>('SELECT demo_run FROM user_account WHERE id = $1', [userId])).rows[0]?.demo_run ?? null

/** An address of the run's own, so a later run never meets an address an earlier one used. Never delivered: sandbox only. */
export const demoEmail = (runId: string, mailbox: string) => `${mailbox}@run-${runId.slice(0, 8)}.demo.invalid`

const demoPassword = () => randomBytes(15).toString('base64url')

/**
 * R-DEMO-08: the run's accounts, in one step. The lead and the investors are not staff: no role, no two-step sign-in. The
 * reviewer gets the reviewer role and a two-step secret made for this run. Every account carries the run, starts with a
 * proven address (made by the operator, R-ACC-01) and a password the admin is shown once, so no change is asked at sign-in.
 */
export async function addDemoAccounts(db: Db, k: Keyring, runId: string, by: string | null): Promise<DemoAccounts> {
  return tx(db, async (c) => {
    await demoStepAllowed(c, runId)
    const make = async (person: { name: string; mailbox: string }): Promise<DemoAccount> => {
      const password = demoPassword()
      const email = demoEmail(runId, person.mailbox)
      const id = await createUser(c, k, { email, name: person.name, password, by, demoRun: runId })
      return { id, name: person.name, email, password }
    }
    const lead = await make(demoScenario.lead)
    const investors: DemoAccount[] = []
    for (const p of demoScenario.investors) investors.push(await make(p))
    const reviewer = await make(demoScenario.reviewer)
    const mfaSecret = randomBytes(20)
    const e = k.encrypt(mfaSecret)
    await c.query('UPDATE user_account SET mfa_secret = $2, mfa_key_id = $3, mfa_wrapped_key = $4, mfa_enabled_at = now() WHERE id = $1', [
      reviewer.id,
      e.ciphertext,
      e.keyId,
      e.wrappedDek,
    ])
    await grantRole(c, k, reviewer.id, 'reviewer', by)
    await c.query('UPDATE demo_run SET reviewer = $2 WHERE id = $1', [runId, reviewer.id])
    await appendAudit(c, k, { actor: by ?? 'system', action: 'demo.accounts_added', entity: runId, detail: { accounts: 2 + investors.length } })
    return { lead, investors, reviewer: { ...reviewer, mfaSecret } }
  })
}
