import type { ActionKind, ProposedAction } from '@joy/core'
import { isAbsolute, relative, resolve } from 'node:path'

/** Joy's own MCP server. Only its tools get special treatment; another server's `ask_peer` is just unknown. */
const JOY_MCP_PREFIX = 'mcp__joy__'

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'listdirectory', 'ls'])
const WRITE_TOOLS = new Set(['edit', 'multiedit', 'write', 'notebookedit'])

/** Anything that chains commands, redirects, substitutes or expands makes a command impossible to judge by its words. */
const SHELL_SYNTAX = /[;&|<>`$(){}[\]*?!~\\\n\r'"#]/

const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn'])
/** Scripts that build or check the project but do not publish, deploy or change git state. */
const SAFE_SCRIPTS = new Set(['test', 'lint', 'build', 'typecheck', 'check', 'format:check'])
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show'])

/**
 * Map a Claude Code permission prompt to a policy action. Anything that cannot be shown to stay inside the
 * worktree is classified as `run_outside_worktree` (red), so unknown tools and unusual commands fail closed.
 */
export function classifyClaudeToolAction(toolName: string, input: unknown, cwd: string): ProposedAction {
  return {
    kind: classifyKind(toolName, input, cwd),
    summary: `Claude requested the ${toolName} tool.`,
    detail: input,
    provenance: 'agent',
  }
}

function classifyKind(toolName: string, input: unknown, cwd: string): ActionKind {
  if (toolName.startsWith('mcp__')) {
    if (!toolName.startsWith(JOY_MCP_PREFIX)) return 'run_outside_worktree'
    const tool = toolName.slice(JOY_MCP_PREFIX.length)
    if (tool === 'ask_peer') return 'ask_peer'
    if (tool === 'task_status') return 'read_file'
    return 'run_outside_worktree'
  }
  const name = toolName.toLowerCase()
  const record = asRecord(input)
  if (READ_TOOLS.has(name)) {
    // Glob and Grep default to the working directory when no path is given; Read always names a file.
    const path = pathOf(record)
    if (path === undefined) return name === 'read' ? 'run_outside_worktree' : 'read_file'
    return isInside(path, cwd) ? 'read_file' : 'run_outside_worktree'
  }
  if (WRITE_TOOLS.has(name)) {
    const path = pathOf(record)
    return path !== undefined && isInside(path, cwd) ? 'edit_worktree' : 'run_outside_worktree'
  }
  if (name === 'bash') {
    const command = typeof record?.command === 'string' ? record.command : ''
    return isSafeWorktreeCommand(command) ? 'run_in_worktree' : 'run_outside_worktree'
  }
  return 'run_outside_worktree'
}

/**
 * True only for a single plain command from a short list that builds, tests or inspects the project.
 * The command runs with the worktree as its working directory, and no argument may point elsewhere.
 */
export function isSafeWorktreeCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '' || SHELL_SYNTAX.test(trimmed)) return false
  const words = trimmed.split(/\s+/)
  if (
    words.some((w) => w.startsWith('/') || w.startsWith('-C') || w.includes('..') || /^[A-Za-z]:/.test(w))
  ) {
    return false
  }
  const [program, first, second] = words
  if (program === 'git') return first !== undefined && SAFE_GIT.has(first)
  if (program && PACKAGE_MANAGERS.has(program)) {
    if (first === 'run') return second !== undefined && SAFE_SCRIPTS.has(second)
    return first !== undefined && SAFE_SCRIPTS.has(first)
  }
  return false
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

/** Absolute paths are fine when they resolve inside the worktree (Claude usually sends absolute paths). */
export function isInside(path: string, cwd: string): boolean {
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The parts of a Codex app-server approval request the policy needs (kept independent of the provider package). */
export type CodexApprovalInput =
  | {
      method: 'item/commandExecution/requestApproval'
      kind: string
      command?: string | null
      cwd?: string | null
    }
  | { method: 'item/fileChange/requestApproval'; grantRoot?: string | null }

/**
 * Map a Codex app-server approval request to a policy action. Codex only asks when it wants to step outside its
 * workspace-write sandbox, so anything that cannot be shown to stay inside the worktree is red.
 */
export function classifyCodexApproval(request: CodexApprovalInput, worktree: string): ProposedAction {
  let kind: ActionKind = 'run_outside_worktree'
  let summary: string
  if (request.method === 'item/commandExecution/requestApproval') {
    const command = unwrapShell(request.command ?? '')
    const cwdInside = !request.cwd || isInside(request.cwd, worktree)
    if (request.kind === 'command' && cwdInside && isSafeWorktreeCommand(command)) kind = 'run_in_worktree'
    summary = `Codex requested to run: ${request.command ?? '(no command given)'}`
  } else {
    if (request.grantRoot && isInside(request.grantRoot, worktree)) kind = 'edit_worktree'
    summary = `Codex requested to write files${request.grantRoot ? ` under ${request.grantRoot}` : ''}`
  }
  return { kind, summary, detail: request, provenance: 'agent' }
}

/** Codex often wraps commands as `bash -lc '<cmd>'`; judge the inner command when the wrapper is that simple. */
function unwrapShell(command: string): string {
  const match = /^(?:ba|z)?sh -l?c '([^']*)'$/.exec(command.trim())
  return match?.[1] ?? command
}
