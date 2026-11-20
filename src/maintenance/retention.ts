// Expiry (PRD R-KYC-04, §5.6; tech design §3.1). Runs as the maintenance role, the only one allowed to remove this data.
// Rows first, under the person's lock, then the files. The audit keeps ids only.
import { addMonths, retentionDue, type RetentionFacts } from '../lib/entity.ts'
import { dealRecordsDue, emailComplaintDue, REMOVED, REMOVED_ADDRESS, transactionCutoff, withoutPeople } from '../lib/retention.ts'
import type { Draft } from '../lib/draft.ts'
import type { Storage } from '../adapters/index.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'

interface Row {
  id: string
  last_login_at: Date | null
  created_at: Date
  deletion_requested_at: Date | null
  relationship_ended_at: Date | null
  retention_hold: boolean
  has_role: boolean
  open_case: boolean
  taking_part: boolean
}

interface Periods { relationship_years: number; idle_months: number; transaction_years: number }

const PEOPLE = `SELECT u.id, u.last_login_at, u.created_at, u.deletion_requested_at, u.relationship_ended_at, u.retention_hold,
            EXISTS (SELECT 1 FROM role_grant g WHERE g.user_id = u.id) AS has_role,
            EXISTS (SELECT 1 FROM kyc_case c JOIN legal_entity e ON e.id = c.entity_id WHERE e.owner_user = u.id AND c.status IN ('in_progress', 'pending_review') AND c.created_at > $1::timestamptz) AS open_case,
            -- §5.6: a part still running, or an investment still held, keeps the relationship going whatever the dates say
            EXISTS (SELECT 1 FROM participation p WHERE p.user_id = u.id AND (p.outcome = 'active' OR (p.invested_minor > 0 AND p.holding_ended_at IS NULL))) AS taking_part
       FROM user_account u WHERE u.anonymised_at IS NULL`

const due = (u: Row, cfg: Periods, now: Date) => retentionDue({
  lastLogin: u.last_login_at, createdAt: u.created_at, deletionRequestedAt: u.deletion_requested_at, relationshipEndedAt: u.relationship_ended_at,
  retentionHold: u.retention_hold,
  hasOngoingRelationship: u.has_role || u.open_case || u.taking_part,
} satisfies RetentionFacts, { relationshipYears: cfg.relationship_years, idleMonths: cfg.idle_months }, now)

const periods = async (q: Pick<Db, 'query'>) =>
  (await q.query<Periods>('SELECT relationship_years, idle_months, transaction_years FROM retention_config')).rows[0]!
// an abandoned case must not hold a person's data for ever: it counts only while younger than the idle period
const cutoffFrom = (cfg: Periods, now: Date) => addMonths(now, -cfg.idle_months).toISOString()

export interface RetentionResult { removed: string[]; failed: string[]; deals: string[]; transactionRows: number; filesLeft: number }

export async function runRetention(db: Db, k: Keyring, storage: Storage, now = new Date()): Promise<RetentionResult> {
  const cfg = await periods(db)
  const rows = (await db.query<Row>(PEOPLE, [cutoffFrom(cfg, now)])).rows
  const removed: string[] = []
  const failed: string[] = []
  for (const u of rows) {
    if (!due(u, cfg, now)) continue
    // one bad row must not stop everyone behind it; the next run tries again
    try {
      if (await removePerson(db, k, u.id, now)) removed.push(u.id)
    } catch (e) {
      console.error(`retention failed for one person: ${(e as { code?: string }).code ?? 'unknown'}`) // no personal data in the log
      failed.push(u.id)
    }
  }
  const deals: string[] = []
  for (const d of (await db.query<DealRow>(DEALS)).rows) {
    if (!dealRecordsDue({ endedAt: d.ended_at, hold: d.retention_hold }, cfg.relationship_years, now)) continue
    try {
      if (await removeDealRecords(db, k, d.id, now)) deals.push(d.id)
    } catch (e) {
      console.error(`retention failed for one deal: ${(e as { code?: string }).code ?? 'unknown'}`)
      failed.push(d.id)
    }
  }
  const transactionRows = await clearOldTransactions(db, k, transactionCutoff(now, cfg.transaction_years))
  await removeEmailComplaints(db, k, cfg, now)
  // A mail can be written just after its person went, or to an address the job cannot tie to anyone. No link lives this long, so none is needed.
  await db.query("DELETE FROM sandbox_outbox WHERE created_at < $1::timestamptz - interval '7 days'", [now.toISOString()])
  // tech design §3.1: a mail done with keeps its address 90 days, for questions about it; the row stays for the evidence pack
  await db.query(
    "UPDATE notification_outbox SET to_address = $2 WHERE status <> 'queued' AND finished_at < $1::timestamptz - interval '90 days' AND to_address <> $2",
    [now.toISOString(), REMOVED_ADDRESS],
  )
  return { removed, failed, deals, transactionRows, filesLeft: await removeFiles(db, storage) }
}

