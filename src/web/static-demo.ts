// The static demo's own parts (plan 05 §5.1, §5.4): the banner with the view switch, the line that answers a change, and file
// choosers that never read a file. Plain DOM outside the app's root, so the app's screens stay as they are.
import { addressFor, clockInWords, DEMO_NO_CHANGE, VIEWS, type DemoPack, type View } from '../demo/snapshot.ts'
import './static-demo.css'

const ROLE: Record<View, string> = { investor: 'Investor', lead: 'Lead', reviewer: 'Reviewer' }

let note: HTMLElement | null = null
let pending: number | undefined

/** Says the demo sentence where everyone sees it, whatever the screen does with the refusal. */
export function showDemoNote(text = DEMO_NO_CHANGE) {
  if (!note) return
  // emptied first so the same sentence twice is announced twice
  clearDemoNote()
  pending = window.setTimeout(() => {
    pending = undefined
    if (note) note.textContent = text
  }, 50)
}

/** Another page: what the note said was about the last one (Codex P r2 #11), a sentence still to come too. */
export function clearDemoNote() {
  window.clearTimeout(pending)
  pending = undefined
  if (note) note.textContent = ''
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: Array<Node | string>) => {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...kids)
  return e
}

export function startDemo(pack: DemoPack, view: View) {
  const bar = el('div', { className: 'demo-bar', id: 'demo-bar' })
  bar.setAttribute('role', 'region')
  bar.setAttribute('aria-label', 'Demo')
  bar.append(
    el(
      'p',
      {},
      el('strong', {}, 'Demo: fictional data. Software demo, not a service, not an offer.'),
      ` Snapshot v${pack.version}, data as of ${clockInWords(pack.clock)}. `,
      el('a', { href: '../' }, 'Back to Bulma'),
    ),
  )
  const views = el('nav', { className: 'demo-views' }, 'See it as: ')
  views.setAttribute('aria-label', 'Demo view')
  for (const v of VIEWS) {
    const a = el('a', { href: addressFor(v, '/') }, `${ROLE[v]} (${pack.views[v].name})`)
    if (v === view) a.setAttribute('aria-current', 'page')
    views.append(a, ' ')
  }
  note = el('p', { className: 'demo-note', id: 'demo-note' })
  note.setAttribute('role', 'status')
  bar.append(views, note)
  document.body.prepend(bar)

  // a file chooser never opens and a dropped file is never read (Money.tsx reads a chosen CSV in the browser)
  const fileInput = (t: EventTarget | null) => t instanceof HTMLInputElement && t.type === 'file'
  document.addEventListener(
    'click',
    (e) => {
      if (!fileInput(e.target)) return
      e.preventDefault()
      showDemoNote()
    },
    true,
  )
  for (const type of ['change', 'input'])
    document.addEventListener(
      type,
      (e) => {
        if (!fileInput(e.target)) return
        e.stopImmediatePropagation()
        ;(e.target as HTMLInputElement).value = ''
        showDemoNote()
      },
      true,
    )
  for (const type of ['dragover', 'drop'])
    document.addEventListener(
      type,
      (e) => {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (type === 'drop') showDemoNote()
      },
      true,
    )
}
