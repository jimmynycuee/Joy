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
import type { CompeteEvent, ContestantOutcome } from './compete.js'
import { JUDGE_SCHEMA, compete, mergePrompt, parseJudgement } from './compete.js'
import { REVIEW_SCHEMA } from './prompts.js'

/** Answers by what it is asked: implement, review, or judge. */
class RoutingProvider implements AgentProvider {
  readonly calls: RunOptions[] = []
  readonly capabilities = {
    codeEdit: true,
    tools: true,
    resume: true,
    presetSessionId: false,
    delegatedApproval: true,
    quotaEvents: false,
    structuredOutput: true,
  }
  constructor(
    readonly kind: ProviderKind,
    private readonly answers: {
      implement?: (opts: RunOptions) => AgentEvent[] | Promise<AgentEvent[]>
      review?: { approve: boolean; summary: string }
      judge?: unknown
    },
  ) {}
  async *run(opts: RunOptions): AsyncGenerator<AgentEvent> {
    this.calls.push(opts)
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (opts.outputSchema === JUDGE_SCHEMA) {
      yield { type: 'done', sessionId: 'j', isError: false, structured: this.answers.judge }
    } else if (opts.outputSchema === REVIEW_SCHEMA) {
      yield {
        type: 'done',
        sessionId: 'r',
        isError: false,
        structured: { ...(this.answers.review ?? { approve: true, summary: 'ok' }), findings: [] },
      }
    } else {
      const events = (await this.answers.implement?.(opts)) ?? [
        { type: 'done', sessionId: 'i', isError: false, finalMessage: 'done' },
      ]
      yield* events
    }
  }
  async healthCheck() {
    return { ok: true, installed: true, loggedIn: true as const }
  }
}

class PerAttemptExecutor implements Executor {
  readonly prepared: AttemptId[] = []
  constructor(private readonly diffs: Record<string, WorkspaceDiff>) {}
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: AttemptId): Promise<Workspace> {
    this.prepared.push(attemptId)
    return {
      repo,
      taskId,
      attemptId,
      path: `/wt/${attemptId}`,
      branch: `joy/${attemptId}`,
      baseCommit: 'base',
    }
  }
  async diff(ws: Workspace): Promise<WorkspaceDiff> {
    return this.diffs[ws.attemptId] ?? { files: [], patch: '' }
  }
  async commit() {
    return null
  }
  async cleanup() {}
}

