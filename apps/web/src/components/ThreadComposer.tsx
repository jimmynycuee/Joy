import type { JoyConfig } from '@joy/config'
import { ApiError, errorMessage, request } from '../api.js'
import {
  THREAD_PLACEHOLDER,
  followUpState,
  messageDeliveryStates,
  ownerActionError,
  pendingMessagesNote,
} from '../messages.js'
import { sendableAttachments } from '../attachments.js'
import type { ComposerChoice, RoleDefaults } from '../composer-choice.js'
import { useAttachments } from '../hooks/useAttachments.js'
import { useDraft } from '../storage.js'
import { roleModel } from '../labels.js'
import { taskPermissionMode, worktreeRemoved } from '../task-info.js'
import { isSwitchableMode, parsePendingSettings, settingsRequest, taskChoice } from '../task-settings.js'
import type { TaskDetails } from '../types.js'
import { useEffect, useMemo, useState } from 'react'
import { deliveryRequest } from '../queue.js'
import { Composer } from './Composer.js'
import { QueuedMessages } from './QueuedMessages.js'
import { ApproachMenu, ModelMenu, PermissionMenu } from './ComposerMenus.js'

const MAX_MESSAGE_CHARS = 20_000
const NO_COMPETE = { compete: '開始後不能改' }

/**
 * The message box at the bottom of a task thread. While the task works, Enter queues the message for the end of the
 * agent's turn (listed above the box, where it can be changed) and ⌘/Ctrl+Enter hands it to the working agent now. A
 * finished task is continued, and a plan that waits for approval is revised. The menus start at the task's own models, mode and permission mode; what the
 * owner changes there goes out with the next message and applies from the next run. The draft survives a failed send.
 */
export function ThreadComposer({
  details,
  config,
  onChanged,
  onError,
  onStop,
  stopping = false,
}: {
  details: TaskDetails
  config: JoyConfig | null
  onChanged: () => void
  onError: (message: string) => void
  /** Set while the task runs: an empty box shows a stop button. */
  onStop?: () => void
  stopping?: boolean
}) {
  const { task } = details
  const [draft, setDraft, clearDraft] = useDraft(`task-${task.id}`)
  const files = useAttachments(`task-${task.id}`)
  const [busy, setBusy] = useState(false)
  const state = followUpState({ mode: task.mode, worktreeRemoved: worktreeRemoved(details.events) })
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
  const defaults: RoleDefaults = useMemo(
    () => ({ implementer: roleModel(config, 'implementer'), reviewer: roleModel(config, 'reviewer') }),
    [config],
  )
  const external = task.provenance === 'external_content'
  const permission = taskPermissionMode(details) ?? 'ask'
  const pending = parsePendingSettings(details.pendingSettings)
  // The task's settings (and those waiting in the queue) decide where the menus start, not every refresh.
  const settingsKey = JSON.stringify([task.mode, task.roleOverrides ?? {}, permission, pending])
  const initial = useMemo(() => taskChoice(task, defaults, permission, pending), [settingsKey, defaults])
  const [choice, setChoice] = useState<ComposerChoice>(initial)
  // The server applied or queued a change (or another tab did): start from what the task uses now.
  useEffect(() => setChoice(initial), [initial])
  const switchable = isSwitchableMode(task.mode)
  const working = task.status === 'queued' || task.status === 'running' || task.status === 'awaiting_approval'

  async function send(now = false): Promise<void> {
    const text = draft.trim()
    const { ids, blocked } = sendableAttachments(files.items)
    if (blocked || (!text && !ids.length)) return
    if (text.length > MAX_MESSAGE_CHARS) {
      onError(`訊息太長了（上限 ${MAX_MESSAGE_CHARS} 字）`)
      return
    }
    setBusy(true)
    try {
      await request(`/api/tasks/${encodeURIComponent(task.id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...deliveryRequest(working, now),
          ...(ids.length ? { attachments: ids } : {}),
          ...(switchable ? settingsRequest(initial, choice, defaults) : {}),
        }),
      })
      clearDraft()
      files.clear()
      onChanged()
    } catch (cause) {
      // The draft and the picked settings stay, so the owner can send it again.
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
      <QueuedMessages
        taskId={task.id}
        messages={details.queuedMessages ?? []}
        onChanged={onChanged}
        onError={onError}
      />
      <Composer
        className="composer-chat composer-menus"
        value={draft}
        onChange={setDraft}
        onSubmit={() => send(false)}
        {...(working ? { onSubmitNow: () => send(true), nowLabel: '立即插話' } : {})}
        placeholder={state.disabled ? '' : THREAD_PLACEHOLDER}
        textareaLabel="傳訊息給任務"
        sendLabel="送出"
        busy={busy}
        disabled={state.disabled}
        attachments={{ items: files.items, onAdd: files.add, onRemove: files.remove, allowWithoutText: true }}
        completion={{
          cli: (choice.models.implementer ?? defaults.implementer).provider,
          repoId: task.repoId,
          taskId: task.id,
        }}
        {...(onStop ? { onStop, stopping, stopLabel: '停止任務' } : {})}
        bar={
          switchable && !state.disabled ? (
            <ApproachMenu
              mode={choice.mode}
              planFirst={false}
              workflows={[]}
              disabledModes={NO_COMPETE}
              onMode={(mode) => setChoice((current) => ({ ...current, mode }))}
            />
          ) : null
        }
        trailing={
          switchable && !state.disabled ? (
            <span className="composer-task-settings" data-testid="task-models">
              <PermissionMenu
                value={choice.permissionMode}
                max={details.repo?.maxPermissionMode}
                lockedReason={external ? '外部內容的任務一律要求核准' : undefined}
                onChange={(permissionMode) => setChoice((current) => ({ ...current, permissionMode }))}
              />
              <ModelMenu
                choice={choice}
                defaults={defaults}
                allowed={details.repo?.allowedProviders}
                mode={choice.mode}
                onChange={setChoice}
              />
            </span>
          ) : null
        }
      />
      {state.reason ? <p className="composer-note">{state.reason}</p> : null}
    </div>
  )
}
