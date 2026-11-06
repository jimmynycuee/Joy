import type { AgentEvent, FileChangeKind } from '@joy/core'
import { isAbsolute, relative, win32 } from 'node:path'
import type { RateLimitSnapshot, RateLimitWindow } from './app-server-protocol.js'
import type { Rec } from '../guards.js'
import { arr, isRecord, num, opt, rec, str } from '../guards.js'

export interface AppServerParserOptions {
  cwd: string
  structured: boolean
}

/** Maps Codex app-server JSON-RPC notifications to Joy's provider event contract. */
export class CodexAppServerParser {
  private sessionId = ''
  private done = false
  private lastMessage = ''
  private readonly streamedMessages = new Set<string>()
  private readonly messageText = new Map<string, string>()
  private readonly announcedTools = new Set<string>()
  private readonly commandOutput = new Map<string, string>()
  private readonly rateLimits = new Map<string, RateLimitSnapshot>()
  private ordinaryUsageAllowed: boolean | undefined

  constructor(private readonly options: AppServerParserOptions) {}

  get finished(): boolean {
    return this.done
  }

  startSession(sessionId: string): AgentEvent[] {
    if (!sessionId || this.sessionId === sessionId) return []
    this.sessionId = sessionId
    return [{ type: 'session_started', sessionId }]
  }

  initialRateLimits(value: unknown): AgentEvent[] {
    const response = rec(value)
    if (!response) return []
    this.ordinaryUsageAllowed =
      typeof response.ordinaryUsageAllowed === 'boolean' ? response.ordinaryUsageAllowed : undefined
    const snapshots = new Map<string, unknown>()
    if (isRecord(response.rateLimitsByLimitId)) {
      for (const [key, snapshot] of Object.entries(response.rateLimitsByLimitId)) snapshots.set(key, snapshot)
    }
    if (snapshots.size === 0 && response.rateLimits) snapshots.set('default', response.rateLimits)
    return [...snapshots].flatMap(([key, snapshot]) => this.acceptRateLimit(snapshot, key))
  }

  notification(method: string, params: unknown): AgentEvent[] {
    if (this.done) return []
    const p = rec(params)
    switch (method) {
      case 'thread/started': {
        const id = str(rec(p?.thread)?.id)
        return id ? this.startSession(id) : []
      }
      case 'account/rateLimits/updated':
        return this.acceptRateLimit(p?.rateLimits)
      case 'item/agentMessage/delta': {
        const id = str(p?.itemId) ?? ''
        const delta = str(p?.delta) ?? ''
        if (!delta) return []
        this.streamedMessages.add(id)
        this.messageText.set(id, (this.messageText.get(id) ?? '') + delta)
        this.lastMessage = this.messageText.get(id) ?? this.lastMessage
        return [{ type: 'message', text: delta }]
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = str(p?.delta)
        return delta ? [{ type: 'thinking', text: delta }] : []
      }
      case 'item/commandExecution/outputDelta': {
        const id = str(p?.itemId) ?? ''
        const delta = str(p?.delta) ?? ''
        this.commandOutput.set(id, (this.commandOutput.get(id) ?? '') + delta)
        return []
      }
      case 'item/started':
        return this.itemStarted(rec(p?.item))
      case 'item/completed':
        return this.itemCompleted(rec(p?.item))
      case 'turn/plan/updated': {
        const text = str(p?.plan)
        return text ? [{ type: 'status', text }] : []
      }
      case 'turn/completed':
        return this.turnCompleted(p)
      default:
        return [{ type: 'raw', source: 'codex-cli', payload: { method, params } }]
    }
  }

  private acceptRateLimit(value: unknown, keyHint?: string): AgentEvent[] {
    if (!isRecord(value)) return []
    const incoming = parseRateLimitSnapshot(value)
    if (!incoming) return []
    const key = incoming.limitId ?? keyHint ?? 'default'
    const previous = this.rateLimits.get(key)
    const merged = previous ? mergeRateLimit(previous, incoming) : incoming
    this.rateLimits.set(key, merged)
    return [quotaEvent(merged, this.ordinaryUsageAllowed)]
  }

