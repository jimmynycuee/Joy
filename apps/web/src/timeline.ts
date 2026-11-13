import { PHASE_LABELS, ROLE_SPEAKERS } from './labels.js'
import { messageDeliveryStates } from './messages.js'
import type { DeliveryState } from './messages.js'
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

/** What a review card shows; a timeline review entry and the review of a pending plan both fit. */
export interface ReviewView {
  target: 'plan' | 'change'
  round: number
  approve: boolean | undefined
  summary: string
  findings: ReviewFindingView[]
}

interface EntryBase {
  /** Stable React key and the sequence number the e2e tests read (`data-event-seq`). */
  key: string
  seq: number
  ts: string
}

export type TimelineEntry =
  | (EntryBase & { kind: 'message'; text: string; role?: string; attemptId?: string })
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
  | (EntryBase & { kind: 'user'; id: string; text: string; state: DeliveryState })
  | (EntryBase & {
      kind: 'checks'
      round: number
      ok: boolean
      exitCode: number | null
      durationMs?: number
      outputTail: string
      timedOut: boolean
    })
  /** `detail` is Markdown that the step folds away (a past version of the plan). */
  | (EntryBase & { kind: 'step'; text: string; tone?: string; detail?: string })
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

/** A plan's review (the verdict the reviewer gave) as a card model; null when there is none. */
export function planReviewView(review: unknown): ReviewView | null {
  const verdict = record(review)
  if (!verdict) return null
  return {
    target: 'plan',
    round: 0,
    approve: typeof verdict.approve === 'boolean' ? verdict.approve : undefined,
    summary: typeof verdict.summary === 'string' ? verdict.summary : '',
    findings: reviewFindings(verdict.findings),
  }
}

/** Server warnings that are fixed English sentences, in plain Chinese. */
const WARNING_LABELS: Record<string, string> = {
  'Implementer and reviewer use the same model: this is not a cross-model review.':
    '實作和審查用同一個模型，這次不是跨模型審查。',
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
  if (event.type === 'warning' && typeof payload?.message === 'string')
    return WARNING_LABELS[payload.message] ?? payload.message
  if (event.type === 'started') return '任務開始'
  if (event.type === 'workspace') return '已準備好獨立的工作副本'
  if (event.type === 'publish.done') return '已推送到 PR'
  if (event.type === 'worktree.removed') {
    if (payload?.pullRequestState === 'merged') return 'PR 已合併，已清除工作副本'
    if (payload?.pullRequestState === 'closed') return 'PR 已關閉，已清除工作副本'
    return '已清除工作副本'
  }
  if (event.type === 'compete.judgement') return '裁判已比較兩個方案'
  if (event.type === 'compete.chosen') return '你選好了一個方案'
  if (event.type === 'user.message' && typeof payload?.text === 'string') return payload.text
  if (event.type === 'user.message.delivered') {
    if (payload?.via === 'interrupt') return '已打斷 agent，訊息已交給它'
    if (payload?.via === 'steer' && payload.late === true)
      return 'agent 稍晚才收到訊息，已從排隊中移除，不會再送一次'
    if (payload?.via === 'steer') return '訊息已交給 agent，它會邊做邊參考'
    return '訊息已交給 agent'
  }
  if (event.type === 'user.message.requeued')
    return payload?.reason === 'steer_failed'
      ? '沒能即時交給 agent，訊息改為等它下一次動手'
      : '沒有打斷成，訊息改為等 agent 下一次動手'
  if (event.type === 'steer.available')
    return payload?.available === true
      ? 'agent 可以邊做邊收你的訊息'
      : 'agent 這一步結束，訊息改為下一次動手時送達'
  if (event.type === 'run.interrupted') return '已中斷目前這一步，帶著你的訊息繼續'
  if (event.type === 'user.message.discarded') return '訊息已撤回'
  if (event.type === 'plan.awaiting_approval') return '計畫寫好了，等你核准'
  if (event.type === 'plan.approved')
    return typeof payload?.note === 'string' ? `你核准了計畫：${payload.note}` : '你核准了計畫，開始實作'
  if (event.type === 'plan.rejected')
    return typeof payload?.note === 'string' ? `你取消了計畫：${payload.note}` : '你取消了計畫'
  if (event.type === 'checks') return payload?.ok === true ? '專案檢查通過' : '專案檢查失敗'
  if (event.type === 'checks.skipped')
    return `略過專案檢查${typeof payload?.reason === 'string' ? `：${payload.reason}` : ''}`
  if (event.type === 'checkpoint.created') return `已建立檢查點 ${String(payload?.n ?? '')}`.trim()
  if (event.type === 'checkpoint.restored') {
    const dropped = typeof payload?.discardedCommits === 'number' ? payload.discardedCommits : 0
    return `已還原到檢查點 ${String(payload?.n ?? '')}${dropped > 0 ? `，丟掉 ${dropped} 個 commit` : ''}`
  }
  if (event.type === 'task.updated') return '任務已更新'
  return event.type.replaceAll('_', ' ')
}

