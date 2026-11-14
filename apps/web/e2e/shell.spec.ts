import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openAdvanced, openSettings } from './helpers.js'

const repo = { id: 'shell-repo', path: '/tmp/shell-project', defaultBranch: 'main' }
const config = {
  autonomy_mode: 'normal',
  roles: Object.fromEntries(
    ['assistant_brain', 'background', 'orchestrator', 'implementer', 'reviewer', 'judge'].map((role) => [
      role,
      { provider: 'claude-cli', model: 'opus', effort: 'medium' },
    ]),
  ),
}
const now = Date.now()
const tasks = [
  {
    id: 'waiting',
    repoId: repo.id,
    title: 'Waiting for you',
    prompt: 'p',
    mode: 'review_loop',
    status: 'awaiting_approval',
    createdAt: new Date(now - 300_000).toISOString(),
  },
  {
    id: 'older',
    repoId: repo.id,
    title: 'Last week chore',
    prompt: 'p',
    mode: 'single',
    status: 'done',
    createdAt: new Date(now - 6 * 86_400_000).toISOString(),
  },
]

interface Patch {
  path: string
  body: Record<string, unknown>
}

async function mockApi(page: Page, created: unknown[] = [], patches: Patch[] = []) {
  // The server keeps the archive flag and the title; the mock does too.
  const list: Array<Record<string, unknown>> = tasks.map((task) => ({ ...task, archived: false }))
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'PATCH' && path.startsWith('/api/tasks/')) {
      const body = request.postDataJSON() as Record<string, unknown>
      patches.push({ path, body })
      const task = list.find((item) => `/api/tasks/${String(item.id)}` === path)
      if (task) Object.assign(task, body)
      await route.fulfill({ json: { task } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks' && request.method() === 'POST') {
      created.push(request.postDataJSON())
      await route.fulfill({ status: 201, json: { task: { ...tasks[0], id: 'created' } } })
    } else if (path === '/api/tasks') {
      const withArchived = new URL(request.url()).searchParams.get('archived') === '1'
      await route.fulfill({ json: { tasks: list.filter((task) => withArchived || !task.archived) } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === '/api/conversations') {
      await route.fulfill({
        json: {
          conversations: [
            { id: 'c1', title: 'Weekend plans', createdAt: new Date(now - 3_600_000).toISOString() },
          ],
        },
      })
    } else if (path.startsWith('/api/tasks/')) {
      await route.fulfill({ json: { task: tasks[0], repo, attempts: [], reviews: [], events: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

test('the home page is just Joy and the message box, and keeps an unsent draft', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  // What needs you and recent tasks live in the sidebar, not on the home page.
  await expect(page.getByLabel('需要你處理')).toHaveCount(0)
  await expect(page.getByLabel('最近的任務')).toHaveCount(0)

  // There are tasks already, so no quick-start chips.
  await expect(page.getByRole('group', { name: '快速開始' })).toHaveCount(0)
  const prompt = page.getByLabel('任務內容')
  await prompt.fill('處理 GitHub issue #42')

  // The draft survives leaving the page and coming back.
  await openSettings(page)
  await page.getByRole('button', { name: '新任務' }).click()
  await expect(page.getByLabel('任務內容')).toHaveValue('處理 GitHub issue #42')
})

test('Enter sends, Shift+Enter adds a line, and the model preset fills implementer and reviewer', async ({
  page,
}) => {
  const created: unknown[] = []
  await mockApi(page, created)
  await page.goto('/')

  const form = page.locator('form.composer-home')
  await form.getByRole('button', { name: /^模型/ }).click()
  await page.getByRole('menuitemradio', { name: /^省額度/ }).click()
  await openAdvanced(page, form)
  await expect(form.getByLabel('實作者的模型')).toHaveValue('haiku')
  await expect(form.getByLabel('審查者的模型')).toHaveValue('gpt-6-luna')

  const prompt = form.getByLabel('任務內容')
  await prompt.fill('first line')
  await prompt.press('Shift+Enter')
  await prompt.pressSequentially('second line')
  await expect(prompt).toHaveValue('first line\nsecond line')
  await prompt.press('Enter')

  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toMatchObject({
    repoId: repo.id,
    prompt: 'first line\nsecond line',
    mode: 'review_loop',
    roleOverrides: {
      implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
      reviewer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
    },
  })
})

test('the sidebar lists tasks and conversations together, filters them, and archives on the server', async ({
  page,
}) => {
  const patches: Patch[] = []
  await mockApi(page, [], patches)
  await page.goto('/')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  // One list, newest first: the waiting task is minutes old, the chore six days.
  await expect(sidebar.locator('.task-row .task-title')).toHaveText([
    'Waiting for you',
    'Weekend plans',
    'Last week chore',
  ])
  await expect(sidebar.getByText('今天', { exact: true })).toHaveCount(0)

  await sidebar.getByLabel('搜尋任務與對話').fill('chore')
  await expect(sidebar.getByRole('button', { name: /Last week chore/ }).first()).toBeVisible()
  await expect(sidebar.getByRole('button', { name: /Waiting for you/ })).toHaveCount(0)
  await sidebar.getByLabel('搜尋任務與對話').fill('')

  await sidebar.getByRole('button', { name: '封存：Last week chore' }).click()
  await expect(sidebar.getByRole('button', { name: /^Last week chore/ })).toHaveCount(0)
  expect(patches).toEqual([{ path: '/api/tasks/older', body: { archived: true } }])
  // The sidebar has no 已封存 group; the task is in 設定 → 已封存.
  await expect(sidebar.getByRole('button', { name: /已封存/ })).toHaveCount(0)
  await openSettings(page, '已封存')
  await expect(page.getByLabel('已封存的任務')).toContainText('Last week chore')
  // The flag is on the server: a reload keeps the task archived.
  await page.reload()
  await expect(sidebar.getByRole('button', { name: /^Last week chore/ })).toHaveCount(0)
  await openSettings(page, '已封存')
  await page.getByRole('button', { name: '取消封存：Last week chore' }).click()
  await expect(sidebar.getByRole('button', { name: /^Last week chore/ })).toBeVisible()
  expect(patches.at(-1)).toEqual({ path: '/api/tasks/older', body: { archived: false } })
})

test('archive choices an older version kept in localStorage move to the server once', async ({ page }) => {
  const patches: Patch[] = []
  await mockApi(page, [], patches)
  await page.addInitScript(() => {
    if (!window.localStorage.getItem('joy.archivedTasks.seeded')) {
      window.localStorage.setItem('joy.archivedTasks', JSON.stringify(['older', 'gone']))
      window.localStorage.setItem('joy.archivedTasks.seeded', '1')
    }
  })
  await page.goto('/')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  await expect(sidebar.getByRole('button', { name: /^Last week chore/ })).toHaveCount(0)
  await openSettings(page, '已封存')
  await expect(page.getByLabel('已封存的任務')).toContainText('Last week chore')
  // Only the task that still exists is sent, and the old key is gone.
  expect(patches).toEqual([{ path: '/api/tasks/older', body: { archived: true } }])
  expect(await page.evaluate(() => window.localStorage.getItem('joy.archivedTasks'))).toBeNull()
})

test('a thread title can be renamed in place', async ({ page }) => {
  const patches: Patch[] = []
  await mockApi(page, [], patches)
  await page.goto('/?task=waiting')
  const title = page.getByRole('heading', { name: 'Waiting for you' })
  await title.dblclick()
  const input = page.getByLabel('任務標題')
  await input.fill('Renamed task')
  await input.press('Enter')
  await expect(page.getByRole('heading', { name: 'Renamed task' })).toBeVisible()
  expect(patches).toEqual([{ path: '/api/tasks/waiting', body: { title: 'Renamed task' } }])

  // Escape cancels without a request.
  await page.getByRole('button', { name: '重新命名' }).click()
  await page.getByLabel('任務標題').fill('Never saved')
  await page.getByLabel('任務標題').press('Escape')
  await expect(page.getByRole('heading', { name: 'Renamed task' })).toBeVisible()
  expect(patches).toHaveLength(1)
})

test('先規劃 asks for a plan first, and is off for the compete mode', async ({ page }) => {
  const created: unknown[] = []
  await mockApi(page, created)
  await page.goto('/')
  const form = page.locator('form.composer-home')
  await form.getByRole('button', { name: /^做法/ }).click()
  const plan = page.getByRole('menuitemcheckbox', { name: /先規劃/ })
  await expect(plan).toHaveAttribute('aria-checked', 'false')
  await plan.click()
  await expect(plan).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(form.getByRole('button', { name: /^做法/ })).toContainText('先規劃')
  await form.getByLabel('任務內容').fill('refactor the parser')
  await form.getByLabel('任務內容').press('Enter')
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toMatchObject({ prompt: 'refactor the parser', mode: 'review_loop', planFirst: true })

  // Compete takes no plan-first, and says why.
  await page.goto('/')
  await form.getByRole('button', { name: /^做法/ }).click()
  await page.getByRole('menuitemradio', { name: /兩家比賽/ }).click()
  await form.getByRole('button', { name: /^做法/ }).click()
  const disabled = page.getByRole('menuitemcheckbox', { name: /先規劃/ })
  await expect(disabled).toHaveAttribute('aria-disabled', 'true')
  await expect(disabled).toContainText('兩家比賽不支援先規劃')
})

test('theme can be set by hand, the command palette jumps around, and shortcuts work', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await openSettings(page, '一般')
  await page.getByRole('button', { name: '深色' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await openSettings(page, '一般')
  await page.getByRole('button', { name: '系統' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/)

  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette).toBeVisible()
  await palette.getByRole('textbox', { name: '輸入指令或任務名稱' }).fill('Waiting')
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible()

  // Control+B hides the sidebar, Control+N opens a new task.
  await page.keyboard.press('Control+b')
  await expect(page.getByRole('navigation', { name: '主選單' })).toBeHidden()
  await page.keyboard.press('Control+b')
  await expect(page.getByRole('navigation', { name: '主選單' })).toBeVisible()
  await page.keyboard.press('Control+n')
  await expect(page.getByRole('heading', { name: '要讓 Joy 做什麼？' })).toBeVisible()
})

test('on a phone the sidebar is a drawer behind the menu button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await mockApi(page)
  await page.goto('/')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  await expect(sidebar).not.toBeInViewport()
  await page.getByRole('button', { name: '開啟側邊欄' }).click()
  await expect(sidebar).toBeInViewport()
  await sidebar.getByRole('button', { name: '設定', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '設定分類' })).toBeVisible()
  await expect(sidebar).not.toBeInViewport()
})
