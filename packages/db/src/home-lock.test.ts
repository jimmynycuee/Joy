import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lockHome } from './home-lock.js'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'joy-lock-'))
  temps.push(dir)
  return join(dir, 'joy.lock')
}

describe('lockHome', () => {
  it('lets one holder in at a time and frees the lock on release', () => {
    const path = lockPath()
    const first = lockHome(path)
    expect(() => lockHome(path)).toThrow(/Another Joy is already running/)
    first.release()
    first.release()
    lockHome(path).release()
  })

  it('is freed when the holding process dies without releasing', async () => {
    const path = lockPath()
    // Takes the lock, says so, then waits to be killed.
    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        '-e',
        `const { DatabaseSync } = require('node:sqlite')
         const db = new DatabaseSync(${JSON.stringify(path)})
         db.exec('PRAGMA locking_mode = EXCLUSIVE'); db.exec('BEGIN EXCLUSIVE'); db.exec('COMMIT')
         process.stdout.write('held\\n'); setInterval(() => {}, 1000)`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], shell: false },
    )
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', () => resolve())
      child.on('error', reject)
      child.on('exit', () => reject(new Error('the child exited before taking the lock')))
    })
    expect(() => lockHome(path)).toThrow(/Another Joy is already running/)
    const exited = new Promise((resolve) => child.on('exit', resolve))
    child.kill('SIGKILL')
    await exited
    lockHome(path).release()
  })
})
