import { describe, expect, it } from 'vitest'
import { withServerFields } from './useTaskDetails.js'
import type { TaskDetails, TaskEvent } from '../types.js'

const task = {
  id: 't',
  repoId: 'r',
  title: 'T',
  prompt: 'p',
  mode: 'single',
  status: 'review_ready',
  createdAt: '',
}
const event: TaskEvent = { taskId: 't', seq: 1, type: 'started', payload: {}, ts: '2026-11-08T10:00:00.000Z' }

describe('withServerFields', () => {
  it('takes the derived fields from a fresh fetch and keeps the live task and events', () => {
    const current: TaskDetails = { task, repo: null, attempts: [], reviews: [], events: [event] }
    const next: TaskDetails = {
      task: { ...task, status: 'done' },
      repo: { id: 'r', path: '/x', defaultBranch: 'main' },
      attempts: [{ id: 'a' }],
      reviews: [],
      events: [],
      usage: { durationMs: 5, byProvider: [] },
      pendingPlan: { plan: '# plan' },
      queuedMessages: [{ id: 'm', text: 'hi' }],
    }
    const merged = withServerFields(current, next)
    expect(merged.task.status).toBe('review_ready')
    expect(merged.events).toEqual([event])
    expect(merged.pendingPlan).toEqual({ plan: '# plan' })
    expect(merged.queuedMessages).toEqual([{ id: 'm', text: 'hi' }])
    expect(merged.usage?.durationMs).toBe(5)
    expect(merged.attempts).toEqual([{ id: 'a' }])
  })

  it('clears a plan the server no longer reports, and keeps older usage', () => {
    const current: TaskDetails = {
      task,
      repo: null,
      attempts: [],
      reviews: [],
      events: [],
      usage: { durationMs: 9, byProvider: [] },
      pendingPlan: { plan: '# old' },
    }
    const merged = withServerFields(current, { task, repo: null, attempts: [], reviews: [], events: [] })
    expect(merged.pendingPlan).toBeNull()
    expect(merged.queuedMessages).toEqual([])
    expect(merged.usage?.durationMs).toBe(9)
  })
})
