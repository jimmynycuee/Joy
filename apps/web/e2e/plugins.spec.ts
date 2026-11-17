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

type Json = Record<string, unknown>
interface Mock {
  skills: Json[]
  servers: Json[]
  files: string[]
  requests: Array<{ method: string; path: string; search: string; body?: Json }>
}

async function mockApi(page: Page, mock: Mock) {
  await page.routeWebSocket('**/ws**', () => undefined)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const body = method === 'GET' || method === 'DELETE' ? undefined : (request.postDataJSON() as Json)
    mock.requests.push({ method, path, search: url.search, ...(body ? { body } : {}) })
    const server = /^\/api\/mcp-servers\/([^/]+)$/.exec(path)
    if (path === '/api/skills') await route.fulfill({ json: { skills: mock.skills } })
    else if (path === '/api/files') {
      const q = url.searchParams.get('q') ?? ''
      await route.fulfill({ json: { files: mock.files.filter((file) => file.includes(q)) } })
    } else if (path === '/api/mcp-servers' && method === 'POST') {
      const created = {
        id: `s${mock.servers.length + 1}`,
        name: body?.name,
        transport: body?.transport,
        command: body?.command,
        args: body?.args ?? [],
        vars: ((body?.vars as Json[] | undefined) ?? []).map((v) =>
          v.secret ? { name: v.name, secret: true } : { name: v.name, value: v.value, secret: false },
        ),
        enabled: true,
        readOnly: Boolean(body?.readOnly),
      }
      mock.servers.push(created)
      await route.fulfill({ status: 201, json: { server: created } })
    } else if (path === '/api/mcp-servers') await route.fulfill({ json: { servers: mock.servers } })
    else if (server && method === 'PATCH') {
      const index = mock.servers.findIndex((s) => s.id === server[1])
      mock.servers[index] = { ...mock.servers[index], ...body }
      await route.fulfill({ json: { server: mock.servers[index] } })
    } else if (server && method === 'DELETE') {
      mock.servers = mock.servers.filter((s) => s.id !== server[1])
      await route.fulfill({ json: { deleted: true } })
    } else if (path === '/api/repos')
      await route.fulfill({ json: { repos: [{ id: 'a', path: '/work/alpha', defaultBranch: 'main' }] } })
    else if (path === '/api/tasks' && method === 'POST')
      await route.fulfill({ status: 500, json: { error: 'not in this test' } })
    else if (path === '/api/tasks') await route.fulfill({ json: { tasks: [] } })
    else if (path === '/api/config') await route.fulfill({ json: { config } })
    else if (path === '/api/conversations') await route.fulfill({ json: { conversations: [] } })
    else await route.fulfill({ json: {} })
  })
}

const box = (page: Page) => page.getByRole('textbox', { name: '任務內容' })
const menu = (page: Page) => page.getByTestId('completion-menu')
const fresh = (): Mock => ({
  skills: [
    { name: 'review', description: 'Review the diff', cli: 'claude-cli', scope: 'user', kind: 'skill' },
    { name: 'deploy', cli: 'codex-cli', scope: 'user', kind: 'skill' },
  ],
  servers: [
    {
      id: 's1',
      name: 'docs',
      transport: 'stdio',
      command: 'docs-mcp',
      args: [],
      vars: [],
      enabled: true,
      readOnly: false,
    },
  ],
  files: ['src/auth/login.ts', 'src/logout.ts'],
  requests: [],
})

