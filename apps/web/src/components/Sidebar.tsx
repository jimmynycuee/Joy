import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { request } from '../api.js'
import { relativeTime } from '../dates.js'
import { modeLabel, repoName, shortTitle, statusLabel } from '../labels.js'
import { NEW_CONVERSATION_TITLE, recentItems } from '../recent.js'
import type { RecentItem } from '../recent.js'
import { repoColor } from '../repo-colors.js'
import { modLabel } from '../shortcuts.js'
import {
  NO_FILTER,
  PROJECTS_SECTION,
  RECENT_SECTION,
  SIDEBAR_MEMORY_KEY,
  STATUS_FILTERS,
  applyFilter,
  isFiltering,
  parseSidebarMemory,
  pinnedRows,
  serializeSidebarMemory,
  tasksOfProject,
  toggleKey,
  unpinnedRows,
  waitsForYou,
} from '../sidebar-groups.js'
import type { RecentFilter, StatusFilter } from '../sidebar-groups.js'
import { readStorage, writeStorage } from '../storage.js'
import type { ConversationSummary, Repo, Task } from '../types.js'
import { MascotMark } from './Mascot.js'
import { Menu, MenuGroup, MenuItem } from './Menu.js'
import { Icon, IconButton, ProjectDot } from './ui.js'

interface QuotaReport {
  providers?: Record<string, { status: string; limitedNow?: boolean; resetsAt?: number }>
  openaiApi?: { monthSpentUsd: number; monthlyCapUsd: number }
}

/** The share of the monthly OpenAI API cap at which the sidebar starts to mention spending. */
export const USAGE_WARNING_RATIO = 0.8

/** Whether the quota report is worth the owner's attention: spend near the cap, or a provider out of quota. */
export function usageNeedsAttention(report: QuotaReport | null): boolean {
  if (!report) return false
  const api = report.openaiApi
  const nearCap =
    api !== undefined &&
    typeof api.monthSpentUsd === 'number' &&
    typeof api.monthlyCapUsd === 'number' &&
    api.monthlyCapUsd > 0 &&
    api.monthSpentUsd / api.monthlyCapUsd >= USAGE_WARNING_RATIO
  return nearCap || Object.values(report.providers ?? {}).some((state) => state.limitedNow)
}

/** Says something only when OpenAI API spend is at 80% of the cap or a provider is out of quota. Refreshes every 30 s. */
function UsageAlert() {
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
  if (!report || !usageNeedsAttention(report)) return null
  const api = report.openaiApi
  const nearCap =
    api !== undefined && api.monthlyCapUsd > 0 && api.monthSpentUsd / api.monthlyCapUsd >= USAGE_WARNING_RATIO
  const limited = Object.entries(report.providers ?? {}).filter(([, state]) => state.limitedNow)
  return (
    <div className="usage-alert" data-testid="usage-strip" role="status">
      <Icon name="alert" size={14} />
      <div>
        {nearCap && api ? (
          <p>
            本月 OpenAI API ${api.monthSpentUsd.toFixed(2)} / ${api.monthlyCapUsd.toFixed(2)}，快到上限了
          </p>
        ) : null}
        {limited.map(([provider, state]) => (
          <p key={provider}>
            {provider} 額度用完
            {state.resetsAt ? `，${new Date(state.resetsAt * 1000).toLocaleTimeString()} 恢復` : ''}
          </p>
        ))}
      </div>
    </div>
  )
}

export interface SidebarProps {
  repos: Repo[]
  tasks: Task[]
  conversations: ConversationSummary[]
  /** Which view is showing, so the matching row or button can be highlighted. */
  view: 'new-task' | 'task' | 'assistant' | 'settings'
  selectedTaskId: string
  selectedConversationId: string
  /** The task whose plan waits for approval, if the open one does: its row says so. */
  pendingPlanTaskId?: string
  onArchive: (id: string) => void
  onPinTask: (id: string, pinned: boolean) => void
  onPinConversation: (id: string, pinned: boolean) => void
  onNewTask: () => void
  onOpenTask: (id: string) => void
  onNewConversation: () => void
  onOpenConversation: (id: string) => void
  onAddProject: () => void
  /** 設定 of one project. */
  onOpenProjectSettings: (repoId: string) => void
  onOpenSettings: () => void
  onCollapse: () => void
}

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: '全部',
  waiting: '等你的',
  running: '進行中',
  done: '已完成',
  failed: '沒完成',
}

