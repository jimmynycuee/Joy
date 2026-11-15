import { describe, expect, it } from 'vitest'
import { summarizeTaskUsage } from './task-usage.js'
import type { UsageAttempt, UsageEvent } from './task-usage.js'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const attempts: UsageAttempt[] = [{ id: 'a1', provider: 'claude-cli', model: 'opus' }]
const CODEX = { provider: 'codex-cli', model: 'luna' }
const CLAUDE = { provider: 'claude-cli', model: 'opus' }

let seq = 0
/** An event `seconds` after the start. */
function at(seconds: number, type: string, payload: unknown = {}, attemptId: string | undefined = 'a1') {
  return {
    seq: ++seq,
    type,
    payload,
    ts: new Date(T0 + seconds * 1000).toISOString(),
    ...(attemptId ? { attemptId } : {}),
  } satisfies UsageEvent
}
const usage = (
  seconds: number,
  role: string,
  fields: Record<string, unknown>,
  attemptId: string | undefined = 'a1',
) => at(seconds, 'agent', { role, round: 1, event: { type: 'usage', ...fields } }, attemptId)
const phase = (seconds: number, role: string | undefined, model?: unknown) =>
  at(seconds, 'phase', { phase: 'x', round: 1, ...(role ? { role } : {}), ...(model ? { model } : {}) })

const summarize = (events: UsageEvent[], running = false, now = T0 + 999_000) =>
  summarizeTaskUsage(events, attempts, { running, now })