/**
 * After the rows, so nothing is lost if a person turns out not to be due. In a sandbox the file is in the app's own memory and
 * stays there until a restart; with its wrapped key gone it can never be read, and that store has a limit.
 */
async function removeFiles(db: Db, storage: Storage): Promise<number> {
  const keys = (await db.query<{ storage_key: string }>('SELECT storage_key FROM file_deletion ORDER BY queued_at')).rows
  let left = 0
  for (const { storage_key } of keys) {
    try {
      await storage.delete(storage_key)
      await db.query('DELETE FROM file_deletion WHERE storage_key = $1', [storage_key])
    } catch {
      left++ // tried again next run
    }
  }
  return left
}

/** Every address a person has had, and everyone named on their entities ($1 the person, $2 the entities), lower-cased. */
const PERSON_ADDRESSES = `SELECT lower(email) FROM user_account WHERE id = $1
         UNION SELECT lower(email) FROM user_email_history WHERE user_id = $1
         UNION SELECT lower(new_email) FROM account_token WHERE user_id = $1 AND new_email IS NOT NULL
         UNION SELECT lower(email) FROM entity_party WHERE entity_id = ANY($2::uuid[]) AND email IS NOT NULL`

async function removePerson(db: Db, k: Keyring, userId: string, now: Date): Promise<boolean> {
  return tx(db, async (c) => {
    // judged again under the lock, on the periods as they are now: a hold, a sign-in or a longer period may have come since the list was read
    await c.query('SELECT lock_person_for_retention($1)', [userId])
    const cfg = await periods(c)
    const fresh = (await c.query<Row>(`${PEOPLE} AND u.id = $2`, [cutoffFrom(cfg, now), userId])).rows[0]
    if (!fresh || !due(fresh, cfg, now)) return false
    const entities = (await c.query<{ id: string }>('SELECT id FROM legal_entity WHERE owner_user = $1', [userId])).rows.map((r) => r.id)
    const applicants = (await c.query<{ provider: string; provider_ref: string }>('SELECT provider, provider_ref FROM kyc_case WHERE entity_id = ANY($1::uuid[]) AND provider_ref IS NOT NULL UNION SELECT provider, provider_ref FROM kyc_provider_ref WHERE entity_id = ANY($1::uuid[])', [entities])).rows
    await c.query('INSERT INTO file_deletion (storage_key) SELECT storage_key FROM stored_file WHERE owner_id = ANY($1::uuid[]) ON CONFLICT DO NOTHING', [entities])
    // mail the sandbox kept: to any address this person has had, to anyone named on their entities, however it was typed
    await c.query(`DELETE FROM sandbox_outbox WHERE lower(to_address) IN (${PERSON_ADDRESSES}) OR lower(reply_to) IN (${PERSON_ADDRESSES})`, [userId, entities])
    // whom a lead's message was meant for (R-COM-03): the person's rows go; the message stays on the deal's clock
    await c.query('DELETE FROM message_recipient WHERE user_id = $1', [userId])
    // queued or sent, the durable queue keeps an address and a subject: the same addresses, and anything tied to the account
    await c.query(`DELETE FROM notification_outbox WHERE user_id = $1 OR lower(to_address) IN (${PERSON_ADDRESSES})`, [userId, entities])
    await removeParts(c, userId, entities)
    await c.query('DELETE FROM user_email_history WHERE user_id = $1', [userId])
    await c.query('DELETE FROM eligibility_reopen WHERE user_id = $1', [userId])
    await c.query('DELETE FROM eligibility_statement WHERE user_id = $1', [userId])
    await c.query('DELETE FROM assessment_attempt WHERE user_id = $1', [userId])
    await c.query('DELETE FROM warning_ack WHERE user_id = $1', [userId])
    await c.query('DELETE FROM cooling_off WHERE user_id = $1', [userId])
    await c.query('DELETE FROM account_token WHERE user_id = $1', [userId])
    await c.query('DELETE FROM mfa_recovery_code WHERE user_id = $1', [userId])
    await c.query('DELETE FROM app_session WHERE user_id = $1', [userId])
    await c.query('DELETE FROM stored_file WHERE owner_id = ANY($1::uuid[])', [entities])
    await c.query('DELETE FROM kyc_case WHERE entity_id = ANY($1::uuid[])', [entities])
    await c.query('DELETE FROM kyc_provider_ref WHERE entity_id = ANY($1::uuid[])', [entities])
    await c.query('DELETE FROM entity_party WHERE entity_id = ANY($1::uuid[])', [entities])
    await c.query('DELETE FROM entity_bank_account WHERE entity_id = ANY($1::uuid[])', [entities])
    // details naming this person, recorded when the account or entities changed; the chain keeps verifying without them
    await c.query('DELETE FROM audit_detail WHERE audit_seq IN (SELECT seq FROM audit WHERE entity_id = ANY($1::text[]))', [[userId, ...entities]])
    await c.query('SELECT anonymise_person($1)', [userId])
    await appendAudit(c, k, { actor: 'system', action: 'retention.person_removed', entity: userId })
    // the applicant at the provider is the operator's to remove, under its contract; these opaque ids are how it finds them
    for (const a of applicants) await appendAudit(c, k, { actor: 'system', action: `retention.provider_followup.${a.provider}`, entity: a.provider_ref })
    return true
  })
}

