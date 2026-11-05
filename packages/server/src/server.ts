import { execFileSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
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
  addUsage,
  appendTaskEvent,
  createAttempt,
  createRepo,
  createReview,
  createTask,
  getRepo,
  getTask,
  interruptRunningWork,
  latestAttempt,
  listAttempts,
  listRepos,
  listReviews,
  listTaskEvents,
  listTasks,
  listUsage,
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
const openAiSecretInputSchema = z.strictObject({ value: z.string().trim().min(1).max(4096) })
const MAX_BODY_BYTES = 1_000_000
const API_TOKEN_FILENAME = 'api-token'
const WS_API_PROTOCOL = 'joy-api-v1'
const WS_TOKEN_PROTOCOL_PREFIX = 'joy-auth.'
const PLAYWRIGHT_E2E_ORIGINS = ['http://127.0.0.1:4173', 'http://localhost:4173'] as const

export interface TaskEvent {
  taskId: TaskId
  attemptId: AttemptId
  seq: number
  eventId?: string
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
  /** Adds only the fixed Playwright E2E origins; this is never enabled by default. */
  allowPlaywrightOrigin?: boolean
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
  const allowedOrigins = createOriginAllowlist(options.allowPlaywrightOrigin ?? false)
  const home = options.home ?? joyHome()
  const configStore = options.configStore ?? new ConfigStore(join(home, 'config.yaml'))
  const initialConfig = await configStore.get()
  const paths = resolvePaths(initialConfig, home)
  const ownsDatabase = !options.database
  const db = options.database ?? openDatabase(paths.database)
  const redactor = options.redactor ?? new Redactor()
  const secretStore = options.secretStore ?? new SecretStore({ onSecret: (secret) => redactor.add(secret) })
  const apiTokenFile = join(home, API_TOKEN_FILENAME)
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
  const subscribers = new Map<TaskId, Set<WebSocket>>()
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY_BYTES,
    handleProtocols: (protocols) => (protocols.has(WS_API_PROTOCOL) ? WS_API_PROTOCOL : false),
  })
  let apiToken = ''
  let closed = false

  const publish = (taskId: TaskId, attemptId: AttemptId, type: string, payload: unknown): TaskEvent => {
    const safe = redactor.redactValue(payload)
    const event = appendTaskEvent(db, attemptId, type, safe)
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
        json(res, error.status, { error: redactor.redact(error.message) })
      } else {
        const message = error instanceof Error ? error.message : 'Unexpected server error'
        json(res, 500, { error: redactor.redact(message) })
      }
    })
  })

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      if (
        !isLoopbackHost(req.headers.host) ||
        req.headers['sec-fetch-site']?.toLowerCase() === 'cross-site' ||
        !isAllowedOrigin(req, allowedOrigins, false) ||
        !hasValidWebSocketToken(req, apiToken)
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = requestUrl(req)
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const taskId = idSchema.parse(url.searchParams.get('taskId')) as TaskId
      const afterText = url.searchParams.get('after')
      const requestedAfter = afterText === null ? 0 : Number(afterText)
      if (!Number.isSafeInteger(requestedAfter) || requestedAfter < 0) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (!getTask(db, taskId)) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        const current = subscribers.get(taskId) ?? new Set<WebSocket>()
        current.add(ws)
        subscribers.set(taskId, current)
        const task = getTask(db, taskId)
        const events = listTaskEvents(db, taskId)
        const lastSequence = events.at(-1)?.seq ?? 0
        const replayAfter = requestedAfter > lastSequence ? 0 : requestedAfter
        ws.send(JSON.stringify({ type: 'snapshot', task, lastSequence }))
        ws.send(JSON.stringify({ type: 'ready', taskId }))
        for (const event of events) {
          if (event.seq > replayAfter) ws.send(JSON.stringify({ type: 'event', event }))
        }
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
    const requestMethod = req.method ?? 'GET'
    if (
      req.headers['sec-fetch-site']?.toLowerCase() === 'cross-site' ||
      !isAllowedOrigin(req, allowedOrigins, requestMethod === 'GET' || requestMethod === 'HEAD')
    )
      throw new HttpError(403, 'Origin is not allowed')
    if (!hasValidBearerToken(req, apiToken)) throw new HttpError(403, 'API authorization failed')
    const method = requestMethod === 'HEAD' ? 'GET' : requestMethod
    const url = requestUrl(req)
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
      const roleOverrides = input.roleOverrides as Partial<RoleConfig> | undefined
      const config = await configStore.get()
      const implementer = resolveRole('implementer', config.roles as RoleConfig, roleOverrides)
      const provider = providers[implementer.provider]
      if (provider && !provider.capabilities.codeEdit)
        throw new HttpError(
          422,
          `${implementer.provider} does not support code editing required by ${input.mode} mode`,
        )
      const repo = getRepo(db, input.repoId as RepoId)
      if (!repo) throw new HttpError(404, `Repository ${input.repoId} was not found`)
      const task = createTask(db, {
        id: randomUUID() as TaskId,
        repoId: repo.id,
        title: input.title,
        prompt: input.prompt,
        mode: input.mode,
        ...(roleOverrides ? { roleOverrides } : {}),
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
        reviews: listAttempts(db, task.id).flatMap((attempt) => listReviews(db, attempt.id)),
        events: listTaskEvents(db, task.id),
      })
      return
    }
    const eventsMatch = /^\/api\/tasks\/([^/]+)\/events$/.exec(url.pathname)
    if (eventsMatch && method === 'GET') {
      const task = requireTask(decodePathSegment(eventsMatch[1] ?? ''))
      const after = Number(url.searchParams.get('after') ?? '0')
      if (!Number.isSafeInteger(after) || after < 0)
        throw new HttpError(400, 'after must be a non-negative integer')
      json(res, 200, { events: listTaskEvents(db, task.id, after) })
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
    if (url.pathname === '/api/usage' && method === 'GET') {
      json(res, 200, { usage: listUsage(db) })
      return
    }
    if (url.pathname === '/api/config' && method === 'GET') {
      json(res, 200, { config: await configStore.get() })
      return
    }
    if (url.pathname === '/api/config' && method === 'PUT') {
      assertJsonContentType(req)
      const config = configSchema.parse(await readJson(req)) as JoyConfig
      if (!providers[config.roles.implementer.provider]?.capabilities.codeEdit)
        throw new HttpError(
          422,
          `${config.roles.implementer.provider} does not support code editing required by the implementer role`,
        )
      json(res, 200, { config: await configStore.save(config) })
      return
    }
    if (url.pathname === '/api/secrets/openai-api-key' && method === 'GET') {
      json(res, 200, await secretStore.status('openai_api_key'))
      return
    }
    if (url.pathname === '/api/secrets/openai-api-key' && method === 'PUT') {
      const { value } = openAiSecretInputSchema.parse(await readJson(req))
      const status = await secretStore.status('openai_api_key')
      if (status.source === 'env')
        throw new HttpError(409, 'OPENAI_API_KEY is supplied by the environment; manage it there instead.')
      await secretStore.set('openai_api_key', value)
      json(res, 200, await secretStore.status('openai_api_key'))
      return
    }
    if (url.pathname === '/api/secrets/openai-api-key' && method === 'DELETE') {
      const status = await secretStore.status('openai_api_key')
      if (status.source === 'env')
        throw new HttpError(409, 'OPENAI_API_KEY is supplied by the environment; manage it there instead.')
      await secretStore.delete('openai_api_key')
      json(res, 200, await secretStore.status('openai_api_key'))
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
    if (!provider?.capabilities.codeEdit)
      throw new HttpError(
        409,
        `${attempt.provider} does not support code editing required to resume as implementer`,
      )
    if (!provider.capabilities.resume)
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
    let failureConfig = initialConfig
    try {
      const repo = getRepo(db, task.repoId)
      if (!repo) throw new Error(`Repository ${task.repoId} was not found`)
      const config = await configStore.get()
      failureConfig = config
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
      const status = controller.signal.aborted ? 'cancelled' : 'failed'
      if (!attempt) {
        const fallbackImplementer = resolveRole(
          'implementer',
          failureConfig.roles as RoleConfig,
          task.roleOverrides,
        )
        attempt = createAttempt(db, {
          id: randomUUID() as AttemptId,
          taskId: task.id,
          provider: fallbackImplementer.provider,
          model: fallbackImplementer.model,
          status,
        })
      }
      updateAttempt(db, attempt.id, { status })
      setTaskStatus(db, task.id, status)
      publish(task.id, attempt.id, 'error', { message })
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
      } else if (event.type === 'agent') {
        const model = event.role === 'reviewer' ? reviewer : implementer
        persistUsageEvent(db, model.provider, event.event)
        if (event.role === 'implementer' && event.event.type === 'session_started') {
          updateAttempt(db, attempt.id, { sessionId: event.event.sessionId })
        }
      } else if (event.type === 'review') {
        const verdict = redactor.redactValue(event.verdict)
        createReview(db, {
          id: randomUUID(),
          attemptId: attempt.id,
          reviewerProvider: reviewer.provider,
          reviewerModel: reviewer.model,
          round: event.round,
          approve: verdict.approve,
          summary: verdict.summary,
          findings: verdict.findings,
        })
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
    if (!provider.capabilities.codeEdit)
      throw new Error(`${model.provider} does not support code editing required by single mode`)
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
      persistUsageEvent(db, model.provider, event)
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

  apiToken = await writeApiToken(apiTokenFile)
  redactor.add(apiToken)
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
      try {
        const activeTasks = [...running.values()]
        for (const active of activeTasks) active.controller.abort()
        await Promise.all(activeTasks.map((active) => active.promise))
        for (const socket of wsServer.clients) socket.terminate()
        await new Promise<void>((resolve) => wsServer.close(() => resolve()))
        if (httpServer.listening)
          await new Promise<void>((resolve, reject) =>
            httpServer.close((error) => (error ? reject(error) : resolve())),
          )
      } finally {
        try {
          await removeApiToken(apiTokenFile, apiToken)
        } finally {
          if (ownsDatabase && db.isOpen) db.close()
        }
      }
    },
  }
}

