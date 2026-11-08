import { EFFORTS } from '@joy/core'
import type { Effort, ProviderKind } from '@joy/core'
import { EFFORT_LABELS } from './labels.js'

/**
 * Which efforts a provider documents for a model. This is a copy of the allowlist in `packages/model-effort`
 * (the web app does not depend on that package); `effort.test.ts` checks the two agree, so a change there that
 * is not mirrored here fails a test.
 */
const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[]
const NO_XHIGH = ['low', 'medium', 'high', 'max'] as const satisfies readonly Effort[]
const CODEX = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly Effort[]

export const SUPPORTED_EFFORTS: Record<ProviderKind, Readonly<Record<string, readonly Effort[]>>> = {
  'claude-cli': {
    haiku: ALL,
    sonnet: ALL,
    opus: ALL,
    'claude-haiku-5-5': ALL,
    'claude-sonnet-5-5': ALL,
    'claude-opus-5-5': ALL,
    'claude-sonnet-5': ALL,
    'claude-opus-5': ALL,
    'claude-opus-4-8': ALL,
    'claude-opus-4-7': ALL,
    'claude-opus-4-6': NO_XHIGH,
    'claude-sonnet-4-6': NO_XHIGH,
  },
  'codex-cli': { 'gpt-6.1-sol': CODEX, 'gpt-6-luna': CODEX },
  'openai-api': { 'gpt-6.1-sol': ALL, 'gpt-6-luna': ALL },
}

/** The efforts a model accepts, in slider order. Empty for a model nobody has validated: send no effort then. */
export function supportedEfforts(provider: ProviderKind, model: string): readonly Effort[] {
  return SUPPORTED_EFFORTS[provider][model.trim().toLowerCase()] ?? []
}

/** Effort used when the owner asks to start over and the settings name none. */
export const DEFAULT_EFFORT: Effort = 'medium'

export function effortLabel(effort: Effort): string {
  return EFFORT_LABELS[effort] ?? effort
}

/** The supported effort closest to `effort`; a tie goes to the lower one (spend less). Undefined when nothing is supported. */
export function nearestSupported(effort: Effort, supported: readonly Effort[]): Effort | undefined {
  const target = EFFORTS.indexOf(effort)
  let best: Effort | undefined
  let bestDistance = Infinity
  for (const candidate of supported) {
    const distance = Math.abs(EFFORTS.indexOf(candidate) - target)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** One step along the supported efforts; stays put at either end. */
export function stepEffort(
  current: Effort | undefined,
  supported: readonly Effort[],
  direction: 1 | -1,
): Effort | undefined {
  if (supported.length === 0) return undefined
  const ordered = EFFORTS.filter((effort) => supported.includes(effort))
  if (current === undefined) return direction === 1 ? ordered[0] : ordered.at(-1)
  const position = ordered.indexOf(nearestSupported(current, ordered) ?? current)
  return ordered[Math.min(ordered.length - 1, Math.max(0, position + direction))]
}

/** Which of the five slider segments a horizontal position (0 to 1 across the track) falls in. */
export function segmentAt(ratio: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  return Math.min(EFFORTS.length - 1, Math.floor(clamped * EFFORTS.length))
}

/** The effort a pointer position means; a segment the model does not support snaps to its nearest neighbour. */
export function effortAtPosition(ratio: number, supported: readonly Effort[]): Effort | undefined {
  const segment = EFFORTS[segmentAt(ratio)]
  return segment ? nearestSupported(segment, supported) : undefined
}
