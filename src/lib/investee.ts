// The check on the company being invested in (PRD §4.8). Pure.
export const INVESTEE_DOCS = ['incorporation_certificate', 'bank_statement', 'address_proof'] as const
export const ADVANCE_ASSURANCE = 'seis_eis_advance_assurance'
export const MAX_INVESTEE_FILES = 20
/** Every file a company has ever sent for one check, removed ones included: the link needs no account, and nothing frees a removed file's storage yet. */
export const MAX_INVESTEE_UPLOADS = 60
export const MAX_EXTRA_CONTACTS = 5

export type InvesteeStatus = 'waiting' | 'submitted' | 'approved' | 'returned'

/** R-INV-02: the advance assurance letter only when the lead ticked SEIS or EIS. */
export const requiredInvesteeDocs = (taxRelief: boolean): string[] => (taxRelief ? [...INVESTEE_DOCS, ADVANCE_ASSURANCE] : [...INVESTEE_DOCS])

/** What the company still has to give before it can send its documents. */
export function investeeGaps(required: readonly string[], uploaded: readonly string[], notarisedAnswered: boolean): string[] {
  const missing = required.filter((r) => !uploaded.includes(r))
  return notarisedAnswered ? missing : [...missing, 'needs_notarised_signature']
}

export const investeeCanChange = (s: InvesteeStatus) => s === 'waiting' || s === 'returned'

export const investeeLinkOpen = (l: { expiresAt: Date; revokedAt: Date | null }, now: Date) => l.revokedAt === null && now.getTime() < l.expiresAt.getTime()

/** R-INV-05: at most one reminder per period. */
export function reminderAllowed(last: Date | null, now: Date, hours: number): boolean {
  return last === null || now.getTime() >= last.getTime() + hours * 3_600_000
}
