import { test, expect } from '@playwright/test'

test('memory management lists, edits, and confirms deletion', async ({ page, request }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Memories', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Memories', exact: true })).toBeVisible()
  await expect(page.getByText('The test memory can be updated safely.', { exact: true })).toBeVisible()
  await expect(page.getByText('Source: summary')).toBeVisible()
  await expect(page.getByText('Only active, non-sensitive memories are shown.')).toBeVisible()

  await page.getByRole('button', { name: 'Edit memory' }).click()
  await page.getByLabel('Memory text').fill('This memory was edited by the user.')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('This memory was edited by the user.', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/t3.4-memory-management.png', fullPage: true })
  const listed = (await (await request.get('/api/memories')).json()) as {
    memories: Array<{ id: string; content: string; source: string }>
  }
  expect(listed.memories).toContainEqual({
    id: 'memory-ui-fixture',
    scope: 'episode',
    content: 'This memory was edited by the user.',
    source: 'summary',
    confidence: 0.8,
    sensitive: false,
    createdAt: expect.any(String),
  })

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('This memory was edited by the user.')
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: 'Delete memory' }).click()
  await expect(page.getByText('This memory was edited by the user.', { exact: true })).toBeVisible()

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('This memory was edited by the user.')
    await dialog.accept()
  })
  await page.getByRole('button', { name: 'Delete memory' }).click()
  await expect(page.getByText('No saved memories to manage.')).toBeVisible()
  expect((await (await request.get('/api/memories')).json()).memories).toEqual([])
})
