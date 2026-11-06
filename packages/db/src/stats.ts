import type { Database } from './database.js'

export interface StatsFilter {
  /** Inclusive lower bound on when the attempt started (ISO). */
  from?: string
  /** Exclusive upper bound (ISO). */
  to?: string
  repoId?: string
}

export interface ImplementerStats {
  provider: string
  model: string
  /** Task mode, the closest thing Joy has to a task category. */
  mode: string
  attempts: number
  /** Attempts that ended (succeeded or failed); cancelled ones are left out of the pass rate. */
  finished: number
  /** Succeeded, and the last review (if any) approved. */
  passed: number
  passRate: number | null
  /** Problems reviewers found in this model's work. */
  findingsAgainst: number
  avgDurationMs: number | null
  /** Times this model handed a task to another because its quota ran out. */
  handoffs: number
}

export interface ReviewerStats {
  provider: string
  model: string
  reviews: number
  approvals: number
  /** Problems this model found as a reviewer. */
  findings: number
}

export interface ModelStats {
  implementers: ImplementerStats[]
  reviewers: ReviewerStats[]
}

function where(filter: StatsFilter): { sql: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.from) {
    clauses.push('a.created_at >= ?')
    params.push(filter.from)
  }
  if (filter.to) {
    clauses.push('a.created_at < ?')
    params.push(filter.to)
  }
  if (filter.repoId) {
    clauses.push('t.repo_id = ?')
    params.push(filter.repoId)
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/** How each provider and model did, over attempts started in the period (T3.9). */
export function modelStats(db: Database, filter: StatsFilter = {}): ModelStats {
  const { sql, params } = where(filter)
  const attempts = db
    .prepare(
      `SELECT a.provider, a.model, t.mode, a.status,
              (SELECT r.approve FROM reviews r WHERE r.attempt_id = a.id ORDER BY r.round DESC LIMIT 1) AS last_approve,
              (SELECT COALESCE(SUM(json_array_length(r.findings)), 0) FROM reviews r WHERE r.attempt_id = a.id) AS findings,
              CAST(ROUND((julianday(a.updated_at) - julianday(a.created_at)) * 86400000) AS INTEGER) AS duration_ms
       FROM attempts a JOIN tasks t ON t.id = a.task_id ${sql}`,
    )
    .all(...params) as unknown as Array<{
    provider: string
    model: string
    mode: string
    status: string
    last_approve: number | null
    findings: number
    duration_ms: number
  }>
  const handoffs = db
    .prepare(
      `SELECT json_extract(e.payload, '$.from.provider') AS provider, json_extract(e.payload, '$.from.model') AS model,
              t.mode, COUNT(*) AS n
       FROM events e JOIN attempts a ON a.id = e.attempt_id JOIN tasks t ON t.id = a.task_id
       ${sql ? `${sql} AND` : 'WHERE'} e.type = 'quota.handoff' GROUP BY 1, 2, 3`,
    )
    .all(...params) as unknown as Array<{ provider: string; model: string; mode: string; n: number }>

  const byKey = new Map<string, ImplementerStats & { durations: number[] }>()
  const entry = (provider: string, model: string, mode: string) => {
    const key = JSON.stringify([provider, model, mode])
    let stats = byKey.get(key)
    if (!stats) {
      stats = {
        provider,
        model,
        mode,
        attempts: 0,
        finished: 0,
        passed: 0,
        passRate: null,
        findingsAgainst: 0,
        avgDurationMs: null,
        handoffs: 0,
        durations: [],
      }
      byKey.set(key, stats)
    }
    return stats
  }
  for (const row of attempts) {
    const stats = entry(row.provider, row.model, row.mode)
    stats.attempts++
    stats.findingsAgainst += row.findings
    if (row.status === 'succeeded' || row.status === 'failed') {
      stats.finished++
      stats.durations.push(row.duration_ms)
      if (row.status === 'succeeded' && row.last_approve !== 0) stats.passed++
    }
  }
  for (const row of handoffs) entry(row.provider, row.model, row.mode).handoffs += row.n

  const implementers = [...byKey.values()]
    .map(({ durations, ...stats }) => ({
      ...stats,
      passRate: stats.finished ? stats.passed / stats.finished : null,
      avgDurationMs: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null,
    }))
    .sort(
      (a, b) =>
        b.attempts - a.attempts || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    )

  const reviewers = (
    db
      .prepare(
        `SELECT r.reviewer_provider AS provider, r.reviewer_model AS model, COUNT(*) AS reviews,
                SUM(r.approve) AS approvals, SUM(json_array_length(r.findings)) AS findings
         FROM reviews r JOIN attempts a ON a.id = r.attempt_id JOIN tasks t ON t.id = a.task_id ${sql}
         GROUP BY 1, 2 ORDER BY reviews DESC, provider, model`,
      )
      .all(...params) as unknown as ReviewerStats[]
  ).map((row) => ({ ...row }))
  return { implementers, reviewers }
}
