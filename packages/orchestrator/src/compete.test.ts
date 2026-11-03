import type {
  AgentEvent,
  AgentProvider,
  AttemptId,
  Executor,
  ModelRef,
  ProviderKind,
  RepoId,
  RepoRef,
  RunOptions,
  TaskId,
  Workspace,
  WorkspaceDiff,
} from '@joy/core'
import { describe, expect, it } from 'vitest'
import type { CompeteEvent, CompeteInput } from './compete.js'
import { compete } from './compete.js'

type Script = (opts: RunOptions, model: ModelRef) => AgentEvent[]

class FakeProvider implements AgentProvider {
  readonly calls: { opts: RunOptions; model: ModelRef }[] = []
  readonly capabilities = {
    codeEdit: true,
    tools: true,
    resume: true,
    presetSessionId: true,
    delegatedApproval: true,
    quotaEvents: false,
    structuredOutput: true,
  }

  constructor(
    readonly kind: ProviderKind,
    private readonly scripts: Record<string, Script>,
    private readonly beforeEvents?: () => Promise<void>,
  ) {}

  async *run(opts: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    this.calls.push({ opts, model })
    const script = this.scripts[model.model]
    if (!script) throw new Error(`${this.kind}:${model.model} has no fake script`)
    await this.beforeEvents?.()
    for (const event of script(opts, model)) yield event
  }

  async healthCheck() {
    return { ok: true, installed: true, loggedIn: true as const }
  }
}

class FakeExecutor implements Executor {
  readonly workspaces: Workspace[] = []
  constructor(private readonly hasChanges = true) {}

  async prepare(repo: RepoRef, taskId: TaskId, attemptId: AttemptId): Promise<Workspace> {
    const workspace = {
      repo,
      taskId,
      attemptId,
      path: `/wt/${attemptId}`,
      branch: `joy/${taskId}/${attemptId}`,
      baseCommit: 'base',
    }
    this.workspaces.push(workspace)
    return workspace
  }

  async diff(workspace: Workspace): Promise<WorkspaceDiff> {
    if (!this.hasChanges) return { files: [], patch: '' }
    const index = this.workspaces.findIndex((candidate) => candidate.attemptId === workspace.attemptId)
    return {
      files: [{ path: `candidate-${index + 1}.ts`, status: 'modified', additions: 1, deletions: 0 }],
      patch: `+candidate ${index + 1}`,
    }
  }

  async commit() {
    return null
  }

  async cleanup() {}
}

