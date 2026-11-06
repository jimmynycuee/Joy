import { afterEach, describe, expect, it } from 'vitest'
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  resetSessionsUsingMemory,
  setConversationTitle,
  updateConversationSession,
} from './conversations.js'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import { createRepo, createTask, getTask } from './repositories.js'
import type { RepoId, TaskId } from '@joy/core'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})
function fresh() {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}

describe('conversations', () => {
  it('stores messages in order and remembers the brain session', () => {
    const db = fresh()
    createConversation(db, { id: 'c1', channel: 'web' })
    appendMessage(db, 'c1', 'user', 'hi')
    appendMessage(db, 'c1', 'assistant', 'hello')
    expect(listMessages(db, 'c1').map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
    ])
    updateConversationSession(db, 'c1', { provider: 'openai-api', model: 'gpt-6-luna', sessionId: 'resp_1' })
    setConversationTitle(db, 'c1', 'Greeting')
    expect(getConversation(db, 'c1')).toMatchObject({
      title: 'Greeting',
      brainProvider: 'openai-api',
      brainModel: 'gpt-6-luna',
      sessionId: 'resp_1',
    })
  })

  it('lists the most recently active conversation first', () => {
    const db = fresh()
    createConversation(db, { id: 'old', channel: 'web' })
    createConversation(db, { id: 'new', channel: 'web' })
    appendMessage(db, 'new', 'user', 'x')
    expect(listConversations(db)[0]?.id).toBe('new')
  })

  it('deletes messages with their conversation', () => {
    const db = fresh()
    createConversation(db, { id: 'c1', channel: 'web' })
    appendMessage(db, 'c1', 'user', 'hi')
    db.prepare("DELETE FROM conversations WHERE id = 'c1'").run()
    expect(listMessages(db, 'c1')).toEqual([])
  })

  it('links tasks to the conversation that created them, and unlinks them when it is deleted', () => {
    const db = fresh()
    createConversation(db, { id: 'c1', channel: 'web' })
    const repo = createRepo(db, { id: 'r1' as RepoId, path: '/r', defaultBranch: 'main' })
    createTask(db, {
      id: 't1' as TaskId,
      repoId: repo.id,
      title: 't',
      prompt: 'p',
      mode: 'single',
      originConversationId: 'c1',
    })
    expect(getTask(db, 't1' as TaskId)?.originConversationId).toBe('c1')
    db.prepare("DELETE FROM conversations WHERE id = 'c1'").run()
    expect(getTask(db, 't1' as TaskId)?.originConversationId).toBeUndefined()
  })

  it('records the memories behind a session and a reply, and resets sessions that used a memory', () => {
    const db = fresh()
    createConversation(db, { id: 'a', channel: 'web' })
    createConversation(db, { id: 'b', channel: 'web' })
    const reply = appendMessage(db, 'a', 'assistant', 'ok', ['m1', 'm2'])
    expect(reply.memoryIds).toEqual(['m1', 'm2'])
    expect(appendMessage(db, 'a', 'user', 'x').memoryIds).toEqual([])
    const session = { provider: 'openai-api' as const, model: 'm', sessionId: 's' }
    updateConversationSession(db, 'a', { ...session, memoryIds: ['m1', 'm2'] })
    updateConversationSession(db, 'b', { ...session, memoryIds: ['m3'] })
    expect(getConversation(db, 'a')?.memoryIds).toEqual(['m1', 'm2'])

    expect(resetSessionsUsingMemory(db, 'm2')).toBe(1)
    expect(getConversation(db, 'a')).not.toHaveProperty('sessionId')
    expect(getConversation(db, 'a')?.memoryIds).toEqual([])
    expect(getConversation(db, 'b')).toMatchObject({ sessionId: 's', memoryIds: ['m3'] })
    // The reply keeps its record of what it used.
    expect(listMessages(db, 'a')[0]?.memoryIds).toEqual(['m1', 'm2'])
  })

  it('rejects memory ids that are not JSON', () => {
    const db = fresh()
    createConversation(db, { id: 'a', channel: 'web' })
    expect(() => db.prepare("UPDATE conversations SET memory_ids = 'nope' WHERE id = 'a'").run()).toThrow()
  })
})
