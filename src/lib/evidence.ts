// Evidence pack (PRD R-AUD-02, TC-AUD-02, decision R28 (6)): one investor's record, as a PDF to read and a JSON list of the
// same items (text key, version, sha256, and the text itself so anyone can hash it again). Pure: the server loads the facts,
// this decides the wording, the order and whether each kept text still has the hash recorded when it was shown.
// The system knows what it returned and what was clicked; never that anyone read it. The wording says so and nothing else.
import { ARCHIVE_NOTE, INTERNAL_APPROVAL_NOTE } from './message.ts'
import { textSha256 } from './regimePack.ts'
import { stableJson } from './snapshot.ts'

export const EVIDENCE_FORMAT = 'bulma-evidence-pack/1'

/** R-AUD-02: said first, before anything else in the pack. */
export const EVIDENCE_LIMITS: readonly string[] = [
  'What this pack can and cannot show.',
  'It lists what this site returned to this person, what was sent to them through the site, and what they clicked, typed or signed here. It cannot tell whether they read any of it or understood it.',
  'A deal page is listed when the site returned it to their account. That is all it records.',
  'Replies, and anything said outside the site (calls, meetings, other email), are not in this pack.',
  'Each text is given in full with two hashes: the one recorded when it was shown and the one of the text kept today. When they differ, the text kept today is not the one shown.',
  'Answers to the assessment questions are not included, only the results.',
]

/** How a kept text was hashed when it was shown, so the same hash can be made again from the pack alone. */
export type ShownText =
  | { hashed: 'utf8'; text: string; sha256: string }
  | { hashed: 'stable_json'; value: unknown; sha256: string }
  | { hashed: 'subject_and_text'; subject: string; text: string; sha256: string }

export const HASHED_AS: Record<ShownText['hashed'], string> = {
  utf8: 'sha256 of the text as UTF-8',
  stable_json: 'sha256 of the value as JSON with keys sorted, no spaces',
  subject_and_text: 'sha256 of the JSON array [subject, text]',
}

/** The hash of a kept text, made the way it was made when it was shown. */
export function hashOfKept(t: ShownText): string {
  if (t.hashed === 'utf8') return textSha256(t.text)
  if (t.hashed === 'stable_json') return textSha256(stableJson(t.value))
  return textSha256(JSON.stringify([t.subject, t.text]))
}

/** The text as it is printed in the PDF. */
export function printedText(t: ShownText): string {
  if (t.hashed === 'utf8') return t.text
  if (t.hashed === 'stable_json') return stableJson(t.value)
  return `Subject: ${t.subject}\n\n${t.text}`
}

export interface EvidenceItem {
  /** When it happened (ISO), or null for a standing fact. */
  at: string | null
  what: string
  fields?: Readonly<Record<string, string | number | boolean | null>>
  shown?: ShownText
}

export const SECTIONS = [
  'statements',
  'warnings',
  'cooling_off',
  'assessment',
  'kyc',
  'deal_versions',
  'link_terms',
  'instructions',
  'signatures',
  'reconfirmations',
  'messages',
  'mails',
  'versions',
] as const
export type SectionKey = (typeof SECTIONS)[number]

/** The size a section's title is drawn at, and nothing else in the pack is: what finds the sections in the PDF's text. */
export const SECTION_TITLE_SIZE = 13

export const SECTION_TITLE: Record<SectionKey, string> = {
  statements: 'Eligibility statements',
  warnings: 'Risk warnings and the choice made on each',
  cooling_off: 'Cooling-off period',
  assessment: 'Appropriateness assessment results',
  kyc: 'Identity check decisions',
  deal_versions: 'Deal page versions returned to this account, and their approval records',
  link_terms: 'Invitation and link terms',
  instructions: 'Payment instructions issued and confirmed',
  signatures: 'Signatures',
  reconfirmations: 'Reconfirmations',
  messages: 'Messages from the lead sent through the site',
  mails: 'Other email sent by the site',
  versions: 'Rule pack and software versions',
}

/** Said under a section's title. */
export const SECTION_NOTE: Partial<Record<SectionKey, string>> = {
  deal_versions: INTERNAL_APPROVAL_NOTE,
  messages: `${ARCHIVE_NOTE} ${INTERNAL_APPROVAL_NOTE}`,
  mails: 'The site keeps the subject and when each email was sent, not its text, except for messages from the lead above.',
  assessment: 'Results only; the questions asked and the answers given are not included.',
}

export interface EvidencePerson {
  id: string
  name: string
  email: string
}

export interface EvidenceInput {
  person: EvidencePerson
  /** The deal this pack is about, or null for the person's records that belong to no deal only. */
  deal: { id: string; code: string; name: string | null } | null
  generatedAt: Date
  softwareVersion: string
  sections: Readonly<Partial<Record<SectionKey, readonly EvidenceItem[]>>>
}

