// What the screens take from the browser: the page's address and today's date. The static demo build puts
// static-browser.ts in its place (hash addresses and the pack's fixed clock; vite.demo.config.ts).

/** The page the browser is on: path and query of the normal build (`/deals/x`, `?import=y`). */
export const here = () => ({ path: window.location.pathname, search: window.location.search })

/** The address a link to a page of the normal build (`/deals/x?y=1`) carries. */
export const pageHref = (page: string) => page

/**
 * A link to a file the server sends (`/api/...`: a PDF, a CSV): its `href`, and the name to save it under when the screen
 * gives one. The static demo points it at the pack's copy or at a page that says why there is none (plan 05 §5.3).
 */
export const fileLink = (url: string, name?: string): { href: string; download?: string } => ({ href: url, ...(name ? { download: name } : {}) })

/** Moves to a page without loading again (the screens listen for `popstate`). */
export function setAddress(page: string, how: 'push' | 'replace' = 'push') {
  if (how === 'push') window.history.pushState(null, '', pageHref(page))
  else window.history.replaceState(null, '', pageHref(page))
}

/** Loads a page afresh (after a change the whole screen depends on). */
export const openPage = (page: string) => window.location.assign(pageHref(page))

/** Today as `yyyy-mm-dd` (UTC), the default of date fields. */
export const today = () => new Date().toISOString().slice(0, 10)

/** A step of a page the address opens: only the static demo has such addresses (its payment-step link); here, none. */
export const openStep = (): string | null => null
