import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RunOptions } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeCli, fixturePath } from '../../test-support/fixtures.js'
import { CodexCliProvider } from './provider.js'

const model = { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' } as const
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(env: Record<string, string>, timeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-codex-test-'))
  dirs.push(dir)
  const argsOut = join(dir, 'args.json')
  const provider = new CodexCliProvider({
    mode: 'exec',
    command: process.execPath,
    argsPrefix: [fakeCli],
    env: { ...process.env, FAKE_ARGS_OUT: argsOut, ...env },
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  return { dir, provider, received: () => JSON.parse(readFileSync(argsOut, 'utf8')) as { args: string[] } }
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

describe('CodexCliProvider: long prompts', () => {
  it('sends a long prompt on stdin with `-` instead of one huge argument', async () => {
    // setup() only gives the folder and the argv reader; this run also records stdin.
    const { dir, received } = setup({})
    const stdinOut = join(dir, 'stdin.txt')
    const big = `fix it\n${'x'.repeat(200 * 1024)}`
    const run = new CodexCliProvider({
      mode: 'exec',
      command: process.execPath,
      argsPrefix: [fakeCli],
      env: {
        ...process.env,
        FAKE_ARGS_OUT: join(dir, 'args.json'),
        FAKE_REPLAY: fixturePath('codex', 'synthetic-edit'),
        FAKE_READ_STDIN: '1',
        FAKE_STDIN_OUT: stdinOut,
      },
    })
    const events = await collect(run.run(opts(dir, { prompt: big }), model))
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
    expect(received().args.slice(-2)).toEqual(['--', '-'])
    expect(readFileSync(stdinOut, 'utf8')).toBe(`${big}\n`)
  })

  it('refuses a prompt too long for the command line when the wrapper gives no stdin (containers)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-codex-test-'))
    dirs.push(dir)
    const seen: Array<string[] | undefined> = []
    const provider = new CodexCliProvider({
      mode: 'exec',
      command: process.execPath,
      wrap: (run) => {
        seen.push(run.readFiles)
        return Promise.resolve({ command: run.command, args: [fakeCli, ...run.args] })
      },
    })
    await expect(collect(provider.run(opts(dir, { prompt: 'x'.repeat(101 * 1024) }), model))).rejects.toThrow(
      /too long for the command line in container mode.*long diffs, long messages, check output/,
    )
    // A short prompt still runs, and the wrapper is told which files to mount.
    await collect(
      provider.run(
        opts(dir, { images: [{ path: '/joy/attachments/a.png', mediaType: 'image/png' }] }),
        model,
      ),
    )
    expect(seen).toEqual([['/joy/attachments/a.png']])
  })
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
    const { capabilities } = new CodexCliProvider({ mode: 'exec' })
    expect(capabilities.presetSessionId).toBe(false)
    expect(capabilities.delegatedApproval).toBe(false)
  })
})

describe('spawn errors', () => {
  it('says the working directory is missing instead of blaming the CLI', async () => {
    const provider = new CodexCliProvider({ command: process.execPath })
    const missing = join(tmpdir(), 'joy-definitely-missing-worktree')
    await expect(collect(provider.run(opts(missing), model))).rejects.toThrow(
      /working directory does not exist/,
    )
  })
})
