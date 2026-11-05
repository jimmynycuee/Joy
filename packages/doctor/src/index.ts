import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { open, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigStore, defaultConfig, joyHome, resolvePaths } from '@joy/config'
import type { SecretBackend } from '@joy/secrets'
import { KeychainBackend } from '@joy/secrets'

export type DoctorStatus = 'ok' | 'missing' | 'untested'

export type DoctorCheckId =
  | 'node'
  | 'git'
  | 'gh-installation'
  | 'gh-authentication'
  | 'claude-cli'
  | 'codex-cli'
  | 'keychain'
  | 'data-directory'

export interface DoctorCheck {
  id: DoctorCheckId
  label: string
  status: DoctorStatus
  detail: string
  repair?: string
}

export interface DoctorReport {
  checkedAt: string
  checks: DoctorCheck[]
}

export interface DoctorCommandResult {
  code: number | null
  stdout: string
  timedOut: boolean
  failedToStart: boolean
}

export interface DoctorCommandOptions {
  timeoutMs: number
}

export type DoctorCommandRunner = (
  command: string,
  args: readonly string[],
  options: DoctorCommandOptions,
) => Promise<DoctorCommandResult>

export interface DoctorOptions {
  /** Defaults to JOY_HOME, or ~/.joy. */
  home?: string
  /** Executable overrides; Claude and Codex also honor providers.*.command from Joy config. */
  commands?: Partial<Record<'git' | 'gh' | 'claude' | 'codex', string>>
  env?: NodeJS.ProcessEnv
  /** Injectable for tests; defaults to spawn with shell disabled and bounded output/time. */
  commandRunner?: DoctorCommandRunner
  /** Injectable keychain backend; the doctor only queries a unique, nonexistent probe name. */
  keychain?: Pick<SecretBackend, 'get'>
  /** Optional probe override, called with the backend and unique probe entry name. */
  keychainProbe?: (keychain: Pick<SecretBackend, 'get'>, probeName: string) => Promise<void>
  /** Injectable filesystem probe; defaults to directory creation and a unique temp-file write. */
  dataDirectoryProbe?: (directory: string) => Promise<void>
  /** Optional directory override for tests and portable installations. */
  dataDirectory?: string
  /** Injectable Node version for tests. */
  nodeVersion?: string
  /** Maximum duration for each external command. Defaults to 5 seconds. */
  timeoutMs?: number
  /** Injectable clock for deterministic reports. */
  now?: () => Date
}

const MIN_NODE = { major: 22, minor: 13 }
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_CAPTURED_STDOUT = 16 * 1024
const KEYCHAIN_REPAIR =
  'Unlock the OS credential store. On macOS, allow Joy in the Keychain prompt; on Linux, unlock GNOME Keyring or KWallet; on Windows, confirm the current account can use Credential Manager.'