const change = (patch: string): WorkspaceDiff => ({
  files: [{ path: 'math.js', status: 'modified', additions: 1, deletions: 1 }],
  patch,
})
const claude: ModelRef = { provider: 'claude-cli', model: 'haiku', effort: 'low' }
const codex: ModelRef = { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' }
const judge: ModelRef = { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' }
const repo = { id: 'r' as RepoId, path: '/repo', defaultBranch: 'main' }
const a = 'a1' as AttemptId
const b = 'a2' as AttemptId

async function run(deps: Parameters<typeof compete>[1], signal = new AbortController().signal) {
  const events: CompeteEvent[] = []
  for await (const event of compete(
    {
      taskId: 't' as TaskId,
      repo,
      prompt: 'Fix add()',
      contestants: [
        { attemptId: a, implementer: claude, reviewer: codex },
        { attemptId: b, implementer: codex, reviewer: claude },
      ],
      judge,
      signal,
    },
    deps,
  ))
    events.push(event)
  return events
}

describe('compete', () => {
  it('runs both attempts in parallel with a cross review each, then the judge compares them', async () => {
    // Each implementer waits until both have started: run one after the other and this never finishes.
    let started = 0
    let release: () => void = () => {}
    const bothStarted = new Promise<void>((resolve) => (release = resolve))
    const slowImplement = async (): Promise<AgentEvent[]> => {
      if (++started === 2) release()
      await bothStarted
      return [{ type: 'done', sessionId: 'i', isError: false, finalMessage: 'done' }]
    }
    const claudeProvider = new RoutingProvider('claude-cli', { implement: slowImplement })
    const codexProvider = new RoutingProvider('codex-cli', { implement: slowImplement })
    const judgeProvider = new RoutingProvider('openai-api', {
      judge: {
        winner: 'b',
        reasons: 'B handles NaN',
        attempts: [
          { label: 'A', strengths: 'short', weaknesses: 'misses NaN' },
          { label: 'B', strengths: 'handles NaN', weaknesses: 'longer' },
        ],
        merge_recommended: true,
      },
    })
    const executor = new PerAttemptExecutor({ a1: change('+claude fix'), a2: change('+codex fix') })
    const events = await run({
      providers: { 'claude-cli': claudeProvider, 'codex-cli': codexProvider, 'openai-api': judgeProvider },
      executor,
    })
    expect(executor.prepared.sort()).toEqual(['a1', 'a2'])
    expect(started).toBe(2)
    // Each change is reviewed by the other model, once.
    expect(codexProvider.calls.filter((c) => c.outputSchema === REVIEW_SCHEMA)).toHaveLength(1)
    expect(claudeProvider.calls.filter((c) => c.outputSchema === REVIEW_SCHEMA)).toHaveLength(1)
    const judgePromptText = judgeProvider.calls[0]?.prompt ?? ''
    expect(judgePromptText).toContain('+claude fix')
    expect(judgePromptText).toContain('+codex fix')
    expect(judgeProvider.calls[0]).toMatchObject({ autonomy: 'read-only', cwd: '/repo' })
    const judgement = events.find((e) => e.type === 'judgement')
    expect(judgement).toMatchObject({
      judgement: {
        winner: 'a2',
        reasons: 'B handles NaN',
        mergeRecommended: true,
        attempts: [
          { attemptId: 'a1', weaknesses: 'misses NaN' },
          { attemptId: 'a2', strengths: 'handles NaN' },
        ],
      },
    })
    expect(events.at(-1)).toEqual({ type: 'result', status: 'succeeded' })
  })

  it('skips the judge when only one attempt produced a change', async () => {
    const judgeProvider = new RoutingProvider('openai-api', {})
    const events = await run({
      providers: {
        'claude-cli': new RoutingProvider('claude-cli', {}),
        'codex-cli': new RoutingProvider('codex-cli', {}),
        'openai-api': judgeProvider,
      },
      executor: new PerAttemptExecutor({ a1: change('+only') }),
    })
    expect(judgeProvider.calls).toEqual([])
    expect(events.find((e) => e.type === 'judgement')).toMatchObject({ judgement: { winner: 'a1' } })
  })

  it('fails when no attempt produced a change, and reports a judge that does not answer', async () => {
    const providers = {
      'claude-cli': new RoutingProvider('claude-cli', {}),
      'codex-cli': new RoutingProvider('codex-cli', {}),
      'openai-api': new RoutingProvider('openai-api', { judge: { nonsense: true } }),
    }
    expect((await run({ providers, executor: new PerAttemptExecutor({}) })).at(-1)).toMatchObject({
      type: 'result',
      status: 'failed',
      reason: 'No attempt produced a change',
    })
    const both = new PerAttemptExecutor({ a1: change('+x'), a2: change('+y') })
    expect((await run({ providers, executor: both })).at(-1)).toMatchObject({
      status: 'failed',
      reason: 'The judge did not return a valid comparison',
    })
  })

  it('ignores a judge that names an attempt that does not exist or failed', () => {
    const outcomes: ContestantOutcome[] = [
      { attemptId: a, label: 'A', implementer: claude, status: 'succeeded', approved: true },
      { attemptId: b, label: 'B', implementer: codex, status: 'failed', approved: false },
    ]
    const base = {
      reasons: 'r',
      attempts: [{ label: 'Z', strengths: '', weaknesses: '' }],
      merge_recommended: false,
    }
    expect(parseJudgement({ ...base, winner: 'B' }, outcomes)).toMatchObject({ winner: null, attempts: [] })
    expect(parseJudgement({ ...base, winner: 'C' }, outcomes)?.winner).toBeNull()
    expect(parseJudgement({ ...base, winner: 'A' }, outcomes)?.winner).toBe('a1')
  })

  it('gives the merge run both patches and the comparison', () => {
    const outcomes: ContestantOutcome[] = [
      {
        attemptId: a,
        label: 'A',
        implementer: claude,
        status: 'succeeded',
        approved: true,
        diff: change('+one'),
      },
      {
        attemptId: b,
        label: 'B',
        implementer: codex,
        status: 'succeeded',
        approved: true,
        diff: change('+two'),
      },
    ]
    const prompt = mergePrompt('Fix add()', outcomes, {
      winner: a,
      reasons: 'A is simpler',
      attempts: [{ attemptId: b, strengths: 'tests', weaknesses: 'verbose' }],
      mergeRecommended: true,
    })
    expect(prompt).toContain('+one')
    expect(prompt).toContain('+two')
    expect(prompt).toContain('- B: strengths: tests; weaknesses: verbose')
  })
})
