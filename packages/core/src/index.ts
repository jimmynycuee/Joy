// Placeholder until T0.5: the full interfaces (AgentProvider, Executor, Channel, policy) are
// finalized after the CLI spikes (T0.3, T0.4). See docs/PLAN.md §3.2.

export const PROVIDER_KINDS = ['openai-api', 'claude-cli', 'codex-cli'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export interface ModelRef {
  provider: ProviderKind
  model: string
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value)
}

/** Parses `"<provider>:<model>"`, e.g. `"claude-cli:opus"`. Returns null when malformed. */
export function parseModelRef(input: string): ModelRef | null {
  const sep = input.indexOf(':')
  if (sep <= 0) return null
  const provider = input.slice(0, sep)
  const model = input.slice(sep + 1).trim()
  if (!isProviderKind(provider) || model === '') return null
  return { provider, model }
}
