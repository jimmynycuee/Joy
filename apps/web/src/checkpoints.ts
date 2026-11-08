import { record } from './types.js'

// Checkpoints (`GET /api/tasks/:id/checkpoints`): snapshots the server takes after each implementer turn.

export interface CheckpointView {
  n: number
  /** Chinese description of why the checkpoint exists. */
  label: string
  round: number
  createdAt: string
  /** False once the worktree it belongs to was removed. */
  available: boolean
}

/** The server labels are English identifiers of its own (`implementer turn, round 2`); show them in Chinese. */
export function checkpointLabel(label: string): string {
  const turn = /^implementer turn(?:, round (\d+))?$/.exec(label)
  if (turn) return turn[1] ? `實作者完成第 ${turn[1]} 輪` : '實作者完成一輪'
  const before = /^before restoring checkpoint (\d+)$/.exec(label)
  if (before) return `還原到檢查點 ${before[1]} 之前的狀態`
  return label
}

/** The list newest first, skipping anything malformed. */
export function mapCheckpoints(value: unknown): CheckpointView[] {
  const list = record(value)?.checkpoints
  if (!Array.isArray(list)) return []
  const views: CheckpointView[] = []
  for (const item of list) {
    const fields = record(item)
    if (typeof fields?.n !== 'number' || !Number.isInteger(fields.n)) continue
    views.push({
      n: fields.n,
      label: checkpointLabel(typeof fields.label === 'string' ? fields.label : ''),
      round: typeof fields.round === 'number' ? fields.round : 0,
      createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : '',
      available: fields.available !== false,
    })
  }
  return views.sort((a, b) => b.n - a.n)
}

/**
 * How many commits a 409 from the restore endpoint says would be lost, or undefined when the 409 is about something
 * else. Only that case is worth asking the owner about and retrying with `confirm: true`.
 */
export function discardedCommitCount(message: string): number | undefined {
  const match = /would discard (\d+) commits?/.exec(message)
  return match ? Number(match[1]) : undefined
}
