import { expect, test } from '@playwright/test'

test('compete synthesizes candidate strengths and persists the selected winner', async ({
  page,
  request,
}, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  if (await page.getByRole('button', { name: 'Manage repositories' }).isVisible()) {
    await page.getByRole('button', { name: 'Manage repositories' }).click()
  } else {
    await page.getByRole('button', { name: 'Add repository' }).click()
  }
  const repoDialog = page.getByRole('dialog', { name: 'Add repository' })
  await repoDialog.getByLabel('Repository path').fill('/tmp/joy-t2.1-compete-project')
  await repoDialog.getByLabel('Default branch').fill('main')
  await repoDialog.getByRole('button', { name: 'Add repository' }).click()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await taskDialog.getByLabel('Task repository').selectOption({ label: '/tmp/joy-t2.1-compete-project' })
  await taskDialog.getByLabel('Task title').fill('Compare fake implementations')
  await taskDialog
    .getByLabel('Task instructions')
    .fill('Make a small greeting change and compare the implementations.')
  await taskDialog.getByLabel('Workflow').selectOption('compete')
  await taskDialog.getByLabel('Implementer provider').selectOption('codex-cli')
  await taskDialog.getByLabel('Implementer model').fill('fake-candidate-one')
  await taskDialog.getByLabel('Reviewer provider').selectOption('claude-cli')
  await taskDialog.getByLabel('Reviewer model').fill('fake-candidate-two')
  await taskDialog.getByRole('button', { name: 'Start task' }).click()

  await expect(page.getByRole('heading', { name: 'Compare fake implementations' })).toBeVisible()
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  await expect(page.getByTestId('compete-judge-summary')).toHaveText(
    'Fake judge prefers the first candidate.',
  )
  await expect(page.getByTestId('compete-judge-rationale')).toContainText(
    'has the clearest implementation in this test',
  )
  await expect(page.locator('.large-status')).toHaveText('review ready')
  const patches = await page.getByTestId('candidate-diff').allTextContents()
  expect(patches[0]).toContain('hello from fake')
  expect(patches[1]).toContain('hello from fake')
  expect(patches[0]).not.toBe(patches[1])

  await page.getByTestId('synthesize-strengths').click()
  await expect(page.getByTestId('synthesis-success')).toBeVisible()
  await expect(page.getByText('SYNTHESIZED CANDIDATE', { exact: true })).toBeVisible()
  await expect(page.getByTestId('candidate-diff')).toHaveCount(3)
  if (process.env.JOY_CAPTURE_T2_1 === '1') {
    await page.screenshot({ path: testInfo.outputPath('t2.1-synthesis.png') })
  }

  const tasksResponse = await request.get('/api/tasks')
  const tasks = (await tasksResponse.json()) as { tasks: Array<{ id: string; title: string }> }
  const task = tasks.tasks.find((item) => item.title === 'Compare fake implementations')
  expect(task).toBeDefined()
  const beforeResponse = await request.get(`/api/tasks/${task?.id}`)
  const before = (await beforeResponse.json()) as {
    events: Array<{ type: string; payload: unknown }>
  }
  const result = before.events
    .map((event) => event.payload as { candidates?: Array<{ attemptId: string; status: string }> })
    .find((payload) => Array.isArray(payload.candidates))
  const winner = before.events
    .filter((event) => event.type === 'attempt')
    .map((event) => event.payload as { attemptId?: string; synthesized?: boolean })
    .find((candidate) => candidate.synthesized)
  expect(winner).toBeDefined()
  expect(result?.candidates?.filter((candidate) => candidate.status === 'succeeded')).toHaveLength(2)

  await page
    .locator('.candidate-card')
    .filter({ hasText: 'SYNTHESIZED CANDIDATE' })
    .getByRole('button', { name: 'Select winner' })
    .click()
  await expect(page.getByTestId('selected-winner')).toHaveText('Selected winner')
  await expect(page.locator('.large-status')).toHaveText('done')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Compare fake implementations' })).toBeVisible()
  await expect(page.getByTestId('selected-winner')).toHaveText('Selected winner')
  const afterResponse = await request.get(`/api/tasks/${task?.id}`)
  const after = (await afterResponse.json()) as {
    task: { status: string }
    events: Array<{ type: string; payload: unknown }>
  }
  expect(after.task.status).toBe('done')
  const selection = after.events.find((event) => event.type === 'winner_selected')
  expect(selection?.payload).toMatchObject({ attemptId: winner?.attemptId })
})

