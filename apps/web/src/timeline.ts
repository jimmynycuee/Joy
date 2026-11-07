import { PHASE_LABELS, ROLE_SPEAKERS } from './labels.js'
import { policyEventIsNoise, policyEventKind, policyEventTitle } from './policy-events.js'
import { summarizeToolCall, toolCallLabel, toolOutputText } from './tool-calls.js'
import type { ToolOutput, ToolSummary } from './tool-calls.js'
import { record } from './types.js'
import type { TaskEvent } from './types.js'

export interface ReviewFindingView {
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  message: string
  file?: string
  line?: number
}

interface EntryBase {
  /** Stable React key and the sequence number the e2e tests read (`data-event-seq`). */
  key: string
  seq: number
  ts: string
}

export type TimelineEntry =
  | (EntryBase & { kind: 'message'; text: string; role?: string })
  | (EntryBase & {
      kind: 'tool'
      name: string
      summary: ToolSummary
      label: string
      output?: ToolOutput
      isError: boolean
    })
  | (EntryBase & { kind: 'phase'; text: string })
  | (EntryBase & {
      kind: 'review'
      text: string
      target: 'plan' | 'change'
      round: number
      approve: boolean | undefined
      summary: string
      findings: ReviewFindingView[]
    })
  | (EntryBase & { kind: 'error'; text: string })
  | (EntryBase & { kind: 'step'; text: string; tone?: string })
  | (EntryBase & { kind: 'noise'; text: string })

const SEVERITIES = new Set(['blocker', 'major', 'minor', 'nit'])

export function reviewFindings(value: unknown): ReviewFindingView[] {
  if (!Array.isArray(value)) return []
  const findings: ReviewFindingView[] = []
  for (const item of value) {
    const finding = record(item)
    if (typeof finding?.message !== 'string') continue
    findings.push({
      severity:
        typeof finding.severity === 'string' && SEVERITIES.has(finding.severity)
          ? (finding.severity as ReviewFindingView['severity'])
          : 'minor',
      message: finding.message,
      ...(typeof finding.file === 'string' ? { file: finding.file } : {}),
      ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
    })
  }
  return findings
}

/** Plain-language title of a raw task event. Events without a good title fall back to their type. */
export function eventTitle(event: TaskEvent): string {
  const payload = record(event.payload)
  const policyTitle = policyEventTitle(event.type, payload)
  if (policyTitle) return policyTitle
  if (event.type === 'agent') {
    const agentEvent = record(payload?.event)
    if (agentEvent?.type === 'message' && typeof agentEvent.text === 'string') return agentEvent.text
    if (agentEvent?.type === 'thinking' && typeof agentEvent.text === 'string') return agentEvent.text
    if (agentEvent?.type === 'tool_call' && typeof agentEvent.name === 'string')
      return `執行 ${agentEvent.name}`
    if (agentEvent?.type === 'done') return 'Agent 完成了這一步'
    if (agentEvent?.type === 'error' && typeof agentEvent.message === 'string') return agentEvent.message
    return `Agent 事件：${String(agentEvent?.type ?? 'update')}`
  }
  if (event.type === 'phase' && typeof payload?.phase === 'string')
    return `階段：${PHASE_LABELS[payload.phase] ?? payload.phase}`
  if (event.type === 'result') return '任務結果已產生'
  if (event.type === 'review') {
    const summary = record(payload?.verdict)?.summary
    if (typeof summary === 'string' && summary) return `審查：${summary}`
  }
  if (event.type === 'error' && typeof payload?.message === 'string') return payload.message
  if (event.type === 'warning' && typeof payload?.message === 'string') return payload.message
  if (event.type === 'started') return '任務開始'
  if (event.type === 'workspace') return '已準備好獨立的工作副本'
  if (event.type === 'publish.done') return '已開 draft PR'
  if (event.type === 'worktree.removed') return '已清除工作副本'
  if (event.type === 'compete.judgement') return '裁判已比較兩個方案'
  if (event.type === 'compete.chosen') return '你選好了一個方案'
  return event.type.replaceAll('_', ' ')
}

/**
 * Turns the raw event log into what a person needs to read. Tool results are folded into the call they answer;
 * low-level chatter becomes "noise" (hidden behind 顯示細節).
 */
export function buildTimeline(events: readonly TaskEvent[], worktreePath?: string): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const toolEntries = new Map<string, Extract<TimelineEntry, { kind: 'tool' }>>()

  events.forEach((event, index) => {
    const base = { key: `${event.seq}-${index}`, seq: event.seq, ts: event.ts }
    const payload = record(event.payload)
    const text = eventTitle(event)

    if (event.type === 'agent') {
      const agentEvent = record(payload?.event)
      const role = typeof payload?.role === 'string' ? ROLE_SPEAKERS[payload.role] : undefined
      const type = agentEvent?.type
      if (type === 'message' && typeof agentEvent?.text === 'string') {
        entries.push({ ...base, kind: 'message', text, ...(role ? { role } : {}) })
      } else if (type === 'tool_call' && typeof agentEvent?.name === 'string') {
        const summary = summarizeToolCall(agentEvent.name, agentEvent.input, worktreePath)
        const entry: Extract<TimelineEntry, { kind: 'tool' }> = {
          ...base,
          kind: 'tool',
          name: agentEvent.name,
          summary,
          label: toolCallLabel(summary),
          isError: false,
        }
        entries.push(entry)
        if (typeof agentEvent.id === 'string' && agentEvent.id) toolEntries.set(agentEvent.id, entry)
      } else if (type === 'tool_result') {
        const call = typeof agentEvent?.id === 'string' ? toolEntries.get(agentEvent.id) : undefined
        if (call) {
          call.output = toolOutputText(agentEvent?.output)
          call.isError = agentEvent?.isError === true
        } else {
          entries.push({ ...base, kind: 'noise', text: 'Agent 事件：tool_result' })
        }
      } else if (type === 'error') {
        entries.push({ ...base, kind: 'error', text })
      } else {
        entries.push({ ...base, kind: 'noise', text })
      }
      return
    }
    if (event.type === 'phase') {
      entries.push({ ...base, kind: 'phase', text })
      return
    }
    if (event.type === 'review') {
      const verdict = record(payload?.verdict)
      entries.push({
        ...base,
        kind: 'review',
        text,
        target: payload?.target === 'plan' ? 'plan' : 'change',
        round: typeof payload?.round === 'number' ? payload.round : 0,
        approve: typeof verdict?.approve === 'boolean' ? verdict.approve : undefined,
        summary: typeof verdict?.summary === 'string' ? verdict.summary : '',
        findings: reviewFindings(verdict?.findings),
      })
      return
    }
    if (event.type === 'error') {
      entries.push({ ...base, kind: 'error', text })
      return
    }
    if (policyEventIsNoise(event.type, payload) || event.type === 'compete.result') {
      entries.push({ ...base, kind: 'noise', text })
      return
    }
    const tone = policyEventKind(event.type, payload)
    entries.push({ ...base, kind: 'step', text, ...(tone ? { tone } : {}) })
  })
  return entries
}
