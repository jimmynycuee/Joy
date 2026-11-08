// Maps Claude Code `--output-format stream-json` lines to AgentEvents.
// Event shapes: docs/spikes/claude-code.md, fixtures in tests/fixtures/cli-events/claude/.
import { isAbsolute, relative } from 'node:path'
import type { AgentEvent, QuotaWindow } from '@joy/core'
import type { Rec } from '../guards.js'
import { arr, isRecord, num, opt, rec, str } from '../guards.js'

/** Built-in tools whose successful result means a file in the workspace changed. */
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** High-volume or internal events Joy deliberately drops (not "unknown"). */
const DROPPED = new Set(['stream_event'])

export interface ClaudeParserOptions {
  /** Worktree path; file paths inside it are reported relative to it. */
  cwd?: string
  /**
   * Streaming input (`--input-format stream-json`): the process may answer several user messages, each ending with a
   * `result`, so `done` is held until the process exits and then reflects the last result.
   */
  multiTurn?: boolean
}

export class ClaudeStreamParser {
  private sessionId: string | undefined
  private done = false
  private started = false
  /** Claude emits a few events before `system/init`; hold them so `session_started` is always first. */
  private beforeInit: AgentEvent[] = []
  private readonly pendingFileTools = new Map<string, { path: string; tool: string }>()
  /** Multi-turn: the `done` of the latest result, emitted when the process exits. */
  private lastDone: AgentEvent | undefined

  constructor(private readonly options: ClaudeParserOptions = {}) {}

  get finished(): boolean {
    return this.done
  }

  get session(): string | undefined {
    return this.sessionId
  }

  /** Converts one parsed stdout line. Returns zero or more events. */
  push(line: unknown): AgentEvent[] {
    if (this.done) return []
    const events = this.convert(line)
    if (this.started || this.done) return events
    if (events[0]?.type === 'session_started') {
      this.started = true
      const held = this.beforeInit
      this.beforeInit = []
      return [events[0], ...held, ...events.slice(1)]
    }
    this.beforeInit.push(...events)
    return []
  }

  private convert(line: unknown): AgentEvent[] {
    if (!isRecord(line)) return [{ type: 'raw', source: 'claude-cli', payload: line }]
    const type = str(line.type)
    const subtype = str(line.subtype)
    this.sessionId ??= str(line.session_id)

    if (type && DROPPED.has(type)) return []
    if (type === 'system' && subtype === 'init') return [this.init(line)]
    if (type === 'system' && subtype === 'task_summary') {
      const text = str(line.detail)
      return text ? [{ type: 'status', text }] : []
    }
    if (type === 'system' && subtype === 'permission_denied') {
      return [
        {
          type: 'permission_denied',
          toolName: str(line.tool_name) ?? 'unknown',
          reason: str(line.decision_reason) ?? str(line.message) ?? '',
        },
      ]
    }
    if (type === 'assistant') return this.assistant(line)
    if (type === 'user') return this.user(line)
    if (type === 'rate_limit_event') return this.rateLimit(line)
    if (type === 'result') return this.result(line)
    return [{ type: 'raw', source: 'claude-cli', payload: line }]
  }

  /**
   * Call when the process has exited. Emits a failing `done` if the CLI never sent `result`; in multi-turn mode a
   * process that was not stopped ends with the last result's `done`.
   */
  finish(reason: string, exit: { stopped: boolean } = { stopped: true }): AgentEvent[] {
    if (this.done) return []
    this.done = true
    if (this.lastDone && !exit.stopped) return [...this.flushHeld(), this.lastDone]
    return [
      ...this.flushHeld(),
      { type: 'error', message: reason, recoverable: false },
      { type: 'done', sessionId: this.sessionId ?? '', isError: true },
    ]
  }

  private init(line: Rec): AgentEvent {
    const sessionId = str(line.session_id) ?? ''
    this.sessionId = sessionId
    return {
      type: 'session_started',
      sessionId,
      ...opt('model', str(line.model)),
      detail: {
        version: str(line.claude_code_version),
        permissionMode: str(line.permissionMode),
        mcpServers: arr(line.mcp_servers),
        toolCount: arr(line.tools).length,
      },
    }
  }

