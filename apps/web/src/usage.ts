import { record } from './types.js'
import type { ProviderUsage, TaskUsage } from './types.js'

// Time, tokens and cost of a task (`usage` in the task details). Only what providers reported is present.

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

function providerUsage(value: unknown): ProviderUsage | null {
  const fields = record(value)
  if (typeof fields?.provider !== 'string' || typeof fields.model !== 'string') return null
  const inputTokens = number(fields.inputTokens)
  const outputTokens = number(fields.outputTokens)
  const costUsd = number(fields.costUsd)
  return {
    provider: fields.provider,
    model: fields.model,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

export function parseUsage(value: unknown): TaskUsage | null {
  const fields = record(value)
  const durationMs = number(fields?.durationMs)
  if (!fields || durationMs === undefined) return null
  const inputTokens = number(fields.inputTokens)
  const outputTokens = number(fields.outputTokens)
  const costUsd = number(fields.costUsd)
  return {
    durationMs,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    byProvider: (Array.isArray(fields.byProvider) ? fields.byProvider : [])
      .map(providerUsage)
      .filter((entry): entry is ProviderUsage => entry !== null),
  }
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

/** CLI providers report an estimated cost (their own price table), not what the subscription billed. */
export function costIsEstimate(provider: string): boolean {
  return provider === 'claude-cli' || provider === 'codex-cli'
}
