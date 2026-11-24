// Switching a task's models, mode and permission mode with a follow-up message.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentProvider,
  ModelRef,
  ProviderKind,
  RunOptions,
  TaskId,
  Workspace,
} from '@joy/core'
import { ConfigStore } from '@joy/config'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { REVIEW_SCHEMA } from '@joy/orchestrator'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { createJoyServer } from './server.js'
import type { JoyServer } from './server.js'

const TOKEN = 'test-api-token-for-switch-tests-0042'
const servers: JoyServer[] = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

type Gate = { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open = () => {}
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

interface Run {
  options: RunOptions
  model: ModelRef
  review: boolean
}

/** Records every run with the model it got. Reviews answer from `verdicts` (approve by default). */
function fakeProvider(kind: ProviderKind, codeEdit = true) {
  const runs: Run[] = []
  const verdicts: boolean[] = []
  const state: {
    work?: ((options: RunOptions) => Promise<void> | void) | undefined
    steerable?: boolean
  } = {}
  let sessions = 0
  const provider: AgentProvider = {
    kind,
    capabilities: {
      codeEdit,
      tools: true,
      resume: true,
      presetSessionId: false,
      delegatedApproval: false,
      quotaEvents: false,
      structuredOutput: true,
    },
    async *run(options: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
      const review = options.outputSchema === REVIEW_SCHEMA
      runs.push({ options, model, review })
      if (review) {
        const approve = verdicts.shift() ?? true
        yield {
          type: 'done',
          sessionId: 'review',
          isError: false,
          structured: {
            approve,
            summary: approve ? 'fine' : 'needs work',
            findings: approve ? [] : [{ severity: 'major', message: 'fix it' }],
          },
        }
        return
      }
      const sessionId = options.resumeSessionId ?? `${kind}-session-${++sessions}`
      if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
      if (state.steerable) options.onSteer?.(async () => true)
      try {
        await state.work?.(options)
      } finally {
        if (state.steerable) options.onSteer?.(undefined)
      }
      yield { type: 'done', sessionId, isError: false, finalMessage: `${kind} answer ${runs.length}` }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  const work = () => runs.filter((run) => !run.review)
  return { provider, runs, work, verdicts, state }
}

class FakeExecutor {
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
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'joy-switch-'))
  dirs.push(home)
  // Small-change reviews would lower the reviewer's effort; these tests check the configured reviewer is kept.
  writeFileSync(
    join(home, 'config.yaml'),
    'approvals:\n  on_timeout: deny\nreview:\n  small_change_max_lines: 0\n',
  )
  const db = openDatabase(':memory:')
  databases.push(db)
  const redactor = new Redactor()
  const claude = fakeProvider('claude-cli')
  const codex = fakeProvider('codex-cli')
  const api = fakeProvider('openai-api', false)
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    executor: new FakeExecutor(),
    apiToken: TOKEN,
    approvalTimeoutMs: 2_000,
    cliVersionCheck: false,
    backups: false,
    memoryExtraction: false,
    conversationSummaries: false,
    providers: { 'claude-cli': claude.provider, 'codex-cli': codex.provider, 'openai-api': api.provider },
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
  return { call, claude, codex }
}

type Call = Awaited<ReturnType<typeof setup>>['call']
type Details = {
  task: Record<string, unknown> & { status: string; mode: string; permissionMode: string }
  attempts: Array<Record<string, unknown>>
  events: Array<{ type: string; payload: Record<string, unknown>; attemptId?: string }>
  pendingSettings: Record<string, unknown> | null
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

const results = (d: Details) => d.events.filter((event) => event.type === 'result').length
const finished = (n: number) => (d: Details) =>
  (d.task.status === 'done' || d.task.status === 'review_ready') && results(d) === n
const settingsEvents = (d: Details) => d.events.filter((event) => event.type === 'task.settings')

async function newRepo(call: Call, extra: object = {}) {
  const { body } = await call('POST', '/api/repos', {
    path: '/tmp/switch-repo',
    defaultBranch: 'main',
    ...extra,
  })
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

const SONNET_HIGH = { provider: 'claude-cli', model: 'sonnet', effort: 'high' }
const SOL = { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' }

describe('switching models with a follow-up message', () => {
  it('keeps the same Claude session and passes only the new model and effort', async () => {
    const { call, claude } = await setup()
    const id = await newTask(call, await newRepo(call))
    await until(call, id, finished(1), 'first run')
    const sent = await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Now use Sonnet',
      roleOverrides: { implementer: SONNET_HIGH },
    })
    expect(sent).toMatchObject({ status: 202, body: { message: { delivery: 'follow_up' } } })
    const after = await until(call, id, finished(2), 'follow-up')
    expect(claude.work()).toHaveLength(2)
    expect(claude.work()[0]?.model).toMatchObject({ model: 'opus', effort: 'medium' })
    expect(claude.work()[1]?.model).toEqual(SONNET_HIGH)
    expect(claude.work()[1]?.options).toMatchObject({
      resumeSessionId: 'claude-cli-session-1',
      cwd: '/fake/worktree',
    })
    expect(claude.work()[1]?.options.prompt).not.toContain('You do not share its session')
    expect(after.task.roleOverrides).toMatchObject({ implementer: SONNET_HIGH })
    expect(after.attempts).toHaveLength(1)
    expect(after.attempts[0]).toMatchObject({ provider: 'claude-cli', model: 'sonnet' })
    expect(settingsEvents(after)).toHaveLength(1)
    expect(settingsEvents(after)[0]?.payload).toEqual({ implementer: SONNET_HIGH })
    // The settings line comes after the owner's message and before the new run.
    const types = after.events.map((event) => event.type)
    expect(types.indexOf('task.settings')).toBeGreaterThan(types.indexOf('user.message'))
    expect(types.lastIndexOf('started')).toBeGreaterThan(types.indexOf('task.settings'))
  })

  it('moves to another provider in the same worktree with a new session and a summary of the conversation', async () => {
    const { call, claude, codex } = await setup()
    const id = await newTask(call, await newRepo(call))
    await until(call, id, finished(1), 'first run')
    await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Continue with Codex',
      roleOverrides: { implementer: SOL },
    })
    const after = await until(call, id, finished(2), 'handoff')
    expect(claude.work()).toHaveLength(1)
    expect(codex.work()).toHaveLength(1)
    const run = codex.work()[0]
    expect(run?.model).toEqual(SOL)
    expect(run?.options.resumeSessionId).toBeUndefined()
    expect(run?.options.cwd).toBe('/fake/worktree')
    expect(run?.options.prompt).toContain(
      'moved this task from claude-cli (opus) to you (codex-cli, gpt-6.1-sol)',
    )
    expect(run?.options.prompt).toContain('Task:\nFix add()')
    expect(run?.options.prompt).toContain('Previous agent: claude-cli answer 1')
    expect(run?.options.prompt).toContain('files: a.ts')
    expect(run?.options.prompt.match(/Continue with Codex/g)).toHaveLength(1)
    expect(after.attempts).toHaveLength(2)
    expect(after.attempts[1]).toMatchObject({
      provider: 'codex-cli',
      model: 'gpt-6.1-sol',
      worktreePath: '/fake/worktree',
      sessionId: 'codex-cli-session-1',
    })
    expect(settingsEvents(after)[0]?.payload).toMatchObject({
      implementer: SOL,
      handoff: {
        from: { provider: 'claude-cli', model: 'opus' },
        to: { provider: 'codex-cli', model: 'gpt-6.1-sol' },
      },
    })

    // The next message resumes the new provider's own session.
    await call('POST', `/api/tasks/${id}/messages`, { text: 'One more thing' })
    await until(call, id, finished(3), 'second follow-up')
    expect(codex.work()[1]?.options.resumeSessionId).toBe('codex-cli-session-1')
    expect(codex.work()[1]?.options.prompt).not.toContain('You do not share its session')
  })

  it('hands a review loop to another provider too, with the reviewer kept', async () => {
    const { call, claude, codex } = await setup()
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop' })
    await until(call, id, finished(1), 'first run')
    const reviewsBefore = codex.runs.filter((run) => run.review).length
    await call('POST', `/api/tasks/${id}/messages`, {
      text: 'Codex takes it from here',
      roleOverrides: {
        implementer: SOL,
        reviewer: { provider: 'claude-cli', model: 'opus', effort: 'high' },
      },
    })
    await until(call, id, finished(2), 'handoff')
    const implementing = codex.work().at(-1)
    expect(implementing?.options.resumeSessionId).toBeUndefined()
    expect(implementing?.options.prompt).toContain('You do not share its session')
    expect(implementing?.options.prompt).toContain('Codex takes it from here')
    // The new reviewer is Claude now; Codex did no new review.
    expect(codex.runs.filter((run) => run.review)).toHaveLength(reviewsBefore)
    expect(claude.runs.filter((run) => run.review).at(-1)?.model).toMatchObject({
      model: 'opus',
      effort: 'high',
    })
  })
})

