import { useEffect, useMemo, useState } from 'react'
import { request } from '../api.js'
import { relativeTime } from '../dates.js'
import { modeLabel, statusLabel } from '../labels.js'
import { NEW_CONVERSATION_TITLE, recentItems } from '../recent.js'
import { repoColor } from '../repo-colors.js'
import { modLabel } from '../shortcuts.js'
import type { ConversationSummary, Repo, Task } from '../types.js'
import { Mascot, MascotMark } from './Mascot.js'
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
  onNewTask: () => void
  onOpenTask: (id: string) => void
  onNewConversation: () => void
  onOpenConversation: (id: string) => void
  onOpenSettings: () => void
  onCollapse: () => void
}

export function Sidebar(props: SidebarProps) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()

  // One list: tasks and conversations together, the most recently active first. Archived tasks live in 設定.
  const items = useMemo(
    () => recentItems(props.tasks, props.conversations, query),
    [props.tasks, props.conversations, query],
  )
  const nothingYet = props.tasks.every((task) => task.archived) && props.conversations.length === 0

  function taskRow(task: Task, time: string | undefined) {
    const selected = props.view === 'task' && props.selectedTaskId === task.id
    const waiting = task.status === 'awaiting_approval' || task.status === 'review_ready'
    const working = task.status === 'running' || task.status === 'queued'
    const label = statusLabel(task.status, task.mode, props.pendingPlanTaskId === task.id)
    return (
      <div className={`nav-row-wrap${selected ? ' selected' : ''}`} key={`task:${task.id}`}>
        <button
          type="button"
          className="task-row"
          aria-current={selected ? 'page' : undefined}
          title={`${label} · ${modeLabel(task.mode)}`}
          onClick={() => props.onOpenTask(task.id)}
        >
          <span className="row-lead">
            <ProjectDot color={repoColor(task.repoId, props.repos)} />
          </span>
          <span className="task-row-copy">
            <span className="task-title">{task.title}</span>
            {waiting ? <span className={`task-meta status-text-${task.status}`}>{label}</span> : null}
          </span>
          {working ? (
            <Mascot mood="thinking" size={20} label={label} />
          ) : waiting ? (
            <span className="task-flag" aria-hidden="true" />
          ) : task.status === 'failed' ? (
            <span className="task-flag task-flag-failed" aria-hidden="true" />
          ) : null}
          <span className="task-time">{relativeTime(time)}</span>
        </button>
        <IconButton
          icon="archive"
          label={`封存：${task.title}`}
          className="row-action"
          onClick={() => props.onArchive(task.id)}
        />
      </div>
    )
  }

  function conversationRow(conversation: ConversationSummary, time: string | undefined) {
    const selected = props.view === 'assistant' && props.selectedConversationId === conversation.id
    const title = conversation.title ?? NEW_CONVERSATION_TITLE
    return (
      <div className={`nav-row-wrap${selected ? ' selected' : ''}`} key={`conversation:${conversation.id}`}>
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
      </div>
    )
  }

  // 新任務 / 聊聊 are lit only while that very page is open: the composer, or a conversation that has no messages yet.
  const onNewTask = props.view === 'new-task'
  const onNewChat = props.view === 'assistant' && props.selectedConversationId === ''

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
          <Icon name="plus" />
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
        <div className="sidebar-group task-list" aria-label="最近">
          {nothingYet ? null : (
            <div className="sidebar-group-head">
              <span className="group-label">最近</span>
            </div>
          )}
          {nothingYet ? (
            <p className="empty-list">還沒有任何工作</p>
          ) : items.length === 0 ? (
            <p className="empty-list">沒有符合的項目</p>
          ) : (
            items.map((item) =>
              item.kind === 'task'
                ? taskRow(item.task, item.time)
                : conversationRow(item.conversation, item.time),
            )
          )}
        </div>
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
