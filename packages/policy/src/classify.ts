import type { ActionKind, PermissionMode, ProposedAction } from '@joy/core'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ClassifyEnvironment, ShellAnalysis } from './shell.js'
import { analyzeSearch, analyzeShellCommand, defaultClassifyEnvironment } from './shell.js'

/**
 * A classified agent action. `grant: 'full'` marks an action outside the worktree that the task's `full` permission
 * mode lets through without asking (it is never set for secrets, Joy's config or external content, and never in the
 * `ask` mode, whose results stay exactly what they were before permission modes existed).
 */
export interface ClassifiedAction extends ProposedAction {
  grant?: 'full'
}

/** Joy's own MCP server. Only its tools get special treatment; another server's `ask_peer` is just unknown. */
const JOY_MCP_PREFIX = 'mcp__joy__'

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'listdirectory', 'ls'])
/**
 * Loading a skill or custom command. One the owner invoked with `/name` in this run (`env.ownerSkills`) runs on its
 * own: the owner asked for it. Any other asks, in every mode: a skill's `allowed-tools` lets the CLI run those tools
 * without asking Joy, and a repository (or the agent itself, by editing the worktree) can bring its own skills.
 */
const SKILL_TOOLS = ['skill', 'slashcommand'] as const

function isSkillTool(name: string): boolean {
  return (SKILL_TOOLS as readonly string[]).includes(name)
}

