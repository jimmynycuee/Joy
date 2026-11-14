import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ROLES } from '@joy/core'
import type { RoleConfig } from '@joy/core'
import type { JoyConfig } from '@joy/config'
import { ApiError, errorMessage, request } from './api.js'
import { CommandPalette } from './components/CommandPalette.js'
import { Mascot } from './components/Mascot.js'
import type { PaletteItem } from './components/CommandPalette.js'
import { Sidebar } from './components/Sidebar.js'
import { Button, IconButton, Spinner } from './components/ui.js'
import { useTaskDetails } from './hooks/useTaskDetails.js'
import { roleModel } from './labels.js'
import { AssistantPage } from './pages/AssistantPage.js'
import { NewTaskPage } from './pages/NewTaskPage.js'
import type { NewTaskInput } from './pages/NewTaskPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import type { SettingsSection } from './pages/SettingsPage.js'
import { TaskPage } from './pages/TaskPage.js'
import { escapeLeavesSettings, isTypingTarget, shortcutFor } from './shortcuts.js'
import type { ShortcutAction } from './shortcuts.js'
import { clearLegacyArchivedIds, readLegacyArchivedIds, readStorage, writeStorage } from './storage.js'
import { diffFrom } from './task-info.js'
import { THEME_LABELS, nextTheme, readTheme, saveTheme } from './theme.js'
import type { ThemePreference } from './theme.js'
import type { ConversationSummary, DoctorReport, Repo, SecretStatus, Task, TaskDetails } from './types.js'

type Page = 'tasks' | 'assistant' | 'settings'

const SIDEBAR_COLLAPSED_KEY = 'joy.sidebarCollapsed'
const MOBILE_QUERY = '(max-width: 859px)'

/** Every task, archived ones included (each has `archived`): the sidebar lists the others, 設定 → 已封存 these. */
const TASKS_PATH = '/api/tasks?archived=1'

/**
 * Archiving used to live in this browser's localStorage. Moves those choices to the server once, then forgets the old
 * key. Tasks that are gone, running, or already archived are skipped; a failed PATCH is not worth stopping for.
 */
async function migrateLegacyArchive(tasks: readonly Task[]): Promise<boolean> {
  const ids = readLegacyArchivedIds()
  const todo = ids.filter((id) => tasks.some((task) => task.id === id && !task.archived))
  const results = await Promise.all(
    todo.map((id) =>
      request(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      })
        .then(() => true)
        .catch(() => false),
    ),
  )
  clearLegacyArchivedIds()
  return results.some(Boolean)
}

function isMobile(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches
}

