import { expect, test } from '@playwright/test'

test('pending reminders and schedules are listed and can be cancelled', async ({ page }) => {
  let reminders = [{ id: 'r1', text: 'Call the bank', dueAt: '2026-11-07T01:00:00.000Z' }]
  const schedules = [
    {
      id: 's1',
      cron: '0 9 * * 1-5',
      action: 'reminder',
      payload: { text: 'Stand-up' },
      nextRunAt: '2026-11-09T01:00:00.000Z',
    },
  ]
  const deleted: string[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/schedules') {
      await route.fulfill({ json: { reminders, schedules } })
    } else if (path.startsWith('/api/schedules/') && request.method() === 'DELETE') {
      deleted.push(path)
      reminders = []
      await route.fulfill({ status: 204, body: '' })
    } else if (path === '/api/conversations') {
      await route.fulfill({ json: { conversations: [] } })
    } else if (path === '/api/memories' || path === '/api/project-notes') {
      await route.fulfill({ json: { memories: [], notes: [] } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Assistant' }).click()
  const panel = page.getByTestId('scheduled-panel')
  await expect(panel).toContainText('Call the bank')
  await expect(panel).toContainText('Stand-up')
  await expect(panel).toContainText('0 9 * * 1-5')
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel).not.toContainText('Call the bank')
  expect(deleted).toEqual(['/api/schedules/r1'])
})
