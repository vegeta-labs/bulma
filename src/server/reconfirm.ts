// D4 chunk 7b: reading a reconfirmation (PRD §5.3). The rules are in lib/deadline.ts; this file reads the facts they need.
import { deadlineState, statementPauses, type Cover, type DeadlineState } from '../lib/deadline.ts'
import { freeze, REAL_SINCE, type FrozenTerms, type LinkRow, type Q } from './d3Core.ts'

export interface ReconfirmRow {
  id: string
  participation_id: string
  change_id: string
  deal_id: string
  deal_version: number
  compared_to: number
  resign: boolean
  /** The set of one person's terms to agree to, and the one last agreed (`invitation_terms.n`). */
  terms_n: number
  terms_compared_to: number
  days: number
  state: string
  started_at: Date
}

/** The one reconfirmation still waiting for this participation, if any; `lock` holds it for an answer. */
export async function pendingReconfirmation(c: Q, pid: string, lock = false): Promise<ReconfirmRow | null> {
  const r = await c.query<ReconfirmRow>(
    `SELECT id, participation_id, change_id, deal_id, deal_version, compared_to, resign, terms_n, terms_compared_to, days, state, started_at FROM reconfirmation
      WHERE participation_id = $1 AND state = 'pending'${lock ? ' FOR UPDATE' : ''}`,
    [pid],
  )
  return r.rows[0] ?? null
}

/**
 * The times a valid statement under this regime covered the person: each one that qualifies, from when it was made until it runs
 * out or a newer statement (qualifying or not) takes its place. Only statements since the switch to real count (R13).
 */
export async function statementCovers(c: Q, userId: string, regime: string): Promise<Cover[]> {
  const rows = (
    await c.query<{ created_at: Date; expires_at: Date; qualifies: boolean }>(
      `SELECT created_at, expires_at, qualifies FROM eligibility_statement WHERE user_id = $1 AND regime = $2 AND created_at >= ${REAL_SINCE}
        ORDER BY created_at, id`,
      [userId, regime],
    )
  ).rows
  const out: Cover[] = []
  rows.forEach((r, i) => {
    if (!r.qualifies) return
    const next = rows[i + 1]
    const end = next && next.created_at < r.expires_at ? next.created_at : r.expires_at
    out.push({ from: new Date(r.created_at), to: new Date(end) })
  })
  return out
}

/** §5.3: where the person's clock stands now: open with a deadline, paused while their statement has run out, or lapsed. */
export async function reconfirmClock(c: Q, rc: ReconfirmRow, userId: string, regime: string, now: Date): Promise<DeadlineState> {
  const start = new Date(rc.started_at)
  return deadlineState({ start, days: rc.days, pauses: statementPauses(await statementCovers(c, userId, regime), start, now), now })
}

/** §5.3: the person's pending reconfirmation is past its deadline with no answer ("no response"). */
export async function reconfirmLapsed(c: Q, pid: string, regime: string, now: Date): Promise<boolean> {
  const rc = await pendingReconfirmation(c, pid)
  if (!rc) return false
  const user = (await c.query<{ user_id: string }>('SELECT user_id FROM participation WHERE id = $1', [pid])).rows[0]!.user_id
  return (await reconfirmClock(c, rc, user, regime, now)).state === 'lapsed'
}

/** The set of terms an invitation had as number n; with no change ever made, the set frozen at the first commitment is the only one. */
export async function termsAt(c: Q, invitationId: string, n: number): Promise<FrozenTerms> {
  const r = await c.query<{ terms: FrozenTerms }>('SELECT terms FROM invitation_terms WHERE invitation_id = $1 AND n = $2', [invitationId, n])
  if (r.rows[0]) return r.rows[0].terms
  return (await c.query<{ terms_snapshot: FrozenTerms }>('SELECT terms_snapshot FROM deal_invitation WHERE id = $1', [invitationId])).rows[0]!.terms_snapshot
}

/** The number of the set of terms an invitation has now (0 until one person's terms are changed). */
export async function termsNow(c: Q, invitationId: string): Promise<number> {
  return (await c.query<{ n: number }>('SELECT coalesce(max(n), 0) AS n FROM invitation_terms WHERE invitation_id = $1', [invitationId])).rows[0]!.n
}

/** The terms an invitation has now: the latest set once someone committed, else its link's. */
export async function termsOfInvitation(c: Q, inv: { id: string; terms_snapshot: FrozenTerms | null; invite_link: string }): Promise<FrozenTerms> {
  if (inv.terms_snapshot) return termsAt(c, inv.id, await termsNow(c, inv.id))
  return freeze((await c.query<LinkRow>('SELECT * FROM invite_link WHERE id = $1', [inv.invite_link])).rows[0]!)
}
