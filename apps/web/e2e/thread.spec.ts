import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const repo = { id: 'thread-repo', path: '/tmp/thread-project', defaultBranch: 'main' }
const config = { autonomy_mode: 'normal', roles: {} }

function taskOf(status: string, id = 'thread-task') {
  return {
    id,
    repoId: repo.id,
    title: 'Fix the login page',
    prompt: 'Pressing Enter on the login page does nothing.',
    mode: 'review_loop',
    status,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  }
}

let seq = 0
const stamp = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()
const event = (taskId: string, type: string, payload: unknown, secondsAgo = 60) => ({
  taskId,
  seq: ++seq,
  type,
  payload,
  ts: stamp(secondsAgo),
})
const agent = (taskId: string, role: string, inner: unknown, secondsAgo = 60) =>
  event(taskId, 'agent', { role, event: inner }, secondsAgo)

async function mockApi(
  page: Page,
  details: { task: ReturnType<typeof taskOf>; attempts?: unknown[]; events: unknown[] },
  posts: string[],
) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path.startsWith(`/api/tasks/${details.task.id}/`)) {
      posts.push(path)
      await route.fulfill({ status: 202, json: { task: details.task } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [details.task] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === `/api/tasks/${details.task.id}`) {
      await route.fulfill({
        json: {
          task: details.task,
          repo,
          attempts: details.attempts ?? [],
          reviews: [],
          events: details.events,
        },
      })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

test('a failed task shows commands, safe Markdown, the review, its branch and can be retried', async ({
  page,
}) => {
  const task = taskOf('failed')
  const posts: string[] = []
  await mockApi(
    page,
    {
      task,
      attempts: [{ id: 'a1', branch: 'joy/fix-login', worktreePath: '/wt/fix-login' }],
      events: [
        event(task.id, 'started', {}),
        agent(task.id, 'implementer', {
          type: 'message',
          text: 'I will **fix** it.\n\n- check the handler\n- add a test\n\n<script>window.__pwned = true</script> [bad](javascript:alert(1))',
        }),
        agent(task.id, 'implementer', {
          type: 'tool_call',
          id: 't1',
          name: 'Bash',
          input: { command: 'pnpm test' },
        }),
        agent(task.id, 'implementer', { type: 'tool_result', id: 't1', output: 'all green', isError: false }),
        agent(task.id, 'implementer', {
          type: 'tool_call',
          id: 't2',
          name: 'Edit',
          input: { file_path: '/wt/fix-login/src/login.ts' },
        }),
        event(task.id, 'policy.action', { kind: 'read_file', tier: 'auto' }),
        event(task.id, 'review', {
          type: 'review',
          round: 1,
          target: 'change',
          verdict: {
            approve: false,
            summary: 'Needs a test',
            findings: [
              { severity: 'major', file: 'src/login.ts', line: 12, message: 'No test covers Enter' },
            ],
          },
        }),
        event(task.id, 'error', { message: 'Reviewer process exited unexpectedly' }),
      ],
    },
    posts,
  )

  await page.goto(`/?task=${task.id}`)
  const stream = page.getByTestId('event-stream')
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible()

  // Commands and files, not "執行 Bash".
  await expect(stream).toContainText('$ pnpm test')
  await expect(stream).toContainText('編輯 src/login.ts')
  await stream.getByText('$ pnpm test').click()
  await expect(stream.getByText('all green')).toBeVisible()

  // Markdown renders; raw HTML and javascript: links do not become elements.
  await expect(stream.locator('strong', { hasText: 'fix' })).toBeVisible()
  await expect(stream.locator('.prose li')).toHaveCount(2)
  await expect(stream.locator('script')).toHaveCount(0)
  await expect(stream.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(stream).toContainText('<script>window.__pwned = true</script>')
  expect(await page.evaluate(() => (window as Window & { __pwned?: boolean }).__pwned)).toBeUndefined()

  // Structured review.
  const review = page.getByLabel('審查結果')
  await expect(review).toContainText('程式變更要求修改')
  await expect(review).toContainText('No test covers Enter')
  await expect(review).toContainText('src/login.ts:12')

  // Routine policy actions are noise until 顯示細節.
  await expect(stream.getByText('權限：讀取檔案')).toBeHidden()
  await page.getByRole('button', { name: /顯示細節/ }).click()
  await expect(stream.getByText('權限：讀取檔案')).toBeVisible()

  // The task's own branch, not the repository default.
  const header = page.locator('.thread-header')
  await expect(header).toContainText('joy/fix-login')
  await expect(header).not.toContainText('main')
  await expect(page.getByRole('button', { name: '複製分支名稱' })).toBeVisible()

  // Failure card, with retry.
  const failure = page.getByLabel('任務失敗')
  await expect(failure).toContainText('Reviewer process exited unexpectedly')
  await failure.getByRole('button', { name: '重試' }).click()
  await expect.poll(() => posts).toEqual([`/api/tasks/${task.id}/resume`])
  await expect(header.locator('.status-pill')).toHaveText('失敗')
})

test('a running task shows progress, can be stopped, and keeps the changes pane closed until there is a diff', async ({
  page,
}) => {
  const task = taskOf('running', 'running-task')
  const posts: string[] = []
  await mockApi(
    page,
    {
      task,
      events: [
        event(task.id, 'started', {}, 90),
        event(task.id, 'phase', { phase: 'implementing', round: 1, role: 'implementer' }, 80),
        event(task.id, 'phase', { phase: 'reviewing', round: 1, role: 'reviewer' }, 40),
        event(task.id, 'phase', { phase: 'fixing', round: 2, role: 'implementer' }, 20),
      ],
    },
    posts,
  )

  await page.goto(`/?task=${task.id}`)
  const progress = page.locator('.running-indicator')
  await expect(progress).toContainText('依審查意見修正')
  await expect(progress).toContainText('實作')
  await expect(progress).toContainText('第 2 輪')
  await expect(progress.getByLabel('已執行時間')).toHaveText(/^1:[3-9]\d$|^[2-9]:\d\d$/)

  // No diff yet: the pane is closed and the toggle shows no "+0 −0".
  await expect(page.getByRole('complementary', { name: '檔案變更' })).toHaveCount(0)
  const toggle = page.getByRole('button', { name: '顯示變更' })
  await expect(toggle).not.toContainText('+0')
  await toggle.click()
  await expect(page.getByRole('complementary', { name: '檔案變更' })).toContainText('還沒有變更')

  await page.getByRole('button', { name: '停止' }).click()
  await expect.poll(() => posts).toEqual([`/api/tasks/${task.id}/cancel`])
})

test('a done task opens its changes by itself with a file tree and coloured lines', async ({ page }) => {
  const task = taskOf('done', 'done-task')
  const diff = {
    files: [
      { path: 'src/ui/login.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'src/ui/form.ts', status: 'modified', additions: 2, deletions: 0 },
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    ],
    patch: [
      'diff --git a/src/ui/login.ts b/src/ui/login.ts',
      '--- a/src/ui/login.ts',
      '+++ b/src/ui/login.ts',
      '@@ -1 +1 @@',
      '-old line',
      '+new line',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1,2 @@',
      '+readme line',
    ].join('\n'),
  }
  await mockApi(
    page,
    {
      task,
      events: [
        event(task.id, 'started', {}),
        event(task.id, 'result', { status: 'succeeded', approved: true, rounds: 1, diff }),
        event(task.id, 'publish.done', { pullRequestUrl: 'https://github.com/owner/repo/pull/7' }),
      ],
    },
    [],
  )

  await page.goto(`/?task=${task.id}`)
  const pane = page.getByRole('complementary', { name: '檔案變更' })
  await expect(pane).toBeVisible()
  await expect(pane.getByRole('group', { name: '變更的檔案' })).toContainText('src/ui')
  await expect(pane.getByRole('button', { name: /login\.ts/ })).toBeVisible()
  await expect(pane.locator('.diff-line.added').first()).toContainText('+new line')
  await expect(pane.locator('.diff-line.removed').first()).toContainText('-old line')
  await pane.getByRole('button', { name: /README\.md/ }).click()
  await expect(page.getByTestId('diff-patch')).toContainText('+readme line')

  // A published task links to its PR.
  const pr = page.getByTestId('publish-panel').getByRole('link', { name: '查看 PR' })
  await expect(pr).toHaveAttribute('href', 'https://github.com/owner/repo/pull/7')
})