export interface ManifestText {
  hashed_as: string
  sha256_recorded: string
  sha256_now: string
  matches: boolean
  subject?: string
  text?: string
  value?: unknown
}

export interface Manifest {
  format: typeof EVIDENCE_FORMAT
  limits: readonly string[]
  generated_at: string
  software_version: string
  person: EvidencePerson
  deal: EvidenceInput['deal']
  sections: { key: SectionKey; title: string; note: string | null; items: (Omit<EvidenceItem, 'shown'> & { shown?: ManifestText })[] }[]
  /** Kept texts whose hash today is not the one recorded. */
  mismatches: number
}

/** The JSON list: every section in the fixed order, empty ones included so a missing record is visible as missing. */
export function evidenceManifest(input: EvidenceInput): Manifest {
  let mismatches = 0
  const sections = SECTIONS.map((key) => ({
    key,
    title: SECTION_TITLE[key],
    note: SECTION_NOTE[key] ?? null,
    items: [...(input.sections[key] ?? [])]
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
      .map(({ shown, ...item }) => {
        if (!shown) return item
        const now = hashOfKept(shown)
        const matches = now === shown.sha256
        if (!matches) mismatches += 1
        const { hashed, sha256, ...kept } = shown
        return { ...item, shown: { hashed_as: HASHED_AS[hashed], sha256_recorded: sha256, sha256_now: now, matches, ...kept } }
      }),
  }))
  return {
    format: EVIDENCE_FORMAT,
    limits: EVIDENCE_LIMITS,
    generated_at: input.generatedAt.toISOString(),
    software_version: input.softwareVersion,
    person: input.person,
    deal: input.deal,
    sections,
    mismatches,
  }
}

export interface Block {
  text: string
  bold?: boolean
  boxed?: boolean
  size?: number
}

const fieldLine = (k: string, v: string | number | boolean | null) => `${k}: ${v === null ? '(none)' : v === true ? 'yes' : v === false ? 'no' : v}`

/** The PDF's blocks: the limits boxed first, then the same sections and items as the JSON. */
export function evidenceBlocks(m: Manifest): Block[] {
  const out: Block[] = [{ text: m.limits.join('\n\n'), bold: true, boxed: true }]
  out.push({ text: 'Evidence pack', bold: true, size: 16 })
  out.push({
    text: [
      `Person: ${m.person.name} <${m.person.email}> (account ${m.person.id})`,
      m.deal ? `Deal: ${m.deal.name ?? '(no name)'} (${m.deal.code})` : 'Deal: none; records that belong to no deal only',
      `Made: ${m.generated_at}, software version ${m.software_version}`,
      m.mismatches === 0
        ? 'Every kept text has the hash recorded when it was shown.'
        : `${m.mismatches} kept text(s) do not have the hash recorded when they were shown. See "does not match" below.`,
    ].join('\n'),
  })
  for (const s of m.sections) {
    out.push({ text: s.title, bold: true, size: SECTION_TITLE_SIZE })
    if (s.note) out.push({ text: s.note })
    if (s.items.length === 0) out.push({ text: 'Nothing recorded.' })
    for (const item of s.items) {
      const lines = [`${item.at ?? '—'}  ${item.what}`, ...Object.entries(item.fields ?? {}).map(([k, v]) => fieldLine(k, v))]
      out.push({ text: lines.join('\n'), bold: false })
      if (item.shown) {
        const t = item.shown
        out.push({
          text: `Text kept (${t.hashed_as}). Recorded ${t.sha256_recorded}; today ${t.sha256_now}: ${t.matches ? 'matches' : 'does not match'}.`,
          bold: !t.matches,
        })
        out.push({
          text: t.subject !== undefined ? `Subject: ${t.subject}\n\n${t.text}` : t.value !== undefined ? stableJson(t.value) : (t.text ?? ''),
          size: 8,
        })
      }
    }
  }
  return out
}

/**
 * TC-AUD-02: claims the pack must never make about its own wording: that someone saw, viewed or read something, or that
 * every exchange is kept. Returns the phrases found.
 */
export function forbiddenClaims(text: string): string[] {
  const patterns = [
    /\b(saw|seen|viewed)\b/gi,
    /\b(has|have|had) read\b/gi,
    /\bread (by|and understood)\b/gi,
    /\ball (communications?|correspondence|messages|emails?)\b[^.]*\b(kept|archived|stored|included|recorded)\b/gi,
    /看到了|已阅读|全部沟通已存档/g,
  ]
  return patterns.flatMap((p) => text.match(p) ?? [])
}
