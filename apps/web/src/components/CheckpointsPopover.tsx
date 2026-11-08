import { useCallback, useEffect, useState } from 'react'
import { ApiError, errorMessage, request } from '../api.js'
import { discardedCommitCount, mapCheckpoints } from '../checkpoints.js'
import type { CheckpointView } from '../checkpoints.js'
import { relativeTime } from '../dates.js'
import { ownerActionError } from '../messages.js'
import { Popover } from './Popover.js'
import { Button } from './ui.js'

/**
 * The task's checkpoints: a snapshot after each implementer turn. Restoring needs the task to be idle; when it would
 * drop commits made since, the owner confirms in the page (no browser dialog) and the restore is retried with confirm.
 */
export function CheckpointsPopover({
  taskId,
  count,
  working,
  onChanged,
}: {
  taskId: string
  /** Number of checkpoint events seen so far; a change reloads the list while it is open. */
  count: number
  working: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<CheckpointView[] | null>(null)
  const [loadFailure, setLoadFailure] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<{ n: number; commits: number } | null>(null)
  const [failure, setFailure] = useState('')

  const load = useCallback(async () => {
    try {
      setItems(mapCheckpoints(await request<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/checkpoints`)))
      setLoadFailure('')
    } catch (cause) {
      setLoadFailure(errorMessage(cause, '無法載入檢查點'))
    }
  }, [taskId])

  useEffect(() => {
    if (open) void load()
  }, [open, count, load])

  async function restore(n: number, confirm: boolean) {
    setBusy(n)
    setFailure('')
    try {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/checkpoints/${n}/restore`, {
        method: 'POST',
        body: JSON.stringify(confirm ? { confirm: true } : {}),
      })
      setConfirming(null)
      onChanged()
      await load()
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : undefined
      const message = errorMessage(cause, '')
      const commits = status === 409 && !confirm ? discardedCommitCount(message) : undefined
      if (commits !== undefined) setConfirming({ n, commits })
      else {
        setConfirming(null)
        setFailure(ownerActionError(status, message, '無法還原檢查點'))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <Popover
      icon="clock"
      label="檢查點"
      buttonLabel={`檢查點（${count}）`}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setConfirming(null)
          setFailure('')
        }
      }}
    >
      <h2 className="popover-title">檢查點</h2>
      <p className="muted">
        每次 agent 完成一輪，Joy 會存一份工作副本的快照。還原前會先把目前的狀態另存成新的檢查點。
      </p>
      {working ? <p className="notice-line">任務進行中，先停止或等它結束才能還原。</p> : null}
      {loadFailure ? <p className="form-error">{loadFailure}</p> : null}
      {failure ? <p className="form-error">{failure}</p> : null}
      {items === null && !loadFailure ? <p className="muted">載入中…</p> : null}
      {items?.length === 0 ? <p className="muted">還沒有檢查點。</p> : null}
      <ul className="checkpoint-list" aria-label="檢查點列表">
        {items?.map((item) => (
          <li key={item.n} className="checkpoint-item">
            <div className="checkpoint-copy">
              <strong>檢查點 {item.n}</strong>
              <span className="muted">
                {item.label}
                {item.createdAt ? ` · ${relativeTime(item.createdAt)}` : ''}
              </span>
              {!item.available ? <span className="muted">工作副本已移除，不能還原</span> : null}
              {confirming?.n === item.n ? (
                <div className="checkpoint-confirm" role="alert">
                  <p>
                    還原到這裡會<strong>丟掉之後的 {confirming.commits} 個 commit</strong>
                    。目前的狀態會先另存成新的檢查點，之後還能還原回來。
                  </p>
                  <div className="button-row">
                    <Button
                      variant="danger"
                      disabled={busy !== null}
                      onClick={() => void restore(item.n, true)}
                    >
                      丟掉並還原
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <Button
              disabled={working || !item.available || busy !== null || confirming?.n === item.n}
              aria-label={`還原到檢查點 ${item.n}`}
              onClick={() => void restore(item.n, false)}
            >
              還原到這裡
            </Button>
          </li>
        ))}
      </ul>
    </Popover>
  )
}
