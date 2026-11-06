import { checkCliVersion, parseCliVersion } from '@joy/providers'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { open, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { KeychainBackend } from '@joy/secrets'

export type DoctorStatus = 'ok' | 'missing' | 'untested'

export interface DoctorCheck {
  id: 'node' | 'git' | 'gh-auth' | 'claude-cli' | 'codex-cli' | 'keychain' | 'data-directory' | 'wsl'
  label: string
  status: DoctorStatus
  summary: string
  repair: string
  version?: string
}

export interface DoctorReport {
  checkedAt: string
  checks: DoctorCheck[]
}

export interface DoctorCommandResult {
  exitCode: number | null
  output?: string
  spawnErrorCode?: string
  commandFound?: boolean
  timedOut?: boolean
}

export type DoctorCommandRunner = (
  command: string,
  args: readonly string[],
  captureOutput: boolean,
) => Promise<DoctorCommandResult>

export type DoctorSpawnCommand = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface DoctorSystemCommandRunnerOptions {
  platform?: NodeJS.Platform
  searchPath?: string
  spawnCommand?: DoctorSpawnCommand
}

export interface DoctorOptions {
  home: string
  commands?: { claude?: string; codex?: string }
  nodeVersion?: string
  platform?: NodeJS.Platform
  now?: () => Date
  runCommand?: DoctorCommandRunner
  /** Receives a random, per-check keychain account name, never a credential name. */
  keychainLookup?: (account: string) => Promise<unknown>
}

const MIN_NODE_VERSION = [22, 13, 0] as const
const COMMAND_TIMEOUT_MS = 8_000
const MAX_VERSION_OUTPUT_LENGTH = 4_096

/** Runs local prerequisite checks without exposing command output or keychain values. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const runCommand = options.runCommand ?? createSystemCommandRunner()
  const checks = await Promise.all([
    checkNode(options.nodeVersion ?? process.versions.node),
    checkGit(runCommand),
    checkGitHubAuth(runCommand),
    checkOptionalCli('Claude Code', options.commands?.claude ?? 'claude', runCommand),
    checkOptionalCli('Codex', options.commands?.codex ?? 'codex', runCommand),
    checkKeychain(
      options.keychainLookup ?? lookupRandomKeychainAccount,
      options.platform ?? process.platform,
    ),
    checkDataDirectory(options.home),
    ...((options.platform ?? process.platform) === 'win32' ? [checkWsl(runCommand)] : []),
  ])
  return { checkedAt: (options.now ?? (() => new Date()))().toISOString(), checks }
}

function checkNode(version: string): DoctorCheck {
  const parsed = parseVersion(version)
  const id = 'node'
  const label = 'Node.js'
  if (!parsed) {
    return {
      id,
      label,
      status: 'untested',
      summary: 'The running Node.js version could not be identified.',
      repair: 'Install Node.js 22.13.0 or later, then restart Joy.',
    }
  }
  const detected = parsed.join('.')
  if (compareVersions(parsed, MIN_NODE_VERSION) < 0) {
    return {
      id,
      label,
      status: 'missing',
      version: detected,
      summary: `Node.js ${detected} is below Joy's declared runtime requirement (22.13.0).`,
      repair: 'Upgrade to Node.js 22.13.0 or later, then restart Joy.',
    }
  }
  return {
    id,
    label,
    status: 'ok',
    version: detected,
    summary: `Node.js ${detected} meets Joy's declared runtime requirement.`,
    repair: 'No action needed.',
  }
}

async function checkGit(runCommand: DoctorCommandRunner): Promise<DoctorCheck> {
  const result = await safeRunCommand(runCommand, 'git', ['--version'], true)
  if (result.spawnErrorCode === 'ENOENT') {
    return {
      id: 'git',
      label: 'Git',
      status: 'missing',
      summary: 'Git is not available on PATH.',
      repair: 'Install Git and ensure the `git` command is available on PATH.',
    }
  }
  const version = result.exitCode === 0 ? parseGitVersion(result.output ?? '') : undefined
  if (version) {
    return {
      id: 'git',
      label: 'Git',
      status: 'ok',
      version,
      summary: `Git ${version} is available.`,
      repair: 'No action needed.',
    }
  }
  return {
    id: 'git',
    label: 'Git',
    status: 'untested',
    summary: 'Git availability or version could not be verified.',
    repair: 'Install or repair Git, then confirm `git --version` succeeds.',
  }
}

async function checkGitHubAuth(runCommand: DoctorCommandRunner): Promise<DoctorCheck> {
  const result = await safeRunCommand(runCommand, 'gh', ['auth', 'status', '--hostname', 'github.com'], false)
  if (result.spawnErrorCode === 'ENOENT') {
    return {
      id: 'gh-auth',
      label: 'GitHub CLI sign-in',
      status: 'missing',
      summary: 'GitHub CLI is not installed or not available on PATH.',
      repair: 'Install GitHub CLI, then run `gh auth login --hostname github.com`.',
    }
  }
  if (result.exitCode === 0) {
    return {
      id: 'gh-auth',
      label: 'GitHub CLI sign-in',
      status: 'ok',
      summary: 'GitHub CLI authentication is available.',
      repair: 'No action needed.',
    }
  }
  return {
    id: 'gh-auth',
    label: 'GitHub CLI sign-in',
    status: 'untested',
    summary: 'GitHub CLI authentication could not be confirmed.',
    repair:
      'Run `gh auth login --hostname github.com`, then check again; a network issue can also make this inconclusive.',
  }
}

async function checkOptionalCli(
  label: 'Claude Code' | 'Codex',
  command: string,
  runCommand: DoctorCommandRunner,
): Promise<DoctorCheck> {
  const id = label === 'Claude Code' ? 'claude-cli' : 'codex-cli'
  const result = await safeRunCommand(runCommand, command, ['--version'], true)
  if (result.commandFound) {
    return {
      id,
      label: `${label} CLI`,
      status: 'untested',
      summary: `${label} CLI is installed as a Windows command shim; Joy could not check its version without invoking a shell.`,
      repair: 'No installation repair is needed; version detection for this Windows shim remains untested.',
    }
  }
  if (result.spawnErrorCode === 'ENOENT') {
    return {
      id,
      label: `${label} CLI`,
      status: 'missing',
      summary: `${label} CLI is not installed or not available on PATH.`,
      repair: `Install ${label} CLI or set its executable path in Joy's provider settings.`,
    }
  }
  const output = result.exitCode === 0 ? (result.output ?? '') : ''
  const check = output ? checkCliVersion(label === 'Claude Code' ? 'claude' : 'codex', output) : undefined
  if (check?.status === 'tested')
    return {
      id,
      label: `${label} CLI`,
      status: 'ok',
      version: check.version,
      summary: check.message,
      repair: 'No action needed.',
    }
  if (check?.status === 'untested')
    return {
      id,
      label: `${label} CLI`,
      status: 'untested',
      version: check.version,
      summary: check.message,
      repair: check.repair,
    }
  return {
    id,
    label: `${label} CLI`,
    status: 'untested',
    summary: `${label} CLI installation or version could not be verified.`,
    repair: `Install or repair ${label} CLI, then confirm its \`--version\` command succeeds.`,
  }
}

/** The CLI checks only, for the warning Joy logs at startup (T4.6). Returns the checks that need attention. */
export async function cliVersionWarnings(
  options: Pick<DoctorOptions, 'commands' | 'runCommand'> = {},
): Promise<DoctorCheck[]> {
  const runCommand = options.runCommand ?? createSystemCommandRunner()
  const checks = await Promise.all([
    checkOptionalCli('Claude Code', options.commands?.claude ?? 'claude', runCommand),
    checkOptionalCli('Codex', options.commands?.codex ?? 'codex', runCommand),
  ])
  return checks.filter((check) => check.status === 'untested' && check.version)
}

/** Windows only: whether Codex can run inside WSL, the fallback when it does not run natively (T4.4). */
async function checkWsl(runCommand: DoctorCommandRunner): Promise<DoctorCheck> {
  const wsl = await safeRunCommand(runCommand, 'wsl.exe', ['--status'], false)
  if (wsl.spawnErrorCode === 'ENOENT' || wsl.exitCode !== 0)
    return {
      id: 'wsl',
      label: 'WSL (for Codex)',
      status: 'missing',
      summary: 'WSL is not installed or has no Linux distribution.',
      repair:
        'Only needed when Codex does not run on Windows itself: run `wsl --install`, install Codex inside WSL, then set providers.codex.wsl: true and transport: exec.',
    }
  const codex = await safeRunCommand(runCommand, 'wsl.exe', ['-e', 'codex', '--version'], true)
  const version = codex.exitCode === 0 ? parseCliVersion(codex.output ?? '') : undefined
  return version
    ? {
        id: 'wsl',
        label: 'WSL (for Codex)',
        status: 'ok',
        version,
        summary: `Codex ${version} is available inside WSL.`,
        repair: 'No action needed. Set providers.codex.wsl: true (with transport: exec) to use it.',
      }
    : {
        id: 'wsl',
        label: 'WSL (for Codex)',
        status: 'untested',
        summary: 'WSL is available but Codex is not installed inside it.',
        repair:
          'Inside WSL run `npm install -g @openai/codex` and `codex login`, if you want Joy to use Codex through WSL.',
      }
}

async function checkKeychain(
  lookup: (account: string) => Promise<unknown>,
  platform: NodeJS.Platform,
): Promise<DoctorCheck> {
  try {
    // Looking up a fresh random account tests availability without touching stored credentials.
    await lookup(`joy-doctor-probe-${randomUUID()}`)
    return {
      id: 'keychain',
      label: 'OS keychain',
      status: 'ok',
      summary: 'The OS keychain responded to an empty, unique availability lookup.',
      repair: 'No action needed.',
    }
  } catch {
    return {
      id: 'keychain',
      label: 'OS keychain',
      status: 'missing',
      summary: 'The OS keychain could not be accessed by Joy.',
      repair: keychainGuidance(platform),
    }
  }
}

async function checkDataDirectory(home: string): Promise<DoctorCheck> {
  const probePath = join(home, `.joy-doctor-${randomUUID()}.tmp`)
  let probeCreated = false
  let writable: boolean
  let probeRemoved = true
  try {
    const info = await stat(home)
    if (!info.isDirectory()) throw new Error('not a directory')
    const probe = await open(probePath, 'wx', 0o600)
    probeCreated = true
    try {
      await probe.writeFile('Joy temporary write probe')
      writable = true
    } finally {
      await probe.close()
    }
  } catch {
    writable = false
  } finally {
    if (probeCreated) {
      try {
        await unlink(probePath)
      } catch (error) {
        probeRemoved = (error as NodeJS.ErrnoException).code === 'ENOENT'
      }
    }
  }
  return writable && probeRemoved
    ? {
        id: 'data-directory',
        label: 'Joy data directory',
        status: 'ok',
        summary: 'Joy can write to its data directory.',
        repair: 'No action needed.',
      }
    : {
        id: 'data-directory',
        label: 'Joy data directory',
        status: 'missing',
        summary: 'Joy data directory is missing or not writable.',
        repair:
          'Joy creates its data directory automatically when the server starts. If it already exists but is not writable, fix its permissions or set JOY_HOME to a writable folder, then restart Joy.',
      }
}

async function safeRunCommand(
  runCommand: DoctorCommandRunner,
  command: string,
  args: readonly string[],
  captureOutput: boolean,
): Promise<DoctorCommandResult> {
  try {
    return await runCommand(command, args, captureOutput)
  } catch {
    return { exitCode: null }
  }
}

async function lookupRandomKeychainAccount(account: string): Promise<unknown> {
  return new KeychainBackend().get(account)
}

function keychainGuidance(platform: NodeJS.Platform): string {
  if (platform === 'darwin')
    return 'Unlock the macOS login keychain and allow Joy to access it, then run the check again.'
  if (platform === 'win32')
    return 'Sign in to Windows and ensure Credential Manager is available, then run the check again.'
  if (platform === 'linux')
    return 'Start and unlock a Secret Service such as GNOME Keyring or KWallet, then run the check again.'
  return 'Enable the operating system credential store for this user, then run the check again.'
}

function parseGitVersion(output: string): string | undefined {
  const match = /\bgit version\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(output)
  return match?.[1]
}

function parseVersion(input: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(input.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(first: readonly number[], second: readonly number[]): number {
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export async function hasWindowsBatchShim(
  command: string,
  searchPath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (platform !== 'win32') return false

  const isBatchCommand = /\.(?:cmd|bat)$/i.test(command)
  const candidates = isBatchCommand ? [command] : [`${command}.cmd`, `${command}.bat`]
  if (/[\\/]/.test(command)) {
    for (const candidate of candidates) {
      if (await isFile(candidate)) return true
    }
    return false
  }

  for (const directory of searchPath.split(';').filter(Boolean)) {
    for (const candidate of candidates) {
      if (await isFile(join(directory, candidate))) return true
    }
  }
  return false
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function createSystemCommandRunner(
  options: DoctorSystemCommandRunnerOptions = {},
): DoctorCommandRunner {
  const platform = options.platform ?? process.platform
  const searchPath = options.searchPath ?? process.env.PATH ?? ''
  const spawnCommand = options.spawnCommand ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions))

  return async (command, args, captureOutput) => {
    const result = await spawnOnce(command, args, captureOutput, false)
    if (
      result.spawnErrorCode !== 'ENOENT' ||
      platform !== 'win32' ||
      !(await hasWindowsBatchShim(command, searchPath, platform))
    ) {
      return result
    }

    // npm's .cmd shims need cmd.exe; only the literal version probe is safe to pass through it.
    if (args.length !== 1 || args[0] !== '--version' || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      return { ...result, commandFound: true }
    }

    const retry = await spawnOnce(command, args, captureOutput, true)
    return retry.spawnErrorCode === 'ENOENT' ? { ...retry, commandFound: true } : retry
  }

  function spawnOnce(
    file: string,
    args: readonly string[],
    captureOutput: boolean,
    shell: boolean,
  ): Promise<DoctorCommandResult> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawnCommand(file, [...args], {
          shell,
          windowsHide: true,
          stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'ignore'],
        })
      } catch (error) {
        const spawnErrorCode = (error as NodeJS.ErrnoException).code
        resolve({ exitCode: null, ...(spawnErrorCode ? { spawnErrorCode } : {}) })
        return
      }

      let output = ''
      let timedOut = false
      let settled = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill()
      }, COMMAND_TIMEOUT_MS)
      const finish = (result: DoctorCommandResult) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(result)
      }
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        if (output.length < MAX_VERSION_OUTPUT_LENGTH) {
          output += chunk.slice(0, MAX_VERSION_OUTPUT_LENGTH - output.length)
        }
      })
      child.once('error', (error: NodeJS.ErrnoException) => {
        finish({ exitCode: null, ...(error.code ? { spawnErrorCode: error.code } : {}) })
      })
      child.once('close', (exitCode) => {
        finish({
          exitCode,
          ...(captureOutput ? { output } : {}),
          ...(timedOut ? { timedOut: true } : {}),
        })
      })
    })
  }
}
