import { spawn } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const playwrightCli = require.resolve('@playwright/test/cli')
const runId = randomUUID()
const apiPort = randomInt(30_000, 60_000)
let webPort = randomInt(30_000, 60_000)
while (webPort === apiPort) webPort = randomInt(30_000, 60_000)

const child = spawn(process.execPath, [playwrightCli, 'test', ...process.argv.slice(2)], {
  cwd: appDirectory,
  env: {
    ...process.env,
    JOY_E2E_RUN_ID: runId,
    JOY_E2E_API_PORT: String(apiPort),
    JOY_E2E_WEB_PORT: String(webPort),
  },
  stdio: 'inherit',
})

child.once('error', (error) => {
  console.error(`Could not start Playwright: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
