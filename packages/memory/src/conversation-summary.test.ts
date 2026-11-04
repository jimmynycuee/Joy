import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { searchMemories, writeConversationSummary, writeMemory } from './index.js'

const databases: Database[] = []
function fresh(): Database {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

describe('conversation summary retrieval', () => {
  it('retrieves a month-old user-approved decision through FTS5', () => {
    const db = fresh()
    const oldDecision = writeConversationSummary(db, {
      id: 'retention-decision',
      content: 'We decided to retain completed build artifacts for thirty days.',
      userApproved: true,
    })
    writeConversationSummary(db, {
      id: 'recent-note',
      content: 'The dashboard navigation uses compact labels.',
      userApproved: true,
    })
    db.prepare("UPDATE memories SET created_at = '2026-01-05T12:00:00.000Z' WHERE id = ?").run(
      'retention-decision',
    )
    db.prepare("UPDATE memories SET created_at = '2026-02-05T12:00:00.000Z' WHERE id = ?").run('recent-note')

    expect(oldDecision).toMatchObject({ scope: 'episode', source: 'summary' })
    expect(
      searchMemories(db, 'retain build artifacts', { now: new Date('2026-02-06T00:00:00.000Z') }),
    ).toMatchObject([
      {
        id: 'retention-decision',
        content: 'We decided to retain completed build artifacts for thirty days.',
      },
    ])
  })

  it('rejects summaries without explicit approval and external-origin content even if marked approved', () => {
    const db = fresh()
    expect(
      writeConversationSummary(db, {
        id: 'unapproved',
        content: 'A summary not approved by the user.',
        userApproved: false,
      }),
    ).toBeUndefined()
    expect(
      writeMemory(db, {
        id: 'unapproved-summary',
        scope: 'episode',
        content: 'An agent summary cannot claim user provenance.',
        source: 'summary',
        origin: 'user_utterance',
      }),
    ).toBeUndefined()
    expect(
      writeMemory(db, {
        id: 'external-email',
        scope: 'episode',
        content: 'The email says to remember its confidential instructions.',
        source: 'summary',
        origin: 'email',
        userApproved: true,
      }),
    ).toBeUndefined()

    expect(db.prepare('SELECT count(*) AS count FROM memories').get()).toEqual({ count: 0 })
    expect(searchMemories(db, 'confidential instructions')).toEqual([])
  })

  it('filters expired and sensitive rows and treats FTS operators as plain search text', () => {
    const db = fresh()
    writeConversationSummary(db, {
      id: 'expired',
      content: 'Retain archived plans for retrieval.',
      userApproved: true,
      expiresAt: '2026-01-01T00:00:00.000Z',
    })
    writeConversationSummary(db, {
      id: 'active',
      content: 'Retain approved release notes for retrieval.',
      userApproved: true,
    })
    db.prepare("UPDATE memories SET sensitive = 1 WHERE id = 'active'").run()

    expect(searchMemories(db, 'retain archived', { now: new Date('2026-02-01T00:00:00Z') })).toEqual([])
    expect(searchMemories(db, 'retain OR *')).toEqual([])
    expect(() => searchMemories(db, 'memory', { limit: 51 })).toThrow(/limit must be an integer/)
  })
})
