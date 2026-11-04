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

export function describeDisallowedRoleProvider({ role, provider }: DisallowedRoleProvider): string {
  return `Role "${role}" selects provider "${provider}", which is not allowed for this repository. Select an allowed provider or update the repository's allowed providers.`
}