test('resume compares only candidates from the latest compete run', async ({ page, request }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  if (await page.getByRole('button', { name: 'Manage repositories' }).isVisible()) {
    await page.getByRole('button', { name: 'Manage repositories' }).click()
  } else {
    await page.getByRole('button', { name: 'Add repository' }).click()
  }
  const repoDialog = page.getByRole('dialog', { name: 'Add repository' })
  await repoDialog.getByLabel('Repository path').fill('/tmp/joy-t2.1-resume-project')
  await repoDialog.getByLabel('Default branch').fill('main')
  await repoDialog.getByRole('button', { name: 'Add repository' }).click()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await taskDialog.getByLabel('Task repository').selectOption({ label: '/tmp/joy-t2.1-resume-project' })
  await taskDialog.getByLabel('Task title').fill('Resume latest compete candidates')
  await taskDialog
    .getByLabel('Task instructions')
    .fill('pause-one-candidate-until-cancel; compare the fake candidates.')
  await taskDialog.getByLabel('Workflow').selectOption('compete')
  await taskDialog.getByLabel('Implementer provider').selectOption('claude-cli')
  await taskDialog.getByLabel('Implementer model').fill('fake-implementer')
  await taskDialog.getByLabel('Reviewer provider').selectOption('codex-cli')
  await taskDialog.getByLabel('Reviewer model').fill('fake-reviewer')
  await taskDialog.getByRole('button', { name: 'Start task' }).click()

  const tasksResponse = await request.get('/api/tasks')
  const tasks = (await tasksResponse.json()) as { tasks: Array<{ id: string; title: string }> }
  const task = tasks.tasks.find((item) => item.title === 'Resume latest compete candidates')
  expect(task).toBeDefined()
  const readDetails = async () => {
    const response = await request.get(`/api/tasks/${task?.id}`)
    return (await response.json()) as {
      task: { status: string }
      attempts: Array<{ status: string }>
    }
  }

  await expect
    .poll(async () => (await readDetails()).attempts.filter((attempt) => attempt.status === 'succeeded'))
    .toHaveLength(1)
  const cancelled = await request.post(`/api/tasks/${task?.id}/cancel`)
  expect(cancelled.status()).toBe(200)
  await expect.poll(async () => (await readDetails()).task.status).toBe('cancelled')
  await expect(page.getByTestId('candidate-diff')).toHaveCount(1)
  const previousPatch = await page.getByTestId('candidate-diff').textContent()
  expect(previousPatch).not.toBeNull()

  const resumed = await request.post(`/api/tasks/${task?.id}/resume`)
  expect(resumed.status()).toBe(202)
  await expect.poll(async () => (await readDetails()).task.status).toBe('review_ready')
  await expect(page.locator('.large-status')).toHaveText('review ready')
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  const currentPatches = await page.getByTestId('candidate-diff').allTextContents()
  expect(currentPatches).not.toContain(previousPatch)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Resume latest compete candidates' })).toBeVisible()
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  if (process.env.JOY_CAPTURE_T2_1 === '1') {
    await page.screenshot({ path: testInfo.outputPath('t2.1-resume.png') })
  }
})

test('buffers socket events during the task snapshot and replays after reconnect from the accepted sequence', async ({
  page,
}) => {
  const repo = { id: 'race-repo', path: '/tmp/joy-websocket-race', defaultBranch: 'main' }
  const task = {
    id: 'race-task',
    repoId: repo.id,
    title: 'WebSocket snapshot race',
    prompt: 'Verify event buffering and replay.',
    mode: 'review_loop',
    status: 'running',
    createdAt: '2025-01-01T00:00:00.000Z',
  }
  const event = (seq: number, type: string, payload: unknown) => ({
    taskId: task.id,
    seq,
    type,
    payload,
    ts: `2025-01-01T00:00:0${seq}.000Z`,
  })
  const snapshotEvent = event(1, 'started', {})
  const bufferedEvent = event(2, 'phase', { phase: 'between snapshot and apply' })
  const replayedEvent = event(3, 'phase', { phase: 'after reconnect' })
  let releaseDetails: (() => void) | undefined
  const detailsGate = new Promise<void>((resolve) => {
    releaseDetails = resolve
  })
  let firstConnection!: () => void
  const firstConnectionReady = new Promise<void>((resolve) => {
    firstConnection = resolve
  })
  let replayFinished!: () => void
  const replayResponseReady = new Promise<void>((resolve) => {
    replayFinished = resolve
  })
  let closeFirstSocket: (() => void) | undefined
  let socketConnections = 0
  let replayAfter: string | null = null

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (url.pathname === '/api/tasks' && route.request().method() === 'GET') {
      await route.fulfill({ json: { tasks: [task] } })
    } else if (url.pathname === '/api/config') {
      await route.fulfill({ json: { config: { roles: {} } } })
    } else if (url.pathname === '/api/secrets/openai-api-key') {
      await route.fulfill({ json: { set: false } })
    } else if (url.pathname === `/api/tasks/${task.id}/events`) {
      replayAfter = url.searchParams.get('after')
      await route.fulfill({ json: { events: [replayedEvent] } })
      replayFinished()
    } else if (url.pathname === `/api/tasks/${task.id}`) {
      await detailsGate
      await route.fulfill({
        json: { task, repo, attempts: [], reviews: [], events: [snapshotEvent] },
      })
    } else {
      await route.fulfill({ json: {} })
    }
  })
  await page.routeWebSocket(/\/ws\?taskId=race-task$/, (webSocket) => {
    socketConnections += 1
    if (socketConnections === 1) {
      closeFirstSocket = () => webSocket.close({ code: 1000, reason: 'test reconnect' })
      webSocket.send(JSON.stringify({ type: 'event', event: bufferedEvent }))
      firstConnection()
    } else {
      webSocket.send(JSON.stringify({ type: 'event', event: snapshotEvent }))
      webSocket.send(JSON.stringify({ type: 'event', event: bufferedEvent }))
    }
  })

  let initialFrameReceived!: () => void
  const initialFrame = new Promise<void>((resolve) => {
    initialFrameReceived = resolve
  })
  page.on('websocket', (webSocket) => webSocket.on('framereceived', initialFrameReceived))
  await page.goto('/')
  await firstConnectionReady
  await initialFrame
  releaseDetails?.()

  await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
  await expect(page.getByTestId('event-stream')).toContainText('Phase: between snapshot and apply')
  await expect(page.getByTestId('event-stream').locator('article')).toHaveCount(2)

  closeFirstSocket?.()
  await replayResponseReady
  await expect(page.getByTestId('event-stream')).toContainText('Phase: after reconnect')
  expect(replayAfter).toBe('2')
  await expect(page.getByTestId('event-stream').locator('article')).toHaveCount(3)
  await expect(page.getByText('Phase: between snapshot and apply', { exact: true })).toHaveCount(1)
})

