// Test helper: a fresh, migrated database per test file on the test Postgres, with a pool per role.
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { Keyring } from './crypto.ts'
import { pool, type Db } from './db.ts'
import { migrate, ROLES, type RolePasswords } from './migrate.ts'
import { ensureInstance } from './packs.ts'

export const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55433/postgres'
export const PASSWORDS = Object.fromEntries(ROLES.map((r) => [r, `test-${r}`])) as RolePasswords

export interface TestDb {
  name: string
  owner: Db
  app: Db
  maintenance: Db
  keyring: Keyring
  drop(): Promise<void>
}

export function roleUrl(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url)
  u.pathname = `/${db}`
  if (user) {
    u.username = user
    u.password = password ?? ''
  }
  return u.toString()
}

export const testKeyring = () => new Keyring([{ id: 'k1', key: randomBytes(32) }], 'k1', randomBytes(32))

export async function createTestDb(): Promise<TestDb> {
  const name = `bulma_test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: TEST_URL })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const ownerUrl = roleUrl(TEST_URL, name)
  await migrate(ownerUrl, PASSWORDS)
  const keyring = testKeyring()
  const t: TestDb = {
    name,
    owner: pool(ownerUrl, 4),
    app: pool(roleUrl(TEST_URL, name, 'bulma_app', PASSWORDS.bulma_app), 12),
    maintenance: pool(roleUrl(TEST_URL, name, 'bulma_maintenance', PASSWORDS.bulma_maintenance), 4),
    keyring,
    async drop() {
      await Promise.all([t.owner.end(), t.app.end(), t.maintenance.end()])
      const a = new pg.Client({ connectionString: TEST_URL })
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await a.end()
    },
  }
  await ensureInstance(t.app, keyring)
  return t
}
