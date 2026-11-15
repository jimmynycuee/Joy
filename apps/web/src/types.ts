import type { ModelRef, PermissionMode, ProviderKind, RoleConfig } from '@joy/core'
import type { RepoColorId } from './repo-colors.js'

/** What the home page's message box starts from for a project; every field is optional. */
export type ProjectDefaults = {
  implementer?: ModelRef
  reviewer?: ModelRef
  /** A built-in mode: `single`, `review_loop` or `compete`. */
  mode?: string
  permissionMode?: PermissionMode
}

export type Repo = {
  id: string
  path: string
  defaultBranch: string
  githubRemote?: string
  allowedProviders?: ProviderKind[]
  /** argv run without a shell before review, e.g. ['pnpm', 'check']. */
  checkCommand?: string[]
  /** The colour the owner picked; missing means Joy hands one out by order (see repo-colors.ts). */
  color?: RepoColorId
  /** The highest permission mode a task here may use; missing means no limit. */
  maxPermissionMode?: PermissionMode
  /** Written by the owner; every new agent session in the project starts with it. */
  instructions?: string
  /** argv that installs dependencies in a new worktree instead of the lockfile install. */
  installCommand?: string[]
  defaults?: ProjectDefaults
}
export type Task = {
  id: string
  repoId: string
  title: string
  prompt: string
  provenance?: 'user' | 'agent' | 'external_content'
  mode: string
  /** Missing on servers from before permission modes. */
  permissionMode?: PermissionMode
  status: string
  roleOverrides?: Partial<RoleConfig>
  createdAt: string
  updatedAt?: string
  /** Server-side archive flag; missing means not archived. */
  archived?: boolean
  /** When the owner pinned it to the top of the sidebar; missing means not pinned. */
  pinnedAt?: string
}
export type TaskEvent = {
  taskId: string
  attemptId?: string
  seq: number
  eventId?: string
  type: string
  payload: unknown
  ts: string
}
export type DiffFile = { path: string; status: string; additions: number; deletions: number }
export type WorkspaceDiff = { files: DiffFile[]; patch: string }
export interface ProviderUsage {
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}
export interface TaskUsage {
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  byProvider: ProviderUsage[]
}
export interface PendingPlan {
  plan: string
  review?: unknown
}
export interface QueuedMessage {
  id: string
  text: string
}
/** The task as `GET /api/tasks/:id` returns it. The fields after `events` are missing from older servers. */
export type TaskDetails = {
  task: Task
  repo: Repo | null
  attempts: unknown[]
  reviews: unknown[]
  events: TaskEvent[]
  usage?: TaskUsage
  pendingPlan?: PendingPlan | null
  queuedMessages?: QueuedMessage[]
  /** Files the owner attached: the first prompt's have no messageId (missing from older servers). */
  attachments?: Array<{
    id: string
    name: string
    mediaType: string
    size: number
    messageId?: string
    disabled?: boolean
  }>
  /** A message sent now reaches the working agent at once, without stopping it (missing from older servers). */
  steerable?: boolean
  /** `interrupt: true` would stop the agent's current step now (missing from older servers). */
  interruptible?: boolean
  /** Models, mode or permission mode a queued message changes once the current run ends (see task-settings.ts). */
  pendingSettings?: unknown
}
export type SecretStatus = { set: boolean; source?: 'env' | 'keychain' }
export type DoctorStatus = 'ok' | 'missing' | 'untested'
export type DoctorCheck = {
  id: string
  label: string
  status: DoctorStatus
  summary: string
  repair: string
  version?: string
}
export type DoctorReport = { checkedAt: string; checks: DoctorCheck[] }

export interface ConversationSummary {
  id: string
  title?: string
  brainProvider?: string
  updatedAt?: string
  createdAt: string
  /** When the owner pinned it to the top of the sidebar; missing means not pinned. */
  pinnedAt?: string
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
