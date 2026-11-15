import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openSettings } from './helpers.js'

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
const now = Date.now()
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()

type Json = Record<string, unknown>

async function mockApi(
  page: Page,
  mock: { repos: Json[]; tasks?: Json[]; patches?: Json[]; created?: Json[]; conversations?: Json[] },
) {
  await page.routeWebSocket('**/ws**', () => undefined)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const repoPatch = /^\/api\/repos\/([^/]+)$/.exec(path)
    if (repoPatch && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Json
      mock.patches?.push(body)
      const index = mock.repos.findIndex((repo) => repo.id === repoPatch[1])
      // null clears a field, like the server.
      mock.repos[index] = Object.fromEntries(
        Object.entries({ ...mock.repos[index], ...body }).filter(([, value]) => value !== null),
      )
      await route.fulfill({ json: { repo: mock.repos[index] } })
    } else if (path === '/api/repos') await route.fulfill({ json: { repos: mock.repos } })
    else if (path === '/api/tasks' && request.method() === 'POST') {
      mock.created?.push(request.postDataJSON() as Json)
      await route.fulfill({
        status: 201,
        json: {
          task: {
            id: 'created',
            repoId: 'a',
            title: 't',
            prompt: 'p',
            mode: 'single',
            status: 'running',
            createdAt: iso(0),
          },
        },
      })
    } else if (path === '/api/tasks') await route.fulfill({ json: { tasks: mock.tasks ?? [] } })
    else if (path === '/api/config') await route.fulfill({ json: { config } })
    else if (path === '/api/conversations')
      await route.fulfill({ json: { conversations: mock.conversations ?? [] } })
    else if (path.startsWith('/api/tasks/'))
      await route.fulfill({
        json: { task: mock.tasks?.[0], repo: mock.repos[0], attempts: [], reviews: [], events: [] },
      })
    else await route.fulfill({ json: {} })
  })
}

const alpha = { id: 'a', path: '/work/alpha', defaultBranch: 'main' }
const beta = { id: 'b', path: '/work/beta', defaultBranch: 'main' }
const form = (page: Page) => page.locator('form.composer-home')
const button = (page: Page, name: RegExp) => form(page).getByRole('button', { name })

