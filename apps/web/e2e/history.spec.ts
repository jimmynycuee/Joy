import { expect, test } from '@playwright/test'

test('past conversations can be searched and opened', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/history') {
      expect(url.searchParams.get('q')).toBe('postgres')
      await route.fulfill({
        json: {
          results: [
            {
              conversationId: 'old',
              title: 'Database choice',
              kind: 'summary',
              snippet: 'Chose SQLite over [Postgres].',
              ts: '2026-10-06T09:00:00.000Z',
            },
          ],
        },
      })
    } else if (url.pathname === '/api/conversations') {
      await route.fulfill({
        json: {
          conversations: [
            { id: 'new', title: 'Today' },
            { id: 'old', title: 'Database choice' },
          ],
        },
      })
    } else if (url.pathname === '/api/conversations/old') {
      await route.fulfill({
        json: {
          conversation: { id: 'old' },
          messages: [{ id: 1, role: 'user', content: 'Use SQLite, not Postgres' }],
        },
      })
    } else if (url.pathname === '/api/conversations/new') {
      await route.fulfill({ json: { conversation: { id: 'new' }, messages: [] } })
    } else if (url.pathname === '/api/memories' || url.pathname === '/api/project-notes') {
      await route.fulfill({ json: { memories: [], notes: [] } })
    } else if (url.pathname === '/api/repos') {
      await route.fulfill({ json: { repos: [] } })
    } else if (url.pathname === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await page.getByRole('button', { name: '聊聊' }).click()
  const box = page.getByLabel('搜尋以前的對話')
  await box.fill('postgres')
  await box.press('Enter')
  const results = page.getByLabel('搜尋結果')
  await expect(results).toContainText('2026-10-06 · Database choice · 摘要')
  await results.getByRole('button').click()
  await expect(page.getByText('Use SQLite, not Postgres')).toBeVisible()
})
