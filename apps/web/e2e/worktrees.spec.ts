import { expect, test } from '@playwright/test'

const config = {
  autonomy_mode: 'normal',
  roles: Object.fromEntries(
    ['assistant_brain', 'background', 'orchestrator', 'implementer', 'reviewer', 'judge'].map((role) => [
      role,
      { provider: 'claude-cli', model: 'worktree-test-model', effort: 'low' },
    ]),
  ),
}

test('worktrees show disk usage and are removed only after confirming unpushed commits', async ({ page }) => {
  let worktrees = [
    {
      path: '/wt/a',
      repoPath: '/work/joy',
      branch: 'joy/t1/a1',
      diskUsageBytes: 3 * 1024 * 1024,
      unpushedCommitCount: 2,
      ageDays: 20.4,
      stale: true,
      active: false,
      taskId: 't1',
      taskTitle: 'Old experiment',
      taskStatus: 'done',
    },
  ]
  const removals: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/worktrees') {
      await route.fulfill({ json: { worktrees, totalBytes: 3 * 1024 * 1024, staleAfterDays: 14 } })
    } else if (path === '/api/worktrees/remove') {
      const body = request.postDataJSON() as { confirmUnpushedCommits?: boolean }
      removals.push(body)
      if (!body.confirmUnpushedCommits) {
        await route.fulfill({
          status: 409,
          json: {
            error:
              'Refusing to remove a worktree with 2 unpushed commits; confirm deletion explicitly to continue',
          },
        })
      } else {
        worktrees = []
        await route.fulfill({ json: { removed: ['a1'] } })
      }
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === '/api/secrets/openai-api-key') {
      await route.fulfill({ json: { set: false } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await page.getByRole('button', { name: '設定' }).click()
  const panel = page.getByTestId('worktrees-panel')
  await expect(panel).toContainText('1 worktree(s) using 3.0 MB. 1 idle for more than 14 days.')
  await expect(panel).toContainText('Old experiment')
  await expect(panel).toContainText('2 unpushed commit(s)')

  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    void dialog.accept()
  })
  await panel.getByRole('button', { name: 'Remove' }).click()
  await expect(panel).toContainText('0 worktree(s)')
  expect(dialogs[0]).toContain('2 unpushed commits')
  expect(removals).toEqual([{ path: '/wt/a' }, { path: '/wt/a', confirmUnpushedCommits: true }])
})
