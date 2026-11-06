import { expect, test } from '@playwright/test'

test('a repository can be added in container mode', async ({ page }) => {
  const created: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/repos' && request.method() === 'POST') {
      created.push(request.postDataJSON())
      await route.fulfill({
        status: 201,
        json: { repo: { id: 'r', path: '/work/untrusted', defaultBranch: 'main' } },
      })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Add repository' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add repository' })
  await dialog.getByLabel('Repository path').fill('/work/untrusted')
  await dialog.getByLabel('Run agents in a container').check()
  await dialog.getByRole('button', { name: 'Add repository' }).click()
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toEqual({ path: '/work/untrusted', defaultBranch: 'main', container: true })
})
