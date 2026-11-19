import type {
  AgentEvent,
  AgentProvider,
  ImageInput,
  ModelRef,
  ProviderCapabilities,
  ProviderHealth,
  RunOptions,
  Steer,
} from '@joy/core'
import { effortCompatibilityError } from '@joy/model-effort'
import { probeVersion } from '../cli-run.js'
import { arr, rec, str } from '../guards.js'
import type { McpServerConfig } from '@joy/core'
import { CodexAppServerClient, type CodexApprovalHandler } from './app-server-client.js'
import type {
  InitializeParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
  TurnSteerParams,
  UserInput,
} from './app-server-protocol.js'
import { CodexAppServerParser } from './app-server-parse.js'

export interface CodexAppServerOptions {
  command?: string
  argsPrefix?: string[]
  /** Default 60 minutes. Codex retries forever without a network, so every run needs one. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Called for app-server approval requests; the app must consult its configured policy. */
  approvalHandler?: CodexApprovalHandler
}

const CAPABILITIES: ProviderCapabilities = {
  codeEdit: true,
  tools: true,
  resume: true,
  presetSessionId: false,
  delegatedApproval: true,
  quotaEvents: true,
  structuredOutput: true,
}

export class CodexAppServerProvider implements AgentProvider {
  readonly kind = 'codex-cli' as const
  readonly capabilities = CAPABILITIES
  private readonly command: string
  private readonly argsPrefix: string[]
  private readonly timeoutMs: number
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly approvalHandler: CodexApprovalHandler | undefined

  constructor(options: CodexAppServerOptions = {}) {
    this.command = options.command ?? 'codex'
    this.argsPrefix = options.argsPrefix ?? []
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
    this.env = options.env
    this.approvalHandler = options.approvalHandler
  }

