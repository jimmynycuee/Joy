// Maps `codex exec --json` lines to AgentEvents.
// Event shapes: @openai/codex-sdk ThreadEvent types (docs/spikes/codex.md). Real fixtures are still pending
// (STATUS.md); tests use the network-error recording plus synthetic streams built from the SDK types.
import { isAbsolute, posix, relative } from 'node:path'
import type { AgentEvent, FileChangeKind } from '@joy/core'
import type { Rec } from '../guards.js'
import { arr, isRecord, num, opt, rec, str } from '../guards.js'

export interface CodexParserOptions {
  cwd?: string
  /** WSL Codex reports POSIX paths even when Joy runs on Windows. */
  cwdStyle?: 'native' | 'posix'
  /** The run asked for --output-schema: parse the final message as JSON into `done.structured`. */
  structured?: boolean
}

const KIND: Record<string, FileChangeKind> = { add: 'add', delete: 'delete', update: 'modify' }

export class CodexStreamParser {
  private sessionId: string | undefined
  private done = false
  private lastMessage: string | undefined
  private readonly announced = new Set<string>()

  constructor(private readonly options: CodexParserOptions = {}) {}

  get finished(): boolean {
    return this.done
  }

  push(line: unknown): AgentEvent[] {
    if (this.done) return []
    if (!isRecord(line)) return [{ type: 'raw', source: 'codex-cli', payload: line }]
    switch (line.type) {
      case 'thread.started': {
        this.sessionId = str(line.thread_id) ?? ''
        return [{ type: 'session_started', sessionId: this.sessionId }]
      }
      case 'turn.started':
        return []
      case 'item.started':
        return this.itemStarted(rec(line.item))
      case 'item.updated':
        return this.itemUpdated(rec(line.item))
      case 'item.completed':
        return this.itemCompleted(rec(line.item))
      case 'turn.completed':
        return this.turnCompleted(line)
      case 'turn.failed': {
        this.done = true
        const message = str(rec(line.error)?.message) ?? 'Codex turn failed'
        return [
          { type: 'error', message, recoverable: false },
          { type: 'done', sessionId: this.sessionId ?? '', isError: true },
        ]
      }
      case 'error':
        // Seen in practice as "Reconnecting... 2/5": a notice, not the end. Fatal errors arrive as turn.failed.
        return [{ type: 'error', message: str(line.message) ?? 'Codex error', recoverable: true }]
      default:
        return [{ type: 'raw', source: 'codex-cli', payload: line }]
    }
  }

  finish(reason: string): AgentEvent[] {
    if (this.done) return []
    this.done = true
    return [
      { type: 'error', message: reason, recoverable: false },
      { type: 'done', sessionId: this.sessionId ?? '', isError: true },
    ]
  }

  private toolCall(item: Rec): AgentEvent | undefined {
    const id = str(item.id) ?? ''
    if (this.announced.has(id)) return undefined
    switch (item.type) {
      case 'command_execution':
        this.announced.add(id)
        return { type: 'tool_call', id, name: 'shell', input: { command: str(item.command) ?? '' } }
      case 'mcp_tool_call':
        this.announced.add(id)
        return {
          type: 'tool_call',
          id,
          name: `mcp__${str(item.server) ?? 'unknown'}__${str(item.tool) ?? 'unknown'}`,
          input: item.arguments,
        }
      case 'web_search':
        this.announced.add(id)
        return { type: 'tool_call', id, name: 'web_search', input: { query: str(item.query) ?? '' } }
      default:
        return undefined
    }
  }

  private itemStarted(item: Rec | undefined): AgentEvent[] {
    if (!item) return []
    const call = this.toolCall(item)
    return call ? [call] : []
  }

  private itemUpdated(item: Rec | undefined): AgentEvent[] {
    if (item?.type === 'todo_list') return [todoStatus(item)]
    return []
  }

  private itemCompleted(item: Rec | undefined): AgentEvent[] {
    if (!item) return []
    const id = str(item.id) ?? ''
    switch (item.type) {
      case 'agent_message': {
        const text = str(item.text) ?? ''
        this.lastMessage = text
        return text ? [{ type: 'message', text }] : []
      }
      case 'reasoning': {
        const text = str(item.text) ?? ''
        return text ? [{ type: 'thinking', text }] : []
      }
      case 'command_execution': {
        const exitCode = num(item.exit_code)
        return [
          ...this.itemStarted(item),
          {
            type: 'tool_result',
            id,
            output: { output: str(item.aggregated_output) ?? '', ...opt('exitCode', exitCode) },
            isError: item.status === 'failed' || (exitCode !== undefined && exitCode !== 0),
          },
        ]
      }
      case 'mcp_tool_call': {
        const failed = item.status === 'failed'
        return [
          ...this.itemStarted(item),
          {
            type: 'tool_result',
            id,
            output: failed ? (str(rec(item.error)?.message) ?? 'failed') : rec(item.result)?.content,
            isError: failed,
          },
        ]
      }
      case 'web_search':
        return [...this.itemStarted(item), { type: 'tool_result', id, output: null, isError: false }]
      case 'file_change': {
        if (item.status !== 'completed') return []
        return arr(item.changes).flatMap((c): AgentEvent[] => {
          const path = str(rec(c)?.path)
          const kind = KIND[str(rec(c)?.kind) ?? '']
          return path && kind ? [{ type: 'file_change', path: this.relPath(path), kind }] : []
        })
      }
      case 'todo_list':
        return [todoStatus(item)]
      case 'error':
        return [{ type: 'error', message: str(item.message) ?? 'Codex error', recoverable: true }]
      default:
        return [{ type: 'raw', source: 'codex-cli', payload: item }]
    }
  }

  private turnCompleted(line: Rec): AgentEvent[] {
    this.done = true
    const usage = rec(line.usage)
    let structured: unknown
    if (this.options.structured && this.lastMessage) {
      try {
        structured = JSON.parse(this.lastMessage)
      } catch {
        structured = undefined
      }
    }
    return [
      {
        type: 'usage',
        ...opt('inputTokens', num(usage?.input_tokens)),
        ...opt('outputTokens', num(usage?.output_tokens)),
        ...opt('cachedInputTokens', num(usage?.cached_input_tokens)),
      },
      {
        type: 'done',
        sessionId: this.sessionId ?? '',
        isError: false,
        ...opt('finalMessage', this.lastMessage),
        ...opt('structured', structured),
      },
    ]
  }

  private relPath(path: string): string {
    const cwd = this.options.cwd
    if (!cwd) return path
    if (this.options.cwdStyle === 'posix') {
      if (!posix.isAbsolute(path)) return path
      const rel = posix.relative(cwd, path)
      return rel.startsWith('..') ? path : rel
    }
    if (!isAbsolute(path)) return path
    const rel = relative(cwd, path)
    return rel.startsWith('..') ? path : rel
  }
}

function todoStatus(item: Rec): AgentEvent {
  const items = arr(item.items).filter(isRecord)
  const doneCount = items.filter((i) => i.completed === true).length
  const next = items.find((i) => i.completed !== true)
  const text = `Plan ${doneCount}/${items.length}${next ? `: ${str(next.text) ?? ''}` : ''}`
  return { type: 'status', text }
}
