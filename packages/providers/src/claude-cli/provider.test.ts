import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RunOptions, Steer } from '@joy/core'
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

// Streaming input (`--input-format stream-json`) against a synthetic stand-in: the real CLI's handling of a message
// that arrives mid-turn is not recorded yet (docs/spikes/claude-code.md).
describe('ClaudeCliProvider.run with steering', () => {
  function steered(env: Record<string, string> = {}) {
    const out = mkdtempSync(join(tmpdir(), 'joy-claude-stdin-'))
    dirs.push(out)
    const stdinOut = join(out, 'stdin.jsonl')
    const s = setup({ FAKE_MODE: 'stream', FAKE_STDIN_OUT: stdinOut, ...env })
    const stdin = () =>
      readFileSync(stdinOut, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown)
    return { ...s, stdin }
  }
  async function run(
    provider: ClaudeCliProvider,
    dir: string,
    onEvent: (event: AgentEvent, steer: Steer | undefined) => void,
  ) {
    const offered: Array<Steer | undefined> = []
    const events: AgentEvent[] = []
    for await (const event of provider.run(
      opts(dir, { resumeSessionId: 'abc', onSteer: (steer) => offered.push(steer) }),
      model,
    )) {
      events.push(event)
      onEvent(event, offered.at(-1))
    }
    return { events, offered }
  }

  it('sends the prompt on stdin, keeps the process for owner messages, then closes stdin at the result', async () => {
    const { dir, provider, received, stdin } = steered()
    const results: Array<Promise<boolean>> = []
    const { events, offered } = await run(provider, dir, (event, steer) => {
      if (event.type === 'session_started' && steer) results.push(steer('also update the docs'))
    })
    expect(await Promise.all(results)).toEqual([true])
    const args = received().args
    expect(args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--resume', 'abc']))
    expect(args).not.toContain('--')
    expect(args).not.toContain('fix it')
    expect(stdin()).toEqual([
      { type: 'user', message: { role: 'user', content: 'fix it' }, parent_tool_use_id: null },
      {
        type: 'user',
        message: { role: 'user', content: 'also update the docs' },
        parent_tool_use_id: null,
      },
    ])
    expect(events.some((e) => e.type === 'message' && e.text === 'steered: also update the docs')).toBe(true)
    expect(events.filter((e) => e.type === 'done')).toEqual([
      expect.objectContaining({ type: 'done', isError: false, finalMessage: 'turn 1 done' }),
    ])
    expect(offered.map((steer) => typeof steer)).toEqual(['function', 'undefined'])
    expect(await offered[0]?.('too late')).toBe(false)
  })

  it('answers a message the CLI queued as its own turn before exiting, with a single done', async () => {
    const { dir, provider } = steered({ FAKE_STREAM_QUEUE: '1' })
    let sent = false
    const { events } = await run(provider, dir, (event, steer) => {
      if (event.type === 'message' && !sent && steer) {
        sent = true
        void steer('and the changelog')
      }
    })
    // Usage is taken once, from the last result (the fake's cost is cumulative), never summed.
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 20, outputTokens: 10, costUsd: 0.02 },
    ])
    expect(events.filter((e) => e.type === 'done')).toEqual([
      expect.objectContaining({ isError: false, finalMessage: 'turn 2 done' }),
    ])
    expect(events.some((e) => e.type === 'message' && e.text === 'got: and the changelog')).toBe(true)
  })

  async function twoTurns(failTurns: string) {
    const { dir, provider } = steered({ FAKE_STREAM_QUEUE: '1', FAKE_STREAM_FAIL_TURNS: failTurns })
    let sent = false
    const { events } = await run(provider, dir, (event, steer) => {
      if (event.type === 'message' && !sent && steer) {
        sent = true
        void steer('and the changelog')
      }
    })
    return events
  }

  it('keeps finished work when the turn for an owner message fails, and shows that failure', async () => {
    const events = await twoTurns('2')
    expect(events.filter((e) => e.type === 'error')).toEqual([
      {
        type: 'error',
        message: "Claude Code could not finish the turn for the owner's added message: turn 2 failed",
        recoverable: true,
      },
    ])
    expect(events.filter((e) => e.type === 'done')).toEqual([
      expect.objectContaining({ isError: false, finalMessage: 'turn 1 done' }),
    ])
  })

  it('stays failed when the work failed, even if the turn for an owner message succeeds', async () => {
    const events = await twoTurns('1')
    expect(events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', message: 'turn 1 failed', recoverable: false },
    ])
    expect(events.filter((e) => e.type === 'done')).toEqual([
      expect.objectContaining({ isError: true, finalMessage: 'turn 1 failed' }),
    ])
  })

  it('ends without owner messages like a one-shot run', async () => {
    const { dir, provider, stdin } = steered()
    const { events } = await run(provider, dir, () => {})
    expect(stdin()).toHaveLength(1)
    expect(events[0]?.type).toBe('session_started')
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
  })

  it('cancels a streaming run and refuses messages afterwards', async () => {
    const { dir, provider, received } = steered({ FAKE_STREAM_HOLD_MS: '60000' })
    const controller = new AbortController()
    let steer: Steer | undefined
    const events: AgentEvent[] = []
    for await (const event of provider.run(
      opts(dir, { signal: controller.signal, onSteer: (s) => (steer ??= s) }),
      model,
    )) {
      events.push(event)
      if (event.type === 'session_started') controller.abort()
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true })
    expect(await steer?.('late')).toBe(false)
    await waitFor(() => !alive(received().pid))
  })

  it('steers through a wrapper that forwards stdin for this worktree', async () => {
    const out = mkdtempSync(join(tmpdir(), 'joy-claude-stdin-'))
    dirs.push(out)
    const stdinOut = join(out, 'stdin.jsonl')
    const dir = mkdtempSync(join(tmpdir(), 'joy-claude-test-'))
    dirs.push(dir)
    const forwarded: string[] = []
    const provider = new ClaudeCliProvider({
      command: process.execPath,
      env: { ...process.env, FAKE_MODE: 'stream', FAKE_STDIN_OUT: stdinOut },
      // Like the server's container wrapper for a repository that is not in a container: unchanged.
      wrap: ({ command, args }) => Promise.resolve({ command, args: [fakeCli, ...args] }),
      forwardsStdin: (cwd) => {
        forwarded.push(cwd)
        return true
      },
    })
    const results: Array<Promise<boolean>> = []
    await collect(
      provider.run(
        opts(dir, {
          onSteer: (steer) => {
            if (steer) results.push(steer('more'))
          },
        }),
        model,
      ),
    )
    expect(forwarded).toEqual([dir])
    expect(await Promise.all(results)).toEqual([true])
    expect(readFileSync(stdinOut, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('sends attached images as base64 image blocks on stdin, also without steering', async () => {
    const { dir, provider, received, stdin } = steered()
    const image = join(dir, 'shot.png')
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const events = await collect(
      provider.run(opts(dir, { images: [{ path: image, mediaType: 'image/png' }] }), model),
    )
    expect(received().args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']))
    expect(received().args).not.toContain('fix it')
    expect(stdin()).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'fix it' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } },
          ],
        },
        parent_tool_use_id: null,
      },
    ])
    expect(events.filter((e) => e.type === 'done')).toEqual([expect.objectContaining({ isError: false })])
  })

  it('steers with images', async () => {
    const { dir, provider, stdin } = steered()
    const image = join(dir, 'later.gif')
    writeFileSync(image, 'GIF89a')
    const results: Array<Promise<boolean>> = []
    await run(provider, dir, (event, steer) => {
      if (event.type === 'session_started' && steer)
        results.push(steer('look', [{ path: image, mediaType: 'image/gif' }]))
    })
    expect(await Promise.all(results)).toEqual([true])
    expect(stdin()[1]).toMatchObject({
      message: {
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image',
            source: { media_type: 'image/gif', data: Buffer.from('GIF89a').toString('base64') },
          },
        ],
      },
    })
  })

  it('refuses images in a container run instead of dropping them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-claude-test-'))
    dirs.push(dir)
    const provider = new ClaudeCliProvider({
      command: process.execPath,
      wrap: ({ command, args }) => Promise.resolve({ command, args: [fakeCli, ...args] }),
      forwardsStdin: () => false,
    })
    await expect(
      collect(
        provider.run(opts(dir, { images: [{ path: join(dir, 'x.png'), mediaType: 'image/png' }] }), model),
      ),
    ).rejects.toThrow(/container mode/)
  })

  it('fails clearly when an attached image is missing', async () => {
    const { dir, provider } = steered()
    await expect(
      collect(
        provider.run(opts(dir, { images: [{ path: join(dir, 'gone.png'), mediaType: 'image/png' }] }), model),
      ),
    ).rejects.toThrow(/attached image could not be read/)
  })

  it('keeps the one-shot command line when the run is wrapped (containers do not forward stdin)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-claude-test-'))
    dirs.push(dir)
    const argsOut = join(dir, 'args.json')
    const provider = new ClaudeCliProvider({
      command: process.execPath,
      env: { ...process.env, FAKE_ARGS_OUT: argsOut, FAKE_REPLAY: fixturePath('claude', 'edit') },
      wrap: ({ command, args }) => Promise.resolve({ command, args: [fakeCli, ...args] }),
    })
    const offered: unknown[] = []
    await collect(provider.run(opts(dir, { onSteer: (steer) => offered.push(steer) }), model))
    const { args } = JSON.parse(readFileSync(argsOut, 'utf8')) as { args: string[] }
    expect(args.slice(-2)).toEqual(['--', 'fix it'])
    expect(offered).toEqual([])
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
