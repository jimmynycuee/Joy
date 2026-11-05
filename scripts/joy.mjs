#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliEntry = fileURLToPath(new URL('../packages/doctor/src/cli.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const result = spawnSync(process.execPath, ['--import', tsxLoader, cliEntry, ...process.argv.slice(2)], {
  shell: false,
  stdio: 'inherit',
})

if (result.error) {
  console.error('Could not start Joy CLI.')
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
