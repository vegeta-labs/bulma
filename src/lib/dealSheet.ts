// What an investor sees and signs (PRD R-CMT-05, R-LNK-03, R-SIG-02, R-PAY-01). Pure: amounts in, words and figures out.
import { dueFor, type Due, type LinkFee } from './fees.ts'
import { fillText } from './regimePack.ts'
import type { FieldChange } from './snapshot.ts'

const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' }
/** An amount with its currency sign, exact to the penny: 1040000n reads "£10,400.00". */
export function money(minor: bigint, currency: string): string {
  const sign = minor < 0n ? '-' : ''
  const m = minor < 0n ? -minor : minor
  const whole = String(m / 100n).replace(/\B(?=(\d{3})+$)/g, ',')
  return `${sign}${SYMBOL[currency] ?? `${currency} `}${whole}.${String(m % 100n).padStart(2, '0')}`
}

/** Basis points as a percentage, by integer arithmetic: 400 reads "4.00%". */
export const percent = (bps: number) => `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`

export function feeWords(fee: LinkFee, currency: string): string {
  if (fee.kind === 'none') return 'No fee'
  const how = fee.mode === 'on_top' ? 'added on top of the commitment' : 'taken from the payment'
  return fee.kind === 'percent' ? `${percent(fee.bps)} ${how}` : `${money(fee.minor, currency)} ${how}`
}

/** The lead fee one person's terms change stores (JSON, amounts as `123n`), in the words the investor reads (R-CHG-05). */
function storedFeeWords(v: string | null, currency: string): string | null {
  if (v === null) return null
  let fee: Record<string, unknown> | null
  try {
    fee = JSON.parse(v, (_k, x: unknown) => (typeof x === 'string' && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x)) as Record<string, unknown> | null
  } catch {
    return v
  }
  if (fee?.kind === 'none') return feeWords({ kind: 'none' }, currency)
  // a record that is not whole is shown as stored, never half in words
  if (fee?.mode !== 'on_top' && fee?.mode !== 'deducted') return v
  if (fee.kind === 'percent' && Number.isInteger(fee.bps)) return feeWords({ kind: 'percent', bps: fee.bps as number, mode: fee.mode }, currency)
  if (fee.kind === 'fixed' && typeof fee.minor === 'bigint') return feeWords({ kind: 'fixed', minor: fee.minor, mode: fee.mode }, currency)
  return v
}

/** What a lead, reviewer or approver reads of stored differences: a lead fee as words, everything else as stored. */
export function changesInWords(changes: readonly FieldChange[], currency: string): FieldChange[] {
  return changes.map((ch) => (ch.field === 'lead_fee' ? { ...ch, before: storedFeeWords(ch.before, currency), after: storedFeeWords(ch.after, currency) } : ch))
}

export interface BreakdownLine {
  key: 'commitment' | 'total_commitment' | 'investment_part' | 'lead_fee' | 'rounding' | 'due'
  label: string
  minor: string
}

/**
 * R-CMT-05, R-LNK-03: the lines shown before committing, in generated files and in the consent record. Under the FPO pack the
 * amount to pay is the total commitment and the part invested is listed under it. The lines add up to the amount to pay.
 */
export function breakdown(commitment: bigint, fee: LinkFee, fpo: boolean): { due: Due; lines: BreakdownLine[] } {
  const d = dueFor(commitment, fee)
  const lines: BreakdownLine[] = []
  if (fpo) {
    lines.push({ key: 'investment_part', label: 'Investment part (before the platform fee)', minor: String(d.invest) })
  } else {
    lines.push({ key: 'commitment', label: 'Commitment', minor: String(commitment) })
    // taken from the payment: the commitment holds the fee, so what is invested is shown on its own
    if (fee.kind !== 'none' && fee.mode === 'deducted')
      lines.push({ key: 'investment_part', label: 'Of which invested (before the platform fee)', minor: String(d.invest) })
  }
  if (d.leadFee > 0n) lines.push({ key: 'lead_fee', label: 'Lead fee', minor: String(d.leadFee) })
  if (d.rounding > 0n) lines.push({ key: 'rounding', label: 'Rounding, returned at close', minor: String(d.rounding) })
  lines.push({ key: fpo ? 'total_commitment' : 'due', label: fpo ? 'Total commitment: the amount to pay' : 'Amount to pay', minor: String(d.due) })
  return { due: d, lines }
}

/** The lines that add up: for a commitment with the fee taken from the payment, the commitment line holds the fee already. */
export function linesAddUp(lines: readonly BreakdownLine[]): boolean {
  const last = lines.at(-1)!
  const parts = lines.filter(
    (l) =>
      l.key === 'investment_part' ||
      l.key === 'lead_fee' ||
      l.key === 'rounding' ||
      (l.key === 'commitment' && !lines.some((x) => x.key === 'investment_part')),
  )
  return parts.reduce((a, l) => a + BigInt(l.minor), 0n) === BigInt(last.minor)
}

export interface SheetValues {
  deal_code: string
  company_name: string
  instrument: string
  investor_name: string
  entity_name: string
  commitment: string
  investment_part: string
  lead_fee: string
  rounding: string
  breakdown: string
  amount_to_pay: string
  carry: string
  fee_terms: string
  reference: string
  date: string
  custom_terms: string
}

/**
 * The most text a deal sheet may have once filled in: the largest template (100,000) plus the largest custom terms, with room
 * for the figures. A template naming a long slot many times would otherwise expand without limit before any PDF limit applies.
 */
export const DEAL_SHEET_MAX_CHARS = 400_000

/** The length of the filled-in sheet, counted from the slots without building it (Codex round 9). */
export function dealSheetLength(template: string, v: SheetValues): number {
  let n = template.length
  for (const m of template.matchAll(/\{([a-z_]+)\}/g)) if (Object.hasOwn(v, m[1]!)) n += v[m[1]! as keyof SheetValues].length - m[0].length
  return n
}

/** "Signed by <name of up to 200> on <ISO time>", the line the signed PDF adds, with room to spare. */
export const SIGNED_LINE_MAX = 300

/**
 * The signed PDF draws the warning lead, the sheet and the signature line. A sheet is offered for signing only when all of
 * it fits the PDF limit, so nothing is signed that cannot then be downloaded (Codex round 11).
 */
export function signedSheetFits(lead: string, body: string, pdfMax: number): boolean {
  return lead.length + body.length + SIGNED_LINE_MAX <= pdfMax
}

/**
 * R-SIG-02: the operator's template with this investor's figures. Unknown slots stay as written, so a gap is visible.
 * R-DRF-04: approved custom terms are always in the sheet: in their slot if the template has one, else added at the end.
 * Null when the whole sheet, the added terms included, would be longer than DEAL_SHEET_MAX_CHARS (Codex round 10).
 */
export function renderDealSheet(template: string, v: SheetValues): string | null {
  const added = v.custom_terms && !template.includes('{custom_terms}') ? `\n\nCustom terms of this deal:\n${v.custom_terms}` : ''
  return dealSheetLength(template, v) + added.length > DEAL_SHEET_MAX_CHARS ? null : fillText(template, { ...v }) + added
}
