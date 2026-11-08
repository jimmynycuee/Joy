import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// The task thread's conversation features (messages, plans, PR status, checkpoints, checks, usage), against route mocks
// that follow the API contract in docs/STATUS.md.

const repo = { id: 'api-repo', path: '/tmp/api-project', defaultBranch: 'main' }
const config = { autonomy_mode: 'normal', roles: {} }

interface Call {
  method: string
  path: string
  body: unknown
}

interface ThreadState {
  task: Record<string, unknown>
  events: unknown[]
  attempts?: unknown[]
  usage?: unknown
  pendingPlan?: unknown
  queuedMessages?: unknown[]
  steerable?: boolean
  interruptible?: boolean
  pr?: { status: number; json: unknown }
  checkpoints?: unknown[]
  /** Answers a POST under /api/tasks/:id/; the default is 202 with the task. */
  post?: (path: string, body: unknown, route: Route) => Promise<boolean | undefined>
}

function taskOf(status: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    repoId: repo.id,
    title: 'Fix the login page',
    prompt: 'Pressing Enter on the login page does nothing.',
    mode: 'review_loop',
    status,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    ...extra,
  }
}

let seq = 1000
const event = (taskId: string, type: string, payload: unknown, secondsAgo = 60) => ({
  taskId,
  seq: ++seq,
  type,
  payload,
  ts: new Date(Date.now() - secondsAgo * 1000).toISOString(),
})

