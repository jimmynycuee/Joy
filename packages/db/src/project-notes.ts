import type { RepoId } from '@joy/core'
import type { Database } from './database.js'

export type ProjectNoteStatus = 'pending' | 'applied' | 'rejected' | 'conflict'
/** `assistant`: the owner asked in a conversation; `review_findings`: reviewers kept finding the same thing. */
export type ProjectNoteSource = 'assistant' | 'review_findings'

export interface ProjectNoteRecord {
  id: string
  repoId: RepoId
  note: string
  /** SHA-256 of AGENTS.md when the note was proposed; absent when the file did not exist. */
  baseSha256?: string
  /** The whole file as it will be after the note is applied. */
  proposed: string
  conversationId?: string
  source: ProjectNoteSource
  /** For `review_findings`: the ids of the reviews whose findings it is drawn from. */
  evidence?: string[]
  status: ProjectNoteStatus
  createdAt: string
  decidedAt?: string
}

interface ProjectNoteRow {
  id: string
  repo_id: string
  note: string
  base_sha256: string | null
  proposed: string
  conversation_id: string | null
  source: ProjectNoteSource
  evidence: string | null
  status: ProjectNoteStatus
  created_at: string
  decided_at: string | null
}

export function createProjectNote(
  db: Database,
  input: Omit<ProjectNoteRecord, 'status' | 'createdAt' | 'decidedAt' | 'source'> & {
    source?: ProjectNoteSource
  },
): ProjectNoteRecord {
  db.prepare(
    `INSERT INTO project_notes (id, repo_id, note, base_sha256, proposed, conversation_id, source, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.repoId,
    input.note,
    input.baseSha256 ?? null,
    input.proposed,
    input.conversationId ?? null,
    input.source ?? 'assistant',
    input.evidence ? JSON.stringify(input.evidence) : null,
  )
  const created = getProjectNote(db, input.id)
  if (!created) throw new Error(`Project note ${input.id} was not found after insert`)
  return created
}

export function getProjectNote(db: Database, id: string): ProjectNoteRecord | undefined {
  const row = db.prepare('SELECT * FROM project_notes WHERE id = ?').get(id) as unknown as
    ProjectNoteRow | undefined
  return row ? map(row) : undefined
}

export function listProjectNotes(db: Database, status?: ProjectNoteStatus): ProjectNoteRecord[] {
  const rows = status
    ? db.prepare('SELECT * FROM project_notes WHERE status = ? ORDER BY created_at DESC, id').all(status)
    : db.prepare('SELECT * FROM project_notes ORDER BY created_at DESC, id').all()
  return (rows as unknown as ProjectNoteRow[]).map(map)
}

/** Moves a pending proposal to its outcome. Returns false when it was not pending (already decided). */
export function decideProjectNote(
  db: Database,
  id: string,
  status: Exclude<ProjectNoteStatus, 'pending'>,
): boolean {
  return (
    Number(
      db
        .prepare(
          `UPDATE project_notes SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND status = 'pending'`,
        )
        .run(status, id).changes,
    ) === 1
  )
}

function map(row: ProjectNoteRow): ProjectNoteRecord {
  return {
    id: row.id,
    repoId: row.repo_id as RepoId,
    note: row.note,
    ...(row.base_sha256 ? { baseSha256: row.base_sha256 } : {}),
    proposed: row.proposed,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    source: row.source,
    ...(row.evidence ? { evidence: JSON.parse(row.evidence) as string[] } : {}),
    status: row.status,
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  }
}

/** Every proposal for a repository, whatever its status (to avoid proposing the same note twice). */
export function listRepoProjectNotes(db: Database, repoId: RepoId): ProjectNoteRecord[] {
  return (
    db
      .prepare('SELECT * FROM project_notes WHERE repo_id = ? ORDER BY created_at DESC, id')
      .all(repoId) as unknown as ProjectNoteRow[]
  ).map(map)
}

export interface RepoFinding {
  reviewId: string
  taskId: string
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  message: string
  file?: string
  createdAt: string
}

/**
 * Review findings of a repository's tasks, newest first, leaving out tasks that came from outside content (an issue,
 * a web page): their findings may echo text someone else wrote, and must not turn into project rules.
 */
export function listRepoFindings(db: Database, repoId: RepoId, limit = 200): RepoFinding[] {
  const rows = db
    .prepare(
      `SELECT r.id AS review_id, t.id AS task_id, r.findings AS findings, r.created_at AS created_at
       FROM reviews r JOIN attempts a ON a.id = r.attempt_id JOIN tasks t ON t.id = a.task_id
       WHERE t.repo_id = ? AND t.provenance <> 'external_content'
       ORDER BY r.created_at DESC, r.id LIMIT ?`,
    )
    .all(repoId, limit) as unknown as Array<{
    review_id: string
    task_id: string
    findings: string
    created_at: string
  }>
  const out: RepoFinding[] = []
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.findings)
    } catch {
      continue
    }
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const f = item as Record<string, unknown>
      if (
        typeof f.message !== 'string' ||
        !['blocker', 'major', 'minor', 'nit'].includes(f.severity as string)
      )
        continue
      out.push({
        reviewId: row.review_id,
        taskId: row.task_id,
        severity: f.severity as RepoFinding['severity'],
        message: f.message,
        ...(typeof f.file === 'string' && f.file ? { file: f.file } : {}),
        createdAt: row.created_at,
      })
    }
  }
  return out
}
