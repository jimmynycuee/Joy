// Model backends and the normalized event stream every backend produces.
// Shapes come from the CLI spikes: docs/spikes/claude-code.md and docs/spikes/codex.md.

export const PROVIDER_KINDS = ['openai-api', 'claude-cli', 'codex-cli'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/** A backend plus a model name. Model names are configuration (aliases such as "opus" are fine). */
export interface ModelRef {
  provider: ProviderKind
  model: string
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value)
}

/** Parses `"<provider>:<model>"`, e.g. `"claude-cli:opus"`. Returns null when malformed. */
export function parseModelRef(input: string): ModelRef | null {
  const sep = input.indexOf(':')
  if (sep <= 0) return null
  const provider = input.slice(0, sep)
  const model = input.slice(sep + 1).trim()
  if (!isProviderKind(provider) || model === '') return null
  return { provider, model }
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`
}

/** A usage window reported by the backend, e.g. Claude's five_hour / seven_day windows. */
export interface QuotaWindow {
  name: string
  /** 0..1 */
  utilization: number
  /** Unix seconds. */
  resetsAt?: number
}

export type FileChangeKind = 'add' | 'modify' | 'delete'

/**
 * The normalized event stream. Adapters map every CLI/API event to one of these.
 * Unknown upstream events become `raw` and are never an error: CLIs add event types often.
 */
export type AgentEvent =
  | { type: 'session_started'; sessionId: string; model?: string; detail?: unknown }
  | { type: 'status'; text: string }
  | { type: 'message'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: unknown; isError: boolean }
  | { type: 'file_change'; path: string; kind: FileChangeKind }
  | { type: 'permission_denied'; toolName: string; reason: string }
  | { type: 'quota'; status: 'allowed' | 'warning' | 'limited'; windows: QuotaWindow[]; resetsAt?: number }
  | {
      type: 'usage'
      inputTokens?: number
      outputTokens?: number
      cachedInputTokens?: number
      /** Equivalent API cost. For subscription CLIs this is an estimate, not money spent. */
      costUsd?: number
    }
  /** `recoverable: true` covers notices such as Codex's "Reconnecting... 2/5". */
  | { type: 'error'; message: string; recoverable: boolean }
  | {
      type: 'done'
      sessionId: string
      finalMessage?: string
      /** The final answer parsed against `RunOptions.outputSchema`, when one was given and the backend supports it. */
      structured?: unknown
      isError: boolean
    }
  | { type: 'raw'; source: ProviderKind; payload: unknown }

export type AgentEventType = AgentEvent['type']

/** How much the agent may do without asking. Maps to CLI sandbox / permission modes. */
export type Autonomy = 'read-only' | 'workspace-write' | 'full'

export type McpServerConfig =
  | { name: string; transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { name: string; transport: 'http'; url: string; headers?: Record<string, string> }

export interface RunOptions {
  /** Absolute path of the worktree the agent works in. */
  cwd: string
  prompt: string
  /** Start a new session with this id (Claude supports choosing it; Codex assigns its own). */
  sessionId?: string
  /** Continue an earlier session instead of starting a new one. */
  resumeSessionId?: string
  /** Joy's Tool Hub and anything else the agent may call. */
  mcpServers?: McpServerConfig[]
  /**
   * Fully qualified MCP tool that answers permission prompts (e.g. `mcp__joy__approve`).
   * Backends that cannot delegate approvals ignore it and rely on `autonomy`.
   */
  approvalTool?: string
  autonomy: Autonomy
  /** Final answer must match this JSON Schema (used for structured review findings). */
  outputSchema?: object
  signal: AbortSignal
}

export interface ProviderCapabilities {
  codeEdit: boolean
  tools: boolean
  resume: boolean
  /** Can choose the session id up front. */
  presetSessionId: boolean
  /** Can hand permission prompts to an MCP tool. */
  delegatedApproval: boolean
  /** Reports quota windows proactively. */
  quotaEvents: boolean
  structuredOutput: boolean
}

export interface ProviderHealth {
  ok: boolean
  installed: boolean
  loggedIn: boolean | 'unknown'
  version?: string
  detail?: string
}

export interface AgentProvider {
  readonly kind: ProviderKind
  readonly capabilities: ProviderCapabilities
  /** Streams normalized events. Ends after exactly one `done` event, or throws if the process could not start. */
  run(opts: RunOptions, model: ModelRef): AsyncIterable<AgentEvent>
  healthCheck(): Promise<ProviderHealth>
}
