import { expect, test } from '@playwright/test'

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
  await page.getByRole('button', { name: 'Settings' }).click()
  const panel = page.getByTestId('backups-panel')
  await expect(panel).toContainText('2026-11-05 · 2.0 KB')
  await panel.getByRole('button', { name: 'Back up now' }).click()
  await expect(panel).toContainText('Backup taken.')
  await expect(panel).toContainText('2026-11-06 · 4.0 KB')
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: /Export tasks and memories/ }).click()
  expect((await download).suggestedFilename()).toMatch(/^joy-export-\d{4}-\d{2}-\d{2}\.json$/)
})
