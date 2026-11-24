import { describe, expect, it } from 'vitest'
import {
  costSourceLabel,
  formatCost,
  formatSpent,
  formatTokens,
  parseRoleTotals,
  parseStatTasks,
  parseUsage,
  runLine,
  sortStatTasks,
  tokenShares,
  totalTokens,
} from './usage.js'

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
      byRole: [],
      runs: [],
    })
  })

  it('reads the roles, the runs, the wait for approvals and where the cost came from', () => {
    expect(
      parseUsage({
        durationMs: 5000,
        approvalWaitMs: 2000,
        cachedInputTokens: 40,
        costSource: 'cli',
        byRole: [
          { role: 'reviewer', provider: 'codex-cli', model: 'luna', durationMs: 900, inputTokens: 3 },
          { role: 7 },
        ],
        runs: [{ endSeq: 9, durationMs: 4000, outputTokens: 5 }, { endSeq: 'x' }],
      }),
    ).toEqual({
      durationMs: 5000,
      approvalWaitMs: 2000,
      cachedInputTokens: 40,
      costSource: 'cli',
      byProvider: [],
      byRole: [{ role: 'reviewer', provider: 'codex-cli', model: 'luna', durationMs: 900, inputTokens: 3 }],
      runs: [{ endSeq: 9, durationMs: 4000, outputTokens: 5 }],
    })
  })

  it('drops a cost source it does not know and numbers that are not numbers', () => {
    const parsed = parseUsage({ durationMs: 1, costSource: 'guess', costUsd: '2', inputTokens: Number.NaN })
    expect(parsed).toEqual({ durationMs: 1, byProvider: [], byRole: [], runs: [] })
  })

  it('reads a task from before usage was told by role and run', () => {
    expect(parseUsage({ durationMs: 1000, inputTokens: 5, byProvider: [] })).toEqual({
      durationMs: 1000,
      inputTokens: 5,
      byProvider: [],
      byRole: [],
      runs: [],
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

  it('names where a cost comes from', () => {
    expect(costSourceLabel('cli')).toBe('CLI 回報')
    expect(costSourceLabel('price_table')).toBe('價目表')
    expect(costSourceLabel('mixed')).toBe('CLI 回報與價目表')
    expect(costSourceLabel(undefined)).toBe('')
  })
})

describe('runLine', () => {
  it('says the time and the tokens of a round, input and output together', () => {
    expect(runLine({ durationMs: 134_000, inputTokens: 36_000, outputTokens: 2_000 })).toBe(
      '2 分 14 秒 · 38k tokens',
    )
  })

  it('adds a cost when there is one and leaves out what is missing', () => {
    expect(runLine({ durationMs: 45_000, inputTokens: 900, costUsd: 0.5 })).toBe('45 秒 · 900 tokens · $0.50')
    expect(runLine({ durationMs: 45_000 })).toBe('45 秒')
    expect(runLine({ durationMs: 400 })).toBe('')
    expect(runLine({ durationMs: 400, outputTokens: 0 })).toBe('')
  })
})

describe('totalTokens', () => {
  it('is undefined for a task that reported no tokens', () => {
    expect(totalTokens({})).toBeUndefined()
    expect(totalTokens({ costUsd: 1 })).toBeUndefined()
    expect(totalTokens({ outputTokens: 4 })).toBe(4)
  })
})

describe('the tasks of the stats page', () => {
  const body = [
    {
      id: 'a',
      title: 'Old one',
      mode: 'single',
      status: 'done',
      createdAt: 'x',
      usage: { durationMs: 10_000 },
    },
    {
      id: 'b',
      title: 'Big',
      mode: 'review_loop',
      status: 'done',
      createdAt: 'y',
      usage: { durationMs: 5_000, inputTokens: 900, outputTokens: 100, costUsd: 2 },
    },
    {
      id: 'c',
      title: 'Cheap',
      mode: 'single',
      status: 'failed',
      createdAt: 'z',
      usage: { durationMs: 20_000, inputTokens: 10, costUsd: 0.1 },
    },
    { id: 'broken', usage: 'nope' },
    'junk',
  ]

  it('reads the tasks that have a usage and skips the rest', () => {
    expect(parseStatTasks(body).map((task) => task.id)).toEqual(['a', 'b', 'c'])
    expect(parseStatTasks(undefined)).toEqual([])
    expect(parseStatTasks({})).toEqual([])
  })

  it('sorts by one measure, the biggest first, tasks without it last and ties in the order given', () => {
    const tasks = parseStatTasks(body)
    expect(sortStatTasks(tasks, 'recent').map((task) => task.id)).toEqual(['a', 'b', 'c'])
    expect(sortStatTasks(tasks, 'duration').map((task) => task.id)).toEqual(['c', 'a', 'b'])
    expect(sortStatTasks(tasks, 'tokens').map((task) => task.id)).toEqual(['b', 'c', 'a'])
    expect(sortStatTasks(tasks, 'cost').map((task) => task.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('usage by role', () => {
  const row = (role: string, inputTokens: number, outputTokens = 0) => ({
    role,
    provider: 'codex-cli',
    model: 'gpt-6.1-sol',
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    costUsd: 0,
  })

  it('keeps well-formed rows and fills missing counts with 0', () => {
    expect(
      parseRoleTotals([
        { role: 'reviewer', provider: 'codex-cli', model: 'gpt-6.1-sol', inputTokens: 5, costUsd: 'x' },
        { role: 'reviewer', provider: 'codex-cli' },
        'nope',
      ]),
    ).toEqual([row('reviewer', 5)])
    expect(parseRoleTotals(undefined)).toEqual([])
  })

  it('gives each row its share of all tokens', () => {
    expect(tokenShares([row('implementer', 700, 100), row('reviewer', 199), row('background', 1)])).toEqual([
      '80%',
      '20%',
      '< 1%',
    ])
    expect(tokenShares([row('assistant', 0)])).toEqual(['—'])
  })
})
