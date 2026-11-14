import { afterEach, describe, expect, it } from 'vitest'
import type { RepoId, TaskId } from '@joy/core'
import {
  createAttachment,
  deleteUnusedAttachments,
  disableAttachment,
  getAttachment,
  linkAttachments,
  listAttachmentIds,
  listTaskAttachments,
} from './attachments.js'
import { openDatabase } from './database.js'
import type { Database } from './database.js'
import { createRepo, createTask } from './repositories.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
let db: Database

function seed(): TaskId {
  db = openDatabase(':memory:')
  createRepo(db, { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' })
  return createTask(db, {
    id: 't1' as TaskId,
    repoId: 'r1' as RepoId,
    title: 'T',
    prompt: 'P',
    mode: 'single',
  }).id
}

afterEach(() => db.close())

describe('attachments', () => {
  it('stores metadata and links uploads to a task and a message', () => {
    const task = seed()
    createAttachment(db, { id: A, name: 'shot.png', mediaType: 'image/png', size: 10 })
    createAttachment(db, { id: B, name: 'notes.txt', mediaType: 'text/plain', size: 4 })
    expect(getAttachment(db, A)).toMatchObject({ id: A, name: 'shot.png', mediaType: 'image/png', size: 10 })
    expect(getAttachment(db, A)?.taskId).toBeUndefined()
    expect(linkAttachments(db, [A], task)).toBe(true)
    expect(linkAttachments(db, [B], task, 'm1')).toBe(true)
    expect(listTaskAttachments(db, task).map((a) => [a.id, a.messageId])).toEqual([
      [A, undefined],
      [B, 'm1'],
    ])
  })

  it('links all or nothing, and an upload is used once', () => {
    const task = seed()
    createAttachment(db, { id: A, name: 'a.png', mediaType: 'image/png', size: 1 })
    createAttachment(db, { id: B, name: 'b.png', mediaType: 'image/png', size: 1 })
    expect(linkAttachments(db, [A], task)).toBe(true)
    // A is already used: B must not be linked either.
    expect(linkAttachments(db, [B, A], task, 'm2')).toBe(false)
    expect(getAttachment(db, B)?.taskId).toBeUndefined()
    expect(linkAttachments(db, [C], task)).toBe(false)
  })

  it('rejects unknown media types and empty files', () => {
    seed()
    expect(() =>
      createAttachment(db, { id: A, name: 'x', mediaType: 'application/pdf' as never, size: 1 }),
    ).toThrow()
    expect(() => createAttachment(db, { id: A, name: 'x', mediaType: 'image/png', size: 0 })).toThrow()
  })

  it('deletes old unused uploads only', () => {
    const task = seed()
    createAttachment(db, { id: A, name: 'a.png', mediaType: 'image/png', size: 1 })
    createAttachment(db, { id: B, name: 'b.png', mediaType: 'image/png', size: 1 })
    linkAttachments(db, [B], task)
    expect(deleteUnusedAttachments(db, '2000-01-01T00:00:00.000Z')).toEqual([])
    expect(deleteUnusedAttachments(db, '2999-01-01T00:00:00.000Z').map((a) => a.id)).toEqual([A])
    expect([...listAttachmentIds(db)]).toEqual([B])
  })

  it('marks only sent attachments as removed, and stops keeping their bytes', () => {
    const task = seed()
    createAttachment(db, { id: A, name: 'a.png', mediaType: 'image/png', size: 1 })
    createAttachment(db, { id: B, name: 'b.png', mediaType: 'image/png', size: 1 })
    linkAttachments(db, [A], task)
    expect(getAttachment(db, A)?.disabled).toBe(false)
    expect(disableAttachment(db, B)).toBe(false)
    expect(disableAttachment(db, A)).toBe(true)
    expect(getAttachment(db, A)?.disabled).toBe(true)
    expect([...listAttachmentIds(db)]).toEqual([B])
  })

  it('goes away with its task', () => {
    const task = seed()
    createAttachment(db, { id: A, name: 'a.png', mediaType: 'image/png', size: 1 })
    linkAttachments(db, [A], task)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task)
    expect(getAttachment(db, A)).toBeUndefined()
  })
})
