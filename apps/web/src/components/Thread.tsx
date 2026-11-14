import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { formatElapsed, parseTimestamp } from '../dates.js'
import { foldSummary, foldTimeline } from '../fold.js'
import type { FoldedItem } from '../fold.js'
import { PHASE_LABELS } from '../labels.js'
import { deliveryTag } from '../messages.js'
import type { DeliveryState } from '../messages.js'
import { runProgress } from '../task-info.js'
import { detailCount, hasDetails } from '../timeline.js'
import type { ReviewView, TimelineEntry } from '../timeline.js'
import { formatSpent } from '../usage.js'
import type { TaskEvent } from '../types.js'
import type { AttachmentInfo } from '../attachments.js'
import type { AttachmentControls } from './Attachments.js'
import { MessageAttachments } from './Attachments.js'
import { Markdown } from './Markdown.js'
import { Mascot } from './Mascot.js'
import { Icon } from './ui.js'

// The message presentation shared by the task thread and the assistant chat:
// the owner's words are a right-aligned bubble, the agent's words are plain prose.

export function UserBubble({
  text,
  state,
  attachments = [],
  attachmentControls,
}: {
  text: string
  state?: DeliveryState
  attachments?: readonly AttachmentInfo[]
  attachmentControls?: AttachmentControls | undefined
}) {
  const tag = state ? deliveryTag(state) : undefined
  return (
    <div className="msg-row msg-row-user">
      <div className="user-column">
        {attachments.length ? (
          <MessageAttachments attachments={attachments} controls={attachmentControls} />
        ) : null}
        {text ? (
          <div
            className={`user-bubble${state === 'discarded' || state === 'lost' ? ' user-bubble-off' : ''}`}
          >
            {text}
          </div>
        ) : null}
        {tag ? (
          <span className={`bubble-tag bubble-tag-${state}`} data-testid="message-tag">
            {tag}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function AgentProse({ text, speaker }: { text: string; speaker?: string }) {
  return (
    <div className="agent-message">
      {speaker ? <span className="speaker">{speaker}</span> : null}
      <Markdown text={text} />
    </div>
  )
}

function timestampTitle(ts: string): string | undefined {
  const time = parseTimestamp(ts)
  return time === undefined ? undefined : new Date(time).toLocaleString()
}

const SEVERITY_LABELS = { blocker: '阻擋', major: '重大', minor: '次要', nit: '小建議' } as const

function ToolRow({ entry }: { entry: Extract<TimelineEntry, { kind: 'tool' }> }) {
  const icon =
    entry.summary.kind === 'command'
      ? 'terminal'
      : entry.summary.kind === 'file'
        ? 'file'
        : entry.summary.kind === 'search'
          ? 'search'
          : 'bolt'
  const header = (
    <>
      <span className="tool-icon">
        <Icon name={icon} size={14} />
      </span>
      <span className="tool-label">{entry.label}</span>
      {entry.output ? (
        <span className={entry.isError ? 'tool-state tool-state-error' : 'tool-state'}>
          <Icon name={entry.isError ? 'alert' : 'check'} size={14} />
        </span>
      ) : null}
    </>
  )
  // An output that is only whitespace has nothing to open.
  if (!entry.output?.text.trim()) return <div className="tool-row tool-row-plain">{header}</div>
  return (
    <details className="tool-row">
      <summary>{header}</summary>
      <pre className="tool-output">{entry.output.text}</pre>
    </details>
  )
}

/** A reviewer's verdict: a small mark and word for pass or changes requested, then the summary and the findings. */
export function ReviewCard({ entry }: { entry: ReviewView }) {
  const subject = entry.target === 'plan' ? '計畫' : '程式變更'
  return (
    <section className="card review-card" aria-label="審查結果">
      <header className="review-head">
        {entry.approve === undefined ? null : (
          <strong className="review-result">
            <Icon name={entry.approve ? 'check' : 'retry'} size={14} />
            {entry.approve ? '通過' : '要求修改'}
          </strong>
        )}
        <span className="muted">
          {subject}審查{entry.round > 0 ? ` · 第 ${entry.round} 輪` : ''}
        </span>
      </header>
      {entry.summary ? <p>{entry.summary}</p> : null}
      {entry.findings.length > 0 ? (
        <ul className="finding-list">
          {entry.findings.map((finding, index) => (
            <li key={index}>
              <span className={`severity severity-${finding.severity}`}>
                {SEVERITY_LABELS[finding.severity]}
              </span>
              <span>
                {finding.message}
                {finding.file ? (
                  <code className="finding-where">
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ''}
                  </code>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function ChecksCard({ entry }: { entry: Extract<TimelineEntry, { kind: 'checks' }> }) {
  const verdict = entry.timedOut ? '專案檢查逾時' : entry.ok ? '專案檢查通過' : '專案檢查失敗'
  const facts = [
    entry.round > 0 ? `第 ${entry.round} 輪` : '',
    entry.exitCode !== null ? `結束碼 ${entry.exitCode}` : '',
    entry.durationMs !== undefined ? `耗時 ${formatSpent(entry.durationMs)}` : '',
  ].filter(Boolean)
  const header = (
    <>
      <span className={entry.ok ? 'tool-state' : 'tool-state tool-state-error'}>
        <Icon name={entry.ok ? 'check' : 'alert'} size={14} />
      </span>
      <strong>{verdict}</strong>
      <span className="muted">{facts.join(' · ')}</span>
    </>
  )
  return (
    <section className="card checks-card" aria-label="專案檢查" data-testid="checks-card">
      {entry.outputTail.trim() ? (
        <details>
          <summary className="checks-head">{header}</summary>
          <pre className="tool-output checks-output">{entry.outputTail}</pre>
        </details>
      ) : (
        <div className="checks-head">{header}</div>
      )}
    </section>
  )
}

function TimelineItem({
  entry,
  showDetails,
  attachmentControls,
}: {
  entry: TimelineEntry
  showDetails: boolean
  attachmentControls: AttachmentControls | undefined
}) {
  return (
    <div
      hidden={entry.kind === 'noise' && !showDetails}
      className={`timeline-item timeline-${entry.kind}${entry.kind === 'step' && entry.tone ? ` tone-${entry.tone}` : ''}`}
      data-event-seq={entry.seq}
      title={timestampTitle(entry.ts)}
    >
      {entry.kind === 'message' ? (
        <AgentProse
          text={entry.text}
          {...(entry.role && entry.role !== '實作' ? { speaker: entry.role } : {})}
        />
      ) : entry.kind === 'tool' ? (
        <ToolRow entry={entry} />
      ) : entry.kind === 'review' ? (
        <ReviewCard entry={entry} />
      ) : entry.kind === 'user' ? (
        <UserBubble
          text={entry.text}
          state={entry.state}
          attachments={entry.attachments}
          attachmentControls={attachmentControls}
        />
      ) : entry.kind === 'checks' ? (
        <ChecksCard entry={entry} />
      ) : entry.kind === 'phase' ? (
        // A hairline with the phase in the middle, not a pill.
        <span className="phase-divider">{entry.text}</span>
      ) : entry.kind === 'step' && entry.detail ? (
        <details className="step-detail">
          <summary>
            <span className="timeline-mark" aria-hidden="true" />
            <span className="timeline-text">{entry.text}</span>
          </summary>
          <Markdown text={entry.detail} />
        </details>
      ) : (
        <>
          <span className="timeline-mark" aria-hidden="true" />
          <span className="timeline-text">{entry.text}</span>
        </>
      )}
    </div>
  )
}

/** The closed-by-default 過程 of a finished task. Whether it is open is this component's own state, not saved. */
function ProcessFold({
  fold,
  showDetails,
  attachmentControls,
  detailsToggle,
}: {
  fold: Extract<FoldedItem, { kind: 'fold' }>
  showDetails: boolean
  attachmentControls: AttachmentControls | undefined
  detailsToggle: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const summary = foldSummary(fold.stats)
  return (
    <div className="process-fold" data-testid="process-fold">
      <button type="button" className="process-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span>過程{summary ? `（${summary}）` : ''}</span>
      </button>
      {open ? (
        <div className="process-body">
          {fold.entries.map((entry) => (
            <TimelineItem
              key={entry.key}
              entry={entry}
              showDetails={showDetails}
              attachmentControls={attachmentControls}
            />
          ))}
          {detailsToggle}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The event log as a conversation: prose, collapsible tool calls, phase dividers and review cards. While the task
 * works everything is open; once it is finished (`collapse`) the process folds into one line and what is left is
 * what the owner asked, what the agent concluded and the last review.
 */
export function TimelineView({
  entries,
  collapse,
  attachmentControls,
}: {
  entries: TimelineEntry[]
  /** Fold the process because the task is over: `done` for a result, `failed` for a failure or a cancel. */
  collapse?: 'done' | 'failed' | undefined
  attachmentControls?: AttachmentControls
}) {
  const [showDetails, setShowDetails] = useState(false)
  const items = useMemo(() => (collapse ? foldTimeline(entries, collapse) : null), [entries, collapse])

  function detailsToggle(shown: readonly TimelineEntry[]) {
    if (!hasDetails(shown)) return null
    const count = detailCount(shown)
    return (
      <button
        type="button"
        className="btn btn-ghost details-toggle"
        onClick={() => setShowDetails((open) => !open)}
      >
        {showDetails ? '隱藏細節' : count > 0 ? `顯示細節（${count} 筆）` : '顯示細節'}
      </button>
    )
  }

  if (items) {
    return (
      <div className="timeline" aria-label="任務紀錄" data-testid="event-stream">
        {items.map((item) =>
          item.kind === 'fold' ? (
            <ProcessFold
              key="process-fold"
              fold={item}
              showDetails={showDetails}
              attachmentControls={attachmentControls}
              detailsToggle={detailsToggle(item.entries)}
            />
          ) : (
            <TimelineItem
              key={item.entry.key}
              entry={item.entry}
              showDetails={showDetails}
              attachmentControls={attachmentControls}
            />
          ),
        )}
      </div>
    )
  }
  return (
    <>
      <div className="timeline" aria-label="任務紀錄" data-testid="event-stream">
        {entries.map((entry) => (
          <TimelineItem
            key={entry.key}
            entry={entry}
            showDetails={showDetails}
            attachmentControls={attachmentControls}
          />
        ))}
      </div>
      {detailsToggle(entries)}
    </>
  )
}

/** Re-renders every `interval` ms, so elapsed times keep counting without new events. */
export function useNow(interval = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(timer)
  }, [interval, enabled])
  return now
}

/** Who is working, in which round, for how long. */
export function RunningIndicator({ events, createdAt }: { events: TaskEvent[]; createdAt: string }) {
  const now = useNow(1000)
  const progress = runProgress(events)
  const startedAt = progress.startedAt ?? parseTimestamp(createdAt)
  const phase = progress.phase ? (PHASE_LABELS[progress.phase] ?? progress.phase) : '準備中'
  return (
    <div className="running-indicator" role="status">
      <Mascot mood="thinking" size={36} decorative />
      <span>{phase}</span>
      {progress.role ? <span className="chip">{progress.role}</span> : null}
      {progress.round > 0 ? <span className="muted">第 {progress.round} 輪</span> : null}
      {startedAt !== undefined ? (
        <time className="muted elapsed" aria-label="已執行時間">
          {formatElapsed(now - startedAt)}
        </time>
      ) : null}
    </div>
  )
}
