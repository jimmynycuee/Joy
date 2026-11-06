import type { AttemptId, ProposedAction, RepoId, TaskId } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createApproval,
  decideApproval,
  expirePendingApprovals,
  getApproval,
  listApprovals,
} from './approvals.js'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import { createAttempt, createRepo, createTask } from './repositories.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

const action: ProposedAction = {
  kind: 'run_outside_worktree',
  summary: 'Claude requested the Bash tool.',
  detail: { command: 'curl https://example.com' },
  provenance: 'agent',
}

function seed() {
  const db = openDatabase(':memory:')
  databases.push(db)
  const repo = createRepo(db, { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' })
  for (const t of ['t1', 't2']) {
    createTask(db, {
      id: t as TaskId,
      repoId: repo.id,
      title: t,
      prompt: 'p',
      mode: 'single',
      roleOverrides: {},
      planFirst: false,
      maxRounds: 1,
    })
    createAttempt(db, {
      id: `a-${t}` as AttemptId,
      taskId: t as TaskId,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
  }
  return db
}

describe('approvals', () => {
  it('creates a pending approval tied to its task', () => {
    const db = seed()
    const created = createApproval(db, { id: 'ap1', attemptId: 'a-t1' as AttemptId, action, tier: 'approve' })
    expect(created).toMatchObject({ id: 'ap1', taskId: 't1', status: 'pending', tier: 'approve', action })
    expect(getApproval(db, 'ap1')).toEqual(created)
  })

  it('lets only the first decision win', () => {
    const db = seed()
    createApproval(db, { id: 'ap1', attemptId: 'a-t1' as AttemptId, action, tier: 'approve' })
    const first = decideApproval(db, 'ap1', 'approved', 'telegram', 'looks fine')
    expect(first).toMatchObject({ status: 'approved', decidedVia: 'telegram', note: 'looks fine' })
    expect(first?.decidedAt).toBeTruthy()
    expect(decideApproval(db, 'ap1', 'denied', 'web')).toBeUndefined()
    expect(getApproval(db, 'ap1')?.status).toBe('approved')
    expect(decideApproval(db, 'missing', 'approved', 'web')).toBeUndefined()
  })

  it('filters by status and task', () => {
    const db = seed()
    createApproval(db, { id: 'ap1', attemptId: 'a-t1' as AttemptId, action, tier: 'approve' })
    createApproval(db, { id: 'ap2', attemptId: 'a-t2' as AttemptId, action, tier: 'approve' })
    decideApproval(db, 'ap2', 'denied', 'web')
    expect(listApprovals(db, { status: 'pending' }).map((a) => a.id)).toEqual(['ap1'])
    expect(listApprovals(db, { taskId: 't2' as TaskId }).map((a) => a.id)).toEqual(['ap2'])
    expect(listApprovals(db).map((a) => a.id)).toEqual(['ap1', 'ap2'])
  })

  it('expires approvals left pending by a restart', () => {
    const db = seed()
    createApproval(db, { id: 'ap1', attemptId: 'a-t1' as AttemptId, action, tier: 'approve' })
    expect(expirePendingApprovals(db)).toBe(1)
    expect(getApproval(db, 'ap1')).toMatchObject({ status: 'expired', decidedVia: 'restart' })
    expect(expirePendingApprovals(db)).toBe(0)
  })
})
