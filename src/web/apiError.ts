// A refused answer as the screens see it; shared by api.ts and the static demo's static-api.ts.
export interface Blocker {
  code: string
  message: string
}
export class ApiError extends Error {
  readonly status: number
  readonly blockers: Blocker[]
  readonly errors: string[]
  readonly mfaRequired: boolean
  constructor(status: number, body: { error?: string; blockers?: Blocker[]; errors?: string[]; issues?: string[]; mfa_required?: boolean }) {
    super(body.error ?? 'request failed')
    this.status = status
    this.blockers = body.blockers ?? []
    this.errors = body.errors ?? body.issues ?? []
    this.mfaRequired = !!body.mfa_required
  }
}
