import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { Database } from '@joy/db'
import { getRepo } from '@joy/db'
import { getMemory, isSensitiveContent } from './storage.js'
import type { MemoryRecord, MemorySource } from './storage.js'

export const PROJECT_MEMORY_PATH = 'AGENTS.md'
const MAX_GUIDE_BYTES = 256_000
const MAX_PROPOSAL_BYTES = 300_000

export type ProjectMemoryProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'stale'
export type ProjectMemoryProposalDecision = 'approve' | 'reject'

export interface ProjectMemoryProvenance {
  memoryId: string
  scope: 'project'
  source: MemorySource
  createdAt: string
}

export interface ProjectMemoryProposal {
  id: string
  repoId: string
  relativePath: typeof PROJECT_MEMORY_PATH
  status: ProjectMemoryProposalStatus
  provenance: ProjectMemoryProvenance[]
  diff: string
  createdAt: string
  reviewedAt?: string
  appliedAt?: string
}

export interface CreateProjectMemoryProposalInput {
  repoId: string
  memoryIds: string[]
}

export type ApplyProjectMemoryProposalResult =
  | { status: 'applied'; proposal: ProjectMemoryProposal }
  | { status: 'approval_required' }
  | { status: 'not_found' }
  | { status: 'not_approved' }
  | { status: 'stale'; proposal: ProjectMemoryProposal }
  | { status: 'write_conflict' }

interface ProposalRow {
  id: string
  repo_id: string
  relative_path: string
  source_provenance: string
  base_content: string | null
  proposed_content: string
  status: ProjectMemoryProposalStatus
  created_at: string
  reviewed_at: string | null
  applied_at: string | null
}

