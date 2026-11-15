import type { RoleConfig } from './roles.js'

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type RepoId = Brand<string, 'RepoId'>
export type TaskId = Brand<string, 'TaskId'>
export type AttemptId = Brand<string, 'AttemptId'>

export type TaskProvenance = 'user' | 'external_content'

export const TASK_MODES = ['single', 'review_loop', 'compete'] as const
export type TaskMode = (typeof TASK_MODES)[number]

/**
 * How much a task's agent may do without asking the owner (per task, like Claude Code / Codex permission modes).
 * `ask`: only a short allowlist runs on its own. `auto`: anything that stays inside the task's worktree runs.
 * `full`: nearly everything runs; secrets, the keychain and Joy's own config still need the owner.
 * The order matters: a repository's maximum allows that mode and every mode before it.
 */
export const PERMISSION_MODES = ['ask', 'auto', 'full'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

/** The stricter of two modes (a task's choice clamped to a repository's maximum). */
export function clampPermissionMode(mode: PermissionMode, max: PermissionMode): PermissionMode {
  return PERMISSION_MODES.indexOf(mode) <= PERMISSION_MODES.indexOf(max) ? mode : max
}

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
  /** Origin of the task request; external content may never trigger automatic actions. */
  provenance: TaskProvenance
  mode: TaskMode
  permissionMode: PermissionMode
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