describe('switching the mode and the permission mode', () => {
  it('turns a single task into a review loop and back', async () => {
    const { call, codex } = await setup()
    const id = await newTask(call, await newRepo(call))
    await until(call, id, finished(1), 'first run')
    expect(codex.runs).toHaveLength(0)
    await call('POST', `/api/tasks/${id}/messages`, { text: 'Get it reviewed', mode: 'review_loop' })
    const reviewed = await until(call, id, finished(2), 'review loop')
    expect(reviewed.task.mode).toBe('review_loop')
    expect(codex.runs.filter((run) => run.review)).toHaveLength(1)
    expect(settingsEvents(reviewed)[0]?.payload).toEqual({ mode: 'review_loop' })

    await call('POST', `/api/tasks/${id}/messages`, { text: 'Just do it', mode: 'single' })
    const single = await until(call, id, finished(3), 'single again')
    expect(single.task.mode).toBe('single')
    expect(codex.runs.filter((run) => run.review)).toHaveLength(1)
  })

  it('applies the permission mode, lowered to the project maximum', async () => {
    const { call } = await setup()
    const repoId = await newRepo(call)
    const id = await newTask(call, repoId, { permissionMode: 'ask' })
    await until(call, id, finished(1), 'first run')
    expect((await call('PATCH', `/api/repos/${repoId}`, { maxPermissionMode: 'auto' })).status).toBe(200)
    await call('POST', `/api/tasks/${id}/messages`, { text: 'go on', permissionMode: 'full' })
    const after = await until(call, id, finished(2), 'follow-up')
    expect(after.task.permissionMode).toBe('auto')
    expect(settingsEvents(after)[0]?.payload).toEqual({ permissionMode: 'auto' })
  })

  it('keeps a task from external content at ask', async () => {
    const { call } = await setup()
    const id = await newTask(call, await newRepo(call), { provenance: 'external_content' })
    await until(call, id, finished(1), 'first run')
    await call('POST', `/api/tasks/${id}/messages`, { text: 'go on', permissionMode: 'full' })
    const after = await until(call, id, finished(2), 'follow-up')
    expect(after.task.permissionMode).toBe('ask')
    expect(settingsEvents(after)).toHaveLength(0)
  })

  it('records nothing when the settings are what the task already uses', async () => {
    const { call, claude } = await setup()
    const id = await newTask(call, await newRepo(call), { permissionMode: 'auto' })
    await until(call, id, finished(1), 'first run')
    await call('POST', `/api/tasks/${id}/messages`, {
      text: 'same again',
      mode: 'single',
      permissionMode: 'auto',
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'opus', effort: 'medium' } },
    })
    const after = await until(call, id, finished(2), 'follow-up')
    expect(settingsEvents(after)).toHaveLength(0)
    expect(after.task.roleOverrides).toEqual({})
    expect(claude.work()[1]?.options.resumeSessionId).toBe('claude-cli-session-1')
  })
})

