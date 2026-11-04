import type { Database } from '@joy/db'
import { writeMemory } from './storage.js'
import type { MemoryRecord } from './storage.js'

export interface ConversationSummaryInput {
  id?: string
  content: string
  /** A user must explicitly approve the summary before this writer can persist it. */
  userApproved: boolean
  expiresAt?: string
  confidence?: number
}

/**
 * Stores only an explicitly user-approved conversation/event summary as an episode memory.
 * This does not summarize stored messages, whose schema has no source/provenance metadata.
 */
export function writeConversationSummary(
  db: Database,
  input: ConversationSummaryInput,
): MemoryRecord | undefined {
  if (!input.userApproved) return undefined
  return writeMemory(db, {
    ...(input.id !== undefined ? { id: input.id } : {}),
    scope: 'episode',
    content: input.content,
    source: 'summary',
    origin: 'manual',
    userApproved: true,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  })
}