  private itemStarted(item: Rec | undefined): AgentEvent[] {
    if (!item) return []
    const call = this.toolCall(item)
    return call ? [call] : []
  }

  private itemCompleted(item: Rec | undefined): AgentEvent[] {
    if (!item) return []
    const id = str(item.id) ?? ''
    switch (item.type) {
      case 'agentMessage': {
        const text = str(item.text) ?? ''
        this.messageText.set(id, text || this.messageText.get(id) || '')
        this.lastMessage = this.messageText.get(id) ?? this.lastMessage
        return this.streamedMessages.has(id) || !text ? [] : [{ type: 'message', text }]
      }
      case 'reasoning': {
        const content = arr(item.content)
          .filter((part): part is string => typeof part === 'string')
          .join('')
        const summary = arr(item.summary)
          .filter((part): part is string => typeof part === 'string')
          .join('\n')
        const text = content || summary
        return text ? [{ type: 'thinking', text }] : []
      }
      case 'commandExecution': {
        const call = this.toolCall(item)
        const code = num(item.exitCode)
        const output = str(item.aggregatedOutput) ?? this.commandOutput.get(id) ?? ''
        const status = str(item.status)
        const failed = status === 'failed' || status === 'declined' || (code !== undefined && code !== 0)
        return [
          ...(call ? [call] : []),
          {
            type: 'tool_result',
            id,
            output: { output, ...opt('exitCode', code) },
            isError: failed,
          },
          ...(status === 'declined'
            ? [{ type: 'permission_denied' as const, toolName: 'shell', reason: 'Codex approval declined' }]
            : []),
        ]
      }
      case 'mcpToolCall': {
        const call = this.toolCall(item)
        const failed = item.status === 'failed'
        return [
          ...(call ? [call] : []),
          {
            type: 'tool_result',
            id,
            output: failed ? (rec(item.error)?.message ?? 'Codex MCP call failed') : item.result,
            isError: failed,
          },
        ]
      }
      case 'webSearch': {
        const call = this.toolCall(item)
        return [...(call ? [call] : []), { type: 'tool_result', id, output: item, isError: false }]
      }
      case 'fileChange': {
        if (item.status !== 'completed') return []
        return arr(item.changes).flatMap((change): AgentEvent[] => {
          const data = rec(change)
          const path = str(data?.path)
          const kind = fileKind(data?.kind)
          return path && kind ? [{ type: 'file_change', path: this.relPath(path), kind }] : []
        })
      }
      case 'plan': {
        const text = str(item.text)
        return text ? [{ type: 'status', text }] : []
      }
      default:
        return [{ type: 'raw', source: 'codex-cli', payload: item }]
    }
  }

  private toolCall(item: Rec): AgentEvent | undefined {
    const id = str(item.id) ?? ''
    if (this.announcedTools.has(id)) return undefined
    let call: AgentEvent | undefined
    switch (item.type) {
      case 'commandExecution':
        call = { type: 'tool_call', id, name: 'shell', input: { command: str(item.command) ?? '' } }
        break
      case 'mcpToolCall':
        call = {
          type: 'tool_call',
          id,
          name: `mcp__${str(item.server) ?? 'unknown'}__${str(item.tool) ?? 'unknown'}`,
          input: item.arguments,
        }
        break
      case 'webSearch':
        call = { type: 'tool_call', id, name: 'web_search', input: { query: str(item.query) ?? '' } }
        break
      default:
        return undefined
    }
    this.announcedTools.add(id)
    return call
  }

  private turnCompleted(value: Rec | undefined): AgentEvent[] {
    this.done = true
    const turn = rec(value?.turn)
    const status = str(turn?.status)
    const finalText = finalAgentMessage(turn) ?? this.lastMessage
    const error =
      str(rec(turn?.error)?.message) ??
      (status === 'interrupted' ? 'Codex turn was interrupted' : 'Codex turn failed')
    let structured: unknown
    if (this.options.structured && finalText) {
      try {
        structured = JSON.parse(finalText) as unknown
      } catch {
        structured = undefined
      }
    }
    return [
      ...(!this.lastMessage && finalText ? [{ type: 'message' as const, text: finalText }] : []),
      ...(status === 'completed' ? [] : [{ type: 'error' as const, message: error, recoverable: false }]),
      {
        type: 'done',
        sessionId: this.sessionId,
        isError: status !== 'completed',
        ...opt('finalMessage', finalText || undefined),
        ...opt('structured', structured),
      },
    ]
  }

