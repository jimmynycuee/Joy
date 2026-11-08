import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentProvider,
  AttemptId,
  Executor,
  McpServerConfig,
  ModelRef,
  ProviderKind,
  RepoRef,
  ReviewFinding,
  ReviewVerdict,
  Role,
  RunOptions,
  TaskId,
  Workspace,
  WorkspaceDiff,
} from '@joy/core'
import { sameBackend } from '@joy/core'
import {
  REVIEW_SCHEMA,
  fixPrompt,
  implementPrompt,
  planPrompt,
  planReviewPrompt,
  reviewPrompt,
  withOwnerMessages,
} from './prompts.js'
import type { ChecksResult } from './prompts.js'

export type Phase = 'preparing' | 'planning' | 'plan_review' | 'implementing' | 'reviewing' | 'fixing'

export type LoopEvent =
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'phase'; phase: Phase; round: number; role?: Role; model?: ModelRef }
  | { type: 'agent'; role: Role; round: number; event: AgentEvent }
  | { type: 'review'; round: number; target: 'plan' | 'change'; verdict: ReviewVerdict }
  | ({ type: 'checks'; round: number } & ChecksResult)
  | { type: 'warning'; message: string }
  | {
      type: 'result'
      status: 'succeeded' | 'failed' | 'cancelled'
      /** Reviewer approved the final change. false with `succeeded` = rounds ran out, a human decides. */
      approved: boolean
      rounds: number
      diff?: WorkspaceDiff
      reason?: string
      /** The run stopped after the plan: the owner approves it (or sends feedback) before any code is written. */
      awaitingPlanApproval?: true
      plan?: string
      planReview?: ReviewVerdict
    }

export interface ReviewLoopInput {
  taskId: TaskId
  attemptId: AttemptId
  repo: RepoRef
  prompt: string
  implementer: ModelRef
  reviewer: ModelRef
  planFirst: boolean
  maxRounds: number
  signal: AbortSignal
  /** Joy's Tool Hub and approval tool, passed to every agent run. */
  mcpServers?: McpServerConfig[]
  approvalTool?: string
  /** Reuse a persisted worktree and resume the implementer's last CLI session after server restart. */
  resumeWorkspace?: Workspace
  resumeSessionId?: string
  /** What the resumed session is told first; defaults to the implement prompt for `prompt`. */
  resumePrompt?: string
  /** Plan again in the resumed session with this prompt (owner feedback on a plan), then stop for approval. */
  replanPrompt?: string
  /** Number of the first round of this run, so a continued task does not reuse earlier round numbers. Default 1. */
  firstRound?: number
  /** Owner messages that arrived during the run; appended to the next implementer turn. */
  takeMessages?: () => string[]
  /** The project's checks, run after each implementer turn and before each review. undefined = not run. */
  runChecks?: (ws: Workspace, round: number) => Promise<ChecksResult | undefined>
}

export interface ReviewLoopDeps {
  providers: Partial<Record<ProviderKind, AgentProvider>>
  executor: Executor
}

class StopLoop extends Error {
  constructor(
    readonly status: 'failed' | 'cancelled',
    message: string,
  ) {
    super(message)
  }
}

/**
 * One model implements in its own worktree, another reviews the diff with structured findings, the
 * first fixes in the same session, up to `maxRounds` reviews. Optional plan + plan review first.
 * Does not clean up the workspace: the caller decides after the human looks at the result.
 */
