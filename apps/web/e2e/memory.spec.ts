import { expect, test } from '@playwright/test'

const config = {
  autonomy_mode: 'normal',
  roles: Object.fromEntries(
    ['assistant_brain', 'background', 'orchestrator', 'implementer', 'reviewer', 'judge'].map((role) => [
      role,
      { provider: 'openai-api', model: 'memory-test-model', effort: 'low' },
    ]),
  ),
}

test('memories used by a reply are shown and can be forgotten or corrected', async ({ page }) => {
  let memories = [
    { id: 'm1', content: 'Likes tabs' },
    { id: 'm2', content: 'Works in Taipei' },
  ]
  const calls: string[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/memories') {
      await route.fulfill({ json: { memories } })
    } else if (path.startsWith('/api/memories/')) {
      const id = decodeURIComponent(path.slice('/api/memories/'.length))
      calls.push(`${request.method()} ${id}`)
      if (request.method() === 'DELETE') {
        memories = memories.filter((m) => m.id !== id)
        await route.fulfill({ status: 204, body: '' })
      } else {
        const { content } = request.postDataJSON() as { content: string }
        memories = memories.map((m) => (m.id === id ? { ...m, content } : m))
        await route.fulfill({ json: { memory: { id, content } } })
      }
    } else if (path === '/api/conversations') {
      await route.fulfill({ json: { conversations: [{ id: 'c1', title: 'Hello' }] } })
    } else if (path === '/api/conversations/c1') {
      await route.fulfill({
        json: {
          conversation: { id: 'c1' },
          messages: [
            { id: 1, role: 'user', content: 'hi', memoryIds: [] },
            { id: 2, role: 'assistant', content: 'Hello again', memoryIds: ['m1', 'm2'] },
          ],
        },
      })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
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
  const used = page.getByLabel('Memories used')
  await expect(used).toContainText('Likes tabs')
  await expect(used).toContainText('Works in Taipei')

  await page.getByRole('button', { name: 'Forget: Likes tabs' }).click()
  await expect(used).toContainText('deleted memory')
  const panel = page.getByTestId('memory-panel')
  await expect(panel).not.toContainText('Likes tabs')

  await panel.getByRole('button', { name: 'Edit' }).click()
  await panel.getByLabel('Memory text').fill('Works in Tainan')
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(panel).toContainText('Works in Tainan')
  expect(calls).toEqual(['DELETE m1', 'PATCH m2'])
})