test('compete mode blocks providers without code-edit capability', async ({ page }, testInfo) => {
  const repo = { id: 'capability-repo', path: '/tmp/joy-p1-code-edit-capability', defaultBranch: 'main' }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (url.pathname === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else if (url.pathname === '/api/config') {
      await route.fulfill({ json: { config: { roles: {} } } })
    } else if (url.pathname === '/api/secrets/openai-api-key') {
      await route.fulfill({ json: { set: false } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await taskDialog.getByLabel('Task repository').selectOption({ label: '/tmp/joy-p1-code-edit-capability' })
  await taskDialog.getByLabel('Task title').fill('Reject non-code-edit competitors')
  await taskDialog.getByLabel('Task instructions').fill('Check code-edit capability before competing.')
  await taskDialog.getByLabel('Implementer provider').selectOption('openai-api')
  await taskDialog.getByLabel('Workflow').selectOption('compete')

  await expect(taskDialog.getByRole('note')).toContainText('including OpenAI API')
  await expect(
    taskDialog.getByLabel('Implementer provider').locator('option[value="openai-api"]'),
  ).toHaveAttribute('disabled', '')
  await expect(taskDialog.getByRole('button', { name: 'Start task' })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('compete-code-edit-disabled.png'), fullPage: true })
})

test('judge failure remains visible while successful candidates can be reviewed', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  if (await page.getByRole('button', { name: 'Manage repositories' }).isVisible()) {
    await page.getByRole('button', { name: 'Manage repositories' }).click()
  } else {
    await page.getByRole('button', { name: 'Add repository' }).click()
  }
  const repoDialog = page.getByRole('dialog', { name: 'Add repository' })
  await repoDialog.getByLabel('Repository path').fill('/tmp/joy-t2.1-judge-failure-project')
  await repoDialog.getByLabel('Default branch').fill('main')
  await repoDialog.getByRole('button', { name: 'Add repository' }).click()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await taskDialog
    .getByLabel('Task repository')
    .selectOption({ label: '/tmp/joy-t2.1-judge-failure-project' })
  await taskDialog.getByLabel('Task title').fill('Judge failure remains visible')
  await taskDialog.getByLabel('Task instructions').fill('fail-fake-judge; compare the fake candidates.')
  await taskDialog.getByLabel('Workflow').selectOption('compete')
  await taskDialog.getByLabel('Implementer provider').selectOption('claude-cli')
  await taskDialog.getByLabel('Implementer model').fill('fake-implementer')
  await taskDialog.getByLabel('Reviewer provider').selectOption('codex-cli')
  await taskDialog.getByLabel('Reviewer model').fill('fake-reviewer')
  await taskDialog.getByRole('button', { name: 'Start task' }).click()

  await expect(page.locator('.large-status')).toHaveText('review ready')
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  await expect(page.getByTestId('compete-judge-error')).toContainText(
    'The judge did not return a valid candidate selection',
  )

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Judge failure remains visible' })).toBeVisible()
  await expect(page.getByTestId('compete-judge-error')).toContainText(
    'The judge did not return a valid candidate selection',
  )
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  if (process.env.JOY_CAPTURE_T2_1 === '1') {
    await page.screenshot({ path: testInfo.outputPath('t2.1-judge-failure.png') })
  }
})
