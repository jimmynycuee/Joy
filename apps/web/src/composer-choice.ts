import { EFFORTS, PROVIDER_KINDS } from '@joy/core'
import type { Effort, ModelRef, ProviderKind } from '@joy/core'
import { DEFAULT_EFFORT, effortLabel, nearestSupported, supportedEfforts } from './effort.js'
import { PROVIDER_LABELS } from './labels.js'
import { modelLabel, modelShort, sameModelName } from './models.js'
import type { ModelPreset } from './presets.js'

/** The two roles a task can pick its own model for. The orchestrator is not used while a task runs, so it is never overridden. */
export type TaskRole = 'implementer' | 'reviewer'
export type TaskModels = Partial<Record<TaskRole, ModelRef>>
export type RoleDefaults = Record<TaskRole, ModelRef>

/** Everything the new-task box remembers between visits. A role missing from `models` follows Settings. */
export interface ComposerChoice {
  models: TaskModels
  /** `review_loop`, `single`, `compete` or `workflow:<name>`. */
  mode: string
  planFirst: boolean
}

export const DEFAULT_MODE = 'review_loop'
export const EMPTY_CHOICE: ComposerChoice = { models: {}, mode: DEFAULT_MODE, planFirst: false }

export function sameRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return sameModelName(a, b) && a?.effort === b?.effort
}

function ref(provider: ProviderKind, model: string, effort: Effort | undefined): ModelRef {
  return effort ? { provider, model, effort } : { provider, model }
}

/** Drops the roles that equal what Settings would use anyway, so "follows Settings" stays visible as such. */
export function normalizeModels(models: TaskModels, defaults: RoleDefaults): TaskModels {
  const next: TaskModels = {}
  for (const role of ['implementer', 'reviewer'] as const) {
    const picked = models[role]
    if (picked && !sameRef(picked, defaults[role])) next[role] = picked
  }
  return next
}

export interface ResolvedModel {
  ref: ModelRef
  /** True when nothing was picked for this role: it is whatever Settings says. */
  isDefault: boolean
}

export function resolveModels(models: TaskModels, defaults: RoleDefaults): Record<TaskRole, ResolvedModel> {
  const normalized = normalizeModels(models, defaults)
  const one = (role: TaskRole): ResolvedModel => {
    const picked = normalized[role]
    return picked ? { ref: picked, isDefault: false } : { ref: defaults[role], isDefault: true }
  }
  return { implementer: one('implementer'), reviewer: one('reviewer') }
}

/** A model whose effort is checked against what that model accepts: a value it does not take moves to the nearest one it does. */
export function fitEffort(provider: ProviderKind, model: string, effort: Effort | undefined): ModelRef {
  if (!effort) return { provider, model }
  return ref(provider, model, nearestSupported(effort, supportedEfforts(provider, model)))
}

function withRole(choice: ComposerChoice, role: TaskRole, next: ModelRef, defaults: RoleDefaults) {
  return { ...choice, models: normalizeModels({ ...choice.models, [role]: next }, defaults) }
}

function currentRef(choice: ComposerChoice, role: TaskRole, defaults: RoleDefaults): ModelRef {
  return choice.models[role] ?? defaults[role]
}

/** Picks a model for a role. The effort in use moves along if the new model takes it, else to the nearest one it takes. */
export function pickModel(
  choice: ComposerChoice,
  role: TaskRole,
  pick: { provider: ProviderKind; model: string },
  defaults: RoleDefaults,
): ComposerChoice {
  const current = currentRef(choice, role, defaults)
  if (sameModelName(current, pick)) return choice
  return withRole(choice, role, fitEffort(pick.provider, pick.model, current.effort), defaults)
}

/** Sets the effort of a role's model. An effort the model does not accept is ignored. */
export function pickEffort(
  choice: ComposerChoice,
  role: TaskRole,
  effort: Effort,
  defaults: RoleDefaults,
): ComposerChoice {
  const current = currentRef(choice, role, defaults)
  if (!supportedEfforts(current.provider, current.model).includes(effort)) return choice
  return withRole(choice, role, ref(current.provider, current.model, effort), defaults)
}

/** The effort a model starts from: Settings' own when it is the same model, else medium (or the nearest the model takes). */
export function defaultEffortFor(
  current: ModelRef,
  defaults: RoleDefaults,
  role: TaskRole,
): Effort | undefined {
  if (sameModelName(current, defaults[role])) return defaults[role].effort
  return nearestSupported(DEFAULT_EFFORT, supportedEfforts(current.provider, current.model))
}

/** 重設 in the effort popover: back to the default effort, keeping the picked model. */
export function resetEffort(choice: ComposerChoice, role: TaskRole, defaults: RoleDefaults): ComposerChoice {
  const current = currentRef(choice, role, defaults)
  return withRole(
    choice,
    role,
    ref(current.provider, current.model, defaultEffortFor(current, defaults, role)),
    defaults,
  )
}

/** A role set to an exact model by hand (the 進階 fields). */
export function setRoleModel(
  choice: ComposerChoice,
  role: TaskRole,
  next: ModelRef,
  defaults: RoleDefaults,
): ComposerChoice {
  return withRole(choice, role, next, defaults)
}

