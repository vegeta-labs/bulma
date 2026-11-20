// Audit hash chain (PRD R-AUD-01, tech design `audit`). Finds tampering; does not prevent it, since the operator controls
// the database and could rebuild the chain. Exporting the head elsewhere is what makes a rebuild visible.
import { createHash } from 'node:crypto'

export const GENESIS = '0'.repeat(64)

export interface AuditRecord {
  seq: number
  at: string // ISO 8601 UTC
  actor_id: string // user id or 'system'
  action: string
  entity_id: string | null
  detail_hmac: string | null
  software_version: string
  pack_version: string | null
  prev_hash: string
  hash: string
}

const FIELDS = ['seq', 'at', 'actor_id', 'action', 'entity_id', 'detail_hmac', 'software_version', 'pack_version', 'prev_hash'] as const

/** SHA-256 of the fields as a JSON array in a fixed order, so no field boundary can be moved. */
export function auditHash(r: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(FIELDS.map((f) => r[f]))).digest('hex')
}

/** Recompute every record; report the first seq that does not match or breaks the sequence. */
export function verifyChain(records: Iterable<AuditRecord>): { ok: true; count: number } | { ok: false; badSeq: number } {
  const check = chainChecker()
  for (const r of records) if (!check.next(r)) return { ok: false, badSeq: r.seq }
  return { ok: true, count: check.count() }
}

/** One record at a time, so a long log never has to fit in memory. */
export function chainChecker() {
  let prev = GENESIS
  let expected = 1
  return {
    next(r: AuditRecord): boolean {
      if (r.seq !== expected || r.prev_hash !== prev || auditHash(r) !== r.hash) return false
      prev = r.hash
      expected++
      return true
    },
    count: () => expected - 1,
  }
}
