// Commands (one image, tech design T12):
//   node src/main.ts init-secrets <dir>
//   node src/main.ts migrate [--roles-only]
//   node src/main.ts serve
//   node src/main.ts maintain [--once]
//   node src/main.ts audit verify | audit head | audit check-head <seq> <hash> | audit export (to standard output)
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { realAdaptersFromEnv } from './adapters/fromEnv.ts'
import { LocalStorage } from './adapters/index.ts'
import { runRetention } from './maintenance/retention.ts'
import { buildServer, parseTrustProxy } from './server/app.ts'
import { bootstrapAdmin } from './server/auth.ts'
import { auditRecords, chainHead, checkHead, verifyAudit } from './store/audit.ts'
import { Keyring } from './store/crypto.ts'
import { pool } from './store/db.ts'
import { migrate } from './store/migrate.ts'
import { recoverDemoRun } from './server/demo.ts'
import { demoOnStart } from './server/demoSeed.ts'
import { ensureInstance } from './store/packs.ts'

const secret = (name: string) => {
  const file = process.env[`${name}_FILE`]
  if (!file) throw new Error(`${name}_FILE is required`)
  return readFileSync(file, 'utf8').replace(/\r?\n$/, '')
}

const url = (user: string, password: string) =>
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${process.env.DATABASE_HOST ?? 'db'}:${process.env.DATABASE_PORT ?? '5432'}/${process.env.DATABASE_NAME ?? 'bulma'}`

const keyring = () => {
  process.env.BULMA_MASTER_KEYS = secret('BULMA_MASTER_KEYS')
  process.env.BULMA_HMAC_KEY = secret('BULMA_HMAC_KEY')
  return Keyring.fromEnv()
}

const appDb = () => pool(url('bulma_app', secret('BULMA_APP_DB_PASSWORD')))

export function initSecrets(dir: string): { created: string[]; kept: string[] } {
  const b64 = () => randomBytes(32).toString('base64')
  const values: Record<string, () => string> = {
    postgres_password: () => randomBytes(24).toString('hex'),
    app_db_password: () => randomBytes(24).toString('hex'),
    maintenance_db_password: () => randomBytes(24).toString('hex'),
    master_keys: () => `k1:${b64()}`,
    hmac_key: b64,
    initial_admin_password: () => randomBytes(18).toString('base64url'),
  }
  const out = { created: [] as string[], kept: [] as string[] }
  for (const [name, make] of Object.entries(values)) {
    const p = join(dir, name)
    if (existsSync(p)) {
      out.kept.push(name)
      continue
    }
    writeFileSync(p, `${make()}\n`, { mode: 0o600, flag: 'wx' })
    out.created.push(name)
  }
  return out
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'init-secrets': {
      if (!rest[0]) throw new Error('usage: init-secrets <directory>')
      const r = initSecrets(rest[0])
      console.log(`created: ${r.created.join(', ') || 'none'}; kept: ${r.kept.join(', ') || 'none'}`)
      return
    }
    case 'migrate': {
      const applied = await migrate(url('postgres', secret('POSTGRES_PASSWORD')), {
        bulma_app: secret('BULMA_APP_DB_PASSWORD'),
        bulma_maintenance: secret('BULMA_MAINTENANCE_DB_PASSWORD'),
      }, { rolesOnly: rest.includes('--roles-only') })
      console.log(`migrations applied: ${applied.join(', ') || 'none'}`)
      return
    }
    case 'serve': {
      const db = appDb()
      const k = keyring()
      await ensureInstance(db, k)
      const first = process.env.INITIAL_ADMIN_PASSWORD_FILE && existsSync(process.env.INITIAL_ADMIN_PASSWORD_FILE) ? secret('INITIAL_ADMIN_PASSWORD') : undefined
      console.log(`initial admin: ${await bootstrapAdmin(db, k, process.env.INITIAL_ADMIN_EMAIL, first)}`)
      const trustProxy = parseTrustProxy(process.env.TRUST_PROXY)
      if (process.env.INSECURE_COOKIES !== '1' && !trustProxy) console.warn('TRUST_PROXY is not set. Behind a proxy every visitor shares one address, so ten failed sign-ins lock out everyone. Set it to the address of your proxy.')
      const mode = (await db.query<{ mode: string }>('SELECT mode FROM instance_profile WHERE id = 1')).rows[0]!.mode
      if (mode === 'real' && !process.env.PUBLIC_URL) throw new Error('PUBLIC_URL is required in the real mode: links in mail are built from it')
      // R-DEMO-04: before any request, a demo run a crash left part-way is retired
      const retired = await recoverDemoRun(db, k)
      if (retired) console.log(`demo run ${retired} was interrupted and has been retired`)
      const app = await buildServer({
        db, k, logger: true,
        webRoot: process.env.WEB_ROOT ?? 'dist/web',
        paymentFile: process.env.PAYMENT_INSTRUCTIONS_FILE,
        secureCookies: process.env.INSECURE_COOKIES !== '1',
        trustProxy,
        real: realAdaptersFromEnv(),
        publicUrl: process.env.PUBLIC_URL,
        mailEveryMs: 30_000, // R23: due mail and retries
      })
      // R-DEMO-03: the same seed as the instance page's button, in-process before the first request; one log line either way
      const demo = await demoOnStart(app, db, k, { flag: process.env.BULMA_DEMO_DEAL, file: resolve(process.env.BULMA_DEMO_SIGN_INS_FILE ?? 'bulma-demo-sign-ins.txt') })
      if (demo) console.log(demo)
      await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) })
      return
    }
    case 'maintain': {
      const db = pool(url('bulma_maintenance', secret('BULMA_MAINTENANCE_DB_PASSWORD')), 2)
      const k = Keyring.hmacOnly(secret('BULMA_HMAC_KEY'))
      const storage = new LocalStorage(process.env.STORAGE_DIR ?? '/var/lib/bulma/files')
      const round = async () => {
        const r = await runRetention(db, k, storage)
        console.log(`retention: removed ${r.removed.length}, failed ${r.failed.length}`)
      }
      await round()
      if (rest.includes('--once')) return void (await db.end())
      setInterval(() => void round().catch((e: Error) => console.error(`retention failed: ${(e as { code?: string }).code ?? 'unknown'}`)), 24 * 3_600_000)
      return
    }
    case 'audit': {
      const db = appDb()
      if (rest[0] === 'verify') {
        const r = await verifyAudit(db, keyring())
        console.log(JSON.stringify(r))
        process.exitCode = r.ok ? 0 : 1
      } else if (rest[0] === 'head') {
        console.log(JSON.stringify(await chainHead(db)))
      } else if (rest[0] === 'check-head' && rest[1] && rest[2]) {
        const r = await checkHead(db, { seq: Number(rest[1]), hash: rest[2] })
        console.log(r)
        process.exitCode = r === 'ok' ? 0 : 1
      } else if (rest[0] === 'export') {
        for await (const r of auditRecords(db)) console.log(JSON.stringify(r))
      } else throw new Error('usage: audit verify | audit head | audit check-head <seq> <hash> | audit export')
      await db.end()
      return
    }
    default:
      throw new Error('commands: init-secrets, migrate, serve, maintain, audit')
  }
}

await main().catch((e: Error) => {
  console.error(e.message)
  process.exit(1)
})
