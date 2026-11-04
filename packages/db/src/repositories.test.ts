import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttemptId, RepoId, TaskId } from '@joy/core'
import { openDatabase } from './database.js'
import type { Database } from './database.js'
import {
  addUsage,
  appendTaskEvent,
  createApproval,
  createAttempt,
  createRepo,
  createReview,
  createTask,
  decideApproval,
  expirePendingApprovals,
  getApproval,
  getAttempt,
  getRepo,
  getTask,
  interruptRunningWork,
  latestAttempt,
  listAttempts,
  listRepos,
  listReviews,
  listTaskApprovals,
  listTaskEvents,
  listTasks,
  listUsage,
  listModelStats,
  setTaskStatus,
  updateAttempt,
} from './repositories.js'

const databases: Database[] = []
const directories: string[] = []
function fresh() {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
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

  it('aggregates persisted model performance by provider, model, and task kind', () => {
    const db = fresh()
    const { task } = seed(db)
    const successful = createAttempt(db, {
      id: aid('stats-success'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    createReview(db, {
      id: 'stats-review-success',
      attemptId: successful.id,
      reviewerProvider: 'codex-cli',
      reviewerModel: 'gpt-6-luna',
      round: 1,
      approve: false,
      summary: 'Two issues',
      findings: [
        { severity: 'major', message: 'First issue' },
        { severity: 'minor', message: 'Second issue' },
      ],
    })
    db.prepare('UPDATE attempts SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      successful.id,
    )
    db.prepare('UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?').run(
      'succeeded',
      '2026-01-01T00:02:00.000Z',
      successful.id,
    )

    const failed = createAttempt(db, {
      id: aid('stats-failed'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    createReview(db, {
      id: 'stats-review-failed',
      attemptId: failed.id,
      reviewerProvider: 'codex-cli',
      reviewerModel: 'gpt-6-luna',
      round: 1,
      approve: false,
      summary: 'One issue',
      findings: [{ severity: 'major', message: 'Third issue' }],
    })
    db.prepare('UPDATE attempts SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', failed.id)
    db.prepare('UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?').run(
      'failed',
      '2026-01-01T00:01:00.000Z',
      failed.id,
    )

    const cancelled = createAttempt(db, {
      id: aid('stats-cancelled'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'cancelled',
    })
    expect(getAttempt(db, cancelled.id)?.status).toBe('cancelled')
    expect(listModelStats(db)).toEqual([
      {
        provider: 'claude-cli',
        model: 'haiku',
        taskKind: 'review_loop',
        attemptCount: 2,
        successCount: 1,
        successRate: 0.5,
        totalReviewIssues: 3,
        averageReviewIssues: 1.5,
        averageDurationMs: 90000,
      },
    ])

    updateAttempt(db, successful.id, { status: 'running' })
    expect(listModelStats(db)).toMatchObject([{ attemptCount: 1, successCount: 0, successRate: 0 }])
  })

  it('persists pending approval requests across database reopen and expires them on task cancellation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-approval-test-'))
    directories.push(directory)
    const path = join(directory, 'joy.sqlite')
    const db = openDatabase(path)
    databases.push(db)
    const { task } = seed(db)
    const attempt = createAttempt(db, {
      id: aid('approval-attempt'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    const request = createApproval(db, {
      id: 'approval-1',
      attemptId: attempt.id,
      tier: 'approve',
      action: {
        kind: 'send_mail',
        summary: 'Send a message',
        detail: { recipient: 'owner@example.test' },
        provenance: 'agent',
      },
    })
    setTaskStatus(db, task.id, 'awaiting_approval')
    expect(listTaskApprovals(db, task.id)).toEqual([request])
    db.close()

    const reopened = openDatabase(path)
    databases.push(reopened)
    expect(getTask(reopened, task.id)?.status).toBe('awaiting_approval')
    expect(getApproval(reopened, request.id)).toEqual(request)
    expect(expirePendingApprovals(reopened, task.id)).toBe(1)
    expect(getApproval(reopened, request.id)).toMatchObject({
      status: 'expired',
      decidedVia: 'task_cancelled',
    })
    expect(decideApproval(reopened, request.id, 'approved', 'test')).toMatchObject({ status: 'expired' })
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
