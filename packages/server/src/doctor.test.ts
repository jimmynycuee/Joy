import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createSystemCommandRunner, hasWindowsBatchShim, runDoctor } from './doctor.js'
import type { DoctorCheck, DoctorCommandResult, DoctorCommandRunner } from './doctor.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'joy-doctor-test-'))
  dirs.push(home)
  return home
}

function checksById(checks: DoctorCheck[]): Map<DoctorCheck['id'], DoctorCheck> {
  return new Map(checks.map((check) => [check.id, check]))
}

function commandRunner(
  responses: Record<string, DoctorCommandResult>,
  calls: Array<{ command: string; args: readonly string[]; captureOutput: boolean }> = [],
): DoctorCommandRunner {
  return async (command, args, captureOutput) => {
    calls.push({ command, args, captureOutput })
    return responses[command] ?? { exitCode: null, spawnErrorCode: 'ENOENT' }
  }
}

describe('Windows CLI shim detection', () => {
  it('detects fake npm-installed Claude and Codex shims without executing them', async () => {
    const directory = tempHome()
    writeFileSync(join(directory, 'claude.cmd'), '@echo off\r\n')
    writeFileSync(join(directory, 'codex.cmd'), '@echo off\r\n')
    writeFileSync(join(directory, 'custom-claude.cmd'), '@echo off\r\n')

    expect(await hasWindowsBatchShim('claude', directory, 'win32')).toBe(true)
    expect(await hasWindowsBatchShim('codex', directory, 'win32')).toBe(true)
    expect(await hasWindowsBatchShim('custom-claude', directory, 'win32')).toBe(true)
    expect(await hasWindowsBatchShim(join(directory, 'claude.cmd'), '', 'win32')).toBe(true)
    expect(await hasWindowsBatchShim('claude', directory, 'linux')).toBe(false)
    expect(await hasWindowsBatchShim('unrelated', directory, 'win32')).toBe(false)
  })

  it('tries shell-free first, then uses a shell only for the fixed version argument', async () => {
    const directory = tempHome()
    writeFileSync(join(directory, 'claude.cmd'), '@echo off\r\n')
    const calls: Array<{ command: string; args: string[]; shell: SpawnOptions['shell'] }> = []
    const runner = createSystemCommandRunner({
      platform: 'win32',
      searchPath: directory,
      spawnCommand: (command, args, options) => {
        calls.push({ command, args, shell: options.shell })
        const child = new EventEmitter() as ChildProcess
        const stdout = new PassThrough()
        Object.assign(child, { stdout, kill: () => true })
        queueMicrotask(() => {
          if (options.shell !== true) {
            child.emit('error', Object.assign(new Error('batch shim requires cmd.exe'), { code: 'ENOENT' }))
          } else {
            stdout.write('Claude Code v2.1.317\n')
            child.emit('close', 0)
          }
        })
        return child
      },
    })

    await expect(runner('claude', ['--version'], true)).resolves.toMatchObject({
      exitCode: 0,
      output: 'Claude Code v2.1.317\n',
    })
    expect(calls).toEqual([
      { command: 'claude', args: ['--version'], shell: false },
      { command: 'claude', args: ['--version'], shell: true },
    ])
  })

  it('does not enable a shell for non-fixed arguments, but still recognizes the shim', async () => {
    const directory = tempHome()
    writeFileSync(join(directory, 'claude.cmd'), '@echo off\r\n')
    const shells: SpawnOptions['shell'][] = []
    const runner = createSystemCommandRunner({
      platform: 'win32',
      searchPath: directory,
      spawnCommand: (_command, _args, options) => {
        shells.push(options.shell)
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { stdout: null, kill: () => true })
        queueMicrotask(() => {
          child.emit('error', Object.assign(new Error('batch shim requires cmd.exe'), { code: 'ENOENT' }))
        })
        return child
      },
    })

    await expect(runner('claude', ['--version', 'untrusted'], true)).resolves.toMatchObject({
      commandFound: true,
    })
    expect(shells).toEqual([false])
  })

  it('reports a found Windows shim as installed but version-untested', async () => {
    const report = await runDoctor({
      home: tempHome(),
      platform: 'win32',
      runCommand: async (command) =>
        command === 'claude' || command === 'codex'
          ? { exitCode: null, commandFound: true }
          : { exitCode: null, spawnErrorCode: 'ENOENT' },
      keychainLookup: async () => {},
    })
    const checks = checksById(report.checks)

    expect(checks.get('claude-cli')).toMatchObject({
      status: 'untested',
      summary: expect.stringContaining('installed as a Windows command shim'),
      repair: expect.stringContaining('No installation repair is needed'),
    })
    expect(checks.get('codex-cli')).toMatchObject({
      status: 'untested',
      summary: expect.stringContaining('installed as a Windows command shim'),
    })
  })
})

