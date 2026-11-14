// Narrow snapshot of the official `codex app-server generate-ts` output used by this adapter.
// Source: openai/codex/codex-rs/app-server-protocol/schema/typescript (v2).
// Regenerate against the installed Codex CLI when its app-server protocol version is pinned.
export type JsonRpcId = string | number

export interface JsonRpcRequest {
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string }
  capabilities: { experimentalApi: boolean; requestAttestation: boolean }
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never'

export interface ThreadStartParams {
  model: string
  cwd: string
  approvalPolicy: CodexApprovalPolicy
  sandbox: CodexSandboxMode
  config?: Record<string, unknown>
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string
}

/**
 * The `UserInput` variants Joy sends (`codex app-server generate-json-schema`, codex-cli 0.166.0): text, and an image
 * file on this computer that the app-server reads itself.
 */
export type UserInput =
  { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string }

export interface TurnStartParams {
  threadId: string
  input: UserInput[]
  cwd: string
  model: string
  effort?: string
  outputSchema?: object
}

/** Adds input to the turn in flight; fails when `expectedTurnId` is not the active turn any more. */
export interface TurnSteerParams {
  threadId: string
  expectedTurnId: string
  input: UserInput[]
}

export interface TurnSteerResponse {
  turnId: string
}

// These request payloads follow the generated CommandExecutionRequestApprovalParams and
// FileChangeRequestApprovalParams definitions. Extra generated fields are kept as unknown JSON.
export interface CommandExecutionApprovalParams {
  kind: 'command' | 'humanCommand' | 'writeStdin'
  threadId: string
  turnId: string
  itemId: string
  startedAtMs: number
  environmentId: string | null
  approvalId?: string | null
  reason?: string | null
  command?: string | null
  cwd?: string | null
  commandActions?: unknown[] | null
  [key: string]: unknown
}

export interface FileChangeApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  startedAtMs: number
  reason?: string | null
  grantRoot?: string | null
  [key: string]: unknown
}

export type ServerApprovalRequest =
  | { method: 'item/commandExecution/requestApproval'; id: JsonRpcId; params: CommandExecutionApprovalParams }
  | { method: 'item/fileChange/requestApproval'; id: JsonRpcId; params: FileChangeApprovalParams }

export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: unknown } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: unknown } }
  | 'decline'
  | 'cancel'

export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface RateLimitSnapshot {
  limitId: string | null
  limitName: string | null
  normalModelSlug: string | null
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
  rateLimitReachedType: string | null
  [key: string]: unknown
}

export interface AccountRateLimitsResponse {
  ordinaryUsageAllowed: boolean | null
  rateLimits: RateLimitSnapshot
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null
  [key: string]: unknown
}

export type AppServerWireMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