describe('refused switches', () => {
  it('refuses compete, unknown fields, disallowed providers, non-coding implementers and bad efforts', async () => {
    const { call } = await setup()
    const repoId = await newRepo(call, { allowedProviders: ['claude-cli', 'openai-api'] })
    const id = await newTask(call, repoId)
    await until(call, id, finished(1), 'first run')
    const send = (body: object) => call('POST', `/api/tasks/${id}/messages`, { text: 'x', ...body })
    expect((await send({ mode: 'compete' })).status).toBe(400)
    expect((await send({ permissionMode: 'root' })).status).toBe(400)
    expect((await send({ roleOverrides: { implementer: { provider: 'claude-cli' } } })).status).toBe(400)
    const disallowed = await send({ roleOverrides: { implementer: SOL } })
    expect(disallowed.status).toBe(422)
    expect(String(disallowed.body.error)).toContain('codex-cli')
    expect(
      (await send({ roleOverrides: { implementer: { provider: 'openai-api', model: 'gpt-6-luna' } } }))
        .status,
    ).toBe(422)
    expect(
      (
        await send({
          roleOverrides: { implementer: { provider: 'claude-cli', model: 'mystery', effort: 'high' } },
        })
      ).status,
    ).toBe(422)
    // Nothing was accepted, so nothing ran again.
    const after = await details(call, id)
    expect(results(after)).toBe(1)
    expect(after.events.filter((event) => event.type === 'user.message')).toHaveLength(0)
  })

  it('refuses a compete task', async () => {
    const { call } = await setup()
    const id = await newTask(call, await newRepo(call), { mode: 'compete' })
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: 'x', mode: 'single' })).status).toBe(409)
  })
})

