import { describe, expect, it } from 'vitest'
import { effectiveEvents, pendingMessages, rewindPoints } from './turns.js'
import type { TurnEvent } from './turns.js'

function thread(...events: Array<[string, Record<string, unknown>]>): TurnEvent[] {
  return events.map(([type, payload], index) => ({ seq: index + 1, type, payload }))
}

describe('pendingMessages', () => {
  it('replays sends, edits, reorders, deliveries and discards', () => {
    const events = thread(
      ['user.message', { id: 'a', text: 'A', delivery: 'queued', persisted: true }],
      [
        'user.message',
        {
          id: 'b',
          text: 'B',
          delivery: 'queued',
          persisted: true,
          attachments: [{ id: 'f1', name: 'x.png' }],
        },
      ],
      [
        'user.message',
        { id: 'c', text: 'C', delivery: 'queued', persisted: true, settings: { mode: 'single' } },
      ],
      ['user.message', { id: 'd', text: 'D', delivery: 'follow_up' }],
      ['user.message.edited', { id: 'b', text: 'B2' }],
      ['user.message.reordered', { ids: ['c', 'b', 'a'] }],
      ['user.message.discarded', { ids: ['a'], reason: 'owner' }],
    )
    expect(pendingMessages(events)).toEqual([
      { id: 'c', text: 'C', settings: { mode: 'single' } },
      { id: 'b', text: 'B2', attachments: ['f1'] },
    ])
    expect(pendingMessages([...events, ...thread(['user.message.delivered', { ids: ['c', 'b'] }])])).toEqual(
      [],
    )
  })

  it('counts a steer that never arrived as waiting, and puts a failed steer at the end', () => {
    const events = thread(
      ['user.message', { id: 's', text: 'S', delivery: 'steer', persisted: true }],
      ['user.message', { id: 'q', text: 'Q', delivery: 'queued', persisted: true }],
      ['user.message.requeued', { ids: ['s'], reason: 'steer_failed' }],
      ['user.message', { id: 'i', text: 'I', delivery: 'interrupt', persisted: true }],
      ['user.message.delivered', { ids: ['i'], via: 'interrupt' }],
    )
    expect(pendingMessages(events).map((m) => m.id)).toEqual(['q', 's'])
  })

  it('drops everything waiting when the owner goes back to an earlier round', () => {
    const events = thread(
      ['user.message', { id: 'q', text: 'Q', delivery: 'queued', persisted: true }],
      ['task.rewound', { messageId: 'task', fromSeq: 1, discardedIds: ['q'] }],
    )
    expect(pendingMessages(events)).toEqual([])
  })

  it('does not bring back messages an older version lost (no `persisted` mark), even before a new run', () => {
    const legacy = thread(
      ['started', {}],
      ['user.message', { id: 'old', text: 'stale', delivery: 'queued' }],
      ['result', {}],
      ['user.message', { id: 'f', text: 'go on', delivery: 'follow_up' }],
      ['started', {}],
    )
    expect(pendingMessages(legacy)).toEqual([])
    const current = thread(
      ['started', {}],
      ['user.message', { id: 'new', text: 'waiting', delivery: 'queued', persisted: true }],
    )
    expect(pendingMessages(current).map((m) => m.id)).toEqual(['new'])
  })

  it('takes a message as lost when a later run started without it, but not when its own run only just started', () => {
    // Held, then the owner pressed Continue and Joy stopped before the run took it: still waiting.
    const justStarted = thread(
      ['user.message', { id: 'h', text: 'held', delivery: 'queued', persisted: true }],
      ['started', {}],
    )
    expect(pendingMessages(justStarted).map((m) => m.id)).toEqual(['h'])
    // That run never took it and another run started since: lost.
    const passedOver = thread(
      ['user.message', { id: 'h', text: 'held', delivery: 'queued', persisted: true }],
      ['started', {}],
      ['result', {}],
      ['started', {}],
    )
    expect(pendingMessages(passedOver)).toEqual([])
  })
})

