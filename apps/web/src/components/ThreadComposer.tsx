import { ApiError, errorMessage, request } from '../api.js'
import { followUpState, ownerActionError } from '../messages.js'
import { useDraft } from '../storage.js'
import { worktreeRemoved } from '../task-info.js'
import type { TaskDetails } from '../types.js'
import { useState } from 'react'
import { Composer } from './Composer.js'

const MAX_MESSAGE_CHARS = 20_000

/**
 * The message box at the bottom of a task thread. A message steers a running task (it reaches the agent's next
 * turn), continues a finished one, or revises a plan that waits for approval. The draft survives a failed send.
 */
export function ThreadComposer({
  details,
  onChanged,
  onError,
}: {
  details: TaskDetails
  onChanged: () => void
  onError: (message: string) => void
}) {
  const { task } = details
  const [draft, setDraft, clearDraft] = useDraft(`task-${task.id}`)
  const [busy, setBusy] = useState(false)
  const state = followUpState({
    status: task.status,
    mode: task.mode,
    worktreeRemoved: worktreeRemoved(details.events),
    pendingPlan: Boolean(details.pendingPlan),
  })
  const queued = details.queuedMessages?.length ?? 0

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text) return
    if (text.length > MAX_MESSAGE_CHARS) {
      onError(`訊息太長了（上限 ${MAX_MESSAGE_CHARS} 字）`)
      return
    }
    setBusy(true)
    try {
      await request(`/api/tasks/${encodeURIComponent(task.id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      clearDraft()
      onChanged()
    } catch (cause) {
      // The draft stays, so the owner can send it again.
      onError(
        ownerActionError(
          cause instanceof ApiError ? cause.status : undefined,
          errorMessage(cause, ''),
          '無法送出訊息',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="thread-composer" data-testid="thread-composer">
      {queued > 0 ? (
        <p className="queued-note" role="status" data-testid="queued-messages">
          {queued} 則訊息排隊中，下一輪會帶給 agent
        </p>
      ) : null}
      <Composer
        className="composer-chat"
        value={draft}
        onChange={setDraft}
        onSubmit={send}
        placeholder={state.disabled ? '' : state.placeholder}
        textareaLabel="傳訊息給任務"
        sendLabel="送出"
        busy={busy}
        disabled={state.disabled}
      />
      {state.reason ? <p className="composer-note">{state.reason}</p> : null}
    </div>
  )
}
