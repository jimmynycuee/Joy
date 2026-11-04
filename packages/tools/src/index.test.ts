import type {
  AgentEvent,
  AgentProvider,
  AttemptId,
  ProviderKind,
  RepoId,
  RunOptions,
  TaskId,
} from '@joy/core'
import { createRepo, createTask, createAttempt, getTask, listTaskApprovals, openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createToolHubMcpServer, createToolHubTools, toFunctionCallingTools } from './index.js'
import type { ToolHubContext } from './index.js'

class FakeProvider implements AgentProvider {
  readonly capabilities = {
    codeEdit: false,
    tools: false,
    resume: false,
    presetSessionId: false,
    delegatedApproval: false,
    quotaEvents: false,
    structuredOutput: false,
  }
  readonly calls: RunOptions[] = []

  constructor(
    readonly kind: ProviderKind,
    private readonly runFake: (options: RunOptions) => AsyncGenerator<AgentEvent>,
  ) {}

  run(options: RunOptions): AsyncIterable<AgentEvent> {
    this.calls.push(options)
    return this.runFake(options)
  }

  async healthCheck() {
    return { ok: true, installed: true, loggedIn: true as const }
  }
}

const databases: Database[] = []
function fixture(
  provider: AgentProvider | null = new FakeProvider('codex-cli', async function* () {
    yield { type: 'done', sessionId: 'peer-session', finalMessage: 'Fake Codex answer', isError: false }
  }),
  currentProvider: ProviderKind = 'claude-cli',
) {
  const db = openDatabase(':memory:')
  databases.push(db)
  const repo = createRepo(db, { id: 'repo' as RepoId, path: '/repo', defaultBranch: 'main' })
  const task = createTask(db, {
    id: 'task' as TaskId,
    repoId: repo.id,
    title: 'A test task',
    prompt: 'Test instructions',
    mode: 'single',
  })
  const attempt = createAttempt(db, {
    id: 'attempt' as AttemptId,
    taskId: task.id,
    provider: 'claude-cli',
    model: 'haiku',
    status: 'running',
  })
  const controller = new AbortController()
  const approvals: string[] = []
  const context: ToolHubContext = {
    db,
    task,
    attempt: { id: attempt.id },
    cwd: '/repo/worktree',
    currentProvider,
    peerModel: { provider: 'codex-cli', model: 'gpt-6-luna' },
    providers: provider ? { 'codex-cli': provider } : {},
    signal: controller.signal,
    redactText: (value: string) => value,
    redactValue: (value: unknown) => value,
    onApprovalCreated: (approval: { id: string }) => approvals.push(approval.id),
  }
  const server = createToolHubMcpServer(context)
  return { db, task, attempt, controller, approvals, context, server }
}

