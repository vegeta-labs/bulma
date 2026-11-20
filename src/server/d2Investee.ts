// The investee check: a link for the company's contact with no account, and the reviewer's decision (R-INV-01 to R-INV-05).
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { StorageFull, type Adapters } from '../adapters/index.ts'
import type { Draft } from '../lib/draft.ts'
import { canReviewDeal, type DealParties } from '../lib/gate.ts'
import {
  ADVANCE_ASSURANCE,
  investeeCanChange,
  investeeGaps,
  investeeLinkOpen,
  MAX_EXTRA_CONTACTS,
  MAX_INVESTEE_FILES,
  MAX_INVESTEE_UPLOADS,
  reminderAllowed,
  requiredInvesteeDocs,
  type InvesteeStatus,
} from '../lib/investee.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { reserveAttempt, sessionStillLive, type SessionUser } from './auth.ts'
import { instanceEpoch } from './d2Files.ts'
import type { MailQueue, QueuedMail } from './outbox.ts'
import { Refused, reviewerTx, type Ctx } from './requests.ts'
import { UploadHolds } from './uploadSlots.ts'

type Q = Pick<Tx, 'query'>
export type Mail = QueuedMail

export interface InvesteeDeps {
  db: Db
  k: Keyring
  now: () => Date
  linkTo: (path: string) => string
  mail: MailQueue
  adapters: () => Promise<Adapters>
  uploadDeadlineMs?: number
  leadTx: <T>(who: SessionUser, id: string, fn: (c: Tx, deal: { id: string; public_code: string }) => Promise<T>) => Promise<T>
  partiesInTx: (c: Tx, id: string) => Promise<{ parties: DealParties; lead: string; code: string; state: string } | null>
  partiesRead: (id: string) => Promise<{ parties: DealParties; state: string } | null>
}

interface OpenLink {
  investee_id: string
  deal_id: string
  status: InvesteeStatus
  expires_at: Date
  revoked_at: Date | null
  public_code: string
  draft: Draft
  needs_notarised_signature: boolean | null
  return_reason: string | null
  lead_user: string
  company_name: string
}

