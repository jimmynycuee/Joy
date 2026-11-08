import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const repo = { id: 'composer-repo', path: '/tmp/composer-project', defaultBranch: 'main' }
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

interface CreatedTask {
  mode?: string
  planFirst?: boolean
  roleOverrides?: Record<string, { provider: string; model: string; effort?: string }>
}

async function mockApi(page: Page, created: CreatedTask[] = [], repoOverride: Record<string, unknown> = {}) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [{ ...repo, ...repoOverride }] } })
    } else if (path === '/api/tasks' && request.method() === 'POST') {
      created.push(request.postDataJSON() as CreatedTask)
      await route.fulfill({
        status: 201,
        json: {
          task: {
            id: 'created',
            repoId: repo.id,
            title: 't',
            prompt: 'p',
            mode: 'review_loop',
            status: 'queued',
            createdAt: new Date().toISOString(),
          },
        },
      })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path.startsWith('/api/tasks/')) {
      await route.fulfill({
        json: {
          task: {
            id: 'created',
            repoId: repo.id,
            title: 't',
            prompt: 'p',
            mode: 'review_loop',
            status: 'queued',
            createdAt: new Date().toISOString(),
          },
          repo,
          attempts: [],
          reviews: [],
          events: [],
        },
      })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

const form = (page: Page) => page.locator('form.composer-home')
const modelButton = (page: Page) => form(page).getByRole('button', { name: /^模型/ })
const modelMenu = (page: Page) => page.getByRole('menu', { name: '模型' })
const quickApply = (page: Page) => modelMenu(page).getByRole('group', { name: '快速套用' })
const implementerModels = (page: Page) => modelMenu(page).getByRole('group', { name: '實作模型' })

async function send(page: Page, text = 'fix the bug') {
  await form(page).getByLabel('任務內容').fill(text)
  await form(page).getByLabel('任務內容').press('Enter')
}

test('the toolbar shows the model Settings would use, marked 預設', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await expect(modelButton(page)).toContainText('Opus 5.5 · 中')
  await expect(modelButton(page)).toContainText('（預設）')
  await expect(form(page).getByRole('button', { name: /^專案/ })).toContainText('composer-project · main')
  await expect(form(page).getByRole('button', { name: /^做法/ })).toContainText('實作＋審查')
  // Plain buttons, no form controls left in the toolbar.
  await expect(form(page).locator('.composer-bar select')).toHaveCount(0)
})

test('the model menu works from the keyboard: arrows, Enter, digits, Esc, focus back on the trigger', async ({
  page,
}) => {
  const created: CreatedTask[] = []
  await mockApi(page, created)
  await page.goto('/')

  const trigger = modelButton(page)
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(modelMenu(page)).toBeVisible()
  // Focus starts on the checked row.
  await expect(page.getByRole('menuitemradio', { name: /Opus 5\.5/ })).toBeFocused()
  await expect(page.getByRole('menuitemradio', { name: /Opus 5\.5/ })).toHaveAttribute('aria-checked', 'true')

  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: /Sonnet 5\.5/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(modelMenu(page)).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(trigger).toContainText('Sonnet 5.5 · 中')
  await expect(trigger).not.toContainText('（預設）')

  // A digit picks the row that shows it.
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: /Sonnet 5\.5/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.keyboard.press('5')
  await expect(modelMenu(page)).toHaveCount(0)
  await expect(trigger).toContainText('GPT-6 Luna · 中')

  // Esc closes without changing anything and gives focus back.
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(modelMenu(page)).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(trigger).toContainText('GPT-6 Luna · 中')

  // Home and End jump to the ends of the menu.
  await trigger.click()
  await page.keyboard.press('End')
  await expect(quickApply(page).getByRole('menuitemradio', { name: /最強/ })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(page.getByRole('menuitemradio', { name: /Opus 5\.5/ })).toBeFocused()
  await page.keyboard.press('Escape')

  await send(page)
  await expect.poll(() => created.length).toBe(1)
  // Only the role that was picked; the reviewer and the other four roles follow Settings.
  expect(created[0]?.roleOverrides).toEqual({
    implementer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'medium' },
  })
})

