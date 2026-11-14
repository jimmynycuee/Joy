import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, request } from '../api.js'
import { DiffBrowser, DiffStat } from '../components/DiffView.js'
import { CheckpointsPanel } from '../components/CheckpointsPanel.js'
import { Mascot } from '../components/Mascot.js'
import { Menu, MenuItem, MenuSeparator, SubMenu } from '../components/Menu.js'
import { PlanCard } from '../components/PlanCard.js'
import { PrStatusCard } from '../components/PrStatusCard.js'
import { RunningIndicator, TimelineView, UserBubble } from '../components/Thread.js'
import { ThreadComposer } from '../components/ThreadComposer.js'
import { TitleEditor } from '../components/TitleEditor.js'
import { UsagePanel } from '../components/UsagePanel.js'
import { ApprovalsPanel, ComparePanel, DiscardButton, PublishPanel } from '../components/task-panels.js'
import { Button, Icon, IconButton } from '../components/ui.js'
import { diffTotals } from '../diff.js'
import { modeLabel, statusLabel } from '../labels.js'
import { followUpState } from '../messages.js'
import { diffFrom, failureMessage, taskBranchInfo, worktreeRemoved } from '../task-info.js'
import { buildTimeline } from '../timeline.js'
import type { AttachmentControls } from '../components/Attachments.js'
import type { TaskDetails } from '../types.js'
import { formatSpent, parseUsage } from '../usage.js'

