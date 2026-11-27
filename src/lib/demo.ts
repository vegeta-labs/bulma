// Demo records and ordinary records stay apart (PRD R-DEMO-05, decision R30). A record's side is the demo run it belongs to,
// or none for an ordinary one: two records may meet only when they belong to the same run, or both to none.
import type { RegimePack } from './regimePack.ts'

/** The words for every refusal at the line: an invitation, a link, a commitment, a syndicate link. */
export const DEMO_APART = 'Demo records and ordinary records stay apart: this account cannot take part here.'

/** R-DEMO-05: whether two records (a person and a deal, a deal and a company, ...) are on the same side of the demo line. */
export const sameDemoSide = (a: string | null, b: string | null): boolean => a === b

/** Money is never moved across the line: unallocated money is ordinary, so demo money never goes there or comes from there. */
export const DEMO_MONEY_APART = 'Demo money and ordinary money stay apart: it cannot go there.'

/** A statement with people from both sides of the line: refused whole, so each import stays on one side. */
export const DEMO_RETIRED_STATEMENT = 'This statement has lines a removed demo deal already took. Upload a statement without them.'
export const DEMO_MIXED_STATEMENT = 'This statement has payments for demo deals and for ordinary deals. Import them as two separate files.'

/**
 * R-DEMO-05: the side of a bank statement, from the sides of the people its lines match: one side (none matched:
 * ordinary), or null when it matches both sides, or two demo runs.
 */
export function statementSide(matched: readonly (string | null)[]): { side: string | null } | null {
  const sides = [...new Set(matched)]
  if (sides.length > 1) return null
  return { side: sides[0] ?? null }
}

/** R-DEMO-07: the three texts a demo deal shows in place of the pack's placeholders, every variant of each. */
export const DEMO_PACK_TEXTS = {
  promotion_warning: 'Sample warning for the demo deal. Not legal text: the operator and its lawyers write the real one.',
  sender: 'Sample sender for the demo deal. Not legal text.',
  your_money: 'Sample note on where your money goes, for the demo deal. Not legal text: no money moves in the sandbox.',
} as const

/** The kept name of the demo pack for a regime; an upload can never take it (`isReservedPackKey`). */
export const demoPackKey = (regime: string) => `${regime}-demo-template`

/**
 * R-DEMO-07: the demo rules pack, made from the current pack so the regime, steps and questions are the ones the
 * investors qualified under. Only the three texts change, to short sample sentences still marked as placeholders, so the
 * real-mode checks refuse the pack as they refuse the template.
 */
export function demoPackContent(current: RegimePack, version: number): RegimePack {
  // the sender's wording is wherever the pack says it is; the warning and the money note have fixed keys
  const body = (key: string) =>
    key === 'promotion_warning' ? DEMO_PACK_TEXTS.promotion_warning : key === current.sender.name_text_key ? DEMO_PACK_TEXTS.sender : key === 'your_money' ? DEMO_PACK_TEXTS.your_money : null
  return {
    ...current,
    key: demoPackKey(current.regime),
    version,
    legal_texts: current.legal_texts.map((t) => {
      const b = body(t.text_key)
      return b === null ? t : { ...t, format: 'plain' as const, body: b, required_bold: [], is_placeholder: true }
    }),
  }
}
