import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FormEvent } from 'react'
import { EFFORTS, PROVIDER_KINDS, ROLES } from '@joy/core'
import type { ModelRef, ProviderKind, Role, RoleConfig } from '@joy/core'
import type { JoyConfig } from '@joy/config'
import './styles.css'

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
type TaskEvent = { taskId: string; seq: number; eventId?: string; type: string; payload: unknown; ts: string }
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
  headers.set('authorization', `Bearer ${__JOY_API_TOKEN__}`)
  const response = await fetch(path, { ...init, headers })
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
  for (const event of [...events].reverse()) {
    if (event.type !== 'result') continue
    const diff = record(event.payload)?.diff
    if (record(diff) && Array.isArray((diff as WorkspaceDiff).files)) return diff as WorkspaceDiff
  }
  return null
}

function eventTitle(event: TaskEvent): string {
  const payload = record(event.payload)
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
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null)
  const [secretStatusLoading, setSecretStatusLoading] = useState(true)
  const [secretStatusRetry, setSecretStatusRetry] = useState(0)
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(true)
  const [doctorRetry, setDoctorRetry] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [details, setDetails] = useState<TaskDetails | null>(null)
  const [page, setPage] = useState<'tasks' | 'settings'>('tasks')
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [showRepoForm, setShowRepoForm] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeDiffFile, setActiveDiffFile] = useState('')

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
      const nextSocket = new WebSocket(socketUrl(), ['joy', `joy-auth.${__JOY_API_TOKEN__}`])
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
                  <option value="compete" disabled>
                    Compete — not available yet
                  </option>
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
createRoot(rootElement).render(<App />)
