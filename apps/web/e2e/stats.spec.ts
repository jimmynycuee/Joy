import { expect, test } from '@playwright/test'
import { openSettings } from './helpers.js'

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
          tasks: [
            {
              id: 't-new',
              title: 'Cheap fix',
              mode: 'single',
              status: 'done',
              createdAt: '2026-11-10T10:00:00.000Z',
              usage: {
                durationMs: 30_000,
                inputTokens: 900,
                outputTokens: 100,
                costUsd: 0.05,
                costSource: 'cli',
                byProvider: [{ provider: 'claude-cli', model: 'haiku', inputTokens: 900 }],
                byRole: [],
              },
            },
            {
              id: 't-big',
              title: 'Big refactor',
              mode: 'review_loop',
              status: 'done',
              createdAt: '2026-11-09T10:00:00.000Z',
              usage: {
                durationMs: 600_000,
                inputTokens: 480_000,
                outputTokens: 20_000,
                costUsd: 3.2,
                byProvider: [{ provider: 'claude-cli', model: 'opus' }],
                byRole: [],
              },
            },
            {
              id: 't-old',
              title: 'Before usage was recorded',
              mode: 'single',
              status: 'done',
              createdAt: '2026-10-01T10:00:00.000Z',
              usage: { durationMs: 10_000, byProvider: [], byRole: [] },
            },
          ],
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
  await openSettings(page, '統計')
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

test('tasks are compared by time, tokens and cost, and sorted by a column', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/stats') {
      await route.fulfill({
        json: {
          stats: { implementers: [], reviewers: [] },
          tasks: [
            {
              id: 't-new',
              title: 'Cheap fix',
              mode: 'single',
              status: 'done',
              createdAt: '2026-11-10T10:00:00.000Z',
              usage: {
                durationMs: 30_000,
                inputTokens: 900,
                outputTokens: 100,
                costUsd: 0.05,
                byProvider: [{ provider: 'claude-cli', model: 'haiku' }],
                byRole: [],
              },
            },
            {
              id: 't-big',
              title: 'Big refactor',
              mode: 'review_loop',
              status: 'done',
              createdAt: '2026-11-09T10:00:00.000Z',
              usage: {
                durationMs: 600_000,
                inputTokens: 480_000,
                outputTokens: 20_000,
                costUsd: 3.2,
                byProvider: [{ provider: 'claude-cli', model: 'opus' }],
                byRole: [],
              },
            },
            {
              id: 't-old',
              title: 'Before usage was recorded',
              mode: 'single',
              status: 'done',
              createdAt: '2026-10-01T10:00:00.000Z',
              usage: { durationMs: 10_000, byProvider: [], byRole: [] },
            },
          ],
        },
      })
    } else if (url.pathname === '/api/repos') {
      await route.fulfill({ json: { repos: [] } })
    } else if (url.pathname === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
  await page.goto('/')
  await openSettings(page, '統計')
  const table = page.getByLabel('各任務用量')
  const titles = () => table.locator('tbody tr td:first-child').allTextContents()
  expect(await titles()).toEqual(['Cheap fix', 'Big refactor', 'Before usage was recorded'])
  const big = table.locator('tbody tr').nth(1)
  await expect(big).toContainText('10 分')
  await expect(big).toContainText('500k')
  await expect(big).toContainText('$3.20')
  await expect(big).toContainText('opus')
  // A task from before usage was recorded has a dash, not a zero.
  await expect(table.locator('tbody tr').nth(2)).toContainText('—')

  await table.getByRole('button', { name: /^耗時/ }).click()
  expect(await titles()).toEqual(['Big refactor', 'Cheap fix', 'Before usage was recorded'])
  await table.getByRole('button', { name: /^花費/ }).click()
  expect(await titles()).toEqual(['Big refactor', 'Cheap fix', 'Before usage was recorded'])
  await table.getByRole('button', { name: /^花費/ }).click()
  expect(await titles()).toEqual(['Cheap fix', 'Big refactor', 'Before usage was recorded'])
})
