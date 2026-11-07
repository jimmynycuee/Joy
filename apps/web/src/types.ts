import type { RoleConfig } from '@joy/core'

export type Repo = { id: string; path: string; defaultBranch: string; githubRemote?: string }
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
export type TaskDetails = {
  task: Task
  repo: Repo | null
  attempts: unknown[]
  reviews: unknown[]
  events: TaskEvent[]
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
