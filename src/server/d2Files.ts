// Deal documents: upload, folders, removal and download (R-DRF-07). A change to the documents is a change to the deal.
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { StorageFull, type Adapters } from '../adapters/index.ts'
import { judgeDealFile, LEGAL_LIMIT_BYTES, MAX_DEAL_FILES } from '../lib/dealFiles.ts'
import { withWarningCover } from './pdfCover.ts'
import type { DealState } from '../lib/dealState.ts'
import { canAdministerDeal, canApproveDealContent, canReviewDeal, GATES, type DealParties } from '../lib/gate.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { SESSION, sessionUser, type SessionUser } from './auth.ts'
import { USER_BYTES_LIMIT } from './d1.ts'
import { Refused } from './requests.ts'
import { UploadHolds } from './uploadSlots.ts'

type Route = { Params: { id: string }; Querystring: { kind?: string; name?: string; folder?: string } }
interface DealForFiles {
  id: string
  state: DealState
}

export interface FileDeps {
  db: Db
  k: Keyring
  adapters: () => Promise<Adapters>
  uploadDeadlineMs?: number
  downloadDeadlineMs?: number
  leadTx: <T>(who: SessionUser, id: string, fn: (c: Tx, deal: never) => Promise<T>) => Promise<T>
  /** Sends a deal in review back to the start of review once its documents have changed. */
  documentsChanged: (c: Tx, deal: never, who: string) => Promise<void>
  partiesFor: (id: string) => Promise<{ parties: DealParties; state: DealState } | null>
  canEdit: (s: DealState) => boolean
}

const Uuid = z.uuid()
const Name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !s.includes('\0'))
const DEADLINE_MS = 120_000
const NO_FILE = 'no such file'
/** Files are held in memory while they are worked on, so what is in flight has a limit in bytes, not only in number. */
const UPLOAD_BUDGET_BYTES = 256 * 1024 * 1024
const DOWNLOAD_BUDGET_BYTES = 512 * 1024 * 1024

export const instanceEpoch = async (q: Pick<Tx, 'query'>) =>
  String((await q.query<{ real_since: Date | null }>('SELECT real_since FROM instance_profile WHERE id = 1')).rows[0]!.real_since?.getTime() ?? 'sandbox')

export const dealFiles = async (q: Pick<Tx, 'query'>, dealId: string) =>
  (
    await q.query(
      "SELECT id, requirement, display_name, content_type, size_bytes, folder_id, created_at FROM stored_file WHERE scope = 'deal_shared' AND owner_id = $1 AND removed_at IS NULL ORDER BY created_at, id",
      [dealId],
    )
  ).rows
export const dealFolders = async (q: Pick<Tx, 'query'>, dealId: string) =>
  (await q.query('SELECT id, parent_id, name FROM doc_folder WHERE deal_id = $1 ORDER BY created_at, id', [dealId])).rows

