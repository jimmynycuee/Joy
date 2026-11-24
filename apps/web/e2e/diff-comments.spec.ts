import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const repo = { id: 'comment-repo', path: '/tmp/comment-project', defaultBranch: 'main' }
const config = { autonomy_mode: 'normal', roles: {} }
const task = {
  id: 'comment-task',
  repoId: repo.id,
  title: 'Fix the login page',
  prompt: 'Pressing Enter on the login page does nothing.',
  mode: 'review_loop',
  status: 'done',
  createdAt: new Date(Date.now() - 120_000).toISOString(),
}
const diff = {
  files: [{ path: 'src/login.ts', status: 'modified', additions: 1, deletions: 1 }],
  patch: [
    'diff --git a/src/login.ts b/src/login.ts',
    '--- a/src/login.ts',
    '+++ b/src/login.ts',
    '@@ -7,2 +7,2 @@',
    ' const form = find()',
    '-form.onsubmit = null',
    '+form.onsubmit = submit',
  ].join('\n'),
}

let seq = 0
const event = (type: string, payload: unknown) => ({
  taskId: task.id,
  seq: ++seq,
  type,
  payload,
  ts: new Date(Date.now() - 60_000).toISOString(),
})

async function mockApi(page: Page, events: unknown[], sent: Array<{ text: string; queue?: boolean }>) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path === `/api/tasks/${task.id}/messages`) {
      sent.push(request.postDataJSON() as { text: string; queue?: boolean })
      await route.fulfill({ status: 202, json: { task } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [task] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === `/api/tasks/${task.id}`) {
      await route.fulfill({ json: { task, repo, attempts: [], reviews: [], events } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

const result = () => event('result', { status: 'succeeded', approved: true, rounds: 1, diff })

test('comments on diff lines survive a reload and go to the agent as one message', async ({ page }) => {
  const sent: Array<{ text: string; queue?: boolean }> = []
  await mockApi(page, [event('started', {}), result()], sent)
  await page.goto(`/?task=${task.id}`)
  const pane = page.getByRole('complementary', { name: '檔案變更' })
  const added = pane.locator('.diff-line.added').first()
  const removed = pane.locator('.diff-line.removed').first()
  // Line numbers: the new file's for added lines, the old file's for removed ones; not part of the line's text.
  await expect(added).toHaveAttribute('data-line', '8')
  await expect(removed).toHaveAttribute('data-line', '8')
  await expect(added).toHaveText('+form.onsubmit = submit')

  await added.hover()
  await added.getByRole('button', { name: '在第 8 行留言' }).click()
  await pane.getByRole('textbox', { name: '留言' }).fill('Use the form helper here')
  await pane.getByRole('button', { name: '留言', exact: true }).click()
  await removed.hover()
  await removed.getByRole('button', { name: '在第 8 行留言' }).click()
  await pane.getByRole('textbox', { name: '留言' }).fill('Why remove this?')
  await pane.getByRole('textbox', { name: '留言' }).press('Escape')
  await expect(pane.getByRole('textbox', { name: '留言' })).toHaveCount(0)
  await removed.getByRole('button', { name: '在第 8 行留言' }).click()
  await pane.getByRole('textbox', { name: '留言' }).fill('Keep the old handler')
  await pane.getByRole('textbox', { name: '留言' }).press('ControlOrMeta+Enter')

  await expect(pane.getByTestId('diff-comment')).toHaveText([
    'Keep the old handler',
    'Use the form helper here',
  ])
  await expect(pane.getByTestId('diff-comments-bar')).toContainText('2 則留言')

  // Unsent comments are kept like a draft.
  await page.reload()
  await expect(pane.getByTestId('diff-comment')).toHaveCount(2)
  await pane
    .getByTestId('diff-comment')
    .filter({ hasText: 'Keep the old handler' })
    .getByRole('button', { name: '刪除留言' })
    .click()
  await expect(pane.getByTestId('diff-comments-bar')).toContainText('1 則留言')

  await pane.getByRole('button', { name: '送出留言' }).click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toEqual({
    text: [
      '我在變更上留了 1 則意見，請逐一處理：',
      '',
      'src/login.ts 第 8 行',
      '> +form.onsubmit = submit',
      'Use the form helper here',
    ].join('\n'),
  })
  await expect(pane.getByTestId('diff-comments-bar')).toHaveCount(0)
  await expect(pane.getByTestId('diff-comment')).toHaveCount(0)
  await page.reload()
  await expect(pane.locator('.diff-line.added')).toHaveCount(1)
  await expect(pane.getByTestId('diff-comment')).toHaveCount(0)
})

test('a task that cannot take messages has no comment buttons', async ({ page }) => {
  await mockApi(page, [event('started', {}), result(), event('worktree.removed', {})], [])
  await page.goto(`/?task=${task.id}`)
  const pane = page.getByRole('complementary', { name: '檔案變更' })
  await expect(pane.locator('.diff-line.added')).toHaveCount(1)
  await expect(pane.getByRole('button', { name: /留言/ })).toHaveCount(0)
})
