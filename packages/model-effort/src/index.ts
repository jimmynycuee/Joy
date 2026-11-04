import type { Effort, ProviderKind } from '@joy/core'

const CLAUDE_ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[]
const CLAUDE_NO_XHIGH = ['low', 'medium', 'high', 'max'] as const satisfies readonly Effort[]
const OPENAI_ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[]
const CODEX_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly Effort[]

/**
 * Effort support is model-specific. Keep this allowlist explicit: unknown models
 * must omit effort until their provider documents the accepted levels.
 * Sources: https://code.claude.com/docs/en/model-config,
 * https://developers.openai.com/codex/config-reference,
 * https://developers.openai.com/api/docs/models/gpt-6-luna,
 * https://developers.openai.com/api/docs/models/gpt-6.1-sol.
 */
const SUPPORTED_EFFORTS: Record<ProviderKind, Readonly<Record<string, readonly Effort[]>>> = {
  'claude-cli': {
    haiku: CLAUDE_ALL,
    sonnet: CLAUDE_ALL,
    opus: CLAUDE_ALL,
    'claude-haiku-5-5': CLAUDE_ALL,
    'claude-sonnet-5-5': CLAUDE_ALL,
    'claude-opus-5-5': CLAUDE_ALL,
    'claude-sonnet-5': CLAUDE_ALL,
    'claude-opus-5': CLAUDE_ALL,
    'claude-opus-4-8': CLAUDE_ALL,
    'claude-opus-4-7': CLAUDE_ALL,
    'claude-opus-4-6': CLAUDE_NO_XHIGH,
    'claude-sonnet-4-6': CLAUDE_NO_XHIGH,
  },
  'codex-cli': {
    'gpt-6.1-sol': CODEX_LEVELS,
    'gpt-6-luna': CODEX_LEVELS,
  },
  'openai-api': {
    'gpt-6.1-sol': OPENAI_ALL,
    'gpt-6-luna': OPENAI_ALL,
  },
}

/** Returns an actionable problem for an unsupported/unverified provider-model-effort tuple. */
export function effortCompatibilityError(
  provider: ProviderKind,
  model: string,
  effort: Effort,
): string | undefined {
  const supported = SUPPORTED_EFFORTS[provider][model.trim().toLowerCase()]
  if (!supported) {
    return `effort '${effort}' is not validated for ${provider} model '${model}'; omit effort or use a documented provider/model combination.`
  }
  if (!supported.includes(effort)) {
    return `effort '${effort}' is not supported for ${provider} model '${model}'; supported efforts are ${supported.join(', ')}.`
  }
  return undefined
}
