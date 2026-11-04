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
    allowPlaywrightOrigin?: boolean
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
  const redactor = options.redactor ?? new Redactor()
  const secretBackend = options.secretBackend ?? new MemoryBackend()
  const serverOptions: JoyServerOptions = {
    home: dir,
    database: db,
    configStore: new ConfigStore(join(dir, 'config.yaml')),
    secretStore: new SecretStore({
      backend: secretBackend,
      ...(options.secretEnv ? { env: options.secretEnv } : {}),
      onSecret: (secret) => redactor.add(secret),
    }),
    redactor,
    executor,
    ...(options.allowPlaywrightOrigin ? { allowPlaywrightOrigin: true } : {}),
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

async function waitForStatus(origin: string, id: string, status: string): Promise<TaskDetails> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${origin}/api/tasks/${id}`)
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

function rawRequest(
  origin: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body = '',
): Promise<{ status: number; body: string }> {
  const { port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: Number(port), path, method, headers },
      (response) => {
        response.setEncoding('utf8')
        let responseBody = ''
        response.on('data', (chunk: string) => {
          responseBody += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: responseBody }))
      },
    )
    request.on('error', reject)
    request.end(body)
  })
}

function tryWebSocket(url: string, origin: string): Promise<{ status: number; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin })
    const messages: unknown[] = []
    let settled = false
    const finish = (status: number) => {
      if (settled) return
      settled = true
      resolve({ status, messages })
      socket.terminate()
    }
    socket.on('message', (data: RawData) => {
      messages.push(JSON.parse(data.toString()) as unknown)
      finish(101)
    })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      finish(response.statusCode ?? 0)
    })
    socket.once('error', reject)
  })
}

describe('Joy local server', () => {
  it('rejects non-loopback Host headers before processing API requests', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const response = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      { host: 'attacker.example', origin, 'content-type': 'application/json' },
      JSON.stringify({ path: '/tmp/repo', defaultBranch: 'main' }),
    )

    expect(response.status).toBe(403)
    const { repos } = (await (await fetch(`${origin}/api/repos`)).json()) as { repos: unknown[] }
    expect(repos).toHaveLength(0)
  })

  it.each(['http://127.0.0.1:5174', 'https://127.0.0.1:5173'])(
    'rejects cross-origin HTTP requests from %s',
    async (attackerOrigin) => {
      const { serverPromise } = fixture()
      const { origin } = await start(serverPromise)
      const response = await rawRequest(
        origin,
        '/api/repos',
        'POST',
        {
          host: new URL(origin).host,
          origin: attackerOrigin,
          'content-type': 'application/json',
        },
        JSON.stringify({ path: '/tmp/cross-origin-repo', defaultBranch: 'main' }),
      )

      expect(response.status).toBe(403)
      const { repos } = (await (await fetch(`${origin}/api/repos`)).json()) as { repos: unknown[] }
      expect(repos).toHaveLength(0)
    },
  )

  it('rejects non-loopback Host headers on WebSocket upgrades', async () => {
    const { serverPromise } = fixture()
    const { origin, websocket } = await start(serverPromise)
    const socket = new WebSocket(`${websocket}/ws?taskId=missing`, {
      origin,
      headers: { host: 'attacker.example' },
    })
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      socket.once('error', reject)
    })

    expect(status).toBe(403)
    socket.terminate()
  })

  it('rejects untrusted Origin headers on WebSocket upgrades with a local Host', async () => {
    const { serverPromise } = fixture()
    const { websocket } = await start(serverPromise)
    const socket = new WebSocket(`${websocket}/ws?taskId=missing`, {
      origin: 'https://attacker.example',
    })
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      socket.once('error', reject)
    })

    expect(status).toBe(403)
    socket.terminate()
  })

  it('rejects untrusted Origin headers before processing API requests', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const response = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      { host: new URL(origin).host, origin: 'https://attacker.example', 'content-type': 'text/plain' },
      JSON.stringify({ path: '/tmp/repo', defaultBranch: 'main' }),
    )

    expect(response.status).toBe(403)
    const { repos } = (await (await fetch(`${origin}/api/repos`)).json()) as { repos: unknown[] }
    expect(repos).toHaveLength(0)
  })

  it('rejects unapproved loopback ports and schemes before HTTP mutations', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const host = new URL(origin).host
    const attackerOrigins = ['http://127.0.0.1:5174', 'https://127.0.0.1:5173']
    const responses = await Promise.all(
      attackerOrigins.map((attackerOrigin, index) =>
        rawRequest(
          origin,
          '/api/repos',
          'POST',
          { host, origin: attackerOrigin, 'content-type': 'application/json' },
          JSON.stringify({ path: `/tmp/attacker-repo-${index}`, defaultBranch: 'main' }),
        ),
      ),
    )

    expect(responses.map((response) => response.status)).toEqual([403, 403])
    const { repos } = (await (await fetch(`${origin}/api/repos`)).json()) as { repos: unknown[] }
    expect(repos).toHaveLength(0)
  })

  it.each(['http://127.0.0.1:5174', 'https://127.0.0.1:5173'])(
    'rejects unapproved WebSocket origin %s without exposing task events',
    async (attackerOrigin) => {
      const { db, serverPromise } = fixture()
      const { origin, websocket } = await start(serverPromise)
      const repo = createRepo(db, {
        id: rid('origin-regression-repo'),
        path: '/tmp/origin-regression-repo',
        defaultBranch: 'main',
      })
      const response = await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title: 'Private task data',
        prompt: 'This task event must not be exposed',
        mode: 'single',
      })
      expect(response.status).toBe(201)
      const { task } = (await response.json()) as { task: { id: string } }
      const details = await waitForStatus(origin, task.id, 'done')
      expect(details.events.length).toBeGreaterThan(0)

      const rejected = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, attackerOrigin)
      expect(rejected.status).toBe(403)
      expect(rejected.messages).toEqual([])
    },
  )

  it('requires JSON Content-Type and accepts the supported Vite and Tauri origins', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const rejected = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      { host: new URL(origin).host, 'content-type': 'text/plain' },
      JSON.stringify({ path: '/tmp/rejected', defaultBranch: 'main' }),
    )
    expect(rejected.status).toBe(415)

    const config = await rawRequest(
      origin,
      '/api/config',
      'PUT',
      { host: new URL(origin).host },
      JSON.stringify({}),
    )
    expect(config.status).toBe(415)

    const unknownRoute = await rawRequest(origin, '/api/unknown', 'POST', { host: new URL(origin).host })
    expect(unknownRoute.status).toBe(404)

    const vite = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      {
        host: new URL(origin).host,
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
      },
      JSON.stringify({ path: '/tmp/vite', defaultBranch: 'main' }),
    )
    expect(vite.status).toBe(201)

    const sameOrigin = await rawRequest(origin, '/api/health', 'GET', { host: new URL(origin).host, origin })
    expect(sameOrigin.status).toBe(200)

    const localhostVite = await rawRequest(origin, '/api/health', 'GET', {
      host: new URL(origin).host,
      origin: 'http://localhost:5173',
    })
    expect(localhostVite.status).toBe(200)

    const tauri = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      {
        host: new URL(origin).host,
        origin: 'tauri://localhost',
        'content-type': 'application/json; charset=utf-8',
      },
      JSON.stringify({ path: '/tmp/tauri', defaultBranch: 'main' }),
    )
    expect(tauri.status).toBe(201)
  })

  it('accepts only the explicit Playwright origin when enabled for E2E', async () => {
    const { serverPromise } = fixture({ allowPlaywrightOrigin: true })
    const { origin } = await start(serverPromise)
    const accepted = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      {
        host: new URL(origin).host,
        origin: 'http://127.0.0.1:4173',
        'content-type': 'application/json',
      },
      JSON.stringify({ path: '/tmp/playwright', defaultBranch: 'main' }),
    )
    expect(accepted.status).toBe(201)

    const notConfigured = await Promise.all([
      rawRequest(
        origin,
        '/api/repos',
        'POST',
        {
          host: new URL(origin).host,
          origin: 'http://127.0.0.1:4174',
          'content-type': 'application/json',
        },
        JSON.stringify({ path: '/tmp/unconfigured-playwright', defaultBranch: 'main' }),
      ),
      rawRequest(
        origin,
        '/api/repos',
        'POST',
        {
          host: new URL(origin).host,
          origin: 'https://127.0.0.1:4173',
          'content-type': 'application/json',
        },
        JSON.stringify({ path: '/tmp/wrong-scheme-playwright', defaultBranch: 'main' }),
      ),
    ])
    expect(notConfigured.map((response) => response.status)).toEqual([403, 403])
  })

  it('returns 400 for malformed percent encoding in task paths', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const responses = await Promise.all([
      fetch(`${origin}/api/tasks/%E0%A4%A`),
      fetch(`${origin}/api/tasks/%E0%A4%A/events`),
      rawRequest(origin, '/api/tasks/%E0%A4%A/cancel', 'POST', {}),
      rawRequest(origin, '/api/tasks/%E0%A4%A/resume', 'POST', {}),
    ])

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400])
  })

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

    const sameOriginSocket = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, origin)
    expect(sameOriginSocket.status).toBe(101)
    expect(sameOriginSocket.messages[0]).toMatchObject({ type: 'ready', taskId: task.id })

    const tauriSocket = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, 'tauri://localhost')
    expect(tauriSocket.status).toBe(101)
    expect(tauriSocket.messages[0]).toMatchObject({ type: 'ready', taskId: task.id })

    const compete = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Compare implementations',
      prompt: 'Do it',
      mode: 'compete',
    })
    expect(compete.status).toBe(422)
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
      origin: restartedOrigin,
    })
    const messages = await receiveMessages(socket, replayed.events.length + 1)
    expect(messages[0]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(messages.slice(1)).toEqual(replayed.events.map((event) => ({ type: 'event', event })))
    socket.close()
  })

  it('rejects single-mode tasks for providers that cannot edit code', async () => {
    const { api, executor, serverPromise } = fixture()
    executor.diff = async () => ({ files: [], patch: '' })
    api.capabilities.codeEdit = false
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Make a code change',
      prompt: 'Change the implementation',
      mode: 'single',
      roleOverrides: { implementer: { provider: 'openai-api', model: 'gpt-test' } },
    })

    expect(response.status).toBe(422)
    expect(api.calls).toHaveLength(0)
    const { tasks } = (await (await fetch(`${origin}/api/tasks`)).json()) as { tasks: unknown[] }
    expect(tasks).toHaveLength(0)
  })

  it('allows a no-op single-mode task when the provider supports code editing', async () => {
    const { executor, serverPromise } = fixture()
    executor.diff = async () => ({ files: [], patch: '' })
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Check whether a change is needed',
      prompt: 'Review the implementation; do not edit if no fix is needed',
      mode: 'single',
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku' } },
    })
    expect(response.status).toBe(201)
    const { task } = (await response.json()) as { task: { id: string } }
    const result = await waitForStatus(origin, task.id, 'done')

    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          payload: expect.objectContaining({ status: 'succeeded', diff: { files: [], patch: '' } }),
        }),
      ]),
    )
  })

  it('rejects single-mode tasks for providers that cannot edit code', async () => {
    const { api, executor, serverPromise } = fixture()
    executor.diff = async () => ({ files: [], patch: '' })
    api.capabilities.codeEdit = false
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Make a code change',
      prompt: 'Change the implementation',
      mode: 'single',
      roleOverrides: { implementer: { provider: 'openai-api', model: 'gpt-test' } },
    })

    expect(response.status).toBe(422)
    expect(api.calls).toHaveLength(0)
    const { tasks } = (await (await fetch(`${origin}/api/tasks`)).json()) as { tasks: unknown[] }
    expect(tasks).toHaveLength(0)
  })

  it('allows a no-op single-mode task when the provider supports code editing', async () => {
    const { executor, serverPromise } = fixture()
    executor.diff = async () => ({ files: [], patch: '' })
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Check whether a change is needed',
      prompt: 'Review the implementation; do not edit if no fix is needed',
      mode: 'single',
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku' } },
    })
    expect(response.status).toBe(201)
    const { task } = (await response.json()) as { task: { id: string } }
    const result = await waitForStatus(origin, task.id, 'done')

    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          payload: expect.objectContaining({ status: 'succeeded', diff: { files: [], patch: '' } }),
        }),
      ]),
    )
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
    const cancelled = await rawRequest(origin, `/api/tasks/${task.id}/cancel`, 'POST', {})
    expect(cancelled.status).toBe(200)
    const result = await waitForStatus(origin, task.id, 'cancelled')
    expect(result.task.status).toBe('cancelled')
  })

  it('rejects resuming legacy single-mode tasks with a non-editing provider before queueing', async () => {
    const { api, db, serverPromise } = fixture()
    api.capabilities.codeEdit = false
    const repo = createRepo(db, { id: rid('legacy-resume-repo'), path: '/repo', defaultBranch: 'main' })
    const task = createTask(db, {
      id: tid('legacy-resume-task'),
      repoId: repo.id,
      title: 'Resume legacy task',
      prompt: 'Finish the change',
      mode: 'single',
    })
    const attempt = createAttempt(db, {
      id: aid('legacy-resume-attempt'),
      taskId: task.id,
      provider: 'openai-api',
      model: 'gpt-test',
      status: 'failed',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: '/saved/worktree',
      branch: 'joy/legacy-resume-task/legacy-resume-attempt',
      baseCommit: 'base-sha',
      sessionId: 'legacy-session',
    })
    setTaskStatus(db, task.id, 'failed')

    const { origin } = await start(serverPromise)
    const response = await rawRequest(origin, `/api/tasks/${task.id}/resume`, 'POST', {})
    await waitForStatus(origin, task.id, 'failed')
    const details = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails

    expect(response.status).toBe(409)
    expect(response.body).toContain('does not support code editing required by single mode')
    expect(details.task.status).toBe('failed')
    expect(details.attempts[0]).toMatchObject({ status: 'failed' })
    expect(details.events).toHaveLength(0)
    expect(api.calls).toHaveLength(0)
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
    const resume = await rawRequest(origin, `/api/tasks/${task.id}/resume`, 'POST', {})
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
