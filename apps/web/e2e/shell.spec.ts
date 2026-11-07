import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openSettings } from './helpers.js'

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

async function mockApi(page: Page, created: unknown[] = []) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks' && request.method() === 'POST') {
      created.push(request.postDataJSON())
      await route.fulfill({ status: 201, json: { task: { ...tasks[0], id: 'created' } } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === '/api/conversations') {
      await route.fulfill({ json: { conversations: [{ id: 'c1', title: 'Weekend plans' }] } })
    } else if (path.startsWith('/api/tasks/')) {
      await route.fulfill({ json: { task: tasks[0], repo, attempts: [], reviews: [], events: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

test('the home page lists what needs you, offers starters and keeps an unsent draft', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  const attention = page.getByLabel('需要你處理')
  await expect(attention).toContainText('Waiting for you')
  await expect(attention).toContainText('等你同意')
  await expect(page.getByLabel('最近的任務')).toContainText('Last week chore')

  await page.getByRole('button', { name: '從 GitHub issue 開始' }).click()
  const prompt = page.getByLabel('任務內容')
  await expect(prompt).toHaveValue('處理 GitHub issue #')
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
  await form.getByLabel('模型組合').selectOption('saver')
  await form.getByRole('button', { name: '進階' }).click()
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

test('the sidebar groups tasks by day, filters them, and archives locally', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  await expect(sidebar.getByText('今天', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('更早', { exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Weekend plans' })).toBeVisible()

  await sidebar.getByLabel('搜尋任務與對話').fill('chore')
  await expect(sidebar.getByRole('button', { name: /Last week chore/ }).first()).toBeVisible()
  await expect(sidebar.getByRole('button', { name: /Waiting for you/ })).toHaveCount(0)
  await sidebar.getByLabel('搜尋任務與對話').fill('')

  await sidebar.getByRole('button', { name: '封存：Last week chore' }).click()
  await expect(sidebar.getByRole('button', { name: /^Last week chore/ })).toHaveCount(0)
  await sidebar.getByRole('button', { name: /已封存（1）/ }).click()
  await sidebar.getByRole('button', { name: '取消封存：Last week chore' }).click()
  await expect(sidebar.getByRole('button', { name: /已封存/ })).toHaveCount(0)
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
