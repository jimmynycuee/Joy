import { test, expect } from '@playwright/test'

test('loads the workspace when keychain status is unavailable', async ({ page }) => {
  await page.route('**/api/secrets/openai-api-key', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Keychain is unavailable' }),
    })
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('button', { name: 'Save role settings' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Unavailable' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry key status' })).toBeVisible()
})