test('the menu has the right ARIA roles and a clicked outside closes it without taking focus', async ({
  page,
}) => {
  await mockApi(page)
  await page.goto('/')
  await modelButton(page).click()
  await expect(modelButton(page)).toHaveAttribute('aria-haspopup', 'menu')
  await expect(modelButton(page)).toHaveAttribute('aria-expanded', 'true')
  const menu = modelMenu(page)
  await expect(menu.getByRole('group', { name: '實作模型' }).getByRole('menuitemradio')).toHaveCount(5)
  await expect(menu.getByRole('group', { name: '快速套用' }).getByRole('menuitemradio')).toHaveCount(4)
  await expect(menu.getByRole('menuitem', { name: /投入程度/ })).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(menu.getByRole('menuitem', { name: /審查模型/ })).toHaveAttribute('aria-haspopup', 'menu')
  await page.getByRole('heading', { name: '要讓 Joy 做什麼？' }).click()
  await expect(menu).toHaveCount(0)
  await expect(modelButton(page)).toHaveAttribute('aria-expanded', 'false')
})

test('the effort popover: slider by keys, digits and pointer, greyed-out steps, reset and the model link', async ({
  page,
}) => {
  const created: CreatedTask[] = []
  await mockApi(page, created)
  await page.goto('/')
  await modelButton(page).click()
  await page.getByRole('menuitem', { name: /投入程度/ }).focus()
  await page.keyboard.press('ArrowRight')

  const dialog = page.getByRole('dialog', { name: '投入程度' })
  const slider = dialog.getByRole('slider', { name: '投入程度' })
  await expect(dialog).toBeVisible()
  await expect(slider).toBeFocused()
  await expect(dialog.locator('.effort-title')).toHaveText('中')
  await expect(dialog.getByRole('button', { name: /Opus 5\.5/ })).toBeVisible()

  await page.keyboard.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuetext', '高')
  await expect(dialog.locator('.effort-title')).toHaveText('高')
  await page.keyboard.press('End')
  await expect(slider).toHaveAttribute('aria-valuetext', '最高')
  await page.keyboard.press('Home')
  await expect(slider).toHaveAttribute('aria-valuetext', '低')
  await page.keyboard.press('4')
  await expect(slider).toHaveAttribute('aria-valuetext', '很高')

  // A click on a step picks it.
  const high = await dialog.locator('.effort-step[data-effort="high"]').boundingBox()
  if (!high) throw new Error('no step')
  await page.mouse.click(high.x + high.width / 2, high.y + 4)
  await expect(slider).toHaveAttribute('aria-valuetext', '高')
  // Dragging from one step to another follows the pointer.
  const low = await dialog.locator('.effort-step[data-effort="low"]').boundingBox()
  if (!low) throw new Error('no step')
  await page.mouse.move(high.x + high.width / 2, high.y + 4)
  await page.mouse.down()
  await page.mouse.move(low.x + low.width / 2, low.y + 4, { steps: 6 })
  await page.mouse.up()
  await expect(slider).toHaveAttribute('aria-valuetext', '低')

  // 重設 goes back to the default effort, and the toolbar follows.
  await dialog.getByRole('button', { name: '重設' }).click()
  await expect(slider).toHaveAttribute('aria-valuetext', '中')
  await page.keyboard.press('Escape')
  // Esc closes only the popover; focus is back on its row and the menu is still open.
  await expect(dialog).toHaveCount(0)
  await expect(modelMenu(page)).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /投入程度/ })).toBeFocused()

  // On a Codex model the top step is greyed out and cannot be reached.
  await page.keyboard.press('Escape')
  await modelButton(page).click()
  await page.keyboard.press('4')
  await expect(modelButton(page)).toContainText('GPT-6.1 Sol · 中')
  await modelButton(page).click()
  await page.getByRole('menuitem', { name: /投入程度/ }).click()
  await expect(dialog.locator('.effort-step[data-effort="max"]')).toHaveClass(/unsupported/)
  await expect(dialog.locator('.effort-step[data-effort="xhigh"]')).not.toHaveClass(/unsupported/)
  await slider.focus()
  await page.keyboard.press('End')
  await expect(slider).toHaveAttribute('aria-valuetext', '很高')
  await page.keyboard.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuetext', '很高')
  const max = await dialog.locator('.effort-step[data-effort="max"]').boundingBox()
  if (!max) throw new Error('no step')
  await page.mouse.click(max.x + max.width / 2, max.y + 4)
  await expect(slider).toHaveAttribute('aria-valuetext', '很高')

  // The model name goes back to the model list, with focus on the checked model.
  await dialog.getByRole('button', { name: /GPT-6\.1 Sol/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('menuitemradio', { name: /GPT-6\.1 Sol/ }).first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(modelButton(page)).toContainText('GPT-6.1 Sol · 很高')

  await send(page)
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]?.roleOverrides).toEqual({
    implementer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'xhigh' },
  })
})

