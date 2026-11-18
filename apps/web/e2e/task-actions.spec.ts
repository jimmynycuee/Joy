import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openTaskMenu } from './helpers.js'

// What the owner does with a finished task: merge it into the default branch, open its worktree in an editor.

const repo = { id: 'act-repo', path: '/tmp/act-project', defaultBranch: 'main' }
const config = { autonomy_mode: 'normal', roles: {} }
const task = {
  id: 'act-task',
  repoId: repo.id,
  title: 'Tidy the parser',
  prompt: 'Tidy the parser.',
  mode: 'single',
  permissionMode: 'auto',
  status: 'done',
  createdAt: new Date(Date.now() - 60_000).toISOString(),
}
const attempt = {
  id: 'a1',
  branch: 'joy/act-task/a1',
  worktreePath: '/tmp/joy/worktrees/act-repo/act-task-a1',
}
let seq = 0
const event = (type: string, payload: unknown) => ({
  taskId: task.id,
  seq: ++seq,
  type,
  payload,
  ts: new Date().toISOString(),
})
const diff = {
  files: [
    { path: 'src/parser.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
  ],
  patch: '',
}

type Reply = { status: number; json: unknown }
interface Mock {
  events: unknown[]
  /** Answers to POST requests by path; the default is 200 {}. */
  replies?: Record<string, Reply | ((mock: Mock) => Reply)>
}

async function mockApi(page: Page, mock: Mock, calls: Array<{ path: string; body: unknown }>) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') {
      calls.push({ path, body: request.postDataJSON() as unknown })
      const reply = mock.replies?.[path]
      const answer = typeof reply === 'function' ? reply(mock) : reply
      await route.fulfill(answer ?? { status: 200, json: {} })
    } else if (path === '/api/repos') await route.fulfill({ json: { repos: [repo] } })
    else if (path === '/api/tasks') await route.fulfill({ json: { tasks: [task] } })
    else if (path === '/api/config') await route.fulfill({ json: { config } })
    else if (path === '/api/approvals') await route.fulfill({ json: { approvals: [] } })
    else if (path === `/api/tasks/${task.id}`)
      await route.fulfill({
        json: { task, repo, attempts: [attempt], reviews: [], events: mock.events, taskAllows: [] },
      })
    else await route.fulfill({ json: {} })
  })
}

const MERGE = `/api/tasks/${task.id}/merge-into-default`

test('merging asks first with the branch and file count, then shows the task as merged', async ({ page }) => {
  const calls: Array<{ path: string; body: unknown }> = []
  const mock: Mock = {
    events: [event('result', { status: 'succeeded', diff })],
    replies: {
      [MERGE]: (current) => {
        current.events = [
          ...current.events,
          event('task.merged', { branch: 'main', commit: 'abc', files: 2 }),
        ]
        return { status: 200, json: { merged: { branch: 'main', commit: 'abc', files: 2 } } }
      },
    },
  }
  await mockApi(page, mock, calls)
  await page.goto(`/?task=${task.id}`)

  const merge = page.getByTestId('merge')
  await merge.getByRole('button', { name: '合併到 main' }).click()
  const confirm = merge.getByRole('group', { name: '確認合併' })
  await expect(confirm).toContainText('把 2 個檔案合併到 main？')
  // Cancelling sends nothing.
  await confirm.getByRole('button', { name: '取消' }).click()
  expect(calls.filter((call) => call.path === MERGE)).toHaveLength(0)

  await merge.getByRole('button', { name: '合併到 main' }).click()
  await merge.getByRole('button', { name: '合併', exact: true }).click()
  await expect
    .poll(() => calls.filter((call) => call.path === MERGE).map((call) => call.body))
    .toEqual([{ confirm: true }])
  await expect(page.getByText('已合併到 main')).toBeVisible()
  await expect(page.getByTestId('merge')).toHaveCount(0)
  // The changes are in main now, so the worktree can simply go.
  await expect(page.getByRole('button', { name: '清除工作副本' })).toBeVisible()
})

test('a refused merge says why and lists conflicting files', async ({ page }) => {
  const calls: Array<{ path: string; body: unknown }> = []
  await mockApi(
    page,
    {
      events: [event('result', { status: 'succeeded', diff })],
      replies: {
        [MERGE]: {
          status: 409,
          json: { error: 'conflict', reason: 'conflict', branch: 'main', conflicts: ['src/parser.ts'] },
        },
      },
    },
    calls,
  )
  await page.goto(`/?task=${task.id}`)
  const merge = page.getByTestId('merge')
  await merge.getByRole('button', { name: '合併到 main' }).click()
  await merge.getByRole('button', { name: '合併', exact: true }).click()
  await expect(merge.getByRole('alert')).toHaveText('和 main 有衝突，已取消合併：src/parser.ts')
  // Still offered, so the owner can try again after resolving it.
  await expect(merge.getByRole('button', { name: '合併', exact: true })).toBeVisible()
})

test('no merge button for a task without changes', async ({ page }) => {
  await mockApi(
    page,
    { events: [event('result', { status: 'succeeded', diff: { files: [], patch: '' } })] },
    [],
  )
  await page.goto(`/?task=${task.id}`)
  await expect(page.getByTestId('task-done')).toBeVisible()
  await expect(page.getByTestId('merge')).toHaveCount(0)
})

test('the task menu opens the worktree in the editor and explains a missing command', async ({ page }) => {
  const calls: Array<{ path: string; body: unknown }> = []
  await mockApi(
    page,
    {
      events: [event('result', { status: 'succeeded', diff })],
      replies: {
        [`/api/tasks/${task.id}/open-editor`]: {
          status: 422,
          json: { error: 'not found', reason: 'editor_not_found', command: 'code' },
        },
      },
    },
    calls,
  )
  await page.goto(`/?task=${task.id}`)
  await openTaskMenu(page, '在編輯器開啟')
  await expect.poll(() => calls.map((call) => call.path)).toContain(`/api/tasks/${task.id}/open-editor`)
  await expect(page.getByRole('alert')).toContainText('找不到 code 指令，請在設定指定編輯器')
})
