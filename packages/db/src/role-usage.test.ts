import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import { addRoleUsage, firstRoleUsageDay, roleUsageTotals } from './role-usage.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})
function fresh() {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}
const codex = { provider: 'codex-cli', model: 'gpt-6.1-sol' }

describe('role usage', () => {
  it('adds up each role and model, sorted by role then by tokens', () => {
    const db = fresh()
    expect(firstRoleUsageDay(db)).toBeUndefined()
    addRoleUsage(db, { role: 'reviewer', ...codex, day: '2026-11-24', inputTokens: 100, outputTokens: 10 })
    addRoleUsage(db, {
      role: 'reviewer',
      ...codex,
      day: '2026-11-25',
      inputTokens: 50,
      cachedInputTokens: 40,
    })
    addRoleUsage(db, {
      role: 'implementer',
      provider: 'claude-cli',
      model: 'haiku',
      day: '2026-11-25',
      inputTokens: 5,
    })
    addRoleUsage(db, {
      role: 'implementer',
      provider: 'claude-cli',
      model: 'opus',
      day: '2026-11-25',
      inputTokens: 9,
    })
    addRoleUsage(db, {
      role: 'assistant',
      provider: 'openai-api',
      model: 'gpt-6-luna',
      day: '2026-11-25',
      costUsd: 0.25,
    })
    expect(roleUsageTotals(db)).toEqual([
      {
        role: 'implementer',
        provider: 'claude-cli',
        model: 'opus',
        inputTokens: 9,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        role: 'implementer',
        provider: 'claude-cli',
        model: 'haiku',
        inputTokens: 5,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
      { role: 'reviewer', ...codex, inputTokens: 150, cachedInputTokens: 40, outputTokens: 10, costUsd: 0 },
      {
        role: 'assistant',
        provider: 'openai-api',
        model: 'gpt-6-luna',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0.25,
      },
    ])
    expect(firstRoleUsageDay(db)).toBe('2026-11-24')
  })

  it('counts whole days, both ends included', () => {
    const db = fresh()
    for (const day of ['2026-11-23', '2026-11-24', '2026-11-25'])
      addRoleUsage(db, { role: 'judge', ...codex, day, inputTokens: 1 })
    expect(roleUsageTotals(db, { from: '2026-11-24', to: '2026-11-24' })[0]?.inputTokens).toBe(1)
    expect(roleUsageTotals(db, { from: '2026-11-24' })[0]?.inputTokens).toBe(2)
    expect(roleUsageTotals(db, { to: '2026-11-24' })[0]?.inputTokens).toBe(2)
  })

  it('keeps only counts and known roles', () => {
    const db = fresh()
    addRoleUsage(db, { role: 'peer', ...codex, inputTokens: -5, outputTokens: Number.NaN, costUsd: 0.1 })
    expect(roleUsageTotals(db)[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0.1 })
    expect(() => addRoleUsage(db, { role: 'nobody' as 'peer', ...codex, inputTokens: 1 })).toThrow(/CHECK/)
  })
})
