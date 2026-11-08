import { describe, expect, it } from 'vitest'
import { costIsEstimate, formatCost, formatSpent, formatTokens, parseUsage } from './usage.js'

describe('parseUsage', () => {
  it('keeps only what was reported', () => {
    expect(
      parseUsage({
        durationMs: 61_000,
        inputTokens: 1200,
        costUsd: 0.5,
        byProvider: [
          { provider: 'claude-cli', model: 'opus', inputTokens: 1200, costUsd: 0.5 },
          { provider: 5 },
        ],
      }),
    ).toEqual({
      durationMs: 61_000,
      inputTokens: 1200,
      costUsd: 0.5,
      byProvider: [{ provider: 'claude-cli', model: 'opus', inputTokens: 1200, costUsd: 0.5 }],
    })
  })

  it('returns null without a duration', () => {
    expect(parseUsage({})).toBeNull()
    expect(parseUsage(undefined)).toBeNull()
  })
})

describe('formatters', () => {
  it('abbreviates tokens', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(48_000)).toBe('48k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })

  it('formats cost and time', () => {
    expect(formatCost(0.1234)).toBe('$0.12')
    expect(formatCost(0.004)).toBe('< $0.01')
    expect(formatSpent(45_000)).toBe('45 秒')
    expect(formatSpent(192_000)).toBe('3 分 12 秒')
    expect(formatSpent(180_000)).toBe('3 分')
    expect(formatSpent(3_900_000)).toBe('1 小時 5 分')
  })

  it('treats CLI costs as estimates', () => {
    expect(costIsEstimate('claude-cli')).toBe(true)
    expect(costIsEstimate('codex-cli')).toBe(true)
    expect(costIsEstimate('openai-api')).toBe(false)
  })
})
