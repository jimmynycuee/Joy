import { record } from './types.js'
import type { CostSource, ProviderUsage, RoleUsage, RunUsage, TaskUsage, UsageTotals } from './types.js'

// Time, tokens and cost of a task (`usage` in the task details). Only what the server recorded is present: an older
// task has no tokens or cost, and shows none.

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

function totals(fields: Record<string, unknown>): UsageTotals {
  const inputTokens = number(fields.inputTokens)
  const outputTokens = number(fields.outputTokens)
  const cachedInputTokens = number(fields.cachedInputTokens)
  const costUsd = number(fields.costUsd)
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

function providerUsage(value: unknown): ProviderUsage | null {
  const fields = record(value)
  if (typeof fields?.provider !== 'string' || typeof fields.model !== 'string') return null
  return { provider: fields.provider, model: fields.model, ...totals(fields) }
}

function roleUsage(value: unknown): RoleUsage | null {
  const fields = record(value)
  if (typeof fields?.role !== 'string') return null
  const durationMs = number(fields.durationMs)
  return {
    role: fields.role,
    ...(typeof fields.provider === 'string' ? { provider: fields.provider } : {}),
    ...(typeof fields.model === 'string' ? { model: fields.model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...totals(fields),
  }
}

function runUsage(value: unknown): RunUsage | null {
  const fields = record(value)
  const endSeq = number(fields?.endSeq)
  const durationMs = number(fields?.durationMs)
  if (!fields || endSeq === undefined || durationMs === undefined) return null
  const approvalWaitMs = number(fields.approvalWaitMs)
  return {
    endSeq,
    durationMs,
    ...(approvalWaitMs !== undefined ? { approvalWaitMs } : {}),
    ...totals(fields),
  }
}

const COST_SOURCES = new Set<string>(['cli', 'price_table', 'mixed'])

function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  return (Array.isArray(value) ? value : []).map(parse).filter((entry): entry is T => entry !== null)
}

export function parseUsage(value: unknown): TaskUsage | null {
  const fields = record(value)
  const durationMs = number(fields?.durationMs)
  if (!fields || durationMs === undefined) return null
  const approvalWaitMs = number(fields.approvalWaitMs)
  return {
    durationMs,
    ...(approvalWaitMs !== undefined ? { approvalWaitMs } : {}),
    ...totals(fields),
    ...(typeof fields.costSource === 'string' && COST_SOURCES.has(fields.costSource)
      ? { costSource: fields.costSource as CostSource }
      : {}),
    byProvider: list(fields.byProvider, providerUsage),
    byRole: list(fields.byRole, roleUsage),
    runs: list(fields.runs, runUsage),
  }
}

/** What the usage says of tokens in a word count: input plus output (the cached part is inside the input). */
export function totalTokens(usage: UsageTotals): number | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

/** 「2 分 14 秒 · 38k tokens」: the line that ends a round; only the parts that exist, empty for nothing to say. */
export function runLine(run: { durationMs: number } & UsageTotals): string {
  const tokens = totalTokens(run)
  return [
    run.durationMs >= 1000 ? formatSpent(run.durationMs) : '',
    tokens !== undefined && tokens > 0 ? `${formatTokens(tokens)} tokens` : '',
    run.costUsd !== undefined ? formatCost(run.costUsd) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 1234 → 1.2k, 2_500_000 → 2.5M. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`
  return String(Math.round(count))
}

export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? '< $0.01' : `$${usd.toFixed(2)}`
}

/** 耗時 as 3 分 12 秒, 45 秒 or 1 小時 5 分. */
export function formatSpent(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ''}`
  return `${Math.floor(minutes / 60)} 小時${minutes % 60 ? ` ${minutes % 60} 分` : ''}`
}

/** Where a cost comes from, in a word. */
export function costSourceLabel(source: CostSource | undefined): string {
  if (source === 'cli') return 'CLI 回報'
  if (source === 'price_table') return '價目表'
  if (source === 'mixed') return 'CLI 回報與價目表'
  return ''
}

/** A task on the stats page: what it is and what it cost. */
export interface StatTask {
  id: string
  title: string
  mode: string
  status: string
  createdAt: string
  usage: TaskUsage
}

export function parseStatTasks(value: unknown): StatTask[] {
  return list(value, (item) => {
    const fields = record(item)
    const usage = parseUsage(fields?.usage)
    if (!fields || typeof fields.id !== 'string' || !usage) return null
    return {
      id: fields.id,
      title: typeof fields.title === 'string' ? fields.title : fields.id,
      mode: typeof fields.mode === 'string' ? fields.mode : '',
      status: typeof fields.status === 'string' ? fields.status : '',
      createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : '',
      usage,
    }
  })
}

export type TaskSort = 'recent' | 'duration' | 'tokens' | 'cost'

/** The tasks as the server sent them (newest first), or the biggest first by one measure; a task without it goes last. */
export function sortStatTasks(tasks: readonly StatTask[], sort: TaskSort): StatTask[] {
  const measure = (task: StatTask): number | undefined =>
    sort === 'duration'
      ? task.usage.durationMs
      : sort === 'tokens'
        ? totalTokens(task.usage)
        : sort === 'cost'
          ? task.usage.costUsd
          : undefined
  if (sort === 'recent') return [...tasks]
  return tasks
    .map((task, index) => ({ task, index, value: measure(task) }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.index - b.index)
    .map(({ task }) => task)
}