describe('pendingMessages across interrupts', () => {
  it('keeps messages waiting through two interrupts in a row, in the order they were sent', () => {
    const events = thread(
      ['started', {}],
      [
        'user.message',
        { id: 'S', text: 'switch', delivery: 'queued', persisted: true, settings: { mode: 'single' } },
      ],
      ['user.message', { id: 'I1', text: 'first stop', delivery: 'interrupt', persisted: true }],
      ['run.interrupted', {}],
      ['started', {}],
      ['user.message', { id: 'I2', text: 'second stop', delivery: 'interrupt', persisted: true }],
      ['run.interrupted', {}],
      ['started', {}],
    )
    expect(pendingMessages(events).map((m) => m.id)).toEqual(['S', 'I1', 'I2'])
  })
})

describe('effectiveEvents', () => {
  it('leaves out rewound ranges and the messages discarded with them, and applies edits', () => {
    const events = thread(
      ['started', {}],
      ['user.message', { id: 'early', text: 'queued early', delivery: 'queued', persisted: true }],
      ['user.message.edited', { id: 'early', text: 'edited' }],
      ['user.message', { id: 'kept', text: 'old', delivery: 'queued', persisted: true }],
      ['user.message.edited', { id: 'kept', text: 'new' }],
      ['result', {}],
      ['user.message', { id: 'r2', text: 'round 2', delivery: 'follow_up' }],
      ['started', {}],
      ['task.rewound', { messageId: 'r2', fromSeq: 7, discardedIds: ['r2', 'early'] }],
    )
    const live = effectiveEvents(events)
    expect(live.map((e) => e.seq)).toEqual([1, 3, 4, 5, 6, 9])
    expect(live.find((e) => e.seq === 4)?.payload).toMatchObject({ text: 'new' })
  })
})

describe('rewindPoints', () => {
  it('finds the turn-start checkpoint of the task and of each round, with queued messages in their batch', () => {
    const events = thread(
      ['started', {}],
      ['checkpoint.created', { n: 1, turnStart: true }],
      ['user.message', { id: 'q1', text: 'queued', delivery: 'queued', persisted: true }],
      ['checkpoint.created', { n: 2 }],
      ['result', {}],
      ['user.message.delivered', { ids: ['q1'], via: 'follow_up' }],
      ['started', {}],
      ['checkpoint.created', { n: 3, turnStart: true }],
      ['result', {}],
      ['user.message.delivered', { ids: ['q2'], via: 'follow_up' }],
      ['user.message', { id: 'f2', text: 'and this', delivery: 'follow_up' }],
      ['started', {}],
      ['checkpoint.created', { n: 4, turnStart: true }],
      ['user.message', { id: 'steered', text: 'mid-run', delivery: 'steer', persisted: true }],
      ['result', {}],
      // A round whose run never got to its checkpoint cannot be gone back to.
      ['user.message', { id: 'f3', text: 'no checkpoint', delivery: 'follow_up' }],
      ['started', {}],
      ['error', {}],
    )
    expect(rewindPoints(events)).toEqual([
      { messageId: 'task', ids: [], checkpoint: 1, fromSeq: 1 },
      { messageId: 'q1', ids: ['q1'], checkpoint: 3, fromSeq: 6 },
      { messageId: 'q2', ids: ['q2', 'f2'], checkpoint: 4, fromSeq: 10 },
    ])
  })

  it('starts over after the owner went back, and the first round starts after the last rewind to it', () => {
    const events = thread(
      ['started', {}],
      ['checkpoint.created', { n: 1, turnStart: true }],
      ['user.message', { id: 'f1', text: 'x', delivery: 'follow_up' }],
      ['started', {}],
      ['checkpoint.created', { n: 2, turnStart: true }],
      ['task.rewound', { messageId: 'task', fromSeq: 1, discardedIds: ['f1'] }],
      ['started', {}],
      ['checkpoint.created', { n: 3, turnStart: true }],
    )
    expect(rewindPoints(events)).toEqual([{ messageId: 'task', ids: [], checkpoint: 3, fromSeq: 7 }])
  })
})
