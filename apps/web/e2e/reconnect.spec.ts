import { expect, test } from '@playwright/test'
import { E2E_API_TOKEN } from './fakes.js'

const repo = { id: 'race-repo', path: '/tmp/joy-websocket-race', defaultBranch: 'main' }
const task = {
  id: 'race-task',
  repoId: repo.id,
  title: 'WebSocket snapshot race',
  prompt: 'Verify ordered replay and event deduplication.',
  mode: 'review_loop',
  status: 'running',
  createdAt: '2025-01-01T00:00:00.000Z',
}
const config = { autonomy_mode: 'normal', roles: {} }
type Frame = { type: string; [key: string]: unknown }
const event = (seq: number, type: string, payload: unknown, ts = `2025-01-01T00:00:0${seq}.000Z`) => ({
  taskId: task.id,
  seq,
  type,
  payload,
  ts,
})
const initialEvent = event(1, 'started', {})
const secondEvent = event(2, 'phase', { phase: 'before reconnect' })
const replayedEvent = event(3, 'phase', { phase: 'after reconnect' })
const unpersistedError = {
  ...event(0, 'error', { message: 'Unpersisted startup error remains visible' }, '2025-01-01T00:00:04.000Z'),
  eventId: 'ephemeral-error-1',
}
const collidingEvent = event(2, 'error', {
  message: 'Collision must not replace the first sequence 2 event',
})

test('reconnects from the snapshot cursor and deduplicates replayed and sequence-zero errors', async ({
  page,
}) => {
  const connectionUrls: string[] = []
  const connectionFrames: Frame[][] = []
  let closeFirstSocket: (() => void) | undefined

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [task] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === '/api/secrets/openai-api-key') {
      await route.fulfill({ json: { set: false } })
    } else if (path === `/api/tasks/${task.id}`) {
      await route.fulfill({ json: { task, repo, attempts: [], reviews: [], events: [initialEvent] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.routeWebSocket('**/ws?*', (webSocket) => {
    connectionUrls.push(webSocket.url())
    const frames: Frame[] = []
    connectionFrames.push(frames)
    const send = (message: Frame) => {
      frames.push(message)
      webSocket.send(JSON.stringify(message))
    }

    if (connectionUrls.length === 1) {
      send({ type: 'snapshot', task: { ...task, status: 'running' }, lastSequence: 1 })
      send({ type: 'ready' })
      send({ type: 'event', event: initialEvent })
      send({ type: 'event', event: secondEvent })
      send({ type: 'event', event: unpersistedError })
      send({ type: 'event', event: unpersistedError })
      closeFirstSocket = () => webSocket.close({ code: 1000, reason: 'test reconnect' })
    } else {
      send({ type: 'snapshot', task: { ...task, status: 'failed' }, lastSequence: 3 })
      send({ type: 'ready' })
      send({ type: 'event', event: collidingEvent })
      send({ type: 'event', event: replayedEvent })
    }
  })

  await page.addInitScript(() => {
    const nativeWebSocket = window.WebSocket
    const captureWindow = window as Window & {
      __joyWebSocketCaptures?: Array<{ url: string; protocols?: string | string[] | undefined }>
    }
    captureWindow.__joyWebSocketCaptures = []
    window.WebSocket = class extends nativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        captureWindow.__joyWebSocketCaptures?.push({
          url: String(url),
          protocols: Array.isArray(protocols) ? [...protocols] : protocols,
        })
        super(url, protocols)
      }
    }
  })

  await page.goto(`/?task=${task.id}`)
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
  await expect(page.getByTestId('event-stream')).toContainText('Unpersisted startup error remains visible')
  // The error fails the task, so its process is folded; the phase lines are inside.
  await page.locator('.process-toggle').click()
  await expect(page.locator('[data-event-seq="0"]')).toHaveCount(1)
  await expect(page.locator('[data-event-seq]')).toHaveCount(3)

  const beforeReconnect = await page
    .locator('[data-event-seq]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-event-seq')))
  expect(beforeReconnect).toEqual(['1', '2', '0'])
  expect(connectionFrames[0]?.map(({ type }) => type)).toEqual([
    'snapshot',
    'ready',
    'event',
    'event',
    'event',
    'event',
  ])

  closeFirstSocket?.()
  await expect.poll(() => connectionUrls.length).toBe(2)
  await expect(page.getByTestId('event-stream')).toContainText('after reconnect')
  await expect(page.getByTestId('event-stream')).not.toContainText('Collision must not replace')
  await expect(page.locator('[data-event-seq]')).toHaveCount(4)
  await expect(page.locator('[data-event-seq="0"]')).toHaveCount(1)

  const sequence = await page
    .locator('[data-event-seq]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-event-seq')))
  expect(sequence).toEqual(['1', '2', '3', '0'])
  expect(new Set(sequence).size).toBe(sequence.length)
  const socketCaptures = await page.evaluate(
    () =>
      (
        window as Window & {
          __joyWebSocketCaptures?: Array<{ url: string; protocols?: string | string[] | undefined }>
        }
      ).__joyWebSocketCaptures ?? [],
  )
  const taskSockets = socketCaptures.filter(({ url }) => url.includes('/ws?taskId='))
  expect(taskSockets).toHaveLength(2)
  for (const capture of taskSockets) {
    expect(
      Array.isArray(capture.protocols) &&
        capture.protocols[0] === 'joy' &&
        capture.protocols[1] === `joy-auth.${E2E_API_TOKEN}`,
    ).toBe(true)
    expect(capture.url.includes(E2E_API_TOKEN)).toBe(false)
    expect(capture.url.includes('/ws?taskId=race-task')).toBe(true)
  }
  expect(new URL(connectionUrls[1] ?? '').searchParams.get('after')).toBe('2')
  expect(connectionFrames[1]?.map(({ type }) => type)).toEqual(['snapshot', 'ready', 'event', 'event'])
})
