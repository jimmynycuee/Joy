import { defineConfig } from '@playwright/test'

const runId = process.env.JOY_E2E_RUN_ID ?? 'standalone'
const apiPort = Number(process.env.JOY_E2E_API_PORT ?? 4317)
const webPort = Number(process.env.JOY_E2E_WEB_PORT ?? 4173)

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: `./test-results/${runId}`,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @joy/web exec node --import tsx e2e/fake-preview.ts',
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      JOY_E2E_API_PORT: String(apiPort),
      JOY_E2E_WEB_PORT: String(webPort),
    },
  },
})
