// The browser's only way to the server: same origin, CSRF header on every change, no third party. The static demo build
// puts static-api.ts in its place (vite.demo.config.ts).
import { ApiError } from './apiError.ts'

export { ApiError, type Blocker } from './apiError.ts'

let csrf = ''
export const setCsrf = (t: string) => {
  csrf = t
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data)
  return data as T
}

/** A file goes as raw bytes; the type is judged on the server from the content. */
export async function uploadFile(path: string, file: File, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrf, ...headers }, body: file })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}
