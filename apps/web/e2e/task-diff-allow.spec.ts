import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openTaskMenu } from './helpers.js'

const repo = {
  id: 'diff-repo',
  path: '/tmp/diff-project',
  defaultBranch: 'main',
  githubRemote: 'https://github.com/owner/repo.git',
}
const config = { autonomy_mode: 'normal', roles: {} }
const taskOf = (status: string) => ({
  id: 'diff-task',
  repoId: repo.id,
  title: 'Tidy the parser',
  prompt: 'Tidy the parser.',
  mode: 'single',
  permissionMode: 'auto',
  status,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
})
let seq = 0
const event = (type: string, payload: unknown) => ({
  taskId: 'diff-task',
  seq: ++seq,
  type,
  payload,
  ts: new Date().toISOString(),
})
const chunk = (path: string, lines: number) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    ...Array.from({ length: lines }, (_, i) => `+${path} line ${i}`),
  ].join('\n')

interface Mock {
  task: ReturnType<typeof taskOf>
  events: unknown[]
  approvals?: unknown[]
  taskAllows?: unknown[]
  pr?: unknown
}

async function mockApi(
  page: Page,
  mock: Mock,
  calls: Array<{ method: string; path: string; body: unknown }>,
) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (method !== 'GET') {
      calls.push({ method, path, body: request.postDataJSON() as unknown })
      await route.fulfill({ status: 200, json: {} })
    } else if (path === '/api/repos') await route.fulfill({ json: { repos: [repo] } })
    else if (path === '/api/tasks') await route.fulfill({ json: { tasks: [mock.task] } })
    else if (path === '/api/config') await route.fulfill({ json: { config } })
    else if (path === '/api/approvals') await route.fulfill({ json: { approvals: mock.approvals ?? [] } })
    else if (path === `/api/tasks/${mock.task.id}/pr`) await route.fulfill({ json: mock.pr ?? {} })
    else if (path === `/api/tasks/${mock.task.id}`)
      await route.fulfill({
        json: {
          task: mock.task,
          repo,
          attempts: [],
          reviews: [],
          events: mock.events,
          taskAllows: mock.taskAllows ?? [],
        },
      })
    else await route.fulfill({ json: {} })
  })
}

