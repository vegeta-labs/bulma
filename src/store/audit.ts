// Audit log (PRD R-AUD-01, R-CMP-04). Written inside the business transaction. The audit row holds ids and an HMAC only;
// anything personal goes to audit_detail, which can be deleted when its retention ends.
import { readFileSync } from 'node:fs'
import { auditHash, chainChecker, GENESIS, type AuditRecord } from '../lib/auditChain.ts'
import type { Keyring } from './crypto.ts'
import type { Db, Tx } from './db.ts'

const AUDIT_LOCK = 7_440_001

export const SOFTWARE_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

export interface AuditEntry {
  actor: string // user id or 'system'
  action: string
  entity?: string | null
  detail?: unknown // personal or free-text values; never placed in the audit row itself
}

export async function appendAudit(c: Tx, k: Keyring, e: AuditEntry): Promise<AuditRecord> {
  await c.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK])
  // a separate statement after the lock: READ COMMITTED gives it a fresh snapshot including the last commit
  const head = (await c.query<{ seq: string; hash: string }>('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1')).rows[0]
  const pack = (await c.query<{ v: string }>("SELECT p.key || '@' || p.version AS v FROM instance_profile i JOIN regime_pack p ON p.id = i.active_pack_id")).rows[0]
  const detailJson = e.detail === undefined ? null : JSON.stringify(e.detail)
  const at = new Date().toISOString()
  const rec = {
    seq: Number(head?.seq ?? 0) + 1,
    at,
    actor_id: e.actor,
    action: e.action,
    entity_id: e.entity ?? null,
    detail_hmac: detailJson === null ? null : k.hmac(`audit-detail\0${detailJson}`),
    software_version: SOFTWARE_VERSION,
    pack_version: pack?.v ?? null,
    prev_hash: head?.hash ?? GENESIS,
  }
  const hash = auditHash(rec)
  await c.query(
    'INSERT INTO audit (seq, at, actor_id, action, entity_id, detail_hmac, software_version, pack_version, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [rec.seq, rec.at, rec.actor_id, rec.action, rec.entity_id, rec.detail_hmac, rec.software_version, rec.pack_version, rec.prev_hash, hash],
  )
  if (detailJson !== null) await c.query('INSERT INTO audit_detail (audit_seq, detail) VALUES ($1, $2)', [rec.seq, detailJson])
  return { ...rec, hash }
}

type Row = Omit<AuditRecord, 'seq'> & { seq: string }
const COLUMNS = 'seq, at, actor_id, action, entity_id, detail_hmac, software_version, pack_version, prev_hash, hash'
const toRecord = ({ seq, ...r }: Row): AuditRecord => ({ ...r, seq: Number(seq) })

export async function* auditRecords(db: Pick<Db, 'query'>, batch = 5000): AsyncGenerator<AuditRecord> {
  let after = 0
  for (;;) {
    const rows = (await db.query<Row>(`SELECT ${COLUMNS} FROM audit WHERE seq > $1 ORDER BY seq LIMIT $2`, [after, batch])).rows
    for (const r of rows) yield toRecord(r)
    if (rows.length < batch) return
    after = Number(rows.at(-1)!.seq)
  }
}

export async function recentAudit(db: Pick<Db, 'query'>, limit: number): Promise<AuditRecord[]> {
  return (await db.query<Row>(`SELECT ${COLUMNS} FROM audit ORDER BY seq DESC LIMIT $1`, [limit])).rows.map(toRecord)
}

/**
 * Walks the chain in batches. Detail that still exists must match the HMAC in its audit row; detail deleted when its
 * retention ended is fine, because the row itself stays.
 */
export async function verifyAudit(db: Pick<Db, 'query'>, k: Keyring): Promise<{ ok: true; count: number } | { ok: false; badSeq: number }> {
  const check = chainChecker()
  let after = 0
  for (;;) {
    const rows = (await db.query<Row & { detail: string | null }>(`SELECT ${COLUMNS.split(', ').map((c) => `a.${c}`).join(', ')}, d.detail FROM audit a LEFT JOIN audit_detail d ON d.audit_seq = a.seq WHERE a.seq > $1 ORDER BY a.seq LIMIT 5000`, [after])).rows
    for (const { detail, ...row } of rows) {
      const r = toRecord(row)
      if (!check.next(r)) return { ok: false, badSeq: r.seq }
      if (detail !== null && k.hmac(`audit-detail\0${detail}`) !== r.detail_hmac) return { ok: false, badSeq: r.seq }
    }
    if (rows.length < 5000) return { ok: true, count: check.count() }
    after = Number(rows.at(-1)!.seq)
  }
}

/** The head an operator exports and keeps elsewhere: a rebuilt chain will not match it. */
export async function chainHead(db: Pick<Db, 'query'>): Promise<{ seq: number; hash: string } | null> {
  const r = (await db.query<{ seq: string; hash: string }>('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1')).rows[0]
  return r ? { seq: Number(r.seq), hash: r.hash } : null
}

/** Compare the database with an exported head: missing tail records, or a different record at that seq. */
export async function checkHead(db: Pick<Db, 'query'>, head: { seq: number; hash: string }): Promise<'ok' | 'truncated' | 'changed'> {
  const r = (await db.query<{ hash: string }>('SELECT hash FROM audit WHERE seq = $1', [head.seq])).rows[0]
  if (!r) return 'truncated'
  return r.hash === head.hash ? 'ok' : 'changed'
}