function persistUsageEvent(db: Database, provider: ProviderKind, event: AgentEvent): void {
  if (event.type === 'usage') {
    if (event.inputTokens === undefined && event.outputTokens === undefined && event.costUsd === undefined)
      return
    addUsage(db, {
      provider,
      ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
      ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
      ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
    })
  } else if (event.type === 'quota' && event.status === 'limited') {
    addUsage(db, { provider, rateLimitHits: 1 })
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
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(host)
  if (!match) return false
  if (match[1] === undefined) return true
  const port = Number(match[1])
  return port > 0 && port <= 65_535
}

function createOriginAllowlist(allowPlaywrightOrigin: boolean): Set<string> {
  return new Set([
    'tauri://localhost',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    ...(allowPlaywrightOrigin ? PLAYWRIGHT_E2E_ORIGINS : []),
  ])
}

function isAllowedOrigin(
  req: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
  allowMissing: boolean,
): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return allowMissing
  return allowedOrigins.has(origin)
}

function hasValidBearerToken(req: IncomingMessage, token: string): boolean {
  const authorization = req.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return false
  return tokensMatch(authorization.slice('Bearer '.length), token)
}

function hasValidWebSocketToken(req: IncomingMessage, token: string): boolean {
  const raw = req.headers['sec-websocket-protocol']
  const protocols = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((value) => value.trim())
  const tokenProtocols = protocols.filter((protocol) => protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX))
  return (
    protocols.includes(WS_API_PROTOCOL) &&
    tokenProtocols.length === 1 &&
    tokensMatch(tokenProtocols[0]?.slice(WS_TOKEN_PROTOCOL_PREFIX.length) ?? '', token)
  )
}

