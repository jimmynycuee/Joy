import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { rowMenu } from './helpers.js'

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

const alpha = { id: 'a', path: '/work/alpha', defaultBranch: 'main' }
const beta = { id: 'b', path: '/work/beta', defaultBranch: 'main' }
const task = (id: string, repoId: string, title: string, minutesAgo: number, extra: Json = {}): Json => ({
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

interface Mock {
  repos: Json[]
  tasks?: Json[]
  conversations?: Json[]
  patches?: Array<{ path: string; body: Json }>
  /** Folder listings by path; a missing path answers 404, a path in `forbidden` 403. */
  folders?: Record<string, Json>
  forbidden?: string[]
  gitInits?: Json[]
  created?: Json[]
}

/** One folder listing shaped like the server's. */
function listing(path: string, folders: Array<[string, boolean]>, isGit = false): Json {
  const parts = path.split('/').filter(Boolean)
  return {
    path,
    parent: parts.length === 0 ? null : `/${parts.slice(0, -1).join('/')}`,
    home: '/home/me',
    isGit,
    crumbs: [
      { name: '/', path: '/' },
      ...parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` })),
    ],
    folders: folders.map(([name, git]) => ({
      name,
      path: `${path === '/' ? '' : path}/${name}`,
      isGit: git,
    })),
    truncated: false,
  }
}

async function mockApi(page: Page, mock: Mock) {
  await page.routeWebSocket('**/ws**', () => undefined)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const taskPatch = /^\/api\/tasks\/([^/]+)$/.exec(path)
    const chatPatch = /^\/api\/conversations\/([^/]+)$/.exec(path)
    if (taskPatch && method === 'PATCH') {
      const body = request.postDataJSON() as Json
      mock.patches?.push({ path, body })
      const found = mock.tasks?.find((item) => item.id === taskPatch[1])
      if (found && 'pinned' in body) {
        if (body.pinned) found.pinnedAt = new Date().toISOString()
        else delete found.pinnedAt
      }
      if (found && body.archived) found.archived = true
      await route.fulfill({ json: { task: found } })
    } else if (chatPatch && method === 'PATCH') {
      const body = request.postDataJSON() as Json
      mock.patches?.push({ path, body })
      const found = mock.conversations?.find((item) => item.id === chatPatch[1])
      if (found) {
        if (body.pinned) found.pinnedAt = new Date().toISOString()
        else delete found.pinnedAt
      }
      await route.fulfill({ json: { conversation: found } })
    } else if (path === '/api/fs/folders') {
      const wanted = url.searchParams.get('path') ?? '/home/me'
      if (mock.forbidden?.includes(wanted)) await route.fulfill({ status: 403, json: { error: 'no' } })
      else if (mock.folders?.[wanted]) await route.fulfill({ json: mock.folders[wanted] })
      else await route.fulfill({ status: 404, json: { error: 'no' } })
    } else if (path === '/api/fs/git-init' && method === 'POST') {
      const body = request.postDataJSON() as { path: string }
      mock.gitInits?.push(body as Json)
      await route.fulfill({ status: 201, json: { path: body.path, defaultBranch: 'main' } })
    } else if (path === '/api/repos' && method === 'POST') {
      const body = request.postDataJSON() as Json
      mock.created?.push(body)
      await route.fulfill({ status: 201, json: { repo: { id: 'new', ...body } } })
    } else if (path === '/api/repos') await route.fulfill({ json: { repos: mock.repos } })
    else if (path === '/api/tasks') await route.fulfill({ json: { tasks: mock.tasks ?? [] } })
    else if (path === '/api/config') await route.fulfill({ json: { config } })
    else if (path === '/api/conversations')
      await route.fulfill({ json: { conversations: mock.conversations ?? [] } })
    else if (path.startsWith('/api/conversations/'))
      await route.fulfill({ json: { conversation: { id: 'c1' }, messages: [] } })
    else if (path.startsWith('/api/tasks/'))
      await route.fulfill({
        json: { task: mock.tasks?.[0], repo: mock.repos[0], attempts: [], reviews: [], events: [] },
      })
    else await route.fulfill({ json: {} })
  })
}

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: '主選單' })

test('a task or a conversation can be pinned: it moves to 已釘選 and the server keeps it', async ({
  page,
}) => {
  const patches: Array<{ path: string; body: Json }> = []
  await mockApi(page, {
    repos: [alpha],
    tasks: [task('t1', 'a', 'Newest task', 1), task('t2', 'a', 'Older task', 30)],
    conversations: [{ id: 'c1', title: 'Weekend plans', createdAt: iso(900), updatedAt: iso(60) }],
    patches,
  })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  const sidebar = sidebarOf(page)
  const pinned = sidebar.getByRole('region', { name: '已釘選' })
  const recent = sidebar.getByRole('region', { name: '最近項目' })

  // Nothing pinned: no section at all.
  await expect(pinned).toHaveCount(0)

  await rowMenu(page, 'Older task', '釘選')
  await expect(pinned.locator('.task-title')).toHaveText(['Older task'])
  await expect(recent.locator('.task-row .task-title')).toHaveText(['Newest task', 'Weekend plans'])
  await rowMenu(page, 'Weekend plans', '釘選')
  // The one pinned last is first.
  await expect(pinned.locator('.task-title')).toHaveText(['Weekend plans', 'Older task'])
  expect(patches).toEqual([
    { path: '/api/tasks/t2', body: { pinned: true } },
    { path: '/api/conversations/c1', body: { pinned: true } },
  ])

  // It is in the server's answer, so a reload keeps it.
  await page.reload()
  await expect(pinned.locator('.task-title')).toHaveText(['Weekend plans', 'Older task'])

  await sidebar.getByRole('button', { name: '更多：Older task' }).first().click()
  await expect(page.getByRole('menuitem', { name: '取消釘選' })).toBeVisible()
  await page.getByRole('menuitem', { name: '取消釘選' }).click()
  await expect(pinned.locator('.task-title')).toHaveText(['Weekend plans'])
  await expect(recent.locator('.task-row .task-title')).toHaveText(['Newest task', 'Older task'])
  await rowMenu(page, 'Weekend plans', '取消釘選')
  await expect(pinned).toHaveCount(0)
  expect(patches.at(-1)).toEqual({ path: '/api/conversations/c1', body: { pinned: false } })
})

test('archiving a pinned task takes it out of 已釘選', async ({ page }) => {
  await mockApi(page, {
    repos: [alpha],
    tasks: [task('t1', 'a', 'Keep me', 5, { pinnedAt: iso(2) }), task('t2', 'a', 'Other', 10)],
  })
  await page.goto('/')
  const sidebar = sidebarOf(page)
  await expect(sidebar.getByRole('region', { name: '已釘選' }).locator('.task-title')).toHaveText(['Keep me'])
  await rowMenu(page, 'Keep me', '封存')
  await expect(sidebar.getByRole('region', { name: '已釘選' })).toHaveCount(0)
  await expect(sidebar.getByText('Keep me')).toHaveCount(0)
})

test('最近項目 folds, remembers it, and filters by status and project', async ({ page }) => {
  await mockApi(page, {
    repos: [alpha, beta],
    tasks: [
      task('1', 'a', 'Alpha waiting', 1, { status: 'awaiting_approval' }),
      task('2', 'b', 'Beta running', 2, { status: 'running' }),
      task('3', 'a', 'Alpha done', 3),
      task('4', 'b', 'Beta failed', 4, { status: 'failed' }),
    ],
    conversations: [{ id: 'c1', title: 'Weekend plans', createdAt: iso(900), updatedAt: iso(30) }],
  })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  const sidebar = sidebarOf(page)
  const recent = sidebar.getByRole('region', { name: '最近項目' })
  const titles = recent.locator('.task-row .task-title')
  const filter = recent.getByRole('button', { name: '篩選' })

  await expect(titles).toHaveText([
    'Alpha waiting',
    'Beta running',
    'Alpha done',
    'Beta failed',
    'Weekend plans',
  ])

  await filter.click()
  await page.getByRole('menuitemradio', { name: '等你的' }).click()
  await expect(titles).toHaveText(['Alpha waiting'])
  // The menu stays open to pick the project too.
  await page.getByRole('menuitemradio', { name: 'beta' }).click()
  await expect(recent.getByText('沒有符合的項目')).toBeVisible()
  await page.getByRole('menuitemradio', { name: '全部' }).first().click()
  await page.getByRole('menuitemradio', { name: '進行中' }).click()
  await expect(titles).toHaveText(['Beta running'])
  await page.getByRole('menuitemradio', { name: '沒完成' }).click()
  await expect(titles).toHaveText(['Beta failed'])
  await page.keyboard.press('Escape')
  await expect(filter).toHaveClass(/filter-on/)

  // Back to everything.
  await filter.click()
  await page.getByRole('menuitemradio', { name: '全部' }).first().click()
  await page.getByRole('menuitemradio', { name: '全部' }).last().click()
  await expect(titles).toHaveCount(5)
  await expect(filter).not.toHaveClass(/filter-on/)
  await page.keyboard.press('Escape')

  // The section's own button starts a new task.
  await recent.getByRole('button', { name: '新對話' }).click()
  await expect(page.getByRole('heading', { name: '要讓 Joy 做什麼？' })).toBeVisible()

  await sidebar.getByRole('button', { name: '最近項目' }).click()
  await expect(titles).toHaveCount(0)
  await page.reload()
  await expect(titles).toHaveCount(0)
  await sidebar.getByRole('button', { name: '最近項目' }).click()
  await expect(titles).toHaveCount(5)
})

test('a project’s ⋯ menu opens that project’s settings alone, and 所有專案 brings the rest back', async ({
  page,
}) => {
  await mockApi(page, { repos: [alpha, beta], tasks: [task('1', 'a', 'Alpha task', 1)] })
  await page.goto('/')
  const sidebar = sidebarOf(page)
  await sidebar.getByRole('button', { name: '更多：beta' }).click()
  await page.getByRole('menuitem', { name: '設定' }).click()
  await expect(
    page.getByRole('navigation', { name: '設定分類' }).getByRole('button', { name: '專案' }),
  ).toBeVisible()
  await expect(page.getByRole('form', { name: 'beta 的專案設定' })).toBeVisible()
  await expect(page.getByRole('form', { name: 'alpha 的專案設定' })).toHaveCount(0)
  await page.getByRole('button', { name: '所有專案' }).click()
  await expect(page.getByRole('form', { name: 'alpha 的專案設定' })).toBeVisible()
  await expect(page.getByRole('form', { name: 'beta 的專案設定' })).toBeVisible()
})

test.describe('加入專案 picks a folder', () => {
  const folders = {
    '/home/me': listing('/home/me', [
      ['code', false],
      ['notes', false],
    ]),
    '/home/me/code': listing('/home/me/code', [
      ['app', true],
      ['sketch', false],
    ]),
    '/home/me/code/app': listing('/home/me/code/app', [], true),
    '/home/me/code/sketch': listing('/home/me/code/sketch', [], false),
  }

  test('the + beside 專案 opens it at the home folder; folders open, the breadcrumb and 上一層 go back', async ({
    page,
  }) => {
    const created: Json[] = []
    await mockApi(page, { repos: [], folders, created })
    await page.goto('/')
    await sidebarOf(page)
      .getByRole('region', { name: '專案' })
      .getByRole('button', { name: '加入專案' })
      .click()
    const dialog = page.getByRole('dialog', { name: '加入專案' })
    await expect(dialog.getByLabel('資料夾路徑')).toHaveValue('/home/me')
    await expect(dialog.locator('.folder-name')).toHaveText(['code', 'notes'])

    await dialog.getByRole('button', { name: 'code', exact: true }).click()
    await expect(dialog.locator('.folder-name')).toHaveText(['app', 'sketch'])
    // Only the git repository has a 選擇 button of its own.
    await expect(dialog.getByRole('button', { name: '加入：app' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '加入：sketch' })).toHaveCount(0)

    await dialog.getByRole('button', { name: '上一層' }).click()
    await expect(dialog.getByLabel('資料夾路徑')).toHaveValue('/home/me')
    await dialog.getByRole('button', { name: 'code', exact: true }).click()
    await dialog
      .getByRole('navigation', { name: '目前位置' })
      .getByRole('button', { name: 'me', exact: true })
      .click()
    await expect(dialog.getByLabel('資料夾路徑')).toHaveValue('/home/me')

    // A git repository goes straight to adding, with its branch and the container choice.
    await dialog.getByRole('button', { name: 'code', exact: true }).click()
    await dialog.getByRole('button', { name: '加入：app' }).click()
    await expect(dialog.getByText('/home/me/code/app')).toBeVisible()
    await dialog.getByLabel('預設分支').fill('develop')
    await dialog.getByRole('button', { name: '加入專案' }).click()
    await expect(dialog).toHaveCount(0)
    expect(created).toEqual([{ path: '/home/me/code/app', defaultBranch: 'develop' }])
  })

  test('a pasted path is opened; a forbidden or missing one says so and keeps the list', async ({ page }) => {
    await mockApi(page, { repos: [], folders, forbidden: ['/home/me/.ssh'] })
    await page.goto('/')
    await sidebarOf(page).getByRole('button', { name: '加入專案' }).click()
    const dialog = page.getByRole('dialog', { name: '加入專案' })
    const input = dialog.getByLabel('資料夾路徑')
    await expect(dialog.locator('.folder-name')).toHaveText(['code', 'notes'])

    await input.fill('/home/me/.ssh')
    await input.press('Enter')
    await expect(dialog.getByRole('alert')).toHaveText('這個資料夾不能瀏覽')
    await expect(dialog.locator('.folder-name')).toHaveText(['code', 'notes'])

    await input.fill('/home/me/nope')
    await input.press('Enter')
    await expect(dialog.getByRole('alert')).toHaveText('找不到這個資料夾')

    await input.fill('/home/me/code')
    await input.press('Enter')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog.locator('.folder-name')).toHaveText(['app', 'sketch'])
  })

  test('a folder that is not a git repository offers git init, only after a confirmation', async ({
    page,
  }) => {
    const gitInits: Json[] = []
    const created: Json[] = []
    await mockApi(page, { repos: [], folders, gitInits, created })
    await page.goto('/')
    await sidebarOf(page).getByRole('button', { name: '加入專案' }).click()
    const dialog = page.getByRole('dialog', { name: '加入專案' })
    await expect(dialog.locator('.folder-name')).toHaveText(['code', 'notes'])
    await dialog.getByLabel('資料夾路徑').fill('/home/me/code/sketch')
    await dialog.getByRole('button', { name: '前往' }).click()
    await expect(dialog.getByRole('navigation', { name: '目前位置' })).toContainText('sketch')
    await dialog.getByRole('button', { name: '選擇這個資料夾' }).click()
    await expect(dialog.getByText('這個資料夾還不是 git 專案')).toBeVisible()

    // Asking is not doing: nothing is sent until the confirmation.
    await dialog.getByRole('button', { name: '在這裡 git init' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('要在這個資料夾建立 git 專案嗎？')
    expect(gitInits).toEqual([])
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog.getByText('這個資料夾還不是 git 專案')).toBeVisible()

    await dialog.getByRole('button', { name: '在這裡 git init' }).click()
    await dialog.getByRole('button', { name: '確認 git init' }).click()
    await expect(dialog.getByLabel('預設分支')).toHaveValue('main')
    expect(gitInits).toEqual([{ path: '/home/me/code/sketch', confirm: true }])
    await dialog.getByRole('button', { name: '加入專案' }).click()
    await expect(dialog).toHaveCount(0)
    expect(created).toEqual([{ path: '/home/me/code/sketch', defaultBranch: 'main' }])
  })

  test('going back from the chosen folder returns to the list, and Esc closes the dialog', async ({
    page,
  }) => {
    await mockApi(page, { repos: [], folders })
    await page.goto('/')
    await sidebarOf(page).getByRole('button', { name: '加入專案' }).click()
    const dialog = page.getByRole('dialog', { name: '加入專案' })
    await dialog.getByRole('button', { name: '選擇這個資料夾' }).click()
    await dialog.getByRole('button', { name: '在這裡 git init' }).click()
    await dialog.getByRole('button', { name: '取消' }).click()
    await dialog.getByRole('button', { name: '返回' }).click()
    await expect(dialog.getByLabel('資料夾路徑')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
