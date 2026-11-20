import { expect, test } from '@playwright/test'

test('a long conversation shows where its earlier part became a summary', async ({ page }) => {
  await page.routeWebSocket(/\/ws/, () => {})
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/conversations/long') {
      await route.fulfill({
        json: {
          conversation: {
            id: 'long',
            title: 'Database choice',
            contextSummary: 'Owner chose SQLite for Joy.\nTask 42 is still open.',
            contextThrough: 4,
          },
          messages: [
            { id: 1, role: 'user', content: 'Postgres or SQLite?' },
            { id: 2, role: 'assistant', content: 'SQLite fits a local app.' },
            { id: 3, role: 'user', content: 'Then SQLite.' },
            { id: 4, role: 'assistant', content: 'Noted.' },
            { id: 5, role: 'user', content: 'Where were we?' },
            { id: 6, role: 'assistant', content: 'Task 42 is open.' },
          ],
        },
      })
    } else if (url.pathname === '/api/conversations') {
      await route.fulfill({ json: { conversations: [{ id: 'long', title: 'Database choice' }] } })
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

  await page.goto('/?chat=long')
  const divider = page.getByTestId('context-divider')
  await expect(divider).toHaveCount(1)
  // It sits right after the last message the summary covers.
  const order = await page
    .locator('.chat-column')
    .evaluate((column) =>
      Array.from(column.querySelectorAll('.context-divider, .chat-assistant, .msg-row-user')).map(
        (element) =>
          element.classList.contains('context-divider') ? 'divider' : (element.textContent?.trim() ?? ''),
      ),
    )
  const at = order.indexOf('divider')
  expect(order[at - 1]).toContain('Noted.')
  expect(order[at + 1]).toContain('Where were we?')

  const summary = page.getByText('Owner chose SQLite for Joy.')
  await expect(summary).toBeHidden()
  await divider.getByText('以上已整理成摘要').click()
  await expect(summary).toBeVisible()
  await expect(divider).toContainText('Task 42 is still open.')
})
