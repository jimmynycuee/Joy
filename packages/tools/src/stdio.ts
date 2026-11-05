import { startToolHubStdio, isToolHubValue } from './mcp.js'

const endpoint = process.env.JOY_TOOL_HUB_ENDPOINT
const token = process.env.JOY_TOOL_HUB_TOKEN

if (!endpoint || !token) {
  throw new Error('Joy Tool Hub requires a task-scoped endpoint and token')
}
const url = new URL(endpoint)
if (
  url.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  !/^\/internal\/tool-hub\/[A-Za-z0-9_-]{32,}$/.test(url.pathname) ||
  url.search !== '' ||
  url.hash !== ''
) {
  throw new Error('Joy Tool Hub only accepts an authenticated loopback endpoint')
}

await startToolHubStdio(async (call) => {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(call),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new Error('Joy Tool Hub could not reach the local task service')
  }
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `Joy Tool Hub request failed (${response.status})`
    throw new Error(message)
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('value' in payload) ||
    !isToolHubValue(payload.value)
  ) {
    throw new Error('Joy Tool Hub returned an invalid response')
  }
  return payload.value
})
