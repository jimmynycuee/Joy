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
  /** The assistant conversation the file was sent in (instead of a task). */
  conversationId?: string
  /**
   * The user.message the file came with (the messages row id for a conversation); absent for the task's first prompt
   * (or while not used yet).
   */
  messageId?: string
  /** The owner removed it after sending; its bytes are gone and agents only get its name. */
  disabled: boolean
  createdAt: string
}

interface Row {
  id: string
  name: string
  media_type: AttachmentMediaType
  size: number
  task_id: string | null
  conversation_id: string | null
  message_id: string | null
  disabled: number
  created_at: string
}

function toRecord(row: Row): AttachmentRecord {
  return {
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    ...(row.task_id ? { taskId: row.task_id as TaskId } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    disabled: row.disabled === 1,
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
  return link(db, ids, 'task_id', taskId, messageId)
}

/** Links uploads that no message used yet to one message of an assistant conversation. All or nothing. */
export function linkConversationAttachments(
  db: Database,
  ids: readonly string[],
  conversationId: string,
  messageId: number,
): boolean {
  return link(db, ids, 'conversation_id', conversationId, String(messageId))
}

/** A conversation's attachments in upload order. */
export function listConversationAttachments(db: Database, conversationId: string): AttachmentRecord[] {
  return (
    db
      .prepare('SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at, rowid')
      .all(conversationId) as unknown as Row[]
  ).map(toRecord)
}

/** Not used by any message yet: neither a task's nor a conversation's. */
const UNUSED = 'task_id IS NULL AND conversation_id IS NULL'

function link(
  db: Database,
  ids: readonly string[],
  column: 'task_id' | 'conversation_id',
  owner: string,
  messageId: string | undefined,
): boolean {
  if (!ids.length) return true
  db.exec('BEGIN')
  try {
    const update = db.prepare(
      `UPDATE attachments SET ${column} = ?, message_id = ? WHERE id = ? AND ${UNUSED}`,
    )
    for (const id of ids) {
      if (Number(update.run(owner, messageId ?? null, id).changes) !== 1) {
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
    .prepare(`SELECT * FROM attachments WHERE ${UNUSED} AND created_at < ?`)
    .all(before) as unknown as Row[]
  db.prepare(`DELETE FROM attachments WHERE ${UNUSED} AND created_at < ?`).run(before)
  return rows.map(toRecord)
}

/** Removes one upload no message used. False when it is unknown or already sent. */
export function deleteUnusedAttachment(db: Database, id: string): boolean {
  return Number(db.prepare(`DELETE FROM attachments WHERE id = ? AND ${UNUSED}`).run(id).changes) === 1
}

/** Marks a sent attachment as removed by the owner. False when it is unknown or not sent. */
export function disableAttachment(db: Database, id: string): boolean {
  return (
    Number(
      db.prepare(`UPDATE attachments SET disabled = 1 WHERE id = ? AND NOT (${UNUSED})`).run(id).changes,
    ) === 1
  )
}

/** Ids whose bytes Joy keeps, for removing files no row needs any more (removed attachments included). */
export function listAttachmentIds(db: Database): Set<string> {
  return new Set(
    (db.prepare('SELECT id FROM attachments WHERE disabled = 0').all() as Array<{ id: string }>).map(
      (row) => row.id,
    ),
  )
}