/** The skill a Skill (`{skill}`) or SlashCommand (`{command: '/name args'}`) call loads, if the owner invoked it. */
function isOwnerSkill(
  name: string,
  record: Record<string, unknown> | undefined,
  env: ClassifyEnvironment,
): boolean {
  const raw = name === 'skill' ? record?.skill : record?.command
  if (typeof raw !== 'string') return false
  const skill = (name === 'skill' ? raw : raw.replace(/^\//, '')).trim().split(/\s/)[0] ?? ''
  return skill !== '' && (env.ownerSkills ?? []).includes(skill)
}
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
export function classifyClaudeToolAction(
  toolName: string,
  input: unknown,
  cwd: string,
  mode: PermissionMode = 'ask',
  env?: ClassifyEnvironment,
): ClassifiedAction {
  if (mode === 'ask') {
    return {
      kind: classifyKind(toolName, input, cwd, env),
      summary: `Claude requested the ${toolName} tool.`,
      detail: input,
      provenance: 'agent',
    }
  }
  const judged = judgeClaudeTool(toolName, input, cwd, mode, env ?? defaultClassifyEnvironment())
  return withVerdict(
    {
      kind: judged.kind,
      summary: `Claude requested the ${toolName} tool.`,
      detail: input,
      provenance: 'agent',
    },
    judged,
    mode,
  )
}

/** Claude Code's own bookkeeping tools: they touch nothing outside the session. */
const SESSION_TOOLS = new Set([
  'todowrite',
  'task',
  'agent',
  'bashoutput',
  'killshell',
  'killbash',
  'toolsearch',
])
const NETWORK_TOOLS = new Set(['webfetch', 'websearch'])

interface Judgement {
  /** The kind when the action stays inside (auto tier); otherwise `run_outside_worktree`. */
  kind: ActionKind
  analysis: ShellAnalysis
}

const inside = (kind: ActionKind): Judgement => ({ kind, analysis: { verdict: 'inside', reason: '' } })
/**
 * Another MCP server's tool, or a tool Joy has never heard of: Joy cannot tell what it touches, so it asks in every
 * mode, `full` included (no grant).
 */
const unknownTool: Judgement = {
  kind: 'run_outside_worktree',
  analysis: { verdict: 'forbidden', reason: 'uses a tool Joy does not know' },
}
const outside = (reason: string): Judgement => ({
  kind: 'run_outside_worktree',
  analysis: { verdict: 'outside', reason },
})

function judgeClaudeTool(
  toolName: string,
  input: unknown,
  cwd: string,
  mode: 'auto' | 'full',
  env: ClassifyEnvironment,
): Judgement {
  if (toolName.startsWith('mcp__')) {
    // An owner-marked read-only server runs on its own in `auto` only; `full` asks for it like any other server.
    if (mode === 'auto' && isReadOnlyMcp(mcpServerOf(toolName), env)) return inside('read_file')
    // Joy's own tools keep their rules; another server's tools are unknown to Joy.
    const kind = classifyKind(toolName, input, cwd)
    return kind === 'run_outside_worktree' ? unknownTool : inside(kind)
  }
  const name = toolName.toLowerCase()
  const record = asRecord(input)
  if (name === 'glob' || name === 'grep') {
    const analysis = judgeSearch(name, record, cwd, mode, env)
    return analysis.verdict === 'inside' ? inside('read_file') : { kind: 'run_outside_worktree', analysis }
  }
  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const path = pathOf(record)
    const ok = READ_TOOLS.has(name) ? 'read_file' : 'edit_worktree'
    // Glob and Grep default to the working directory when no path is given; Read and the edit tools name a file.
    if (path === undefined) return name === 'glob' || name === 'grep' ? inside(ok) : outside('names no file')
    const analysis = judgePath(path, cwd, mode, env)
    return analysis.verdict === 'inside' ? inside(ok) : { kind: 'run_outside_worktree', analysis }
  }
  if (name === 'bash') {
    const command = typeof record?.command === 'string' ? record.command : ''
    // Claude's Bash keeps its working directory between calls but never outside its allowed directories (the
    // worktree): judging from the root is the conservative choice, since a deeper real cwd only makes `..` paths
    // land further inside.
    const analysis = analyzeShellCommand(command, { cwd, worktree: cwd, mode, env })
    return analysis.verdict === 'inside'
      ? inside('run_in_worktree')
      : { kind: 'run_outside_worktree', analysis }
  }
  if (isSkillTool(name)) return isOwnerSkill(name, record, env) ? inside('read_file') : unknownTool
  if (SESSION_TOOLS.has(name)) return inside('read_file')
  if (NETWORK_TOOLS.has(name)) return outside('downloads from or uploads to the network')
  return unknownTool
}

/** A file path a tool names: inside the worktree or the OS temp dir is fine; secrets never are. */
function judgePath(
  path: string,
  worktree: string,
  mode: 'auto' | 'full',
  env: ClassifyEnvironment,
): ShellAnalysis {
  // Quote it so the shell analysis sees one literal word (paths with spaces, `$` in a file name).
  return analyzeShellCommand(`cat ${singleQuote(path)}`, { cwd: worktree, worktree, mode, env })
}

/**
 * Grep and Glob read every file their search reaches: the path alone is not enough. Glob's `pattern` and Grep's
 * `glob` are paths too, and a search from the home directory may descend into `.ssh` or JOY_HOME.
 */
function judgeSearch(
  name: 'glob' | 'grep',
  record: Record<string, unknown> | undefined,
  cwd: string,
  mode: 'auto' | 'full',
  env: ClassifyEnvironment,
): ShellAnalysis {
  const glob = name === 'glob' ? record?.pattern : record?.glob
  return analyzeSearch(pathOf(record) ?? cwd, typeof glob === 'string' ? [glob] : [], {
    worktree: cwd,
    mode,
    recursive: name === 'grep',
    env,
  })
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Applies a judgement: inside stays as classified; outside asks in `auto` and is granted in `full`; secrets ask in
 * every mode. The summary says why the owner is asked.
 */
function withVerdict(action: ProposedAction, judged: Judgement, mode: 'auto' | 'full'): ClassifiedAction {
  const { verdict, reason } = judged.analysis
  if (verdict === 'inside') return action
  const summary = reason ? `${action.summary.replace(/\.$/, '')} (${reason}).` : action.summary
  if (verdict === 'outside' && mode === 'full')
    return { ...action, kind: 'run_outside_worktree', summary, grant: 'full' }
  return { ...action, kind: 'run_outside_worktree', summary }
}

function classifyKind(
  toolName: string,
  input: unknown,
  cwd: string,
  env: ClassifyEnvironment = defaultClassifyEnvironment(),
): ActionKind {
  if (toolName.startsWith('mcp__')) {
    if (!toolName.startsWith(JOY_MCP_PREFIX)) return 'run_outside_worktree'
    const tool = toolName.slice(JOY_MCP_PREFIX.length)
    if (tool === 'ask_peer') return 'ask_peer'
    if (tool === 'task_status') return 'read_file'
    return 'run_outside_worktree'
  }
  const name = toolName.toLowerCase()
  const record = asRecord(input)
  if (isSkillTool(name)) return isOwnerSkill(name, record, env) ? 'read_file' : 'run_outside_worktree'
  if (READ_TOOLS.has(name)) {
    // Glob and Grep default to the working directory when no path is given; Read always names a file.
    const path = pathOf(record)
    // A search must also stay out of secrets with its patterns (see judgeSearch); the rest of `ask` is unchanged.
    if (
      (name === 'glob' || name === 'grep') &&
      judgeSearch(name, record, cwd, 'auto', env).verdict !== 'inside'
    )
      return 'run_outside_worktree'
    if (path === undefined) return name === 'read' ? 'run_outside_worktree' : 'read_file'
    return isInside(path, cwd) ? 'read_file' : 'run_outside_worktree'
  }
  if (WRITE_TOOLS.has(name)) {
    const path = pathOf(record)
    return path !== undefined && isInside(path, cwd) ? 'edit_worktree' : 'run_outside_worktree'
  }
  if (name === 'bash') {
    const command = typeof record?.command === 'string' ? record.command : ''
    return isSafeShellCommand(command) ? 'run_in_worktree' : 'run_outside_worktree'
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

/** Filters that only read their standard input (or files inside the worktree) and print a part of it. */
const READ_ONLY_FILTERS = new Set(['head', 'tail', 'grep', 'wc', 'sort', 'uniq'])
/** Filter arguments stay plain words: no quotes, globs, paths outside the worktree or anything a shell expands. */
const PLAIN_FILTER_ARG = /^[A-Za-z0-9_.,:=+@%-]+$/

/**
 * Like `isSafeWorktreeCommand`, but for a command a shell will run: agents habitually add `2>&1` and pipe the
 * output through `tail`/`grep` to keep it short, which changes nothing about what the command can touch.
 * Every other shell feature (`;`, `&&`, `>`, `$`, quotes, ...) is still refused.
 */
export function isSafeShellCommand(command: string): boolean {
  const segments = command.split('|').map((segment) => segment.trim())
  const [first, ...filters] = segments
  if (first === undefined) return false
  const main = first.replace(/\s+2>&1$/, '')
  if (!isSafeWorktreeCommand(main)) return false
  return filters.every((segment) => {
    const words = segment.replace(/\s+2>&1$/, '').split(/\s+/)
    const [program, ...args] = words
    if (program === undefined || !READ_ONLY_FILTERS.has(program)) return false
    return args.every((arg) => PLAIN_FILTER_ARG.test(arg) && !arg.includes('..'))
  })
}

/** `mcp__<server>__<tool>`: the server part (server names never contain `__`; Joy's are checked on input). */
function mcpServerOf(toolName: string): string {
  const rest = toolName.slice('mcp__'.length)
  const end = rest.indexOf('__')
  return end < 0 ? '' : rest.slice(0, end)
}

function isReadOnlyMcp(server: string, env: ClassifyEnvironment): boolean {
  return server !== '' && server !== 'joy' && (env.readOnlyMcpServers ?? []).includes(server)
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
   * Codex asks before a tool call of an MCP server Joy told it to ask about (`toolCall`: its `_meta` says so), or the
   * server itself asks the owner something. `tool` and `message` come from the MCP server: untrusted, shown only.
   */
  | {
      method: 'mcpServer/elicitation/request'
      server: string
      toolCall?: boolean
      tool?: string
      message?: string
    }

/**
 * Map a Codex app-server approval request to a policy action. Codex only asks when it wants to step outside its
 * workspace-write sandbox, so anything that cannot be shown to stay inside the worktree is red.
 */
export function classifyCodexApproval(
  request: CodexApprovalInput,
  worktree: string,
  mode: PermissionMode = 'ask',
  env?: ClassifyEnvironment,
): ClassifiedAction {
  if (request.method === 'mcpServer/elicitation/request') {
    const said = [request.tool, request.message]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .map((part) => part.replace(/\s+/g, ' ').trim().slice(0, 200))
      .join(' — ')
    const action: ProposedAction = {
      kind: 'run_outside_worktree',
      summary: request.toolCall
        ? `Codex requested a tool of the ${request.server} MCP server${said ? ` (the server says: ${said})` : ''}.`
        : `The ${request.server} MCP server asks something${said ? ` (it says: ${said})` : ''}.`,
      detail: request,
      provenance: 'agent',
    }
    // Same rule as Claude's mcp__ tools: an owner-marked read-only server runs on its own in `auto`, nowhere else,
    // and only for a tool call: anything else the server asks goes to the owner.
    if (
      mode === 'auto' &&
      request.toolCall === true &&
      isReadOnlyMcp(request.server, env ?? defaultClassifyEnvironment())
    )
      return { ...action, kind: 'read_file' }
    return mode === 'ask' ? action : withVerdict(action, unknownTool, mode)
  }
  if (mode !== 'ask')
    return classifyCodexApprovalForMode(request, worktree, mode, env ?? defaultClassifyEnvironment())
  let kind: ActionKind = 'run_outside_worktree'
  let summary: string
  if (request.method === 'item/commandExecution/requestApproval') {
    const command = unwrapShell(request.command ?? '')
    const cwdInside = !request.cwd || isInside(request.cwd, worktree)
    if (request.kind === 'command' && cwdInside && isSafeShellCommand(command)) kind = 'run_in_worktree'
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

/**
 * `auto` / `full` for Codex. Codex runs in its workspace-write sandbox and asks only to step outside it (usually
 * for the network, e.g. `pnpm install`), so accepting means the command runs without the sandbox: the same shell
 * analysis as Claude's Bash decides whether that is still the worktree's business.
 */
function classifyCodexApprovalForMode(
  request: Exclude<CodexApprovalInput, { method: 'mcpServer/elicitation/request' }>,
  worktree: string,
  mode: 'auto' | 'full',
  env: ClassifyEnvironment,
): ClassifiedAction {
  if (request.method === 'item/commandExecution/requestApproval') {
    const action: ProposedAction = {
      kind: 'run_in_worktree',
      summary: `Codex requested to run: ${request.command ?? '(no command given)'}`,
      detail: request,
      provenance: 'agent',
    }
    if (request.kind === 'writeStdin')
      return withVerdict(action, outside('writes to a running program'), mode)
    if (!request.command) return withVerdict(action, outside('names no command'), mode)
    const cwd = request.cwd || worktree
    const cwdAnalysis = judgePath(cwd, worktree, mode, env)
    if (cwdAnalysis.verdict !== 'inside') {
      // Still look for secrets in the command itself.
      const commandAnalysis = analyzeShellCommand(request.command, { cwd: worktree, worktree, mode, env })
      const analysis = commandAnalysis.verdict === 'forbidden' ? commandAnalysis : cwdAnalysis
      return withVerdict(action, { kind: 'run_outside_worktree', analysis }, mode)
    }
    const analysis = analyzeShellCommand(request.command, { cwd, worktree, mode, env })
    return withVerdict(
      action,
      analysis.verdict === 'inside' ? inside('run_in_worktree') : { kind: 'run_outside_worktree', analysis },
      mode,
    )
  }
  const action: ProposedAction = {
    kind: 'edit_worktree',
    summary: `Codex requested to write files${request.grantRoot ? ` under ${request.grantRoot}` : ''}`,
    detail: request,
    provenance: 'agent',
  }
  if (!request.grantRoot) {
    // Without a root Joy cannot tell where the files are, so it cannot rule out secrets: ask even in `full`.
    return withVerdict(
      action,
      { kind: 'run_outside_worktree', analysis: { verdict: 'forbidden', reason: 'names no directory' } },
      mode,
    )
  }
  const analysis = judgePath(request.grantRoot, worktree, mode, env)
  return withVerdict(
    action,
    analysis.verdict === 'inside' ? inside('edit_worktree') : { kind: 'run_outside_worktree', analysis },
    mode,
  )
}

/**
 * The project checks (`repos.check_command`, an argv run without a shell) under a permission mode. `ask` keeps the
 * original rule (only the short allowlist runs on its own).
 */
export function classifyCheckCommand(
  argv: readonly string[],
  worktree: string,
  mode: Exclude<PermissionMode, 'ask'>,
  env?: ClassifyEnvironment,
): { kind: Extract<ActionKind, 'run_in_worktree' | 'run_outside_worktree'>; grant?: 'full'; reason: string } {
  if (argv.length === 0 || argv.some((part) => part === ''))
    return { kind: 'run_outside_worktree', reason: 'names no command' }
  const command = argv.map((part) => singleQuote(part)).join(' ')
  const analysis = analyzeShellCommand(command, {
    cwd: worktree,
    worktree,
    mode,
    env: env ?? defaultClassifyEnvironment(),
  })
  if (analysis.verdict === 'inside') return { kind: 'run_in_worktree', reason: '' }
  if (analysis.verdict === 'outside' && mode === 'full')
    return { kind: 'run_outside_worktree', grant: 'full', reason: analysis.reason }
  return { kind: 'run_outside_worktree', reason: analysis.reason }
}
