import { describe, expect, it } from 'vitest'
import { deliveryTag, followUpState, messageDeliveryStates, ownerActionError } from './messages.js'
import type { TaskEvent } from './types.js'

let seq = 0
const event = (type: string, payload: unknown): TaskEvent => ({
  taskId: 't1',
  seq: ++seq,
  type,
  payload,
  ts: '2026-11-08T10:00:00.000Z',
})
const message = (id: string, delivery: string) =>
  event('user.message', { id, text: `text ${id}`, provenance: 'user', delivery })

describe('messageDeliveryStates', () => {
  it('keeps a queued message queued until a delivered event names it', () => {
    const queued = [message('a', 'queued'), message('b', 'queued')]
    expect([...messageDeliveryStates(queued)]).toEqual([
      ['a', 'queued'],
      ['b', 'queued'],
    ])
    const after = messageDeliveryStates([
      ...queued,
      event('user.message.delivered', { ids: ['a'], via: 'next_turn' }),
    ])
    expect(after.get('a')).toBe('delivered')
    expect(after.get('b')).toBe('queued')
  })

  it('marks a discarded message, and treats immediate deliveries as sent', () => {
    const states = messageDeliveryStates([
      message('a', 'queued'),
      message('b', 'follow_up'),
      message('c', 'replan'),
      event('user.message.discarded', { ids: ['a'], reason: 'The task was cancelled' }),
    ])
    expect(states.get('a')).toBe('discarded')
    expect(states.get('b')).toBe('sent')
    expect(states.get('c')).toBe('sent')
  })

  it('shows a queued message the server forgot as lost, but only once the task stopped running', () => {
    const events = [message('a', 'queued'), message('b', 'queued')]
    const queuedIds = new Set(['b'])
    expect(messageDeliveryStates(events, { queuedIds, busy: false }).get('a')).toBe('lost')
    expect(messageDeliveryStates(events, { queuedIds, busy: false }).get('b')).toBe('queued')
    expect(messageDeliveryStates(events, { queuedIds, busy: true }).get('a')).toBe('queued')
  })

  it('ignores malformed events', () => {
    const states = messageDeliveryStates([
      event('user.message', { text: 'no id' }),
      event('user.message.delivered', { ids: 'nope' }),
      event('user.message.discarded', null),
    ])
    expect(states.size).toBe(0)
  })
})

describe('deliveryTag', () => {
  it('only tags the states the owner should notice', () => {
    expect(deliveryTag('queued')).toBe('排隊中')
    expect(deliveryTag('discarded')).toBe('已撤回')
    expect(deliveryTag('lost')).toBe('未送達')
    expect(deliveryTag('delivered')).toBeUndefined()
    expect(deliveryTag('sent')).toBeUndefined()
  })
})

describe('followUpState', () => {
  const base = { status: 'done', mode: 'review_loop', worktreeRemoved: false, pendingPlan: false }

  it('words the placeholder after what the message will do', () => {
    expect(followUpState({ ...base, status: 'running' }).placeholder).toBe('補充指示，下一輪會帶給 agent')
    expect(followUpState({ ...base, status: 'awaiting_approval' }).placeholder).toBe(
      '補充指示，下一輪會帶給 agent',
    )
    expect(followUpState(base).placeholder).toBe('接著交代…')
    expect(followUpState({ ...base, status: 'failed' }).placeholder).toBe('接著交代…')
    expect(followUpState({ ...base, status: 'review_ready', pendingPlan: true }).placeholder).toBe(
      '說明要怎麼改計畫',
    )
  })

  it('is disabled with a reason for compete tasks and removed worktrees', () => {
    const compete = followUpState({ ...base, mode: 'compete' })
    expect(compete.disabled).toBe(true)
    expect(compete.reason).toContain('比賽')
    const removed = followUpState({ ...base, worktreeRemoved: true })
    expect(removed.disabled).toBe(true)
    expect(removed.reason).toContain('工作副本')
    expect(followUpState(base).disabled).toBe(false)
  })
})

describe('ownerActionError', () => {
  it('explains the busy 409, the 429 and other conflicts in Chinese', () => {
    expect(
      ownerActionError(
        409,
        'Another action on this task is still in progress; try again in a moment',
        '無法送出',
      ),
    ).toBe('這個任務正在處理另一個動作，請稍後再送')
    expect(ownerActionError(429, 'Too many messages are waiting', '無法送出')).toContain('排隊')
    expect(
      ownerActionError(409, 'This worktree was already removed (published or discarded)', '無法送出'),
    ).toContain('工作副本已經移除')
    expect(ownerActionError(409, 'Task cannot take a message while it is queued', '無法送出')).toContain(
      '狀態',
    )
  })

  it('explains restore conflicts', () => {
    expect(
      ownerActionError(
        409,
        'Task is running; cancel it or wait for it to finish before restoring',
        '無法還原',
      ),
    ).toContain('進行中')
    expect(
      ownerActionError(409, 'The worktree of this checkpoint was already removed', '無法還原'),
    ).toContain('已經移除')
    expect(ownerActionError(404, 'Checkpoint 9 was not found', '無法還原')).toContain('找不到')
  })

  it('passes other errors through', () => {
    expect(ownerActionError(500, 'boom', '無法送出')).toBe('boom')
    expect(ownerActionError(undefined, '', '無法送出')).toBe('無法送出')
  })
})