test('the review model has its own list and changes only the reviewer', async ({ page }) => {
  const created: CreatedTask[] = []
  await mockApi(page, created)
  await page.goto('/')
  await modelButton(page).click()
  const reviewerRow = page.getByRole('menuitem', { name: /審查模型/ })
  await expect(reviewerRow).toContainText('GPT-6.1 Sol')
  await reviewerRow.click()
  const list = page.getByRole('menu', { name: '審查模型' })
  await expect(list).toBeVisible()
  await expect(list.getByRole('menuitemradio', { name: /GPT-6\.1 Sol/ }).first()).toHaveAttribute(
    'aria-checked',
    'true',
  )
  // ArrowLeft closes only the sub-menu.
  await page.keyboard.press('ArrowLeft')
  await expect(list).toHaveCount(0)
  await expect(modelMenu(page)).toBeVisible()
  await expect(reviewerRow).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(list).toBeVisible()
  // The digit shown on a row picks it.
  await page.keyboard.press('3')
  await expect(modelMenu(page)).toHaveCount(0)
  await expect(modelButton(page)).toContainText('Opus 5.5 · 中')
  await send(page)
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]?.roleOverrides).toEqual({
    reviewer: { provider: 'claude-cli', model: 'haiku', effort: 'medium' },
  })
})

test('quick apply sets implementer and reviewer, and each row spells out the combination', async ({
  page,
}) => {
  const created: CreatedTask[] = []
  await mockApi(page, created)
  await page.goto('/')
  await modelButton(page).click()
  const quick = quickApply(page)
  await expect(quick.getByRole('menuitemradio', { name: /照設定/ })).toContainText('Opus 中 實作 · Sol 審查')
  await expect(quick.getByRole('menuitemradio', { name: /平衡/ })).toContainText('Opus 中 實作 · Sol 審查')
  await expect(quick.getByRole('menuitemradio', { name: /省額度/ })).toContainText(
    'Haiku 低 實作 · Luna 審查',
  )
  await expect(quick.getByRole('menuitemradio', { name: /最強/ })).toContainText('Opus 高 實作 · Sol 審查')
  await quick.getByRole('menuitemradio', { name: /省額度/ }).click()
  await expect(modelButton(page)).toContainText('Haiku 5.5 · 低')
  await send(page)
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]?.roleOverrides).toEqual({
    implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
    reviewer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
  })
})

