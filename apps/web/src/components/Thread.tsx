import { useEffect, useState } from 'react'
import { formatElapsed, parseTimestamp } from '../dates.js'
import { PHASE_LABELS } from '../labels.js'
import { runProgress } from '../task-info.js'
import type { TimelineEntry } from '../timeline.js'
import type { TaskEvent } from '../types.js'
import { Markdown } from './Markdown.js'
import { Icon, Spinner } from './ui.js'

// The message presentation shared by the task thread and the assistant chat:
// the owner's words are a right-aligned bubble, the agent's words are plain prose.

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="msg-row msg-row-user">
      <div className="user-bubble">{text}</div>
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
  if (!entry.output?.text) return <div className="tool-row tool-row-plain">{header}</div>
  return (
    <details className="tool-row">
      <summary>{header}</summary>
      <pre className="tool-output">{entry.output.text}</pre>
    </details>
  )
}

function ReviewCard({ entry }: { entry: Extract<TimelineEntry, { kind: 'review' }> }) {
  const subject = entry.target === 'plan' ? '計畫' : '程式變更'
  const verdict =
    entry.approve === undefined
      ? `${subject}審查`
      : entry.approve
        ? `${subject}審查通過`
        : `${subject}要求修改`
  return (
    <section
      className={`card review-card ${entry.approve === false ? 'review-changes' : entry.approve ? 'review-ok' : ''}`}
      aria-label="審查結果"
    >
      <header className="review-head">
        <Icon name={entry.approve === false ? 'alert' : 'check'} size={16} />
        <strong>{verdict}</strong>
        {entry.round > 0 ? <span className="muted">第 {entry.round} 輪</span> : null}
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

/** The event log as a conversation: prose, collapsible tool calls, phase markers and review cards. */
export function TimelineView({ entries, showDetails }: { entries: TimelineEntry[]; showDetails: boolean }) {
  return (
    <div className="timeline" aria-label="任務紀錄" data-testid="event-stream">
      {entries.map((entry) => (
        <div
          hidden={entry.kind === 'noise' && !showDetails}
          className={`timeline-item timeline-${entry.kind}${entry.kind === 'step' && entry.tone ? ` tone-${entry.tone}` : ''}`}
          data-event-seq={entry.seq}
          title={timestampTitle(entry.ts)}
          key={entry.key}
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
          ) : entry.kind === 'phase' ? (
            <span className="phase-label">{entry.text}</span>
          ) : (
            <>
              <span className="timeline-mark" aria-hidden="true" />
              <span className="timeline-text">{entry.text}</span>
            </>
          )}
        </div>
      ))}
    </div>
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
      <Spinner />
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
