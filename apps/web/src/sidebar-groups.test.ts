import { describe, expect, it } from 'vitest'
import { recentItems } from './recent.js'
import {
  EMPTY_MEMORY,
  NO_FILTER,
  applyFilter,
  isFiltering,
  parseSidebarMemory,
  pinnedRows,
  serializeSidebarMemory,
  statusCounts,
  tasksOfProject,
  toggleKey,
  unpinnedRows,
  waitsForYou,
} from './sidebar-groups.js'
import type { ConversationSummary, Task } from './types.js'

function task(id: string, repoId: string, createdAt: string, extra: Partial<Task> = {}): Task {
  return { id, repoId, title: `task ${id}`, prompt: '', mode: 'single', status: 'done', createdAt, ...extra }
}
const chat = (extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'c',
  createdAt: '2026-11-11T10:00:00Z',
  ...extra,
})

describe('pinnedRows and unpinnedRows', () => {
  const tasks = [
    task('plain', 'a', '2026-11-12T10:00:00Z'),
    task('first-pin', 'a', '2026-11-09T10:00:00Z', { pinnedAt: '2026-11-13T08:00:00Z' }),
    task('last-pin', 'b', '2026-11-08T10:00:00Z', { pinnedAt: '2026-11-14T08:00:00Z' }),
  ]

  it('puts the pin made last first, tasks and conversations together', () => {
    const items = recentItems(tasks, [chat({ pinnedAt: '2026-11-13T12:00:00Z' })])
    expect(pinnedRows(items).map((item) => item.id)).toEqual(['last-pin', 'c', 'first-pin'])
  })

  it('splits the rest off in their own order, and never loses a row', () => {
    const items = recentItems(tasks, [chat()])
    const pinned = pinnedRows(items)
    const rest = unpinnedRows(items)
    expect(rest.map((item) => item.id)).toEqual(['plain', 'c'])
    expect(pinned.length + rest.length).toBe(items.length)
  })

  it('leaves out archived tasks, which recentItems never lists', () => {
    const items = recentItems(
      [task('gone', 'a', '2026-11-12T10:00:00Z', { archived: true, pinnedAt: 'x' })],
      [],
    )
    expect(pinnedRows(items)).toEqual([])
  })

  it('keeps a pin whose time cannot be read, ahead of the others, in the given order', () => {
    const items = recentItems(
      [
        task('ok', 'a', '2026-11-12T10:00:00Z', { pinnedAt: '2026-11-13T08:00:00Z' }),
        task('odd', 'a', '2026-11-11T10:00:00Z', { pinnedAt: 'not a time' }),
      ],
      [],
    )
    expect(pinnedRows(items).map((item) => item.id)).toEqual(['odd', 'ok'])
  })
})

describe('tasksOfProject', () => {
  it('keeps one project’s tasks, newest first, and no conversation', () => {
    const items = recentItems(
      [
        task('a-old', 'a', '2026-11-09T10:00:00Z'),
        task('b', 'b', '2026-11-12T10:00:00Z'),
        task('a-new', 'a', '2026-11-10T10:00:00Z'),
      ],
      [chat()],
    )
    expect(tasksOfProject(items, 'a').map((item) => item.id)).toEqual(['a-new', 'a-old'])
    expect(tasksOfProject(items, 'nope')).toEqual([])
  })
})