const clients: Client[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

async function connect(server: ReturnType<typeof createToolHubMcpServer>): Promise<Client> {
  const client = new Client({ name: 'joy-tools-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

function text(content: unknown): string {
  const result = content as { content?: Array<{ type: string; text?: string }> }
  return result.content?.find((item) => item.type === 'text')?.text ?? ''
}

describe('Joy MCP Tool Hub', () => {
  it('publishes strict tool schemas and returns the configured peer answer', async () => {
    const peer = new FakeProvider('codex-cli', async function* (options) {
      yield {
        type: 'done',
        sessionId: 'peer-session',
        finalMessage: `Codex reviewed: ${options.prompt.includes('Question: Would you add a regression test?') ? 'yes' : 'no'}`,
        isError: false,
      }
    })
    const f = fixture(peer)
    const client = await connect(f.server)
    const listed = await client.listTools()
    const apiTools = toFunctionCallingTools(createToolHubTools(f.context))
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'ask_peer',
      'request_approval',
      'task_status',
    ])
    expect(apiTools.map((tool) => tool.name).sort()).toEqual(listed.tools.map((tool) => tool.name).sort())
    expect(apiTools.find((tool) => tool.name === 'task_status')?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
    const askPeer = listed.tools.find((tool) => tool.name === 'ask_peer')
    expect(askPeer?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['question'],
    })

    const response = await client.callTool({
      name: 'ask_peer',
      arguments: { question: 'Would you add a regression test?' },
    })
    expect(text(response)).toBe('Codex reviewed: yes')
    expect(response.isError).not.toBe(true)
    expect(peer.calls[0]).toMatchObject({
      cwd: '/repo/worktree',
      autonomy: 'read-only',
      signal: f.controller.signal,
    })
    expect(peer.calls[0]?.mcpServers).toBeUndefined()
  })

  it('returns MCP tool errors for missing peer providers and unknown tools', async () => {
    const f = fixture(null)
    const client = await connect(f.server)
    const unavailable = await client.callTool({
      name: 'ask_peer',
      arguments: { question: 'Review this edge case' },
    })
    expect(unavailable.isError).toBe(true)
    expect(text(unavailable)).toContain('No peer provider configured for codex-cli')
    const unknown = await client.callTool({ name: 'not_a_joy_tool', arguments: {} })
    expect(unknown.isError).toBe(true)

    const sameProvider = new FakeProvider('codex-cli', async function* () {
      yield { type: 'done', sessionId: 'same-provider', finalMessage: 'should not run', isError: false }
    })
    const sameProviderFixture = fixture(sameProvider, 'codex-cli')
    const sameProviderClient = await connect(sameProviderFixture.server)
    const noPeer = await sameProviderClient.callTool({
      name: 'ask_peer',
      arguments: { question: 'Do not call the same provider' },
    })
    expect(noPeer.isError).toBe(true)
    expect(text(noPeer)).toContain('different provider')
    expect(sameProvider.calls).toHaveLength(0)
  })

  it('validates tool input, exposes task and approval state, and persists requests', async () => {
    const f = fixture()
    const client = await connect(f.server)
    const invalidQuestion = await client.callTool({ name: 'ask_peer', arguments: { question: '  ' } })
    expect(invalidQuestion.isError).toBe(true)
    const extraStatusField = await client.callTool({ name: 'task_status', arguments: { taskId: 'other' } })
    expect(extraStatusField.isError).toBe(true)
    const invalidApproval = await client.callTool({
      name: 'request_approval',
      arguments: { kind: 'unknown_action', summary: 'Not valid' },
    })
    expect(invalidApproval.isError).toBe(true)

    const approval = await client.callTool({
      name: 'request_approval',
      arguments: {
        kind: 'send_mail',
        summary: 'Send the prepared update',
        detail: { recipient: 'owner@example.test' },
      },
    })
    expect(approval.isError).not.toBe(true)
    expect(JSON.parse(text(approval))).toMatchObject({ status: 'pending', taskStatus: 'awaiting_approval' })
    expect(getTask(f.db, f.task.id)?.status).toBe('awaiting_approval')
    expect(listTaskApprovals(f.db, f.task.id)).toMatchObject([
      {
        attemptId: f.attempt.id,
        tier: 'approve',
        status: 'pending',
        action: {
          kind: 'send_mail',
          summary: 'Send the prepared update',
          detail: { recipient: 'owner@example.test' },
          provenance: 'agent',
        },
      },
    ])
    const status = await client.callTool({ name: 'task_status', arguments: {} })
    expect(JSON.parse(text(status))).toMatchObject({
      task: { id: f.task.id, status: 'awaiting_approval' },
      approvals: [{ status: 'pending' }],
    })
    expect(f.approvals).toHaveLength(1)
  })

  it('propagates task cancellation into a peer provider request', async () => {
    let observedAbort = false
    const peer = new FakeProvider('codex-cli', async function* (options) {
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve()
        else options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      observedAbort = options.signal.aborted
      yield { type: 'done', sessionId: 'cancelled-peer', finalMessage: 'cancelled', isError: false }
    })
    const f = fixture(peer)
    const client = await connect(f.server)
    const result = client.callTool({
      name: 'ask_peer',
      arguments: { question: 'Wait for a peer answer' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.controller.abort()
    const response = await result
    expect(response.isError).toBe(true)
    expect(text(response)).toContain('cancelled')
    expect(observedAbort).toBe(true)
  })
})
