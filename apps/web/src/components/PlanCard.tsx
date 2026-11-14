import { useState } from 'react'
import { ApiError, errorMessage, request } from '../api.js'
import { ownerActionError } from '../messages.js'
import { planReviewView } from '../timeline.js'
import type { PendingPlan } from '../types.js'
import { Markdown } from './Markdown.js'
import { Mascot } from './Mascot.js'
import { ReviewCard } from './Thread.js'
import { Button } from './ui.js'

/** The plan the agent wrote, waiting at the end of the thread for approval (or for a message that revises it). */
export function PlanCard({
  taskId,
  plan,
  onChanged,
  onError,
}: {
  taskId: string
  plan: PendingPlan
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const review = planReviewView(plan.review)

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision)
    try {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/plan/${decision}`, {
        method: 'POST',
        body: '{}',
      })
      onChanged()
    } catch (cause) {
      onError(
        ownerActionError(
          cause instanceof ApiError ? cause.status : undefined,
          errorMessage(cause, ''),
          decision === 'approve' ? '無法核准計畫' : '無法取消任務',
        ),
      )
      // A plan that was already decided elsewhere should disappear from this page.
      if (cause instanceof ApiError && cause.status === 409) onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card plan-card" aria-label="等你核准的計畫" data-testid="plan-card">
      <header className="plan-head">
        <Mascot mood="waiting" size={32} decorative />
        <strong>計畫等你核准</strong>
      </header>
      {plan.plan ? <Markdown text={plan.plan} /> : <p className="muted">agent 沒有寫出計畫內容。</p>}
      {review ? <ReviewCard entry={review} /> : null}
      <p className="muted plan-hint">想調整的話，在下面輸入要怎麼改，agent 會重寫計畫。</p>
      <div className="button-row">
        <Button variant="primary" disabled={busy !== null} onClick={() => void decide('approve')}>
          核准並開始實作
        </Button>
        <Button variant="danger" disabled={busy !== null} onClick={() => void decide('reject')}>
          取消任務
        </Button>
      </div>
    </section>
  )
}
