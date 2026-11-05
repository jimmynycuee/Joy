import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
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
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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

function websocketError(url: string, options: { origin: string; headers?: Record<string, string> }) {
  return new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('error', (error) => resolve(error.message))
    socket.once('open', () => {
      socket.close()
      reject(new Error('WebSocket unexpectedly opened'))
    })
  })
}
const diff: WorkspaceDiff = {
  files: [{ path: 'src/fix.ts', status: 'modified', additions: 1, deletions: 0 }],
  patch: 'diff --git a/src/fix.ts b/src/fix.ts\n+fixed\n',
}

class FakeProvider implements AgentProvider {
  readonly calls: RunOptions[] = []
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
    if (options.prompt === 'wait') {
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

class FailOnceConfigStore extends ConfigStore {
  failNextRead = false

  override async get() {
    if (this.failNextRead) {
      this.failNextRead = false
      throw new Error('Simulated config read failure')
    }
    return super.get()
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
    secretBackend?: MemoryBackend
    secretEnv?: NodeJS.ProcessEnv
    configStore?: ConfigStore
    remoteAccessToken?: string
    allowPlaywrightOrigin?: boolean
  } = {},
) {
  vi.stubEnv('JOY_REMOTE_ACCESS_TOKEN', options.remoteAccessToken)
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
  const redactor = options.redactor ?? new Redactor()
  const secretBackend = options.secretBackend ?? new MemoryBackend()
  const serverOptions: JoyServerOptions = {
    home: dir,
    database: db,
    configStore: options.configStore ?? new ConfigStore(join(dir, 'config.yaml')),
    secretStore: new SecretStore({
      backend: secretBackend,
      ...(options.secretEnv ? { env: options.secretEnv } : {}),
      onSecret: (secret) => redactor.add(secret),
    }),
    redactor,
    executor,
    providers: {
      'claude-cli': implementer,
      'codex-cli': reviewer,
      'openai-api': api,
    },
    ...(options.redactor ? { redactor: options.redactor } : {}),
    ...(options.allowPlaywrightOrigin ? { allowPlaywrightOrigin: true } : {}),
  }
  const serverPromise = createJoyServer(serverOptions)
  return {
    dir,
    db,
    executor,
    implementer,
    reviewer,
    api,
    secretBackend,
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

async function waitForStatus(
  origin: string,
  id: string,
  status: string,
  headers?: Record<string, string>,
): Promise<TaskDetails> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${origin}/api/tasks/${id}`, headers ? { headers } : {})
    const body = (await response.json()) as TaskDetails
    if (body.task.status === status) return body
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Task did not reach ${status}`)
}

async function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function requestWithHeaders(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.once('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.once('error', reject)
    req.end(body)
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

    const socket = new WebSocket(`${websocket}/ws?taskId=${task.id}`, { origin: 'http://127.0.0.1:5173' })
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
  })

  it('requires bearer authentication for HTTP and WebSocket requests when configured', async () => {
    const token = 'b'.repeat(64)
    const consoleLog = vi.spyOn(console, 'log')
    const consoleInfo = vi.spyOn(console, 'info')
    const consoleWarn = vi.spyOn(console, 'warn')
    const consoleError = vi.spyOn(console, 'error')
    const { db, serverPromise } = fixture({ remoteAccessToken: token })
    const { origin, websocket, server } = await start(serverPromise)
    expect(server.httpServer.address()).toMatchObject({ address: '127.0.0.1' })

    const unauthenticated = await fetch(`${origin}/api/health`)
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('www-authenticate')).toContain('Bearer')
    expect(await unauthenticated.text()).not.toContain(token)

    const invalid = await fetch(`${origin}/api/repos`, {
      headers: { authorization: 'Bearer invalid-token' },
    })
    expect(invalid.status).toBe(401)
    const unauthorizedRemoteHost = await requestWithHeaders(`${origin}/api/health`, 'GET', {
      host: 'joy.tailnet.example',
      origin: 'https://joy.tailnet.example',
    })
    expect(unauthorizedRemoteHost.status).toBe(401)
    const queryCredential = await fetch(`${origin}/api/health?token=invalid-token`)
    expect(queryCredential.status).toBe(401)
    expect(db.prepare('SELECT id FROM repos').all()).toHaveLength(0)

    const authorization = { authorization: `Bearer ${token}` }
    const health = await fetch(`${origin}/api/health`, { headers: authorization })
    expect(health.status).toBe(200)
    const remoteHealth = await requestWithHeaders(`${origin}/api/health`, 'GET', {
      ...authorization,
      host: 'joy.tailnet.example',
      origin: 'https://joy.tailnet.example',
    })
    expect(remoteHealth.status).toBe(200)
    const configResponse = await fetch(`${origin}/api/config`, { headers: authorization })
    expect(await configResponse.text()).not.toContain(token)
    const repoResponse = await fetch(`${origin}/api/repos`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/authorized-repo', defaultBranch: 'main' }),
    })
    expect(repoResponse.status).toBe(201)
    const { repo } = (await repoResponse.json()) as { repo: { id: string } }
    const taskResponse = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: repo.id,
        title: 'Authorized task',
        prompt: 'Test remote authentication',
        mode: 'single',
      }),
    })
    expect(taskResponse.status).toBe(201)
    const { task } = (await taskResponse.json()) as { task: { id: string } }
    const taskUrl = `${websocket}/ws?taskId=${task.id}`

    await expect(
      websocketError(taskUrl, {
        origin: 'https://joy.tailnet.example',
        headers: { host: 'joy.tailnet.example' },
      }),
    ).resolves.toContain('401')
    await expect(
      websocketError(taskUrl, {
        origin: 'https://joy.tailnet.example',
        headers: { authorization: 'Bearer invalid-token', host: 'joy.tailnet.example' },
      }),
    ).resolves.toContain('401')

    const socket = new WebSocket(taskUrl, {
      origin: 'https://joy.tailnet.example',
      headers: { ...authorization, host: 'joy.tailnet.example' },
    })
    const socketMessages = await receiveMessages(socket, 1)
    expect(socketMessages[0]).toMatchObject({ type: 'ready', taskId: task.id })
    socket.close()

    const protocolSocket = new WebSocket(taskUrl, ['joy.v1', `joy-bearer.${token}`], {
      origin: 'https://joy.tailnet.example',
      headers: { host: 'joy.tailnet.example' },
    })
    const protocolMessages = await receiveMessages(protocolSocket, 1)
    expect(protocolMessages[0]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(protocolSocket.protocol).toBe('joy.v1')
    expect(protocolSocket.protocol).not.toContain(token)
    protocolSocket.close()

    await waitForStatus(origin, task.id, 'done', authorization)
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    const persistedRows = tableNames.flatMap(({ name }) => {
      const quotedName = `"${name.replaceAll('"', '""')}"`
      return db.prepare(`SELECT * FROM ${quotedName}`).all()
    })
    expect(JSON.stringify(persistedRows)).not.toContain(token)
    const consoleOutput = [
      ...consoleLog.mock.calls.flat(),
      ...consoleInfo.mock.calls.flat(),
      ...consoleWarn.mock.calls.flat(),
      ...consoleError.mock.calls.flat(),
    ]
      .map(String)
      .join('\n')
    expect(consoleOutput).not.toContain(token)
  })

  it('rejects an empty or weak remote access token during startup', async () => {
    for (const remoteAccessToken of ['', 'short', 'a'.repeat(32), 'b'.repeat(64) + '\n']) {
      const { serverPromise } = fixture({ remoteAccessToken })
      await expect(serverPromise).rejects.toThrow(/JOY_REMOTE_ACCESS_TOKEN/)
    }
  })

  it('rejects unsupported compete mode with 422 before creating a task or starting work', async () => {
    const { serverPromise, executor, implementer, reviewer, api } = fixture()
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/p1-only-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Compete is unavailable in P1',
      prompt: 'This must be rejected before work starts.',
      mode: 'compete',
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'Compete mode is not available in P1 yet' })
    const taskList = (await (await fetch(`${origin}/api/tasks`)).json()) as { tasks: unknown[] }
    expect(taskList.tasks).toHaveLength(0)
    expect(executor.prepareCalls).toBe(0)
    expect(implementer.calls).toHaveLength(0)
    expect(reviewer.calls).toHaveLength(0)
    expect(api.calls).toHaveLength(0)
  })

  it('persists early task failures so clients can replay a unique error event', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'joy-failing-config-'))
    dirs.push(configDir)
    const configStore = new FailOnceConfigStore(join(configDir, 'config.yaml'))
    const { serverPromise } = fixture({ configStore })
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/early-failure-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const currentConfig = await configStore.get()
    await configStore.save({
      ...currentConfig,
      roles: {
        ...currentConfig.roles,
        implementer: {
          ...currentConfig.roles.implementer,
          provider: 'openai-api',
          model: 'current-config-model',
        },
      },
    })
    configStore.failNextRead = true

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Fail before attempt setup',
      prompt: 'This should fail during config loading',
      mode: 'review_loop',
    })
    expect(response.status).toBe(201)
    const { task } = (await response.json()) as { task: { id: string } }
    const details = await waitForStatus(origin, task.id, 'failed')
    const errorEvent = details.events.find(
      (value) =>
        typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'error',
    ) as { seq: number; payload: { message: string } }
    expect(errorEvent.seq).toBeGreaterThan(0)
    expect(errorEvent.payload.message).toContain('Simulated config read failure')
    expect(details.attempts).toHaveLength(1)
    expect(details.attempts[0]).toMatchObject({
      provider: 'openai-api',
      model: 'current-config-model',
      status: 'failed',
    })
    expect(details.task.status).toBe('failed')
  })

  it('keeps the task failed and emits no fabricated event when failure-attempt persistence fails', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'joy-failing-attempt-'))
    dirs.push(configDir)
    const configStore = new FailOnceConfigStore(join(configDir, 'config.yaml'))
    const { db, serverPromise } = fixture({ configStore })
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/attempt-persistence-failure', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    db.exec(`
      CREATE TRIGGER reject_attempt_insert
      BEFORE INSERT ON attempts
      BEGIN
        SELECT RAISE(ABORT, 'simulated attempt persistence failure');
      END;
    `)
    configStore.failNextRead = true

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Attempt persistence fails',
      prompt: 'The task state should still become terminal.',
      mode: 'review_loop',
    })
    expect(response.status).toBe(201)
    const { task } = (await response.json()) as { task: { id: string } }
    const details = await waitForStatus(origin, task.id, 'failed')
    expect(details.attempts).toHaveLength(0)
    expect(details.events).toHaveLength(0)
    expect((await fetch(`${origin}/api/health`)).status).toBe(200)
  })

  it('rejects untrusted Host and Origin headers and requires JSON for body methods', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const repositoryUrl = `${origin}/api/repos`
    const body = JSON.stringify({ path: '/rejected-repo', defaultBranch: 'main' })
    const json = { 'content-type': 'application/json' }

    const badHost = await requestWithHeaders(
      repositoryUrl,
      'POST',
      { ...json, host: 'joy.attacker.test' },
      body,
    )
    expect(badHost.status).toBe(403)
    const badOrigin = await requestWithHeaders(
      repositoryUrl,
      'POST',
      { ...json, origin: 'https://attacker.test' },
      body,
    )
    expect(badOrigin.status).toBe(403)
    for (const disallowedOrigin of [
      'custom://127.0.0.1',
      'https://127.0.0.1:5173',
      'http://127.0.0.1:5174',
      'http://localhost:5174',
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    ]) {
      const rejected = await requestWithHeaders(`${origin}/api/health`, 'GET', {
        origin: disallowedOrigin,
      })
      expect(rejected.status, disallowedOrigin).toBe(403)
    }
    const localhostDevOrigin = await requestWithHeaders(`${origin}/api/health`, 'GET', {
      origin: 'http://localhost:5173',
    })
    expect(localhostDevOrigin.status).toBe(200)
    const rejectedSecretWrite = await requestWithHeaders(
      `${origin}/api/secrets/openai-api-key`,
      'PUT',
      { ...json, origin: 'https://attacker.test' },
      JSON.stringify({ value: 'must-not-be-saved' }),
    )
    expect(rejectedSecretWrite.status).toBe(403)
    expect(await (await fetch(`${origin}/api/secrets/openai-api-key`)).json()).toMatchObject({ set: false })
    const missingContentType = await requestWithHeaders(repositoryUrl, 'POST', {}, body)
    expect(missingContentType.status).toBe(415)
    const wrongContentType = await requestWithHeaders(
      repositoryUrl,
      'POST',
      { 'content-type': 'text/plain' },
      body,
    )
    expect(wrongContentType.status).toBe(415)
    const missingPutContentType = await requestWithHeaders(`${origin}/api/config`, 'PUT', {}, '{}')
    expect(missingPutContentType.status).toBe(415)
    for (const [path, method] of [
      ['/api/tasks', 'POST'],
      ['/api/secrets/openai-api-key', 'PUT'],
    ] as const) {
      const missing = await requestWithHeaders(`${origin}${path}`, method, {}, '{}')
      expect(missing.status, `${method} ${path}`).toBe(415)
    }
    expect(await (await fetch(`${origin}/api/secrets/openai-api-key`)).json()).toMatchObject({ set: false })
    const repositories = (await (await fetch(repositoryUrl)).json()) as { repos: unknown[] }
    expect(repositories.repos).toHaveLength(0)

    const accepted = await requestWithHeaders(
      repositoryUrl,
      'POST',
      { ...json, host: 'localhost', origin: 'http://127.0.0.1:5173' },
      body,
    )
    expect(accepted.status).toBe(201)
    const acceptedTauri = await requestWithHeaders(`${origin}/api/health`, 'GET', {
      origin: 'tauri://localhost',
    })
    expect(acceptedTauri.status).toBe(200)
    const ipv6Loopback = await requestWithHeaders(`${origin}/api/health`, 'GET', { host: '[::1]' })
    expect(ipv6Loopback.status).toBe(200)
  })

  it('rejects WebSocket upgrades with an untrusted Host or Origin', async () => {
    const { serverPromise } = fixture()
    const { websocket } = await start(serverPromise)
    const deniedStatus = (options: { origin: string; headers?: Record<string, string> }) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${websocket}/ws?taskId=missing-task`, options)
        socket.once('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0)
          socket.terminate()
        })
        socket.once('open', () => {
          socket.close()
          reject(new Error('Expected the WebSocket upgrade to be rejected'))
        })
        socket.once('error', reject)
      })

    expect(await deniedStatus({ origin: 'http://127.0.0.1:5174' })).toBe(403)
    expect(
      await deniedStatus({ origin: 'http://127.0.0.1:5173', headers: { host: 'joy.attacker.test' } }),
    ).toBe(403)
  })

  it('allows the Playwright origin only when explicitly enabled', async () => {
    const defaultServer = fixture()
    const { origin: defaultOrigin } = await start(defaultServer.serverPromise)
    const denied = await requestWithHeaders(`${defaultOrigin}/api/health`, 'GET', {
      origin: 'http://127.0.0.1:4173',
    })
    expect(denied.status).toBe(403)
    const deniedLocalhost = await requestWithHeaders(`${defaultOrigin}/api/health`, 'GET', {
      origin: 'http://localhost:4173',
    })
    expect(deniedLocalhost.status).toBe(403)
    const deniedDynamicLoopback = await requestWithHeaders(`${defaultOrigin}/api/health`, 'GET', {
      origin: 'http://127.0.0.1:49131',
    })
    expect(deniedDynamicLoopback.status).toBe(403)

    const playwrightServer = fixture({ allowPlaywrightOrigin: true })
    const { origin: playwrightOrigin } = await start(playwrightServer.serverPromise)
    const allowed = await requestWithHeaders(`${playwrightOrigin}/api/health`, 'GET', {
      origin: 'http://127.0.0.1:4173',
    })
    expect(allowed.status).toBe(200)
    const allowedLocalhost = await requestWithHeaders(`${playwrightOrigin}/api/health`, 'GET', {
      origin: 'http://localhost:4173',
    })
    expect(allowedLocalhost.status).toBe(200)
    const allowedDynamicLoopback = await requestWithHeaders(`${playwrightOrigin}/api/health`, 'GET', {
      origin: 'http://localhost:49131',
    })
    expect(allowedDynamicLoopback.status).toBe(200)

    for (const origin of [
      'https://localhost:49131',
      'http://example.test:49131',
      'http://localhost:0',
      'http://localhost',
      'http://localhost:49131/path',
    ]) {
      const rejected = await requestWithHeaders(`${playwrightOrigin}/api/health`, 'GET', { origin })
      expect(rejected.status, `${origin} must remain rejected`).toBe(403)
    }
  })

  it('manages OpenAI keys without exposing them and redacts subsequent fake-provider events', async () => {
    const key = 'test-openai-key-kept-out-of-responses-123'
    const implementer = new FakeProvider('claude-cli', [
      { type: 'message', text: `Agent repeated ${key}` },
      { type: 'done', sessionId: 'fake-session', isError: false },
    ])
    const { db, secretBackend, serverPromise } = fixture({ implementer })
    const { origin } = await start(serverPromise)

    const emptyStatus = await fetch(`${origin}/api/secrets/openai-api-key`)
    expect(await emptyStatus.json()).toEqual({ set: false })
    const rejected = await fetch(`${origin}/api/secrets/openai-api-key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'short' }),
    })
    expect(rejected.status).toBe(400)
    expect(secretBackend.values.has('openai_api_key')).toBe(false)

    const saved = await fetch(`${origin}/api/secrets/openai-api-key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: key }),
    })
    expect(saved.status).toBe(200)
    const savedBody = await saved.text()
    expect(savedBody).not.toContain(key)
    expect(JSON.parse(savedBody)).toEqual({ set: true, source: 'keychain' })
    expect(secretBackend.values.get('openai_api_key')).toBe(key)

    const config = await (await fetch(`${origin}/api/config`)).text()
    expect(config).not.toContain(key)
    const repo = (await (
      await postJson(`${origin}/api/repos`, { path: '/secret-test-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const created = await postJson(`${origin}/api/tasks`, {
      repoId: repo.repo.id,
      title: 'Check safe event redaction',
      prompt: 'Return the fake response',
      mode: 'single',
    })
    const { task } = (await created.json()) as { task: { id: string } }
    const result = await waitForStatus(origin, task.id, 'done')
    const responseBody = JSON.stringify(result)
    expect(responseBody).not.toContain(key)
    expect(responseBody).toContain('[REDACTED]')
    expect(JSON.stringify(db.prepare('SELECT payload FROM events').all())).not.toContain(key)

    const deleted = await fetch(`${origin}/api/secrets/openai-api-key`, { method: 'DELETE' })
    expect(await deleted.json()).toEqual({ set: false })
    expect(secretBackend.values.has('openai_api_key')).toBe(false)
  })

  it('reports environment-managed OpenAI keys without revealing or shadowing them', async () => {
    const envKey = 'environment-openai-secret-never-return-52'
    const backend = new MemoryBackend()
    const { serverPromise } = fixture({ secretBackend: backend, secretEnv: { OPENAI_API_KEY: envKey } })
    const { origin } = await start(serverPromise)

    const status = await fetch(`${origin}/api/secrets/openai-api-key`)
    const statusText = await status.text()
    expect(JSON.parse(statusText)).toEqual({ set: true, source: 'env' })
    expect(statusText).not.toContain(envKey)

    const put = await fetch(`${origin}/api/secrets/openai-api-key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'replacement-openai-secret-53' }),
    })
    expect(put.status).toBe(409)
    expect(await put.text()).not.toContain(envKey)
    const deleted = await fetch(`${origin}/api/secrets/openai-api-key`, { method: 'DELETE' })
    expect(deleted.status).toBe(409)
    expect(await deleted.text()).not.toContain(envKey)
    expect(backend.values.has('openai_api_key')).toBe(false)
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
      origin: 'http://127.0.0.1:5173',
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
    const cancelled = await requestWithHeaders(`${origin}/api/tasks/${task.id}/cancel`, 'POST', {})
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
    const resume = await requestWithHeaders(`${origin}/api/tasks/${task.id}/resume`, 'POST', {})
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
