import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttemptId, RepoId, TaskId } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createApproval } from './approvals.js'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import {
  createAttempt,
  createRepo,
  createTask,
  interruptRunningWork,
  setTaskStatus,
  updateTask,
} from './repositories.js'
import {
  clearTaskAllows,
  createTaskAllow,
  deleteTaskAllow,
  findTaskAllow,
  listTaskAllows,
} from './task-allows.js'

const databases: Database[] = []
const dirs: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function seed(db: Database) {
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
    createApproval(db, {
      id: `ap-${t}`,
      attemptId: `a-${t}` as AttemptId,
      action: { kind: 'run_outside_worktree', summary: 's', detail: {}, provenance: 'agent' },
      tier: 'approve',
    })
  }
}

function open(path = ':memory:') {
  const db = openDatabase(path)
  databases.push(db)
  return db
}

const allow = (db: Database, n: number, taskId: string, fingerprint = HASH_A) =>
  createTaskAllow(db, {
    id: uuid(n),
    taskId: taskId as TaskId,
    kind: 'shell',
    fingerprint,
    target: 'pnpm install',
    approvalId: `ap-${taskId}`,
  })

describe('task allows', () => {
  it('stores, finds, lists and revokes an allow per task', () => {
    const db = open()
    seed(db)
    const created = allow(db, 1, 't1')
    expect(created).toMatchObject({
      taskId: 't1',
      kind: 'shell',
      target: 'pnpm install',
      approvalId: 'ap-t1',
    })
    // The same fingerprint again keeps the first row.
    expect(allow(db, 2, 't1').id).toBe(created.id)
    expect(findTaskAllow(db, 't1' as TaskId, HASH_A)?.id).toBe(created.id)
    // Not shared across tasks.
    expect(findTaskAllow(db, 't2' as TaskId, HASH_A)).toBeUndefined()
    allow(db, 3, 't1', HASH_B)
    expect(listTaskAllows(db, 't1' as TaskId).map((a) => a.fingerprint)).toEqual([HASH_A, HASH_B])
    expect(deleteTaskAllow(db, 't2' as TaskId, created.id)).toBe(false)
    expect(deleteTaskAllow(db, 't1' as TaskId, created.id)).toBe(true)
    expect(findTaskAllow(db, 't1' as TaskId, HASH_A)).toBeUndefined()
    expect(clearTaskAllows(db, 't1' as TaskId)).toBe(1)
  })

  it('rejects bad rows', () => {
    const db = open()
    seed(db)
    expect(() => allow(db, 1, 't1', 'not-a-hash')).toThrow()
    expect(() => allow(db, 1, 't1', 'A'.repeat(64))).toThrow()
    expect(() =>
      createTaskAllow(db, {
        id: uuid(2),
        taskId: 't1' as TaskId,
        kind: 'everything' as 'shell',
        fingerprint: HASH_A,
        target: 'x',
        approvalId: 'ap-t1',
      }),
    ).toThrow()
    expect(() => createTaskAllow(db, { ...allowInput(3), taskId: 'missing' as TaskId })).toThrow()
    expect(() => createTaskAllow(db, { ...allowInput(4), approvalId: 'missing' })).toThrow()
    expect(() => createTaskAllow(db, { ...allowInput(5), target: '' })).toThrow()
  })

  it('ends when the task is archived, not when it finishes, fails, is cancelled or Joy restarts', () => {
    const db = open()
    seed(db)
    allow(db, 1, 't1')
    setTaskStatus(db, 't1' as TaskId, 'running')
    interruptRunningWork(db)
    setTaskStatus(db, 't1' as TaskId, 'cancelled')
    expect(listTaskAllows(db, 't1' as TaskId)).toHaveLength(1)
    // A follow-up after the task finished keeps what the owner allowed.
    setTaskStatus(db, 't1' as TaskId, 'done')
    expect(listTaskAllows(db, 't1' as TaskId)).toHaveLength(1)
    setTaskStatus(db, 't1' as TaskId, 'review_ready')
    expect(listTaskAllows(db, 't1' as TaskId)).toHaveLength(1)
    updateTask(db, 't1' as TaskId, { archived: true })
    expect(listTaskAllows(db, 't1' as TaskId)).toHaveLength(0)

    allow(db, 3, 't2')
    updateTask(db, 't2' as TaskId, { title: 'renamed' })
    expect(listTaskAllows(db, 't2' as TaskId)).toHaveLength(1)
    updateTask(db, 't2' as TaskId, { archived: true })
    expect(listTaskAllows(db, 't2' as TaskId)).toHaveLength(0)
  })

  it('is still there after the database is opened again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-task-allows-'))
    dirs.push(dir)
    const path = join(dir, 'joy.sqlite')
    const first = open(path)
    seed(first)
    allow(first, 1, 't1')
    first.close()
    const second = open(path)
    expect(findTaskAllow(second, 't1' as TaskId, HASH_A)?.target).toBe('pnpm install')
  })

  it('goes with its task', () => {
    const db = open()
    seed(db)
    allow(db, 1, 't1')
    db.prepare("DELETE FROM attempts WHERE task_id = 't1'").run()
    db.prepare("DELETE FROM tasks WHERE id = 't1'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_allows').get()).toEqual({ n: 0 })
  })
})

function allowInput(n: number) {
  return {
    id: uuid(n),
    taskId: 't1' as TaskId,
    kind: 'shell' as const,
    fingerprint: HASH_A,
    target: 'x',
    approvalId: 'ap-t1',
  }
}