describe('runDoctor', () => {
  it('reports available prerequisites, keeps CLI compatibility untested, and omits command and keychain output', async () => {
    const home = tempHome()
    const before = readdirSync(home)
    const calls: Array<{ command: string; args: readonly string[]; captureOutput: boolean }> = []
    const privateOutput = 'Logged in as private-account with credential ghp_do_not_show'
    const report = await runDoctor({
      home,
      nodeVersion: '22.13.0',
      commands: { claude: 'fake-claude', codex: 'fake-codex' },
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      runCommand: commandRunner(
        {
          git: { exitCode: 0, output: 'git version 2.48.1' },
          gh: { exitCode: 0, output: privateOutput },
          'fake-claude': { exitCode: 0, output: 'Claude Code v2.1.317 (private-account)' },
          'fake-codex': { exitCode: 0, output: 'codex-cli 0.104.0 (private-account)' },
        },
        calls,
      ),
      keychainLookup: async (account) => {
        expect(account).toMatch(/^joy-doctor-probe-[0-9a-f-]{36}$/)
        return 'keychain-secret-must-not-appear'
      },
    })
    const checks = checksById(report.checks)

    expect(report.checkedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(checks.get('node')).toMatchObject({
      status: 'ok',
      version: '22.13.0',
      repair: 'No action needed.',
    })
    expect(checks.get('git')).toMatchObject({ status: 'ok', version: '2.48.1' })
    expect(checks.get('gh-auth')).toMatchObject({ status: 'ok' })
    expect(checks.get('claude-cli')).toMatchObject({ status: 'untested', version: '2.1.317' })
    expect(checks.get('codex-cli')).toMatchObject({ status: 'untested', version: '0.104.0' })
    expect(checks.get('keychain')).toMatchObject({ status: 'ok' })
    expect(checks.get('data-directory')).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(report)).not.toContain('private-account')
    expect(JSON.stringify(report)).not.toContain('ghp_do_not_show')
    expect(JSON.stringify(report)).not.toContain('keychain-secret-must-not-appear')
    expect(calls).toContainEqual({
      command: 'gh',
      args: ['auth', 'status', '--hostname', 'github.com'],
      captureOutput: false,
    })
    expect(calls).toContainEqual({ command: 'fake-claude', args: ['--version'], captureOutput: true })
    expect(calls).toContainEqual({ command: 'fake-codex', args: ['--version'], captureOutput: true })
    expect(readdirSync(home)).toEqual(before)
  })

  it('marks missing executables and gives actionable install guidance', async () => {
    const report = await runDoctor({
      home: tempHome(),
      runCommand: commandRunner({
        git: { exitCode: null, spawnErrorCode: 'ENOENT' },
        gh: { exitCode: null, spawnErrorCode: 'ENOENT' },
        claude: { exitCode: null, spawnErrorCode: 'ENOENT' },
        codex: { exitCode: null, spawnErrorCode: 'ENOENT' },
      }),
      keychainLookup: async () => {},
    })
    const checks = checksById(report.checks)

    expect(checks.get('git')).toMatchObject({
      status: 'missing',
      repair: expect.stringContaining('Install Git'),
    })
    expect(checks.get('gh-auth')).toMatchObject({
      status: 'missing',
      repair: expect.stringContaining('gh auth login'),
    })
    expect(checks.get('claude-cli')).toMatchObject({
      status: 'missing',
      repair: expect.stringContaining('Install Claude Code'),
    })
    expect(checks.get('codex-cli')).toMatchObject({
      status: 'missing',
      repair: expect.stringContaining('Install Codex'),
    })
  })

  it('marks unsupported Node as missing and keeps uncertain CLI status untested', async () => {
    const report = await runDoctor({
      home: tempHome(),
      nodeVersion: '20.11.1',
      runCommand: commandRunner({
        git: { exitCode: 0, output: 'unexpected git version output' },
        gh: { exitCode: 1, output: 'private authentication detail' },
        claude: { exitCode: 0, output: 'version output without a parseable version' },
        codex: { exitCode: 1, output: 'private CLI error' },
      }),
      keychainLookup: async () => {},
    })
    const checks = checksById(report.checks)

    expect(checks.get('node')).toMatchObject({
      status: 'missing',
      version: '20.11.1',
      summary: expect.stringContaining("below Joy's declared runtime requirement"),
      repair: expect.stringContaining('Upgrade to Node.js 22.13.0 or later'),
    })
    expect(checks.get('git')).toMatchObject({ status: 'untested' })
    expect(checks.get('gh-auth')).toMatchObject({ status: 'untested' })
    expect(checks.get('claude-cli')).toMatchObject({ status: 'untested' })
    expect(checks.get('codex-cli')).toMatchObject({ status: 'untested' })
    expect(JSON.stringify(report)).not.toContain('private authentication detail')
    expect(JSON.stringify(report)).not.toContain('private CLI error')
  })

  it('reports keychain access failures without surfacing errors and removes the data probe', async () => {
    const home = tempHome()
    const report = await runDoctor({
      home,
      platform: 'linux',
      runCommand: commandRunner({
        git: { exitCode: 0, output: 'git version 2.40.0' },
        gh: { exitCode: 0 },
        claude: { exitCode: 0, output: '2.0.0' },
        codex: { exitCode: 0, output: '1.0.0' },
      }),
      keychainLookup: async () => {
        throw new Error('secret backend details must not appear')
      },
    })
    const checks = checksById(report.checks)

    expect(checks.get('keychain')).toMatchObject({
      status: 'missing',
      repair: expect.stringContaining('Secret Service'),
    })
    expect(JSON.stringify(report)).not.toContain('secret backend details')
    expect(checks.get('data-directory')?.status).toBe('ok')
    expect(readdirSync(home)).toEqual([])
  })

  it('reports an absent or non-directory Joy home as missing without creating it', async () => {
    const parent = tempHome()
    const absentHome = join(parent, 'not-created')
    const report = await runDoctor({
      home: absentHome,
      runCommand: commandRunner({
        git: { exitCode: 0, output: 'git version 2.40.0' },
        gh: { exitCode: 0 },
        claude: { exitCode: 0, output: '2.0.0' },
        codex: { exitCode: 0, output: '1.0.0' },
      }),
      keychainLookup: async () => {},
    })

    expect(checksById(report.checks).get('data-directory')).toMatchObject({
      status: 'missing',
      repair: expect.stringContaining('automatically when the server starts'),
    })
    expect(readdirSync(parent)).toEqual([])
  })
})
