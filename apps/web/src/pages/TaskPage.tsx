import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, request } from '../api.js'
import { DiffBrowser, DiffStat } from '../components/DiffView.js'
import { CheckpointsPopover } from '../components/CheckpointsPopover.js'
import { Mascot } from '../components/Mascot.js'
import { PlanCard } from '../components/PlanCard.js'
import { PrStatusCard } from '../components/PrStatusCard.js'
import { RunningIndicator, TimelineView, UserBubble } from '../components/Thread.js'
import { ThreadComposer } from '../components/ThreadComposer.js'
import { TitleEditor } from '../components/TitleEditor.js'
import { UsagePopover } from '../components/UsagePopover.js'
import { ApprovalsPanel, ComparePanel, DiscardButton, PublishPanel } from '../components/task-panels.js'
import { Button, CopyButton, Icon, IconButton, ProjectDot } from '../components/ui.js'
import { diffTotals } from '../diff.js'
import { modeLabel, repoName, statusLabel } from '../labels.js'
import { followUpState } from '../messages.js'
import { repoColor } from '../repo-colors.js'
import { diffFrom, failureMessage, taskBranchInfo, worktreeRemoved } from '../task-info.js'
import { buildTimeline } from '../timeline.js'
import type { Repo, TaskDetails } from '../types.js'
import { parseUsage } from '../usage.js'

/** One task as a conversation: what you asked, what the agents did, and what is waiting for you. */
export function TaskPage({
  details,
  repos,
  changesOpen,
  onToggleChanges,
  onChanged,
  onError,
  onRename,
}: {
  details: TaskDetails
  /** Every project, so this one's colour follows its place in the list. */
  repos: Repo[]
  changesOpen: boolean | null
  onToggleChanges: (open: boolean) => void
  onChanged: () => void
  onError: (message: string) => void
  onRename: (title: string) => Promise<boolean>
}) {
  const { task, repo } = details
  const [showDetails, setShowDetails] = useState(false)
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
    status: task.status,
    mode: task.mode,
    worktreeRemoved: worktreeRemoved(details.events),
    pendingPlan: pendingPlan !== null,
  }).disabled
  const hiddenCount = entries.filter((entry) => entry.kind === 'noise').length
  const diff = useMemo(() => diffFrom(details.events), [details.events])
  const totals = diffTotals(diff?.files ?? [])
  // Closed while there is nothing to see; opens by itself when a diff appears, until the owner decides otherwise.
  const hasDiff = Boolean(diff && diff.files.length > 0)
  const paneOpen = changesOpen ?? hasDiff

  const canResume = (task.status === 'failed' || task.status === 'cancelled') && task.mode !== 'compete'

  useEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [details.events.length, task.status])

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
        <div className="thread-heading">
          <div className="thread-title-line">
            <ProjectDot color={repoColor(task.repoId, repos)} className="project-dot-lg" />
            <TitleEditor title={task.title} onRename={onRename} />
          </div>
          <div className="thread-sub">
            <span>{repoName(repo?.path)}</span>
            <span aria-hidden="true">·</span>
            <span>{modeLabel(task.mode)}</span>
            {branch.branch ? (
              <span className="meta-chip" title="這個任務的分支">
                <Icon name="branch" size={13} />
                <code>{branch.branch}</code>
                <CopyButton text={branch.branch} label="複製分支名稱" />
              </span>
            ) : null}
            {branch.worktreePath ? (
              <span className="meta-chip" title={branch.worktreePath}>
                <Icon name="folder" size={13} />
                <span>工作副本</span>
                <CopyButton text={branch.worktreePath} label="複製工作副本路徑" />
              </span>
            ) : null}
          </div>
        </div>
        <span className={`status-pill status-${task.status}`}>
          {statusLabel(task.status, task.mode, pendingPlan !== null)}
        </span>
        {usage ? <UsagePopover usage={usage} /> : null}
        {checkpointCount > 0 ? (
          <CheckpointsPopover
            taskId={task.id}
            count={checkpointCount}
            working={working || task.status === 'awaiting_approval'}
            onChanged={onChanged}
          />
        ) : null}
        <Button
          icon="panel-right"
          aria-pressed={paneOpen}
          aria-label={paneOpen ? '隱藏變更' : '顯示變更'}
          onClick={() => onToggleChanges(!paneOpen)}
        >
          變更
          <DiffStat {...totals} />
        </Button>
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
              <UserBubble text={task.prompt} />
              <TimelineView entries={entries} showDetails={showDetails} />
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost details-toggle"
                  onClick={() => setShowDetails((open) => !open)}
                >
                  {showDetails ? '隱藏細節' : `顯示細節（${hiddenCount} 筆）`}
                </button>
              ) : null}
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
