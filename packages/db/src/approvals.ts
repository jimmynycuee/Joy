import type { AttemptId, ProposedAction, TaskId, Tier } from '@joy/core'
import type { Database } from './database.js'

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface ApprovalRecord {
  id: string
  attemptId: AttemptId
  taskId: TaskId
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
  attemptId: AttemptId
  action: ProposedAction
  tier: Tier
}

interface ApprovalRow {
  id: string
  attempt_id: string
  task_id: string
  action: string
  tier: Tier
  status: ApprovalStatus
  decided_via: string | null
  note: string | null
  created_at: string
  decided_at: string | null
}

const SELECT = `SELECT ap.*, a.task_id FROM approvals ap JOIN attempts a ON a.id = ap.attempt_id`

export function createApproval(db: Database, input: NewApproval): ApprovalRecord {
  db.prepare(
    `INSERT INTO approvals (id, attempt_id, action, tier, status) VALUES (?, ?, ?, ?, 'pending')`,
  ).run(input.id, input.attemptId, JSON.stringify(input.action), input.tier)
  const created = getApproval(db, input.id)
  if (!created) throw new Error(`Approval ${input.id} was not found after insert`)
  return created
}

export function getApproval(db: Database, id: string): ApprovalRecord | undefined {
  const row = db.prepare(`${SELECT} WHERE ap.id = ?`).get(id) as ApprovalRow | undefined
  return row ? mapApproval(row) : undefined
}

export function listApprovals(
  db: Database,
  filter: { status?: ApprovalStatus; taskId?: TaskId } = {},
): ApprovalRecord[] {
  const where: string[] = []
  const params: string[] = []
  if (filter.status) {
    where.push('ap.status = ?')
    params.push(filter.status)
  }
  if (filter.taskId) {
    where.push('a.task_id = ?')
    params.push(filter.taskId)
  }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ap.created_at, ap.id`
  return (db.prepare(sql).all(...params) as unknown as ApprovalRow[]).map(mapApproval)
}

/**
 * Records a decision only if the approval is still pending, so two channels answering at once cannot both win.
 * Returns the updated record, or undefined when it was already decided (or does not exist).
 */
export function decideApproval(
  db: Database,
  id: string,
  decision: Exclude<ApprovalStatus, 'pending'>,
  decidedVia: string,
  note?: string,
): ApprovalRecord | undefined {
  const result = db
    .prepare(
      `UPDATE approvals SET status = ?, decided_via = ?, note = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(decision, decidedVia, note ?? null, id)
  return Number(result.changes) === 1 ? getApproval(db, id) : undefined
}

/**
 * Approves a request that expired because nobody answered in time (decided_via 'timeout'), so its paused task can
 * be resumed. Approvals expired by a cancelled run or a restart cannot be revived. Returns undefined otherwise.
 */
export function approveTimedOutApproval(
  db: Database,
  id: string,
  decidedVia: string,
  note?: string,
): ApprovalRecord | undefined {
  const result = db
    .prepare(
      `UPDATE approvals SET status = 'approved', decided_via = ?, note = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'expired' AND decided_via = 'timeout'`,
    )
    .run(decidedVia, note ?? null, id)
  return Number(result.changes) === 1 ? getApproval(db, id) : undefined
}

/** Pending approvals cannot survive a restart (nobody is waiting for them): mark them expired. */
export function expirePendingApprovals(db: Database): number {
  const result = db
    .prepare(
      `UPDATE approvals SET status = 'expired', decided_via = 'restart', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'pending'`,
    )
    .run()
  return Number(result.changes)
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    attemptId: row.attempt_id as AttemptId,
    taskId: row.task_id as TaskId,
    action: JSON.parse(row.action) as ProposedAction,
    tier: row.tier,
    status: row.status,
    ...(row.decided_via ? { decidedVia: row.decided_via } : {}),
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  }
}
