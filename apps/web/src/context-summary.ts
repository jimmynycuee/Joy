/** The summary a long assistant conversation's brain started over from, and the last message it covers. */
export interface ConversationContext {
  summary: string
  through: number
}

/** Reads it from a conversation in an API answer (untrusted shape). */
export function parseConversationContext(value: unknown): ConversationContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { contextSummary, contextThrough } = value as { contextSummary?: unknown; contextThrough?: unknown }
  return typeof contextSummary === 'string' && contextSummary && typeof contextThrough === 'number'
    ? { summary: contextSummary, through: contextThrough }
    : undefined
}

/**
 * The message the summary divider goes after: the last stored message the summary covers. Messages shown before
 * the server answered have negative ids and are never covered. -1 when there is none.
 */
export function contextDividerIndex(messages: ReadonlyArray<{ id: number }>, through: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.id ?? -1
    if (id > 0 && id <= through) return i
  }
  return -1
}
