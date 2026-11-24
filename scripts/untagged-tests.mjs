// Test names that need no case id (CLAUDE.md: "Test names start with their TC id"; test-plan review T-06).
// Only generic security, session, hostile-input and tooling tests that own no requirement point belong here; a test that
// proves a requirement carries the id of the case that owns it. scripts/check-coverage.mjs fails on any other title.
export const UNTAGGED = [
  // src/lib/lib.test.ts
  'mulDiv works beyond 2^53 and rejects bad inputs',
  'deny by default and refuse a temporary password',
  // src/server/server.test.ts
  'a password change ends other sessions',
  'a session stops at once if the credential version moves or the account is disabled, even with the session row still there',
  'no session, a bad cookie and a missing CSRF token are refused',
  'wrong password, unknown email and hostile bodies get the same plain refusal',
  'sign-in locks after ten failures for that email, even with the right password',
  'parallel guesses cannot outrun the limit, and refused attempts add nothing to the audit log or the password work',
  'from one address, changing the email cannot grow the throttle table once that address is over its limit',
  'TRUST_PROXY takes an address or CIDR and refuses anything else',
  'the password-change route cannot be used to guess: after the limit, no password work and the right one fails too',
  'a session ending while the password change waits for the row stops it; so does one expiring during a wait',
  'signing out ends the session and is audited',
  'a NUL character is refused plainly, not a server error',
  'security headers are on every response',
  'the static route serves the page, refuses a path outside its folder and never answers for the API',
  'hostile request bodies are refused',
  'role grants: the application role cannot touch what it must not',
  'roles-only prepares a fresh server without touching the schema',
  // src/server/d1.test.ts
  "hostile: someone else's entity, bad bodies and bad files",
  'hostile F11: a NUL in a file name is refused, and a file whose row cannot be written is not left behind',
  'hostile: the 15 MB parser is only on the upload route',
  "hostile: strangers, junk bodies, another person's attempt",
  // e2e/d0.spec.ts
  'phone width has no sideways page scroll',
  // scripts/checks.test.ts
  'reads the milestone from the last cell and ignores other rows',
  'counts vitest and playwright reports, several ids in one title, and failures',
  'a test name with no case id is reported unless it is on the allow-list, and an allow-list entry no test uses is reported',
  "a case id in a test name with no row in the test plan is reported, whatever the row's milestone",
  'a line inside a test touches that test; inside a describe, all its tests; outside every describe, the whole file',
  'a block ends where its brackets balance: multi-line parameters, brackets in strings, templates and comments do not end it',
  'a slash after a keyword starts a regex: its brackets do not stretch the test over a shared helper (Codex group B r2 #3)',
  'every mutant command with a -t / -g name matches a test or describe by its fixed text, or a row on its own, not only a %s title the run expands (Codex group B r2 #2)',
  'a mutant is new unless the base defines the same file, original, replacement, label and command',
  'a command picks the touched tests its -t / -g name matches; a command with no name, or a whole-file change, runs them',
]
