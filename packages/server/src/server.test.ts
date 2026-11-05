import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
import {
  appendTaskEvent,
  createAttempt,
  createRepo,
  createTask,
  openDatabase,
  setTaskStatus,
  updateAttempt,
} from '@joy/db'
import type { Database } from '@joy/db'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { createJoyServer } from './server.js'
import type { JoyServer, JoyServerOptions } from './server.js'
import WebSocket, { type RawData } from 'ws'

const dirs: string[] = []
const servers: JoyServer[] = []
const databases: Database[] = []
const VITE_ORIGIN = 'http://127.0.0.1:5173'
const TEST_API_TOKEN = 'test-api-token-for-server-tests-72'

function fetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${TEST_API_TOKEN}`)
  return globalThis.fetch(input, { ...init, headers })
}

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
  onRun?: (options: RunOptions) => Promise<void>
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
    await this.onRun?.(options)
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
    secretBackend?: MemoryBackend
    secretEnv?: NodeJS.ProcessEnv
    allowPlaywrightOrigin?: boolean
    configStore?: ConfigStore
    apiToken?: string
    generateApiToken?: boolean
    home?: string
    tokenFileContents?: string
    tokenFileMode?: number
  } = {},
) {
  const dir = options.home ?? mkdtempSync(join(tmpdir(), 'joy-server-test-'))
  if (!options.home) dirs.push(dir)
  if (options.tokenFileContents !== undefined) {
    const tokenPath = join(dir, 'api-token')
    writeFileSync(tokenPath, options.tokenFileContents, { mode: options.tokenFileMode ?? 0o600 })
    if (options.tokenFileMode !== undefined) chmodSync(tokenPath, options.tokenFileMode)
  }
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
  const configStore = options.configStore ?? new ConfigStore(join(dir, 'config.yaml'))
  const serverOptions: JoyServerOptions = {
    home: dir,
    database: db,
    configStore,
    secretStore: new SecretStore({
      backend: secretBackend,
      ...(options.secretEnv ? { env: options.secretEnv } : {}),
      onSecret: (secret) => redactor.add(secret),
    }),
    redactor,
    executor,
    ...(options.allowPlaywrightOrigin ? { allowPlaywrightOrigin: true } : {}),
    ...(options.generateApiToken ? {} : { apiToken: options.apiToken ?? TEST_API_TOKEN }),
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
    apiToken: options.apiToken ?? (options.generateApiToken ? undefined : TEST_API_TOKEN),
    db,
    executor,
    implementer,
    reviewer,
    api,
    secretBackend,
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
    headers: {
      'content-type': 'application/json',
      origin: VITE_ORIGIN,
      authorization: `Bearer ${TEST_API_TOKEN}`,
    },
    body: JSON.stringify(body),
  })
}

function rawRequest(
  origin: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body = '',
  authToken: string | null = TEST_API_TOKEN,
): Promise<{ status: number; body: string }> {
  const { port } = new URL(origin)
  const normalizedHeaders =
    headers.origin === new URL(origin).origin ? { ...headers, origin: VITE_ORIGIN } : headers
  const requestHeaders = {
    ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    ...normalizedHeaders,
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: Number(port), path, method, headers: requestHeaders },
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

function tryWebSocket(
  url: string,
  origin?: string,
  headers?: Record<string, string>,
  protocols: string[] = ['joy', `joy-auth.${TEST_API_TOKEN}`],
): Promise<{ status: number; messages: unknown[]; protocol: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, {
      ...(origin ? { origin } : {}),
      ...(headers ? { headers } : {}),
    })
    const messages: unknown[] = []
    let settled = false
    const finish = (status: number) => {
      if (settled) return
      settled = true
      resolve({ status, messages, protocol: socket.protocol })
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

async function patchJson(url: string, body: unknown) {
  return fetch(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      origin: VITE_ORIGIN,
      authorization: `Bearer ${TEST_API_TOKEN}`,
    },
    body: JSON.stringify(body),
  })
}

describe('Joy local server', () => {
  it('requires a bearer token for HTTP mutations and a token protocol for WebSocket upgrades', async () => {
    const { db, serverPromise } = fixture()
    const { origin, websocket } = await start(serverPromise)
    const body = JSON.stringify({ path: '/tmp/unauthorized-repo', defaultBranch: 'main' })
    const missing = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      { host: new URL(origin).host, origin: VITE_ORIGIN, 'content-type': 'application/json' },
      body,
      null,
    )
    const wrongToken = `${TEST_API_TOKEN}-wrong`
    const unauthenticatedRead = await rawRequest(
      origin,
      '/api/repos',
      'GET',
      { host: new URL(origin).host, origin: VITE_ORIGIN },
      '',
      null,
    )
    const wrong = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      { host: new URL(origin).host, origin: VITE_ORIGIN, 'content-type': 'application/json' },
      body,
      wrongToken,
    )
    expect(missing.status).toBe(403)
    expect(unauthenticatedRead.status).toBe(403)
    expect(wrong.status).toBe(403)
    const publicHealth = await rawRequest(
      origin,
      '/api/health',
      'GET',
      { host: new URL(origin).host, origin: VITE_ORIGIN },
      '',
      null,
    )
    expect(publicHealth.status).toBe(200)
    expect(missing.body).not.toContain(TEST_API_TOKEN)
    expect(wrong.body).not.toContain(wrongToken)
    const { repos } = (await (await fetch(`${origin}/api/repos`)).json()) as { repos: unknown[] }
    expect(repos).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM repos').get()).toMatchObject({ count: 0 })
    const lowercaseScheme = await rawRequest(
      origin,
      '/api/repos',
      'GET',
      { host: new URL(origin).host, origin: VITE_ORIGIN, authorization: `bearer ${TEST_API_TOKEN}` },
      '',
      null,
    )
    expect(lowercaseScheme.status).toBe(200)

    const repo = createRepo(db, { id: rid('auth-ws-repo'), path: '/auth-ws-repo', defaultBranch: 'main' })
    const task = createTask(db, {
      id: tid('auth-ws-task'),
      repoId: repo.id,
      title: 'Auth-gated socket',
      prompt: 'Do not expose this task without authentication',
      mode: 'single',
    })
    const missingSocket = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, VITE_ORIGIN, undefined, [
      'joy',
    ])
    const wrongSocket = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, VITE_ORIGIN, undefined, [
      'joy',
      `joy-auth.${wrongToken}`,
    ])
    const missingMarkerSocket = await tryWebSocket(
      `${websocket}/ws?taskId=${task.id}`,
      VITE_ORIGIN,
      undefined,
      [`joy-auth.${TEST_API_TOKEN}`],
    )
    const duplicateCredentialSocket = await rawRequest(
      websocket,
      `/ws?taskId=${task.id}`,
      'GET',
      {
        host: new URL(websocket).host,
        origin: VITE_ORIGIN,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        'sec-websocket-protocol': `joy, joy-auth.${TEST_API_TOKEN}, joy-auth.${TEST_API_TOKEN}`,
      },
      '',
      null,
    )
    expect(missingSocket.status).toBe(403)
    expect(wrongSocket.status).toBe(403)
    expect(missingMarkerSocket.status).toBe(403)
    expect(duplicateCredentialSocket.status).toBe(403)
    expect(missingSocket.messages).toEqual([])
    expect(wrongSocket.messages).toEqual([])
    expect(missingMarkerSocket.messages).toEqual([])
    expect(missingSocket.protocol).toBe('')
    expect(wrongSocket.protocol).toBe('')
    expect(missingMarkerSocket.protocol).toBe('')
  })

  it('rejects missing and incorrect credentials for every API route before dispatch', async () => {
    const { db, executor, serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const protectedRequests: Array<[string, string]> = [
      ['GET', '/api'],
      ['GET', '/api/'],
      ['GET', '/api/repos'],
      ['POST', '/api/repos'],
      ['GET', '/api/tasks'],
      ['POST', '/api/tasks'],
      ['GET', '/api/tasks/auth-test'],
      ['GET', '/api/tasks/auth-test/events'],
      ['POST', '/api/tasks/auth-test/cancel'],
      ['POST', '/api/tasks/auth-test/resume'],
      ['GET', '/api/usage'],
      ['GET', '/api/config'],
      ['PUT', '/api/config'],
      ['GET', '/api/secrets/openai-api-key'],
      ['PUT', '/api/secrets/openai-api-key'],
      ['DELETE', '/api/secrets/openai-api-key'],
      ['GET', '/api/providers'],
      ['GET', '/api/unknown'],
      ['HEAD', '/api/health'],
      ['OPTIONS', '/api/health'],
    ]

    for (const [method, path] of protectedRequests) {
      for (const token of [null, 'wrong-auth-token-12345']) {
        const response = await rawRequest(
          origin,
          path,
          method,
          {
            host: new URL(origin).host,
            origin: VITE_ORIGIN,
            ...(method === 'POST' || method === 'PUT' ? { 'content-type': 'application/json' } : {}),
          },
          method === 'POST' || method === 'PUT' ? '{}' : '',
          token,
        )
        expect(response.status, `${method} ${path}`).toBe(403)
      }
    }

    expect(db.prepare('SELECT COUNT(*) AS count FROM repos').get()).toMatchObject({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toMatchObject({ count: 0 })
    expect(executor.prepareCalls).toBe(0)
  })

  it('generates and reuses a private random API token without returning it publicly', async () => {
    const generated = fixture({ generateApiToken: true })
    const { server, origin } = await start(generated.serverPromise)
    const tokenPath = join(generated.dir, 'api-token')
    const token = readFileSync(tokenPath, 'utf8')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    if (process.platform !== 'win32') expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect(Object.keys(server)).not.toContain('apiToken')
    expect(await (await fetch(`${origin}/api/health`)).text()).not.toContain(token)
    expect(existsSync(tokenPath)).toBe(true)

    const second = fixture({ generateApiToken: true })
    await start(second.serverPromise)
    expect(readFileSync(join(second.dir, 'api-token'), 'utf8')).not.toBe(token)

    await server.close()
    const restarted = await generated.restart()
    servers.push(restarted)
    const address = await restarted.listen()
    const restartedOrigin = `http://127.0.0.1:${address.port}`
    const accepted = await rawRequest(
      restartedOrigin,
      '/api/repos',
      'POST',
      {
        host: new URL(restartedOrigin).host,
        origin: VITE_ORIGIN,
        'content-type': 'application/json',
      },
      JSON.stringify({ path: '/tmp/reused-token', defaultBranch: 'main' }),
      token,
    )
    expect(accepted.status).toBe(201)
  })

  it('trims a trailing newline from a private token file', async () => {
    const app = fixture({ generateApiToken: true, tokenFileContents: `${TEST_API_TOKEN}\n` })
    const { origin } = await start(app.serverPromise)
    const accepted = await rawRequest(
      origin,
      '/api/repos',
      'GET',
      { host: new URL(origin).host, origin: VITE_ORIGIN },
      '',
      TEST_API_TOKEN,
    )
    expect(accepted.status).toBe(200)
  })

  it('fails closed with recovery instructions for an empty token file', async () => {
    const app = fixture({ generateApiToken: true, tokenFileContents: '' })
    await expect(app.serverPromise).rejects.toThrow(/API token file is empty; remove it and restart Joy/)
  })

  it('atomically shares one generated token across concurrent server startups', async () => {
    const home = mkdtempSync(join(tmpdir(), 'joy-server-shared-token-'))
    dirs.push(home)
    const first = fixture({ home, generateApiToken: true })
    const second = fixture({ home, generateApiToken: true })
    const [firstServer, secondServer] = await Promise.all([
      start(first.serverPromise),
      start(second.serverPromise),
    ])
    const token = readFileSync(join(home, 'api-token'), 'utf8')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const accepted = await Promise.all(
      [firstServer.origin, secondServer.origin].map((origin) =>
        rawRequest(
          origin,
          '/api/repos',
          'GET',
          { host: new URL(origin).host, origin: VITE_ORIGIN },
          '',
          token,
        ),
      ),
    )
    expect(accepted.map((response) => response.status)).toEqual([200, 200])
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a token file with group or world permissions without changing it',
    async () => {
      const app = fixture({
        generateApiToken: true,
        tokenFileContents: TEST_API_TOKEN,
        tokenFileMode: 0o644,
      })
      await expect(app.serverPromise).rejects.toThrow(/permissions must restrict access to its owner/)
      expect(statSync(join(app.dir, 'api-token')).mode & 0o777).toBe(0o644)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic token file without changing its target',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'joy-server-token-link-'))
      dirs.push(home)
      const target = join(home, 'shared-token')
      writeFileSync(target, TEST_API_TOKEN, { mode: 0o644 })
      chmodSync(target, 0o644)
      symlinkSync(target, join(home, 'api-token'))
      const app = fixture({ home, generateApiToken: true })

      await expect(app.serverPromise).rejects.toThrow(/must not be a symbolic link/)
      expect(statSync(target).mode & 0o777).toBe(0o644)
    },
  )

  it('rejects malformed injected tokens before starting the server', async () => {
    const app = fixture({ apiToken: 'short' })
    await expect(app.serverPromise).rejects.toThrow(/at least 16 URL-safe characters/)
  })

  it('redacts the API token from authentication errors and persisted task replay', async () => {
    const implementer = new FakeProvider('claude-cli', [
      { type: 'message', text: `Provider echoed ${TEST_API_TOKEN}` },
      { type: 'done', sessionId: 'token-redaction-session', isError: false },
    ])
    const { dir, serverPromise } = fixture({ implementer })
    const { origin, websocket } = await start(serverPromise)
    expect(existsSync(join(dir, 'api-token'))).toBe(false)
    const badToken = `${TEST_API_TOKEN}-invalid`
    const error = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      { host: new URL(origin).host, origin: VITE_ORIGIN, 'content-type': 'application/json' },
      JSON.stringify({ path: '/tmp/token-redaction-repo', defaultBranch: 'main' }),
      badToken,
    )
    expect(error.status).toBe(403)
    expect(error.body).not.toContain(TEST_API_TOKEN)
    expect(error.body).not.toContain(badToken)

    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/tmp/token-redaction-repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const { task } = (await (
      await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title: 'Redact auth token',
        prompt: 'Return an event containing the token',
        mode: 'single',
      })
    ).json()) as { task: { id: string } }
    const details = await waitForStatus(origin, task.id, 'done')
    const replay = await (await fetch(`${origin}/api/tasks/${task.id}/events?after=0`)).text()
    expect(JSON.stringify(details.events)).not.toContain(TEST_API_TOKEN)
    expect(JSON.stringify(details.events)).toContain('[REDACTED]')
    expect(replay).not.toContain(TEST_API_TOKEN)
    expect(replay).toContain('[REDACTED]')

    const socket = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, VITE_ORIGIN)
    expect(socket.status).toBe(101)
    expect(socket.protocol).toBe('joy')
    expect(JSON.stringify(socket.messages)).not.toContain(TEST_API_TOKEN)
  })

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

  it.each(['localhost:abc', 'localhost:0', '127.0.0.1:70000', 'joy.attacker.example'])(
    'rejects malformed or hostile Host headers such as %s',
    async (host) => {
      const { serverPromise } = fixture()
      const { origin } = await start(serverPromise)
      const response = await rawRequest(origin, '/api/health', 'GET', { host, origin })
      expect(response.status).toBe(403)
    },
  )

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

  it('rejects hostile and malformed Host headers on WebSocket upgrades', async () => {
    const { serverPromise } = fixture()
    const { origin, websocket } = await start(serverPromise)
    const url = `${websocket}/ws?taskId=missing`
    const hostileHost = await tryWebSocket(url, origin, { host: 'attacker.example' })
    const malformedHost = await tryWebSocket(url, origin, { host: 'localhost:abc' })
    const overflowPort = await tryWebSocket(url, origin, { host: '127.0.0.1:70000' })

    expect(hostileHost.status).toBe(403)
    expect(malformedHost.status).toBe(403)
    expect(overflowPort.status).toBe(403)
    expect(hostileHost.messages).toEqual([])
  })

  it('rejects untrusted, missing, and same-authority unapproved Origins on WebSocket upgrades', async () => {
    const { serverPromise } = fixture()
    const { websocket } = await start(serverPromise)
    const url = `${websocket}/ws?taskId=missing`
    const hostile = await tryWebSocket(url, 'https://attacker.example')
    const originless = await tryWebSocket(url)
    const crossSite = await tryWebSocket(url, 'http://127.0.0.1:4317', { 'sec-fetch-site': 'cross-site' })
    const sameAuthorityUnapproved = await tryWebSocket(url, 'http://127.0.0.1:5174', {
      host: '127.0.0.1:5174',
    })

    expect(hostile.status).toBe(403)
    expect(hostile.messages).toEqual([])
    expect(originless.status).toBe(403)
    expect(originless.messages).toEqual([])
    expect(crossSite.status).toBe(403)
    expect(crossSite.messages).toEqual([])
    expect(sameAuthorityUnapproved.status).toBe(403)
    expect(sameAuthorityUnapproved.messages).toEqual([])
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

  it('rejects same-authority unapproved loopback Origins before HTTP mutations', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const response = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      {
        host: '127.0.0.1:5174',
        origin: 'http://127.0.0.1:5174',
        'content-type': 'application/json',
      },
      JSON.stringify({ path: '/tmp/same-authority-unapproved', defaultBranch: 'main' }),
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

  it('allows supported Vite and Tauri Origins for HTTP requests', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const rejected = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      { host: new URL(origin).host, origin: VITE_ORIGIN, 'content-type': 'text/plain' },
      JSON.stringify({ path: '/tmp/rejected', defaultBranch: 'main' }),
    )
    expect(rejected.status).toBe(415)

    const config = await rawRequest(
      origin,
      '/api/config',
      'PUT',
      { host: new URL(origin).host, origin: VITE_ORIGIN },
      JSON.stringify({}),
    )
    expect(config.status).toBe(415)

    const unknownRoute = await rawRequest(origin, '/api/unknown', 'POST', {
      host: new URL(origin).host,
      origin: VITE_ORIGIN,
    })
    expect(unknownRoute.status).toBe(404)

    const vite = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      {
        host: new URL(origin).host,
        origin: VITE_ORIGIN,
        'content-type': 'application/json',
      },
      JSON.stringify({ path: '/tmp/vite', defaultBranch: 'main' }),
    )
    expect(vite.status).toBe(201)

    const viteHealth = await rawRequest(origin, '/api/health', 'GET', {
      host: new URL(origin).host,
      origin: VITE_ORIGIN,
    })
    expect(viteHealth.status).toBe(200)
    const crossSiteFetch = await rawRequest(origin, '/api/health', 'GET', {
      host: new URL(origin).host,
      origin: VITE_ORIGIN,
      'sec-fetch-site': 'cross-site',
    })
    expect(crossSiteFetch.status).toBe(403)
    const originlessRead = await rawRequest(origin, '/api/health', 'GET', { host: new URL(origin).host })
    expect(originlessRead.status).toBe(200)
    const originlessMutation = await rawRequest(
      origin,
      '/api/repos',
      'POST',
      { host: new URL(origin).host, 'content-type': 'application/json' },
      JSON.stringify({ path: '/tmp/originless', defaultBranch: 'main' }),
    )
    expect(originlessMutation.status).toBe(403)

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

  it('accepts only the fixed Playwright Origins for HTTP and WebSocket in E2E mode', async () => {
    const { db, serverPromise } = fixture({ allowPlaywrightOrigin: true })
    const { origin, websocket } = await start(serverPromise)
    const playwrightOrigins = ['http://127.0.0.1:4173', 'http://localhost:4173']
    const accepted = await Promise.all(
      playwrightOrigins.map((playwrightOrigin, index) =>
        rawRequest(
          origin,
          '/api/repos',
          'POST',
          {
            host: new URL(origin).host,
            origin: playwrightOrigin,
            'content-type': 'application/json',
          },
          JSON.stringify({ path: `/tmp/playwright-${index}`, defaultBranch: 'main' }),
        ),
      ),
    )
    expect(accepted.map((response) => response.status)).toEqual([201, 201])
    const repo = createRepo(db, { id: rid('preview-ws-repo'), path: '/preview-ws', defaultBranch: 'main' })
    const task = createTask(db, {
      id: tid('preview-ws-task'),
      repoId: repo.id,
      title: 'Verify preview origin',
      prompt: 'Check WebSocket allowlisting',
      mode: 'single',
    })
    const sockets = await Promise.all(
      playwrightOrigins.map((playwrightOrigin) =>
        tryWebSocket(`${websocket}/ws?taskId=${task.id}`, playwrightOrigin),
      ),
    )
    expect(sockets.map((socket) => socket.status)).toEqual([101, 101])
    expect(sockets[0]?.messages[0]).toMatchObject({ type: 'snapshot', task: { id: task.id } })

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
      rawRequest(origin, '/api/tasks/%E0%A4%A/cancel', 'POST', { host: new URL(origin).host, origin }),
      rawRequest(origin, '/api/tasks/%E0%A4%A/resume', 'POST', { host: new URL(origin).host, origin }),
      rawRequest(
        origin,
        '/api/repos/%E0%A4%A',
        'PATCH',
        { host: new URL(origin).host, origin, 'content-type': 'application/json' },
        JSON.stringify({ allowedProviders: ['claude-cli'] }),
      ),
    ])

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400])
  })

  it('sends a task snapshot before replaying only events after the WebSocket cursor', async () => {
    const { db, serverPromise } = fixture()
    const { origin, websocket } = await start(serverPromise)
    const repo = createRepo(db, { id: rid('cursor-repo'), path: '/cursor-repo', defaultBranch: 'main' })
    const task = createTask(db, {
      id: tid('cursor-task'),
      repoId: repo.id,
      title: 'Resume event replay',
      prompt: 'Keep the replay ordered',
      mode: 'single',
    })
    const attempt = createAttempt(db, {
      id: aid('cursor-attempt'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    appendTaskEvent(db, attempt.id, 'started', { index: 1 })
    appendTaskEvent(db, attempt.id, 'phase', { index: 2 })
    appendTaskEvent(db, attempt.id, 'phase', { index: 3 })
    const { events } = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails

    const socket = new WebSocket(
      `${websocket}/ws?taskId=${task.id}&after=1`,
      ['joy', `joy-auth.${TEST_API_TOKEN}`],
      { origin: VITE_ORIGIN },
    )
    const messages = await receiveMessages(socket, 4)
    expect(messages[0]).toMatchObject({
      type: 'snapshot',
      task: { id: task.id },
      lastSequence: 3,
    })
    expect(messages[1]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(messages.slice(2)).toEqual(events.slice(1).map((event) => ({ type: 'event', event })))
    socket.close()
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

    const result = await waitForStatus(origin, task.id, 'done')
    const socket = new WebSocket(
      `${websocket}/ws?taskId=${task.id}&after=0`,
      ['joy', `joy-auth.${TEST_API_TOKEN}`],
      { origin: VITE_ORIGIN },
    )
    const messages = await receiveMessages(socket, result.events.length + 2)
    expect(messages[0]).toMatchObject({ type: 'snapshot', task: { id: task.id } })
    expect(messages[1]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(messages.slice(2)).toEqual(result.events.map((event) => ({ type: 'event', event })))
    socket.close()
    expect(result.task.status).toBe('done')
    expect(result.attempts[0]).toMatchObject({ status: 'succeeded', worktreePath: '/fake/worktree' })
    expect(result.events.length).toBeGreaterThan(0)
    expect(executor.prepareCalls).toBe(1)
    expect(db.isOpen).toBe(true)

    const viteOriginSocket = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, VITE_ORIGIN)
    expect(viteOriginSocket.status).toBe(101)
    expect(viteOriginSocket.protocol).toBe('joy')
    expect(viteOriginSocket.messages[0]).toMatchObject({ type: 'snapshot', task: { id: task.id } })

    const localhostSocket = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, 'http://localhost:5173')
    expect(localhostSocket.status).toBe(101)
    expect(localhostSocket.protocol).toBe('joy')

    const tauriSocket = await tryWebSocket(`${websocket}/ws?taskId=${task.id}`, 'tauri://localhost')
    expect(tauriSocket.status).toBe(101)
    expect(tauriSocket.messages[0]).toMatchObject({ type: 'snapshot', task: { id: task.id } })

    const compete = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Compare implementations',
      prompt: 'Do it',
      mode: 'compete',
    })
    expect(compete.status).toBe(422)
  })

  it('exposes a task-scoped Tool Hub to CLI runs with authentication, shared read-only peers, and limits', async () => {
    const implementer = new FakeProvider('claude-cli')
    implementer.capabilities.delegatedApproval = true
    const { reviewer, configStore, serverPromise } = fixture({ implementer })
    await configStore.update((config) => ({ ...config, tool_hub: { max_ask_peer_calls: 1 } }))
    const { origin } = await start(serverPromise)
    const repoResponse = await postJson(`${origin}/api/repos`, {
      path: '/tmp/tool-hub-repo',
      defaultBranch: 'main',
    })
    const { repo } = (await repoResponse.json()) as { repo: { id: string } }
    const taskResponse = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Use the Tool Hub',
      prompt: 'Implement the requested change',
      mode: 'single',
    })
    const { task } = (await taskResponse.json()) as { task: { id: string } }
    const responses: Array<{ status: number; body: unknown }> = []
    let capturedEndpoint: string | undefined
    let capturedToken: string | undefined
    implementer.onRun = async (options) => {
      const mcp = options.mcpServers?.[0]
      if (!mcp || mcp.transport !== 'stdio')
        throw new Error('CLI provider did not receive the stdio Tool Hub')
      expect(mcp).toMatchObject({ name: 'joy', command: process.execPath })
      expect(options.approvalTool).toBe('mcp__joy__approve')
      const endpoint = mcp.env?.JOY_TOOL_HUB_ENDPOINT
      const token = mcp.env?.JOY_TOOL_HUB_TOKEN
      expect(endpoint).toContain('/internal/tool-hub/')
      expect(token).toBeTruthy()
      expect(endpoint).not.toContain(token as string)
      capturedEndpoint = endpoint
      capturedToken = token
      const call = async (authorization: string, name: string, args: unknown) => {
        const response = await globalThis.fetch(endpoint as string, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ name, arguments: args }),
        })
        responses.push({ status: response.status, body: await response.json() })
      }
      await call(`Bearer ${token}-wrong`, 'task_status', {})
      await call(`Bearer ${token}-wrong`, 'approve', {
        tool_name: 'mcp__joy__ask_peer',
        input: { provider: 'codex-cli', question: 'Review' },
        tool_use_id: 'wrong-auth-1',
      })
      await call(`Bearer ${token}`, 'task_status', {})
      await call(`Bearer ${token}`, 'approve', {
        tool_name: 'mcp__joy__ask_peer',
        input: { provider: 'codex-cli', question: 'Review' },
        tool_use_id: 'joy-tool-1',
      })
      await call(`Bearer ${token}`, 'approve', {
        tool_name: 'Bash',
        input: { command: 'anything' },
        tool_use_id: 'shell-1',
      })
      await call(`Bearer ${token}`, 'ask_peer', {
        provider: 'codex-cli',
        question: 'Review the current change',
      })
      await call(`Bearer ${token}`, 'ask_peer', {
        provider: 'codex-cli',
        question: 'Review the current change again',
      })
    }
    const result = await waitForStatus(origin, task.id, 'done')
    expect(responses.map(({ status }) => status)).toEqual([403, 403, 200, 200, 200, 200, 422])
    expect(responses[2]?.body).toMatchObject({ value: { id: task.id, status: 'running' } })
    expect(responses[3]?.body).toMatchObject({
      value: { behavior: 'allow', updatedInput: { provider: 'codex-cli', question: 'Review' } },
    })
    expect(responses[4]?.body).toMatchObject({ value: { behavior: 'deny' } })
    expect(responses[5]?.body).toMatchObject({ value: { provider: 'codex-cli', answer: 'working' } })
    expect(responses[6]?.body).toMatchObject({ error: 'ask_peer limit reached (1 per task)' })
    expect(reviewer.calls).toHaveLength(1)
    expect(reviewer.calls[0]).toMatchObject({ cwd: '/fake/worktree', autonomy: 'read-only' })
    expect(reviewer.calls[0]?.mcpServers).toBeUndefined()
    expect(
      result.events.filter((event) => (event as { type?: string }).type === 'tool_hub.ask_peer'),
    ).toHaveLength(1)
    expect(capturedEndpoint).toBeDefined()
    expect(capturedToken).toBeDefined()
    const expired = await globalThis.fetch(capturedEndpoint as string, {
      method: 'POST',
      headers: { authorization: `Bearer ${capturedToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'task_status', arguments: {} }),
    })
    expect(expired.status).toBe(403)
  })

  it('preserves the task ask_peer budget across a resumed provider session', async () => {
    const implementer = new FakeProvider('claude-cli')
    let peerResponse: { status: number; body: unknown } | undefined
    implementer.onRun = async (options) => {
      const mcp = options.mcpServers?.[0]
      if (!mcp || mcp.transport !== 'stdio') throw new Error('CLI provider did not receive stdio Tool Hub')
      const endpoint = mcp.env?.JOY_TOOL_HUB_ENDPOINT
      const token = mcp.env?.JOY_TOOL_HUB_TOKEN
      if (!endpoint || !token) throw new Error('CLI provider did not receive Tool Hub credentials')
      const response = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'ask_peer',
          arguments: { provider: 'codex-cli', question: 'Review the resumed worktree' },
        }),
      })
      peerResponse = { status: response.status, body: await response.json() }
    }
    const { db, serverPromise, configStore, reviewer } = fixture({ implementer })
    await configStore.update((config) => ({ ...config, tool_hub: { max_ask_peer_calls: 1 } }))
    const repo = createRepo(db, {
      id: rid('tool-hub-resume-repo'),
      path: join(tmpdir(), 'joy-tool-hub-resume-repo'),
      defaultBranch: 'main',
    })
    const task = createTask(db, {
      id: tid('tool-hub-resume-task'),
      repoId: repo.id,
      title: 'Resume Tool Hub budget',
      prompt: 'Try one more peer call after resume',
      mode: 'single',
    })
    const attempt = createAttempt(db, {
      id: aid('tool-hub-resume-attempt'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'cancelled',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: join(tmpdir(), 'joy-tool-hub-resume-worktree'),
      branch: 'joy/tool-hub-resume-task/tool-hub-resume-attempt',
      baseCommit: 'base-sha',
      sessionId: 'saved-tool-hub-session',
    })
    setTaskStatus(db, task.id, 'cancelled')
    for (let index = 0; index < 128; index++) {
      appendTaskEvent(db, attempt.id, 'tool_hub.peer_budget_fixture', { index })
    }
    appendTaskEvent(db, attempt.id, 'tool_hub.ask_peer', { provider: 'codex-cli' })

    const { origin } = await start(serverPromise)
    const resumed = await postJson(`${origin}/api/tasks/${task.id}/resume`, {})
    expect(resumed.status).toBe(202)
    const result = await waitForStatus(origin, task.id, 'done')
    expect(peerResponse).toMatchObject({
      status: 422,
      body: { error: 'ask_peer limit reached (1 per task)' },
    })
    expect(reviewer.calls).toHaveLength(0)
    expect(
      result.events.filter((event) => (event as { type?: string }).type === 'tool_hub.ask_peer'),
    ).toHaveLength(1)
  })

  it('rejects a Tool Hub bearer token when used with another active session', async () => {
    const implementer = new FakeProvider('claude-cli')
    let releaseRuns!: () => void
    const runGate = new Promise<void>((resolve) => {
      releaseRuns = resolve
    })
    const sessions: Array<{ endpoint: string; token: string }> = []
    implementer.onRun = async (options) => {
      const mcp = options.mcpServers?.[0]
      if (!mcp || mcp.transport !== 'stdio') throw new Error('CLI provider did not receive stdio Tool Hub')
      const endpoint = mcp.env?.JOY_TOOL_HUB_ENDPOINT
      const token = mcp.env?.JOY_TOOL_HUB_TOKEN
      if (!endpoint || !token) throw new Error('CLI provider did not receive Tool Hub credentials')
      sessions.push({ endpoint, token })
      await runGate
    }
    const { serverPromise } = fixture({ implementer })
    const { origin } = await start(serverPromise)
    const repoResponse = await postJson(`${origin}/api/repos`, {
      path: '/tmp/tool-hub-session-repo',
      defaultBranch: 'main',
    })
    const { repo } = (await repoResponse.json()) as { repo: { id: string } }
    const taskIds: string[] = []
    for (const title of ['First Tool Hub task', 'Second Tool Hub task']) {
      const response = await postJson(`${origin}/api/tasks`, {
        repoId: repo.id,
        title,
        prompt: 'Hold the task open for the session token check',
        mode: 'single',
      })
      const { task } = (await response.json()) as { task: { id: string } }
      taskIds.push(task.id)
    }
    try {
      await waitForProviderCalls(implementer, 2)
      expect(sessions).toHaveLength(2)
      const first = sessions[0]
      const second = sessions[1]
      if (!first || !second) throw new Error('Both Tool Hub sessions must be active')
      const pairs: Array<[{ endpoint: string; token: string }, { endpoint: string; token: string }]> = [
        [first, second],
        [second, first],
      ]
      for (const [from, other] of pairs) {
        const response = await globalThis.fetch(from.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'task_status', arguments: {} }),
        })
        expect(response.status).toBe(403)
      }
    } finally {
      releaseRuns()
    }
    await Promise.all(taskIds.map((id) => waitForStatus(origin, id, 'done')))
  })

  it('aborts an active peer run when its parent task is cancelled', async () => {
    const implementer = new FakeProvider('claude-cli')
    const reviewer = new FakeProvider('codex-cli')
    reviewer.onRun = async (options) => {
      if (options.signal.aborted) return
      await new Promise<void>((resolve) => {
        options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const { serverPromise } = fixture({ implementer, reviewer })
    const { origin } = await start(serverPromise)
    const repoResponse = await postJson(`${origin}/api/repos`, {
      path: '/tmp/tool-hub-cancel-repo',
      defaultBranch: 'main',
    })
    const { repo } = (await repoResponse.json()) as { repo: { id: string } }
    const taskResponse = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Cancel delegated peer',
      prompt: 'Start a peer and cancel it',
      mode: 'single',
    })
    const { task } = (await taskResponse.json()) as { task: { id: string } }
    implementer.onRun = async (options) => {
      const mcp = options.mcpServers?.[0]
      if (!mcp || mcp.transport !== 'stdio') throw new Error('CLI provider did not receive stdio Tool Hub')
      const endpoint = mcp.env?.JOY_TOOL_HUB_ENDPOINT
      const token = mcp.env?.JOY_TOOL_HUB_TOKEN
      if (!endpoint || !token) throw new Error('CLI provider did not receive Tool Hub credentials')
      const peerRequest = globalThis.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'ask_peer',
          arguments: { provider: 'codex-cli', question: 'Review the worktree' },
        }),
      })
      await waitForProviderCalls(reviewer, 1)
      const cancelled = await postJson(`${origin}/api/tasks/${task.id}/cancel`, {})
      expect(cancelled.status).toBe(200)
      await peerRequest.catch(() => undefined)
    }
    await waitForStatus(origin, task.id, 'cancelled')
    expect(reviewer.calls[0]?.signal.aborted).toBe(true)
  })

  it('aborts an in-flight peer when the implementer closes its Tool Hub session', async () => {
    const implementer = new FakeProvider('claude-cli')
    const reviewer = new FakeProvider('codex-cli')
    reviewer.onRun = async (options) => {
      if (options.signal.aborted) return
      await new Promise<void>((resolve) => {
        options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const { serverPromise } = fixture({ implementer, reviewer })
    const { origin } = await start(serverPromise)
    const repoResponse = await postJson(`${origin}/api/repos`, {
      path: '/tmp/tool-hub-session-close-repo',
      defaultBranch: 'main',
    })
    const { repo } = (await repoResponse.json()) as { repo: { id: string } }
    const taskResponse = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Close a delegated peer session',
      prompt: 'Finish while a peer is still running',
      mode: 'single',
    })
    const { task } = (await taskResponse.json()) as { task: { id: string } }
    let peerRequest: Promise<Response> | undefined
    implementer.onRun = async (options) => {
      const mcp = options.mcpServers?.[0]
      if (!mcp || mcp.transport !== 'stdio') throw new Error('CLI provider did not receive stdio Tool Hub')
      const endpoint = mcp.env?.JOY_TOOL_HUB_ENDPOINT
      const token = mcp.env?.JOY_TOOL_HUB_TOKEN
      if (!endpoint || !token) throw new Error('CLI provider did not receive Tool Hub credentials')
      peerRequest = globalThis.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'ask_peer',
          arguments: { provider: 'codex-cli', question: 'Review before finishing' },
        }),
      })
      await waitForProviderCalls(reviewer, 1)
    }
    await waitForStatus(origin, task.id, 'done')
    expect(reviewer.calls[0]?.signal.aborted).toBe(true)
    await peerRequest
  })

  it('blocks Tool Hub peers excluded by the repository provider allowlist', async () => {
    const implementer = new FakeProvider('claude-cli')
    const { reviewer, serverPromise } = fixture({ implementer })
    const { origin } = await start(serverPromise)
    const repoResponse = await postJson(`${origin}/api/repos`, {
      path: '/tmp/tool-hub-allowlist-repo',
      defaultBranch: 'main',
      allowedProviders: ['claude-cli'],
    })
    const { repo } = (await repoResponse.json()) as { repo: { id: string } }
    const taskResponse = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Respect peer allowlist',
      prompt: 'Do not delegate to a disallowed provider',
      mode: 'single',
    })
    const { task } = (await taskResponse.json()) as { task: { id: string } }
    let response: { status: number; body: unknown } | undefined
    implementer.onRun = async (options) => {
      const mcp = options.mcpServers?.[0]
      if (!mcp || mcp.transport !== 'stdio')
        throw new Error('CLI provider did not receive the stdio Tool Hub')
      const endpoint = mcp.env?.JOY_TOOL_HUB_ENDPOINT
      const token = mcp.env?.JOY_TOOL_HUB_TOKEN
      const result = await globalThis.fetch(endpoint as string, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'ask_peer',
          arguments: { provider: 'codex-cli', question: 'Review this worktree' },
        }),
      })
      response = { status: result.status, body: await result.json() }
    }
    await waitForStatus(origin, task.id, 'done')
    expect(response).toMatchObject({
      status: 422,
      body: { error: 'ask_peer provider codex-cli is not allowed for this repository' },
    })
    expect(reviewer.calls).toHaveLength(0)
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
      headers: {
        'content-type': 'application/json',
        origin: VITE_ORIGIN,
        authorization: `Bearer ${TEST_API_TOKEN}`,
      },
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

    const deleted = await fetch(`${origin}/api/secrets/openai-api-key`, {
      method: 'DELETE',
      headers: { origin: VITE_ORIGIN, authorization: `Bearer ${TEST_API_TOKEN}` },
    })
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
      headers: {
        'content-type': 'application/json',
        origin: VITE_ORIGIN,
        authorization: `Bearer ${TEST_API_TOKEN}`,
      },
      body: JSON.stringify({ value: 'replacement-openai-secret-53' }),
    })
    expect(put.status).toBe(409)
    expect(await put.text()).not.toContain(envKey)
    const deleted = await fetch(`${origin}/api/secrets/openai-api-key`, {
      method: 'DELETE',
      headers: { origin: VITE_ORIGIN, authorization: `Bearer ${TEST_API_TOKEN}` },
    })
    expect(deleted.status).toBe(409)
    expect(await deleted.text()).not.toContain(envKey)
    expect(backend.values.has('openai_api_key')).toBe(false)
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

    const failed = await waitForStatus(origin, task.id, 'failed')
    expect(failed.attempts).toHaveLength(0)
    expect(failed.events).toEqual([
      expect.objectContaining({
        seq: 1,
        type: 'error',
        payload: expect.objectContaining({ message: expect.stringContaining('Role "implementer"') }),
      }),
    ])
    expect(failed.events[0]).not.toHaveProperty('attemptId')
    expect(failed.events[0]).toMatchObject({
      payload: { message: expect.stringContaining('create a new task') },
    })
    const resumeWithoutAttempt = await postJson(`${origin}/api/tasks/${task.id}/resume`, {})
    expect(resumeWithoutAttempt.status).toBe(409)
    expect(((await resumeWithoutAttempt.json()) as { error: string }).error).toContain(
      'cannot be resumed; create a new task',
    )
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
      expect(rejection.error).toContain("saved task's provider is fixed")
      expect(rejection.error).toContain('create a new task with an allowed provider')
      const afterResume = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails
      expect(afterResume.task.status).toBe('cancelled')
      expect(afterResume.attempts).toEqual(beforeResume.attempts)
      expect(afterResume.events).toEqual(beforeResume.events)
      expect(implementer.calls).toHaveLength(0)
      expect(reviewer.calls).toHaveLength(0)
      expect(api.calls).toHaveLength(0)
    },
  )

  it('publishes a runtime allowlist rejection for an existing resumed attempt', async () => {
    const { db, serverPromise, configStore, implementer, reviewer, api } = fixture()
    const repo = createRepo(db, {
      id: rid('resume-race-repo'),
      path: '/resume-race-repo',
      defaultBranch: 'main',
      allowedProviders: ['claude-cli'],
    })
    const task = createTask(db, {
      id: tid('resume-race-task'),
      repoId: repo.id,
      title: 'Block a resume after preflight',
      prompt: 'Do not call a provider',
      mode: 'review_loop',
    })
    const attempt = createAttempt(db, {
      id: aid('resume-race-attempt'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'cancelled',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: '/saved/worktree',
      branch: 'joy/resume-race-task/resume-race-attempt',
      baseCommit: 'base-sha',
      sessionId: 'saved-session',
    })
    setTaskStatus(db, task.id, 'cancelled')

    const { origin } = await start(serverPromise)
    const getConfig = configStore.get.bind(configStore)
    let reads = 0
    configStore.get = async () => {
      const config = await getConfig()
      reads++
      const reviewerProvider = reads === 1 ? 'claude-cli' : 'codex-cli'
      return {
        ...config,
        roles: { ...config.roles, reviewer: { ...config.roles.reviewer, provider: reviewerProvider } },
      }
    }

    const resumed = await postJson(`${origin}/api/tasks/${task.id}/resume`, {})
    expect(resumed.status).toBe(202)
    const failed = await waitForStatus(origin, task.id, 'failed')
    expect(failed.attempts).toHaveLength(1)
    expect(failed.attempts[0]).toMatchObject({ id: attempt.id, provider: 'claude-cli', status: 'failed' })
    expect(failed.events).toEqual([
      expect.objectContaining({
        attemptId: attempt.id,
        seq: 1,
        type: 'error',
        payload: expect.objectContaining({
          message: expect.stringContaining('Role "reviewer" selects provider "codex-cli"'),
        }),
      }),
    ])
    expect(implementer.calls).toHaveLength(0)
    expect(reviewer.calls).toHaveLength(0)
    expect(api.calls).toHaveLength(0)
  })

  it('requires JSON and validates repository PATCH ids, body, and existence', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/patch-validation', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const host = new URL(origin).host
    const contentType = { host, origin, 'content-type': 'application/json' }
    const responses = await Promise.all([
      rawRequest(
        origin,
        `/api/repos/${repo.id}`,
        'PATCH',
        { host, origin },
        JSON.stringify({ allowedProviders: ['claude-cli'] }),
      ),
      rawRequest(origin, `/api/repos/${repo.id}`, 'PATCH', contentType, '{'),
      rawRequest(origin, `/api/repos/${repo.id}`, 'PATCH', contentType, JSON.stringify({ unexpected: true })),
      rawRequest(
        origin,
        '/api/repos/not-found',
        'PATCH',
        contentType,
        JSON.stringify({ allowedProviders: ['claude-cli'] }),
      ),
    ])

    expect(responses.map((response) => response.status)).toEqual([415, 400, 400, 404])
  })

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
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws?taskId=${task.id}`,
      ['joy', `joy-auth.${TEST_API_TOKEN}`],
      { origin: VITE_ORIGIN },
    )
    const messages = await receiveMessages(socket, replayed.events.length + 2)
    expect(messages[0]).toMatchObject({ type: 'snapshot', task: { id: task.id } })
    expect(messages[1]).toMatchObject({ type: 'ready', taskId: task.id })
    expect(messages.slice(2)).toEqual(replayed.events.map((event) => ({ type: 'event', event })))
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

  it('rejects review-loop tasks for providers that cannot edit code', async () => {
    const { api, serverPromise } = fixture()
    api.capabilities.codeEdit = false
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }

    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Review and fix a change',
      prompt: 'Review the implementation and fix any issues',
      mode: 'review_loop',
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

  it('rejects saving a config with a non-editing implementer provider', async () => {
    const { api, serverPromise } = fixture()
    api.capabilities.codeEdit = false
    const { origin } = await start(serverPromise)

    const response = await rawRequest(
      origin,
      '/api/config',
      'PUT',
      { host: new URL(origin).host, origin, 'content-type': 'application/json' },
      JSON.stringify({ roles: { implementer: { provider: 'openai-api', model: 'gpt-test' } } }),
    )

    expect(response.status).toBe(422)
    expect(api.calls).toHaveLength(0)
    const { config } = (await (await fetch(`${origin}/api/config`)).json()) as {
      config: { roles: { implementer: { provider: string } } }
    }
    expect(config.roles.implementer.provider).toBe('claude-cli')
  })

  it('persists pre-attempt failures as replayable events with a unique sequence', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'joy-config-test-'))
    dirs.push(configDir)
    const configStore = new ConfigStore(join(configDir, 'config.yaml'))
    const originalGet = configStore.get.bind(configStore)
    let reads = 0
    configStore.get = async () => {
      reads++
      if (reads === 3) throw new Error('config became unavailable')
      return originalGet()
    }
    const { serverPromise } = fixture({ configStore })
    const { origin } = await start(serverPromise)
    const { repo } = (await (
      await postJson(`${origin}/api/repos`, { path: '/repo', defaultBranch: 'main' })
    ).json()) as { repo: { id: string } }
    const response = await postJson(`${origin}/api/tasks`, {
      repoId: repo.id,
      title: 'Fail before starting an attempt',
      prompt: 'This task should record its failure',
      mode: 'single',
    })
    const { task } = (await response.json()) as { task: { id: string } }
    const result = await waitForStatus(origin, task.id, 'failed')

    expect(result.attempts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({ seq: 1, type: 'error', payload: { message: 'config became unavailable' } }),
    ])
    const replay = (await (await fetch(`${origin}/api/tasks/${task.id}/events?after=0`)).json()) as {
      events: Array<{ seq: number; type: string }>
    }
    expect(replay.events).toMatchObject([{ seq: 1, type: 'error' }])
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
    const cancelled = await rawRequest(origin, `/api/tasks/${task.id}/cancel`, 'POST', {
      host: new URL(origin).host,
      origin,
    })
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
    const response = await rawRequest(origin, `/api/tasks/${task.id}/resume`, 'POST', {
      host: new URL(origin).host,
      origin,
    })
    await waitForStatus(origin, task.id, 'failed')
    const details = (await (await fetch(`${origin}/api/tasks/${task.id}`)).json()) as TaskDetails

    expect(response.status).toBe(409)
    expect(response.body).toContain('does not support code editing required to resume as implementer')
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
    const resume = await rawRequest(origin, `/api/tasks/${task.id}/resume`, 'POST', {
      host: new URL(origin).host,
      origin,
    })
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
