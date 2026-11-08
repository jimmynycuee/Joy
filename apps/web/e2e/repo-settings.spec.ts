import { expect, test } from '@playwright/test'
import { openSettings } from './helpers.js'

test('a project’s GitHub remote, allowed services and check command are edited in settings', async ({
  page,
}) => {
  const patches: Array<{ path: string; body: unknown }> = []
  let repo: Record<string, unknown> = {
    id: 'settings-repo',
    path: '/work/app',
    defaultBranch: 'main',
    allowedProviders: ['openai-api', 'claude-cli', 'codex-cli'],
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'PATCH' && path === '/api/repos/settings-repo') {
      const body = request.postDataJSON() as Record<string, unknown>
      patches.push({ path, body })
      // null clears a field, like the server.
      repo = Object.fromEntries(Object.entries({ ...repo, ...body }).filter(([, value]) => value !== null))
      await route.fulfill({ json: { repo } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config: { autonomy_mode: 'normal', roles: {} } } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await openSettings(page, '專案')
  const form = page.getByRole('form', { name: 'app 的專案設定' })
  const save = form.getByRole('button', { name: '儲存專案設定' })
  await expect(save).toBeDisabled()
  await expect(form).toContainText('不會經過 shell')

  await form.getByLabel('app 的檢查指令').fill('pnpm check')
  await form.getByLabel('app 的 GitHub 網址').fill('https://github.com/o/app.git')
  await form.getByLabel('app 允許 OpenAI API').uncheck()
  await save.click()
  await expect(form.getByRole('status').filter({ hasText: '已儲存' })).toBeVisible()
  expect(patches).toEqual([
    {
      path: '/api/repos/settings-repo',
      body: {
        githubRemote: 'https://github.com/o/app.git',
        allowedProviders: ['claude-cli', 'codex-cli'],
        checkCommand: ['pnpm', 'check'],
      },
    },
  ])
  await expect(save).toBeDisabled()

  // Emptying the field removes the check; a shell symbol is flagged but sent as-is.
  await form.getByLabel('app 的檢查指令').fill('pnpm check && pnpm build')
  await expect(form).toContainText('不會被 shell 解讀')
  await form.getByLabel('app 的檢查指令').fill('')
  await save.click()
  await expect.poll(() => patches.length).toBe(2)
  expect(patches[1]?.body).toEqual({ checkCommand: null })

  // At least one service has to stay allowed.
  for (const name of ['Claude Code', 'Codex']) await form.getByLabel(`app 允許 ${name}`).uncheck()
  await save.click()
  await expect(form).toContainText('至少要允許一個服務')
  expect(patches).toHaveLength(2)
})
