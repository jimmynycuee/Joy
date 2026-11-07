import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FormEvent } from 'react'
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
  assistant_brain: 'Assistant brain',
  background: 'Background',
  orchestrator: 'Orchestrator',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  judge: 'Judge',
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
  return status === 'ok' ? 'OK' : status === 'missing' ? 'Missing' : 'Untested'
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('authorization', `Bearer ${apiToken()}`)
  const response = await fetch(path, { ...init, headers })
  if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  const text = await response.text()
  const body = text ? (JSON.parse(text) as T & ApiError) : ({} as T & ApiError)
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
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
      return `Running ${agentEvent.name}`
    if (agentEvent?.type === 'done') return 'Agent finished the task'
    if (agentEvent?.type === 'error' && typeof agentEvent.message === 'string') return agentEvent.message
    return `Agent event: ${String(agentEvent?.type ?? 'update')}`
  }
  if (event.type === 'phase' && typeof payload?.phase === 'string') return `Phase: ${payload.phase}`
  if (event.type === 'result') return 'Task result is ready'
  if (event.type === 'review') {
    const summary = record(payload?.verdict)?.summary
    if (typeof summary === 'string' && summary) return `Review: ${summary}`
  }
  if (event.type === 'error' && typeof payload?.message === 'string') return payload.message
  if (event.type === 'started') return 'Task started'
  if (event.type === 'workspace') return 'Isolated worktree prepared'
  return event.type.replaceAll('_', ' ')
}

