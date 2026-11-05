import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { startFakeJoyRuntime } from './fakes.js'

const appDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runtime = await startFakeJoyRuntime()
const previousJoyHome = process.env.JOY_HOME
process.env.JOY_HOME = runtime.home
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
  if (previousJoyHome === undefined) delete process.env.JOY_HOME
  else process.env.JOY_HOME = previousJoyHome
}

process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
console.log('Joy fake-provider preview ready on port 5173')
