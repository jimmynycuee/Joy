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
  addUsage,
  appendTaskEvent,
  createAttempt,
  createRepo,
  createReview,
  createTask,
  getAttempt,
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
import { compete, reviewLoop, synthesizeStrengths } from '@joy/orchestrator'
import type { SynthesisSourceCandidate } from '@joy/orchestrator'
import { ClaudeCliProvider, CodexCliProvider, OpenAiApiProvider } from '@joy/providers'
import { MIN_SECRET_VALUE_LENGTH, Redactor, SecretStore } from '@joy/secrets'

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
const workspaceDiffSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().optional(),
      status: z.enum(['added', 'modified', 'deleted', 'renamed']),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  ),
  patch: z.string(),
})
const synthesisSourceCandidateSchema = z.object({
  attemptId: idSchema,
  model: modelSchema,
  status: z.literal('succeeded'),
  diff: workspaceDiffSchema,
})
const openAiSecretInputSchema = z.strictObject({
  value: z.string().trim().min(MIN_SECRET_VALUE_LENGTH).max(4096),
})
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
  const subscribers = new Map<TaskId, Set<WebSocket>>()
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES })
  let closed = false

  const publish = (taskId: TaskId, attemptId: AttemptId, type: string, payload: unknown): TaskEvent => {
    const safe = redactor.redactValue(payload)
    const storedAttempt = getAttempt(db, attemptId)
    const event = storedAttempt
      ? appendTaskEvent(db, attemptId, type, safe)
      : {
          taskId,
          attemptId,
          seq: listTaskEvents(db, taskId).at(-1)?.seq ?? 0,
          type,
          payload: safe,
          ts: new Date().toISOString(),
        }
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
      const url = requestUrl(req)
      if (
        !isLocalHostHeader(req.headers.host) ||
        url.pathname !== '/ws' ||
        !isAllowedOrigin(req.headers.origin, options.allowPlaywrightOrigin)
      ) {
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
        for (const event of listTaskEvents(db, taskId)) ws.send(JSON.stringify({ type: 'event', event }))
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
    if (!isLocalHostHeader(req.headers.host))
      throw new HttpError(403, 'Host must be localhost, 127.0.0.1, or [::1]')
    if (!isAllowedOrigin(req.headers.origin, options.allowPlaywrightOrigin))
      throw new HttpError(403, 'Origin is not allowed')
    const method = req.method ?? 'GET'
    const url = requestUrl(req)
    if (requiresJsonContentType(method, url.pathname) && !isJsonContentType(req.headers['content-type']))
      throw new HttpError(415, 'Content-Type must be application/json')
    if (url.pathname === '/api/health' && method === 'GET') {
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/api/repos' && method === 'GET') {
      json(res, 200, { repos: listRepos(db) })
      return
    }
    if (url.pathname === '/api/repos' && method === 'POST') {
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
      const input = taskInputSchema.parse(await readJson(req))
      if (input.mode === 'compete') {
        const config = await configStore.get()
        const overrides = (input.roleOverrides ?? {}) as Partial<RoleConfig>
        const implementer = resolveRole('implementer', config.roles as RoleConfig, overrides)
        const reviewer = resolveRole('reviewer', config.roles as RoleConfig, overrides)
        if (implementer.provider === reviewer.provider)
          throw new HttpError(
            400,
            'Compete mode requires implementer and reviewer to use different providers',
          )
        for (const model of [implementer, reviewer]) {
          const provider = providers[model.provider]
          if (!provider)
            throw new HttpError(400, `Compete mode requires configured provider ${model.provider}`)
          if (!provider.capabilities.codeEdit)
            throw new HttpError(
              400,
              `Compete mode requires code-edit capable providers; ${model.provider} cannot edit code`,
            )
        }
      }
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
      const task = requireTask(decodeURIComponent(taskMatch[1] ?? ''))
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
      const task = requireTask(decodeURIComponent(eventsMatch[1] ?? ''))
      const after = Number(url.searchParams.get('after') ?? '0')
      if (!Number.isSafeInteger(after) || after < 0)
        throw new HttpError(400, 'after must be a non-negative integer')
      json(res, 200, { events: listTaskEvents(db, task.id, after) })
      return
    }
    const selectMatch = /^\/api\/tasks\/([^/]+)\/select$/.exec(url.pathname)
    if (selectMatch && method === 'POST') {
      const task = requireTask(decodeURIComponent(selectMatch[1] ?? ''))
      if (task.mode !== 'compete')
        throw new HttpError(409, 'Only compete tasks have a winning attempt to select')
      if (task.status !== 'review_ready')
        throw new HttpError(409, `Task cannot select a winner from ${task.status}`)
      if (running.has(task.id)) throw new HttpError(409, 'A task operation is already running')
      const body = z.strictObject({ attemptId: idSchema }).parse(await readJson(req))
      const currentTask = requireTask(task.id)
      if (currentTask.status !== 'review_ready')
        throw new HttpError(409, 'Task is no longer ready for winner selection')
      if (running.has(task.id)) throw new HttpError(409, 'A task operation is already running')
      const attempt = getAttempt(db, body.attemptId as AttemptId)
      if (!attempt || attempt.taskId !== task.id)
        throw new HttpError(404, 'Attempt was not found for this task')
      if (attempt.status !== 'succeeded')
        throw new HttpError(409, 'Only a successful candidate can be selected')
      const taskEvents = listTaskEvents(db, task.id)
      const latestRunStart = taskEvents.filter((event) => event.type === 'compete_run_started').at(-1)
      if (latestRunStart) {
        const latestRunAttemptIds = new Set(
          taskEvents
            .filter((event) => event.seq > latestRunStart.seq && event.type === 'attempt')
            .map((event) => event.attemptId),
        )
        if (!latestRunAttemptIds.has(attempt.id))
          throw new HttpError(409, 'Only candidates from the latest compete run can be selected')
      }
      setTaskStatus(db, task.id, 'done')
      const event = publish(task.id, attempt.id, 'winner_selected', { attemptId: attempt.id })
      json(res, 200, { task: getTask(db, task.id), selectedAttemptId: attempt.id, event })
      return
    }
    const synthesizeMatch = /^\/api\/tasks\/([^/]+)\/synthesize$/.exec(url.pathname)
    if (synthesizeMatch && method === 'POST') {
      z.strictObject({}).parse(await readJson(req))
      const task = requireTask(decodeURIComponent(synthesizeMatch[1] ?? ''))
      if (task.mode !== 'compete')
        throw new HttpError(409, 'Only compete tasks can synthesize candidate strengths')
      if (task.status !== 'review_ready')
        throw new HttpError(409, `Task cannot synthesize strengths from ${task.status}`)
      if (running.has(task.id)) throw new HttpError(409, 'A task operation is already running')

      const latestRun = latestSynthesisSources(db, task.id)
      if (!latestRun.runStart)
        throw new HttpError(409, 'No completed competition run is available to synthesize')
      if (latestRun.candidates.length < 2)
        throw new HttpError(409, 'Synthesis requires at least two successful candidates from the latest run')
      if (
        latestRun.runEvents.some((event) => {
          if (
            event.type !== 'synthesis_result' ||
            typeof event.payload !== 'object' ||
            event.payload === null
          )
            return false
          return (event.payload as { status?: unknown }).status === 'succeeded'
        })
      )
        throw new HttpError(409, 'This competition run already has a synthesized candidate')

      const repo = getRepo(db, task.repoId)
      if (!repo) throw new HttpError(404, `Repository ${task.repoId} was not found`)
      const config = await configStore.get()
      const synthesizer = resolveRole('judge', config.roles as RoleConfig, task.roleOverrides)
      const synthesizerProvider = providers[synthesizer.provider]
      if (!synthesizerProvider)
        throw new HttpError(409, `No provider configured for synthesizer ${synthesizer.provider}`)
      if (!synthesizerProvider.capabilities.codeEdit)
        throw new HttpError(409, `Synthesizer provider ${synthesizer.provider} is not code-edit capable`)

      const currentTask = requireTask(task.id)
      if (currentTask.status !== 'review_ready')
        throw new HttpError(409, `Task cannot synthesize strengths from ${currentTask.status}`)
      if (running.has(task.id)) throw new HttpError(409, 'A task operation is already running')
      const currentRun = latestSynthesisSources(db, task.id)
      if (!currentRun.runStart || currentRun.candidates.length < 2)
        throw new HttpError(
          409,
          'No completed competition run with at least two successful candidates is available',
        )
      if (
        currentRun.runEvents.some((event) => {
          if (
            event.type !== 'synthesis_result' ||
            typeof event.payload !== 'object' ||
            event.payload === null
          )
            return false
          return (event.payload as { status?: unknown }).status === 'succeeded'
        })
      )
        throw new HttpError(409, 'This competition run already has a synthesized candidate')

      const started = scheduleSynthesis(currentTask, repo, currentRun.candidates, synthesizer)
      json(res, 202, { task: getTask(db, task.id), event: started })
      return
    }
    const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
    if (cancelMatch && method === 'POST') {
      const task = requireTask(decodeURIComponent(cancelMatch[1] ?? ''))
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
      const task = requireTask(decodeURIComponent(resumeMatch[1] ?? ''))
      if (task.status !== 'failed' && task.status !== 'cancelled')
        throw new HttpError(409, `Task cannot be resumed from ${task.status}`)
      const state = task.mode === 'compete' ? undefined : resumeState(task)
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
      const config = configSchema.parse(await readJson(req)) as JoyConfig
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

  function scheduleSynthesis(
    task: StoredTask,
    repo: RepoRecord,
    candidates: SynthesisSourceCandidate[],
    synthesizer: ModelRef,
  ): TaskEvent {
    const controller = new AbortController()
    const active: ActiveTask = { controller, promise: Promise.resolve() }
    const anchorAttemptId = candidates[0]?.attemptId
    if (!anchorAttemptId) throw new Error('Synthesis has no source candidate')
    running.set(task.id, active)
    let started: TaskEvent
    try {
      started = publish(task.id, anchorAttemptId, 'synthesis_started', {
        sourceAttemptIds: candidates.map((candidate) => candidate.attemptId),
        model: synthesizer,
      })
    } catch (error) {
      if (running.get(task.id) === active) running.delete(task.id)
      throw error
    }

    const markInterruptedAttempt = () => {
      const attemptEvent = listTaskEvents(db, task.id)
        .filter(
          (event) =>
            event.seq > started.seq &&
            event.type === 'attempt' &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            (event.payload as { synthesized?: unknown }).synthesized === true,
        )
        .at(-1)
      if (attemptEvent && getAttempt(db, attemptEvent.attemptId))
        updateAttempt(db, attemptEvent.attemptId, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
        })
    }
    active.promise = runSynthesisTask(task, repo, candidates, synthesizer, controller)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Synthesis failed unexpectedly'
        try {
          markInterruptedAttempt()
          const hasTerminalEvent = listTaskEvents(db, task.id).some(
            (event) =>
              event.seq > started.seq &&
              (event.type === 'synthesis_result' || event.type === 'synthesis_error'),
          )
          if (!hasTerminalEvent) publish(task.id, anchorAttemptId, 'synthesis_error', { message })
        } catch {
          try {
            markInterruptedAttempt()
          } catch {
            // The operation lock is still released in finally if persistence itself is unavailable.
          }
        }
      })
      .finally(() => {
        if (running.get(task.id) === active) running.delete(task.id)
      })
    return started
  }

  async function runTask(task: StoredTask, controller: AbortController, resume?: ResumeState): Promise<void> {
    let attempt = resume?.attempt
    try {
      const repo = getRepo(db, task.repoId)
      if (!repo) throw new Error(`Repository ${task.repoId} was not found`)
      const config = await configStore.get()
      const roles = config.roles as RoleConfig
      if (task.mode === 'compete') {
        await runCompeteTask(task, repo, roles, controller)
        return
      }
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
      if (!attempt) {
        const implementer = resolveRole('implementer', initialConfig.roles as RoleConfig, task.roleOverrides)
        attempt = createAttempt(db, {
          id: randomUUID() as AttemptId,
          taskId: task.id,
          provider: implementer.provider,
          model: implementer.model,
          status: 'failed',
        })
      }
      updateAttempt(db, attempt.id, { status: controller.signal.aborted ? 'cancelled' : 'failed' })
      setTaskStatus(db, task.id, controller.signal.aborted ? 'cancelled' : 'failed')
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

  async function runCompeteTask(
    task: StoredTask,
    repo: RepoRecord,
    roles: RoleConfig,
    controller: AbortController,
  ): Promise<void> {
    const implementer = resolveRole('implementer', roles, task.roleOverrides)
    const reviewer = resolveRole('reviewer', roles, task.roleOverrides)
    const judge = resolveRole('judge', roles, task.roleOverrides)
    const preflightModel =
      [implementer, reviewer, judge].find((model) => !providers[model.provider]) ?? implementer
    const failPreflight = (model: ModelRef, message: string) => {
      const attemptId = randomUUID() as AttemptId
      createAttempt(db, {
        id: attemptId,
        taskId: task.id,
        provider: model.provider,
        model: model.model,
        status: 'failed',
      })
      setTaskStatus(db, task.id, 'failed')
      publish(task.id, attemptId, 'result', {
        type: 'result',
        status: 'failed',
        approved: false,
        rounds: 0,
        reason: message,
      })
    }
    if (implementer.provider === reviewer.provider) {
      failPreflight(implementer, 'Compete mode requires implementer and reviewer to use different providers')
      return
    }
    const missingProvider = [
      { role: 'implementer', model: implementer },
      { role: 'reviewer', model: reviewer },
      { role: 'judge', model: judge },
    ].find(({ model }) => !providers[model.provider])
    if (missingProvider) {
      failPreflight(
        missingProvider.model,
        `No provider configured for ${missingProvider.role} ${missingProvider.model.provider}`,
      )
      return
    }
    for (const model of [implementer, reviewer]) {
      const provider = providers[model.provider]
      if (!provider) {
        failPreflight(model, `Compete mode requires configured provider ${model.provider}`)
        return
      }
      if (!provider.capabilities.codeEdit) {
        failPreflight(
          model,
          `Compete mode requires code-edit capable providers; ${model.provider} cannot edit code`,
        )
        return
      }
    }

    let anchorAttemptId: AttemptId | undefined
    let finished = false
    let runStarted = false
    const runId = randomUUID()
    const markRunStarted = (attemptId: AttemptId) => {
      if (runStarted) return
      runStarted = true
      publish(task.id, attemptId, 'compete_run_started', { runId })
    }
    for await (const event of compete(
      {
        taskId: task.id,
        repo,
        prompt: task.prompt,
        competitors: [implementer, reviewer],
        judge,
        signal: controller.signal,
      },
      { providers, executor },
    )) {
      if (event.type === 'attempt') {
        anchorAttemptId ??= event.attemptId
        if (!getAttempt(db, event.attemptId)) {
          createAttempt(db, {
            id: event.attemptId,
            taskId: task.id,
            provider: event.model.provider,
            model: event.model.model,
            status: event.status,
          })
        }
        updateAttempt(db, event.attemptId, {
          status: event.status,
          ...(event.workspace
            ? {
                worktreePath: event.workspace.path,
                branch: event.workspace.branch,
                baseCommit: event.workspace.baseCommit,
              }
            : {}),
          ...(event.diff ? { diffStats: summarizeDiff(event.diff) } : {}),
        })
        markRunStarted(event.attemptId)
      } else if (event.type === 'agent') {
        persistUsageEvent(db, event.model.provider, event.event)
        if (event.role === 'implementer' && event.attemptId && event.event.type === 'session_started')
          updateAttempt(db, event.attemptId, { sessionId: event.event.sessionId })
      } else if (event.type === 'result') {
        finished = true
        const hasSelectableCandidate = event.candidates.some(
          (candidate) => candidate.status === 'succeeded' && candidate.diff !== undefined,
        )
        const status: TaskStatus =
          event.status === 'cancelled'
            ? 'cancelled'
            : event.status === 'failed'
              ? hasSelectableCandidate
                ? 'review_ready'
                : 'failed'
              : 'review_ready'
        setTaskStatus(db, task.id, status)
        if (!anchorAttemptId && event.candidates.length === 0) {
          anchorAttemptId = randomUUID() as AttemptId
          createAttempt(db, {
            id: anchorAttemptId,
            taskId: task.id,
            provider: preflightModel.provider,
            model: preflightModel.model,
            status: event.status === 'cancelled' ? 'cancelled' : 'failed',
          })
        }
        if (anchorAttemptId) markRunStarted(anchorAttemptId)
      }

      const attemptId =
        event.type === 'attempt'
          ? event.attemptId
          : event.type === 'agent'
            ? (event.attemptId ?? anchorAttemptId)
            : event.type === 'judgment'
              ? event.judgment.winnerAttemptId
              : event.type === 'result'
                ? (event.judgment?.winnerAttemptId ?? event.candidates[0]?.attemptId ?? anchorAttemptId)
                : anchorAttemptId
      if (attemptId) publish(task.id, attemptId, event.type, event)
    }
    if (!finished) throw new Error('Competition stopped without a result')
  }

  async function runSynthesisTask(
    task: StoredTask,
    repo: RepoRecord,
    candidates: SynthesisSourceCandidate[],
    synthesizer: ModelRef,
    controller: AbortController,
  ): Promise<void> {
    let finished = false
    for await (const event of synthesizeStrengths(
      {
        taskId: task.id,
        repo,
        prompt: task.prompt,
        synthesizer,
        candidates,
        signal: controller.signal,
      },
      { providers, executor },
    )) {
      if (event.type === 'attempt') {
        const candidate = event.candidate
        if (!getAttempt(db, candidate.attemptId)) {
          createAttempt(db, {
            id: candidate.attemptId,
            taskId: task.id,
            provider: candidate.model.provider,
            model: candidate.model.model,
            status: candidate.status,
          })
        }
        updateAttempt(db, candidate.attemptId, {
          status: candidate.status,
          ...(candidate.workspace
            ? {
                worktreePath: candidate.workspace.path,
                branch: candidate.workspace.branch,
                baseCommit: candidate.workspace.baseCommit,
              }
            : {}),
          ...(candidate.diff ? { diffStats: summarizeDiff(candidate.diff) } : {}),
        })
        publish(task.id, candidate.attemptId, 'attempt', candidate)
      } else if (event.type === 'agent') {
        persistUsageEvent(db, event.model.provider, event.event)
        if (event.event.type === 'session_started')
          updateAttempt(db, event.attemptId, { sessionId: event.event.sessionId })
        publish(task.id, event.attemptId, 'agent', { role: 'synthesizer', round: 1, event: event.event })
      } else {
        finished = true
        updateAttempt(db, event.candidate.attemptId, {
          status: event.candidate.status,
          ...(event.candidate.diff ? { diffStats: summarizeDiff(event.candidate.diff) } : {}),
        })
        publish(task.id, event.candidate.attemptId, 'synthesis_result', {
          attemptId: event.candidate.attemptId,
          status: event.candidate.status,
          sourceAttemptIds: event.candidate.sourceAttemptIds,
          ...(event.candidate.reason ? { reason: event.candidate.reason } : {}),
        })
      }
    }
    if (!finished) throw new Error('Synthesis stopped without a result')
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
  for (const task of listTasks(db)) {
    const events = listTaskEvents(db, task.id)
    const started = events.filter((event) => event.type === 'synthesis_started').at(-1)
    if (!started) continue
    if (
      events.some(
        (event) =>
          event.seq > started.seq && (event.type === 'synthesis_result' || event.type === 'synthesis_error'),
      )
    )
      continue
    const attemptEvent = events
      .filter(
        (event) =>
          event.seq > started.seq &&
          event.type === 'attempt' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          (event.payload as { synthesized?: unknown }).synthesized === true,
      )
      .at(-1)
    if (attemptEvent && getAttempt(db, attemptEvent.attemptId))
      updateAttempt(db, attemptEvent.attemptId, { status: 'failed' })
    publish(task.id, started.attemptId, 'synthesis_error', {
      message: 'Synthesis interrupted by server restart',
    })
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

function latestSynthesisSources(
  db: Database,
  taskId: TaskId,
): {
  runStart?: TaskEvent
  runEvents: TaskEvent[]
  candidates: SynthesisSourceCandidate[]
} {
  const events = listTaskEvents(db, taskId)
  const runStart = events.filter((event) => event.type === 'compete_run_started').at(-1)
  if (!runStart) return { runEvents: [], candidates: [] }
  const runEvents = events.filter((event) => event.seq > runStart.seq)
  const result = runEvents.filter((event) => event.type === 'result').at(-1)
  const payload =
    typeof result?.payload === 'object' && result.payload !== null
      ? (result.payload as Record<string, unknown>)
      : undefined
  const candidates = Array.isArray(payload?.candidates)
    ? payload.candidates.flatMap((candidate) => {
        const parsed = synthesisSourceCandidateSchema.safeParse(candidate)
        return parsed.success
          ? [
              {
                attemptId: parsed.data.attemptId as AttemptId,
                model: parsed.data.model as ModelRef,
                diff: parsed.data.diff as WorkspaceDiff,
              },
            ]
          : []
      })
    : []
  return { runStart, runEvents, candidates }
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

function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(host)
  return Boolean(match && (match[1] === undefined || Number(match[1]) <= 65_535))
}

function isAllowedOrigin(origin: string | undefined, allowPlaywrightOrigin = false): boolean {
  return (
    origin === undefined ||
    origin === 'tauri://localhost' ||
    origin === 'http://localhost:5173' ||
    origin === 'http://127.0.0.1:5173' ||
    (allowPlaywrightOrigin && (origin === 'http://127.0.0.1:4173' || origin === 'http://localhost:4173'))
  )
}

function requiresJsonContentType(method: string, pathname: string): boolean {
  if (method === 'POST') {
    return (
      pathname === '/api/repos' ||
      pathname === '/api/tasks' ||
      /^\/api\/tasks\/[^/]+\/(?:select|synthesize)$/.test(pathname)
    )
  }
  return method === 'PUT' && ['/api/config', '/api/secrets/openai-api-key'].includes(pathname)
}

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
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
