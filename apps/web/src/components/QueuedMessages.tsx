import { useState } from 'react'
import { ApiError, errorMessage, request } from '../api.js'
import { ownerActionError } from '../messages.js'
import { moveQueued } from '../queue.js'
import type { QueuedMessage } from '../types.js'
import { Icon } from './ui.js'

/**
 * Messages waiting for the end of the agent's turn, above the composer: the owner can rewrite, move or drop each one
 * before the agent gets them.
 */
export function QueuedMessages({
  taskId,
  messages,
  onChanged,
  onError,
}: {
  taskId: string
  messages: readonly QueuedMessage[]
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  if (!messages.length) return null
  const base = `/api/tasks/${encodeURIComponent(taskId)}/queued`

  async function act(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true)
    try {
      await request(path, init)
      onChanged()
      return true
    } catch (error) {
      onError(
        ownerActionError(
          error instanceof ApiError ? error.status : undefined,
          errorMessage(error, ''),
          '無法更改排隊中的訊息',
        ),
      )
      onChanged()
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save(id: string) {
    const text = draft.trim()
    if (!text) return
    if (await act(`${base}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ text }) }))
      setEditing(null)
  }

  return (
    <ol className="queued-list" aria-label="排隊中的訊息" data-testid="queued-list">
      {messages.map((message, index) => (
        <li key={message.id} className="queued-item" data-testid="queued-item">
          {editing === message.id ? (
            <form
              className="queued-edit"
              onSubmit={(event) => {
                event.preventDefault()
                void save(message.id)
              }}
            >
              <input
                aria-label="修改排隊中的訊息"
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setEditing(null)
                }}
              />
              <button
                type="submit"
                className="icon-btn icon-btn-sm"
                aria-label="儲存"
                title="儲存"
                disabled={busy}
              >
                <Icon name="check" size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="取消"
                title="取消"
                onClick={() => setEditing(null)}
              >
                <Icon name="x" size={14} />
              </button>
            </form>
          ) : (
            <>
              <Icon name="clock" size={14} />
              <span className="queued-text" title={message.text}>
                {message.text || '（只有附件）'}
              </span>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="往前"
                title="往前"
                disabled={busy || index === 0}
                onClick={() =>
                  void act(base, {
                    method: 'PUT',
                    body: JSON.stringify({ ids: moveQueued(messages, index, -1) }),
                  })
                }
              >
                <Icon name="chevron-up" size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="往後"
                title="往後"
                disabled={busy || index === messages.length - 1}
                onClick={() =>
                  void act(base, {
                    method: 'PUT',
                    body: JSON.stringify({ ids: moveQueued(messages, index, 1) }),
                  })
                }
              >
                <Icon name="chevron-down" size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="修改"
                title="修改"
                disabled={busy || !message.text}
                onClick={() => {
                  setDraft(message.text)
                  setEditing(message.id)
                }}
              >
                <Icon name="pencil" size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="刪除"
                title="刪除"
                disabled={busy}
                onClick={() => void act(`${base}/${encodeURIComponent(message.id)}`, { method: 'DELETE' })}
              >
                <Icon name="x" size={14} />
              </button>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}
