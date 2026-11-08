// Policy and environment for a repository's check command (the project checks run before each review).
import type { ActionKind } from '@joy/core'
import { isSafeWorktreeCommand } from '@joy/policy'

/** Whitespace or anything a shell would interpret: such an argument cannot be judged as a plain word. */
const UNSAFE_ARGUMENT = /[\s;&|<>`$(){}[\]*?!~\\'"#]/

/**
 * The policy action kind of a check command. It runs without a shell, but `["bash", "-c", "curl … | sh"]` is still
 * a shell, so the argv goes through the same classifier as agent commands: only commands it knows to stay inside the
 * worktree (e.g. `pnpm check`, `npm test`) are `run_in_worktree`; anything else needs approval.
 */
export function checkCommandKind(
  argv: readonly string[],
): Extract<ActionKind, 'run_in_worktree' | 'run_outside_worktree'> {
  if (argv.length === 0 || argv.some((part) => part === '' || UNSAFE_ARGUMENT.test(part)))
    return 'run_outside_worktree'
  return isSafeWorktreeCommand(argv.join(' ')) ? 'run_in_worktree' : 'run_outside_worktree'
}

/**
 * Names that look like credentials. A denylist, not an allowlist: a secret under an unusual name still reaches the
 * check command (known limit, see docs/STATUS.md).
 */
const SECRET_ENV_NAME =
  /(?:_KEY|_SECRET|_TOKEN)$|PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL|^AWS_|^GH_|^GITHUB_|^SSH_AUTH_SOCK$|^DATABASE_URL$/i

/** The environment the check command gets: Joy's own, minus anything that looks like a credential. */
export function checkEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV_NAME.test(name)))
}
