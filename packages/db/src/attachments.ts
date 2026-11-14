import type { TaskId } from '@joy/core'
import type { Database } from './database.js'

export const ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
] as const
export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number]

/** What Joy knows about an attached file; the bytes are stored by the server, outside the database. */
export interface AttachmentRecord {
  id: string
  name: string
  mediaType: AttachmentMediaType
  size: number
  taskId?: TaskId
  /** The user.message the file came with; absent for the task's first prompt (or while not used yet). */
  messageId?: string
  createdAt: string
}

interface Row {
  id: string
  name: string
  media_type: AttachmentMediaType
  size: number
  task_id: string | null
  message_id: string | null
  created_at: string
}

function toRecord(row: Row): AttachmentRecord {
  return {
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    ...(row.task_id ? { taskId: row.task_id as TaskId } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    createdAt: row.created_at,
  }
}

export function createAttachment(
  db: Database,
  input: { id: string; name: string; mediaType: AttachmentMediaType; size: number },
): AttachmentRecord {
  db.prepare('INSERT INTO attachments (id, name, media_type, size) VALUES (?, ?, ?, ?)').run(
    input.id,
    input.name,
    input.mediaType,
    input.size,
  )
  const created = getAttachment(db, input.id)
  if (!created) throw new Error(`Attachment ${input.id} was not saved`)
  return created
}

export function getAttachment(db: Database, id: string): AttachmentRecord | undefined {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Row | undefined
  return row ? toRecord(row) : undefined
}

/** A task's attachments in upload order (first prompt and every message). */
export function listTaskAttachments(db: Database, taskId: TaskId): AttachmentRecord[] {
  return (
    db
      .prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as unknown as Row[]
  ).map(toRecord)
}

/**
 * Links uploads that no message used yet to a task (and a message). All or nothing: false, and nothing changes, when
 * any id is unknown or already used.
 */
export function linkAttachments(
  db: Database,
  ids: readonly string[],
  taskId: TaskId,
  messageId?: string,
): boolean {
  if (!ids.length) return true
  db.exec('BEGIN')
  try {
    const update = db.prepare(
      'UPDATE attachments SET task_id = ?, message_id = ? WHERE id = ? AND task_id IS NULL',
    )
    for (const id of ids) {
      if (Number(update.run(taskId, messageId ?? null, id).changes) !== 1) {
        db.exec('ROLLBACK')
        return false
      }
    }
    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Uploads no message used, created before `before` (ISO time); deleted rows are returned so their files can go too. */
export function deleteUnusedAttachments(db: Database, before: string): AttachmentRecord[] {
  const rows = db
    .prepare('SELECT * FROM attachments WHERE task_id IS NULL AND created_at < ?')
    .all(before) as unknown as Row[]
  db.prepare('DELETE FROM attachments WHERE task_id IS NULL AND created_at < ?').run(before)
  return rows.map(toRecord)
}

/** Removes one upload no message used. False when it is unknown or already sent. */
export function deleteUnusedAttachment(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM attachments WHERE id = ? AND task_id IS NULL').run(id).changes) === 1
}

/** Every attachment id Joy knows, for removing files no row points to any more. */
export function listAttachmentIds(db: Database): Set<string> {
  return new Set(
    (db.prepare('SELECT id FROM attachments').all() as Array<{ id: string }>).map((row) => row.id),
  )
}
