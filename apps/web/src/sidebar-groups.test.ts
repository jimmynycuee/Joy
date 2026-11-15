import { describe, expect, it } from 'vitest'
import { recentItems } from './recent.js'
import {
  CONVERSATIONS_GROUP,
  UNKNOWN_PROJECT_GROUP,
  groupByProject,
  parseCollapsedGroups,
  serializeCollapsedGroups,
  toggleCollapsed,
} from './sidebar-groups.js'
import type { ConversationSummary, Repo, Task } from './types.js'

const repos: Repo[] = [
  { id: 'a', path: '/work/alpha', defaultBranch: 'main' },
  { id: 'b', path: '/work/beta', defaultBranch: 'main' },
]
function task(id: string, repoId: string, createdAt: string, extra: Partial<Task> = {}): Task {
  return { id, repoId, title: `task ${id}`, prompt: '', mode: 'single', status: 'done', createdAt, ...extra }
}
const chat: ConversationSummary = { id: 'c', createdAt: '2026-11-11T10:00:00Z' }

describe('groupByProject', () => {
  it('has no groups when the tasks belong to one project, even with several projects added', () => {
    const tasks = [task('1', 'a', '2026-11-10T10:00:00Z'), task('2', 'a', '2026-11-11T10:00:00Z')]
    expect(groupByProject(recentItems(tasks, [chat]), repos, tasks)).toBeNull()
    expect(groupByProject([], repos, [])).toBeNull()
  })

  it('does not count archived tasks as a project', () => {
    const tasks = [
      task('1', 'a', '2026-11-10T10:00:00Z'),
      task('2', 'b', '2026-11-11T10:00:00Z', { archived: true }),
    ]
    expect(groupByProject(recentItems(tasks, []), repos, tasks)).toBeNull()
  })

  it('splits by project in the order projects were added, newest first inside, conversations last', () => {
    const tasks = [
      task('b-new', 'b', '2026-11-12T10:00:00Z'),
      task('a-old', 'a', '2026-11-09T10:00:00Z'),
      task('a-new', 'a', '2026-11-10T10:00:00Z'),
    ]
    const groups = groupByProject(recentItems(tasks, [chat]), repos, tasks)
    expect(groups?.map((group) => [group.key, group.label, group.items.map((item) => item.id)])).toEqual([
      ['a', 'alpha', ['a-new', 'a-old']],
      ['b', 'beta', ['b-new']],
      [CONVERSATIONS_GROUP, '對話', ['c']],
    ])
    expect(groups?.[0]?.repoId).toBe('a')
    expect(groups?.[2]?.repoId).toBeUndefined()
  })

  it('leaves out a project without rows (a search) but still groups', () => {
    const tasks = [
      task('x', 'a', '2026-11-10T10:00:00Z', { title: 'needle' }),
      task('y', 'b', '2026-11-11T10:00:00Z'),
    ]
    const groups = groupByProject(recentItems(tasks, [], 'needle'), repos, tasks)
    expect(groups?.map((group) => group.key)).toEqual(['a'])
  })

  it('never loses a task whose project is not in the list', () => {
    const tasks = [task('x', 'gone', '2026-11-10T10:00:00Z'), task('y', 'a', '2026-11-11T10:00:00Z')]
    const groups = groupByProject(recentItems(tasks, []), repos, tasks)
    expect(groups?.map((group) => group.key)).toEqual(['a', UNKNOWN_PROJECT_GROUP])
  })
})

describe('collapsed groups', () => {
  it('reads what was stored and treats anything else as none', () => {
    expect([...parseCollapsedGroups('["a","b"]')]).toEqual(['a', 'b'])
    for (const raw of [null, '', 'nope', '{}', '"a"', '5', '[1,{"x":1},null]'])
      expect(parseCollapsedGroups(raw).size).toBe(0)
    expect([...parseCollapsedGroups('["a",1,"b"]')]).toEqual(['a', 'b'])
  })

  it('round-trips and toggles without changing the old set', () => {
    const open = new Set<string>()
    const closed = toggleCollapsed(open, 'a')
    expect([...closed]).toEqual(['a'])
    expect(open.size).toBe(0)
    expect(toggleCollapsed(closed, 'a').size).toBe(0)
    expect([...parseCollapsedGroups(serializeCollapsedGroups(toggleCollapsed(closed, 'b')))]).toEqual([
      'a',
      'b',
    ])
  })
})
