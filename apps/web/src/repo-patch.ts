import { PROVIDER_KINDS } from '@joy/core'
import type { PermissionMode, ProviderKind } from '@joy/core'
import { formatCheckCommand, parseCheckCommand } from './check-command.js'
import type { RepoColorId } from './repo-colors.js'
import { sameDefaults } from './project-defaults.js'
import type { ProjectDefaults, Repo } from './types.js'

/** What changed in the form, in the shape `PATCH /api/repos/:id` takes (null clears a field). */
export function repoPatch(
  repo: Repo,
  form: {
    githubRemote: string
    providers: readonly ProviderKind[]
    checkCommand: string
    /** null is "automatic". */
    color: RepoColorId | null
    /** null is "no limit"; left out, the field is not part of the form. */
    maxPermissionMode?: PermissionMode | null
    /** The project instructions text; left out, the field is not part of the form. */
    instructions?: string
    /** The install command as typed; empty means the lockfile install. Left out, not part of the form. */
    installCommand?: string
    /** No field set means no defaults. Left out, not part of the form. */
    defaults?: ProjectDefaults
  },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const remote = form.githubRemote.trim()
  if (remote !== (repo.githubRemote ?? '')) patch.githubRemote = remote || null
  const current = repo.allowedProviders ?? [...PROVIDER_KINDS]
  const chosen = PROVIDER_KINDS.filter((kind) => form.providers.includes(kind))
  if (chosen.length !== current.length || chosen.some((kind) => !current.includes(kind)))
    patch.allowedProviders = chosen
  const argv = parseCheckCommand(form.checkCommand)
  if ((argv?.join(' ') ?? '') !== formatCheckCommand(repo.checkCommand)) patch.checkCommand = argv
  if (form.color !== (repo.color ?? null)) patch.color = form.color
  if (form.maxPermissionMode !== undefined && form.maxPermissionMode !== (repo.maxPermissionMode ?? null))
    patch.maxPermissionMode = form.maxPermissionMode
  if (form.instructions !== undefined && form.instructions.trim() !== (repo.instructions ?? ''))
    patch.instructions = form.instructions.trim() || null
  if (form.installCommand !== undefined) {
    const install = parseCheckCommand(form.installCommand)
    if ((install?.join(' ') ?? '') !== formatCheckCommand(repo.installCommand)) patch.installCommand = install
  }
  if (form.defaults !== undefined && !sameDefaults(form.defaults, repo.defaults))
    patch.defaults = Object.keys(form.defaults).length > 0 ? form.defaults : null
  return patch
}
