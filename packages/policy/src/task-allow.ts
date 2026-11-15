import { posix, win32 } from 'node:path'
import type { CodexApprovalInput } from './classify.js'
import type { ClassifyEnvironment, ShellConcern } from './shell.js'
import { analyzeShellConcerns, defaultClassifyEnvironment } from './shell.js'

/**
 * "Allow for the rest of this task": after the owner approves an action once, the same action in the same task is not
 * asked again. This file decides which actions may be remembered and what "the same action" means.
 *
 * The fingerprint is deliberately narrow, so a remembered approval covers what the owner saw and nothing more:
 * - `shell`: the whole command, only trimmed and with line endings unified (never just the program name: allowing
 *   `rm -rf build` must not allow `rm -rf ..`), plus its working directory relative to the worktree (Codex);
 * - `file_write` / `file_read`: the resolved path the tool names;
 * - `network`: the host of a URL (Claude's WebFetch);
 * - `mcp`: the server and the tool name.
 *
 * Never offered: anything that touches secrets, credentials or Joy's own data (the `forbidden` verdict, asked in every
 * permission mode), and actions that reach other people or machines on the owner's behalf (git remotes, network
 * programs such as `gh`, `curl` or `ssh`, package publishing or installing outside the lockfile), so a push or a pull
 * request is always the owner's own decision. Commands the analysis cannot read, MCP tools whose name does not say
 * they only read, and anything Joy does not recognise are not offered either. External content is excluded by the
 * caller (the task's provenance).
 */
export type TaskAllowKind = 'shell' | 'file_write' | 'file_read' | 'network' | 'mcp'

export const TASK_ALLOW_KINDS: readonly TaskAllowKind[] = [
  'shell',
  'file_write',
  'file_read',
  'network',
  'mcp',
]

export type TaskAllowJudgement =
  | {
      offer: true
      kind: TaskAllowKind
      /** What the owner sees in the task's list of allowed actions (the caller redacts it). */
      target: string
      /** Equal for two actions exactly when one remembered approval covers both. */
      fingerprint: string
    }
  | { offer: false; reason: string }

/** Concerns that make an action the owner's decision every time. */
const EXTERNAL_CONCERNS: ReadonlySet<ShellConcern> = new Set<ShellConcern>([
  'secret',
  'network',
  'git',
  'packages',
  'unparseable',
])

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'listdirectory', 'ls'])
const WRITE_TOOLS = new Set(['edit', 'multiedit', 'write', 'notebookedit'])
/** An MCP tool whose name says it only reads. */
const READ_ONLY_MCP = /^(?:list|get|search|read|find|query|fetch|show|describe|view)(?:_|-|$)/i
/** Words that mean the tool acts, even when the name starts like a read (`get_and_send`). */
const ACTING_MCP =
  /send|post|publish|push|merge|create|update|delete|remove|write|reply|forward|invite|share|upload|pay|buy|transfer/i

const no = (reason: string): TaskAllowJudgement => ({ offer: false, reason })

function fingerprintOf(kind: TaskAllowKind, ...parts: string[]): string {
  return JSON.stringify([kind, ...parts])
}

/** Normalizes a command without changing what it means: no reordering, no whitespace changes inside it. */
export function normalizeCommand(command: string): string {
  return command.replace(/\r\n?/g, '\n').trim()
}

function pathsFor(worktree: string): typeof posix {
  return /^[A-Za-z]:[\\/]/.test(worktree) || worktree.startsWith('\\\\') ? win32 : posix
}

