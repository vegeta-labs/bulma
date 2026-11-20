// A real server on a fresh database for the browser tests; production build, production CSP.
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { buildServer } from '../src/server/app.ts'
import { bootstrapAdmin } from '../src/server/auth.ts'
import { Keyring } from '../src/store/crypto.ts'
import { pool } from '../src/store/db.ts'
import { migrate } from '../src/store/migrate.ts'
import { ensureInstance } from '../src/store/packs.ts'
import { PASSWORDS, roleUrl, TEST_URL } from '../src/store/testdb.ts'

const name = `bulma_e2e_${randomBytes(6).toString('hex')}`
const admin = new pg.Client({ connectionString: TEST_URL })
await admin.connect()
await admin.query(`CREATE DATABASE ${name}`)
await admin.end()
await migrate(roleUrl(TEST_URL, name), PASSWORDS)
const db = pool(roleUrl(TEST_URL, name, 'bulma_app', PASSWORDS.bulma_app))
const k = new Keyring([{ id: 'k', key: randomBytes(32) }], 'k', randomBytes(32))
await ensureInstance(db, k)
await bootstrapAdmin(db, k, 'first.admin@example.test', 'temporary-password-1')
writeFileSync('test-results-db.txt', name)
const app = await buildServer({ db, k, webRoot: 'dist/web', secureCookies: false })
await app.listen({ host: '127.0.0.1', port: Number(process.env.E2E_PORT ?? 4318) })
