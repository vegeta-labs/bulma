import { defineConfig, devices } from '@playwright/test'

// E2E_PORT lets this run beside something else on 4318; the default is unchanged
const port = Number(process.env.E2E_PORT ?? 4318)

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-report.json' }]],
  use: { baseURL: `http://127.0.0.1:${port}`, ...devices['Desktop Chrome'] },
  webServer: { command: 'npm run build && node --experimental-strip-types --no-warnings e2e/serve.ts', url: `http://127.0.0.1:${port}/api/health`, timeout: 180_000, reuseExistingServer: false },
})