test('/ lists the implementer’s skills and Joy’s commands; arrows, Enter and Esc work', async ({ page }) => {
  const mock = fresh()
  await mockApi(page, mock)
  await page.goto('/')
  await box(page).click()
  await page.keyboard.type('/')
  await expect(menu(page)).toBeVisible()
  const options = menu(page).getByRole('option')
  // The implementer is Claude: Codex's `deploy` is not offered.
  await expect(options.first()).toContainText('/review')
  await expect(menu(page)).not.toContainText('/deploy')
  await expect(menu(page)).toContainText('/settings')
  await expect(box(page)).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.type('re')
  await expect(options).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(box(page)).toHaveValue('/review ')
  await expect(menu(page)).toBeHidden()

  // Esc closes the menu and leaves the text alone.
  await box(page).fill('')
  await page.keyboard.type('/s')
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
  await expect(box(page)).toHaveValue('/s')

  // Nothing matches: no menu at all.
  await box(page).fill('')
  await page.keyboard.type('/zzz')
  await expect(menu(page)).toBeHidden()

  // A Joy command runs instead of being inserted.
  await box(page).fill('')
  await page.keyboard.type('/sett')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('navigation', { name: '設定分類' })).toBeVisible()
})

test('@ lists the project’s MCP servers and files and inserts the relative path', async ({ page }) => {
  const mock = fresh()
  await mockApi(page, mock)
  await page.goto('/')
  await box(page).click()
  await page.keyboard.type('fix @log')
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('option')).toHaveText(['src/auth/login.ts', 'src/logout.ts'])
  expect(mock.requests.some((r) => r.path === '/api/files' && r.search.includes('repoId=a'))).toBe(true)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(box(page)).toHaveValue('fix src/logout.ts ')

  await page.keyboard.type('@d')
  await expect(menu(page).getByRole('option').first()).toContainText('@docs')
  await page.keyboard.press('Tab')
  await expect(box(page)).toHaveValue('fix src/logout.ts @docs ')
  // An e-mail address is not a mention.
  await page.keyboard.type('me@log')
  await expect(menu(page)).toBeHidden()
})

test('Settings → 外掛: empty states, add a server with a secret, mark it read-only, delete it', async ({
  page,
}) => {
  const mock = fresh()
  mock.skills = []
  mock.servers = []
  await mockApi(page, mock)
  await page.goto('/')
  await openSettings(page)
  await page.getByRole('navigation', { name: '設定分類' }).getByRole('button', { name: '外掛' }).click()
  await expect(page.getByTestId('mcp-panel')).toContainText('沒有 MCP server')
  await expect(page.getByTestId('skills-panel')).toContainText('沒有 skill')

  await page.getByRole('button', { name: '新增' }).click()
  const form = page.getByTestId('mcp-form')
  await form.getByLabel('名稱').fill('files')
  await form.getByLabel('指令').fill('npx -y "files mcp" --root /tmp')
  await form.getByRole('button', { name: '環境變數' }).click()
  await form.getByLabel('環境變數 1 名稱').fill('API_TOKEN')
  await form.getByLabel('環境變數 1 值').fill('secret-value')
  await expect(form.getByLabel('環境變數 1 值')).toHaveAttribute('type', 'password')
  await form.getByRole('button', { name: '新增' }).click()

  const row = page.getByTestId('mcp-server')
  await expect(row).toContainText('files')
  await expect(row).toContainText('API_TOKEN •••')
  await expect(row).not.toContainText('secret-value')
  const posted = mock.requests.find((r) => r.method === 'POST' && r.path === '/api/mcp-servers')
  expect(posted?.body).toEqual({
    name: 'files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'files mcp', '--root', '/tmp'],
    vars: [{ name: 'API_TOKEN', value: 'secret-value', secret: true }],
    readOnly: false,
  })

  await row.getByLabel('files 唯讀，可自動').check()
  await expect.poll(() => mock.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ readOnly: true })
  await row.getByLabel('啟用 files').uncheck()
  await expect
    .poll(() => mock.requests.filter((r) => r.method === 'PATCH').at(-1)?.body)
    .toEqual({
      enabled: false,
    })

  page.once('dialog', (dialog) => void dialog.accept())
  await row.getByRole('button', { name: '刪除 files' }).click()
  await expect(page.getByTestId('mcp-panel')).toContainText('沒有 MCP server')
})
