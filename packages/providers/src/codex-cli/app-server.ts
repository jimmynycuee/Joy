import type {
  AgentEvent,
  AgentProvider,
  ModelRef,
  ProviderCapabilities,
  ProviderHealth,
  RunOptions,
  Steer,
} from '@joy/core'
import { effortCompatibilityError } from '@joy/model-effort'
import { probeVersion } from '../cli-run.js'
import { rec, str } from '../guards.js'
import type { McpServerConfig } from '@joy/core'
import { CodexAppServerClient, type CodexApprovalHandler } from './app-server-client.js'
import type {
  InitializeParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
  TurnSteerParams,
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
      args: [...this.argsPrefix, 'app-server'],
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

      const config = mcpConfig(opts.mcpServers)
      const common: ThreadStartParams = {
        model: model.model,
        cwd: opts.cwd,
        approvalPolicy: approvalPolicy(opts.autonomy),
        sandbox: sandboxMode(opts.autonomy),
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
      yield* parser.startSession(sessionId)

      try {
        const rateLimits = await client.request('account/rateLimits/read', {})
        yield* parser.initialRateLimits(rateLimits)
      } catch {
        // Quota is supplemental; older app-server versions may not implement this method.
      }

      const turn: TurnStartParams = {
        threadId: sessionId,
        input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
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
        const steer: Steer = async (text) => {
          if (!steerable || parser.finished || opts.signal.aborted) return false
          try {
            await client.request('turn/steer', {
              threadId,
              expectedTurnId: turnId,
              input: [{ type: 'text', text, text_elements: [] }],
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

function approvalPolicy(autonomy: RunOptions['autonomy']): ThreadStartParams['approvalPolicy'] {
  return autonomy === 'workspace-write' ? 'on-request' : 'never'
}

function mcpConfig(servers: McpServerConfig[] | undefined): Record<string, unknown> | undefined {
  if (!servers?.length) return undefined
  const mcpServers: Record<string, unknown> = {}
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) throw new Error(`Invalid MCP server name "${server.name}"`)
    mcpServers[server.name] =
      server.transport === 'stdio'
        ? { command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) }
        : { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) }
  }
  return { mcp_servers: mcpServers }
}
