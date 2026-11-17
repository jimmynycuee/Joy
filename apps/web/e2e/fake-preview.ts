import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { E2E_API_TOKEN, startFakeJoyRuntime } from './fakes.js'
import { E2E_API_PORT, E2E_WEB_PORT } from './ports.js'

const appDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
process.env.JOY_API_TOKEN = E2E_API_TOKEN
// The fake API trusts the preview's own origin, whatever port it is on (5173 is always trusted).
const runtime = await startFakeJoyRuntime(E2E_API_PORT, {
  allowPlaywrightOrigin: true,
  playwrightOriginPort: E2E_WEB_PORT,
})
const vite = await createServer({
  configFile: resolve(appDirectory, 'vite.config.ts'),
  root: appDirectory,
  server: {
    host: '127.0.0.1',
    port: E2E_WEB_PORT,
    strictPort: true,
    // Merged into vite.config.ts's proxy, so only the API port changes.
    proxy: {
      '/api': { target: `http://127.0.0.1:${E2E_API_PORT}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${E2E_API_PORT}`, changeOrigin: false, ws: true },
    },
  },
})
await vite.listen()

let closing = false
async function close(): Promise<void> {
  if (closing) return
  closing = true
  await vite.close()
  await runtime.close()
}

process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
console.log(`Joy fake-provider preview ready on port ${E2E_WEB_PORT}`)
