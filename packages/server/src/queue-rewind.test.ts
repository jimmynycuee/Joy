// Messages queued for the end of the agent's turn (edit, reorder, delete, kept across a restart) and going back to an
// earlier round of a task (rewind) with a new session.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentProvider, ProviderKind, RunOptions, TaskId, Workspace } from '@joy/core'
import { ConfigStore } from '@joy/config'
import { appendTaskLevelEvent, openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { CheckpointRestoreIncompleteError, WorktreeExecutor } from '@joy/executor'
import { REVIEW_SCHEMA } from '@joy/orchestrator'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { createJoyServer } from './server.js'
import type { JoyServer, JoyServerOptions } from './server.js'

const TOKEN = 'test-api-token-for-queue-rewind-0042'
const servers: JoyServer[] = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

type Gate = { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open = () => {}
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

const untilAborted = (options: RunOptions) =>
  new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))

/** Each run without a session to resume starts a new one (`<kind>-session-<n>`); `steer` makes runs steerable. */
function fakeProvider(kind: ProviderKind) {
  const calls: RunOptions[] = []
  const steered: string[] = []
  const state: {
    work?: ((options: RunOptions, call: number) => Promise<void> | void) | undefined
    steer?: boolean
  } = {}
  let sessions = 0
  const provider: AgentProvider = {
    kind,
    capabilities: {
      codeEdit: true,
      tools: true,
      resume: true,
      presetSessionId: false,
      delegatedApproval: false,
      quotaEvents: false,
      structuredOutput: true,
    },
    async *run(options: RunOptions): AsyncGenerator<AgentEvent> {
      calls.push(options)
      if (options.outputSchema === REVIEW_SCHEMA) {
        yield {
          type: 'done',
          sessionId: 'review',
          isError: false,
          structured: { approve: true, summary: 'fine', findings: [] },
        }
        return
      }
      const sessionId = options.resumeSessionId ?? `${kind}-session-${++sessions}`
      if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
      if (state.steer)
        options.onSteer?.(async (text) => {
          steered.push(text)
          return true
        })
      try {
        await state.work?.(options, calls.length)
      } finally {
        if (state.steer) options.onSteer?.(undefined)
      }
      yield { type: 'done', sessionId, isError: false, finalMessage: `answer ${calls.length}` }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, calls, state, steered }
}

class FakeExecutor {
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: Workspace['attemptId']) {
    return { repo, taskId, attemptId, path: '/fake/worktree', branch: 'joy/t/a', baseCommit: 'base' }
  }
  async diff() {
    return { files: [], patch: '' }
  }
  async commit() {
    return null
  }
  async cleanup() {}
}

async function setup(
  options: { executor?: JoyServerOptions['executor']; db?: Database; home?: string } = {},
) {
  const home = options.home ?? tempDir('joy-queue-')
  writeFileSync(join(home, 'config.yaml'), 'approvals:\n  on_timeout: deny\n')
  const db = options.db ?? openDatabase(':memory:')
  if (!options.db) databases.push(db)
  const redactor = new Redactor()
  const claude = fakeProvider('claude-cli')
  const codex = fakeProvider('codex-cli')
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    executor: options.executor ?? new FakeExecutor(),
    apiToken: TOKEN,
    approvalTimeoutMs: 2_000,
    cliVersionCheck: false,
    backups: false,
    memoryExtraction: false,
    conversationSummaries: false,
    providers: { 'claude-cli': claude.provider, 'codex-cli': codex.provider },
  })
  servers.push(server)
  const address = await server.listen()
  const origin = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: 'http://127.0.0.1:5173',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return { call, claude, codex, db, home, server }
}

type Call = Awaited<ReturnType<typeof setup>>['call']
type Details = {
  task: Record<string, unknown> & { status: string; prompt: string }
  attempts: Array<Record<string, unknown>>
  events: Array<{ seq: number; type: string; payload: Record<string, unknown>; attemptId?: string }>
  queuedMessages: Array<{ id: string; text: string }>
  rewindPoints: Array<{ messageId: string; ids: string[]; checkpoint: number }>
}

async function details(call: Call, id: string): Promise<Details> {
  return (await call('GET', `/api/tasks/${id}`)).body as unknown as Details
}