describe('applyFilter', () => {
  const items = recentItems(
    [
      task('w1', 'a', '2026-11-12T10:00:00Z', { status: 'awaiting_approval' }),
      task('w2', 'b', '2026-11-12T09:00:00Z', { status: 'review_ready' }),
      task('r', 'a', '2026-11-12T08:00:00Z', { status: 'running' }),
      task('q', 'b', '2026-11-12T07:00:00Z', { status: 'queued' }),
      task('d', 'a', '2026-11-12T06:00:00Z', { status: 'done' }),
      task('f', 'b', '2026-11-12T05:00:00Z', { status: 'failed' }),
      task('x', 'a', '2026-11-12T04:00:00Z', { status: 'cancelled' }),
    ],
    [chat()],
  )
  const ids = (filter: Parameters<typeof applyFilter>[1]) => applyFilter(items, filter).map((item) => item.id)

  it('shows everything, conversations too, without a filter', () => {
    expect(isFiltering(NO_FILTER)).toBe(false)
    expect(ids(NO_FILTER)).toHaveLength(items.length)
  })

  it('filters by status: waiting, running (queued too), done, and what did not finish', () => {
    expect(ids({ status: 'waiting', repoId: null })).toEqual(['w1', 'w2'])
    expect(ids({ status: 'running', repoId: null })).toEqual(['r', 'q'])
    expect(ids({ status: 'done', repoId: null })).toEqual(['d'])
    expect(ids({ status: 'failed', repoId: null })).toEqual(['f', 'x'])
  })

  it('filters by project, and by both; a conversation has neither, so it drops out', () => {
    expect(ids({ status: 'all', repoId: 'b' })).toEqual(['w2', 'q', 'f'])
    expect(ids({ status: 'waiting', repoId: 'b' })).toEqual(['w2'])
    expect(ids({ status: 'done', repoId: 'b' })).toEqual([])
    expect(isFiltering({ status: 'all', repoId: 'b' })).toBe(true)
    expect(isFiltering({ status: 'done', repoId: null })).toBe(true)
  })

  it('counts the tasks behind each status choice, within the chosen project', () => {
    expect(statusCounts(items, null)).toEqual({ all: 7, waiting: 2, running: 2, done: 1, failed: 2 })
    expect(statusCounts(items, 'b')).toEqual({ all: 3, waiting: 1, running: 1, done: 0, failed: 1 })
  })

  it('treats a status the app does not know as not finished', () => {
    const odd = recentItems([task('z', 'a', '2026-11-12T10:00:00Z', { status: 'mystery' })], [])
    expect(applyFilter(odd, { status: 'failed', repoId: null }).map((item) => item.id)).toEqual(['z'])
  })
})

describe('waitsForYou', () => {
  it('is true for an approval or a review that waits', () => {
    expect(waitsForYou(task('1', 'a', '', { status: 'awaiting_approval' }))).toBe(true)
    expect(waitsForYou(task('1', 'a', '', { status: 'review_ready' }))).toBe(true)
    expect(waitsForYou(task('1', 'a', '', { status: 'running' }))).toBe(false)
  })
})

describe('sidebar memory', () => {
  it('round-trips folded sections and opened projects', () => {
    const memory = { collapsed: new Set(['recent']), open: new Set(['a', 'b']) }
    expect(parseSidebarMemory(serializeSidebarMemory(memory))).toEqual(memory)
  })

  it('remembers nothing for a missing, broken, or wrong-shaped value', () => {
    expect(parseSidebarMemory(null)).toBe(EMPTY_MEMORY)
    expect(parseSidebarMemory('{not json')).toBe(EMPTY_MEMORY)
    expect(parseSidebarMemory('[]')).toBe(EMPTY_MEMORY)
    expect(parseSidebarMemory('"text"')).toBe(EMPTY_MEMORY)
    expect(parseSidebarMemory('null')).toBe(EMPTY_MEMORY)
  })

  it('keeps only strings of a sensible length from each list', () => {
    const memory = parseSidebarMemory(
      JSON.stringify({ collapsed: ['ok', 3, null, 'x'.repeat(201)], open: 'a' }),
    )
    expect([...memory.collapsed]).toEqual(['ok'])
    expect([...memory.open]).toEqual([])
  })

  it('toggles a key without changing the set it was given', () => {
    const keys = new Set(['a'])
    expect([...toggleKey(keys, 'b')].sort()).toEqual(['a', 'b'])
    expect([...toggleKey(keys, 'a')]).toEqual([])
    expect([...keys]).toEqual(['a'])
  })
})
