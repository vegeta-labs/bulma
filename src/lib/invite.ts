// Invitation rules (PRD R-LNK-*, §5.2, R-CMP-03). Pure. The server stores; these decide.
import { linkFeeErrors, type LinkFee } from './fees.ts'

/** R-LNK-04: active links per deal, the same as the investor limit. */
export const MAX_ACTIVE_LINKS = 500
/** R-LNK-10: an unbound opened link is kept this long. */
export const PENDING_INVITE_DAYS = 30
/** Tech design §5: opening a link, per address and per token in each 15-minute window. A shared link is opened by many people. */
export const INVITE_OPENS_PER_IP = 30
export const INVITE_OPENS_PER_TOKEN = 300

export interface LinkTerms {
  carryBps: number
  fee: LinkFee
}

/** R-CMP-03: the operator's switches that bear on links. */
export interface LinkPolicy {
  perLinkTerms: boolean
  genericLinks: boolean
}

/** R-LNK-06: terms other than the deal's default carry with no fee. */
export const differs = (t: LinkTerms, defaultCarryBps: number) => t.carryBps !== defaultCarryBps || t.fee.kind !== 'none'

export interface NewLinkFacts {
  dealLive: boolean
  activeLinks: number
  defaultCarryBps: number
  feeMaxBps: number
  policy: LinkPolicy
  kind: 'open' | 'terms_only'
  terms: LinkTerms
  reason: string | null
  /** COBS: the lead confirmed this is no incentive (R-LNK-06). */
  incentiveAttested: boolean
  attestationRequired: boolean
}

/** R-LNK-01, R-LNK-02, R-LNK-04, R-LNK-06, R-CMP-03: why a link cannot be made, or null. */
export function newLinkRefusal(f: NewLinkFacts): string | null {
  if (!f.dealLive) return 'Links can be made only while the deal is live.'
  if (f.activeLinks >= MAX_ACTIVE_LINKS) return `A deal can have at most ${MAX_ACTIVE_LINKS} links in use. Turn one off first.`
  if (!Number.isInteger(f.terms.carryBps) || f.terms.carryBps < 0 || f.terms.carryBps > 10_000) return 'Carry must be from 0% to 100%.'
  const feeProblem = linkFeeErrors(f.terms.fee, f.feeMaxBps)[0]
  if (feeProblem) return feeProblem
  if (f.kind === 'open' && !f.policy.genericLinks) return 'The operator allows only invitations sent to a named address.'
  if (differs(f.terms, f.defaultCarryBps)) {
    if (!f.policy.perLinkTerms) return 'The operator does not allow terms that differ from the default.'
    if (!f.reason?.trim()) return 'Say why these terms differ from the default.'
    if (f.attestationRequired && !f.incentiveAttested) return 'Confirm these terms are not an incentive.'
  }
  return null
}

/** R-LNK-06: a link with different terms waits for a reviewer where the pack asks for it. */
export const needsTermsApproval = (t: LinkTerms, defaultCarryBps: number, attestationRequired: boolean) => attestationRequired && differs(t, defaultCarryBps)

export interface LinkState {
  disabled: boolean
  closingPaused: boolean
  /** Awaiting the reviewer (R-LNK-06). */
  awaitingApproval: boolean
}
export const linkUsable = (l: LinkState) => !l.disabled && !l.closingPaused && !l.awaitingApproval

/** What a person already has on this deal. */
export interface PersonOnDeal {
  /** An invitation in progress. */
  activeInvitation: boolean
  /** Any earlier invitation that ended (passed, revoked, or every participation terminal). */
  endedBefore: boolean
}

export type AcceptResult =
  | { ok: true; kind: 'new' }
  | { ok: true; kind: 'already_invited' } // R-LNK-11: terms unchanged, the lead is told
  | { ok: false; reason: 'deal_not_open' | 'link_unusable' | 'wrong_address' | 'consumed' | 'ended_before' | 'held' }

