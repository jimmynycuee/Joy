import { randomBytes } from 'node:crypto'
import { request as nodeRequest } from 'node:http'
import { expect, test } from '@playwright/test'
import { E2E_API_TOKEN } from './fakes.js'

const devOrigin = 'http://127.0.0.1:5173'
const crossPortOrigin = 'http://127.0.0.1:5174'

function websocketHandshake(
  taskId: string,
  origin: string,
  token?: string,
): Promise<{ status: number; protocol?: string | undefined }> {
  return new Promise((resolve, reject) => {
    const protocols = token ? ['joy', `joy-auth.${token}`] : ['joy']
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
        'sec-websocket-protocol': protocols.join(', '),
      },
    })
    request.once('upgrade', (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode ?? 0, protocol: response.headers['sec-websocket-protocol'] })
    })
    request.once('response', (response) => {
      response.resume()
      resolve({ status: response.statusCode ?? 0 })
    })
    request.once('error', reject)
    request.end()
  })
}

test('Vite proxy preserves origin checks and requires API tokens for HTTP writes and WebSockets', async ({
  request,
}) => {
  const allowedHealth = await request.get('/api/health', { headers: { origin: devOrigin } })
  expect(allowedHealth.status()).toBe(200)

  const localhostHealth = await request.get('http://localhost:5173/api/health', {
    headers: { origin: 'http://localhost:5173' },
  })
  expect(localhostHealth.status()).toBe(200)

  const rejectedHealth = await request.get('/api/health', { headers: { origin: crossPortOrigin } })
  expect(rejectedHealth.status()).toBe(403)

  const mutation = { path: '/tmp/joy-auth-e2e', defaultBranch: 'main' }
  const missingToken = await request.post('/api/repos', {
    headers: { origin: devOrigin },
    data: mutation,
  })
  // T4.1: missing or wrong token is 401; a forbidden origin stays 403.
  expect(missingToken.status()).toBe(401)
  expect((await missingToken.text()).includes(E2E_API_TOKEN)).toBe(false)
  const wrongToken = await request.post('/api/repos', {
    headers: { origin: devOrigin, authorization: 'Bearer wrong-e2e-token' },
    data: mutation,
  })
  expect(wrongToken.status()).toBe(401)
  expect((await wrongToken.text()).includes(E2E_API_TOKEN)).toBe(false)

  const missingTaskId = 'nonexistent-auth-check'
  expect(await websocketHandshake(missingTaskId, devOrigin)).toMatchObject({ status: 401 })
  expect(await websocketHandshake(missingTaskId, devOrigin, 'wrong-e2e-token')).toMatchObject({ status: 401 })
  expect(await websocketHandshake(missingTaskId, devOrigin, E2E_API_TOKEN)).toMatchObject({ status: 404 })
  expect(await websocketHandshake(missingTaskId, crossPortOrigin, E2E_API_TOKEN)).toMatchObject({
    status: 403,
  })
})
