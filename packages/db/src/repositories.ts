import type {
  AttemptId,
  AttemptStatus,
  ProviderKind,
  ProposedAction,
  RepoId,
  RepoRef,
  ReviewFinding,
  RoleConfig,
  Task,
  TaskId,
  TaskMode,
  TaskStatus,
  Tier,
} from '@joy/core'
import type { Database } from './database.js'

export interface RepoRecord extends RepoRef {
  createdAt: string
}

export interface StoredTask extends Task {
  updatedAt: string
}

export interface TaskEventRecord {
  taskId: TaskId
  attemptId: AttemptId
  seq: number
  type: string
  payload: unknown
  ts: string
}

export interface NewReview {
  id: string
  attemptId: AttemptId
  reviewerProvider: ProviderKind
  reviewerModel: string
  round: number
  approve: boolean
  summary: string
  findings: ReviewFinding[]
}

export interface ReviewRecord extends NewReview {
  createdAt: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface ApprovalRecord {
  id: string
  attemptId?: AttemptId
  action: ProposedAction
  tier: Tier
  status: ApprovalStatus
  decidedVia?: string
  note?: string
  createdAt: string
  decidedAt?: string
}

export interface NewApproval {
  id: string
  attemptId?: AttemptId
  action: ProposedAction
  tier: Tier
}

export interface UsageRecord {
  provider: ProviderKind
  day: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  rateLimitHits: number
}

export interface UsageIncrement {
  provider: ProviderKind
  day?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  rateLimitHits?: number
}

export interface ModelStatsSummary {
  provider: ProviderKind
  model: string
  taskKind: TaskMode
  attemptCount: number
  successCount: number
  successRate: number
  totalReviewIssues: number
  averageReviewIssues: number
  averageDurationMs: number
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

interface ReviewRow {
  id: string
  attempt_id: string
  reviewer_provider: ProviderKind
  reviewer_model: string
  round: number
  approve: number
  summary: string
  findings: string
  created_at: string
}

interface ApprovalRow {
  id: string
  attempt_id: string | null
  action: string
  tier: Tier
  status: ApprovalStatus
  decided_via: string | null
  note: string | null
  created_at: string
  decided_at: string | null
}

interface UsageRow {
  provider: ProviderKind
  day: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  rate_limit_hits: number
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

interface ModelStatsRow {
  provider: ProviderKind
  model: string
  task_kind: TaskMode
  attempt_count: number
  success_count: number
  total_review_issues: number
  average_review_issues: number
  average_duration_ms: number
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

export function appendTaskEvent(
  db: Database,
  attemptId: AttemptId,
  type: string,
  payload: unknown,
): TaskEventRecord {
  const attempt = db.prepare('SELECT task_id FROM attempts WHERE id = ?').get(attemptId) as
    { task_id: string } | undefined
  if (!attempt) throw new Error(`Attempt ${attemptId} was not found`)
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(e.seq), 0) AS seq FROM events e JOIN attempts a ON a.id = e.attempt_id WHERE a.task_id = ?',
    )
    .get(attempt.task_id) as { seq: number }
  const seq = row.seq + 1
  const result = db
    .prepare('INSERT INTO events (attempt_id, seq, type, payload) VALUES (?, ?, ?, ?)')
    .run(attemptId, seq, type, JSON.stringify(payload))
  const event = db
    .prepare(`SELECT e.seq, e.type, e.payload, e.ts FROM events e WHERE e.id = ?`)
    .get(result.lastInsertRowid) as { seq: number; type: string; payload: string; ts: string }
  return {
    taskId: attempt.task_id as TaskId,
    attemptId,
    seq: event.seq,
    type: event.type,
    payload: JSON.parse(event.payload) as unknown,
    ts: event.ts,
  }
}

export function listTaskEvents(db: Database, taskId: TaskId, after = 0): TaskEventRecord[] {
  const rows = db
    .prepare(
      `SELECT e.attempt_id, e.seq, e.type, e.payload, e.ts
       FROM events e JOIN attempts a ON a.id = e.attempt_id
       WHERE a.task_id = ? AND e.seq > ? ORDER BY e.seq, e.id`,
    )
    .all(taskId, after) as unknown as {
    attempt_id: string
    seq: number
    type: string
    payload: string
    ts: string
  }[]
  return rows.map((row) => ({
    taskId,
    attemptId: row.attempt_id as AttemptId,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    ts: row.ts,
  }))
}

export function createReview(db: Database, input: NewReview): ReviewRecord {
  db.prepare(
    `INSERT INTO reviews (id, attempt_id, reviewer_provider, reviewer_model, round, approve, summary, findings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (attempt_id, round) DO UPDATE SET
       reviewer_provider = excluded.reviewer_provider,
       reviewer_model = excluded.reviewer_model,
       approve = excluded.approve,
       summary = excluded.summary,
       findings = excluded.findings`,
  ).run(
    input.id,
    input.attemptId,
    input.reviewerProvider,
    input.reviewerModel,
    input.round,
    input.approve ? 1 : 0,
    input.summary,
    JSON.stringify(input.findings),
  )
  const row = db
    .prepare('SELECT * FROM reviews WHERE attempt_id = ? AND round = ?')
    .get(input.attemptId, input.round) as ReviewRow | undefined
  if (!row) throw new Error(`Review ${input.id} was not found after insert`)
  return mapReview(row)
}

export function listReviews(db: Database, attemptId: AttemptId): ReviewRecord[] {
  return (
    db
      .prepare('SELECT * FROM reviews WHERE attempt_id = ? ORDER BY round, created_at, id')
      .all(attemptId) as unknown as ReviewRow[]
  ).map(mapReview)
}

export function createApproval(db: Database, input: NewApproval): ApprovalRecord {
  db.prepare(
    "INSERT INTO approvals (id, attempt_id, action, tier, status) VALUES (?, ?, ?, ?, 'pending')",
  ).run(input.id, input.attemptId ?? null, JSON.stringify(input.action), input.tier)
  const approval = getApproval(db, input.id)
  if (!approval) throw new Error(`Approval ${input.id} was not found after insert`)
  return approval
}

export function getApproval(db: Database, id: string): ApprovalRecord | undefined {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined
  return row ? mapApproval(row) : undefined
}

export function listTaskApprovals(db: Database, taskId: TaskId, status?: ApprovalStatus): ApprovalRecord[] {
  const rows = db
    .prepare(
      `SELECT p.* FROM approvals p
       JOIN attempts a ON a.id = p.attempt_id
       WHERE a.task_id = ? AND (? IS NULL OR p.status = ?)
       ORDER BY p.created_at, p.id`,
    )
    .all(taskId, status ?? null, status ?? null) as unknown as ApprovalRow[]
  return rows.map(mapApproval)
}

export function decideApproval(
  db: Database,
  id: string,
  decision: Extract<ApprovalStatus, 'approved' | 'denied'>,
  decidedVia: string,
  note?: string,
): ApprovalRecord | undefined {
  db.prepare(
    `UPDATE approvals SET status = ?, decided_via = ?, note = ?,
       decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status = 'pending'`,
  ).run(decision, decidedVia, note ?? null, id)
  return getApproval(db, id)
}

export function expirePendingApprovals(db: Database, taskId: TaskId): number {
  const result = db
    .prepare(
      `UPDATE approvals SET status = 'expired', decided_via = 'task_cancelled',
         decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'pending' AND attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)`,
    )
    .run(taskId)
  return Number(result.changes)
}

export function addUsage(db: Database, input: UsageIncrement): UsageRecord {
  const day = input.day ?? new Date().toISOString().slice(0, 10)
  db.prepare(
    `INSERT INTO usage (provider, day, input_tokens, output_tokens, cost_usd, rate_limit_hits)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, day) DO UPDATE SET
       input_tokens = usage.input_tokens + excluded.input_tokens,
       output_tokens = usage.output_tokens + excluded.output_tokens,
       cost_usd = usage.cost_usd + excluded.cost_usd,
       rate_limit_hits = usage.rate_limit_hits + excluded.rate_limit_hits`,
  ).run(
    input.provider,
    day,
    input.inputTokens ?? 0,
    input.outputTokens ?? 0,
    input.costUsd ?? 0,
    input.rateLimitHits ?? 0,
  )
  const row = db.prepare('SELECT * FROM usage WHERE provider = ? AND day = ?').get(input.provider, day) as
    UsageRow | undefined
  if (!row) throw new Error(`Usage for ${input.provider} on ${day} was not found after update`)
  return mapUsage(row)
}

export function listUsage(db: Database): UsageRecord[] {
  return (db.prepare('SELECT * FROM usage ORDER BY day DESC, provider').all() as unknown as UsageRow[]).map(
    mapUsage,
  )
}

/** Aggregates completed attempt snapshots by provider, model, and task mode. */
export function listModelStats(db: Database): ModelStatsSummary[] {
  const rows = db
    .prepare(
      `SELECT provider, model, task_kind, COUNT(*) AS attempt_count, SUM(success) AS success_count,
         SUM(review_issues) AS total_review_issues, AVG(review_issues) AS average_review_issues,
         AVG(duration_ms) AS average_duration_ms
       FROM model_stats
       GROUP BY provider, model, task_kind
       ORDER BY task_kind, provider, model`,
    )
    .all() as unknown as ModelStatsRow[]
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    taskKind: row.task_kind,
    attemptCount: row.attempt_count,
    successCount: row.success_count,
    successRate: row.attempt_count === 0 ? 0 : row.success_count / row.attempt_count,
    totalReviewIssues: row.total_review_issues,
    averageReviewIssues: row.average_review_issues,
    averageDurationMs: row.average_duration_ms,
  }))
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

function mapReview(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    attemptId: row.attempt_id as AttemptId,
    reviewerProvider: row.reviewer_provider,
    reviewerModel: row.reviewer_model,
    round: row.round,
    approve: row.approve === 1,
    summary: row.summary,
    findings: JSON.parse(row.findings) as ReviewFinding[],
    createdAt: row.created_at,
  }
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    ...(row.attempt_id ? { attemptId: row.attempt_id as AttemptId } : {}),
    action: JSON.parse(row.action) as ProposedAction,
    tier: row.tier,
    status: row.status,
    ...(row.decided_via ? { decidedVia: row.decided_via } : {}),
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  }
}

function mapUsage(row: UsageRow): UsageRecord {
  return {
    provider: row.provider,
    day: row.day,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    rateLimitHits: row.rate_limit_hits,
  }
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