  async *run(opts: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    if (model.provider !== 'codex-cli') {
      throw new Error(`Codex app-server cannot run model provider '${model.provider}'.`)
    }
    if (model.effort) {
      const issue = effortCompatibilityError(model.provider, model.model, model.effort)
      if (issue) throw new Error(`Invalid Codex model effort: ${issue}`)
    }

    const client = new CodexAppServerClient({
      command: this.command,
      args: [...this.argsPrefix, 'app-server', ...OWNER_EXTRAS_OFF],
      cwd: opts.cwd,
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
      ...(this.env ? { env: this.env } : {}),
      ...(this.approvalHandler
        ? { approvalHandler: (request) => this.approvalHandler?.(request, opts) ?? 'decline' }
        : {}),
    })
    const parser = new CodexAppServerParser({ cwd: opts.cwd, structured: Boolean(opts.outputSchema) })
    let sessionId = ''
    let steerable = false

    try {
      const initialize: InitializeParams = {
        clientInfo: { name: 'joy', title: 'Joy', version: '0.0.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }
      await client.request('initialize', initialize)
      client.notify('initialized')

      const config = isolatedConfig(await ownerMcpServers(client, opts.cwd), opts.mcpServers)
      const common: ThreadStartParams = {
        model: model.model,
        cwd: opts.cwd,
        approvalPolicy: approvalPolicy(opts.autonomy),
        sandbox: sandboxMode(opts.autonomy),
        // Measured with codex-cli 0.166.0: `approvals_reviewer = "guardian_subagent"` in the owner's config.toml made
        // Codex approve a network escalation itself in an `ask` task; Joy never saw the request.
        approvalsReviewer: 'user',
        ...(config ? { config } : {}),
      }
      const thread = opts.resumeSessionId
        ? await client.request('thread/resume', {
            ...common,
            threadId: opts.resumeSessionId,
          } satisfies ThreadResumeParams)
        : await client.request('thread/start', common)
      sessionId = str(rec(rec(thread)?.thread)?.id) ?? ''
      if (!sessionId) throw new Error('Codex app-server did not return a thread id')
      await assertOnlyJoyServers(client, sessionId, opts.mcpServers)
      yield* parser.startSession(sessionId)

      try {
        const rateLimits = await client.request('account/rateLimits/read', {})
        yield* parser.initialRateLimits(rateLimits)
      } catch {
        // Quota is supplemental; older app-server versions may not implement this method.
      }

      const turn: TurnStartParams = {
        threadId: sessionId,
        input: userInput(opts.prompt, opts.images),
        cwd: opts.cwd,
        model: model.model,
        ...(model.effort ? { effort: model.effort } : {}),
        ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
      }
      const started = await client.request('turn/start', turn)
      const turnId = str(rec(rec(started)?.turn)?.id)
      if (turnId && opts.onSteer) {
        // Owner messages join the turn in flight (`turn/steer`); the turn id guards against steering a later one.
        const threadId = sessionId
        steerable = true
        const steer: Steer = async (text, images) => {
          if (!steerable || parser.finished || opts.signal.aborted) return false
          try {
            await client.request('turn/steer', {
              threadId,
              expectedTurnId: turnId,
              input: userInput(text, images),
            } satisfies TurnSteerParams)
            return true
          } catch {
            return false
          }
        }
        opts.onSteer(steer)
      }

      for await (const incoming of client.incoming) {
        if (incoming.kind === 'raw') {
          yield { type: 'raw', source: 'codex-cli', payload: incoming.payload }
          continue
        }
        if (incoming.kind === 'error') {
          yield { type: 'error', message: incoming.message, recoverable: false }
          continue
        }
        const events = parser.notification(incoming.method, incoming.params)
        if (parser.finished) stopSteering()
        yield* events
        if (parser.finished) break
      }
      if (!parser.finished) throw new Error('Codex app-server closed before the turn completed')
    } catch (error) {
      if (!sessionId) throw error
      if (!parser.finished) {
        const message = error instanceof Error ? error.message : 'Codex app-server failed'
        yield { type: 'error', message, recoverable: false }
        yield { type: 'done', sessionId, isError: true }
      }
    } finally {
      stopSteering()
      await client.close()
    }

    function stopSteering(): void {
      if (!steerable) return
      steerable = false
      opts.onSteer?.(undefined)
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const probe = await probeVersion(this.command, this.argsPrefix, this.env)
    return {
      ok: probe.ok,
      installed: probe.installed,
      loggedIn: probe.installed ? 'unknown' : false,
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.detail ? { detail: probe.detail } : {}),
    }
  }
}

function sandboxMode(autonomy: RunOptions['autonomy']): ThreadStartParams['sandbox'] {
  switch (autonomy) {
    case 'read-only':
      return 'read-only'
    case 'workspace-write':
      return 'workspace-write'
    case 'full':
      return 'danger-full-access'
  }
}

/**
 * Every task permission mode (ask, auto, full) uses `workspace-write` + `on-request`: the sandbox keeps writes in the
 * worktree and the network off, and Codex asks Joy only to step outside it; the mode decides that answer. Neither
 * `danger-full-access` nor `never` is used for `full`, since Joy must still see requests that touch secrets.
 */
function approvalPolicy(autonomy: RunOptions['autonomy']): ThreadStartParams['approvalPolicy'] {
  return autonomy === 'workspace-write' ? 'on-request' : 'never'
}

/**
 * Started without the owner's plugins (CapCut, Notion, Gmail…), the ChatGPT apps connectors and remote plugins: their
 * tools would reach the agent without Joy's approval. Measured with codex-cli 0.166.0: a thread-level `features`
 * override is too late for remote plugins, so this is on the command line.
 */
const OWNER_EXTRAS_OFF = ['--disable', 'plugins', '--disable', 'apps', '--disable', 'remote_plugin']

/**
 * The MCP servers the owner's own Codex config would start here (`config/read` includes the project's
 * `.codex/config.toml`). Joy cannot keep them out without their names, so a run stops when it cannot get them.
 */
async function ownerMcpServers(client: CodexAppServerClient, cwd: string): Promise<string[]> {
  let read: unknown
  try {
    read = await client.request('config/read', { cwd, includeLayers: false })
  } catch (error) {
    throw new Error(
      `Codex app-server did not report which MCP servers it would load, so Joy cannot keep the owner's own servers out of this run: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const settings = rec(rec(read)?.config)
  if (!settings)
    throw new Error(
      "Codex app-server sent no configuration for config/read; Joy cannot keep the owner's MCP servers out",
    )
  return Object.keys(rec(settings.mcp_servers) ?? {})
}

/**
 * Joy's servers plus every other configured server switched off: like Claude's `--strict-mcp-config`, a run only gets
 * the servers Joy gave it. Without this, the owner's servers (computer use, a REPL, anything in config.toml) ran in
 * Joy's tasks and their tools were called without Joy's approval.
 */
function isolatedConfig(
  ownerServers: string[],
  servers: McpServerConfig[] | undefined,
): Record<string, unknown> | undefined {
  const joy = mcpConfig(servers)
  const joyServers = rec(joy?.mcp_servers) ?? {}
  const off = Object.fromEntries(
    ownerServers.filter((name) => !(name in joyServers)).map((name) => [name, { enabled: false }]),
  )
  const all = { ...off, ...joyServers }
  return Object.keys(all).length ? { mcp_servers: all } : undefined
}

/** A safety net for servers from places neither switch reaches: the run stops before the agent gets a turn. */
async function assertOnlyJoyServers(
  client: CodexAppServerClient,
  threadId: string,
  servers: McpServerConfig[] | undefined,
): Promise<void> {
  const joy = new Set((servers ?? []).map((server) => server.name))
  const listed = arr(rec(await client.request('mcpServerStatus/list', { threadId }))?.data)
  const stray = listed
    .map((entry) => rec(entry))
    .filter((entry) => entry && !joy.has(str(entry.name) ?? '') && str(entry.runtimeStatus) !== 'disabled')
    .map((entry) => str(entry?.name) ?? '?')
  if (stray.length)
    throw new Error(
      `Codex started MCP servers Joy did not configure (${stray.join(', ')}); the run was stopped so their tools cannot be used without approval`,
    )
}

function mcpConfig(servers: McpServerConfig[] | undefined): Record<string, unknown> | undefined {
  if (!servers?.length) return undefined
  const mcpServers: Record<string, unknown> = {}
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) throw new Error(`Invalid MCP server name "${server.name}"`)
    // `default_tools_approval_mode = "prompt"` (codex-cli 0.166.0 config: auto | prompt | writes | approve) makes Codex
    // ask before every tool call of that server, through `mcpServer/elicitation/request`, which reaches Joy's policy.
    const approval = server.approval === 'every-call' ? { default_tools_approval_mode: 'prompt' } : {}
    mcpServers[server.name] =
      server.transport === 'stdio'
        ? {
            command: server.command,
            args: server.args,
            ...(server.env ? { env: server.env } : {}),
            ...approval,
          }
        : { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}), ...approval }
  }
  return { mcp_servers: mcpServers }
}

/** The prompt, then each attached image as a local file the app-server reads (never copied into the worktree). */
export function userInput(text: string, images: readonly ImageInput[] = []): UserInput[] {
  return [
    { type: 'text', text, text_elements: [] },
    ...images.map((image): UserInput => ({ type: 'localImage', path: image.path })),
  ]
}
