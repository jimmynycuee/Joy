import { afterEach, describe, expect, it } from 'vitest'
import type { AttemptId, RepoId, TaskId } from '@joy/core'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import { appendTaskEvent, createAttempt, createRepo, createReview, createTask } from './repositories.js'
import { modelStats } from './stats.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

function seed() {
  const db = openDatabase(':memory:')
  databases.push(db)
  createRepo(db, { id: 'joy' as RepoId, path: '/joy', defaultBranch: 'main' })
  createRepo(db, { id: 'other' as RepoId, path: '/other', defaultBranch: 'main' })
  let n = 0
  const attempt = (input: {
    repo: string
    provider: 'claude-cli' | 'codex-cli'
    model: string
    status: 'succeeded' | 'failed' | 'cancelled'
    start: string
    minutes: number
    reviews?: Array<{ approve: boolean; findings: number }>
  }) => {
    const id = `a${++n}`
    createTask(db, {
      id: `t${n}` as TaskId,
      repoId: input.repo as RepoId,
      title: id,
      prompt: id,
      mode: 'review_loop',
    })
    createAttempt(db, {
      id: id as AttemptId,
      taskId: `t${n}` as TaskId,
      provider: input.provider,
      model: input.model,
      status: input.status,
    })
    const end = new Date(Date.parse(input.start) + input.minutes * 60_000).toISOString()
    db.prepare('UPDATE attempts SET created_at = ?, updated_at = ? WHERE id = ?').run(input.start, end, id)
    input.reviews?.forEach((review, index) =>
      createReview(db, {
        id: `${id}-r${index}`,
        attemptId: id as AttemptId,
        reviewerProvider: input.provider === 'claude-cli' ? 'codex-cli' : 'claude-cli',
        reviewerModel: input.provider === 'claude-cli' ? 'gpt-6' : 'opus',
        round: index + 1,
        approve: review.approve,
        summary: '',
        findings: Array.from({ length: review.findings }, () => ({
          severity: 'major',
          message: 'x',
        })) as never,
      }),
    )
    return id as AttemptId
  }
  attempt({
    repo: 'joy',
    provider: 'claude-cli',
    model: 'opus',
    status: 'succeeded',
    start: '2026-10-01T10:00:00.000Z',
    minutes: 10,
    reviews: [
      { approve: false, findings: 2 },
      { approve: true, findings: 0 },
    ],
  })
  attempt({
    repo: 'joy',
    provider: 'claude-cli',
    model: 'opus',
    status: 'succeeded',
    start: '2026-11-01T10:00:00.000Z',
    minutes: 20,
    reviews: [{ approve: false, findings: 1 }],
  })
  const handedOver = attempt({
    repo: 'other',
    provider: 'codex-cli',
    model: 'gpt-6',
    status: 'failed',
    start: '2026-11-02T10:00:00.000Z',
    minutes: 30,
  })
  attempt({
    repo: 'joy',
    provider: 'claude-cli',
    model: 'opus',
    status: 'cancelled',
    start: '2026-11-03T10:00:00.000Z',
    minutes: 5,
  })
  appendTaskEvent(db, handedOver, 'quota.handoff', {
    from: { provider: 'claude-cli', model: 'opus' },
    to: { provider: 'codex-cli', model: 'gpt-6' },
  })
  return db
}

describe('model stats', () => {
  it('reports pass rate, problems found, time and handoffs per model', () => {
    const stats = modelStats(seed())
    expect(stats.implementers).toEqual([
      {
        provider: 'claude-cli',
        model: 'opus',
        mode: 'review_loop',
        attempts: 3,
        finished: 2,
        // The second attempt finished without the reviewer's approval.
        passed: 1,
        passRate: 0.5,
        findingsAgainst: 3,
        avgDurationMs: 15 * 60_000,
        handoffs: 1,
      },
      {
        provider: 'codex-cli',
        model: 'gpt-6',
        mode: 'review_loop',
        attempts: 1,
        finished: 1,
        passed: 0,
        passRate: 0,
        findingsAgainst: 0,
        avgDurationMs: 30 * 60_000,
        handoffs: 0,
      },
    ])
    expect(stats.reviewers).toEqual([
      { provider: 'codex-cli', model: 'gpt-6', reviews: 3, approvals: 1, findings: 3 },
    ])
  })

  it('filters by period and repository', () => {
    const db = seed()
    const november = modelStats(db, { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' })
    expect(november.implementers.find((s) => s.provider === 'claude-cli')).toMatchObject({
      attempts: 2,
      findingsAgainst: 1,
    })
    const other = modelStats(db, { repoId: 'other' })
    expect(other.implementers.map((s) => [s.provider, s.attempts, s.handoffs])).toEqual([
      ['codex-cli', 1, 0],
      ['claude-cli', 0, 1],
    ])
    expect(other.reviewers).toEqual([])
    expect(modelStats(db, { repoId: 'missing' })).toEqual({ implementers: [], reviewers: [] })
  })
})
