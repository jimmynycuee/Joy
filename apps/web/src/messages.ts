import { record } from './types.js'
import type { TaskEvent } from './types.js'

// What happens to the owner's messages in a task thread: delivery state from the event log, the composer's
// wording for each task state, and the toast text for the errors the messages endpoint can answer with.

/**
 * `sent`: the agent got it right away (follow-up or plan revision). `steering`: being handed to the working agent,
 * which keeps going and takes it into account. `interrupting`: the owner asked to stop the agent's current step; the
 * message is handed to it as soon as the step has stopped. `queued`: the agent could not take it now (a review, checks,
 * an approval, a quota wait, a backend that cannot take input mid-run) and it waits for the agent's next turn.
 * `held`: queued, but the task stopped at a time or cost limit, so nothing goes to the agent until the owner presses
 * Continue or sends another message. `delivered` and `discarded` end a pending message's life.
 * `lost`: still unresolved although the server no longer holds it (Joy restarted; the queue is in memory only).
 */
export type DeliveryState =
  'sent' | 'steering' | 'interrupting' | 'queued' | 'held' | 'delivered' | 'discarded' | 'lost'

const PENDING_STATES = new Set<DeliveryState>(['steering', 'interrupting', 'queued', 'held'])

/** What the owner does to get held messages to the agent; also the line under the composer. */
export const HELD_MESSAGES_NOTE = '任務因上限停下，按「繼續」或再送訊息才會帶給 agent'

function ids(payload: Record<string, unknown> | null): string[] {
  return Array.isArray(payload?.ids) ? payload.ids.filter((id): id is string => typeof id === 'string') : []
}

/**
 * The delivery state of every `user.message`, by message id. `queuedIds` (the server's current queue, from the task
 * details) and `busy` let a message that outlived a Joy restart show as lost instead of waiting forever.
 */
export function messageDeliveryStates(
  events: readonly TaskEvent[],
  options: { queuedIds?: ReadonlySet<string>; busy?: boolean } = {},
): Map<string, DeliveryState> {
  const delivered = new Set<string>()
  const discarded = new Set<string>()
  const requeued = new Set<string>()
  const held = new Set<string>()
  for (const event of events) {
    if (event.type === 'user.message.held') for (const id of ids(record(event.payload))) held.add(id)
    if (event.type === 'user.message.delivered')
      for (const id of ids(record(event.payload))) delivered.add(id)
    if (event.type === 'user.message.discarded')
      for (const id of ids(record(event.payload))) discarded.add(id)
    // A steer or an interrupt that did not happen (the turn ended, a limit stopped the run) leaves the message queued.
    if (event.type === 'user.message.requeued') for (const id of ids(record(event.payload))) requeued.add(id)
  }
  const states = new Map<string, DeliveryState>()
  for (const event of events) {
    if (event.type !== 'user.message') continue
    const payload = record(event.payload)
    if (typeof payload?.id !== 'string') continue
    let state: DeliveryState =
      payload.delivery === 'queued'
        ? 'queued'
        : payload.delivery === 'interrupt'
          ? 'interrupting'
          : payload.delivery === 'steer'
            ? 'steering'
            : 'sent'
    if ((state === 'interrupting' || state === 'steering') && requeued.has(payload.id)) state = 'queued'
    if (state === 'queued' && held.has(payload.id)) state = 'held'
    if (PENDING_STATES.has(state)) {
      if (discarded.has(payload.id)) state = 'discarded'
      else if (delivered.has(payload.id)) state = 'delivered'
      else if (options.queuedIds && !options.busy && !options.queuedIds.has(payload.id)) state = 'lost'
    }
    states.set(payload.id, state)
  }
  return states
}

/** The small tag under a bubble; only the states the owner should notice have one. */
export function deliveryTag(state: DeliveryState): string | undefined {
  if (state === 'steering') return '正在交給 agent…'
  if (state === 'delivered') return '已交給 agent'
  if (state === 'interrupting') return '正在打斷 agent…'
  if (state === 'queued') return '排隊中'
  if (state === 'held') return '已停下，等你繼續'
  if (state === 'discarded') return '已撤回'
  if (state === 'lost') return '未送達'
  return undefined
}

/** The line above the composer about messages the agent has not read yet, if any. */
export function pendingMessagesNote(states: ReadonlyMap<string, DeliveryState>): string | undefined {
  const values = [...states.values()]
  const interrupting = values.filter((state) => state === 'interrupting').length
  const queued = values.filter((state) => state === 'queued').length
  if (values.includes('held')) return HELD_MESSAGES_NOTE
  if (interrupting > 0) return '正在打斷 agent 目前這一步，停下來後會帶著你的訊息繼續'
  if (values.includes('steering')) return '正在把訊息交給 agent，它不會停下來'
  if (queued > 0)
    return `${queued} 則訊息排隊中，agent 下一次動手時會帶給它（審查、檢查與等待核准時不能即時補充）`
  return undefined
}

export interface FollowUpState {
  disabled: boolean
  /** Why the composer is off; shown instead of the box. */
  reason?: string
}

/** What the box says in every state: how a message gets delivered shows on the message itself, not here. */
export const THREAD_PLACEHOLDER = '傳訊息給 Joy'

/** The thread composer for a task: off for compete tasks and removed worktrees, on otherwise. */
export function followUpState(input: { mode: string; worktreeRemoved: boolean }): FollowUpState {
  if (input.mode === 'compete')
    return {
      disabled: true,
      reason: '比賽任務不能接續交代；請從兩個方案裡挑一個，或開一個新任務。',
    }
  if (input.worktreeRemoved)
    return {
      disabled: true,
      reason: '這個任務的工作副本已經移除（開 PR 或丟掉變更後會移除），不能再接續；請開一個新任務。',
    }
  return { disabled: false }
}

/** Chinese text for a failed owner action on a task: a message, a plan decision, a checkpoint restore. */
export function ownerActionError(status: number | undefined, message: string, fallback: string): string {
  if (status === 404) return '找不到這個項目，可能已經被移除'
  if (status === 429) return '排隊中的訊息太多了，等 agent 讀完再送'
  if (status === 409) {
    if (/Another action on this task/i.test(message)) return '這個任務正在處理另一個動作，請稍後再送'
    if (/worktree was already removed/i.test(message)) return '工作副本已經移除，不能再接續；請開一個新任務'
    if (/Compete tasks/i.test(message)) return '比賽任務不能接續交代'
    if (/no plan waiting/i.test(message)) return '這份計畫已經處理過了'
    if (/^Task is (queued|running|awaiting_approval)/i.test(message))
      return '任務還在進行中，請先停止或等它結束'
    if (/checkpoint.*already removed|no worktree to restore/i.test(message))
      return '這個檢查點的工作副本已經移除，不能還原'
    return '這個任務現在的狀態不能這樣做，重新整理後再試'
  }
  return message || fallback
}
