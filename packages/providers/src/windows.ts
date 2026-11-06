// Windows support (T4.4). npm and pnpm install CLIs as `.cmd` shims, which Node can only start through cmd.exe —
// and Joy never spawns through a shell. So a shim is read instead: it names the CLI's JavaScript entry, which runs
// directly with this Node. Real executables (.exe) are used as they are.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { win32 } from 'node:path'

export interface ResolvedCommand {
  command: string
  /** Arguments placed before the caller's (the script, for a shim). */
  prefix: string[]
}

export interface ResolveOptions {
  platform?: NodeJS.Platform
  /** PATH as Windows sees it (`;`-separated). */
  path?: string
  /** The Node that runs a shim's script. Default: this process's Node. */
  node?: string
  /** File checks, replaceable in tests. */
  isFile?: (path: string) => boolean
  readFile?: (path: string) => string
}

function defaultIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/** The script an npm (cmd-shim) or pnpm `.cmd` shim runs, as an absolute path; undefined if it is not such a shim. */
export function shimScript(shimPath: string, content: string): string | undefined {
  // npm: "%dp0%\node_modules\pkg\cli.js"; pnpm: "%~dp0\..\pkg\cli.js" or "%~dp0\node_modules\...".
  const match = /"%~?dp0%?\\([^"%]+\.(?:c|m)?js)"/i.exec(content)
  if (!match?.[1]) return undefined
  return win32.resolve(win32.dirname(shimPath), match[1])
}

/**
 * How to start `command` without a shell. On anything but Windows, or when the command is already a path to an
 * executable, it is returned unchanged.
 */
export function resolveCommand(command: string, options: ResolveOptions = {}): ResolvedCommand {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { command, prefix: [] }
  const isFile = options.isFile ?? defaultIsFile
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const node = options.node ?? process.execPath

  const fromShim = (shim: string): ResolvedCommand => {
    const script = shimScript(shim, readFile(shim))
    if (!script || !isFile(script))
      throw new Error(
        `${shim} is a command shim Joy cannot run without a shell. Set the CLI's path in Joy's settings to its .exe or its JavaScript entry (cli.js).`,
      )
    return { command: node, prefix: [script] }
  }

  if (/[\\/]/.test(command)) {
    if (/\.(?:cmd|bat)$/i.test(command)) return fromShim(command)
    return { command, prefix: [] }
  }
  for (const directory of (options.path ?? process.env.PATH ?? '').split(';').filter(Boolean)) {
    const exe = win32.join(directory, `${command}.exe`)
    if (isFile(exe)) return { command: exe, prefix: [] }
    for (const extension of ['.cmd', '.bat']) {
      const shim = win32.join(directory, `${command}${extension}`)
      if (isFile(shim)) return fromShim(shim)
    }
  }
  // Not found: spawning reports ENOENT with Joy's usual "install it" message.
  return { command, prefix: [] }
}

const resolved = new Map<string, ResolvedCommand>()

/** `resolveCommand` for this computer, remembered per command (PATH lookups are not free on Windows). */
export function resolveCommandCached(command: string): ResolvedCommand {
  if (process.platform !== 'win32') return { command, prefix: [] }
  let hit = resolved.get(command)
  if (!hit) {
    hit = resolveCommand(command)
    if (hit.command !== command || hit.prefix.length) resolved.set(command, hit)
  }
  return hit
}

/** A Windows path as WSL sees it: `C:\Users\me` → `/mnt/c/Users/me`. Undefined for paths WSL cannot map. */
export function toWslPath(windowsPath: string): string | undefined {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath)
  if (!match?.[1]) return undefined
  return `/mnt/${match[1].toLowerCase()}/${(match[2] ?? '').replace(/\\/g, '/')}`.replace(/\/$/, '')
}

/**
 * `codex exec` run inside WSL instead of Windows (T4.4 fallback). Windows paths in the arguments and the working
 * directory are translated to their /mnt/<drive> form; Codex must be installed and logged in inside WSL.
 */
export function wslCommand(run: { args: string[]; cwd: string; cli: string }): {
  command: string
  args: string[]
} {
  const cwd = toWslPath(run.cwd)
  if (!cwd)
    throw new Error(
      `WSL cannot reach ${run.cwd}; keep Joy's data on a drive letter (C:, D:, …) to use Codex in WSL`,
    )
  return {
    command: 'wsl.exe',
    args: [
      '--cd',
      cwd,
      '-e',
      run.cli,
      ...run.args.map((arg) => (/^[A-Za-z]:[\\/]/.test(arg) ? (toWslPath(arg) ?? arg) : arg)),
    ],
  }
}