/**
 * D3–D4 records of a person being removed (tech design §3.1): what they did in deals goes, what they paid keeps its amounts
 * with the payer's details blanked, and their address leaves the lead's list. Ids, amounts and states stay, so the deal's
 * figures still add up. Runs before the addresses are gone ($1 the person, $2 their entities).
 */
async function removeParts(c: Tx, userId: string, entities: string[]) {
  const parts = (await c.query<{ id: string }>('SELECT id FROM participation WHERE user_id = $1', [userId])).rows.map((r) => r.id)
  for (const table of ['participation_event', 'instruction_ack', 'payment_query', 'withdrawal_request', 'refund_todo_event', 'reconfirm_exclusion', 'goten_import_row'])
    await c.query(`DELETE FROM ${table} WHERE participation_id = ANY($1::uuid[])`, [parts])
  await c.query("UPDATE signature_record SET signed_name = $2, ip = '', document = '', document_lead = '' WHERE participation_id = ANY($1::uuid[])", [parts, REMOVED])
  await c.query(
    `UPDATE unallocated_receipt SET payer_name = $2, payer_account = $2, bank_ref = '', note = NULL, return_basis = CASE WHEN return_basis IS NULL THEN NULL ELSE $2 END
      WHERE id IN (SELECT unallocated_id FROM receipt WHERE participation_id = ANY($1::uuid[])) OR from_receipt IN (SELECT id FROM receipt WHERE participation_id = ANY($1::uuid[]))`,
    [parts, REMOVED],
  )
  await c.query('UPDATE receipt SET payer_name = $2, payer_account = $2, note = NULL WHERE participation_id = ANY($1::uuid[])', [parts, REMOVED])
  await c.query(
    `UPDATE refund_payment SET source_name = $2, source_account = $2, dest_name = $2, dest_account = $2,
            evidence = CASE WHEN evidence IS NULL THEN NULL ELSE $2 END, recall_evidence = CASE WHEN recall_evidence IS NULL THEN NULL ELSE $2 END
      WHERE participation_id = ANY($1::uuid[])`,
    [parts, REMOVED],
  )
  await c.query('UPDATE hold_release SET basis = $2 WHERE participation_id = ANY($1::uuid[])', [parts, REMOVED])
  for (const table of ['deal_view', 'invitee_policy_ack', 'pending_invite']) await c.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId])
  // what they wrote to a deal's team, and complaints: from their form, or emailed from one of their addresses
  await c.query('DELETE FROM deal_message WHERE author = $1', [userId])
  await c.query(`DELETE FROM complaint WHERE user_id = $1 OR lower(from_address) IN (${PERSON_ADDRESSES})`, [userId, entities])
  // the lead's list and the personal invitations: rows they took up, or sent to an address of theirs
  await c.query(
    `UPDATE pipeline_entry SET name = $3, email = $4, private_note = NULL
      WHERE lower(email) IN (${PERSON_ADDRESSES}) OR targeted_invite IN (SELECT id FROM targeted_invite WHERE consumed_by = $1)`,
    [userId, entities, REMOVED, REMOVED_ADDRESS],
  )
  await c.query(`UPDATE targeted_invite SET email = $3 WHERE consumed_by = $1 OR lower(email) IN (${PERSON_ADDRESSES})`, [userId, entities, REMOVED_ADDRESS])
}