function eventKind(event: TaskEvent): string {
  const policyKind = policyEventKind(event.type, record(event.payload))
  if (policyKind) return policyKind
  if (event.type !== 'agent') return event.type
  const payload = record(event.payload)
  const role = payload?.role
  return typeof role === 'string' ? role : 'agent'
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
      setFailure(error instanceof Error ? error.message : 'Could not record the decision')
    } finally {
      setBusy('')
    }
  }

  if (pending.length === 0) return null
  return (
    <section className="approvals-panel" aria-label="Pending approvals" data-testid="pending-approvals">
      <h2>
        {pending.some((a) => a.status === 'expired')
          ? 'Paused until you approve'
          : 'Waiting for your approval'}
      </h2>
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
              {approval.status === 'expired' ? 'Approve and resume' : 'Approve'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy === approval.id}
              onClick={() => void decide(approval.id, 'deny')}
            >
              Deny
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
      setMessage('Saved. Restart Joy to connect Telegram.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save Telegram settings')
    }
  }

  return (
    <section className="settings-card" aria-labelledby="telegram-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">CHANNELS</p>
          <h2 id="telegram-heading">Telegram</h2>
        </div>
        <span className={tokenStatus?.set && chatId ? 'status-pill configured' : 'status-pill'}>
          {tokenStatus?.set && chatId ? 'Configured' : 'Not configured'}
        </span>
      </div>
      <p className="muted secret-description">
        Joy sends approval requests and task results to your chat and only accepts button presses from it.
        Create a bot with @BotFather; the token is stored in the OS keychain.
      </p>
      <form className="secret-form" onSubmit={(event) => void save(event)}>
        <label htmlFor="telegram-chat-id">Your chat id</label>
        <input
          id="telegram-chat-id"
          name="telegram-chat-id"
          inputMode="numeric"
          pattern="-?[0-9]+"
          defaultValue={chatId ?? ''}
        />
        {tokenStatus?.source === 'env' ? (
          <div className="env-managed" role="status">
            Managed by the JOY_TELEGRAM_BOT_TOKEN environment variable.
          </div>
        ) : (
          <>
            <label htmlFor="telegram-token">{tokenStatus?.set ? 'Replace bot token' : 'Bot token'}</label>
            <input id="telegram-token" name="telegram-token" type="password" autoComplete="new-password" />
          </>
        )}
        <button className="primary-button" type="submit">
          Save Telegram settings
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
      setFailure(error instanceof Error ? error.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="compare-panel" aria-label="Compare attempts" data-testid="compare-panel">
      {judgement ? (
        <div className="judge-box" aria-label="Judge">
          <p className="eyebrow">JUDGE</p>
          <p>
            {judgement.winner ? (
              <strong>Prefers {labels.get(judgement.winner) ?? 'an attempt'}.</strong>
            ) : (
              <strong>No attempt is acceptable.</strong>
            )}{' '}
            {judgement.reasons}
          </p>
          {judgement.mergeRecommended ? (
            <p className="muted">The judge thinks a merged version would be better.</p>
          ) : null}
        </div>
      ) : details.task.status === 'running' ? (
        <p className="muted">The attempts are running; the judge compares them when both are reviewed.</p>
      ) : null}
      <div className="compare-columns">
        {attempts.map((attempt) => {
          const id = String(attempt.id)
          const result = results.get(id)
          const resultDiff = record(result?.diff) as WorkspaceDiff | undefined
          const review = reviews.filter((r) => r.attemptId === id).at(-1)
          const notes = judgement?.attempts.find((a) => a.attemptId === id)
          const label = id === mergeId ? 'Merged' : (labels.get(id) ?? 'Attempt')
          return (
            <article
              key={id}
              className={id === chosenId ? 'compare-column chosen' : 'compare-column'}
              aria-label={`Attempt ${label}`}
            >
              <header>
                <strong>{label}</strong>
                <span className="muted">
                  {' '}
                  {String(attempt.provider)} · {String(attempt.model)}
                </span>
                {judgement?.winner === id ? <span className="badge">judge's pick</span> : null}
                {id === chosenId ? <span className="badge">chosen</span> : null}
              </header>
              <p className="muted">
                {result
                  ? result.status === 'succeeded'
                    ? review
                      ? `Review: ${review.approve ? 'approved' : 'changes requested'}${review.summary ? ` — ${String(review.summary)}` : ''}`
                      : 'Finished'
                    : `${String(result.status)}${result.reason ? `: ${String(result.reason)}` : ''}`
                  : 'Running…'}
              </p>
              {notes ? (
                <p className="compare-notes">
                  <span>+ {notes.strengths}</span>
                  <span>− {notes.weaknesses}</span>
                </p>
              ) : null}
              {resultDiff ? (
                <pre className="diff-code compare-diff" aria-label={`Diff ${label}`}>
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
                  Choose {label}
                </button>
              ) : null}
            </article>
          )
        })}
      </div>
      {canMerge ? (
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void act('merge', {})}>
          Merge: the judge re-implements the best of both
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
    if (!window.confirm(`${message}\n\nDelete these commits anyway?`)) return false
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
      setFailure(error instanceof Error ? error.message : 'Could not remove the worktree')
    }
    await load().catch(() => undefined)
  }

  const stale = data?.worktrees.filter((row) => row.stale && !row.active) ?? []
  return (
    <section className="settings-card" aria-label="Worktrees" data-testid="worktrees-panel">
      <h2>Worktrees</h2>
      <p className="muted">
        {data ? `${data.worktrees.length} worktree(s) using ${formatBytes(data.totalBytes)}.` : 'Loading…'}
        {stale.length ? ` ${stale.length} idle for more than ${data?.staleAfterDays} days.` : ''}
      </p>
      {data?.worktrees.length ? (
        <ul className="worktree-list">
          {data.worktrees.map((row) => (
            <li key={row.path} className={row.stale ? 'worktree-item stale' : 'worktree-item'}>
              <span>
                <strong>{row.taskTitle ?? row.branch ?? row.path}</strong>
                <span className="muted">
                  {' '}
                  · {formatBytes(row.diskUsageBytes)} · {Math.floor(row.ageDays)} day(s) idle
                  {row.unpushedCommitCount ? ` · ${row.unpushedCommitCount} unpushed commit(s)` : ''}
                  {row.stale ? ' · idle' : ''}
                </span>
              </span>
              {row.active ? (
                <span className="muted">running</span>
              ) : (
                <button type="button" className="quiet-button" onClick={() => void remove(row)}>
                  Remove
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
  if (!response.ok) throw new Error(`Download failed (${response.status})`)
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
    <section className="settings-card" aria-label="Debug logs" data-testid="logs-panel">
      <h2>Debug logs</h2>
      <p className="muted">
        One file per day, kept 14 days. Known secrets are removed before anything is written.
      </p>
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
                  setFailure(error instanceof Error ? error.message : 'Download failed'),
                )
              }
            >
              Download
            </button>
          </li>
        ))}
      </ul>
      {logs.length === 0 ? <p className="muted">No logs yet.</p> : null}
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
      setMessage(body.created ? 'Backup taken.' : "Today's backup already exists.")
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Backup failed')
    }
  }

  async function exportJson() {
    try {
      await downloadFile('/api/export', `joy-export-${new Date().toISOString().slice(0, 10)}.json`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Export failed')
    }
  }

  return (
    <section className="settings-card" aria-label="Backups" data-testid="backups-panel">
      <h2>Backups &amp; export</h2>
      <p className="muted">Joy backs up its database once a day and keeps the last 7.</p>
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
          Back up now
        </button>
        <button type="button" className="quiet-button" onClick={() => void exportJson()}>
          Export tasks and memories (JSON)
        </button>
      </div>
      <p className="muted">
        To restore: stop Joy, then run <code>pnpm joy restore 2026-11-06</code> (a day from the list).
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
    return 'Notifications need HTTPS (or localhost). On a phone, open Joy through `tailscale serve` (see README).'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return 'This browser does not support Web Push. On iPhone, add Joy to the Home Screen first.'
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
      if ((await Notification.requestPermission()) !== 'granted')
        throw new Error('Notifications were not allowed')
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
      setMessage(error instanceof Error ? error.message : 'Could not turn notifications on')
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
    <section className="settings-card" aria-label="Notifications" data-testid="notifications-panel">
      <h2>Notifications</h2>
      <p className="muted">When a task finishes or needs your approval, this device gets a notification.</p>
      {unsupported ? (
        <p className="muted">{unsupported}</p>
      ) : state === 'on' ? (
        <div className="project-note-actions">
          <span>On for this device.</span>
          <button
            type="button"
            className="quiet-button"
            onClick={() => void request('/api/push/test', { method: 'POST', body: '{}' })}
          >
            Send a test
          </button>
          <button type="button" className="quiet-button" onClick={() => void disable()}>
            Turn off
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="quiet-button"
          disabled={state === 'busy'}
          onClick={() => void enable()}
        >
          Turn on notifications
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
          if (!window.confirm('Discard this task’s worktree and its changes?')) return
          setFailure('')
          void removeWithConfirmation(`/api/tasks/${encodeURIComponent(details.task.id)}/discard`, {})
            .then(onChanged)
            .catch((error: unknown) =>
              setFailure(error instanceof Error ? error.message : 'Could not discard'),
            )
        }}
      >
        Discard worktree
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
      setFailure(error instanceof Error ? error.message : 'Could not save the remote')
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
      setFailure(error instanceof Error ? error.message : 'Publishing failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="publish-panel" data-testid="publish-panel">
      {typeof prUrl === 'string' ? (
        <a href={prUrl} target="_blank" rel="noreferrer">
          Draft PR opened ↗
        </a>
      ) : remote ? (
        <button className="primary-button" type="button" disabled={busy} onClick={() => void publishTask()}>
          {busy ? 'Opening draft PR…' : 'Open draft PR'}
        </button>
      ) : (
        <form className="secret-form" onSubmit={(event) => void setRemote(event)}>
          <label htmlFor="github-remote">GitHub repository URL</label>
          <div className="secret-input-row">
            <input
              id="github-remote"
              name="github-remote"
              placeholder="https://github.com/owner/repo.git"
              required
            />
            <button className="outline-button" type="submit">
              Save
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
          OpenAI API ${api.monthSpentUsd.toFixed(2)} / ${api.monthlyCapUsd.toFixed(2)} this month
        </span>
      ) : null}
      {limited.map(([provider, state]) => (
        <span className="usage-limited" key={provider}>
          {provider} out of quota
          {state.resetsAt ? ` until ${new Date(state.resetsAt * 1000).toLocaleTimeString()}` : ''}
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
      props.onError(error instanceof Error ? error.message : 'Could not save the memory')
    }
  }

  return (
    <section className="memory-panel" aria-label="Memories" data-testid="memory-panel">
      <h3>What Joy remembers</h3>
      {props.memories.length === 0 ? <p className="muted">Nothing yet.</p> : null}
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
                  aria-label="Memory text"
                  value={draft}
                  maxLength={500}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="quiet-button">
                  Save
                </button>
                <button type="button" className="quiet-button" onClick={() => setEditing('')}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span>{memory.content}</span>
                {memory.supersededBy ? <span className="muted"> (replaced)</span> : null}
                {!memory.supersededBy && memoryInactive(memory) ? (
                  <span className="muted"> (expired)</span>
                ) : null}
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => {
                    setEditing(memory.id)
                    setDraft(memory.content)
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  aria-label={`Delete memory: ${memory.content}`}
                  onClick={() => void deleteMemory(memory.id, props.onChange, props.onError)}
                >
                  Delete
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
      props.onError(error instanceof Error ? error.message : 'Could not cancel')
    }
    await load().catch(() => undefined)
  }

  if (items.reminders.length === 0 && items.schedules.length === 0) return null
  return (
    <section className="memory-panel" aria-label="Scheduled" data-testid="scheduled-panel">
      <h3>Scheduled</h3>
      <ul>
        {items.reminders.map((reminder) => (
          <li key={reminder.id} className="memory-item">
            <span>
              ⏰ {reminder.text} <span className="muted">· {new Date(reminder.dueAt).toLocaleString()}</span>
            </span>
            <button type="button" className="quiet-button" onClick={() => void cancel(reminder.id)}>
              Cancel
            </button>
          </li>
        ))}
        {items.schedules.map((schedule) => (
          <li key={schedule.id} className="memory-item">
            <span>
              🔁 {String(schedule.action === 'reminder' ? schedule.payload.text : schedule.payload.title)}{' '}
              <span className="muted">
                · <code>{schedule.cron}</code> · next {new Date(schedule.nextRunAt).toLocaleString()}
              </span>
            </span>
            <button type="button" className="quiet-button" onClick={() => void cancel(schedule.id)}>
              Remove
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
        <input
          name="q"
          type="search"
          placeholder="Search past conversations"
          aria-label="Search past conversations"
        />
      </form>
      {hits === null ? null : hits.length === 0 ? (
        <p className="muted">No matches.</p>
      ) : (
        <ul aria-label="Search results">
          {hits.map((hit, index) => (
            <li key={`${hit.conversationId}-${index}`}>
              <button type="button" className="task-row" onClick={() => props.onOpen(hit.conversationId)}>
                <span className="muted">
                  {hit.ts.slice(0, 10)} · {hit.title ?? 'Conversation'}
                  {hit.kind === 'summary' ? ' · summary' : ''}
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
      props.onError(error instanceof Error ? error.message : 'Could not answer')
    }
    await load().catch(() => undefined)
    props.onDecided()
  }

  if (actions.length === 0) return null
  return (
    <section className="project-notes" aria-label="Waiting for your approval" data-testid="assistant-actions">
      <h3>🔴 Waiting for your approval</h3>
      {actions.map((action) => (
        <article key={action.id} className="project-note">
          <p>
            <code>{action.summary}</code>
            {action.provenance === 'external_content' ? (
              <span className="muted"> · asked for after reading mail or calendar content</span>
            ) : null}
          </p>
          <div className="project-note-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void decide(action.id, 'approve')}
            >
              Approve
            </button>
            <button type="button" className="quiet-button" onClick={() => void decide(action.id, 'deny')}>
              Deny
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
      props.onError(error instanceof Error ? error.message : 'Could not update the proposal')
    }
    await load().catch(() => undefined)
  }

  if (notes.length === 0) return null
  return (
    <section className="project-notes" aria-label="Project note proposals" data-testid="project-notes">
      <h3>Proposed project notes</h3>
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
            <p className="muted">The file changed since this was proposed. Reject it and ask Joy again.</p>
          ) : (
            <pre className="diff" aria-label={`Diff for ${note.note}`}>
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
                Apply to {note.file}
              </button>
            )}
            <button type="button" className="quiet-button" onClick={() => void decide(note.id, 'reject')}>
              Reject
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
    onError(error instanceof Error ? error.message : 'Could not delete the memory')
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
      setFailure(error instanceof Error ? error.message : 'The assistant did not answer')
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
      <aside className="assistant-list" aria-label="Conversations">
        <button className="primary-button" type="button" onClick={() => void newConversation()}>
          New conversation
        </button>
        <HistorySearch onOpen={setSelected} />
        {conversations.map((conversation) => (
          <button
            type="button"
            key={conversation.id}
            className={conversation.id === selected ? 'task-row selected' : 'task-row'}
            onClick={() => setSelected(conversation.id)}
          >
            {conversation.title ?? 'New conversation'}
          </button>
        ))}
        <ScheduledPanel onError={setFailure} />
        <MemoryPanel memories={memories} onChange={loadMemories} onError={setFailure} />
      </aside>
      <section className="assistant-chat" aria-label="Chat">
        <AssistantActionsPanel onError={setFailure} onDecided={() => undefined} />
        <ProjectNotesPanel onError={setFailure} />
        <div className="chat-messages">
          {messages.length === 0 ? (
            <p className="muted">
              Ask about your repositories and tasks. The assistant brain is set in Settings.
            </p>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`chat-message chat-${message.role}`}>
                <span className="chat-role">
                  {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Joy' : 'Error'}
                </span>
                <p>{message.content}</p>
                {message.role === 'assistant' && message.memoryIds?.length ? (
                  <div className="memory-chips" aria-label="Memories used">
                    {message.memoryIds.map((id) => {
                      const memory = memories.find((m) => m.id === id)
                      return memory ? (
                        <span key={id} className="memory-chip">
                          {memory.content}
                          <button
                            type="button"
                            aria-label={`Forget: ${memory.content}`}
                            onClick={() => void deleteMemory(id, loadMemories, setFailure)}
                          >
                            ×
                          </button>
                        </span>
                      ) : (
                        <span key={id} className="memory-chip deleted">
                          deleted memory
                        </span>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ))
          )}
          {sending ? <p className="muted">Joy is thinking…</p> : null}
        </div>
        {failure ? <p className="approvals-error">{failure}</p> : null}
        <form className="chat-form" onSubmit={(event) => void send(event)}>
          <textarea name="message" rows={3} placeholder="Message Joy" required disabled={sending} />
          <button className="primary-button" type="submit" disabled={sending}>
            Send
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
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${Math.max(1, Math.round(minutes))} min`
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
        if (!cancelled) setFailure(error instanceof Error ? error.message : 'Could not load stats')
      })
    return () => {
      cancelled = true
    }
  }, [filter])

  return (
    <main className="settings-page stats-page" data-testid="stats-page">
      <div className="page-heading">
        <h1>Model stats</h1>
      </div>
      <form className="stats-filter" onSubmit={(event) => event.preventDefault()}>
        <label>
          From
          <input
            type="date"
            value={filter.from}
            onChange={(e) => setFilter({ ...filter, from: e.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={filter.to}
            onChange={(e) => setFilter({ ...filter, to: e.target.value })}
          />
        </label>
        <label>
          Repository
          <select value={filter.repoId} onChange={(e) => setFilter({ ...filter, repoId: e.target.value })}>
            <option value="">All</option>
            {props.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.path}
              </option>
            ))}
          </select>
        </label>
      </form>
      {failure ? <p className="approvals-error">{failure}</p> : null}
      <h2>As implementer</h2>
      {stats && stats.implementers.length === 0 ? <p className="muted">No attempts in this period.</p> : null}
      {stats && stats.implementers.length ? (
        <table className="stats-table" aria-label="Implementer stats">
          <thead>
            <tr>
              <th>Model</th>
              <th>Mode</th>
              <th>Attempts</th>
              <th>Pass rate</th>
              <th>Problems found by review</th>
              <th>Avg time</th>
              <th>Handoffs</th>
            </tr>
          </thead>
          <tbody>
            {stats.implementers.map((row) => (
              <tr key={`${row.provider}/${row.model}/${row.mode}`}>
                <td>
                  {row.provider} · {row.model}
                </td>
                <td>{row.mode}</td>
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
      <h2>As reviewer</h2>
      {stats && stats.reviewers.length === 0 ? <p className="muted">No reviews in this period.</p> : null}
      {stats && stats.reviewers.length ? (
        <table className="stats-table" aria-label="Reviewer stats">
          <thead>
            <tr>
              <th>Model</th>
              <th>Reviews</th>
              <th>Approved</th>
              <th>Problems found</th>
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
      <h1>Joy access token</h1>
      <p className="muted">
        Paste the token from <code>~/.joy/api-token</code> on the computer that runs Joy. It is kept on this
        device only.
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
        <input name="token" type="password" aria-label="Access token" autoComplete="off" required />
        <button className="primary-button" type="submit">
          Continue
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
    if (!window.confirm('Regenerate the access token? Every other device and tab will need the new token.'))
      return
    setFailure('')
    try {
      const body = await request<{ token: string }>('/api/token/rotate', { method: 'POST', body: '{}' })
      saveApiToken(body.token)
      setShown(body.token)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not regenerate the token')
    }
  }

  return (
    <section className="settings-card" aria-label="Access token" data-testid="access-token-panel">
      <h2>Access token</h2>
      <p className="muted">
        Every request to Joy needs this token. For remote access (Tailscale), see the README.
      </p>
      <button type="button" className="quiet-button" onClick={() => void regenerate()}>
        Regenerate token
      </button>
      {shown ? (
        <p>
          New token (shown once): <code data-testid="new-token">{shown}</code>
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
    if (!selectedTaskId && taskResponse.tasks[0]) setSelectedTaskId(taskResponse.tasks[0].id)
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
        if (taskResponse.tasks[0]) setSelectedTaskId(taskResponse.tasks[0].id)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not connect to Joy server')
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
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load task')
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
      setNotice('Repository added to this Joy server.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add repository')
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
          title: String(form.get('title')).trim(),
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
      setNotice('Task created. Joy is working in an isolated worktree.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create task')
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
      setNotice('Settings saved.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save settings')
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
      setNotice('OpenAI key saved securely; the value is not returned or displayed.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save OpenAI key')
    }
  }

  async function removeOpenAiKey() {
    setError('')
    try {
      setSecretStatus(await request<SecretStatus>('/api/secrets/openai-api-key', { method: 'DELETE' }))
      setNotice('Saved OpenAI key removed.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove OpenAI key')
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#workspace" onClick={() => setPage('tasks')} aria-label="Joy workspace">
          <span className="brand-mark">J</span>
          <span>joy</span>
        </a>
        <div className="topbar-center">
          <span className="connection-dot" />
          <span>Local workspace</span>
        </div>
        <nav className="topbar-nav" aria-label="Main navigation">
          <button
            className={page === 'tasks' ? 'nav-button active' : 'nav-button'}
            onClick={() => setPage('tasks')}
          >
            Workspace
          </button>
          <button
            className={page === 'assistant' ? 'nav-button active' : 'nav-button'}
            onClick={() => setPage('assistant')}
          >
            Assistant
          </button>
          <button
            className={page === 'stats' ? 'nav-button active' : 'nav-button'}
            onClick={() => setPage('stats')}
          >
            Stats
          </button>
          <button
            className={page === 'settings' ? 'nav-button active' : 'nav-button'}
            onClick={() => setPage('settings')}
          >
            Settings
          </button>
        </nav>
      </header>

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
              <p className="eyebrow">PREFERENCES</p>
              <h1>Settings</h1>
              <p className="subheading">Configure model routing and global action permissions.</p>
            </div>
            <button className="quiet-button" onClick={() => setPage('tasks')}>
              Back to workspace
            </button>
          </div>

          {config ? (
            <div className="settings-layout">
              <section className="settings-card">
                <form onSubmit={saveConfig}>
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">MODEL ROUTING</p>
                      <h2>Roles and autonomy</h2>
                    </div>
                    <span className="muted">Changes apply to new tasks</span>
                  </div>
                  <div className="mode-setting">
                    <label htmlFor="autonomy-mode">Global autonomy mode</label>
                    <select
                      id="autonomy-mode"
                      aria-label="Global autonomy mode"
                      value={config.autonomy_mode}
                      onChange={(event) =>
                        setConfig({
                          ...config,
                          autonomy_mode: event.target.value as JoyConfig['autonomy_mode'],
                        })
                      }
                    >
                      <option value="careful">Careful — raise actions by one tier</option>
                      <option value="normal">Normal — use each action’s default tier</option>
                      <option value="hands-off">Hands-off — lower notifications, keep red approvals</option>
                    </select>
                    <p className="muted">
                      Red actions always need owner approval and cross-model pre-review. Actions derived from
                      external content are never auto-executed.
                    </p>
                  </div>
                  <div className="role-grid">
                    {ROLES.map((role) => (
                      <fieldset className="role-card" key={role}>
                        <legend>{ROLE_LABELS[role]}</legend>
                        {role === 'implementer' && config.roles.implementer.provider === 'openai-api' ? (
                          <p className="muted" role="status">
                            OpenAI API cannot edit code, so Joy selected Claude Code for this role. Save to
                            update routing.
                          </p>
                        ) : null}
                        <label>
                          Provider
                          <select
                            aria-label={`${ROLE_LABELS[role]} provider`}
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
                          Model
                          <input
                            aria-label={`${ROLE_LABELS[role]} model`}
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
                          Effort
                          <select
                            aria-label={`${ROLE_LABELS[role]} effort`}
                            name={`${role}-effort`}
                            value={roleModel(config, role).effort ?? 'medium'}
                            onChange={(event) =>
                              updateRole(role, 'effort', event.target.value as ModelRef['effort'])
                            }
                          >
                            {EFFORTS.map((effort) => (
                              <option key={effort} value={effort}>
                                {effort}
                              </option>
                            ))}
                          </select>
                        </label>
                      </fieldset>
                    ))}
                  </div>
                  <div className="form-actions">
                    <button className="primary-button" type="submit">
                      Save settings
                    </button>
                  </div>
                </form>
              </section>

              <section className="settings-card secret-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">CREDENTIALS</p>
                    <h2>OpenAI API key</h2>
                  </div>
                  <span
                    className={secretStatus?.set ? 'status-pill configured' : 'status-pill'}
                    role="status"
                  >
                    {secretStatusLoading
                      ? 'Checking…'
                      : secretStatus === null
                        ? 'Unavailable'
                        : secretStatus.set
                          ? 'Configured'
                          : 'Not configured'}
                  </span>
                </div>
                <p className="muted secret-description">
                  {secretStatusLoading
                    ? 'Checking OpenAI key status…'
                    : secretStatus === null
                      ? 'OpenAI key status is unavailable. Key management is temporarily disabled.'
                      : 'Stored in the OS keychain. Joy never returns the key to the browser or writes it to config, events, or the database.'}
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
                    Retry key status
                  </button>
                ) : secretStatus.source === 'env' ? (
                  <div className="env-managed" role="status">
                    Managed by the OPENAI_API_KEY environment variable.
                  </div>
                ) : (
                  <form className="secret-form" onSubmit={saveOpenAiKey}>
                    <label htmlFor="openai-key">{secretStatus.set ? 'Replace key' : 'Enter key'}</label>
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
                        Save key
                      </button>
                    </div>
                    <div className="secret-actions">
                      <span className="muted">
                        {secretStatus.set
                          ? 'Saved securely in the OS keychain'
                          : 'Only the status is shown after saving'}
                      </span>
                      {secretStatus.source === 'keychain' && (
                        <button
                          className="text-button danger-text"
                          type="button"
                          onClick={() => void removeOpenAiKey()}
                        >
                          Remove key
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
            <div className="loading-card">Loading settings…</div>
          )}
        </main>
      ) : (
        <main className="workspace-grid">
          <aside className="task-sidebar">
            <div className="sidebar-heading">
              <div>
                <p className="eyebrow">YOUR WORK</p>
                <h1>Tasks</h1>
              </div>
              <button
                className="icon-button"
                aria-label="Create task"
                title="Create task"
                onClick={() => setShowTaskForm(true)}
              >
                ＋
              </button>
            </div>
            <button className="new-task-button" onClick={() => setShowTaskForm(true)}>
              <span>＋</span> New task
            </button>
            {repos.length === 0 ? (
              <div className="empty-repo">
                <div className="empty-icon">⌘</div>
                <h2>Add a repository</h2>
                <p>Connect a local project folder to start an isolated coding task.</p>
                <button className="outline-button" onClick={() => setShowRepoForm(true)}>
                  Add repository
                </button>
              </div>
            ) : (
              <div className="task-list" aria-label="Task list">
                <div className="list-label">RECENT</div>
                {tasks.length === 0 ? (
                  <p className="empty-list">Your tasks will appear here.</p>
                ) : (
                  tasks.map((task) => (
                    <button
                      className={selectedTaskId === task.id ? 'task-row selected' : 'task-row'}
                      key={task.id}
                      onClick={() => {
                        setSelectedTaskId(task.id)
                        setPage('tasks')
                      }}
                    >
                      <span className={`task-status status-${task.status}`} aria-hidden="true" />
                      <span className="task-row-copy">
                        <span className="task-title">{task.title}</span>
                        <span className="task-meta">
                          {task.status.replaceAll('_', ' ')} · {task.mode.replace('_', ' ')}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            <section className="doctor-panel" aria-labelledby="doctor-heading" data-testid="doctor-checks">
              <div className="doctor-panel-heading">
                <h2 id="doctor-heading">Environment checks</h2>
                <button
                  className="doctor-refresh"
                  aria-label="Refresh environment checks"
                  title="Refresh environment checks"
                  disabled={doctorLoading}
                  onClick={() => setDoctorRetry((retry) => retry + 1)}
                >
                  ↻
                </button>
              </div>
              {doctorLoading ? (
                <p className="doctor-message" role="status">
                  Checking Joy's setup…
                </p>
              ) : doctorReport ? (
                <ul className="doctor-check-list">
                  {doctorReport.checks.map((check) => (
                    <li className="doctor-check" key={check.id}>
                      <div className="doctor-check-heading">
                        <strong>{check.label}</strong>
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
                <div className="doctor-message" role="status">
                  <p>Setup checks are unavailable.</p>
                  <button className="footer-link" onClick={() => setDoctorRetry((retry) => retry + 1)}>
                    Retry checks
                  </button>
                </div>
              )}
            </section>
            <div className="sidebar-footer">
              <UsageStrip />
              <div className="local-badge">
                <span className="connection-dot" /> Joy is running locally
              </div>
              <button className="footer-link" onClick={() => setShowRepoForm(true)}>
                Manage repositories
              </button>
            </div>
          </aside>

          <section className="activity-panel" aria-label="Task activity">
            {details ? (
              <>
                <div className="activity-header">
                  <div className="breadcrumbs">
                    <span>{details.repo?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Repository'}</span>
                    <span className="breadcrumb-separator">/</span>
                    <span>Task</span>
                  </div>
                  <div className="task-heading-row">
                    <div>
                      <h1>{details.task.title}</h1>
                      <p className="task-prompt">{details.task.prompt}</p>
                    </div>
                    <span className={`large-status status-${details.task.status}`}>
                      {details.task.status.replaceAll('_', ' ')}
                    </span>
                  </div>
                  <div className="run-meta">
                    <span className="mode-tag">{details.task.mode.replace('_', ' ')}</span>
                    <span>{details.events.length} events</span>
                    <span>{details.repo?.defaultBranch ?? 'main'}</span>
                  </div>
                </div>
                <ApprovalsPanel
                  taskId={details.task.id}
                  taskStatus={details.task.status}
                  approvalEvents={details.events.filter((event) => event.type.startsWith('approval.')).length}
                />
                <div className="event-stream" aria-label="Live event stream" data-testid="event-stream">
                  {details.events.length === 0 ? (
                    <div className="stream-empty">
                      <span className="spinner" />
                      <p>Waiting for the first event…</p>
                    </div>
                  ) : (
                    details.events.map((event, index) => (
                      <article
                        className={`event-card event-${eventKind(event).replaceAll('_', '-')}`}
                        data-event-seq={event.seq}
                        key={`${event.seq}-${index}`}
                      >
                        <span className="event-marker" />
                        <div className="event-body">
                          <div className="event-topline">
                            <span className="event-kind">{eventKind(event).replaceAll('_', ' ')}</span>
                            <time>
                              {new Date(event.ts).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </time>
                          </div>
                          <p>{eventTitle(event)}</p>
                        </div>
                      </article>
                    ))
                  )}
                </div>
                <div className="activity-footer">
                  <span className="footer-orb" /> Live event replay is connected
                </div>
              </>
            ) : (
              <div className="welcome-panel">
                <div className="welcome-mark">J</div>
                <p className="eyebrow">LOCAL-FIRST AGENT WORKSPACE</p>
                <h1>What should Joy work on?</h1>
                <p>
                  Choose a repository and describe the change. Joy runs each task in an isolated worktree.
                </p>
                <button
                  className="primary-button"
                  onClick={() => (repos.length ? setShowTaskForm(true) : setShowRepoForm(true))}
                >
                  {repos.length ? 'Create a task' : 'Add a repository'}
                </button>
              </div>
            )}
          </section>

          <aside className="diff-panel" aria-label="Diff viewer">
            <div className="diff-header">
              <div>
                <p className="eyebrow">WORKTREE</p>
                <h2>Changes</h2>
              </div>
              <span className="diff-count">{diff?.files.length ?? 0}</span>
            </div>
            {details?.task.mode === 'compete' && details.task.status !== 'done' ? (
              <ComparePanel details={details} onChanged={() => void refreshSelectedTask()} />
            ) : null}
            {details ? <PublishPanel details={details} onChanged={() => void refreshSelectedTask()} /> : null}
            {details ? (
              <DiscardButton details={details} onChanged={() => void refreshSelectedTask()} />
            ) : null}
            {diff ? (
              <>
                <div className="diff-summary">
                  <span>
                    {diff.files.length} {diff.files.length === 1 ? 'file' : 'files'}
                  </span>
                  <span className="additions">
                    +{diff.files.reduce((total, file) => total + file.additions, 0)}
                  </span>
                  <span className="deletions">
                    −{diff.files.reduce((total, file) => total + file.deletions, 0)}
                  </span>
                </div>
                <div className="diff-file-list" aria-label="Changed files">
                  {diff.files.map((file) => (
                    <button
                      className={activeDiffFile === file.path ? 'diff-file active' : 'diff-file'}
                      key={file.path}
                      onClick={() => setActiveDiffFile(file.path)}
                    >
                      <span className="file-icon">
                        {file.status === 'added' ? '＋' : file.status === 'deleted' ? '−' : '·'}
                      </span>
                      <span>{file.path}</span>
                      <span className="file-stat">
                        +{file.additions} −{file.deletions}
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
                <div className="diff-empty-icon">⌁</div>
                <h3>No changes yet</h3>
                <p>The latest task diff will appear here when the agent finishes.</p>
              </div>
            )}
            <div className="diff-footer">Diff from the task result event</div>
          </aside>
        </main>
      )}

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
              <div>
                <p className="eyebrow">LOCAL PROJECT</p>
                <h2 id="repo-dialog-title">Add repository</h2>
              </div>
              <button className="close-button" aria-label="Close" onClick={() => setShowRepoForm(false)}>
                ×
              </button>
            </div>
            <p className="muted">Use the absolute path to a Git repository on the machine running Joy.</p>
            <form className="stacked-form" onSubmit={(event) => void createRepo(event)}>
              <label>
                Repository path
                <input
                  name="path"
                  aria-label="Repository path"
                  placeholder="/Users/you/project"
                  required
                  autoFocus
                />
              </label>
              <label>
                Default branch
                <input name="defaultBranch" aria-label="Default branch" defaultValue="main" required />
              </label>
              <label className="checkbox-row">
                <input type="checkbox" name="container" aria-label="Run agents in a container" />
                Untrusted code: run agents in a container (needs Docker; see README)
              </label>
              <div className="form-actions">
                <button className="quiet-button" type="button" onClick={() => setShowRepoForm(false)}>
                  Cancel
                </button>
                <button className="primary-button" type="submit">
                  Add repository
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {showTaskForm && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowTaskForm(false)
          }}
        >
          <section
            className="dialog-card task-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-dialog-title"
          >
            <div className="dialog-header">
              <div>
                <p className="eyebrow">NEW WORK</p>
                <h2 id="task-dialog-title">Create a task</h2>
              </div>
              <button className="close-button" aria-label="Close" onClick={() => setShowTaskForm(false)}>
                ×
              </button>
            </div>
            <form className="stacked-form" onSubmit={(event) => void createTask(event)}>
              <label>
                Repository
                <select name="repoId" aria-label="Task repository" required defaultValue="">
                  <option value="" disabled>
                    Select a repository
                  </option>
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.path}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Task title
                <input
                  name="title"
                  aria-label="Task title"
                  placeholder="What needs to change?"
                  required
                  maxLength={500}
                />
              </label>
              <label>
                Instructions
                <textarea
                  name="prompt"
                  aria-label="Task instructions"
                  placeholder="Describe the desired behavior and any constraints…"
                  required
                  rows={4}
                />
              </label>
              <label>
                Workflow
                <select name="mode" aria-label="Workflow">
                  <option value="review_loop">Implement + review</option>
                  <option value="single">Single agent</option>
                  <option value="compete">Compete (both models, judge compares)</option>
                  {customWorkflows.map((workflow) => (
                    <option key={workflow.name} value={`workflow:${workflow.name}`}>
                      {workflow.name}
                      {workflow.description ? ` — ${workflow.description}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="task-model-grid">
                {(['implementer', 'reviewer'] as const).map((role) => {
                  const model = roleModel(config, role)
                  return (
                    <fieldset className="task-role-card" key={role}>
                      <legend>{ROLE_LABELS[role]}</legend>
                      <label>
                        Provider
                        <select
                          aria-label={`${ROLE_LABELS[role]} provider`}
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
                        Model
                        <input
                          aria-label={`${ROLE_LABELS[role]} model`}
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
                        Effort
                        <select
                          aria-label={`${ROLE_LABELS[role]} effort`}
                          name={`${role}-effort`}
                          defaultValue={model.effort ?? 'medium'}
                        >
                          {EFFORTS.map((effort) => (
                            <option key={effort} value={effort}>
                              {effort}
                            </option>
                          ))}
                        </select>
                      </label>
                    </fieldset>
                  )
                })}
              </div>
              <div className="form-actions">
                <button className="quiet-button" type="button" onClick={() => setShowTaskForm(false)}>
                  Cancel
                </button>
                <button className="primary-button" type="submit">
                  Start task
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
