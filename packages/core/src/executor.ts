import type { AttemptId, RepoRef, TaskId } from './task.js'

export interface Workspace {
  repo: RepoRef
  taskId: TaskId
  attemptId: AttemptId
  /** Absolute path of the git worktree. */
  path: string
  branch: string
  baseCommit: string
}

export interface DiffFile {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

export interface WorkspaceDiff {
  files: DiffFile[]
  /** Unified diff against `baseCommit`. */
  patch: string
}

export interface Executor {
  prepare(repo: RepoRef, taskId: TaskId, attemptId: AttemptId): Promise<Workspace>
  diff(ws: Workspace): Promise<WorkspaceDiff>
  /** Commits everything in the worktree; returns the new commit sha, or null when there was nothing to commit. */
  commit(ws: Workspace, message: string): Promise<string | null>
  cleanup(ws: Workspace): Promise<void>
}
