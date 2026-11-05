import type { ModelRef, ProviderKind, Role } from '@joy/core'
import { ROLES } from '@joy/core'

export interface DisallowedRoleProvider {
  role: Role
  provider: ProviderKind
}

/** Returns selected roles whose provider is not enabled for the repository. */
export function findDisallowedRoleProviders(
  selectedRoles: Partial<Record<Role, ModelRef>>,
  allowedProviders: readonly ProviderKind[],
): DisallowedRoleProvider[] {
  return ROLES.flatMap((role) => {
    const selection = selectedRoles[role]
    return selection && !allowedProviders.includes(selection.provider)
      ? [{ role, provider: selection.provider }]
      : []
  })
}

export function describeDisallowedRoleProvider(
  { role, provider }: DisallowedRoleProvider,
  options: { resuming?: boolean } = {},
): string {
  const updateAllowlist =
    'update the repository allowlist with PATCH /api/repos/{repoId} and a JSON body shaped like {"allowedProviders":["openai-api","claude-cli"]}, replacing the list with providers permitted for this repository'
  const nextStep = options.resuming
    ? `The saved task's provider is fixed; ${updateAllowlist} to include this provider, or create a new task with an allowed provider.`
    : `Select an allowed provider, or ${updateAllowlist}.`
  return `Role "${role}" selects provider "${provider}", which is not allowed for this repository. ${nextStep}`
}
