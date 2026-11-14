import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openSettings, openSettingsSection } from './helpers.js'

const repo = { id: 'dc-repo', path: '/tmp/declutter-project', defaultBranch: 'main' }
const githubRepo = { ...repo, githubRemote: 'https://github.com/owner/declutter.git' }
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
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()

function task(id: string, title: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    repoId: repo.id,
    title,
    prompt: 'p',
    mode: 'single',
    status: 'done',
    createdAt: iso(minutesAgo + 5),
    updatedAt: iso(minutesAgo),
    archived: false,
    ...extra,
  }
}

interface Mock {
  tasks?: Array<Record<string, unknown>>
  conversations?: Array<Record<string, unknown>>
  repos?: Array<Record<string, unknown>>
  patches?: Array<{ path: string; body: Record<string, unknown> }>
}

async function mockApi(page: Page, mock: Mock = {}) {
  const list = mock.tasks ?? []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'PATCH' && path.startsWith('/api/tasks/')) {
      const body = request.postDataJSON() as Record<string, unknown>
      mock.patches?.push({ path, body })
      const found = list.find((item) => `/api/tasks/${String(item.id)}` === path)
      if (found) Object.assign(found, body)
      await route.fulfill({ json: { task: found } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: mock.repos ?? [repo] } })
    } else if (path === '/api/tasks') {
      const withArchived = new URL(request.url()).searchParams.get('archived') === '1'
      await route.fulfill({ json: { tasks: list.filter((item) => withArchived || !item.archived) } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === '/api/conversations') {
      await route.fulfill({ json: { conversations: mock.conversations ?? [] } })
    } else if (path.startsWith('/api/conversations/')) {
      await route.fulfill({ json: { conversation: { id: 'c1' }, messages: [] } })
    } else if (path.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(path.slice('/api/tasks/'.length).split('/')[0] ?? '')
      const found = list.find((item) => item.id === id) ?? list[0]
      await route.fulfill({
        json: { task: found, repo: mock.repos?.[0] ?? repo, attempts: [], reviews: [], events: [] },
      })
    } else if (path === '/api/stats') {
      await route.fulfill({ json: { stats: { implementers: [], reviewers: [] } } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: '主選單' })
/** The row itself, not its hover action (封存：…), which has the title in its name too. */
const rowOf = (page: Page, title: string) => sidebarOf(page).locator('.task-row', { hasText: title })

test('the sidebar is one 最近 list: tasks and conversations mixed by last activity, no archived, no extra sections', async ({
  page,
}) => {
  await mockApi(page, {
    tasks: [
      task('old', 'Oldest task', 600),
      // Created long ago, but it ran a minute ago: it belongs near the top.
      task('busy', 'Busy task', 600, { updatedAt: iso(1), status: 'running' }),
      task('mid', 'Middle task', 120),
      task('gone', 'Archived task', 5, { archived: true }),
    ],
    conversations: [{ id: 'c1', title: 'Weekend plans', createdAt: iso(900), updatedAt: iso(30) }],
  })
  await page.goto('/')
  const sidebar = sidebarOf(page)

  const rows = sidebar.locator('.task-row .task-title')
  await expect(rows).toHaveText(['Busy task', 'Weekend plans', 'Middle task', 'Oldest task'])
  // A task row has the project dot, a conversation row the speech-bubble icon.
  await expect(sidebar.locator('.task-row', { hasText: 'Busy task' }).locator('.project-dot')).toHaveCount(1)
  await expect(sidebar.locator('.task-row', { hasText: 'Weekend plans' }).locator('svg')).toHaveCount(1)
  await expect(
    sidebar.locator('.task-row', { hasText: 'Weekend plans' }).locator('.project-dot'),
  ).toHaveCount(0)

  await expect(sidebar.getByText('Archived task')).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: /已封存/ })).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: '助理' })).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: '統計' })).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: '加入專案' })).toHaveCount(0)
  await expect(sidebar.getByText('對話', { exact: true })).toHaveCount(0)
  await expect(sidebar.getByText('任務', { exact: true })).toHaveCount(0)
  await expect(sidebar.getByText('最近', { exact: true })).toBeVisible()
  // Footer: just 設定.
  await expect(sidebar.locator('.sidebar-footer').getByRole('button')).toHaveText(['設定'])

  // Search narrows both kinds at once.
  await sidebar.getByLabel('搜尋任務與對話').fill('e')
  await expect(rows).toHaveText(['Weekend plans', 'Middle task', 'Oldest task'])
  await sidebar.getByLabel('搜尋任務與對話').fill('zzz')
  await expect(sidebar.getByText('沒有符合的項目')).toBeVisible()
})

