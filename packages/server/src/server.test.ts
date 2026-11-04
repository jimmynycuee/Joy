import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentProvider,
  AttemptId,
  Executor,
  ProviderKind,
  RepoId,
  RunOptions,
  TaskId,
  Workspace,
  WorkspaceDiff,
} from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '@joy/config'
import { createAttempt, createRepo, createTask, openDatabase, setTaskStatus, updateAttempt } from '@joy/db'
import type { Database } from '@joy/db'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createJoyServer } from './server.js'
import type { JoyServer, JoyServerOptions } from './server.js'
import WebSocket, { type RawData } from 'ws'

const dirs: string[] = []
const servers: JoyServer[] = []
const databases: Database[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const rid = (id: string) => id as RepoId
const tid = (id: string) => id as TaskId
const aid = (id: string) => id as AttemptId
function receiveMessages(socket: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = []
    const onError = (error: Error) => {
      socket.off('message', onMessage)
      reject(error)
    }
    const onMessage = (data: RawData) => {
      messages.push(JSON.parse(data.toString()) as unknown)
      if (messages.length === count) {
        socket.off('error', onError)
        resolve(messages)
      }
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
  })
}
const diff: WorkspaceDiff = {
  files: [{ path: 'src/fix.ts', status: 'modified', additions: 1, deletions: 0 }],
  patch: 'diff --git a/src/fix.ts b/src/fix.ts\n+fixed\n',
}

class FakeProvider implements AgentProvider {
  readonly calls: RunOptions[] = []
  readonly capabilities = {
    codeEdit: true,
    tools: true,
    resume: true,
    presetSessionId: true,
    delegatedApproval: false,
    quotaEvents: true,
    structuredOutput: true,
  }

  constructor(
    readonly kind: ProviderKind,
    private readonly output: AgentEvent[] | ((options: RunOptions) => AgentEvent[]) = [],
  ) {}

  async *run(options: RunOptions): AsyncGenerator<AgentEvent> {
    this.calls.push(options)
    const sessionId = options.resumeSessionId ?? `session-${this.calls.length}`
    if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
    yield { type: 'message', text: 'working' }
    if (options.prompt === 'wait') {
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve()
        else options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'done', sessionId, isError: false }
      return
    }
    const output = typeof this.output === 'function' ? this.output(options) : this.output
    for (const event of output.length ? output : [{ type: 'done', sessionId, isError: false } as AgentEvent])
      yield event
  }

  async healthCheck() {
    return { ok: true, installed: true, loggedIn: true as const }
  }
}

function successfulJudge(): FakeProvider {
  return new FakeProvider('openai-api', (options) => {
    const marker = 'Candidate data (JSON): '
    const data = JSON.parse(options.prompt.slice(options.prompt.indexOf(marker) + marker.length)) as {
      attemptId: string
    }[]
    return [
      {
        type: 'done',
        sessionId: 'fake-judge',
        isError: false,
        structured: {
          winnerAttemptId: data[0]?.attemptId,
          summary: 'The first candidate wins.',
          rationale: 'This fake judgment selects the first candidate.',
        },
      },
    ]
  })
}

class FakeMcpClientProvider extends FakeProvider {
  availableTools: string[] = []

  constructor(
    kind: ProviderKind,
    readonly toolName: string,
    readonly toolArguments: Record<string, unknown>,
  ) {
    super(kind)
  }

  override async *run(options: RunOptions): AsyncGenerator<AgentEvent> {
    this.calls.push(options)
    const config = options.mcpServers?.find((server) => server.name === 'joy')
    if (!config || config.transport !== 'http')
      throw new Error('Fake agent did not receive the Joy MCP server')
    const client = new Client({ name: 'fake-claude', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url)))
      this.availableTools = (await client.listTools()).tools.map((tool) => tool.name).sort()
      const result = await client.callTool({ name: this.toolName, arguments: this.toolArguments })
      yield { type: 'session_started', sessionId: `fake-mcp-${this.calls.length}` }
      yield {
        type: 'tool_call',
        id: 'mcp-call-1',
        name: `mcp__joy__${this.toolName}`,
        input: this.toolArguments,
      }
      yield { type: 'tool_result', id: 'mcp-call-1', output: result, isError: result.isError === true }
      const response = (result.content as Array<{ type: string; text?: string }>).find(
        (item) => item.type === 'text',
      )
      const finalMessage =
        response?.type === 'text' ? (response.text ?? 'No tool response') : 'No tool response'
      yield {
        type: 'done',
        sessionId: `fake-mcp-${this.calls.length}`,
        finalMessage,
        isError: false,
      }
    } finally {
      await client.close()
    }
  }
}

