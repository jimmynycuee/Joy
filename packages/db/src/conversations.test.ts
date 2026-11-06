import { afterEach, describe, expect, it } from 'vitest'
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  listMessages,
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
})
