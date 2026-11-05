import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DoctorCommandRunner, DoctorOptions } from './index.js'
import { runDoctor } from './index.js'

const temporaryDirectories: string[] = []

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'joy-doctor-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('runDoctor', () => {
  it('runs all probes independently and reports successful CLI versions as untested', async () => {
    const root = await makeTempDirectory()
    const home = join(root, 'joy-home')
    const dataDirectory = join(root, 'joy-data')
    const invocations: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = []
    const commandRunner: DoctorCommandRunner = async (command, args, { timeoutMs }) => {
      invocations.push({ command, args, timeoutMs })
      if (command === 'git')
        return { code: 0, stdout: 'git version 2.49.1\n', timedOut: false, failedToStart: false }
      if (command === 'gh' && args[0] === '--version') {
        return { code: 0, stdout: 'gh version 2.75.0 (2025-01-01)\n', timedOut: false, failedToStart: false }
      }
      if (command === 'gh') {
        return {
          code: 0,
          stdout: 'private auth output must never appear',
          timedOut: false,
          failedToStart: false,
        }
      }
      if (command === '/configured claude') {
        return { code: 0, stdout: '2.0.10 (Claude Code)\n', timedOut: false, failedToStart: false }
      }
      return { code: 0, stdout: 'codex-cli 0.45.0\n', timedOut: false, failedToStart: false }
    }
    const keychainCalls: string[] = []
    const options: DoctorOptions = {
      home,
      dataDirectory,
      commands: { claude: '/configured claude' },
      env: { JOY_HOME: join(root, 'ignored-env-home') },
      nodeVersion: 'v22.13.1',
      now: () => new Date('2026-11-05T12:00:00.000Z'),
      commandRunner,
      keychain: {
        get: async (name) => {
          keychainCalls.push(name)
          return null
        },
      },
    }

    const report = await runDoctor(options)

    expect(report.checkedAt).toBe('2026-11-05T12:00:00.000Z')
    expect(report.checks.map(({ id, status }) => [id, status])).toEqual([
      ['node', 'ok'],
      ['git', 'ok'],
      ['gh-installation', 'ok'],
      ['gh-authentication', 'ok'],
      ['claude-cli', 'untested'],
      ['codex-cli', 'untested'],
      ['keychain', 'ok'],
      ['data-directory', 'ok'],
    ])
    expect(report.checks.find(({ id }) => id === 'claude-cli')?.detail).toContain('Version 2.0.10')
    expect(report.checks.find(({ id }) => id === 'codex-cli')?.detail).toContain('Version 0.45.0')
    expect(invocations).toEqual(
      expect.arrayContaining([
        { command: 'git', args: ['--version'], timeoutMs: 5_000 },
        { command: 'gh', args: ['--version'], timeoutMs: 5_000 },
        { command: 'gh', args: ['auth', 'status'], timeoutMs: 5_000 },
        { command: '/configured claude', args: ['--version'], timeoutMs: 5_000 },
        { command: 'codex', args: ['--version'], timeoutMs: 5_000 },
      ]),
    )
    expect(keychainCalls).toHaveLength(1)
    expect(keychainCalls[0]).toMatch(/^joy-doctor-probe-[0-9a-f-]{36}$/)
    expect(await readdir(dataDirectory)).toEqual([])
  })

  it.each([
    ['v22.12.99', 'missing'],
    ['v22.13.0', 'ok'],
    ['v23.0.0', 'ok'],
  ] as const)('checks Node minimum version %s', async (nodeVersion, status) => {
    const root = await makeTempDirectory()
    const report = await runDoctor({
      home: join(root, 'home'),
      dataDirectory: join(root, 'data'),
      nodeVersion,
      commandRunner: async () => ({ code: 0, stdout: '', timedOut: false, failedToStart: false }),
      keychain: { get: async () => null },
      dataDirectoryProbe: async () => {},
    })
    expect(report.checks.find(({ id }) => id === 'node')?.status).toBe(status)
  })

  it('reports failures independently and never includes raw authentication or keychain errors', async () => {
    const root = await makeTempDirectory()
    const commandRunner: DoctorCommandRunner = async (command, args) => {
      if (command === 'git') throw new Error('secret command failure')
      if (command === 'gh' && args[0] === '--version') {
        return { code: 0, stdout: 'gh version 2.75.0\n', timedOut: false, failedToStart: false }
      }
      if (command === 'gh') {
        return { code: 1, stdout: 'TOP_SECRET_AUTH_OUTPUT', timedOut: false, failedToStart: false }
      }
      if (command === 'claude') {
        return { code: 127, stdout: '', timedOut: false, failedToStart: false }
      }
      return { code: 0, stdout: 'codex-cli 0.45.0', timedOut: false, failedToStart: false }
    }

    const report = await runDoctor({
      home: join(root, 'home'),
      dataDirectory: join(root, 'data'),
      nodeVersion: 'v18.20.2',
      timeoutMs: 73,
      commandRunner,
      keychain: { get: async () => Promise.reject(new Error('KEYCHAIN_SECRET_ERROR')) },
      dataDirectoryProbe: async () => Promise.reject(new Error('write failure')),
    })

    const checks = new Map(report.checks.map((check) => [check.id, check]))
    expect(checks.get('node')?.status).toBe('missing')
    expect(checks.get('git')?.status).toBe('missing')
    expect(checks.get('gh-installation')?.status).toBe('ok')
    expect(checks.get('gh-authentication')).toMatchObject({
      status: 'missing',
      repair: expect.stringContaining('gh auth login'),
    })
    expect(checks.get('claude-cli')?.status).toBe('missing')
    expect(checks.get('codex-cli')?.status).toBe('untested')
    expect(checks.get('keychain')).toMatchObject({
      status: 'missing',
      repair: expect.stringContaining('Keychain'),
    })
    expect(checks.get('data-directory')?.status).toBe('missing')
    expect(JSON.stringify(report)).not.toContain('TOP_SECRET_AUTH_OUTPUT')
    expect(JSON.stringify(report)).not.toContain('KEYCHAIN_SECRET_ERROR')
    expect(JSON.stringify(report)).not.toContain('secret command failure')
    expect(checks.get('gh-authentication')?.detail).not.toContain('TOP_SECRET_AUTH_OUTPUT')
  })

  it('uses executable overrides loaded from Joy config without shell tokenization', async () => {
    const root = await makeTempDirectory()
    const home = join(root, 'home')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(home, { recursive: true }))
    await writeFile(
      join(home, 'config.yaml'),
      'providers:\n  claude:\n    command: "/path with spaces/claude"\n  codex:\n    command: /custom/codex\n',
    )
    const invocations: Array<{ command: string; args: readonly string[] }> = []
    const commandRunner: DoctorCommandRunner = async (command, args) => {
      invocations.push({ command, args })
      return { code: 0, stdout: 'v1.2.3', timedOut: false, failedToStart: false }
    }

    await runDoctor({
      home,
      dataDirectory: join(root, 'data'),
      commandRunner,
      keychain: { get: async () => null },
    })

    expect(invocations).toContainEqual({ command: '/path with spaces/claude', args: ['--version'] })
    expect(invocations).toContainEqual({ command: '/custom/codex', args: ['--version'] })
  })

  it('marks a timed-out CLI as missing while continuing the remaining checks', async () => {
    const root = await makeTempDirectory()
    const commandRunner: DoctorCommandRunner = async (command) => ({
      code: command === 'claude' ? null : 0,
      stdout: '',
      timedOut: command === 'claude',
      failedToStart: false,
    })
    const report = await runDoctor({
      home: join(root, 'home'),
      dataDirectory: join(root, 'data'),
      commandRunner,
      keychain: { get: async () => null },
    })
    expect(report.checks.find(({ id }) => id === 'claude-cli')?.status).toBe('missing')
    expect(report.checks.find(({ id }) => id === 'data-directory')?.status).toBe('ok')
  })
})
