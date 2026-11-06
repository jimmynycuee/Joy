import { afterEach, describe, expect, it } from 'vitest'
import type { RepoId } from '@joy/core'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import { createProjectNote, decideProjectNote, getProjectNote, listProjectNotes } from './project-notes.js'
import { createRepo } from './repositories.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

describe('project notes', () => {
  it('stores a proposal and decides it only once', () => {
    const db = openDatabase(':memory:')
    databases.push(db)
    createRepo(db, { id: 'r1' as RepoId, path: '/r', defaultBranch: 'main' })
    createProjectNote(db, { id: 'n1', repoId: 'r1' as RepoId, note: 'Use pnpm', proposed: '- Use pnpm\n' })
    expect(getProjectNote(db, 'n1')).toMatchObject({ status: 'pending', note: 'Use pnpm' })
    expect(getProjectNote(db, 'n1')).not.toHaveProperty('baseSha256')
    expect(listProjectNotes(db, 'pending').map((n) => n.id)).toEqual(['n1'])
    expect(decideProjectNote(db, 'n1', 'applied')).toBe(true)
    expect(decideProjectNote(db, 'n1', 'rejected')).toBe(false)
    expect(getProjectNote(db, 'n1')).toMatchObject({ status: 'applied', decidedAt: expect.any(String) })
    expect(listProjectNotes(db, 'pending')).toEqual([])
    expect(() => db.prepare("UPDATE project_notes SET status = 'maybe'").run()).toThrow()
  })
})