test('instructions, install command and new-task defaults are edited in a project’s settings', async ({
  page,
}) => {
  const patches: Json[] = []
  await mockApi(page, { repos: [{ ...alpha, maxPermissionMode: 'auto' }], patches })
  await page.goto('/')
  await openSettings(page, '專案')
  const card = page.getByRole('form', { name: 'alpha 的專案設定' })
  const save = card.getByRole('button', { name: '儲存專案設定' })
  await expect(save).toBeDisabled()

  await card.getByLabel('alpha 的專案指示').fill('  Write tests first.\n\nUse tabs.  ')
  await card.getByLabel('alpha 的安裝指令').fill('pnpm install --offline')
  await card.getByLabel('alpha 的預設實作者').selectOption({ label: 'Haiku 5.5' })
  await card.getByLabel('alpha 的預設審查者').selectOption({ label: 'GPT-6 Luna' })
  await card.getByLabel('alpha 的預設做法').selectOption('single')
  // Above the project's maximum (自動): not offered.
  await expect(card.getByLabel('alpha 的預設權限').getByRole('option', { name: '完整存取' })).toHaveAttribute(
    'disabled',
    '',
  )
  await card.getByLabel('alpha 的預設權限').selectOption('auto')
  await save.click()
  await expect(card.getByRole('status').filter({ hasText: '已儲存' })).toBeVisible()
  expect(patches).toEqual([
    {
      instructions: 'Write tests first.\n\nUse tabs.',
      installCommand: ['pnpm', 'install', '--offline'],
      defaults: {
        implementer: { provider: 'claude-cli', model: 'haiku' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna' },
        mode: 'single',
        permissionMode: 'auto',
      },
    },
  ])
  await expect(save).toBeDisabled()

  // Lowering the maximum takes the default permission down with it; emptied fields are cleared with null.
  await card.getByLabel('alpha 的最高權限').selectOption('ask')
  await expect(card.getByLabel('alpha 的預設權限')).toHaveValue('ask')
  await card.getByLabel('alpha 的專案指示').fill('')
  await card.getByLabel('alpha 的安裝指令').fill('')
  await card.getByLabel('alpha 的預設實作者').selectOption('')
  await card.getByLabel('alpha 的預設審查者').selectOption('')
  await card.getByLabel('alpha 的預設做法').selectOption('')
  await card.getByLabel('alpha 的預設權限').selectOption('')
  await save.click()
  await expect.poll(() => patches.length).toBe(2)
  expect(patches[1]).toEqual({
    maxPermissionMode: 'ask',
    instructions: null,
    installCommand: null,
    defaults: null,
  })

  // A service taken away takes the default model that used it away too.
  await card.getByLabel('alpha 的預設審查者').selectOption({ label: 'GPT-6 Luna' })
  await card.getByLabel('alpha 允許 Codex').uncheck()
  await expect(card.getByLabel('alpha 的預設審查者')).toHaveValue('')
})

test('switching project in the new task box applies that project’s defaults and keeps the rest', async ({
  page,
}) => {
  const created: Json[] = []
  await mockApi(page, {
    repos: [
      {
        ...alpha,
        defaults: {
          mode: 'single',
          permissionMode: 'ask',
          implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
        },
      },
      beta,
      {
        id: 'c',
        path: '/work/gamma',
        defaultBranch: 'main',
        maxPermissionMode: 'auto',
        defaults: { permissionMode: 'full', mode: 'compete' },
      },
    ],
    created,
  })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  // The first project counts as switched to: its defaults show.
  await expect(button(page, /^做法/)).toContainText('單人')
  await expect(button(page, /^權限/)).toContainText('要求核准')
  await expect(button(page, /^模型/)).toContainText('Haiku')

  // A project without defaults keeps what the box shows now (the last choice).
  await button(page, /^專案/).click()
  await page.getByRole('menuitemradio', { name: /beta/ }).click()
  await expect(button(page, /^做法/)).toContainText('單人')
  await expect(button(page, /^權限/)).toContainText('要求核准')

  // Defaults above the project's maximum are lowered to it; the model the project did not set is left alone.
  await button(page, /^專案/).click()
  await page.getByRole('menuitemradio', { name: /gamma/ }).click()
  await expect(button(page, /^做法/)).toContainText('兩家比賽')
  await expect(button(page, /^權限/)).toContainText('自動')
  await expect(button(page, /^模型/)).toContainText('Haiku')

  // What was sent is what the box showed.
  await button(page, /^專案/).click()
  await page.getByRole('menuitemradio', { name: /alpha/ }).click()
  await form(page).getByLabel('任務內容').fill('do it')
  await form(page).getByLabel('任務內容').press('Enter')
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toMatchObject({
    repoId: 'a',
    mode: 'single',
    permissionMode: 'ask',
    roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' } },
  })
})

test('the sidebar groups tasks by project once there are two, and a group folds away and stays folded', async ({
  page,
}) => {
  const task = (id: string, repoId: string, title: string, minutesAgo: number, extra: Json = {}) => ({
    id,
    repoId,
    title,
    prompt: 'p',
    mode: 'single',
    status: 'done',
    createdAt: iso(minutesAgo + 5),
    updatedAt: iso(minutesAgo),
    ...extra,
  })
  await mockApi(page, {
    repos: [alpha, beta],
    tasks: [
      task('1', 'a', 'Alpha newest', 1),
      task('2', 'b', 'Beta task', 5),
      task('3', 'a', 'Alpha older', 60),
      task('4', 'b', 'Beta waiting', 90, { status: 'awaiting_approval' }),
    ],
    conversations: [{ id: 'c1', title: 'Weekend plans', createdAt: iso(900), updatedAt: iso(30) }],
  })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  const sidebar = page.getByRole('navigation', { name: '主選單' })

  await expect(sidebar.locator('[role="group"] .group-label')).toHaveText(['alpha', 'beta', '對話'])
  await expect(sidebar.getByRole('group', { name: 'alpha' }).locator('.task-title')).toHaveText([
    'Alpha newest',
    'Alpha older',
  ])
  await expect(sidebar.getByRole('group', { name: 'beta' }).locator('.task-title')).toHaveText([
    'Beta task',
    'Beta waiting',
  ])
  await expect(sidebar.getByRole('group', { name: '對話' }).locator('.task-title')).toHaveText([
    'Weekend plans',
  ])
  await expect(sidebar.getByText('最近', { exact: true })).toHaveCount(0)

  // Folding hides the rows, says so to assistive tech, and a group with something waiting keeps a dot.
  const toggle = sidebar.locator('.sidebar-group-toggle', { hasText: 'beta' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar.getByText('Beta task')).toHaveCount(0)
  await expect(toggle.getByRole('img', { name: '有任務在等你' })).toBeVisible()
  await expect(sidebar.getByText('Alpha newest')).toBeVisible()

  // It stays folded after a reload; a search still shows its matches.
  await page.reload()
  await expect(sidebar.getByText('Beta task')).toHaveCount(0)
  await sidebar.getByLabel('搜尋任務與對話').fill('beta')
  await expect(sidebar.getByText('Beta task')).toBeVisible()
  await sidebar.getByLabel('搜尋任務與對話').fill('')
  await expect(sidebar.getByText('Beta task')).toHaveCount(0)
  await sidebar.locator('.sidebar-group-toggle', { hasText: 'beta' }).click()
  await expect(sidebar.getByText('Beta task')).toBeVisible()
})

test('with one project the sidebar keeps its plain list and shows no group heading', async ({ page }) => {
  await mockApi(page, {
    repos: [alpha, beta],
    tasks: [
      {
        id: '1',
        repoId: 'a',
        title: 'Only task',
        prompt: 'p',
        mode: 'single',
        status: 'done',
        createdAt: iso(5),
        updatedAt: iso(1),
      },
    ],
  })
  await page.goto('/')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  await expect(sidebar.getByText('Only task')).toBeVisible()
  await expect(sidebar.getByText('最近', { exact: true })).toBeVisible()
  await expect(sidebar.locator('.sidebar-group-toggle')).toHaveCount(0)
})

test('a blocked localStorage does not break the sidebar groups', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('blocked')
      },
    })
  })
  await mockApi(page, {
    repos: [alpha, beta],
    tasks: [
      {
        id: '1',
        repoId: 'a',
        title: 'Alpha task',
        prompt: 'p',
        mode: 'single',
        status: 'done',
        createdAt: iso(5),
        updatedAt: iso(1),
      },
      {
        id: '2',
        repoId: 'b',
        title: 'Beta task',
        prompt: 'p',
        mode: 'single',
        status: 'done',
        createdAt: iso(6),
        updatedAt: iso(2),
      },
    ],
  })
  await page.goto('/')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  await expect(sidebar.locator('.sidebar-group-toggle')).toHaveCount(2)
  await sidebar.locator('.sidebar-group-toggle', { hasText: 'beta' }).click()
  await expect(sidebar.getByText('Beta task')).toHaveCount(0)
})
