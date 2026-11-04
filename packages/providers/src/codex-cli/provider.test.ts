import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RunOptions } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeCli, fakeWsl, fixturePath } from '../../test-support/fixtures.js'
import { CodexCliProvider } from './provider.js'

const model = { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' } as const
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(
  env: Record<string, string>,
  timeoutMs?: number,
  options: {
    platform?: NodeJS.Platform
    command?: string
    argsPrefix?: string[]
    wslCommand?: string
    wslArgsPrefix?: string[]
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-codex-test-'))
  dirs.push(dir)
  const argsOut = join(dir, 'args.json')
  const wslArgsOut = join(dir, 'wsl-args.json')
  const provider = new CodexCliProvider({
    command: options.command ?? process.execPath,
    argsPrefix: options.argsPrefix ?? [fakeCli],
    env: { ...process.env, FAKE_ARGS_OUT: argsOut, FAKE_WSL_ARGS_OUT: wslArgsOut, ...env },
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.wslCommand ? { wslCommand: options.wslCommand } : {}),
    ...(options.wslArgsPrefix ? { wslArgsPrefix: options.wslArgsPrefix } : {}),
  })
  return {
    dir,
    provider,
    received: () => JSON.parse(readFileSync(argsOut, 'utf8')) as { args: string[] },
    receivedWsl: () => JSON.parse(readFileSync(wslArgsOut, 'utf8')) as { cwd: string; args: string[] },
  }
}

async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const opts = (cwd: string, over: Partial<RunOptions> = {}): RunOptions => ({
  cwd,
  prompt: 'fix it',
  autonomy: 'workspace-write',
  signal: new AbortController().signal,
  ...over,
})

describe('CodexCliProvider', () => {
  it('replays a stream into normalized events', async () => {
    const { dir, provider, received } = setup({ FAKE_REPLAY: fixturePath('codex', 'synthetic-edit') })
    const events = await collect(provider.run(opts(dir), model))
    expect(events[0]?.type).toBe('session_started')
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
    expect(received().args).toEqual(
      expect.arrayContaining(['exec', '--json', '-c', 'model_reasoning_effort="low"']),
    )
  })

  it('keeps a usable native Windows Codex command ahead of the WSL fallback', async () => {
    const { dir, provider, received } = setup(
      { FAKE_REPLAY: fixturePath('codex', 'synthetic-edit') },
      undefined,
      {
        platform: 'win32',
        command: process.execPath,
        argsPrefix: [fakeCli],
        wslCommand: 'joy-wsl-should-not-run',
      },
    )
    const events = await collect(provider.run(opts(dir), model))
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
    expect(received().args).toContain('exec')
  })

  it('detects Codex in WSL and falls back when native Windows exec is unsupported', async () => {
    const { dir, provider, receivedWsl } = setup(
      {
        FAKE_EXEC_HELP_FAIL: '1',
        FAKE_REPLAY: fixturePath('codex', 'synthetic-edit'),
      },
      undefined,
      {
        platform: 'win32',
        command: process.execPath,
        argsPrefix: [fakeCli],
        wslCommand: process.execPath,
        wslArgsPrefix: [fakeWsl],
      },
    )
    const health = await provider.healthCheck()
    expect(health).toMatchObject({ ok: true, installed: true, loggedIn: 'unknown' })
    expect(health.detail).toMatch(/available through WSL/)

    const events = await collect(provider.run(opts(dir, { outputSchema: { type: 'object' } }), model))
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
    const execution = receivedWsl()
    expect(execution.cwd).toBe(dir)
    expect(execution.args).toEqual(expect.arrayContaining(['exec', '--json', '--output-schema']))
    expect(execution.args[execution.args.indexOf('--output-schema') + 1]).toMatch(/schema\.json$/)
  })

  it('fails clearly when neither native Codex nor WSL Codex is usable', async () => {
    const { dir, provider } = setup({ FAKE_WSL_MODE: 'missing' }, undefined, {
      platform: 'win32',
      command: 'joy-native-codex-not-installed',
      wslCommand: process.execPath,
      wslArgsPrefix: [fakeWsl],
    })
    await expect(collect(provider.run(opts(dir), model))).rejects.toThrow(/not usable on Windows.*WSL Codex/)
  })

  it('writes the output schema to a temp file and removes it afterwards', async () => {
    const { dir, provider, received } = setup({ FAKE_REPLAY: fixturePath('codex', 'synthetic-edit') })
    await collect(provider.run(opts(dir, { outputSchema: { type: 'object' } }), model))
    const args = received().args
    const schemaPath = args[args.indexOf('--output-schema') + 1] ?? ''
    expect(schemaPath).toMatch(/schema\.json$/)
    expect(existsSync(schemaPath)).toBe(false)
  })

  it('stops a Codex that keeps retrying without a network', async () => {
    const { dir, provider } = setup({ FAKE_MODE: 'hang' }, 300)
    const events = await collect(provider.run(opts(dir), model))
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/Codex did not finish/) })
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true })
  })

  it('throws a helpful error when Codex is not installed', async () => {
    const provider = new CodexCliProvider({ command: 'joy-definitely-not-installed' })
    await expect(collect(provider.run(opts(tmpdir()), model))).rejects.toThrow(/Codex CLI not found/)
  })

  it('cannot preset session ids or delegate approvals', () => {
    const { capabilities } = new CodexCliProvider()
    expect(capabilities.presetSessionId).toBe(false)
    expect(capabilities.delegatedApproval).toBe(false)
  })
})