test('the empty sidebar is one faint line, without the character', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  const sidebar = sidebarOf(page)
  await expect(sidebar.getByText('還沒有任何工作')).toBeVisible()
  await expect(sidebar.locator('.empty-list svg')).toHaveCount(0)
  // The big character is for the new task page.
  await expect(page.locator('.home-mascot')).toBeVisible()
})

test('新任務 and 聊聊 are highlighted only while their own page is open', async ({ page }) => {
  await mockApi(page, {
    tasks: [task('t1', 'First task', 10)],
    conversations: [{ id: 'c1', title: 'Chat one', createdAt: iso(20), updatedAt: iso(20) }],
  })
  await page.goto('/')
  const sidebar = sidebarOf(page)
  const newTask = sidebar.getByRole('button', { name: '新任務' })
  const chat = sidebar.getByRole('button', { name: '聊聊' })
  const lit = (button: typeof newTask) => button.evaluate((element) => element.classList.contains('active'))

  // Nothing is open yet: the composer is the page.
  await expect(newTask).toHaveAttribute('aria-current', 'page')
  expect(await lit(chat)).toBe(false)

  await rowOf(page, 'First task').click()
  await expect(page.getByRole('heading', { name: 'First task' })).toBeVisible()
  await expect(newTask).not.toHaveAttribute('aria-current', 'page')
  await expect(chat).not.toHaveAttribute('aria-current', 'page')
  expect(await lit(newTask)).toBe(false)

  await chat.click()
  await expect(page.getByTestId('assistant-page')).toBeVisible()
  await expect(chat).toHaveAttribute('aria-current', 'page')
  expect(await lit(newTask)).toBe(false)

  // An existing conversation is a row of the list, not the 聊聊 page.
  await rowOf(page, 'Chat one').click()
  await expect(chat).not.toHaveAttribute('aria-current', 'page')
  await expect(rowOf(page, 'Chat one')).toHaveAttribute('aria-current', 'page')
})

test('設定 has a back button that returns to where the owner came from', async ({ page }) => {
  await mockApi(page, {
    tasks: [task('t1', 'First task', 10)],
    conversations: [{ id: 'c1', title: 'Chat one', createdAt: iso(20), updatedAt: iso(20) }],
  })
  const back = page.getByRole('navigation', { name: '設定分類' }).getByRole('button', { name: '返回' })

  // From a task, through two sections, back to the task.
  await page.goto('/?task=t1')
  await expect(page.getByRole('heading', { name: 'First task' })).toBeVisible()
  await openSettings(page, '模型')
  await expect(back).toBeVisible()
  await openSettingsSection(page, '通知')
  await back.click()
  await expect(page.getByRole('heading', { name: 'First task' })).toBeVisible()

  // From a conversation.
  await rowOf(page, 'Chat one').click()
  await expect(page.getByTestId('assistant-page')).toBeVisible()
  await openSettings(page)
  await back.click()
  await expect(page.getByTestId('assistant-page')).toBeVisible()

  // From the composer.
  await page.getByRole('button', { name: '新任務' }).click()
  await openSettings(page, '專案')
  await back.click()
  await expect(page.getByRole('heading', { name: '要讓 Joy 做什麼？' })).toBeVisible()
})

test('Esc leaves 設定, but not while typing in a field', async ({ page }) => {
  await mockApi(page, { tasks: [task('t1', 'First task', 10)] })
  await page.goto('/?task=t1')
  await expect(page.getByRole('heading', { name: 'First task' })).toBeVisible()

  await openSettings(page, '統計')
  // The date field is somewhere the owner types: Esc stays with it.
  await page.getByLabel('從').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('navigation', { name: '設定分類' })).toBeVisible()

  // Focus on the page itself: Esc goes back.
  await page.getByLabel('從').blur()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'First task' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '設定分類' })).toHaveCount(0)
})

test('Esc does not leave 設定 while the command palette is open, and closes only the palette', async ({
  page,
}) => {
  await mockApi(page, { tasks: [task('t1', 'First task', 10)] })
  await page.goto('/')
  await openSettings(page, '一般')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '設定分類' })).toBeVisible()
})

test('settings back with nothing before it lands on the new task page', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '要讓 Joy 做什麼？' })).toBeVisible()
  // Straight from the command palette, as the first thing done in this session.
  await page.keyboard.press('Control+k')
  await page.getByRole('textbox', { name: '輸入指令或任務名稱' }).fill('設定：已封存')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('navigation', { name: '設定分類' })).toBeVisible()
  await expect(page.getByLabel('已封存的任務')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '要讓 Joy 做什麼？' })).toBeVisible()
})

