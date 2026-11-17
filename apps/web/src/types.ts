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
export type DiffFile = {
  path: string
  oldPath?: string
  status: string
  additions: number
  deletions: number
}
export type WorkspaceDiff = { files: DiffFile[]; patch: string }
/** Tokens and cost of one slice of a task; only what was reported is present. `inputTokens` includes the cached ones. */
export interface UsageTotals {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  costUsd?: number
}
export interface ProviderUsage extends UsageTotals {
  provider: string
  model: string
}
/** One role of the task (implementer, reviewer, judge); `durationMs` leaves the wait for approvals out. */
export interface RoleUsage extends UsageTotals {
  role: string
  provider?: string
  model?: string
  durationMs?: number
}
/** One run of the task; `endSeq` is the event that ended it, where the timeline shows its line. */
export interface RunUsage extends UsageTotals {
  endSeq: number
  durationMs: number
  approvalWaitMs?: number
}
/** `cli`: the CLI's own figure; `price_table`: Joy's price table applied to the tokens; `mixed`: both. */
export type CostSource = 'cli' | 'price_table' | 'mixed'
export interface TaskUsage extends UsageTotals {
  /** Wall-clock time the task ran, the wait for approvals left out. */
  durationMs: number
  approvalWaitMs?: number
  costSource?: CostSource
  byProvider: ProviderUsage[]
  byRole: RoleUsage[]
  runs: RunUsage[]
}
export interface PendingPlan {
  plan: string
  review?: unknown
}
export interface QueuedMessage {
  id: string
  text: string
  /** How many files go with it. */
  attachments?: number
  /** It changes the models, mode or permission mode from the next run. */
  settings?: boolean
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
  /** Actions the owner allowed for the rest of this task (missing from older servers). */
  taskAllows?: TaskAllow[]
  /** Rounds the owner can go back to (see rewind.ts; missing from older servers). */
  rewindPoints?: unknown
}
export type TaskAllowKind = 'shell' | 'file_write' | 'file_read' | 'network' | 'mcp'
export interface TaskAllow {
  id: string
  kind: TaskAllowKind
  /** The command, path, host or MCP tool, as the owner saw it on the approval card. */
  target: string
  approvalId: string
  createdAt: string
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