function tokensMatch(candidate: string, token: string): boolean {
  const candidateBytes = Buffer.from(candidate, 'utf8')
  const tokenBytes = Buffer.from(token, 'utf8')
  return candidateBytes.byteLength === tokenBytes.byteLength && timingSafeEqual(candidateBytes, tokenBytes)
}

async function writeApiToken(path: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(directory, `.${API_TOKEN_FILENAME}-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.chmod(0o600)
      if (process.platform === 'win32') setWindowsApiTokenAcl(temporaryPath)
      await handle.writeFile(token, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
    return token
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

function setWindowsApiTokenAcl(path: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$stage = 'get-identity'
try {
  $path = $env:JOY_API_TOKEN_FILE
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $icacls = "$env:SystemRoot\\System32\\icacls.exe"
  $stage = 'disable-acl-inheritance'
  & $icacls $path /inheritance:r > $null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to disable inherited API token ACLs.' }
  $stage = 'grant-current-user'
  & $icacls $path /grant:r "*$($currentSid.Value):(R,D)" > $null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to grant current-user API token access.' }
  $stage = 'verify-acl'
  $verified = [System.IO.File]::GetAccessControl($path)
  $allowRules = @($verified.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })
  $unexpected = @($allowRules | Where-Object {
    $_.IsInherited -or $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value
  })
  if (
    $allowRules.Count -ne 1 -or
    $unexpected.Count -ne 0 -or
    $allowRules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::ReadAndDelete
  ) { throw 'Unexpected API token ACL.' }
} catch {
  [Console]::Error.WriteLine('JOY_API_TOKEN_ACL_FAILURE:' + $stage + '/' + $_.Exception.GetType().Name)
  exit 1
}
`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, JOY_API_TOKEN_FILE: path },
      timeout: 10_000,
      windowsHide: true,
    })
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer }
    const safeDiagnostic = String(failure.stderr ?? '').match(
      /JOY_API_TOKEN_ACL_FAILURE:[a-z-]+\/[A-Za-z0-9]+/,
    )?.[0]
    const missingPowerShell = failure.code === 'ENOENT' ? ' (PowerShell unavailable)' : ''
    throw new Error(
      `Unable to restrict API token file access to the current Windows user.${safeDiagnostic ? ` ${safeDiagnostic}` : missingPowerShell}`,
      { cause: error },
    )
  }
}

async function removeApiToken(path: string, token: string): Promise<void> {
  let current: string
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (tokensMatch(current, token)) await unlink(path)
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
