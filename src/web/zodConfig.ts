// Imported first by main.tsx, before any schema is made or used. zod probes for eval with `new Function`; under the strict
// CSP (no 'unsafe-eval': the app's own and the website's for the demo pack) the probe fails as it should, but the browser
// still reports a CSP violation each time a page loads. `jitless` skips the probe and zod's compiled fast path; what zod
// accepts and refuses is the same either way.
import { config } from 'zod'

config({ jitless: true })
