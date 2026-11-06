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
  /** Memories the current brain session was given. */
  memoryIds: string[]
  /** What the conversation was about, written by the background model (T3.6). */
  summary?: string
  /** Id of the last message the summary covers. */
  summaryThrough?: number
  createdAt: string
  updatedAt?: string
}

export interface MessageRecord {
  id: number
  conversationId: string
  role: MessageRole
  content: string
  /** Memories in play when the assistant wrote this reply. */
  memoryIds: string[]
  ts: string
}

interface ConversationRow {
  id: string
  channel: string
  title: string | null
  brain_provider: string | null
  brain_model: string | null
  session_id: string | null
  memory_ids: string | null
  summary: string | null
  summary_through: number | null
  created_at: string
  updated_at: string | null
}

interface MessageRow {
  id: number
  conversation_id: string
  role: MessageRole
  content: string
  memory_ids: string | null
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
  session: { provider: ProviderKind; model: string; sessionId: string | null; memoryIds?: string[] },
): void {
  db.prepare(
    `UPDATE conversations SET brain_provider = ?, brain_model = ?, session_id = ?, memory_ids = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  ).run(
    session.provider,
    session.model,
    session.sessionId,
    session.sessionId && session.memoryIds?.length ? JSON.stringify(session.memoryIds) : null,
    id,
  )
}

/**
 * Ends the brain session of every conversation that was given this memory, so the next turn starts a new session
 * without it. Returns how many conversations were reset.
 */
export function resetSessionsUsingMemory(db: Database, memoryId: string): number {
  return Number(
    db
      .prepare(
        `UPDATE conversations SET session_id = NULL, memory_ids = NULL
         WHERE memory_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(memory_ids) WHERE value = ?)`,
      )
      .run(memoryId).changes,
  )
}

export function setConversationTitle(db: Database, id: string, title: string): void {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
}

export function appendMessage(
  db: Database,
  conversationId: string,
  role: MessageRole,
  content: string,
  memoryIds: string[] = [],
): MessageRecord {
  const result = db
    .prepare('INSERT INTO messages (conversation_id, role, content, memory_ids) VALUES (?, ?, ?, ?)')
    .run(conversationId, role, content, memoryIds.length ? JSON.stringify(memoryIds) : null)
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

/** Stores the conversation's summary and keeps its search index in step. */
export function setConversationSummary(
  db: Database,
  id: string,
  summary: string,
  throughMessageId: number,
): void {
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE conversations SET summary = ?, summary_through = ? WHERE id = ?').run(
      summary,
      throughMessageId,
      id,
    )
    db.prepare('DELETE FROM conversation_summaries_fts WHERE conversation_id = ?').run(id)
    db.prepare('INSERT INTO conversation_summaries_fts (conversation_id, summary) VALUES (?, ?)').run(
      id,
      summary,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export interface HistoryHit {
  conversationId: string
  title?: string
  kind: 'summary' | 'message'
  role?: MessageRole
  /** The matching text with the matched words in [brackets]. */
  snippet: string
  ts: string
}

/**
 * Full-text search over what the owner and Joy said and over conversation summaries, newest first. Words match as
 * prefixes; FTS syntax in the query is ignored.
 */
export function searchHistory(db: Database, query: string, limit = 20): HistoryHit[] {
  const terms = query
    .replace(/["*()^:{}+-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"*`)
  if (terms.length === 0) return []
  const match = terms.join(' OR ')
  const summaries = db
    .prepare(
      `SELECT c.id AS conversation_id, c.title, snippet(conversation_summaries_fts, 1, '[', ']', '…', 24) AS snippet,
              COALESCE(c.updated_at, c.created_at) AS ts
       FROM conversation_summaries_fts f JOIN conversations c ON c.id = f.conversation_id
       WHERE conversation_summaries_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(match, limit) as unknown as Array<{
    conversation_id: string
    title: string | null
    snippet: string
    ts: string
  }>
  const messages = db
    .prepare(
      `SELECT m.conversation_id, c.title, m.role, snippet(messages_fts, 0, '[', ']', '…', 24) AS snippet, m.ts
       FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN conversations c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ? AND m.role IN ('user', 'assistant') ORDER BY rank LIMIT ?`,
    )
    .all(match, limit) as unknown as Array<{
    conversation_id: string
    title: string | null
    role: MessageRole
    snippet: string
    ts: string
  }>
  const hits: HistoryHit[] = [
    ...summaries.map((row) => ({
      conversationId: row.conversation_id,
      ...(row.title ? { title: row.title } : {}),
      kind: 'summary' as const,
      snippet: row.snippet,
      ts: row.ts,
    })),
    ...messages.map((row) => ({
      conversationId: row.conversation_id,
      ...(row.title ? { title: row.title } : {}),
      kind: 'message' as const,
      role: row.role,
      snippet: row.snippet,
      ts: row.ts,
    })),
  ]
  return hits.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit)
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    channel: row.channel,
    ...(row.title ? { title: row.title } : {}),
    ...(row.brain_provider ? { brainProvider: row.brain_provider as ProviderKind } : {}),
    ...(row.brain_model ? { brainModel: row.brain_model } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    memoryIds: parseIds(row.memory_ids),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.summary_through !== null ? { summaryThrough: row.summary_through } : {}),
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  }
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    memoryIds: parseIds(row.memory_ids),
    ts: row.ts,
  }
}

function parseIds(value: string | null): string[] {
  if (!value) return []
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
}
