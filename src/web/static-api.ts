// The static demo's api.ts (plan 05 §5.1, §5.2): every answer comes from data/snapshot.js; nothing is sent, ever. A read the
// export did not record says so; any change (and any POST off the export's read-only list) gets the demo sentence, a quote
// for another amount the amounts the pack works out.
import { answerFor, DEMO_NO_CHANGE, DEMO_NOT_RECORDED, refusalFor } from '../demo/snapshot.ts'
import { ApiError } from './apiError.ts'
import { pack, view } from './static-browser.ts'
import { showDemoNote } from './static-demo.ts'

export { ApiError, type Blocker } from './apiError.ts'

// the pack has no session, so no CSRF value to keep
export const setCsrf = (_t: string) => undefined

/** Status 0: not an answer of the server, so no screen takes it for one (a 409 "new wording", a 401 "signed out"). */
const refused = (error: string) => new ApiError(0, { error })

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const a = answerFor(pack(), view(), method, path, body)
  if (!a || a.file) {
    // said where everyone sees it, so a screen that shows nothing on an error is not left blank and silent (Codex P r1 #11)
    if (method === 'GET') {
      showDemoNote(DEMO_NOT_RECORDED)
      throw refused(DEMO_NOT_RECORDED)
    }
    const why = refusalFor(pack(), view(), path, body)
    showDemoNote(why)
    throw refused(why)
  }
  if (a.status >= 400) throw new ApiError(a.status, (a.body ?? {}) as ConstructorParameters<typeof ApiError>[1])
  // a copy: the screens may change what they get, the pack stays as recorded
  return structuredClone(a.body) as T
}

export async function uploadFile(_path: string, _file: File, _headers: Record<string, string> = {}): Promise<unknown> {
  showDemoNote(DEMO_NO_CHANGE)
  throw refused(DEMO_NO_CHANGE)
}
