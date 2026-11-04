import type { AgentEvent, AgentProvider, ModelRef, ProviderKind, RunOptions } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OpenAiApiProvider } from '@joy/providers'
import type { ToolHubTool } from '@joy/tools'
import { AssistantConversation } from './index.js'

const mcpServers = [{ name: 'joy', transport: 'http', url: 'http://127.0.0.1:4000/mcp/fake' }] as const
const taskSchema = z.strictObject({ repo: z.string().min(1), task: z.string().min(1) })
const requestedTasks: { repo: string; task: string }[] = []

function createTaskTool(): ToolHubTool {
  return {
    name: 'create_task',
    title: 'Create task',
    description: 'Create a task in a repository.',
    inputSchema: taskSchema,
    run: async (input) => {
      const request = taskSchema.parse(input)
      requestedTasks.push(request)
      return { id: `task-${requestedTasks.length}`, ...request }
    },
  }
}

class FakeCliProvider implements AgentProvider {
  readonly capabilities = {
    codeEdit: false,
    tools: true,
    resume: true,
    presetSessionId: false,
    delegatedApproval: false,
    quotaEvents: false,
    structuredOutput: false,
  }
  readonly calls: RunOptions[] = []
  private runNumber = 0

  constructor(
    readonly kind: 'claude-cli' | 'codex-cli',
    private readonly tools: readonly ToolHubTool[],
  ) {}

  async *run(options: RunOptions, _model: ModelRef): AsyncGenerator<AgentEvent> {
    this.calls.push(options)
    expect(options.mcpServers).toEqual(mcpServers)
    this.runNumber += 1
    const id = `call-${this.runNumber}`
    const input = { repo: 'repo-X', task: 'Y' }
    const tool = this.tools.find((candidate) => candidate.name === 'create_task')
    if (!tool) throw new Error('The fake Tool Hub does not contain create_task')
    yield { type: 'tool_call', id, name: tool.name, input }
    const result = await tool.run(tool.inputSchema.parse(input), options.signal)
    yield { type: 'tool_result', id, output: result, isError: false }
    yield {
      type: 'done',
      sessionId: `${this.kind}-session-${this.runNumber}`,
      finalMessage: 'Queued Y in repo-X.',
      isError: false,
    }
  }

  async healthCheck() {
    return { ok: true, installed: true, loggedIn: true }
  }
}

function openAiFixture() {
  const requests: { body: Record<string, unknown> }[] = []
  let responseNumber = 0
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    responseNumber += 1
    requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    const id = `api-response-${responseNumber}`
    const events =
      responseNumber === 1
        ? [
            { type: 'response.created', response: { id } },
            {
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                call_id: 'api-call-1',
                name: 'create_task',
                arguments: JSON.stringify({ repo: 'repo-X', task: 'Y' }),
              },
            },
            { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 2 } } },
          ]
        : [
            { type: 'response.created', response: { id } },
            { type: 'response.output_text.done', text: 'Queued Y in repo-X.' },
            { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 4 } } },
          ]
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetch, requests }
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

afterEach(() => {
  requestedTasks.length = 0
})

describe('assistant conversation', () => {
  it('selects MCP for CLI brains and function calling for the API brain using one repo/task tool definition', async () => {
    const tools = [createTaskTool()]
    const api = openAiFixture()
    const providers: Partial<Record<ProviderKind, AgentProvider>> = {
      'claude-cli': new FakeCliProvider('claude-cli', tools),
      'codex-cli': new FakeCliProvider('codex-cli', tools),
      'openai-api': new OpenAiApiProvider({ apiKey: async () => 'fixture-key', fetch: api.fetch }),
    }
    const brains: ModelRef[] = [
      { provider: 'claude-cli', model: 'fake-claude' },
      { provider: 'codex-cli', model: 'fake-codex' },
      { provider: 'openai-api', model: 'fake-openai' },
    ]

    for (const brain of brains) {
      const conversation = new AssistantConversation({
        brain,
        providers,
        cwd: '/repo',
        tools,
        mcpServers: [...mcpServers],
      })
      const events = await collect(
        conversation.send('Do Y in repo X', { signal: new AbortController().signal }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_call',
          name: 'create_task',
          input: { repo: 'repo-X', task: 'Y' },
        }),
      )
      expect(events.find((event) => event.type === 'done')).toMatchObject({
        finalMessage: 'Queued Y in repo-X.',
        isError: false,
      })
    }

    expect(requestedTasks).toEqual([
      { repo: 'repo-X', task: 'Y' },
      { repo: 'repo-X', task: 'Y' },
      { repo: 'repo-X', task: 'Y' },
    ])
    expect((providers['claude-cli'] as FakeCliProvider).calls[0]?.autonomy).toBe('read-only')
    expect((providers['codex-cli'] as FakeCliProvider).calls[0]?.mcpServers).toEqual(mcpServers)
    expect(api.requests[0]?.body.tools).toMatchObject([
      { type: 'function', name: 'create_task', description: 'Create a task in a repository.' },
    ])
  })

  it('resumes a conversation only with the same selected brain', async () => {
    const tools = [createTaskTool()]
    const claude = new FakeCliProvider('claude-cli', tools)
    const codex = new FakeCliProvider('codex-cli', tools)
    const conversation = new AssistantConversation({
      brain: { provider: 'claude-cli', model: 'fake-claude' },
      providers: { 'claude-cli': claude, 'codex-cli': codex },
      cwd: '/repo',
      tools,
      mcpServers: [...mcpServers],
    })

    await collect(conversation.send('Do Y in repo X', { signal: new AbortController().signal }))
    await collect(conversation.send('Give me the status', { signal: new AbortController().signal }))
    await collect(
      conversation.send('Use the other brain', {
        brain: { provider: 'codex-cli', model: 'fake-codex' },
        signal: new AbortController().signal,
      }),
    )

    expect(claude.calls[1]?.resumeSessionId).toBe('claude-cli-session-1')
    expect(codex.calls[0]?.resumeSessionId).toBeUndefined()
  })
})
