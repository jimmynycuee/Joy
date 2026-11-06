import type { ProviderKind } from '@joy/core'
import type { Database } from './database.js'

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export interface ConversationRecord {
  id: string
  channel: string
  title?: string
  brainProvider?: ProviderKind
  brainModel?: string
  sessionId?: string
  createdAt: string
  updatedAt?: string
}

export interface MessageRecord {
  id: number
  conversationId: string
  role: MessageRole
  content: string
  ts: string
}

interface ConversationRow {
  id: string
  channel: string
  title: string | null
  brain_provider: string | null
  brain_model: string | null
  session_id: string | null
  created_at: string
  updated_at: string | null
}

interface MessageRow {
  id: number
  conversation_id: string
  role: MessageRole
  content: string
  ts: string
}

export function createConversation(
  db: Database,
  input: { id: string; channel: string; title?: string },
): ConversationRecord {
  db.prepare('INSERT INTO conversations (id, channel, title) VALUES (?, ?, ?)').run(
    input.id,
    input.channel,
    input.title ?? null,
  )
  const created = getConversation(db, input.id)
  if (!created) throw new Error(`Conversation ${input.id} was not found after insert`)
  return created
}

export function getConversation(db: Database, id: string): ConversationRecord | undefined {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined
  return row ? mapConversation(row) : undefined
}

/** Most recently active first. */
export function listConversations(db: Database): ConversationRecord[] {
  return (
    db
      .prepare('SELECT * FROM conversations ORDER BY COALESCE(updated_at, created_at) DESC, id')
      .all() as unknown as ConversationRow[]
  ).map(mapConversation)
}

/** Records which brain served the conversation and its session, so the next turn resumes it. */
export function updateConversationSession(
  db: Database,
  id: string,
  session: { provider: ProviderKind; model: string; sessionId: string | null },
): void {
  db.prepare(
    `UPDATE conversations SET brain_provider = ?, brain_model = ?, session_id = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  ).run(session.provider, session.model, session.sessionId, id)
}

export function setConversationTitle(db: Database, id: string, title: string): void {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
}

export function appendMessage(
  db: Database,
  conversationId: string,
  role: MessageRole,
  content: string,
): MessageRecord {
  const result = db
    .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(conversationId, role, content)
  db.prepare(`UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(
    conversationId,
  )
  const row = db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as MessageRow
  return mapMessage(row)
}

export function listMessages(db: Database, conversationId: string): MessageRecord[] {
  return (
    db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id')
      .all(conversationId) as unknown as MessageRow[]
  ).map(mapMessage)
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    channel: row.channel,
    ...(row.title ? { title: row.title } : {}),
    ...(row.brain_provider ? { brainProvider: row.brain_provider as ProviderKind } : {}),
    ...(row.brain_model ? { brainModel: row.brain_model } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  }
}

function mapMessage(row: MessageRow): MessageRecord {
  return { id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, ts: row.ts }
}
