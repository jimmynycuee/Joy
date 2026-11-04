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
    platform: 'linux',
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
    const { capabilities } = new CodexCliProvider()
    expect(capabilities.presetSessionId).toBe(false)
    expect(capabilities.delegatedApproval).toBe(false)
  })
})
