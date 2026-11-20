// Rich text is stored as a structured document and only ever rendered from this whitelist (tech design §6): memo and custom terms.
const MAX_JSON_CHARS = 200_000
const MAX_DEPTH = 12

interface Rule {
  children: ReadonlySet<string> | null
  attrs?: Readonly<Record<string, (v: unknown) => boolean>>
}

const INLINE = new Set(['text', 'hard_break'])
const BLOCKS = new Set(['paragraph', 'heading', 'bullet_list', 'ordered_list'])
const NODES = new Map<string, Rule>([
  ['doc', { children: BLOCKS }],
  ['paragraph', { children: INLINE }],
  ['heading', { children: INLINE, attrs: { level: (v) => v === 1 || v === 2 || v === 3 } }],
  ['bullet_list', { children: new Set(['list_item']) }],
  ['ordered_list', { children: new Set(['list_item']) }],
  ['list_item', { children: BLOCKS }],
  ['hard_break', { children: null }],
  ['text', { children: null }],
])

/** Only https, and no name and password hidden in front of the host. */
export function safeHttpsUrl(v: unknown): URL | null {
  if (typeof v !== 'string' || v.length > 2048) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname ? u : null
  } catch {
    return null
  }
}

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k))

function validMark(m: unknown): boolean {
  if (!plainObject(m)) return false
  if (m.type === 'strong' || m.type === 'em') return onlyKeys(m, ['type'])
  if (m.type !== 'link' || !onlyKeys(m, ['type', 'attrs']) || !plainObject(m.attrs) || !onlyKeys(m.attrs, ['href'])) return false
  return safeHttpsUrl(m.attrs.href) !== null
}

function validNode(n: unknown, allowed: ReadonlySet<string>, depth: number): boolean {
  if (depth > MAX_DEPTH || !plainObject(n) || typeof n.type !== 'string' || !allowed.has(n.type)) return false
  const rule = NODES.get(n.type)
  if (!rule || !onlyKeys(n, ['type', 'content', 'attrs', 'text', 'marks'])) return false
  if (n.type === 'text') {
    if (typeof n.text !== 'string' || !n.text || n.content !== undefined || n.attrs !== undefined) return false
    return n.marks === undefined || (Array.isArray(n.marks) && n.marks.every(validMark))
  }
  if (n.text !== undefined || n.marks !== undefined) return false
  if (rule.attrs) {
    const checks = rule.attrs
    if (!plainObject(n.attrs) || !onlyKeys(n.attrs, Object.keys(checks))) return false
    const attrs = n.attrs
    if (!Object.entries(checks).every(([k, ok]) => ok(attrs[k]))) return false
  } else if (n.attrs !== undefined) return false
  if (n.content === undefined) return true
  if (!rule.children || !Array.isArray(n.content)) return false
  const children = rule.children
  return n.content.every((c) => validNode(c, children, depth + 1))
}

/** Over the size a document may be: told apart so that a long memo is not refused for its formatting. */
export function richTextTooLong(doc: unknown): boolean {
  try {
    return (JSON.stringify(doc)?.length ?? 0) > MAX_JSON_CHARS
  } catch {
    return false
  }
}

/** True only for a document made entirely of what the renderer knows. Anything else is refused, not cleaned up. */
export function validRichText(doc: unknown): boolean {
  let size: number
  try {
    size = JSON.stringify(doc)?.length ?? Number.POSITIVE_INFINITY
  } catch {
    return false
  }
  return size <= MAX_JSON_CHARS && validNode(doc, new Set(['doc']), 0)
}

/** The words of a document, for a reviewer's checklist and for telling an empty document from a written one. */
export function richTextPlain(doc: unknown): string {
  if (!plainObject(doc)) return ''
  if (doc.type === 'text' && typeof doc.text === 'string') return doc.text
  // a line break typed inside a paragraph stays a line break: "due in" + break + "30 days" must not read "due in30 days"
  if (doc.type === 'hard_break') return '\n'
  if (!Array.isArray(doc.content)) return ''
  const parts = doc.content.map(richTextPlain)
  return parts.join(doc.type === 'doc' || doc.type === 'bullet_list' || doc.type === 'ordered_list' || doc.type === 'list_item' ? '\n' : '').trim()
}

type Inline = { type: 'text'; text: string; marks?: Array<{ type: 'strong' | 'em' } | { type: 'link'; attrs: { href: string } }> } | { type: 'hard_break' }
type Block = { type: string; attrs?: { level: number }; content?: unknown[] }

