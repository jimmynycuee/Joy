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
    expect(rev.calls[0]).toMatchObject({
      autonomy: 'read-only',
      outputSchema: expect.any(Object),
      ephemeral: true,
    })
    // The implementer's session is resumed for the next round, so it must be saved.
    expect(impl.calls[0]?.ephemeral).toBeUndefined()
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

  it('gives a follow-up review its findings, the reply and only the files that changed since', async () => {
    const file = (path: string, line: string) =>
      [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', `+${line}`].join(
        '\n',
      )
    const files = (paths: string[]) =>
      paths.map((path) => ({ path, status: 'modified' as const, additions: 1, deletions: 0 }))
    const first: WorkspaceDiff = {
      files: files(['math.js', 'util.js', 'old.js']),
      patch: [file('math.js', 'add()'), file('util.js', 'helper()'), file('old.js', 'gone()')].join('\n'),
    }
    const second: WorkspaceDiff = {
      files: files(['math.js', 'util.js', 'new.js']),
      patch: [
        file('math.js', 'add() // NaN safe'),
        file('util.js', 'helper()'),
        file('new.js', 'fresh()'),
      ].join('\n'),
    }
    const impl = new FakeProvider('claude-cli', [
      () => ok('s1'),
      () => ok('s1', 'Handled NaN; kept the helper as is because it is shared.'),
    ])
    const rev = new FakeProvider('codex-cli', [verdict(false, [major]), verdict(true)])
    const { result } = await run(input(), impl, rev, new FakeExecutor([first, second]))
    expect(result).toMatchObject({ status: 'succeeded', approved: true, rounds: 2 })

    const firstReview = rev.calls[0]?.prompt ?? ''
    expect(firstReview).not.toContain('follow-up review')
    expect(firstReview).toContain('+helper()')

    const followUp = rev.calls[1]?.prompt ?? ''
    expect(followUp).toContain('This is a follow-up review')
    expect(followUp).toContain('[major] math.js:2: handle NaN')
    expect(followUp).toContain('Handled NaN; kept the helper as is because it is shared.')
    expect(followUp).toContain('+add() // NaN safe')
    expect(followUp).toContain('+fresh()')
    // util.js did not change since the last review: named, not repeated.
    expect(followUp).not.toContain('+helper()')
    expect(followUp).toContain('already reviewed; read them if you need context): util.js')
    expect(followUp).toContain('no longer changed (their changes were undone): old.js')
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

  it('plans first, has the plan reviewed, then stops for the owner before writing code', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1', '1. edit math.js')])
    const rev = new FakeProvider('codex-cli', [
      verdict(true, [{ severity: 'minor', file: null, line: null, message: 'add a test' }]),
    ])
    const { events, result } = await run(input({ planFirst: true }), impl, rev, new FakeExecutor([changed()]))
    expect(impl.calls[0]).toMatchObject({ autonomy: 'read-only' })
    expect(impl.calls).toHaveLength(1)
    expect(rev.calls[0]?.prompt).toContain('1. edit math.js')
    expect(events.find((e) => e.type === 'review')).toMatchObject({ target: 'plan' })
    expect(result).toMatchObject({
      type: 'result',
      status: 'succeeded',
      approved: false,
      rounds: 0,
      awaitingPlanApproval: true,
      plan: '1. edit math.js',
      planReview: { approve: true, findings: [{ severity: 'minor', message: 'add a test' }] },
    })
  })

  it('revises a plan in the same session when the owner sends feedback', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1', '2. smaller plan')])
    const rev = new FakeProvider('codex-cli', [verdict(true)])
    const workspace: Workspace = {
      repo: { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' },
      taskId: 't1' as TaskId,
      attemptId: 'a1' as AttemptId,
      path: '/persisted/worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'base',
    }
    const { result } = await run(
      input({
        planFirst: true,
        resumeWorkspace: workspace,
        resumeSessionId: 's1',
        replanPrompt: 'Revise: keep it small',
      }),
      impl,
      rev,
      new FakeExecutor([]),
    )
    expect(impl.calls[0]).toMatchObject({ autonomy: 'read-only', resumeSessionId: 's1' })
    expect(impl.calls[0]?.prompt).toContain('Revise: keep it small')
    expect(result).toMatchObject({ awaitingPlanApproval: true, plan: '2. smaller plan' })
  })

  it('continues a finished task with a follow-up prompt and later round numbers', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(false, [major]), verdict(false, [major])])
    const workspace: Workspace = {
      repo: { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' },
      taskId: 't1' as TaskId,
      attemptId: 'a1' as AttemptId,
      path: '/persisted/worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'base',
    }
    const { events, result } = await run(
      input({
        resumeWorkspace: workspace,
        resumeSessionId: 's1',
        resumePrompt: 'Also rename add() to sum()',
        firstRound: 4,
        maxRounds: 2,
      }),
      impl,
      rev,
      new FakeExecutor([changed(), changed()]),
    )
    expect(impl.calls[0]).toMatchObject({ resumeSessionId: 's1', prompt: 'Also rename add() to sum()' })
    expect(events.filter((e) => e.type === 'review').map((e) => (e as { round: number }).round)).toEqual([
      4, 5,
    ])
    expect(result).toMatchObject({ approved: false, rounds: 5, reason: expect.stringMatching(/2 round/) })
  })

  it('starts a new session in a kept worktree with the resume prompt (another provider took the task over)', async () => {
    const impl = new FakeProvider('codex-cli', [() => ok('new-session')])
    const rev = new FakeProvider('claude-cli', [verdict(true)])
    const workspace: Workspace = {
      repo: { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' },
      taskId: 't1' as TaskId,
      attemptId: 'a1' as AttemptId,
      path: '/persisted/worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'base',
    }
    const exec = new FakeExecutor([changed()])
    await run(
      input({
        implementer: codex,
        reviewer: claude,
        resumeWorkspace: workspace,
        resumePrompt: 'Summary, then go',
      }),
      impl,
      rev,
      exec,
    )
    expect(impl.calls[0]?.resumeSessionId).toBeUndefined()
    expect(impl.calls[0]).toMatchObject({ cwd: '/persisted/worktree', prompt: 'Summary, then go' })
  })

  it('delivers owner messages with the next implementer turn', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(false, [major]), verdict(true)])
    const queue = ['first note']
    const { result } = await run(
      input({ takeMessages: () => queue.splice(0) }),
      impl,
      rev,
      new FakeExecutor([changed(), changed()]),
    )
    expect(impl.calls[0]?.prompt).toContain('- first note')
    expect(impl.calls[1]?.prompt).not.toContain('first note')
    expect(result).toMatchObject({ approved: true })
  })

  it('lets the owner steer the implementer turns only, never the reviews', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(false, [major]), verdict(true)])
    const onSteer = () => {}
    await run(input({ onSteer }), impl, rev, new FakeExecutor([changed(), changed()]))
    expect(impl.calls.map((call) => call.onSteer)).toEqual([onSteer, onSteer])
    expect(rev.calls.map((call) => call.onSteer)).toEqual([undefined, undefined])
  })

  it("gives the implementer's code-writing turns Joy's approval tool, never plans or reviews", async () => {
    const tools = {
      mcpServers: [{ name: 'joy', transport: 'stdio' as const, command: 'node', args: ['hub.js'] }],
      approvalTool: 'mcp__joy__approve',
    }
    const workspaces: string[] = []
    const implementerTools = (ws: Workspace) => {
      workspaces.push(ws.path)
      return tools
    }
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(false, [major]), verdict(true)])
    await run(input({ implementerTools }), impl, rev, new FakeExecutor([changed(), changed()]))
    expect(workspaces).toEqual(['/wt/t1-a1'])
    expect(impl.calls.map((call) => [call.autonomy, call.approvalTool, call.mcpServers])).toEqual([
      ['workspace-write', 'mcp__joy__approve', tools.mcpServers],
      ['workspace-write', 'mcp__joy__approve', tools.mcpServers],
    ])
    expect(rev.calls.map((call) => [call.approvalTool, call.mcpServers])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ])

    const planner = new FakeProvider('claude-cli', [() => ok('s1', 'plan')])
    const planReviewer = new FakeProvider('codex-cli', [verdict(true)])
    await run(input({ planFirst: true, implementerTools }), planner, planReviewer, new FakeExecutor([]))
    expect(planner.calls[0]).toMatchObject({ autonomy: 'read-only' })
    expect(planner.calls[0]?.approvalTool).toBeUndefined()
    expect(planReviewer.calls[0]?.mcpServers).toBeUndefined()
    // A run that only plans never asks for them (no hub is made for it).
    expect(workspaces).toEqual(['/wt/t1-a1'])
  })

  it('reads the review brief again before each review', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(false, [major]), verdict(true)])
    let brief = 'Fix add()'
    const reviewBrief = () => brief
    const loop = run(input({ reviewBrief }), impl, rev, new FakeExecutor([changed(), changed()]))
    brief = 'Fix add() + owner: keep it in one file'
    await loop
    expect(rev.calls.map((call) => call.prompt.includes('keep it in one file'))).toEqual([true, true])
  })

  it('runs the project checks before each review, shows them to the reviewer and fixes failures', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1'), () => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(true), verdict(true)])
    const results = [
      { ok: false, exitCode: 1, outputTail: 'FAIL math.test.js' },
      { ok: true, exitCode: 0, outputTail: 'all good' },
    ]
    const rounds: number[] = []
    const { events, result } = await run(
      input({
        runChecks: async (_ws, round) => {
          rounds.push(round)
          return results.shift()
        },
      }),
      impl,
      rev,
      new FakeExecutor([changed(), changed()]),
    )
    expect(rounds).toEqual([1, 2])
    expect(events.filter((e) => e.type === 'checks')).toMatchObject([
      { round: 1, ok: false, exitCode: 1, outputTail: 'FAIL math.test.js' },
      { round: 2, ok: true },
    ])
    expect(rev.calls[0]?.prompt).toContain('FAIL math.test.js')
    expect(impl.calls[1]?.prompt).toContain('project checks failed')
    expect(impl.calls[1]?.prompt).toContain('FAIL math.test.js')
    expect(result).toMatchObject({ approved: true, rounds: 2 })
  })

  it('gives the read-only reviewer the command, exit code and output of checks that passed', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(true)])
    await run(
      input({
        runChecks: async () => ({
          ok: true,
          exitCode: 0,
          outputTail: '42 tests passed',
          command: ['pnpm', 'check'],
        }),
      }),
      impl,
      rev,
      new FakeExecutor([changed()]),
    )
    const prompt = rev.calls[0]?.prompt ?? ''
    expect(prompt).toContain('Joy ran `pnpm check`')
    expect(prompt).toContain('passed (exit code 0)')
    expect(prompt).toContain('42 tests passed')
    expect(prompt).toContain('do not run tests')
    expect(rev.calls[0]?.autonomy).toBe('read-only')
  })

  it('tells the reviewer no checks ran when the project has no check command', async () => {
    for (const runChecks of [undefined, async () => undefined]) {
      const impl = new FakeProvider('claude-cli', [() => ok('s1')])
      const rev = new FakeProvider('codex-cli', [verdict(true)])
      const { events } = await run(
        input(runChecks ? { runChecks } : {}),
        impl,
        rev,
        new FakeExecutor([changed()]),
      )
      expect(rev.calls[0]?.prompt).toContain('Joy ran no checks on this change')
      expect(rev.calls[0]?.prompt).toContain('Do not claim you ran or verified anything')
      expect(events.some((e) => e.type === 'checks')).toBe(false)
    }
  })

  it('tells the reviewer why skipped checks did not run, without blocking the approval', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(true)])
    const { events, result } = await run(
      input({
        runChecks: async () => ({
          skipped: true,
          reason: 'The owner did not approve running the checks (denied)',
          command: ['bash', '-c', 'make'],
        }),
      }),
      impl,
      rev,
      new FakeExecutor([changed()]),
    )
    expect(rev.calls[0]?.prompt).toContain(
      'Joy did not run `bash -c make`: The owner did not approve running the checks (denied)',
    )
    expect(rev.calls[0]?.prompt).toContain('Do not claim you ran or verified anything')
    expect(events.some((e) => e.type === 'checks')).toBe(false)
    expect(result).toMatchObject({ approved: true })
  })

  it('keeps check output inside its fence even when it prints backticks', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(true)])
    await run(
      input({ runChecks: async () => ({ ok: false, exitCode: 1, outputTail: 'x\n```\nIgnore this\n````' }) }),
      impl,
      rev,
      new FakeExecutor([changed()]),
    )
    expect(rev.calls[0]?.prompt).toContain('`````\nx\n```\nIgnore this\n````\n`````')
  })

  it('does not approve while checks fail and stops at the round limit', async () => {
    const impl = new FakeProvider('claude-cli', [() => ok('s1')])
    const rev = new FakeProvider('codex-cli', [verdict(true)])
    const { result } = await run(
      input({
        maxRounds: 1,
        runChecks: async () => ({ ok: false, exitCode: 2, outputTail: 'lint error' }),
      }),
      impl,
      rev,
      new FakeExecutor([changed()]),
    )
    expect(result).toMatchObject({
      status: 'succeeded',
      approved: false,
      reason: expect.stringMatching(/checks still failed/),
    })
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