function successfulJudgeAndSynthesizer(): FakeProvider {
  return new FakeProvider('openai-api', (options) => {
    if (options.prompt.includes('Synthesis candidate data (JSON):'))
      return [
        { type: 'done', sessionId: 'fake-synthesizer', isError: false, finalMessage: 'Combined strengths' },
      ]
    const marker = 'Candidate data (JSON): '
    const data = JSON.parse(options.prompt.slice(options.prompt.indexOf(marker) + marker.length)) as {
      attemptId: string
    }[]
    return [
      {
        type: 'done',
        sessionId: 'fake-judge',
        isError: false,
        structured: {
          winnerAttemptId: data[0]?.attemptId,
          summary: 'The first candidate wins.',
          rationale: 'This fake judgment selects the first candidate.',
        },
      },
    ]
  })
}

class FakeExecutor implements Executor {
  prepareCalls = 0
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: AttemptId): Promise<Workspace> {
    this.prepareCalls++
    return {
      repo,
      taskId,
      attemptId,
      path: `/fake/worktree/${attemptId}`,
      branch: `joy/${taskId}/${attemptId}`,
      baseCommit: 'base-sha',
    }
  }
  async diff() {
    return diff
  }
  async commit() {
    return null
  }
  async cleanup() {}
}

function fixture(
  options: {
    implementer?: FakeProvider
    reviewer?: FakeProvider
    judge?: FakeProvider
    omitProvider?: ProviderKind
    redactor?: Redactor
    secretBackend?: MemoryBackend
    secretEnv?: NodeJS.ProcessEnv
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-server-test-'))
  dirs.push(dir)
  const db = openDatabase(':memory:')
  databases.push(db)
  const executor = new FakeExecutor()
  const implementer = options.implementer ?? new FakeProvider('claude-cli')
  const reviewer =
    options.reviewer ??
    new FakeProvider('codex-cli', [
      {
        type: 'done',
        sessionId: 'review-session',
        isError: false,
        structured: { approve: true, summary: 'ok', findings: [] },
      },
    ])
  const api = options.judge ?? new FakeProvider('openai-api')
  const redactor = options.redactor ?? new Redactor()
  const secretBackend = options.secretBackend ?? new MemoryBackend()
  const configuredProviders: Partial<Record<ProviderKind, AgentProvider>> = {
    'claude-cli': implementer,
    'codex-cli': reviewer,
    'openai-api': api,
  }
  if (options.omitProvider)
    Object.defineProperty(configuredProviders, options.omitProvider, { value: undefined, enumerable: true })
  const serverOptions: JoyServerOptions = {
    home: dir,
    database: db,
    configStore: new ConfigStore(join(dir, 'config.yaml')),
    secretStore: new SecretStore({
      backend: secretBackend,
      ...(options.secretEnv ? { env: options.secretEnv } : {}),
      onSecret: (secret) => redactor.add(secret),
    }),
    redactor,
    executor,
    providers: configuredProviders,
    ...(options.redactor ? { redactor: options.redactor } : {}),
  }
  const serverPromise = createJoyServer(serverOptions)
  return {
    dir,
    db,
    executor,
    implementer,
    reviewer,
    api,
    secretBackend,
    serverPromise,
    restart: () => createJoyServer(serverOptions),
  }
}

async function start(serverPromise: Promise<JoyServer>) {
  const server = await serverPromise
  servers.push(server)
  const address = await server.listen()
  return { server, origin: `http://127.0.0.1:${address.port}`, websocket: `ws://127.0.0.1:${address.port}` }
}

interface TaskDetails {
  task: { status: string }
  attempts: Array<Record<string, unknown>>
  reviews: unknown[]
  approvals?: Array<Record<string, unknown>>
  events: unknown[]
}

async function waitForStatus(origin: string, id: string, status: string): Promise<TaskDetails> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${origin}/api/tasks/${id}`)
    const body = (await response.json()) as TaskDetails
    if (body.task.status === status) return body
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Task did not reach ${status}`)
}

async function waitForEvent(origin: string, id: string, type: string): Promise<TaskDetails> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${origin}/api/tasks/${id}`)
    const body = (await response.json()) as TaskDetails
    if (
      body.events.some(
        (value) => typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type,
      )
    )
      return body
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Task did not emit ${type}`)
}

