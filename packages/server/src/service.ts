import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { UiBuildState } from './ui-build.js'

// `pnpm joy service install|uninstall|status`: runs Joy at login without a terminal. The files and commands for each
// operating system are planned by pure functions (`planService`), so tests check them without touching the system.

/** Seconds before the manager starts Joy again after it exits (a busy port would otherwise retry in a tight loop). */
const RESTART_DELAY_SECONDS = 30

/** The launchd label and the name used for the systemd unit and the Windows scheduled task. */
export const SERVICE_LABEL = 'com.joy.local'
/** systemd unit and Windows task name: specific enough not to replace an unrelated `joy` of the owner's. */
export const SERVICE_NAME = 'joy-local'
export const DEFAULT_SERVICE_PORT = 4317

/** An error whose message is written for the owner (Chinese) and is printed as is. */
export class ServiceError extends Error {}

export type ServiceAction = 'install' | 'uninstall' | 'status'

export interface ServiceCommand {
  command: string
  args: string[]
  /** A step that is allowed to fail (for example unloading a service that is not loaded). */
  ignoreFailure?: boolean
  /** Extra tries, a second apart, for a step that can race the one before it (launchd unloads in the background). */
  retries?: number
}

export interface ServiceFile {
  path: string
  content: string
  /** Windows scheduled-task XML must be UTF-16 with a byte order mark. */
  encoding?: 'utf8' | 'utf16le'
}

export interface ServicePlan {
  /** Human name of the service manager, for the printed summary. */
  manager: string
  files: ServiceFile[]
  install: ServiceCommand[]
  /** Run before the files are removed. */
  uninstall: ServiceCommand[]
  /** Run after the files are removed (systemd reloads its units). */
  afterUninstall: ServiceCommand[]
  status: ServiceCommand
  /** Where the service writes what it prints (empty when the manager does not redirect it). */
  logs: string[]
  /** Limits of this service manager the owner should know about, printed after an install. */
  notes: string[]
}

