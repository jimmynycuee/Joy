import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_TOKEN_FILENAME = 'api-token'
const WS_API_PROTOCOL = 'joy-api-v1'
const WS_TOKEN_PROTOCOL_PREFIX = 'joy-auth.'

function readApiToken(): string {
  const path = join(process.env.JOY_HOME ?? join(homedir(), '.joy'), API_TOKEN_FILENAME)
  let info
  let token: string
  try {
    info = lstatSync(path)
    token = readFileSync(path, 'utf8')
  } catch {
    throw new Error('Joy API token is unavailable; start the Joy server before the web UI.')
  }
  const isCurrentUserOwned =
    process.platform === 'win32' || (typeof process.getuid === 'function' && info.uid === process.getuid())
  if (
    !info.isFile() ||
    !isCurrentUserOwned ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  )
    throw new Error('Joy API token file is invalid or not private.')
  return token
}

export default defineConfig(({ command }) => {
  const apiToken = command === 'serve' ? readApiToken() : ''
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      // Preserve the browser's same-origin headers so the API can enforce them.
      cors: false,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4317',
          changeOrigin: false,
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest) => {
              proxyRequest.setHeader('authorization', `Bearer ${apiToken}`)
            })
          },
        },
        '/ws': {
          target: 'ws://127.0.0.1:4317',
          changeOrigin: false,
          ws: true,
          configure(proxy) {
            proxy.on('proxyReqWs', (proxyRequest) => {
              proxyRequest.setHeader(
                'sec-websocket-protocol',
                `${WS_API_PROTOCOL}, ${WS_TOKEN_PROTOCOL_PREFIX}${apiToken}`,
              )
            })
          },
        },
      },
    },
  }
})
