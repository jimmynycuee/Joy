import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentProvider,
  AttemptId,
  Executor,
  ProviderKind,
  RepoId,
  RunOptions,
  TaskId,
  Workspace,
  WorkspaceDiff,
} from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '@joy/config'
import { createAttempt, createRepo, createTask, openDatabase, setTaskStatus, updateAttempt } from '@joy/db'
import type { Database } from '@joy/db'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { createJoyServer } from './server.js'
import type { JoyServer, JoyServerOptions } from './server.js'
import WebSocket, { type RawData } from 'ws'

const dirs: string[] = []
const servers: JoyServer[] = []
const databases: Database[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const rid = (id: string) => id as RepoId
const tid = (id: string) => id as TaskId
const aid = (id: string) => id as AttemptId
function receiveMessages(socket: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = []
    const onError = (error: Error) => {
      socket.off('message', onMessage)
      reject(error)
    }
    const onMessage = (data: RawData) => {
      messages.push(JSON.parse(data.toString()) as unknown)
      if (messages.length === count) {
        socket.off('error', onError)
        resolve(messages)
      }
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
  })
}
const diff: WorkspaceDiff = {
  files: [{ path: 'src/fix.ts', status: 'modified', additions: 1, deletions: 0 }],
  patch: 'diff --git a/src/fix.ts b/src/fix.ts\n+fixed\n',
}

class FakeProvider implements AgentProvider {
  readonly calls: RunOptions[] = []
  waitForAbort = false
  readonly capabilities = {
    codeEdit: true,
    tools: true,
    resume: true,
    presetSessionId: true,
    delegatedApproval: false,
    quotaEvents: true,
    structuredOutput: true,
  }

  constructor(
    readonly kind: ProviderKind,
    private readonly output: AgentEvent[] = [],
  ) {}

  async *run(options: RunOptions): AsyncGenerator<AgentEvent> {
    this.calls.push(options)
    const sessionId = options.resumeSessionId ?? `session-${this.calls.length}`
    if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
    yield { type: 'message', text: 'working' }
    if (this.waitForAbort || options.prompt === 'wait') {
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve()
        else options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'done', sessionId, isError: false }
      return
    }
    for (const event of this.output.length
      ? this.output
      : [{ type: 'done', sessionId, isError: false } as AgentEvent])
      yield event
  }

  async healthCheck() {
    return { ok: true, installed: true, loggedIn: true as const }
  }
}

class FakeExecutor implements Executor {
  prepareCalls = 0
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: AttemptId): Promise<Workspace> {
    this.prepareCalls++
    return { repo, taskId, attemptId, path: '/fake/worktree', branch: 'joy/t1/a1', baseCommit: 'base-sha' }
  }
  async diff() {
    return diff
  }
  async commit() {
    return null
  }
  async cleanup() {}
}

function fixture(
  options: {
    implementer?: FakeProvider
    reviewer?: FakeProvider
    redactor?: Redactor
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-server-test-'))
  dirs.push(dir)
  const db = openDatabase(':memory:')
  databases.push(db)
  const executor = new FakeExecutor()
  const implementer = options.implementer ?? new FakeProvider('claude-cli')
  const reviewer =
    options.reviewer ??
    new FakeProvider('codex-cli', [
      {
        type: 'done',
        sessionId: 'review-session',
        isError: false,
        structured: { approve: true, summary: 'ok', findings: [] },
      },
    ])
  const api = new FakeProvider('openai-api')
  const configStore = new ConfigStore(join(dir, 'config.yaml'))
  const serverOptions: JoyServerOptions = {
    home: dir,
    database: db,
    configStore,
    secretStore: new SecretStore({ backend: new MemoryBackend() }),
    executor,
    providers: {
      'claude-cli': implementer,
      'codex-cli': reviewer,
      'openai-api': api,
    },
    ...(options.redactor ? { redactor: options.redactor } : {}),
  }
  const serverPromise = createJoyServer(serverOptions)
  return {
    dir,
    db,
    executor,
    implementer,
    reviewer,
    api,
    configStore,
    serverPromise,
    restart: () => createJoyServer(serverOptions),
  }
}

async function start(serverPromise: Promise<JoyServer>) {
  const server = await serverPromise
  servers.push(server)
  const address = await server.listen()
  return { server, origin: `http://127.0.0.1:${address.port}`, websocket: `ws://127.0.0.1:${address.port}` }
}

interface TaskDetails {
  task: { status: string }
  attempts: Array<Record<string, unknown>>
  reviews: unknown[]
  events: unknown[]
}

async function waitForStatus(origin: string, id: string, status: string): Promise<TaskDetails> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${origin}/api/tasks/${id}`)
    const body = (await response.json()) as TaskDetails
    if (body.task.status === status) return body
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Task did not reach ${status}`)
}

