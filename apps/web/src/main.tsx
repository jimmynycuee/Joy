import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FormEvent, ReactNode } from 'react'
import { EFFORTS, PROVIDER_KINDS, ROLES } from '@joy/core'
import type { ModelRef, ProviderKind, Role, RoleConfig } from '@joy/core'
import type { JoyConfig } from '@joy/config'
import './styles.css'
import { policyEventKind, policyEventTitle } from './policy-events.js'

type Repo = { id: string; path: string; defaultBranch: string; githubRemote?: string }
type Task = {
  id: string
  repoId: string
  title: string
  prompt: string
  provenance?: 'user' | 'agent' | 'external_content'
  mode: string
  status: string
  roleOverrides?: Partial<RoleConfig>
  createdAt: string
}
type TaskEvent = {
  taskId: string
  attemptId?: string
  seq: number
  eventId?: string
  type: string
  payload: unknown
  ts: string
}
type DiffFile = { path: string; status: string; additions: number; deletions: number }
type WorkspaceDiff = { files: DiffFile[]; patch: string }
type TaskDetails = {
  task: Task
  repo: Repo | null
  attempts: unknown[]
  reviews: unknown[]
  events: TaskEvent[]
}
type SecretStatus = { set: boolean; source?: 'env' | 'keychain' }
type DoctorStatus = 'ok' | 'missing' | 'untested'
type DoctorCheck = {
  id: string
  label: string
  status: DoctorStatus
  summary: string
  repair: string
  version?: string
}
type DoctorReport = { checkedAt: string; checks: DoctorCheck[] }
type ApiError = { error?: string }

const ROLE_LABELS: Record<Role, string> = {
  assistant_brain: '助理大腦',
  background: '背景工作',
  orchestrator: '調度者',
  implementer: '實作者',
  reviewer: '審查者',
  judge: '裁判',
}
const PROVIDER_LABELS: Record<ProviderKind, string> = {
  'openai-api': 'OpenAI API',
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
}
const MODEL_SUGGESTIONS: Record<ProviderKind, string[]> = {
  'openai-api': ['gpt-6-luna'],
  'claude-cli': ['opus', 'sonnet', 'haiku'],
  'codex-cli': ['gpt-6.1-sol', 'gpt-6-luna'],
}

declare const __JOY_API_TOKEN__: string

const TOKEN_KEY = 'joy.apiToken'

/**
 * The access token: one this device saved (remote access, or after regenerating), else the one the local dev server
 * injected. Storage can be unavailable (private windows), so every access is guarded.
 */
function apiToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || __JOY_API_TOKEN__
  } catch {
    return __JOY_API_TOKEN__
  }
}

function saveApiToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Without storage the token only lasts until reload; the gate asks again.
  }
}

/** Tells the app the token was refused, so it can ask for a new one. */
const UNAUTHORIZED_EVENT = 'joy-unauthorized'

function providersForRole(role: Role): ProviderKind[] {
  return role === 'implementer'
    ? PROVIDER_KINDS.filter((provider) => provider !== 'openai-api')
    : [...PROVIDER_KINDS]
}

function doctorStatusLabel(status: DoctorStatus): string {
  return status === 'ok' ? '正常' : status === 'missing' ? '缺少' : '未驗證'
}

const DOCTOR_LABELS: Record<string, string> = {
  'gh-auth': 'GitHub CLI 登入',
  keychain: '作業系統鑰匙圈',
  'data-directory': 'Joy 資料夾',
}

const EFFORT_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排隊中',
  running: '進行中',
  awaiting_approval: '等你同意',
  review_ready: '待你決定',
  done: '完成',
  failed: '失敗',
  cancelled: '已取消',
}

const MODE_LABELS: Record<string, string> = {
  single: '單人',
  review_loop: '實作＋審查',
  compete: '兩家比賽',
}

const MODE_HINTS: Record<string, string> = {
  review_loop: '一個 AI 動手做，另一個 AI 再檢查一次。推送、刪除這類動作會先問你。',
  single: '只用一個 AI 完成，最快。',
  compete: '兩個 AI 各做一份、互相審查，最後由你挑一個。',
}

const PHASE_LABELS: Record<string, string> = {
  preparing: '準備工作環境',
  planning: '規劃中',
  plan_review: '審查計畫',
  implementing: '實作中',
  reviewing: '審查中',
  fixing: '依審查意見修正',
}

/** The title the owner typed, else the prompt's first line, so a task needs only one box. */
function taskTitle(title: string, prompt: string): string {
  const typed = title.trim()
  if (typed) return typed
  const firstLine = prompt.trim().split('\n')[0]?.trim() ?? ''
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replaceAll('_', ' ')
}

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode.replaceAll('_', ' ')
}

function repoName(path: string | undefined): string {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? '專案'
}

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('authorization', `Bearer ${apiToken()}`)
  const response = await fetch(path, { ...init, headers })
  if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  const text = await response.text()
  const body = text ? (JSON.parse(text) as T & ApiError) : ({} as T & ApiError)
  if (!response.ok) throw new Error(body.error ?? `請求失敗（${response.status}）`)
  return body
}

