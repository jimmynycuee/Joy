import type { RepoId } from '@joy/core'
import type { Database } from './database.js'

export type ProjectNoteStatus = 'pending' | 'applied' | 'rejected' | 'conflict'

export interface ProjectNoteRecord {
  id: string
  repoId: RepoId
  note: string
  /** SHA-256 of AGENTS.md when the note was proposed; absent when the file did not exist. */
  baseSha256?: string
  /** The whole file as it will be after the note is applied. */
  proposed: string
  conversationId?: string
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
  status: ProjectNoteStatus
  created_at: string
  decided_at: string | null
}

export function createProjectNote(
  db: Database,
  input: Omit<ProjectNoteRecord, 'status' | 'createdAt' | 'decidedAt'>,
): ProjectNoteRecord {
  db.prepare(
    `INSERT INTO project_notes (id, repo_id, note, base_sha256, proposed, conversation_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.repoId,
    input.note,
    input.baseSha256 ?? null,
    input.proposed,
    input.conversationId ?? null,
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
    status: row.status,
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  }
}