/** Creates a pending, reviewable AGENTS.md diff from existing trusted project memories. */
export async function createProjectMemoryProposal(
  db: Database,
  input: CreateProjectMemoryProposalInput,
): Promise<ProjectMemoryProposal> {
  if (
    !input.memoryIds.length ||
    input.memoryIds.length > 20 ||
    new Set(input.memoryIds).size !== input.memoryIds.length
  ) {
    throw new Error('Choose between 1 and 20 distinct project memories')
  }
  const repo = getRepo(db, input.repoId as Parameters<typeof getRepo>[1])
  if (!repo) throw new Error('Project repository was not found')

  const memories = input.memoryIds.map((id) => {
    const memory = getMemory(db, id)
    if (!memory || memory.scope !== 'project' || memory.repoId !== repo.id) {
      throw new Error('Every selected memory must be active project memory for this repository')
    }
    if (!memory.content.trim() || isSensitiveContent(memory.content)) {
      throw new Error('Project memory contains unsafe content')
    }
    return memory
  })

  const root = await resolveRepositoryRoot(repo.path)
  const baseContent = await readGuide(root)
  const proposedContent = appendProjectMemories(baseContent, memories)
  if (Buffer.byteLength(proposedContent, 'utf8') > MAX_PROPOSAL_BYTES) {
    throw new Error('The proposed AGENTS.md content is too large')
  }

  const id = randomUUID()
  db.prepare(
    `INSERT INTO project_memory_proposals
       (id, repo_id, relative_path, source_provenance, base_content, proposed_content)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    repo.id,
    PROJECT_MEMORY_PATH,
    JSON.stringify(memories.map(toProvenance)),
    baseContent,
    proposedContent,
  )
  const proposal = getProjectMemoryProposal(db, id)
  if (!proposal) throw new Error(`Project memory proposal ${id} was not found after insert`)
  return proposal
}

/** Lists proposals for one repository; returned diffs are safe to present for review. */
export function listProjectMemoryProposals(db: Database, repoId: string): ProjectMemoryProposal[] {
  const rows = db
    .prepare('SELECT * FROM project_memory_proposals WHERE repo_id = ? ORDER BY created_at, id')
    .all(repoId) as unknown as ProposalRow[]
  return rows.map(mapProposal)
}

/** Reads a proposal without changing its review state or the repository. */
export function getProjectMemoryProposal(db: Database, id: string): ProjectMemoryProposal | undefined {
  const row = db.prepare('SELECT * FROM project_memory_proposals WHERE id = ?').get(id) as
    ProposalRow | undefined
  return row ? mapProposal(row) : undefined
}

/** Records an explicit user review. A proposal is never approved by creation or by reading its diff. */
export function reviewProjectMemoryProposal(
  db: Database,
  id: string,
  decision: ProjectMemoryProposalDecision,
  userApproved: boolean,
): ProjectMemoryProposal | undefined {
  if (userApproved !== true) return undefined
  const result = db
    .prepare(
      `UPDATE project_memory_proposals
       SET status = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(decision === 'approve' ? 'approved' : 'rejected', id)
  return Number(result.changes) === 1 ? getProjectMemoryProposal(db, id) : undefined
}

/** Writes only after a separate explicit confirmation, and only if the reviewed file is unchanged. */
export async function applyProjectMemoryProposal(
  db: Database,
  id: string,
  userApproved: boolean,
): Promise<ApplyProjectMemoryProposalResult> {
  if (userApproved !== true) return { status: 'approval_required' }
  const row = db.prepare('SELECT * FROM project_memory_proposals WHERE id = ?').get(id) as
    ProposalRow | undefined
  if (!row) return { status: 'not_found' }
  if (row.status !== 'approved') return { status: 'not_approved' }
  if (row.relative_path !== PROJECT_MEMORY_PATH) return { status: 'stale', proposal: mapProposal(row) }
  if (Buffer.byteLength(row.proposed_content, 'utf8') > MAX_PROPOSAL_BYTES) {
    return { status: 'stale', proposal: mapProposal(row) }
  }

  const repo = getRepo(db, row.repo_id as Parameters<typeof getRepo>[1])
  if (!repo) return { status: 'not_found' }
  const root = await resolveRepositoryRoot(repo.path)
  const target = resolveTarget(root, row.relative_path)
  const lockPath = join(root, '.joy-project-memory.lock')
  let lock: Awaited<ReturnType<typeof open>> | undefined
  let tempPath: string | undefined
  try {
    try {
      lock = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) return { status: 'write_conflict' }
      throw error
    }

    const latest = db.prepare('SELECT * FROM project_memory_proposals WHERE id = ?').get(id) as
      ProposalRow | undefined
    if (!latest) return { status: 'not_found' }
    if (latest.status !== 'approved') return { status: 'not_approved' }
    if (latest.relative_path !== PROJECT_MEMORY_PATH) return markStale(db, id)

    const current = await readGuide(root)
    if (current !== latest.base_content) return markStale(db, id)
    const mode = await targetMode(target)
    tempPath = join(root, `.AGENTS.md.joy-${randomUUID()}.tmp`)
    const temp = await open(tempPath, 'wx', mode)
    try {
      await temp.writeFile(latest.proposed_content, 'utf8')
      await temp.sync()
    } finally {
      await temp.close()
    }

    // Recheck immediately before rename so an intervening edit is never silently overwritten.
    if ((await realpath(repo.path)) !== root || (await readGuide(root)) !== latest.base_content) {
      return markStale(db, id)
    }
    await rename(tempPath, target)
    tempPath = undefined
    const result = db
      .prepare(
        `UPDATE project_memory_proposals
         SET status = 'applied', applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'approved'`,
      )
      .run(id)
    if (Number(result.changes) !== 1) throw new Error('Proposal state changed while applying the update')
    const proposal = getProjectMemoryProposal(db, id)
    if (!proposal) throw new Error(`Project memory proposal ${id} disappeared after apply`)
    return { status: 'applied', proposal }
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined)
    if (lock) {
      await lock.close()
      await unlink(lockPath).catch(() => undefined)
    }
  }
}

function markStale(db: Database, id: string): ApplyProjectMemoryProposalResult {
  db.prepare(
    `UPDATE project_memory_proposals SET status = 'stale'
     WHERE id = ? AND status = 'approved'`,
  ).run(id)
  const proposal = getProjectMemoryProposal(db, id)
  return proposal ? { status: 'stale', proposal } : { status: 'not_found' }
}

function toProvenance(memory: MemoryRecord): ProjectMemoryProvenance {
  return {
    memoryId: memory.id,
    scope: 'project',
    source: memory.source,
    createdAt: memory.createdAt,
  }
}

function mapProposal(row: ProposalRow): ProjectMemoryProposal {
  const provenance = JSON.parse(row.source_provenance) as ProjectMemoryProvenance[]
  return {
    id: row.id,
    repoId: row.repo_id,
    relativePath: PROJECT_MEMORY_PATH,
    status: row.status,
    provenance,
    diff: makeAppendDiff(row.base_content, row.proposed_content),
    createdAt: row.created_at,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
  }
}

