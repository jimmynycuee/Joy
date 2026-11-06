import type { AttemptId, ProposedAction, RepoId, TaskId } from '@joy/core'
import { createAttempt, createRepo, createTask, getApproval, openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { Redactor } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalBroker } from './approvals.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

const action: ProposedAction = {
  kind: 'send_mail',
  summary: 'Send token sk-secret-value-123',
  detail: {},
  provenance: 'agent',
}

function setup() {
  const db = openDatabase(':memory:')
  databases.push(db)
  createRepo(db, { id: 'r' as RepoId, path: '/r', defaultBranch: 'main' })
  createTask(db, {
    id: 't' as TaskId,
    repoId: 'r' as RepoId,
    title: 't',
    prompt: 'p',
    mode: 'single',
    roleOverrides: {},
    planFirst: false,
    maxRounds: 1,
  })
  createAttempt(db, {
    id: 'a' as AttemptId,
    taskId: 't' as TaskId,
    provider: 'claude-cli',
    model: 'haiku',
    status: 'running',
  })
  const events: Array<{ type: string; payload: unknown }> = []
  const redactor = new Redactor()
  redactor.add('sk-secret-value-123')
  const broker = new ApprovalBroker({
    db,
    redactor,
    publish: (_t, _a, type, payload) => events.push({ type, payload }),
  })
  return { db, broker, events }
}

const input = { taskId: 't' as TaskId, attemptId: 'a' as AttemptId, action, tier: 'approve' as const }

describe('ApprovalBroker', () => {
  it('resolves with the decision and redacts what it stores and publishes', async () => {
    const { db, broker, events } = setup()
    const waiting = broker.request(input, new AbortController().signal, 10_000)
    const [pending] = broker.pending()
    expect(pending?.action.summary).toBe('Send token [REDACTED]')
    broker.decide(pending?.id ?? '', 'approved', 'telegram')
    expect(await waiting).toBe('approved')
    expect(getApproval(db, pending?.id ?? '')?.decidedVia).toBe('telegram')
    expect(JSON.stringify(events)).not.toContain('sk-secret-value-123')
    expect(events.map((e) => e.type)).toEqual(['approval.requested', 'approval.decided'])
  })

  it('expires on timeout and when the run is cancelled', async () => {
    const { broker } = setup()
    expect(await broker.request(input, new AbortController().signal, 10)).toBe('expired')
    const controller = new AbortController()
    const waiting = broker.request(input, controller.signal, 10_000)
    controller.abort()
    expect(await waiting).toBe('expired')
    expect(broker.pending()).toHaveLength(0)
  })

  it('keeps going when a channel listener throws, and tells the others', async () => {
    const { broker } = setup()
    const seen: string[] = []
    broker.onRequested(() => {
      throw new Error('telegram down')
    })
    broker.onRequested((approval) => seen.push(approval.id))
    const waiting = broker.request(input, new AbortController().signal, 10_000)
    expect(seen).toHaveLength(1)
    broker.decide(seen[0] ?? '', 'denied', 'web')
    expect(await waiting).toBe('denied')
  })
})
