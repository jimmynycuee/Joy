import type { RepoId } from '@joy/core'
import type { Database } from './database.js'

export type MemoryScope = 'user' | 'project' | 'episode'
export type MemorySource = 'user_utterance' | 'agent' | 'summary' | 'manual'

export interface MemoryRecord {
  id: string
  scope: MemoryScope
  repoId?: RepoId
  content: string
  source: MemorySource
  confidence: number
  expiresAt?: string
  lastUsedAt?: string
  supersededBy?: string
  createdAt: string
}

export interface NewMemory {
  id: string
  scope: MemoryScope
  repoId?: RepoId
  content: string
  source: MemorySource
  confidence?: number
  expiresAt?: string
}

interface MemoryRow {
  id: string
  scope: MemoryScope
  repo_id: string | null
  content: string
  source: MemorySource
  confidence: number
  sensitive: number
  expires_at: string | null
  last_used_at: string | null
  superseded_by: string | null
  created_at: string
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
/** A memory Joy may use: not sensitive, not superseded, not expired. */
const ACTIVE = `m.sensitive = 0 AND m.superseded_by IS NULL AND (m.expires_at IS NULL OR m.expires_at > ${NOW})`

export function createMemory(db: Database, input: NewMemory): MemoryRecord {
  db.prepare(
    `INSERT INTO memories (id, scope, repo_id, content, source, confidence, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.scope,
    input.repoId ?? null,
    input.content,
    input.source,
    input.confidence ?? 1,
    input.expiresAt ?? null,
  )
  const created = getMemory(db, input.id)
  if (!created) throw new Error(`Memory ${input.id} was not found after insert`)
  return created
}

export function getMemory(db: Database, id: string): MemoryRecord | undefined {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow | undefined
  return row ? mapMemory(row) : undefined
}

/** Memories Joy may use now: recently used ones first, then the newest unused ones. */
export function listActiveMemories(db: Database, scope: MemoryScope, limit = 50): MemoryRecord[] {
  return (
    db
      .prepare(
        `SELECT m.* FROM memories m WHERE m.scope = ? AND ${ACTIVE}
         ORDER BY m.last_used_at IS NULL, m.last_used_at DESC, m.seq DESC LIMIT ?`,
      )
      .all(scope, limit) as unknown as MemoryRow[]
  ).map(mapMemory)
}

/** Every memory of a scope, including expired and superseded ones (for the memory page). */
export function listAllMemories(db: Database, scope: MemoryScope): MemoryRecord[] {
  return (
    db
      .prepare('SELECT * FROM memories WHERE scope = ? AND sensitive = 0 ORDER BY seq DESC')
      .all(scope) as unknown as MemoryRow[]
  ).map(mapMemory)
}

/** Full-text search over active memories. Words are matched as prefixes; quotes in the query are ignored. */
export function searchMemories(db: Database, query: string, limit = 20): MemoryRecord[] {
  const terms = query
    .replace(/["*()^:]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"*`)
  if (terms.length === 0) return []
  return (
    db
      .prepare(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.seq = f.rowid
         WHERE memories_fts MATCH ? AND ${ACTIVE} ORDER BY rank LIMIT ?`,
      )
      .all(terms.join(' OR '), limit) as unknown as MemoryRow[]
  ).map(mapMemory)
}

export function markMemoriesUsed(db: Database, ids: string[]): void {
  const statement = db.prepare(`UPDATE memories SET last_used_at = ${NOW} WHERE id = ?`)
  for (const id of ids) statement.run(id)
}

/** A newer memory replaced this one. The old row stays for the record but is never used again. */
export function supersedeMemory(db: Database, id: string, by: string): boolean {
  return (
    Number(
      db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL').run(by, id)
        .changes,
    ) === 1
  )
}

export function updateMemoryContent(db: Database, id: string, content: string): MemoryRecord | undefined {
  db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id)
  return getMemory(db, id)
}

export function deleteMemory(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes) === 1
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    ...(row.repo_id ? { repoId: row.repo_id as RepoId } : {}),
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    createdAt: row.created_at,
  }
}
