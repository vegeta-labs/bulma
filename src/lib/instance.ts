// Instance mode rules (PRD R-OP-01, R-OP-02, R-OP-08). Pure: the server gathers the facts inside a transaction.
export type Mode = 'sandbox' | 'real'
export type RegulatoryStatus = 'authorised_firm' | 'unauthorised_relying_on_exemption' | 'appointed_representative'
export type InstanceRole = 'admin' | 'reviewer' | 'approver'

export interface Staff {
  userId: string
  roles: readonly InstanceRole[]
}

export interface SwitchFacts {
  regulatoryStatus: RegulatoryStatus | null
  accountablePerson: string | null
  accountableConfirmedOn: string | null
  today: string // YYYY-MM-DD
  placeholderTextKeys: readonly string[]
  paymentInstructionsConfigured: boolean
  paymentFileInvalid: boolean
  packFormatErrors: readonly string[]
  yourMoneyFilled: boolean
  staff: readonly Staff[]
}

export interface Blocker {
  code: string
  message: string
}

const has = (s: Staff, r: InstanceRole) => s.roles.includes(r)
const admins = (staff: readonly Staff[]) => staff.filter((s) => has(s, 'admin'))

/** R-OP-08: two admins and a reviewer, three different people. */
export function hasDistinctAdminsAndReviewer(staff: readonly Staff[]): boolean {
  const a = admins(staff)
  if (a.length < 2) return false
  // a reviewer who is no admin leaves any two admins free; otherwise a reviewer who is an admin needs two others
  return staff.some((r) => has(r, 'reviewer') && a.filter((x) => x.userId !== r.userId).length >= 2)
}

const realDate = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
}

/** Each thing missing for the real mode (R-OP-02). An empty list means the switch may go to a second admin. */
export function switchBlockers(f: SwitchFacts): Blocker[] {
  const out: Blocker[] = []
  if (!f.regulatoryStatus) out.push({ code: 'regulatory_status', message: 'Choose the regulatory status.' })
  if (f.regulatoryStatus === 'appointed_representative') {
    out.push({ code: 'appointed_representative', message: 'This version cannot be used for an appointed representative. You can still choose it to try the sandbox.' })
  }
  if (!f.accountablePerson?.trim()) out.push({ code: 'accountable_person', message: 'Name the operator accountable person.' })
  const on = f.accountableConfirmedOn
  if (!on || !realDate(on) || on > f.today) out.push({ code: 'accountable_confirmed_on', message: 'Give the date the operator accountable person confirmed; it cannot be in the future.' })
  if (f.placeholderTextKeys.length) out.push({ code: 'placeholder_texts', message: `Replace the placeholder legal text: ${f.placeholderTextKeys.join(', ')}.` })
  if (f.packFormatErrors.length) out.push({ code: 'pack_format', message: `The active pack no longer passes the format check: ${f.packFormatErrors.join('; ')}.` })
  if (f.paymentFileInvalid) out.push({ code: 'payment_instructions', message: 'The payment instructions file cannot be read or is not in the documented format.' })
  else if (!f.paymentInstructionsConfigured) out.push({ code: 'payment_instructions', message: 'Configure the payment instructions, with the account holder and its capacity.' })
  if (!f.yourMoneyFilled) out.push({ code: 'your_money', message: 'Fill in the "your money" panel.' })
  if (!f.staff.some((s) => has(s, 'approver'))) out.push({ code: 'approver', message: 'Add at least one promotion approver.' })
  if (!hasDistinctAdminsAndReviewer(f.staff)) out.push({ code: 'separation', message: 'The real mode needs two admins and a reviewer, three different people.' })
  return out
}

export interface ApprovalFacts {
  mode: Mode
  requestedBy: string
  approver: string
  adminCount: number
  approverIsAdmin: boolean
}

/** R-OP-08: a second admin approves; only a sandbox with exactly one admin may approve its own request. */
export function approvalRefusal(f: ApprovalFacts): string | null {
  if (!f.approverIsAdmin) return 'Only an admin can approve this.'
  if (f.approver !== f.requestedBy) return null
  if (f.mode === 'sandbox' && f.adminCount === 1) return null
  return 'A second admin must approve this.'
}

/** True when this approval is the sandbox's single-admin exception (recorded on the request). */
export const isSingleAdminException = (f: ApprovalFacts) => f.approverIsAdmin && f.approver === f.requestedBy && f.mode === 'sandbox' && f.adminCount === 1

/** A role change that would break R-OP-08: the last admin never goes; in the real mode the separation always holds. */
export function roleChangeRefusal(mode: Mode, after: readonly Staff[]): string | null {
  if (admins(after).length < 1) return 'The instance must keep at least one admin.'
  if (mode === 'real' && !hasDistinctAdminsAndReviewer(after)) return 'The real mode needs two admins and a reviewer, three different people.'
  if (mode === 'real' && !after.some((s) => has(s, 'approver'))) return 'The real mode needs at least one promotion approver.'
  return null
}

/** Fixed fictional payment details, the only ones a sandbox ever shows; there is no input for them (R-OP-01). */
export function sandboxPaymentInstruction(currency: 'GBP' | 'USD' | 'EUR') {
  return {
    currency,
    fictional: true as const,
    account_name: 'Fictional Sandbox Account',
    sort_code: '00-00-00',
    account_number: '00000000',
    holder: 'Fictional Holder Ltd',
    holder_capacity: 'Fictional example, not a real account. Do not send money.',
  }
}
