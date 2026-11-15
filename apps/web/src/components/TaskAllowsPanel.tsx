import { useState } from 'react'
import { errorMessage, request } from '../api.js'
import { relativeTime } from '../dates.js'
import type { TaskAllow, TaskAllowKind } from '../types.js'
import { Button } from './ui.js'

const KIND_LABELS: Record<TaskAllowKind, string> = {
  shell: '指令',
  file_write: '寫入',
  file_read: '讀取',
  network: '網路',
  mcp: 'MCP',
}

export function taskAllowKindLabel(kind: string): string {
  return KIND_LABELS[kind as TaskAllowKind] ?? kind
}

/** What the owner allowed for the rest of this task (in the ⋯ menu), each with a way to take it back. */
export function TaskAllowsPanel({
  taskId,
  allows,
  onChanged,
}: {
  taskId: string
  allows: readonly TaskAllow[]
  onChanged: () => void
}) {
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')

  async function revoke(id: string) {
    setBusy(id)
    setFailure('')
    try {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/allows/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      onChanged()
    } catch (cause) {
      setFailure(errorMessage(cause, '無法撤銷'))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="panel-content">
      {failure ? <p className="form-error">{failure}</p> : null}
      <ul className="checkpoint-list" aria-label="這個任務內允許的動作">
        {allows.map((allow) => (
          <li key={allow.id} className="checkpoint-item">
            <div className="checkpoint-copy">
              <span className="muted">
                {taskAllowKindLabel(allow.kind)}
                {allow.createdAt ? ` · ${relativeTime(allow.createdAt)}` : ''}
              </span>
              <code className="allow-target">{allow.target}</code>
            </div>
            <Button
              disabled={busy === allow.id}
              aria-label={`撤銷：${allow.target}`}
              onClick={() => void revoke(allow.id)}
            >
              撤銷
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