export interface PlanInput {
  platform: NodeJS.Platform
  /** Absolute path of a Node 22. */
  nodePath: string
  /** The Joy checkout (where scripts/joy.ts and node_modules are). */
  repoRoot: string
  /** Joy's data folder (`~/.joy`); logs go to its `logs` folder. */
  joyHome: string
  userHome: string
  port: number
  /** POSIX user id, for launchd's per-user domain. */
  uid?: number | undefined
  /** The environment variables the service needs; nothing else is copied (no secrets). */
  env?: {
    PATH?: string | undefined
    JOY_HOME?: string | undefined
    XDG_CONFIG_HOME?: string | undefined
    USERDOMAIN?: string | undefined
    USERNAME?: string | undefined
  }
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** What the service runs: `node --import tsx scripts/joy.ts start --port N`, with the checkout as working folder. */
function startArguments(input: PlanInput): string[] {
  const p = pathFor(input.platform)
  return [
    '--import',
    'tsx',
    p.join(input.repoRoot, 'scripts', 'joy.ts'),
    'start',
    '--port',
    String(input.port),
  ]
}

/**
 * PATH for the service. A login service does not get the terminal's PATH, but Joy starts `claude`, `codex`, `git` and
 * `gh` by name. So the PATH of the terminal that installs it is saved (the Node folder first), plus the usual
 * folders. Install again after installing a CLI somewhere new.
 */
export function servicePath(input: PlanInput): string {
  const p = pathFor(input.platform)
  const standard =
    input.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
      : ['/usr/local/bin', '/usr/bin', '/bin']
  const entries = [p.dirname(input.nodePath), ...(input.env?.PATH?.split(p.delimiter) ?? []), ...standard]
  // `pnpm` and `npx` put their own folders (node_modules/.bin, the npx cache) in front of PATH while they run.
  const lasting = entries.filter(
    (entry) =>
      entry && p.isAbsolute(entry) && !isTemporaryNodePath(entry) && !/[\\/]node_modules[\\/]/.test(entry),
  )
  return [...new Set(lasting)].join(p.delimiter)
}

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * A systemd unit value in double quotes with `\`, `"` and `%` escaped. `$` is expanded in ExecStart (command lines)
 * but not in Environment=, so only ExecStart escapes it.
 */
function systemdQuote(text: string, expandsDollar = false): string {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
  return `"${expandsDollar ? escaped.replaceAll('$', '$$$$') : escaped}"`
}

/** One argument of a Windows command line (the scheduled task's Arguments field). */
function windowsArgument(text: string): string {
  return /[\s"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text
}

function environmentVariables(input: PlanInput): Array<[string, string]> {
  return [
    ['PATH', servicePath(input)],
    // The data folder is only passed on when the installing terminal chose one.
    ...(input.env?.JOY_HOME ? ([['JOY_HOME', input.env.JOY_HOME]] as Array<[string, string]>) : []),
  ]
}

function launchdPlan(input: PlanInput): ServicePlan {
  const p = path.posix
  if (input.uid === undefined) throw new ServiceError('找不到目前使用者的 uid，無法設定 launchd。')
  const logs = p.join(input.joyHome, 'logs')
  const outLog = p.join(logs, 'service.out.log')
  const errLog = p.join(logs, 'service.err.log')
  const plistPath = p.join(input.userHome, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
  const programArguments = [input.nodePath, ...startArguments(input)]
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join('\n')
  const environment = environmentVariables(input)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n')
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${RESTART_DELAY_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`
  const domain = `gui/${input.uid}`
  const target = `${domain}/${SERVICE_LABEL}`
  return {
    manager: 'macOS launchd（登入時自動啟動，結束後自動重啟）',
    files: [{ path: plistPath, content }],
    // Unloading first lets an install over an older one pick up the new file.
    install: [
      { command: 'launchctl', args: ['bootout', target], ignoreFailure: true },
      { command: 'launchctl', args: ['bootstrap', domain, plistPath], retries: 3 },
    ],
    uninstall: [{ command: 'launchctl', args: ['bootout', target], ignoreFailure: true }],
    afterUninstall: [],
    status: { command: 'launchctl', args: ['print', target] },
    logs: [outLog, errLog],
    notes: [],
  }
}

function systemdPlan(input: PlanInput): ServicePlan {
  const p = path.posix
  const logs = p.join(input.joyHome, 'logs')
  const outLog = p.join(logs, 'service.out.log')
  const errLog = p.join(logs, 'service.err.log')
  const configHome = input.env?.XDG_CONFIG_HOME?.startsWith('/')
    ? input.env.XDG_CONFIG_HOME
    : p.join(input.userHome, '.config')
  const unitPath = p.join(configHome, 'systemd', 'user', `${SERVICE_NAME}.service`)
  for (const value of [input.nodePath, input.repoRoot, input.joyHome])
    if (/[\r\n]/.test(value)) throw new ServiceError('路徑不能含換行，無法寫進 systemd 設定。')
  const exec = [input.nodePath, ...startArguments(input)].map((part) => systemdQuote(part, true)).join(' ')
  const environment = environmentVariables(input)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join('\n')
  const content = `[Unit]
Description=Joy local server
After=network.target

[Service]
Type=simple
WorkingDirectory=${input.repoRoot.replaceAll('%', '%%')}
ExecStart=${exec}
${environment}
Restart=on-failure
RestartSec=${RESTART_DELAY_SECONDS}
StandardOutput=append:${outLog.replaceAll('%', '%%')}
StandardError=append:${errLog.replaceAll('%', '%%')}

[Install]
WantedBy=default.target
`
  const unit = `${SERVICE_NAME}.service`
  return {
    manager: 'Linux systemd 使用者服務（登入時自動啟動，失敗後自動重啟）',
    files: [{ path: unitPath, content }],
    // `restart` so an install over an older unit runs the new one.
    install: [
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', unit] },
      { command: 'systemctl', args: ['--user', 'restart', unit] },
    ],
    uninstall: [{ command: 'systemctl', args: ['--user', 'disable', '--now', unit], ignoreFailure: true }],
    afterUninstall: [{ command: 'systemctl', args: ['--user', 'daemon-reload'], ignoreFailure: true }],
    status: {
      command: 'systemctl',
      args: ['--user', 'show', unit, '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID'],
    },
    logs: [outLog, errLog],
    notes: [],
  }
}

function windowsPlan(input: PlanInput): ServicePlan {
  const p = path.win32
  const xmlPath = p.join(input.joyHome, 'service', 'joy-local-task.xml')
  const args = startArguments(input).map(windowsArgument).join(' ')
  const user =
    input.env?.USERNAME && input.env.USERDOMAIN ? `${input.env.USERDOMAIN}\\${input.env.USERNAME}` : undefined
  // The XML (not /TR) is used because it can lift the 72-hour run limit Task Scheduler gives a new task, set the
  // working folder and restart Joy when it exits. `conhost.exe --headless` runs node without a console window
  // (Windows 10 1903 or later); the task has no way to carry environment variables, so it runs with the user's own
  // environment from logon.
  const content = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Joy local server</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${user ? `\n      <UserId>${xmlEscape(user)}</UserId>` : ''}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${xmlEscape(`--headless ${windowsArgument(input.nodePath)} ${args}`)}</Arguments>
      <WorkingDirectory>${xmlEscape(input.repoRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
  return {
    manager: 'Windows 工作排程器（登入時自動啟動，失敗後自動重啟）',
    files: [{ path: xmlPath, content, encoding: 'utf16le' }],
    // `/End` first: a running task ignores `/Run` (IgnoreNew), so an install over an older one would keep the old Joy.
    install: [
      { command: 'schtasks', args: ['/End', '/TN', SERVICE_NAME], ignoreFailure: true },
      { command: 'schtasks', args: ['/Create', '/TN', SERVICE_NAME, '/XML', xmlPath, '/F'] },
      { command: 'schtasks', args: ['/Run', '/TN', SERVICE_NAME] },
    ],
    uninstall: [
      { command: 'schtasks', args: ['/End', '/TN', SERVICE_NAME], ignoreFailure: true },
      { command: 'schtasks', args: ['/Delete', '/TN', SERVICE_NAME, '/F'], ignoreFailure: true },
    ],
    afterUninstall: [],
    status: { command: 'schtasks', args: ['/Query', '/TN', SERVICE_NAME, '/FO', 'LIST', '/V'] },
    // Task Scheduler cannot redirect output without a shell; Joy's own log (~/.joy/logs) still has everything.
    logs: [],
    notes: [
      '這個工作在登入時用你的使用者環境執行：PATH 是 Windows 設定裡的使用者／系統 PATH，只在終端機臨時設定的 PATH 不會帶進來；`claude`、`codex`、`git`、`gh` 要在 Windows 的 PATH 裡。',
      ...(input.env?.JOY_HOME
        ? [
            `注意：你目前的 JOY_HOME（${input.env.JOY_HOME}）不會帶進工作排程器；服務會用預設資料夾。要用這個資料夾，請先在 Windows「使用者環境變數」設定 JOY_HOME 再重跑 install。`,
          ]
        : []),
      '隱藏視窗用 conhost.exe --headless（Windows 10 1903 以上）；這一點尚待實機驗證，若 Joy 沒有在登入後啟動，執行 pnpm joy service uninstall 後改用終端機 pnpm joy start。',
    ],
  }
}

/** The files and commands that install, remove and query the service on this operating system. */
export function planService(input: PlanInput): ServicePlan {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
    throw new ServiceError('--port 必須是 1 到 65535 的整數。')
  if (input.platform === 'darwin') return launchdPlan(input)
  if (input.platform === 'linux') return systemdPlan(input)
  if (input.platform === 'win32') return windowsPlan(input)
  throw new ServiceError(`不支援這個作業系統（${input.platform}）；請手動用 pnpm joy start 啟動。`)
}

// --- Finding a Node 22 that will still be there tomorrow ---

const NODE_MAJOR = 22
const NODE_MIN_MINOR = 13

/** Joy is built and tested on Node 22 (`.nvmrc`); 22.13 is the first with a usable node:sqlite. */
/**
 * Homebrew runs Node from a versioned Cellar folder (`/opt/homebrew/Cellar/node@22/22.23.5/bin/node`) that
 * `brew upgrade` deletes; its `opt` link (`/opt/homebrew/opt/node@22/bin/node`) survives upgrades.
 */
export function stableHomebrewPath(nodePath: string, deps: Pick<NodeSearchDeps, 'exists'>): string {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(nodePath)
  if (!match) return nodePath
  const stable = `${match[1]}/opt/${match[2]}/bin/node`
  return deps.exists(stable) ? stable : nodePath
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version.trim())
  return !!match && Number(match[1]) === NODE_MAJOR && Number(match[2]) >= NODE_MIN_MINOR
}

/**
 * A Node that lives in a cache the next `npx` or `pnpm dlx` may delete (what `npx -p node@22` runs): a service that
 * points at it breaks without warning.
 */
export function isTemporaryNodePath(nodePath: string, temporaryRoot = tmpdir()): boolean {
  const normalized = nodePath.replaceAll('\\', '/')
  if (/\/(_npx|dlx|dlx-[^/]*)\//.test(`${normalized}/`)) return true
  const temporary = temporaryRoot.replaceAll('\\', '/').replace(/\/+$/, '')
  return temporary.length > 1 && normalized.startsWith(`${temporary}/`)
}

export interface NodeSearchDeps {
  exists(path: string): boolean
  /** Names inside a folder; empty when it does not exist. */
  list(dir: string): string[]
  /** `node --version` of a binary; undefined when it cannot run. */
  version(nodePath: string): Promise<string | undefined>
}

export interface NodeSearchInput {
  platform: NodeJS.Platform
  userHome: string
  /** The Node running this command and its version. */
  execPath: string
  execVersion: string
  explicit?: string | undefined
  env?: Record<string, string | undefined>
}

export interface FoundNode {
  path: string
  version: string
  source: string
}

function noNodeMessage(platform: NodeJS.Platform): string {
  const install =
    platform === 'darwin'
      ? '在終端機執行 `brew install node@22`，再重跑這個指令（會自動找到 /opt/homebrew/opt/node@22/bin/node）'
      : platform === 'win32'
        ? '到 https://nodejs.org 安裝 Node 22 LTS（22.13 以上）後重跑這個指令'
        : '用套件管理員、nvm 或 fnm 安裝 Node 22（22.13 以上）後重跑這個指令'
  return [
    '找不到可以長期使用的 Node 22（22.13 以上、23 以前；Joy 只在 Node 22 測試過）。',
    '背景服務會一直用同一個 Node，所以不能用 npx 暫存裡的 Node（暫存隨時可能被清掉），也不能用系統裡別的大版本。請擇一：',
    `  1. ${install}`,
    '  2. 已經裝好的話，直接指定它的絕對路徑：pnpm joy service install --node <Node 22 的絕對路徑>',
  ].join('\n')
}

/** Node 22 versions installed under `<root>/<name>/...`, newest first (nvm, fnm, asdf layouts). */
function versionFolders(deps: NodeSearchDeps, root: string, tail: string[], p: path.PlatformPath): string[] {
  return deps
    .list(root)
    .map((name) => ({ name, match: /^v?(22)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter(
      (entry): entry is { name: string; match: RegExpExecArray } =>
        !!entry.match && Number(entry.match[2]) >= NODE_MIN_MINOR,
    )
    .sort((a, b) => Number(b.match[2]) - Number(a.match[2]) || Number(b.match[3]) - Number(a.match[3]))
    .map((entry) => p.join(root, entry.name, ...tail))
}

/**
 * The Node the service will run: the one named with `--node`, else the running one when it is a supported, lasting
 * install, else a Node 22 found in the usual places (Homebrew, nvm, fnm, asdf, system folders).
 */
export async function findServiceNode(input: NodeSearchInput, deps: NodeSearchDeps): Promise<FoundNode> {
  const p = pathFor(input.platform)
  const env = input.env ?? {}
  if (input.explicit !== undefined) {
    if (!p.isAbsolute(input.explicit))
      throw new ServiceError(`--node 要給絕對路徑，不能是 ${input.explicit}。`)
    if (isTemporaryNodePath(input.explicit))
      throw new ServiceError(
        `--node 指到暫存資料夾（${input.explicit}），它隨時可能被清掉；請指定長期安裝的 Node 22。`,
      )
    const version = deps.exists(input.explicit) ? await deps.version(input.explicit) : undefined
    if (!version) throw new ServiceError(`--node 指定的 ${input.explicit} 不存在或無法執行。`)
    if (!isSupportedNodeVersion(version))
      throw new ServiceError(
        `--node 指定的 Node 是 ${version.trim()}；Joy 需要 Node 22（22.13 以上、23 以前）。`,
      )
    return { path: input.explicit, version: version.trim(), source: '--node 參數' }
  }
  if (!isTemporaryNodePath(input.execPath) && isSupportedNodeVersion(input.execVersion))
    return {
      path: stableHomebrewPath(input.execPath, deps),
      version: input.execVersion,
      source: '目前執行的 Node',
    }

  const candidates: Array<{ path: string; source: string }> = []
  const add = (candidate: string, source: string) => candidates.push({ path: candidate, source })
  const nodeBinary = input.platform === 'win32' ? 'node.exe' : 'node'
  if (input.platform === 'win32') {
    for (const root of [env.ProgramFiles, env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs')])
      if (root) add(p.join(root, 'nodejs', nodeBinary), '標準安裝位置')
    if (env.NVM_HOME)
      for (const found of versionFolders(deps, env.NVM_HOME, [nodeBinary], p)) add(found, 'nvm-windows')
  } else {
    for (const prefix of ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew'])
      add(p.join(prefix, 'opt', 'node@22', 'bin', nodeBinary), 'Homebrew node@22')
    const nvmDir = env.NVM_DIR ?? p.join(input.userHome, '.nvm')
    for (const found of versionFolders(deps, p.join(nvmDir, 'versions', 'node'), ['bin', nodeBinary], p))
      add(found, 'nvm')
    const fnmRoots = [
      env.FNM_DIR,
      p.join(input.userHome, '.local', 'share', 'fnm'),
      p.join(input.userHome, 'Library', 'Application Support', 'fnm'),
    ]
    for (const root of fnmRoots)
      if (root)
        for (const found of versionFolders(
          deps,
          p.join(root, 'node-versions'),
          ['installation', 'bin', nodeBinary],
          p,
        ))
          add(found, 'fnm')
    for (const found of versionFolders(
      deps,
      p.join(input.userHome, '.asdf', 'installs', 'nodejs'),
      ['bin', nodeBinary],
      p,
    ))
      add(found, 'asdf')
    for (const folder of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])
      add(p.join(folder, nodeBinary), '系統資料夾')
  }
  for (const candidate of candidates) {
    if (!deps.exists(candidate.path) || isTemporaryNodePath(candidate.path)) continue
    const version = await deps.version(candidate.path)
    if (version && isSupportedNodeVersion(version))
      return { path: candidate.path, version: version.trim(), source: candidate.source }
  }
  throw new ServiceError(noNodeMessage(input.platform))
}

// --- Running a plan ---

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

/** Runs one program without a shell. */
export type ServiceRunner = (command: string, args: string[]) => Promise<RunResult>

export const runWithoutShell: ServiceRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { shell: false, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = (error as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code
        resolve({
          status: error ? (typeof code === 'number' ? code : null) : 0,
          stdout,
          stderr,
          ...(error && typeof code !== 'number' ? { error } : {}),
        })
      },
    )
  })

export interface ServiceDeps extends NodeSearchDeps {
  run: ServiceRunner
  mkdir(path: string, mode?: number): Promise<void>
  write(file: ServiceFile): Promise<void>
  sleep(ms: number): Promise<void>
  remove(path: string): Promise<void>
  /** Whether a Joy already answers on this port. */
  health(port: number): Promise<boolean>
  uiState(repoRoot: string): UiBuildState
  /**
   * Loads Joy's native modules with the service's Node; returns why that failed, or undefined when it works. A
   * `pnpm install` run under another Node (for example an x64 one from npx on an arm64 Mac) leaves only that
   * architecture's binding, and the service would crash on every start.
   */
  nativeCheck(nodePath: string, repoRoot: string): Promise<string | undefined>
  out(line: string): void
}

export interface ServiceOptions {
  platform: NodeJS.Platform
  userHome: string
  joyHome: string
  repoRoot: string
  port: number
  dryRun: boolean
  node?: string | undefined
  uid?: number | undefined
  execPath: string
  execVersion: string
  env?: Record<string, string | undefined>
}

function describeCommand(step: ServiceCommand): string {
  const text = [step.command, ...step.args].join(' ')
  return step.ignoreFailure ? `${text}   （失敗也沒關係）` : text
}

async function runSteps(steps: ServiceCommand[], deps: ServiceDeps): Promise<void> {
  for (const step of steps) {
    let result = await deps.run(step.command, step.args)
    for (let retry = 0; result.status !== 0 && retry < (step.retries ?? 0); retry++) {
      await deps.sleep(1_000)
      result = await deps.run(step.command, step.args)
    }
    if (result.status === 0 || step.ignoreFailure) continue
    const reason = result.error?.message ?? (result.stderr.trim() || `結束碼 ${String(result.status)}`)
    throw new ServiceError(
      `指令失敗：${[step.command, ...step.args].join(' ')}\n${reason}\n（已寫入的檔案還在；修好原因後重跑 install，或執行 uninstall 清掉。）`,
    )
  }
}

function planInput(options: ServiceOptions, nodePath: string): PlanInput {
  return {
    platform: options.platform,
    nodePath,
    repoRoot: options.repoRoot,
    joyHome: options.joyHome,
    userHome: options.userHome,
    port: options.port,
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
    ...(options.env ? { env: options.env } : {}),
  }
}

async function install(options: ServiceOptions, deps: ServiceDeps): Promise<number> {
  const p = pathFor(options.platform)
  const node = await findServiceNode(
    {
      platform: options.platform,
      userHome: options.userHome,
      execPath: options.execPath,
      execVersion: options.execVersion,
      explicit: options.node,
      ...(options.env ? { env: options.env } : {}),
    },
    deps,
  )
  if (!deps.exists(p.join(options.repoRoot, 'node_modules', 'tsx')))
    throw new ServiceError(`在 ${options.repoRoot} 找不到 node_modules；先在 Joy 資料夾執行 pnpm install。`)
  const nativeProblem = await deps.nativeCheck(node.path, options.repoRoot)
  if (nativeProblem) {
    const fix = [
      `這個 Node（${node.path}）載入不了 Joy 的原生模組，服務會一啟動就失敗：`,
      `  ${nativeProblem}`,
      '通常是 pnpm install 用了別的 Node（例如架構不同）。請用這個 Node 在 Joy 資料夾重跑 pnpm install，再重新安裝服務：',
      options.platform === 'win32'
        ? `  在 PATH 最前面加上 ${p.dirname(node.path)}，再執行 npx -y pnpm@10.28.0 install`
        : `  PATH=${p.dirname(node.path)}:$PATH npx -y pnpm@10.28.0 install`,
    ].join('\n')
    if (!options.dryRun) throw new ServiceError(fix)
    deps.out(fix)
    deps.out('')
  }
  const plan = planService(planInput(options, node.path))
  deps.out(`Joy 背景服務：${plan.manager}`)
  deps.out(`Node：${node.path}（${node.version}，來源：${node.source}）`)
  deps.out(`介面連接埠：${options.port}`)
  deps.out('')
  deps.out('將寫入這些檔案：')
  for (const file of plan.files) {
    deps.out(`  ${file.path}`)
    deps.out('  --------')
    for (const line of file.content.trimEnd().split('\n')) deps.out(`  ${line}`)
    deps.out('  --------')
  }
  deps.out('將依序執行這些指令：')
  for (const step of plan.install) deps.out(`  ${describeCommand(step)}`)
  deps.out('')
  const notes: string[] = [...plan.notes]
  if (await deps.health(options.port)) {
    // Re-running install while the service itself answers is an update, not a clash.
    const own = describeStatus(options.platform, await deps.run(plan.status.command, plan.status.args)).loaded
    notes.push(
      own
        ? `127.0.0.1:${options.port} 現在回應的是已安裝的服務；安裝會把它重新啟動，換成新的設定。`
        : `注意：127.0.0.1:${options.port} 已經有 Joy 在回應（可能是用終端機開的）。服務啟動時埠會被佔用而一直重試（紀錄會越積越多）；請先停掉那一個，或用 --port 換一個埠。`,
    )
  }
  const ui = deps.uiState(options.repoRoot)
  if (ui !== 'fresh')
    notes.push(
      ui === 'missing'
        ? `注意：還沒建置網頁介面，直接開 http://127.0.0.1:${options.port} 會是空的；先執行 pnpm joy build-ui。`
        : '注意：網頁介面比原始碼舊；執行 pnpm joy build-ui 更新。',
    )
  for (const note of notes) deps.out(note)
  if (options.dryRun) {
    deps.out('--dry-run：沒有寫入設定檔，也沒有安裝、啟動或重新啟動服務。')
    return 0
  }
  await deps.mkdir(p.join(options.joyHome, 'logs'), 0o700)
  for (const file of plan.files) {
    await deps.mkdir(p.dirname(file.path), 0o755)
    await deps.write(file)
  }
  await runSteps(plan.install, deps)
  deps.out(`已安裝。Joy 會在登入時自動啟動；現在就可以開 http://127.0.0.1:${options.port}`)
  deps.out(`第一次打開要貼上存取權杖，它在 ${p.join(options.joyHome, 'api-token')}（網頁上有說明）。`)
  if (plan.logs.length) deps.out(`紀錄：${plan.logs.join('、')}`)
  deps.out('查看狀態：pnpm joy service status；移除：pnpm joy service uninstall')
  if (options.platform === 'linux')
    deps.out(
      '想在登入前、開機時就啟動，另外執行一次 `loginctl enable-linger`（需要管理員權限，這裡不會替你執行）。',
    )
  return 0
}

async function uninstall(options: ServiceOptions, deps: ServiceDeps): Promise<number> {
  // The Node is not needed to remove anything; a placeholder keeps the planner's one path.
  const plan = planService(planInput(options, pathFor(options.platform).join(options.repoRoot, 'node')))
  deps.out(`移除 Joy 背景服務：${plan.manager}`)
  deps.out('將依序執行這些指令：')
  for (const step of plan.uninstall) deps.out(`  ${describeCommand(step)}`)
  deps.out('將刪除這些檔案：')
  for (const file of plan.files) deps.out(`  ${file.path}`)
  for (const step of plan.afterUninstall) deps.out(`  ${describeCommand(step)}`)
  if (options.dryRun) {
    deps.out('--dry-run：沒有刪除設定檔，也沒有停止或移除服務。')
    return 0
  }
  const existed = plan.files.some((file) => deps.exists(file.path))
  await runSteps(plan.uninstall, deps)
  for (const file of plan.files) await deps.remove(file.path)
  await runSteps(plan.afterUninstall, deps)
  deps.out(existed ? '已移除。Joy 資料（~/.joy）沒有動。' : '本來就沒有安裝；已確認沒有留下排程。')
  return 0
}

async function status(options: ServiceOptions, deps: ServiceDeps): Promise<number> {
  const plan = planService(planInput(options, pathFor(options.platform).join(options.repoRoot, 'node')))
  const installed = plan.files.every((file) => deps.exists(file.path))
  const result = await deps.run(plan.status.command, plan.status.args)
  const detail = describeStatus(options.platform, result)
  const responding = await deps.health(options.port)
  deps.out(`背景服務：${plan.manager}`)
  deps.out(`設定檔：${installed ? '已安裝' : '未安裝'}（${plan.files.map((file) => file.path).join('、')}）`)
  deps.out(
    `服務管理員：${detail.loaded ? `已載入${detail.summary ? `，${detail.summary}` : ''}` : '沒有載入'}`,
  )
  deps.out(
    `Joy 回應：${responding ? `是，http://127.0.0.1:${options.port}` : `否（127.0.0.1:${options.port} 沒有回應；若不是預設埠請加 --port）`}`,
  )
  if (plan.logs.length) deps.out(`紀錄：${plan.logs.join('、')}`)
  return installed && detail.loaded && responding ? 0 : 1
}

function describeStatus(platform: NodeJS.Platform, result: RunResult): { loaded: boolean; summary: string } {
  if (platform === 'linux') {
    const values = new Map(
      result.stdout
        .split('\n')
        .map((line) => line.split('=', 2) as [string, string | undefined])
        .filter((pair): pair is [string, string] => pair[1] !== undefined),
    )
    const loaded = result.status === 0 && values.get('LoadState') === 'loaded'
    return {
      loaded,
      summary: loaded
        ? `${values.get('ActiveState') ?? '?'}/${values.get('SubState') ?? '?'}，開機設定 ${values.get('UnitFileState') ?? '?'}，pid ${values.get('MainPID') ?? '?'}`
        : '',
    }
  }
  if (result.status !== 0) return { loaded: false, summary: '' }
  if (platform === 'darwin') {
    const state = /\bstate = (\S+)/.exec(result.stdout)?.[1]
    const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1]
    return { loaded: true, summary: [state, pid ? `pid ${pid}` : undefined].filter(Boolean).join('，') }
  }
  // schtasks prints localized labels; the whole answer is the task's state.
  return { loaded: true, summary: '' }
}

/** Runs `service install|uninstall|status`; returns the process exit code. Owner-facing errors are printed. */
export async function runService(
  action: ServiceAction,
  options: ServiceOptions,
  deps: ServiceDeps,
): Promise<number> {
  try {
    if (action === 'install') return await install(options, deps)
    if (action === 'uninstall') return await uninstall(options, deps)
    return await status(options, deps)
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
    deps.out(error.message)
    return 1
  }
}

/** The real thing: the file system, `execFile` and an HTTP health probe. */
export function realServiceDeps(out: (line: string) => void, uiState: ServiceDeps['uiState']): ServiceDeps {
  return {
    run: runWithoutShell,
    exists: (target) => existsSync(target),
    list: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
    version: async (nodePath) => {
      const result = await runWithoutShell(nodePath, ['--version'])
      return result.status === 0 ? result.stdout.trim() : undefined
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    mkdir: async (target, mode = 0o700) => void (await mkdir(target, { recursive: true, mode })),
    write: async (file) => {
      const body =
        file.encoding === 'utf16le'
          ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.content, 'utf16le')])
          : file.content
      // Nothing secret is in these files, and launchd and systemd read them as the owner.
      await writeFile(file.path, body, { mode: 0o644 })
    },
    remove: (target) => rm(target, { force: true }),
    health: async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1_500),
        })
        return response.ok
      } catch {
        return false
      }
    },
    uiState,
    nativeCheck: async (nodePath, repoRoot) => {
      // Resolved from the package that depends on it, the way the server loads it.
      const script =
        "const m=require('node:module');const r=m.createRequire(process.argv[1]);r(r.resolve('@napi-rs/keyring'))"
      const from = path.join(repoRoot, 'packages', 'secrets', 'package.json')
      const result = await runWithoutShell(nodePath, ['-e', script, from])
      if (result.status === 0) return undefined
      const reason = (result.error?.message ?? result.stderr)
        .split('\n')
        .find((line) => /Cannot find|Error/.test(line))
      return (reason ?? `結束碼 ${String(result.status)}`).trim()
    },
    out,
  }
}
