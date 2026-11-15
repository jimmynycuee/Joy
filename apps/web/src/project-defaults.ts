import { clampPermissionMode } from '@joy/core'
import type { ModelRef, PermissionMode, ProviderKind } from '@joy/core'
import { defaultEffortFor, fitEffort, setRoleModel } from './composer-choice.js'
import type { ComposerChoice, RoleDefaults } from './composer-choice.js'
import type { ProjectDefaults } from './types.js'

/** The longest project instructions text the server takes (`MAX_PROJECT_INSTRUCTIONS` in `packages/db`). */
export const MAX_INSTRUCTIONS = 20_000

/** The built-in modes a project can default to, in the order the settings list shows them. */
export const DEFAULT_MODES = ['review_loop', 'single', 'compete'] as const

const ROLES = ['implementer', 'reviewer'] as const

/** What the settings form holds: each field is a select value, with '' meaning "no default" (keep the last choice). */
export interface DefaultsForm {
  /** `provider|model`. */
  implementer: string
  reviewer: string
  mode: string
  permissionMode: PermissionMode | ''
}

export function refKey(ref: Pick<ModelRef, 'provider' | 'model'>): string {
  return `${ref.provider}|${ref.model}`
}

function parseRefKey(key: string): Pick<ModelRef, 'provider' | 'model'> | undefined {
  const [provider, ...rest] = key.split('|')
  const model = rest.join('|')
  return provider && model ? { provider: provider as ProviderKind, model } : undefined
}

export function defaultsForm(defaults: ProjectDefaults | undefined): DefaultsForm {
  return {
    implementer: defaults?.implementer ? refKey(defaults.implementer) : '',
    reviewer: defaults?.reviewer ? refKey(defaults.reviewer) : '',
    mode: defaults?.mode ?? '',
    permissionMode: defaults?.permissionMode ?? '',
  }
}

/**
 * The defaults the form describes. A model the owner did not change keeps what was stored for it (an effort set
 * through the API, for example); an empty field is not part of the result.
 */
export function buildDefaults(form: DefaultsForm, stored: ProjectDefaults | undefined): ProjectDefaults {
  const defaults: ProjectDefaults = {}
  for (const role of ROLES) {
    const ref = parseRefKey(form[role])
    const before = stored?.[role]
    if (ref) defaults[role] = before && refKey(before) === form[role] ? before : ref
  }
  if (form.mode) defaults.mode = form.mode
  if (form.permissionMode) defaults.permissionMode = form.permissionMode
  return defaults
}

export function sameDefaults(a: ProjectDefaults | undefined, b: ProjectDefaults | undefined): boolean {
  const ref = (value: ModelRef | undefined) => (value ? `${refKey(value)}|${value.effort ?? ''}` : '')
  return (
    ref(a?.implementer) === ref(b?.implementer) &&
    ref(a?.reviewer) === ref(b?.reviewer) &&
    (a?.mode ?? '') === (b?.mode ?? '') &&
    (a?.permissionMode ?? '') === (b?.permissionMode ?? '')
  )
}

/**
 * The home page's choice after switching to a project: what the project has a default for replaces the choice, the rest
 * stays as the owner last left it. A permission mode above the project's maximum is lowered to it. A model without its
 * own effort gets the one a model starts from anyway (Settings' for the same model, else the middle one it takes).
 */
export function applyProjectDefaults(
  choice: ComposerChoice,
  defaults: ProjectDefaults | undefined,
  roleDefaults: RoleDefaults,
  maxPermissionMode: PermissionMode | undefined,
): ComposerChoice {
  if (!defaults) return choice
  let next = choice
  for (const role of ROLES) {
    const picked = defaults[role]
    if (!picked) continue
    const effort = picked.effort ?? defaultEffortFor(picked, roleDefaults, role)
    next = setRoleModel(next, role, fitEffort(picked.provider, picked.model, effort), roleDefaults)
  }
  if (defaults.mode) next = { ...next, mode: defaults.mode }
  if (defaults.permissionMode)
    next = {
      ...next,
      permissionMode: maxPermissionMode
        ? clampPermissionMode(defaults.permissionMode, maxPermissionMode)
        : defaults.permissionMode,
    }
  return next
}
