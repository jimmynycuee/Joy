import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import {
  createMemory,
  deleteMemory,
  listActiveMemories,
  listAllMemories,
  markMemoriesUsed,
  searchMemories,
  supersedeMemory,
  updateMemoryContent,
} from './memories.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})
function fresh() {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}
const user = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  scope: 'user' as const,
  content,
  source: 'user_utterance' as const,
  ...extra,
})

describe('memories', () => {
  it('keeps full-text results mapped to the right memory after VACUUM (issue 39)', () => {
    const db = fresh()
    for (let i = 0; i < 20; i++) createMemory(db, user(`m${i}`, `filler memory number ${i}`))
    createMemory(db, user('target', 'prefers squash merges'))
    for (let i = 0; i < 10; i++) deleteMemory(db, `m${i}`)
    db.exec('VACUUM')
    expect(searchMemories(db, 'squash').map((m) => m.id)).toEqual(['target'])
    updateMemoryContent(db, 'target', 'prefers rebase merges')
    db.exec('VACUUM')
    expect(searchMemories(db, 'squash')).toEqual([])
    expect(searchMemories(db, 'rebase').map((m) => m.id)).toEqual(['target'])
    expect(searchMemories(db, 'number 15').map((m) => m.id)).toContain('m15')
  })

  it('never returns sensitive, superseded or expired memories', () => {
    const db = fresh()
    createMemory(db, user('old', 'works at Acme'))
    createMemory(db, user('new', 'works at Globex'))
    supersedeMemory(db, 'old', 'new')
    createMemory(db, user('temp', 'busy this week', { expiresAt: '2000-01-01T00:00:00.000Z' }))
    createMemory(db, user('secret', 'card 4111'))
    db.prepare("UPDATE memories SET sensitive = 1 WHERE id = 'secret'").run()
    expect(listActiveMemories(db, 'user').map((m) => m.id)).toEqual(['new'])
    expect(searchMemories(db, 'works').map((m) => m.id)).toEqual(['new'])
    expect(searchMemories(db, 'card')).toEqual([])
    expect(listAllMemories(db, 'user').map((m) => m.id)).toEqual(['temp', 'new', 'old'])
  })

  it('orders active memories by last use and ignores search syntax in queries', () => {
    const db = fresh()
    createMemory(db, user('a', 'likes tea'))
    createMemory(db, user('b', 'likes coffee'))
    markMemoriesUsed(db, ['a'])
    expect(listActiveMemories(db, 'user')[0]?.id).toBe('a')
    expect(searchMemories(db, '"tea" OR *')).toHaveLength(1)
    expect(searchMemories(db, '   ')).toEqual([])
  })
})
