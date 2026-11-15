import type { TaskId } from '@joy/core'
import type { Database } from './database.js'

/** Keep equal to TASK_ALLOW_KINDS in @joy/policy and the CHECK in migration 24. */
export const TASK_ALLOW_KINDS = ['shell', 'file_write', 'file_read', 'network', 'mcp'] as const
export type TaskAllowKind = (typeof TASK_ALLOW_KINDS)[number]

/** An action the owner allowed for the rest of a task. */
export interface TaskAllowRecord {
  id: string
  taskId: TaskId
  kind: TaskAllowKind
  /** SHA-256 (hex) of the policy fingerprint. */
  fingerprint: string
  /** The redacted command, path, host or tool the owner saw. */
  target: string
  approvalId: string
  createdAt: string
}

export interface NewTaskAllow {
  id: string
  taskId: TaskId
  kind: TaskAllowKind
  fingerprint: string
  target: string
  approvalId: string
}

interface Row {
  id: string
  task_id: string
  kind: TaskAllowKind
  fingerprint: string
  target: string
  approval_id: string
  created_at: string
}

function toRecord(row: Row): TaskAllowRecord {
  return {
    id: row.id,
    taskId: row.task_id as TaskId,
    kind: row.kind,
    fingerprint: row.fingerprint,
    target: row.target,
    approvalId: row.approval_id,
    createdAt: row.created_at,
  }
}

/** Remembers an allow; when the task already has one for the same fingerprint, that one is returned. */
export function createTaskAllow(db: Database, input: NewTaskAllow): TaskAllowRecord {
  db.prepare(
    `INSERT INTO task_allows (id, task_id, kind, fingerprint, target, approval_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, fingerprint) DO NOTHING`,
  ).run(input.id, input.taskId, input.kind, input.fingerprint, input.target, input.approvalId)
  const record = findTaskAllow(db, input.taskId, input.fingerprint)
  if (!record) throw new Error(`Task allow for task ${input.taskId} was not found after insert`)
  return record
}

export function findTaskAllow(
  db: Database,
  taskId: TaskId,
  fingerprint: string,
): TaskAllowRecord | undefined {
  const row = db
    .prepare('SELECT * FROM task_allows WHERE task_id = ? AND fingerprint = ?')
    .get(taskId, fingerprint) as Row | undefined
  return row ? toRecord(row) : undefined
}

export function listTaskAllows(db: Database, taskId: TaskId): TaskAllowRecord[] {
  return (
    db
      .prepare('SELECT * FROM task_allows WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as unknown as Row[]
  ).map(toRecord)
}

/** Revokes one allow of a task. Returns false when the task has no allow with that id. */
export function deleteTaskAllow(db: Database, taskId: TaskId, id: string): boolean {
  return (
    Number(db.prepare('DELETE FROM task_allows WHERE task_id = ? AND id = ?').run(taskId, id).changes) > 0
  )
}

/** Forgets every allow of a task. Returns how many there were. */
export function clearTaskAllows(db: Database, taskId: TaskId): number {
  return Number(db.prepare('DELETE FROM task_allows WHERE task_id = ?').run(taskId).changes)
}
