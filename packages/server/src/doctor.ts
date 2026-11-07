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
/** The repair text of a check that needs nothing (callers compare against it). */
export const NO_ACTION_NEEDED = '不需要處理。'
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
      summary: '無法辨識目前執行的 Node.js 版本。',
      repair: '安裝 Node.js 22.13.0 以上版本，然後重新啟動 Joy。',
    }
  }
  const detected = parsed.join('.')
  if (compareVersions(parsed, MIN_NODE_VERSION) < 0) {
    return {
      id,
      label,
      status: 'missing',
      version: detected,
      summary: `Node.js ${detected} 低於 Joy 要求的版本（22.13.0）。`,
      repair: '升級到 Node.js 22.13.0 以上版本，然後重新啟動 Joy。',
    }
  }
  return {
    id,
    label,
    status: 'ok',
    version: detected,
    summary: `Node.js ${detected} 符合 Joy 要求的版本。`,
    repair: NO_ACTION_NEEDED,
  }
}

async function checkGit(runCommand: DoctorCommandRunner): Promise<DoctorCheck> {
  const result = await safeRunCommand(runCommand, 'git', ['--version'], true)
  if (result.spawnErrorCode === 'ENOENT') {
    return {
      id: 'git',
      label: 'Git',
      status: 'missing',
      summary: 'PATH 上找不到 Git。',
      repair: '安裝 Git，並確認 PATH 上可以執行 `git` 指令。',
    }
  }
  const version = result.exitCode === 0 ? parseGitVersion(result.output ?? '') : undefined
  if (version) {
    return {
      id: 'git',
      label: 'Git',
      status: 'ok',
      version,
      summary: `Git ${version} 可以使用。`,
      repair: NO_ACTION_NEEDED,
    }
  }
  return {
    id: 'git',
    label: 'Git',
    status: 'untested',
    summary: '無法確認 Git 是否可用或其版本。',
    repair: '安裝或修復 Git，然後確認 `git --version` 可以成功執行。',
  }
}

async function checkGitHubAuth(runCommand: DoctorCommandRunner): Promise<DoctorCheck> {
  const result = await safeRunCommand(runCommand, 'gh', ['auth', 'status', '--hostname', 'github.com'], false)
  if (result.spawnErrorCode === 'ENOENT') {
    return {
      id: 'gh-auth',
      label: 'GitHub CLI 登入',
      status: 'missing',
      summary: 'GitHub CLI 未安裝，或 PATH 上找不到。',
      repair: '安裝 GitHub CLI，然後執行 `gh auth login --hostname github.com`。',
    }
  }
  if (result.exitCode === 0) {
    return {
      id: 'gh-auth',
      label: 'GitHub CLI 登入',
      status: 'ok',
      summary: 'GitHub CLI 已登入。',
      repair: NO_ACTION_NEEDED,
    }
  }
  return {
    id: 'gh-auth',
    label: 'GitHub CLI 登入',
    status: 'untested',
    summary: '無法確認 GitHub CLI 是否已登入。',
    repair: '執行 `gh auth login --hostname github.com` 後再檢查一次；網路問題也可能讓這項無法判斷。',
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
      summary: `${label} CLI 以 Windows 指令 shim 安裝；Joy 不透過 shell 就無法檢查它的版本。`,
      repair: '不需要重新安裝；這個 Windows shim 的版本仍未檢查。',
    }
  }
  if (result.spawnErrorCode === 'ENOENT') {
    return {
      id,
      label: `${label} CLI`,
      status: 'missing',
      summary: `${label} CLI 未安裝，或 PATH 上找不到。`,
      repair: `安裝 ${label} CLI，或在 Joy 的 provider 設定中指定它的執行檔路徑。`,
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
      summary: `${label} CLI ${check.version} 是測試過的版本。`,
      repair: NO_ACTION_NEEDED,
    }
  if (check?.status === 'untested')
    return {
      id,
      label: `${label} CLI`,
      status: 'untested',
      version: check.version,
      summary: `${label} CLI ${check.version} 尚未和 Joy 一起測試過，輸出格式可能已經改變。`,
      repair: `安裝測試過的版本；或用 \`${recordCommand(label)}\` 重新錄製 contract fixture、執行 \`pnpm test\`，並更新 TESTED_CLI_VERSIONS。`,
    }
  return {
    id,
    label: `${label} CLI`,
    status: 'untested',
    summary: `無法確認 ${label} CLI 是否安裝或其版本。`,
    repair: `安裝或修復 ${label} CLI，然後確認它的 \`--version\` 指令可以成功執行。`,
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
      label: 'WSL（給 Codex 用）',
      status: 'missing',
      summary: 'WSL 未安裝，或沒有 Linux 發行版。',
      repair:
        '只有 Codex 無法直接在 Windows 上執行時才需要：執行 `wsl --install`，在 WSL 內安裝 Codex，然後設定 providers.codex.wsl: true 與 transport: exec。',
    }
  const codex = await safeRunCommand(runCommand, 'wsl.exe', ['-e', 'codex', '--version'], true)
  const version = codex.exitCode === 0 ? parseCliVersion(codex.output ?? '') : undefined
  return version
    ? {
        id: 'wsl',
        label: 'WSL（給 Codex 用）',
        status: 'ok',
        version,
        summary: `WSL 內可以使用 Codex ${version}。`,
        repair: '不需要處理。要使用它，請設定 providers.codex.wsl: true（並設 transport: exec）。',
      }
    : {
        id: 'wsl',
        label: 'WSL（給 Codex 用）',
        status: 'untested',
        summary: 'WSL 可以使用，但裡面沒有安裝 Codex。',
        repair:
          '如果想讓 Joy 透過 WSL 使用 Codex，請在 WSL 內執行 `npm install -g @openai/codex` 與 `codex login`。',
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
      label: '系統鑰匙圈',
      status: 'ok',
      summary: '系統鑰匙圈回應了一次不存在帳號的可用性查詢。',
      repair: NO_ACTION_NEEDED,
    }
  } catch {
    return {
      id: 'keychain',
      label: '系統鑰匙圈',
      status: 'missing',
      summary: 'Joy 無法存取系統鑰匙圈。',
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
        label: 'Joy 資料目錄',
        status: 'ok',
        summary: 'Joy 可以寫入它的資料目錄。',
        repair: NO_ACTION_NEEDED,
      }
    : {
        id: 'data-directory',
        label: 'Joy 資料目錄',
        status: 'missing',
        summary: 'Joy 資料目錄不存在或無法寫入。',
        repair:
          'Joy 啟動 server 時會自動建立資料目錄。如果目錄已存在但無法寫入，請修正權限，或把 JOY_HOME 設成可寫入的資料夾，然後重新啟動 Joy。',
      }
}

function recordCommand(label: 'Claude Code' | 'Codex'): string {
  return `node scripts/record-fixtures.mjs ${label === 'Claude Code' ? 'claude' : 'codex'}`
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
  if (platform === 'darwin') return '解鎖 macOS 的登入鑰匙圈並允許 Joy 存取，然後再檢查一次。'
  if (platform === 'win32')
    return '登入 Windows 並確認認證管理員（Credential Manager）可以使用，然後再檢查一次。'
  if (platform === 'linux')
    return '啟動並解鎖 Secret Service（例如 GNOME Keyring 或 KWallet），然後再檢查一次。'
  return '為這個使用者啟用作業系統的憑證儲存區，然後再檢查一次。'
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
