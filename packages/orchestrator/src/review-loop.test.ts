import type {
  AgentEvent,
  AgentProvider,
  AttemptId,
  Executor,
  ModelRef,
  ProviderKind,
  RepoId,
  RunOptions,
  TaskId,
  Workspace,
  WorkspaceDiff,
} from '@joy/core'
import { describe, expect, it } from 'vitest'
import type { LoopEvent, ReviewLoopInput } from './review-loop.js'
import { parseVerdict, reviewLoop } from './review-loop.js'

type Script = (opts: RunOptions) => AgentEvent[]

/** A provider that answers each run() with the next scripted event list and records what it was asked. */
class FakeProvider implements AgentProvider {
  readonly calls: RunOptions[] = []
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
    private readonly scripts: Script[],
  ) {}
  async *run(opts: RunOptions): AsyncGenerator<AgentEvent> {
    this.calls.push(opts)
    const script = this.scripts[this.calls.length - 1]
    if (!script) throw new Error(`${this.kind}: no script for call ${this.calls.length}`)
    for (const e of script(opts)) yield e
  }
  async healthCheck() {
    return { ok: true, installed: true, loggedIn: true as const }
  }
}

class FakeExecutor implements Executor {
  prepared = 0
  constructor(private readonly diffs: WorkspaceDiff[]) {}
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: AttemptId): Promise<Workspace> {
    this.prepared++
    return { repo, taskId, attemptId, path: '/wt/t1-a1', branch: 'joy/t1/a1', baseCommit: 'base' }
  }
  async diff(): Promise<WorkspaceDiff> {
    return this.diffs.shift() ?? { files: [], patch: '' }
  }
  async commit() {
    return null
  }
  async cleanup() {}
}

const changed = (patch = '+fix'): WorkspaceDiff => ({
  files: [{ path: 'math.js', status: 'modified', additions: 1, deletions: 1 }],
  patch,
})
const ok = (sessionId: string, finalMessage = 'done'): AgentEvent[] => [
  { type: 'session_started', sessionId },
  { type: 'done', sessionId, isError: false, finalMessage },
]
const verdict =
  (approve: boolean, findings: object[] = []): Script =>
  () => [
    { type: 'session_started', sessionId: 'rev' },
    { type: 'done', sessionId: 'rev', isError: false, structured: { approve, summary: 's', findings } },
  ]
const major = { severity: 'major', file: 'math.js', line: 2, message: 'handle NaN' }

