import { afterEach, describe, expect, it } from 'vitest'
import type { RepoId, TaskId } from '@joy/core'
import {
  createConversation,
  getConversation,
  listConversations,
  setConversationPinned,
} from './conversations.js'
import { migrate, openDatabase } from './database.js'
import type { Database } from './database.js'
import { MIGRATIONS } from './migrations.js'
import { createRepo, createTask, getTask, listTasks, updateTask } from './repositories.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})
function fresh(migrations = MIGRATIONS) {
  const db = openDatabase(':memory:', { migrations })
  databases.push(db)
  return db
}

const tid = (id: string) => id as TaskId

function seed(db: Database) {
  const repo = createRepo(db, { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' })
  const task = createTask(db, {
    id: tid('t1'),
    repoId: repo.id,
    title: 'Fix bug',
    prompt: 'Fix it',
    mode: 'single',
    roleOverrides: {},
    planFirst: false,
    maxRounds: 4,
  })
  return task
}

describe('pinned tasks', () => {
  it('pins and unpins without moving updated_at, and keeps the first pin time', () => {
    const db = fresh()
    const task = seed(db)
    expect(task.pinnedAt).toBeUndefined()
    db.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z'").run()

    const pinned = updateTask(db, task.id, { pinned: true })
    expect(pinned?.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(pinned?.updatedAt).toBe('2020-01-01T00:00:00.000Z')

    db.prepare("UPDATE tasks SET pinned_at = '2021-01-01T00:00:00.000Z'").run()
    expect(updateTask(db, task.id, { pinned: true })?.pinnedAt).toBe('2021-01-01T00:00:00.000Z')

    const unpinned = updateTask(db, task.id, { pinned: false })
    expect(unpinned?.pinnedAt).toBeUndefined()
    expect(unpinned?.updatedAt).toBe('2020-01-01T00:00:00.000Z')
    expect(listTasks(db)[0]?.pinnedAt).toBeUndefined()
  })

  it('drops the pin when the task is archived and refuses to pin an archived task', () => {
    const db = fresh()
    const task = seed(db)
    updateTask(db, task.id, { pinned: true })
    expect(updateTask(db, task.id, { archived: true })).toMatchObject({ archived: true })
    expect(getTask(db, task.id)?.pinnedAt).toBeUndefined()

    expect(updateTask(db, task.id, { pinned: true })?.pinnedAt).toBeUndefined()
    // Restoring it does not bring the old pin back.
    expect(updateTask(db, task.id, { archived: false })?.pinnedAt).toBeUndefined()
    // Archived and pinned in one call: the archive wins.
    expect(updateTask(db, task.id, { archived: true, pinned: true })?.pinnedAt).toBeUndefined()
  })

  it('leaves tasks from before migration 24 unpinned, knows no task it was not given, and rejects an empty time', () => {
    const db = fresh(MIGRATIONS.filter((m) => m.version < 24))
    const task = seed(db)
    migrate(db, MIGRATIONS)
    expect(getTask(db, task.id)?.pinnedAt).toBeUndefined()
    expect(updateTask(db, tid('missing'), { pinned: true })).toBeUndefined()
    expect(() => db.prepare("UPDATE tasks SET pinned_at = ''").run()).toThrow()
  })
})

describe('pinned conversations', () => {
  it('pins and unpins without moving updated_at, and keeps the first pin time', () => {
    const db = fresh()
    createConversation(db, { id: 'c1', channel: 'web' })
    db.prepare("UPDATE conversations SET updated_at = '2020-01-01T00:00:00.000Z'").run()
    expect(getConversation(db, 'c1')?.pinnedAt).toBeUndefined()

    expect(setConversationPinned(db, 'c1', true)).toBe(true)
    const pinned = getConversation(db, 'c1')
    expect(pinned?.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(pinned?.updatedAt).toBe('2020-01-01T00:00:00.000Z')

    db.prepare("UPDATE conversations SET pinned_at = '2021-01-01T00:00:00.000Z'").run()
    setConversationPinned(db, 'c1', true)
    expect(getConversation(db, 'c1')?.pinnedAt).toBe('2021-01-01T00:00:00.000Z')

    expect(setConversationPinned(db, 'c1', false)).toBe(true)
    expect(getConversation(db, 'c1')?.pinnedAt).toBeUndefined()
    expect(listConversations(db)[0]?.pinnedAt).toBeUndefined()
  })

  it('says so when the conversation does not exist', () => {
    const db = fresh()
    expect(setConversationPinned(db, 'missing', true)).toBe(false)
    expect(setConversationPinned(db, 'missing', false)).toBe(false)
  })
})