export function registerDealFiles(app: FastifyInstance, d: FileDeps) {
  const verified = { config: { gate: 'verified' as const } }
  const lead = <T>(who: SessionUser, id: string, fn: (c: Tx, deal: DealForFiles) => Promise<T>) => d.leadTx(who, id, fn as (c: Tx, deal: never) => Promise<T>)
  const changed = (c: Tx, deal: DealForFiles, who: string) => d.documentsChanged(c, deal as never, who)
  const holds = new UploadHolds(d.uploadDeadlineMs ?? DEADLINE_MS, 2, 8, UPLOAD_BUDGET_BYTES)
  const downloads = new UploadHolds(d.downloadDeadlineMs ?? DEADLINE_MS, 4, 16, DOWNLOAD_BUDGET_BYTES)

  const folderInDeal = async (c: Pick<Tx, 'query'>, dealId: string, folder: string) => {
    if (!(await c.query('SELECT 1 FROM doc_folder WHERE id = $1 AND deal_id = $2', [folder, dealId])).rowCount)
      throw new Refused('That folder is not part of this deal.')
  }

  const addFile = async (req: FastifyRequest<Route>, reply: FastifyReply) => {
    const id = Uuid.parse(req.params.id)
    const kind = z.enum(['legal', 'deck']).parse(req.query.kind)
    const name = Name.parse(req.query.name)
    const folder = req.query.folder ? Uuid.parse(req.query.folder) : null
    const data = req.body
    if (!Buffer.isBuffer(data) || !data.length) return reply.code(400).send({ error: 'send the file as raw bytes' })
    const judged = judgeDealFile(kind, data)
    if (!judged.ok) return reply.code(judged.status).send({ error: judged.error })
    // before the adapters are chosen: a switch to the real mode while this runs means a fake scanner and sandbox storage handled it
    const epoch = await instanceEpoch(d.db)
    // before the scan and the storage: nothing is done for someone who may not add to this deal
    await lead(req.user!, id, async (_c, deal) => {
      if (!d.canEdit(deal.state)) throw new Refused('This deal can no longer be edited here.')
    })
    const a = await d.adapters()
    if (!(await a.scanner.scan(data)).clean) return reply.code(422).send({ error: 'this file did not pass the virus check' })
    // decision R26: investors get a PDF with a warning cover, so a PDF that cannot take one is refused now, while the lead
    // can still replace it, rather than found unreadable after launch (Codex round 4)
    if (judged.contentType === 'application/pdf' && !(await withWarningCover(data, 'check', 'check')))
      return reply.code(422).send({ error: 'This PDF cannot be read in full. Save it again as a standard PDF and upload that.' })
    const fileId = randomUUID()
    const sealed = d.k.encrypt(data)
    const key = `deal/${id}/${fileId}`
    try {
      await a.storage.put(key, sealed.ciphertext)
    } catch (e) {
      if (e instanceof StorageFull) return reply.code(507).send({ error: e.message })
      throw e
    }
    try {
      await lead(req.user!, id, async (c, deal) => {
        if ((await instanceEpoch(c)) !== epoch) throw new Refused('The instance changed while this file was being added. Add it again.')
        if (!d.canEdit(deal.state)) throw new Refused('This deal can no longer be edited here.')
        if (folder) await folderInDeal(c, id, folder)
        const held = (
          await c.query<{ n: string }>("SELECT count(*) AS n FROM stored_file WHERE scope = 'deal_shared' AND owner_id = $1 AND removed_at IS NULL", [id])
        ).rows[0]!
        if (Number(held.n) >= MAX_DEAL_FILES) throw new Refused(`A deal can hold at most ${MAX_DEAL_FILES} files.`)
        const mine = // removed files too, as for entity files: nothing frees their storage yet, so uploading and deleting must not be free
          (
            await c.query<{ bytes: string }>(
              "SELECT coalesce(sum(size_bytes), 0) AS bytes FROM stored_file WHERE uploaded_by = $1 AND created_at >= coalesce((SELECT real_since FROM instance_profile WHERE id = 1), '-infinity'::timestamptz)",
              [req.user!.id],
            )
          ).rows[0]!
        if (Number(mine.bytes) + data.length > USER_BYTES_LIMIT) throw new Refused('You have too many files.')
        // one pitch deck at a time: a new one replaces the last
        if (kind === 'deck')
          await c.query(
            "UPDATE stored_file SET removed_at = now() WHERE scope = 'deal_shared' AND owner_id = $1 AND requirement = 'deck' AND removed_at IS NULL",
            [id],
          )
        await c.query(
          'INSERT INTO stored_file (id, scope, owner_id, requirement, display_name, content_type, sha256, size_bytes, scan_status, storage_key, key_id, wrapped_key, uploaded_by, folder_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
          [
            fileId,
            'deal_shared',
            id,
            kind,
            name,
            judged.contentType,
            createHash('sha256').update(data).digest('hex'),
            data.length,
            'clean',
            key,
            sealed.keyId,
            sealed.wrappedDek,
            req.user!.id,
            folder,
          ],
        )
        await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.file_added', entity: fileId })
        await changed(c, deal, req.user!.id)
      })
    } catch (e) {
      // without its row nothing could ever find this file again
      await a.storage.delete(key).catch(() => undefined)
      throw e
    }
    return { id: fileId }
  }

  // raw bytes; the parser exists only in this scope
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: LEGAL_LIMIT_BYTES }, (_r, body, done) => done(null, body))
    scope.post<Route>(
      '/api/deals/:id/files',
      {
        ...verified,
        bodyLimit: LEGAL_LIMIT_BYTES,
        // before the body is read: a stranger must not be able to make the server hold 100 MB
        onRequest: async (req, reply) => {
          const who = await sessionUser(d.db, d.k, req.cookies[SESSION])
          if (!who) return reply.code(401).send({ error: 'not signed in' })
          if (!GATES.verified(who)) return reply.code(403).send({ error: 'not allowed' })
          // before the body is read: nothing is held for someone who cannot add to this deal
          const deal = Uuid.safeParse(req.params.id)
          const held = deal.success ? await d.partiesFor(deal.data) : null
          if (!held || !held.parties.leadUserIds.includes(who.id)) return reply.code(409).send({ error: 'Deal not found.' })
          if (!d.canEdit(held.state)) return reply.code(409).send({ error: 'This deal can no longer be edited here.' })
          const bytes = Number(req.headers['content-length'])
          if (!Number.isSafeInteger(bytes) || bytes <= 0) return reply.code(411).send({ error: 'say how large the file is' })
          // no limit on how many: a deal can need 200 files. Slots and the byte limits are what protect the server
          if (!holds.hold(req, reply, who.id, bytes)) return reply.code(429).send({ error: 'too many uploads at once, try again in a moment' })
        },
      },
      async (req, reply) => holds.work(req, reply, () => addFile(req, reply)),
    )
  })

  app.post<{ Params: { id: string } }>('/api/deals/:id/folders', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const body = z.strictObject({ name: Name, parent_id: Uuid.nullable().optional() }).parse(req.body)
    return lead(req.user!, id, async (c, deal) => {
      if (!d.canEdit(deal.state)) throw new Refused('This deal can no longer be edited here.')
      if (body.parent_id) await folderInDeal(c, id, body.parent_id)
      const folder = randomUUID()
      await c.query('INSERT INTO doc_folder (id, deal_id, parent_id, name) VALUES ($1, $2, $3, $4)', [folder, id, body.parent_id ?? null, body.name])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.folder_added', entity: folder })
      return { id: folder }
    })
  })

  app.delete<{ Params: { id: string; file: string } }>('/api/deals/:id/files/:file', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const file = Uuid.parse(req.params.file)
    return lead(req.user!, id, async (c, deal) => {
      if (!d.canEdit(deal.state)) throw new Refused('This deal can no longer be edited here.')
      const r = await c.query("UPDATE stored_file SET removed_at = now() WHERE id = $1 AND owner_id = $2 AND scope = 'deal_shared' AND removed_at IS NULL", [
        file,
        id,
      ])
      if (!r.rowCount) throw new Refused(NO_FILE)
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.file_removed', entity: file })
      await changed(c, deal, req.user!.id)
      return { ok: true }
    })
  })

  // decided on every download; never the file of another deal, and never through the KYC route
  app.get<{ Params: { id: string; file: string } }>('/api/deals/:id/files/:file', verified, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const file = Uuid.parse(req.params.file)
    const who = req.user!
    const held = await d.partiesFor(id)
    const runsIt = !!held && canAdministerDeal(who, held.parties)
    // staff with a stake are no different from anyone else, and nobody at the operator reads a draft that was never submitted
    const staff = !!held && held.state !== 'draft' && (canReviewDeal(who, who.email, held.parties) || canApproveDealContent(who, who.email, held.parties))
    if (!held || (!runsIt && !staff)) return reply.code(404).send({ error: NO_FILE })
    const f = (
      await d.db.query<{ content_type: string; storage_key: string; key_id: string; wrapped_key: Buffer; size_bytes: string }>(
        "SELECT content_type, storage_key, key_id, wrapped_key, size_bytes FROM stored_file WHERE id = $1 AND owner_id = $2 AND scope = 'deal_shared' AND removed_at IS NULL",
        [file, id],
      )
    ).rows[0]
    if (!f) return reply.code(404).send({ error: NO_FILE })
    const send = async () => {
      const sealed = await (await d.adapters()).storage.get(f.storage_key)
      if (!sealed) return reply.code(404).send({ error: NO_FILE })
      if (!runsIt) await tx(d.db, (c) => appendAudit(c, d.k, { actor: who.id, action: 'deal.file_viewed', entity: file }))
      return reply
        .header('content-disposition', 'attachment; filename="document"')
        .type(f.content_type)
        .send(d.k.decrypt(f.key_id, f.wrapped_key, sealed))
    }
    // the sealed copy and the opened one are both in memory until the file has gone
    return downloads.work(req, reply, send, who.id, 2 * Number(f.size_bytes))
  })
}
