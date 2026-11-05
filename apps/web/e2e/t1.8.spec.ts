import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import type { ModelRef } from '@joy/core'

test('settings, secure key status, and a complete fake-provider task flow', async ({
  page,
  request,
}, testInfo) => {
  const runId = randomUUID()
  const repositoryPath = join(tmpdir(), `joy-e2e-project-${runId}`)
  const taskTitle = `Show the fake diff ${runId}`
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Task activity' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Diff viewer' })).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  for (const role of ['Assistant brain', 'Background', 'Orchestrator', 'Implementer', 'Reviewer', 'Judge']) {
    await expect(page.getByLabel(`${role} provider`)).toBeVisible()
    await expect(page.getByLabel(`${role} model`)).toBeVisible()
  }
  await page.getByLabel('Implementer provider').selectOption('openai-api')
  await expect(page.getByLabel('Implementer model')).toHaveValue('gpt-6-luna')
  await page.screenshot({ path: testInfo.outputPath('t1.8-provider-switch.png'), fullPage: true })
  await page.getByLabel('Implementer model').fill('fake-ui-model')
  await page.getByRole('button', { name: 'Save role settings' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Role and model settings saved' })).toBeVisible()

  const secret = `fake-openai-key-must-never-return-${runId}`
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/secrets/openai-api-key') && response.request().method() === 'PUT',
  )
  await page.locator('#openai-key').fill(secret)
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
  await page.screenshot({ path: testInfo.outputPath('t1.8-settings.png'), fullPage: true })

  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  const manageRepositories = page.getByRole('button', { name: 'Manage repositories' })
  if (await manageRepositories.isVisible()) {
    await manageRepositories.click()
  } else {
    await page.getByRole('button', { name: 'Add repository' }).click()
  }
  const repoDialog = page.getByRole('dialog', { name: 'Add repository' })
  await repoDialog.getByLabel('Repository path').fill(repositoryPath)
  await repoDialog.getByLabel('Default branch').fill('main')
  await repoDialog.getByRole('button', { name: 'Add repository' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Repository added to this Joy server.' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await taskDialog.getByLabel('Task repository').selectOption({ label: repositoryPath })
  await taskDialog.getByLabel('Task title').fill(taskTitle)
  await taskDialog.getByLabel('Task instructions').fill('Update the greeting and explain the result.')
  await taskDialog.getByLabel('Reviewer provider').selectOption('claude-cli')
  await expect(taskDialog.getByLabel('Reviewer model')).toHaveValue('opus')
  await taskDialog.getByLabel('Reviewer provider').selectOption('codex-cli')
  await expect(taskDialog.getByLabel('Reviewer model')).toHaveValue('gpt-6.1-sol')
  await expect(taskDialog.locator('option[value="compete"]')).toBeEnabled()
  await expect(taskDialog.getByLabel('Workflow')).toHaveValue('review_loop')
  await taskDialog.getByRole('button', { name: 'Start task' }).click()

  await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible()
  await expect(page.getByTestId('event-stream')).toContainText(
    'Fake provider completed: openai-api:fake-ui-model',
  )
  await expect(page.getByTestId('event-stream')).toContainText('Review: Fake review approved')
  await expect(page.getByTestId('diff-patch')).toContainText('hello from fake')
  await expect(page.getByText('done', { exact: true })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(secret)

  const taskListResponse = await request.get('/api/tasks')
  const taskList = (await taskListResponse.json()) as { tasks: Array<{ id: string; title: string }> }
  const createdTask = taskList.tasks.find((task) => task.title === taskTitle)
  expect(createdTask).toBeDefined()
  const detailResponse = await request.get(`/api/tasks/${createdTask?.id}`)
  const details = (await detailResponse.json()) as {
    task: { roleOverrides: { implementer: ModelRef } }
    attempts: Array<{ provider: string; model: string }>
    events: Array<{ payload: unknown }>
  }
  expect(details.task.roleOverrides.implementer).toMatchObject({
    provider: 'openai-api',
    model: 'fake-ui-model',
  })
  expect(details.attempts[0]).toMatchObject({ provider: 'openai-api', model: 'fake-ui-model' })
  expect(JSON.stringify(details.events)).not.toContain(secret)
  await page.waitForTimeout(4100)
  await page.screenshot({ path: testInfo.outputPath('t1.8-workspace.png'), fullPage: true })
})

test('backs off repeated WebSocket reconnects', async ({ page }) => {
  const repo = { id: 'reconnect-repo', path: join(tmpdir(), 'joy-reconnect-backoff'), defaultBranch: 'main' }
  const task = {
    id: 'reconnect-backoff-task',
    repoId: repo.id,
    title: 'WebSocket reconnect backoff',
    prompt: 'Verify reconnect pacing.',
    mode: 'single',
    status: 'running',
    createdAt: '2025-01-01T00:00:00.000Z',
  }
  let socketConnections = 0
  const connectionTimes: number[] = []

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks' && route.request().method() === 'GET') {
      await route.fulfill({ json: { tasks: [task] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config: { roles: {} } } })
    } else if (path === '/api/secrets/openai-api-key') {
      await route.fulfill({ json: { set: false } })
    } else if (path === `/api/tasks/${task.id}/events`) {
      await route.fulfill({ json: { events: [] } })
    } else if (path === `/api/tasks/${task.id}`) {
      await route.fulfill({ json: { task, repo, attempts: [], reviews: [], events: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
  await page.routeWebSocket(/\/ws\?taskId=reconnect-backoff-task$/, (webSocket) => {
    socketConnections++
    connectionTimes.push(Date.now())
    webSocket.close({ code: 1000, reason: 'simulated disconnect' })
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
  await expect.poll(() => socketConnections, { timeout: 4_000 }).toBe(3)
  const firstReconnectAt = connectionTimes[1]
  const secondReconnectAt = connectionTimes[2]
  expect(firstReconnectAt).toBeDefined()
  expect(secondReconnectAt).toBeDefined()
  expect((secondReconnectAt ?? 0) - (firstReconnectAt ?? 0)).toBeGreaterThanOrEqual(800)
})