/**
 * Turns the raw event log into what a person needs to read. Tool results are folded into the call they answer;
 * low-level chatter becomes "noise" (hidden behind 顯示細節).
 */
export interface TimelineOptions {
  /** Ids the server still holds as queued messages, to tell a lost queued message from a waiting one. */
  queuedIds?: ReadonlySet<string>
  /** Whether the task is running; a queued message waits only while it is. */
  busy?: boolean
  /** The plan is shown as its own card at the end, so its timeline step does not repeat it. */
  pendingPlan?: boolean
}

/** Events that only change state; they stay behind 顯示細節. */
const QUIET_EVENTS = new Set([
  'user.message.delivered',
  'user.message.discarded',
  'user.message.requeued',
  'steer.available',
  'checkpoint.created',
  'task.updated',
])

const STEP_TONES: Record<string, string> = {
  'plan.approved': 'ok',
  'plan.rejected': 'bad',
  'checkpoint.restored': 'ok',
  'checks.skipped': 'muted',
  'run.interrupted': 'muted',
}

export function buildTimeline(
  events: readonly TaskEvent[],
  worktreePath?: string,
  options: TimelineOptions = {},
): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const toolEntries = new Map<string, Extract<TimelineEntry, { kind: 'tool' }>>()
  const deliveries = messageDeliveryStates(events, {
    ...(options.queuedIds ? { queuedIds: options.queuedIds } : {}),
    ...(options.busy !== undefined ? { busy: options.busy } : {}),
  })
  const lastPlanIndex = events.findLastIndex((event) => event.type === 'plan.awaiting_approval')
  let lastThinking: Extract<TimelineEntry, { kind: 'noise' }> | undefined

  events.forEach((event, index) => {
    const base = { key: `${event.seq}-${index}`, seq: event.seq, ts: event.ts }
    const payload = record(event.payload)
    const text = eventTitle(event)

    if (event.type === 'agent') {
      const agentEvent = record(payload?.event)
      const role = typeof payload?.role === 'string' ? ROLE_SPEAKERS[payload.role] : undefined
      const type = agentEvent?.type
      if (type === 'message' && typeof agentEvent?.text === 'string') {
        // Codex and the OpenAI API stream a reply as many small `message` events; one reply is one bubble.
        const last = entries.at(-1)
        if (last?.kind === 'message' && last.role === role && last.attemptId === event.attemptId) {
          last.text += agentEvent.text
          return
        }
        entries.push({
          ...base,
          kind: 'message',
          text,
          ...(role ? { role } : {}),
          ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        })
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
      } else if (type === 'thinking' && typeof agentEvent?.text === 'string') {
        // Reasoning streams in fragments too: keep one detail line per stretch of thinking.
        const last = entries.at(-1)
        if (lastThinking && last === lastThinking) {
          lastThinking.text += agentEvent.text
          return
        }
        const entry: Extract<TimelineEntry, { kind: 'noise' }> = { ...base, kind: 'noise', text }
        entries.push(entry)
        lastThinking = entry
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
    if (event.type === 'user.message' && typeof payload?.text === 'string') {
      const id = typeof payload.id === 'string' ? payload.id : base.key
      entries.push({ ...base, kind: 'user', id, text: payload.text, state: deliveries.get(id) ?? 'sent' })
      return
    }
    if (event.type === 'checks') {
      entries.push({
        ...base,
        kind: 'checks',
        round: typeof payload?.round === 'number' ? payload.round : 0,
        ok: payload?.ok === true,
        exitCode: typeof payload?.exitCode === 'number' ? payload.exitCode : null,
        ...(typeof payload?.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
        outputTail: typeof payload?.outputTail === 'string' ? payload.outputTail : '',
        timedOut: payload?.timedOut === true,
      })
      return
    }
    if (QUIET_EVENTS.has(event.type)) {
      entries.push({ ...base, kind: 'noise', text })
      return
    }
    if (event.type === 'plan.awaiting_approval') {
      const plan = typeof payload?.plan === 'string' ? payload.plan : ''
      const showPlan = plan && !(options.pendingPlan && index === lastPlanIndex)
      entries.push({ ...base, kind: 'step', text, ...(showPlan ? { detail: plan } : {}) })
      return
    }
    if (policyEventIsNoise(event.type, payload) || event.type === 'compete.result') {
      entries.push({ ...base, kind: 'noise', text })
      return
    }
    const tone = STEP_TONES[event.type] ?? policyEventKind(event.type, payload)
    entries.push({ ...base, kind: 'step', text, ...(tone ? { tone } : {}) })
  })
  return entries
}
