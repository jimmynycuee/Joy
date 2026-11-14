import { useState } from 'react'
import { ApiError, errorMessage, request } from '../api.js'
import { usePrStatus } from '../hooks/usePrStatus.js'
import { ownerActionError } from '../messages.js'
import { checksSummary, ciFixMessage, prStateLabel, prTone } from '../pr-status.js'
import { Button, CopyButton, Icon } from './ui.js'

/**
 * State and CI of the pull request a task opened. When checks fail it can ask the agent to fix them, as long as the
 * task still has its worktree (Joy removes it after publishing, so this usually points at a new task instead).
 */
export function PrStatusCard({
  taskId,
  canAskAgent,
  onChanged,
  onError,
}: {
  taskId: string
  /** Whether a follow-up message can reach the agent: the worktree still exists and the task is not a compete task. */
  canAskAgent: boolean
  onChanged: () => void
  onError: (message: string) => void
}) {
  const { status, error, refresh } = usePrStatus(taskId, true)
  const [sending, setSending] = useState(false)

  if (!status) {
    return error ? (
      <div className="pr-status muted" data-testid="pr-status">
        <Icon name="git-pr" size={14} />
        <span>{error}</span>
        <Button variant="ghost" onClick={refresh}>
          重新整理
        </Button>
      </div>
    ) : null
  }

  const { checks } = status
  const summary = checksSummary(checks)
  const failing = checks.failing > 0

  async function askAgent() {
    if (!status) return
    setSending(true)
    try {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
        method: 'POST',
        // A CI fix can wait for the agent's next turn; it should not stop what the agent is doing.
        body: JSON.stringify({ text: ciFixMessage(status.checks.failingNames), interrupt: false }),
      })
      onChanged()
    } catch (cause) {
      onError(
        ownerActionError(
          cause instanceof ApiError ? cause.status : undefined,
          errorMessage(cause, ''),
          '無法送出訊息',
        ),
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="card pr-status" aria-label="PR 狀態" data-testid="pr-status">
      <div className="pr-status-head">
        <Icon name="git-pr" size={16} />
        <strong>PR 狀態</strong>
        <span className={`chip pr-chip pr-${prTone(status)}`}>{prStateLabel(status)}</span>
        {summary ? (
          <span className={failing ? 'pr-checks pr-checks-failing' : 'pr-checks'}>{summary}</span>
        ) : (
          <span className="muted">還沒有檢查</span>
        )}
        <Button variant="ghost" className="pr-refresh" onClick={refresh}>
          重新整理
        </Button>
      </div>
      {failing ? (
        <div className="pr-failing">
          {checks.failingNames.length > 0 ? (
            <ul aria-label="失敗的檢查">
              {checks.failingNames.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {canAskAgent ? (
            <Button variant="primary" disabled={sending} onClick={() => void askAgent()}>
              請 agent 修正 CI
            </Button>
          ) : (
            <p className="muted">
              工作副本已移除，agent 不能接續修正。
              <CopyButton text={ciFixMessage(checks.failingNames)} label="複製修正 CI 的說明" />
            </p>
          )}
        </div>
      ) : null}
    </section>
  )
}