const claude: ModelRef = { provider: 'claude-cli', model: 'haiku', effort: 'low' }
const codex: ModelRef = { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' }
const judgeModel: ModelRef = { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' }
const repo: RepoRef = { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' }

function input(over: Partial<CompeteInput> = {}): CompeteInput {
  return {
    taskId: 't1' as TaskId,
    repo,
    prompt: 'Fix add() and its tests',
    competitors: [claude, codex],
    judge: judgeModel,
    signal: new AbortController().signal,
    ...over,
  }
}

function events(sessionId: string, finalMessage = 'implemented'): AgentEvent[] {
  return [
    { type: 'session_started', sessionId },
    { type: 'status', text: 'working' },
    { type: 'done', sessionId, isError: false, finalMessage },
  ]
}

async function run(
  i: CompeteInput,
  providers: Partial<Record<ProviderKind, AgentProvider>>,
  executor: FakeExecutor,
) {
  const output: CompeteEvent[] = []
  for await (const event of compete(i, { providers, executor })) output.push(event)
  return { output, result: output.at(-1) }
}

describe('compete', () => {
  it('runs candidates in separate worktrees and judges their diffs', async () => {
    const executor = new FakeExecutor()
    let started = 0
    let release!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    const waitForBoth = async () => {
      started++
      if (started === 2) release()
      await bothStarted
    }
    const implementerA = new FakeProvider(
      'claude-cli',
      { haiku: () => events('claude-session') },
      waitForBoth,
    )
    const implementerB = new FakeProvider(
      'codex-cli',
      { 'gpt-6-luna': () => events('codex-session') },
      waitForBoth,
    )
    const judge = new FakeProvider('openai-api', {
      'gpt-6-luna': () => [
        {
          type: 'done',
          sessionId: 'judge-session',
          isError: false,
          structured: {
            winnerAttemptId: executor.workspaces[1]?.attemptId,
            summary: 'Candidate two handles the edge case.',
            rationale: 'It adds a regression test and preserves the existing API.',
          },
        },
      ],
    })

    const { output, result } = await run(
      input({
        mcpServersForRun: (model, attemptId) => [
          {
            name: 'joy',
            transport: 'http',
            url: `http://127.0.0.1/${model.provider}/${attemptId ?? 'judge'}`,
          },
        ],
      }),
      { 'claude-cli': implementerA, 'codex-cli': implementerB, 'openai-api': judge },
      executor,
    )

    expect(executor.workspaces).toHaveLength(2)
    expect(new Set(executor.workspaces.map((workspace) => workspace.path)).size).toBe(2)
    expect(implementerA.calls[0]?.opts.cwd).toBe(executor.workspaces[0]?.path)
    expect(implementerB.calls[0]?.opts.cwd).toBe(executor.workspaces[1]?.path)
    expect(implementerA.calls[0]?.opts.autonomy).toBe('workspace-write')
    expect(implementerA.calls[0]?.opts.mcpServers?.[0]).toMatchObject({
      transport: 'http',
      url: expect.stringContaining('claude-cli/'),
    })
    expect(implementerB.calls[0]?.opts.mcpServers?.[0]).toMatchObject({
      transport: 'http',
      url: expect.stringContaining('codex-cli/'),
    })
    expect(judge.calls[0]?.opts.mcpServers?.[0]).toMatchObject({
      transport: 'http',
      url: expect.stringContaining('openai-api/judge'),
    })
    expect(judge.calls[0]?.opts).toMatchObject({
      cwd: '/repo',
      autonomy: 'read-only',
      outputSchema: expect.any(Object),
    })
    expect(judge.calls[0]?.opts.prompt).toContain('+candidate 1')
    expect(judge.calls[0]?.opts.prompt).toContain('+candidate 2')
    expect(output.filter((event) => event.type === 'agent')).toHaveLength(7)
    expect(result).toMatchObject({
      type: 'result',
      status: 'succeeded',
      judgment: {
        winnerAttemptId: executor.workspaces[1]?.attemptId,
        summary: 'Candidate two handles the edge case.',
        rationale: 'It adds a regression test and preserves the existing API.',
      },
      candidates: [
        { model: claude, status: 'succeeded', diff: { patch: '+candidate 1' } },
        { model: codex, status: 'succeeded', diff: { patch: '+candidate 2' } },
      ],
    })
  })

  it('keeps successful candidates when another candidate fails', async () => {
    const executor = new FakeExecutor()
    const good = new FakeProvider('claude-cli', { haiku: () => events('good') })
    const failed = new FakeProvider('codex-cli', {
      'gpt-6-luna': () => [
        { type: 'error', message: 'rate limited', recoverable: false },
        { type: 'done', sessionId: 'bad', isError: true },
      ],
    })
    const judge = new FakeProvider('openai-api', {
      'gpt-6-luna': () => [
        {
          type: 'done',
          sessionId: 'judge',
          isError: false,
          structured: {
            winnerAttemptId: executor.workspaces[0]?.attemptId,
            summary: 'Only candidate available',
            rationale: 'The other candidate failed before producing changes.',
          },
        },
      ],
    })

    const { result } = await run(
      input(),
      { 'claude-cli': good, 'codex-cli': failed, 'openai-api': judge },
      executor,
    )
    expect(result).toMatchObject({
      type: 'result',
      status: 'succeeded',
      candidates: [
        { status: 'succeeded' },
        { status: 'failed', reason: expect.stringMatching(/rate limited/) },
      ],
    })
    expect(judge.calls).toHaveLength(1)
  })

  it('fails when no candidate produces a usable diff', async () => {
    const executor = new FakeExecutor(false)
    const provider = (kind: ProviderKind, model: string) =>
      new FakeProvider(kind, { [model]: () => events(`${kind}-session`) })
    const judge = provider('openai-api', 'gpt-6-luna')
    const { result } = await run(
      input(),
      {
        'claude-cli': provider('claude-cli', 'haiku'),
        'codex-cli': provider('codex-cli', 'gpt-6-luna'),
        'openai-api': judge,
      },
      executor,
    )
    expect(result).toMatchObject({
      type: 'result',
      status: 'failed',
      reason: expect.stringMatching(/No candidate produced/),
    })
    expect(judge.calls).toHaveLength(0)
  })

  it('rejects a judge result that names an unknown attempt', async () => {
    const executor = new FakeExecutor()
    const a = new FakeProvider('claude-cli', { haiku: () => events('a') })
    const b = new FakeProvider('codex-cli', { 'gpt-6-luna': () => events('b') })
    const judge = new FakeProvider('openai-api', {
      'gpt-6-luna': () => [
        {
          type: 'done',
          sessionId: 'judge',
          isError: false,
          structured: { winnerAttemptId: 'not-a-candidate', summary: 'x', rationale: 'y' },
        },
      ],
    })
    const { result } = await run(input(), { 'claude-cli': a, 'codex-cli': b, 'openai-api': judge }, executor)
    expect(result).toMatchObject({
      type: 'result',
      status: 'failed',
      reason: expect.stringMatching(/did not select a successful candidate/),
    })
  })

  it('does not run the judge after cancellation', async () => {
    const controller = new AbortController()
    const executor = new FakeExecutor()
    const a = new FakeProvider('claude-cli', {
      haiku: () => {
        controller.abort()
        return events('a')
      },
    })
    const b = new FakeProvider('codex-cli', { 'gpt-6-luna': () => events('b') })
    const judge = new FakeProvider('openai-api', { 'gpt-6-luna': () => events('judge') })
    const { result } = await run(
      input({ signal: controller.signal }),
      { 'claude-cli': a, 'codex-cli': b, 'openai-api': judge },
      executor,
    )
    expect(result).toMatchObject({ type: 'result', status: 'cancelled' })
    expect(judge.calls).toHaveLength(0)
  })

  it('requires a distinct provider for each competitor', async () => {
    const executor = new FakeExecutor()
    const provider = new FakeProvider('claude-cli', {
      haiku: () => events('a'),
      opus: () => events('b'),
    })
    const { result } = await run(
      input({ competitors: [claude, { ...claude, model: 'opus' }] }),
      { 'claude-cli': provider },
      executor,
    )
    expect(result).toMatchObject({
      type: 'result',
      status: 'failed',
      reason: expect.stringMatching(/different provider for each competitor/),
    })
    expect(executor.workspaces).toHaveLength(0)
  })
})
