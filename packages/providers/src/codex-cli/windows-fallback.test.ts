import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RunOptions } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeCli, fakeWsl, fixturePath } from '../../test-support/fixtures.js'
import { CodexCliProvider } from './provider.js'
import { CodexStreamParser } from './parse.js'

const model = { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' } as const
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function expectedWslPath(hostPath: string): string {
  const drivePath = /^([a-z]):[\\/](.*)$/i.exec(hostPath)
  return drivePath ? `/mnt/${drivePath[1]?.toLowerCase()}/${drivePath[2]?.replaceAll('\\', '/')}` : hostPath
}

function setup(
  env: Record<string, string>,
  options: { command: string; argsPrefix?: string[]; wslCommand?: string; wslArgsPrefix?: string[] },
) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-codex-windows-test-'))
  dirs.push(dir)
  const nativeArgsOut = join(dir, 'native-args.json')
  const wslArgsOut = join(dir, 'wsl-args.json')
  const provider = new CodexCliProvider({
    platform: 'win32',
    command: options.command,
    argsPrefix: options.argsPrefix ?? [],
    wslCommand: options.wslCommand ?? process.execPath,
    wslArgsPrefix: options.wslArgsPrefix ?? [fakeWsl],
    env: { ...process.env, FAKE_ARGS_OUT: nativeArgsOut, FAKE_WSL_ARGS_OUT: wslArgsOut, ...env },
  })
  return {
    dir,
    provider,
    nativeArgs: () => JSON.parse(readFileSync(nativeArgsOut, 'utf8')) as { args: string[] },
    wslArgs: () => JSON.parse(readFileSync(wslArgsOut, 'utf8')) as { cwd: string; args: string[] },
  }
}

const opts = (cwd: string, over: Partial<RunOptions> = {}): RunOptions => ({
  cwd,
  prompt: 'fix it',
  autonomy: 'workspace-write',
  signal: new AbortController().signal,
  ...over,
})

async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = []
  for await (const event of it) out.push(event)
  return out
}

describe('Windows Codex fallback', () => {
  it('normalizes WSL file-change paths relative to the Linux worktree', () => {
    const parser = new CodexStreamParser({ cwd: '/mnt/c/project', cwdStyle: 'posix' })
    expect(
      parser.push({
        type: 'item.completed',
        item: {
          id: 'file',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: '/mnt/c/project/src/index.ts', kind: 'update' }],
        },
      }),
    ).toEqual([{ type: 'file_change', path: 'src/index.ts', kind: 'modify' }])
  })

  it('uses native Codex when version and exec probes pass', async () => {
    const { dir, provider, nativeArgs } = setup(
      { FAKE_REPLAY: fixturePath('codex', 'synthetic-edit') },
      { command: process.execPath, argsPrefix: [fakeCli], wslCommand: 'joy-wsl-must-not-run' },
    )
    const events = await collect(provider.run(opts(dir), model))
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
    expect(nativeArgs().args).toContain('exec')
  })

  it('uses WSL when the native CLI is installed but its exec interface is unsupported', async () => {
    const { dir, provider, wslArgs } = setup(
      {
        FAKE_EXEC_HELP_FAIL: '1',
        FAKE_REPLAY: fixturePath('codex', 'synthetic-edit'),
      },
      { command: process.execPath, argsPrefix: [fakeCli] },
    )
    const health = await provider.healthCheck()
    expect(health).toMatchObject({ ok: true, installed: true, loggedIn: 'unknown' })
    expect(health.detail).toMatch(/available through WSL/)

    const events = await collect(provider.run(opts(dir, { outputSchema: { type: 'object' } }), model))
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
    const execution = wslArgs()
    expect(execution.cwd).toBe(expectedWslPath(dir))
    expect(execution.args).toEqual(expect.arrayContaining(['exec', '--json', '--output-schema']))
    const schemaPath = execution.args[execution.args.indexOf('--output-schema') + 1] ?? ''
    expect(schemaPath).toMatch(/schema\.json$/)
  })

  it('fails before running a task when native and WSL Codex are unavailable', async () => {
    const { dir, provider } = setup(
      { FAKE_WSL_MODE: 'missing' },
      { command: 'joy-native-codex-not-installed' },
    )
    await expect(collect(provider.run(opts(dir), model))).rejects.toThrow(/not usable on Windows.*WSL Codex/)
  })
})
