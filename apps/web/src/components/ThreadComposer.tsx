import { ApiError, errorMessage, request } from '../api.js'
import { followUpState, messageDeliveryStates, ownerActionError, pendingMessagesNote } from '../messages.js'
import { useDraft } from '../storage.js'
import { taskModels, worktreeRemoved } from '../task-info.js'
import type { TaskDetails } from '../types.js'
import { useMemo, useState } from 'react'
import { Composer } from './Composer.js'

const MAX_MESSAGE_CHARS = 20_000

/**
 * The message box at the bottom of a task thread. A message steers a running task (it interrupts the agent's current
 * step, or waits for its next turn during a review, checks or an approval), continues a finished one, or revises a plan
 * that waits for approval. The draft survives a failed send.
 */
export function ThreadComposer({
  details,
  onChanged,
  onError,
  onStop,
  stopping = false,
}: {
  details: TaskDetails
  onChanged: () => void
  onError: (message: string) => void
  /** Set while the task runs: an empty box shows a stop button. */
  onStop?: () => void
  stopping?: boolean
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
  const pendingNote = useMemo(
    () =>
      pendingMessagesNote(
        messageDeliveryStates(details.events, {
          ...(details.queuedMessages ? { queuedIds: new Set(details.queuedMessages.map((m) => m.id)) } : {}),
          busy: task.status === 'queued' || task.status === 'running' || task.status === 'awaiting_approval',
        }),
      ),
    [details.events, details.queuedMessages, task.status],
  )
  const models = taskModels(details)

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
      {pendingNote ? (
        <p className="queued-note" role="status" data-testid="queued-messages">
          {pendingNote}
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
        {...(onStop ? { onStop, stopping, stopLabel: '停止任務' } : {})}
        trailing={
          models.implementer ? (
            <span
              className="composer-model-label"
              data-testid="task-models"
              title={models.reviewer ? `實作：${models.implementer}，審查：${models.reviewer}` : undefined}
            >
              {models.implementer}
              {models.reviewer ? <span className="muted"> · 審查 {models.reviewer}</span> : null}
            </span>
          ) : null
        }
      />
      {state.reason ? <p className="composer-note">{state.reason}</p> : null}
    </div>
  )
}
