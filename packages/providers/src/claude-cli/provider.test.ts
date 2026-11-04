import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RunOptions } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeCli, fixturePath } from '../../test-support/fixtures.js'
import { ClaudeCliProvider } from './provider.js'

const model = { provider: 'claude-cli', model: 'haiku' } as const
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(env: Record<string, string>, timeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-claude-test-'))
  dirs.push(dir)
  const argsOut = join(dir, 'args.json')
  const provider = new ClaudeCliProvider({
    command: process.execPath,
    argsPrefix: [fakeCli],
    env: { ...process.env, FAKE_ARGS_OUT: argsOut, ...env },
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  const received = () => JSON.parse(readFileSync(argsOut, 'utf8')) as { args: string[]; pid: number }
  return { dir, provider, received }
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('ClaudeCliProvider.run', () => {
  it('replays a real stream into normalized events', async () => {
    const { dir, provider, received } = setup({ FAKE_REPLAY: fixturePath('claude', 'edit') })
    const events = await collect(provider.run(opts(dir), model))
    expect(events[0]?.type).toBe('session_started')
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
    expect(received().args.slice(-2)).toEqual(['--', 'fix it'])
  })

  it('writes the MCP config to a private temp file and removes it afterwards', async () => {
    const { dir, provider, received } = setup({
      FAKE_CAT_MCP: '1',
      FAKE_REPLAY: fixturePath('claude', 'resume-1'),
    })
    const events = await collect(
      provider.run(
        opts(dir, { mcpServers: [{ name: 'joy', transport: 'stdio', command: 'node', args: ['hub.js'] }] }),
        model,
      ),
    )
    const raw = events.find((e) => e.type === 'raw' && (e.payload as { type?: string }).type === 'fake_mcp')
    expect(raw).toMatchObject({
      payload: { config: { mcpServers: { joy: { command: 'node', args: ['hub.js'] } } } },
    })
    const args = received().args
    const path = args[args.indexOf('--mcp-config') + 1] ?? ''
    expect(existsSync(path)).toBe(false)
  })

  it('cancels: kills the process and ends with a failing done', async () => {
    const { dir, provider, received } = setup({ FAKE_MODE: 'hang' })
    const controller = new AbortController()
    const run = collect(provider.run(opts(dir, { signal: controller.signal }), model))
    await waitFor(() => existsSync(join(dir, 'args.json')))
    controller.abort()
    const events = await run
    expect(events).toEqual([
      { type: 'error', message: 'Cancelled', recoverable: false },
      { type: 'done', sessionId: '', isError: true },
    ])
    await waitFor(() => !alive(received().pid))
  })

  it('times out a stuck CLI', async () => {
    const { dir, provider } = setup({ FAKE_MODE: 'hang' }, 300)
    const events = await collect(provider.run(opts(dir), model))
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/did not finish/) })
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true })
  })

  it('reports a CLI that exits without a result, including stderr', async () => {
    const { dir, provider } = setup({ FAKE_MODE: 'exit3' })
    const events = await collect(provider.run(opts(dir), model))
    expect(events[0]).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/code 3.*not logged in/s),
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true })
  })

  it('keeps non-JSON output as raw', async () => {
    const { dir, provider } = setup({ FAKE_MODE: 'garbage' })
    const events = await collect(provider.run(opts(dir), model))
    expect(events[0]).toEqual({ type: 'raw', source: 'claude-cli', payload: 'not json' })
  })

  it('throws a helpful error when the CLI is not installed', async () => {
    const provider = new ClaudeCliProvider({ command: 'joy-definitely-not-installed' })
    await expect(collect(provider.run(opts(tmpdir()), model))).rejects.toThrow(/Claude Code CLI not found/)
  })
})

describe('ClaudeCliProvider.healthCheck', () => {
  it('reports a missing CLI', async () => {
    const health = await new ClaudeCliProvider({ command: 'joy-definitely-not-installed' }).healthCheck()
    expect(health).toMatchObject({ ok: false, installed: false })
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
