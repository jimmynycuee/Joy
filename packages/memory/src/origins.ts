export const UNTRUSTED_MEMORY_ORIGINS = ['email', 'web_page', 'issue', 'tool_output'] as const
export type UntrustedMemoryOrigin = (typeof UNTRUSTED_MEMORY_ORIGINS)[number]

export type MemoryOrigin = 'user_utterance' | 'agent' | 'summary' | 'manual' | UntrustedMemoryOrigin

export function isUntrustedMemoryOrigin(origin: MemoryOrigin): origin is UntrustedMemoryOrigin {
  return (UNTRUSTED_MEMORY_ORIGINS as readonly string[]).includes(origin)
}
