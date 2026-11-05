import { afterEach, describe, expect, it } from 'vitest'
import type { AttemptId, RepoId, TaskId } from '@joy/core'
import { createAttempt, createRepo, createTask, listTaskEvents, openDatabase } from '@joy/db'
import { appendTaskEventIfAttemptExists } from './task-events.js'

describe('persisted task event anchors', () => {
  let db: ReturnType<typeof openDatabase> | undefined
  afterEach(() => {
    if (db?.isOpen) db.close()
    db = undefined
  })

  it('does not create or emit a colliding event when the attempt anchor is missing', () => {
    db = openDatabase(':memory:')
    const repo = createRepo(db, {
      id: 'event-anchor-repo' as RepoId,
      path: '/event-anchor-repo',
      defaultBranch: 'main',
    })
    const task = createTask(db, {
      id: 'event-anchor-task' as TaskId,
      repoId: repo.id,
      title: 'Persist only anchored events',
      prompt: 'Keep replay sequences unique.',
      mode: 'review_loop',
    })
    const attempt = createAttempt(db, {
      id: 'event-anchor-attempt' as AttemptId,
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })

    const first = appendTaskEventIfAttemptExists(db, attempt.id, 'started', {})
    expect(first?.seq).toBe(1)

    const missing = appendTaskEventIfAttemptExists(db, 'missing-attempt' as AttemptId, 'error', {
      message: 'This cannot be replayed without an anchor.',
    })
    expect(missing).toBeUndefined()
    expect(listTaskEvents(db, task.id)).toEqual([first])

    const next = appendTaskEventIfAttemptExists(db, attempt.id, 'error', { message: 'Persisted failure.' })
    expect(next?.seq).toBe(2)
    expect(listTaskEvents(db, task.id).map((event) => event.seq)).toEqual([1, 2])
  })
})
