import type { RoleConfig } from './roles.js'

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type RepoId = Brand<string, 'RepoId'>
export type TaskId = Brand<string, 'TaskId'>
export type AttemptId = Brand<string, 'AttemptId'>

export const TASK_MODES = ['single', 'review_loop', 'compete'] as const
export type TaskMode = (typeof TASK_MODES)[number]

export const TASK_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'review_ready',
  'done',
  'failed',
  'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const ATTEMPT_STATUSES = [
  'preparing',
  'running',
  'reviewing',
  'fixing',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

export interface RepoRef {
  id: RepoId
  /** Absolute path of the main checkout. */
  path: string
  defaultBranch: string
  githubRemote?: string
}

export interface Task {
  id: TaskId
  repoId: RepoId
  title: string
  prompt: string
  mode: TaskMode
  roleOverrides: Partial<RoleConfig>
  /** Plan-then-review before implementing (review_loop only). */
  planFirst: boolean
  maxRounds: number
  status: TaskStatus
  createdAt: string
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

/** Structured review output (reviewer final answer, validated by outputSchema). */
export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  file?: string
  line?: number
  message: string
}

export interface ReviewVerdict {
  approve: boolean
  summary: string
  findings: ReviewFinding[]
}
