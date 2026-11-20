// R-NTF-01: the reminders. Hourly, each due reminder is queued in a transaction that holds what it is about and records it,
// so it is queued once. The queue decides again before it sends (R-NTF-02): a reminder never goes once the step is done, or
// while the deal is paused.
import { randomUUID } from 'node:crypto'
import { commitReminderDue, endOfDay, periodicReminderDue } from '../lib/mailContent.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { approvedSnapshot, dealById, dealGateFacts, heldMinor, packOf, policyNow } from './d3Core.ts'
import { pendingReconfirmation, reconfirmClock } from './reconfirm.ts'
import { activeHold } from '../lib/gate.ts'
import type { MailQueue } from './outbox.ts'
import type { Keyring } from '../store/crypto.ts'
import { openProposal } from './allocation.ts'

type Q = Pick<Tx, 'query'>

export interface ReminderDeps {
  db: Db
  now: () => Date
  mail: MailQueue
  /** With the keyring the run also ends proposed amounts past their deadline (R-ALO-01), which writes the audit. */
  k?: Keyring
}

const remindedSince = async (c: Q, kind: string, aboutId: string, since: Date) =>
  Number(
    (
      await c.query<{ n: string }>('SELECT count(*) AS n FROM mail_reminder WHERE kind = $1 AND about_id = $2 AND created_at >= $3::timestamptz', [
        kind,
        aboutId,
        since.toISOString(),
      ])
    ).rows[0]!.n,
  )
const lastReminded = async (c: Q, kind: string, aboutId: string, since: Date) =>
  (
    await c.query<{ at: Date | null }>('SELECT max(created_at) AS at FROM mail_reminder WHERE kind = $1 AND about_id = $2 AND created_at >= $3::timestamptz', [
      kind,
      aboutId,
      since.toISOString(),
    ])
  ).rows[0]!.at
const record = (c: Q, kind: string, aboutId: string, at: Date) =>
  c.query('INSERT INTO mail_reminder (id, kind, about_id, created_at) VALUES ($1, $2, $3, $4::timestamptz)', [randomUUID(), kind, aboutId, at.toISOString()])

/** A deal in a state where the step can be done, with no hold on it. */
async function dealOpen(c: Q, dealId: string, states: readonly string[]) {
  const deal = await dealById(c, dealId)
  if (!deal) return null
  const gate = await dealGateFacts(c, deal)
  return states.includes(gate.state) && !activeHold(gate.holds) ? deal : null
}

