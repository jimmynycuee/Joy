import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage, removeWithConfirmation, request } from '../api.js'
import { safeHref } from '../markdown.js'
import { hasUnpublishedChanges, worktreeRemoved } from '../task-info.js'
import { policyEventTitle } from '../policy-events.js'
import { record } from '../types.js'
import type { TaskDetails, WorkspaceDiff } from '../types.js'
import { DiffCode } from './DiffView.js'
import { Mascot } from './Mascot.js'
import { Button, ButtonLink } from './ui.js'

interface PendingApproval {
  id: string
  taskId: string
  createdAt: string
  status: string
  decidedVia?: string
  action: { kind: string; summary: string; provenance: string }
}

/** Red actions waiting for the owner in this task, with Approve / Deny. Refreshes on approval events. */
export function ApprovalsPanel({
  taskId,
  taskStatus,
  approvalEvents,
}: {
  taskId: string
  taskStatus: string
  approvalEvents: number
}) {
  const [pending, setPending] = useState<PendingApproval[]>([])
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')

  useEffect(() => {
    let cancelled = false
    // A paused task also shows the request that timed out, so it can still be approved and resumed.
    const paused = taskStatus === 'awaiting_approval' || taskStatus === 'failed'
    const load = () =>
      request<{ approvals: PendingApproval[] }>(`/api/approvals?taskId=${encodeURIComponent(taskId)}`)
        .then((body) => {
          // Never trust the shape of a response: a missing list must not take the whole page down.
          const all = Array.isArray(body.approvals) ? body.approvals : []
          const open = all.filter(
            (approval) =>
              approval.status === 'pending' ||
              (paused && approval.status === 'expired' && approval.decidedVia === 'timeout'),
          )
          if (!cancelled) setPending(open)
        })
        .catch(() => undefined)
    void load()
    // Events usually trigger the refresh; the timer catches approvals that expire quietly.
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [taskId, taskStatus, approvalEvents])

  async function decide(id: string, decision: 'approve' | 'deny') {
    setBusy(id)
    setFailure('')
    try {
      await request(`/api/approvals/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: '{}' })
      setPending((current) => current.filter((approval) => approval.id !== id))
    } catch (error) {
      setFailure(errorMessage(error, '無法記錄你的決定'))
    } finally {
      setBusy('')
    }
  }

  if (pending.length === 0) return null
  return (
    <section className="card approvals-card" aria-label="等你同意的動作" data-testid="pending-approvals">
      <h2 className="approvals-title">
        <Mascot mood="waiting" size={32} decorative />
        {pending.some((a) => a.status === 'expired') ? '已暫停，等你同意後繼續' : '需要你同意'}
      </h2>
      {failure ? <p className="form-error">{failure}</p> : null}
      {pending.map((approval) => (
        <div className="approval-row" key={approval.id}>
          <div className="approval-copy">
            <strong>
              {policyEventTitle('policy.action', {
                kind: approval.action.kind,
                tier: 'approve',
                provenance: approval.action.provenance,
              })}
            </strong>
            <p>{approval.action.summary}</p>
          </div>
          <div className="button-row">
            <Button
              variant="primary"
              disabled={busy === approval.id}
              onClick={() => void decide(approval.id, 'approve')}
            >
              {approval.status === 'expired' ? '同意並繼續' : '同意'}
            </Button>
            <Button
              variant="danger"
              disabled={busy === approval.id}
              onClick={() => void decide(approval.id, 'deny')}
            >
              拒絕
            </Button>
          </div>
        </div>
      ))}
    </section>
  )
}

type CompeteJudgement = {
  winner: string | null
  reasons: string
  attempts: Array<{ attemptId: string; strengths: string; weaknesses: string }>
  mergeRecommended: boolean
}

/** Compete mode (T2.1): the attempts side by side with their reviews and the judge's reasons. */
export function ComparePanel({ details, onChanged }: { details: TaskDetails; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const events = details.events
  const latest = (type: string) => record([...events].reverse().find((event) => event.type === type)?.payload)
  const judged = latest('compete.judgement')
  const judgement = record(judged?.judgement) as CompeteJudgement | undefined
  const labels = new Map<string, string>()
  for (const outcome of Array.isArray(judged?.outcomes) ? judged.outcomes : []) {
    const item = record(outcome)
    if (typeof item?.attemptId === 'string' && typeof item.label === 'string')
      labels.set(item.attemptId, item.label)
  }
  const mergeId = latest('compete.merge_started')?.attemptId
  const chosenId = latest('compete.chosen')?.attemptId
  const results = new Map<string, Record<string, unknown>>()
  for (const event of events)
    if (event.type === 'compete.result' && event.attemptId) {
      const payload = record(event.payload)
      if (payload) results.set(event.attemptId, payload)
    }
  const attempts = details.attempts
    .map((attempt) => record(attempt))
    .filter((attempt): attempt is Record<string, unknown> => typeof attempt?.id === 'string')
  const reviews = details.reviews.map((review) => record(review)).filter(Boolean) as Array<
    Record<string, unknown>
  >
  const ready = details.task.status === 'review_ready'
  const finishedCount = attempts.filter(
    (a) => a.id !== mergeId && results.get(String(a.id))?.status === 'succeeded',
  ).length
  const mergeResult = typeof mergeId === 'string' ? results.get(mergeId) : undefined
  const canMerge =
    ready &&
    judgement &&
    finishedCount >= 2 &&
    (!mergeId || (mergeResult && mergeResult.status !== 'succeeded'))

  async function act(path: string, body: object) {
    setBusy(true)
    setFailure('')
    try {
      await request(`/api/tasks/${encodeURIComponent(details.task.id)}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      onChanged()
    } catch (error) {
      setFailure(errorMessage(error, '操作失敗'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="compare-panel" aria-label="比較兩個方案" data-testid="compare-panel">
      {judgement ? (
        <div className="card judge-box" aria-label="裁判">
          <p className="eyebrow">裁判</p>
          <p>
            {judgement.winner ? (
              <strong>選 {labels.get(judgement.winner) ?? '其中一個方案'}。</strong>
            ) : (
              <strong>兩個方案都不夠好。</strong>
            )}{' '}
            {judgement.reasons}
          </p>
          {judgement.mergeRecommended ? <p className="muted">裁判認為合併兩邊會更好。</p> : null}
        </div>
      ) : details.task.status === 'running' ? (
        <p className="muted">兩個方案都在進行中；兩邊都審查完後，裁判會比較。</p>
      ) : null}
      <div className="compare-columns">
        {attempts.map((attempt) => {
          const id = String(attempt.id)
          const result = results.get(id)
          const resultDiff = record(result?.diff) as WorkspaceDiff | undefined
          const review = reviews.filter((r) => r.attemptId === id).at(-1)
          const notes = judgement?.attempts.find((a) => a.attemptId === id)
          const label = id === mergeId ? '合併版' : (labels.get(id) ?? '方案')
          return (
            <article
              key={id}
              className={id === chosenId ? 'card compare-column chosen' : 'card compare-column'}
              aria-label={`方案 ${label}`}
            >
              <header>
                <strong>{label}</strong>
                <span className="muted">
                  {' '}
                  {String(attempt.provider)} · {String(attempt.model)}
                </span>
                {judgement?.winner === id ? <span className="chip chip-accent">裁判推薦</span> : null}
                {id === chosenId ? <span className="chip chip-accent">已選定</span> : null}
              </header>
              <p className="muted">
                {result
                  ? result.status === 'succeeded'
                    ? review
                      ? `審查：${review.approve ? '通過' : '要求修改'}${review.summary ? ` — ${String(review.summary)}` : ''}`
                      : '完成'
                    : `${String(result.status)}${result.reason ? `: ${String(result.reason)}` : ''}`
                  : '進行中…'}
              </p>
              {notes ? (
                <p className="compare-notes">
                  <span>+ {notes.strengths}</span>
                  <span>− {notes.weaknesses}</span>
                </p>
              ) : null}
              {resultDiff ? (
                <DiffCode patch={resultDiff.patch} className="compare-diff" label={`差異 ${label}`} />
              ) : null}
              {ready && result?.status === 'succeeded' && resultDiff ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void act('choose', { attemptId: id })}
                >
                  選 {label}
                </Button>
              ) : null}
            </article>
          )
        })}
      </div>
      {canMerge ? (
        <Button variant="secondary" disabled={busy} onClick={() => void act('merge', {})}>
          合併：由裁判綜合兩邊的優點重做一版
        </Button>
      ) : null}
      {failure ? <p className="form-error">{failure}</p> : null}
    </section>
  )
}

/** Throws away a finished task's worktrees (T2.8). */
export function DiscardButton({ details, onChanged }: { details: TaskDetails; onChanged: () => void }) {
  const [failure, setFailure] = useState('')
  const finished = ['done', 'review_ready', 'failed', 'cancelled'].includes(details.task.status)
  const removed = details.events.some((event) => event.type === 'worktree.removed')
  const published = details.events.some((event) => event.type === 'publish.done')
  if (!finished || removed || published) return null
  return (
    <div className="action-stack">
      <Button
        variant="danger"
        icon="trash"
        onClick={() => {
          if (!window.confirm('要丟掉這個任務的工作副本和所有變更嗎？')) return
          setFailure('')
          void removeWithConfirmation(`/api/tasks/${encodeURIComponent(details.task.id)}/discard`, {})
            .then(onChanged)
            .catch((error: unknown) => setFailure(errorMessage(error, '無法丟棄')))
        }}
      >
        丟掉這些變更
      </Button>
      {failure ? <p className="form-error">{failure}</p> : null}
    </div>
  )
}

export function PublishPanel({ details, onChanged }: { details: TaskDetails; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const published = [...details.events].reverse().find((event) => event.type === 'publish.done')
  const prPayload = record(published?.payload)?.pullRequestUrl
  // Only open links that are http(s); the URL comes from the GitHub CLI's output.
  const prUrl = typeof prPayload === 'string' ? safeHref(prPayload) : undefined
  const remote = details.repo?.githubRemote
  const canPushUpdate =
    Boolean(prUrl) && !worktreeRemoved(details.events) && hasUnpublishedChanges(details.events)

  if (details.task.status !== 'done' || !details.repo) return null

  async function setRemote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('github-remote') ?? '').trim()
    if (!value || !details.repo) return
    setFailure('')
    try {
      await request(`/api/repos/${encodeURIComponent(details.repo.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ githubRemote: value }),
      })
      onChanged()
    } catch (error) {
      setFailure(errorMessage(error, '無法儲存 GitHub 網址'))
    }
  }

  async function publishTask() {
    setBusy(true)
    setFailure('')
    try {
      await request(`/api/tasks/${encodeURIComponent(details.task.id)}/publish`, {
        method: 'POST',
        body: '{}',
      })
      onChanged()
    } catch (error) {
      setFailure(errorMessage(error, '開 PR 失敗'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="publish-panel" data-testid="publish-panel">
      {prUrl ? (
        <div className="pr-row">
          <a href={prUrl} target="_blank" rel="noreferrer noopener" className="pr-link">
            已開 PR
          </a>
          {canPushUpdate ? (
            <Button variant="primary" icon="git-pr" disabled={busy} onClick={() => void publishTask()}>
              {busy ? '正在推送…' : '推送更新到 PR'}
            </Button>
          ) : null}
          <ButtonLink href={prUrl} variant="secondary" icon="external">
            查看 PR
          </ButtonLink>
        </div>
      ) : remote ? (
        <Button variant="primary" icon="git-pr" disabled={busy} onClick={() => void publishTask()}>
          {busy ? '正在開 draft PR…' : '開 draft PR'}
        </Button>
      ) : (
        <form className="field-stack" onSubmit={(event) => void setRemote(event)}>
          <label htmlFor="github-remote">第一次開 PR：填入 GitHub repo 網址</label>
          <div className="input-row">
            <input
              id="github-remote"
              name="github-remote"
              placeholder="https://github.com/owner/repo.git"
              required
            />
            <Button variant="secondary" type="submit">
              儲存
            </Button>
          </div>
        </form>
      )}
      {failure ? <p className="form-error">{failure}</p> : null}
    </div>
  )
}
