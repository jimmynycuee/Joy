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
import { MemoryBackend, SecretStore } from '@joy/secrets'
import { createJoyServer } from './server.js'
import type { JoyServer } from './server.js'
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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'joy-server-test-'))
  dirs.push(dir)
  const db = openDatabase(':memory:')
  databases.push(db)
  const executor = new FakeExecutor()
  const implementer = new FakeProvider('claude-cli')
  const reviewer = new FakeProvider('codex-cli', [
    {
      type: 'done',
      sessionId: 'review-session',
      isError: false,
      structured: { approve: true, summary: 'ok', findings: [] },
    },
  ])
  const api = new FakeProvider('openai-api')
  const serverPromise = createJoyServer({
    home: dir,
    database: db,
    configStore: new ConfigStore(join(dir, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend() }),
    executor,
    providers: {
      'claude-cli': implementer,
      'codex-cli': reviewer,
      'openai-api': api,
    },
  })
  return { dir, db, executor, implementer, reviewer, api, serverPromise }
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

  it('requires JSON Content-Type for API writes and preserves the local Tauri origin', async () => {
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

  it('returns 400 for malformed percent encoding in task paths', async () => {
    const { serverPromise } = fixture()
    const { origin } = await start(serverPromise)
    const response = await fetch(`${origin}/api/tasks/%E0%A4%A`)

    expect(response.status).toBe(400)
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
