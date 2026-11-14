import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage, request } from '../api.js'
import { Button, Icon, IconButton } from './ui.js'

export interface MemoryItem {
  id: string
  content: string
  expiresAt?: string
  supersededBy?: string
}

function memoryInactive(memory: MemoryItem): boolean {
  return (
    Boolean(memory.supersededBy) ||
    (memory.expiresAt !== undefined && Date.parse(memory.expiresAt) <= Date.now())
  )
}

export async function deleteMemory(
  id: string,
  onChange: () => Promise<void>,
  onError: (message: string) => void,
) {
  try {
    await request(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await onChange()
  } catch (error) {
    onError(errorMessage(error, '無法刪除這筆記憶'))
  }
}

/** What Joy remembers about the owner (T3.4): every memory can be corrected or deleted. */
export function MemoryPanel(props: {
  memories: MemoryItem[]
  onChange: () => Promise<void>
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')

  async function save(id: string) {
    try {
      await request(`/api/memories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: draft }),
      })
      setEditing('')
      await props.onChange()
    } catch (error) {
      props.onError(errorMessage(error, '無法儲存這筆記憶'))
    }
  }

  return (
    <section className="side-section" aria-label="記憶" data-testid="memory-panel">
      <h3>Joy 記得的事</h3>
      {props.memories.length === 0 ? <p className="muted">還沒有。</p> : null}
      <ul className="side-list">
        {props.memories.map((memory) => (
          <li key={memory.id} className={memoryInactive(memory) ? 'side-item inactive' : 'side-item'}>
            {editing === memory.id ? (
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void save(memory.id)
                }}
              >
                <input
                  aria-label="記憶內容"
                  value={draft}
                  maxLength={500}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="button-row">
                  <Button variant="primary" type="submit">
                    儲存
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing('')}>
                    取消
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <span className="side-item-text">
                  {memory.content}
                  {memory.supersededBy ? <span className="muted">（已被取代）</span> : null}
                  {!memory.supersededBy && memoryInactive(memory) ? (
                    <span className="muted">（已過期）</span>
                  ) : null}
                </span>
                <span className="side-item-actions">
                  <IconButton
                    icon="pencil"
                    label="編輯"
                    onClick={() => {
                      setEditing(memory.id)
                      setDraft(memory.content)
                    }}
                  />
                  <IconButton
                    icon="trash"
                    label={`刪除記憶：${memory.content}`}
                    className="icon-btn-danger"
                    onClick={() => void deleteMemory(memory.id, props.onChange, props.onError)}
                  />
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

interface ScheduledItems {
  reminders: Array<{ id: string; text: string; dueAt: string }>
  schedules: Array<{
    id: string
    cron: string
    action: string
    payload: Record<string, unknown>
    nextRunAt: string
  }>
}

/** Pending reminders and recurring schedules (T3.7); the assistant creates them, the owner can cancel them here. */
export function ScheduledPanel(props: { onError: (message: string) => void }) {
  const [items, setItems] = useState<ScheduledItems>({ reminders: [], schedules: [] })

  async function load() {
    const body = await request<Partial<ScheduledItems>>('/api/schedules')
    setItems({
      reminders: Array.isArray(body.reminders) ? body.reminders : [],
      schedules: Array.isArray(body.schedules) ? body.schedules : [],
    })
  }

  useEffect(() => {
    void load().catch(() => undefined)
    const timer = window.setInterval(() => void load().catch(() => undefined), 15000)
    return () => window.clearInterval(timer)
  }, [])

  async function cancel(id: string) {
    try {
      await request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (error) {
      props.onError(errorMessage(error, '無法取消'))
    }
    await load().catch(() => undefined)
  }

  if (items.reminders.length === 0 && items.schedules.length === 0) return null
  return (
    <section className="side-section" aria-label="排程" data-testid="scheduled-panel">
      <h3>提醒與排程</h3>
      <ul className="side-list">
        {items.reminders.map((reminder) => (
          <li key={reminder.id} className="side-item">
            <span className="side-item-text">
              <Icon name="clock" size={14} /> {reminder.text}{' '}
              <span className="muted">· {new Date(reminder.dueAt).toLocaleString()}</span>
            </span>
            <Button variant="ghost" onClick={() => void cancel(reminder.id)}>
              取消
            </Button>
          </li>
        ))}
        {items.schedules.map((schedule) => (
          <li key={schedule.id} className="side-item">
            <span className="side-item-text">
              <Icon name="repeat" size={14} />{' '}
              {String(schedule.action === 'reminder' ? schedule.payload.text : schedule.payload.title)}{' '}
              <span className="muted">
                · <code>{schedule.cron}</code> · 下次 {new Date(schedule.nextRunAt).toLocaleString()}
              </span>
            </span>
            <Button variant="danger" onClick={() => void cancel(schedule.id)}>
              移除
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface HistoryHit {
  conversationId: string
  title?: string
  kind: 'summary' | 'message'
  role?: string
  snippet: string
  ts: string
}

/** Search past conversations (T3.6); picking a result opens that conversation. */
export function HistorySearch(props: { onOpen: (conversationId: string) => void }) {
  const [hits, setHits] = useState<HistoryHit[] | null>(null)

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = String(new FormData(event.currentTarget).get('q') ?? '').trim()
    if (!query) {
      setHits(null)
      return
    }
    const body = await request<{ results?: HistoryHit[] }>(
      `/api/history?q=${encodeURIComponent(query)}`,
    ).catch(() => ({ results: [] }))
    setHits(Array.isArray(body.results) ? body.results : [])
  }

  return (
    <div className="history-search">
      <form role="search" className="search-field" onSubmit={(event) => void search(event)}>
        <Icon name="search" size={14} />
        <input name="q" type="search" placeholder="搜尋對話內容" aria-label="搜尋以前的對話" />
      </form>
      {hits === null ? null : (
        <div className="history-results card">
          {hits.length === 0 ? (
            <p className="muted">找不到符合的內容。</p>
          ) : (
            <ul aria-label="搜尋結果" className="result-list">
              {hits.map((hit, index) => (
                <li key={`${hit.conversationId}-${index}`}>
                  <button
                    type="button"
                    className="result-row"
                    onClick={() => {
                      props.onOpen(hit.conversationId)
                      setHits(null)
                    }}
                  >
                    <span className="muted">
                      {hit.ts.slice(0, 10)} · {hit.title ?? '對話'}
                      {hit.kind === 'summary' ? ' · 摘要' : ''}
                    </span>
                    <span>{hit.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

interface ProjectNote {
  id: string
  note: string
  file: string
  repoPath?: string
  stale?: boolean
  diff?: Array<{ kind: 'same' | 'add' | 'remove'; text: string }>
}

/** Outside actions the assistant asked for (send mail, invite people; T3.8). Nothing happens until approved here. */
export function AssistantActionsPanel(props: { onDecided: () => void; onError: (message: string) => void }) {
  const [actions, setActions] = useState<Array<{ id: string; summary: string; provenance: string }>>([])

  async function load() {
    const body = await request<{ actions?: Array<{ id: string; summary: string; provenance: string }> }>(
      '/api/assistant/actions',
    )
    setActions(Array.isArray(body.actions) ? body.actions : [])
  }

  useEffect(() => {
    void load().catch(() => undefined)
    const timer = window.setInterval(() => void load().catch(() => undefined), 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function decide(id: string, decision: 'approve' | 'deny') {
    try {
      await request(`/api/assistant/actions/${encodeURIComponent(id)}/${decision}`, {
        method: 'POST',
        body: '{}',
      })
    } catch (error) {
      props.onError(errorMessage(error, '無法送出你的決定'))
    }
    await load().catch(() => undefined)
    props.onDecided()
  }

  if (actions.length === 0) return null
  return (
    <section className="card approvals-card" aria-label="需要你同意" data-testid="assistant-actions">
      <h2>需要你同意</h2>
      {actions.map((action) => (
        <div key={action.id} className="approval-row">
          <div className="approval-copy">
            <code>{action.summary}</code>
            {action.provenance === 'external_content' ? (
              <p className="muted">這是讀了郵件或行事曆內容之後提出的要求</p>
            ) : null}
          </div>
          <div className="button-row">
            <Button variant="primary" onClick={() => void decide(action.id, 'approve')}>
              同意
            </Button>
            <Button variant="danger" onClick={() => void decide(action.id, 'deny')}>
              拒絕
            </Button>
          </div>
        </div>
      ))}
    </section>
  )
}

/** AGENTS.md notes Joy proposed (T3.5). Nothing reaches the repository until the owner applies the diff here. */
export function ProjectNotesPanel(props: { onError: (message: string) => void }) {
  const [notes, setNotes] = useState<ProjectNote[]>([])

  async function load() {
    const body = await request<{ notes?: ProjectNote[] }>('/api/project-notes?status=pending')
    setNotes(Array.isArray(body.notes) ? body.notes : [])
  }

  useEffect(() => {
    void load().catch(() => undefined)
    const timer = window.setInterval(() => void load().catch(() => undefined), 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function decide(id: string, action: 'apply' | 'reject') {
    try {
      await request(`/api/project-notes/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' })
    } catch (error) {
      props.onError(errorMessage(error, '無法更新這個提案'))
    }
    await load().catch(() => undefined)
  }

  if (notes.length === 0) return null
  return (
    <section className="card approvals-card" aria-label="專案守則提案" data-testid="project-notes">
      <h2>建議加入專案守則</h2>
      {notes.map((note) => (
        <article key={note.id} className="project-note">
          <p>
            <strong>{note.note}</strong>
            <span className="muted">
              {' '}
              → {note.repoPath ? `${note.repoPath}/` : ''}
              {note.file}
            </span>
          </p>
          {note.stale ? (
            <p className="muted">提案之後檔案又改過了。請拒絕這個提案，再請 Joy 重新提一次。</p>
          ) : (
            <pre className="diff-code" aria-label={`差異：${note.note}`}>
              {(note.diff ?? [])
                .filter((line) => line.kind !== 'same')
                .map((line, index) => (
                  <span key={index} className={`diff-line ${line.kind === 'add' ? 'added' : 'removed'}`}>
                    {line.kind === 'add' ? '+ ' : '- '}
                    {line.text}
                  </span>
                ))}
            </pre>
          )}
          <div className="button-row">
            {note.stale ? null : (
              <Button variant="primary" onClick={() => void decide(note.id, 'apply')}>
                寫進 {note.file}
              </Button>
            )}
            <Button variant="danger" onClick={() => void decide(note.id, 'reject')}>
              拒絕
            </Button>
          </div>
        </article>
      ))}
    </section>
  )
}
