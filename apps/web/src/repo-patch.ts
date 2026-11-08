import { PROVIDER_KINDS } from '@joy/core'
import type { ProviderKind } from '@joy/core'
import { formatCheckCommand, parseCheckCommand } from './check-command.js'
import type { Repo } from './types.js'

/** What changed in the form, in the shape `PATCH /api/repos/:id` takes (null clears a field). */
export function repoPatch(
  repo: Repo,
  form: { githubRemote: string; providers: readonly ProviderKind[]; checkCommand: string },
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
  return patch
}