interface DealRow { id: string; ended_at: Date | null; retention_hold: boolean }
const DEALS = 'SELECT id, ended_at, retention_hold FROM deal WHERE ended_at IS NOT NULL AND records_erased_at IS NULL'

/** Every version of a person the deal ever named: today's contacts and recipients, and those in its versions and changes. */
const DEAL_PEOPLE = `SELECT contact_version AS id FROM investee WHERE deal_id = $1
   UNION SELECT unnest(extra_contact_versions) FROM investee WHERE deal_id = $1
   UNION SELECT person_version FROM carry_recipient WHERE deal_id = $1
   UNION SELECT (jsonb_path_query(snapshot, 'lax $.**.contact_version') #>> '{}')::uuid FROM deal_version WHERE deal_id = $1
   UNION SELECT (jsonb_path_query(snapshot, 'lax $.**.person_version') #>> '{}')::uuid FROM deal_version WHERE deal_id = $1
   UNION SELECT (jsonb_path_query(proposed_snapshot, 'lax $.**.contact_version') #>> '{}')::uuid FROM change_request WHERE deal_id = $1
   UNION SELECT (jsonb_path_query(proposed_snapshot, 'lax $.**.person_version') #>> '{}')::uuid FROM change_request WHERE deal_id = $1`

/**
 * §5.6, the deal's clock: the people with no account it named, the investee's files, the lead's list and personal
 * invitations, what was written to its investors and its team. Judged again under the deal's lock; the audit keeps the id.
 * A version of a person is per deal (a deal's versions only reuse its own), so blanking one touches no other deal.
 */
async function removeDealRecords(db: Db, k: Keyring, dealId: string, now: Date): Promise<boolean> {
  return tx(db, async (c) => {
    const d = (await c.query<DealRow>(`${DEALS} AND id = $1 FOR UPDATE`, [dealId])).rows[0]
    const cfg = await periods(c)
    if (!d || !dealRecordsDue({ endedAt: d.ended_at, hold: d.retention_hold }, cfg.relationship_years, now)) return false
    await c.query(`UPDATE person_version SET fields = '{}', anonymised_at = $2 WHERE id IN (${DEAL_PEOPLE}) AND anonymised_at IS NULL`, [dealId, now.toISOString()])
    const investees = (await c.query<{ id: string }>('SELECT id FROM investee WHERE deal_id = $1', [dealId])).rows.map((r) => r.id)
    await c.query(
      "INSERT INTO file_deletion (storage_key) SELECT storage_key FROM stored_file WHERE scope = 'investee_verification' AND owner_id = ANY($1::uuid[]) ON CONFLICT DO NOTHING",
      [investees],
    )
    await c.query("DELETE FROM stored_file WHERE scope = 'investee_verification' AND owner_id = ANY($1::uuid[])", [investees])
    const draft = (await c.query<{ draft: Draft }>('SELECT draft FROM deal WHERE id = $1', [dealId])).rows[0]!.draft
    await c.query('UPDATE deal SET draft = $2, records_erased_at = $3 WHERE id = $1', [dealId, JSON.stringify(withoutPeople(draft)), now.toISOString()])
    for (const r of (await c.query<{ id: string; proposed: Draft }>('SELECT id, proposed FROM change_request WHERE deal_id = $1', [dealId])).rows)
      await c.query('UPDATE change_request SET proposed = $2 WHERE id = $1', [r.id, JSON.stringify(withoutPeople(r.proposed))])
    await c.query('UPDATE message SET subject = NULL, body = NULL, sha256 = NULL, erased_at = $2 WHERE deal_id = $1 AND erased_at IS NULL', [dealId, now.toISOString()])
    await c.query('DELETE FROM deal_message WHERE deal_id = $1', [dealId])
    await c.query('UPDATE pipeline_entry SET name = $2, email = $3, private_note = NULL WHERE deal_id = $1', [dealId, REMOVED, REMOVED_ADDRESS])
    await c.query('UPDATE targeted_invite SET email = $2 WHERE deal_id = $1', [dealId, REMOVED_ADDRESS])
    await appendAudit(c, k, { actor: 'system', action: 'retention.deal_records_removed', entity: dealId })
    return true
  })
}

