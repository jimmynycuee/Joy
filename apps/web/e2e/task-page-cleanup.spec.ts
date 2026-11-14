import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openTaskMenu } from './helpers.js'

// The task page without clutter: a one-line title bar with a ⋯ menu, a finished task folded to what matters, no
// raw reviewer JSON, and no coloured blocks or glow. Route mocks only; no real agent runs.

const repo = { id: 'clean-repo', path: '/tmp/clean-project', defaultBranch: 'main' }
const config = { autonomy_mode: 'normal', roles: {} }
const LONG_PROMPT =
  'Pressing Enter on the login page does nothing at all, please look into it and fix it carefully and add a test'

interface Mock {
  task: Record<string, unknown> & { id: string; status: string }
  attempts?: unknown[]
  events: unknown[]
  usage?: unknown
  pendingPlan?: unknown
}

let seq = 0
const stamp = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()
const event = (taskId: string, type: string, payload: unknown, secondsAgo = 60) => ({
  taskId,
  seq: ++seq,
  type,
  payload,
  ts: stamp(secondsAgo),
})
const agent = (taskId: string, role: string, inner: unknown, secondsAgo = 60) =>
  event(taskId, 'agent', { role, event: inner }, secondsAgo)

function taskOf(status: string, id: string, title = 'Fix the login page', extra: object = {}) {
  return {
    id,
    repoId: repo.id,
    title,
    prompt: LONG_PROMPT,
    mode: 'review_loop',
    status,
    createdAt: new Date(Date.now() - 300_000).toISOString(),
    ...extra,
  }
}

async function mockApi(
  page: Page,
  mock: Mock,
  calls: Array<{ method: string; path: string; body: unknown }>,
) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') {
      calls.push({ method: request.method(), path, body: request.postDataJSON() as unknown })
      if (request.method() === 'PATCH' && path === `/api/tasks/${mock.task.id}`) {
        const patch = request.postDataJSON() as Record<string, unknown>
        mock.task = { ...mock.task, ...patch }
        await route.fulfill({ json: { task: mock.task } })
      } else {
        await route.fulfill({ status: 202, json: { task: mock.task } })
      }
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [mock.task] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === `/api/tasks/${mock.task.id}`) {
      await route.fulfill({
        json: {
          task: mock.task,
          repo,
          attempts: mock.attempts ?? [],
          reviews: [],
          events: mock.events,
          ...(mock.usage ? { usage: mock.usage } : {}),
          ...(mock.pendingPlan ? { pendingPlan: mock.pendingPlan } : {}),
        },
      })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

/** A finished review loop: implement, fail one review, fix, pass the second. */
function finishedEvents(id: string, extra: unknown[] = []) {
  return [
    event(id, 'started', {}, 200),
    event(id, 'phase', { phase: 'implementing', round: 1, role: 'implementer' }, 190),
    agent(id, 'implementer', { type: 'thinking', text: 'Let me look at the handler' }, 188),
    agent(id, 'implementer', { type: 'message', text: 'I will start with the handler.' }, 185),
    agent(
      id,
      'implementer',
      { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'pnpm test' } },
      180,
    ),
    agent(id, 'implementer', { type: 'tool_result', id: 'c1', output: '   ', isError: false }, 179),
    event(id, 'policy.action', { kind: 'read_file', tier: 'auto' }, 178),
    event(id, 'phase', { phase: 'reviewing', round: 1, role: 'reviewer' }, 150),
    agent(id, 'reviewer', { type: 'message', text: '{"approve":false,' }, 140),
    agent(id, 'reviewer', { type: 'message', text: '"summary":"Needs a test","findings":[]}' }, 139),
    event(
      id,
      'review',
      {
        round: 1,
        target: 'change',
        verdict: {
          approve: false,
          summary: 'Needs a test',
          findings: [{ severity: 'major', message: 'No test' }],
        },
      },
      138,
    ),
    event(id, 'phase', { phase: 'fixing', round: 2, role: 'implementer' }, 130),
    agent(
      id,
      'implementer',
      { type: 'tool_call', id: 'c2', name: 'Edit', input: { file_path: '/wt/a/src/login.ts' } },
      120,
    ),
    agent(id, 'implementer', { type: 'message', text: 'Fixed the handler and added a test.' }, 100),
    event(id, 'phase', { phase: 'reviewing', round: 2, role: 'reviewer' }, 90),
    agent(id, 'reviewer', { type: 'message', text: '{"approve":true,"summary":"Good","findings":[]}' }, 80),
    event(
      id,
      'review',
      { round: 2, target: 'change', verdict: { approve: true, summary: 'Good work', findings: [] } },
      79,
    ),
    ...extra,
  ]
}

