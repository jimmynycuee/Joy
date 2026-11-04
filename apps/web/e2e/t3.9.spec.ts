import { test, expect } from '@playwright/test'

test('model performance shows fake-provider success, review findings, and elapsed time', async ({
  page,
  request,
}) => {
  const repoResponse = await request.post('/api/repos', {
    data: { path: '/tmp/joy-t3.9-model-stats', defaultBranch: 'main' },
  })
  expect(repoResponse.status()).toBe(201)
  const { repo } = (await repoResponse.json()) as { repo: { id: string } }
  const taskResponse = await request.post('/api/tasks', {
    data: {
      repoId: repo.id,
      title: 'T3.9 model statistics sample',
      prompt: 'T3.9_STATS_REVIEW_ISSUE',
      mode: 'review_loop',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'fake-stats-implementer', effort: 'low' },
        reviewer: { provider: 'codex-cli', model: 'fake-stats-reviewer', effort: 'low' },
      },
    },
  })
  expect(taskResponse.status()).toBe(201)
  const { task } = (await taskResponse.json()) as { task: { id: string } }

  await expect
    .poll(async () => {
      const response = await request.get(`/api/tasks/${task.id}`)
      const details = (await response.json()) as { task: { status: string } }
      return details.task.status
    })
    .toBe('done')

  const statsResponse = await request.get('/api/model-stats')
  expect(statsResponse.status()).toBe(200)
  const { stats } = (await statsResponse.json()) as {
    stats: Array<{
      provider: string
      model: string
      taskKind: string
      attemptCount: number
      successCount: number
      successRate: number
      totalReviewIssues: number
      averageReviewIssues: number
      averageDurationMs: number
    }>
  }
  expect(stats).toContainEqual(
    expect.objectContaining({
      provider: 'claude-cli',
      model: 'fake-stats-implementer',
      taskKind: 'review_loop',
      attemptCount: 1,
      successCount: 1,
      successRate: 1,
      totalReviewIssues: 1,
      averageReviewIssues: 1,
      averageDurationMs: expect.any(Number),
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'Performance' }).click()
  await expect(page.getByRole('heading', { name: 'Model performance' })).toBeVisible()
  const row = page.getByTestId('model-stat-row').filter({ hasText: 'fake-stats-implementer' })
  await expect(row).toContainText('Implement + review')
  await expect(row).toContainText('Claude Code')
  await expect(row).toContainText('100%')
  await expect(row).toContainText('1.0 avg')
  await expect(row).toContainText('1 total')
  await expect(row).toContainText(/\d+s/)
  await page.screenshot({ path: 'test-results/t3.9-model-stats.png', fullPage: true })
})