test('archived tasks live in 設定 → 已封存, where they can be opened or restored', async ({ page }) => {
  const patches: Array<{ path: string; body: Record<string, unknown> }> = []
  await mockApi(page, {
    patches,
    tasks: [
      task('keep', 'Kept task', 10),
      task('arch1', 'Archived one', 50, { archived: true }),
      task('arch2', 'Archived two', 90, { archived: true }),
    ],
  })
  await page.goto('/')
  const sidebar = sidebarOf(page)
  await expect(sidebar.getByText('Archived one')).toHaveCount(0)

  await openSettings(page, '已封存')
  const panel = page.getByLabel('已封存的任務')
  await expect(panel.locator('.archived-title')).toHaveText(['Archived one', 'Archived two'])

  // Restore: the row leaves the panel and appears in the sidebar list.
  await panel.getByRole('button', { name: '取消封存：Archived one' }).click()
  await expect(panel.locator('.archived-title')).toHaveText(['Archived two'])
  expect(patches).toEqual([{ path: '/api/tasks/arch1', body: { archived: false } }])
  await expect(rowOf(page, 'Archived one')).toBeVisible()

  // Open: goes to the task.
  await panel.getByRole('button', { name: '打開：Archived two' }).click()
  await expect(page.getByRole('heading', { name: 'Archived two' })).toBeVisible()

  // Archiving from the sidebar moves a task here.
  await sidebar.getByRole('button', { name: '封存：Kept task' }).click()
  await expect(sidebar.getByRole('button', { name: /^Kept task/ })).toHaveCount(0)
  await openSettings(page, '已封存')
  await expect(page.getByLabel('已封存的任務').getByText('Kept task')).toBeVisible()
})

test('an empty 已封存 says so in one line', async ({ page }) => {
  await mockApi(page, { tasks: [task('t', 'Only task', 5)] })
  await page.goto('/')
  await openSettings(page, '已封存')
  await expect(page.getByLabel('已封存的任務')).toContainText('沒有已封存的任務')
})

test('quick-start chips only show before the very first task, and the issue one needs a GitHub address', async ({
  page,
}) => {
  const starters = page.getByRole('group', { name: '快速開始' })

  // No task at all, project without GitHub: three chips.
  await mockApi(page)
  await page.goto('/')
  await expect(starters.getByRole('button')).toHaveText(['修一個 bug', '補測試', '解釋這段程式'])
  await expect(page.getByRole('button', { name: '從 GitHub issue 開始' })).toHaveCount(0)
  await page.unroute('**/api/**')

  // No task, project with a GitHub address: the issue chip too.
  await mockApi(page, { repos: [githubRepo] })
  await page.goto('/')
  await expect(starters.getByRole('button')).toHaveText([
    '修一個 bug',
    '補測試',
    '解釋這段程式',
    '從 GitHub issue 開始',
  ])
  await page.unroute('**/api/**')

  // An archived task still counts as "has tasks": no chips.
  await mockApi(page, { repos: [githubRepo], tasks: [task('a', 'Archived', 10, { archived: true })] })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '要讓 Joy 做什麼？' })).toBeVisible()
  await expect(starters).toHaveCount(0)
  await page.unroute('**/api/**')

  // Any task: no chips.
  await mockApi(page, { repos: [githubRepo], tasks: [task('t', 'A task', 10)] })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '要讓 Joy 做什麼？' })).toBeVisible()
  await expect(starters).toHaveCount(0)
})

test('the new task page has no explanation line, 進階 is the last row of 做法, and the model entry has no 預設 tag', async ({
  page,
}) => {
  await mockApi(page)
  await page.goto('/')
  const form = page.locator('form.composer-home')
  await expect(page.getByText('一個 AI 動手做')).toHaveCount(0)
  await expect(form.getByRole('button', { name: '進階' })).toHaveCount(0)
  await expect(form.getByLabel('任務內容')).not.toHaveAttribute('placeholder', /.+/)

  const model = form.getByRole('button', { name: /^模型/ })
  await expect(model).not.toContainText('預設')
  await expect(model).toHaveAttribute('aria-label', /^模型：[^（]+$/)
  // The default is marked inside the model menu.
  await model.click()
  await expect(page.getByRole('menuitemradio').filter({ hasText: '預設' }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  await form.getByRole('button', { name: /^做法/ }).click()
  const items = page.getByRole('menu', { name: '做法' }).locator('[role^="menuitem"]')
  await expect(items.last()).toHaveText('進階')
  await page.getByRole('menuitem', { name: '進階' }).click()
  await expect(form.getByLabel('任務標題')).toBeVisible()
  await expect(form.getByLabel('實作者的模型')).toBeVisible()
})

test('統計 is a section of 設定', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await openSettings(page, '統計')
  await expect(page.getByLabel('從')).toBeVisible()
  await expect(sidebarOf(page).getByRole('button', { name: '統計' })).toHaveCount(0)
})