describe('switching while the agent works', () => {
  it('waits for the run to end instead of steering, then runs with the new model and the message', async () => {
    const { call, claude } = await setup()
    const wait = gate()
    claude.state.work = () => wait.promise
    claude.state.steerable = true
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.runs.length === 1, 'running')
    const sent = await call('POST', `/api/tasks/${id}/messages`, {
      text: 'After this, use Sonnet',
      roleOverrides: { implementer: SONNET_HIGH },
    })
    expect(sent.body.message).toMatchObject({ delivery: 'queued' })
    const queued = await details(call, id)
    expect(queued.pendingSettings).toEqual({ roleOverrides: { implementer: SONNET_HIGH } })
    expect(settingsEvents(queued)).toHaveLength(0)
    // A plain message behind it waits too, instead of steering past it.
    expect(
      (await call('POST', `/api/tasks/${id}/messages`, { text: 'and add a test' })).body.message,
    ).toMatchObject({
      delivery: 'queued',
    })
    claude.state.work = undefined
    wait.open()
    const after = await until(call, id, finished(2), 'follow-up with the new model')
    expect(claude.work()).toHaveLength(2)
    expect(claude.work()[0]?.model).toMatchObject({ model: 'opus' })
    expect(claude.work()[1]?.model).toEqual(SONNET_HIGH)
    expect(claude.work()[1]?.options.prompt).toContain('After this, use Sonnet')
    expect(claude.work()[1]?.options.prompt).toContain('and add a test')
    expect(after.pendingSettings).toBeNull()
    expect(settingsEvents(after)).toHaveLength(1)
  })

  it('does not hand a settings message to a fix round of the current review loop', async () => {
    const { call, claude, codex } = await setup()
    const wait = gate()
    claude.state.work = () => wait.promise
    codex.verdicts.push(false)
    const id = await newTask(call, await newRepo(call), { mode: 'review_loop', maxRounds: 3 })
    await until(call, id, (d) => d.task.status === 'running' && claude.runs.length === 1, 'implementing')
    await call('POST', `/api/tasks/${id}/messages`, { text: 'Switch to single', mode: 'single' })
    claude.state.work = undefined
    wait.open()
    const after = await until(call, id, finished(2), 'run with the new mode')
    // Round 1, the fix round (without the message) and then the single-mode follow-up with it.
    expect(claude.work()).toHaveLength(3)
    expect(claude.work()[1]?.options.prompt).not.toContain('Switch to single')
    expect(claude.work()[2]?.options.prompt).toContain('Switch to single')
    expect(after.task.mode).toBe('single')
    expect(codex.runs.filter((run) => run.review)).toHaveLength(2)
  })
})
