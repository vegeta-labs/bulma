// Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 seconds), which every authenticator app reads. Pure.
import { createHmac, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const STEP_SECONDS = 30

export function base32(data: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  return bits > 0 ? out + ALPHABET[(value << (5 - bits)) & 31] : out
}

export const stepOf = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS)

export function codeAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', secret).update(counter).digest()
  const at = h[h.length - 1]! & 15
  return String((h.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** The step the code belongs to, one step either way for clock drift, or null. A step at or before `lastStep` is a replay. */
export function matchStep(secret: Buffer, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const now = stepOf(nowMs)
  let found: number | null = null
  for (const step of [now - 1, now, now + 1]) {
    const a = Buffer.from(codeAt(secret, step))
    if (timingSafeEqual(a, Buffer.from(code)) && (lastStep === null || step > lastStep)) found = found ?? step
  }
  return found
}

export const otpauthUri = (secretBase32: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`Bulma:${account}`)}?secret=${secretBase32}&issuer=Bulma&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`
