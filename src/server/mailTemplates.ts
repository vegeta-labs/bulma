// R-NTF-01, R-CMP-02: the operator's wording for investor mail. An admin edits; an edited investor template makes that mail
// promotional, so it is sent only as approved, only to someone who passes that day, and with the warning first (R-COM-04).
// Urgent notices cannot be edited at all.
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { defaultTemplate, EDITABLE, INVESTOR_ACTIONS, templateKey, templateProblems, URGENT } from '../lib/mailContent.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { sessionStillLive } from './auth.ts'
import { REAL_SINCE } from './d3Core.ts'
import { adminTx, Refused, type Ctx } from './requests.ts'

type Q = Pick<Tx, 'query'>

export interface MailTemplateDeps {
  db: Db
  k: Keyring
}

/** What an approver approves: the subject and text together. */
export const templateSha = (subject: string, body: string) => createHash('sha256').update(JSON.stringify({ subject, body }), 'utf8').digest('hex')

const Key = z.string().min(1).max(60)

async function current(c: Q) {
  return (
    await c.query<{ key: string; version: number; subject: string | null; body: string | null; sha256: string | null; approved: boolean }>(
      `SELECT DISTINCT ON (t.key) t.key, t.version, t.subject, t.body, t.sha256,
              EXISTS (SELECT 1 FROM promotion_approval a WHERE a.subject_kind = 'template' AND a.subject_id = t.key || ':' || t.version AND a.content_sha256 = t.sha256 AND a.created_at >= ${REAL_SINCE}) AS approved
         FROM email_template t ORDER BY t.key, t.version DESC`,
    )
  ).rows
}

export function registerMailTemplates(app: FastifyInstance, d: MailTemplateDeps) {
  const x: Ctx = { db: d.db, k: d.k }
  const admin = { config: { gate: 'canAdministerInstance' as const } }
  const approver = { config: { gate: 'canApproveContent' as const } }

  app.get('/api/admin/mail-templates', admin, async () => {
    const rows = new Map((await current(d.db)).map((r) => [r.key, r]))
    return {
      templates: EDITABLE.map((action) => {
        const r = rows.get(templateKey(action))
        return {
          key: templateKey(action),
          action: INVESTOR_ACTIONS[action],
          fixed: defaultTemplate(action),
          // once edited, the mail is promotional: approved wording, sent only to someone who passes that day
          edited: r?.body ? { version: r.version, subject: r.subject, body: r.body, sha256: r.sha256, approved: r.approved } : null,
        }
      }),
      // shown so the operator can read them; never editable
      urgent: Object.entries(URGENT).map(([kind, u]) => ({ key: `urgent.${kind}`, subject: u.subject, line: u.line })),
    }
  })

  const Edit = z.union([z.strictObject({ subject: z.string().max(1000), body: z.string().max(20_000) }), z.strictObject({ reset: z.literal(true) })])

  app.put<{ Params: { key: string } }>('/api/admin/mail-templates/:key', admin, async (req) => {
    const key = Key.parse(req.params.key)
    const b = Edit.parse(req.body)
    const problems = 'reset' in b ? templateProblems(key, 'x', 'x') : templateProblems(key, b.subject, b.body)
    if (problems.length) throw new Refused(problems.join(' '))
    return adminTx(x, req.user!, async (c) => {
      const v = (await c.query<{ v: number }>('SELECT coalesce(max(version), 0) AS v FROM email_template WHERE key = $1', [key])).rows[0]!.v + 1
      const edit = 'reset' in b ? null : { subject: b.subject, body: b.body, sha256: templateSha(b.subject, b.body) }
      await c.query('INSERT INTO email_template (key, version, subject, body, sha256, edited_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        key,
        v,
        edit?.subject ?? null,
        edit?.body ?? null,
        edit?.sha256 ?? null,
        req.user!.id,
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: edit ? 'mail_template.edited' : 'mail_template.reset', entity: `${key}:${v}` })
      return { version: v, promotional: !!edit }
    })
  })

  app.get('/api/approvals/mail-templates', approver, async () => ({
    templates: (await current(d.db))
      .filter((r) => r.body)
      .map((r) => ({ key: r.key, version: r.version, subject: r.subject, body: r.body, sha256: r.sha256, approved: r.approved })),
  }))

  app.post<{ Params: { key: string; version: string } }>('/api/approvals/mail-templates/:key/:version', approver, async (req) => {
    const who = req.user!
    const key = Key.parse(req.params.key)
    const version = z.coerce.number().int().min(1).max(1_000_000).parse(req.params.version)
    const b = z
      .strictObject({
        content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        self_declared_name: z.string().trim().min(1).max(200),
        self_declared_frn: z
          .string()
          .regex(/^\d{6,7}$/)
          .nullable()
          .optional(),
      })
      .parse(req.body)
    return tx(d.db, async (c) => {
      await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      const ok = await c.query(
        "SELECT 1 FROM role_grant g JOIN user_account u ON u.id = g.user_id WHERE g.user_id = $1 AND g.role = 'approver' AND u.mfa_enabled_at IS NOT NULL",
        [who.id],
      )
      if (!ok.rowCount) throw new Refused('Only an approver can do this.')
      const t = (await c.query<{ sha256: string | null }>('SELECT sha256 FROM email_template WHERE key = $1 AND version = $2', [key, version])).rows[0]
      if (!t?.sha256) throw new Refused('No such wording to approve.')
      // what the approver read is what is approved
      if (t.sha256 !== b.content_sha256) throw new Refused('This wording has changed since you opened it. Open it again.')
      await c.query(
        "INSERT INTO promotion_approval (id, subject_kind, subject_id, approver_user, self_declared_name, self_declared_frn, approved_on, content_sha256) VALUES ($1, 'template', $2, $3, $4, $5, current_date, $6)",
        [randomUUID(), `${key}:${version}`, who.id, b.self_declared_name, b.self_declared_frn ?? null, t.sha256],
      )
      await appendAudit(c, d.k, { actor: who.id, action: 'mail_template.approved', entity: `${key}:${version}` })
      return { ok: true }
    })
  })
}
