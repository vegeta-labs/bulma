// Forward-only migrations, run by the owner role at start-up. Creates the database roles and sets their passwords.
import { readdirSync, readFileSync } from 'node:fs'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import pg from 'pg'

const DIR = new URL('./migrations/', import.meta.url)
export const ROLES = ['bulma_app', 'bulma_maintenance'] as const
export type RolePasswords = Record<(typeof ROLES)[number], string>

/** SCRAM-SHA-256 verifier as Postgres stores it (RFC 5802 / 7677), so statement logs never hold the password. */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16)
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

const MIGRATE_LOCK = 7_401_105

async function setRoles(c: pg.Client, passwords: RolePasswords): Promise<void> {
  for (const role of ROLES) {
    const pw = scramVerifier(passwords[role])
    // roles are cluster-wide: two databases migrating at once can race on the same role row; try again
    for (let attempt = 1; ; attempt++) {
      try {
        const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
        await c.query(exists.rowCount ? `ALTER ROLE ${role} WITH LOGIN PASSWORD '${pw}'` : `CREATE ROLE ${role} WITH LOGIN PASSWORD '${pw}'`)
        break
      } catch (e) {
        const code = (e as { code?: string }).code
        if (attempt >= 10 || !(code === 'XX000' || code === '23505' || code === '42710')) throw e
        await new Promise((r) => setTimeout(r, 50 * attempt))
      }
    }
  }
}

/** `rolesOnly` prepares a fresh server for restoring a backup: a dump holds the grants but not the roles they name. */
export async function migrate(ownerUrl: string, passwords: RolePasswords, opts: { rolesOnly?: boolean } = {}): Promise<string[]> {
  const c = new pg.Client({ connectionString: ownerUrl })
  await c.connect()
  try {
    await c.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK])
    await setRoles(c, passwords)
    if (opts.rolesOnly) return []
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()); REVOKE ALL ON schema_migrations FROM PUBLIC')
    const done = new Map((await c.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations')).rows.map((r) => [r.name, r.sha256]))
    const applied: string[] = []
    for (const name of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(new URL(name, DIR), 'utf8')
      const sha = createHash('sha256').update(sql).digest('hex')
      if (done.has(name)) {
        if (done.get(name) !== sha) throw new Error(`migration ${name} was changed after it was applied`)
        continue
      }
      await c.query('BEGIN')
      try {
        await c.query(sql)
        await c.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [name, sha])
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK')
        throw new Error(`migration ${name} failed: ${(e as Error).message}`)
      }
      applied.push(name)
    }
    return applied
  } finally {
    await c.end() // ends the session and with it the advisory lock
  }
}