/**
 * MLR reg 40(4): payer details on money rows dated on or before `cutoff` are blanked, amounts kept, even while the person
 * is still a customer. Rows still open (money not yet placed, a query or request not decided, an import line not decided) wait;
 * a receipt does not, even with money held or due back: its blanked account then reads as unknown, so a refund needs the
 * account typed with evidence (plan R28 (3), `accountUnknown`). Rows of a person or deal under a legal hold stay. Returns how many rows changed.
 */
async function clearOldTransactions(db: Db, k: Keyring, cutoff: string): Promise<number> {
  return tx(db, async (c) => {
    // a row is free when neither its person nor its deal is held
    const free = `NOT EXISTS (SELECT 1 FROM participation p JOIN user_account u ON u.id = p.user_id JOIN deal d ON d.id = p.deal_id
                    WHERE p.id = x.participation_id AND (u.retention_hold OR d.retention_hold))`
    let n = 0
    n += (
      await c.query(`UPDATE receipt x SET payer_name = $2, payer_account = $2, note = NULL WHERE x.received_on <= $1::date AND x.payer_name <> $2 AND ${free}`, [
        cutoff,
        REMOVED,
      ])
    ).rowCount!
    // money that came in with no person: nobody's hold applies; once allocated it follows the receipt it became
    n += (
      await c.query(
        `UPDATE unallocated_receipt x SET payer_name = $2, payer_account = $2, bank_ref = '', note = NULL, return_basis = CASE WHEN return_basis IS NULL THEN NULL ELSE $2 END
          WHERE x.received_on <= $1::date AND x.payer_name <> $2 AND x.outcome <> 'open'
            AND NOT EXISTS (SELECT 1 FROM receipt r WHERE (r.unallocated_id = x.id OR r.id = x.from_receipt) AND r.payer_name <> $2)`,
        [cutoff, REMOVED],
      )
    ).rowCount!
    n += (
      await c.query(
        `UPDATE refund_payment x SET source_name = $2, source_account = $2, dest_name = $2, dest_account = $2,
                evidence = CASE WHEN evidence IS NULL THEN NULL ELSE $2 END, recall_evidence = CASE WHEN recall_evidence IS NULL THEN NULL ELSE $2 END
          WHERE x.state IN ('recorded', 'cancelled') AND coalesce(x.recorded_at, x.cancelled_at)::date <= $1::date AND x.source_name <> $2 AND ${free}`,
        [cutoff, REMOVED],
      )
    ).rowCount!
    n += (
      await c.query(
        `DELETE FROM goten_import_row x WHERE coalesce(x.received_on, (SELECT created_at::date FROM goten_import i WHERE i.id = x.import_id)) <= $1::date
           AND x.decision IS NOT NULL AND (x.participation_id IS NULL OR ${free})`,
        [cutoff],
      )
    ).rowCount!
    // only what is finished: open money, an open query or request, or a line nobody has decided is still someone's work
    const finished: Record<string, string> = { participation_event: 'true', payment_query: "x.status <> 'open'", withdrawal_request: 'x.decision IS NOT NULL' }
    for (const [table, done] of Object.entries(finished))
      n += (await c.query(`DELETE FROM ${table} x WHERE x.created_at::date <= $1::date AND ${done} AND ${free}`, [cutoff])).rowCount!
    if (n) await appendAudit(c, k, { actor: 'system', action: 'retention.transactions_cleared', entity: cutoff })
    return n
  })
}

/** Complaints emailed in by someone with no account (R-AUD-05); a form complaint goes with its person. */
async function removeEmailComplaints(db: Db, k: Keyring, cfg: Periods, now: Date) {
  const rows = (await db.query<{ id: string; received_at: Date }>("SELECT id, received_at FROM complaint WHERE channel = 'email'")).rows
  const due = rows.filter((r) => emailComplaintDue(r.received_at, cfg.relationship_years, now)).map((r) => r.id)
  if (!due.length) return
  await tx(db, async (c) => {
    await c.query('DELETE FROM complaint WHERE id = ANY($1::uuid[])', [due])
    for (const id of due) await appendAudit(c, k, { actor: 'system', action: 'retention.complaint_removed', entity: id })
  })
}