export function Workspace() {
  const [repos, setRepos] = useState<Repo[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [config, setConfig] = useState<JoyConfig | null>(null)
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null)
  const [secretStatusLoading, setSecretStatusLoading] = useState(true)
  const [secretStatusRetry, setSecretStatusRetry] = useState(0)
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(true)
  const [doctorRetry, setDoctorRetry] = useState(0)
  // Custom workflows from config.yaml (T5.6); the built-in three are the fixed options of the task form.
  const [customWorkflows, setCustomWorkflows] = useState<Array<{ name: string; description?: string }>>([])
  // A notification opens `/?task=<id>`; start on that task.
  const [selectedTaskId, setSelectedTaskId] = useState(
    () => new URLSearchParams(window.location.search).get('task') ?? '',
  )
  const [page, setPage] = useState<Page>('tasks')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [showRepoForm, setShowRepoForm] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = useState('')
  // The page 設定 was opened from, so 返回 goes back there (null: nothing to go back to).
  const [pageBeforeSettings, setPageBeforeSettings] = useState<Exclude<Page, 'settings'> | null>(null)
  const [theme, setTheme] = useState<ThemePreference>(readTheme)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStorage(SIDEBAR_COLLAPSED_KEY) === '1')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // null = follow the diff (open when there is one); true/false = the owner chose.
  const [changesOpen, setChangesOpen] = useState<boolean | null>(null)

  const [details, setDetails] = useTaskDetails(selectedTaskId, setTasks, setError)

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

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent<{ type?: string; url?: string }>) => {
      if (event.data?.type !== 'joy-open' || !event.data.url) return
      const task = new URL(event.data.url, window.location.origin).searchParams.get('task')
      if (task) {
        setSelectedTaskId(task)
        setShowTaskForm(false)
        setPage('tasks')
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  const refreshLists = useCallback(async () => {
    const [repoResponse, taskResponse] = await Promise.all([
      request<{ repos: Repo[] }>('/api/repos'),
      request<{ tasks: Task[] }>(TASKS_PATH),
    ])
    setRepos(repoResponse.repos)
    setTasks(taskResponse.tasks)
  }, [])

  async function refreshSelectedTask() {
    if (!selectedTaskId) return
    const next = await request<TaskDetails>(`/api/tasks/${encodeURIComponent(selectedTaskId)}`)
    setDetails((current) => (current && current.task.id === next.task.id ? next : current))
    await refreshLists()
  }

  const loadConversations = useCallback(async () => {
    const body = await request<{ conversations?: ConversationSummary[] }>('/api/conversations')
    setConversations(Array.isArray(body.conversations) ? body.conversations : [])
  }, [])

  useEffect(() => {
    let active = true
    void Promise.all([
      request<{ repos: Repo[] }>('/api/repos'),
      request<{ tasks: Task[] }>(TASKS_PATH),
      request<{ config: JoyConfig }>('/api/config'),
    ])
      .then(([repoResponse, taskResponse, configResponse]) => {
        if (!active) return
        setRepos(repoResponse.repos)
        setTasks(taskResponse.tasks)
        setConfig(configResponse.config)
        void migrateLegacyArchive(taskResponse.tasks).then((changed) => {
          if (changed && active) void refreshLists().catch(() => undefined)
        })
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause, '連不到 Joy server'))
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    void loadConversations().catch(() => undefined)
    const timer = window.setInterval(() => void loadConversations().catch(() => undefined), 20_000)
    return () => window.clearInterval(timer)
  }, [loadConversations])

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

  // Notices fade by themselves; errors stay until dismissed or replaced.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // Each task starts with its changes pane following the diff.
  useEffect(() => {
    setChangesOpen(null)
  }, [selectedTaskId])

  const composing = page === 'tasks' && (showTaskForm || !selectedTaskId)
  const setupProblems = doctorReport?.checks.filter((check) => check.status === 'missing').length ?? 0
  const activeTasks = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  const diff = useMemo(() => diffFrom(details?.events ?? []), [details?.events])
  const changesVisible = changesOpen ?? Boolean(diff && diff.files.length > 0)

  function closeDrawer() {
    setDrawerOpen(false)
  }

  const openComposer = useCallback(() => {
    setPage('tasks')
    setShowTaskForm(true)
    setDrawerOpen(false)
  }, [])

  function openTask(id: string) {
    setSelectedTaskId(id)
    setShowTaskForm(false)
    setPage('tasks')
    closeDrawer()
  }

  function newConversation() {
    setConversationId('')
    setPage('assistant')
    closeDrawer()
  }

  function openConversation(id: string) {
    setConversationId(id)
    setPage('assistant')
    closeDrawer()
  }

  function openSettings(section?: SettingsSection) {
    if (section) setSettingsSection(section)
    if (page !== 'settings') setPageBeforeSettings(page)
    setPage('settings')
    closeDrawer()
  }

  /** 設定 → 返回: the task, conversation or composer that was open before; the composer when there was none. */
  function leaveSettings() {
    if (pageBeforeSettings === 'assistant') {
      setPage('assistant')
      return
    }
    if (pageBeforeSettings === null) setShowTaskForm(true)
    setPage('tasks')
  }

  function changeTheme(next: ThemePreference) {
    saveTheme(next)
    setTheme(next)
  }

  const toggleSidebar = useCallback(() => {
    if (isMobile()) {
      setDrawerOpen((open) => !open)
      return
    }
    setSidebarCollapsed((collapsed) => {
      writeStorage(SIDEBAR_COLLAPSED_KEY, collapsed ? null : '1')
      return !collapsed
    })
  }, [])

  // One listener for the whole app; the ref keeps it pointing at the latest state.
  const runShortcut = useRef<(action: ShortcutAction) => void>(() => undefined)
  runShortcut.current = (action) => {
    if (action === 'palette') setPaletteOpen((open) => !open)
    else if (action === 'new-task') openComposer()
    else if (action === 'toggle-sidebar') toggleSidebar()
    else if (page === 'tasks' && !composing && details) setChangesOpen(!changesVisible)
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const action = shortcutFor(event, isTypingTarget(event.target))
      if (!action) return
      event.preventDefault()
      runShortcut.current(action)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Esc leaves 設定, unless the owner is typing or a dialog, the palette or the drawer owns the key.
  const escapeSettings = useRef<(event: KeyboardEvent) => void>(() => undefined)
  escapeSettings.current = (event) => {
    const overlayOpen =
      paletteOpen ||
      showRepoForm ||
      drawerOpen ||
      document.querySelector('[role="dialog"], [role="menu"]') !== null
    if (
      !escapeLeavesSettings(event, {
        onSettings: page === 'settings',
        typing: isTypingTarget(event.target),
        overlayOpen,
      })
    )
      return
    event.preventDefault()
    leaveSettings()
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => escapeSettings.current(event)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

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
      setError(errorMessage(cause, '無法加入專案'))
    }
  }

  async function createTask(input: NewTaskInput): Promise<boolean> {
    setError('')
    try {
      const { task } = await request<{ task: Task }>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          repoId: input.repoId,
          title: input.title,
          prompt: input.prompt,
          // A custom workflow (T5.6) brings its own models and options; the built-in ones use the models chosen here.
          ...(input.mode.startsWith('workflow:')
            ? { workflow: input.mode.slice('workflow:'.length) }
            : {
                mode: input.mode,
                // Only the roles the owner picked; the rest follow Settings on the server.
                ...(input.roleOverrides ? { roleOverrides: input.roleOverrides } : {}),
                ...(input.planFirst ? { planFirst: true } : {}),
              }),
        }),
      })
      setShowTaskForm(false)
      setSelectedTaskId(task.id)
      await refreshLists()
      setNotice('任務已建立。')
      return true
    } catch (cause) {
      setError(errorMessage(cause, '無法建立任務'))
      return false
    }
  }

  /** Renames or (un)archives a task on the server, then mirrors the answer in the list and the open thread. */
  async function patchTask(id: string, patch: { title?: string; archived?: boolean }): Promise<boolean> {
    setError('')
    try {
      const { task } = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      setTasks((current) => current.map((item) => (item.id === id ? { ...item, ...task } : item)))
      setDetails((current) =>
        current && current.task.id === id ? { ...current, task: { ...current.task, ...task } } : current,
      )
      return true
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 409 && patch.archived
          ? '進行中的任務不能封存，請先停止它'
          : errorMessage(cause, patch.title !== undefined ? '無法重新命名' : '無法更新任務'),
      )
      return false
    }
  }

  async function archiveTask(id: string) {
    const ok = await patchTask(id, { archived: true })
    if (ok && id === selectedTaskId && page === 'tasks') openComposer()
  }

  async function saveConfig() {
    if (!config) return
    // Save what the form shows, including a legacy OpenAI implementer already shown as Claude Code.
    const roles = { ...config.roles } as RoleConfig
    for (const role of ROLES) roles[role] = roleModel(config, role)
    setError('')
    try {
      const { config: saved } = await request<{ config: JoyConfig }>('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ ...config, roles }),
      })
      setConfig(saved)
      setNotice('設定已儲存。')
    } catch (cause) {
      setError(errorMessage(cause, '無法儲存設定'))
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
      setNotice('金鑰已儲存。')
    } catch (cause) {
      setError(errorMessage(cause, '無法儲存金鑰'))
    }
  }

  async function removeOpenAiKey() {
    setError('')
    try {
      setSecretStatus(await request<SecretStatus>('/api/secrets/openai-api-key', { method: 'DELETE' }))
      setNotice('已移除金鑰。')
    } catch (cause) {
      setError(errorMessage(cause, '無法移除金鑰'))
    }
  }

  const view = composing ? 'new-task' : page === 'tasks' ? 'task' : page
  const title =
    view === 'new-task'
      ? '新任務'
      : view === 'task'
        ? (details?.task.title ?? '任務')
        : view === 'assistant'
          ? '聊聊'
          : '設定'

  const paletteItems: PaletteItem[] = [
    { id: 'cmd:new-task', label: '新任務', hint: '指令', icon: 'plus', run: openComposer },
    { id: 'cmd:chat', label: '聊聊', hint: '指令', icon: 'chat', run: newConversation },
    { id: 'cmd:settings', label: '設定', hint: '指令', icon: 'settings', run: () => openSettings() },
    { id: 'cmd:stats', label: '設定：統計', hint: '指令', icon: 'chart', run: () => openSettings('stats') },
    {
      id: 'cmd:archived',
      label: '設定：已封存',
      hint: '指令',
      icon: 'archive',
      run: () => openSettings('archived'),
    },
    {
      id: 'cmd:theme',
      label: `切換主題（目前：${THEME_LABELS[theme]}）`,
      hint: '指令',
      icon: 'sun',
      run: () => changeTheme(nextTheme(theme)),
    },
    { id: 'cmd:sidebar', label: '收合或展開側邊欄', hint: '指令', icon: 'panel-left', run: toggleSidebar },
    { id: 'cmd:add-repo', label: '加入專案', hint: '指令', icon: 'folder', run: () => setShowRepoForm(true) },
    ...(details && page === 'tasks' && !composing
      ? [
          {
            id: 'cmd:changes',
            label: '顯示或隱藏變更面板',
            hint: '指令',
            icon: 'panel-right' as const,
            run: () => setChangesOpen(!changesVisible),
          },
        ]
      : []),
    ...activeTasks.map((task) => ({
      id: `task:${task.id}`,
      label: task.title,
      hint: '任務',
      icon: 'bolt' as const,
      run: () => openTask(task.id),
    })),
    ...conversations.map((conversation) => ({
      id: `conversation:${conversation.id}`,
      label: conversation.title ?? '新對話',
      hint: '對話',
      icon: 'chat' as const,
      run: () => openConversation(conversation.id),
    })),
  ]

  let content
  if (page === 'assistant') {
    content = (
      <AssistantPage
        conversationId={conversationId}
        onSelectConversation={setConversationId}
        onConversationsChanged={() => void loadConversations().catch(() => undefined)}
        onError={setError}
      />
    )
  } else if (page === 'settings') {
    content = (
      <SettingsPage
        section={settingsSection}
        onSection={setSettingsSection}
        config={config}
        setConfig={setConfig}
        onSaveConfig={saveConfig}
        secretStatus={secretStatus}
        secretStatusLoading={secretStatusLoading}
        onRetrySecret={() => {
          setSecretStatusLoading(true)
          setSecretStatusRetry((attempt) => attempt + 1)
        }}
        onSaveOpenAiKey={saveOpenAiKey}
        onRemoveOpenAiKey={removeOpenAiKey}
        doctorReport={doctorReport}
        doctorLoading={doctorLoading}
        onRetryDoctor={() => setDoctorRetry((retry) => retry + 1)}
        repos={repos}
        onAddRepo={() => setShowRepoForm(true)}
        onRepoSaved={(saved) =>
          // The reply is the whole repo, so a cleared field (null) must disappear instead of lingering.
          setRepos((current) => current.map((repo) => (repo.id === saved.id ? saved : repo)))
        }
        theme={theme}
        onTheme={changeTheme}
        tasks={tasks}
        onOpenTask={openTask}
        onRestoreTask={(id) => void patchTask(id, { archived: false })}
        onBack={leaveSettings}
      />
    )
  } else if (!composing && !details) {
    content = (
      <main className="home-page" aria-busy="true">
        <div className="running-indicator" role="status">
          <Spinner />
          正在載入任務…
        </div>
      </main>
    )
  } else if (composing || !details) {
    content = (
      <NewTaskPage
        repos={repos}
        hasAnyTask={tasks.length > 0}
        config={config}
        customWorkflows={customWorkflows}
        setupProblems={setupProblems}
        onOpenSetup={() => openSettings('advanced')}
        onAddRepo={() => setShowRepoForm(true)}
        onCreate={createTask}
      />
    )
  } else {
    content = (
      <TaskPage
        key={details.task.id}
        details={details}
        repos={repos}
        changesOpen={changesOpen}
        onToggleChanges={setChangesOpen}
        onChanged={() => void refreshSelectedTask().catch(() => undefined)}
        onError={setError}
        onRename={(next) => patchTask(details.task.id, { title: next })}
      />
    )
  }

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${drawerOpen ? ' drawer-open' : ''}`}
    >
      <Sidebar
        repos={repos}
        tasks={tasks}
        conversations={conversations}
        view={view}
        selectedTaskId={selectedTaskId}
        selectedConversationId={conversationId}
        pendingPlanTaskId={details?.pendingPlan ? details.task.id : ''}
        onArchive={(id) => void archiveTask(id)}
        onNewTask={openComposer}
        onOpenTask={openTask}
        onNewConversation={newConversation}
        onOpenConversation={openConversation}
        onOpenSettings={() => openSettings()}
        onCollapse={toggleSidebar}
      />
      <div className="sidebar-scrim" onClick={closeDrawer} aria-hidden="true" />

      <div className="main-area">
        <div className="topbar">
          <IconButton icon="menu" label="開啟側邊欄" onClick={toggleSidebar} />
          <span className="topbar-title">{title}</span>
        </div>
        {error && (
          <div className="toast error-toast" role="alert">
            <Mascot mood="error" size={28} decorative />
            <span>{error}</span>
            <IconButton icon="x" label="關閉訊息" className="icon-btn-sm" onClick={() => setError('')} />
          </div>
        )}
        {notice && (
          <div className="toast notice-toast" role="status">
            {notice}
          </div>
        )}
        {content}
      </div>

      {showRepoForm && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowRepoForm(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setShowRepoForm(false)
          }}
        >
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="repo-dialog-title">
            <div className="dialog-header">
              <h2 id="repo-dialog-title">加入專案</h2>
              <IconButton icon="x" label="關閉" onClick={() => setShowRepoForm(false)} />
            </div>
            <form className="field-stack" onSubmit={(event) => void createRepo(event)}>
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
                在容器裡執行 agent（需要 Docker）
              </label>
              <div className="dialog-actions">
                <Button variant="ghost" onClick={() => setShowRepoForm(false)}>
                  取消
                </Button>
                <Button variant="primary" type="submit">
                  加入專案
                </Button>
              </div>
            </form>
          </section>
        </div>
      )}

      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
