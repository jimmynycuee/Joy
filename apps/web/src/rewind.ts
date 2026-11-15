import { record } from './types.js'
import type { TaskEvent } from './types.js'

// Going back to an earlier round (`POST /api/tasks/:id/rewind`): which owner messages can be gone back to, which part
// of the thread the owner already went back over, and what to ask before the server's 409s that want a confirmation.

/** A round the owner can go back to, as `GET /api/tasks/:id` lists it. `task` is the task's own prompt. */
export interface RewindPoint {
  messageId: string
  ids: string[]
}

export const TASK_ROUND = 'task'

export function parseRewindPoints(value: unknown): RewindPoint[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const fields = record(item)
    if (typeof fields?.messageId !== 'string') return []
    const ids = Array.isArray(fields.ids)
      ? fields.ids.filter((id): id is string => typeof id === 'string')
      : []
    return [{ messageId: fields.messageId, ids }]
  })
}

/** Owner message id → the round to send to the server; the round's first message carries the button. */
export function rewindTargets(points: readonly RewindPoint[]): Map<string, string> {
  const targets = new Map<string, string>()
  for (const point of points) targets.set(point.ids[0] ?? point.messageId, point.messageId)
  return targets
}

/** What the owner discarded by going back: whole seq ranges, plus earlier-sent messages delivered in them. */
export function rewoundParts(events: readonly TaskEvent[]): {
  inRange: (seq: number) => boolean
  messageIds: Set<string>
} {
  const ranges: Array<[number, number]> = []
  const messageIds = new Set<string>()
  for (const event of events) {
    if (event.type !== 'task.rewound') continue
    const payload = record(event.payload)
    if (typeof payload?.fromSeq === 'number' && payload.fromSeq < event.seq)
      ranges.push([payload.fromSeq, event.seq])
    if (Array.isArray(payload?.discardedIds))
      for (const id of payload.discardedIds) if (typeof id === 'string') messageIds.add(id)
  }
  return { inRange: (seq) => ranges.some(([from, to]) => seq >= from && seq < to), messageIds }
}

/**
 * The question for a 409 that a confirmation can get past (a pull request, commits the restore would drop), or
 * undefined when the refusal is about something else.
 */
export function rewindConfirmQuestion(message: string): string | undefined {
  if (/pull request/i.test(message))
    return '這個任務已經開了 PR。重做只會改這台電腦上的分支，PR 要等你再推送才會更新。'
  const commits = /would discard (\d+) commits?/.exec(message)
  if (commits) return `重做會丟掉之後的 ${commits[1]} 個 commit。`
  return undefined
}
