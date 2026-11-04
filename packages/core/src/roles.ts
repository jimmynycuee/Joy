import type { ModelRef } from './provider.js'

export const ROLES = [
  'assistant_brain',
  'background',
  'orchestrator',
  'implementer',
  'reviewer',
  'judge',
] as const
export type Role = (typeof ROLES)[number]

export type RoleConfig = Record<Role, ModelRef>

/** Per-task overrides win over the global config. */
export function resolveRole(role: Role, config: RoleConfig, overrides: Partial<RoleConfig> = {}): ModelRef {
  return overrides[role] ?? config[role]
}

/** True when two roles would be served by the same backend, i.e. a "cross-model" review is not cross-model. */
export function sameBackend(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model
}
