import { repoName } from './labels.js'
import type { RecentItem } from './recent.js'
import type { Repo, Task } from './types.js'

/** The group that holds assistant conversations, which belong to no project. */
export const CONVERSATIONS_GROUP = 'conversations'
/** Tasks whose project is gone from the list (should not happen, but a row must never disappear). */
export const UNKNOWN_PROJECT_GROUP = 'unknown-project'

export interface SidebarGroup {
  /** The project's id, or one of the two keys above. Also what the collapsed state remembers. */
  key: string
  label: string
  /** Set for a project: the dot colour comes from it. */
  repoId?: string
  items: RecentItem[]
}

/**
 * The sidebar's rows split by project, in the order the projects were added (so a group never jumps around while
 * work goes on), with the assistant conversations last. Rows keep their order (newest first) inside a group.
 * Returns null when the tasks belong to only one project: then there is nothing to tell apart, and the sidebar shows
 * its plain list without headings. `allTasks` decides that, not `items`, so a search does not make headings come and go.
 */
export function groupByProject(
  items: readonly RecentItem[],
  repos: readonly Repo[],
  allTasks: readonly Task[],
): SidebarGroup[] | null {
  const projects = new Set(allTasks.filter((task) => !task.archived).map((task) => task.repoId))
  if (projects.size < 2) return null

  const groups: SidebarGroup[] = []
  const byKey = new Map<string, SidebarGroup>()
  const group = (key: string, label: string, repoId?: string): SidebarGroup => {
    let found = byKey.get(key)
    if (!found) {
      found = { key, label, ...(repoId ? { repoId } : {}), items: [] }
      byKey.set(key, found)
      groups.push(found)
    }
    return found
  }
  // Projects first, in list order; each is created only when it has a row.
  for (const item of items) {
    if (item.kind !== 'task') continue
    const repo = repos.find((candidate) => candidate.id === item.task.repoId)
    if (repo) group(repo.id, repoName(repo.path), repo.id).items.push(item)
    else group(UNKNOWN_PROJECT_GROUP, '其他').items.push(item)
  }
  groups.sort((a, b) => order(a, repos) - order(b, repos))
  const chats = items.filter((item) => item.kind === 'conversation')
  if (chats.length) groups.push({ key: CONVERSATIONS_GROUP, label: '對話', items: chats })
  return groups
}

function order(entry: SidebarGroup, repos: readonly Repo[]): number {
  const index = repos.findIndex((repo) => repo.id === entry.key)
  return index === -1 ? repos.length : index
}

export const COLLAPSED_GROUPS_KEY = 'joy.sidebar.collapsed.v1'

/** The group keys remembered as collapsed; anything that is not a list of strings means none are. */
export function parseCollapsedGroups(raw: string | null): Set<string> {
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((item): item is string => typeof item === 'string' && item.length <= 200))
  } catch {
    return new Set()
  }
}

export function serializeCollapsedGroups(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys])
}

/** A copy of `keys` with `key` collapsed when it was open, or opened when it was collapsed. */
export function toggleCollapsed(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys)
  if (!next.delete(key)) next.add(key)
  return next
}
