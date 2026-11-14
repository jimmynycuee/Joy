import { parseTimestamp } from './dates.js'
import type { ConversationSummary, Task } from './types.js'

/** One row of the sidebar's single 最近 list: a task or an assistant conversation. */
export type RecentItem =
  | { kind: 'task'; id: string; time: string | undefined; task: Task }
  | { kind: 'conversation'; id: string; time: string | undefined; conversation: ConversationSummary }

export const NEW_CONVERSATION_TITLE = '新對話'

function matches(text: string | undefined, query: string): boolean {
  return (text ?? '').toLowerCase().includes(query)
}

/** Time of the last activity: `updatedAt` when there is one, else the creation time. */
function activityTime(item: { updatedAt?: string | undefined; createdAt: string }): string | undefined {
  return item.updatedAt || item.createdAt || undefined
}

/** Newest activity first; items without a usable timestamp count as newest and keep their given order. */
function newestFirst<T>(items: readonly T[], timeOf: (item: T) => string | undefined): T[] {
  const rank = (item: T) => parseTimestamp(timeOf(item)) ?? Number.POSITIVE_INFINITY
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ra = rank(a.item)
      const rb = rank(b.item)
      if (ra === rb) return a.index - b.index
      return rb > ra ? 1 : -1
    })
    .map(({ item }) => item)
}

/** Tasks, most recently active first (for 設定 → 已封存). */
export function sortTasksByActivity(tasks: readonly Task[]): Task[] {
  return newestFirst(tasks, activityTime)
}

/**
 * Tasks and conversations mixed into one list, most recent activity first. Archived tasks are left out (they live in
 * 設定 → 已封存). `query` (already lower-cased) keeps only matching titles and task prompts. Items without a usable
 * timestamp count as newest, like `groupByDay`, and keep their given order among themselves.
 */
export function recentItems(
  tasks: readonly Task[],
  conversations: readonly ConversationSummary[],
  query = '',
): RecentItem[] {
  const items: RecentItem[] = [
    ...tasks
      .filter((task) => !task.archived)
      .filter((task) => !query || matches(task.title, query) || matches(task.prompt, query))
      .map((task): RecentItem => ({ kind: 'task', id: task.id, time: activityTime(task), task })),
    ...conversations
      .filter((conversation) => !query || matches(conversation.title ?? NEW_CONVERSATION_TITLE, query))
      .map((conversation): RecentItem => ({
        kind: 'conversation',
        id: conversation.id,
        time: activityTime(conversation),
        conversation,
      })),
  ]
  return newestFirst(items, (item) => item.time)
}
