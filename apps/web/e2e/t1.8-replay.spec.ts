import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('buffers socket events during the task snapshot and replays after reconnect from the accepted sequence', async ({
  page,
}) => {
  const repo = { id: 'race-repo', path: join(tmpdir(), 'joy-websocket-race'), defaultBranch: 'main' }
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
