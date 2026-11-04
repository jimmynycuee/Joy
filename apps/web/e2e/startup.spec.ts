import { expect, test } from '@playwright/test'

const repo = { id: 'repo-startup', path: '/tmp/startup-project', defaultBranch: 'main' }
const task = {
  id: 'task-startup',
  repoId: repo.id,
  title: 'Workspace loads without keychain',
  prompt: 'The keychain may be unavailable.',
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

test('workspace and settings remain usable while key status is unavailable and can be retried', async ({
  page,
}) => {
  let keyStatusRequests = 0
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/secrets/openai-api-key') {
      keyStatusRequests++
      if (keyStatusRequests === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Keychain is unavailable' }),
        })
      } else {
        await route.fulfill({ json: { set: false } })
      }
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [task] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === `/api/tasks/${task.id}`) {
      await route.fulfill({ json: { task, repo, attempts: [], reviews: [], events: [] } })
    } else {
      await route.continue()
    }
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('button', { name: 'Save role settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'OpenAI API key' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Unavailable' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry key status' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Not configured' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry key status' })).toHaveCount(0)
  expect(keyStatusRequests).toBe(2)
})
