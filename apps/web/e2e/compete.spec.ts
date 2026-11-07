import { expect, test } from '@playwright/test'

const repo = { id: 'repo-c', path: '/work/joy', defaultBranch: 'main' }
const task = {
  id: 'task-c',
  repoId: repo.id,
  title: 'Fix add()',
  prompt: 'Fix add()',
  mode: 'compete',
  status: 'review_ready',
  createdAt: '2026-11-06T00:00:00.000Z',
}
const patch = (text: string) =>
  `diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n@@ -1 +1 @@\n-old\n+${text}`
const diff = (text: string) => ({
  files: [{ path: 'math.js', status: 'modified', additions: 1, deletions: 1 }],
  patch: patch(text),
})

test('compete attempts are compared side by side with the judge and can be merged or chosen', async ({
  page,
}) => {
  const posts: Array<{ path: string; body: string | null }> = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [task] } })
    } else if (path === `/api/tasks/${task.id}`) {
      await route.fulfill({
        json: {
          task,
          repo,
          attempts: [
            { id: 'a1', provider: 'claude-cli', model: 'opus', status: 'succeeded' },
            { id: 'a2', provider: 'codex-cli', model: 'gpt-6', status: 'succeeded' },
          ],
          reviews: [
            { attemptId: 'a1', approve: true, summary: 'clean' },
            { attemptId: 'a2', approve: false, summary: 'missing a test' },
          ],
          events: [
            {
              taskId: task.id,
              attemptId: 'a1',
              seq: 1,
              type: 'compete.result',
              payload: { status: 'succeeded', diff: diff('claude version') },
              ts: '',
            },
            {
              taskId: task.id,
              attemptId: 'a2',
              seq: 2,
              type: 'compete.result',
              payload: { status: 'succeeded', diff: diff('codex version') },
              ts: '',
            },
            {
              taskId: task.id,
              seq: 3,
              type: 'compete.judgement',
              payload: {
                judgement: {
                  winner: 'a1',
                  reasons: 'A is simpler and tested.',
                  attempts: [{ attemptId: 'a2', strengths: 'handles NaN', weaknesses: 'no test' }],
                  mergeRecommended: true,
                },
                outcomes: [
                  { attemptId: 'a1', label: 'A' },
                  { attemptId: 'a2', label: 'B' },
                ],
              },
              ts: '',
            },
          ],
        },
      })
    } else if (request.method() === 'POST' && path.startsWith(`/api/tasks/${task.id}/`)) {
      posts.push({ path, body: request.postData() })
      await route.fulfill({ status: path.endsWith('/merge') ? 202 : 200, json: { task } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto(`/?task=${task.id}`)
  const panel = page.getByTestId('compare-panel')
  await expect(panel.getByLabel('裁判')).toContainText('選 A。 A is simpler and tested.')
  await expect(panel.getByLabel('差異 A')).toContainText('+claude version')
  await expect(panel.getByLabel('差異 B')).toContainText('+codex version')
  await expect(panel.getByLabel('方案 B')).toContainText('審查：要求修改 — missing a test')
  await expect(panel.getByLabel('方案 B')).toContainText('+ handles NaN')
  await expect(panel.getByLabel('方案 A')).toContainText('裁判推薦')

  await panel.getByRole('button', { name: /合併：由裁判綜合兩邊/ }).click()
  await panel.getByRole('button', { name: '選 B' }).click()
  await expect.poll(() => posts.length).toBe(2)
  expect(posts).toEqual([
    { path: `/api/tasks/${task.id}/merge`, body: '{}' },
    { path: `/api/tasks/${task.id}/choose`, body: '{"attemptId":"a2"}' },
  ])
})
