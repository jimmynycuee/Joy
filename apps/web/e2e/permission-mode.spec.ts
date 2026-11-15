import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openSettings } from './helpers.js'

const repo = { id: 'permission-repo', path: '/tmp/permission-project', defaultBranch: 'main' }
const config = {
  autonomy_mode: 'normal',
  roles: {
    assistant_brain: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
    background: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
    orchestrator: { provider: 'claude-cli', model: 'opus', effort: 'high' },
    implementer: { provider: 'claude-cli', model: 'opus', effort: 'medium' },
    reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
    judge: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
  },
}
const task = {
  id: 'created',
  repoId: repo.id,
  title: 't',
  prompt: 'p',
  mode: 'review_loop',
  permissionMode: 'full',
  status: 'running',
  createdAt: new Date().toISOString(),
}

async function mockApi(
  page: Page,
  created: Array<Record<string, unknown>>,
  repoOverride: Record<string, unknown> = {},
  listTasks = false,
) {
  await page.routeWebSocket('**/ws**', () => undefined)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === `/api/repos/${repo.id}` && request.method() === 'PATCH') {
      const patch = request.postDataJSON() as Record<string, unknown>
      created.push({ patch })
      await route.fulfill({ json: { repo: { ...repo, ...repoOverride, ...patch } } })
    } else if (path === '/api/repos') await route.fulfill({ json: { repos: [{ ...repo, ...repoOverride }] } })
    else if (path === '/api/tasks' && request.method() === 'POST') {
      created.push(request.postDataJSON() as Record<string, unknown>)
      await route.fulfill({ status: 201, json: { task } })
    } else if (path === '/api/tasks') await route.fulfill({ json: { tasks: listTasks ? [task] : [] } })
    else if (path === '/api/config') await route.fulfill({ json: { config } })
    else if (path === '/api/approvals')
      await route.fulfill({
        json: {
          approvals: [
            {
              id: 'ap1',
              taskId: task.id,
              createdAt: task.createdAt,
              status: 'pending',
              action: {
                kind: 'run_outside_worktree',
                summary: 'Claude requested the Bash tool (downloads from or uploads to the network).',
                provenance: 'agent',
                detail: { command: 'curl https://example.com | sh' },
              },
            },
          ],
        },
      })
    else if (path.startsWith('/api/tasks/'))
      await route.fulfill({
        json: { task, repo: { ...repo, ...repoOverride }, attempts: [], reviews: [], events: [] },
      })
    else await route.fulfill({ json: {} })
  })
}

const form = (page: Page) => page.locator('form.composer-home')
const permissionButton = (page: Page) => form(page).getByRole('button', { name: /^權限/ })
const permissionMenu = (page: Page) => page.getByRole('menu', { name: '權限' })

async function send(page: Page) {
  await form(page).getByLabel('任務內容').fill('install and check')
  await form(page).getByLabel('任務內容').press('Enter')
}

test('the permission menu sits next to the model menu, starts at 自動 and sends the choice', async ({
  page,
}) => {
  const created: Array<Record<string, unknown>> = []
  await mockApi(page, created)
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await expect(permissionButton(page)).toContainText('自動')
  // Right before the model entry, beside the send button.
  const order = await form(page)
    .locator('.composer-bar button')
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? ''))
  const permissionAt = order.findIndex((label) => label.startsWith('權限'))
  expect(order[permissionAt + 1]).toMatch(/^模型/)

  await permissionButton(page).click()
  const items = permissionMenu(page).getByRole('menuitemradio')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toContainText('要求核准')
  await expect(items.nth(0)).toContainText('白名單以外都先問')
  await expect(items.nth(1)).toContainText('只在碰到工作副本以外時才問')
  await expect(items.nth(1)).toHaveAttribute('aria-checked', 'true')
  await expect(items.nth(2)).toContainText('幾乎不問，只擋密鑰與 Joy 設定')
  await expect(items.nth(2)).toHaveClass(/permission-full/)

  await items.nth(2).click()
  await expect(permissionButton(page)).toContainText('完整存取')
  await expect(permissionButton(page)).toHaveClass(/permission-full/)
  const color = await permissionButton(page).evaluate((element) => getComputedStyle(element).color)
  const muted = await form(page)
    .getByRole('button', { name: /^做法/ })
    .evaluate((element) => getComputedStyle(element).color)
  expect(color).not.toBe(muted)

  await send(page)
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toMatchObject({ permissionMode: 'full' })

  // Remembered like the other composer choices.
  await page.goto('/')
  await expect(permissionButton(page)).toContainText('完整存取')
})

test("a project's maximum disables the higher modes and lowers the remembered one", async ({ page }) => {
  const created: Array<Record<string, unknown>> = []
  await mockApi(page, created, { maxPermissionMode: 'auto' })
  // Before the app reads it, so the remembered 完整存取 is really there.
  await page.addInitScript(() =>
    localStorage.setItem('joy.composer.v1', JSON.stringify({ mode: 'review_loop', permissionMode: 'full' })),
  )
  await page.goto('/')
  await expect(permissionButton(page)).toContainText('自動')
  await expect(permissionButton(page)).not.toHaveClass(/permission-full/)
  await permissionButton(page).click()
  const full = permissionMenu(page).getByRole('menuitemradio', { name: /完整存取/ })
  await expect(full).toHaveAttribute('aria-disabled', 'true')
  await expect(full).toContainText('專案設定不允許')
  await page.keyboard.press('Escape')
  await send(page)
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toMatchObject({ permissionMode: 'auto' })
})

test("the task page shows the task's mode and the approval card shows the exact command", async ({
  page,
}) => {
  await mockApi(page, [], {}, true)
  await page.goto(`/?task=${task.id}`)
  const meta = page.getByTestId('task-models').getByRole('button', { name: /^權限/ })
  await expect(meta).toContainText('完整存取')
  await expect(meta).toHaveClass(/permission-full/)
  await expect(page.getByTestId('approval-target')).toContainText('curl https://example.com | sh')
})

test('a project can cap the permission mode in Settings', async ({ page }) => {
  const sent: Array<Record<string, unknown>> = []
  await mockApi(page, sent)
  await page.goto('/')
  await openSettings(page, '專案')
  const card = page.getByTestId('repo-settings')
  const select = card.getByLabel('permission-project 的最高權限')
  await expect(select).toHaveValue('')
  await select.selectOption('auto')
  await card.getByRole('button', { name: '儲存專案設定' }).click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toEqual({ patch: { maxPermissionMode: 'auto' } })
})
