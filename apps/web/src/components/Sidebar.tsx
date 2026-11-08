import { useEffect, useMemo, useState } from 'react'
import { request } from '../api.js'
import { groupByDay, relativeTime } from '../dates.js'
import { modeLabel, repoName, statusLabel } from '../labels.js'
import { modLabel } from '../shortcuts.js'
import type { ConversationSummary, Repo, Task } from '../types.js'
import { Icon, IconButton } from './ui.js'

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
  /** Which view is showing, so the matching row can be highlighted. */
  view: 'new-task' | 'task' | 'assistant' | 'stats' | 'settings'
  selectedTaskId: string
  selectedConversationId: string
  /** The task whose plan waits for approval, if the open one does: its row says so. */
  pendingPlanTaskId?: string
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onNewTask: () => void
  onOpenTask: (id: string) => void
  onOpenAssistant: () => void
  onNewConversation: () => void
  onOpenConversation: (id: string) => void
  onOpenStats: () => void
  onOpenSettings: () => void
  onAddRepo: () => void
  onCollapse: () => void
}

function contains(text: string | undefined, query: string): boolean {
  return (text ?? '').toLowerCase().includes(query)
}

export function Sidebar(props: SidebarProps) {
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const query = search.trim().toLowerCase()

  const visibleTasks = useMemo(
    () => props.tasks.filter((task) => !query || contains(task.title, query) || contains(task.prompt, query)),
    [props.tasks, query],
  )
  const activeTasks = visibleTasks.filter((task) => !task.archived)
  const archivedTasks = visibleTasks.filter((task) => task.archived)
  const conversations = props.conversations.filter(
    (conversation) => !query || contains(conversation.title ?? '新對話', query),
  )

  const groups = useMemo(() => {
    const byRepo = new Map<string, Task[]>()
    for (const task of activeTasks) byRepo.set(task.repoId, [...(byRepo.get(task.repoId) ?? []), task])
    return [...byRepo.entries()].map(([repoId, list]) => ({
      repoId,
      name: repoName(props.repos.find((repo) => repo.id === repoId)?.path),
      days: groupByDay(list, (task) => task.createdAt),
    }))
  }, [activeTasks, props.repos])

  const nothingFound =
    query && activeTasks.length === 0 && archivedTasks.length === 0 && conversations.length === 0

  function taskRow(task: Task, archivedRow: boolean) {
    const selected = props.view === 'task' && props.selectedTaskId === task.id
    const waiting = task.status === 'awaiting_approval' || task.status === 'review_ready'
    const label = statusLabel(task.status, task.mode, props.pendingPlanTaskId === task.id)
    return (
      <div className={`nav-row-wrap${selected ? ' selected' : ''}`} key={task.id}>
        <button
          type="button"
          className="task-row"
          aria-current={selected ? 'page' : undefined}
          title={`${label} · ${modeLabel(task.mode)}`}
          onClick={() => props.onOpenTask(task.id)}
        >
          {task.status === 'running' || task.status === 'queued' ? (
            <span className="task-spinner" aria-hidden="true" />
          ) : (
            <span className={`task-dot status-${task.status}`} aria-hidden="true" />
          )}
          <span className="task-row-copy">
            <span className="task-title">{task.title}</span>
            {waiting ? <span className={`task-meta status-text-${task.status}`}>{label}</span> : null}
          </span>
          <span className="task-time">{relativeTime(task.createdAt)}</span>
        </button>
        {archivedRow ? (
          <IconButton
            icon="retry"
            label={`取消封存：${task.title}`}
            className="row-action"
            onClick={() => props.onRestore(task.id)}
          />
        ) : (
          <IconButton
            icon="archive"
            label={`封存：${task.title}`}
            className="row-action"
            onClick={() => props.onArchive(task.id)}
          />
        )}
      </div>
    )
  }

  return (
    <nav className="sidebar" aria-label="主選單">
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            J
          </span>
          <span>Joy</span>
        </div>
        <IconButton
          icon="panel-left"
          label="收合側邊欄"
          className="sidebar-collapse"
          onClick={props.onCollapse}
        />
      </div>

      <div className="search-field sidebar-search">
        <Icon name="search" size={14} />
        <input
          type="search"
          aria-label="搜尋任務與對話"
          placeholder="搜尋任務與對話"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search ? null : <kbd>{modLabel()}K</kbd>}
      </div>

      <button
        type="button"
        className={`nav-item${props.view === 'new-task' ? ' active' : ''}`}
        aria-current={props.view === 'new-task' ? 'page' : undefined}
        onClick={props.onNewTask}
      >
        <Icon name="plus" />
        新任務
      </button>
      <button
        type="button"
        className={`nav-item${props.view === 'assistant' ? ' active' : ''}`}
        aria-current={props.view === 'assistant' ? 'page' : undefined}
        onClick={props.onOpenAssistant}
      >
        <Icon name="chat" />
        助理
      </button>

      <div className="sidebar-scroll">
        <div className="sidebar-group">
          <div className="sidebar-group-head">
            <span className="group-label">對話</span>
            <IconButton
              icon="plus"
              label="新對話"
              className="icon-btn-sm"
              onClick={props.onNewConversation}
            />
          </div>
          {conversations.length === 0 ? (
            <p className="empty-list">{query ? '沒有符合的對話。' : '還沒有對話。'}</p>
          ) : (
            conversations.map((conversation) => {
              const selected = props.view === 'assistant' && props.selectedConversationId === conversation.id
              return (
                <button
                  type="button"
                  key={conversation.id}
                  className={`nav-row${selected ? ' selected' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => props.onOpenConversation(conversation.id)}
                >
                  <span className="task-title">{conversation.title ?? '新對話'}</span>
                </button>
              )
            })
          )}
        </div>

        <div className="sidebar-group task-list" aria-label="任務列表">
          <div className="sidebar-group-head">
            <span className="group-label">任務</span>
          </div>
          {props.tasks.length === 0 ? (
            <p className="empty-list">你的任務會出現在這裡。</p>
          ) : nothingFound ? (
            <p className="empty-list">沒有符合的項目。</p>
          ) : (
            groups.map((group) => (
              <div className="task-group" key={group.repoId}>
                <div className="task-group-label">
                  <Icon name="folder" size={13} />
                  {group.name}
                </div>
                {group.days.map((day) => (
                  <div key={day.group}>
                    <div className="day-label">{day.label}</div>
                    {day.items.map((task) => taskRow(task, false))}
                  </div>
                ))}
              </div>
            ))
          )}
          {archivedTasks.length > 0 ? (
            <div className="task-group">
              <button
                type="button"
                className="nav-row archived-toggle"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((open) => !open)}
              >
                <Icon name={showArchived ? 'chevron-down' : 'chevron-right'} size={14} />
                已封存（{archivedTasks.length}）
              </button>
              {showArchived ? archivedTasks.map((task) => taskRow(task, true)) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="sidebar-footer">
        <UsageAlert />
        <button type="button" className="nav-item" onClick={props.onAddRepo}>
          <Icon name="folder" />
          加入專案
        </button>
        <div className="footer-row">
          <button
            type="button"
            className={`nav-item${props.view === 'stats' ? ' active' : ''}`}
            aria-current={props.view === 'stats' ? 'page' : undefined}
            onClick={props.onOpenStats}
          >
            <Icon name="chart" />
            統計
          </button>
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
      </div>
    </nav>
  )
}
