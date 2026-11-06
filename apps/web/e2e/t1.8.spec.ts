import { test, expect } from '@playwright/test'
import type { ModelRef } from '@joy/core'
import { E2E_API_TOKEN } from './fakes.js'

test('settings, secure key status, and a complete fake-provider task flow', async ({ page, request }) => {
  const apiRequests: Array<{ method: string; url: string; authorization: string | undefined }> = []
  await page.addInitScript(() => {
    const nativeWebSocket = window.WebSocket
    const captureWindow = window as Window & {
      __joyWebSocketCaptures?: Array<{
        url: string
        protocols: string | string[] | undefined
        negotiatedProtocol: string
      }>
    }
    captureWindow.__joyWebSocketCaptures = []
    window.WebSocket = class extends nativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const capture = {
          url: String(url),
          protocols: Array.isArray(protocols) ? [...protocols] : protocols,
          negotiatedProtocol: '',
        }
        super(url, protocols)
        captureWindow.__joyWebSocketCaptures?.push(capture)
        this.addEventListener('open', () => {
          capture.negotiatedProtocol = this.protocol
        })
      }
    }
  })
  page.on('request', (apiRequest) => {
    if (new URL(apiRequest.url()).pathname.startsWith('/api/')) {
      apiRequests.push({
        method: apiRequest.method(),
        url: apiRequest.url(),
        authorization: apiRequest.headers()['authorization'],
      })
    }
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
  const autonomyMode = page.getByLabel('Global autonomy mode')
  await expect(autonomyMode).toHaveValue('normal')
  await autonomyMode.selectOption('careful')
  const settingsImplementerProvider = page.getByLabel('Implementer provider')
  await expect(settingsImplementerProvider.locator('option[value="openai-api"]')).toHaveCount(0)
  await settingsImplementerProvider.selectOption('claude-cli')
  await page.getByLabel('Implementer model').fill('claude-opus-4-6')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()

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
  const configResponse = await request.get('/api/config', {
    headers: { authorization: `Bearer ${E2E_API_TOKEN}` },
  })
  const savedConfig = (await configResponse.json()) as { config: { autonomy_mode: string } }
  expect(savedConfig.config.autonomy_mode).toBe('careful')
  expect(JSON.stringify(savedConfig)).not.toContain(secret)
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

  const taskListResponse = await request.get('/api/tasks', {
    headers: { authorization: `Bearer ${E2E_API_TOKEN}` },
  })
  const taskList = (await taskListResponse.json()) as { tasks: Array<{ id: string; title: string }> }
  const createdTask = taskList.tasks.find((task) => task.title === 'Show the fake diff')
  expect(createdTask).toBeDefined()
  const detailResponse = await request.get(`/api/tasks/${createdTask?.id}`, {
    headers: { authorization: `Bearer ${E2E_API_TOKEN}` },
  })
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
  expect((await page.locator('body').innerText()).includes(E2E_API_TOKEN)).toBe(false)
  expect(apiRequests.length).toBeGreaterThan(0)
  expect(apiRequests.every(({ url }) => !url.includes(E2E_API_TOKEN))).toBe(true)
  expect(apiRequests.some(({ method }) => method === 'GET')).toBe(true)
  expect(apiRequests.every(({ authorization }) => authorization === `Bearer ${E2E_API_TOKEN}`)).toBe(true)
  const socketCaptures = await page.evaluate(
    () =>
      (
        window as Window & {
          __joyWebSocketCaptures?: Array<{
            url: string
            protocols: string | string[] | undefined
            negotiatedProtocol: string
          }>
        }
      ).__joyWebSocketCaptures ?? [],
  )
  const taskSockets = socketCaptures.filter(({ url }) => url.includes('/ws?taskId='))
  expect(taskSockets.length > 0).toBe(true)
  expect(
    taskSockets.every(
      ({ protocols, url }) =>
        Array.isArray(protocols) &&
        protocols[0] === 'joy' &&
        protocols[1] === `joy-auth.${E2E_API_TOKEN}` &&
        !url.includes(E2E_API_TOKEN),
    ),
  ).toBe(true)
  expect(taskSockets.some(({ negotiatedProtocol }) => negotiatedProtocol === 'joy')).toBe(true)
  await page.waitForTimeout(4100)
  await page.screenshot({ path: 'test-results/t1.8-workspace.png', fullPage: true })
})
