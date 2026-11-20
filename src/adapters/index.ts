// Outside services (tech design T9, §7). Every adapter has a fake; the sandbox always uses the fakes, whatever the
// deployment configured (R-OP-01). The real SMTP, KYC and signature adapters arrive with the milestones that use them.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { connect } from 'node:net'
import type { Mode } from '../lib/instance.ts'
import type { Db } from '../store/db.ts'

/** `html`: the body is a promotional HTML mail, sent with no plain-text part (R-COM-06). */
export interface MailMessage { to: string; subject: string; body: string; html?: boolean; /** R-COM-02: replies go to the lead who wrote. */ replyTo?: string }
export interface Mailer { send(msg: MailMessage): Promise<{ delivered: boolean }> }
export type KycDecision = { ref: string; answer: 'GREEN' } | { ref: string; answer: 'RED'; rejectType: 'RETRY' | 'FINAL'; comment?: string }
export interface WebhookRequest { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }
export interface KycProvider {
  name: 'fake' | 'sumsub'
  usesBiometrics: boolean
  start(externalId: string, email: string): Promise<{ ref: string; url?: string }>
  /** Where the person continues, when the provider has its own page. */
  link?(externalId: string): Promise<string>
  /** null: a signed event of another type. Throws when the signature is wrong. */
  parseWebhook(req: WebhookRequest): KycDecision | null
}
export interface SignatureProvider { start(documentSha256: string, signerId: string): Promise<{ ref: string }>; status(ref: string): Promise<'pending' | 'signed'> }
export interface Storage { put(key: string, data: Buffer): Promise<void>; get(key: string): Promise<Buffer | null>; delete(key: string): Promise<void> }
export type ScanResult = { clean: true } | { clean: false; signature: string }
export interface VirusScanner { scan(data: Buffer): Promise<ScanResult> }

/** Sandbox mail stays in the database and is never sent. */
export class FakeOutbox implements Mailer {
  private readonly db: Pick<Db, 'query'>
  constructor(db: Pick<Db, 'query'>) {
    this.db = db
  }
  async send(m: MailMessage) {
    await this.db.query('INSERT INTO sandbox_outbox (id, to_address, subject, body, is_html, reply_to) VALUES ($1, $2, $3, $4, $5, $6)', [
      randomUUID(),
      m.to,
      m.subject,
      m.body,
      !!m.html,
      m.replyTo ?? null,
    ])
    return { delivered: false }
  }
}

export class FakeKyc implements KycProvider {
  readonly name = 'fake' as const
  readonly usesBiometrics = false
  async start(externalId: string) {
    return { ref: `fake-${externalId}` }
  }
  parseWebhook(req: WebhookRequest): KycDecision | null {
    const r = JSON.parse(req.rawBody.toString('utf8')) as { ref?: unknown; answer?: unknown; rejectType?: unknown }
    if (typeof r?.ref !== 'string') throw new Error('bad fake KYC event')
    if (r.answer === 'GREEN') return { ref: r.ref, answer: 'GREEN' }
    if (r.answer === 'RED' && (r.rejectType === 'RETRY' || r.rejectType === 'FINAL')) return { ref: r.ref, answer: 'RED', rejectType: r.rejectType }
    throw new Error('bad fake KYC event')
  }
}

export class FakeSignature implements SignatureProvider {
  private readonly signed = new Set<string>()
  async start(documentSha256: string, signerId: string) {
    return { ref: `fake-${documentSha256.slice(0, 12)}-${signerId}` }
  }
  sign(ref: string) {
    this.signed.add(ref)
  }
  async status(ref: string) {
    return this.signed.has(ref) ? ('signed' as const) : ('pending' as const)
  }
}

export class StorageFull extends Error {}

/** The sandbox keeps files in memory, so everything held here counts against one limit (decision: files go on restart). */
export class MemoryStorage implements Storage {
  private readonly files = new Map<string, Buffer>()
  private readonly limit: number
  private used = 0
  constructor(limitBytes = 256 * 1024 * 1024) {
    this.limit = limitBytes
  }
  async put(key: string, data: Buffer) {
    const replaced = this.files.get(key)?.length ?? 0
    if (this.used - replaced + data.length > this.limit) throw new StorageFull('the sandbox has no room for more files')
    this.used += data.length - replaced
    this.files.set(key, data)
  }
  async get(key: string) {
    return this.files.get(key) ?? null
  }
  async delete(key: string) {
    this.used -= this.files.get(key)?.length ?? 0
    this.files.delete(key)
  }
}

export class LocalStorage implements Storage {
  private readonly root: string
  constructor(root: string) {
    this.root = resolve(root)
  }
  private path(key: string): string {
    const p = resolve(join(this.root, key))
    const rel = relative(this.root, p)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('storage key outside the root')
    return p
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, data)
  }
  async get(key: string) {
    return readFile(this.path(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true })
  }
}

export class FakeScanner implements VirusScanner {
  async scan(data: Buffer): Promise<ScanResult> {
    return data.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? { clean: false, signature: 'Fake.EICAR' } : { clean: true }
  }
}

/** INSTREAM over TCP to the separate ClamAV container. */
export class Clamd implements VirusScanner {
  private readonly host: string
  private readonly port: number
  constructor(host: string, port: number) {
    this.host = host
    this.port = port
  }
  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((res, rej) => {
      const s = connect({ host: this.host, port: this.port })
      const chunks: Buffer[] = []
      s.setTimeout(60_000, () => s.destroy(new Error('clamd timeout')))
      s.on('error', rej)
      s.on('data', (d) => chunks.push(d))
      s.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()
        const found = /:\s*(.+) FOUND$/.exec(reply)
        if (/:\s*OK$/.test(reply)) res({ clean: true })
        else if (found) res({ clean: false, signature: found[1]! })
        else rej(new Error('clamd gave an unexpected reply'))
      })
      s.on('connect', () => {
        s.write('zINSTREAM\0')
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024)
          const len = Buffer.alloc(4)
          len.writeUInt32BE(chunk.length)
          s.write(len)
          s.write(chunk)
        }
        s.end(Buffer.alloc(4))
      })
    })
  }
}

export interface RealAdapters {
  mailer?: Mailer
  kyc?: KycProvider
  signature?: SignatureProvider
  storage?: Storage
  scanner?: VirusScanner
}

export interface Adapters {
  mailer: Mailer
  kyc: KycProvider
  signature: SignatureProvider
  storage: Storage
  scanner: VirusScanner
}

const missing = (name: string) => () => {
  throw new Error(`no ${name} adapter is configured for the real mode`)
}
const unconfigured = <T extends object>(name: string): T => new Proxy({}, { get: missing(name) }) as T

/** The sandbox ignores whatever real adapters are configured, so its mail can never leave. */
export function selectAdapters(mode: Mode, db: Pick<Db, 'query'>, real: RealAdapters = {}): Adapters {
  if (mode === 'sandbox') return { mailer: new FakeOutbox(db), kyc: new FakeKyc(), signature: new FakeSignature(), storage: new MemoryStorage(), scanner: new FakeScanner() }
  return {
    mailer: real.mailer ?? unconfigured<Mailer>('mail'),
    kyc: real.kyc ?? unconfigured<KycProvider>('KYC'),
    signature: real.signature ?? unconfigured<SignatureProvider>('signature'),
    storage: real.storage ?? unconfigured<Storage>('storage'),
    scanner: real.scanner ?? unconfigured<VirusScanner>('virus scanner'),
  }
}