function roleModel(config: JoyConfig | null, role: Role): ModelRef {
  const model = config?.roles[role] ?? {
    provider: 'claude-cli' as const,
    model: 'opus',
    effort: 'medium' as const,
  }
  const provider = role === 'implementer' && model.provider === 'openai-api' ? 'claude-cli' : model.provider
  return {
    provider,
    model: provider === model.provider ? model.model : (MODEL_SUGGESTIONS[provider][0] ?? 'opus'),
    ...(model.effort ? { effort: model.effort } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function mergeEvents(first: TaskEvent[], second: TaskEvent[]): TaskEvent[] {
  const events = new Map<string, TaskEvent>()
  for (const event of [...first, ...second]) {
    const key =
      event.seq > 0
        ? `sequence:${event.seq}`
        : `ephemeral:${event.eventId ?? `${event.taskId}:${event.type}:${event.ts}:${JSON.stringify(event.payload)}`}`
    if (!events.has(key)) events.set(key, event)
  }
  return [...events.values()].sort((a, b) => {
    if (a.seq > 0 && b.seq > 0) return a.seq - b.seq
    if (a.seq > 0) return -1
    if (b.seq > 0) return 1
    return a.ts.localeCompare(b.ts)
  })
}

function taskAfterEvent(task: Task, event: TaskEvent): Task {
  const payload = record(event.payload)
  if (event.type === 'error') return { ...task, status: 'failed' }
  if (event.type !== 'result') return task
  if (payload?.status === 'succeeded')
    return { ...task, status: payload.approved === false ? 'review_ready' : 'done' }
  if (payload?.status === 'failed' || payload?.status === 'cancelled')
    return { ...task, status: payload.status }
  return task
}

function diffFrom(events: TaskEvent[]): WorkspaceDiff | null {
  // A decided compete task shows the attempt the owner chose.
  const chosen = record(
    [...events].reverse().find((event) => event.type === 'compete.chosen')?.payload,
  )?.attemptId
  if (typeof chosen === 'string') {
    const result = [...events].reverse().find((e) => e.type === 'compete.result' && e.attemptId === chosen)
    const diff = record(result?.payload)?.diff
    if (record(diff) && Array.isArray((diff as WorkspaceDiff).files)) return diff as WorkspaceDiff
  }
  for (const event of [...events].reverse()) {
    if (event.type !== 'result') continue
    const diff = record(event.payload)?.diff
    if (record(diff) && Array.isArray((diff as WorkspaceDiff).files)) return diff as WorkspaceDiff
  }
  return null
}

function eventTitle(event: TaskEvent): string {
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
  if (event.type === 'started') return '任務開始'
  if (event.type === 'workspace') return '已準備好獨立的工作副本'
  return event.type.replaceAll('_', ' ')
}

type TimelineItem = {
  kind: 'message' | 'step' | 'phase' | 'review' | 'error' | 'noise'
  text: string
  role?: string
  tone?: string
}

const ROLE_SPEAKERS: Record<string, string> = {
  implementer: '實作',
  reviewer: '審查',
  judge: '裁判',
  orchestrator: '調度',
}

/** Turns a raw task event into what a non-expert needs to see; low-level agent chatter becomes "noise". */
function timelineItem(event: TaskEvent): TimelineItem {
  const payload = record(event.payload)
  const text = eventTitle(event)
  if (event.type === 'agent') {
    const agentEvent = record(payload?.event)
    const role = typeof payload?.role === 'string' ? ROLE_SPEAKERS[payload.role] : undefined
    if (agentEvent?.type === 'message') return { kind: 'message', text, ...(role ? { role } : {}) }
    if (agentEvent?.type === 'tool_call' || agentEvent?.type === 'done') return { kind: 'step', text }
    if (agentEvent?.type === 'error') return { kind: 'error', text }
    return { kind: 'noise', text }
  }
  if (event.type === 'phase') return { kind: 'phase', text }
  if (event.type === 'review') return { kind: 'review', text }
  if (event.type === 'error') return { kind: 'error', text }
  const tone = policyEventKind(event.type, payload)
  return { kind: 'step', text, ...(tone ? { tone } : {}) }
}

function splitDiff(patch: string): Map<string, string> {
  const chunks = patch.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim())
  return new Map(
    chunks.map((chunk, index) => {
      const filePath = /^diff --git a\/.+ b\/(.+)$/m.exec(chunk)?.[1] ?? `file-${index + 1}`
      return [filePath, chunk]
    }),
  )
}

interface PendingApproval {
  id: string
  taskId: string
  createdAt: string
  status: string
  decidedVia?: string
  action: { kind: string; summary: string; provenance: string }
}

/** Red actions waiting for the owner in this task, with Approve / Deny. Refreshes on approval events. */
function ApprovalsPanel({
  taskId,
  taskStatus,
  approvalEvents,
}: {
  taskId: string
  taskStatus: string
  approvalEvents: number
}) {
  const [pending, setPending] = useState<PendingApproval[]>([])
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')

  useEffect(() => {
    let cancelled = false
    // A paused task also shows the request that timed out, so it can still be approved and resumed.
    const paused = taskStatus === 'awaiting_approval' || taskStatus === 'failed'
    const load = () =>
      request<{ approvals: PendingApproval[] }>(`/api/approvals?taskId=${encodeURIComponent(taskId)}`)
        .then((body) => {
          // Never trust the shape of a response: a missing list must not take the whole page down.
          const all = Array.isArray(body.approvals) ? body.approvals : []
          const open = all.filter(
            (approval) =>
              approval.status === 'pending' ||
              (paused && approval.status === 'expired' && approval.decidedVia === 'timeout'),
          )
          if (!cancelled) setPending(open)
        })
        .catch(() => undefined)
    void load()
    // Events usually trigger the refresh; the timer catches approvals that expire quietly.
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [taskId, taskStatus, approvalEvents])

  async function decide(id: string, decision: 'approve' | 'deny') {
    setBusy(id)
    setFailure('')
    try {
      await request(`/api/approvals/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: '{}' })
      setPending((current) => current.filter((approval) => approval.id !== id))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '無法記錄你的決定')
    } finally {
      setBusy('')
    }
  }

  if (pending.length === 0) return null
  return (
    <section className="approvals-panel" aria-label="等你同意的動作" data-testid="pending-approvals">
      <h2>{pending.some((a) => a.status === 'expired') ? '已暫停，等你同意後繼續' : '需要你同意'}</h2>
      {failure ? <p className="approvals-error">{failure}</p> : null}
      {pending.map((approval) => (
        <div className="approval-row" key={approval.id}>
          <div>
            <strong>
              {policyEventTitle('policy.action', {
                kind: approval.action.kind,
                tier: 'approve',
                provenance: approval.action.provenance,
              })}
            </strong>
            <p>{approval.action.summary}</p>
          </div>
          <div className="approval-actions">
            <button
              type="button"
              disabled={busy === approval.id}
              onClick={() => void decide(approval.id, 'approve')}
            >
              {approval.status === 'expired' ? '同意並繼續' : '同意'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy === approval.id}
              onClick={() => void decide(approval.id, 'deny')}
            >
              拒絕
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}

/** Telegram settings: owner chat id (config) and bot token (OS keychain). Applies after Joy restarts. */
function TelegramSettings({
  config,
  onConfig,
}: {
  config: JoyConfig
  onConfig: (config: JoyConfig) => void
}) {
  const [tokenStatus, setTokenStatus] = useState<SecretStatus | null>(null)
  const [message, setMessage] = useState('')
  // An older server may not send the channels section at all.
  const chatId = config.channels?.telegram?.owner_chat_id

  useEffect(() => {
    request<SecretStatus>('/api/secrets/telegram-bot-token')
      .then(setTokenStatus)
      .catch(() => setTokenStatus(null))
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // currentTarget is cleared once the handler awaits, so keep the element.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const chatId = String(form.get('telegram-chat-id') ?? '').trim()
    const token = String(form.get('telegram-token') ?? '').trim()
    setMessage('')
    try {
      const next = { ...config, channels: { telegram: chatId ? { owner_chat_id: chatId } : {} } }
      const saved = await request<{ config: JoyConfig }>('/api/config', {
        method: 'PUT',
        body: JSON.stringify(next),
      })
      onConfig(saved.config)
      if (token) {
        setTokenStatus(
          await request<SecretStatus>('/api/secrets/telegram-bot-token', {
            method: 'PUT',
            body: JSON.stringify({ value: token }),
          }),
        )
      }
      formElement.reset()
      setMessage('已儲存。重新啟動 Joy 後才會連上 Telegram。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法儲存 Telegram 設定')
    }
  }

  return (
    <section className="settings-card" aria-labelledby="telegram-heading">
      <div className="section-heading">
        <h2 id="telegram-heading">Telegram</h2>
        <span className={tokenStatus?.set && chatId ? 'status-pill configured' : 'status-pill'}>
          {tokenStatus?.set && chatId ? '已設定' : '未設定'}
        </span>
      </div>
      <p className="muted secret-description">
        Joy 會把需要你同意的動作和任務結果傳到你的 Telegram 對話，也只接受從這個對話按下的按鈕。用 @BotFather
        建立機器人；token 會存在作業系統鑰匙圈。
      </p>
      <form className="secret-form" onSubmit={(event) => void save(event)}>
        <label htmlFor="telegram-chat-id">你的 chat id</label>
        <input
          id="telegram-chat-id"
          name="telegram-chat-id"
          inputMode="numeric"
          pattern="-?[0-9]+"
          defaultValue={chatId ?? ''}
        />
        {tokenStatus?.source === 'env' ? (
          <div className="env-managed" role="status">
            由環境變數 JOY_TELEGRAM_BOT_TOKEN 管理。
          </div>
        ) : (
          <>
            <label htmlFor="telegram-token">{tokenStatus?.set ? '換一個機器人 token' : '機器人 token'}</label>
            <input id="telegram-token" name="telegram-token" type="password" autoComplete="new-password" />
          </>
        )}
        <button className="primary-button" type="submit">
          儲存 Telegram 設定
        </button>
        {message ? (
          <p className="muted" role="status">
            {message}
          </p>
        ) : null}
      </form>
    </section>
  )
}

/** "Open draft PR" for a finished task: sets the repository's GitHub remote first if needed. */
type CompeteJudgement = {
  winner: string | null
  reasons: string
  attempts: Array<{ attemptId: string; strengths: string; weaknesses: string }>
  mergeRecommended: boolean
}

/** Compete mode (T2.1): the attempts side by side with their reviews and the judge's reasons. */
function ComparePanel({ details, onChanged }: { details: TaskDetails; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const events = details.events
  const latest = (type: string) => record([...events].reverse().find((event) => event.type === type)?.payload)
  const judged = latest('compete.judgement')
  const judgement = record(judged?.judgement) as CompeteJudgement | undefined
  const labels = new Map<string, string>()
  for (const outcome of Array.isArray(judged?.outcomes) ? judged.outcomes : []) {
    const item = record(outcome)
    if (typeof item?.attemptId === 'string' && typeof item.label === 'string')
      labels.set(item.attemptId, item.label)
  }
  const mergeId = latest('compete.merge_started')?.attemptId
  const chosenId = latest('compete.chosen')?.attemptId
  const results = new Map<string, Record<string, unknown>>()
  for (const event of events)
    if (event.type === 'compete.result' && event.attemptId) {
      const payload = record(event.payload)
      if (payload) results.set(event.attemptId, payload)
    }
  const attempts = details.attempts
    .map((attempt) => record(attempt))
    .filter((attempt): attempt is Record<string, unknown> => typeof attempt?.id === 'string')
  const reviews = details.reviews.map((review) => record(review)).filter(Boolean) as Array<
    Record<string, unknown>
  >
  const ready = details.task.status === 'review_ready'
  const finishedCount = attempts.filter(
    (a) => a.id !== mergeId && results.get(String(a.id))?.status === 'succeeded',
  ).length
  const mergeResult = typeof mergeId === 'string' ? results.get(mergeId) : undefined
  const canMerge =
    ready &&
    judgement &&
    finishedCount >= 2 &&
    (!mergeId || (mergeResult && mergeResult.status !== 'succeeded'))

  async function act(path: string, body: object) {
    setBusy(true)
    setFailure('')
    try {
      await request(`/api/tasks/${encodeURIComponent(details.task.id)}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      onChanged()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '操作失敗')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="compare-panel" aria-label="比較兩個方案" data-testid="compare-panel">
      {judgement ? (
        <div className="judge-box" aria-label="裁判">
          <p className="eyebrow">裁判</p>
          <p>
            {judgement.winner ? (
              <strong>選 {labels.get(judgement.winner) ?? '其中一個方案'}。</strong>
            ) : (
              <strong>兩個方案都不夠好。</strong>
            )}{' '}
            {judgement.reasons}
          </p>
          {judgement.mergeRecommended ? <p className="muted">裁判認為合併兩邊會更好。</p> : null}
        </div>
      ) : details.task.status === 'running' ? (
        <p className="muted">兩個方案都在進行中；兩邊都審查完後，裁判會比較。</p>
      ) : null}
      <div className="compare-columns">
        {attempts.map((attempt) => {
          const id = String(attempt.id)
          const result = results.get(id)
          const resultDiff = record(result?.diff) as WorkspaceDiff | undefined
          const review = reviews.filter((r) => r.attemptId === id).at(-1)
          const notes = judgement?.attempts.find((a) => a.attemptId === id)
          const label = id === mergeId ? '合併版' : (labels.get(id) ?? '方案')
          return (
            <article
              key={id}
              className={id === chosenId ? 'compare-column chosen' : 'compare-column'}
              aria-label={`方案 ${label}`}
            >
              <header>
                <strong>{label}</strong>
                <span className="muted">
                  {' '}
                  {String(attempt.provider)} · {String(attempt.model)}
                </span>
                {judgement?.winner === id ? <span className="badge">裁判推薦</span> : null}
                {id === chosenId ? <span className="badge">已選定</span> : null}
              </header>
              <p className="muted">
                {result
                  ? result.status === 'succeeded'
                    ? review
                      ? `審查：${review.approve ? '通過' : '要求修改'}${review.summary ? ` — ${String(review.summary)}` : ''}`
                      : '完成'
                    : `${String(result.status)}${result.reason ? `: ${String(result.reason)}` : ''}`
                  : '進行中…'}
              </p>
              {notes ? (
                <p className="compare-notes">
                  <span>+ {notes.strengths}</span>
                  <span>− {notes.weaknesses}</span>
                </p>
              ) : null}
              {resultDiff ? (
                <pre className="diff-code compare-diff" aria-label={`差異 ${label}`}>
                  {resultDiff.patch.split('\n').map((line, index) => (
                    <span
                      key={index}
                      className={
                        line.startsWith('+') && !line.startsWith('+++')
                          ? 'diff-line added'
                          : line.startsWith('-') && !line.startsWith('---')
                            ? 'diff-line removed'
                            : 'diff-line'
                      }
                    >
                      {line || ' '}
                    </span>
                  ))}
                </pre>
              ) : null}
              {ready && result?.status === 'succeeded' && resultDiff ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void act('choose', { attemptId: id })}
                >
                  選 {label}
                </button>
              ) : null}
            </article>
          )
        })}
      </div>
      {canMerge ? (
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void act('merge', {})}>
          合併：由裁判綜合兩邊的優點重做一版
        </button>
      ) : null}
      {failure ? <p className="approvals-error">{failure}</p> : null}
    </section>
  )
}

type WorktreeRow = {
  path: string
  repoPath: string
  branch: string | null
  diskUsageBytes: number
  unpushedCommitCount: number
  ageDays: number
  stale: boolean
  active: boolean
  taskId?: string
  taskTitle?: string
  taskStatus?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/** Removes worktrees; asks again before losing commits that exist nowhere else. */
async function removeWithConfirmation(path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    await request(path, { method: 'POST', body: JSON.stringify(body) })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!/unpushed commit/.test(message)) throw error
    if (!window.confirm(`${message}\n\n還是要刪掉這些 commit 嗎？`)) return false
    await request(path, { method: 'POST', body: JSON.stringify({ ...body, confirmUnpushedCommits: true }) })
    return true
  }
}

