import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { z, ZodError } from 'zod'
import type {
  AgentEvent,
  AgentProvider,
  AttemptId,
  AttemptStatus,
  ModelRef,
  ProviderKind,
  RepoId,
  Role,
  RoleConfig,
  RunOptions,
  TaskId,
  TaskStatus,
  Workspace,
} from '@joy/core'
import { EFFORTS, PROVIDER_KINDS, ROLES, resolveRole } from '@joy/core'
import { ConfigStore, configSchema, joyHome, resolvePaths, type JoyConfig } from '@joy/config'
import {
  createAttempt,
  createRepo,
  createTask,
  getRepo,
  getTask,
  interruptRunningWork,
  latestAttempt,
  listAttempts,
  listRepos,
  listTasks,
  openDatabase,
  setTaskStatus,
  updateAttempt,
} from '@joy/db'
import type { AttemptRecord, Database, RepoRecord, StoredTask } from '@joy/db'
import { WorktreeExecutor } from '@joy/executor'
import type { Executor, WorkspaceDiff } from '@joy/core'
import { reviewLoop } from '@joy/orchestrator'
import { ClaudeCliProvider, CodexCliProvider, OpenAiApiProvider } from '@joy/providers'
import { Redactor, SecretStore } from '@joy/secrets'

const modelSchema = z.strictObject({
  provider: z.enum(PROVIDER_KINDS),
  model: z.string().trim().min(1),
  effort: z.enum(EFFORTS).optional(),
})
const roleOverridesSchema = z.strictObject(
  Object.fromEntries(ROLES.map((role) => [role, modelSchema.optional()])) as {
    [R in Role]: z.ZodOptional<typeof modelSchema>
  },
)
const repoInputSchema = z.strictObject({
  id: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).refine(isAbsolute, 'must be an absolute path'),
  defaultBranch: z.string().trim().min(1),
  githubRemote: z.string().trim().min(1).optional(),
})
const taskInputSchema = z.strictObject({
  repoId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(500),
  prompt: z.string().trim().min(1).max(100_000),
  mode: z.enum(['single', 'review_loop', 'compete']),
  roleOverrides: roleOverridesSchema.optional(),
  planFirst: z.boolean().optional(),
  maxRounds: z.number().int().min(1).max(20).optional(),
})
const idSchema = z.string().min(1).max(128)
const MAX_BODY_BYTES = 1_000_000

export interface TaskEvent {
  taskId: TaskId
  attemptId: AttemptId
  seq: number
  type: string
  payload: unknown
  ts: string
}

export interface JoyServerOptions {
  /** Defaults to ~/.joy, or JOY_HOME when set. */
  home?: string
  database?: Database
  configStore?: ConfigStore
  secretStore?: SecretStore
  redactor?: Redactor
  providers?: Partial<Record<ProviderKind, AgentProvider>>
  executor?: Executor
}

