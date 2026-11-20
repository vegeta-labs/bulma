// Investing entities and KYC (PRD R-ENT-*, R-KYC-*). Pure.
export type EntityType = 'individual' | 'company' | 'trust' | 'other'
export type KycStatus = 'not_started' | 'in_progress' | 'pending_review' | 'approved' | 'returned' | 'rejected'

export const DEFAULT_UBO_THRESHOLD_BPS = 2500

export interface Party { kind: 'owner' | 'controller' | 'director' | 'representative'; ownershipBps: number }

/** R-ENT-04, MLR reg 5: over 25%, not at it, whatever else the person is; anyone exercising final control whatever their share. */
export const isBeneficialOwner = (p: Party, thresholdBps = DEFAULT_UBO_THRESHOLD_BPS) => p.kind === 'controller' || p.ownershipBps > thresholdBps

const INDIVIDUAL_FIELDS = ['full_name', 'address', 'tax_residence', 'tax_id'] as const
const COMPANY_FIELDS = ['name', 'company_number', 'registered_address', 'tax_residence', 'tax_id', 'source_of_wealth'] as const
const INDIVIDUAL_FILES = ['identity_proof', 'address_proof', 'source_of_wealth'] as const
const COMPANY_FILES = ['registration_proof', 'address_proof', 'structure_chart'] as const
// a trust or other body has no company number or directors, and shows what constitutes it (R-ENT-01, R-ENT-04)
const OTHER_FIELDS = ['name', 'registered_address', 'tax_residence', 'tax_id', 'source_of_wealth'] as const
const OTHER_FILES = ['constitution_proof', 'address_proof', 'structure_chart'] as const

export const requiredFields = (t: EntityType): readonly string[] => (t === 'individual' ? INDIVIDUAL_FIELDS : t === 'company' ? COMPANY_FIELDS : OTHER_FIELDS)
export const requiredFiles = (t: EntityType): readonly string[] => (t === 'individual' ? INDIVIDUAL_FILES : t === 'company' ? COMPANY_FILES : OTHER_FILES)
/** Proof of a bank account, kept apart: it is not part of the identity being checked. */
export const BANK_PROOF = 'bank_proof'
export const allowedRequirement = (t: EntityType, requirement: string) => requirement === BANK_PROOF || requiredFiles(t).includes(requirement)

export interface EntityFacts {
  type: EntityType
  fields: Readonly<Record<string, unknown>>
  files: readonly string[]
  parties: readonly (Party & { verified: boolean })[]
}

/** Everything still missing before the entity can go to review. */
export function entityGaps(e: EntityFacts, uboThresholdBps = DEFAULT_UBO_THRESHOLD_BPS): string[] {
  const out: string[] = []
  for (const f of requiredFields(e.type)) {
    const v = e.fields[f]
    if (typeof v !== 'string' || !v.trim()) out.push(`field:${f}`)
  }
  for (const f of requiredFiles(e.type)) if (!e.files.includes(f)) out.push(`file:${f}`)
  if (e.type !== 'individual') {
    if (e.type === 'company' && !e.parties.some((p) => p.kind === 'director')) out.push('party:director')
    if (!e.parties.some((p) => p.kind === 'representative')) out.push('party:representative') // reg 28(10)
    if (!e.parties.some((p) => isBeneficialOwner(p, uboThresholdBps))) out.push('party:beneficial_owner')
    for (const p of e.parties) if (isBeneficialOwner(p, uboThresholdBps) && !p.verified) out.push('party:beneficial_owner_unverified')
  }
  return [...new Set(out)]
}

export interface KycFact {
  status: Exclude<KycStatus, 'not_started'>
  entityVersion: number
  expiresOn: string | null
}

/** R-ENT-03: a pass counts only for the identity it was given to, and only until it expires. */
export function kycPassed(c: KycFact | null, currentVersion: number, today: string): boolean {
  return !!c && c.status === 'approved' && c.entityVersion === currentVersion && !!c.expiresOn && today < c.expiresOn
}

/** What people see. An approved case for an older identity or past its date is no longer a pass (R-ENT-02). */
export function entityStatus(c: KycFact | null, currentVersion: number, today: string): 'to_do' | 'in_progress' | 'in_review' | 'passed' | 'returned' | 'expired' | 'rejected' {
  if (!c) return 'to_do'
  if (c.status === 'rejected') return 'rejected'
  if (c.status === 'returned') return 'returned' // it says why, even when the details changed since
  if (c.entityVersion !== currentVersion) return 'to_do'
  if (c.status === 'approved') return kycPassed(c, currentVersion, today) ? 'passed' : 'expired'
  return c.status === 'pending_review' ? 'in_review' : 'in_progress'
}

export type ProviderDecision = { answer: 'GREEN' } | { answer: 'RED'; rejectType: 'RETRY' | 'FINAL'; comment?: string }

/**
 * R-KYC-02: a provider's automatic result never rejects by itself, and neither does it approve: every result goes to a
 * reviewer with the suggestion attached. RETRY sends it back to the person; the text is the provider's person-facing comment.
 */
export function afterProviderDecision(d: ProviderDecision): { status: 'pending_review' | 'returned'; suggestion: string; returnReason: string | null } {
  if (d.answer === 'GREEN') return { status: 'pending_review', suggestion: 'provider_green', returnReason: null }
  if (d.rejectType === 'RETRY') return { status: 'returned', suggestion: 'provider_retry', returnReason: d.comment?.trim() || 'Please check your documents and send them again.' }
  return { status: 'pending_review', suggestion: 'provider_final', returnReason: null }
}

const legalName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** R-ENT-06: a bank account must be in the entity's own name. A person confirms; this only catches a clear mismatch. */
/** R-ENT-06: enough to pay into: an IBAN, or a sort code with an account number. Whether they are right is for the reviewer. */
export const bankDetailsGiven = (f: Record<string, string>) => !!f.iban?.trim() || (!!f.sort_code?.trim() && !!f.account_number?.trim())
export const BANK_DETAILS_NEEDED = 'Give the account details: an IBAN, or a sort code and an account number.'

export const sameHolder = (holder: string, entityName: string) => legalName(holder) !== '' && legalName(holder) === legalName(entityName)

export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate()
  return `${y + years}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

export interface RetentionFacts {
  lastLogin: Date | null
  createdAt: Date
  deletionRequestedAt: Date | null
  relationshipEndedAt: Date | null
  retentionHold: boolean
  hasOngoingRelationship: boolean
}

export function addMonths(at: Date, months: number): Date {
  const d = new Date(at.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d
}

/**
 * PRD §5.6. The earliest of: a recorded end of relationship, a deletion request, or going idle. No date while another
 * relationship is ongoing. D3 onward sets `relationshipEndedAt` from participations.
 */
export function relationshipEnd(f: RetentionFacts, idleMonths: number): Date | null {
  if (f.hasOngoingRelationship) return null
  const idleFrom = addMonths(f.lastLogin ?? f.createdAt, idleMonths)
  const dates = [f.relationshipEndedAt, f.deletionRequestedAt, idleFrom].filter((d): d is Date => !!d)
  return dates.sort((a, b) => a.getTime() - b.getTime())[0] ?? null
}

/** When personal data goes: the configured years after the end, never during a legal hold. */
export function retentionDue(f: RetentionFacts, cfg: { relationshipYears: number; idleMonths: number }, now: Date): boolean {
  if (f.retentionHold) return false
  const end = relationshipEnd(f, cfg.idleMonths)
  return !!end && addMonths(end, cfg.relationshipYears * 12) <= now
}
