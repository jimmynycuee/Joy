import { randomUUID } from 'node:crypto'
import type { AttemptId, ProposedAction, TaskId, Tier } from '@joy/core'
import type { ApprovalRecord, ApprovalStatus, Database } from '@joy/db'
import { createApproval, decideApproval, getApproval, listApprovals } from '@joy/db'
import type { Redactor } from '@joy/secrets'

export interface ApprovalRequestInput {
  taskId: TaskId
  attemptId: AttemptId
  action: ProposedAction
  tier: Tier
  /** Cross-model pre-review shown next to the request, when one ran. */
  preReview?: { provider: string; approve: boolean; summary: string }
}

export interface ApprovalBrokerOptions {
  db: Database
  redactor: Redactor
  publish: (taskId: TaskId, attemptId: AttemptId, type: string, payload: unknown) => void
}

type Listener = (approval: ApprovalRecord, preReview?: ApprovalRequestInput['preReview']) => void

/**
 * Holds red actions until a person answers through any channel (web UI now, Telegram in T2.4b).
 * The database row is the source of truth: the first decision wins, later ones are ignored.
 */
export class ApprovalBroker {
  private readonly waiters = new Map<string, (status: ApprovalStatus) => void>()
  private readonly listeners = new Set<Listener>()

  constructor(private readonly options: ApprovalBrokerOptions) {}

  /** Called for every new request, e.g. to send a Telegram message. Returns an unsubscribe function. */
  onRequested(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Waits for a decision. Resolves 'approved', 'denied' or 'expired' (no answer within `timeoutMs`, or the run
   * was cancelled).
   */
  request(input: ApprovalRequestInput, signal: AbortSignal, timeoutMs: number): Promise<ApprovalStatus> {
    const { db, redactor, publish } = this.options
    const action: ProposedAction = { ...input.action, summary: redactor.redact(input.action.summary) }
    const record = createApproval(db, {
      id: randomUUID(),
      attemptId: input.attemptId,
      action,
      tier: input.tier,
    })
    publish(input.taskId, input.attemptId, 'approval.requested', {
      approvalId: record.id,
      kind: action.kind,
      summary: action.summary,
      provenance: action.provenance,
      ...(input.preReview ? { preReview: input.preReview } : {}),
    })
    for (const listener of this.listeners) {
      try {
        listener(record, input.preReview)
      } catch {
        // A failing channel must not block the others or the request itself.
      }
    }

    return new Promise<ApprovalStatus>((resolve) => {
      const finish = (status: ApprovalStatus) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.waiters.delete(record.id)
        resolve(status)
      }
      const expire = (via: string) => {
        const decided = decideApproval(db, record.id, 'expired', via)
        if (decided) this.announce(decided)
        finish(decided?.status ?? getApproval(db, record.id)?.status ?? 'expired')
      }
      const onAbort = () => expire('cancelled')
      const timer = setTimeout(() => expire('timeout'), timeoutMs)
      timer.unref?.()
      this.waiters.set(record.id, finish)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Records a person's decision. Returns undefined when the approval does not exist or was already decided. */
  decide(
    id: string,
    decision: 'approved' | 'denied',
    via: string,
    note?: string,
  ): ApprovalRecord | undefined {
    const decided = decideApproval(
      this.options.db,
      id,
      decision,
      via,
      note ? this.options.redactor.redact(note) : undefined,
    )
    if (!decided) return undefined
    this.announce(decided)
    this.waiters.get(id)?.(decided.status)
    return decided
  }

  pending(): ApprovalRecord[] {
    return listApprovals(this.options.db, { status: 'pending' })
  }

  private announce(record: ApprovalRecord): void {
    this.options.publish(record.taskId, record.attemptId, 'approval.decided', {
      approvalId: record.id,
      status: record.status,
      via: record.decidedVia,
      ...(record.note ? { note: record.note } : {}),
    })
  }
}