/** One task as a conversation: what you asked, what the agents did, and what is waiting for you. */
export function TaskPage({
  details,
  changesOpen,
  onToggleChanges,
  onChanged,
  onError,
  onRename,
  onArchive,
}: {
  details: TaskDetails
  changesOpen: boolean | null
  onToggleChanges: (open: boolean) => void
  onChanged: () => void
  onError: (message: string) => void
  onRename: (title: string) => Promise<boolean>
  onArchive: () => void
}) {
  const { task } = details
  const [renaming, setRenaming] = useState(false)
  const [copied, setCopied] = useState<'branch' | 'path' | null>(null)
  const [acting, setActing] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  const branch = useMemo(() => taskBranchInfo(details.attempts), [details.attempts])
  const working = task.status === 'queued' || task.status === 'running'
  const pendingPlan = details.pendingPlan ?? null
  const queuedIds = useMemo(
    () => (details.queuedMessages ? new Set(details.queuedMessages.map((message) => message.id)) : undefined),
    [details.queuedMessages],
  )
  // A sent file can be taken back: agents get only its name from then on (and a file a backend refuses no longer
  // breaks the task).
  const attachmentControls: AttachmentControls = useMemo(
    () => ({
      removed: new Set((details.attachments ?? []).filter((a) => a.disabled).map((a) => a.id)),
      onRemove: async (attachment) => {
        if (!window.confirm(`移除「${attachment.name}」？之後 agent 只會看到檔名，無法復原。`)) return
        try {
          await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' })
          onChanged()
        } catch (error) {
          onError(errorMessage(error, '無法移除附件'))
        }
      },
    }),
    [details.attachments, onChanged, onError],
  )
  const entries = useMemo(
    () =>
      buildTimeline(details.events, branch.worktreePath, {
        ...(queuedIds ? { queuedIds } : {}),
        busy: task.status === 'queued' || task.status === 'running' || task.status === 'awaiting_approval',
        pendingPlan: pendingPlan !== null,
      }),
    [details.events, branch.worktreePath, queuedIds, task.status, pendingPlan],
  )
  const usage = useMemo(() => parseUsage(details.usage), [details.usage])
  const checkpointCount = details.events.filter((event) => event.type === 'checkpoint.created').length
  const published = details.events.some((event) => event.type === 'publish.done')
  const canAskAgent = !followUpState({
    mode: task.mode,
    worktreeRemoved: worktreeRemoved(details.events),
  }).disabled
  const diff = useMemo(() => diffFrom(details.events), [details.events])
  const totals = diffTotals(diff?.files ?? [])
  // Closed while there is nothing to see; opens by itself when a diff appears, until the owner decides otherwise.
  const hasDiff = Boolean(diff && diff.files.length > 0)
  const paneOpen = changesOpen ?? hasDiff

  // A finished task reads from the top: what was asked, what the agent concluded, the last review. The process folds
  // away. A plan waiting for a decision and a compete task (two attempts side by side) stay open.
  const finished = task.status === 'done' || task.status === 'review_ready'
  const collapse =
    pendingPlan !== null || task.mode === 'compete'
      ? undefined
      : finished
        ? 'done'
        : task.status === 'failed' || task.status === 'cancelled'
          ? 'failed'
          : undefined
  const ended = finished || task.status === 'failed' || task.status === 'cancelled'

  const canResume = (task.status === 'failed' || task.status === 'cancelled') && task.mode !== 'compete'

  useEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [details.events.length, task.status])

  function copy(kind: 'branch' | 'path', text: string) {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(kind)
        window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1500)
      })
      .catch(() => undefined)
  }

  async function act(path: 'cancel' | 'resume') {
    setActing(true)
    try {
      await request(`/api/tasks/${encodeURIComponent(task.id)}/${path}`, { method: 'POST', body: '{}' })
      onChanged()
    } catch (error) {
      onError(errorMessage(error, path === 'cancel' ? '無法停止任務' : '無法繼續任務'))
    } finally {
      setActing(false)
    }
  }

  return (
    <main className="thread" aria-label="任務進度">
      <header className="thread-header">
        <div className="thread-title-line">
          <span
            className={`task-dot status-${task.status}`}
            role="img"
            aria-label={statusLabel(task.status, task.mode, pendingPlan !== null)}
            title={`${statusLabel(task.status, task.mode, pendingPlan !== null)} · ${modeLabel(task.mode)}`}
            data-testid="task-status"
          />
          <TitleEditor
            title={task.title}
            onRename={onRename}
            editing={renaming}
            onEditingChange={setRenaming}
          />
        </div>
        <Button
          icon="panel-right"
          aria-pressed={paneOpen}
          aria-label={paneOpen ? '隱藏變更' : '顯示變更'}
          onClick={() => onToggleChanges(!paneOpen)}
        >
          變更
          <DiffStat {...totals} />
        </Button>
        <Menu
          label="任務選項"
          triggerLabel="更多"
          triggerTitle="更多"
          triggerClassName="icon-btn"
          trigger={<Icon name="more" size={18} />}
          align="end"
        >
          {branch.branch ? (
            <MenuItem
              icon={copied === 'branch' ? 'check' : 'branch'}
              keepOpen
              description={<span className="menu-desc-path">{branch.branch}</span>}
              onSelect={() => copy('branch', branch.branch ?? '')}
            >
              {copied === 'branch' ? '已複製' : '複製分支名稱'}
            </MenuItem>
          ) : null}
          {branch.worktreePath ? (
            <MenuItem
              icon={copied === 'path' ? 'check' : 'folder'}
              keepOpen
              description={<span className="menu-desc-path">{branch.worktreePath}</span>}
              onSelect={() => copy('path', branch.worktreePath ?? '')}
            >
              {copied === 'path' ? '已複製' : '複製工作副本路徑'}
            </MenuItem>
          ) : null}
          {branch.branch || branch.worktreePath ? <MenuSeparator /> : null}
          {usage ? (
            <SubMenu
              label="用量"
              value={formatSpent(usage.durationMs)}
              kind="dialog"
              className="menu-panel-wide"
            >
              <UsagePanel usage={usage} />
            </SubMenu>
          ) : null}
          {checkpointCount > 0 ? (
            <SubMenu label="檢查點" value={String(checkpointCount)} kind="dialog" className="menu-panel-wide">
              <CheckpointsPanel
                taskId={task.id}
                count={checkpointCount}
                working={working || task.status === 'awaiting_approval'}
                onChanged={onChanged}
              />
            </SubMenu>
          ) : null}
          {usage || checkpointCount > 0 ? <MenuSeparator /> : null}
          <MenuItem icon="pencil" onSelect={() => setRenaming(true)}>
            改名
          </MenuItem>
          <MenuItem
            icon="archive"
            disabled={working}
            disabledReason="進行中的任務不能封存，請先停止它"
            onSelect={onArchive}
          >
            封存
          </MenuItem>
        </Menu>
      </header>
      <div className="thread-body">
        <div className="thread-main">
          <div
            className="thread-scroll"
            ref={scrollRef}
            onScroll={(event) => {
              const element = event.currentTarget
              stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140
            }}
          >
            <div className="thread-column">
              <UserBubble
                text={task.prompt}
                attachments={(details.attachments ?? []).filter((attachment) => !attachment.messageId)}
                attachmentControls={attachmentControls}
              />
              <TimelineView entries={entries} collapse={collapse} attachmentControls={attachmentControls} />
              {pendingPlan && !working ? (
                <PlanCard taskId={task.id} plan={pendingPlan} onChanged={onChanged} onError={onError} />
              ) : null}
              <ApprovalsPanel
                taskId={task.id}
                taskStatus={task.status}
                approvalEvents={details.events.filter((event) => event.type.startsWith('approval.')).length}
              />
              {task.status === 'failed' ? (
                <section className="card error-card" aria-label="任務失敗">
                  <Mascot mood="error" size={40} decorative />
                  <div className="error-card-copy">
                    <strong>任務失敗</strong>
                    <p>{failureMessage(details.events) ?? '沒有收到更詳細的錯誤訊息。'}</p>
                  </div>
                  {canResume ? (
                    <Button icon="retry" disabled={acting} onClick={() => void act('resume')}>
                      重試
                    </Button>
                  ) : null}
                </section>
              ) : null}
              {task.status === 'cancelled' ? (
                <section className="card note-card" aria-label="任務已取消">
                  <Icon name="stop" size={18} />
                  <div className="error-card-copy">
                    <strong>任務已取消</strong>
                  </div>
                  {canResume ? (
                    <Button icon="retry" disabled={acting} onClick={() => void act('resume')}>
                      繼續
                    </Button>
                  ) : null}
                </section>
              ) : null}
              {working ? <RunningIndicator events={details.events} createdAt={task.createdAt} /> : null}
              {task.mode === 'compete' && task.status !== 'done' ? (
                <ComparePanel details={details} onChanged={onChanged} />
              ) : null}
              {published ? (
                <PrStatusCard
                  taskId={task.id}
                  canAskAgent={canAskAgent}
                  onChanged={onChanged}
                  onError={onError}
                />
              ) : null}
              {task.status === 'done' ? (
                <section className="done-row" aria-label="任務完成" data-testid="task-done">
                  <Mascot mood="happy" size={40} decorative />
                  <span>任務完成了</span>
                </section>
              ) : null}
              {ended && hasDiff ? (
                <button type="button" className="change-summary" onClick={() => onToggleChanges(true)}>
                  <Icon name="file" size={14} />
                  <span>{diff?.files.length} 個檔案</span>
                  <DiffStat {...totals} />
                </button>
              ) : null}
              <div className="thread-actions">
                <PublishPanel details={details} onChanged={onChanged} />
                <DiscardButton details={details} onChanged={onChanged} />
              </div>
            </div>
          </div>
          <ThreadComposer
            details={details}
            onChanged={onChanged}
            onError={onError}
            {...(working ? { onStop: () => void act('cancel'), stopping: acting } : {})}
          />
        </div>
        {paneOpen ? (
          <aside className="diff-pane" aria-label="檔案變更">
            <div className="pane-header">
              <h2>變更</h2>
              <IconButton icon="x" label="關閉變更面板" onClick={() => onToggleChanges(false)} />
            </div>
            {diff && hasDiff ? <DiffBrowser diff={diff} /> : <p className="pane-empty">還沒有變更</p>}
          </aside>
        ) : null}
      </div>
    </main>
  )
}