/** Runs independent environment checks without allowing a failed optional CLI to stop startup. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env
  const home = options.home ?? joyHome(env)
  const paths = resolvePaths(defaultConfig(), home)
  const dataDirectory = options.dataDirectory ?? home
  const commandRunner = options.commandRunner ?? runCommand
  const keychain = options.keychain ?? new KeychainBackend()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const needsConfigCommands = options.commands?.claude === undefined || options.commands?.codex === undefined
  const configCommands: { claude?: string; codex?: string; unavailable: boolean } = needsConfigCommands
    ? await readConfiguredCliCommands(paths.config)
    : { unavailable: false }
  const configuredClaude = options.commands?.claude ?? configCommands.claude
  const configuredCodex = options.commands?.codex ?? configCommands.codex
  const configUnavailable = configCommands.unavailable

  const checks = await Promise.all([
    Promise.resolve(checkNodeVersion(options.nodeVersion ?? process.version)),
    checkCommand({
      id: 'git',
      label: 'Git',
      command: options.commands?.git ?? 'git',
      args: ['--version'],
      runner: commandRunner,
      timeoutMs,
      success: (result) => {
        const version = extractVersion('git', result.stdout)
        return { detail: version ? `Git ${version} is installed.` : 'Git is installed.' }
      },
      repair: 'Install Git and ensure the git command is available on PATH.',
    }),
    checkCommand({
      id: 'gh-installation',
      label: 'GitHub CLI',
      command: options.commands?.gh ?? 'gh',
      args: ['--version'],
      runner: commandRunner,
      timeoutMs,
      success: (result) => {
        const version = extractVersion('gh', result.stdout)
        return { detail: version ? `GitHub CLI ${version} is installed.` : 'GitHub CLI is installed.' }
      },
      repair: 'Install GitHub CLI (gh) and ensure gh is available on PATH.',
    }),
    checkCommand({
      id: 'gh-authentication',
      label: 'GitHub CLI authentication',
      command: options.commands?.gh ?? 'gh',
      args: ['auth', 'status'],
      runner: commandRunner,
      timeoutMs,
      success: () => ({ detail: 'GitHub CLI authentication is available.' }),
      failure: 'GitHub CLI is installed but is not authenticated, or its authentication check failed.',
      repair: 'Run `gh auth login` and complete the sign-in flow.',
    }),
    checkCliVersion({
      id: 'claude-cli',
      label: 'Claude Code',
      command: configuredClaude ?? 'claude',
      displayName: 'Claude Code',
      versionKind: 'claude',
      runner: commandRunner,
      timeoutMs,
      configUnavailable: configUnavailable && configuredClaude === undefined,
    }),
    checkCliVersion({
      id: 'codex-cli',
      label: 'Codex CLI',
      command: configuredCodex ?? 'codex',
      displayName: 'Codex CLI',
      versionKind: 'codex',
      runner: commandRunner,
      timeoutMs,
      configUnavailable: configUnavailable && configuredCodex === undefined,
    }),
    checkKeychain(keychain, options.keychainProbe),
    checkDataDirectory(dataDirectory, options.dataDirectoryProbe),
  ])

  return { checkedAt: (options.now ?? (() => new Date()))().toISOString(), checks }
}

function checkNodeVersion(version: string): DoctorCheck {
  const parsed = /^(?:v)?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
  const major = parsed?.[1] === undefined ? NaN : Number(parsed[1])
  const minor = parsed?.[2] === undefined ? NaN : Number(parsed[2])
  const meetsMinimum = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)
  if (meetsMinimum) {
    return {
      id: 'node',
      label: 'Node.js',
      status: 'ok',
      detail: `Node.js ${version} meets the >=22.13 requirement.`,
    }
  }
  return {
    id: 'node',
    label: 'Node.js',
    status: 'missing',
    detail: `Node.js ${version} does not meet the >=22.13 requirement.`,
    repair: 'Install Node.js 22.13 or newer and restart Joy.',
  }
}

interface CheckCommandInput {
  id: DoctorCheckId
  label: string
  command: string
  args: string[]
  runner: DoctorCommandRunner
  timeoutMs: number
  success: (result: DoctorCommandResult) => { detail: string; status?: DoctorStatus }
  failure?: string
  repair: string
}

async function checkCommand(input: CheckCommandInput): Promise<DoctorCheck> {
  try {
    const result = await input.runner(input.command, input.args, { timeoutMs: input.timeoutMs })
    if (result.code === 0 && !result.timedOut && !result.failedToStart) {
      const success = input.success(result)
      return {
        id: input.id,
        label: input.label,
        status: success.status ?? 'ok',
        detail: success.detail,
      }
    }
  } catch {
    // Each probe reports its own generic repair guidance; command errors may contain sensitive output.
  }
  return {
    id: input.id,
    label: input.label,
    status: 'missing',
    detail: input.failure ?? `${input.label} is not available or its check failed.`,
    repair: input.repair,
  }
}

interface CheckCliInput {
  id: 'claude-cli' | 'codex-cli'
  label: string
  command: string
  displayName: string
  versionKind: 'claude' | 'codex'
  runner: DoctorCommandRunner
  timeoutMs: number
  configUnavailable: boolean
}

async function checkCliVersion(input: CheckCliInput): Promise<DoctorCheck> {
  if (input.configUnavailable) {
    return {
      id: input.id,
      label: input.label,
      status: 'untested',
      detail: 'Joy configuration could not be read, so the configured executable is unknown.',
      repair: 'Fix ~/.joy/config.yaml and run `joy doctor` again.',
    }
  }
  return checkCommand({
    id: input.id,
    label: input.label,
    command: input.command,
    args: ['--version'],
    runner: input.runner,
    timeoutMs: input.timeoutMs,
    success: (result) => {
      const version = extractVersion(input.versionKind, result.stdout)
      const versionText = version ? ` Version ${version} was reported.` : ''
      return {
        status: 'untested',
        detail: `${input.displayName} responds to --version.${versionText} Joy has no verified supported-version range.`,
      }
    },
    repair: `Install ${input.displayName} and ensure its command is available on PATH, or set its command in ~/.joy/config.yaml.`,
  })
}

async function checkKeychain(
  keychain: Pick<SecretBackend, 'get'>,
  probe: DoctorOptions['keychainProbe'],
): Promise<DoctorCheck> {
  const probeName = `joy-doctor-probe-${randomUUID()}`
  try {
    if (probe) await probe(keychain, probeName)
    else await keychain.get(probeName)
    return { id: 'keychain', label: 'OS keychain', status: 'ok', detail: 'The OS keychain is accessible.' }
  } catch {
    return {
      id: 'keychain',
      label: 'OS keychain',
      status: 'missing',
      detail: 'Joy could not access the OS keychain.',
      repair: KEYCHAIN_REPAIR,
    }
  }
}

async function checkDataDirectory(
  directory: string,
  probe: DoctorOptions['dataDirectoryProbe'],
): Promise<DoctorCheck> {
  try {
    if (probe) await probe(directory)
    else await probeWritableDirectory(directory)
    return {
      id: 'data-directory',
      label: 'Joy data directory',
      status: 'ok',
      detail: `Joy can create and write to ${directory}.`,
    }
  } catch {
    return {
      id: 'data-directory',
      label: 'Joy data directory',
      status: 'missing',
      detail: `Joy could not create or write to ${directory}.`,
      repair: `Grant the current user write access to ${directory}, or set JOY_HOME to a writable directory.`,
    }
  }
}

async function readConfiguredCliCommands(
  configPath: string,
): Promise<{ claude?: string; codex?: string; unavailable: boolean }> {
  try {
    const config = await new ConfigStore(configPath).get()
    return {
      ...(config.providers.claude.command ? { claude: config.providers.claude.command } : {}),
      ...(config.providers.codex.command ? { codex: config.providers.codex.command } : {}),
      unavailable: false,
    }
  } catch {
    return { unavailable: true }
  }
}

async function probeWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  const probePath = join(directory, `.joy-doctor-${randomUUID()}.tmp`)
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(probePath, 'wx', 0o600)
    await file.writeFile('Joy doctor write probe\n')
  } finally {
    await file?.close().catch(() => {})
    await unlink(probePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: DoctorCommandOptions,
): Promise<DoctorCommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const result = (code: number | null, timedOut = false, failedToStart = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, timedOut, failedToStart })
    }
    let child: ReturnType<typeof spawn> | undefined
    const timer = setTimeout(() => {
      child?.kill()
      result(null, true)
    }, options.timeoutMs)
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      result(null, false, true)
      return
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length >= MAX_CAPTURED_STDOUT) return
      stdout += chunk.toString().slice(0, MAX_CAPTURED_STDOUT - stdout.length)
    })
    child.on('error', () => result(null, false, true))
    child.on('close', (code) => result(code))
  })
}

function extractVersion(kind: 'git' | 'gh' | 'claude' | 'codex', output: string): string | undefined {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const patterns: Record<typeof kind, RegExp> = {
    git: /^git version v?(\d+\.\d+\.\d+)/i,
    gh: /^gh version v?(\d+\.\d+\.\d+)/i,
    claude: /^(?:Claude Code(?: CLI)?\s+v?(\d+\.\d+\.\d+)|(\d+\.\d+\.\d+)\s+\(Claude Code\))/i,
    codex: /^(?:codex(?:-cli)?\s+v?(\d+\.\d+\.\d+)|(\d+\.\d+\.\d+)\s+\(Codex\))/i,
  }
  const match = patterns[kind].exec(firstLine)
  return match?.[1] ?? match?.[2]
}
