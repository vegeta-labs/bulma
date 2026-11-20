// Payment references and deal codes (PRD C-REF-1, §5.5). Pure: the random source is passed in.
/** A–Z and 2–9 without 0, O, 1, I and L, which are easy to misread. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const REFERENCE_RANDOM_LENGTH = 6

/** R-OP: the operator's prefix, two to four ASCII letters. */
export const validPrefix = (p: string) => /^[A-Z]{2,4}$/.test(p)

/** `random(n)` returns a whole number from 0 to n − 1, from a secure source. */
export function randomPart(random: (n: number) => number, length = REFERENCE_RANDOM_LENGTH): string {
  return Array.from({ length }, () => CODE_ALPHABET[random(CODE_ALPHABET.length)]).join('')
}

/** C-REF-1: `AB-7K2M9Q`. */
export function newReference(prefix: string, random: (n: number) => number): string {
  if (!validPrefix(prefix)) throw new RangeError('the reference prefix must be 2 to 4 letters A to Z')
  return `${prefix}-${randomPart(random)}`
}

/** Goten C-REC-1: a–z to A–Z only, and every ASCII character other than a letter or digit dropped. Non-ASCII stays. */
export function normaliseReference(r: string): string {
  let out = ''
  for (const ch of r) {
    const code = ch.codePointAt(0)!
    if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(code - 32)
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code > 0x7f) out += ch
  }
  return out
}

/** The shape C-REF-1 promises, which also meets Goten R-REC-01.2 (one to three parts, 3 to 20 characters). */
export const REFERENCE_PATTERN = /^[A-Z]{2,4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/

/** Goten C-REC-2: whether a bank memo holds this reference, as one to three neighbouring parts. */
export function memoMatches(memo: string, reference: string): boolean {
  const want = normaliseReference(reference)
  if (!want) return false
  const parts: string[] = []
  let cur = ''
  for (const ch of memo) {
    const code = ch.codePointAt(0)!
    const separator = code <= 0x7f && !((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39))
    if (separator) {
      if (cur) parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) parts.push(cur)
  const norm = parts.map(normaliseReference)
  for (let i = 0; i < norm.length; i++) {
    let joined = ''
    for (let k = i; k < Math.min(norm.length, i + 3); k++) {
      joined += norm[k]
      if (joined === want) return true
    }
  }
  return false
}

/**
 * C-REF-1: a reference no one else holds once normalised. 31^6 values make a clash likely within tens of thousands, so the
 * caller says which are taken (the database's unique index is the final word) and this draws again, a bounded number of times.
 */
export function issueReference(prefix: string, random: (n: number) => number, taken: (normalised: string) => boolean, tries = 20): string {
  for (let i = 0; i < tries; i++) {
    const r = newReference(prefix, random)
    if (!taken(normaliseReference(r))) return r
  }
  throw new Error('no free payment reference found')
}
