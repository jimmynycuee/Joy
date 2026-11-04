import type { Database } from '@joy/db'
import { isSensitiveContent, storeExtractedUserMemory } from './storage.js'
import type { MemoryRecord } from './storage.js'
import type { UntrustedMemoryOrigin } from './origins.js'

export type UserMemoryOrigin = 'user_utterance' | UntrustedMemoryOrigin

export interface UserMemoryInput {
  origin: UserMemoryOrigin
  text: string
  id?: string
  expiresAt?: string
}

export type UserMemoryResult =
  | { status: 'stored'; memory: MemoryRecord }
  | { status: 'ignored'; reason: 'untrusted_origin' | 'no_memory_candidate' | 'sensitive' }

/** Extracts an explicit remember request from a direct user utterance; external content is never parsed. */
export function extractUserMemory(utterance: string): string | undefined {
  const text = utterance.trim()
  const match =
    text.match(/^(?:please\s+)?remember(?:\s+that)?\s+([\s\S]+)$/i) ??
    text.match(/^remember\s*:\s*([\s\S]+)$/i)
  const candidate = match?.[1]
    ?.trim()
    .replace(/[.!?]+$/, '')
    .trim()
  return candidate || undefined
}

/** Writes at most one user-scope memory, and only from an explicitly identified user utterance. */
export function ingestUserMemory(db: Database, input: UserMemoryInput): UserMemoryResult {
  if (input.origin !== 'user_utterance') return { status: 'ignored', reason: 'untrusted_origin' }

  const content = extractUserMemory(input.text)
  if (!content) return { status: 'ignored', reason: 'no_memory_candidate' }
  if (isSensitiveContent(content)) return { status: 'ignored', reason: 'sensitive' }

  return {
    status: 'stored',
    memory: storeExtractedUserMemory(db, {
      ...(input.id !== undefined ? { id: input.id } : {}),
      content,
      confidence: 0.9,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    }),
  }
}
