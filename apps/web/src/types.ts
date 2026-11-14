import type { ProviderKind, RoleConfig } from '@joy/core'
import type { RepoColorId } from './repo-colors.js'

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
}
export type Task = {
  id: string
  repoId: string
  title: string
  prompt: string
  provenance?: 'user' | 'agent' | 'external_content'
  mode: string
  status: string
  roleOverrides?: Partial<RoleConfig>
  createdAt: string
  updatedAt?: string
  /** Server-side archive flag; missing means not archived. */
  archived?: boolean
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
  /** A message sent now reaches the working agent at once, without stopping it (missing from older servers). */
  steerable?: boolean
  /** `interrupt: true` would stop the agent's current step now (missing from older servers). */
  interruptible?: boolean
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
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