/** 快速套用: the preset's implementer and reviewer. Nothing else about the task changes. */
export function applyPreset(
  choice: ComposerChoice,
  preset: ModelPreset,
  defaults: RoleDefaults,
): ComposerChoice {
  return {
    ...choice,
    models: normalizeModels(
      { implementer: preset.roles.implementer, reviewer: preset.roles.reviewer },
      defaults,
    ),
  }
}

/** 照設定: no model picked for this task. */
export function followSettings(choice: ComposerChoice): ComposerChoice {
  return { ...choice, models: {} }
}

export function providerBlockedReason(
  provider: ProviderKind,
  allowed: readonly ProviderKind[] | undefined,
): string | undefined {
  if (!allowed || allowed.includes(provider)) return undefined
  return `專案不允許 ${PROVIDER_LABELS[provider]}`
}

/** Leaves out picks the repository does not allow, so they fall back to Settings instead of failing the task. */
export function applyAllowlist(
  choice: ComposerChoice,
  allowed: readonly ProviderKind[] | undefined,
): ComposerChoice {
  const models: TaskModels = {}
  for (const role of ['implementer', 'reviewer'] as const) {
    const picked = choice.models[role]
    if (picked && !providerBlockedReason(picked.provider, allowed)) models[role] = picked
  }
  return { ...choice, models }
}

/** A remembered custom workflow that no longer exists falls back to the default mode. */
export function validMode(mode: string, workflowNames: readonly string[]): string {
  if (mode === 'review_loop' || mode === 'single' || mode === 'compete') return mode
  if (mode.startsWith('workflow:') && workflowNames.includes(mode.slice('workflow:'.length))) return mode
  return DEFAULT_MODE
}

/** Plan-first works for the two built-in single-agent modes; compete and custom workflows do not take it. */
export function planFirstDisabledReason(mode: string): string | undefined {
  if (mode === 'compete') return '兩家比賽不支援先規劃'
  if (mode.startsWith('workflow:')) return '自訂流程請在設定檔裡設定 plan_first'
  return undefined
}

/** The `roleOverrides` to send: only roles the owner picked, and the reviewer only when the mode has one. Undefined when nothing was picked. */
export function buildRoleOverrides(choice: ComposerChoice, mode: string): TaskModels | undefined {
  if (mode.startsWith('workflow:')) return undefined
  const overrides: TaskModels = {}
  if (choice.models.implementer) overrides.implementer = choice.models.implementer
  if (mode !== 'single' && choice.models.reviewer) overrides.reviewer = choice.models.reviewer
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

/** "Opus 5.5 · 中", or just the name when no effort is set. */
export function modelButtonText(model: ModelRef): string {
  return model.effort ? `${modelLabel(model)} · ${effortLabel(model.effort)}` : modelLabel(model)
}

/** The second line of a quick-apply item: "Opus 中 實作 · Sol 審查". */
export function comboSummary(implementer: ModelRef, reviewer: ModelRef): string {
  const effort = implementer.effort ? ` ${effortLabel(implementer.effort)}` : ''
  return `${modelShort(implementer)}${effort} 實作 · ${modelShort(reviewer)} 審查`
}

export function modeSummary(mode: string, planFirst: boolean, label: (mode: string) => string): string {
  return planFirst && !planFirstDisabledReason(mode) ? `${label(mode)} · 先規劃` : label(mode)
}

export const COMPOSER_STORAGE_KEY = 'joy.composer.v1'

function parseRef(value: unknown): ModelRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, model, effort } = value as Record<string, unknown>
  if (typeof provider !== 'string' || !(PROVIDER_KINDS as readonly string[]).includes(provider))
    return undefined
  if (typeof model !== 'string' || model.trim().length === 0 || model.length > 100) return undefined
  const kind = provider as ProviderKind
  const name = model.trim()
  const effortValue = (EFFORTS as readonly unknown[]).includes(effort) ? (effort as Effort) : undefined
  return fitEffort(kind, name, effortValue)
}

/** Reads what was stored; anything missing, malformed or no longer valid just means "use the defaults". */
export function parseStoredChoice(raw: string | null): ComposerChoice {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (typeof value !== 'object' || value === null) return EMPTY_CHOICE
    const stored = value as Record<string, unknown>
    const models: TaskModels = {}
    const storedModels = typeof stored.models === 'object' && stored.models !== null ? stored.models : {}
    const implementer = parseRef((storedModels as Record<string, unknown>).implementer)
    // The OpenAI API cannot edit code, so a remembered API implementer is stale.
    if (implementer && implementer.provider !== 'openai-api') models.implementer = implementer
    const reviewer = parseRef((storedModels as Record<string, unknown>).reviewer)
    if (reviewer) models.reviewer = reviewer
    const mode = typeof stored.mode === 'string' && stored.mode.length <= 100 ? stored.mode : DEFAULT_MODE
    return { models, mode, planFirst: stored.planFirst === true }
  } catch {
    return EMPTY_CHOICE
  }
}

export function serializeChoice(choice: ComposerChoice): string {
  return JSON.stringify(choice)
}