const diff = {
  files: [
    { path: 'src/parser.ts', status: 'modified', additions: 3, deletions: 0 },
    { path: 'pnpm-lock.yaml', status: 'modified', additions: 1200, deletions: 0 },
    { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
  ],
  patch: [chunk('src/parser.ts', 3), chunk('pnpm-lock.yaml', 1200), chunk('README.md', 1)].join('\n'),
}

test('the diff lists every file, folds each one, keeps long files closed and pages their lines', async ({
  page,
}) => {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  await mockApi(
    page,
    { task: taskOf('done'), events: [event('result', { status: 'succeeded', diff })] },
    calls,
  )
  await page.goto('/?task=diff-task')
  const pane = page.getByRole('complementary', { name: '檔案變更' })
  const files = pane.getByTestId('diff-patch')
  const parser = files.getByRole('region', { name: 'src/parser.ts' })
  const lock = files.getByRole('region', { name: 'pnpm-lock.yaml' })
  await expect(parser).toContainText('+src/parser.ts line 2')
  await expect(files.getByRole('region', { name: 'README.md' })).toContainText('+README.md line 0')
  // The lockfile is too long to draw by itself.
  await expect(lock.getByRole('button', { name: /pnpm-lock\.yaml/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(lock.locator('.diff-line')).toHaveCount(0)

  // Opening it draws the first page, then the rest on request.
  await lock.getByRole('button', { name: /pnpm-lock\.yaml/ }).click()
  await expect(lock.locator('.diff-line')).toHaveCount(500)
  await lock.getByRole('button', { name: '顯示其餘 704 行' }).click()
  await expect(lock.locator('.diff-line')).toHaveCount(1204)

  // A file folds away.
  await parser.getByRole('button', { name: /src\/parser\.ts/ }).click()
  await expect(parser.locator('.diff-line')).toHaveCount(0)
  await pane.getByRole('button', { name: '全部展開' }).click()
  await expect(parser.locator('.diff-line')).toHaveCount(7)

  // Above the diff: open a PR, only when the owner clicks.
  const bar = pane.getByTestId('pr-bar')
  await expect(bar.getByRole('button', { name: '開 PR' })).toBeVisible()
  expect(calls.filter((call) => call.path.endsWith('/publish'))).toHaveLength(0)
  await bar.getByRole('button', { name: '開 PR' }).click()
  await expect.poll(() => calls.map((call) => call.path)).toContain('/api/tasks/diff-task/publish')
})

test('a published task shows its PR link and CI above the diff', async ({ page }) => {
  await mockApi(
    page,
    {
      task: taskOf('done'),
      events: [
        event('result', { status: 'succeeded', diff }),
        event('publish.done', { pullRequestUrl: 'https://github.com/owner/repo/pull/12' }),
      ],
      pr: {
        url: 'https://github.com/owner/repo/pull/12',
        state: 'OPEN',
        isDraft: true,
        checks: { passing: 3, failing: 1, pending: 0, failingNames: ['lint'] },
      },
    },
    [],
  )
  await page.goto('/?task=diff-task')
  const bar = page.getByRole('complementary', { name: '檔案變更' }).getByTestId('pr-bar')
  await expect(bar.getByRole('link', { name: 'PR #12' })).toHaveAttribute(
    'href',
    'https://github.com/owner/repo/pull/12',
  )
  await expect(bar).toContainText('Draft')
  await expect(bar).toContainText('通過 3 / 失敗 1')
  await expect(bar.getByRole('button', { name: '開 PR' })).toHaveCount(0)
})

test('a running task has no PR button', async ({ page }) => {
  await mockApi(
    page,
    { task: taskOf('running'), events: [event('result', { status: 'succeeded', diff })] },
    [],
  )
  await page.goto('/?task=diff-task')
  await expect(page.getByTestId('diff-patch')).toBeVisible()
  await expect(page.getByTestId('pr-bar')).toHaveCount(0)
})

const approval = (id: string, command: string, allowInTask?: boolean) => ({
  id,
  taskId: 'diff-task',
  createdAt: new Date().toISOString(),
  status: 'pending',
  action: {
    kind: 'run_outside_worktree',
    summary: 'Claude requested the Bash tool.',
    provenance: 'agent',
    detail: { command },
  },
  ...(allowInTask ? { allowInTask } : {}),
})

test('the approval card offers "allow for this task" only when Joy can remember it, and the menu can revoke it', async ({
  page,
}) => {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  await mockApi(
    page,
    {
      task: taskOf('awaiting_approval'),
      events: [event('started', {})],
      approvals: [approval('ap-1', 'rm -rf ../cache', true), approval('ap-2', 'git push origin HEAD')],
      taskAllows: [
        {
          id: 'allow-1',
          kind: 'shell',
          target: 'pnpm install',
          approvalId: 'ap-0',
          createdAt: new Date().toISOString(),
        },
      ],
    },
    calls,
  )
  await page.goto('/?task=diff-task')
  const card = page.getByTestId('pending-approvals')
  const rows = card.locator('.approval-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).getByRole('button')).toHaveText(['同意', '這個任務內一律允許', '拒絕'])
  await expect(rows.nth(1).getByRole('button')).toHaveText(['同意', '拒絕'])
  await rows.nth(0).getByRole('button', { name: '這個任務內一律允許' }).click()
  await expect
    .poll(() => calls.find((call) => call.path === '/api/approvals/ap-1/approve')?.body)
    .toEqual({ scope: 'task' })

  await openTaskMenu(page, /允許/)
  const list = page.getByRole('list', { name: '這個任務內允許的動作' })
  await expect(list).toContainText('pnpm install')
  await list.getByRole('button', { name: '撤銷：pnpm install' }).click()
  await expect
    .poll(() => calls.map((call) => `${call.method} ${call.path}`))
    .toContain('DELETE /api/tasks/diff-task/allows/allow-1')
})