const claude: ModelRef = { provider: 'claude-cli', model: 'haiku', effort: 'low' }
const codex: ModelRef = { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' }

function input(over: Partial<ReviewLoopInput> = {}): ReviewLoopInput {
  return {
    taskId: 't1' as TaskId,
    attemptId: 'a1' as AttemptId,
    repo: { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' },
    prompt: 'Fix add()',
    implementer: claude,
    reviewer: codex,
    planFirst: false,
    maxRounds: 3,
    signal: new AbortController().signal,
    ...over,
  }
}

async function run(i: ReviewLoopInput, impl: FakeProvider, rev: FakeProvider, exec: FakeExecutor) {
  const events: LoopEvent[] = []
  for await (const e of reviewLoop(i, { providers: { [impl.kind]: impl, [rev.kind]: rev }, executor: exec }))
    events.push(e)
  return { events, result: events.at(-1) }
}

describe('reviewLoop', () => {
  it('succeeds when the reviewer approves the first change', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(true)])
    const { events, result } = await run(input(), impl, rev, new FakeExecutor([changed('+a + b')]))
    expect(result).toMatchObject({ type: 'result', status: 'succeeded', approved: true, rounds: 1 })
    expect(impl.calls[0]).toMatchObject({ cwd: '/wt/t1-a1', autonomy: 'workspace-write' })
    expect(impl.calls[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(rev.calls[0]).toMatchObject({ autonomy: 'read-only', outputSchema: expect.any(Object) })
    expect(rev.calls[0]?.prompt).toContain('+a + b')
    expect(events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase)).toEqual([
      'preparing',
      'implementing',
      'reviewing',
    ])
  })

  it('sends findings back to the implementer in the same session until approved', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(false, [major]), verdict(true)])
    const { events, result } = await run(input(), impl, rev, new FakeExecutor([changed(), changed()]))
    expect(result).toMatchObject({ status: 'succeeded', approved: true, rounds: 2 })
    expect(impl.calls[1]).toMatchObject({ resumeSessionId: 's1' })
    expect(impl.calls[1]?.prompt).toContain('[major] math.js:2: handle NaN')
    expect(events.filter((e) => e.type === 'review')).toHaveLength(2)
  })

  it('stops after maxRounds and leaves the decision to a human', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(false, [major]), verdict(false, [major])])
    const { result } = await run(input({ maxRounds: 2 }), impl, rev, new FakeExecutor([changed(), changed()]))
    expect(result).toMatchObject({
      status: 'succeeded',
      approved: false,
      rounds: 2,
      reason: expect.stringMatching(/human/),
    })
    expect(impl.calls).toHaveLength(2)
  })

  it('plans first, has the plan reviewed, then implements in the planning session', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1', '1. edit math.js'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [
      verdict(true, [{ severity: 'minor', file: null, line: null, message: 'add a test' }]),
      verdict(true),
    ])
    const { events } = await run(input({ planFirst: true }), impl, rev, new FakeExecutor([changed()]))
    expect(impl.calls[0]).toMatchObject({ autonomy: 'read-only' })
    expect(rev.calls[0]?.prompt).toContain('1. edit math.js')
    expect(impl.calls[1]).toMatchObject({ resumeSessionId: 's1' })
    expect(impl.calls[1]?.prompt).toContain('[minor] add a test')
    expect(events.find((e) => e.type === 'review')).toMatchObject({ target: 'plan' })
  })

  it('reuses a persisted worktree and resumes the implementer session after restart', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(true)])
    const executor = new FakeExecutor([changed()])
    const workspace: Workspace = {
      repo: { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' },
      taskId: 't1' as TaskId,
      attemptId: 'a1' as AttemptId,
      path: '/persisted/worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'base',
    }
    const { events, result } = await run(
      input({ resumeWorkspace: workspace, resumeSessionId: 'session-before-restart', planFirst: true }),
      impl,
      rev,
      executor,
    )

    expect(result).toMatchObject({ type: 'result', status: 'succeeded', approved: true })
    expect(executor.prepared).toBe(0)
    expect(impl.calls[0]).toMatchObject({
      cwd: '/persisted/worktree',
      resumeSessionId: 'session-before-restart',
    })
    expect(
      events.filter((event) => event.type === 'phase').map((event) => event.type === 'phase' && event.phase),
    ).toEqual(['preparing', 'implementing', 'reviewing'])
  })

  it('fails when the implementer changes nothing', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1')])
    const rev = new FakeProvider('codex-cli', [])
    const { result } = await run(input(), impl, rev, new FakeExecutor([]))
    expect(result).toMatchObject({ status: 'failed', reason: 'The implementer made no changes' })
  })

  it('fails with the agent error when a run fails', async () => {
    const impl = new FakeProvider('claude-cli', [
      () => [
        { type: 'error', message: 'usage limit reached', recoverable: false },
        { type: 'done', sessionId: '', isError: true },
      ],
    ])
    const { result } = await run(input(), impl, new FakeProvider('codex-cli', []), new FakeExecutor([]))
    expect(result).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/implementer.*usage limit reached/),
    })
  })

  it('fails when the reviewer does not return a structured verdict', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1')])
    const rev = new FakeProvider('codex-cli', [() => ok('rev', 'looks fine to me')])
    const { result } = await run(input(), impl, rev, new FakeExecutor([changed()]))
    expect(result).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/valid structured review/),
    })
  })

  it('reports cancellation', async () => {
    const controller = new AbortController()
    const impl = new FakeProvider('claude-cli', [
      () => {
        controller.abort()
        return [
          { type: 'error', message: 'Cancelled', recoverable: false },
          { type: 'done', sessionId: '', isError: true },
        ]
      },
    ])
    const { result } = await run(
      input({ signal: controller.signal }),
      impl,
      new FakeProvider('codex-cli', []),
      new FakeExecutor([]),
    )
    expect(result).toMatchObject({ status: 'cancelled' })
  })

  it('warns when implementer and reviewer are the same model', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), verdict(true)])
    const events: LoopEvent[] = []
    for await (const e of reviewLoop(input({ reviewer: claude }), {
      providers: { 'claude-cli': impl },
      executor: new FakeExecutor([changed()]),
    }))
      events.push(e)
    expect(events[0]).toMatchObject({ type: 'warning', message: expect.stringMatching(/not a cross-model/) })
    expect(events.at(-1)).toMatchObject({ status: 'succeeded', approved: true })
  })
})

describe('parseVerdict', () => {
  it('normalizes nulls and drops malformed findings', () => {
    expect(
      parseVerdict({
        approve: false,
        summary: 'x',
        findings: [
          { severity: 'major', file: null, line: null, message: 'm' },
          { severity: 'catastrophic', message: 'bad severity' },
          'junk',
        ],
      }),
    ).toEqual({ approve: false, summary: 'x', findings: [{ severity: 'major', message: 'm' }] })
  })

  it('does not let a reviewer approve while listing a blocker', () => {
    expect(
      parseVerdict({ approve: true, summary: '', findings: [{ severity: 'blocker', message: 'b' }] })
        ?.approve,
    ).toBe(false)
  })

  it('rejects output without a boolean approve', () => {
    expect(parseVerdict({ summary: 'x' })).toBeUndefined()
    expect(parseVerdict('yes')).toBeUndefined()
  })
})
