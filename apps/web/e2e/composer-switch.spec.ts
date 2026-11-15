import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

const repo = { id: 'switch-repo', path: '/tmp/switch-project', defaultBranch: 'main' }
const config = {
  autonomy_mode: 'normal',
  roles: {
    assistant_brain: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
    background: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
    orchestrator: { provider: 'claude-cli', model: 'opus', effort: 'high' },
    implementer: { provider: 'claude-cli', model: 'opus', effort: 'medium' },
    reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
    judge: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
  },
}
const baseTask = {
  id: 'switch-task',
  repoId: repo.id,
  title: 'Fix add()',
  prompt: 'Fix add()',
  mode: 'single',
  permissionMode: 'auto',
  status: 'done',
  roleOverrides: {},
  createdAt: new Date().toISOString(),
}

async function mockApi(
  page: Page,
  options: { task?: Record<string, unknown>; events?: unknown[]; sent?: Array<Record<string, unknown>> } = {},
) {
  const task = { ...baseTask, ...options.task }
  await page.routeWebSocket('**/ws**', () => undefined)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/repos') await route.fulfill({ json: { repos: [repo] } })
    else if (path === '/api/config') await route.fulfill({ json: { config } })
    else if (path === '/api/tasks') await route.fulfill({ json: { tasks: [task] } })
    else if (path === `/api/tasks/${task.id}/messages` && request.method() === 'POST') {
      options.sent?.push(request.postDataJSON() as Record<string, unknown>)
      await route.fulfill({ status: 202, json: { task, message: { id: 'm1', delivery: 'follow_up' } } })
    } else if (path === `/api/tasks/${task.id}`)
      await route.fulfill({
        json: { task, repo, attempts: [], reviews: [], events: options.events ?? [] },
      })
    else await route.fulfill({ json: {} })
  })
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('not visible')
  return rect
}

test.describe('composer height', () => {
  test('starts one line high, grows with the text without moving the bar early, then scrolls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    await mockApi(page)
    await page.goto('/')
    const textarea = page.locator('form.composer-home textarea')
    const send = page.locator('form.composer-home .send-btn')
    const lineHeight = await textarea.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight))
    const empty = await box(textarea)
    expect(empty.height).toBeLessThan(lineHeight * 1.6)

    // Typing on the first line does not move the buttons.
    const sendBefore = await box(send)
    await textarea.pressSequentially('one line')
    expect((await box(send)).y).toBe(sendBefore.y)

    await textarea.fill(['1', '2', '3', '4'].join('\n'))
    const four = await box(textarea)
    expect(four.height).toBeGreaterThan(lineHeight * 3.5)
    expect(await textarea.evaluate((el) => getComputedStyle(el).overflowY)).toBe('hidden')

    await textarea.fill(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))
    const full = await box(textarea)
    expect(full.height).toBeLessThanOrEqual(Math.min(lineHeight * 12 + 8, 900 * 0.4) + 1)
    expect(await textarea.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')

    // Emptied again: back to one line.
    await textarea.fill('')
    expect((await box(textarea)).height).toBeLessThan(lineHeight * 1.6)
  })

  test('the task page box is one line high too, and 40% of a short window at most', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 500 })
    await mockApi(page)
    await page.goto(`/?task=${baseTask.id}`)
    const textarea = page.getByLabel('傳訊息給任務')
    const lineHeight = await textarea.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight))
    expect((await box(textarea)).height).toBeLessThan(lineHeight * 1.6)
    await textarea.fill(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))
    expect((await box(textarea)).height).toBeLessThanOrEqual(200 + 1)
  })
})

test.describe('switching on the task page', () => {
  const composer = (page: Page) => page.getByTestId('thread-composer')

  test("shows the home page's menus at the task's settings and sends what changed with the message", async ({
    page,
  }) => {
    const sent: Array<Record<string, unknown>> = []
    await mockApi(page, { sent })
    await page.goto(`/?task=${baseTask.id}`)
    const approach = composer(page).getByRole('button', { name: /^做法/ })
    const model = composer(page).getByRole('button', { name: /^模型/ })
    const permission = composer(page).getByRole('button', { name: /^權限/ })
    await expect(approach).toHaveAttribute('aria-label', '做法：單人')
    await expect(model).toHaveAttribute('aria-label', '模型：Opus 5.5 · 中')
    await expect(permission).toHaveAttribute('aria-label', '權限：自動')

    await approach.click()
    const menu = page.getByRole('menu', { name: '做法' })
    await expect(menu.getByRole('menuitemradio', { name: /兩家比賽/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await expect(menu.getByText('先規劃')).toHaveCount(0)
    await menu.getByRole('menuitemradio', { name: /實作＋審查/ }).click()
    await expect(approach).toHaveAttribute('aria-label', '做法：實作＋審查')

    await model.click()
    await page
      .getByRole('menu', { name: '模型' })
      .getByRole('menuitemradio', { name: /Sonnet 5.5/ })
      .click()
    await expect(model).toHaveAttribute('aria-label', '模型：Sonnet 5.5 · 中')

    const textarea = page.getByLabel('傳訊息給任務')
    await textarea.fill('Use Sonnet and get it reviewed')
    await textarea.press('Enter')
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toEqual({
      text: 'Use Sonnet and get it reviewed',
      mode: 'review_loop',
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'sonnet', effort: 'medium' } },
    })
  })

  test('sends no settings when the menus were not touched', async ({ page }) => {
    const sent: Array<Record<string, unknown>> = []
    await mockApi(page, { sent })
    await page.goto(`/?task=${baseTask.id}`)
    const textarea = page.getByLabel('傳訊息給任務')
    await textarea.fill('just continue')
    await textarea.press('Enter')
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toEqual({ text: 'just continue' })
  })

  test('a task from external content cannot change its permission mode', async ({ page }) => {
    await mockApi(page, { task: { provenance: 'external_content', permissionMode: 'ask' } })
    await page.goto(`/?task=${baseTask.id}`)
    const permission = composer(page).getByRole('button', { name: /^權限/ })
    await expect(permission).toHaveAttribute('aria-label', '權限：要求核准')
    await expect(permission).toBeDisabled()
  })

  test('the thread shows the switch as one short line', async ({ page }) => {
    await mockApi(page, {
      task: { mode: 'review_loop' },
      events: [
        {
          taskId: baseTask.id,
          seq: 1,
          type: 'user.message',
          payload: { id: 'm1', text: 'switch', provenance: 'user', delivery: 'follow_up' },
          ts: new Date().toISOString(),
        },
        {
          taskId: baseTask.id,
          seq: 2,
          type: 'task.settings',
          payload: {
            implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' },
            mode: 'review_loop',
          },
          ts: new Date().toISOString(),
        },
      ],
    })
    await page.goto(`/?task=${baseTask.id}`)
    await expect(page.getByText('改用 Opus · 實作＋審查')).toBeVisible()
  })
})
