import { expect, test } from '@playwright/test'

test('a proposed AGENTS.md note is shown as a diff and written only when applied', async ({ page }) => {
  let notes = [
    {
      id: 'n1',
      note: 'Run pnpm check before committing',
      file: 'AGENTS.md',
      repoPath: '/work/joy',
      stale: false,
      diff: [
        { kind: 'same', text: '# Rules' },
        { kind: 'add', text: '## Notes from Joy' },
        { kind: 'add', text: '- Run pnpm check before committing' },
      ],
    },
  ]
  const decisions: Array<{ path: string; body: string | null }> = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/project-notes') {
      await route.fulfill({ json: { notes } })
    } else if (path.startsWith('/api/project-notes/')) {
      decisions.push({ path, body: request.postData() })
      notes = []
      await route.fulfill({ json: { note: { id: 'n1', status: 'applied' } } })
    } else if (path === '/api/conversations') {
      await route.fulfill({ json: { conversations: [] } })
    } else if (path === '/api/memories') {
      await route.fulfill({ json: { memories: [] } })
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
  const panel = page.getByTestId('project-notes')
  const diff = panel.getByLabel('差異：Run pnpm check before committing')
  await expect(diff).toContainText('+ - Run pnpm check before committing')
  await expect(diff).not.toContainText('# Rules')
  await panel.getByRole('button', { name: '寫進 AGENTS.md' }).click()
  await expect(panel).toHaveCount(0)
  // The owner's click is the approval; the request carries no approval flag.
  expect(decisions).toEqual([{ path: '/api/project-notes/n1/apply', body: '{}' }])
})
