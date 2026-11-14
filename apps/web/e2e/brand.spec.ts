import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// The character and the project colours, against route mocks (no real agents).

const repos = [
  { id: 'r1', path: '/work/joy', defaultBranch: 'main' },
  { id: 'r2', path: '/work/website', defaultBranch: 'main', color: 'orange' },
  { id: 'r3', path: '/work/notes', defaultBranch: 'dev' },
]
const task = (id: string, repoId: string, title: string, status: string) => ({
  id,
  repoId,
  title,
  prompt: title,
  mode: 'review_loop',
  status,
  createdAt: new Date(Date.now() - 300_000).toISOString(),
})
const tasks = [
  task('t-run', 'r1', 'Running task', 'running'),
  task('t-wait', 'r1', 'Waiting task', 'awaiting_approval'),
  task('t-plan', 'r2', 'Review task', 'review_ready'),
  task('t-done', 'r2', 'Done task', 'done'),
  task('t-fail', 'r3', 'Failed task', 'failed'),
]

async function mock(page: Page, options: { empty?: boolean } = {}) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/repos') await route.fulfill({ json: { repos } })
    else if (path === '/api/tasks') await route.fulfill({ json: { tasks: options.empty ? [] : tasks } })
    else if (path === '/api/config')
      await route.fulfill({ json: { config: { autonomy_mode: 'normal', roles: {} } } })
    else if (path === '/api/conversations') await route.fulfill({ json: { conversations: [] } })
    else if (path.startsWith('/api/tasks/')) {
      const found = tasks.find((item) => item.id === path.split('/')[3])
      await route.fulfill({
        json: {
          task: found,
          repo: repos.find((repo) => repo.id === found?.repoId),
          attempts: [],
          reviews: [],
          events: [{ taskId: found?.id, seq: 1, type: 'started', payload: {}, ts: new Date().toISOString() }],
        },
      })
    } else await route.fulfill({ json: {} })
  })
}

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`
}

test('projects get a colour by order, a picked one wins, and the dots show in the sidebar and the new task menu', async ({
  page,
}) => {
  await mock(page)
  await page.goto('/')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  const dotOf = (title: string) => sidebar.locator('.task-row', { hasText: title }).locator('.project-dot')
  // joy is first (灰藍), website picked 灰橘, notes is third in order (灰紫).
  await expect(dotOf('Running task')).toHaveCSS('background-color', rgb('#7C93B5'))
  await expect(dotOf('Waiting task')).toHaveCSS('background-color', rgb('#7C93B5'))
  await expect(dotOf('Done task')).toHaveCSS('background-color', rgb('#C39A74'))
  await expect(dotOf('Failed task')).toHaveCSS('background-color', rgb('#9A8BB8'))

  await expect(page.getByRole('button', { name: '專案：joy · main' }).locator('.project-dot')).toHaveCSS(
    'background-color',
    rgb('#7C93B5'),
  )
})

test('the sidebar shows who is thinking, who waits for you, and which task is open', async ({ page }) => {
  await mock(page)
  await page.goto('/?task=t-wait')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  const row = (title: string) => sidebar.locator('.task-row', { hasText: title })

  // Running: the thinking character instead of a spinner; its ball circles.
  const thinking = row('Running task').locator('svg.mascot')
  await expect(thinking).toHaveAttribute('data-mood', 'thinking')
  await expect(sidebar.locator('.task-spinner')).toHaveCount(0)
  await expect(thinking.locator('.mascot-orbit')).toHaveCSS('animation-name', 'mascot-orbit')

  // Waiting for the owner: a teal dot on the right and the label under the title.
  await expect(row('Waiting task').locator('.task-flag')).toBeVisible()
  await expect(row('Waiting task')).toContainText('等你同意')
  await expect(row('Review task').locator('.task-flag')).toBeVisible()
  await expect(row('Failed task').locator('.task-flag-failed')).toBeVisible()
  await expect(row('Done task').locator('.task-flag')).toHaveCount(0)

  // The open task: a 2px teal line on the left, background stays grey (not teal).
  const open = sidebar.locator('.nav-row-wrap.selected')
  await expect(open).toHaveCount(1)
  await expect(open).toContainText('Waiting task')
  await expect(open).toHaveCSS('box-shadow', /rgb\(14, 156, 145\) 2px 0px 0px 0px inset/)
  const background = await open.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(background).not.toBe(rgb('#0E9C91'))
})

test('reduced motion stops the thinking character from circling', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await mock(page)
  await page.goto('/')
  const orbit = page.getByRole('navigation', { name: '主選單' }).locator('.mascot-orbit').first()
  await expect(orbit).toHaveCSS('animation-name', 'none')
  await context.close()
})

test('a task page shows the character for the state it is in', async ({ page }) => {
  await mock(page)
  await page.goto('/?task=t-run')
  await expect(page.locator('.running-indicator svg.mascot')).toHaveAttribute('data-mood', 'thinking')

  await page.goto('/?task=t-done')
  await expect(page.getByTestId('task-done').locator('svg.mascot')).toHaveAttribute('data-mood', 'happy')
  // The dot beside the title is the project's colour (website picked 灰橘).
  await expect(page.locator('.thread-title-line .project-dot')).toHaveCSS('background-color', rgb('#C39A74'))

  await page.goto('/?task=t-fail')
  await expect(page.getByLabel('任務失敗').locator('svg.mascot')).toHaveAttribute('data-mood', 'error')

  // The timeline shows no character for agent replies (they keep the model name instead).
  await expect(page.getByTestId('event-stream').locator('svg.mascot')).toHaveCount(0)
})

test('the new task page greets with the normal character, and the empty sidebar has none', async ({
  page,
}) => {
  await mock(page, { empty: true })
  await page.goto('/')
  const sidebar = page.getByRole('navigation', { name: '主選單' })
  // The sidebar says it in one faint line; the character is for the big empty page.
  await expect(sidebar.getByText('還沒有任何工作')).toBeVisible()
  await expect(sidebar.locator('.empty-list svg')).toHaveCount(0)
  await expect(page.locator('.home-mascot')).toHaveAttribute('data-mood', 'normal')
  await expect(page.locator('.home-mascot')).toHaveAttribute('width', '96')
})

test('the access token page shows the normal character', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: { error: 'no' } }))
  await page.goto('/')
  await expect(page.getByTestId('token-gate').locator('svg.mascot')).toHaveAttribute('data-mood', 'normal')
})

test('a server that cannot be reached shows the error character with the message', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort('connectionrefused'))
  await page.goto('/')
  const alert = page.getByRole('alert')
  await expect(alert).not.toBeEmpty()
  await expect(alert.locator('svg.mascot')).toHaveAttribute('data-mood', 'error')
})

test('the focus ring and the colours the interface asks for are teal in light and dark', async ({
  browser,
}) => {
  for (const [scheme, accent, accentText] of [
    ['light', '#0E9C91', '#07726A'],
    ['dark', '#2EE6D6', '#2EE6D6'],
  ] as const) {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    await mock(page)
    await page.goto('/')
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return ['--accent', '--accent-text', '--brand-yellow', '--brand-yellow-deep', '--brand-teal'].map(
        (name) => style.getPropertyValue(name).trim().toLowerCase(),
      )
    })
    expect(tokens).toEqual([accent.toLowerCase(), accentText.toLowerCase(), '#fce9a6', '#f5c94a', '#2ee6d6'])
    // The send button stays black with white text (inverted in dark).
    const send = page.getByRole('button', { name: '開始任務' })
    await expect(send).toHaveCSS(
      'background-color',
      scheme === 'light' ? 'rgb(31, 31, 30)' : 'rgb(236, 236, 234)',
    )
    await context.close()
  }
})
