import { isPermissionMode } from '@joy/core'
import type { ModelRef, PermissionMode } from '@joy/core'
import { normalizeModels, resolveModels, sameRef } from './composer-choice.js'
import type { ComposerChoice, RoleDefaults, TaskModels } from './composer-choice.js'
import { MODE_LABELS, PERMISSION_LABELS } from './labels.js'
import { modelShort } from './models.js'
import { record } from './types.js'
import type { Task } from './types.js'

/** The two modes a running or finished task can move between; compete is set up when a task starts. */
export type SwitchableMode = 'single' | 'review_loop'

export function isSwitchableMode(mode: string): mode is SwitchableMode {
  return mode === 'single' || mode === 'review_loop'
}

/** What a follow-up message may change about the task's next runs (the `POST /messages` fields). */
export interface TaskSettings {
  mode?: SwitchableMode
  roleOverrides?: TaskModels
  permissionMode?: PermissionMode
}

/**
 * Where the task page's menus start: the task's own models, mode and permission mode, with any change still waiting
 * for the current run to end already applied.
 */
export function taskChoice(
  task: Pick<Task, 'mode' | 'roleOverrides'>,
  defaults: RoleDefaults,
  permissionMode: PermissionMode,
  pending?: TaskSettings | null,
): ComposerChoice {
  const overrides = { ...task.roleOverrides, ...pending?.roleOverrides }
  const models: TaskModels = {}
  if (overrides.implementer) models.implementer = overrides.implementer
  if (overrides.reviewer) models.reviewer = overrides.reviewer
  return {
    models: normalizeModels(models, defaults),
    mode: pending?.mode ?? task.mode,
    planFirst: false,
    permissionMode: pending?.permissionMode ?? permissionMode,
  }
}

/** Only what the owner changed in the menus; empty when nothing did. Models go out resolved, so 照設定 works too. */
export function settingsRequest(
  initial: ComposerChoice,
  current: ComposerChoice,
  defaults: RoleDefaults,
): TaskSettings {
  const request: TaskSettings = {}
  if (current.mode !== initial.mode && isSwitchableMode(current.mode)) request.mode = current.mode
  if (current.permissionMode !== initial.permissionMode) request.permissionMode = current.permissionMode
  const before = resolveModels(initial.models, defaults)
  const after = resolveModels(current.models, defaults)
  const roleOverrides: TaskModels = {}
  for (const role of ['implementer', 'reviewer'] as const) {
    if (!sameRef(before[role].ref, after[role].ref)) roleOverrides[role] = after[role].ref
  }
  if (Object.keys(roleOverrides).length) request.roleOverrides = roleOverrides
  return request
}

function ref(value: unknown): ModelRef | undefined {
  const fields = record(value)
  return typeof fields?.provider === 'string' && typeof fields.model === 'string'
    ? (fields as unknown as ModelRef)
    : undefined
}

/** Parses `pendingSettings` from the task details (missing or null on servers without it). */
export function parsePendingSettings(value: unknown): TaskSettings | null {
  const fields = record(value)
  if (!fields) return null
  const settings: TaskSettings = {}
  if (typeof fields.mode === 'string' && isSwitchableMode(fields.mode)) settings.mode = fields.mode
  if (isPermissionMode(fields.permissionMode)) settings.permissionMode = fields.permissionMode
  const overrides = record(fields.roleOverrides)
  const implementer = ref(overrides?.implementer)
  const reviewer = ref(overrides?.reviewer)
  if (implementer || reviewer)
    settings.roleOverrides = { ...(implementer ? { implementer } : {}), ...(reviewer ? { reviewer } : {}) }
  return Object.keys(settings).length ? settings : null
}

/** The thread line for a `task.settings` event: 「改用 Opus · 實作＋審查」. */
export function settingsLine(payload: unknown): string {
  const fields = record(payload)
  const implementer = ref(fields?.implementer)
  const reviewer = ref(fields?.reviewer)
  const mode = typeof fields?.mode === 'string' ? fields.mode : undefined
  const permission = isPermissionMode(fields?.permissionMode) ? fields.permissionMode : undefined
  const parts = [
    implementer ? modelShort(implementer) : undefined,
    reviewer ? `${modelShort(reviewer)} 審查` : undefined,
    mode ? (MODE_LABELS[mode] ?? mode) : undefined,
    permission ? PERMISSION_LABELS[permission] : undefined,
  ].filter((part): part is string => part !== undefined)
  if (!parts.length) return '設定已更新'
  return `${implementer || reviewer ? '改用 ' : '改成'}${parts.join(' · ')}`
}