export async function* reviewLoop(input: ReviewLoopInput, deps: ReviewLoopDeps): AsyncGenerator<LoopEvent> {
  const implementer = provider(deps, input.implementer)
  const reviewer = provider(deps, input.reviewer)
  if (sameBackend(input.implementer, input.reviewer)) {
    yield {
      type: 'warning',
      message: 'Implementer and reviewer use the same model: this is not a cross-model review.',
    }
  }

  let rounds = 0
  try {
    yield { type: 'phase', phase: 'preparing', round: 0 }
    const ws =
      input.resumeWorkspace ?? (await deps.executor.prepare(input.repo, input.taskId, input.attemptId))
    yield { type: 'workspace', workspace: ws }

    const base = (over: Partial<RunOptions>): RunOptions => ({
      cwd: ws.path,
      prompt: '',
      autonomy: 'workspace-write',
      signal: input.signal,
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      ...(input.approvalTool ? { approvalTool: input.approvalTool } : {}),
      ...over,
    })

    // Optional plan, reviewed before any code is written. The run then stops: the owner approves the plan first.
    let session: string | undefined = input.resumeSessionId
    const take = () => input.takeMessages?.() ?? []
    if ((input.planFirst && !input.resumeSessionId) || input.replanPrompt) {
      yield { type: 'phase', phase: 'planning', round: 0, role: 'implementer', model: input.implementer }
      const planned = yield* runAgent(
        implementer,
        input.implementer,
        'implementer',
        0,
        base({
          prompt: withOwnerMessages(input.replanPrompt ?? planPrompt(input.prompt), take()),
          autonomy: 'read-only',
          ...(session ? { resumeSessionId: session } : presetSession(implementer)),
        }),
      )
      const plan = planned.finalMessage ?? ''
      yield { type: 'phase', phase: 'plan_review', round: 0, role: 'reviewer', model: input.reviewer }
      const planVerdict = yield* review(
        reviewer,
        input.reviewer,
        0,
        base({
          prompt: planReviewPrompt(input.prompt, plan),
          autonomy: 'read-only',
        }),
      )
      yield { type: 'review', round: 0, target: 'plan', verdict: planVerdict }
      yield {
        type: 'result',
        status: 'succeeded',
        approved: false,
        rounds: 0,
        awaitingPlanApproval: true,
        plan,
        planReview: planVerdict,
        reason: 'The plan is ready for your approval',
      }
      return
    }

    const first = input.firstRound ?? 1
    yield {
      type: 'phase',
      phase: 'implementing',
      round: first,
      role: 'implementer',
      model: input.implementer,
    }
    const implemented = yield* runAgent(
      implementer,
      input.implementer,
      'implementer',
      first,
      base({
        prompt: withOwnerMessages(
          session && input.resumePrompt ? input.resumePrompt : implementPrompt(input.prompt),
          take(),
        ),
        ...(session ? { resumeSessionId: session } : presetSession(implementer)),
      }),
    )
    session = implemented.sessionId || session

    for (rounds = first; ; rounds++) {
      const diff = await deps.executor.diff(ws)
      if (diff.files.length === 0) throw new StopLoop('failed', 'The implementer made no changes')

      const checks = input.runChecks ? await input.runChecks(ws, rounds) : undefined
      if (input.signal.aborted) throw new StopLoop('cancelled', 'Cancelled')
      if (checks) yield { type: 'checks', round: rounds, ...checks }

      yield { type: 'phase', phase: 'reviewing', round: rounds, role: 'reviewer', model: input.reviewer }
      const verdict = yield* review(
        reviewer,
        input.reviewer,
        rounds,
        base({
          prompt: reviewPrompt(input.prompt, diff.patch, checks),
          autonomy: 'read-only',
        }),
      )
      yield { type: 'review', round: rounds, target: 'change', verdict }

      const checksFailed = checks !== undefined && !checks.ok
      if (verdict.approve && !checksFailed) {
        yield { type: 'result', status: 'succeeded', approved: true, rounds, diff }
        return
      }
      if (rounds - first + 1 >= input.maxRounds) {
        yield {
          type: 'result',
          status: 'succeeded',
          approved: false,
          rounds,
          diff,
          reason: verdict.approve
            ? `The project checks still failed after ${rounds - first + 1} round(s); needs a human decision`
            : `Reviewer still had findings after ${rounds - first + 1} round(s); needs a human decision`,
        }
        return
      }

      yield {
        type: 'phase',
        phase: 'fixing',
        round: rounds + 1,
        role: 'implementer',
        model: input.implementer,
      }
      const fixed = yield* runAgent(
        implementer,
        input.implementer,
        'implementer',
        rounds + 1,
        base({
          prompt: withOwnerMessages(fixPrompt(verdict, checks), take()),
          ...(session && implementer.capabilities.resume ? { resumeSessionId: session } : {}),
        }),
      )
      session = fixed.sessionId || session
    }
  } catch (err) {
    if (input.signal.aborted) {
      yield { type: 'result', status: 'cancelled', approved: false, rounds, reason: 'Cancelled' }
    } else if (err instanceof StopLoop) {
      yield { type: 'result', status: err.status, approved: false, rounds, reason: err.message }
    } else {
      yield { type: 'result', status: 'failed', approved: false, rounds, reason: (err as Error).message }
    }
  }
}

