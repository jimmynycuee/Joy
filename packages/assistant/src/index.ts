import type {
  AgentEvent,
  AgentProvider,
  Autonomy,
  McpServerConfig,
  ModelRef,
  ProviderKind,
  RunOptions,
} from '@joy/core'
import type { ApiTool } from '@joy/providers'
import { toFunctionCallingTools } from '@joy/tools'
import type { ToolHubTool } from '@joy/tools'

interface FunctionCallingAgentProvider extends AgentProvider {
  withTools(tools: ApiTool[]): AgentProvider
}

export interface AssistantConversationOptions {
  /** The selected assistant_brain model; callers can override it for any turn. */
  brain: ModelRef
  providers: Partial<Record<ProviderKind, AgentProvider>>
  cwd: string
  tools: readonly ToolHubTool[]
  /** The same Tool Hub exposed to CLI brains over MCP. */
  mcpServers?: McpServerConfig[]
  autonomy?: Autonomy
}

export interface AssistantTurnOptions {
  signal: AbortSignal
  brain?: ModelRef
}

/**
 * Runs provider-native tool rounds and keeps provider sessions for follow-up turns.
 * CLI providers receive the Tool Hub as MCP; OpenAI receives function tools built
 * from the same ToolHubTool definitions.
 */
export class AssistantConversation {
  private readonly sessions = new Map<string, string>()
  private running = false

  constructor(private readonly options: AssistantConversationOptions) {}

  async *send(prompt: string, turn: AssistantTurnOptions): AsyncGenerator<AgentEvent> {
    if (this.running) throw new Error('An assistant turn is already running')
    if (!prompt.trim()) throw new Error('Assistant prompt must not be empty')
    this.running = true
    try {
      const brain = turn.brain ?? this.options.brain
      const configuredProvider = this.options.providers[brain.provider]
      if (!configuredProvider) throw new Error(`No assistant provider configured for ${brain.provider}`)

      const sessionKey = `${brain.provider}:${brain.model}:${brain.effort ?? ''}`
      const previousSessionId = this.sessions.get(sessionKey)
      const runOptions: RunOptions = {
        cwd: this.options.cwd,
        prompt,
        autonomy: this.options.autonomy ?? 'read-only',
        signal: turn.signal,
        ...(previousSessionId ? { resumeSessionId: previousSessionId } : {}),
      }

      let provider = configuredProvider
      if (brain.provider === 'openai-api') {
        if (!hasFunctionCalling(configuredProvider))
          throw new Error('The OpenAI assistant provider must support per-turn function tools')
        provider = configuredProvider.withTools(toFunctionCallingTools(this.options.tools))
      } else {
        if (this.options.tools.length > 0 && !this.options.mcpServers?.length)
          throw new Error('CLI assistant providers require a Tool Hub MCP server')
        if (this.options.mcpServers?.length) runOptions.mcpServers = this.options.mcpServers
      }

      let done: Extract<AgentEvent, { type: 'done' }> | undefined
      for await (const event of provider.run(runOptions, brain)) {
        if (event.type === 'done') done = event
        yield event
      }
      if (done && !done.isError && done.sessionId) this.sessions.set(sessionKey, done.sessionId)
      else this.sessions.delete(sessionKey)
    } finally {
      this.running = false
    }
  }
}

function hasFunctionCalling(provider: AgentProvider): provider is FunctionCallingAgentProvider {
  return typeof (provider as Partial<FunctionCallingAgentProvider>).withTools === 'function'
}
