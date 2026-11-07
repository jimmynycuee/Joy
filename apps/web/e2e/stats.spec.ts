import { expect, test } from '@playwright/test'

test('model stats can be filtered by period and repository', async ({ page }) => {
  const queries: string[] = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/stats') {
      queries.push(url.search)
      const filtered = url.searchParams.get('repoId') === 'joy'
      await route.fulfill({
        json: {
          stats: {
            implementers: [
              {
                provider: 'claude-cli',
                model: 'opus',
                mode: 'review_loop',
                attempts: filtered ? 2 : 5,
                finished: 4,
                passed: 3,
                passRate: 0.75,
                findingsAgainst: 7,
                avgDurationMs: 900_000,
                handoffs: 1,
              },
            ],
            reviewers: [{ provider: 'codex-cli', model: 'gpt-6', reviews: 6, approvals: 3, findings: 7 }],
          },
        },
      })
    } else if (url.pathname === '/api/repos') {
      await route.fulfill({ json: { repos: [{ id: 'joy', path: '/work/joy', defaultBranch: 'main' }] } })
    } else if (url.pathname === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await page.getByRole('button', { name: '統計' }).click()
  const implementers = page.getByLabel('實作者統計')
  await expect(implementers).toContainText('claude-cli · opus')
  await expect(implementers).toContainText('75% (3/4)')
  await expect(implementers).toContainText('15 分鐘')
  await expect(page.getByLabel('審查者統計')).toContainText('codex-cli · gpt-6')

  await page.getByLabel('從').fill('2026-11-01')
  await page.getByLabel('專案').selectOption('joy')
  await expect(implementers.locator('tbody tr td').nth(2)).toHaveText('2')
  expect(queries.at(-1)).toBe('?from=2026-11-01&repoId=joy')
})
