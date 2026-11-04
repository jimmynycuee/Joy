import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FormEvent } from 'react'
import { EFFORTS, PROVIDER_KINDS, ROLES } from '@joy/core'
import type { ModelRef, ProviderKind, Role, RoleConfig, TaskMode } from '@joy/core'
import type { JoyConfig } from '@joy/config'
import './styles.css'

type Repo = { id: string; path: string; defaultBranch: string; githubRemote?: string }
type Task = {
  id: string
  repoId: string
  title: string
  prompt: string
  mode: string
  status: string
  roleOverrides?: Partial<RoleConfig>
  createdAt: string
}
type TaskEvent = { taskId: string; seq: number; type: string; payload: unknown; ts: string }
type DiffFile = { path: string; status: string; additions: number; deletions: number }
type WorkspaceDiff = { files: DiffFile[]; patch: string }
type Competitor = {
  attemptId: string
  model?: ModelRef
  status: string
  diff?: WorkspaceDiff
  reason?: string
  synthesized?: boolean
}
type CompeteJudgment = { winnerAttemptId: string; summary: string; rationale: string }
type CompeteView = {
  candidates: Competitor[]
  judgment: CompeteJudgment | null
  judgeFailure: string | null
  selectedAttemptId: string
  synthesisRunning: boolean
  synthesisSucceeded: boolean
  synthesisError: string | null
}
type TaskDetails = {
  task: Task
  repo: Repo | null
  attempts: unknown[]
  reviews: unknown[]
  events: TaskEvent[]
}
type SecretStatus = { set: boolean; source?: 'env' | 'keychain' }
type ApiError = { error?: string }
type ModelStatsSummary = {
  provider: ProviderKind
  model: string
  taskKind: TaskMode
  attemptCount: number
  successCount: number
  successRate: number
  totalReviewIssues: number
  averageReviewIssues: number
  averageDurationMs: number
}

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
const TASK_KIND_LABELS: Record<TaskMode, string> = {
  single: 'Single agent',
  review_loop: 'Implement + review',
  compete: 'Compete',
}
const MODEL_SUGGESTIONS: Record<ProviderKind, string[]> = {
  'openai-api': ['gpt-6-luna'],
  'claude-cli': ['opus', 'sonnet', 'haiku'],
  'codex-cli': ['gpt-6.1-sol', 'gpt-6-luna'],
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
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
  return {
    provider: model.provider,
    model: model.model,
    ...(model.effort ? { effort: model.effort } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function mergeEvents(first: TaskEvent[], second: TaskEvent[]): TaskEvent[] {
  const events = new Map<number, TaskEvent>()
  for (const event of [...first, ...second]) events.set(event.seq, event)
  return [...events.values()].sort((a, b) => a.seq - b.seq)
}

function diffFrom(events: TaskEvent[]): WorkspaceDiff | null {
  for (const event of [...events].reverse()) {
    if (event.type !== 'result') continue
    const diff = record(event.payload)?.diff
    if (record(diff) && Array.isArray((diff as WorkspaceDiff).files)) return diff as WorkspaceDiff
  }
  return null
}

function eventTitle(event: TaskEvent): string {
  const payload = record(event.payload)
  if (event.type === 'attempt') {
    const model = record(payload?.model)
    const identity = typeof model?.model === 'string' ? model.model : 'candidate'
    return `${identity}: ${String(payload?.status ?? 'updated')}`
  }
  if (event.type === 'judgment') {
    const judgment = record(payload?.judgment)
    return typeof judgment?.summary === 'string' ? `Judge: ${judgment.summary}` : 'Judge selected a candidate'
  }
  if (event.type === 'result' && typeof payload?.reason === 'string') {
    return `${String(payload.status ?? 'result')}: ${payload.reason}`
  }
  if (event.type === 'compete_run_started') return 'A new competition run started'
  if (event.type === 'winner_selected') return 'A candidate was selected as the winner'
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
  if (event.type !== 'agent') return event.type
  const payload = record(event.payload)
  const role = payload?.role
  return typeof role === 'string' ? role : 'agent'
}

function competeView(events: TaskEvent[]): CompeteView {
  const candidates = new Map<string, Competitor>()
  let judgment: CompeteJudgment | null = null
  let judgeFailure: string | null = null
  let selectedAttemptId = ''
  let synthesisRunning = false
  let synthesisSucceeded = false
  let synthesisError: string | null = null
  const addCandidate = (value: unknown) => {
    const candidate = record(value)
    if (typeof candidate?.attemptId !== 'string') return
    const existing = candidates.get(candidate.attemptId)
    const model = record(candidate.model)
    const diff = record(candidate.diff)
    candidates.set(candidate.attemptId, {
      attemptId: candidate.attemptId,
      ...(model && typeof model.provider === 'string' && typeof model.model === 'string'
        ? { model: model as unknown as ModelRef }
        : existing?.model
          ? { model: existing.model }
          : {}),
      status: typeof candidate.status === 'string' ? candidate.status : (existing?.status ?? 'unknown'),
      ...(diff && Array.isArray(diff.files) && typeof diff.patch === 'string'
        ? { diff: diff as unknown as WorkspaceDiff }
        : existing?.diff
          ? { diff: existing.diff }
          : {}),
      ...(typeof candidate.reason === 'string' ? { reason: candidate.reason } : {}),
      ...(candidate.synthesized === true || existing?.synthesized ? { synthesized: true } : {}),
    })
  }
  for (const event of events) {
    const payload = record(event.payload)
    if (event.type === 'compete_run_started') {
      candidates.clear()
      judgment = null
      judgeFailure = null
      selectedAttemptId = ''
      synthesisRunning = false
      synthesisSucceeded = false
      synthesisError = null
    }
    if (event.type === 'synthesis_started') {
      synthesisRunning = true
      synthesisSucceeded = false
      synthesisError = null
    }
    if (event.type === 'attempt') addCandidate(payload)
    if (event.type === 'result') {
      if (Array.isArray(payload?.candidates)) payload.candidates.forEach(addCandidate)
      const hasSuccessfulCandidate = [...candidates.values()].some(
        (candidate) => candidate.status === 'succeeded' && candidate.diff !== undefined,
      )
      judgeFailure =
        payload?.status === 'failed' && hasSuccessfulCandidate && typeof payload.reason === 'string'
          ? payload.reason
          : null
      const value = record(payload?.judgment)
      if (
        typeof value?.winnerAttemptId === 'string' &&
        typeof value.summary === 'string' &&
        typeof value.rationale === 'string'
      ) {
        judgment = {
          winnerAttemptId: value.winnerAttemptId,
          summary: value.summary,
          rationale: value.rationale,
        }
        judgeFailure = null
      }
    }
    if (event.type === 'judgment') {
      const value = record(payload?.judgment)
      if (
        typeof value?.winnerAttemptId === 'string' &&
        typeof value.summary === 'string' &&
        typeof value.rationale === 'string'
      ) {
        judgment = {
          winnerAttemptId: value.winnerAttemptId,
          summary: value.summary,
          rationale: value.rationale,
        }
        judgeFailure = null
      }
    }
    if (event.type === 'synthesis_result') {
      synthesisRunning = false
      synthesisSucceeded = payload?.status === 'succeeded'
      synthesisError =
        payload?.status === 'succeeded'
          ? null
          : typeof payload?.reason === 'string'
            ? payload.reason
            : 'Synthesis did not produce a candidate.'
    }
    if (event.type === 'synthesis_error') {
      synthesisRunning = false
      synthesisError = typeof payload?.message === 'string' ? payload.message : 'Synthesis failed.'
    }
    if (event.type === 'winner_selected' && typeof payload?.attemptId === 'string') {
      selectedAttemptId = payload.attemptId
    }
  }
  return {
    candidates: [...candidates.values()],
    judgment,
    judgeFailure,
    selectedAttemptId,
    synthesisRunning,
    synthesisSucceeded,
    synthesisError,
  }
}

function modelIdentity(model?: ModelRef): string {
  if (!model) return 'Candidate model unavailable'
  return `${PROVIDER_LABELS[model.provider]} · ${model.model}`
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
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

function App() {
  const [repos, setRepos] = useState<Repo[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [config, setConfig] = useState<JoyConfig | null>(null)
  const [secretStatus, setSecretStatus] = useState<SecretStatus>({ set: false })
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [details, setDetails] = useState<TaskDetails | null>(null)
  const [page, setPage] = useState<'tasks' | 'stats' | 'settings'>('tasks')
  const [modelStats, setModelStats] = useState<ModelStatsSummary[]>([])
  const [statsLoading, setStatsLoading] = useState(false)
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [showRepoForm, setShowRepoForm] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeDiffFile, setActiveDiffFile] = useState('')
  const [selectingWinner, setSelectingWinner] = useState('')

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
      request<SecretStatus>('/api/secrets/openai-api-key'),
    ])
      .then(([repoResponse, taskResponse, configResponse, status]) => {
        if (!active) return
        setRepos(repoResponse.repos)
        setTasks(taskResponse.tasks)
        setConfig(configResponse.config)
        setSecretStatus(status)
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
    if (page !== 'stats') return
    let active = true
    setStatsLoading(true)
    void request<{ stats: ModelStatsSummary[] }>('/api/model-stats')
      .then(({ stats }) => {
        if (active) setModelStats(stats)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load model statistics')
      })
      .finally(() => {
        if (active) setStatsLoading(false)
      })
    return () => {
      active = false
    }
  }, [page])

  useEffect(() => {
    if (!selectedTaskId) {
      setDetails(null)
      return
    }
    let active = true
    setDetails(null)
    const socketProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(
      `${socketProtocol}//${window.location.host}/ws?taskId=${encodeURIComponent(selectedTaskId)}`,
    )
    socket.onmessage = (message) => {
      const decoded = record(JSON.parse(String(message.data)))
      if (decoded?.type !== 'event') return
      const event = record(decoded.event) as unknown as TaskEvent | null
      if (!event || typeof event.seq !== 'number') return
      setDetails((current) => {
        if (!current || current.task.id !== selectedTaskId) return current
        const payload = record(event.payload)
        const hasSelectableCandidate =
          event.type === 'result' &&
          Array.isArray(payload?.candidates) &&
          payload.candidates.some((value) => {
            const candidate = record(value)
            const diff = record(candidate?.diff)
            return (
              candidate?.status === 'succeeded' &&
              Array.isArray(diff?.files) &&
              typeof diff.patch === 'string'
            )
          })
        const resultStatus =
          event.type === 'error'
            ? 'failed'
            : event.type === 'winner_selected'
              ? 'done'
              : event.type === 'result'
                ? payload?.status === 'succeeded'
                  ? current.task.mode === 'compete' || payload.approved === false
                    ? 'review_ready'
                    : 'done'
                  : current.task.mode === 'compete' && hasSelectableCandidate
                    ? 'review_ready'
                    : payload?.status
                : undefined
        const status = typeof resultStatus === 'string' ? resultStatus : current.task.status
        return {
          ...current,
          task: { ...current.task, status },
          events: mergeEvents(current.events, [event]),
        }
      })
      if (event.type === 'result' || event.type === 'error' || event.type === 'winner_selected') {
        void request<{ tasks: Task[] }>('/api/tasks')
          .then(({ tasks: updated }) => setTasks(updated))
          .catch(() => {})
      }
    }
    void request<TaskDetails>(`/api/tasks/${encodeURIComponent(selectedTaskId)}`)
      .then((next) => {
        if (!active) return
        setDetails((current) =>
          current?.task.id === selectedTaskId
            ? { ...next, events: mergeEvents(next.events, current.events) }
            : next,
        )
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load task')
      })
    return () => {
      active = false
      socket.close()
    }
  }, [selectedTaskId])

  const diff = useMemo(() => diffFrom(details?.events ?? []), [details?.events])
  const diffChunks = useMemo(() => splitDiff(diff?.patch ?? ''), [diff?.patch])
  const selectedPatch = diffChunks.get(activeDiffFile) ?? diffChunks.values().next().value ?? ''
  const compete = useMemo(() => competeView(details?.events ?? []), [details?.events])
  const displayedCandidates = [...compete.candidates].sort(
    (first, second) => Number(Boolean(second.synthesized)) - Number(Boolean(first.synthesized)),
  )

  async function selectWinner(attemptId: string) {
    if (!details || !attemptId) return
    setSelectingWinner(attemptId)
    setError('')
    try {
      await request(`/api/tasks/${encodeURIComponent(details.task.id)}/select`, {
        method: 'POST',
        body: JSON.stringify({ attemptId }),
      })
      const next = await request<TaskDetails>(`/api/tasks/${encodeURIComponent(details.task.id)}`)
      setDetails((current) =>
        current?.task.id === details.task.id
          ? { ...next, events: mergeEvents(next.events, current.events) }
          : next,
      )
      await refreshLists()
      setNotice('Winner selected and saved for this task.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not select winner')
    } finally {
      setSelectingWinner('')
    }
  }

  async function synthesizeCandidate() {
    if (!details) return
    setError('')
    try {
      await request(`/api/tasks/${encodeURIComponent(details.task.id)}/synthesize`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const next = await request<TaskDetails>(`/api/tasks/${encodeURIComponent(details.task.id)}`)
      setDetails((current) =>
        current?.task.id === details.task.id
          ? { ...next, events: mergeEvents(next.events, current.events) }
          : current,
      )
      await refreshLists()
      setNotice('Synthesis started in a new isolated worktree.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not synthesize candidate strengths')
    }
  }

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
          mode: String(form.get('mode')),
          roleOverrides: { implementer: model('implementer'), reviewer: model('reviewer') },
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
      setNotice('Role and model settings saved.')
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
            className={page === 'stats' ? 'nav-button active' : 'nav-button'}
            aria-current={page === 'stats' ? 'page' : undefined}
            onClick={() => setPage('stats')}
          >
            Performance
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

      {page === 'settings' ? (
        <main className="settings-page">
          <div className="page-heading">
            <div>
              <p className="eyebrow">PREFERENCES</p>
              <h1>Settings</h1>
              <p className="subheading">Choose a provider and model for each Joy role.</p>
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
                      <h2>Roles</h2>
                    </div>
                    <span className="muted">Changes apply to new tasks</span>
                  </div>
                  <div className="role-grid">
                    {ROLES.map((role) => (
                      <fieldset className="role-card" key={role}>
                        <legend>{ROLE_LABELS[role]}</legend>
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
                            {PROVIDER_KINDS.map((provider) => (
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
                      Save role settings
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
                  <span className={secretStatus.set ? 'status-pill configured' : 'status-pill'}>
                    {secretStatus.set ? 'Configured' : 'Not configured'}
                  </span>
                </div>
                <p className="muted secret-description">
                  Stored in the OS keychain. Joy never returns the key to the browser or writes it to config,
                  events, or the database.
                </p>
                {secretStatus.source === 'env' ? (
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
            </div>
          ) : (
            <div className="loading-card">Loading settings…</div>
          )}
        </main>
      ) : page === 'stats' ? (
        <main className="settings-page model-stats-page" aria-label="Model performance statistics">
          <div className="page-heading">
            <div>
              <p className="eyebrow">PERFORMANCE</p>
              <h1>Model performance</h1>
              <p className="subheading">Success, review findings, and elapsed time by model and task kind.</p>
            </div>
            <button className="quiet-button" onClick={() => setPage('tasks')}>
              Back to workspace
            </button>
          </div>
          <section className="settings-card stats-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">COMPLETED ATTEMPTS</p>
                <h2>Provider and model breakdown</h2>
              </div>
              <span className="muted">Cancelled attempts are excluded</span>
            </div>
            {statsLoading ? (
              <p className="muted" role="status">
                Loading model statistics…
              </p>
            ) : modelStats.length ? (
              <div className="model-stats-table-wrap">
                <table className="model-stats-table" data-testid="model-stats-table">
                  <thead>
                    <tr>
                      <th scope="col">Task kind</th>
                      <th scope="col">Provider / model</th>
                      <th scope="col">Runs</th>
                      <th scope="col">Success rate</th>
                      <th scope="col">Review issues</th>
                      <th scope="col">Avg elapsed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelStats.map((stat) => (
                      <tr
                        key={`${stat.taskKind}:${stat.provider}:${stat.model}`}
                        data-testid="model-stat-row"
                      >
                        <td>{TASK_KIND_LABELS[stat.taskKind]}</td>
                        <td className="stats-model-cell">
                          <strong>{PROVIDER_LABELS[stat.provider]}</strong>
                          <span>{stat.model}</span>
                        </td>
                        <td>{stat.attemptCount}</td>
                        <td>
                          <strong>{Math.round(stat.successRate * 100)}%</strong>
                          <span>
                            {stat.successCount} / {stat.attemptCount} successful
                          </span>
                        </td>
                        <td>
                          <strong>{stat.averageReviewIssues.toFixed(1)} avg</strong>
                          <span>{stat.totalReviewIssues} total</span>
                        </td>
                        <td>{formatDuration(stat.averageDurationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-stats" data-testid="model-stats-empty">
                <h2>No completed attempts yet</h2>
                <p>
                  Performance summaries appear after tasks finish. Failed attempts count toward success rate;
                  cancellations do not.
                </p>
              </div>
            )}
            <p className="stats-footnote">
              Review issues are findings saved by the review loop. Success means the model attempt completed
              without an execution error.
            </p>
          </section>
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
            <div className="sidebar-footer">
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

          <aside
            className="diff-panel"
            aria-label={details?.task.mode === 'compete' ? 'Candidate comparison' : 'Diff viewer'}
          >
            <div className="diff-header">
              <div>
                <p className="eyebrow">{details?.task.mode === 'compete' ? 'COMPETE REVIEW' : 'WORKTREE'}</p>
                <h2>{details?.task.mode === 'compete' ? 'Candidate comparison' : 'Changes'}</h2>
              </div>
              <span className="diff-count">
                {details?.task.mode === 'compete' ? compete.candidates.length : (diff?.files.length ?? 0)}
              </span>
            </div>
            {details?.task.mode === 'compete' ? (
              <div className="compete-review" data-testid="compete-review">
                <section className="judge-card" aria-label="Judge decision">
                  <p className="eyebrow">JUDGE</p>
                  {compete.judgment ? (
                    <>
                      <h3 data-testid="compete-judge-summary">{compete.judgment.summary}</h3>
                      <p data-testid="compete-judge-rationale">{compete.judgment.rationale}</p>
                    </>
                  ) : compete.judgeFailure ? (
                    <p className="muted" data-testid="compete-judge-error">
                      The judge could not compare successful candidate diffs: {compete.judgeFailure}
                    </p>
                  ) : (
                    <p className="muted">The judge will compare successful candidate diffs.</p>
                  )}
                </section>
                {details?.task.status === 'review_ready' &&
                compete.candidates.filter(
                  (candidate) => !candidate.synthesized && candidate.status === 'succeeded' && candidate.diff,
                ).length >= 2 &&
                !compete.synthesisSucceeded ? (
                  <section className="synthesis-controls" aria-label="Synthesize candidate strengths">
                    <button
                      className="primary-button"
                      type="button"
                      data-testid="synthesize-strengths"
                      disabled={compete.synthesisRunning || Boolean(selectingWinner)}
                      onClick={() => void synthesizeCandidate()}
                    >
                      {compete.synthesisRunning
                        ? 'Synthesizing strengths…'
                        : compete.synthesisError
                          ? 'Retry synthesis'
                          : 'Synthesize strengths'}
                    </button>
                    {compete.synthesisRunning ? (
                      <p role="status">The judge model is combining candidate changes in a fresh worktree.</p>
                    ) : null}
                    {compete.synthesisError ? (
                      <p className="synthesis-error" role="alert" data-testid="synthesis-error">
                        Synthesis failed: {compete.synthesisError}
                      </p>
                    ) : null}
                  </section>
                ) : null}
                {compete.synthesisSucceeded ? (
                  <p className="synthesis-success" data-testid="synthesis-success">
                    The synthesized candidate is ready to review and select.
                  </p>
                ) : null}
                <div className="candidate-grid" aria-label="Candidate diffs">
                  {compete.candidates.length ? (
                    displayedCandidates.map((candidate) => (
                      <article className="candidate-card" key={candidate.attemptId}>
                        <header className="candidate-heading">
                          <div>
                            <p className="eyebrow">
                              {candidate.synthesized
                                ? 'SYNTHESIZED CANDIDATE'
                                : `CANDIDATE ${compete.candidates.filter((item) => !item.synthesized).indexOf(candidate) + 1}`}
                            </p>
                            <h3>{modelIdentity(candidate.model)}</h3>
                          </div>
                          <span className={`candidate-status status-${candidate.status}`}>
                            {candidate.status.replaceAll('_', ' ')}
                          </span>
                        </header>
                        {candidate.diff ? (
                          <>
                            <div className="candidate-files">
                              {candidate.diff.files.map((file) => (
                                <span className="candidate-file" key={file.path}>
                                  {file.path}{' '}
                                  <span>
                                    +{file.additions} −{file.deletions}
                                  </span>
                                </span>
                              ))}
                            </div>
                            <pre className="candidate-diff" data-testid="candidate-diff">
                              {candidate.diff.patch.split('\n').map((line, lineIndex) => (
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
                                  key={`${lineIndex}-${line}`}
                                >
                                  {line || ' '}
                                </span>
                              ))}
                            </pre>
                          </>
                        ) : (
                          <p className="candidate-empty">
                            {candidate.reason ?? 'Waiting for this candidate to produce a diff.'}
                          </p>
                        )}
                        {compete.selectedAttemptId === candidate.attemptId ? (
                          <span className="winner-badge" data-testid="selected-winner">
                            Selected winner
                          </span>
                        ) : details?.task.status === 'review_ready' &&
                          candidate.status === 'succeeded' &&
                          candidate.diff ? (
                          <button
                            className="primary-button select-winner-button"
                            type="button"
                            disabled={
                              Boolean(selectingWinner) ||
                              Boolean(compete.selectedAttemptId) ||
                              compete.synthesisRunning
                            }
                            onClick={() => void selectWinner(candidate.attemptId)}
                          >
                            {selectingWinner === candidate.attemptId ? 'Saving winner…' : 'Select winner'}
                          </button>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <div className="diff-empty">
                      <div className="diff-empty-icon">⌁</div>
                      <h3>No candidates yet</h3>
                      <p>Candidate status and diffs will appear here as they finish.</p>
                    </div>
                  )}
                </div>
              </div>
            ) : diff ? (
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
            <div className="diff-footer">
              {details?.task.mode === 'compete'
                ? 'Only successful candidates can be selected'
                : 'Diff from the task result event'}
            </div>
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
                  <option value="compete">Compete — compare independent candidates</option>
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
                          {PROVIDER_KINDS.map((provider) => (
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
createRoot(rootElement).render(<App />)