  private assistant(line: Rec): AgentEvent[] {
    const events: AgentEvent[] = []
    for (const block of arr(rec(line.message)?.content)) {
      if (!isRecord(block)) continue
      switch (block.type) {
        case 'text': {
          const text = str(block.text)
          if (text) events.push({ type: 'message', text })
          break
        }
        case 'thinking': {
          const text = str(block.thinking)
          if (text) events.push({ type: 'thinking', text })
          break
        }
        case 'tool_use': {
          const id = str(block.id) ?? ''
          const name = str(block.name) ?? 'unknown'
          const input = block.input
          events.push({ type: 'tool_call', id, name, input })
          const path = str(rec(input)?.file_path) ?? str(rec(input)?.notebook_path)
          if (FILE_TOOLS.has(name) && path) this.pendingFileTools.set(id, { path, tool: name })
          break
        }
        default:
          events.push({ type: 'raw', source: 'claude-cli', payload: block })
      }
    }
    return events
  }

  private user(line: Rec): AgentEvent[] {
    const events: AgentEvent[] = []
    for (const block of arr(rec(line.message)?.content)) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      const id = str(block.tool_use_id) ?? ''
      const isError = block.is_error === true
      events.push({ type: 'tool_result', id, output: block.content, isError })
      const pending = this.pendingFileTools.get(id)
      if (pending) {
        this.pendingFileTools.delete(id)
        if (!isError) {
          events.push({
            type: 'file_change',
            path: this.relPath(pending.path),
            kind: pending.tool === 'Write' ? writeKind(line) : 'modify',
          })
        }
      }
    }
    return events
  }

  private rateLimit(line: Rec): AgentEvent[] {
    const info = rec(line.rate_limit_info)
    if (!info) return [{ type: 'raw', source: 'claude-cli', payload: line }]
    const status = str(info.status)
    const windows: QuotaWindow[] = []
    for (const [name, w] of Object.entries(rec(info.unifiedWindows) ?? {})) {
      const utilization = num(rec(w)?.utilization)
      if (utilization === undefined) continue
      windows.push({ name, utilization, ...opt('resetsAt', num(rec(w)?.resetsAt)) })
    }
    return [
      {
        type: 'quota',
        status: status === 'allowed' ? 'allowed' : status === 'allowed_warning' ? 'warning' : 'limited',
        windows,
        ...opt('resetsAt', num(info.resetsAt)),
      },
    ]
  }

  private flushHeld(): AgentEvent[] {
    const held = this.beforeInit
    this.beforeInit = []
    return held
  }

  private result(line: Rec): AgentEvent[] {
    if (!this.options.multiTurn) this.done = true
    const usage = rec(line.usage)
    const isError = line.is_error === true
    const final = str(line.result)
    const events: AgentEvent[] = [
      ...this.flushHeld(),
      {
        type: 'usage',
        ...opt('inputTokens', num(usage?.input_tokens)),
        ...opt('outputTokens', num(usage?.output_tokens)),
        ...opt('cachedInputTokens', num(usage?.cache_read_input_tokens)),
        ...opt('costUsd', num(line.total_cost_usd)),
      },
    ]
    if (isError) {
      events.push({
        type: 'error',
        message: final ?? `Claude Code ended with ${str(line.subtype) ?? 'an error'}`,
        recoverable: false,
      })
    }
    const done: AgentEvent = {
      type: 'done',
      sessionId: str(line.session_id) ?? this.sessionId ?? '',
      isError,
      ...opt('finalMessage', final),
      ...opt('structured', line.structured_output ?? undefined),
    }
    if (this.options.multiTurn) this.lastDone = done
    else events.push(done)
    return events
  }

  private relPath(path: string): string {
    const cwd = this.options.cwd
    if (!cwd || !isAbsolute(path)) return path
    const rel = relative(cwd, path)
    return rel.startsWith('..') ? path : rel
  }
}

/** Write's tool_use_result.type is 'create' for new files (not yet seen in a fixture; falls back to 'modify'). */
function writeKind(line: Rec): 'add' | 'modify' {
  const meta = rec(line.tool_use_result)
  if (str(meta?.type) === 'create') return 'add'
  return 'modify'
}
