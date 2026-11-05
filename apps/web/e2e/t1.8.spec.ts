import { test, expect } from '@playwright/test'
import type { ModelRef } from '@joy/core'

test('settings, secure key status, and a complete fake-provider task flow', async ({ page, request }) => {
  const clientAuthorizationHeaders: Array<string | undefined> = []
  page.on('request', (browserRequest) => {
    if (browserRequest.url().includes('/api/'))
      clientAuthorizationHeaders.push(browserRequest.headers().authorization)
  })
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    const body = (await response.json()) as { config: { roles: Record<string, unknown> } }
    body.config.roles.implementer = { provider: 'openai-api', model: 'gpt-6-luna', effort: 'medium' }
    await route.fulfill({ response, json: body })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Task activity' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Diff viewer' })).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'OpenAI API cannot edit code' })).toBeVisible()
  await page.screenshot({ path: 'test-results/t1.8-legacy-openai-implementer.png', fullPage: true })
  for (const role of ['Assistant brain', 'Background', 'Orchestrator', 'Implementer', 'Reviewer', 'Judge']) {
    await expect(page.getByLabel(`${role} provider`)).toBeVisible()
    await expect(page.getByLabel(`${role} model`)).toBeVisible()
  }
  const settingsImplementerProvider = page.getByLabel('Implementer provider')
  await expect(settingsImplementerProvider.locator('option[value="openai-api"]')).toHaveCount(0)
  await settingsImplementerProvider.selectOption('claude-cli')
  await page.getByLabel('Implementer model').fill('claude-opus-4-6')
  await page.getByRole('button', { name: 'Save role settings' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Role and model settings saved' })).toBeVisible()

  const secret = 'fake-openai-key-must-never-return-41'
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/secrets/openai-api-key') && response.request().method() === 'PUT',
  )
  await page.getByLabel('Enter key').fill(secret)
  await page.getByRole('button', { name: 'Save key' }).click()
  const keyResponse = await responsePromise
  expect(keyResponse.status()).toBe(200)
  expect(await keyResponse.text()).not.toContain(secret)
  await expect(page.getByText('Configured', { exact: true })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(secret)
  await expect(page.locator('#openai-key')).toHaveValue('')
  const configResponse = await request.get('/api/config')
  expect(await configResponse.text()).not.toContain(secret)
  await page.waitForTimeout(4100)
  await page.screenshot({ path: 'test-results/t1.8-settings.png', fullPage: true })

  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await page.getByRole('button', { name: 'Add repository' }).click()
  const repoDialog = page.getByRole('dialog', { name: 'Add repository' })
  await repoDialog.getByLabel('Repository path').fill('/tmp/joy-e2e-project')
  await repoDialog.getByLabel('Default branch').fill('main')
  await repoDialog.getByRole('button', { name: 'Add repository' }).click()
  await expect(page.getByText('Your tasks will appear here.')).toBeVisible()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await expect(
    taskDialog.getByLabel('Implementer provider').locator('option[value="openai-api"]'),
  ).toHaveCount(0)
  await taskDialog.getByLabel('Task repository').selectOption({ index: 1 })
  await taskDialog.getByLabel('Task title').fill('Show the fake diff')
  await taskDialog.getByLabel('Task instructions').fill('Update the greeting and explain the result.')
  expect(await taskDialog.locator('option[value="compete"]').getAttribute('disabled')).toBe('')
  await taskDialog.getByRole('button', { name: 'Start task' }).click()

  await expect(page.getByRole('heading', { name: 'Show the fake diff' })).toBeVisible()
  await expect(page.getByTestId('event-stream')).toContainText(
    'Fake provider completed: claude-cli:claude-opus-4-6',
  )
  await expect(page.getByTestId('event-stream')).toContainText('Review: Fake review approved')
  await expect(page.getByTestId('diff-patch')).toContainText('hello from fake')
  await expect(page.getByText('done', { exact: true })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(secret)

  const taskListResponse = await request.get('/api/tasks')
  const taskList = (await taskListResponse.json()) as { tasks: Array<{ id: string; title: string }> }
  const createdTask = taskList.tasks.find((task) => task.title === 'Show the fake diff')
  expect(createdTask).toBeDefined()
  const detailResponse = await request.get(`/api/tasks/${createdTask?.id}`)
  const details = (await detailResponse.json()) as {
    task: { roleOverrides: { implementer: ModelRef } }
    attempts: Array<{ provider: string; model: string }>
    events: Array<{ payload: unknown }>
  }
  expect(details.task.roleOverrides.implementer).toMatchObject({
    provider: 'claude-cli',
    model: 'claude-opus-4-6',
  })
  expect(details.attempts[0]).toMatchObject({ provider: 'claude-cli', model: 'claude-opus-4-6' })
  expect(JSON.stringify(details.events)).not.toContain(secret)
  expect(clientAuthorizationHeaders.every((header) => header === undefined)).toBe(true)
  await page.waitForTimeout(4100)
  await page.screenshot({ path: 'test-results/t1.8-workspace.png', fullPage: true })
})
