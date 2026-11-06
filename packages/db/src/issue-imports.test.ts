import { afterEach, describe, expect, it } from 'vitest'
import type { RepoId, TaskId } from '@joy/core'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import { claimIssueImport, getIssueImport, releaseIssueImport, setIssueImportTask } from './issue-imports.js'
import { createRepo, createTask } from './repositories.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

describe('issue imports', () => {
  it('imports an issue once, and releases a failed claim', () => {
    const db = openDatabase(':memory:')
    databases.push(db)
    const repo = 'r' as RepoId
    createRepo(db, { id: repo, path: '/r', defaultBranch: 'main' })
    expect(claimIssueImport(db, repo, 7, 'label')).toBe(true)
    expect(claimIssueImport(db, repo, 7, 'assistant-command')).toBe(false)
    releaseIssueImport(db, repo, 7)
    expect(claimIssueImport(db, repo, 7, 'assistant-command')).toBe(true)
    createTask(db, { id: 't' as TaskId, repoId: repo, title: 't', prompt: 'p', mode: 'single' })
    setIssueImportTask(db, repo, 7, 't' as TaskId)
    releaseIssueImport(db, repo, 7)
    expect(getIssueImport(db, repo, 7)).toMatchObject({ taskId: 't', trigger: 'assistant-command' })
    expect(() => claimIssueImport(db, repo, 0, 'label')).toThrow(/CHECK/)
  })
})
