import { test, expect } from '@playwright/test'

const repo = { id: 'repo-1', path: '/tmp/startup-project', defaultBranch: 'main' }
const task = {
  id: 'task-1',
  repoId: repo.id,
  title: 'Startup data loaded',
  prompt: 'Check startup loading.',
  mode: 'single',
  status: 'running',
  createdAt: '2025-01-01T00:00:00.000Z',
}
const config = {
  roles: Object.fromEntries(
    ['assistant_brain', 'background', 'orchestrator', 'implementer', 'reviewer', 'judge'].map((role) => [
      role,
      { provider: 'claude-cli', model: 'startup-test-model', effort: 'medium' },
    ]),
  ),
}

test('loads workspace when OpenAI key status is unavailable and retries the lookup', async ({
  page,
}, testInfo) => {
  let keyStatusRequests = 0
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/secrets/openai-api-key') {
      keyStatusRequests++
      if (keyStatusRequests === 1) await route.abort('failed')
      else await route.fulfill({ json: { set: false } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [task] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === `/api/tasks/${task.id}`) {
      await route.fulfill({
        json: { task, repo, attempts: [], reviews: [], events: [] },
      })
    } else {
      await route.continue()
    }
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByLabel('Implementer model')).toHaveValue('startup-test-model')
  await expect(page.getByRole('heading', { name: 'OpenAI API key' })).toBeVisible()
  await expect(page.getByText('Unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry key status' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('key-status-unavailable.png'), fullPage: true })
  await page.getByRole('button', { name: 'Retry key status' }).click()
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible()
  expect(keyStatusRequests).toBe(2)
})
