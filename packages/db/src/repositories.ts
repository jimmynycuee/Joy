import type {
  AttemptId,
  AttemptStatus,
  ProviderKind,
  RepoId,
  RepoRef,
  RoleConfig,
  Task,
  TaskId,
  TaskMode,
  TaskStatus,
} from '@joy/core'
import type { Database } from './database.js'

export interface RepoRecord extends RepoRef {
  createdAt: string
}

export interface StoredTask extends Task {
  updatedAt: string
}

export interface AttemptRecord {
  id: AttemptId
  taskId: TaskId
  provider: ProviderKind
  model: string
  worktreePath?: string
  branch?: string
  baseCommit?: string
  sessionId?: string
  status: AttemptStatus
  diffStats?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

interface RepoRow {
  id: string
  path: string
  github_remote: string | null
  default_branch: string
  created_at: string
}

interface TaskRow {
  id: string
  repo_id: string
  title: string
  prompt: string
  mode: TaskMode
  role_overrides: string
  plan_first: number
  max_rounds: number
  status: TaskStatus
  created_at: string
  updated_at: string
}

interface AttemptRow {
  id: string
  task_id: string
  provider: ProviderKind
  model: string
  worktree_path: string | null
  branch: string | null
  base_commit: string | null
  session_id: string | null
  status: AttemptStatus
  diff_stats: string | null
  created_at: string
  updated_at: string
}

export function createRepo(db: Database, repo: Omit<RepoRecord, 'createdAt'>): RepoRecord {
  db.prepare('INSERT INTO repos (id, path, github_remote, default_branch) VALUES (?, ?, ?, ?)').run(
    repo.id,
    repo.path,
    repo.githubRemote ?? null,
    repo.defaultBranch,
  )
  const stored = getRepo(db, repo.id)
  if (!stored) throw new Error(`Repository ${repo.id} was not found after insert`)
  return stored
}

export function getRepo(db: Database, id: RepoId): RepoRecord | undefined {
  const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined
  return row ? mapRepo(row) : undefined
}

export function listRepos(db: Database): RepoRecord[] {
  return (db.prepare('SELECT * FROM repos ORDER BY created_at, id').all() as unknown as RepoRow[]).map(
    mapRepo,
  )
}

export interface NewTask {
  id: TaskId
  repoId: RepoId
  title: string
  prompt: string
  mode: TaskMode
  roleOverrides?: Partial<RoleConfig>
  planFirst?: boolean
  maxRounds?: number
}

export function createTask(db: Database, input: NewTask): StoredTask {
  db.prepare(
    `INSERT INTO tasks (id, repo_id, title, prompt, mode, role_overrides, plan_first, max_rounds, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
  ).run(
    input.id,
    input.repoId,
    input.title,
    input.prompt,
    input.mode,
    JSON.stringify(input.roleOverrides ?? {}),
    input.planFirst ? 1 : 0,
    input.maxRounds ?? 3,
  )
  const stored = getTask(db, input.id)
  if (!stored) throw new Error(`Task ${input.id} was not found after insert`)
  return stored
}

export function getTask(db: Database, id: TaskId): StoredTask | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? mapTask(row) : undefined
}

export function listTasks(db: Database): StoredTask[] {
  return (db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, id').all() as unknown as TaskRow[]).map(
    mapTask,
  )
}

export function setTaskStatus(db: Database, id: TaskId, status: TaskStatus): void {
  db.prepare(
    "UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(status, id)
}

export interface NewAttempt {
  id: AttemptId
  taskId: TaskId
  provider: ProviderKind
  model: string
  status: AttemptStatus
}

export function createAttempt(db: Database, input: NewAttempt): AttemptRecord {
  db.prepare('INSERT INTO attempts (id, task_id, provider, model, status) VALUES (?, ?, ?, ?, ?)').run(
    input.id,
    input.taskId,
    input.provider,
    input.model,
    input.status,
  )
  const stored = getAttempt(db, input.id)
  if (!stored) throw new Error(`Attempt ${input.id} was not found after insert`)
  return stored
}

export type AttemptUpdate = Partial<
  Pick<
    AttemptRecord,
    'provider' | 'model' | 'worktreePath' | 'branch' | 'baseCommit' | 'sessionId' | 'status' | 'diffStats'
  >
>

export function updateAttempt(db: Database, id: AttemptId, update: AttemptUpdate): void {
  const columns: Record<keyof AttemptUpdate, string> = {
    provider: 'provider',
    model: 'model',
    worktreePath: 'worktree_path',
    branch: 'branch',
    baseCommit: 'base_commit',
    sessionId: 'session_id',
    status: 'status',
    diffStats: 'diff_stats',
  }
  const values: (string | number | null)[] = []
  const sets: string[] = []
  for (const [key, column] of Object.entries(columns) as [keyof AttemptUpdate, string][]) {
    if (!(key in update)) continue
    const value = update[key]
    sets.push(`${column} = ?`)
    values.push(
      key === 'diffStats'
        ? value === undefined
          ? null
          : JSON.stringify(value)
        : typeof value === 'string' || typeof value === 'number'
          ? value
          : null,
    )
  }
  if (sets.length === 0) return
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
  db.prepare(`UPDATE attempts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
}

export function getAttempt(db: Database, id: AttemptId): AttemptRecord | undefined {
  const row = db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as AttemptRow | undefined
  return row ? mapAttempt(row) : undefined
}

export function listAttempts(db: Database, taskId: TaskId): AttemptRecord[] {
  return (
    db
      .prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY created_at, id')
      .all(taskId) as unknown as AttemptRow[]
  ).map(mapAttempt)
}

export function latestAttempt(db: Database, taskId: TaskId): AttemptRecord | undefined {
  const row = db
    .prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(taskId) as unknown as AttemptRow | undefined
  return row ? mapAttempt(row) : undefined
}

/** Marks active work as interrupted but leaves its worktree/session checkpoint available to resume. */
export function interruptRunningWork(db: Database): TaskId[] {
  const tasks = db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as unknown as {
    id: string
  }[]
  db.exec('BEGIN')
  try {
    db.prepare(
      "UPDATE attempts SET status = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status IN ('preparing', 'running', 'reviewing', 'fixing') AND task_id IN (SELECT id FROM tasks WHERE status = 'running')",
    ).run()
    db.prepare(
      "UPDATE tasks SET status = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'running'",
    ).run()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return tasks.map(({ id }) => id as TaskId)
}

function mapRepo(row: RepoRow): RepoRecord {
  return {
    id: row.id as RepoId,
    path: row.path,
    defaultBranch: row.default_branch,
    ...(row.github_remote ? { githubRemote: row.github_remote } : {}),
    createdAt: row.created_at,
  }
}

function mapTask(row: TaskRow): StoredTask {
  return {
    id: row.id as TaskId,
    repoId: row.repo_id as RepoId,
    title: row.title,
    prompt: row.prompt,
    mode: row.mode,
    roleOverrides: JSON.parse(row.role_overrides) as Partial<RoleConfig>,
    planFirst: row.plan_first === 1,
    maxRounds: row.max_rounds,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAttempt(row: AttemptRow): AttemptRecord {
  return {
    id: row.id as AttemptId,
    taskId: row.task_id as TaskId,
    provider: row.provider,
    model: row.model,
    ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    status: row.status,
    ...(row.diff_stats ? { diffStats: JSON.parse(row.diff_stats) as Record<string, unknown> } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
