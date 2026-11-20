// Sumsub (tech design §7), checked against docs.sumsub.com on 2026-11-06: reference/authentication, create-applicant,
// generate-access-token, docs/webhook-manager, docs/user-verification-webhooks. The operator signs its own contract.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { KycDecision, KycProvider, WebhookRequest } from './index.ts'

const HOST = 'https://api.sumsub.com'
const CALL_MS = 10_000
const LINK_SECONDS = 24 * 3600
// SHA-1 exists only for old webhooks; a new webhook defaults to SHA-256, and a weak algorithm is not chosen by the sender
const ALGORITHMS: Record<string, string> = { HMAC_SHA256_HEX: 'sha256', HMAC_SHA512_HEX: 'sha512' }

export interface SumsubConfig {
  appToken: string
  secretKey: string
  webhookSecret: string
  levelName: string
  fetch?: typeof fetch
  now?: () => number
}

const header = (h: WebhookRequest['headers'], name: string) => {
  const v = h[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

export class SumsubKyc implements KycProvider {
  readonly name = 'sumsub' as const
  readonly usesBiometrics = true
  private readonly c: SumsubConfig
  constructor(c: SumsubConfig) {
    this.c = c
  }

  /** X-App-Access-Sig: HMAC-SHA256 of timestamp + METHOD + path with query + raw body, in lowercase hex. */
  signature(ts: string, method: string, path: string, body: string): string {
    return createHmac('sha256', this.c.secretKey).update(ts + method + path + body).digest('hex')
  }

  private async post(path: string, payload: object): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload)
    const ts = String(Math.floor((this.c.now?.() ?? Date.now()) / 1000))
    const res = await (this.c.fetch ?? fetch)(HOST + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-App-Token': this.c.appToken, 'X-App-Access-Ts': ts, 'X-App-Access-Sig': this.signature(ts, 'POST', path, body) },
      body,
      signal: AbortSignal.timeout(CALL_MS),
    })
    if (!res.ok) throw new Error(`Sumsub answered ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  async start(externalId: string, email: string): Promise<{ ref: string; url?: string }> {
    const level = encodeURIComponent(this.c.levelName)
    const applicant = await this.post(`/resources/applicants?levelName=${level}`, { externalUserId: externalId, email })
    if (typeof applicant.id !== 'string') throw new Error('Sumsub gave no applicant id')
    return { ref: applicant.id }
  }

  /**
   * The page where the person continues, on this device or a phone: no third-party script in our pages. Checked against
   * docs.sumsub.com/reference/generate-websdk-external-link on 2026-11-07.
   */
  async link(externalId: string): Promise<string> {
    const r = await this.post('/resources/sdkIntegrations/levels/-/websdkLink', { levelName: this.c.levelName, userId: externalId, ttlInSecs: LINK_SECONDS })
    if (typeof r.url !== 'string') throw new Error('Sumsub gave no link')
    return r.url
  }

  parseWebhook(req: WebhookRequest): KycDecision | null {
    const algo = ALGORITHMS[header(req.headers, 'x-payload-digest-alg') ?? '']
    const given = header(req.headers, 'x-payload-digest')
    if (!algo || !given) throw new Error('webhook signature missing')
    const want = createHmac(algo, this.c.webhookSecret).update(req.rawBody).digest('hex')
    const a = Buffer.from(given)
    const b = Buffer.from(want)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('webhook signature wrong')
    const e = JSON.parse(req.rawBody.toString('utf8')) as { type?: unknown; applicantId?: unknown; reviewResult?: { reviewAnswer?: unknown; reviewRejectType?: unknown; moderationComment?: unknown } }
    if (e.type !== 'applicantReviewed') return null
    if (typeof e.applicantId !== 'string') throw new Error('webhook without an applicant')
    if (e.reviewResult?.reviewAnswer === 'GREEN') return { ref: e.applicantId, answer: 'GREEN' }
    if (e.reviewResult?.reviewAnswer !== 'RED') throw new Error('webhook without a result')
    // moderationComment may be shown to the person; clientComment may hold private information and is never read
    const comment = typeof e.reviewResult.moderationComment === 'string' ? e.reviewResult.moderationComment : undefined
    return { ref: e.applicantId, answer: 'RED', rejectType: e.reviewResult.reviewRejectType === 'RETRY' ? 'RETRY' : 'FINAL', comment }
  }
}