const Uuid = z.uuid()
const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const Token = z.string().min(20).max(200)
const FILE_LIMIT = 15 * 1024 * 1024
const NOT_VALID = 'This link has expired or is not valid.'
const DAY_MS = 86_400_000
const ALLOWED: Array<{ type: string; magic: Buffer }> = [
  { type: 'application/pdf', magic: Buffer.from('%PDF-') },
  { type: 'image/png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { type: 'image/jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
]

const hashLink = (k: Keyring, token: string) => k.hmac(`investee-link\0${token}`)
const investeeConfig = async (q: Q) =>
  (
    await q.query<{ investee_link_days: number; investee_reminder_hours: number; investee_valid_days: number }>(
      'SELECT investee_link_days, investee_reminder_hours, investee_valid_days FROM deal_config WHERE id = 1',
    )
  ).rows[0]!
const uploadedDocs = async (q: Q, investee: string) =>
  (
    await q.query<{ id: string; requirement: string; display_name: string }>(
      "SELECT id, requirement, display_name FROM stored_file WHERE scope = 'investee_verification' AND owner_id = $1 AND removed_at IS NULL ORDER BY created_at, id",
      [investee],
    )
  ).rows
const contactEmail = async (q: Q, investee: string) =>
  (
    await q.query<{ email: string }>(
      "SELECT p.fields->>'contact_email' AS email FROM investee i JOIN person_version p ON p.id = i.contact_version WHERE i.id = $1",
      [investee],
    )
  ).rows[0]!.email
const leadEmail = async (q: Q, id: string) => (await q.query<{ email: string }>('SELECT email FROM user_account WHERE id = $1', [id])).rows[0]!.email
/** A mail to the lead, sent only while they still lead the deal (R-NTF-02). */
export const toLead = async (q: Q, lead: string, dealId: string, subject: string, body: string): Promise<QueuedMail> => ({
  audience: { kind: 'lead', userId: lead, dealId },
  to: await leadEmail(q, lead),
  subject,
  body,
})

/** What a reviewer looked at: which company, and which of its documents. A decision names it, so it cannot land on another company or a changed set. */
const checkHash = (companyId: string, docs: ReadonlyArray<{ id: string }>, notarised: boolean | null) =>
  createHash('sha256')
    .update(JSON.stringify({ company: companyId, files: docs.map((f) => f.id).sort(), notarised }), 'utf8')
    .digest('hex')

/** A new link replaces any earlier one (R-INV-01). The token itself is never stored, so sending again means a new link. */
async function issueLink(c: Q, k: Keyring, now: Date, investee: string): Promise<{ token: string; days: number }> {
  const token = randomBytes(32).toString('base64url')
  const days = (await investeeConfig(c)).investee_link_days
  await c.query('UPDATE investee_link SET revoked_at = $2::timestamptz WHERE investee_id = $1 AND revoked_at IS NULL', [investee, now.toISOString()])
  await c.query('INSERT INTO investee_link (id, investee_id, token_hmac, expires_at) VALUES ($1, $2, $3, $4::timestamptz)', [
    randomUUID(),
    investee,
    hashLink(k, token),
    new Date(now.getTime() + days * DAY_MS).toISOString(),
  ])
  return { token, days }
}

const REAL_SINCE = "coalesce((SELECT real_since FROM instance_profile WHERE id = 1), '-infinity'::timestamptz)"
const hasTaxRelief = (draft: Draft) => draft.terms?.seis === true || draft.terms?.eis === true
const sameText = (a: unknown, b: unknown) =>
  String(a ?? '')
    .trim()
    .toLowerCase() ===
  String(b ?? '')
    .trim()
    .toLowerCase()
type SyncDeps = Pick<InvesteeDeps, 'k' | 'now' | 'linkTo'>
type SyncDeal = { id: string; public_code: string; lead_user: string }

/**
 * R-INV-04: a company already checked, recognised by its registration number, is not asked again. An advance assurance letter
 * belongs to one deal, so a check that did not ask for one cannot stand in for it (R-INV-02).
 */
/** What the company said about signatures when it was checked: reusing the check must not lose it. */
const earlierAnswer = async (c: Q, company: string) =>
  (await c.query<{ needs_notarised_signature: boolean | null }>('SELECT needs_notarised_signature FROM investee_company WHERE id = $1', [company])).rows[0]
    ?.needs_notarised_signature ?? null

async function checkedCompany(c: Q, d: SyncDeps, draft: Draft): Promise<string | null> {
  const number = draft.company!.registration_number?.trim()
  if (!number || hasTaxRelief(draft)) return null
  const today = d.now().toISOString().slice(0, 10)
  const known = await c.query<{ id: string }>(
    `SELECT id FROM investee_company WHERE registration_number = $1 AND lower(jurisdiction) = lower($2) AND verified_until >= $3::date AND verified_at >= ${REAL_SINCE} LIMIT 1`,
    [number, draft.company!.jurisdiction!.trim(), today],
  )
  return known.rows[0]?.id ?? null
}

async function newCompany(c: Q, draft: Draft): Promise<string> {
  const co = draft.company!
  const id = randomUUID()
  await c.query('INSERT INTO investee_company (id, legal_name, jurisdiction, registration_number) VALUES ($1, $2, $3, $4)', [
    id,
    co.legal_name!.trim(),
    co.jurisdiction!.trim(),
    co.registration_number?.trim() || null,
  ])
  return id
}

async function askCompany(c: Q, d: SyncDeps, deal: SyncDeal, draft: Draft, investee: string): Promise<Mail[]> {
  const { token, days } = await issueLink(c, d.k, d.now(), investee)
  return [
    {
      audience: { kind: 'address' },
      to: draft.company!.contact_email!,
      subject: `Company check for deal ${deal.public_code}`,
      body: `A deal has been submitted that names your company. Please provide the company's documents here. No account is needed.\n\n${d.linkTo(`/investee?token=${token}`)}\n\nThe link expires in ${days} days. Any earlier link no longer works.`,
    },
    await toLead(c, deal.lead_user, deal.id, `Company check started for deal ${deal.public_code}`, 'We have asked the company contact for its documents. You can follow progress on the deal page.'),
  ]
}

/**
 * Keeps the check in step with what the deal says, at every submission and every edit under review. A check of one company says
 * nothing about another; a link belongs to the person it was sent to; and a document asked for later has to be asked for.
 */
export async function syncInvesteeCheck(c: Q, d: SyncDeps, deal: SyncDeal, draft: Draft, contactVersion: string): Promise<Mail[]> {
  const row = (
    await c.query<{
      id: string
      status: InvesteeStatus
      legal_name: string
      jurisdiction: string
      registration_number: string | null
      old_email: string | null
    }>(
      `SELECT i.id, i.status, co.legal_name, co.jurisdiction, co.registration_number, p.fields->>'contact_email' AS old_email
     FROM investee i JOIN investee_company co ON co.id = i.company_id JOIN person_version p ON p.id = i.contact_version WHERE i.deal_id = $1 FOR UPDATE OF i`,
      [deal.id],
    )
  ).rows[0]
  const now = d.now().toISOString()
  if (!row) {
    const investee = randomUUID()
    const known = await checkedCompany(c, d, draft)
    if (known) {
      await c.query(
        "INSERT INTO investee (id, deal_id, company_id, contact_version, status, decided_at) VALUES ($1, $2, $3, $4, 'approved', $5::timestamptz)",
        [investee, deal.id, known, contactVersion, now],
      )
      await c.query('UPDATE investee SET needs_notarised_signature = $2 WHERE id = $1', [investee, await earlierAnswer(c, known)])
      return []
    }
    await c.query('INSERT INTO investee (id, deal_id, company_id, contact_version) VALUES ($1, $2, $3, $4)', [
      investee,
      deal.id,
      await newCompany(c, draft),
      contactVersion,
    ])
    return askCompany(c, d, deal, draft, investee)
  }
  await c.query('UPDATE investee SET contact_version = $2 WHERE id = $1', [row.id, contactVersion])
  const co = draft.company!
  if (!sameText(row.legal_name, co.legal_name) || !sameText(row.jurisdiction, co.jurisdiction) || !sameText(row.registration_number, co.registration_number)) {
    await c.query("UPDATE stored_file SET removed_at = $2::timestamptz WHERE scope = 'investee_verification' AND owner_id = $1 AND removed_at IS NULL", [
      row.id,
      now,
    ])
    const known = await checkedCompany(c, d, draft)
    await c.query(
      'UPDATE investee SET company_id = $2, status = $3, decided_by = NULL, decided_at = $4::timestamptz, return_reason = NULL, needs_notarised_signature = NULL WHERE id = $1',
      [row.id, known ?? (await newCompany(c, draft)), known ? 'approved' : 'waiting', known ? now : null],
    )
    if (!known) return askCompany(c, d, deal, draft, row.id)
    await c.query('UPDATE investee SET needs_notarised_signature = $2 WHERE id = $1', [row.id, await earlierAnswer(c, known)])
    await c.query('UPDATE investee_link SET revoked_at = $2::timestamptz WHERE investee_id = $1 AND revoked_at IS NULL', [row.id, now])
    return []
  }
  const held = (await uploadedDocs(c, row.id)).map((f) => f.requirement)
  const letterMissing = hasTaxRelief(draft) && !held.includes(ADVANCE_ASSURANCE) && !investeeCanChange(row.status)
  if (letterMissing) await c.query("UPDATE investee SET status = 'waiting', decided_by = NULL, decided_at = NULL WHERE id = $1", [row.id])
  const newContact = !sameText(row.old_email, co.contact_email)
  if (!letterMissing && !newContact) return []
  if (letterMissing || investeeCanChange(row.status)) return askCompany(c, d, deal, draft, row.id)
  // nothing left for the company to send, but a link should not stay with someone no longer the contact
  await c.query('UPDATE investee_link SET revoked_at = $2::timestamptz WHERE investee_id = $1 AND revoked_at IS NULL', [row.id, now])
  return []
}

/** R-INV-05: what a lead may see is the progress, never the company's documents. */
export async function investeeProgress(q: Q, dealId: string) {
  const row = (
    await q.query<{ id: string; status: InvesteeStatus; return_reason: string | null; last_reminded_at: Date | null; expires_at: Date | null }>(
      'SELECT i.id, i.status, i.return_reason, i.last_reminded_at, l.expires_at FROM investee i LEFT JOIN investee_link l ON l.investee_id = i.id AND l.revoked_at IS NULL WHERE i.deal_id = $1',
      [dealId],
    )
  ).rows[0]
  if (!row) return null
  return {
    status: row.status,
    return_reason: row.return_reason,
    last_reminded_at: row.last_reminded_at,
    link_expires_at: row.expires_at,
    documents_received: (await uploadedDocs(q, row.id)).length,
  }
}

export async function investeeForReview(q: Q, dealId: string) {
  const row = (
    await q.query<{
      id: string
      company_id: string
      status: InvesteeStatus
      needs_notarised_signature: boolean | null
      return_reason: string | null
      legal_name: string
      jurisdiction: string
      registration_number: string | null
    }>(
      'SELECT i.id, i.company_id, i.status, i.needs_notarised_signature, i.return_reason, co.legal_name, co.jurisdiction, co.registration_number FROM investee i JOIN investee_company co ON co.id = i.company_id WHERE i.deal_id = $1',
      [dealId],
    )
  ).rows[0]
  if (!row) return null
  const documents = await uploadedDocs(q, row.id)
  return {
    status: row.status,
    needs_notarised_signature: row.needs_notarised_signature,
    return_reason: row.return_reason,
    documents,
    // the company this check is about, which a working copy sent back for changes may no longer name
    company: { legal_name: row.legal_name, jurisdiction: row.jurisdiction, registration_number: row.registration_number },
    // passed on an earlier deal: the documents are with that check, not this one (R-INV-04)
    reused_earlier_check: row.status === 'approved' && documents.length === 0,
    check_sha256: checkHash(row.company_id, documents, row.needs_notarised_signature),
  }
}

export function registerInvestee(app: FastifyInstance, d: InvesteeDeps) {
  const x: Ctx = { db: d.db, k: d.k }
  const pub = { config: { gate: 'public' as const } }
  const verified = { config: { gate: 'verified' as const } }
  const reviewer = { config: { gate: 'canReviewDeals' as const } }
  const holds = new UploadHolds(d.uploadDeadlineMs)
  const downloads = new UploadHolds(120_000, 4, 16)

  const findLink = async (q: Q, token: string, lock = false) => {
    // the lock first, then a fresh read: a statement that waits for a lock still sees the link as it was when it started
    if (lock)
      await q.query('SELECT 1 FROM investee i JOIN investee_link l ON l.investee_id = i.id WHERE l.token_hmac = $1 FOR UPDATE OF i', [hashLink(d.k, token)])
    const r = (
      await q.query<OpenLink>(
        `SELECT l.investee_id, i.deal_id, i.status, l.expires_at, l.revoked_at, deal.public_code, (SELECT v.snapshot FROM deal_version v WHERE v.deal_id = deal.id ORDER BY v.n DESC LIMIT 1) AS draft, i.needs_notarised_signature, i.return_reason, deal.lead_user, co.legal_name AS company_name
       FROM investee_link l JOIN investee i ON i.id = l.investee_id JOIN deal ON deal.id = i.deal_id JOIN investee_company co ON co.id = i.company_id
       WHERE l.token_hmac = $1 AND deal.state <> 'rejected' AND deal.deleted_at IS NULL`,
        [hashLink(d.k, token)],
      )
    ).rows[0]
    return r && investeeLinkOpen({ expiresAt: r.expires_at, revokedAt: r.revoked_at }, d.now()) ? r : null
  }
  /** Only a wrong token counts against the address: a company uploading its documents should not run out of tries. */
  const refuseLink = async (req: FastifyRequest, reply: FastifyReply) => {
    const allowed = await reserveAttempt(d.db, [d.k.hmac(`investee-link-ip\0${req.ip}`)])
    return reply.code(allowed ? 404 : 429).send({ error: NOT_VALID })
  }
  const requiredFor = (draft: Draft) => requiredInvesteeDocs(draft.terms?.seis === true || draft.terms?.eis === true)

  app.post('/api/investee/view', pub, async (req, reply) => {
    const { token } = z.strictObject({ token: Token }).parse(req.body)
    const page = await tx(d.db, async (c) => {
      // one view of the database: the link's validity and the files listed must belong to the same moment
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const link = await findLink(c, token)
      if (!link) return null
      return {
        public_code: link.public_code,
        deal_name: link.draft.basics?.name ?? null,
        // the company this link was issued for, not whatever the working copy says by now
        company: link.company_name,
        status: link.status,
        return_reason: link.return_reason,
        required: requiredFor(link.draft),
        uploaded: (await uploadedDocs(c, link.investee_id)).map(({ id, requirement, display_name }) => ({ id, requirement, display_name })),
        needs_notarised_signature: link.needs_notarised_signature,
        link_expires_at: link.expires_at,
      }
    })
    return page ?? refuseLink(req, reply)
  })

  type Upload = { Querystring: { requirement?: string; name?: string } }
  const tokenOf = (req: FastifyRequest) => Token.safeParse(req.headers['x-investee-token'])
  const addFile = async (req: FastifyRequest<Upload>, reply: FastifyReply) => {
    const parsed = tokenOf(req)
    if (!parsed.success) return refuseLink(req, reply)
    const token = parsed.data
    const name = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((s) => !s.includes('\0'))
      .parse(req.query.name)
    const requirement = z.string().max(40).parse(req.query.requirement)
    const data = req.body
    if (!Buffer.isBuffer(data) || !data.length) return reply.code(400).send({ error: 'send the file as raw bytes' })
    const kind = ALLOWED.find((f) => data.subarray(0, f.magic.length).equals(f.magic))
    if (!kind) return reply.code(415).send({ error: 'only PDF, PNG and JPEG files are accepted' })
    const first = await findLink(d.db, token)
    if (!first) return refuseLink(req, reply)
    if (!requiredFor(first.draft).includes(requirement)) return reply.code(400).send({ error: 'this document is not asked for' })
    if (!investeeCanChange(first.status)) throw new Refused('These documents have already been sent.')
    const epoch = await instanceEpoch(d.db)
    const a = await d.adapters()
    if (!(await a.scanner.scan(data)).clean) return reply.code(422).send({ error: 'this file did not pass the virus check' })
    const fileId = randomUUID()
    const sealed = d.k.encrypt(data)
    const key = `investee/${first.investee_id}/${fileId}`
    try {
      await a.storage.put(key, sealed.ciphertext)
    } catch (e) {
      if (e instanceof StorageFull) return reply.code(507).send({ error: e.message })
      throw e
    }
    try {
      await tx(d.db, async (c) => {
        await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
        if ((await instanceEpoch(c)) !== epoch) throw new Refused('The instance changed while this file was being added. Add it again.')
        const link = await findLink(c, token, true)
        if (!link || !investeeCanChange(link.status)) throw new Refused(NOT_VALID)
        if ((await uploadedDocs(c, link.investee_id)).length >= MAX_INVESTEE_FILES) throw new Refused('There are too many files.')
        const ever = await c.query<{ n: string }>("SELECT count(*) AS n FROM stored_file WHERE scope = 'investee_verification' AND owner_id = $1", [
          link.investee_id,
        ])
        if (Number(ever.rows[0]!.n) >= MAX_INVESTEE_UPLOADS) throw new Refused('There are too many files.')
        await c.query(
          'INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
          [
            fileId,
            'investee_verification',
            link.investee_id,
            requirement,
            name,
            kind.type,
            createHash('sha256').update(data).digest('hex'),
            data.length,
            'clean',
            key,
            sealed.keyId,
            sealed.wrappedDek,
          ],
        )
        await appendAudit(c, d.k, { actor: 'investee', action: 'investee.file_added', entity: fileId })
      })
    } catch (e) {
      await a.storage.delete(key).catch(() => undefined)
      throw e
    }
    return { id: fileId }
  }

  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: FILE_LIMIT }, (_r, body, done) => done(null, body))
    scope.post<Upload>(
      '/api/investee/files',
      {
        ...pub,
        bodyLimit: FILE_LIMIT,
        // before the body is read: only someone holding a live link can make the server hold a file
        onRequest: async (req, reply) => {
          const parsed = tokenOf(req)
          const link = parsed.success ? await findLink(d.db, parsed.data) : null
          if (!link) return refuseLink(req, reply)
          if (!holds.hold(req, reply, link.investee_id)) return reply.code(429).send({ error: 'too many uploads at once, try again in a moment' })
        },
      },
      async (req, reply) => holds.work(req, reply, () => addFile(req, reply)),
    )
  })

  // a company sent back for more must be able to clear what it no longer wants to send
  app.post('/api/investee/files/remove', pub, async (req, reply) => {
    const body = z.strictObject({ token: Token, file_id: Uuid }).parse(req.body)
    const ok = await tx(d.db, async (c) => {
      const link = await findLink(c, body.token, true)
      if (!link) return false
      if (!investeeCanChange(link.status)) throw new Refused('These documents have already been sent.')
      const r = await c.query(
        "UPDATE stored_file SET removed_at = $3::timestamptz WHERE id = $1 AND owner_id = $2 AND scope = 'investee_verification' AND removed_at IS NULL",
        [body.file_id, link.investee_id, d.now().toISOString()],
      )
      if (!r.rowCount) throw new Refused('no such file')
      await appendAudit(c, d.k, { actor: 'investee', action: 'investee.file_removed', entity: body.file_id })
      return true
    })
    if (!ok) return refuseLink(req, reply)
    return { ok: true }
  })

  app.post('/api/investee/submit', pub, async (req, reply) => {
    const body = z.strictObject({ token: Token, needs_notarised_signature: z.boolean().nullable() }).parse(req.body)
    const ok = await tx(d.db, async (c) => {
      const link = await findLink(c, body.token, true)
      if (!link) return false
      if (!investeeCanChange(link.status)) throw new Refused('These documents have already been sent.')
      const gaps = investeeGaps(
        requiredFor(link.draft),
        (await uploadedDocs(c, link.investee_id)).map((f) => f.requirement),
        body.needs_notarised_signature !== null,
      )
      if (gaps.length) throw new Refused(`Still missing: ${gaps.join(', ')}.`)
      await c.query("UPDATE investee SET status = 'submitted', needs_notarised_signature = $2, return_reason = NULL WHERE id = $1", [
        link.investee_id,
        body.needs_notarised_signature,
      ])
      await appendAudit(c, d.k, { actor: 'investee', action: 'investee.submitted', entity: link.investee_id })
      await d.mail.queue(c, await toLead(c, link.lead_user, link.deal_id, `Company check for deal ${link.public_code}`, 'The company has sent its documents. A reviewer will look at them next.'))
      return true
    })
    if (!ok) return refuseLink(req, reply)
    await d.mail.flush()
    return { status: 'submitted' }
  })

  const investeeRow = async (c: Q, dealId: string) =>
    (
      await c.query<{
        id: string
        status: InvesteeStatus
        last_reminded_at: Date | null
        company_id: string
        extra_contact_versions: string[]
        needs_notarised_signature: boolean | null
      }>('SELECT id, status, last_reminded_at, company_id, extra_contact_versions, needs_notarised_signature FROM investee WHERE deal_id = $1 FOR UPDATE', [
        dealId,
      ])
    ).rows[0]

  // R-INV-01, R-INV-05: chasing the company sends a fresh link, at most once per period
  app.post<{ Params: { id: string } }>('/api/deals/:id/investee/remind', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    await d.leadTx(req.user!, id, async (c, deal) => {
      const row = await investeeRow(c, id)
      if (!row) throw new Refused('The company check has not started.')
      if ((deal as { state?: string }).state === 'rejected') throw new Refused('This deal has ended.')
      if (!investeeCanChange(row.status)) throw new Refused('The company has nothing left to send.')
      if (!reminderAllowed(row.last_reminded_at, d.now(), (await investeeConfig(c)).investee_reminder_hours))
        throw new Refused('A reminder was sent recently. Try again later.')
      const { token, days } = await issueLink(c, d.k, d.now(), row.id)
      await c.query('UPDATE investee SET last_reminded_at = $2::timestamptz WHERE id = $1', [row.id, d.now().toISOString()])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'investee.reminded', entity: row.id })
      await d.mail.queue(c, {
        audience: { kind: 'address' },
        to: await contactEmail(c, row.id),
        subject: `Reminder: company check for deal ${deal.public_code}`,
        body: `Please provide the company's documents here. No account is needed.\n\n${d.linkTo(`/investee?token=${token}`)}\n\nThe link expires in ${days} days. Any earlier link no longer works.`,
      })
    })
    await d.mail.flush()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/deals/:id/investee/contacts', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const body = z.strictObject({ name: z.string().trim().min(1).max(200), email: z.email().max(320) }).parse(req.body)
    return d.leadTx(req.user!, id, async (c) => {
      const row = await investeeRow(c, id)
      if (!row) throw new Refused('The company check has not started.')
      if (row.extra_contact_versions.length >= MAX_EXTRA_CONTACTS) throw new Refused(`There can be at most ${MAX_EXTRA_CONTACTS} extra contacts.`)
      const version = randomUUID()
      await c.query('INSERT INTO person_version (id, fields) VALUES ($1, $2)', [
        version,
        JSON.stringify({ contact_name: body.name, contact_email: body.email }),
      ])
      await c.query('UPDATE investee SET extra_contact_versions = array_append(extra_contact_versions, $2::uuid) WHERE id = $1', [row.id, version])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'investee.contact_added', entity: row.id })
      return { ok: true }
    })
  })

  // R-INV-03: the reviewer decides; without a pass a deal can raise money but cannot enter closing (D5)
  const decide = (
    who: SessionUser,
    id: string,
    reviewed: string,
    fn: (c: Tx, row: NonNullable<Awaited<ReturnType<typeof investeeRow>>>, code: string) => Promise<Mail | null>,
  ) =>
    reviewerTx(x, who, async (c) => {
      const held = await d.partiesInTx(c, id)
      // a draft has been submitted to nobody: the same answer as for a deal that does not exist
      if (!held || held.state === 'draft') throw new Refused('Deal not found.')
      // after the waiting: someone whose session ended meanwhile decides nothing
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      if (held.state === 'rejected') throw new Refused('This deal has ended.')
      if (!canReviewDeal(who, who.email, held.parties)) throw new Refused('You cannot review a deal you lead, work on, or receive carry from.')
      const row = await investeeRow(c, id)
      if (!row || row.status !== 'submitted') throw new Refused('There is nothing to decide yet.')
      if (checkHash(row.company_id, await uploadedDocs(c, row.id), row.needs_notarised_signature) !== reviewed)
        throw new Refused('This company check has changed since you opened it. Open it again.')
      const m = await fn(c, row, held.code)
      if (m) await d.mail.queue(c, m)
    })

  app.post<{ Params: { id: string } }>('/api/review/deals/:id/investee/approve', reviewer, async (req) => {
    const id = Uuid.parse(req.params.id)
    const { reviewed_sha256 } = z.strictObject({ reviewed_sha256: Hash }).parse(req.body)
    await decide(req.user!, id, reviewed_sha256, async (c, row) => {
      const until = new Date(d.now().getTime() + (await investeeConfig(c)).investee_valid_days * DAY_MS).toISOString().slice(0, 10)
      await c.query("UPDATE investee SET status = 'approved', decided_by = $2, decided_at = $3::timestamptz, return_reason = NULL WHERE id = $1", [
        row.id,
        req.user!.id,
        d.now().toISOString(),
      ])
      await c.query('UPDATE investee_company SET verified_until = $2::date, verified_at = $3::timestamptz, needs_notarised_signature = $4 WHERE id = $1', [
        row.company_id,
        until,
        d.now().toISOString(),
        row.needs_notarised_signature,
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'investee.approved', entity: row.id })
      return null
    })
    return { status: 'approved' }
  })

  app.post<{ Params: { id: string } }>('/api/review/deals/:id/investee/return', reviewer, async (req) => {
    const id = Uuid.parse(req.params.id)
    const { reason, reviewed_sha256 } = z.strictObject({ reason: z.string().trim().min(1).max(5_000), reviewed_sha256: Hash }).parse(req.body)
    await decide(req.user!, id, reviewed_sha256, async (c, row, code) => {
      await c.query("UPDATE investee SET status = 'returned', decided_by = $2, decided_at = $3::timestamptz, return_reason = $4 WHERE id = $1", [
        row.id,
        req.user!.id,
        d.now().toISOString(),
        reason,
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'investee.returned', entity: row.id, detail: reason })
      const { token, days } = await issueLink(c, d.k, d.now(), row.id)
      return {
        audience: { kind: 'address' },
        to: await contactEmail(c, row.id),
        subject: `More is needed for deal ${code}`,
        body: `We need more from the company: ${reason}\n\n${d.linkTo(`/investee?token=${token}`)}\n\nThe link expires in ${days} days.`,
      }
    })
    await d.mail.flush()
    return { status: 'returned' }
  })

  app.get<{ Params: { id: string; file: string } }>('/api/review/deals/:id/investee/files/:file', reviewer, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const file = Uuid.parse(req.params.file)
    // the check on the company is for reviewers with no stake in the deal (R-INV-05, decision R19)
    const held = await d.partiesRead(id)
    // a deal withdrawn to draft is no longer before anyone: a link kept from when it was
    if (!held || held.state === 'draft' || !canReviewDeal(req.user, req.user!.email, held.parties)) return reply.code(404).send({ error: 'no such file' })
    const f = (
      await d.db.query<{ content_type: string; storage_key: string; key_id: string; wrapped_key: Buffer }>(
        "SELECT f.content_type, f.storage_key, f.key_id, f.wrapped_key FROM stored_file f JOIN investee i ON i.id = f.owner_id WHERE f.id = $1 AND i.deal_id = $2 AND f.scope = 'investee_verification' AND f.removed_at IS NULL",
        [file, id],
      )
    ).rows[0]
    if (!f) return reply.code(404).send({ error: 'no such file' })
    return downloads.work(
      req,
      reply,
      async () => {
        const sealed = await (await d.adapters()).storage.get(f.storage_key)
        if (!sealed) return reply.code(404).send({ error: 'no such file' })
        await tx(d.db, (c) => appendAudit(c, d.k, { actor: req.user!.id, action: 'investee.file_viewed', entity: file }))
        return reply
          .header('content-disposition', 'attachment; filename="document"')
          .type(f.content_type)
          .send(d.k.decrypt(f.key_id, f.wrapped_key, sealed))
      },
      req.user!.id,
    )
  })
}
