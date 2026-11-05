import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RunOptions } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { fixturePath, fakeCodexAppServer } from '../../test-support/fixtures.js'
import { syntheticCodexAppServerFixture } from '../../test-support/codex-app-server-fixtures.js'
import { CodexAppServerProvider } from './app-server.js'
import { CodexCliProvider } from './provider.js'

const model = { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' } as const
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureFor(cwd: string) {
  return JSON.parse(
    JSON.stringify(syntheticCodexAppServerFixture).replaceAll('/tmp/joy-worktree', cwd),
  ) as typeof syntheticCodexAppServerFixture
}

function setup(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-codex-app-server-test-'))
  dirs.push(dir)
  const rpcPath = join(dir, 'rpc.jsonl')
  const approvalsPath = join(dir, 'approvals.jsonl')
  const fixture = fixtureFor(dir)
  const env = {
    FAKE_APP_SERVER_FIXTURE: JSON.stringify(fixture),
    FAKE_RPC_OUT: rpcPath,
    FAKE_APPROVALS_OUT: approvalsPath,
    ...extraEnv,
  }
  return {
    dir,
    env,
    rpcPath,
    approvalsPath,
    readLines: (path: string) =>
      readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

const opts = (cwd: string, over: Partial<RunOptions> = {}): RunOptions => ({
  cwd,
  prompt: 'fix it',
  autonomy: 'workspace-write',
  signal: new AbortController().signal,
  ...over,
})

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('Codex app-server', () => {
  it('uses the persistent JSON-RPC lifecycle, maps events and answers policy approvals', async () => {
    const { dir, rpcPath, approvalsPath, readLines } = setup()
    const fixture = fixtureFor(dir)
    const approvalRequests: string[] = []
    const events = await collect(
      new CodexAppServerProvider({
        command: process.execPath,
        argsPrefix: [fakeCodexAppServer],
        env: {
          FAKE_APP_SERVER_FIXTURE: JSON.stringify(fixture),
          FAKE_RPC_OUT: rpcPath,
          FAKE_APPROVALS_OUT: approvalsPath,
        },
        timeoutMs: 5_000,
        approvalHandler: (request, runOptions) => {
          approvalRequests.push(`${request.method}:${runOptions.autonomy}`)
          return request.method === 'item/fileChange/requestApproval' ? 'decline' : 'accept'
        },
      }).run(
        opts(dir, {
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          mcpServers: [
            {
              name: 'joy',
              transport: 'stdio',
              command: 'node',
              args: ['tool-hub.mjs'],
              env: { JOY_TEST: '1' },
            },
            {
              name: 'remote',
              transport: 'http',
              url: 'https://mcp.example.test',
              headers: { authorization: 'test' },
            },
          ],
        }),
        model,
      ),
    )

    expect(events[0]).toEqual({ type: 'session_started', sessionId: 'thread-synthetic-1' })
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false, structured: { ok: true } })
    expect(events.filter((event) => event.type === 'quota').map((event) => event.status)).toEqual([
      'warning',
      'limited',
    ])
    expect(events.filter((event) => event.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'command-1', name: 'shell', input: { command: 'echo safe' } },
    ])
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      id: 'command-1',
      output: { output: 'safe\n', exitCode: 0 },
      isError: false,
    })
    expect(events.find((event) => event.type === 'file_change')).toEqual({
      type: 'file_change',
      path: 'src/example.ts',
      kind: 'modify',
    })
    expect(events.find((event) => event.type === 'message')).toEqual({ type: 'message', text: '{"ok":true}' })
    expect(approvalRequests).toEqual([
      'item/commandExecution/requestApproval:workspace-write',
      'item/fileChange/requestApproval:workspace-write',
    ])

    const requests = readLines(rpcPath)
    expect(requests.some((request) => request.method === 'initialized')).toBe(true)
    const threadStart = requests.find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({
      model: 'gpt-6-luna',
      cwd: dir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        mcp_servers: {
          joy: { command: 'node', args: ['tool-hub.mjs'], env: { JOY_TEST: '1' } },
          remote: { url: 'https://mcp.example.test', http_headers: { authorization: 'test' } },
        },
      },
    })
    const turnStart = requests.find((request) => request.method === 'turn/start')
    expect(turnStart?.params).toMatchObject({
      threadId: 'thread-synthetic-1',
      input: [{ type: 'text', text: 'fix it', text_elements: [] }],
      model: 'gpt-6-luna',
      effort: 'low',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    })
    expect(readLines(approvalsPath)).toEqual([
      { id: 'command-approval', result: { decision: 'accept' } },
      { id: 'file-approval', result: { decision: 'decline' } },
    ])
    expect(new CodexAppServerProvider().capabilities.delegatedApproval).toBe(true)
    expect(new CodexAppServerProvider().capabilities.quotaEvents).toBe(true)
    expect(new CodexCliProvider().capabilities.delegatedApproval).toBe(true)
  })

  it('uses app-server by default through the existing Codex provider entry point', async () => {
    const { dir, env, rpcPath, readLines } = setup()
    const provider = new CodexCliProvider({
      command: process.execPath,
      argsPrefix: [fakeCodexAppServer],
      env,
      timeoutMs: 5_000,
    })
    const events = await collect(provider.run(opts(dir), model))
    expect(events[0]).toEqual({ type: 'session_started', sessionId: 'thread-synthetic-1' })
    expect(events.some((event) => event.type === 'status' && event.text.includes('falling back'))).toBe(false)
    expect(readLines(rpcPath).some((request) => request.method === 'turn/start')).toBe(true)
  })

  it('resumes a prior thread and safely declines approvals when no policy handler is wired', async () => {
    const { dir, rpcPath, approvalsPath, readLines } = setup()
    const provider = new CodexAppServerProvider({
      command: process.execPath,
      argsPrefix: [fakeCodexAppServer],
      env: {
        FAKE_APP_SERVER_FIXTURE: JSON.stringify(fixtureFor(dir)),
        FAKE_RPC_OUT: rpcPath,
        FAKE_APPROVALS_OUT: approvalsPath,
      },
      timeoutMs: 5_000,
    })
    const events = await collect(provider.run(opts(dir, { resumeSessionId: 'thread-existing' }), model))
    const requests = readLines(rpcPath)
    expect(requests.find((request) => request.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-existing',
      cwd: dir,
      model: 'gpt-6-luna',
    })
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false)
    expect(events[0]).toEqual({ type: 'session_started', sessionId: 'thread-synthetic-1' })
    expect(readLines(approvalsPath)).toEqual([
      { id: 'command-approval', result: { decision: 'decline' } },
      { id: 'file-approval', result: { decision: 'decline' } },
    ])
  })

  it('falls back to exec --json when app-server startup fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-codex-fallback-test-'))
    dirs.push(dir)
    const provider = new CodexCliProvider({
      command: process.execPath,
      argsPrefix: [fakeCodexAppServer],
      env: {
        FAKE_APP_SERVER_MODE: 'exit',
        FAKE_EXEC_REPLAY: fixturePath('codex', 'synthetic-edit'),
      },
      timeoutMs: 5_000,
    })
    const events = await collect(provider.run(opts(dir), model))
    expect(events[0]).toEqual({
      type: 'status',
      text: 'Codex app-server unavailable; falling back to codex exec --json.',
    })
    expect(events.some((event) => event.type === 'session_started')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
  })

  it('keeps exec mode explicitly available with its legacy capability set', () => {
    const provider = new CodexCliProvider({ mode: 'exec' })
    expect(provider.capabilities).toMatchObject({ delegatedApproval: false, quotaEvents: false })
  })

  it('times out an unresponsive app-server during initialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-codex-timeout-test-'))
    dirs.push(dir)
    const provider = new CodexAppServerProvider({
      command: process.execPath,
      argsPrefix: [fakeCodexAppServer],
      env: { FAKE_APP_SERVER_MODE: 'hang' },
      timeoutMs: 100,
    })
    await expect(collect(provider.run(opts(dir), model))).rejects.toThrow(/Codex app-server did not finish/)
  })
})
