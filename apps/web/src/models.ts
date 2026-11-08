import type { ModelRef, ProviderKind } from '@joy/core'

export interface CatalogModel {
  provider: ProviderKind
  /** The name the provider's CLI or API takes. Model names are configuration, so they live here and nowhere else in the UI. */
  model: string
  /** Full display name: "Opus 5.5". */
  label: string
  /** Short display name for tight places: "Opus". */
  short: string
  /** One line with the provider, for lists where the same name can come from two places (the review model list). */
  description: string
  /** A few words after the name in the compact model list. */
  blurb: string
  /** Can do the implementer's job (edit code). The OpenAI API cannot. */
  implementer: boolean
}

/** Every model the composer offers, in menu order. A model that is not here (set by hand in Settings) still works; it just shows its raw name. */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    provider: 'claude-cli',
    model: 'opus',
    label: 'Opus 5.5',
    short: 'Opus',
    description: 'Claude Code · 最強，適合複雜任務',
    blurb: '最強',
    implementer: true,
  },
  {
    provider: 'claude-cli',
    model: 'sonnet',
    label: 'Sonnet 5.5',
    short: 'Sonnet',
    description: 'Claude Code · 速度與品質平衡',
    blurb: '速度與品質平衡',
    implementer: true,
  },
  {
    provider: 'claude-cli',
    model: 'haiku',
    label: 'Haiku 5.5',
    short: 'Haiku',
    description: 'Claude Code · 最快、最省額度',
    blurb: '最快、最省額度',
    implementer: true,
  },
  {
    provider: 'codex-cli',
    model: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    short: 'Sol',
    description: 'Codex · 旗艦模型',
    blurb: 'Codex 旗艦',
    implementer: true,
  },
  {
    provider: 'codex-cli',
    model: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    short: 'Luna',
    description: 'Codex · 輕量、省額度',
    blurb: 'Codex 輕量、省額度',
    implementer: true,
  },
  {
    provider: 'openai-api',
    model: 'gpt-6-luna',
    label: 'GPT-6 Luna (API)',
    short: 'Luna API',
    description: 'OpenAI API · 便宜快速，只能審查',
    blurb: '只能審查',
    implementer: false,
  },
  {
    provider: 'openai-api',
    model: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol (API)',
    short: 'Sol API',
    description: 'OpenAI API · 只能審查，花 API 費用',
    blurb: '只能審查，花 API 費用',
    implementer: false,
  },
]

/** Models that can edit code, for the implementer list. */
export const IMPLEMENTER_MODELS: readonly CatalogModel[] = MODEL_CATALOG.filter((model) => model.implementer)

export function findCatalogModel(
  ref: { provider: ProviderKind; model: string } | undefined,
): CatalogModel | undefined {
  if (!ref) return undefined
  const name = ref.model.trim().toLowerCase()
  return MODEL_CATALOG.find((entry) => entry.provider === ref.provider && entry.model === name)
}

/** "Opus 5.5" for a known model, the raw name otherwise. */
export function modelLabel(ref: Pick<ModelRef, 'provider' | 'model'>): string {
  return findCatalogModel(ref)?.label ?? ref.model
}

/** "Opus" for a known model, the raw name otherwise. */
export function modelShort(ref: Pick<ModelRef, 'provider' | 'model'>): string {
  return findCatalogModel(ref)?.short ?? ref.model
}

export function sameModelName(
  a: Pick<ModelRef, 'provider' | 'model'> | undefined,
  b: Pick<ModelRef, 'provider' | 'model'> | undefined,
): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model
}