const INLINE_MARK = /\*\*(?=\S)(.+?)(?<=\S)\*\*|\*(?=\S)(.+?)(?<=\S)\*|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g

function inlineOf(line: string): Inline[] {
  const out: Inline[] = []
  const plain = (text: string) => {
    if (text) out.push({ type: 'text', text })
  }
  let at = 0
  for (const m of line.matchAll(INLINE_MARK)) {
    plain(line.slice(at, m.index))
    if (m[1]) out.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] })
    else if (m[2]) out.push({ type: 'text', text: m[2], marks: [{ type: 'em' }] })
    else if (safeHttpsUrl(m[4])) out.push({ type: 'text', text: m[3]!, marks: [{ type: 'link', attrs: { href: m[4]! } }] })
    else plain(m[0])
    at = m.index + m[0].length
  }
  plain(line.slice(at))
  return out
}

/**
 * The plain writing a lead types, as a structured document: `#` headings, `-` and `1.` lists, `**bold**`, `*italic*` and a link written as `[words]` followed by its secure address in brackets.
 * Nothing typed here can become markup: what is not one of these stays as text. An empty text is no document.
 */
export function markupToRichText(text: string): { type: 'doc'; content: Block[] } | null {
  const content: Block[] = []
  let paragraph: string[] = []
  let list: { type: 'bullet_list' | 'ordered_list'; items: string[] } | null = null
  const endParagraph = () => {
    if (paragraph.length) {
      const inline = paragraph.flatMap((l, i) => (i === 0 ? inlineOf(l) : [{ type: 'hard_break' } as const, ...inlineOf(l)]))
      content.push({ type: 'paragraph', content: inline })
    }
    paragraph = []
  }
  const endList = () => {
    if (list) content.push({ type: list.type, content: list.items.map((i) => ({ type: 'list_item', content: [{ type: 'paragraph', content: inlineOf(i) }] })) })
    list = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    const ordered = /^\d+\.\s+(.+)$/.exec(line)
    const kind = bullet ? 'bullet_list' : ordered ? 'ordered_list' : null
    if (!line || heading) {
      endParagraph()
      endList()
      if (heading) content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inlineOf(heading[2]!) })
    } else if (kind) {
      endParagraph()
      if ((list as { type: string } | null)?.type !== kind) endList()
      list ??= { type: kind, items: [] }
      ;(list as { items: string[] }).items.push((bullet ?? ordered)![1]!)
    } else {
      endList()
      paragraph.push(line)
    }
  }
  endParagraph()
  endList()
  return content.length ? { type: 'doc', content } : null
}

function inlineMarkup(nodes: unknown): string {
  if (!Array.isArray(nodes)) return ''
  return nodes
    .map((n: { type?: string; text?: string; marks?: Array<{ type: string; attrs?: { href?: string } }>; content?: unknown }) => {
      if (n.type === 'hard_break') return '\n'
      if (n.type !== 'text') return inlineMarkup(n.content)
      const mark = n.marks?.[0]
      if (mark?.type === 'strong') return `**${n.text}**`
      if (mark?.type === 'em') return `*${n.text}*`
      if (mark?.type === 'link') return `[${n.text}](${mark.attrs?.href})`
      return n.text ?? ''
    })
    .join('')
}

/** A stored document back as the writing above, for the same box it was typed in. */
export function richTextToMarkup(doc: unknown): string {
  if (!validRichText(doc)) return ''
  return (doc as { content?: Array<{ type: string; attrs?: { level: number }; content?: Array<{ content?: unknown }> }> }).content
    ?.map((b) => {
      if (b.type === 'heading') return `${'#'.repeat(b.attrs!.level)} ${inlineMarkup(b.content)}`
      if (b.type === 'bullet_list') return (b.content ?? []).map((i) => `- ${(i.content as Array<{ content?: unknown }> | undefined)?.map((p) => inlineMarkup(p.content)).join(' ')}`).join('\n')
      if (b.type === 'ordered_list') return (b.content ?? []).map((i, n) => `${n + 1}. ${(i.content as Array<{ content?: unknown }> | undefined)?.map((p) => inlineMarkup(p.content)).join(' ')}`).join('\n')
      return inlineMarkup(b.content)
    })
    .join('\n\n') ?? ''
}