function provider(deps: ReviewLoopDeps, model: ModelRef): AgentProvider {
  const p = deps.providers[model.provider]
  if (!p) throw new Error(`No provider configured for ${model.provider}`)
  return p
}

function presetSession(p: AgentProvider): Partial<RunOptions> {
  return p.capabilities.presetSessionId ? { sessionId: randomUUID() } : {}
}

/** Runs one agent turn, forwarding its events. Throws StopLoop when the run fails. */
async function* runAgent(
  p: AgentProvider,
  model: ModelRef,
  role: Role,
  round: number,
  opts: RunOptions,
): AsyncGenerator<LoopEvent, Extract<AgentEvent, { type: 'done' }>> {
  let done: Extract<AgentEvent, { type: 'done' }> | undefined
  let lastError: string | undefined
  for await (const event of p.run(opts, model)) {
    yield { type: 'agent', role, round, event }
    if (event.type === 'error' && !event.recoverable) lastError = event.message
    if (event.type === 'done') done = event
  }
  if (opts.signal.aborted) throw new StopLoop('cancelled', 'Cancelled')
  if (!done) throw new StopLoop('failed', `${role} ended without a result`)
  if (done.isError)
    throw new StopLoop(
      'failed',
      `${role} (${model.provider}:${model.model}) failed: ${lastError ?? 'unknown error'}`,
    )
  return done
}

async function* review(
  p: AgentProvider,
  model: ModelRef,
  round: number,
  opts: RunOptions,
): AsyncGenerator<LoopEvent, ReviewVerdict> {
  const done = yield* runAgent(p, model, 'reviewer', round, { ...opts, outputSchema: REVIEW_SCHEMA })
  const verdict = parseVerdict(done.structured ?? tryJson(done.finalMessage))
  if (!verdict) throw new StopLoop('failed', 'The reviewer did not return a valid structured review')
  return verdict
}

function tryJson(text: string | undefined): unknown {
  if (!text) return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  try {
    return JSON.parse(fenced?.[1] ?? text)
  } catch {
    return undefined
  }
}

const SEVERITIES = new Set(['blocker', 'major', 'minor', 'nit'])

/** Validates reviewer output (untrusted model output) into a ReviewVerdict, dropping malformed findings. */
export function parseVerdict(value: unknown): ReviewVerdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.approve !== 'boolean') return undefined
  const findings: ReviewFinding[] = []
  for (const f of Array.isArray(v.findings) ? v.findings : []) {
    if (typeof f !== 'object' || f === null) continue
    const r = f as Record<string, unknown>
    if (typeof r.message !== 'string' || !SEVERITIES.has(r.severity as string)) continue
    findings.push({
      severity: r.severity as ReviewFinding['severity'],
      message: r.message,
      ...(typeof r.file === 'string' && r.file ? { file: r.file } : {}),
      ...(typeof r.line === 'number' && Number.isInteger(r.line) ? { line: r.line } : {}),
    })
  }
  // A reviewer that approves while listing blockers did not really approve.
  const approve = v.approve && !findings.some((f) => f.severity === 'blocker')
  return { approve, summary: typeof v.summary === 'string' ? v.summary : '', findings }
}