async function waitForProviderCalls(provider: FakeProvider, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (provider.calls.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Provider did not receive ${count} calls`)
}

async function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function patchJson(url: string, body: unknown) {
  return fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Joy local server', () => {
  it('binds only to loopback and supports repositories, task creation, replay and WebSocket events', async () => {
    const { db, executor, serverPromise } = fixture()
    const { origin, websocket, server } = await start(serverPromise)
    const address = server.httpServer.address()
    expect(address).toMatchObject({ address: '127.0.0.1' })

    const repoResponse = await postJson(`${origin}/api/repos`, {
      path: '/tmp/repo',
      defaultBranch: 'main',
      githubRemote: 'https://github.com/example/repo',
    })
    expect(repoResponse.status).toBe(201)
    const { repo } = (await repoResponse.json()) as { repo: { id: string; defaultBranch: string } }
    expect(repo.defaultBranch).toBe('main')
    const repoList = (await (await fetch(`${origin}/api/repos`)).json()) as { repos: unknown[] }
    expect(repoList.repos).toHaveLength(1)

    const taskResponse = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Fix the bug',
      prompt: 'Make the failing test pass',
      mode: 'review_loop',
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku', effort: 'low' } },
      maxRounds: 2,
    })
    expect(taskResponse.status).toBe(201)
    const { task } = (await taskResponse.json()) as { task: { id: string } }

    const socket = new WebSocket(`${websocket}/ws?taskId=${task.id}`, { origin })
    const messages = await receiveMessages(socket, 2)
    expect(messages[0]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(messages[1]).toMatchObject({ type: 'event', event: { taskId: task.id } })
    socket.close()
    const result = await waitForStatus(origin, task.id, 'done')
    expect(result.task.status).toBe('done')
    expect(result.attempts[0]).toMatchObject({ status: 'succeeded', worktreePath: '/fake/worktree' })
    expect(result.events.length).toBeGreaterThan(0)
    expect(executor.prepareCalls).toBe(1)
    expect(db.isOpen).toBe(true)

    const compete = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Compare implementations',
      prompt: 'Do it',
      mode: 'compete',
    })
    expect(compete.status).toBe(422)
  })

  it('defaults repository allowlists to all providers and accepts allowed role selections', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const createdRepo = await postJson(`${origin}/api/repos`, {
      path: '/default-all-repo',
      defaultBranch: 'main',
    })
    expect(createdRepo.status).toBe(201)
    const { repo } = (await createdRepo.json()) as {
      repo: { id: string; allowedProviders: string[] }
    }
    expect(repo.allowedProviders).toEqual(['openai-api', 'claude-cli', 'codex-cli'])

    const createdTask = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Use all provider choices',
      prompt: 'Verify provider selections',
      mode: 'single',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku' },
        reviewer: { provider: 'openai-api', model: 'test-model' },
        orchestrator: { provider: 'codex-cli', model: 'test-model' },
      },
    })
    expect(createdTask.status).toBe(201)
  })

  it('allows configured providers and rejects disallowed task role selections by role', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const createdRepo = await postJson(`${origin}/api/repos`, {
      path: '/claude-only-repo',
      defaultBranch: 'main',
      allowedProviders: ['claude-cli'],
    })
    expect(createdRepo.status).toBe(201)
    const { repo } = (await createdRepo.json()) as {
      repo: { id: string; allowedProviders: string[] }
    }
    expect(repo.allowedProviders).toEqual(['claude-cli'])

    const allowedTask = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Allowed implementer',
      prompt: 'Use the repository provider',
      mode: 'single',
    })
    expect(allowedTask.status).toBe(201)

    const deniedCases = [
      {
        mode: 'single',
        roleOverrides: { implementer: { provider: 'codex-cli', model: 'test-model' } },
        role: 'implementer',
      },
      { mode: 'review_loop', roleOverrides: undefined, role: 'reviewer' },
    ] as const
    for (const denied of deniedCases) {
      const response = await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title: `Reject ${denied.role}`,
        prompt: 'Reject disallowed provider',
        mode: denied.mode,
        ...(denied.roleOverrides ? { roleOverrides: denied.roleOverrides } : {}),
      })
      expect(response.status).toBe(422)
      const body = (await response.json()) as { error: string }
      expect(body.error).toContain(`Role "${denied.role}"`)
      expect(body.error).toContain('codex-cli')
      expect(body.error).toContain('Select an allowed provider')
      expect(body.error).toContain('PATCH /api/repos/{repoId}')
    }
  })

  it('ignores an unused disallowed reviewer override in single mode', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, {
        path: '/single-with-unused-reviewer',
        defaultBranch: 'main',
        allowedProviders: ['claude-cli'],
      })
    ).json()) as { repo: { id: string } }

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Ignore unused reviewer',
      prompt: 'Do the implementation only',
      mode: 'single',
      roleOverrides: { reviewer: { provider: 'codex-cli', model: 'test-model' } },
    })
    expect(response.status).toBe(201)
  })

  it('retains the runtime allowlist guard if the active config changes after task creation', async () => {
    const { serverPromise, configStore, implementer, reviewer, api } = fixture()
    const getConfig = configStore.get.bind(configStore)
    let configReads = 0
    configStore.get = async () => {
      const config = await getConfig()
      configReads++
      return configReads === 2
        ? {
            ...config,
            roles: { ...config.roles, implementer: { ...config.roles.implementer, provider: 'codex-cli' } },
          }
        : config
    }
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, {
        path: '/runtime-allowlist-guard',
        defaultBranch: 'main',
        allowedProviders: ['claude-cli'],
      })
    ).json()) as { repo: { id: string } }
    const { task } = (await (
      await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title: 'Revalidate at execution',
        prompt: 'Run with current configuration',
        mode: 'single',
      })
    ).json()) as { task: { id: string } }

    expect((await waitForStatus(origin, task.id, 'failed')).attempts).toHaveLength(0)
    expect(implementer.calls).toHaveLength(0)
    expect(reviewer.calls).toHaveLength(0)
    expect(api.calls).toHaveLength(0)
  })

  it.each([
    { role: 'implementer', allowedProviders: ['codex-cli'], reviewerProvider: 'codex-cli' },
    { role: 'reviewer', allowedProviders: ['claude-cli'], reviewerProvider: 'openai-api' },
  ] as const)(
    'rejects a resumed task synchronously when its $role provider is no longer allowed',
    async ({ role, allowedProviders, reviewerProvider }) => {
      const { db, serverPromise, implementer, reviewer, api, configStore } = fixture()
      implementer.waitForAbort = true
      const { origin } = await start(serverPromise)
      const createdRepo = await postJson(`${origin}/api/repos`, {
        path: `/resume-${role}-repo`,
        defaultBranch: 'main',
      })
      expect(createdRepo.status).toBe(201)
      const { repo } = (await createdRepo.json()) as { repo: { id: string } }
      const createdTask = await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title: `Resume with disallowed ${role}`,
        prompt: 'wait',
        mode: 'review_loop',
      })
      expect(createdTask.status).toBe(201)
      const { task } = (await createdTask.json()) as { task: { id: string } }
      await waitForProviderCalls(implementer, 1)

      const cancelled = await postJson(`${origin}/api/tasks/${task.id}/cancel`, {})
      expect(cancelled.status).toBe(200)
      await waitForStatus(origin, task.id, 'cancelled')
      implementer.calls.length = 0
      implementer.waitForAbort = false
      reviewer.calls.length = 0
      api.calls.length = 0

      db.prepare('UPDATE repos SET allowed_providers = ? WHERE id = ?').run(
        JSON.stringify(allowedProviders),
        repo.id,
      )
      if (role === 'reviewer') {
        await configStore.update((config) => ({
          ...config,
          roles: { ...config.roles, reviewer: { ...config.roles.reviewer, provider: reviewerProvider } },
        }))
      }

      const beforeResume = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails
      const resumed = await postJson(`${origin}/api/tasks/${task.id}/resume`, {})
      expect(resumed.status).toBe(422)
      const rejection = (await resumed.json()) as { error: string }
      expect(rejection.error).toContain(`Role "${role}"`)
      expect(rejection.error).toContain(
        `provider "${role === 'implementer' ? 'claude-cli' : reviewerProvider}"`,
      )
      expect(rejection.error).toContain('PATCH /api/repos/{repoId}')
      const afterResume = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails
      expect(afterResume.task.status).toBe('cancelled')
      expect(afterResume.attempts).toEqual(beforeResume.attempts)
      expect(afterResume.events).toEqual(beforeResume.events)
      expect(implementer.calls).toHaveLength(0)
      expect(reviewer.calls).toHaveLength(0)
      expect(api.calls).toHaveLength(0)
    },
  )

  it('updates a repository allowlist through PATCH so a rejected resume can be recovered', async () => {
    const { serverPromise, implementer } = fixture()
    implementer.waitForAbort = true
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/resume-recovery', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const { task } = (await (
      await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title: 'Recover a rejected resume',
        prompt: 'wait',
        mode: 'single',
      })
    ).json()) as { task: { id: string } }
    await waitForProviderCalls(implementer, 1)
    await postJson(`${origin}/api/tasks/${task.id}/cancel`, {})
    await waitForStatus(origin, task.id, 'cancelled')

    const narrowed = await patchJson(`${origin}/api/repos/${repo.id}`, {
      allowedProviders: ['codex-cli'],
    })
    expect(narrowed.status).toBe(200)
    const denied = await postJson(`${origin}/api/tasks/${task.id}/resume`, {})
    expect(denied.status).toBe(422)
    expect(((await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails).task.status).toBe(
      'cancelled',
    )

    const restored = await patchJson(`${origin}/api/repos/${repo.id}`, { allowedProviders: ['claude-cli'] })
    expect(restored.status).toBe(200)
    expect(
      ((await restored.json()) as { repo: { allowedProviders: string[] } }).repo.allowedProviders,
    ).toEqual(['claude-cli'])
    const resumed = await postJson(`${origin}/api/tasks/${task.id}/resume`, {})
    expect(resumed.status).toBe(202)
    await waitForProviderCalls(implementer, 2)
    const cancelled = await postJson(`${origin}/api/tasks/${task.id}/cancel`, {})
    expect(cancelled.status).toBe(200)
    await waitForStatus(origin, task.id, 'cancelled')

    const invalidUpdate = await patchJson(`${origin}/api/repos/${repo.id}`, { allowedProviders: [] })
    expect(invalidUpdate.status).toBe(400)
  })

  it.each([
    { allowedProviders: [], issue: 'at least one provider' },
    { allowedProviders: ['claude-cli', 'claude-cli'], issue: 'unique' },
  ] as const)('rejects a repository allowlist that is $issue', async ({ allowedProviders, issue }) => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const response = await postJson(`${origin}/api/repos`, {
      path: `/invalid-allowlist-${issue}`,
      defaultBranch: 'main',
      allowedProviders,
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { issues: Array<{ path: string[]; message: string }> }
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['allowedProviders'], message: expect.stringContaining(issue) }),
      ]),
    )
  })

  it('stores redacted events, reviews, and usage and replays persisted events after restart', async () => {
    const secret = 'joy-private-test-secret-123'
    const redactor = new Redactor()
    redactor.add(secret)
    const implementer = new FakeProvider('claude-cli', [
      { type: 'message', text: `Output contains ${secret}` },
      { type: 'usage', inputTokens: 12, outputTokens: 4, costUsd: 0.02 },
      { type: 'quota', status: 'limited', windows: [] },
      { type: 'done', sessionId: 'implementer-session', isError: false },
    ])
    const reviewer = new FakeProvider('codex-cli', [
      {
        type: 'done',
        sessionId: 'reviewer-session',
        isError: false,
        structured: {
          approve: true,
          summary: `Reviewed ${secret}`,
          findings: [{ severity: 'minor', message: secret }],
        },
      },
    ])
    const { db, restart, serverPromise } = fixture({ implementer, reviewer, redactor })
    const { origin, server } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/logged-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const { task } = (await (
      await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title: 'Persist events',
        prompt: 'Record everything safely',
        mode: 'review_loop',
      })
    ).json()) as { task: { id: string } }
    const result = await waitForStatus(origin, task.id, 'done')
    const serializedEvents = JSON.stringify(result.events)
    expect(serializedEvents).not.toContain(secret)
    expect(serializedEvents).toContain('[REDACTED]')
    expect(result.reviews).toMatchObject([
      { summary: `Reviewed [REDACTED]`, findings: [{ message: '[REDACTED]' }] },
    ])
    expect(JSON.stringify(db.prepare('SELECT payload FROM events').all())).not.toContain(secret)
    expect(JSON.stringify(db.prepare('SELECT summary, findings FROM reviews').all())).not.toContain(secret)
    const usage = (await (await fetch(`${origin}/api/usage`)).json()) as {
      usage: Array<Record<string, unknown>>
    }
    expect(usage.usage).toEqual([
      expect.objectContaining({
        provider: 'claude-cli',
        inputTokens: 12,
        outputTokens: 4,
        costUsd: 0.02,
        rateLimitHits: 1,
      }),
    ])

    await server.close()
    const restarted = await restart()
    servers.push(restarted)
    const address = await restarted.listen()
    const restartedOrigin = `http://127.0.0.1:${address.port}`
    const replayed = (await (await fetch(`${restartedOrigin}/api/tasks/${task.id}`)).json()) as TaskDetails
    expect(replayed.events).toEqual(result.events)
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?taskId=${task.id}`, {
      origin: restartedOrigin,
    })
    const messages = await receiveMessages(socket, replayed.events.length + 1)
    expect(messages[0]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(messages.slice(1)).toEqual(replayed.events.map((event) => ({ type: 'event', event })))
    socket.close()
  })

  it('cancels a running task through the API', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/repo', defaultBranch: 'main' })
    ).json()) as {
      repo: { id: string }
    }
    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Cancel me',
      prompt: 'wait',
      mode: 'single',
    })
    const { task } = (await response.json()) as { task: { id: string } }
    await new Promise((resolve) => setTimeout(resolve, 15))
    const cancelled = await postJson(`${origin}/api/tasks/${task.id}/cancel`, {})
    expect(cancelled.status).toBe(200)
    const result = await waitForStatus(origin, task.id, 'cancelled')
    expect(result.task.status).toBe('cancelled')
  })

  it('marks interrupted tasks on restart and resumes the saved session and worktree', async () => {
    const { db, dir, executor, implementer, serverPromise } = fixture()
    const repo = createRepo(db, { id: rid('resume-repo'), path: '/repo', defaultBranch: 'main' })
    const task = createTask(db, {
      id: tid('resume-task'),
      repoId: repo.id,
      title: 'Resume me',
      prompt: 'Finish the change',
      mode: 'single',
    })
    const attempt = createAttempt(db, {
      id: aid('resume-attempt'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: '/saved/worktree',
      branch: 'joy/resume-task/resume-attempt',
      baseCommit: 'base-sha',
      sessionId: 'session-before-restart',
    })
    setTaskStatus(db, task.id, 'running')

    const { origin } = await start(serverPromise)
    const interrupted = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails
    expect(interrupted.task.status).toBe('failed')
    expect(interrupted.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'interrupted' })]),
    )
    const resume = await postJson(`${origin}/api/tasks/${task.id}/resume`, {})
    expect(resume.status).toBe(202)
    await waitForStatus(origin, task.id, 'done')
    expect(implementer.calls[0]).toMatchObject({
      cwd: '/saved/worktree',
      resumeSessionId: 'session-before-restart',
    })
    expect(executor.prepareCalls).toBe(0)
    expect(dir).toBeTruthy()
  })
})
