import { expect, test } from '@playwright/test'

test('outside actions the assistant asked for wait on the assistant page until approved or denied', async ({
  page,
}) => {
  let actions = [
    { id: 'a1', summary: 'google: send_gmail_message {"to":"team@example.com"}', provenance: 'user' },
    { id: 'a2', summary: 'google: create_event {"summary":"From the mail"}', provenance: 'external_content' },
  ]
  const decisions: string[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/assistant/actions') {
      await route.fulfill({ json: { actions } })
    } else if (path.startsWith('/api/assistant/actions/')) {
      decisions.push(path)
      const id = path.split('/')[4]
      actions = actions.filter((a) => a.id !== id)
      await route.fulfill({ json: { status: 'done' } })
    } else if (path === '/api/conversations') {
      await route.fulfill({ json: { conversations: [] } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await page.getByRole('button', { name: '聊聊' }).click()
  const panel = page.getByTestId('assistant-actions')
  await expect(panel).toContainText('send_gmail_message')
  await expect(panel).toContainText('這是讀了郵件或行事曆內容之後提出的要求')
  await panel.getByRole('button', { name: '同意' }).first().click()
  await expect(panel).not.toContainText('send_gmail_message')
  await panel.getByRole('button', { name: '拒絕' }).click()
  await expect(panel).toHaveCount(0)
  expect(decisions).toEqual(['/api/assistant/actions/a1/approve', '/api/assistant/actions/a2/deny'])
})