async function mockThread(page: Page, state: ThreadState, calls: Call[]) {
  const id = String(state.task.id)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (method === 'POST' && path.startsWith(`/api/tasks/${id}/`)) {
      const body: unknown = request.postDataJSON()
      calls.push({ method, path, body })
      if ((await state.post?.(path, body, route)) === true) return
      await route.fulfill({ status: 202, json: { task: state.task } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [state.task] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === `/api/tasks/${id}`) {
      await route.fulfill({
        json: {
          task: state.task,
          repo,
          attempts: state.attempts ?? [],
          reviews: [],
          events: state.events,
          usage: state.usage,
          pendingPlan: state.pendingPlan ?? null,
          queuedMessages: state.queuedMessages ?? [],
          ...(state.steerable !== undefined ? { steerable: state.steerable } : {}),
          ...(state.interruptible !== undefined ? { interruptible: state.interruptible } : {}),
        },
      })
    } else if (path === `/api/tasks/${id}/pr`) {
      const pr = state.pr ?? { status: 404, json: { error: 'This task has no pull request yet' } }
      await route.fulfill({ status: pr.status, json: pr.json })
    } else if (path === `/api/tasks/${id}/checkpoints`) {
      await route.fulfill({ json: { checkpoints: state.checkpoints ?? [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

test('a follow-up on a finished task is sent from the thread and shows as a bubble', async ({ page }) => {
  const state: ThreadState = {
    task: taskOf('done', 'follow-task'),
    events: [event('follow-task', 'started', {}), event('follow-task', 'result', { status: 'succeeded' })],
  }
  const calls: Call[] = []
  state.post = async (path, body) => {
    const text = (body as { text: string }).text
    state.task = { ...state.task, status: 'running' }
    state.events.push(
      event('follow-task', 'user.message', { id: 'm1', text, provenance: 'user', delivery: 'follow_up' }, 1),
    )
  }
  await mockThread(page, state, calls)

  await page.goto('/?task=follow-task')
  const composer = page.getByLabel('傳訊息給任務')
  await expect(composer).toHaveAttribute('placeholder', '接著交代…')
  await composer.fill('Also cover the Escape key')
  await composer.press('Enter')

  await expect
    .poll(() => calls.map((call) => ({ path: call.path, body: call.body })))
    .toEqual([{ path: '/api/tasks/follow-task/messages', body: { text: 'Also cover the Escape key' } }])
  const stream = page.getByTestId('event-stream')
  await expect(stream.locator('.user-bubble', { hasText: 'Also cover the Escape key' })).toBeVisible()
  // Sent straight to the agent, so there is no 排隊中 tag, and the draft is gone.
  await expect(page.getByTestId('message-tag')).toHaveCount(0)
  await expect(composer).toHaveValue('')
  await expect(composer).toHaveAttribute('placeholder', '訊息會在 agent 下一次動手時送達')
})

test('a message to a running agent reaches it while it keeps working', async ({ page }) => {
  const state: ThreadState = {
    task: taskOf('running', 'steer-task'),
    steerable: true,
    interruptible: true,
    events: [event('steer-task', 'started', {})],
  }
  const calls: Call[] = []
  let answer: () => void = () => {}
  state.post = async (_path, body, route) => {
    const text = (body as { text: string }).text
    state.events.push(
      event('steer-task', 'user.message', { id: 's1', text, provenance: 'user', delivery: 'steer' }, 1),
    )
    // Hold the answer so the "being sent" state can be seen.
    await new Promise<void>((resolve) => (answer = resolve))
    state.events.push(event('steer-task', 'user.message.delivered', { ids: ['s1'], via: 'steer' }, 0))
    await route.fulfill({ status: 202, json: { task: state.task, message: { id: 's1', delivery: 'steer' } } })
    return true
  }
  await mockThread(page, state, calls)

  await page.goto('/?task=steer-task')
  const composer = page.getByLabel('傳訊息給任務')
  await expect(composer).toHaveAttribute('placeholder', '補充指示或提問，agent 會邊做邊參考')
  await composer.fill('Use the existing helper; why did you add a new one?')
  await composer.press('Enter')

  // The web app does not ask to interrupt: the default hands the message to the working agent.
  await expect
    .poll(() => calls.map((call) => call.body))
    .toEqual([{ text: 'Use the existing helper; why did you add a new one?' }])
  answer()
  await page.reload()
  const bubble = page.locator('.user-column', { hasText: 'Use the existing helper' })
  await expect(bubble.getByTestId('message-tag')).toHaveText('已送給 agent')
  await expect(page.getByTestId('queued-messages')).toHaveCount(0)
  await expect(page.getByTestId('event-stream')).not.toContainText('已中斷目前這一步')
  // The stop button is still there for an empty box.
  await expect(page.getByRole('button', { name: '停止任務' })).toBeVisible()
})

test('a message during a review is queued until the next turn', async ({ page }) => {
  const state: ThreadState = {
    task: taskOf('running', 'queue-task'),
    steerable: false,
    events: [event('queue-task', 'started', {})],
  }
  state.post = async (_path, body) => {
    const text = (body as { text: string }).text
    state.queuedMessages = [{ id: 'q1', text }]
    state.events.push(
      event('queue-task', 'user.message', { id: 'q1', text, provenance: 'user', delivery: 'queued' }, 1),
    )
  }
  await mockThread(page, state, [])

  await page.goto('/?task=queue-task')
  const composer = page.getByLabel('傳訊息給任務')
  await expect(composer).toHaveAttribute('placeholder', '訊息會在 agent 下一次動手時送達')
  await composer.fill('Use the existing helper')
  await composer.press('Enter')

  const bubble = page.locator('.user-column', { hasText: 'Use the existing helper' })
  await expect(bubble.getByTestId('message-tag')).toHaveText('排隊中')
  await expect(page.getByTestId('queued-messages')).toContainText('1 則訊息排隊中')

  // The agent picks it up: the tag goes away (the details refetch brings the delivered event and an empty queue).
  state.queuedMessages = []
  state.events.push(event('queue-task', 'user.message.delivered', { ids: ['q1'], via: 'next_turn' }, 0))
  await page.reload()
  const delivered = page.locator('.user-column', { hasText: 'Use the existing helper' })
  await expect(delivered.getByTestId('message-tag')).toHaveText('已送給 agent')
  await expect(page.getByTestId('queued-messages')).toHaveCount(0)
})

test('a busy task answers 409: a toast explains and the draft stays', async ({ page }) => {
  const state: ThreadState = {
    task: taskOf('done', 'busy-task'),
    events: [event('busy-task', 'started', {})],
  }
  state.post = async (_path, _body, route) => {
    await route.fulfill({
      status: 409,
      json: { error: 'Another action on this task is still in progress; try again in a moment' },
    })
    return true
  }
  await mockThread(page, state, [])

  await page.goto('/?task=busy-task')
  const composer = page.getByLabel('傳訊息給任務')
  await composer.fill('keep this text')
  await composer.press('Enter')
  await expect(page.getByRole('alert')).toContainText('這個任務正在處理另一個動作，請稍後再送')
  await expect(composer).toHaveValue('keep this text')
  await expect(page.locator('.user-bubble', { hasText: 'keep this text' })).toHaveCount(0)
})

test('the composer is off, with a reason, for compete tasks and removed worktrees', async ({ page }) => {
  const compete: ThreadState = {
    task: taskOf('review_ready', 'compete-task', { mode: 'compete' }),
    events: [event('compete-task', 'started', {})],
  }
  await mockThread(page, compete, [])
  await page.goto('/?task=compete-task')
  await expect(page.getByLabel('傳訊息給任務')).toBeDisabled()
  await expect(page.getByTestId('thread-composer')).toContainText('比賽任務不能接續交代')
})

test('a removed worktree turns the composer off', async ({ page }) => {
  const state: ThreadState = {
    task: taskOf('done', 'removed-task'),
    events: [event('removed-task', 'worktree.removed', { attemptIds: ['a1'], discarded: true })],
  }
  await mockThread(page, state, [])
  await page.goto('/?task=removed-task')
  await expect(page.getByLabel('傳訊息給任務')).toBeDisabled()
  await expect(page.getByTestId('thread-composer')).toContainText('工作副本已經移除')
})

test('a plan waits at the end of the thread and is approved from its card', async ({ page }) => {
  const id = 'plan-task'
  const state: ThreadState = {
    task: taskOf('review_ready', id),
    events: [
      event(id, 'started', {}),
      event(id, 'plan.awaiting_approval', { plan: '## 計畫\n\n- 修改 login.ts\n- 補一個測試' }),
    ],
    pendingPlan: {
      plan: '## 計畫\n\n- 修改 login.ts\n- 補一個測試',
      review: { approve: true, summary: 'The plan is small and safe', findings: [] },
    },
  }
  const calls: Call[] = []
  state.post = async (path) => {
    if (path.endsWith('/plan/approve')) {
      state.task = { ...state.task, status: 'running' }
      state.pendingPlan = null
      state.events.push(event(id, 'plan.approved', {}, 1))
    }
  }
  await mockThread(page, state, calls)

  await page.goto(`/?task=${id}`)
  await expect(page.locator('.thread-header .status-pill')).toHaveText('等你核准計畫')
  const card = page.getByTestId('plan-card')
  await expect(card).toContainText('修改 login.ts')
  await expect(card).toContainText('The plan is small and safe')
  await expect(page.getByLabel('傳訊息給任務')).toHaveAttribute('placeholder', '說明要怎麼改計畫')
  // The plan is in the card, not repeated in the timeline.
  await expect(page.getByTestId('event-stream')).toContainText('計畫寫好了，等你核准')
  await expect(page.getByTestId('event-stream').locator('details')).toHaveCount(0)

  await card.getByRole('button', { name: '核准並開始實作' }).click()
  await expect.poll(() => calls.map((call) => call.path)).toEqual([`/api/tasks/${id}/plan/approve`])
  await expect(page.getByTestId('plan-card')).toHaveCount(0)
  await expect(page.getByTestId('event-stream')).toContainText('你核准了計畫，開始實作')
  await expect(page.locator('.thread-header .status-pill')).toHaveText('進行中')
})

test('a plan can be rejected, which cancels the task', async ({ page }) => {
  const id = 'reject-task'
  const state: ThreadState = {
    task: taskOf('review_ready', id),
    events: [event(id, 'plan.awaiting_approval', { plan: 'Do everything' })],
    pendingPlan: { plan: 'Do everything' },
  }
  const calls: Call[] = []
  state.post = async (path) => {
    if (path.endsWith('/plan/reject')) {
      state.task = { ...state.task, status: 'cancelled' }
      state.pendingPlan = null
      state.events.push(event(id, 'plan.rejected', {}, 1))
    }
  }
  await mockThread(page, state, calls)

  await page.goto(`/?task=${id}`)
  await page.getByTestId('plan-card').getByRole('button', { name: '取消任務' }).click()
  await expect.poll(() => calls.map((call) => call.path)).toEqual([`/api/tasks/${id}/plan/reject`])
  await expect(page.getByTestId('plan-card')).toHaveCount(0)
  await expect(page.locator('.thread-header .status-pill')).toHaveText('已取消')
  await expect(page.getByTestId('event-stream')).toContainText('你取消了計畫')
})

test('a published task shows its PR state and checks, and can be asked to fix CI', async ({ page }) => {
  const id = 'pr-task'
  const state: ThreadState = {
    task: taskOf('done', id),
    events: [event(id, 'publish.done', { pullRequestUrl: 'https://github.com/o/r/pull/7' })],
    pr: {
      status: 200,
      json: {
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        isDraft: true,
        checks: { passing: 2, failing: 1, pending: 1, failingNames: ['windows-latest'] },
        fetchedAt: new Date().toISOString(),
      },
    },
  }
  const calls: Call[] = []
  await mockThread(page, state, calls)

  await page.goto(`/?task=${id}`)
  const card = page.getByTestId('pr-status')
  await expect(card).toContainText('Draft')
  await expect(card).toContainText('通過 2 / 失敗 1 / 進行中 1')
  await expect(card.getByLabel('失敗的檢查')).toContainText('windows-latest')

  await card.getByRole('button', { name: '請 agent 修正 CI' }).click()
  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0]?.path).toBe(`/api/tasks/${id}/messages`)
  expect((calls[0]?.body as { text: string }).text).toContain('windows-latest')
  // A CI fix waits for the agent's next turn instead of interrupting it.
  expect(calls[0]?.body).toMatchObject({ interrupt: false })
})

test('after the worktree was removed, failing CI points at a new task instead of the agent', async ({
  page,
}) => {
  const id = 'pr-removed-task'
  const state: ThreadState = {
    task: taskOf('done', id),
    events: [
      event(id, 'publish.done', { pullRequestUrl: 'https://github.com/o/r/pull/8' }),
      event(id, 'worktree.removed', { attemptIds: ['a1'], published: true }),
    ],
    pr: {
      status: 200,
      json: {
        url: 'https://github.com/o/r/pull/8',
        state: 'MERGED',
        isDraft: false,
        checks: { passing: 1, failing: 1, pending: 0, failingNames: ['lint'] },
        fetchedAt: new Date().toISOString(),
      },
    },
  }
  await mockThread(page, state, [])
  await page.goto(`/?task=${id}`)
  const card = page.getByTestId('pr-status')
  await expect(card).toContainText('已合併')
  await expect(card.getByRole('button', { name: '請 agent 修正 CI' })).toHaveCount(0)
  await expect(card).toContainText('工作副本已移除')
})

test('restoring a checkpoint asks in the page before dropping commits, then retries with confirm', async ({
  page,
}) => {
  const id = 'checkpoint-task'
  const state: ThreadState = {
    task: taskOf('done', id),
    events: [
      event(id, 'checkpoint.created', { n: 1, label: 'implementer turn, round 1', round: 1 }),
      event(id, 'checkpoint.created', { n: 2, label: 'implementer turn, round 2', round: 2 }),
    ],
    checkpoints: [1, 2].map((n) => ({
      n,
      ref: `refs/joy/checkpoints/${id}/${n}`,
      commit: 'abc',
      head: 'def',
      round: n,
      label: `implementer turn, round ${n}`,
      attemptId: 'a1',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      available: true,
    })),
  }
  const calls: Call[] = []
  state.post = async (path, body, route) => {
    if (!path.includes('/checkpoints/')) return
    if ((body as { confirm?: boolean }).confirm !== true) {
      await route.fulfill({
        status: 409,
        json: {
          error:
            'Restoring this checkpoint would discard 2 commits made after it; confirm to continue (send {"confirm": true})',
        },
      })
      return true
    }
    state.events.push(
      event(
        id,
        'checkpoint.restored',
        { n: 1, commit: 'abc', savedAs: 3, discardedCommits: 2, diff: { files: [], patch: '' } },
        1,
      ),
    )
    await route.fulfill({ json: { restored: 1, savedAs: 3, discardedCommits: 2 } })
    return true
  }
  await mockThread(page, state, calls)
  page.on('dialog', (dialog) => {
    throw new Error(`unexpected browser dialog: ${dialog.message()}`)
  })

  await page.goto(`/?task=${id}`)
  await page.getByRole('button', { name: /^檢查點/ }).click()
  const panel = page.getByRole('dialog', { name: '檢查點' })
  await expect(panel.getByRole('listitem')).toHaveCount(2)
  // Newest first, labels in Chinese.
  await expect(panel.getByRole('listitem').first()).toContainText('實作者完成第 2 輪')

  await panel.getByRole('button', { name: '還原到檢查點 1' }).click()
  const confirm = panel.getByRole('alert')
  await expect(confirm).toContainText('丟掉之後的 2 個 commit')
  expect(calls.map((call) => call.body)).toEqual([{}])

  await confirm.getByRole('button', { name: '丟掉並還原' }).click()
  await expect.poll(() => calls.map((call) => call.body)).toEqual([{}, { confirm: true }])
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(calls.map((call) => call.path)).toEqual([
    `/api/tasks/${id}/checkpoints/1/restore`,
    `/api/tasks/${id}/checkpoints/1/restore`,
  ])
  await expect(page.getByTestId('event-stream').getByText('已還原到檢查點 1，丟掉 2 個 commit')).toBeVisible()
})

test('checkpoint restore is off while the task is running', async ({ page }) => {
  const id = 'running-checkpoint-task'
  const state: ThreadState = {
    task: taskOf('running', id),
    events: [event(id, 'checkpoint.created', { n: 1, label: 'implementer turn', round: 1 })],
    checkpoints: [
      {
        n: 1,
        ref: 'r',
        commit: 'c',
        head: 'h',
        round: 1,
        label: 'implementer turn',
        attemptId: 'a1',
        createdAt: new Date().toISOString(),
        available: true,
      },
    ],
  }
  await mockThread(page, state, [])
  await page.goto(`/?task=${id}`)
  await page.getByRole('button', { name: /^檢查點/ }).click()
  await expect(page.getByRole('button', { name: '還原到檢查點 1' })).toBeDisabled()
})

test('checks show as a step card with collapsible output, and skipped checks as a muted step', async ({
  page,
}) => {
  const id = 'checks-task'
  const state: ThreadState = {
    task: taskOf('done', id),
    events: [
      event(id, 'checks', {
        type: 'checks',
        round: 1,
        ok: false,
        exitCode: 1,
        outputTail: 'FAIL src/login.test.ts\n  expected 1 to be 2',
        durationMs: 4200,
      }),
      event(id, 'checks', {
        type: 'checks',
        round: 2,
        ok: true,
        exitCode: 0,
        outputTail: '',
        durationMs: 900,
      }),
      event(id, 'checks.skipped', {
        round: 3,
        reason: 'The owner did not approve running the checks (denied)',
      }),
    ],
  }
  await mockThread(page, state, [])
  await page.goto(`/?task=${id}`)
  const cards = page.getByTestId('checks-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText('專案檢查失敗')
  await expect(cards.first()).toContainText('結束碼 1')
  await expect(cards.first()).toContainText('耗時 4 秒')
  await expect(cards.first().locator('pre')).toBeHidden()
  await cards.first().getByText('專案檢查失敗').click()
  await expect(cards.first().locator('pre')).toContainText('expected 1 to be 2')
  await expect(cards.last()).toContainText('專案檢查通過')
  await expect(page.getByTestId('event-stream')).toContainText('略過專案檢查')
})

test('usage shows time, tokens and an estimated cost per model', async ({ page }) => {
  const id = 'usage-task'
  const state: ThreadState = {
    task: taskOf('done', id),
    events: [event(id, 'started', {})],
    usage: {
      durationMs: 192_000,
      inputTokens: 48_000,
      outputTokens: 3_400,
      costUsd: 0.4321,
      byProvider: [
        { provider: 'claude-cli', model: 'opus', inputTokens: 40_000, outputTokens: 3_000, costUsd: 0.4 },
        {
          provider: 'codex-cli',
          model: 'gpt-6-luna',
          inputTokens: 8_000,
          outputTokens: 400,
          costUsd: 0.0321,
        },
      ],
    },
  }
  await mockThread(page, state, [])
  await page.goto(`/?task=${id}`)
  await page.getByRole('button', { name: /^用量/ }).click()
  const panel = page.getByRole('dialog', { name: '用量' })
  await expect(panel).toContainText('3 分 12 秒')
  await expect(panel).toContainText('輸入 48k / 輸出 3.4k')
  await expect(panel).toContainText('$0.43')
  await expect(panel.getByLabel('各模型用量')).toContainText('Claude Code · opus')
  await expect(panel.getByLabel('各模型用量')).toContainText('$0.40（估算）')
})