test('a repository that does not allow Codex turns those models off and says why', async ({ page }) => {
  const created: CreatedTask[] = []
  await mockApi(page, created, { allowedProviders: ['claude-cli'] })
  await page.goto('/')
  await modelButton(page).click()
  const sol = implementerModels(page).getByRole('menuitemradio', { name: /GPT-6\.1 Sol/ })
  await expect(sol).toHaveAttribute('aria-disabled', 'true')
  await expect(sol).toContainText('專案不允許 Codex')
  await expect(sol).toHaveAttribute('title', /不允許 Codex/)
  // The digit does nothing on a row that is off.
  await page.keyboard.press('4')
  await expect(modelMenu(page)).toBeVisible()
  await expect(modelButton(page)).toContainText('Opus 5.5 · 中')
  // Quick apply combinations that use Codex are off too.
  await expect(quickApply(page).getByRole('menuitemradio', { name: /省額度/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(quickApply(page).getByRole('menuitemradio', { name: /平衡/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(
    implementerModels(page).getByRole('menuitemradio', { name: /Sonnet 5\.5/ }),
  ).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
})

test('single mode has no review model, and a review pick is not sent for it', async ({ page }) => {
  const created: CreatedTask[] = []
  await mockApi(page, created)
  await page.goto('/')
  await modelButton(page).click()
  await page.getByRole('menuitem', { name: /審查模型/ }).click()
  await page.keyboard.press('3')
  await form(page).getByRole('button', { name: /^做法/ }).click()
  await page.getByRole('menuitemradio', { name: /單人/ }).click()
  await modelButton(page).click()
  const reviewerRow = page.getByRole('menuitem', { name: /審查模型/ })
  await expect(reviewerRow).toHaveAttribute('aria-disabled', 'true')
  await expect(reviewerRow).toContainText('單人模式沒有審查者')
  await page.keyboard.press('Escape')
  await send(page)
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]?.mode).toBe('single')
  expect(created[0]?.roleOverrides).toBeUndefined()
})

test('the last choice is remembered, and 照設定 clears it', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await modelButton(page).click()
  await implementerModels(page)
    .getByRole('menuitemradio', { name: /Sonnet 5\.5/ })
    .click()
  await form(page).getByRole('button', { name: /^做法/ }).click()
  await page.getByRole('menuitemcheckbox', { name: /先規劃/ }).click()
  await page.keyboard.press('Escape')

  await page.reload()
  await expect(modelButton(page)).toContainText('Sonnet 5.5 · 中')
  await expect(form(page).getByRole('button', { name: /^做法/ })).toContainText('先規劃')

  await modelButton(page).click()
  await quickApply(page)
    .getByRole('menuitemradio', { name: /照設定/ })
    .click()
  await expect(modelButton(page)).toContainText('Opus 5.5 · 中')
  await expect(modelButton(page)).toContainText('（預設）')
  await page.reload()
  await expect(modelButton(page)).toContainText('（預設）')
})

test('a broken remembered choice just means the defaults', async ({ page }) => {
  await mockApi(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('joy.composer.v1', '{"models":{"implementer":{"provider":"x"}},"mode":')
  })
  await page.goto('/')
  await expect(modelButton(page)).toContainText('Opus 5.5 · 中')
})

test('a model set by hand in Settings still shows its name, and its efforts are explained', async ({
  page,
}) => {
  await mockApi(page)
  await page.route('**/api/config', async (route) => {
    await route.fulfill({
      json: {
        config: {
          ...config,
          roles: { ...config.roles, implementer: { provider: 'claude-cli', model: 'my-own-model' } },
        },
      },
    })
  })
  await page.goto('/')
  await expect(modelButton(page)).toContainText('my-own-model')
  await modelButton(page).click()
  await expect(implementerModels(page).getByRole('menuitemradio', { name: /my-own-model/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.getByRole('menuitem', { name: /投入程度/ }).click()
  await expect(page.getByRole('dialog', { name: '投入程度' })).toContainText('沒有已驗證的投入程度')
  await expect(page.getByRole('slider', { name: '投入程度' })).toHaveAttribute('aria-disabled', 'true')
})

test('on a phone the toolbar fits without sideways scrolling and the menus stay on screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 })
  await mockApi(page)
  await page.goto('/')
  await expect(modelButton(page)).toContainText('Opus 5.5')
  const fits = await page.evaluate(() => {
    const bar = document.querySelector('.composer-home .composer-bar')
    return {
      page: document.documentElement.scrollWidth <= window.innerWidth,
      bar: bar ? bar.scrollWidth <= bar.clientWidth : false,
    }
  })
  expect(fits).toEqual({ page: true, bar: true })

  await modelButton(page).click()
  const box = await modelMenu(page).boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(700)
  await page.getByRole('menuitem', { name: /投入程度/ }).click()
  const dialog = await page.getByRole('dialog', { name: '投入程度' }).boundingBox()
  expect(dialog).not.toBeNull()
  if (!dialog) return
  expect(dialog.x).toBeGreaterThanOrEqual(0)
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(375)
})