/** A section heading: the name and a chevron fold it; the tools on the right are the section's own. */
function SectionHead({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children?: ReactNode
}) {
  return (
    <div className="section-head">
      <button type="button" className="section-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="group-label">{label}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {children ? <div className="section-tools">{children}</div> : null}
    </div>
  )
}

export function Sidebar(props: SidebarProps) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const [filter, setFilter] = useState<RecentFilter>(NO_FILTER)

  // Tasks and conversations together, the most recently active first. Archived tasks live in 設定.
  const items = useMemo(
    () => recentItems(props.tasks, props.conversations, query),
    [props.tasks, props.conversations, query],
  )
  const nothingYet = props.tasks.every((task) => task.archived) && props.conversations.length === 0
  const pinned = useMemo(() => pinnedRows(items), [items])
  // A project that was removed cannot filter anything any more.
  const activeFilter = useMemo<RecentFilter>(
    () =>
      filter.repoId !== null && !props.repos.some((repo) => repo.id === filter.repoId)
        ? { ...filter, repoId: null }
        : filter,
    [filter, props.repos],
  )
  const recent = useMemo(() => applyFilter(unpinnedRows(items), activeFilter), [items, activeFilter])

  const [memory, setMemory] = useState(() => parseSidebarMemory(readStorage(SIDEBAR_MEMORY_KEY)))
  function remember(next: typeof memory) {
    setMemory(next)
    writeStorage(SIDEBAR_MEMORY_KEY, serializeSidebarMemory(next))
  }
  const toggleSection = (key: string) => remember({ ...memory, collapsed: toggleKey(memory.collapsed, key) })
  const toggleProject = (id: string) => remember({ ...memory, open: toggleKey(memory.open, id) })
  // A search shows every match, folded or not.
  const searching = query !== ''
  const projectsOpen = searching || !memory.collapsed.has(PROJECTS_SECTION)
  const recentOpen = searching || !memory.collapsed.has(RECENT_SECTION)

  function rowMenu(label: string, pinnedNow: boolean, onPin: () => void, onArchive?: () => void) {
    return (
      <Menu
        label={`更多：${label}`}
        triggerLabel={`更多：${label}`}
        triggerClassName="icon-btn row-action"
        trigger={<Icon name="more" size={16} />}
        align="end"
      >
        <MenuItem icon="pin" onSelect={onPin}>
          {pinnedNow ? '取消釘選' : '釘選'}
        </MenuItem>
        {onArchive ? (
          <MenuItem icon="archive" onSelect={onArchive}>
            封存
          </MenuItem>
        ) : null}
      </Menu>
    )
  }

  function taskRow(task: Task, time: string | undefined, nested = false, scope = '') {
    const selected = props.view === 'task' && props.selectedTaskId === task.id
    const waiting = waitsForYou(task)
    const working = task.status === 'running' || task.status === 'queued'
    const label = statusLabel(task.status, task.mode, props.pendingPlanTaskId === task.id)
    const title = shortTitle(task.title)
    return (
      <div
        className={`nav-row-wrap${selected ? ' selected' : ''}${nested ? ' nested' : ''}`}
        key={`${scope}task:${task.id}`}
      >
        <button
          type="button"
          className="task-row"
          aria-current={selected ? 'page' : undefined}
          title={`${label} · ${modeLabel(task.mode)}`}
          onClick={() => props.onOpenTask(task.id)}
        >
          {nested ? null : (
            <span className="row-lead">
              <ProjectDot color={repoColor(task.repoId, props.repos)} />
            </span>
          )}
          <span className="task-row-copy">
            <span className="task-title">{title}</span>
            {waiting ? <span className={`task-meta status-text-${task.status}`}>{label}</span> : null}
          </span>
          {working ? (
            <span className="task-flag" role="img" aria-label={label} />
          ) : waiting ? (
            <span className="task-flag" aria-hidden="true" />
          ) : task.status === 'failed' ? (
            <span className="task-flag task-flag-failed" aria-hidden="true" />
          ) : null}
          <span className="task-time">{relativeTime(time)}</span>
        </button>
        {rowMenu(
          title,
          task.pinnedAt !== undefined,
          () => props.onPinTask(task.id, task.pinnedAt === undefined),
          () => props.onArchive(task.id),
        )}
      </div>
    )
  }

  function conversationRow(conversation: ConversationSummary, time: string | undefined, scope = '') {
    const selected = props.view === 'assistant' && props.selectedConversationId === conversation.id
    const title = conversation.title ?? NEW_CONVERSATION_TITLE
    return (
      <div
        className={`nav-row-wrap${selected ? ' selected' : ''}`}
        key={`${scope}conversation:${conversation.id}`}
      >
        <button
          type="button"
          className="task-row"
          aria-current={selected ? 'page' : undefined}
          title="對話"
          onClick={() => props.onOpenConversation(conversation.id)}
        >
          <span className="row-lead row-lead-chat">
            <Icon name="chat" size={14} />
          </span>
          <span className="task-row-copy">
            <span className="task-title">{title}</span>
          </span>
          <span className="task-time">{relativeTime(time)}</span>
        </button>
        {rowMenu(title, conversation.pinnedAt !== undefined, () =>
          props.onPinConversation(conversation.id, conversation.pinnedAt === undefined),
        )}
      </div>
    )
  }

  function itemRow(item: RecentItem, scope = '') {
    return item.kind === 'task'
      ? taskRow(item.task, item.time, false, scope)
      : conversationRow(item.conversation, item.time, scope)
  }

  function projectBlock(repo: Repo) {
    const tasks = tasksOfProject(items, repo.id)
    // While searching, a project without a match has nothing to show.
    if (searching && tasks.length === 0) return null
    const open = searching || memory.open.has(repo.id)
    const needsYou = !open && tasks.some((item) => waitsForYou(item.task))
    const name = repoName(repo.path)
    return (
      <div className="project-block" key={repo.id} role="group" aria-label={name}>
        <div className="nav-row-wrap project-row-wrap">
          <button
            type="button"
            className="task-row project-row"
            aria-expanded={open}
            title={repo.path}
            onClick={() => toggleProject(repo.id)}
          >
            <span className="row-lead">
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
            </span>
            <ProjectDot color={repoColor(repo.id, props.repos)} />
            <span className="task-row-copy">
              <span className="task-title">{name}</span>
            </span>
            {needsYou ? <span className="task-flag" role="img" aria-label="有任務在等你" /> : null}
          </button>
          <Menu
            label={`更多：${name}`}
            triggerLabel={`更多：${name}`}
            triggerClassName="icon-btn row-action"
            trigger={<Icon name="more" size={16} />}
            align="end"
          >
            <MenuItem icon="settings" onSelect={() => props.onOpenProjectSettings(repo.id)}>
              設定
            </MenuItem>
          </Menu>
        </div>
        {open ? (
          tasks.length > 0 ? (
            tasks.map((item) => taskRow(item.task, item.time, true, 'project:'))
          ) : (
            <p className="empty-list nested">沒有任務</p>
          )
        ) : null}
      </div>
    )
  }

  // 新任務 / 聊聊 are lit only while that very page is open: the composer, or a conversation that has no messages yet.
  const onNewTask = props.view === 'new-task'
  const onNewChat = props.view === 'assistant' && props.selectedConversationId === ''
  const filtering = isFiltering(activeFilter)
  const visibleProjects = props.repos.filter(
    (repo) => !searching || tasksOfProject(items, repo.id).length > 0,
  )

  return (
    <nav className="sidebar" aria-label="主選單">
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <MascotMark size={26} />
          <span>Joy</span>
        </div>
        <IconButton
          icon="panel-left"
          label="收合側邊欄"
          className="sidebar-collapse"
          onClick={props.onCollapse}
        />
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className={`sidebar-action${onNewTask ? ' active' : ''}`}
          aria-current={onNewTask ? 'page' : undefined}
          onClick={props.onNewTask}
        >
          <Icon name="pencil" />
          新任務
        </button>
        <button
          type="button"
          className={`sidebar-action${onNewChat ? ' active' : ''}`}
          aria-current={onNewChat ? 'page' : undefined}
          onClick={props.onNewConversation}
        >
          <Icon name="chat" />
          聊聊
        </button>
      </div>

      <div className="search-field sidebar-search">
        <Icon name="search" size={14} />
        <input
          type="search"
          aria-label="搜尋任務與對話"
          placeholder="搜尋"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search ? null : <kbd>{modLabel()}K</kbd>}
      </div>

      <div className="sidebar-scroll">
        {pinned.length > 0 ? (
          <section className="sidebar-section" aria-label="已釘選">
            <div className="section-head">
              <span className="group-label section-label">已釘選</span>
            </div>
            <div className="task-list">{pinned.map((item) => itemRow(item, 'pinned:'))}</div>
          </section>
        ) : null}

        {visibleProjects.length > 0 || !searching ? (
          <section className="sidebar-section" aria-label="專案">
            <SectionHead label="專案" open={projectsOpen} onToggle={() => toggleSection(PROJECTS_SECTION)}>
              <IconButton icon="plus" label="加入專案" className="icon-btn-sm" onClick={props.onAddProject} />
            </SectionHead>
            {projectsOpen ? (
              <div className="task-list">
                {props.repos.length === 0 ? (
                  <p className="empty-list">還沒有專案</p>
                ) : (
                  visibleProjects.map(projectBlock)
                )}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="sidebar-section" aria-label="最近項目">
          <SectionHead label="最近項目" open={recentOpen} onToggle={() => toggleSection(RECENT_SECTION)}>
            <Menu
              label="篩選"
              triggerLabel="篩選"
              triggerClassName={`icon-btn icon-btn-sm${filtering ? ' filter-on' : ''}`}
              trigger={<Icon name="filter" size={14} />}
              align="end"
            >
              <MenuGroup label="狀態">
                {STATUS_FILTERS.map((status) => (
                  <MenuItem
                    key={status}
                    role="menuitemradio"
                    keepOpen
                    checked={activeFilter.status === status}
                    onSelect={() => setFilter({ ...activeFilter, status })}
                  >
                    {STATUS_FILTER_LABELS[status]}
                  </MenuItem>
                ))}
              </MenuGroup>
              {props.repos.length > 0 ? (
                <MenuGroup label="專案">
                  <MenuItem
                    role="menuitemradio"
                    keepOpen
                    checked={activeFilter.repoId === null}
                    onSelect={() => setFilter({ ...activeFilter, repoId: null })}
                  >
                    全部
                  </MenuItem>
                  {props.repos.map((repo) => (
                    <MenuItem
                      key={repo.id}
                      role="menuitemradio"
                      keepOpen
                      checked={activeFilter.repoId === repo.id}
                      onSelect={() => setFilter({ ...activeFilter, repoId: repo.id })}
                    >
                      {repoName(repo.path)}
                    </MenuItem>
                  ))}
                </MenuGroup>
              ) : null}
            </Menu>
            <IconButton icon="pencil" label="新對話" className="icon-btn-sm" onClick={props.onNewTask} />
          </SectionHead>
          {recentOpen ? (
            <div className="task-list">
              {nothingYet ? (
                <p className="empty-list">還沒有任何工作</p>
              ) : recent.length === 0 ? (
                // Everything may simply be pinned, or its matches may be listed above: then there is nothing to say.
                filtering || (searching && pinned.length === 0 && visibleProjects.length === 0) ? (
                  <p className="empty-list">沒有符合的項目</p>
                ) : null
              ) : (
                recent.map((item) => itemRow(item, 'recent:'))
              )}
            </div>
          ) : null}
        </section>
      </div>

      <div className="sidebar-footer">
        <UsageAlert />
        <button
          type="button"
          className={`nav-item${props.view === 'settings' ? ' active' : ''}`}
          aria-current={props.view === 'settings' ? 'page' : undefined}
          onClick={props.onOpenSettings}
        >
          <Icon name="settings" />
          設定
        </button>
      </div>
    </nav>
  )
}
