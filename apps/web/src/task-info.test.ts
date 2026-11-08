import { describe, expect, it } from 'vitest'
import { hasUnpublishedChanges, worktreeRemoved } from './task-info.js'
import type { TaskEvent } from './types.js'

const ev = (type: string, seq: number, payload: unknown = {}): TaskEvent => ({
  taskId: 't1',
  seq,
  type,
  payload,
  ts: '2026-11-08T00:00:00Z',
})

describe('published task state', () => {
  it('sees new agent work after the last publish', () => {
    expect(hasUnpublishedChanges([ev('result', 1)])).toBe(false)
    expect(hasUnpublishedChanges([ev('result', 1), ev('publish.done', 2)])).toBe(false)
    expect(hasUnpublishedChanges([ev('publish.done', 1), ev('user.message', 2), ev('result', 3)])).toBe(true)
    expect(hasUnpublishedChanges([ev('publish.done', 1), ev('result', 2), ev('publish.done', 3)])).toBe(false)
    expect(hasUnpublishedChanges([ev('publish.done', 1), ev('checkpoint.restored', 2)])).toBe(true)
  })

  it('keeps the worktree after publishing until Joy reports it removed', () => {
    expect(worktreeRemoved([ev('publish.done', 1)])).toBe(false)
    expect(worktreeRemoved([ev('publish.done', 1), ev('worktree.removed', 2, { published: true })])).toBe(
      true,
    )
  })
})
