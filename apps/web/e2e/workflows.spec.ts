import { expect, test } from '@playwright/test'

const repo = { id: 'repo-w', path: '/work/joy', defaultBranch: 'main' }

test('a custom workflow from config can be picked when creating a task', async ({ page }) => {
  const created: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/workflows') {
      await route.fulfill({
        json: {
          workflows: [
            { name: 'single', pattern: 'single', builtIn: true, problems: [] },
            { name: 'review_loop', pattern: 'review_loop', builtIn: true, problems: [] },
            { name: 'compete', pattern: 'compete', builtIn: true, problems: [] },
            { name: 'careful', pattern: 'review_loop', description: 'Plan first, five rounds', problems: [] },
            { name: 'broken', pattern: 'single', problems: ['uses the judge role'] },
          ],
        },
      })
    } else if (path === '/api/tasks' && request.method() === 'POST') {
      created.push(request.postDataJSON())
      await route.fulfill({
        status: 201,
        json: {
          task: {
            id: 't-w',
            repoId: repo.id,
            title: 'Careful fix',
            prompt: 'Fix add()',
            mode: 'review_loop',
            status: 'queued',
            createdAt: '2026-11-07T00:00:00.000Z',
          },
        },
      })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await page.getByRole('button', { name: '新任務' }).click()
  const dialog = page.locator('form.composer-home')
  const workflow = dialog.getByLabel('模式')
  await expect(workflow.locator('option')).toHaveText([
    '實作＋審查',
    '單人',
    '兩家比賽',
    'careful — Plan first, five rounds',
  ])
  await dialog.getByLabel('專案').selectOption(repo.id)
  await dialog.getByRole('button', { name: '進階' }).click()
  await dialog.getByLabel('任務標題').fill('Careful fix')
  await dialog.getByLabel('任務內容').fill('Fix add()')
  await workflow.selectOption('workflow:careful')
  await dialog.getByRole('button', { name: '開始任務' }).click()
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toEqual({
    repoId: repo.id,
    title: 'Careful fix',
    prompt: 'Fix add()',
    workflow: 'careful',
  })
})
