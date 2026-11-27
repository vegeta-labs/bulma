import { defineConfig, devices } from '@playwright/test'

// TC-DEMO-09/10/11: the packed static demo (scripts/demo-pack.ts) under the website's headers at /bulma/demo/. Its own port,
// so it can run beside the app's browser tests (4318) and the export (4329).
const port = Number(process.env.DEMO_E2E_PORT ?? 4331)

export default defineConfig({
  testDir: 'e2e-demo',
  timeout: 120_000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-demo-report.json' }]],
  use: { baseURL: `http://127.0.0.1:${port}`, ...devices['Desktop Chrome'], acceptDownloads: true },
  webServer: {
    command: 'node --experimental-strip-types --no-warnings e2e-demo/serve.ts',
    url: `http://127.0.0.1:${port}/bulma/`,
    timeout: 30_000,
    reuseExistingServer: false,
  },
})
