import { ROLE_SPEAKERS } from './labels.js'
import { parseTimestamp } from './dates.js'
import { record } from './types.js'
import type { Task, TaskEvent, WorkspaceDiff } from './types.js'

export interface BranchInfo {
  branch?: string
  worktreePath?: string
}

/**
 * The branch and worktree the task really works in, from its latest attempt that recorded one. Never the repository's
 * default branch: that is where the task starts from, not where it lives.
 */
export function taskBranchInfo(attempts: readonly unknown[]): BranchInfo {
  for (const attempt of [...attempts].reverse()) {
    const fields = record(attempt)
    const branch = typeof fields?.branch === 'string' && fields.branch ? fields.branch : undefined
    const worktreePath =
      typeof fields?.worktreePath === 'string' && fields.worktreePath ? fields.worktreePath : undefined
    if (branch || worktreePath) {
      return { ...(branch ? { branch } : {}), ...(worktreePath ? { worktreePath } : {}) }
    }
  }
  return {}
}

export interface RunProgress {
  /** Raw phase name of the latest `phase` event. */
  phase?: string
  /** 實作 / 審查 / 裁判 for the role of the latest phase. */
  role?: string
  /** How many implementing and fixing phases have started. */
  round: number
  /** Milliseconds since the epoch of the first event, the start of the run. */
  startedAt?: number
}

/** What the running indicator shows: who is working, in which round, and since when. */
export function runProgress(events: readonly TaskEvent[]): RunProgress {
  let phase: string | undefined
  let roleKey: string | undefined
  let round = 0
  let startedAt: number | undefined
  for (const event of events) {
    const time = parseTimestamp(event.ts)
    if (time !== undefined && (startedAt === undefined || time < startedAt)) startedAt = time
    if (event.type !== 'phase') continue
    const payload = record(event.payload)
    if (typeof payload?.phase !== 'string') continue
    phase = payload.phase
    roleKey = typeof payload.role === 'string' ? payload.role : undefined
    if (payload.phase === 'implementing' || payload.phase === 'fixing') round++
  }
  const role = roleKey ? ROLE_SPEAKERS[roleKey] : undefined
  return {
    round,
    ...(phase ? { phase } : {}),
    ...(role ? { role } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  }
}

/** Why a task failed, in the failure's own words: the last error event, else the failed result's reason. */
export function failureMessage(events: readonly TaskEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    const payload = record(event.payload)
    if (event.type === 'error' && typeof payload?.message === 'string') return payload.message
    if (event.type === 'result' && typeof payload?.reason === 'string' && payload.status !== 'succeeded')
      return payload.reason
    const agentEvent = record(payload?.event)
    if (event.type === 'agent' && agentEvent?.type === 'error' && typeof agentEvent.message === 'string')
      return agentEvent.message
  }
  return undefined
}

const ATTENTION_ORDER = ['awaiting_approval', 'review_ready', 'running', 'queued']

/** Tasks that want a look: waiting for approval, with review comments, or running. Needs-you first. */
export function tasksNeedingAttention(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => ATTENTION_ORDER.includes(task.status))
    .sort((a, b) => ATTENTION_ORDER.indexOf(a.status) - ATTENTION_ORDER.indexOf(b.status))
}

/** The diff to show: the attempt the owner chose in a compete task, else the latest result's diff. */
export function diffFrom(events: readonly TaskEvent[]): WorkspaceDiff | null {
  const asDiff = (value: unknown): WorkspaceDiff | null =>
    record(value) && Array.isArray((value as WorkspaceDiff).files) ? (value as WorkspaceDiff) : null
  const newestFirst = [...events].reverse()
  const chosen = record(newestFirst.find((event) => event.type === 'compete.chosen')?.payload)?.attemptId
  if (typeof chosen === 'string') {
    const result = newestFirst.find((e) => e.type === 'compete.result' && e.attemptId === chosen)
    const diff = asDiff(record(result?.payload)?.diff)
    if (diff) return diff
  }
  for (const event of newestFirst) {
    if (event.type !== 'result') continue
    const diff = asDiff(record(event.payload)?.diff)
    if (diff) return diff
  }
  return null
}
