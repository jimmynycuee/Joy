import { randomUUID } from 'node:crypto'
import type { Database } from '@joy/db'
import { isUntrustedMemoryOrigin } from './origins.js'
import type { MemoryOrigin } from './origins.js'

export const MEMORY_SCOPES = ['user', 'project', 'episode'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MEMORY_SOURCES = ['user_utterance', 'agent', 'summary', 'manual'] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

export interface MemoryRecord {
  id: string
  scope: MemoryScope
  repoId?: string
  content: string
  source: MemorySource
  confidence: number
  sensitive: boolean
  expiresAt?: string
  lastUsedAt?: string
  createdAt: string
}

export interface WriteMemoryInput {
  id?: string
  scope: 'project' | 'episode'
  repoId?: string
  content: string
  source: MemorySource
  origin: MemoryOrigin
  /** Required when memory content was not supplied as a direct user utterance. */
  userApproved?: boolean
  confidence?: number
  expiresAt?: string
}

export interface ListMemoryOptions {
  scope?: MemoryScope
  repoId?: string
  now?: Date
}

export interface SearchMemoryOptions extends ListMemoryOptions {
  limit?: number
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
  created_at: string
}

const SENSITIVE_PATTERNS = [
  /\b(?:password|passcode|secret|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|private[\s_-]*key)\b\s*(?:is|=|:)\s*[^\s,;]+/i,
  /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,})\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
]

/** Filters credential-like values and government identifiers before they reach SQLite. */
export function isSensitiveContent(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))
}

/** Stores project or episode memories only with direct-user provenance or explicit user approval. */
export function writeMemory(db: Database, input: WriteMemoryInput): MemoryRecord | undefined {
  if (isUntrustedMemoryOrigin(input.origin)) return undefined
  const verifiedUserOrigin = input.origin === 'user_utterance' && input.source === 'user_utterance'
  if (!verifiedUserOrigin && input.userApproved !== true) return undefined
  const content = input.content.trim()
  if (!content || isSensitiveContent(content)) return undefined
  const confidence = input.confidence ?? 1
  validateConfidence(confidence)
  return insertMemory(db, {
    ...input,
    content,
    confidence,
  })
}

/** Returns only active, non-sensitive memories. */
export function listMemories(db: Database, options: ListMemoryOptions = {}): MemoryRecord[] {
  const now = (options.now ?? new Date()).toISOString()
  const conditions = ['sensitive = 0', '(expires_at IS NULL OR expires_at > ?)']
  const values: (string | number)[] = [now]
  if (options.scope) {
    conditions.push('scope = ?')
    values.push(options.scope)
  }
  if (options.repoId) {
    conditions.push('repo_id = ?')
    values.push(options.repoId)
  }
  const rows = db
    .prepare(`SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY created_at, id`)
    .all(...values) as unknown as MemoryRow[]
  return rows.map(mapMemory)
}

/** Searches active, non-sensitive memories using FTS5; terms are treated as plain text, not FTS syntax. */
export function searchMemories(
  db: Database,
  query: string,
  options: SearchMemoryOptions = {},
): MemoryRecord[] {
  if (query.length > 512) throw new Error('Memory search query must be 512 characters or fewer')
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])]
  if (terms.length === 0) return []

  const limit = options.limit ?? 10
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Memory search limit must be an integer between 1 and 50')
  }
  const now = (options.now ?? new Date()).toISOString()
  const conditions = ['memories_fts MATCH ?', 'm.sensitive = 0', '(m.expires_at IS NULL OR m.expires_at > ?)']
  const values: (string | number)[] = [terms.map((term) => `"${term}"`).join(' AND '), now]
  if (options.scope) {
    conditions.push('m.scope = ?')
    values.push(options.scope)
  }
  if (options.repoId) {
    conditions.push('m.repo_id = ?')
    values.push(options.repoId)
  }
  values.push(limit)

  const rows = db
    .prepare(
      `SELECT m.* FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE ${conditions.join(' AND ')}
       ORDER BY bm25(memories_fts), m.created_at DESC, m.id
       LIMIT ?`,
    )
    .all(...values) as unknown as MemoryRow[]
  return rows.map(mapMemory)
}

/** Deletes expired rows and returns the number removed. */
export function deleteExpiredMemories(db: Database, now = new Date()): number {
  const result = db
    .prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .run(now.toISOString())
  return Number(result.changes)
}

/** Internal path used only after a direct user utterance has produced a safe candidate. */
export function storeExtractedUserMemory(
  db: Database,
  input: { id?: string; content: string; confidence: number; expiresAt?: string },
): MemoryRecord {
  return insertMemory(db, {
    ...input,
    scope: 'user',
    source: 'user_utterance',
  })
}

function insertMemory(
  db: Database,
  input: {
    id?: string
    scope: MemoryScope
    repoId?: string
    content: string
    source: MemorySource
    confidence: number
    expiresAt?: string
  },
): MemoryRecord {
  validateConfidence(input.confidence)
  const expiresAt = input.expiresAt === undefined ? null : normalizeTimestamp(input.expiresAt)
  const id = input.id ?? randomUUID()
  db.prepare(
    `INSERT INTO memories (id, scope, repo_id, content, source, confidence, sensitive, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(id, input.scope, input.repoId ?? null, input.content, input.source, input.confidence, expiresAt)
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
  if (!row) throw new Error(`Memory ${id} was not found after insert`)
  return mapMemory(row)
}

function validateConfidence(confidence: number): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Memory confidence must be a number between 0 and 1')
  }
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error('Memory expiry must be a valid date')
  return new Date(milliseconds).toISOString()
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    ...(row.repo_id ? { repoId: row.repo_id } : {}),
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    sensitive: row.sensitive === 1,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    createdAt: row.created_at,
  }
}
