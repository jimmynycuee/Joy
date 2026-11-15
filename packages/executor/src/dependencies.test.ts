import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dependencyInstall, installDependencies } from './dependencies.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'joy-deps-'))
  dirs.push(dir)
  return dir
}

/** A package manager that records how it was started and exits with FAKE_PM_EXIT (no network, no shell). */
function fakePackageManager(): string {
  const dir = temp()
  const script = join(dir, 'fake-pm.mjs')
  writeFileSync(
    script,
    [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync('pm-call.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))",
      "console.log('installing...')",
      "if (process.env.FAKE_PM_EXIT !== '0') console.error('ERR_PNPM_OUTDATED_LOCKFILE')",
      'process.exit(Number(process.env.FAKE_PM_EXIT ?? 0))',
    ].join('\n'),
  )
  return script
}

describe('dependencyInstall', () => {
  it.each([
    [['pnpm-lock.yaml'], 'pnpm', ['install', '--frozen-lockfile']],
    [['package-lock.json'], 'npm', ['ci']],
    [['yarn.lock'], 'yarn', ['install', '--frozen-lockfile']],
    [['yarn.lock', 'pnpm-lock.yaml'], 'pnpm', ['install', '--frozen-lockfile']],
  ] as const)('%j installs with %s', (files, manager, args) => {
    const dir = temp()
    for (const file of files) writeFileSync(join(dir, file), '')
    expect(dependencyInstall(dir)).toMatchObject({ manager, command: manager, args })
  })

  it('does nothing without a lockfile', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'package.json'), '{}')
    expect(dependencyInstall(dir)).toBeUndefined()
    expect(await installDependencies(dir)).toEqual({ status: 'none' })
  })
})

describe('installDependencies', () => {
  it('runs the package manager in the worktree without a shell, as an argv array', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    const script = fakePackageManager()
    const seen: string[] = []
    const result = await installDependencies(dir, {
      env: { ...process.env, FAKE_PM_EXIT: '0' },
      resolve: (command) => {
        seen.push(command)
        return { command: process.execPath, prefix: [script] }
      },
    })
    expect(seen).toEqual(['pnpm'])
    expect(result).toMatchObject({
      status: 'installed',
      manager: 'pnpm',
      command: 'pnpm install --frozen-lockfile',
      exitCode: 0,
      outputTail: '',
    })
    const call = JSON.parse(readFileSync(join(dir, 'pm-call.json'), 'utf8')) as {
      args: string[]
      cwd: string
    }
    expect(call.args).toEqual(['install', '--frozen-lockfile'])
    expect(call.cwd.toLowerCase()).toContain('joy-deps-')
  })

  it('reports a failure with the end of the output instead of throwing', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    const script = fakePackageManager()
    const result = await installDependencies(dir, {
      env: { ...process.env, FAKE_PM_EXIT: '1' },
      resolve: () => ({ command: process.execPath, prefix: [script] }),
    })
    expect(result).toMatchObject({
      status: 'failed',
      manager: 'npm',
      command: 'npm ci',
      exitCode: 1,
      timedOut: false,
    })
    expect(result.status === 'failed' && result.outputTail).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
  })

  it('reports a package manager that is not installed', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'yarn.lock'), '')
    const result = await installDependencies(dir, {
      resolve: () => ({ command: join(dir, 'no-such-yarn'), prefix: [] }),
    })
    expect(result).toMatchObject({ status: 'failed', manager: 'yarn', exitCode: null })
    expect(result.status === 'failed' && result.spawnError).toBeTruthy()
  })
})