async function until(call: Call, id: string, check: (d: Details) => boolean, what: string): Promise<Details> {
  const deadline = Date.now() + 10_000
  let last: Details | undefined
  while (Date.now() < deadline) {
    last = await details(call, id)
    if (check(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${what} (status ${last?.task.status})`)
}

const count = (d: Details, type: string) => d.events.filter((event) => event.type === type).length
const doneAfter = (n: number) => (d: Details) => d.task.status === 'done' && count(d, 'result') === n
const messageId = (sent: { body: Record<string, unknown> }) => (sent.body.message as { id: string }).id

async function newRepo(call: Call, path = '/tmp/queue-repo') {
  const { body } = await call('POST', '/api/repos', { path, defaultBranch: 'main' })
  return (body.repo as { id: string }).id
}

async function newTask(call: Call, repoId: string, extra: object = {}) {
  const { status, body } = await call('POST', '/api/tasks', {
    repoId,
    title: 'Fix add()',
    prompt: 'Fix add()',
    mode: 'single',
    ...extra,
  })
  expect(status).toBe(201)
  return (body.task as { id: string }).id
}

describe('messages queued for the end of the turn', () => {
  it('keeps a queued message out of a steerable run, lets the owner edit, reorder and delete it, then sends the rest in one follow-up', async () => {
    const { call, claude } = await setup()
    const wait = gate()
    claude.state.steer = true
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    const first = await call('POST', `/api/tasks/${id}/messages`, { text: 'first', queue: true })
    const second = await call('POST', `/api/tasks/${id}/messages`, { text: 'second', queue: true })
    const third = await call('POST', `/api/tasks/${id}/messages`, { text: 'third', queue: true })
    for (const sent of [first, second, third])
      expect(sent).toMatchObject({ status: 202, body: { message: { delivery: 'queued' } } })
    expect(claude.steered).toEqual([])
    expect(claude.calls[0]?.signal.aborted).toBe(false)

    const [a, b, c] = [first, second, third].map(messageId) as [string, string, string]
    expect(await call('PATCH', `/api/tasks/${id}/queued/${a}`, { text: 'first, rewritten' })).toMatchObject({
      status: 200,
    })
    expect((await call('PUT', `/api/tasks/${id}/queued`, { ids: [c, a, b] })).status).toBe(200)
    const removed = await call('DELETE', `/api/tasks/${id}/queued/${b}`)
    expect(removed.body.queuedMessages).toEqual([
      { id: c, text: 'third' },
      { id: a, text: 'first, rewritten' },
    ])
    expect((await details(call, id)).queuedMessages).toEqual([
      { id: c, text: 'third' },
      { id: a, text: 'first, rewritten' },
    ])

    wait.open()
    const after = await until(call, id, doneAfter(2), 'one follow-up')
    expect(claude.calls).toHaveLength(2)
    const prompt = claude.calls[1]?.prompt ?? ''
    expect(prompt.indexOf('third')).toBeGreaterThan(-1)
    expect(prompt.indexOf('third')).toBeLessThan(prompt.indexOf('first, rewritten'))
    expect(prompt).not.toContain('second')
    expect(after.queuedMessages).toEqual([])
    expect(after.events.find((e) => e.type === 'user.message.discarded')?.payload).toMatchObject({
      ids: [b],
      reason: 'owner',
    })
  })

  it('refuses to change a message that is no longer waiting, a stale order, and queue with interrupt', async () => {
    const { call, claude } = await setup()
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running', 'running')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'later', queue: true })
    const queued = messageId(sent)
    expect((await call('PUT', `/api/tasks/${id}/queued`, { ids: [queued, 'other'] })).status).toBe(409)
    expect(
      (await call('POST', `/api/tasks/${id}/messages`, { text: 'x', queue: true, interrupt: true })).status,
    ).toBe(400)
    expect((await call('PATCH', `/api/tasks/${id}/queued/${queued}`, { text: '  ' })).status).toBe(400)
    wait.open()
    await until(call, id, doneAfter(2), 'follow-up')
    expect((await call('PATCH', `/api/tasks/${id}/queued/${queued}`, { text: 'too late' })).status).toBe(409)
    expect((await call('DELETE', `/api/tasks/${id}/queued/${queued}`)).status).toBe(409)
  })

  it('keeps the queue (with edits and order) across a restart and sends it when the owner continues', async () => {
    const first = await setup()
    first.claude.state.work = (options) => untilAborted(options)
    const id = await newTask(first.call, await newRepo(first.call))
    await until(first.call, id, (d) => d.task.status === 'running', 'running')
    const a = messageId(await first.call('POST', `/api/tasks/${id}/messages`, { text: 'alpha', queue: true }))
    const b = messageId(await first.call('POST', `/api/tasks/${id}/messages`, { text: 'beta', queue: true }))
    await first.call('PATCH', `/api/tasks/${id}/queued/${a}`, { text: 'alpha two' })
    await first.call('PUT', `/api/tasks/${id}/queued`, { ids: [b, a] })
    await first.server.close()

    const second = await setup({ db: first.db, home: first.home })
    const restarted = await details(second.call, id)
    expect(restarted.queuedMessages).toEqual([
      { id: b, text: 'beta' },
      { id: a, text: 'alpha two' },
    ])
    // Nothing runs on its own after the restart; the messages wait for the owner.
    expect(second.claude.calls).toHaveLength(0)
    expect(restarted.events.filter((e) => e.type === 'user.message.held').at(-1)?.payload).toMatchObject({
      ids: [b, a],
    })
    const sent = await second.call('POST', `/api/tasks/${id}/messages`, { text: 'go on' })
    expect(sent.status).toBe(202)
    await until(second.call, id, (d) => d.task.status === 'done', 'continued')
    const prompt = second.claude.calls[0]?.prompt ?? ''
    expect(prompt.indexOf('beta')).toBeLessThan(prompt.indexOf('alpha two'))
    expect(prompt.indexOf('alpha two')).toBeLessThan(prompt.indexOf('go on'))
    expect((await details(second.call, id)).queuedMessages).toEqual([])
  })

  it('does not rebuild after a restart what an older version lost, nor anything on finished or archived tasks', async () => {
    const first = await setup()
    const repoId = await newRepo(first.call)
    const failed = await newTask(first.call, repoId)
    const done = await newTask(first.call, repoId)
    const archived = await newTask(first.call, repoId)
    for (const id of [failed, done, archived]) await until(first.call, id, doneAfter(1), 'done')
    await first.server.close()
    first.db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(failed)
    first.db.prepare('UPDATE tasks SET archived = 1 WHERE id = ?').run(archived)
    const queued = (id: string, extra: object) =>
      appendTaskLevelEvent(first.db, id as TaskId, 'user.message', {
        text: `waiting on ${id}`,
        provenance: 'user',
        delivery: 'queued',
        ...extra,
      })
    // Written before this version: the queue lived in memory and a restart lost it without a trace.
    queued(failed, { id: 'legacy' })
    queued(failed, { id: 'current', persisted: true })
    queued(done, { id: 'on-done', persisted: true })
    queued(archived, { id: 'on-archived', persisted: true })

    const second = await setup({ db: first.db, home: first.home })
    expect((await details(second.call, failed)).queuedMessages).toEqual([
      { id: 'current', text: `waiting on ${failed}` },
    ])
    expect((await details(second.call, done)).queuedMessages).toEqual([])
    expect((await details(second.call, archived)).queuedMessages).toEqual([])
  })
})

/** A one-commit repository with add.js, and where its worktrees go. */
function realRepo() {
  const root = tempDir('joy-rewind-')
  const repoPath = join(root, 'repo')
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' }).toString()
  mkdirSync(repoPath)
  run('init', '-q', '-b', 'main')
  run('config', 'core.autocrlf', 'false')
  writeFileSync(join(repoPath, 'add.js'), 'start\n')
  run('add', '.')
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return { repoPath, worktreesDir: join(root, 'worktrees') }
}

/** A task with three rounds; each run writes `turn <n>` to add.js. */
async function threeRounds(Executor: typeof WorktreeExecutor = WorktreeExecutor) {
  const { repoPath, worktreesDir } = realRepo()
  const executor = new Executor({ worktreesDir })
  const env = await setup({ executor })
  env.claude.state.work = (options, n) => writeFileSync(join(options.cwd, 'add.js'), `turn ${n}\n`)
  const id = await newTask(env.call, await newRepo(env.call, repoPath))
  const first = await until(env.call, id, doneAfter(1), 'round 1')
  const worktree = first.attempts[0]?.worktreePath as string
  const second = messageId(await env.call('POST', `/api/tasks/${id}/messages`, { text: 'make it faster' }))
  await until(env.call, id, doneAfter(2), 'round 2')
  const third = messageId(await env.call('POST', `/api/tasks/${id}/messages`, { text: 'add a cache' }))
  const done = await until(env.call, id, doneAfter(3), 'round 3')
  return { ...env, executor, id, worktree, repoPath, second, third, done }
}

const read = (worktree: string) => readFileSync(join(worktree, 'add.js'), 'utf8')

describe('going back to an earlier round', () => {
  it('restores the worktree to the start of the round, discards the later rounds and runs the edited message in a new session', async () => {
    const { call, claude, id, worktree, second, third, done } = await threeRounds()
    expect(done.rewindPoints.map((point) => point.messageId)).toEqual(['task', second, third])
    expect(read(worktree)).toBe('turn 3\n')

    const rewound = await call('POST', `/api/tasks/${id}/rewind`, {
      messageId: second,
      text: 'make it faster, without new dependencies',
    })
    expect(rewound).toMatchObject({ status: 202, body: { message: { delivery: 'follow_up' } } })
    const after = await until(call, id, doneAfter(4), 'redone round')
    // The new run started from the worktree as round 2 found it.
    expect(claude.calls).toHaveLength(4)
    const redo = claude.calls[3] as RunOptions
    expect(redo.resumeSessionId).toBeUndefined()
    expect(redo.prompt).toContain('went back to an earlier point')
    expect(redo.prompt).toContain('Fix add()')
    expect(redo.prompt).toContain('answer 1')
    expect(redo.prompt).not.toContain('answer 2')
    expect(redo.prompt).not.toContain('add a cache')
    expect(redo.prompt).toContain('make it faster, without new dependencies')
    expect(redo.prompt).toContain('+turn 1')
    expect(read(worktree)).toBe('turn 4\n')

    const event = after.events.find((e) => e.type === 'task.rewound')
    expect(event?.payload).toMatchObject({ messageId: second, discardedIds: [second, third] })
    // Nothing was deleted: the thread still has the discarded rounds, and the saved state can be restored.
    expect(after.events.filter((e) => e.type === 'user.message')).toHaveLength(3)
    const savedAs = event?.payload.savedAs as number
    expect((await call('POST', `/api/tasks/${id}/checkpoints/${savedAs}/restore`, {})).status).toBe(200)
    expect(read(worktree)).toBe('turn 3\n')

    // The next follow-up goes on in the new session, not the old one.
    const newSession = after.attempts.at(-1)?.sessionId
    expect(newSession).toBe('claude-cli-session-2')
    await call('POST', `/api/tasks/${id}/messages`, { text: 'one more' })
    await until(call, id, doneAfter(5), 'next round')
    expect(claude.calls[4]?.resumeSessionId).toBe(newSession)
    // A discarded round cannot be gone back to.
    expect((await call('POST', `/api/tasks/${id}/rewind`, { messageId: third, text: 'again' })).status).toBe(
      404,
    )
  }, 30_000)

  it('goes back to the first round with a rewritten request', async () => {
    const { call, claude, id, worktree } = await threeRounds()
    const rewound = await call('POST', `/api/tasks/${id}/rewind`, { messageId: 'task', text: 'Fix sub()' })
    expect(rewound.status).toBe(202)
    const after = await until(call, id, doneAfter(4), 'redone first round')
    expect(after.task.prompt).toBe('Fix sub()')
    expect(claude.calls[3]?.resumeSessionId).toBeUndefined()
    expect(claude.calls[3]?.prompt).toContain('Fix sub()')
    expect(claude.calls[3]?.prompt).not.toContain('make it faster')
    expect(after.events.find((e) => e.type === 'task.rewound')?.payload).toMatchObject({
      messageId: 'task',
      previousPrompt: 'Fix add()',
    })
    expect(read(worktree)).toBe('turn 4\n')
    expect(after.rewindPoints.map((point) => point.messageId)).toEqual(['task'])
  }, 30_000)

  it('refuses while the task runs, for a compete task and for an unknown round', async () => {
    const { call, claude, id, second } = await threeRounds()
    const wait = gate()
    claude.state.work = () => wait.promise
    await call('POST', `/api/tasks/${id}/messages`, { text: 'more' })
    await until(call, id, (d) => d.task.status === 'running', 'running')
    expect(await call('POST', `/api/tasks/${id}/rewind`, { messageId: second, text: 'x' })).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining('stop it') },
    })
    wait.open()
    await until(call, id, doneAfter(4), 'done')
    expect((await call('POST', `/api/tasks/${id}/rewind`, { messageId: 'nope', text: 'x' })).status).toBe(404)

    const compete = await newTask(call, await newRepo(call, '/tmp/compete-repo'), { mode: 'compete' })
    expect((await details(call, compete)).rewindPoints).toEqual([])
    expect(
      (await call('POST', `/api/tasks/${compete}/rewind`, { messageId: 'task', text: 'x' })).status,
    ).toBe(409)
  }, 30_000)

  it('asks before going back on a task with a pull request', async () => {
    const { call, db, id, second, worktree } = await threeRounds()
    appendTaskLevelEvent(db, id as TaskId, 'publish.done', { pullRequestUrl: 'https://example.test/pr/1' })
    expect(await call('POST', `/api/tasks/${id}/rewind`, { messageId: second, text: 'x' })).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining('pull request') },
    })
    expect(read(worktree)).toBe('turn 3\n')
    expect(
      (await call('POST', `/api/tasks/${id}/rewind`, { messageId: second, text: 'x', confirm: true })).status,
    ).toBe(202)
    await until(call, id, doneAfter(4), 'redone')
  }, 30_000)

  it('leaves the worktree and the thread alone when the checkpoint is gone', async () => {
    const { call, id, second, worktree, repoPath, done } = await threeRounds()
    const point = done.rewindPoints.find((candidate) => candidate.messageId === second)
    execFileSync('git', ['update-ref', '-d', `refs/joy/checkpoints/${id}/${point?.checkpoint}`], {
      cwd: repoPath,
    })
    const response = await call('POST', `/api/tasks/${id}/rewind`, { messageId: second, text: 'x' })
    expect(response.status).toBe(409)
    expect(read(worktree)).toBe('turn 3\n')
    const after = await details(call, id)
    expect(count(after, 'task.rewound')).toBe(0)
    expect(after.attempts).toHaveLength(1)
    expect(after.task.status).toBe('done')
  }, 30_000)

  it('tells the owner which checkpoint puts things back when a restore stops half way', async () => {
    const { call, id, second, worktree, executor } = await threeRounds(HalfRestoreExecutor)
    ;(executor as HalfRestoreExecutor).failNext = true
    const response = await call('POST', `/api/tasks/${id}/rewind`, { messageId: second, text: 'x' })
    const after = await details(call, id)
    const failed = after.events.find((e) => e.type === 'checkpoint.restore_failed')
    const savedAs = failed?.payload.savedAs as number
    expect(response).toMatchObject({
      status: 500,
      body: { error: expect.stringContaining(`restore checkpoint ${savedAs} to get back`) },
    })
    expect(count(after, 'task.rewound')).toBe(0)
    expect(after.attempts).toHaveLength(1)
    // The saved checkpoint does put the worktree back.
    expect((await call('POST', `/api/tasks/${id}/checkpoints/${savedAs}/restore`, {})).status).toBe(200)
    expect(read(worktree)).toBe('turn 3\n')
  }, 30_000)
})

/** Resets the worktree like a real restore, then fails as if `git read-tree` had (once, when asked to). */
class HalfRestoreExecutor extends WorktreeExecutor {
  failNext = false
  override async restoreCheckpoint(...args: Parameters<WorktreeExecutor['restoreCheckpoint']>) {
    if (!this.failNext) return super.restoreCheckpoint(...args)
    this.failNext = false
    const [ws] = args
    execFileSync('git', ['reset', '--hard', '-q', 'HEAD'], { cwd: ws.path })
    writeFileSync(join(ws.path, 'add.js'), 'half\n')
    throw new CheckpointRestoreIncompleteError(new Error('read-tree failed'))
  }
}
