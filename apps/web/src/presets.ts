import { ROLES } from '@joy/core'
import type { Effort, ModelRef, ProviderKind, Role, RoleConfig } from '@joy/core'

export interface ModelPreset {
  id: 'balanced' | 'saver' | 'max'
  label: string
  description: string
  roles: RoleConfig
}

const cheapApi: ModelRef = { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' }

/** Ready-made model combinations. Model names are configuration, so they live here and nowhere else in the UI. */
export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'balanced',
    label: '平衡',
    description: 'Claude 實作、Codex 審查。日常任務的預設選擇。',
    roles: {
      assistant_brain: cheapApi,
      background: cheapApi,
      orchestrator: { provider: 'claude-cli', model: 'opus', effort: 'high' },
      implementer: { provider: 'claude-cli', model: 'opus', effort: 'medium' },
      reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
      judge: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
    },
  },
  {
    id: 'saver',
    label: '省額度',
    description: '每個角色都用最便宜的模型、思考程度低。適合小修改。',
    roles: {
      assistant_brain: cheapApi,
      background: cheapApi,
      orchestrator: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
      implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
      reviewer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
      judge: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
    },
  },
  {
    id: 'max',
    label: '最強',
    description: '實作與審查都用最強模型、思考程度高。難題或重要的修改用。',
    roles: {
      assistant_brain: { provider: 'openai-api', model: 'gpt-6.1-sol', effort: 'medium' },
      background: cheapApi,
      orchestrator: { provider: 'claude-cli', model: 'opus', effort: 'high' },
      implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' },
      reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high' },
      judge: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high' },
    },
  },
]

export function findPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id)
}

/** A model as it comes out of config (effort may be explicitly undefined). */
interface LooseModel {
  provider: ProviderKind
  model: string
  effort?: Effort | undefined
}

function sameModel(a: LooseModel | undefined, b: LooseModel): boolean {
  return (
    a?.provider === b.provider && a.model === b.model && (a.effort ?? undefined) === (b.effort ?? undefined)
  )
}

/** The preset whose six roles all match the config, if any. */
export function matchingPreset(
  roles: { [R in Role]?: LooseModel | undefined } | undefined,
): ModelPreset | undefined {
  if (!roles) return undefined
  return MODEL_PRESETS.find((preset) =>
    ROLES.every((role: Role) => sameModel(roles[role], preset.roles[role])),
  )
}

/** The preset that equals these implementer and reviewer models (what a single task overrides), if any. */
export function matchingTaskPreset(implementer: LooseModel, reviewer: LooseModel): ModelPreset | undefined {
  return MODEL_PRESETS.find(
    (preset) =>
      sameModel(implementer, preset.roles.implementer) && sameModel(reviewer, preset.roles.reviewer),
  )
}