/** Worktree cleanup (T2.8): disk usage, idle worktrees, and removal that never loses commits silently. */
function WorktreesPanel() {
  const [data, setData] = useState<{
    worktrees: WorktreeRow[]
    totalBytes: number
    staleAfterDays: number
  } | null>(null)
  const [failure, setFailure] = useState('')

  async function load() {
    const body = await request<{ worktrees?: WorktreeRow[]; totalBytes?: number; staleAfterDays?: number }>(
      '/api/worktrees',
    )
    setData({
      worktrees: Array.isArray(body.worktrees) ? body.worktrees : [],
      totalBytes: typeof body.totalBytes === 'number' ? body.totalBytes : 0,
      staleAfterDays: typeof body.staleAfterDays === 'number' ? body.staleAfterDays : 14,
    })
  }

  useEffect(() => {
    void load().catch(() => undefined)
  }, [])

  async function remove(row: WorktreeRow) {
    setFailure('')
    try {
      await removeWithConfirmation('/api/worktrees/remove', { path: row.path })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '無法移除工作副本')
    }
    await load().catch(() => undefined)
  }

  const stale = data?.worktrees.filter((row) => row.stale && !row.active) ?? []
  return (
    <section className="settings-card" aria-label="工作副本" data-testid="worktrees-panel">
      <h2>工作副本（worktree）</h2>
      <p className="muted">
        {data ? `共 ${data.worktrees.length} 個，佔用 ${formatBytes(data.totalBytes)}。` : '載入中…'}
        {stale.length ? `其中 ${stale.length} 個閒置超過 ${data?.staleAfterDays} 天。` : ''}
      </p>
      {data?.worktrees.length ? (
        <ul className="worktree-list">
          {data.worktrees.map((row) => (
            <li key={row.path} className={row.stale ? 'worktree-item stale' : 'worktree-item'}>
              <span>
                <strong>{row.taskTitle ?? row.branch ?? row.path}</strong>
                <span className="muted">
                  {' '}
                  · {formatBytes(row.diskUsageBytes)} · 閒置 {Math.floor(row.ageDays)} 天
                  {row.unpushedCommitCount ? ` · ${row.unpushedCommitCount} 個 commit 還沒推送` : ''}
                  {row.stale ? ' · 閒置' : ''}
                </span>
              </span>
              {row.active ? (
                <span className="muted">執行中</span>
              ) : (
                <button type="button" className="quiet-button" onClick={() => void remove(row)}>
                  移除
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {failure ? <p className="approvals-error">{failure}</p> : null}
    </section>
  )
}

/** Downloads an authenticated API response as a file. */
async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { headers: { authorization: `Bearer ${apiToken()}` } })
  if (!response.ok) throw new Error(`下載失敗（${response.status}）`)
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Debug logs (T4.8): the last 14 days, secrets already removed, for attaching to a bug report. */
function LogsPanel() {
  const [logs, setLogs] = useState<Array<{ day: string; name: string; bytes: number }>>([])
  const [failure, setFailure] = useState('')

  useEffect(() => {
    request<{ logs?: Array<{ day: string; name: string; bytes: number }> }>('/api/logs')
      .then((body) => setLogs(Array.isArray(body.logs) ? body.logs : []))
      .catch(() => undefined)
  }, [])

  return (
    <section className="settings-card" aria-label="除錯紀錄" data-testid="logs-panel">
      <h2>除錯紀錄</h2>
      <p className="muted">每天一個檔案，保留 14 天。寫入前會先移除已知的密碼和金鑰。</p>
      <ul className="worktree-list">
        {logs.map((log) => (
          <li key={log.day} className="worktree-item">
            <span>
              {log.day} <span className="muted">· {formatBytes(log.bytes)}</span>
            </span>
            <button
              type="button"
              className="quiet-button"
              onClick={() =>
                void downloadFile(`/api/logs/${log.day}`, log.name).catch((error: unknown) =>
                  setFailure(error instanceof Error ? error.message : '下載失敗'),
                )
              }
            >
              下載
            </button>
          </li>
        ))}
      </ul>
      {logs.length === 0 ? <p className="muted">還沒有紀錄。</p> : null}
      {failure ? <p className="approvals-error">{failure}</p> : null}
    </section>
  )
}

/** Backups and export (T4.7). Restoring replaces the database, so it is a command run while Joy is stopped. */
function BackupsPanel() {
  const [backups, setBackups] = useState<Array<{ day: string; bytes: number }>>([])
  const [message, setMessage] = useState('')

  async function load() {
    const body = await request<{ backups?: Array<{ day: string; bytes: number }> }>('/api/backups')
    setBackups(Array.isArray(body.backups) ? body.backups : [])
  }

  useEffect(() => {
    void load().catch(() => undefined)
  }, [])

  async function backupNow() {
    try {
      const body = await request<{ created?: string | null }>('/api/backups', { method: 'POST', body: '{}' })
      setMessage(body.created ? '已備份。' : '今天已經備份過了。')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '備份失敗')
    }
  }

  async function exportJson() {
    try {
      await downloadFile('/api/export', `joy-export-${new Date().toISOString().slice(0, 10)}.json`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '匯出失敗')
    }
  }

  return (
    <section className="settings-card" aria-label="備份" data-testid="backups-panel">
      <h2>備份與匯出</h2>
      <p className="muted">Joy 每天備份一次資料庫，保留最近 7 份。</p>
      <ul className="worktree-list">
        {backups.map((backup) => (
          <li key={backup.day} className="worktree-item">
            <span>
              {backup.day} <span className="muted">· {formatBytes(backup.bytes)}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="project-note-actions">
        <button type="button" className="quiet-button" onClick={() => void backupNow()}>
          立即備份
        </button>
        <button type="button" className="quiet-button" onClick={() => void exportJson()}>
          匯出任務和記憶（JSON）
        </button>
      </div>
      <p className="muted">
        還原方式：先停止 Joy，再執行 <code>pnpm joy restore 2026-11-06</code>（日期換成清單裡的一天）。
      </p>
      {message ? <p className="muted">{message}</p> : null}
    </section>
  )
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** Why this browser cannot receive notifications, or undefined when it can. */
function pushUnsupportedReason(): string | undefined {
  if (!window.isSecureContext)
    return '通知需要 HTTPS（或 localhost）。手機上請透過 `tailscale serve` 開 Joy（見 README）。'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return '這個瀏覽器不支援 Web Push。iPhone 請先把 Joy 加到主畫面。'
  return undefined
}

/** Turns on notifications for this device (T4.2): task results and approval requests. */
function NotificationsPanel() {
  const [state, setState] = useState<'off' | 'on' | 'busy'>('off')
  const [message, setMessage] = useState('')
  const unsupported = pushUnsupportedReason()

  useEffect(() => {
    if (unsupported) return
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? 'on' : 'off'))
      .catch(() => undefined)
  }, [unsupported])

  async function enable() {
    setState('busy')
    setMessage('')
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('沒有允許通知')
      const { publicKey } = await request<{ publicKey: string }>('/api/push/key')
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
      })
      await request('/api/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify(subscription.toJSON()),
      })
      setState('on')
    } catch (error) {
      setState('off')
      setMessage(error instanceof Error ? error.message : '無法開啟通知')
    }
  }

  async function disable() {
    setState('busy')
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      await request('/api/push/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => undefined)
      await subscription.unsubscribe()
    }
    setState('off')
  }

  return (
    <section className="settings-card" aria-label="通知" data-testid="notifications-panel">
      <h2>通知</h2>
      <p className="muted">任務完成或需要你同意時，這台裝置會收到通知。</p>
      {unsupported ? (
        <p className="muted">{unsupported}</p>
      ) : state === 'on' ? (
        <div className="project-note-actions">
          <span>這台裝置已開啟通知。</span>
          <button
            type="button"
            className="quiet-button"
            onClick={() => void request('/api/push/test', { method: 'POST', body: '{}' })}
          >
            傳送測試通知
          </button>
          <button type="button" className="quiet-button" onClick={() => void disable()}>
            關閉
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="quiet-button"
          disabled={state === 'busy'}
          onClick={() => void enable()}
        >
          開啟通知
        </button>
      )}
      {message ? <p className="approvals-error">{message}</p> : null}
    </section>
  )
}

/** Throws away a finished task's worktrees (T2.8). */
function DiscardButton({ details, onChanged }: { details: TaskDetails; onChanged: () => void }) {
  const [failure, setFailure] = useState('')
  const finished = ['done', 'review_ready', 'failed', 'cancelled'].includes(details.task.status)
  const removed = details.events.some((event) => event.type === 'worktree.removed')
  const published = details.events.some((event) => event.type === 'publish.done')
  if (!finished || removed || published) return null
  return (
    <div className="discard-row">
      <button
        type="button"
        className="quiet-button"
        onClick={() => {
          if (!window.confirm('要丟掉這個任務的工作副本和所有變更嗎？')) return
          setFailure('')
          void removeWithConfirmation(`/api/tasks/${encodeURIComponent(details.task.id)}/discard`, {})
            .then(onChanged)
            .catch((error: unknown) => setFailure(error instanceof Error ? error.message : '無法丟棄'))
        }}
      >
        丟掉這些變更
      </button>
      {failure ? <p className="approvals-error">{failure}</p> : null}
    </div>
  )
}

function PublishPanel({ details, onChanged }: { details: TaskDetails; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const published = [...details.events].reverse().find((event) => event.type === 'publish.done')
  const prUrl = record(published?.payload)?.pullRequestUrl
  const remote = details.repo?.githubRemote

  if (details.task.status !== 'done' || !details.repo) return null

  async function setRemote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('github-remote') ?? '').trim()
    if (!value || !details.repo) return
    setFailure('')
    try {
      await request(`/api/repos/${encodeURIComponent(details.repo.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ githubRemote: value }),
      })
      onChanged()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '無法儲存 GitHub 網址')
    }
  }

  async function publishTask() {
    setBusy(true)
    setFailure('')
    try {
      await request(`/api/tasks/${encodeURIComponent(details.task.id)}/publish`, {
        method: 'POST',
        body: '{}',
      })
      onChanged()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '開 PR 失敗')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="publish-panel" data-testid="publish-panel">
      {typeof prUrl === 'string' ? (
        <a href={prUrl} target="_blank" rel="noreferrer">
          已開 draft PR ↗
        </a>
      ) : remote ? (
        <button className="primary-button" type="button" disabled={busy} onClick={() => void publishTask()}>
          {busy ? '正在開 draft PR…' : '開 draft PR'}
        </button>
      ) : (
        <form className="secret-form" onSubmit={(event) => void setRemote(event)}>
          <label htmlFor="github-remote">第一次開 PR：填入 GitHub repo 網址</label>
          <div className="secret-input-row">
            <input
              id="github-remote"
              name="github-remote"
              placeholder="https://github.com/owner/repo.git"
              required
            />
            <button className="outline-button" type="submit">
              儲存
            </button>
          </div>
        </form>
      )}
      {failure ? <p className="approvals-error">{failure}</p> : null}
    </div>
  )
}

interface QuotaReport {
  providers?: Record<string, { status: string; limitedNow?: boolean; resetsAt?: number }>
  openaiApi?: { monthSpentUsd: number; monthlyCapUsd: number }
}

/** OpenAI API spend this month and any provider that is out of quota. Refreshes every 30 s. */
function UsageStrip() {
  const [report, setReport] = useState<QuotaReport | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      request<QuotaReport>('/api/quota')
        .then((body) => {
          if (!cancelled) setReport(body)
        })
        .catch(() => undefined)
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])
  const api = report?.openaiApi
  const limited = Object.entries(report?.providers ?? {}).filter(([, state]) => state.limitedNow)
  if (!api && limited.length === 0) return null
  return (
    <div className="usage-strip" data-testid="usage-strip">
      {api && typeof api.monthSpentUsd === 'number' ? (
        <span>
          本月 OpenAI API ${api.monthSpentUsd.toFixed(2)} / ${api.monthlyCapUsd.toFixed(2)}
        </span>
      ) : null}
      {limited.map(([provider, state]) => (
        <span className="usage-limited" key={provider}>
          {provider} 額度用完
          {state.resetsAt ? `，${new Date(state.resetsAt * 1000).toLocaleTimeString()} 恢復` : ''}
        </span>
      ))}
    </div>
  )
}

interface ConversationSummary {
  id: string
  title?: string
  brainProvider?: string
  updatedAt?: string
  createdAt: string
}
interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  memoryIds?: string[]
}

interface MemoryItem {
  id: string
  content: string
  expiresAt?: string
  supersededBy?: string
}

function memoryInactive(memory: MemoryItem): boolean {
  return (
    Boolean(memory.supersededBy) ||
    (memory.expiresAt !== undefined && Date.parse(memory.expiresAt) <= Date.now())
  )
}

/** What Joy remembers about the owner (T3.4): every memory can be corrected or deleted. */
function MemoryPanel(props: {
  memories: MemoryItem[]
  onChange: () => Promise<void>
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')

  async function save(id: string) {
    try {
      await request(`/api/memories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: draft }),
      })
      setEditing('')
      await props.onChange()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : '無法儲存這筆記憶')
    }
  }

  return (
    <section className="memory-panel" aria-label="記憶" data-testid="memory-panel">
      <h3>Joy 記得的事</h3>
      {props.memories.length === 0 ? <p className="muted">還沒有。</p> : null}
      <ul>
        {props.memories.map((memory) => (
          <li key={memory.id} className={memoryInactive(memory) ? 'memory-item inactive' : 'memory-item'}>
            {editing === memory.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void save(memory.id)
                }}
              >
                <input
                  aria-label="記憶內容"
                  value={draft}
                  maxLength={500}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="quiet-button">
                  儲存
                </button>
                <button type="button" className="quiet-button" onClick={() => setEditing('')}>
                  取消
                </button>
              </form>
            ) : (
              <>
                <span>{memory.content}</span>
                {memory.supersededBy ? <span className="muted">（已被取代）</span> : null}
                {!memory.supersededBy && memoryInactive(memory) ? (
                  <span className="muted">（已過期）</span>
                ) : null}
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => {
                    setEditing(memory.id)
                    setDraft(memory.content)
                  }}
                >
                  編輯
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  aria-label={`刪除記憶：${memory.content}`}
                  onClick={() => void deleteMemory(memory.id, props.onChange, props.onError)}
                >
                  刪除
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

interface ScheduledItems {
  reminders: Array<{ id: string; text: string; dueAt: string }>
  schedules: Array<{
    id: string
    cron: string
    action: string
    payload: Record<string, unknown>
    nextRunAt: string
  }>
}

/** Pending reminders and recurring schedules (T3.7); the assistant creates them, the owner can cancel them here. */
function ScheduledPanel(props: { onError: (message: string) => void }) {
  const [items, setItems] = useState<ScheduledItems>({ reminders: [], schedules: [] })

  async function load() {
    const body = await request<Partial<ScheduledItems>>('/api/schedules')
    setItems({
      reminders: Array.isArray(body.reminders) ? body.reminders : [],
      schedules: Array.isArray(body.schedules) ? body.schedules : [],
    })
  }

  useEffect(() => {
    void load().catch(() => undefined)
    const timer = window.setInterval(() => void load().catch(() => undefined), 15000)
    return () => window.clearInterval(timer)
  }, [])

  async function cancel(id: string) {
    try {
      await request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (error) {
      props.onError(error instanceof Error ? error.message : '無法取消')
    }
    await load().catch(() => undefined)
  }

  if (items.reminders.length === 0 && items.schedules.length === 0) return null
  return (
    <section className="memory-panel" aria-label="排程" data-testid="scheduled-panel">
      <h3>提醒與排程</h3>
      <ul>
        {items.reminders.map((reminder) => (
          <li key={reminder.id} className="memory-item">
            <span>
              ⏰ {reminder.text} <span className="muted">· {new Date(reminder.dueAt).toLocaleString()}</span>
            </span>
            <button type="button" className="quiet-button" onClick={() => void cancel(reminder.id)}>
              取消
            </button>
          </li>
        ))}
        {items.schedules.map((schedule) => (
          <li key={schedule.id} className="memory-item">
            <span>
              🔁 {String(schedule.action === 'reminder' ? schedule.payload.text : schedule.payload.title)}{' '}
              <span className="muted">
                · <code>{schedule.cron}</code> · 下次 {new Date(schedule.nextRunAt).toLocaleString()}
              </span>
            </span>
            <button type="button" className="quiet-button" onClick={() => void cancel(schedule.id)}>
              移除
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface HistoryHit {
  conversationId: string
  title?: string
  kind: 'summary' | 'message'
  role?: string
  snippet: string
  ts: string
}

/** Search past conversations (T3.6); picking a result opens that conversation. */
function HistorySearch(props: { onOpen: (conversationId: string) => void }) {
  const [hits, setHits] = useState<HistoryHit[] | null>(null)

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = String(new FormData(event.currentTarget).get('q') ?? '').trim()
    if (!query) {
      setHits(null)
      return
    }
    const body = await request<{ results?: HistoryHit[] }>(
      `/api/history?q=${encodeURIComponent(query)}`,
    ).catch(() => ({ results: [] }))
    setHits(Array.isArray(body.results) ? body.results : [])
  }

  return (
    <div className="history-search">
      <form role="search" onSubmit={(event) => void search(event)}>
        <input name="q" type="search" placeholder="搜尋以前的對話" aria-label="搜尋以前的對話" />
      </form>
      {hits === null ? null : hits.length === 0 ? (
        <p className="muted">找不到符合的內容。</p>
      ) : (
        <ul aria-label="搜尋結果">
          {hits.map((hit, index) => (
            <li key={`${hit.conversationId}-${index}`}>
              <button type="button" className="task-row" onClick={() => props.onOpen(hit.conversationId)}>
                <span className="muted">
                  {hit.ts.slice(0, 10)} · {hit.title ?? '對話'}
                  {hit.kind === 'summary' ? ' · 摘要' : ''}
                </span>
                <span>{hit.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface ProjectNote {
  id: string
  note: string
  file: string
  repoPath?: string
  stale?: boolean
  diff?: Array<{ kind: 'same' | 'add' | 'remove'; text: string }>
}

/** Outside actions the assistant asked for (send mail, invite people; T3.8). Nothing happens until approved here. */
function AssistantActionsPanel(props: { onDecided: () => void; onError: (message: string) => void }) {
  const [actions, setActions] = useState<Array<{ id: string; summary: string; provenance: string }>>([])

  async function load() {
    const body = await request<{ actions?: Array<{ id: string; summary: string; provenance: string }> }>(
      '/api/assistant/actions',
    )
    setActions(Array.isArray(body.actions) ? body.actions : [])
  }

  useEffect(() => {
    void load().catch(() => undefined)
    const timer = window.setInterval(() => void load().catch(() => undefined), 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function decide(id: string, decision: 'approve' | 'deny') {
    try {
      await request(`/api/assistant/actions/${encodeURIComponent(id)}/${decision}`, {
        method: 'POST',
        body: '{}',
      })
    } catch (error) {
      props.onError(error instanceof Error ? error.message : '無法送出你的決定')
    }
    await load().catch(() => undefined)
    props.onDecided()
  }

  if (actions.length === 0) return null
  return (
    <section className="project-notes" aria-label="需要你同意" data-testid="assistant-actions">
      <h3>需要你同意</h3>
      {actions.map((action) => (
        <article key={action.id} className="project-note">
          <p>
            <code>{action.summary}</code>
            {action.provenance === 'external_content' ? (
              <span className="muted"> · 這是讀了郵件或行事曆內容之後提出的要求</span>
            ) : null}
          </p>
          <div className="project-note-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void decide(action.id, 'approve')}
            >
              同意
            </button>
            <button type="button" className="quiet-button" onClick={() => void decide(action.id, 'deny')}>
              拒絕
            </button>
          </div>
        </article>
      ))}
    </section>
  )
}

/** AGENTS.md notes Joy proposed (T3.5). Nothing reaches the repository until the owner applies the diff here. */
function ProjectNotesPanel(props: { onError: (message: string) => void }) {
  const [notes, setNotes] = useState<ProjectNote[]>([])

  async function load() {
    const body = await request<{ notes?: ProjectNote[] }>('/api/project-notes?status=pending')
    setNotes(Array.isArray(body.notes) ? body.notes : [])
  }

  useEffect(() => {
    void load().catch(() => undefined)
    const timer = window.setInterval(() => void load().catch(() => undefined), 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function decide(id: string, action: 'apply' | 'reject') {
    try {
      await request(`/api/project-notes/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' })
    } catch (error) {
      props.onError(error instanceof Error ? error.message : '無法更新這個提案')
    }
    await load().catch(() => undefined)
  }

  if (notes.length === 0) return null
  return (
    <section className="project-notes" aria-label="專案守則提案" data-testid="project-notes">
      <h3>建議加入專案守則</h3>
      {notes.map((note) => (
        <article key={note.id} className="project-note">
          <p>
            <strong>{note.note}</strong>
            <span className="muted">
              {' '}
              → {note.repoPath ? `${note.repoPath}/` : ''}
              {note.file}
            </span>
          </p>
          {note.stale ? (
            <p className="muted">提案之後檔案又改過了。請拒絕這個提案，再請 Joy 重新提一次。</p>
          ) : (
            <pre className="diff" aria-label={`差異：${note.note}`}>
              {(note.diff ?? [])
                .filter((line) => line.kind !== 'same')
                .map((line, index) => (
                  <span key={index} className={`diff-${line.kind}`}>
                    {line.kind === 'add' ? '+ ' : '- '}
                    {line.text}
                    {'\n'}
                  </span>
                ))}
            </pre>
          )}
          <div className="project-note-actions">
            {note.stale ? null : (
              <button type="button" className="primary-button" onClick={() => void decide(note.id, 'apply')}>
                寫進 {note.file}
              </button>
            )}
            <button type="button" className="quiet-button" onClick={() => void decide(note.id, 'reject')}>
              拒絕
            </button>
          </div>
        </article>
      ))}
    </section>
  )
}

async function deleteMemory(id: string, onChange: () => Promise<void>, onError: (message: string) => void) {
  try {
    await request(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await onChange()
  } catch (error) {
    onError(error instanceof Error ? error.message : '無法刪除這筆記憶')
  }
}

/** Chat with the assistant (T3.1). Conversations are listed on the left, the selected one on the right. */
function AssistantPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState('')
  const [memories, setMemories] = useState<MemoryItem[]>([])

  async function loadMemories(): Promise<void> {
    const body = await request<{ memories?: MemoryItem[] }>('/api/memories')
    setMemories(Array.isArray(body.memories) ? body.memories : [])
  }

  async function loadList(): Promise<ConversationSummary[]> {
    const body = await request<{ conversations?: ConversationSummary[] }>('/api/conversations')
    const list = Array.isArray(body.conversations) ? body.conversations : []
    setConversations(list)
    return list
  }

  useEffect(() => {
    void loadMemories().catch(() => undefined)
    void loadList()
      .then((list) => {
        if (list[0]) setSelected((current) => current || list[0]?.id || '')
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!selected) {
      setMessages([])
      return
    }
    let cancelled = false
    const load = () =>
      request<{ messages?: ChatMessage[] }>(`/api/conversations/${encodeURIComponent(selected)}`)
        .then((body) => {
          if (!cancelled) setMessages(Array.isArray(body.messages) ? body.messages : [])
        })
        .catch(() => undefined)
    void load()
    // Tasks the assistant started report back here when they finish.
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selected])

  async function newConversation() {
    const body = await request<{ conversation: ConversationSummary }>('/api/conversations', {
      method: 'POST',
      body: '{}',
    })
    await loadList()
    setSelected(body.conversation.id)
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const text = String(new FormData(formElement).get('message') ?? '').trim()
    if (!text) return
    setFailure('')
    setSending(true)
    let conversationId = selected
    try {
      if (!conversationId) {
        const created = await request<{ conversation: ConversationSummary }>('/api/conversations', {
          method: 'POST',
          body: '{}',
        })
        conversationId = created.conversation.id
        setSelected(conversationId)
      }
      setMessages((current) => [...current, { id: -Date.now(), role: 'user', content: text }])
      formElement.reset()
      await request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '助理沒有回應')
    } finally {
      setSending(false)
      if (conversationId) {
        const body = await request<{ messages?: ChatMessage[] }>(
          `/api/conversations/${encodeURIComponent(conversationId)}`,
        ).catch(() => ({ messages: undefined }))
        if (Array.isArray(body.messages)) setMessages(body.messages)
      }
      void loadList().catch(() => undefined)
      // Joy may have learned something from this message; extraction runs in the background.
      window.setTimeout(() => void loadMemories().catch(() => undefined), 3000)
    }
  }

  return (
    <main className="assistant-page" data-testid="assistant-page">
      <aside className="assistant-list" aria-label="對話列表">
        <button className="primary-button" type="button" onClick={() => void newConversation()}>
          新對話
        </button>
        <HistorySearch onOpen={setSelected} />
        {conversations.map((conversation) => (
          <button
            type="button"
            key={conversation.id}
            className={conversation.id === selected ? 'task-row selected' : 'task-row'}
            onClick={() => setSelected(conversation.id)}
          >
            {conversation.title ?? '新對話'}
          </button>
        ))}
        <ScheduledPanel onError={setFailure} />
        <MemoryPanel memories={memories} onChange={loadMemories} onError={setFailure} />
      </aside>
      <section className="assistant-chat" aria-label="對話">
        <AssistantActionsPanel onError={setFailure} onDecided={() => undefined} />
        <ProjectNotesPanel onError={setFailure} />
        <div className="chat-messages">
          {messages.length === 0 ? (
            <p className="muted">
              可以問專案和任務的狀況、請它開任務或設提醒。助理用哪個模型可以在設定裡改。
            </p>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`chat-message chat-${message.role}`}>
                <span className="chat-role">
                  {message.role === 'user' ? '你' : message.role === 'assistant' ? 'Joy' : '錯誤'}
                </span>
                <p>{message.content}</p>
                {message.role === 'assistant' && message.memoryIds?.length ? (
                  <div className="memory-chips" aria-label="用到的記憶">
                    {message.memoryIds.map((id) => {
                      const memory = memories.find((m) => m.id === id)
                      return memory ? (
                        <span key={id} className="memory-chip">
                          {memory.content}
                          <button
                            type="button"
                            aria-label={`忘記：${memory.content}`}
                            onClick={() => void deleteMemory(id, loadMemories, setFailure)}
                          >
                            ×
                          </button>
                        </span>
                      ) : (
                        <span key={id} className="memory-chip deleted">
                          已刪除的記憶
                        </span>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ))
          )}
          {sending ? <p className="muted">Joy 正在想…</p> : null}
        </div>
        {failure ? <p className="approvals-error">{failure}</p> : null}
        <form className="chat-form" onSubmit={(event) => void send(event)}>
          <textarea name="message" rows={3} placeholder="傳訊息給 Joy" required disabled={sending} />
          <button className="primary-button" type="submit" disabled={sending}>
            送出
          </button>
        </form>
      </section>
    </main>
  )
}

interface ImplementerStat {
  provider: string
  model: string
  mode: string
  attempts: number
  finished: number
  passed: number
  passRate: number | null
  findingsAgainst: number
  avgDurationMs: number | null
  handoffs: number
}

interface ReviewerStat {
  provider: string
  model: string
  reviews: number
  approvals: number
  findings: number
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = ms / 60_000
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)} 小時` : `${Math.max(1, Math.round(minutes))} 分鐘`
}

/** How each provider and model has done (T3.9), filtered by period and repository. */
function StatsPage(props: { repos: Repo[] }) {
  const [filter, setFilter] = useState({ from: '', to: '', repoId: '' })
  const [stats, setStats] = useState<{ implementers: ImplementerStat[]; reviewers: ReviewerStat[] } | null>(
    null,
  )
  const [failure, setFailure] = useState('')

  useEffect(() => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value))
    let cancelled = false
    request<{ stats?: { implementers?: ImplementerStat[]; reviewers?: ReviewerStat[] } }>(
      `/api/stats?${query}`,
    )
      .then((body) => {
        if (cancelled) return
        setFailure('')
        setStats({
          implementers: Array.isArray(body.stats?.implementers) ? body.stats.implementers : [],
          reviewers: Array.isArray(body.stats?.reviewers) ? body.stats.reviewers : [],
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : '無法載入統計')
      })
    return () => {
      cancelled = true
    }
  }, [filter])

  return (
    <main className="settings-page stats-page" data-testid="stats-page">
      <div className="page-heading">
        <h1>模型統計</h1>
      </div>
      <form className="stats-filter" onSubmit={(event) => event.preventDefault()}>
        <label>
          從
          <input
            type="date"
            value={filter.from}
            onChange={(e) => setFilter({ ...filter, from: e.target.value })}
          />
        </label>
        <label>
          到
          <input
            type="date"
            value={filter.to}
            onChange={(e) => setFilter({ ...filter, to: e.target.value })}
          />
        </label>
        <label>
          專案
          <select value={filter.repoId} onChange={(e) => setFilter({ ...filter, repoId: e.target.value })}>
            <option value="">全部</option>
            {props.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.path}
              </option>
            ))}
          </select>
        </label>
      </form>
      {failure ? <p className="approvals-error">{failure}</p> : null}
      <h2>擔任實作者</h2>
      {stats && stats.implementers.length === 0 ? <p className="muted">這段期間沒有實作紀錄。</p> : null}
      {stats && stats.implementers.length ? (
        <table className="stats-table" aria-label="實作者統計">
          <thead>
            <tr>
              <th>模型</th>
              <th>模式</th>
              <th>次數</th>
              <th>通過率</th>
              <th>被審查找到的問題</th>
              <th>平均耗時</th>
              <th>交接次數</th>
            </tr>
          </thead>
          <tbody>
            {stats.implementers.map((row) => (
              <tr key={`${row.provider}/${row.model}/${row.mode}`}>
                <td>
                  {row.provider} · {row.model}
                </td>
                <td>{modeLabel(row.mode)}</td>
                <td>{row.attempts}</td>
                <td>
                  {row.passRate === null ? '—' : `${Math.round(row.passRate * 100)}%`}
                  <span className="muted">
                    {' '}
                    ({row.passed}/{row.finished})
                  </span>
                </td>
                <td>{row.findingsAgainst}</td>
                <td>{formatDuration(row.avgDurationMs)}</td>
                <td>{row.handoffs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <h2>擔任審查者</h2>
      {stats && stats.reviewers.length === 0 ? <p className="muted">這段期間沒有審查紀錄。</p> : null}
      {stats && stats.reviewers.length ? (
        <table className="stats-table" aria-label="審查者統計">
          <thead>
            <tr>
              <th>模型</th>
              <th>審查次數</th>
              <th>通過</th>
              <th>找到的問題</th>
            </tr>
          </thead>
          <tbody>
            {stats.reviewers.map((row) => (
              <tr key={`${row.provider}/${row.model}`}>
                <td>
                  {row.provider} · {row.model}
                </td>
                <td>{row.reviews}</td>
                <td>{row.approvals}</td>
                <td>{row.findings}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
  )
}

/** Shown when this device has no accepted access token (remote access, or after the token was regenerated). */
function TokenGate() {
  return (
    <main className="token-gate" data-testid="token-gate">
      <h1>Joy 存取權杖</h1>
      <p className="muted">
        貼上執行 Joy 那台電腦裡 <code>~/.joy/api-token</code> 的內容。權杖只會存在這台裝置。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const token = String(new FormData(event.currentTarget).get('token') ?? '').trim()
          if (!token) return
          saveApiToken(token)
          window.location.reload()
        }}
      >
        <input name="token" type="password" aria-label="存取權杖" autoComplete="off" required />
        <button className="primary-button" type="submit">
          繼續
        </button>
      </form>
    </main>
  )
}

/** Regenerating the token logs out every other device and browser tab (T4.1). */
function AccessTokenPanel() {
  const [shown, setShown] = useState('')
  const [failure, setFailure] = useState('')

  async function regenerate() {
    if (!window.confirm('要重新產生存取權杖嗎？其他裝置和分頁都要改用新的權杖。')) return
    setFailure('')
    try {
      const body = await request<{ token: string }>('/api/token/rotate', { method: 'POST', body: '{}' })
      saveApiToken(body.token)
      setShown(body.token)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '無法重新產生權杖')
    }
  }

  return (
    <section className="settings-card" aria-label="存取權杖" data-testid="access-token-panel">
      <h2>存取權杖</h2>
      <p className="muted">每個送到 Joy 的請求都要帶這個權杖。要從其他裝置連線（Tailscale）請看 README。</p>
      <button type="button" className="quiet-button" onClick={() => void regenerate()}>
        重新產生權杖
      </button>
      {shown ? (
        <p>
          新權杖（只顯示這一次）：<code data-testid="new-token">{shown}</code>
        </p>
      ) : null}
      {failure ? <p className="approvals-error">{failure}</p> : null}
    </section>
  )
}

function App() {
  const [unauthorized, setUnauthorized] = useState(() => !apiToken())
  useEffect(() => {
    const onUnauthorized = () => setUnauthorized(true)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])
  return unauthorized ? <TokenGate /> : <Workspace />
}

function Workspace() {
  const [repos, setRepos] = useState<Repo[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [config, setConfig] = useState<JoyConfig | null>(null)
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null)
  const [secretStatusLoading, setSecretStatusLoading] = useState(true)
  const [secretStatusRetry, setSecretStatusRetry] = useState(0)
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(true)
  const [doctorRetry, setDoctorRetry] = useState(0)
  // A notification opens `/?task=<id>`; start on that task.
  // Custom workflows from config.yaml (T5.6); the built-in three are the fixed options of the task form.
  const [customWorkflows, setCustomWorkflows] = useState<Array<{ name: string; description?: string }>>([])
  useEffect(() => {
    request<{
      workflows?: Array<{ name: string; description?: string; builtIn?: boolean; problems?: string[] }>
    }>('/api/workflows')
      .then((body) =>
        setCustomWorkflows(
          (Array.isArray(body.workflows) ? body.workflows : []).filter(
            (workflow) => !workflow.builtIn && !workflow.problems?.length,
          ),
        ),
      )
      .catch(() => undefined)
  }, [])
  const [selectedTaskId, setSelectedTaskId] = useState(
    () => new URLSearchParams(window.location.search).get('task') ?? '',
  )
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent<{ type?: string; url?: string }>) => {
      if (event.data?.type !== 'joy-open' || !event.data.url) return
      const task = new URL(event.data.url, window.location.origin).searchParams.get('task')
      if (task) setSelectedTaskId(task)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])
  const [details, setDetails] = useState<TaskDetails | null>(null)
  const [page, setPage] = useState<'tasks' | 'assistant' | 'stats' | 'settings'>('tasks')
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [showRepoForm, setShowRepoForm] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeDiffFile, setActiveDiffFile] = useState('')

  async function refreshSelectedTask() {
    if (!selectedTaskId) return
    const next = await request<TaskDetails>(`/api/tasks/${encodeURIComponent(selectedTaskId)}`)
    setDetails((current) => (current && current.task.id === next.task.id ? next : current))
    await refreshLists()
  }

  async function refreshLists() {
    const [repoResponse, taskResponse] = await Promise.all([
      request<{ repos: Repo[] }>('/api/repos'),
      request<{ tasks: Task[] }>('/api/tasks'),
    ])
    setRepos(repoResponse.repos)
    setTasks(taskResponse.tasks)
  }

  useEffect(() => {
    let active = true
    void Promise.all([
      request<{ repos: Repo[] }>('/api/repos'),
      request<{ tasks: Task[] }>('/api/tasks'),
      request<{ config: JoyConfig }>('/api/config'),
    ])
      .then(([repoResponse, taskResponse, configResponse]) => {
        if (!active) return
        setRepos(repoResponse.repos)
        setTasks(taskResponse.tasks)
        setConfig(configResponse.config)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '連不到 Joy server')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void request<SecretStatus>('/api/secrets/openai-api-key')
      .then((status) => {
        if (!active) return
        setSecretStatus(status)
        setSecretStatusLoading(false)
      })
      .catch(() => {
        if (!active) return
        setSecretStatus(null)
        setSecretStatusLoading(false)
      })
    return () => {
      active = false
    }
  }, [secretStatusRetry])

  useEffect(() => {
    let active = true
    setDoctorLoading(true)
    void request<{ doctor: DoctorReport }>('/api/doctor')
      .then(({ doctor }) => {
        if (active) setDoctorReport(doctor)
      })
      .catch(() => {
        if (active) setDoctorReport(null)
      })
      .finally(() => {
        if (active) setDoctorLoading(false)
      })
    return () => {
      active = false
    }
  }, [doctorRetry])

  useEffect(() => {
    if (!selectedTaskId) {
      setDetails(null)
      return
    }
    let active = true
    let detailsLoaded = false
    let bufferedEvents: TaskEvent[] = []
    let lastAcceptedSequence = 0
    const acceptedOutOfOrder = new Set<number>()
    let snapshotTask: Task | null = null
    let snapshotSequence = -1
    let taskStatusSequence = -1
    let ephemeralFailureSeen = false
    let reconnectAttempts = 0
    let reconnectTimer: number | undefined
    let stableConnectionTimer: number | undefined
    let socket: WebSocket | undefined
    setDetails(null)
    const socketProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    function socketUrl(): string {
      return `${socketProtocol}//${window.location.host}/ws?taskId=${encodeURIComponent(selectedTaskId)}&after=${lastAcceptedSequence}`
    }

    function refreshTaskList(): void {
      void request<{ tasks: Task[] }>('/api/tasks')
        .then(({ tasks: updated }) => setTasks(updated))
        .catch(() => {})
    }

    function advanceSequence(event: TaskEvent): void {
      if (event.seq <= lastAcceptedSequence) return
      acceptedOutOfOrder.add(event.seq)
      while (acceptedOutOfOrder.delete(lastAcceptedSequence + 1)) lastAcceptedSequence++
    }

    function acceptEvents(events: TaskEvent[]): void {
      const matching = events.filter(
        (event) =>
          event.taskId === selectedTaskId &&
          Number.isSafeInteger(event.seq) &&
          (event.seq > 0 || (event.seq === 0 && event.type === 'error')),
      )
      if (matching.length === 0) return
      if (!detailsLoaded) {
        bufferedEvents = mergeEvents(bufferedEvents, matching)
        return
      }
      const ephemeralErrors = matching.filter((event) => event.seq === 0 && event.type === 'error')
      const newlyAccepted = matching
        .filter(
          (event) => event.seq > 0 && event.seq > lastAcceptedSequence && !acceptedOutOfOrder.has(event.seq),
        )
        .sort((first, second) => first.seq - second.seq)
      const additions = [...newlyAccepted, ...ephemeralErrors]
      if (additions.length === 0) return
      for (const event of newlyAccepted) advanceSequence(event)
      const statusEvents = newlyAccepted.filter(
        (event) =>
          (event.type === 'result' || event.type === 'error') &&
          event.seq > taskStatusSequence &&
          event.seq > snapshotSequence,
      )
      if (statusEvents.length) taskStatusSequence = statusEvents.at(-1)?.seq ?? taskStatusSequence
      if (ephemeralErrors.length) ephemeralFailureSeen = true
      setDetails((current) => {
        if (!current || current.task.id !== selectedTaskId) return current
        let task = statusEvents.reduce(taskAfterEvent, current.task)
        if (ephemeralErrors.length) task = { ...task, status: 'failed' }
        return { ...current, task, events: mergeEvents(current.events, additions) }
      })
      if (additions.some((event) => event.type === 'result' || event.type === 'error')) refreshTaskList()
    }

    function connect(): void {
      if (!active) return
      const nextSocket = new WebSocket(socketUrl(), ['joy', `joy-auth.${apiToken()}`])
      socket = nextSocket
      nextSocket.onopen = () => {
        if (!active) return
        stableConnectionTimer = window.setTimeout(() => {
          reconnectAttempts = 0
        }, 10_000)
      }
      nextSocket.onmessage = (message) => {
        let decoded: Record<string, unknown> | null
        try {
          decoded = record(JSON.parse(String(message.data)))
        } catch {
          return
        }
        if (decoded?.type === 'snapshot') {
          const task = record(decoded.task) as unknown as Task | null
          const sequence = decoded.lastSequence
          if (
            !task ||
            task.id !== selectedTaskId ||
            !Number.isSafeInteger(sequence) ||
            (sequence as number) < 0
          )
            return
          if ((sequence as number) >= snapshotSequence) {
            snapshotTask = task
            snapshotSequence = sequence as number
          }
          if (detailsLoaded && snapshotSequence >= taskStatusSequence) {
            taskStatusSequence = snapshotSequence
            setDetails((current) => {
              if (!current || current.task.id !== selectedTaskId) return current
              if (ephemeralFailureSeen && snapshotTask?.status !== 'failed') return current
              return { ...current, task: snapshotTask as Task }
            })
          }
          return
        }
        if (decoded?.type !== 'event') return
        const event = record(decoded.event) as unknown as TaskEvent | null
        if (!event || typeof event.seq !== 'number') return
        acceptEvents([event])
      }
      nextSocket.onclose = () => {
        if (stableConnectionTimer !== undefined) window.clearTimeout(stableConnectionTimer)
        if (!active) return
        const delay = Math.min(500 * 2 ** reconnectAttempts, 30_000)
        reconnectAttempts = Math.min(reconnectAttempts + 1, 6)
        reconnectTimer = window.setTimeout(connect, delay)
      }
      nextSocket.onerror = () => nextSocket.close()
    }

    connect()
    void request<TaskDetails>(`/api/tasks/${encodeURIComponent(selectedTaskId)}`)
      .then((next) => {
        if (!active) return
        const snapshotLastSequence = next.events.reduce(
          (latest, event) => (event.seq > 0 ? Math.max(latest, event.seq) : latest),
          0,
        )
        const snapshotEvents = mergeEvents(next.events, bufferedEvents)
        const pendingEvents = bufferedEvents
          .filter((event) => event.seq > snapshotLastSequence && event.seq > 0)
          .sort((first, second) => first.seq - second.seq)
        const ephemeralErrors = bufferedEvents.filter((event) => event.seq === 0 && event.type === 'error')
        let task = snapshotTask && snapshotSequence >= snapshotLastSequence ? snapshotTask : next.task
        taskStatusSequence =
          snapshotTask && snapshotSequence >= snapshotLastSequence ? snapshotSequence : snapshotLastSequence
        const pendingStatusEvents = pendingEvents.filter(
          (event) => (event.type === 'result' || event.type === 'error') && event.seq > taskStatusSequence,
        )
        task = pendingStatusEvents.reduce(taskAfterEvent, task)
        taskStatusSequence = Math.max(taskStatusSequence, pendingStatusEvents.at(-1)?.seq ?? -1)
        if (ephemeralErrors.length) {
          ephemeralFailureSeen = true
          task = ephemeralErrors.reduce(taskAfterEvent, task)
        }
        lastAcceptedSequence = snapshotLastSequence
        acceptedOutOfOrder.clear()
        for (const event of pendingEvents) advanceSequence(event)
        bufferedEvents = []
        detailsLoaded = true
        setDetails({ ...next, task, events: snapshotEvents })
        if (pendingStatusEvents.length || ephemeralErrors.length) refreshTaskList()
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '無法載入任務')
      })
    return () => {
      active = false
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (stableConnectionTimer !== undefined) window.clearTimeout(stableConnectionTimer)
      socket?.close()
    }
  }, [selectedTaskId])

  const diff = useMemo(() => diffFrom(details?.events ?? []), [details?.events])
  const diffChunks = useMemo(() => splitDiff(diff?.patch ?? ''), [diff?.patch])
  const selectedPatch = diffChunks.get(activeDiffFile) ?? diffChunks.values().next().value ?? ''

  async function createRepo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError('')
    try {
      await request('/api/repos', {
        method: 'POST',
        body: JSON.stringify({
          path: String(form.get('path') ?? '').trim(),
          defaultBranch: String(form.get('defaultBranch') ?? 'main').trim(),
          ...(form.get('container') ? { container: true } : {}),
        }),
      })
      await refreshLists()
      setShowRepoForm(false)
      setNotice('已加入專案。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法加入專案')
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const model = (role: 'implementer' | 'reviewer'): ModelRef => ({
      provider: String(form.get(`${role}-provider`)) as ProviderKind,
      model: String(form.get(`${role}-model`)).trim(),
      effort: String(form.get(`${role}-effort`)) as NonNullable<ModelRef['effort']>,
    })
    setError('')
    try {
      const { task } = await request<{ task: Task }>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          repoId: String(form.get('repoId')),
          title: taskTitle(String(form.get('title') ?? ''), String(form.get('prompt') ?? '')),
          prompt: String(form.get('prompt')).trim(),
          // A custom workflow (T5.6) brings its own models and options; the built-in ones use the fields below.
          ...(String(form.get('mode')).startsWith('workflow:')
            ? { workflow: String(form.get('mode')).slice('workflow:'.length) }
            : {
                mode: String(form.get('mode')),
                roleOverrides: { implementer: model('implementer'), reviewer: model('reviewer') },
              }),
        }),
      })
      setShowTaskForm(false)
      setSelectedTaskId(task.id)
      await refreshLists()
      setNotice('任務已建立，Joy 在獨立的工作副本裡處理。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法建立任務')
    }
  }

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!config) return
    const form = new FormData(event.currentTarget)
    const roles = { ...config.roles } as RoleConfig
    for (const role of ROLES) {
      roles[role] = {
        provider: String(form.get(`${role}-provider`)) as ProviderKind,
        model: String(form.get(`${role}-model`)).trim(),
        effort: String(form.get(`${role}-effort`)) as NonNullable<ModelRef['effort']>,
      }
    }
    setError('')
    try {
      const { config: saved } = await request<{ config: JoyConfig }>('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ ...config, roles }),
      })
      setConfig(saved)
      setNotice('設定已儲存。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法儲存設定')
    }
  }

  async function saveOpenAiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const value = String(form.get('openai-key') ?? '')
    setError('')
    try {
      const status = await request<SecretStatus>('/api/secrets/openai-api-key', {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
      setSecretStatus(status)
      formElement.reset()
      setNotice('金鑰已安全儲存，之後不會再顯示。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法儲存金鑰')
    }
  }

  async function removeOpenAiKey() {
    setError('')
    try {
      setSecretStatus(await request<SecretStatus>('/api/secrets/openai-api-key', { method: 'DELETE' }))
      setNotice('已移除金鑰。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法移除金鑰')
    }
  }

  function updateRole<K extends keyof ModelRef>(role: Role, field: K, value: ModelRef[K]) {
    if (!config) return
    setConfig({
      ...config,
      roles: {
        ...config.roles,
        [role]: { ...config.roles[role], [field]: value },
      },
    })
  }

  const [showDiff, setShowDiff] = useState(true)
  const [showDetails, setShowDetails] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [composerMode, setComposerMode] = useState('review_loop')

  const composing = page === 'tasks' && (showTaskForm || !selectedTaskId)
  const setupProblems = doctorReport?.checks.filter((check) => check.status === 'missing').length ?? 0
  const tasksByRepo = useMemo(() => {
    const groups = new Map<string, Task[]>()
    for (const task of tasks) groups.set(task.repoId, [...(groups.get(task.repoId) ?? []), task])
    return [...groups.entries()].map(([repoId, list]) => ({
      repoId,
      name: repoName(repos.find((repo) => repo.id === repoId)?.path),
      tasks: list,
    }))
  }, [tasks, repos])
  const timeline = useMemo(() => (details?.events ?? []).map(timelineItem), [details?.events])
  const hiddenCount = timeline.filter((item) => item.kind === 'noise').length
  const diffAdditions = diff?.files.reduce((total, file) => total + file.additions, 0) ?? 0
  const diffDeletions = diff?.files.reduce((total, file) => total + file.deletions, 0) ?? 0
  const working = details ? ['queued', 'running'].includes(details.task.status) : false

  function openComposer() {
    setPage('tasks')
    setShowTaskForm(true)
  }

  function navButton(target: typeof page, label: string, icon: ReactNode) {
    return (
      <button
        className={page === target ? 'nav-item active' : 'nav-item'}
        aria-current={page === target ? 'page' : undefined}
        onClick={() => setPage(target)}
      >
        {icon}
        {label}
      </button>
    )
  }

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="主選單">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            J
          </span>
          <span>Joy</span>
        </div>
        <button
          className={composing ? 'nav-item active' : 'nav-item'}
          onClick={openComposer}
          aria-current={composing ? 'page' : undefined}
        >
          <Icon path="M12 5v14M5 12h14" />
          新任務
        </button>
        {navButton(
          'assistant',
          '助理',
          <Icon path="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
        )}
        {navButton('stats', '統計', <Icon path="M4 20V10M10 20V4M16 20v-7M22 20H2" />)}

        <h2 className="sidebar-section">任務</h2>
        <div className="task-list" aria-label="任務列表">
          {tasks.length === 0 ? (
            <p className="empty-list">你的任務會出現在這裡。</p>
          ) : (
            tasksByRepo.map((group) => (
              <div className="task-group" key={group.repoId}>
                <div className="task-group-label">{group.name}</div>
                {group.tasks.map((task) => (
                  <button
                    className={
                      page === 'tasks' && !composing && selectedTaskId === task.id
                        ? 'task-row selected'
                        : 'task-row'
                    }
                    key={task.id}
                    onClick={() => {
                      setSelectedTaskId(task.id)
                      setShowTaskForm(false)
                      setPage('tasks')
                    }}
                  >
                    <span className={`task-dot status-${task.status}`} aria-hidden="true" />
                    <span className="task-row-copy">
                      <span className="task-title">{task.title}</span>
                      <span className="task-meta">
                        {statusLabel(task.status)} · {modeLabel(task.mode)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <UsageStrip />
          <button className="nav-item" onClick={() => setShowRepoForm(true)}>
            <Icon path="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            加入專案
          </button>
          {navButton(
            'settings',
            '設定',
            <Icon path="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" />,
          )}
        </div>
      </nav>

      <div className="main-area">
        {error && (
          <div className="toast error-toast" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="toast notice-toast" role="status">
            {notice}
          </div>
        )}

        {page === 'assistant' ? (
          <AssistantPage />
        ) : page === 'stats' ? (
          <StatsPage repos={repos} />
        ) : page === 'settings' ? (
          <main className="settings-page">
            <div className="page-heading">
              <div>
                <h1>設定</h1>
                <p className="subheading">各角色用哪個模型、哪些動作要先問你。</p>
              </div>
            </div>

            <section className="settings-card" aria-labelledby="doctor-heading" data-testid="doctor-checks">
              <div className="section-heading">
                <h2 id="doctor-heading">環境檢查</h2>
                <button
                  className="outline-button"
                  aria-label="重新檢查環境"
                  disabled={doctorLoading}
                  onClick={() => setDoctorRetry((retry) => retry + 1)}
                >
                  重新檢查
                </button>
              </div>
              {doctorLoading ? (
                <p className="muted" role="status">
                  正在檢查 Joy 的環境…
                </p>
              ) : doctorReport ? (
                <ul className="doctor-check-list">
                  {doctorReport.checks.map((check) => (
                    <li className="doctor-check" key={check.id}>
                      <div className="doctor-check-heading">
                        <strong>{DOCTOR_LABELS[check.id] ?? check.label}</strong>
                        <span className={`doctor-state doctor-state-${check.status}`}>
                          {doctorStatusLabel(check.status)}
                        </span>
                      </div>
                      <p>{check.summary}</p>
                      {check.repair !== 'No action needed.' && (
                        <p className="doctor-repair">{check.repair}</p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted" role="status">
                  <p>目前無法取得環境檢查結果。</p>
                  <button className="outline-button" onClick={() => setDoctorRetry((retry) => retry + 1)}>
                    再試一次
                  </button>
                </div>
              )}
            </section>

            {config ? (
              <div className="settings-layout">
                <section className="settings-card">
                  <form onSubmit={saveConfig}>
                    <div className="section-heading">
                      <h2>角色與自主程度</h2>
                      <span className="muted">只套用到之後的新任務</span>
                    </div>
                    <div className="mode-setting">
                      <label htmlFor="autonomy-mode">自主程度</label>
                      <select
                        id="autonomy-mode"
                        aria-label="自主程度"
                        value={config.autonomy_mode}
                        onChange={(event) =>
                          setConfig({
                            ...config,
                            autonomy_mode: event.target.value as JoyConfig['autonomy_mode'],
                          })
                        }
                      >
                        <option value="careful">謹慎：每個動作都提高一級</option>
                        <option value="normal">一般：照每個動作的預設等級</option>
                        <option value="hands-off">放手：少通知，但高風險動作仍要你同意</option>
                      </select>
                      <p className="muted">
                        高風險動作（推送、刪除等）一定要你同意，並先由另一個模型預審。來自外部內容的要求永遠不會自動執行。
                      </p>
                    </div>
                    <div className="role-grid">
                      {ROLES.map((role) => (
                        <fieldset className="role-card" key={role}>
                          <legend>{ROLE_LABELS[role]}</legend>
                          {role === 'implementer' && config.roles.implementer.provider === 'openai-api' ? (
                            <p className="muted" role="status">
                              OpenAI API 不能改程式碼，所以這個角色改用 Claude Code。按儲存後生效。
                            </p>
                          ) : null}
                          <label>
                            服務
                            <select
                              aria-label={`${ROLE_LABELS[role]}的服務`}
                              name={`${role}-provider`}
                              value={roleModel(config, role).provider}
                              onChange={(event) =>
                                updateRole(role, 'provider', event.target.value as ProviderKind)
                              }
                            >
                              {providersForRole(role).map((provider) => (
                                <option key={provider} value={provider}>
                                  {PROVIDER_LABELS[provider]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            模型
                            <input
                              aria-label={`${ROLE_LABELS[role]}的模型`}
                              name={`${role}-model`}
                              list={`${role}-model-options`}
                              value={roleModel(config, role).model}
                              onChange={(event) => updateRole(role, 'model', event.target.value)}
                              required
                            />
                            <datalist id={`${role}-model-options`}>
                              {MODEL_SUGGESTIONS[roleModel(config, role).provider].map((model) => (
                                <option key={model} value={model} />
                              ))}
                            </datalist>
                          </label>
                          <label>
                            思考程度
                            <select
                              aria-label={`${ROLE_LABELS[role]}的思考程度`}
                              name={`${role}-effort`}
                              value={roleModel(config, role).effort ?? 'medium'}
                              onChange={(event) =>
                                updateRole(role, 'effort', event.target.value as ModelRef['effort'])
                              }
                            >
                              {EFFORTS.map((effort) => (
                                <option key={effort} value={effort}>
                                  {EFFORT_LABELS[effort] ?? effort}
                                </option>
                              ))}
                            </select>
                          </label>
                        </fieldset>
                      ))}
                    </div>
                    <div className="form-actions">
                      <button className="primary-button" type="submit">
                        儲存設定
                      </button>
                    </div>
                  </form>
                </section>

                <section className="settings-card secret-card">
                  <div className="section-heading">
                    <h2>OpenAI API 金鑰</h2>
                    <span
                      className={secretStatus?.set ? 'status-pill configured' : 'status-pill'}
                      role="status"
                    >
                      {secretStatusLoading
                        ? '檢查中…'
                        : secretStatus === null
                          ? '無法取得'
                          : secretStatus.set
                            ? '已設定'
                            : '未設定'}
                    </span>
                  </div>
                  <p className="muted secret-description">
                    {secretStatusLoading
                      ? '正在檢查金鑰狀態…'
                      : secretStatus === null
                        ? '目前無法取得金鑰狀態，暫時不能管理金鑰。'
                        : '存在作業系統鑰匙圈。Joy 不會把金鑰傳回瀏覽器，也不會寫進設定檔、紀錄或資料庫。'}
                  </p>
                  {secretStatusLoading ? null : secretStatus === null ? (
                    <button
                      className="outline-button"
                      type="button"
                      onClick={() => {
                        setSecretStatusLoading(true)
                        setSecretStatusRetry((attempt) => attempt + 1)
                      }}
                    >
                      重新檢查金鑰
                    </button>
                  ) : secretStatus.source === 'env' ? (
                    <div className="env-managed" role="status">
                      由環境變數 OPENAI_API_KEY 管理。
                    </div>
                  ) : (
                    <form className="secret-form" onSubmit={saveOpenAiKey}>
                      <label htmlFor="openai-key">{secretStatus.set ? '換一把金鑰' : '輸入金鑰'}</label>
                      <div className="secret-input-row">
                        <input
                          id="openai-key"
                          name="openai-key"
                          type="password"
                          autoComplete="new-password"
                          minLength={1}
                          required
                        />
                        <button className="primary-button" type="submit">
                          儲存金鑰
                        </button>
                      </div>
                      <div className="secret-actions">
                        <span className="muted">
                          {secretStatus.set ? '已安全存在作業系統鑰匙圈' : '儲存後只會顯示狀態'}
                        </span>
                        {secretStatus.source === 'keychain' && (
                          <button
                            className="text-button danger-text"
                            type="button"
                            onClick={() => void removeOpenAiKey()}
                          >
                            移除金鑰
                          </button>
                        )}
                      </div>
                    </form>
                  )}
                </section>
                {config ? <TelegramSettings config={config} onConfig={setConfig} /> : null}
                <AccessTokenPanel />
                <NotificationsPanel />
                <WorktreesPanel />
                <BackupsPanel />
                <LogsPanel />
              </div>
            ) : (
              <div className="loading-card">正在載入設定…</div>
            )}
          </main>
        ) : !composing && !details ? (
          <main className="composer-page" aria-busy="true">
            <div className="timeline-working" role="status">
              <span className="spinner" aria-hidden="true" />
              正在載入任務…
            </div>
          </main>
        ) : composing || !details ? (
          <main className="composer-page">
            {setupProblems > 0 ? (
              <button type="button" className="setup-banner" onClick={() => setPage('settings')}>
                有 {setupProblems} 項環境設定需要處理，點這裡查看
              </button>
            ) : null}
            {repos.length === 0 ? (
              <div className="composer-empty">
                <h1>先加入一個專案</h1>
                <p>選一個電腦裡的 Git 專案資料夾，Joy 會在獨立的工作副本裡幫你改程式。</p>
                <button className="primary-button" onClick={() => setShowRepoForm(true)}>
                  加入專案
                </button>
              </div>
            ) : (
              <form className="composer-home" onSubmit={(event) => void createTask(event)}>
                <h1>要讓 Joy 做什麼？</h1>
                <div className="composer">
                  <textarea
                    name="prompt"
                    aria-label="任務內容"
                    placeholder="例如：登入頁按 Enter 不會送出，幫我修好"
                    required
                    rows={3}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
                        event.currentTarget.form?.requestSubmit()
                    }}
                  />
                  <div className="composer-bar">
                    <select name="repoId" aria-label="專案" className="chip-select" required>
                      {repos.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                          {repoName(repo.path)} · {repo.defaultBranch}
                        </option>
                      ))}
                    </select>
                    <select
                      name="mode"
                      aria-label="模式"
                      className="chip-select"
                      value={composerMode}
                      onChange={(event) => setComposerMode(event.target.value)}
                    >
                      <option value="review_loop">實作＋審查</option>
                      <option value="single">單人</option>
                      <option value="compete">兩家比賽</option>
                      {customWorkflows.map((workflow) => (
                        <option key={workflow.name} value={`workflow:${workflow.name}`}>
                          {workflow.name}
                          {workflow.description ? ` — ${workflow.description}` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="chip-button"
                      aria-expanded={showAdvanced}
                      onClick={() => setShowAdvanced((open) => !open)}
                    >
                      進階
                    </button>
                    <span className="composer-spacer" />
                    <button type="submit" className="send-button" aria-label="開始任務">
                      <Icon path="M12 19V5M5 12l7-7 7 7" />
                    </button>
                  </div>
                  <div className="composer-advanced" hidden={!showAdvanced}>
                    <label>
                      標題（選填，預設用任務內容的第一行）
                      <input name="title" aria-label="任務標題" maxLength={500} />
                    </label>
                    <div className="task-model-grid">
                      {(['implementer', 'reviewer'] as const).map((role) => {
                        const model = roleModel(config, role)
                        return (
                          <fieldset className="task-role-card" key={role}>
                            <legend>{ROLE_LABELS[role]}</legend>
                            <label>
                              服務
                              <select
                                aria-label={`${ROLE_LABELS[role]}的服務`}
                                name={`${role}-provider`}
                                defaultValue={model.provider}
                              >
                                {providersForRole(role).map((provider) => (
                                  <option key={provider} value={provider}>
                                    {PROVIDER_LABELS[provider]}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              模型
                              <input
                                aria-label={`${ROLE_LABELS[role]}的模型`}
                                name={`${role}-model`}
                                list={`task-${role}-models`}
                                defaultValue={model.model}
                                required
                              />
                              <datalist id={`task-${role}-models`}>
                                {MODEL_SUGGESTIONS[model.provider].map((option) => (
                                  <option key={option} value={option} />
                                ))}
                              </datalist>
                            </label>
                            <label>
                              思考程度
                              <select
                                aria-label={`${ROLE_LABELS[role]}的思考程度`}
                                name={`${role}-effort`}
                                defaultValue={model.effort ?? 'medium'}
                              >
                                {EFFORTS.map((effort) => (
                                  <option key={effort} value={effort}>
                                    {EFFORT_LABELS[effort] ?? effort}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </fieldset>
                        )
                      })}
                    </div>
                  </div>
                </div>
                <p className="composer-hint">{MODE_HINTS[composerMode] ?? '照這個自訂流程的設定執行。'}</p>
              </form>
            )}
          </main>
        ) : (
          <main className="thread" aria-label="任務進度">
            <header className="thread-header">
              <div className="thread-heading">
                <h1>{details.task.title}</h1>
                <span className="thread-sub">
                  {repoName(details.repo?.path)} · {details.repo?.defaultBranch ?? 'main'} ·{' '}
                  {modeLabel(details.task.mode)}
                </span>
              </div>
              <span className={`status-pill status-${details.task.status}`}>
                {statusLabel(details.task.status)}
              </span>
              <button
                className="outline-button diff-toggle"
                aria-pressed={showDiff}
                onClick={() => setShowDiff((open) => !open)}
              >
                變更 <span className="additions">+{diffAdditions}</span>{' '}
                <span className="deletions">−{diffDeletions}</span>
              </button>
            </header>
            <div className="thread-body">
              <div className="thread-scroll">
                <div className="thread-column">
                  <div className="user-bubble">{details.task.prompt}</div>
                  <ApprovalsPanel
                    taskId={details.task.id}
                    taskStatus={details.task.status}
                    approvalEvents={
                      details.events.filter((event) => event.type.startsWith('approval.')).length
                    }
                  />
                  <div className="timeline" aria-label="任務紀錄" data-testid="event-stream">
                    {timeline.map((item, index) => (
                      <div
                        hidden={item.kind === 'noise' && !showDetails}
                        className={`timeline-item timeline-${item.kind} ${item.tone ? `tone-${item.tone}` : ''}`}
                        data-event-seq={details.events[index]?.seq}
                        key={`${details.events[index]?.seq ?? 0}-${index}`}
                      >
                        {item.kind === 'message' ? (
                          <>
                            {item.role ? <span className="timeline-role">{item.role}</span> : null}
                            <p>{item.text}</p>
                          </>
                        ) : item.kind === 'phase' ? (
                          <span>{item.text}</span>
                        ) : (
                          <>
                            <span className="timeline-mark" aria-hidden="true" />
                            <span className="timeline-text">{item.text}</span>
                          </>
                        )}
                      </div>
                    ))}
                    {working ? (
                      <div className="timeline-working" role="status">
                        <span className="spinner" aria-hidden="true" />
                        Joy 正在處理…
                      </div>
                    ) : null}
                  </div>
                  {hiddenCount > 0 ? (
                    <button
                      className="text-button details-toggle"
                      onClick={() => setShowDetails((open) => !open)}
                    >
                      {showDetails ? '隱藏細節' : `顯示細節（${hiddenCount} 筆）`}
                    </button>
                  ) : null}
                  {details.task.mode === 'compete' && details.task.status !== 'done' ? (
                    <ComparePanel details={details} onChanged={() => void refreshSelectedTask()} />
                  ) : null}
                  <div className="thread-actions">
                    <PublishPanel details={details} onChanged={() => void refreshSelectedTask()} />
                    <DiscardButton details={details} onChanged={() => void refreshSelectedTask()} />
                  </div>
                </div>
              </div>
              {showDiff ? (
                <aside className="diff-pane" aria-label="檔案變更">
                  <div className="diff-header">
                    <h2>變更</h2>
                    <span className="muted">{diff?.files.length ?? 0} 個檔案</span>
                  </div>
                  {diff ? (
                    <>
                      <div className="diff-file-list" aria-label="變更的檔案">
                        {diff.files.map((file) => (
                          <button
                            className={activeDiffFile === file.path ? 'diff-file active' : 'diff-file'}
                            key={file.path}
                            onClick={() => setActiveDiffFile(file.path)}
                          >
                            <span className="diff-file-path">{file.path}</span>
                            <span className="file-stat">
                              <span className="additions">+{file.additions}</span>{' '}
                              <span className="deletions">−{file.deletions}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                      <pre className="diff-code" data-testid="diff-patch">
                        {String(selectedPatch)
                          .split('\n')
                          .map((line, index) => (
                            <span
                              className={
                                line.startsWith('+') && !line.startsWith('+++')
                                  ? 'diff-line added'
                                  : line.startsWith('-') && !line.startsWith('---')
                                    ? 'diff-line removed'
                                    : line.startsWith('@@')
                                      ? 'diff-line hunk'
                                      : 'diff-line'
                              }
                              key={`${index}-${line}`}
                            >
                              {line || ' '}
                            </span>
                          ))}
                      </pre>
                    </>
                  ) : (
                    <div className="diff-empty">
                      <h3>還沒有變更</h3>
                      <p>任務完成後，改了哪些地方會顯示在這裡。</p>
                    </div>
                  )}
                </aside>
              ) : null}
            </div>
          </main>
        )}
      </div>

      {showRepoForm && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowRepoForm(false)
          }}
        >
          <section
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="repo-dialog-title"
          >
            <div className="dialog-header">
              <h2 id="repo-dialog-title">加入專案</h2>
              <button className="close-button" aria-label="關閉" onClick={() => setShowRepoForm(false)}>
                ×
              </button>
            </div>
            <p className="muted">填入執行 Joy 這台電腦上，Git 專案資料夾的完整路徑。</p>
            <form className="stacked-form" onSubmit={(event) => void createRepo(event)}>
              <label>
                專案路徑
                <input
                  name="path"
                  aria-label="專案路徑"
                  placeholder="/Users/you/project"
                  required
                  autoFocus
                />
              </label>
              <label>
                預設分支
                <input name="defaultBranch" aria-label="預設分支" defaultValue="main" required />
              </label>
              <label className="checkbox-row">
                <input type="checkbox" name="container" aria-label="在容器裡執行 agent" />
                不信任的程式碼：在容器裡執行 agent（需要 Docker，見 README）
              </label>
              <div className="form-actions">
                <button className="quiet-button" type="button" onClick={() => setShowRepoForm(false)}>
                  取消
                </button>
                <button className="primary-button" type="submit">
                  加入專案
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}

export default App

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing application root element')
// The service worker only shows notifications (T4.2); browsers allow it on HTTPS and localhost.
if ('serviceWorker' in navigator && window.isSecureContext)
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)

createRoot(rootElement).render(<App />)