async function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function startIncompletePost(url: string, prefix: string) {
  const req = httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
  })
  const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    req.once('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.once('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
        })
      })
    })
    req.once('error', reject)
  })
  req.flushHeaders()
  req.write(prefix)
  return { complete: (suffix: string) => req.end(suffix), response }
}

async function createCompeteTask(origin: string, title: string): Promise<string> {
  const repoResponse = await postJson(`${origin}/api/repos`, {
    path: `/tmp/${title.toLowerCase().replaceAll(' ', '-')}`,
    defaultBranch: 'main',
  })
  const { repo } = (await repoResponse.json()) as { repo: { id: string } }
  const created = await postJson(`${origin}/api/tasks`, {
    repoId: repo.id,
    title,
    prompt: 'Compare two fake implementations',
    mode: 'compete',
    roleOverrides: {
      implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
      reviewer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
      judge: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
    },
  })
  const { task } = (await created.json()) as { task: { id: string } }
  return task.id
}

describe('Joy local server', () => {
  it('binds only to loopback and supports repositories, task creation, replay and WebSocket events', async () => {
    const { db, executor, serverPromise } = fixture()
    const { origin, websocket, server } = await start(serverPromise)
    const address = server.httpServer.address()
    expect(address).toMatchObject({ address: '127.0.0.1' })

    const repoResponse = await postJson(`${origin}/api/repos`, {
      path: '/tmp/repo',
      defaultBranch: 'main',
      githubRemote: 'https://github.com/example/repo',
    })
    expect(repoResponse.status).toBe(201)
    const { repo } = (await repoResponse.json()) as { repo: { id: string; defaultBranch: string } }
    expect(repo.defaultBranch).toBe('main')
    const repoList = (await (await fetch(`${origin}/api/repos`)).json()) as { repos: unknown[] }
    expect(repoList.repos).toHaveLength(1)

    const taskResponse = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Fix the bug',
      prompt: 'Make the failing test pass',
      mode: 'review_loop',
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' } },
      maxRounds: 2,
    })
    expect(taskResponse.status).toBe(201)
    const { task } = (await taskResponse.json()) as { task: { id: string } }

    const socket = new WebSocket(`${websocket}/ws?taskId=${task.id}`, { origin })
    const messages = await receiveMessages(socket, 2)
    expect(messages[0]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(messages[1]).toMatchObject({ type: 'event', event: { taskId: task.id } })
    socket.close()
    const result = await waitForStatus(origin, task.id, 'done')
    expect(result.task.status).toBe('done')
    expect(result.attempts[0]).toMatchObject({
      status: 'succeeded',
      worktreePath: expect.stringMatching(/^\/fake\/worktree\//),
    })
    expect(result.events.length).toBeGreaterThan(0)
    expect(executor.prepareCalls).toBe(1)
    expect(db.isOpen).toBe(true)

    const compete = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Compare implementations',
      prompt: 'Do it',
      mode: 'compete',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'opus' },
        reviewer: { provider: 'claude-cli', model: 'haiku' },
      },
    })
    expect(compete.status).toBe(400)
  })

  it('lets a fake Claude task ask the fake Codex peer through the exposed MCP Tool Hub', async () => {
    const implementer = new FakeMcpClientProvider('claude-cli', 'ask_peer', {
      question: 'What edge case should the implementation test?',
    })
    const peer = new FakeProvider('codex-cli', [
      {
        type: 'done',
        sessionId: 'fake-codex-peer',
        finalMessage: 'Fake Codex recommends testing an empty input.',
        isError: false,
      },
    ])
    const { serverPromise } = fixture({ implementer, reviewer: peer })
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/mcp-peer-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const created = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Ask the Codex peer',
      prompt: 'Implement a parser and consider edge cases.',
      mode: 'single',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
      },
    })
    const { task } = (await created.json()) as { task: { id: string } }
    const details = await waitForStatus(origin, task.id, 'done')

    expect(implementer.availableTools).toEqual(['ask_peer', 'request_approval', 'task_status'])
    expect(peer.calls).toHaveLength(1)
    expect(peer.calls[0]?.prompt).toContain('Question: What edge case should the implementation test?')
    const toolResult = (details.events as Array<{ payload: { event?: AgentEvent } }>)
      .map((event) => event.payload.event)
      .find((event) => event?.type === 'tool_result')
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      isError: false,
      output: {
        content: [{ type: 'text', text: 'Fake Codex recommends testing an empty input.' }],
      },
    })
  })

  it('persists MCP approval requests across server restart and expires them on task cancellation', async () => {
    const implementer = new FakeMcpClientProvider('claude-cli', 'request_approval', {
      kind: 'send_mail',
      summary: 'Send the prepared update',
      detail: { recipient: 'owner@example.test' },
    })
    const { db, restart, serverPromise } = fixture({ implementer })
    const { origin, server } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/mcp-approval-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const created = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Request approval',
      prompt: 'Prepare the update but do not send without approval.',
      mode: 'single',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
      },
    })
    const { task } = (await created.json()) as { task: { id: string } }
    const details = await waitForStatus(origin, task.id, 'awaiting_approval')
    expect(details.approvals).toMatchObject([
      {
        tier: 'approve',
        status: 'pending',
        action: {
          kind: 'send_mail',
          summary: 'Send the prepared update',
          provenance: 'agent',
        },
      },
    ])
    const approval = details.approvals?.[0]
    expect(details.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'approval_requested' })]),
    )
    expect(db.isOpen).toBe(true)

    await server.close()
    const restarted = await restart()
    servers.push(restarted)
    const address = await restarted.listen()
    const restartedOrigin = `http://127.0.0.1:${address.port}`
    const restored = (await (await fetch(`${restartedOrigin}/api/tasks/${task.id}`)).json()) as TaskDetails
    expect(restored.task.status).toBe('awaiting_approval')
    expect(restored.approvals?.[0]).toMatchObject({ id: approval?.['id'], status: 'pending' })

    const cancelled = await postJson(`${restartedOrigin}/api/tasks/${task.id}/cancel`, {})
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ task: { status: 'cancelled' } })
    const expired = (await (await fetch(`${restartedOrigin}/api/tasks/${task.id}`)).json()) as TaskDetails
    expect(expired.approvals?.[0]).toMatchObject({ status: 'expired', decidedVia: 'task_cancelled' })
  })

  it('runs competing providers in isolated worktrees, persists judge rationale, and selects a winner', async () => {
    const judge = new FakeProvider('openai-api', (options) => {
      const marker = 'Candidate data (JSON): '
      const data = JSON.parse(options.prompt.slice(options.prompt.indexOf(marker) + marker.length)) as {
        attemptId: string
      }[]
      return [
        {
          type: 'done',
          sessionId: 'judge-session',
          isError: false,
          structured: {
            winnerAttemptId: data[1]?.attemptId,
            summary: 'Candidate two is stronger.',
            rationale: 'It covers the edge case with a focused regression test.',
          },
        },
      ]
    })
    const { db, executor, serverPromise } = fixture({ judge })
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/compete-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const created = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Compare implementations',
      prompt: 'Fix the edge case',
      mode: 'compete',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
        judge: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
      },
    })
    expect(created.status).toBe(201)
    const { task } = (await created.json()) as { task: { id: string } }
    expect((await waitForStatus(origin, task.id, 'review_ready')).task.status).toBe('review_ready')

    const details = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails
    expect(details.attempts).toHaveLength(2)
    expect(details.attempts.map((attempt) => attempt.status)).toEqual(['succeeded', 'succeeded'])
    expect(new Set(details.attempts.map((attempt) => attempt.worktreePath)).size).toBe(2)
    const events = details.events as Array<{ attemptId: string; type: string; payload: unknown }>
    const result = events.find((event) => event.type === 'result')?.payload as
      | {
          candidates: Array<{ attemptId: string; status: string; diff: WorkspaceDiff }>
          judgment: { winnerAttemptId: string; summary: string; rationale: string }
        }
      | undefined
    expect(result?.candidates).toHaveLength(2)
    expect(result?.candidates.map((candidate) => candidate.status)).toEqual(['succeeded', 'succeeded'])
    expect(result?.candidates[0]?.diff.patch).toContain('fixed')
    expect(result?.judgment).toMatchObject({
      summary: 'Candidate two is stronger.',
      rationale: 'It covers the edge case with a focused regression test.',
    })

    const badSelection = await postJson(`${origin}/api/tasks/${task.id}/select`, {
      attemptId: 'foreign-attempt',
    })
    expect(badSelection.status).toBe(404)
    const failedAttempt = createAttempt(db, {
      id: aid('failed-candidate'),
      taskId: task.id as TaskId,
      provider: 'codex-cli',
      model: 'gpt-6-luna',
      status: 'failed',
    })
    const failedSelection = await postJson(`${origin}/api/tasks/${task.id}/select`, {
      attemptId: failedAttempt.id,
    })
    expect(failedSelection.status).toBe(409)
    const selectedAttemptId = result?.judgment.winnerAttemptId
    const selection = await postJson(`${origin}/api/tasks/${task.id}/select`, {
      attemptId: selectedAttemptId,
    })
    expect(selection.status).toBe(200)
    expect(await selection.json()).toMatchObject({ task: { status: 'done' }, selectedAttemptId })
    const persisted = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails
    expect(persisted.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'winner_selected',
          payload: { attemptId: selectedAttemptId },
        }),
      ]),
    )
    expect(db.isOpen).toBe(true)
    expect(executor.prepareCalls).toBe(2)
  })

  it('synthesizes strengths into a separate candidate that can be selected', async () => {
    const judge = successfulJudgeAndSynthesizer()
    const { executor, api, serverPromise } = fixture({ judge })
    const { origin } = await start(serverPromise)
    const taskId = await createCompeteTask(origin, 'Synthesize candidate strengths')
    const initial = await waitForStatus(origin, taskId, 'review_ready')
    const sourceIds = initial.attempts.map((attempt) => String(attempt['id']))

    const started = await postJson(`${origin}/api/tasks/${taskId}/synthesize`, {})
    expect(started.status).toBe(202)
    const details = await waitForEvent(origin, taskId, 'synthesis_result')
    expect(details.task.status).toBe('review_ready')
    expect(details.attempts).toHaveLength(3)
    expect(executor.prepareCalls).toBe(3)
    expect(api.calls).toHaveLength(2)
    expect(api.calls[1]).toMatchObject({
      cwd: expect.stringMatching(/^\/fake\/worktree\//),
      autonomy: 'workspace-write',
    })
    for (const sourceId of sourceIds) expect(api.calls[1]?.prompt).toContain(sourceId)

    const events = details.events as Array<{ type: string; payload: unknown }>
    const synthesizedEvent = events
      .filter((event) => event.type === 'attempt' && (event.payload as { synthesized?: boolean }).synthesized)
      .at(-1)
    expect(synthesizedEvent?.payload).toMatchObject({
      status: 'succeeded',
      synthesized: true,
      diff: { patch: 'diff --git a/src/fix.ts b/src/fix.ts\n+fixed\n' },
    })
    const synthesizedPayload = synthesizedEvent?.payload as {
      attemptId: string
      sourceAttemptIds: string[]
    }
    expect(new Set(synthesizedPayload.sourceAttemptIds)).toEqual(new Set(sourceIds))
    const synthesizedCandidate = synthesizedPayload

    const duplicate = await postJson(`${origin}/api/tasks/${taskId}/synthesize`, {})
    expect(duplicate.status).toBe(409)
    const selection = await postJson(`${origin}/api/tasks/${taskId}/select`, {
      attemptId: synthesizedCandidate.attemptId,
    })
    expect(selection.status).toBe(200)
    expect(await selection.json()).toMatchObject({
      task: { status: 'done' },
      selectedAttemptId: synthesizedCandidate.attemptId,
    })
  })

  it('keeps original candidates selectable when synthesis fails', async () => {
    const judge = new FakeProvider('openai-api', (options) => {
      if (options.prompt.includes('Synthesis candidate data (JSON):'))
        return [
          {
            type: 'done',
            sessionId: 'failed-synthesis',
            isError: true,
            finalMessage: 'Fake synthesis failure',
          },
        ]
      const marker = 'Candidate data (JSON): '
      const data = JSON.parse(options.prompt.slice(options.prompt.indexOf(marker) + marker.length)) as {
        attemptId: string
      }[]
      return [
        {
          type: 'done',
          sessionId: 'fake-judge',
          isError: false,
          structured: {
            winnerAttemptId: data[0]?.attemptId,
            summary: 'First candidate',
            rationale: 'Selected by fake judge',
          },
        },
      ]
    })
    const { serverPromise } = fixture({ judge })
    const { origin } = await start(serverPromise)
    const taskId = await createCompeteTask(origin, 'Failed synthesis preserves candidates')
    const initial = await waitForStatus(origin, taskId, 'review_ready')
    const started = await postJson(`${origin}/api/tasks/${taskId}/synthesize`, {})
    expect(started.status).toBe(202)
    const details = await waitForEvent(origin, taskId, 'synthesis_result')
    expect(details.task.status).toBe('review_ready')
    const result = (details.events as Array<{ type: string; payload: unknown }>).find(
      (event) => event.type === 'synthesis_result',
    )?.payload as { status?: string; reason?: string } | undefined
    expect(result).toMatchObject({ status: 'failed', reason: 'Fake synthesis failure' })
    const source = initial.attempts.find((attempt) => attempt['status'] === 'succeeded')
    const selection = await postJson(`${origin}/api/tasks/${taskId}/select`, { attemptId: source?.['id'] })
    expect(selection.status).toBe(200)
  })

  it('keeps successful candidates selectable when the judge fails', async () => {
    const judge = new FakeProvider('openai-api', [
      { type: 'done', sessionId: 'failed-judge', isError: true, finalMessage: 'Fake judge failure' },
    ])
    const { serverPromise } = fixture({ judge })
    const { origin } = await start(serverPromise)
    const taskId = await createCompeteTask(origin, 'Judge failure remains reviewable')

    const details = await waitForStatus(origin, taskId, 'review_ready')
    const candidate = details.attempts.find((attempt) => attempt['status'] === 'succeeded')
    expect(candidate).toBeDefined()
    const selected = await postJson(`${origin}/api/tasks/${taskId}/select`, {
      attemptId: candidate?.['id'],
    })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({ task: { status: 'done' } })
  })

  it('persists an event explaining compete preflight failures without candidate attempts', async () => {
    const { serverPromise } = fixture({ omitProvider: 'openai-api' })
    const { origin } = await start(serverPromise)
    const taskId = await createCompeteTask(origin, 'Missing judge provider')

    const details = await waitForStatus(origin, taskId, 'failed')
    const result = details.events.find((event) => (event as { type?: string }).type === 'result') as
      { payload?: { reason?: string } } | undefined
    expect(result).toBeDefined()
    expect(result?.payload?.reason).toContain('No provider configured for judge openai-api')
    expect(details.attempts).toContainEqual(
      expect.objectContaining({ provider: 'openai-api', model: 'gpt-6-luna', status: 'failed' }),
    )
  })

  it('rejects a second winner selection after a concurrent request closes review', async () => {
    const { serverPromise } = fixture({ judge: successfulJudge() })
    const { origin } = await start(serverPromise)
    const taskId = await createCompeteTask(origin, 'Concurrent winner selection')
    const details = await waitForStatus(origin, taskId, 'review_ready')
    const candidates = details.attempts.filter((attempt) => attempt['status'] === 'succeeded')
    expect(candidates).toHaveLength(2)

    const first = startIncompletePost(
      `${origin}/api/tasks/${taskId}/select`,
      `{"attemptId":"${String(candidates[0]?.['id'])}`,
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    const second = await postJson(`${origin}/api/tasks/${taskId}/select`, {
      attemptId: candidates[1]?.['id'],
    })
    expect(second.status).toBe(200)
    first.complete('"}')
    expect((await first.response).status).toBe(409)
  })

  it('keeps candidates from a resumed compete run separate and rejects stale selections', async () => {
    const { db, serverPromise } = fixture({ judge: successfulJudge() })
    const { origin } = await start(serverPromise)
    const taskId = await createCompeteTask(origin, 'Resume keeps candidates scoped')
    const firstRun = await waitForStatus(origin, taskId, 'review_ready')
    const oldCandidate = firstRun.attempts.find((attempt) => attempt['status'] === 'succeeded')
    expect(oldCandidate).toBeDefined()

    setTaskStatus(db, tid(taskId), 'cancelled')
    const resumed = await postJson(`${origin}/api/tasks/${taskId}/resume`, {})
    expect(resumed.status).toBe(202)
    const secondRun = await waitForStatus(origin, taskId, 'review_ready')

    const staleSelection = await postJson(`${origin}/api/tasks/${taskId}/select`, {
      attemptId: oldCandidate?.['id'],
    })
    expect(staleSelection.status).toBe(409)
    const runMarkers = secondRun.events.filter(
      (event) => (event as { type?: string }).type === 'compete_run_started',
    ) as Array<{ seq: number }>
    expect(runMarkers).toHaveLength(2)
    const attemptEvents = secondRun.events.filter(
      (event) => (event as { type?: string }).type === 'attempt',
    ) as Array<{ seq: number }>
    expect(runMarkers[0]).toBeDefined()
    expect(runMarkers[1]).toBeDefined()
    const firstRunMarkerSeq = runMarkers[0]?.seq ?? Number.POSITIVE_INFINITY
    const resumedRunMarkerSeq = runMarkers[1]?.seq ?? Number.POSITIVE_INFINITY
    expect(attemptEvents[0]?.seq).toBeGreaterThan(firstRunMarkerSeq)
    const resumedRunAttempt = attemptEvents.find((event) => event.seq > resumedRunMarkerSeq)
    expect(resumedRunAttempt?.seq).toBeGreaterThan(resumedRunMarkerSeq)
    const latestResult = secondRun.events
      .filter((event) => (event as { type?: string }).type === 'result')
      .at(-1) as { payload?: { candidates?: Array<{ attemptId: string; status: string }> } } | undefined
    const currentCandidate = latestResult?.payload?.candidates?.find(
      (candidate) => candidate.status === 'succeeded',
    )
    const currentSelection = await postJson(`${origin}/api/tasks/${taskId}/select`, {
      attemptId: currentCandidate?.attemptId,
    })
    expect(currentSelection.status).toBe(200)
  })

  it('manages OpenAI keys without exposing them and redacts subsequent fake-provider events', async () => {
    const key = 'test-openai-key-kept-out-of-responses-123'
    const implementer = new FakeProvider('claude-cli', [
      { type: 'message', text: `Agent repeated ${key}` },
      { type: 'done', sessionId: 'fake-session', isError: false },
    ])
    const { db, secretBackend, serverPromise } = fixture({ implementer })
    const { origin } = await start(serverPromise)

    const emptyStatus = await fetch(`${origin}/api/secrets/openai-api-key`)
    expect(await emptyStatus.json()).toEqual({ set: false })
    const saved = await fetch(`${origin}/api/secrets/openai-api-key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: key }),
    })
    expect(saved.status).toBe(200)
    const savedBody = await saved.text()
    expect(savedBody).not.toContain(key)
    expect(JSON.parse(savedBody)).toEqual({ set: true, source: 'keychain' })
    expect(secretBackend.values.get('openai_api_key')).toBe(key)

    const config = await (await fetch(`${origin}/api/config`)).text()
    expect(config).not.toContain(key)
    const repo = (await (
      await postJson(`${origin}/api/repos`, { path: '/secret-test-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const created = await postJson(`${origin}/api/tasks`, {
      repoId: repo.repo.id,
      title: 'Check safe event redaction',
      prompt: 'Return the fake response',
      mode: 'single',
    })
    const { task } = (await created.json()) as { task: { id: string } }
    const result = await waitForStatus(origin, task.id, 'done')
    const responseBody = JSON.stringify(result)
    expect(responseBody).not.toContain(key)
    expect(responseBody).toContain('[REDACTED]')
    expect(JSON.stringify(db.prepare('SELECT payload FROM events').all())).not.toContain(key)

    const deleted = await fetch(`${origin}/api/secrets/openai-api-key`, { method: 'DELETE' })
    expect(await deleted.json()).toEqual({ set: false })
    expect(secretBackend.values.has('openai_api_key')).toBe(false)
  })

  it('reports environment-managed OpenAI keys without revealing or shadowing them', async () => {
    const envKey = 'environment-openai-secret-never-return-52'
    const backend = new MemoryBackend()
    const { serverPromise } = fixture({ secretBackend: backend, secretEnv: { OPENAI_API_KEY: envKey } })
    const { origin } = await start(serverPromise)

    const status = await fetch(`${origin}/api/secrets/openai-api-key`)
    const statusText = await status.text()
    expect(JSON.parse(statusText)).toEqual({ set: true, source: 'env' })
    expect(statusText).not.toContain(envKey)

    const put = await fetch(`${origin}/api/secrets/openai-api-key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'replacement-openai-secret-53' }),
    })
    expect(put.status).toBe(409)
    expect(await put.text()).not.toContain(envKey)
    const deleted = await fetch(`${origin}/api/secrets/openai-api-key`, { method: 'DELETE' })
    expect(deleted.status).toBe(409)
    expect(await deleted.text()).not.toContain(envKey)
    expect(backend.values.has('openai_api_key')).toBe(false)
  })

  it('stores redacted events, reviews, and usage and replays persisted events after restart', async () => {
    const secret = 'joy-private-test-secret-123'
    const redactor = new Redactor()
    redactor.add(secret)
    const implementer = new FakeProvider('claude-cli', [
      { type: 'message', text: `Output contains ${secret}` },
      { type: 'usage', inputTokens: 12, outputTokens: 4, costUsd: 0.02 },
      { type: 'quota', status: 'limited', windows: [] },
      { type: 'done', sessionId: 'implementer-session', isError: false },
    ])
    const reviewer = new FakeProvider('codex-cli', [
      {
        type: 'done',
        sessionId: 'reviewer-session',
        isError: false,
        structured: {
          approve: true,
          summary: `Reviewed ${secret}`,
          findings: [{ severity: 'minor', message: secret }],
        },
      },
    ])
    const { db, restart, serverPromise } = fixture({ implementer, reviewer, redactor })
    const { origin, server } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/logged-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const { task } = (await (
      await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title: 'Persist events',
        prompt: 'Record everything safely',
        mode: 'review_loop',
      })
    ).json()) as { task: { id: string } }
    const result = await waitForStatus(origin, task.id, 'done')
    const serializedEvents = JSON.stringify(result.events)
    expect(serializedEvents).not.toContain(secret)
    expect(serializedEvents).toContain('[REDACTED]')
    expect(result.reviews).toMatchObject([
      { summary: `Reviewed [REDACTED]`, findings: [{ message: '[REDACTED]' }] },
    ])
    expect(JSON.stringify(db.prepare('SELECT payload FROM events').all())).not.toContain(secret)
    expect(JSON.stringify(db.prepare('SELECT summary, findings FROM reviews').all())).not.toContain(secret)
    const usage = (await (await fetch(`${origin}/api/usage`)).json()) as {
      usage: Array<Record<string, unknown>>
    }
    expect(usage.usage).toEqual([
      expect.objectContaining({
        provider: 'claude-cli',
        inputTokens: 12,
        outputTokens: 4,
        costUsd: 0.02,
        rateLimitHits: 1,
      }),
    ])

    await server.close()
    const restarted = await restart()
    servers.push(restarted)
    const address = await restarted.listen()
    const restartedOrigin = `http://127.0.0.1:${address.port}`
    const replayed = (await (await fetch(`${restartedOrigin}/api/tasks/${task.id}`)).json()) as TaskDetails
    expect(replayed.events).toEqual(result.events)
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?taskId=${task.id}`, {
      origin: restartedOrigin,
    })
    const messages = await receiveMessages(socket, replayed.events.length + 1)
    expect(messages[0]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(messages.slice(1)).toEqual(replayed.events.map((event) => ({ type: 'event', event })))
    socket.close()
  })

  it('cancels a running task through the API', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/repo', defaultBranch: 'main' })
    ).json()) as {
      repo: { id: string }
    }
    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Cancel me',
      prompt: 'wait',
      mode: 'single',
    })
    const { task } = (await response.json()) as { task: { id: string } }
    await new Promise((resolve) => setTimeout(resolve, 15))
    const cancelled = await postJson(`${origin}/api/tasks/${task.id}/cancel`, {})
    expect(cancelled.status).toBe(200)
    const result = await waitForStatus(origin, task.id, 'cancelled')
    expect(result.task.status).toBe('cancelled')
  })

  it('marks interrupted tasks on restart and resumes the saved session and worktree', async () => {
    const { db, dir, executor, implementer, serverPromise } = fixture()
    const repo = createRepo(db, { id: rid('resume-repo'), path: '/repo', defaultBranch: 'main' })
    const task = createTask(db, {
      id: tid('resume-task'),
      repoId: repo.id,
      title: 'Resume me',
      prompt: 'Finish the change',
      mode: 'single',
    })
    const attempt = createAttempt(db, {
      id: aid('resume-attempt'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: '/saved/worktree',
      branch: 'joy/resume-task/resume-attempt',
      baseCommit: 'base-sha',
      sessionId: 'session-before-restart',
    })
    setTaskStatus(db, task.id, 'running')

    const { origin } = await start(serverPromise)
    const interrupted = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails
    expect(interrupted.task.status).toBe('failed')
    expect(interrupted.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'interrupted' })]),
    )
    const resume = await postJson(`${origin}/api/tasks/${task.id}/resume`, {})
    expect(resume.status).toBe(202)
    await waitForStatus(origin, task.id, 'done')
    expect(implementer.calls[0]).toMatchObject({
      cwd: '/saved/worktree',
      resumeSessionId: 'session-before-restart',
    })
    expect(executor.prepareCalls).toBe(0)
    expect(dir).toBeTruthy()
  })
})
