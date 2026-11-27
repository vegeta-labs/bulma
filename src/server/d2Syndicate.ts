// Syndicates: pages, members, member links, and who is on a deal (R-SYN-01, R-SYN-03 to R-SYN-07).
import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { validRichText } from '../lib/richText.ts'
import { appendAudit } from '../store/audit.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { reserveAttempt, sessionStillLive, type SessionUser } from './auth.ts'
import type { MailQueue } from './outbox.ts'
import { Refused } from './requests.ts'
import { demoRunOfUser } from './demo.ts'
import { DEMO_APART, sameDemoSide } from '../lib/demo.ts'

type Q = Pick<Tx, 'query'>
type Role = 'admin' | 'deal_member'

export interface SyndicateDeps {
  db: Db
  k: Keyring
  linkTo: (path: string) => string
  mail: MailQueue
  leadTx: <T>(
    who: SessionUser,
    id: string,
    fn: (
      c: Tx,
      deal: {
        id: string
        state: string
        public_code: string
        syndicate_id: string | null
        lead_user: string
        draft: { basics?: { syndicate?: { mode?: string; id?: string } } }
      },
    ) => Promise<T>,
  ) => Promise<T>
}

const Uuid = z.uuid()
const NOT_FOUND = 'Syndicate not found.'
const RoleBody = z.enum(['admin', 'deal_member'])
const Name = z.string().trim().min(1).max(200)
const inviteHash = (k: Keyring, t: string) => k.hmac(`syndicate-invite\0${t}`)
const roleIn = async (q: Q, syndicate: string, user: string) =>
  (await q.query<{ role: Role }>('SELECT role FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [syndicate, user])).rows[0]?.role ?? null
const adminCount = async (q: Q, syndicate: string) =>
  Number((await q.query<{ n: string }>("SELECT count(*) AS n FROM syndicate_member WHERE syndicate_id = $1 AND role = 'admin'", [syndicate])).rows[0]!.n)

const leadsADeal = async (q: Q, syndicate: string, user: string) =>
  !!(
    await q.query("SELECT 1 FROM deal WHERE syndicate_id = $1 AND lead_user = $2 AND deleted_at IS NULL AND state NOT IN ('rejected') LIMIT 1", [
      syndicate,
      user,
    ])
  ).rowCount

export const dealTeam = async (q: Q, dealId: string) =>
  (
    await q.query(
      'SELECT m.user_id, m.role, u.name FROM deal_member m JOIN user_account u ON u.id = m.user_id WHERE m.deal_id = $1 ORDER BY m.created_at, m.user_id',
      [dealId],
    )
  ).rows

export function registerSyndicates(app: FastifyInstance, d: SyndicateDeps) {
  const verified = { config: { gate: 'verified' as const } }

  /** Again after waiting for a lock: a session ended meanwhile must count as ended. */
  const stillLive = async (c: Tx, who: SessionUser) => {
    if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
  }

  const liveTx = <T>(who: SessionUser, fn: (c: Tx) => Promise<T>) =>
    tx(d.db, async (c) => {
      await c.query('SELECT 1 FROM instance_profile WHERE id = 1 FOR SHARE')
      if (!(await sessionStillLive(c, who.sessionHmac, who.id))) throw new Refused('Your session has ended.')
      return fn(c)
    })

  /** An admin's change. The syndicate row is held, so two admins cannot each remove the other and leave none. */
  const adminTx = <T>(who: SessionUser, id: string, fn: (c: Tx, status: string) => Promise<T>) =>
    liveTx(who, async (c) => {
      const s = (await c.query<{ status: string }>('SELECT status FROM syndicate WHERE id = $1 FOR UPDATE', [id])).rows[0]
      await stillLive(c, who)
      if (!s || (await roleIn(c, id, who.id)) !== 'admin') throw new Refused(NOT_FOUND)
      return fn(c, s.status)
    })
  const mustBeActive = (status: string) => {
    if (status !== 'active') throw new Refused('This syndicate is archived.')
  }

  app.post('/api/syndicates', verified, async (req) => {
    const body = z.strictObject({ name: Name, lead_entity_id: Uuid }).parse(req.body)
    return liveTx(req.user!, async (c) => {
      if (
        !(
          await c.query(
            `SELECT 1 FROM legal_entity WHERE id = $1 AND owner_user = $2 AND created_at >= coalesce((SELECT real_since FROM instance_profile WHERE id = 1), '-infinity'::timestamptz)`,
            [body.lead_entity_id, req.user!.id],
          )
        ).rowCount
      )
        throw new Refused('Choose one of your own entities as the lead entity.')
      const id = randomUUID()
      const slug = `${
        body.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || 'syndicate'
      }-${randomBytes(3).toString('hex')}`
      await c.query('INSERT INTO syndicate (id, name, slug, lead_entity, created_by) VALUES ($1, $2, $3, $4, $5)', [
        id,
        body.name,
        slug,
        body.lead_entity_id,
        req.user!.id,
      ])
      await c.query("INSERT INTO syndicate_member (syndicate_id, user_id, role) VALUES ($1, $2, 'admin')", [id, req.user!.id])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'syndicate.created', entity: id })
      return { id }
    })
  })

  app.get('/api/syndicates', verified, async (req) => {
    const rows = (
      await d.db.query<{ id: string; name: string; status: string; role: Role }>(
        'SELECT s.id, s.name, s.status, m.role FROM syndicate s JOIN syndicate_member m ON m.syndicate_id = s.id WHERE m.user_id = $1 ORDER BY s.name, s.id',
        [req.user!.id],
      )
    ).rows
    return { managed: rows.filter((r) => r.role === 'admin'), joined: rows.filter((r) => r.role !== 'admin') }
  })

  app.get<{ Params: { id: string } }>('/api/syndicates/:id', verified, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    const role = await roleIn(d.db, id, req.user!.id)
    const s = (
      await d.db.query<{ id: string; name: string; thesis: unknown; status: string }>('SELECT id, name, thesis, status FROM syndicate WHERE id = $1', [id])
    ).rows[0]
    if (!s || !role) return reply.code(404).send({ error: NOT_FOUND })
    const team = (
      await d.db.query(
        'SELECT m.user_id, m.role, u.name FROM syndicate_member m JOIN user_account u ON u.id = m.user_id WHERE m.syndicate_id = $1 ORDER BY m.created_at, m.user_id',
        [id],
      )
    ).rows
    // R-SYN-06: an admin sees every deal; a deal member only those assigned
    const deals = (
      await d.db.query(
        `SELECT d.id, d.state, d.public_code, d.draft->'basics'->>'name' AS name FROM deal d
       WHERE d.syndicate_id = $1 AND d.deleted_at IS NULL AND ($3 OR EXISTS (SELECT 1 FROM deal_member m WHERE m.deal_id = d.id AND m.user_id = $2)) ORDER BY d.created_at DESC, d.id`,
        [id, req.user!.id, role === 'admin'],
      )
    ).rows
    return { ...s, role, team, deals, can_start_deal: role === 'admin' && s.status === 'active' }
  })

  app.put<{ Params: { id: string } }>('/api/syndicates/:id', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const body = z.strictObject({ name: Name, thesis: z.unknown().optional() }).parse(req.body)
    if (body.thesis !== undefined && body.thesis !== null && !validRichText(body.thesis))
      throw new Refused('The investment thesis contains formatting that is not allowed.')
    return adminTx(req.user!, id, async (c, status) => {
      mustBeActive(status)
      await c.query('UPDATE syndicate SET name = $2, thesis = $3 WHERE id = $1', [
        id,
        body.name,
        body.thesis === undefined || body.thesis === null ? null : JSON.stringify(body.thesis),
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'syndicate.updated', entity: id })
      return { ok: true }
    })
  })

  app.post<{ Params: { id: string } }>('/api/syndicates/:id/archive', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    return adminTx(req.user!, id, async (c) => {
      if ((await c.query('SELECT 1 FROM deal WHERE syndicate_id = $1 AND deleted_at IS NULL LIMIT 1', [id])).rowCount)
        throw new Refused('A syndicate with deals cannot be archived.')
      await c.query("UPDATE syndicate SET status = 'archived' WHERE id = $1", [id])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'syndicate.archived', entity: id })
      return { ok: true }
    })
  })

  // R-SYN-04: the link is returned for a person to read and copy; nothing here or on the screen writes to the clipboard
  app.post<{ Params: { id: string } }>('/api/syndicates/:id/invites', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const { role } = z.strictObject({ role: RoleBody }).parse(req.body)
    return adminTx(req.user!, id, async (c, status) => {
      mustBeActive(status)
      const invite = randomUUID()
      const token = randomBytes(32).toString('base64url')
      await c.query('INSERT INTO member_invite (id, syndicate_id, token_hmac, role, created_by) VALUES ($1, $2, $3, $4, $5)', [
        invite,
        id,
        inviteHash(d.k, token),
        role,
        req.user!.id,
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'syndicate.invite_created', entity: invite })
      return { id: invite, role, link: d.linkTo(`/join-syndicate?token=${token}`) }
    })
  })

  app.get<{ Params: { id: string } }>('/api/syndicates/:id/invites', verified, async (req, reply) => {
    const id = Uuid.parse(req.params.id)
    if ((await roleIn(d.db, id, req.user!.id)) !== 'admin') return reply.code(404).send({ error: NOT_FOUND })
    return {
      invites: (
        await d.db.query('SELECT id, role, created_at FROM member_invite WHERE syndicate_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id', [id])
      ).rows,
    }
  })

  app.post<{ Params: { id: string; invite: string } }>('/api/syndicates/:id/invites/:invite/revoke', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const invite = Uuid.parse(req.params.invite)
    return adminTx(req.user!, id, async (c) => {
      const r = await c.query('UPDATE member_invite SET revoked_at = now() WHERE id = $1 AND syndicate_id = $2 AND revoked_at IS NULL', [invite, id])
      if (!r.rowCount) throw new Refused('That link is not active.')
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'syndicate.invite_revoked', entity: invite })
      return { ok: true }
    })
  })

  app.post('/api/syndicate-invites/accept', verified, async (req, reply) => {
    const { token } = z.strictObject({ token: z.string().min(20).max(200) }).parse(req.body)
    const result = await liveTx(req.user!, async (c) => {
      // the lock first, then a fresh read: a statement that waits for a lock still sees the link as it was when it started
      await c.query('SELECT 1 FROM syndicate s JOIN member_invite i ON i.syndicate_id = s.id WHERE i.token_hmac = $1 FOR UPDATE OF s', [inviteHash(d.k, token)])
      await stillLive(c, req.user!)
      const inv = (
        await c.query<{ id: string; syndicate_id: string; role: Role; status: string }>(
          'SELECT i.id, i.syndicate_id, i.role, s.status FROM member_invite i JOIN syndicate s ON s.id = i.syndicate_id WHERE i.token_hmac = $1 AND i.revoked_at IS NULL',
          [inviteHash(d.k, token)],
        )
      ).rows[0]
      if (!inv || inv.status !== 'active') return null
      const syndicateRun = (await c.query<{ demo_run: string | null }>('SELECT demo_run FROM syndicate WHERE id = $1', [inv.syndicate_id])).rows[0]!.demo_run
      if (!sameDemoSide(syndicateRun, await demoRunOfUser(c, req.user!.id))) throw new Refused(DEMO_APART)
      // someone already in keeps the role they have: a link never changes it
      await c.query('INSERT INTO syndicate_member (syndicate_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (syndicate_id, user_id) DO NOTHING', [
        inv.syndicate_id,
        req.user!.id,
        inv.role,
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'syndicate.joined', entity: inv.syndicate_id })
      return { syndicate_id: inv.syndicate_id }
    })
    if (result) return result
    const allowed = await reserveAttempt(d.db, [d.k.hmac(`syndicate-invite-user\0${req.user!.id}`)])
    return reply.code(allowed ? 404 : 429).send({ error: 'This link is not valid.' })
  })

  app.put<{ Params: { id: string; user: string } }>('/api/syndicates/:id/members/:user', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const user = Uuid.parse(req.params.user)
    const { role } = z.strictObject({ role: RoleBody }).parse(req.body)
    return adminTx(req.user!, id, async (c) => {
      const current = await roleIn(c, id, user)
      if (!current) throw new Refused('That person is not a member.')
      if (current === 'admin' && role !== 'admin' && (await adminCount(c, id)) <= 1) throw new Refused('A syndicate must keep at least one admin.')
      // only an admin can run a deal in a syndicate: demoted, the person would be left with a deal that can never be saved
      if (current === 'admin' && role !== 'admin' && (await leadsADeal(c, id, user))) throw new Refused('This person leads a deal in the syndicate.')
      await c.query('UPDATE syndicate_member SET role = $3 WHERE syndicate_id = $1 AND user_id = $2', [id, user, role])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'syndicate.role_changed', entity: user })
      return { ok: true }
    })
  })

  app.delete<{ Params: { id: string; user: string } }>('/api/syndicates/:id/members/:user', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const user = Uuid.parse(req.params.user)
    const remove = async (c: Tx) => {
      const current = await roleIn(c, id, user)
      if (!current) throw new Refused('That person is not a member.')
      if (current === 'admin' && (await adminCount(c, id)) <= 1) throw new Refused('A syndicate must keep at least one admin.')
      if (await leadsADeal(c, id, user)) throw new Refused('This person leads a deal in the syndicate.')
      await c.query(
        `DELETE FROM deal_member WHERE user_id = $2 AND deal_id IN (SELECT id FROM deal WHERE syndicate_id = $1 OR draft->'basics'->'syndicate'->>'id' = $1::text)`,
        [id, user],
      )
      await c.query('DELETE FROM syndicate_member WHERE syndicate_id = $1 AND user_id = $2', [id, user])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'syndicate.member_removed', entity: user })
      return { ok: true }
    }
    // anyone may leave; removing someone else takes an admin
    if (user !== req.user!.id) return adminTx(req.user!, id, (c) => remove(c))
    return liveTx(req.user!, async (c) => {
      // someone not in it gets the same answer as for a syndicate that does not exist
      const exists = (await c.query('SELECT 1 FROM syndicate WHERE id = $1 FOR UPDATE', [id])).rowCount
      await stillLive(c, req.user!)
      if (!exists || !(await roleIn(c, id, user))) throw new Refused(NOT_FOUND)
      return remove(c)
    })
  })

  // R-SYN-06, R-SYN-07: who works on a deal must already be in its syndicate
  app.put<{ Params: { id: string; user: string } }>('/api/deals/:id/members/:user', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const user = Uuid.parse(req.params.user)
    const { role } = z.strictObject({ role: z.enum(['member', 'co_lead']) }).parse(req.body)
    await d.leadTx(req.user!, id, async (c, deal) => {
      const syndicate = deal.syndicate_id ?? (deal.draft.basics?.syndicate?.mode === 'existing' ? deal.draft.basics.syndicate.id : undefined)
      if (!syndicate) throw new Refused('Choose an existing syndicate first, or add people once the deal is submitted.')
      if (user === deal.lead_user) throw new Refused('That person already leads this deal.')
      // held so that a removal happening now finishes first, or waits until this person is on the deal and takes them off
      await c.query('SELECT 1 FROM syndicate WHERE id = $1 FOR SHARE', [syndicate])
      // a draft only names a syndicate; nothing has checked that its author runs it
      if (!deal.syndicate_id && (await roleIn(c, syndicate, req.user!.id)) !== 'admin') throw new Refused('Choose a syndicate you manage.')
      if (!(await roleIn(c, syndicate, user))) throw new Refused('Only a member of the syndicate can be added to its deal.')
      await c.query('INSERT INTO deal_member (deal_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (deal_id, user_id) DO UPDATE SET role = EXCLUDED.role', [
        id,
        user,
        role,
      ])
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.member_set', entity: user })
      // R-DRF-11: a co-lead on a draft hears at submission instead
      if (role !== 'co_lead' || deal.state === 'draft') return null
      const told = await c.query(
        "UPDATE deal_member SET notified_at = now() WHERE deal_id = $1 AND user_id = $2 AND role = 'co_lead' AND notified_at IS NULL",
        [id, user],
      )
      if (!told.rowCount) return
      const to = (await c.query<{ email: string }>('SELECT email FROM user_account WHERE id = $1', [user])).rows[0]!.email
      await d.mail.queue(c, { audience: { kind: 'lead', userId: user, dealId: id }, to, subject: 'You are a co-lead on a deal', body: 'You have been added as a co-lead. You can see the deal in your list of deals.' })
    })
    await d.mail.flush()
    return { ok: true }
  })

  app.delete<{ Params: { id: string; user: string } }>('/api/deals/:id/members/:user', verified, async (req) => {
    const id = Uuid.parse(req.params.id)
    const user = Uuid.parse(req.params.user)
    return d.leadTx(req.user!, id, async (c) => {
      const r = await c.query('DELETE FROM deal_member WHERE deal_id = $1 AND user_id = $2', [id, user])
      if (!r.rowCount) throw new Refused('That person is not on this deal.')
      await appendAudit(c, d.k, { actor: req.user!.id, action: 'deal.member_removed', entity: user })
      return { ok: true }
    })
  })
}