test('the title bar keeps a status dot, a one-line title, 變更 and a ⋯ menu, with the long branch inside the menu', async ({
  page,
}) => {
  const task = taskOf('done', 'bar-task', LONG_PROMPT)
  const branch = 'joy/3f2c9a54-1111-4222-8333-944455556666/7a8b9c0d-aaaa-4bbb-8ccc-ddddeeeeffff'
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  await mockApi(
    page,
    {
      task,
      attempts: [{ id: 'a1', branch, worktreePath: '/wt/bar-task' }],
      events: finishedEvents(task.id),
      usage: { durationMs: 192_000, byProvider: [] },
    },
    calls,
  )
  await page.goto(`/?task=${task.id}`)

  const header = page.locator('.thread-header')
  const heading = header.getByRole('heading')
  // A whole pasted prompt as the title shows as one line of about 48 half-width characters and an ellipsis.
  await expect(heading).toHaveText(`${LONG_PROMPT.slice(0, 48).trimEnd()}…`)
  await expect(heading).toHaveAttribute('title', LONG_PROMPT)
  const oneLine = await heading.evaluate((element) => {
    const style = getComputedStyle(element)
    return [style.whiteSpace, style.textOverflow, element.getBoundingClientRect().height < 40]
  })
  expect(oneLine).toEqual(['nowrap', 'ellipsis', true])

  // No status pill, no branch, no worktree chip, no usage or checkpoint buttons in the bar.
  await expect(header.locator('.status-pill')).toHaveCount(0)
  await expect(header).not.toContainText('joy/')
  await expect(header).not.toContainText('工作副本')
  await expect(header.getByRole('button', { name: /^用量/ })).toHaveCount(0)
  await expect(header.getByRole('button')).toHaveCount(2)
  await expect(header.getByTestId('task-status')).toHaveAttribute('aria-label', '完成')

  await openTaskMenu(page)
  const menu = page.getByRole('menu', { name: '任務選項' })
  await expect(menu.getByRole('menuitem', { name: /複製分支名稱/ })).toContainText(branch)
  await expect(menu.getByRole('menuitem', { name: /複製工作副本路徑/ })).toContainText('/wt/bar-task')
  await expect(menu.getByRole('menuitem', { name: /^用量/ })).toContainText('3 分 12 秒')
  await expect(menu.getByRole('menuitem', { name: '改名' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '封存' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('a short title is shown whole; renaming works from the menu and by double-click', async ({ page }) => {
  const task = taskOf('done', 'rename-task', 'Fix the login page')
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  await mockApi(page, { task, events: finishedEvents(task.id) }, calls)
  await page.goto(`/?task=${task.id}`)

  const header = page.locator('.thread-header')
  await expect(header.getByRole('heading')).toHaveText('Fix the login page')
  await expect(header.getByRole('heading')).not.toHaveAttribute('title', /.+/)
  await expect(header.getByRole('button', { name: '重新命名' })).toHaveCount(0)

  await openTaskMenu(page, '改名')
  const box = header.getByRole('textbox', { name: '任務標題' })
  await expect(box).toBeFocused()
  await box.fill('Fix login')
  await box.press('Enter')
  await expect
    .poll(() => calls.filter((call) => call.method === 'PATCH').map((call) => call.body))
    .toEqual([{ title: 'Fix login' }])
  await expect(header.getByRole('heading')).toHaveText('Fix login')

  await header.getByRole('heading').dblclick()
  await expect(header.getByRole('textbox', { name: '任務標題' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(header.getByRole('heading')).toHaveText('Fix login')
})

test('the menu copies the branch, opens 用量 and 檢查點, and archives the task', async ({ page }) => {
  const task = taskOf('done', 'menu-task')
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await mockApi(
    page,
    {
      task,
      attempts: [{ id: 'a1', branch: 'joy/fix-login', worktreePath: '/wt/menu-task' }],
      events: [
        ...finishedEvents(task.id),
        event(task.id, 'checkpoint.created', { n: 1, label: 'implementer turn' }),
      ],
      usage: {
        durationMs: 192_000,
        inputTokens: 48_000,
        outputTokens: 3_400,
        costUsd: 0.43,
        byProvider: [{ provider: 'claude-cli', model: 'opus', costUsd: 0.4 }],
      },
    },
    calls,
  )
  await page.goto(`/?task=${task.id}`)

  await openTaskMenu(page, /複製分支名稱/)
  await expect(page.getByRole('menuitem', { name: '已複製' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('joy/fix-login')

  await page.getByRole('menuitem', { name: /^用量/ }).click()
  const usage = page.getByRole('dialog', { name: '用量' })
  await expect(usage).toContainText('3 分 12 秒')
  await expect(usage).toContainText('Claude Code · opus')
  await page.keyboard.press('Escape')
  await expect(usage).toHaveCount(0)

  await page.getByRole('menuitem', { name: /^檢查點/ }).click()
  await expect(page.getByRole('dialog', { name: '檢查點' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('menuitem', { name: '封存' }).click()
  await expect
    .poll(() => calls.filter((call) => call.method === 'PATCH').map((call) => call.body))
    .toEqual([{ archived: true }])
})

test('a running task cannot be archived from the menu and keeps its whole timeline open', async ({
  page,
}) => {
  const task = taskOf('running', 'live-task')
  await mockApi(page, { task, events: finishedEvents(task.id).slice(0, 8) }, [])
  await page.goto(`/?task=${task.id}`)
  await openTaskMenu(page)
  await expect(page.getByRole('menuitem', { name: /封存/ })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('process-fold')).toHaveCount(0)
  await expect(page.getByTestId('event-stream')).toContainText('$ pnpm test')
  await expect(page.getByTestId('task-status')).toHaveAttribute('aria-label', '進行中')
})

test('a finished task folds its process; the summary, the last review and the next steps stay', async ({
  page,
}) => {
  const task = taskOf('done', 'done-task')
  const diff = {
    files: [{ path: 'src/login.ts', status: 'modified', additions: 3, deletions: 1 }],
    patch: '',
  }
  await mockApi(
    page,
    {
      task,
      events: finishedEvents(task.id, [
        event(task.id, 'result', { status: 'succeeded', approved: true, diff }, 70),
      ]),
    },
    [],
  )
  await page.goto(`/?task=${task.id}`)

  const stream = page.getByTestId('event-stream')
  const fold = page.getByTestId('process-fold')
  const toggle = fold.locator('.process-toggle')
  await expect(toggle).toHaveText(/^過程（2 輪審查 · \d+ 個步驟 · .+）$/)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // What the owner reads: the agent's last words and the last review.
  await expect(stream).toContainText('Fixed the handler and added a test.')
  await expect(page.getByLabel('審查結果')).toHaveCount(1)
  await expect(page.getByLabel('審查結果')).toContainText('通過')
  await expect(page.getByLabel('審查結果')).toContainText('Good work')
  // Not what happened on the way.
  await expect(stream).not.toContainText('I will start with the handler.')
  await expect(stream).not.toContainText('$ pnpm test')
  await expect(stream).not.toContainText('要求修改')
  await expect(page.getByRole('button', { name: /顯示細節/ })).toHaveCount(0)

  // The change summary and the next steps are outside the fold.
  await expect(page.getByRole('button', { name: /1 個檔案/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '丟掉這些變更' })).toBeVisible()

  // Opening it shows the process as it was, details toggle included; closing it hides it again.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(stream).toContainText('I will start with the handler.')
  await expect(stream).toContainText('$ pnpm test')
  await expect(stream).toContainText('要求修改')
  await expect(page.getByLabel('審查結果')).toHaveCount(2)
  await fold.getByRole('button', { name: /^顯示細節/ }).click()
  await expect(stream).toContainText('權限：讀取檔案')
  await toggle.click()
  await expect(stream).not.toContainText('$ pnpm test')
})

test('a failed task folds too, but keeps its error and last three steps in view', async ({ page }) => {
  const task = taskOf('failed', 'fail-task')
  const events = [
    event(task.id, 'started', {}, 100),
    agent(task.id, 'implementer', { type: 'message', text: 'Starting out.' }, 95),
    ...['one', 'two', 'three', 'four', 'five'].flatMap((word, index) => [
      agent(
        task.id,
        'implementer',
        { type: 'tool_call', id: `t${index}`, name: 'Bash', input: { command: `echo ${word}` } },
        90 - index,
      ),
    ]),
    event(task.id, 'error', { message: 'The reviewer crashed' }, 50),
  ]
  await mockApi(page, { task, events }, [])
  await page.goto(`/?task=${task.id}`)

  const stream = page.getByTestId('event-stream')
  await expect(page.locator('.process-toggle')).toContainText('過程')
  await expect(stream.getByText('$ echo five')).toBeVisible()
  await expect(stream.getByText('$ echo four')).toBeVisible()
  await expect(stream.getByText('$ echo three')).toBeVisible()
  await expect(stream.getByText('$ echo two')).toHaveCount(0)
  await expect(stream.getByText('The reviewer crashed')).toBeVisible()
  await expect(page.getByLabel('任務失敗')).toContainText('The reviewer crashed')
  await page.locator('.process-toggle').click()
  await expect(stream.getByText('$ echo two')).toBeVisible()
  await expect(stream.getByText('$ echo one')).toBeVisible()
})

test('a plan waiting for a decision keeps its timeline open', async ({ page }) => {
  const task = taskOf('review_ready', 'plan-task')
  await mockApi(
    page,
    {
      task,
      events: [
        event(task.id, 'started', {}),
        agent(task.id, 'implementer', {
          type: 'tool_call',
          id: 'c1',
          name: 'Bash',
          input: { command: 'ls' },
        }),
        event(task.id, 'plan.awaiting_approval', { plan: 'Change login.ts' }),
      ],
      pendingPlan: { plan: 'Change login.ts' },
    },
    [],
  )
  await page.goto(`/?task=${task.id}`)
  await expect(page.getByTestId('plan-card')).toBeVisible()
  await expect(page.getByTestId('process-fold')).toHaveCount(0)
  await expect(page.getByTestId('event-stream')).toContainText('$ ls')
})

test('while running nothing folds: the raw reviewer JSON is gone, fragments are not counted, phases are dividers', async ({
  page,
}) => {
  const task = taskOf('running', 'raw-task')
  await mockApi(page, { task, events: finishedEvents(task.id).slice(0, 12) }, [])
  await page.goto(`/?task=${task.id}`)

  const stream = page.getByTestId('event-stream')
  await expect(stream).toContainText('Needs a test')
  await expect(stream).not.toContainText('"approve"')
  await expect(stream).not.toContainText('"summary"')
  await expect(page.getByLabel('審查結果')).toHaveCount(1)

  // One policy line is a real detail; the stretch of thinking and the empty tool result are not counted.
  await expect(page.getByRole('button', { name: '顯示細節（1 筆）' })).toBeVisible()

  // A phase is a hairline with the name in the middle, with no pill behind it.
  const divider = stream.locator('.phase-divider').first()
  await expect(divider).toHaveText('實作中')
  const pill = await divider.evaluate((element) => {
    const style = getComputedStyle(element)
    const before = getComputedStyle(element, '::before')
    return { background: style.backgroundColor, line: before.height }
  })
  expect(pill).toEqual({ background: 'rgba(0, 0, 0, 0)', line: '1px' })

  // A tool call that printed nothing has no output block to open.
  await expect(stream.locator('.tool-output')).toHaveCount(0)
  await expect(stream.locator('details.tool-row')).toHaveCount(0)
})

test('the review card is a neutral thin box with a small mark and word', async ({ page }) => {
  const task = taskOf('running', 'card-task')
  await mockApi(page, { task, events: finishedEvents(task.id).slice(0, 12) }, [])
  await page.goto(`/?task=${task.id}`)

  const card = page.getByLabel('審查結果')
  await expect(card.locator('.review-result')).toHaveText('要求修改')
  await expect(card.locator('.review-result svg')).toHaveCount(1)
  const borders = await card.evaluate((element) => {
    const style = getComputedStyle(element)
    const probe = document.createElement('div')
    probe.className = 'card'
    document.body.append(probe)
    const plain = getComputedStyle(probe).borderTopColor
    probe.remove()
    return { border: style.borderTopColor, plain, width: style.borderTopWidth }
  })
  expect(borders.border).toBe(borders.plain)
  expect(borders.width).toBe('1px')
  // Severity stays a neutral tag: no tinted background.
  const severity = await card
    .locator('.severity')
    .evaluate((element) => getComputedStyle(element).backgroundColor)
  const muted = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.background = 'var(--surface-muted)'
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
  expect(severity).toBe(muted)
})

test('the sidebar marks the open task by text, not by a block or a line, and a running one by a dot', async ({
  page,
}) => {
  const open = taskOf('done', 'open-task', 'Open task')
  const other = taskOf('running', 'other-task', 'Busy task', { updatedAt: new Date().toISOString() })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/repos') await route.fulfill({ json: { repos: [repo] } })
    else if (path === '/api/tasks') await route.fulfill({ json: { tasks: [open, other] } })
    else if (path === '/api/config') await route.fulfill({ json: { config } })
    else if (path === `/api/tasks/${open.id}`)
      await route.fulfill({ json: { task: open, repo, attempts: [], reviews: [], events: [] } })
    else await route.fulfill({ json: {} })
  })
  await page.goto(`/?task=${open.id}`)

  const nav = page.getByRole('navigation', { name: '主選單' })
  const selected = nav.locator('.nav-row-wrap.selected')
  await expect(selected).toHaveCount(1)
  const style = await selected.evaluate((element) => {
    const wrap = getComputedStyle(element)
    const title = getComputedStyle(element.querySelector('.task-title') as Element)
    return {
      background: wrap.backgroundColor,
      shadow: wrap.boxShadow,
      weight: title.fontWeight,
      color: title.color,
    }
  })
  expect(style.background).toBe('rgba(0, 0, 0, 0)')
  expect(style.shadow).toBe('none')
  expect(style.weight).toBe('500')
  const otherStyle = await nav
    .locator('.nav-row-wrap:not(.selected) .task-title')
    .first()
    .evaluate((element) => ({
      weight: getComputedStyle(element).fontWeight,
      color: getComputedStyle(element).color,
    }))
  expect(otherStyle.weight).toBe('400')
  expect(otherStyle.color).not.toBe(style.color)

  // Hovering tints a row only very lightly.
  const row = nav.locator('.nav-row-wrap:not(.selected)').first()
  await row.hover()
  const hover = await row.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(hover).toMatch(/^rgba\(0, 0, 0, 0\.0\d+\)$/)

  // The running task has a small dot, not the thinking character.
  const busy = nav.getByRole('button', { name: /Busy task/ })
  await expect(busy.locator('.task-flag')).toHaveAttribute('aria-label', '進行中')
  await expect(busy.locator('svg.mascot')).toHaveCount(0)
})

test('focusing the message box darkens its outline and adds no glow', async ({ page }) => {
  const task = taskOf('done', 'focus-task')
  await mockApi(page, { task, events: finishedEvents(task.id) }, [])
  await page.goto(`/?task=${task.id}`)

  const form = page.locator('form.composer-chat')
  const before = await form.evaluate((element) => getComputedStyle(element).borderTopColor)
  await page.getByLabel('傳訊息給任務').focus()
  const after = await form.evaluate((element) => {
    const style = getComputedStyle(element)
    return { border: style.borderTopColor, shadow: style.boxShadow }
  })
  expect(after.shadow).toBe('none')
  expect(after.border).not.toBe(before)
  const accent = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent)'
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  expect(after.border).not.toBe(accent)
  // The same short line in every state.
  await expect(page.getByLabel('傳訊息給任務')).toHaveAttribute('placeholder', '傳訊息給 Joy')
})

test('a waiting-for-you card keeps its colour thin: a neutral line and a faint tint', async ({ page }) => {
  const task = taskOf('awaiting_approval', 'approval-task')
  await mockApi(page, { task, events: [event(task.id, 'started', {})] }, [])
  await page.route('**/api/approvals**', async (route) => {
    await route.fulfill({
      json: {
        approvals: [
          {
            id: 'ap1',
            taskId: task.id,
            createdAt: new Date().toISOString(),
            status: 'pending',
            action: { kind: 'run_command', summary: 'rm -rf build', provenance: 'user' },
          },
        ],
      },
    })
  })
  await page.goto(`/?task=${task.id}`)
  const card = page.getByTestId('pending-approvals')
  await expect(card).toBeVisible()
  const styles = await card.evaluate((element) => {
    const style = getComputedStyle(element)
    const probe = document.createElement('div')
    probe.className = 'card'
    document.body.append(probe)
    const plain = getComputedStyle(probe).borderTopColor
    probe.remove()
    return { border: style.borderTopColor, plain, width: style.borderTopWidth }
  })
  expect(styles.border).toBe(styles.plain)
  expect(styles.width).toBe('1px')
})
