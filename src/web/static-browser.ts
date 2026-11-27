// The static demo's browser.ts (plan 05 §5.1): addresses are hashes `#/<view><path>?<query>`, so a deep link, a refresh, back
// and a new tab work on a static host under any folder; the view is the first part. Today is the pack's fixed clock.
import { addressFor, fileLinkFor, parseAddress, type DemoPack, type View } from '../demo/snapshot.ts'
import { clearDemoNote, startDemo } from './static-demo.ts'

declare global {
  // set by data/snapshot.js, a plain script loaded before the app
  var BULMA_DEMO: DemoPack | undefined
}

export function pack(): DemoPack {
  if (!globalThis.BULMA_DEMO) throw new Error('data/snapshot.js did not load')
  return globalThis.BULMA_DEMO
}

// an address without a view (the pack's front door, or a typed one) is the investor's home
if (!parseAddress(window.location.hash)) window.history.replaceState(null, '', addressFor('investor', '/'))
const loaded: View = parseAddress(window.location.hash)!.view
const stepAt = (hash: string) => new URLSearchParams(parseAddress(hash)?.search ?? '').get('step')
// the step and page last shown, kept up to date across the app's own moves too (they make no hashchange; Codex P r3 #10, #11)
let shownStep = stepAt(window.location.hash)
let shownPath = parseAddress(window.location.hash)!.path
/** After any move: the demo note goes only when the page changes, not on a query of the same page (Codex P r3 #11). */
function moved() {
  const path = parseAddress(window.location.hash)?.path
  if (path !== shownPath) clearDemoNote()
  shownPath = path ?? '/'
}

/** The view this page was loaded in; another view is another load (its own signed-in person and answers). */
export const view = () => loaded

export function here() {
  const a = parseAddress(window.location.hash)
  return a ? { path: a.path, search: a.search } : { path: '/', search: '' }
}

export const pageHref = (page: string) => addressFor(loaded, page)

/** The step a deep link opens (`#/investor/invest/<id>?step=pay`: the payment details, the site's list item 8). */
export const openStep = () => new URLSearchParams(here().search).get('step')

export const fileLink = (url: string, name?: string) => fileLinkFor(pack(), loaded, url, name)

export function setAddress(page: string, how: 'push' | 'replace' = 'push') {
  if (how === 'push') window.history.pushState(null, '', pageHref(page))
  else window.history.replaceState(null, '', pageHref(page))
  shownStep = stepAt(window.location.hash)
  moved()
}

// a hash-only move: the browser fires popstate, which the screens follow
export const openPage = (page: string) => window.location.assign(pageHref(page))

export const today = () => pack().clock.slice(0, 10)

// the view switch, back and forward across views, or a typed address: load again in that view. A link carrying a token (the
// payment details' "Check these details") loads again too: the app reads a token once, at load, as the normal build's full
// page load gives it (plan 05 §5.3)
// So does a move to or from the payment step's link (`?step=pay`), which the screen reads when it opens (Codex P r2 #10),
// against the step last shown, whichever way the address got there (Codex P r3 #10).
window.addEventListener('hashchange', () => {
  const a = parseAddress(window.location.hash)
  const step = stepAt(window.location.hash)
  if (a?.view !== loaded || new URLSearchParams(a.search).has('token') || step !== shownStep) window.location.reload()
  shownStep = step
})
// back, forward or a link to another page: the note was about the page left (Codex P r2 #11)
window.addEventListener('popstate', moved)

startDemo(pack(), loaded)
