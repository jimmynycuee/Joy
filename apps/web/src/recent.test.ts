import { describe, expect, it } from 'vitest'
import { recentItems } from './recent.js'
import type { ConversationSummary, Task } from './types.js'

function task(id: string, createdAt: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    repoId: 'r',
    title: `task ${id}`,
    prompt: '',
    mode: 'single',
    status: 'done',
    createdAt,
    ...extra,
  }
}
function conversation(
  id: string,
  createdAt: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary {
  return { id, createdAt, ...extra }
}

describe('recentItems', () => {
  it('mixes tasks and conversations by last activity, newest first', () => {
    const items = recentItems(
      [task('a', '2026-11-10T10:00:00Z'), task('b', '2026-11-12T10:00:00Z')],
      [conversation('c', '2026-11-11T10:00:00Z')],
    )
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual(['task:b', 'conversation:c', 'task:a'])
  })

  it('uses updatedAt, so an old task that just ran and an old conversation that was just used move up', () => {
    const items = recentItems(
      [
        task('old', '2026-11-01T10:00:00Z', { updatedAt: '2026-11-13T10:00:00Z' }),
        task('new', '2026-11-12T10:00:00Z'),
      ],
      [conversation('talk', '2026-11-02T10:00:00Z', { updatedAt: '2026-11-14T10:00:00Z' })],
    )
    expect(items.map((item) => item.id)).toEqual(['talk', 'old', 'new'])
  })

  it('leaves archived tasks out', () => {
    const items = recentItems(
      [task('a', '2026-11-10T10:00:00Z', { archived: true }), task('b', '2026-11-09T10:00:00Z')],
      [],
    )
    expect(items.map((item) => item.id)).toEqual(['b'])
  })

  it('filters tasks (title or prompt) and conversations (title, default 新對話) by the query', () => {
    const tasks = [
      task('a', '2026-11-10T10:00:00Z', { title: 'Fix login', prompt: 'x' }),
      task('b', '2026-11-10T11:00:00Z', { prompt: 'about LOGIN too' }),
    ]
    const conversations = [
      conversation('c', '2026-11-10T12:00:00Z', { title: 'login chat' }),
      conversation('d', '2026-11-10T13:00:00Z'),
    ]
    expect(recentItems(tasks, conversations, 'login').map((item) => item.id)).toEqual(['c', 'b', 'a'])
    expect(recentItems(tasks, conversations, '新對').map((item) => item.id)).toEqual(['d'])
    expect(recentItems(tasks, conversations, 'nothing')).toEqual([])
  })

  it('puts items without a usable timestamp first and keeps their order', () => {
    const items = recentItems(
      [task('a', ''), task('b', '2026-11-10T10:00:00Z'), task('c', '')],
      [conversation('d', '')],
    )
    expect(items.map((item) => item.id)).toEqual(['a', 'c', 'd', 'b'])
  })
})
