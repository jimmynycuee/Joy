import { describe, expect, it } from 'vitest'
import { hasUnpublishedChanges, taskModels, worktreeRemoved } from './task-info.js'
import type { TaskDetails, TaskEvent } from './types.js'

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

describe('taskModels', () => {
  const details = (extra: Partial<TaskDetails>): TaskDetails => ({
    task: {
      id: 't1',
      repoId: 'r1',
      title: 't',
      prompt: 'p',
      mode: 'review_loop',
      status: 'running',
      createdAt: '',
    },
    repo: null,
    attempts: [],
    reviews: [],
    events: [],
    ...extra,
  })

  it('names the attempt model with the chosen effort and the reviewer', () => {
    const base = details({})
    expect(
      taskModels({
        ...base,
        task: {
          ...base.task,
          roleOverrides: { implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' } },
        },
        attempts: [{ provider: 'codex-cli', model: 'gpt-6.1-sol' }],
        reviews: [{ reviewerProvider: 'claude-cli', reviewerModel: 'opus' }],
      }),
    ).toEqual({ implementer: 'GPT-6.1 Sol · 高', reviewer: 'Opus 5.5' })
  })

  it('falls back to the overrides and leaves out what is unknown', () => {
    expect(taskModels(details({}))).toEqual({})
    expect(taskModels(details({ attempts: [{ provider: 'nope', model: 'x' }] }))).toEqual({})
  })
})
