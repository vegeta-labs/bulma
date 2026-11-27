// The pack's archive (plan 05 §5.7; Codex P round 1 #1): written here rather than by the system's tar, which copies the
// builder's login, uid and gid into every header and, on macOS, extended attributes. Plain ustar, gzip: a directory or a
// file per entry, owner 0:0 with no user or group name, mode 755 or 644, one fixed time. `tarProblems()` reads an archive's
// own headers back, so the scan refuses anything else a header could carry.
import { gunzipSync, gzipSync } from 'node:zlib'

const BLOCK = 512

function field(h: Buffer, at: number, len: number, value: string) {
  const b = Buffer.from(value, 'utf8')
  if (b.length > len) throw new Error(`tar: ${value} does not fit in ${len} bytes`)
  b.copy(h, at)
}

const octal = (n: number, len: number) => `${n.toString(8).padStart(len - 1, '0')}\0`

/**
 * ustar's two name fields: a path over 100 bytes is split at a folder boundary into a prefix (up to 155 bytes) and a name
 * (up to 100), which every tar joins with `/` (Codex P r2 #8: a file's 80-character name under `data/files/<hash>/`).
 */
export function splitName(path: string): [prefix: string, name: string] {
  const len = (s: string) => Buffer.byteLength(s, 'utf8')
  if (len(path) <= 100) return ['', path]
  const body = path.endsWith('/') ? path.slice(0, -1) : path
  // a folder's header says it is one, so its closing `/` may go when only that is over (Codex P r3 #8)
  if (len(body) <= 100) return ['', body]
  for (let i = body.indexOf('/'); i > 0; i = body.indexOf('/', i + 1)) {
    const prefix = body.slice(0, i)
    // a folder's name keeps its closing / when it fits, else goes without, as at the top (Codex P r4 #8: x/<100 bytes>/)
    const name = [path.slice(i + 1), body.slice(i + 1)].find((n) => len(n) <= 100)
    if (len(prefix) <= 155 && name !== undefined) return [prefix, name]
  }
  throw new Error(`tar: ${path} is too long for a ustar header`)
}

function header(path: string, dir: boolean, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK)
  const [prefix, name] = splitName(path)
  field(h, 0, 100, name)
  field(h, 345, 155, prefix)
  field(h, 100, 8, octal(dir ? 0o755 : 0o644, 8))
  field(h, 108, 8, octal(0, 8))
  field(h, 116, 8, octal(0, 8))
  field(h, 124, 12, octal(size, 12))
  field(h, 136, 12, octal(mtime, 12))
  h.fill(' ', 148, 156)
  field(h, 156, 1, dir ? '5' : '0')
  field(h, 257, 6, 'ustar\0')
  field(h, 263, 2, '00')
  let sum = 0
  for (const byte of h) sum += byte
  field(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return h
}

/**
 * A gzipped ustar archive of `files` (path → bytes, `/`-separated, no outer directory), each folder listed before what it
 * holds, all sorted; `mtime` in seconds since the epoch. A path that fits no ustar header is refused.
 */
export function writeTar(files: ReadonlyMap<string, Uint8Array>, mtime: number): Buffer {
  const dirs = new Set<string>()
  for (const p of files.keys()) {
    if (!p || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`tar: not a plain relative path: ${p}`)
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  const out: Buffer[] = []
  for (const name of [...dirs, ...files.keys()].sort()) {
    const data = name.endsWith('/') ? null : files.get(name)!
    out.push(header(name, !data, data?.length ?? 0, mtime))
    if (data) {
      out.push(Buffer.from(data))
      if (data.length % BLOCK) out.push(Buffer.alloc(BLOCK - (data.length % BLOCK)))
    }
  }
  out.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(out), { level: 9 })
}

export interface TarEntry {
  name: string
  type: string
  mode: number
  uid: number
  gid: number
  uname: string
  gname: string
  mtime: number
  data: Buffer
}

const text = (h: Buffer, at: number, len: number) => {
  const s = h.subarray(at, at + len)
  const end = s.indexOf(0)
  return s.subarray(0, end < 0 ? len : end).toString('utf8')
}
const num = (h: Buffer, at: number, len: number) => parseInt(text(h, at, len).trim() || '0', 8)

/** Every entry of a gzipped tar as written, extended headers included as entries of their own type. */
export function readTar(gz: Uint8Array): TarEntry[] {
  const b = gunzipSync(gz)
  const out: TarEntry[] = []
  for (let at = 0; at + BLOCK <= b.length;) {
    const h = b.subarray(at, at + BLOCK)
    if (h.every((x) => x === 0)) break
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
    if (sum !== num(h, 148, 8)) throw new Error(`tar: a header at byte ${at} has a wrong checksum`)
    const size = num(h, 124, 12)
    const prefix = text(h, 345, 155)
    const name = prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100)
    out.push({
      name,
      type: String.fromCharCode(h[156] || 48),
      mode: num(h, 100, 8),
      uid: num(h, 108, 8),
      gid: num(h, 116, 8),
      uname: text(h, 265, 32),
      gname: text(h, 297, 32),
      mtime: num(h, 136, 12),
      data: Buffer.from(b.subarray(at + BLOCK, at + BLOCK + size)),
    })
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  return out
}

/** What a header says beyond a plain file or folder of the pack: another type, an owner, a name, a mode, a time. */
export function tarProblems(entries: readonly TarEntry[], mtime: number): string[] {
  const out: string[] = []
  for (const e of entries) {
    const say = (what: string) => out.push(`${e.name}: the archive's header ${what}`)
    if (e.type !== '0' && e.type !== '5') say(`is of type ${e.type} (an extended header, a link or a device), not a file or folder`)
    if (e.uid !== 0 || e.gid !== 0) say(`names owner ${e.uid}:${e.gid}`)
    if (e.uname || e.gname) say(`names the user or group ${e.uname}:${e.gname}`)
    if (e.mode !== (e.type === '5' ? 0o755 : 0o644)) say(`has mode ${e.mode.toString(8)}`)
    if (e.mtime !== mtime) say('has another time than the pack')
  }
  return out
}
