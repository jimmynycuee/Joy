// Installing a fresh worktree's dependencies from its lockfile before the agent starts. Without it, the first thing
// every agent does is `pnpm install`, which needs the network (outside Codex's sandbox) and so an approval.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './run.js'
import type { RunCommandInput, RunCommandResult } from './run.js'

export type PackageManager = 'pnpm' | 'npm' | 'yarn'

export interface DependencyInstall {
  manager: PackageManager
  lockfile: string
  /** Program and arguments, started without a shell. */
  command: string
  args: string[]
}

/**
 * Installs exactly what the lockfile says and fails instead of changing it, so the agent starts from the
 * dependencies the branch was committed with. pnpm first: a repository with several lockfiles is usually migrating.
 */
const INSTALLS: readonly DependencyInstall[] = [
  { manager: 'pnpm', lockfile: 'pnpm-lock.yaml', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
  { manager: 'npm', lockfile: 'package-lock.json', command: 'npm', args: ['ci'] },
  { manager: 'yarn', lockfile: 'yarn.lock', command: 'yarn', args: ['install', '--frozen-lockfile'] },
]

/** The install for the lockfile at the top of `dir`, or undefined when there is none. */
export function dependencyInstall(
  dir: string,
  exists: (path: string) => boolean = existsSync,
): DependencyInstall | undefined {
  return INSTALLS.find((install) => exists(join(dir, install.lockfile)))
}

export interface InstallDependenciesOptions {
  signal?: AbortSignal
  /** Default 10 minutes. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /**
   * How to start the package manager without a shell (on Windows, npm and pnpm are `.cmd` shims that Node cannot
   * spawn directly). Default: unchanged.
   */
  resolve?: (command: string) => { command: string; prefix: string[] }
  /** Replaceable in tests. */
  run?: (input: RunCommandInput) => Promise<RunCommandResult>
  exists?: (path: string) => boolean
}

export type InstallDependenciesResult =
  | { status: 'none' }
  | {
      status: 'installed' | 'failed'
      manager: PackageManager
      /** As the owner would type it. */
      command: string
      exitCode: number | null
      timedOut: boolean
      /** The end of the output, for a failure. */
      outputTail: string
      durationMs: number
      spawnError?: string
    }

/** Runs the lockfile install in `dir`. Never throws: a failed install is reported, and the agent can still try. */
export async function installDependencies(
  dir: string,
  options: InstallDependenciesOptions = {},
): Promise<InstallDependenciesResult> {
  const install = dependencyInstall(dir, options.exists)
  if (!install) return { status: 'none' }
  const resolved = options.resolve?.(install.command) ?? { command: install.command, prefix: [] }
  const startedAt = Date.now()
  const result = await (options.run ?? runCommand)({
    command: resolved.command,
    args: [...resolved.prefix, ...install.args],
    cwd: dir,
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    maxOutputChars: 8_000,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.env ? { env: options.env } : {}),
  })
  const ok = result.exitCode === 0 && !result.timedOut && !result.spawnError
  return {
    status: ok ? 'installed' : 'failed',
    manager: install.manager,
    command: [install.command, ...install.args].join(' '),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTail: ok ? '' : result.output.slice(-4_000),
    durationMs: Date.now() - startedAt,
    ...(result.spawnError ? { spawnError: result.spawnError } : {}),
  }
}
