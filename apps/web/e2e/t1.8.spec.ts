import { test, expect } from '@playwright/test'
import type { ModelRef } from '@joy/core'
import { E2E_API_TOKEN } from './fakes.js'
import { openSettings, openSettingsSection } from './helpers.js'

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
  await expect(page.getByRole('navigation', { name: '主選單' })).toBeVisible()
  // No project yet: the home page asks for one.
  await expect(page.getByRole('heading', { name: '先加入一個專案' })).toBeVisible()

  await openSettings(page)
  await expect(page.getByRole('heading', { name: '設定' })).toBeVisible()
  await openSettingsSection(page, '模型')
  await expect(page.getByRole('status').filter({ hasText: 'OpenAI API 不能改程式碼' })).toBeVisible()
  await page.screenshot({ path: 'test-results/t1.8-legacy-openai-implementer.png', fullPage: true })
  // The six roles live behind the disclosure under the model presets.
  await page.getByRole('button', { name: '各角色的詳細設定' }).click()
  for (const role of ['助理大腦', '背景工作', '調度者', '實作者', '審查者', '裁判']) {
    await expect(page.getByLabel(`${role}的服務`)).toBeVisible()
    await expect(page.getByLabel(`${role}的模型`)).toBeVisible()
  }
  await openSettingsSection(page, '權限與自主')
  const autonomyMode = page.getByLabel('自主程度')
  await expect(autonomyMode).toHaveValue('normal')
  await autonomyMode.selectOption('careful')
  // One draft is shared by both sections: saving from 模型 also saves the autonomy mode.
  await openSettingsSection(page, '模型')
  const settingsImplementerProvider = page.getByLabel('實作者的服務')
  await expect(settingsImplementerProvider.locator('option[value="openai-api"]')).toHaveCount(0)
  await settingsImplementerProvider.selectOption('claude-cli')
  await page.getByLabel('實作者的模型').fill('claude-opus-4-6')
  await page.getByRole('button', { name: '儲存設定' }).click()
  await expect(page.getByRole('status').filter({ hasText: '設定已儲存' })).toBeVisible()

  const secret = 'fake-openai-key-must-never-return-41'
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/secrets/openai-api-key') && response.request().method() === 'PUT',
  )
  await page.getByLabel('輸入金鑰').fill(secret)
  await page.getByRole('button', { name: '儲存金鑰' }).click()
  const keyResponse = await responsePromise
  expect(keyResponse.status()).toBe(200)
  expect(await keyResponse.text()).not.toContain(secret)
  await expect(page.getByText('已設定', { exact: true })).toBeVisible()
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

  await page.getByRole('button', { name: '新任務' }).click()
  await page.getByRole('button', { name: '加入專案' }).first().click()
  const repoDialog = page.getByRole('dialog', { name: '加入專案' })
  await repoDialog.getByLabel('專案路徑').fill('/tmp/joy-e2e-project')
  await repoDialog.getByLabel('預設分支').fill('main')
  await repoDialog.getByRole('button', { name: '加入專案' }).click()
  await expect(page.getByText('你的任務會出現在這裡。')).toBeVisible()

  const taskDialog = page.locator('form.composer-home')
  await taskDialog.getByRole('button', { name: '進階' }).click()
  await expect(taskDialog.getByLabel('實作者的服務').locator('option[value="openai-api"]')).toHaveCount(0)
  await taskDialog.getByLabel('專案').selectOption({ index: 0 })
  await taskDialog.getByLabel('任務標題').fill('Show the fake diff')
  await taskDialog.getByLabel('任務內容').fill('Update the greeting and explain the result.')
  expect(await taskDialog.locator('option[value="compete"]').getAttribute('disabled')).toBeNull()
  await taskDialog.getByRole('button', { name: '開始任務' }).click()

  await expect(page.getByRole('heading', { name: 'Show the fake diff' })).toBeVisible()
  await expect(page.getByTestId('event-stream')).toContainText(
    'Fake provider completed: claude-cli:claude-opus-4-6',
  )
  await expect(page.getByTestId('event-stream')).toContainText('程式變更審查通過')
  await expect(page.getByTestId('event-stream')).toContainText('Fake review approved')
  await expect(page.getByTestId('diff-patch')).toContainText('hello from fake')
  await expect(page.locator('.thread-header .status-pill')).toHaveText('完成')
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
