import { describe, expect, it } from 'vitest'
import { foldTimeline } from './fold.js'
import { ownerActionError } from './messages.js'
import { deliveryRequest, moveQueued } from './queue.js'
import { parseRewindPoints, rewindConfirmQuestion, rewindTargets } from './rewind.js'
import { diffFrom } from './task-info.js'
import { buildTimeline } from './timeline.js'
import type { TaskEvent } from './types.js'

let seq = 0
const event = (type: string, payload: unknown): TaskEvent => ({
  taskId: 't1',
  seq: ++seq,
  type,
  payload,
  ts: '2026-11-16T10:00:00.000Z',
})
const answer = (text: string) => event('agent', { role: 'implementer', event: { type: 'message', text } })

describe('going back to an earlier round', () => {
  it('folds the rounds the owner went back over into one discarded entry, with messages sent before them', () => {
    seq = 0
    const events = [
      event('started', {}),
      event('user.message', { id: 'early', text: 'queued while round 1 ran', delivery: 'queued' }),
      answer('round 1 done'),
      event('user.message.delivered', { ids: ['early'], via: 'follow_up' }),
      event('started', {}),
      answer('round 2 done'),
      event('task.rewound', {
        messageId: 'early',
        fromSeq: 4,
        discardedIds: ['early'],
        diff: { files: [], patch: '' },
      }),
      event('user.message', { id: 'again', text: 'smaller, please', delivery: 'follow_up' }),
    ]
    const entries = buildTimeline(events)
    const kinds = entries.map((entry) => entry.kind)
    expect(kinds).toEqual(['step', 'rewound', 'message', 'rewound', 'step', 'user'])
    const [first, second] = entries.filter((entry) => entry.kind === 'rewound')
    expect(first && first.kind === 'rewound' && first.entries.map((entry) => entry.kind)).toEqual(['user'])
    expect(second && second.kind === 'rewound' && second.entries.map((entry) => entry.kind)).toEqual([
      'noise',
      'step',
      'message',
    ])
    expect(entries.at(-2)).toMatchObject({ kind: 'step', text: '從這裡重做', owner: true })
    // A finished task keeps the discarded rounds in view (folded on their own), not inside 過程.
    const folded = foldTimeline(entries, 'done')
    expect(folded.filter((item) => item.kind === 'entry' && item.entry.kind === 'rewound')).toHaveLength(2)
    // The restored worktree's diff is what the changes pane shows.
    expect(diffFrom(events)).toEqual({ files: [], patch: '' })
  })

  it('reads the rounds from the task details and puts the button on each round’s first message', () => {
    const points = parseRewindPoints([
      { messageId: 'task', ids: [], checkpoint: 1 },
      { messageId: 'q1', ids: ['q1', 'f2'], checkpoint: 3 },
      { messageId: 7 },
      'junk',
    ])
    expect(points).toEqual([
      { messageId: 'task', ids: [] },
      { messageId: 'q1', ids: ['q1', 'f2'] },
    ])
    expect([...rewindTargets(points)]).toEqual([
      ['task', 'task'],
      ['q1', 'q1'],
    ])
    expect(parseRewindPoints(undefined)).toEqual([])
  })

  it('says how to get back after a restore stopped half way', () => {
    seq = 0
    const [entry] = buildTimeline([event('checkpoint.restore_failed', { n: 3, savedAs: 7, message: 'x' })])
    expect(entry).toMatchObject({ kind: 'step', tone: 'bad', text: expect.stringContaining('還原檢查點 7') })
    expect(
      ownerActionError(
        500,
        'Restoring stopped half way: boom. The worktree may be half restored; restore checkpoint 7 to get back the state from before',
        '無法重做',
      ),
    ).toContain('還原檢查點 7')
  })

  it('asks only about the refusals a confirmation gets past', () => {
    expect(
      rewindConfirmQuestion('This task has a pull request; going back … (send {"confirm": true})'),
    ).toContain('PR')
    expect(
      rewindConfirmQuestion('Restoring this checkpoint would discard 2 commits made after it'),
    ).toContain('2 個 commit')
    expect(rewindConfirmQuestion('Task is running; stop it before going back')).toBeUndefined()
  })
})

describe('the queue above the composer', () => {
  it('shows a rewritten message with its new words and leaves still-queued ones to the list', () => {
    seq = 0
    const events = [
      event('user.message', { id: 'a', text: 'old words', delivery: 'queued' }),
      event('user.message.edited', { id: 'a', text: 'new words' }),
      event('user.message', { id: 'b', text: 'still waiting', delivery: 'queued' }),
      event('user.message.delivered', { ids: ['a'], via: 'follow_up' }),
    ]
    const users = buildTimeline(events, undefined, { queuedIds: new Set(['b']), busy: true }).filter(
      (entry) => entry.kind === 'user',
    )
    expect(users).toEqual([expect.objectContaining({ id: 'a', text: 'new words', state: 'delivered' })])
  })

  it('moves a message one place and keeps the order at the ends', () => {
    const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(moveQueued(queue, 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveQueued(queue, 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveQueued(queue, 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveQueued(queue, 2, 1)).toEqual(['a', 'b', 'c'])
  })

  it('queues by default while the task works and sends straight away when asked or when it is idle', () => {
    expect(deliveryRequest(true, false)).toEqual({ queue: true })
    expect(deliveryRequest(true, true)).toEqual({})
    expect(deliveryRequest(false, false)).toEqual({})
  })
})