  private relPath(path: string): string {
    const windowsStyle =
      process.platform === 'win32' ||
      /^[a-z]:[\\/]/i.test(path) ||
      path.startsWith('\\\\') ||
      /^[a-z]:[\\/]/i.test(this.options.cwd) ||
      this.options.cwd.startsWith('\\\\')
    const pathApi = windowsStyle ? win32 : undefined
    const absolute = pathApi ? pathApi.isAbsolute(path) : isAbsolute(path)
    if (!absolute) return windowsStyle ? path.replaceAll('\\', '/') : path
    const rel = pathApi ? pathApi.relative(this.options.cwd, path) : relative(this.options.cwd, path)
    const normalized = rel.startsWith('..') ? path : rel
    return windowsStyle ? normalized.replaceAll('\\', '/') : normalized
  }
}

function finalAgentMessage(turn: Rec | undefined): string | undefined {
  for (const item of [...arr(turn?.items)].reverse()) {
    const record = rec(item)
    const text = str(record?.text)
    if (record?.type === 'agentMessage' && text) return text
  }
  return undefined
}

function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot | undefined {
  const record = rec(value)
  if (!record) return undefined
  const window = (candidate: unknown): RateLimitWindow | null => {
    const w = rec(candidate)
    const usedPercent = num(w?.usedPercent)
    if (usedPercent === undefined) return null
    return {
      usedPercent,
      windowDurationMins: num(w?.windowDurationMins) ?? null,
      resetsAt: num(w?.resetsAt) ?? null,
    }
  }
  return {
    limitId: str(record.limitId) ?? null,
    limitName: str(record.limitName) ?? null,
    normalModelSlug: str(record.normalModelSlug) ?? null,
    primary: window(record.primary),
    secondary: window(record.secondary),
    rateLimitReachedType: str(record.rateLimitReachedType) ?? null,
  }
}

function mergeRateLimit(previous: RateLimitSnapshot, incoming: RateLimitSnapshot): RateLimitSnapshot {
  const merged: Record<string, unknown> = { ...previous }
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined) merged[key] = value
  }
  return merged as RateLimitSnapshot
}

function quotaEvent(snapshot: RateLimitSnapshot, ordinaryUsageAllowed?: boolean): AgentEvent {
  const label = snapshot.limitName ?? snapshot.limitId ?? 'codex'
  const windows = (['primary', 'secondary'] as const).flatMap((slot) => {
    const window = snapshot[slot]
    if (!window || !Number.isFinite(window.usedPercent)) return []
    const utilization = Math.max(0, Math.min(1, window.usedPercent / 100))
    return [
      {
        name: `${label}_${slot}`,
        utilization,
        ...opt('resetsAt', window.resetsAt ?? undefined),
      },
    ]
  })
  const limited =
    ordinaryUsageAllowed === false ||
    snapshot.rateLimitReachedType != null ||
    windows.some((window) => window.utilization >= 1)
  const status = limited
    ? 'limited'
    : windows.some((window) => window.utilization >= 0.8)
      ? 'warning'
      : 'allowed'
  const resetTimes = windows.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt]))
  return {
    type: 'quota',
    status,
    windows,
    ...opt('resetsAt', resetTimes.length ? Math.min(...resetTimes) : undefined),
  }
}

function fileKind(value: unknown): FileChangeKind | undefined {
  const kind = isRecord(value) ? str(value.type) : str(value)
  switch (kind) {
    case 'add':
      return 'add'
    case 'delete':
      return 'delete'
    case 'update':
      return 'modify'
    default:
      return undefined
  }
}
