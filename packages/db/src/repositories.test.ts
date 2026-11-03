import { afterEach, describe, expect, it } from 'vitest'
import type { AttemptId, RepoId, TaskId } from '@joy/core'
import { openDatabase } from './database.js'
import type { Database } from './database.js'
import {
  createAttempt,
  createRepo,
  createTask,
  getAttempt,
  getRepo,
  getTask,
  interruptRunningWork,
  latestAttempt,
  listAttempts,
  listRepos,
  listTasks,
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
