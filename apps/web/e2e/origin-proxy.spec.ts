import { randomBytes, randomUUID } from 'node:crypto'
import { request as nodeRequest } from 'node:http'
import { expect, test } from '@playwright/test'

const devOrigin = 'http://127.0.0.1:5173'
const crossPortOrigin = 'http://127.0.0.1:5174'

function websocketStatus(taskId: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest({
      hostname: '127.0.0.1',
      port: 5173,
      path: `/ws?taskId=${encodeURIComponent(taskId)}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        origin,
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
      },
    })
    request.once('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    request.once('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.once('error', reject)
    request.end()
  })
}

test('Vite proxy preserves same-origin checks for HTTP and WebSocket requests', async ({ request }) => {
  const allowedHealth = await request.get('/api/health', { headers: { origin: devOrigin } })
  expect(allowedHealth.status()).toBe(200)

  const rejectedHealth = await request.get('/api/health', { headers: { origin: crossPortOrigin } })
  expect(rejectedHealth.status()).toBe(403)

  const missingTaskId = randomUUID()
  expect(await websocketStatus(missingTaskId, devOrigin)).toBe(404)
  expect(await websocketStatus(missingTaskId, crossPortOrigin)).toBe(403)
})