export interface JoyServer {
  readonly httpServer: Server
  listen(port?: number): Promise<AddressInfo>
  close(): Promise<void>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface ActiveTask {
  controller: AbortController
  promise: Promise<void>
}

interface ResumeState {
  attempt: AttemptRecord
  workspace: Workspace
  sessionId: string
}

/** Builds the local HTTP + WebSocket service. It never binds beyond loopback. */
export async function createJoyServer(options: JoyServerOptions = {}): Promise<JoyServer> {
  const home = options.home ?? joyHome()
  const configStore = options.configStore ?? new ConfigStore(join(home, 'config.yaml'))
  const initialConfig = await configStore.get()
  const paths = resolvePaths(initialConfig, home)
  const ownsDatabase = !options.database
  const db = options.database ?? openDatabase(paths.database)
  const redactor = options.redactor ?? new Redactor()
  const secretStore = options.secretStore ?? new SecretStore({ onSecret: (secret) => redactor.add(secret) })
  const providers: Partial<Record<ProviderKind, AgentProvider>> = {
    'claude-cli': new ClaudeCliProvider({
      ...(initialConfig.providers.claude.command ? { command: initialConfig.providers.claude.command } : {}),
    }),
    'codex-cli': new CodexCliProvider({
      ...(initialConfig.providers.codex.command ? { command: initialConfig.providers.codex.command } : {}),
    }),
    'openai-api': new OpenAiApiProvider({
      apiKey: async () => {
        const key = await secretStore.get('openai_api_key')
        if (key) redactor.add(key)
        return key
      },
    }),
    ...options.providers,
  } satisfies Partial<Record<ProviderKind, AgentProvider>>
  const executor = options.executor ?? new WorktreeExecutor({ worktreesDir: paths.worktrees })
  const running = new Map<TaskId, ActiveTask>()
  const eventHistory = new Map<TaskId, TaskEvent[]>()
  const subscribers = new Map<TaskId, Set<WebSocket>>()
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES })
  let closed = false

  const publish = (taskId: TaskId, attemptId: AttemptId, type: string, payload: unknown): TaskEvent => {
    const safe = redactor.redactValue(payload)
    const events = eventHistory.get(taskId) ?? []
    const event: TaskEvent = {
      taskId,
      attemptId,
      seq: (events.at(-1)?.seq ?? 0) + 1,
      type,
      payload: safe,
      ts: new Date().toISOString(),
    }
    events.push(event)
    eventHistory.set(taskId, events)
    const message = JSON.stringify({ type: 'event', event })
    for (const socket of subscribers.get(taskId) ?? []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message)
    }
    return event
  }

  const httpServer = createHttpServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof ZodError) {
        json(res, 400, {
          error: 'Invalid request',
          issues: error.issues.map(({ path, message }) => ({ path, message })),
        })
      } else if (error instanceof HttpError) {
        json(res, error.status, { error: error.message })
      } else {
        const message = error instanceof Error ? error.message : 'Unexpected server error'
        json(res, 500, { error: message })
      }
    })
  })

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      if (!isLoopbackHost(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = requestUrl(req)
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const taskId = idSchema.parse(url.searchParams.get('taskId')) as TaskId
      if (!getTask(db, taskId)) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        const current = subscribers.get(taskId) ?? new Set<WebSocket>()
        current.add(ws)
        subscribers.set(taskId, current)
        ws.send(JSON.stringify({ type: 'ready', taskId }))
        for (const event of eventHistory.get(taskId) ?? []) ws.send(JSON.stringify({ type: 'event', event }))
        ws.once('close', () => {
          current.delete(ws)
          if (current.size === 0) subscribers.delete(taskId)
        })
      })
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'Host is not allowed')
    if (!isLocalOrigin(req.headers.origin)) throw new HttpError(403, 'Origin is not allowed')
    const url = requestUrl(req)
    const method = req.method ?? 'GET'
    if (url.pathname === '/api/health' && method === 'GET') {
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/api/repos' && method === 'GET') {
      json(res, 200, { repos: listRepos(db) })
      return
    }
    if (url.pathname === '/api/repos' && method === 'POST') {
      assertJsonContentType(req)
      const input = repoInputSchema.parse(await readJson(req))
      const repo = createRepo(db, {
        id: (input.id ?? randomUUID()) as RepoId,
        path: input.path,
        defaultBranch: input.defaultBranch,
        ...(input.githubRemote ? { githubRemote: input.githubRemote } : {}),
      })
      json(res, 201, { repo })
      return
    }
    if (url.pathname === '/api/tasks' && method === 'GET') {
      json(res, 200, { tasks: listTasks(db) })
      return
    }
    if (url.pathname === '/api/tasks' && method === 'POST') {
      assertJsonContentType(req)
      const input = taskInputSchema.parse(await readJson(req))
      if (input.mode === 'compete') throw new HttpError(422, 'Compete mode is not available in P1 yet')
      const repo = getRepo(db, input.repoId as RepoId)
      if (!repo) throw new HttpError(404, `Repository ${input.repoId} was not found`)
      const task = createTask(db, {
        id: randomUUID() as TaskId,
        repoId: repo.id,
        title: input.title,
        prompt: input.prompt,
        mode: input.mode,
        ...(input.roleOverrides ? { roleOverrides: input.roleOverrides as Partial<RoleConfig> } : {}),
        ...(input.planFirst !== undefined ? { planFirst: input.planFirst } : {}),
        ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
      })
      scheduleTask(task)
      json(res, 201, { task })
      return
    }

    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)
    if (taskMatch && method === 'GET') {
      const task = requireTask(decodePathSegment(taskMatch[1] ?? ''))
      const repo = getRepo(db, task.repoId)
      json(res, 200, {
        task,
        repo,
        attempts: listAttempts(db, task.id),
        events: eventHistory.get(task.id) ?? [],
      })
      return
    }
    const eventsMatch = /^\/api\/tasks\/([^/]+)\/events$/.exec(url.pathname)
    if (eventsMatch && method === 'GET') {
      const task = requireTask(decodePathSegment(eventsMatch[1] ?? ''))
      const after = Number(url.searchParams.get('after') ?? '0')
      if (!Number.isSafeInteger(after) || after < 0)
        throw new HttpError(400, 'after must be a non-negative integer')
      json(res, 200, { events: (eventHistory.get(task.id) ?? []).filter((event) => event.seq > after) })
      return
    }
    const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
    if (cancelMatch && method === 'POST') {
      const task = requireTask(decodePathSegment(cancelMatch[1] ?? ''))
      const active = running.get(task.id)
      if (active) active.controller.abort()
      else if (task.status === 'queued') setTaskStatus(db, task.id, 'cancelled')
      else if (task.status !== 'cancelled')
        throw new HttpError(409, `Task cannot be cancelled from ${task.status}`)
      json(res, 200, { task: getTask(db, task.id) })
      return
    }
    const resumeMatch = /^\/api\/tasks\/([^/]+)\/resume$/.exec(url.pathname)
    if (resumeMatch && method === 'POST') {
      const task = requireTask(decodePathSegment(resumeMatch[1] ?? ''))
      if (task.status !== 'failed' && task.status !== 'cancelled')
        throw new HttpError(409, `Task cannot be resumed from ${task.status}`)
      const state = resumeState(task)
      if (running.has(task.id)) throw new HttpError(409, 'Task is already running')
      setTaskStatus(db, task.id, 'queued')
      scheduleTask({ ...task, status: 'queued' }, state)
      json(res, 202, { task: getTask(db, task.id), resumed: true })
      return
    }
    if (url.pathname === '/api/config' && method === 'GET') {
      json(res, 200, { config: await configStore.get() })
      return
    }
    if (url.pathname === '/api/config' && method === 'PUT') {
      assertJsonContentType(req)
      const config = configSchema.parse(await readJson(req)) as JoyConfig
      json(res, 200, { config: await configStore.save(config) })
      return
    }
    if (url.pathname === '/api/providers' && method === 'GET') {
      const health = await Promise.all(
        PROVIDER_KINDS.map(async (kind) => {
          const provider = providers[kind]
          return provider
            ? { kind, ...(await provider.healthCheck()) }
            : { kind, ok: false, installed: false, loggedIn: false, detail: 'Provider is not configured' }
        }),
      )
      json(res, 200, { providers: health })
      return
    }
    json(res, 404, { error: 'Not found' })
  }

  function requireTask(id: string): StoredTask {
    const parsed = idSchema.parse(id) as TaskId
    const task = getTask(db, parsed)
    if (!task) throw new HttpError(404, `Task ${id} was not found`)
    return task
  }

  function resumeState(task: StoredTask): ResumeState {
    const attempt = latestAttempt(db, task.id)
    if (!attempt?.sessionId || !attempt.worktreePath || !attempt.branch || !attempt.baseCommit)
      throw new HttpError(409, 'No saved worktree and provider session are available to resume')
    const repo = getRepo(db, task.repoId)
    if (!repo) throw new HttpError(404, `Repository ${task.repoId} was not found`)
    const provider = providers[attempt.provider]
    if (!provider?.capabilities.resume)
      throw new HttpError(409, `${attempt.provider} does not support session resume`)
    const workspace: Workspace = {
      repo,
      taskId: task.id,
      attemptId: attempt.id,
      path: attempt.worktreePath,
      branch: attempt.branch,
      baseCommit: attempt.baseCommit,
    }
    return { attempt, workspace, sessionId: attempt.sessionId }
  }

  function scheduleTask(task: StoredTask, resume?: ResumeState): void {
    const controller = new AbortController()
    const active: ActiveTask = { controller, promise: Promise.resolve() }
    running.set(task.id, active)
    active.promise = runTask(task, controller, resume).finally(() => {
      if (running.get(task.id) === active) running.delete(task.id)
    })
  }

  async function runTask(task: StoredTask, controller: AbortController, resume?: ResumeState): Promise<void> {
    let attempt = resume?.attempt
    try {
      const repo = getRepo(db, task.repoId)
      if (!repo) throw new Error(`Repository ${task.repoId} was not found`)
      const config = await configStore.get()
      const roles = config.roles as RoleConfig
      const configuredImplementer = resolveRole('implementer', roles, task.roleOverrides)
      const implementer = resume
        ? { ...configuredImplementer, provider: resume.attempt.provider, model: resume.attempt.model }
        : configuredImplementer
      const reviewer = resolveRole('reviewer', roles, task.roleOverrides)
      if (!attempt) {
        attempt = createAttempt(db, {
          id: randomUUID() as AttemptId,
          taskId: task.id,
          provider: implementer.provider,
          model: implementer.model,
          status: 'preparing',
        })
      } else {
        updateAttempt(db, attempt.id, { status: 'preparing' })
      }
      setTaskStatus(db, task.id, 'running')
      publish(task.id, attempt.id, 'started', { taskId: task.id, attemptId: attempt.id })
      if (task.mode === 'single') {
        await runSingle(task, repo, attempt, implementer, controller, resume)
      } else if (task.mode === 'review_loop') {
        await runReviewLoop(task, repo, attempt, implementer, reviewer, controller, resume)
      } else {
        throw new Error(`Task mode ${task.mode} is not supported`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Task failed'
      if (attempt)
        updateAttempt(db, attempt.id, { status: controller.signal.aborted ? 'cancelled' : 'failed' })
      setTaskStatus(db, task.id, controller.signal.aborted ? 'cancelled' : 'failed')
      publish(task.id, attempt?.id ?? ('unknown' as AttemptId), 'error', { message })
    }
  }

  async function runReviewLoop(
    task: StoredTask,
    repo: RepoRecord,
    attempt: AttemptRecord,
    implementer: ModelRef,
    reviewer: ModelRef,
    controller: AbortController,
    resume?: ResumeState,
  ): Promise<void> {
    let finished = false
    for await (const event of reviewLoop(
      {
        taskId: task.id,
        attemptId: attempt.id,
        repo,
        prompt: task.prompt,
        implementer,
        reviewer,
        planFirst: task.planFirst,
        maxRounds: task.maxRounds,
        signal: controller.signal,
        ...(resume ? { resumeWorkspace: resume.workspace, resumeSessionId: resume.sessionId } : {}),
      },
      { providers, executor },
    )) {
      if (event.type === 'workspace') {
        updateAttempt(db, attempt.id, {
          worktreePath: event.workspace.path,
          branch: event.workspace.branch,
          baseCommit: event.workspace.baseCommit,
        })
      } else if (event.type === 'phase') {
        const status: AttemptStatus = phaseStatus(event.phase)
        updateAttempt(db, attempt.id, { status })
      } else if (
        event.type === 'agent' &&
        event.role === 'implementer' &&
        event.event.type === 'session_started'
      ) {
        updateAttempt(db, attempt.id, { sessionId: event.event.sessionId })
      } else if (event.type === 'result') {
        finished = true
        const taskStatus: TaskStatus =
          event.status === 'cancelled'
            ? 'cancelled'
            : event.status === 'failed'
              ? 'failed'
              : event.approved
                ? 'done'
                : 'review_ready'
        const attemptStatus: AttemptStatus =
          event.status === 'cancelled' ? 'cancelled' : event.status === 'failed' ? 'failed' : 'succeeded'
        updateAttempt(db, attempt.id, {
          status: attemptStatus,
          ...(event.diff ? { diffStats: summarizeDiff(event.diff) } : {}),
        })
        setTaskStatus(db, task.id, taskStatus)
      }
      publish(task.id, attempt.id, event.type, event)
    }
    if (!finished) throw new Error('Review loop stopped without a result')
  }

  async function runSingle(
    task: StoredTask,
    repo: RepoRecord,
    attempt: AttemptRecord,
    model: ModelRef,
    controller: AbortController,
    resume?: ResumeState,
  ): Promise<void> {
    const provider = providers[model.provider]
    if (!provider) throw new Error(`No provider configured for ${model.provider}`)
    const workspace = resume?.workspace ?? (await executor.prepare(repo, task.id, attempt.id))
    updateAttempt(db, attempt.id, {
      status: 'running',
      worktreePath: workspace.path,
      branch: workspace.branch,
      baseCommit: workspace.baseCommit,
    })
    publish(task.id, attempt.id, 'workspace', workspace)
    const options: RunOptions = {
      cwd: workspace.path,
      prompt: task.prompt,
      autonomy: 'workspace-write',
      signal: controller.signal,
      ...(resume ? { resumeSessionId: resume.sessionId } : {}),
    }
    let done: Extract<AgentEvent, { type: 'done' }> | undefined
    let failure: string | undefined
    for await (const event of provider.run(options, model)) {
      if (event.type === 'session_started') updateAttempt(db, attempt.id, { sessionId: event.sessionId })
      if (event.type === 'error' && !event.recoverable) failure = event.message
      if (event.type === 'done') done = event
      publish(task.id, attempt.id, 'agent', { role: 'implementer', round: 1, event })
    }
    const diff = await executor.diff(workspace)
    const succeeded = !controller.signal.aborted && !!done && !done.isError && !failure
    const status = controller.signal.aborted ? 'cancelled' : succeeded ? 'succeeded' : 'failed'
    updateAttempt(db, attempt.id, { status, diffStats: summarizeDiff(diff) })
    setTaskStatus(db, task.id, status === 'succeeded' ? 'done' : status)
    publish(task.id, attempt.id, 'result', {
      type: 'result',
      status,
      approved: succeeded,
      rounds: 1,
      diff,
      ...(failure ? { reason: failure } : {}),
    })
  }

  // Existing active work is no longer running in this process. Its workspace and session id remain resumable.
  for (const taskId of interruptRunningWork(db)) {
    const attempt = latestAttempt(db, taskId)
    if (attempt) publish(taskId, attempt.id, 'interrupted', { taskId, attemptId: attempt.id })
  }

  return {
    httpServer,
    listen(port = 0) {
      if (closed) return Promise.reject(new Error('Server is closed'))
      if (httpServer.listening) return Promise.reject(new Error('Server is already listening'))
      return new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        httpServer.once('error', onError)
        httpServer.listen(port, '127.0.0.1', () => {
          httpServer.off('error', onError)
          resolve(httpServer.address() as AddressInfo)
        })
      })
    },
    async close() {
      if (closed) return
      closed = true
      const activeTasks = [...running.values()]
      for (const active of activeTasks) active.controller.abort()
      await Promise.all(activeTasks.map((active) => active.promise))
      for (const socket of wsServer.clients) socket.terminate()
      await new Promise<void>((resolve) => wsServer.close(() => resolve()))
      if (httpServer.listening)
        await new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve())),
        )
      if (ownsDatabase && db.isOpen) db.close()
    },
  }
}

function phaseStatus(phase: string): AttemptStatus {
  if (phase === 'preparing') return 'preparing'
  if (phase === 'reviewing' || phase === 'plan_review') return 'reviewing'
  if (phase === 'fixing') return 'fixing'
  return 'running'
}

function summarizeDiff(diff: WorkspaceDiff): Record<string, unknown> {
  return {
    files: diff.files.length,
    additions: diff.files.reduce((total, file) => total + file.additions, 0),
    deletions: diff.files.reduce((total, file) => total + file.deletions, 0),
  }
}

function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  } catch {
    throw new HttpError(400, 'Invalid request URL')
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    const url = new URL(`http://${host}`)
    return (
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      isLoopbackHostname(url.hostname)
    )
  } catch {
    return false
  }
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function assertJsonContentType(req: IncomingMessage): void {
  const contentType = req.headers['content-type']
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json')
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new HttpError(400, 'Malformed URL path encoding')
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.byteLength
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large')
    chunks.push(data)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON')
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}