/** Queues every reminder due now. Returns how many. */
export async function runReminders(d: ReminderDeps): Promise<number> {
  const now = d.now()
  let n = 0
  const one = (fn: (c: Tx) => Promise<boolean>) => tx(d.db, fn).then((queued) => void (queued && n++))

  // a targeted invitation not yet opened: to the address it went to, counted from when it was (last) sent
  const invites = (
    await d.db.query<{ id: string }>(
      "SELECT t.id FROM targeted_invite t JOIN deal dl ON dl.id = t.deal_id WHERE t.revoked_at IS NULL AND t.consumed_at IS NULL AND dl.state = 'live'",
    )
  ).rows
  for (const { id } of invites)
    await one(async (c) => {
      const t = (
        await c.query<{ deal_id: string; email: string; last_sent_at: Date }>(
          'SELECT deal_id, email, last_sent_at FROM targeted_invite WHERE id = $1 AND revoked_at IS NULL AND consumed_at IS NULL FOR UPDATE',
          [id],
        )
      ).rows[0]
      if (!t || !(await dealOpen(c, t.deal_id, ['live']))) return false
      const count = (await policyNow(c)).reminderCount
      if (!commitReminderDue(new Date(t.last_sent_at), await remindedSince(c, 'commit_invite', id, new Date(t.last_sent_at)), count, now)) return false
      await record(c, 'commit_invite', id, now)
      await d.mail.investor(c, { action: 'commit_reminder', audience: { kind: 'invite', inviteId: id, dealId: t.deal_id }, to: t.email, dealId: t.deal_id })
      return true
    })

  // an invitation taken up but no commitment yet: the operator's count covers the reminders before and after it was opened
  const bound = (
    await d.db.query<{ id: string }>(
      `SELECT i.id FROM deal_invitation i JOIN deal dl ON dl.id = i.deal_id WHERE i.state = 'active' AND dl.state = 'live'
          AND NOT EXISTS (SELECT 1 FROM participation p WHERE p.invitation_id = i.id AND p.outcome = 'active')`,
    )
  ).rows
  for (const { id } of bound)
    await one(async (c) => {
      const i = (
        await c.query<{ deal_id: string; user_id: string; email: string; targeted_invite: string | null; created_at: Date; committed: boolean }>(
          `SELECT i.deal_id, i.user_id, u.email, i.targeted_invite, i.created_at,
                  EXISTS (SELECT 1 FROM participation p WHERE p.invitation_id = i.id) AS committed
             FROM deal_invitation i JOIN user_account u ON u.id = i.user_id WHERE i.id = $1 AND i.state = 'active' FOR UPDATE OF i`,
          [id],
        )
      ).rows[0]
      // someone who committed once and ended it has decided; no reminder brings them back
      if (!i || i.committed || !(await dealOpen(c, i.deal_id, ['live']))) return false
      const count = (await policyNow(c)).reminderCount
      const own = await remindedSince(c, 'commit', id, new Date(i.created_at))
      const before = i.targeted_invite ? await remindedSince(c, 'commit_invite', i.targeted_invite, new Date(0)) : 0
      if (before + own >= count || !commitReminderDue(new Date(i.created_at), own, count, now)) return false
      await record(c, 'commit', id, now)
      await d.mail.investor(c, {
        action: 'commit_reminder',
        audience: { kind: 'reminder', userId: i.user_id, dealId: i.deal_id, about: 'commit', aboutId: id },
        to: i.email,
        dealId: i.deal_id,
      })
      return true
    })

  // payment: valid instructions, money still owed, a payment deadline set; every so many days until it has passed
  const owing = (
    await d.db.query<{ id: string }>(
      `SELECT p.id FROM participation p JOIN deal dl ON dl.id = p.deal_id WHERE p.outcome = 'active' AND dl.state IN ('live', 'closing_requested', 'closing')
          AND EXISTS (SELECT 1 FROM issued_instruction i WHERE i.participation_id = p.id AND i.voided_at IS NULL)`,
    )
  ).rows
  for (const { id } of owing)
    await one(async (c) => {
      const p = (
        await c.query<{ deal_id: string; user_id: string; email: string; cash_due_minor: string; issued_at: Date }>(
          `SELECT p.deal_id, p.user_id, u.email, p.cash_due_minor, i.created_at AS issued_at FROM participation p JOIN user_account u ON u.id = p.user_id
             JOIN issued_instruction i ON i.participation_id = p.id AND i.voided_at IS NULL WHERE p.id = $1 AND p.outcome = 'active' FOR UPDATE OF p`,
          [id],
        )
      ).rows[0]
      if (!p) return false
      const deal = await dealOpen(c, p.deal_id, ['live', 'closing_requested', 'closing'])
      if (!deal || (await heldMinor(c, id)) >= BigInt(p.cash_due_minor)) return false
      const payBy = ((await approvedSnapshot(c, deal))?.snapshot.terms?.pay_by as string | undefined) ?? null
      const issued = new Date(p.issued_at)
      const every = (await policyNow(c)).reminderEveryDays
      if (!periodicReminderDue(issued, await lastReminded(c, 'payment', id, issued), every, payBy ? endOfDay(payBy) : null, now)) return false
      await record(c, 'payment', id, now)
      await d.mail.investor(c, {
        action: 'payment_reminder',
        audience: { kind: 'reminder', userId: p.user_id, dealId: p.deal_id, about: 'payment', aboutId: id },
        to: p.email,
        dealId: p.deal_id,
        deadline: payBy ?? undefined,
      })
      return true
    })
  // R-ALO-01: a proposed amount nobody answered ends at its deadline; the amount stays and the investor is told
  const k = d.k
  if (k) {
    const due = (
      await d.db.query<{ participation_id: string }>('SELECT participation_id FROM amount_proposal WHERE decision IS NULL AND deadline_at <= $1', [now])
    ).rows
    for (const { participation_id } of due) await one(async (c) => (await openProposal(c, { k, mail: d.mail, now: () => now }, participation_id)) === null)
  }
  // §5.3: a reconfirmation still waiting, every N days from when it was asked until its deadline; none while the clock is paused
  const asked = (await d.db.query<{ id: string }>("SELECT id FROM reconfirmation WHERE state = 'pending' ORDER BY started_at, id")).rows
  for (const { id } of asked)
    await one(async (c) => {
      const r = (
        await c.query<{ participation_id: string; deal_id: string; user_id: string; email: string }>(
          `SELECT r.participation_id, r.deal_id, p.user_id, u.email FROM reconfirmation r JOIN participation p ON p.id = r.participation_id
             JOIN user_account u ON u.id = p.user_id WHERE r.id = $1 AND r.state = 'pending' AND p.outcome = 'active' FOR UPDATE OF p`,
          [id],
        )
      ).rows[0]
      if (!r) return false
      const deal = await dealOpen(c, r.deal_id, ['live', 'closing_requested', 'closing'])
      const rc = await pendingReconfirmation(c, r.participation_id)
      if (!deal || !rc || rc.id !== id) return false
      const pack = await packOf(c, deal)
      if (!pack) return false
      const clock = await reconfirmClock(c, rc, r.user_id, pack.regime, now)
      if (clock.state !== 'open') return false
      const started = new Date(rc.started_at)
      const every = (await policyNow(c)).reminderEveryDays
      if (!periodicReminderDue(started, await lastReminded(c, 'reconfirm', id, started), every, clock.deadline, now)) return false
      await record(c, 'reconfirm', id, now)
      await d.mail.investor(c, {
        action: 'reconfirm_reminder',
        audience: { kind: 'reminder', userId: r.user_id, dealId: r.deal_id, about: 'reconfirm', aboutId: id },
        to: r.email,
        dealId: r.deal_id,
        // the deadline is the end of its last day, so the day shown is the one before midnight
        deadline: new Date(clock.deadline.getTime() - 1).toISOString().slice(0, 10),
      })
      return true
    })
  if (n) await d.mail.flush()
  return n
}

/** Every hour, one run at a time. */
export function startReminders(d: ReminderDeps, everyMs: number, onError: (code: string) => void): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    runReminders(d)
      .catch((e: { code?: string }) => onError(e?.code ?? 'unknown'))
      .finally(() => {
        running = false
      })
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
