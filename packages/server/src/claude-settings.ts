import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Keys of a project's `.claude/settings.json` that make Claude Code run something on its own, without a tool call Joy
 * could approve: hooks run at session start and around tools, helpers run to fetch credentials or headers, plugins can
 * bring their own hooks, and `env` reaches every command it starts (`BASH_ENV`, `NODE_OPTIONS`) and where it sends
 * requests (`ANTHROPIC_BASE_URL`). Claude Code 2.1.319 applies a project's hooks even in a folder it never trusted
 * (docs/spikes/claude-code.md), and `--setting-sources` cannot drop them without dropping the project's CLAUDE.md and
 * skills too.
 */
const COMMAND_KEYS = [
  'hooks',
  'env',
  'statusLine',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
  'enabledPlugins',
  'extraKnownMarketplaces',
] as const

const MAX_LINES = 40
const MAX_LINE = 400
/** Far above any real settings file; a bigger one (or `/dev/zero`) is refused instead of read. */
const MAX_BYTES = 256 * 1024

export const CLAUDE_SETTINGS_FILE = join('.claude', 'settings.json')

export interface ClaudeSettingsCommands {
  /** SHA-256 of the command-running parts only: editing permissions or other keys does not ask again. */
  fingerprint: string
  /** One line per command, for the owner to read before approving. */
  commands: string[]
}

/**
 * The commands `.claude/settings.json` in `cwd` would make Claude Code run, or undefined when there are none. Throws
 * when the path is not a regular file of sane size (a FIFO an agent made would otherwise hang the check).
 */
export async function readClaudeSettingsCommands(
  cwd: string,
  signal?: AbortSignal,
): Promise<ClaudeSettingsCommands | undefined> {
  const text = await readSettingsText(join(cwd, CLAUDE_SETTINGS_FILE), signal)
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Unreadable to Joy is not proof Claude Code ignores it: show the owner what is there and ask.
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
    return {
      fingerprint: sha256(text),
      commands: [`${CLAUDE_SETTINGS_FILE} is not valid JSON:`, ...shownLines(lines)],
    }
  }
  if (!isRecord(parsed)) return undefined
  const picked: Record<string, unknown> = {}
  for (const key of COMMAND_KEYS) if (parsed[key] !== undefined) picked[key] = parsed[key]
  const commands = describe(picked)
  if (commands.length === 0) return undefined
  return { fingerprint: sha256(stableJson(picked)), commands: shownLines(commands) }
}

function shownLines(lines: string[]): string[] {
  const shown = lines.slice(0, MAX_LINES).map((line) => clip(line))
  if (lines.length > MAX_LINES) shown.push(`… ${lines.length - MAX_LINES} more`)
  return shown
}

/** Opened without blocking and checked on the open handle, so the file cannot be swapped between check and read. */
async function readSettingsText(path: string, signal?: AbortSignal): Promise<string | undefined> {
  let handle
  try {
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer. Windows has no such flag.
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`${path} is not a regular file; Claude Code was not started`)
    if (info.size > MAX_BYTES)
      throw new Error(`${path} is larger than ${MAX_BYTES / 1024} KB; Claude Code was not started`)
    signal?.throwIfAborted()
    const buffer = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0)
    // Whether Claude Code skips a byte order mark is unverified; dropping it here shows the commands either way.
    return buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
  } finally {
    await handle.close()
  }
}

function describe(picked: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(picked)) {
    if (key === 'hooks') lines.push(...describeHooks(value))
    else if (key === 'env') {
      if (isRecord(value))
        // Names only: a value may be a token. The fingerprint still covers the values.
        for (const name of Object.keys(value)) lines.push(`env: ${name}`)
      else lines.push(`env: ${compact(value)}`)
    } else if (key === 'enabledPlugins') {
      if (isRecord(value)) {
        for (const [name, on] of Object.entries(value)) if (on) lines.push(`plugin: ${name}`)
      } else lines.push(`enabledPlugins: ${compact(value)}`)
    } else if (key === 'extraKnownMarketplaces') {
      if (isRecord(value)) for (const name of Object.keys(value)) lines.push(`marketplace: ${name}`)
      else lines.push(`extraKnownMarketplaces: ${compact(value)}`)
    } else if (key === 'statusLine') {
      lines.push(
        `statusLine: ${isRecord(value) && typeof value.command === 'string' ? value.command : compact(value)}`,
      )
    } else if (value !== null && value !== '')
      lines.push(`${key}: ${typeof value === 'string' ? value : compact(value)}`)
  }
  return lines
}

function describeHooks(value: unknown): string[] {
  if (!isRecord(value)) return value === null ? [] : [`hooks: ${compact(value)}`]
  const lines: string[] = []
  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) {
      lines.push(`${event}: ${compact(groups)}`)
      continue
    }
    for (const group of groups) {
      const matcher =
        isRecord(group) && typeof group.matcher === 'string' && group.matcher ? ` (${group.matcher})` : ''
      const hooks = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : undefined
      if (!hooks) {
        lines.push(`${event}: ${compact(group)}`)
        continue
      }
      for (const hook of hooks) lines.push(`${event}${matcher}: ${hookText(hook)}`)
    }
  }
  return lines
}

function hookText(hook: unknown): string {
  if (isRecord(hook))
    for (const key of ['command', 'url', 'prompt'] as const)
      if (typeof hook[key] === 'string') return hook[key] as string
  return compact(hook)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compact(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

function clip(line: string): string {
  const single = line.replace(/\s+/g, ' ').trim()
  return single.length > MAX_LINE ? `${single.slice(0, MAX_LINE)}…` : single
}

/** JSON with object keys sorted, so reformatting the file keeps the same fingerprint. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
