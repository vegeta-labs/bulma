// Database access: one pool per database role. Transactions run at READ COMMITTED.
import pg from 'pg'

export type Db = pg.Pool
export type Tx = pg.PoolClient

// dates stay ISO strings; a Date would shift with the server time zone. bigint columns stay strings: money is read with
// BigInt(), never through a JavaScript number.
pg.types.setTypeParser(1082, (v) => v)

export function pool(url: string, max = 10): Db {
  const p = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 10_000 }) // a waiter gives up instead of hanging the server for ever
  // an idle connection the server ends must not crash the process; only the code is logged, the message can carry details
  p.on('error', (e: Error & { code?: string }) => console.error(`database connection lost (${e.code ?? 'no code'})`))
  return p
}

/** Run fn in a transaction; retry the whole transaction on a deadlock or serialization failure. */
export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    const c = await db.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const out = await fn(c)
      await c.query('COMMIT')
      return out
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      const code = (e as { code?: string }).code
      if (!(code === '40P01' || code === '40001') || i >= attempts) throw e
    } finally {
      c.release()
    }
  }
}
