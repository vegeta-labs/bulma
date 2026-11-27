// Regime pack storage (PRD R-OP-04; tech design T8). Rows only ever get added; a version already stored never changes.
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePack, textSha256, type RegimePack } from '../lib/regimePack.ts'
import { appendAudit } from './audit.ts'
import type { Keyring } from './crypto.ts'
import { tx, type Db, type Tx } from './db.ts'

export const BUILT_IN_PACKS = new URL('../../packs/', import.meta.url).pathname
export const DEFAULT_PACK = 'uk-fpo-template'
/** Keys kept for packs shipped with the software, now or later, so an operator's pack can never block a future start. */
export const isReservedPackKey = (key: string) => /^uk-.*-template$/.test(key)

const sha = (p: RegimePack) => createHash('sha256').update(JSON.stringify(p)).digest('hex')
/** The hash a stored pack's `content_sha256` holds. */
export const packSha256 = sha

export async function insertPack(c: Tx, p: RegimePack, o: { builtIn: boolean; by: string | null; demoOnly?: boolean }): Promise<string> {
  const id = randomUUID()
  await c.query('INSERT INTO regime_pack (id, key, version, regime, content, content_sha256, built_in, added_by, demo_only) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
    id, p.key, p.version, p.regime, JSON.stringify(p), sha(p), o.builtIn, o.by, o.demoOnly ?? false,
  ])
  for (const t of p.legal_texts) {
    await c.query('INSERT INTO legal_text (id, pack_id, text_key, variant, version, format, body, required_bold, sha256, is_placeholder) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
      randomUUID(), id, t.text_key, t.variant, t.version, t.format, t.body, JSON.stringify(t.required_bold), textSha256(t.body), t.is_placeholder,
    ])
  }
  for (const q of p.assessment.questions) {
    await c.query('INSERT INTO assessment_question (id, pack_id, question_key, content) VALUES ($1, $2, $3, $4)', [randomUUID(), id, q.id, JSON.stringify(q)])
  }
  return id
}

export function readBuiltInPacks(dir = BUILT_IN_PACKS): RegimePack[] {
  return readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()).sort().map((d) => {
    const r = parsePack(JSON.parse(readFileSync(join(dir, d, 'pack.json'), 'utf8')))
    if (!r.pack) throw new Error(`built-in pack ${d} does not load: ${r.errors.join('; ')}`)
    return r.pack
  })
}

/**
 * First start: store the built-in packs and create the instance row in the sandbox (R-OP-01). Later starts add new
 * versions and refuse a built-in version whose content changed. Never moves the active pack of an existing instance.
 */
export async function ensureInstance(db: Db, k: Keyring, dir = BUILT_IN_PACKS): Promise<void> {
  const packs = readBuiltInPacks(dir)
  await tx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7440002)')
    for (const p of packs) {
      const old = (await c.query<{ content_sha256: string }>('SELECT content_sha256 FROM regime_pack WHERE key = $1 AND version = $2', [p.key, p.version])).rows[0]
      if (old && old.content_sha256 !== sha(p)) throw new Error(`built-in pack ${p.key} version ${p.version} changed; a stored version cannot change, add a new version`)
      if (!old) {
        const id = await insertPack(c, p, { builtIn: true, by: null })
        await appendAudit(c, k, { actor: 'system', action: 'pack.added', entity: id })
      }
    }
    const exists = await c.query('SELECT 1 FROM instance_profile')
    if (exists.rowCount) return
    const first = (await c.query<{ id: string }>('SELECT id FROM regime_pack WHERE key = $1 ORDER BY version DESC LIMIT 1', [DEFAULT_PACK])).rows[0]
    if (!first) throw new Error(`the default pack ${DEFAULT_PACK} is missing`)
    await c.query('INSERT INTO instance_profile (id, active_pack_id) VALUES (1, $1)', [first.id])
    await appendAudit(c, k, { actor: 'system', action: 'instance.created', entity: 'instance' })
  })
}

export async function packContent(c: Pick<Tx, 'query'>, id: string): Promise<RegimePack | null> {
  const r = await c.query<{ content: RegimePack }>('SELECT content FROM regime_pack WHERE id = $1', [id])
  return r.rows[0]?.content ?? null
}
