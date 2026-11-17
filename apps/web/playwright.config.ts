import { defineConfig } from '@playwright/test'
import { E2E_WEB_ORIGIN } from './e2e/ports.js'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: 'list',
  outputDir: './test-results',
  use: {
    baseURL: E2E_WEB_ORIGIN,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @joy/web exec node --import tsx e2e/fake-preview.ts',
    url: E2E_WEB_ORIGIN,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
