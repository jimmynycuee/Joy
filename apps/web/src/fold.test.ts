import { describe, expect, it } from 'vitest'
import { foldSummary, foldTimeline } from './fold.js'
import { buildTimeline } from './timeline.js'
import type { TimelineEntry } from './timeline.js'
import type { TaskEvent } from './types.js'

let seq = 0
const at = (secondsIntoRun: number) => new Date(Date.UTC(2026, 10, 8, 10, 0, secondsIntoRun)).toISOString()
const event = (type: string, payload: unknown, second = seq): TaskEvent => ({
  taskId: 't1',
  seq: ++seq,
  type,
  payload,
  ts: at(second),
})
const agent = (role: string, inner: unknown, second = seq) => event('agent', { role, event: inner }, second)
const review = (round: number, approve: boolean, second = seq) =>
  event(
    'review',
    { round, target: 'change', verdict: { approve, summary: approve ? 'ok' : 'fix it', findings: [] } },
    second,
  )
const tool = (id: string, command: string) =>
  agent('implementer', { type: 'tool_call', id, name: 'Bash', input: { command } })

/** Two review rounds: implement, review (changes), fix, review (approved). */
function twoRounds(): TimelineEntry[] {
  seq = 0
  return buildTimeline([
    event('started', {}, 0),
    event('phase', { phase: 'implementing', role: 'implementer' }, 1),
    agent('implementer', { type: 'message', text: 'First attempt.' }, 2),
    tool('c1', 'pnpm test'),
    event('policy.action', { kind: 'read_file', tier: 'auto' }, 3),
    event('phase', { phase: 'reviewing', role: 'reviewer' }, 20),
    review(1, false, 30),
    event('phase', { phase: 'fixing', role: 'implementer' }, 31),
    tool('c2', 'pnpm lint'),
    agent('implementer', { type: 'message', text: 'All fixed and checked.' }, 60),
    event('phase', { phase: 'reviewing', role: 'reviewer' }, 61),
    review(2, true, 80),
  ])
}

const kinds = (items: ReturnType<typeof foldTimeline>) =>
  items.map((item) => (item.kind === 'fold' ? 'fold' : item.entry.kind))

describe('foldTimeline', () => {
  it('keeps the last message and the last review of a finished task, and folds the rest into one process', () => {
    const items = foldTimeline(twoRounds(), 'done')
    expect(kinds(items)).toEqual(['fold', 'message', 'review'])
    const fold = items[0]
    if (fold?.kind !== 'fold') throw new Error('expected a fold')
    expect(fold.entries.map((entry) => entry.kind)).toEqual([
      'step',
      'phase',
      'message',
      'tool',
      'noise',
      'phase',
      'review',
      'phase',
      'tool',
      'phase',
    ])
    const kept = items.filter((item) => item.kind === 'entry')
    expect(
      kept.map((item) => (item.kind === 'entry' && item.entry.kind === 'message' ? item.entry.text : '')),
    ).toEqual(['All fixed and checked.', ''])
    // The earlier review is inside; the approved one is outside.
    expect(kept.at(-1)?.kind === 'entry' && kept.at(-1)).toMatchObject({ entry: { round: 2, approve: true } })
  })

  it('counts rounds over the whole run, steps in the fold, and the time from first to last event', () => {
    const fold = foldTimeline(twoRounds(), 'done')[0]
    if (fold?.kind !== 'fold') throw new Error('expected a fold')
    expect(fold.stats).toEqual({ reviewRounds: 2, steps: 3, durationMs: 80_000 })
    expect(foldSummary(fold.stats)).toBe('2 輪審查 · 3 個步驟 · 1 分 20 秒')
  })

  it('keeps the owner messages where they happened and puts the fold at its first folded entry', () => {
    seq = 0
    const entries = buildTimeline([
      event('user.message', { id: 'u0', text: 'first words' }, 0),
      tool('c1', 'ls'),
      event('user.message', { id: 'u1', text: 'one more thing' }, 5),
      agent('implementer', { type: 'message', text: 'Summary.' }, 9),
    ])
    expect(kinds(foldTimeline(entries, 'done'))).toEqual(['user', 'fold', 'user', 'message'])
  })

  it('does not take a reviewer reply for the agent summary', () => {
    seq = 0
    const entries = buildTimeline([
      agent('implementer', { type: 'message', text: 'I changed it.' }),
      tool('c1', 'ls'),
      agent('reviewer', { type: 'message', text: 'Looks fine to me.' }),
    ])
    const items = foldTimeline(entries, 'done')
    const message = items.find((item) => item.kind === 'entry' && item.entry.kind === 'message')
    expect(message).toMatchObject({ entry: { text: 'I changed it.' } })
  })

  it('does not fold at all when everything is kept', () => {
    seq = 0
    const entries = buildTimeline([
      event('user.message', { id: 'u0', text: 'hi' }),
      agent('implementer', { type: 'message', text: 'Hello.' }),
    ])
    expect(kinds(foldTimeline(entries, 'done'))).toEqual(['user', 'message'])
  })

  it('leaves a failed task its error and its last three steps outside', () => {
    seq = 0
    const entries = buildTimeline([
      event('started', {}),
      tool('c1', 'one'),
      tool('c2', 'two'),
      tool('c3', 'three'),
      tool('c4', 'four'),
      tool('c5', 'five'),
      event('error', { message: 'The reviewer crashed' }),
    ])
    const items = foldTimeline(entries, 'failed')
    expect(kinds(items)).toEqual(['fold', 'tool', 'tool', 'tool', 'error'])
    const labels = items.flatMap((item) =>
      item.kind === 'entry' && item.entry.kind === 'tool' ? [item.entry.label] : [],
    )
    expect(labels).toEqual(['$ three', '$ four', '$ five'])
    const fold = items[0]
    expect(fold?.kind === 'fold' && fold.stats.steps).toBe(3)
  })

  it('folds an error of a finished task, which the final result has outlived', () => {
    seq = 0
    const entries = buildTimeline([
      tool('c1', 'one'),
      event('error', { message: 'A hiccup that was retried' }),
      agent('implementer', { type: 'message', text: 'Done.' }),
    ])
    expect(kinds(foldTimeline(entries, 'done'))).toEqual(['fold', 'message'])
  })
})

describe('foldSummary', () => {
  it('leaves out the parts that are missing', () => {
    expect(foldSummary({ reviewRounds: 0, steps: 0, durationMs: undefined })).toBe('')
    expect(foldSummary({ reviewRounds: 1, steps: 0, durationMs: 400 })).toBe('1 輪審查')
    expect(foldSummary({ reviewRounds: 0, steps: 4, durationMs: 45_000 })).toBe('4 個步驟 · 45 秒')
  })
})
