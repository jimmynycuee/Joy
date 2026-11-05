import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { E2E_API_TOKEN, startFakeJoyRuntime } from './fakes.js'

const appDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
process.env.JOY_API_TOKEN = E2E_API_TOKEN
const runtime = await startFakeJoyRuntime()
const vite = await createServer({
  configFile: resolve(appDirectory, 'vite.config.ts'),
  root: appDirectory,
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
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
console.log('Joy fake-provider preview ready on port 5173')
