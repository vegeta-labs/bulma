// TC-AUTHZ-07: every route names a gate. `--with-bad-example` adds a route with none, to show this check really fails.
import { buildServer } from '../src/server/app.ts'
import { Keyring } from '../src/store/crypto.ts'
import { pool } from '../src/store/db.ts'

const bad = process.argv.includes('--with-bad-example')
const db = pool('postgres://nobody@127.0.0.1:1/none') // never connected: building the server runs no query
try {
  const app = await buildServer({
    db,
    k: new Keyring([{ id: 'k', key: Buffer.alloc(32) }], 'k', Buffer.alloc(32)),
    webRoot: 'dist/web',
    extraRoutes: bad ? (a) => a.get('/api/forgot-to-declare', async () => ({ leaked: true })) : undefined,
  })
  await app.ready()
  for (const r of app.routeTable) console.log(`${r.gate}\t${r.method}\t${r.url}`)
  console.log(`route check passed (${app.routeTable.length} routes)`)
  await app.close()
} catch (e) {
  console.log(`route check FAILED: ${(e as Error).message}`)
  process.exitCode = 1
}
await db.end()