export interface AcceptFacts {
  dealLive: boolean
  held: boolean
  link: LinkState
  person: PersonOnDeal
  /** Present for a targeted invitation (R-LNK-07). */
  targeted: { email: string; consumed: boolean; revoked: boolean; allowsReentry: boolean } | null
  /** The person's verified address. */
  verifiedEmail: string
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** R-LNK-10, R-LNK-11, R-LNK-07, §5.2: binding an opened link to a signed-in person with a verified address. */
export function decideAccept(f: AcceptFacts): AcceptResult {
  if (f.held) return { ok: false, reason: 'held' }
  if (!f.dealLive) return { ok: false, reason: 'deal_not_open' }
  if (f.targeted) {
    if (f.targeted.consumed || f.targeted.revoked) return { ok: false, reason: 'consumed' }
    if (!sameAddress(f.targeted.email, f.verifiedEmail)) return { ok: false, reason: 'wrong_address' }
  }
  if (!linkUsable(f.link)) return { ok: false, reason: 'link_unusable' }
  if (f.person.activeInvitation) return { ok: true, kind: 'already_invited' }
  // only an invitation sent to this person, marked for re-entry, brings back someone whose invitation ended
  if (f.person.endedBefore && !f.targeted?.allowsReentry) return { ok: false, reason: 'ended_before' }
  return { ok: true, kind: 'new' }
}

/** R-LNK-09: people counted once whatever the number of entities, by the country they gave. */
export interface CountryCount {
  uk: number
  eea: Record<string, number>
  unknown: number
  other: number
}

export const EEA = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
] as const

/** Another country than these: counted as outside the UK and the EEA (a code ISO 3166 leaves to users). */
export const OTHER_COUNTRY = 'ZZ'

/**
 * R-LNK-09: the countries a person can choose, the UK first. Every EEA state is here, as each has its own count
 * (Codex round 9: Bulgaria, Czechia, Greece, Romania and others were missing); any other country is OTHER_COUNTRY.
 */
export const COUNTRY_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['GB', 'United Kingdom'],
  ['AU', 'Australia'],
  ['AT', 'Austria'],
  ['BE', 'Belgium'],
  ['BG', 'Bulgaria'],
  ['CA', 'Canada'],
  ['HR', 'Croatia'],
  ['CY', 'Cyprus'],
  ['CZ', 'Czechia'],
  ['DK', 'Denmark'],
  ['EE', 'Estonia'],
  ['FI', 'Finland'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['GR', 'Greece'],
  ['HK', 'Hong Kong'],
  ['HU', 'Hungary'],
  ['IS', 'Iceland'],
  ['IE', 'Ireland'],
  ['IT', 'Italy'],
  ['LV', 'Latvia'],
  ['LI', 'Liechtenstein'],
  ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'],
  ['MT', 'Malta'],
  ['NL', 'Netherlands'],
  ['NO', 'Norway'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['RO', 'Romania'],
  ['SG', 'Singapore'],
  ['SK', 'Slovakia'],
  ['SI', 'Slovenia'],
  ['ES', 'Spain'],
  ['SE', 'Sweden'],
  ['CH', 'Switzerland'],
  ['AE', 'United Arab Emirates'],
  ['US', 'United States'],
  [OTHER_COUNTRY, 'Another country'],
]

export function countPeople(people: ReadonlyArray<{ userId: string; country: string | null }>): CountryCount {
  const seen = new Set<string>()
  const out: CountryCount = { uk: 0, eea: {}, unknown: 0, other: 0 }
  for (const p of people) {
    if (seen.has(p.userId)) continue
    seen.add(p.userId)
    const c = p.country?.trim().toUpperCase() ?? ''
    if (!/^[A-Z]{2}$/.test(c)) out.unknown++
    else if (c === 'GB') out.uk++
    else if ((EEA as readonly string[]).includes(c)) out.eea[c] = (out.eea[c] ?? 0) + 1
    else out.other++
  }
  return out
}

export interface CountWarnings {
  ukPeopleNear: boolean
  ukAmountNear: boolean
  eeaOver: string[]
  unknown: number
}

/** R-LNK-09: reminders only, never a block. "Near" is 90% of the line. */
export function countWarnings(c: CountryCount, ukRaisedMinor: bigint, eeaLimit: number): CountWarnings {
  return {
    ukPeopleNear: c.uk >= 135,
    ukAmountNear: ukRaisedMinor >= 450_000_000n,
    eeaOver: Object.entries(c.eea)
      .filter(([, n]) => n > eeaLimit)
      .map(([k]) => k)
      .sort(),
    unknown: c.unknown,
  }
}
