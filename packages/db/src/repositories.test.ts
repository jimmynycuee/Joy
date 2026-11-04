import { afterEach, describe, expect, it } from 'vitest'
import type { AttemptId, RepoId, TaskId } from '@joy/core'
import { openDatabase } from './database.js'
import type { Database } from './database.js'
import {
  addUsage,
  appendTaskEvent,
  createAttempt,
  createRepo,
  createReview,
  createTask,
  getAttempt,
  getRepo,
  getTask,
  interruptRunningWork,
  latestAttempt,
  listAttempts,
  listRepos,
  listReviews,
  listTaskEvents,
  listTasks,
  listUsage,
  setTaskStatus,
  updateAttempt,
} from './repositories.js'

const databases: Database[] = []
function fresh() {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

const rid = (id: string) => id as RepoId
const tid = (id: string) => id as TaskId
const aid = (id: string) => id as AttemptId

function seed(db: Database) {
  const repo = createRepo(db, {
    id: rid('r1'),
    path: '/repo',
    defaultBranch: 'main',
    githubRemote: 'https://example/repo',
  })
  const task = createTask(db, {
    id: tid('t1'),
    repoId: repo.id,
    title: 'Fix bug',
    prompt: 'Fix it',
    mode: 'review_loop',
    roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku' } },
    planFirst: true,
    maxRounds: 4,
  })
  return { repo, task }
}

describe('repositories', () => {
  it('creates and lists repositories and tasks with their typed configuration', () => {
    const db = fresh()
    const { repo, task } = seed(db)
    expect(getRepo(db, rid('r1'))).toEqual(repo)
    expect(listRepos(db)).toEqual([repo])
    expect(getTask(db, task.id)).toEqual(task)
    expect(listTasks(db)).toEqual([task])
    expect(task.roleOverrides.implementer).toEqual({ provider: 'claude-cli', model: 'haiku' })
    expect(task.planFirst).toBe(true)
    expect(task.maxRounds).toBe(4)
  })

  it('persists attempt workspaces, sessions and status updates', () => {
    const db = fresh()
    const { task } = seed(db)
    const attempt = createAttempt(db, {
      id: aid('a1'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'preparing',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: '/tmp/joy-worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'a'.repeat(40),
      sessionId: 'session-1',
      status: 'running',
      diffStats: { files: 2 },
    })
    expect(getAttempt(db, attempt.id)).toMatchObject({
      id: attempt.id,
      taskId: attempt.taskId,
      provider: attempt.provider,
      model: attempt.model,
      worktreePath: '/tmp/joy-worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'a'.repeat(40),
      sessionId: 'session-1',
      status: 'running',
      diffStats: { files: 2 },
    })
    expect(listAttempts(db, task.id)).toHaveLength(1)
    expect(latestAttempt(db, task.id)?.id).toBe(attempt.id)
    setTaskStatus(db, task.id, 'running')
    expect(getTask(db, task.id)?.status).toBe('running')
  })

  it('only advances task updatedAt when its status changes', () => {
    const db = fresh()
    const { task } = seed(db)
    const previousUpdate = '2026-11-04T10:00:00.000Z'
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(previousUpdate, task.id)

    setTaskStatus(db, task.id, 'queued')
    expect(getTask(db, task.id)?.updatedAt).toBe(previousUpdate)

    setTaskStatus(db, task.id, 'running')
    expect(getTask(db, task.id)).toMatchObject({ status: 'running' })
    expect(getTask(db, task.id)?.updatedAt).not.toBe(previousUpdate)
  })

  it('persists task-ordered events, reviews, and additive daily usage', () => {
    const db = fresh()
    const { task } = seed(db)
    const first = createAttempt(db, {
      id: aid('a1'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    const second = createAttempt(db, {
      id: aid('a2'),
      taskId: task.id,
      provider: 'codex-cli',
      model: 'gpt-6-luna',
      status: 'running',
    })
    expect(appendTaskEvent(db, first.id, 'message', { text: 'started' }).seq).toBe(1)
    expect(appendTaskEvent(db, second.id, 'review', { approve: false }).seq).toBe(2)
    expect(appendTaskEvent(db, first.id, 'done', { ok: true }).seq).toBe(3)
    expect(listTaskEvents(db, task.id, 1).map(({ seq }) => seq)).toEqual([2, 3])

    createReview(db, {
      id: 'review-1',
      attemptId: first.id,
      reviewerProvider: 'codex-cli',
      reviewerModel: 'gpt-6-luna',
      round: 1,
      approve: false,
      summary: 'One issue',
      findings: [{ severity: 'major', message: 'Handle the empty input' }],
    })
    expect(listReviews(db, first.id)).toMatchObject([
      { approve: false, summary: 'One issue', findings: [{ severity: 'major' }] },
    ])
    createReview(db, {
      id: 'review-1-replayed',
      attemptId: first.id,
      reviewerProvider: 'codex-cli',
      reviewerModel: 'gpt-6-luna',
      round: 1,
      approve: true,
      summary: 'Replayed review',
      findings: [],
    })
    expect(listReviews(db, first.id)).toMatchObject([{ approve: true, summary: 'Replayed review' }])
    expect(listReviews(db, first.id)).toHaveLength(1)

    addUsage(db, { provider: 'openai-api', day: '2026-11-03', inputTokens: 10, costUsd: 0.2 })
    addUsage(db, { provider: 'openai-api', day: '2026-11-03', outputTokens: 4, rateLimitHits: 1 })
    addUsage(db, { provider: 'claude-cli', day: '2026-11-03', inputTokens: 7 })
    expect(listUsage(db)).toEqual([
      {
        provider: 'claude-cli',
        day: '2026-11-03',
        inputTokens: 7,
        outputTokens: 0,
        costUsd: 0,
        rateLimitHits: 0,
      },
      {
        provider: 'openai-api',
        day: '2026-11-03',
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.2,
        rateLimitHits: 1,
      },
    ])
  })

  it('marks interrupted work failed without deleting resume checkpoints', () => {
    const db = fresh()
    const { task } = seed(db)
    const attempt = createAttempt(db, {
      id: aid('a1'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: '/tmp/joy-worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'a'.repeat(40),
      sessionId: 'session-1',
    })
    setTaskStatus(db, task.id, 'running')

    expect(interruptRunningWork(db)).toEqual([task.id])
    expect(getTask(db, task.id)?.status).toBe('failed')
    expect(getAttempt(db, attempt.id)).toMatchObject({
      status: 'failed',
      worktreePath: '/tmp/joy-worktree',
      sessionId: 'session-1',
    })
  })
})
