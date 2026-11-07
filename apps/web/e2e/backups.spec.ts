import { expect, test } from '@playwright/test'
import { openSettings, openSettingsSection } from './helpers.js'

const config = {
  autonomy_mode: 'normal',
  roles: Object.fromEntries(
    ['assistant_brain', 'background', 'orchestrator', 'implementer', 'reviewer', 'judge'].map((role) => [
      role,
      { provider: 'claude-cli', model: 'backup-test-model', effort: 'low' },
    ]),
  ),
}

test('backups are listed, can be taken now, and the export downloads as JSON', async ({ page }) => {
  let backups = [{ day: '2026-11-05', bytes: 2048 }]
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/backups' && request.method() === 'POST') {
      backups = [{ day: '2026-11-06', bytes: 4096 }, ...backups]
      await route.fulfill({ json: { created: '/home/.joy/backups/joy-2026-11-06.sqlite', backups } })
    } else if (path === '/api/backups') {
      await route.fulfill({ json: { backups } })
    } else if (path === '/api/logs') {
      await route.fulfill({ json: { logs: [{ day: '2026-11-06', name: 'joy-2026-11-06.log', bytes: 512 }] } })
    } else if (path === '/api/logs/2026-11-06') {
      await route.fulfill({ contentType: 'text/plain', body: '{"msg":"task finished"}\n' })
    } else if (path === '/api/export') {
      await route.fulfill({ contentType: 'application/json', body: '{"format":"joy-export"}' })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === '/api/secrets/openai-api-key') {
      await route.fulfill({ json: { set: false } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await openSettings(page, '資料與備份')
  const panel = page.getByTestId('backups-panel')
  await expect(panel).toContainText('2026-11-05 · 2.0 KB')
  await panel.getByRole('button', { name: '立即備份' }).click()
  await expect(panel).toContainText('已備份。')
  await expect(panel).toContainText('2026-11-06 · 4.0 KB')
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: /匯出任務和記憶/ }).click()
  expect((await download).suggestedFilename()).toMatch(/^joy-export-\d{4}-\d{2}-\d{2}\.json$/)

  await openSettingsSection(page, '進階')
  const logs = page.getByTestId('logs-panel')
  await expect(logs).toContainText('2026-11-06 · 512 B')
  const logDownload = page.waitForEvent('download')
  await logs.getByRole('button', { name: '下載' }).click()
  expect((await logDownload).suggestedFilename()).toBe('joy-2026-11-06.log')
})