/** Absolute, normalized path; Windows paths compare case-insensitively, so they are lower-cased. */
function resolvedPath(path: string, cwd: string): string {
  const paths = pathsFor(cwd)
  const resolved = paths.resolve(cwd, path)
  return paths === win32 ? resolved.toLowerCase() : resolved
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Whether a shell command may be remembered, judged with the strictest mode (`auto`) whatever the task's mode. */
function judgeShell(command: string, cwd: string, worktree: string, env: ClassifyEnvironment) {
  const analysis = analyzeShellConcerns(command, { cwd, worktree, mode: 'auto', env })
  if (analysis.verdict === 'forbidden') return no('forbidden')
  const external = analysis.concerns.find((concern) => EXTERNAL_CONCERNS.has(concern))
  return external ? no(external === 'unparseable' ? 'unparseable' : 'external') : undefined
}

function judgeFile(
  kind: 'file_read' | 'file_write',
  path: string,
  cwd: string,
  env: ClassifyEnvironment,
): TaskAllowJudgement {
  const blocked = judgeShell(`cat ${singleQuote(path)}`, cwd, cwd, env)
  if (blocked) return blocked
  const target = resolvedPath(path, cwd)
  return { offer: true, kind, target, fingerprint: fingerprintOf(kind, target) }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}

function pathOf(record: Record<string, unknown> | undefined): string | undefined {
  const candidate = record?.file_path ?? record?.filePath ?? record?.notebook_path ?? record?.path
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined
}

/** A Claude Code permission prompt (`tool_name`, `input`) in the worktree `cwd`. */
export function taskAllowForClaudeTool(
  toolName: string,
  input: unknown,
  cwd: string,
  env: ClassifyEnvironment = defaultClassifyEnvironment(),
): TaskAllowJudgement {
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length)
    const split = rest.indexOf('__')
    if (split <= 0) return no('unknown')
    const server = rest.slice(0, split)
    const tool = rest.slice(split + 2)
    // Joy's own tools are judged by their own rules (and approved before this point).
    if (server === 'joy' || !tool) return no('unknown')
    if (!READ_ONLY_MCP.test(tool) || ACTING_MCP.test(tool)) return no('external')
    return {
      offer: true,
      kind: 'mcp',
      target: `${server} · ${tool}`,
      fingerprint: fingerprintOf('mcp', server, tool),
    }
  }
  const name = toolName.toLowerCase()
  const record = asRecord(input)
  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const path = pathOf(record)
    if (path === undefined) return no('unknown')
    return judgeFile(READ_TOOLS.has(name) ? 'file_read' : 'file_write', path, cwd, env)
  }
  if (name === 'bash') {
    const command = typeof record?.command === 'string' ? normalizeCommand(record.command) : ''
    if (!command) return no('unknown')
    const blocked = judgeShell(command, cwd, cwd, env)
    if (blocked) return blocked
    // Claude's Bash is judged from the worktree root (see classify.ts), so the directory part is always the root.
    return { offer: true, kind: 'shell', target: command, fingerprint: fingerprintOf('shell', command, '') }
  }
  if (name === 'webfetch') {
    const url = typeof record?.url === 'string' ? record.url : ''
    let host: string
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return no('unknown')
      host = parsed.hostname.toLowerCase()
    } catch {
      return no('unknown')
    }
    if (!host) return no('unknown')
    return { offer: true, kind: 'network', target: host, fingerprint: fingerprintOf('network', host) }
  }
  // WebSearch names no host, and an unknown tool could do anything.
  return no('unknown')
}

/** A Codex app-server approval request in the worktree. */
export function taskAllowForCodexApproval(
  request: CodexApprovalInput,
  worktree: string,
  env: ClassifyEnvironment = defaultClassifyEnvironment(),
): TaskAllowJudgement {
  if (request.method === 'item/commandExecution/requestApproval') {
    // Writing to a running program depends on what that program is doing; only whole commands are remembered.
    if (request.kind !== 'command') return no('unknown')
    const command = normalizeCommand(request.command ?? '')
    if (!command) return no('unknown')
    const cwd = request.cwd || worktree
    const blockedCwd = judgeShell(`cd ${singleQuote(cwd)}`, worktree, worktree, env)
    if (blockedCwd && !blockedCwd.offer && blockedCwd.reason === 'forbidden') return blockedCwd
    const blocked = judgeShell(command, cwd, worktree, env)
    if (blocked) return blocked
    const paths = pathsFor(worktree)
    const relative = paths.relative(resolvedPath(worktree, worktree), resolvedPath(cwd, worktree))
    const directory = paths === win32 ? relative.replace(/\\/g, '/') : relative
    return {
      offer: true,
      kind: 'shell',
      target: directory ? `${command}  (${directory})` : command,
      fingerprint: fingerprintOf('shell', command, directory),
    }
  }
  if (!request.grantRoot) return no('forbidden')
  return judgeFile('file_write', request.grantRoot, worktree, env)
}