describe('summarizeTaskUsage', () => {
  it('has nothing to show for a task that recorded nothing', () => {
    expect(summarize([])).toEqual({ durationMs: 0, byProvider: [], byRole: [], runs: [] })
    // Events without usage: the time is known, tokens and cost are absent rather than zero.
    const summary = summarize([at(0, 'started'), at(5, 'result')])
    expect(summary.durationMs).toBe(5000)
    expect(summary).not.toHaveProperty('inputTokens')
    expect(summary).not.toHaveProperty('costUsd')
    expect(summary.runs).toEqual([{ endSeq: expect.any(Number), durationMs: 5000 }])
  })

  it('adds up tokens and cost by model, by role and by run, and says where the cost came from', () => {
    const summary = summarize([
      at(0, 'started'),
      phase(0, 'implementer', CLAUDE),
      usage(10, 'implementer', {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 800,
        costUsd: 0.5,
        costSource: 'cli',
      }),
      phase(10, 'reviewer', CODEX),
      usage(20, 'reviewer', { inputTokens: 300, outputTokens: 30, cachedInputTokens: 100 }),
      at(20, 'result'),
    ])
    expect(summary).toMatchObject({
      durationMs: 20_000,
      inputTokens: 1300,
      outputTokens: 130,
      cachedInputTokens: 900,
      costUsd: 0.5,
      costSource: 'cli',
    })
    expect(summary.byProvider).toEqual([
      { ...CLAUDE, inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800, costUsd: 0.5 },
      { ...CODEX, inputTokens: 300, outputTokens: 30, cachedInputTokens: 100 },
    ])
    expect(summary.byRole).toEqual([
      {
        role: 'implementer',
        ...CLAUDE,
        durationMs: 10_000,
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 800,
        costUsd: 0.5,
      },
      {
        role: 'reviewer',
        ...CODEX,
        durationMs: 10_000,
        inputTokens: 300,
        outputTokens: 30,
        cachedInputTokens: 100,
      },
    ])
    expect(summary.runs).toHaveLength(1)
    expect(summary.runs[0]).toMatchObject({ durationMs: 20_000, inputTokens: 1300, outputTokens: 130 })
  })

  it('takes the implementer model from its attempt when no phase named one', () => {
    const summary = summarize([
      at(0, 'started'),
      usage(1, 'implementer', { inputTokens: 5 }),
      at(2, 'result'),
    ])
    expect(summary.byProvider).toEqual([{ ...CLAUDE, inputTokens: 5 }])
    expect(summary.byRole).toEqual([{ role: 'implementer', ...CLAUDE, inputTokens: 5 }])
  })

  it('keeps the wait for an approval out of the time and reports it on its own', () => {
    const summary = summarize([
      at(0, 'started'),
      phase(0, 'implementer', CLAUDE),
      at(10, 'approval.requested', { approvalId: 'p1' }),
      at(70, 'approval.decided', { approvalId: 'p1', status: 'approved' }),
      usage(80, 'implementer', { inputTokens: 1 }),
      at(100, 'result'),
    ])
    expect(summary.durationMs).toBe(40_000)
    expect(summary.approvalWaitMs).toBe(60_000)
    expect(summary.runs[0]).toMatchObject({ durationMs: 40_000, approvalWaitMs: 60_000 })
    expect(summary.byRole[0]?.durationMs).toBe(40_000)
  })

  it('counts an approval that is never decided as waiting until the run ends, and ignores a late decision', () => {
    const summary = summarize([
      at(0, 'started'),
      at(10, 'approval.requested', { approvalId: 'p1' }),
      at(40, 'error', { message: 'expired' }),
      at(500, 'approval.decided', { approvalId: 'p1', status: 'approved' }),
    ])
    expect(summary).toMatchObject({ durationMs: 10_000, approvalWaitMs: 30_000 })
  })

  it('splits a task into its runs and counts the time between them for none', () => {
    const summary = summarize([
      at(0, 'started'),
      usage(5, 'implementer', { inputTokens: 10, outputTokens: 1 }),
      at(10, 'result'),
      at(1000, 'started'),
      usage(1020, 'implementer', { inputTokens: 20, outputTokens: 2 }),
      at(1030, 'result'),
    ])
    expect(summary.durationMs).toBe(40_000)
    expect(summary.inputTokens).toBe(30)
    expect(summary.runs).toMatchObject([
      { durationMs: 10_000, inputTokens: 10, outputTokens: 1 },
      { durationMs: 30_000, inputTokens: 20, outputTokens: 2 },
    ])
  })

  it('counts the judge of a compete task, which comes after the contestants, with the last run', () => {
    const summary = summarize([
      at(0, 'started'),
      usage(5, 'implementer', { inputTokens: 10 }),
      at(10, 'result'),
      at(
        12,
        'compete.usage',
        { role: 'judge', model: CODEX, event: { type: 'usage', inputTokens: 7, costUsd: 0.1 } },
        undefined,
      ),
    ])
    expect(summary.inputTokens).toBe(17)
    expect(summary.runs[0]).toMatchObject({ inputTokens: 17, costUsd: 0.1 })
    expect(summary.byRole.map((entry) => [entry.role, entry.inputTokens])).toEqual([
      ['implementer', 10],
      ['judge', 7],
    ])
    expect(summary.byProvider).toContainEqual({ ...CODEX, inputTokens: 7, costUsd: 0.1 })
  })

  it('counts the run still going up to now, and a run that never ended not at all', () => {
    const events = [at(0, 'started'), usage(5, 'implementer', { inputTokens: 1 })]
    expect(summarize(events, true, T0 + 30_000)).toMatchObject({
      durationMs: 30_000,
      inputTokens: 1,
      runs: [],
    })
    expect(summarize(events, false, T0 + 30_000)).toMatchObject({ durationMs: 0, inputTokens: 1 })
  })

  it('marks a cost from different sources as mixed and leaves out a source nothing reported a cost with', () => {
    const mixed = summarize([
      at(0, 'started'),
      usage(1, 'implementer', { costUsd: 1, costSource: 'cli' }),
      usage(2, 'reviewer', { costUsd: 1, costSource: 'price_table' }, 'a1'),
      at(3, 'result'),
    ])
    expect(mixed.costSource).toBe('mixed')
    const none = summarize([
      at(0, 'started'),
      usage(1, 'implementer', { inputTokens: 1, costSource: 'cli' }),
      at(2, 'result'),
    ])
    expect(none).not.toHaveProperty('costSource')
  })

  it('ignores values that are not numbers and events with a broken time', () => {
    const summary = summarize([
      { seq: 1, type: 'started', payload: {}, ts: 'not a date', attemptId: 'a1' },
      at(0, 'started'),
      usage(1, 'implementer', { inputTokens: '12', outputTokens: Number.NaN, costUsd: null }),
      at(2, 'result'),
    ])
    expect(summary).not.toHaveProperty('inputTokens')
    expect(summary).not.toHaveProperty('outputTokens')
    expect(summary).not.toHaveProperty('costUsd')
    expect(summary.durationMs).toBe(2000)
  })
})