async function resolveRepositoryRoot(repoPath: string): Promise<string> {
  if (!isAbsolute(repoPath)) throw new Error('Project repository path must be absolute')
  const root = await realpath(repoPath)
  if (!(await stat(root)).isDirectory()) throw new Error('Project repository path must be a directory')
  return root
}

function resolveTarget(root: string, relativePath: string): string {
  if (relativePath !== PROJECT_MEMORY_PATH) throw new Error('Only repository-root AGENTS.md may be updated')
  const target = join(root, PROJECT_MEMORY_PATH)
  if (relative(root, target) !== PROJECT_MEMORY_PATH)
    throw new Error('Project memory path escaped the repository')
  return target
}

async function readGuide(root: string): Promise<string | null> {
  const target = resolveTarget(root, PROJECT_MEMORY_PATH)
  let info
  try {
    info = await lstat(target)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('Repository-root AGENTS.md must be a regular file, not a symlink')
  }
  const canonical = await realpath(target)
  if (canonical !== target) throw new Error('AGENTS.md must resolve inside the repository root')
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const file = await open(target, constants.O_RDONLY | noFollow)
  try {
    const opened = await file.stat()
    if (!opened.isFile()) throw new Error('Repository-root AGENTS.md must be a regular file')
    if (opened.size > MAX_GUIDE_BYTES) throw new Error('AGENTS.md is too large to propose safely')
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

async function targetMode(target: string): Promise<number> {
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Repository-root AGENTS.md must be a regular file, not a symlink')
    }
    return info.mode & 0o777
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 0o644
    throw error
  }
}

function appendProjectMemories(baseContent: string | null, memories: MemoryRecord[]): string {
  const eol = baseContent?.includes('\r\n') ? '\r\n' : '\n'
  const bullets = memories.map(({ content }) => `- ${content.trim().replace(/\s+/gu, ' ')}`)
  if (baseContent === null || baseContent.length === 0) {
    return [`## Project memory`, '', ...bullets, ''].join(eol)
  }

  const lines = baseContent.split(/\r?\n/u)
  if (baseContent.endsWith(eol)) lines.pop()
  const headingIndexes = lines.flatMap((line, index) => (line === '## Project memory' ? [index] : []))
  if (headingIndexes.length > 1) throw new Error('AGENTS.md has multiple Project memory sections')
  const headingIndex = headingIndexes[0]
  if (headingIndex !== undefined) {
    if (lines.slice(headingIndex + 1).some((line) => /^#{1,6}\s/u.test(line))) {
      throw new Error('Project memory must be the final AGENTS.md section')
    }
    const existing = new Set(lines.slice(headingIndex + 1).map((line) => line.trim()))
    const additions = bullets.filter((bullet) => !existing.has(bullet))
    if (additions.length === 0)
      throw new Error('The selected project memory is already proposed in AGENTS.md')
    return `${baseContent}${baseContent.endsWith(eol) ? '' : eol}${additions.join(eol)}${eol}`
  }

  const separator = baseContent.endsWith(eol) ? eol : `${eol}${eol}`
  return `${baseContent}${separator}## Project memory${eol}${eol}${bullets.join(eol)}${eol}`
}

function makeAppendDiff(baseContent: string | null, proposedContent: string): string {
  const oldLines = diffLines(baseContent ?? '')
  const newLines = diffLines(proposedContent)
  let prefix = 0
  while (prefix < oldLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  const context = oldLines.slice(Math.max(0, prefix - 3), prefix)
  const additions = newLines.slice(prefix)
  const oldStart = oldLines.length === 0 ? 0 : oldLines.length - context.length + 1
  const newStart = oldLines.length === 0 ? 1 : oldStart
  const oldRange = oldLines.length === 0 ? '0,0' : `${oldStart},${context.length}`
  const newRange = `${newStart},${context.length + additions.length}`
  return [
    `--- ${baseContent === null ? '/dev/null' : `a/${PROJECT_MEMORY_PATH}`}`,
    `+++ b/${PROJECT_MEMORY_PATH}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...context.map((line) => ` ${line}`),
    ...additions.map((line) => `+${line}`),
    '',
  ].join('\n')
}

function diffLines(content: string): string[] {
  const lines = content.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
