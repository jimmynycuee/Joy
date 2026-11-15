import { parseTimestamp } from './dates.js'
import type { RecentItem } from './recent.js'
import type { Task } from './types.js'

/*
 * What the sidebar shows besides the plain search result: pinned rows, the rows of one project, and the 最近項目
 * filter. Everything here is a pure function of the rows, so the component only draws.
 */

/** A task whose work waits for the owner: an approval, or a review with findings (or a plan, or a pick). */
export function waitsForYou(task: Task): boolean {
  return task.status === 'awaiting_approval' || task.status === 'review_ready'
}

function pinnedAtOf(item: RecentItem): string | undefined {
  return item.kind === 'task' ? item.task.pinnedAt : item.conversation.pinnedAt
}

/** The pinned rows, the one pinned last first. Archived tasks are never in `items`, so they never show here. */
export function pinnedRows(items: readonly RecentItem[]): RecentItem[] {
  return items
    .map((item, index) => ({ item, index, at: parseTimestamp(pinnedAtOf(item)) }))
    .filter((entry) => pinnedAtOf(entry.item) !== undefined)
    .sort((a, b) => {
      // A pin time that cannot be read counts as the newest, like an activity time that cannot be read.
      const ra = a.at ?? Number.POSITIVE_INFINITY
      const rb = b.at ?? Number.POSITIVE_INFINITY
      return ra === rb ? a.index - b.index : rb > ra ? 1 : -1
    })
    .map((entry) => entry.item)
}

/** Everything that is not pinned, in the order given. */
export function unpinnedRows(items: readonly RecentItem[]): RecentItem[] {
  return items.filter((item) => pinnedAtOf(item) === undefined)
}

/** The tasks of one project, in the order given (newest first). */
export function tasksOfProject(
  items: readonly RecentItem[],
  repoId: string,
): Array<RecentItem & { kind: 'task' }> {
  return items.filter(
    (item): item is RecentItem & { kind: 'task' } => item.kind === 'task' && item.task.repoId === repoId,
  )
}

export type StatusFilter = 'all' | 'waiting' | 'running' | 'done' | 'failed'
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'waiting', 'running', 'done', 'failed']

export interface RecentFilter {
  status: StatusFilter
  /** Only this project's tasks; null means every project. */
  repoId: string | null
}
export const NO_FILTER: RecentFilter = { status: 'all', repoId: null }

export function isFiltering(filter: RecentFilter): boolean {
  return filter.status !== 'all' || filter.repoId !== null
}

function statusGroup(task: Task): Exclude<StatusFilter, 'all'> {
  if (waitsForYou(task)) return 'waiting'
  if (task.status === 'running' || task.status === 'queued') return 'running'
  if (task.status === 'done') return 'done'
  // failed and cancelled: what did not finish.
  return 'failed'
}

/**
 * The rows that pass the filter. A conversation has no status and no project, so it only shows while nothing is
 * filtered.
 */
export function applyFilter(items: readonly RecentItem[], filter: RecentFilter): RecentItem[] {
  if (!isFiltering(filter)) return [...items]
  return items.filter((item) => {
    if (item.kind !== 'task') return false
    if (filter.repoId !== null && item.task.repoId !== filter.repoId) return false
    return filter.status === 'all' || statusGroup(item.task) === filter.status
  })
}

/** What the sidebar remembers between visits (localStorage): folded sections, and projects opened to show their tasks. */
export interface SidebarMemory {
  /** Section keys (`projects`, `recent`) the owner folded. Both start open. */
  collapsed: ReadonlySet<string>
  /** Ids of the projects whose tasks are shown. Every project starts closed. */
  open: ReadonlySet<string>
}

export const SIDEBAR_MEMORY_KEY = 'joy.sidebar.v2'
export const PROJECTS_SECTION = 'projects'
export const RECENT_SECTION = 'recent'

export const EMPTY_MEMORY: SidebarMemory = { collapsed: new Set(), open: new Set() }

function strings(value: unknown): Set<string> {
  return Array.isArray(value)
    ? new Set(value.filter((item): item is string => typeof item === 'string' && item.length <= 200))
    : new Set()
}

/** Anything that is not the saved shape (missing, hand-edited, another version) means nothing is remembered. */
export function parseSidebarMemory(raw: string | null): SidebarMemory {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_MEMORY
    const record = value as Record<string, unknown>
    return { collapsed: strings(record.collapsed), open: strings(record.open) }
  } catch {
    return EMPTY_MEMORY
  }
}

export function serializeSidebarMemory(memory: SidebarMemory): string {
  return JSON.stringify({ collapsed: [...memory.collapsed], open: [...memory.open] })
}

/** A copy of `keys` without `key` when it was in, with it when it was not. */
export function toggleKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys)
  if (!next.delete(key)) next.add(key)
  return next
}
