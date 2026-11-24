import type { Database } from './database.js'

/** The kinds of work Joy pays tokens for. Not the same as core's `Role`: the safety pre-review and ask_peer count apart. */
export const USAGE_ROLES = [
  'implementer',
  'reviewer',
  'judge',
  'assistant',
  'background',
  'safety_review',
  'peer',
] as const
export type UsageRole = (typeof USAGE_ROLES)[number]

export interface RoleUsageIncrement {
  role: UsageRole
  provider: string
  model: string
  /** UTC day, `YYYY-MM-DD`; today by default. */
  day?: string
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export interface RoleUsageTotal {
  role: UsageRole
  provider: string
  model: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  costUsd: number
}

export function addRoleUsage(db: Database, input: RoleUsageIncrement): void {
  const day = input.day ?? new Date().toISOString().slice(0, 10)
  // A provider can report odd numbers; the table only takes counts.
  const count = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0
  db.prepare(
    `INSERT INTO role_usage (role, provider, model, day, input_tokens, cached_input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (role, provider, model, day) DO UPDATE SET
       input_tokens = role_usage.input_tokens + excluded.input_tokens,
       cached_input_tokens = role_usage.cached_input_tokens + excluded.cached_input_tokens,
       output_tokens = role_usage.output_tokens + excluded.output_tokens,
       cost_usd = role_usage.cost_usd + excluded.cost_usd`,
  ).run(
    input.role,
    input.provider,
    input.model,
    day,
    Math.round(count(input.inputTokens)),
    Math.round(count(input.cachedInputTokens)),
    Math.round(count(input.outputTokens)),
    count(input.costUsd),
  )
}

/** Totals per role and model over whole UTC days, `from` and `to` (`YYYY-MM-DD`) both included. */
export function roleUsageTotals(db: Database, period: { from?: string; to?: string } = {}): RoleUsageTotal[] {
  const where: string[] = []
  const params: string[] = []
  if (period.from) {
    where.push('day >= ?')
    params.push(period.from)
  }
  if (period.to) {
    where.push('day <= ?')
    params.push(period.to)
  }
  const rows = db
    .prepare(
      `SELECT role, provider, model,
              SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
       FROM role_usage ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY role, provider, model`,
    )
    .all(...params) as unknown as Array<{
    role: UsageRole
    provider: string
    model: string
    input_tokens: number
    cached_input_tokens: number
    output_tokens: number
    cost_usd: number
  }>
  return rows
    .map((row) => ({
      role: row.role,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
    }))
    .sort(
      (a, b) =>
        USAGE_ROLES.indexOf(a.role) - USAGE_ROLES.indexOf(b.role) ||
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    )
}

/** The first day anything was recorded, or undefined before then. */
export function firstRoleUsageDay(db: Database): string | undefined {
  const row = db.prepare('SELECT MIN(day) AS day FROM role_usage').get() as { day: string | null } | undefined
  return row?.day ?? undefined
}
