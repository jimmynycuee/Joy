import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { startFakeJoyRuntime } from './fakes.js'

const appDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const apiPort = Number(process.env.JOY_E2E_API_PORT ?? 4317)
const webPort = Number(process.env.JOY_E2E_WEB_PORT ?? 4173)
const runtime = await startFakeJoyRuntime(apiPort)
const vite = await createServer({
  configFile: resolve(appDirectory, 'vite.config.ts'),
  root: appDirectory,
  server: { host: '127.0.0.1', port: webPort, strictPort: true },
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
console.log(`Joy fake-provider preview ready on port ${webPort}`)
