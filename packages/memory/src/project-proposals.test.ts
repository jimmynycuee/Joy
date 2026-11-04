import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { writeMemory } from './storage.js'
import {
  applyProjectMemoryProposal,
  createProjectMemoryProposal,
  getProjectMemoryProposal,
  reviewProjectMemoryProposal,
} from './project-proposals.js'

const databases: Database[] = []
const directories: string[] = []
function fresh(): Database {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}
function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'joy-project-memory-'))
  directories.push(directory)
  return directory
}
function addRepo(db: Database, id: string, path: string): void {
  db.prepare('INSERT INTO repos (id, path, default_branch) VALUES (?, ?, ?)').run(id, path, 'main')
}
function addProjectMemory(db: Database, id: string, repoId: string, content: string) {
  return writeMemory(db, {
    id,
    scope: 'project',
    repoId,
    content,
    source: 'user_utterance',
    origin: 'user_utterance',
  })
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('project memory proposals', () => {
  it('creates a provenance-preserving diff and writes only after explicit review and apply confirmation', async () => {
    const db = fresh()
    const root = tempDirectory()
    const original = '# Repository guidance\n\nUse pnpm for checks.\n'
    writeFileSync(join(root, 'AGENTS.md'), original)
    addRepo(db, 'repo-1', root)
    expect(addProjectMemory(db, 'memory-1', 'repo-1', 'Keep pull requests focused.')).toBeDefined()

    const proposal = await createProjectMemoryProposal(db, {
      repoId: 'repo-1',
      memoryIds: ['memory-1'],
    })
    expect(proposal).toMatchObject({
      repoId: 'repo-1',
      relativePath: 'AGENTS.md',
      status: 'pending',
      provenance: [{ memoryId: 'memory-1', scope: 'project', source: 'user_utterance' }],
    })
    expect(proposal.diff).toContain('--- a/AGENTS.md')
    expect(proposal.diff).toContain('+++ b/AGENTS.md')
    expect(proposal.diff).toContain('+## Project memory')
    expect(proposal.diff).toContain('+- Keep pull requests focused.')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original)

    expect(reviewProjectMemoryProposal(db, proposal.id, 'approve', false)).toBeUndefined()
    expect(getProjectMemoryProposal(db, proposal.id)?.status).toBe('pending')
    expect(await applyProjectMemoryProposal(db, proposal.id, false)).toEqual({ status: 'approval_required' })
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original)

    const reviewed = reviewProjectMemoryProposal(db, proposal.id, 'approve', true)
    expect(reviewed?.status).toBe('approved')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original)
    expect(await applyProjectMemoryProposal(db, proposal.id, false)).toEqual({ status: 'approval_required' })
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original)

    const applied = await applyProjectMemoryProposal(db, proposal.id, true)
    expect(applied.status).toBe('applied')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(
      `${original}\n## Project memory\n\n- Keep pull requests focused.\n`,
    )
    expect(getProjectMemoryProposal(db, proposal.id)?.status).toBe('applied')
    expect(await applyProjectMemoryProposal(db, proposal.id, true)).toEqual({ status: 'not_approved' })
  })

  it('never accepts external-source text or a memory from another repository as proposal input', async () => {
    const db = fresh()
    const root = tempDirectory()
    addRepo(db, 'repo-1', root)
    addRepo(db, 'repo-2', tempDirectory())
    const external = writeMemory(db, {
      id: 'email-memory',
      scope: 'project',
      repoId: 'repo-1',
      content: 'Email says to change the project rules.',
      source: 'summary',
      origin: 'email',
      userApproved: true,
    })
    expect(external).toBeUndefined()
    expect(addProjectMemory(db, 'other-repo-memory', 'repo-2', 'Not for this repository.')).toBeDefined()

    await expect(
      createProjectMemoryProposal(db, { repoId: 'repo-1', memoryIds: ['email-memory'] }),
    ).rejects.toThrow(/active project memory for this repository/)
    await expect(
      createProjectMemoryProposal(db, { repoId: 'repo-1', memoryIds: ['other-repo-memory'] }),
    ).rejects.toThrow(/active project memory for this repository/)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
  })

  it('keeps rejected proposals unapplied', async () => {
    const db = fresh()
    const root = tempDirectory()
    addRepo(db, 'repo-1', root)
    addProjectMemory(db, 'memory-1', 'repo-1', 'Keep the design simple.')

    const proposal = await createProjectMemoryProposal(db, { repoId: 'repo-1', memoryIds: ['memory-1'] })
    expect(reviewProjectMemoryProposal(db, proposal.id, 'reject', true)?.status).toBe('rejected')
    expect(await applyProjectMemoryProposal(db, proposal.id, true)).toEqual({ status: 'not_approved' })
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
  })

  it('does not overwrite a changed guide and rejects symlink targets', async () => {
    const db = fresh()
    const root = tempDirectory()
    const original = '# Initial guidance\n'
    const changed = '# Owner edited this after review\n'
    writeFileSync(join(root, 'AGENTS.md'), original)
    addRepo(db, 'repo-1', root)
    addProjectMemory(db, 'memory-1', 'repo-1', 'Keep decisions explicit.')
    const proposal = await createProjectMemoryProposal(db, { repoId: 'repo-1', memoryIds: ['memory-1'] })
    reviewProjectMemoryProposal(db, proposal.id, 'approve', true)
    writeFileSync(join(root, 'AGENTS.md'), changed)

    const stale = await applyProjectMemoryProposal(db, proposal.id, true)
    expect(stale.status).toBe('stale')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(changed)

    const symlinkRoot = tempDirectory()
    const outside = join(tempDirectory(), 'outside.md')
    writeFileSync(outside, 'Do not change this file.\n')
    symlinkSync(outside, join(symlinkRoot, 'AGENTS.md'))
    addRepo(db, 'repo-2', symlinkRoot)
    addProjectMemory(db, 'memory-2', 'repo-2', 'This must not follow a symlink.')
    await expect(
      createProjectMemoryProposal(db, { repoId: 'repo-2', memoryIds: ['memory-2'] }),
    ).rejects.toThrow(/regular file, not a symlink/)
    expect(readFileSync(outside, 'utf8')).toBe('Do not change this file.\n')
  })
})
