import type { ActionKind, ApprovalDecision, ProviderKind, ProposedAction, TaskId } from '@joy/core'
import { ACTION_KINDS, PROVIDER_KINDS } from '@joy/core'
import { z } from 'zod'

export const TOOL_HUB_TOOL_NAMES = ['ask_peer', 'task_status', 'request_approval', 'approve'] as const
export const TOOL_HUB_SERVER_NAME = 'joy' as const
export const TOOL_HUB_APPROVAL_TOOL_NAME = `mcp__${TOOL_HUB_SERVER_NAME}__approve` as const
export type ToolHubToolName = (typeof TOOL_HUB_TOOL_NAMES)[number]
export type ToolHubValue = null | boolean | number | string | ToolHubValue[] | { [key: string]: ToolHubValue }

const askPeerInput = z.strictObject({
  provider: z.enum(PROVIDER_KINDS),
  question: z.string().trim().min(1).max(20_000),
})
const requestApprovalInput = z.strictObject({
  kind: z.enum(ACTION_KINDS),
  summary: z.string().trim().min(1).max(2_000),
  detail: z.unknown(),
})
const approveInput = z.strictObject({
  tool_name: z.string().trim().min(1).max(256),
  input: z.unknown(),
  tool_use_id: z.string().trim().min(1).max(256),
})

export interface AskPeerInput {
  taskId: TaskId
  provider: ProviderKind
  question: string
  cwd: string
  autonomy: 'read-only'
  signal: AbortSignal
}

export interface ToolHubBudget {
  askPeerCalls: number
}

export interface ToolHubRuntime {
  taskId: TaskId
  currentProvider: ProviderKind
  allowedProviders: readonly ProviderKind[]
  cwd: string
  maxAskPeerCalls: number
  budget: ToolHubBudget
  reserveAskPeer?(input: { provider: ProviderKind }): void
  askPeer(input: AskPeerInput): Promise<ToolHubValue>
  taskStatus(): Promise<ToolHubValue>
  requestApproval?(action: ProposedAction): Promise<ToolHubValue>
  approve?(input: { tool_name: string; input: unknown; tool_use_id: string }): Promise<ToolHubValue>
}

export interface ToolHubCall {
  name: ToolHubToolName
  arguments: unknown
}

export type ToolHubDispatcher = (call: ToolHubCall, signal?: AbortSignal) => Promise<ToolHubValue>

const allowedPeerProviders = new Set<ProviderKind>(PROVIDER_KINDS)

/** Validates and executes one task-scoped tool call; the budget object is shared for all task runs. */
export function createToolHubDispatcher(runtime: ToolHubRuntime): ToolHubDispatcher {
  if (!Number.isInteger(runtime.maxAskPeerCalls) || runtime.maxAskPeerCalls < 1) {
    throw new Error('maxAskPeerCalls must be a positive integer')
  }
  return async function dispatch(call: ToolHubCall, signal?: AbortSignal): Promise<ToolHubValue> {
    if (call.name === 'ask_peer') {
      const input = askPeerInput.parse(call.arguments)
      if (input.provider === runtime.currentProvider) {
        throw new Error('ask_peer must target a different provider than the current agent')
      }
      if (!allowedPeerProviders.has(input.provider) || !runtime.allowedProviders.includes(input.provider)) {
        throw new Error(`ask_peer provider ${input.provider} is not allowed for this repository`)
      }
      if (runtime.budget.askPeerCalls >= runtime.maxAskPeerCalls) {
        throw new Error(`ask_peer limit reached (${runtime.maxAskPeerCalls} per task)`)
      }
      runtime.budget.askPeerCalls += 1
      try {
        runtime.reserveAskPeer?.({ provider: input.provider })
      } catch (error) {
        runtime.budget.askPeerCalls -= 1
        throw error
      }
      return runtime.askPeer({
        taskId: runtime.taskId,
        provider: input.provider,
        question: input.question,
        cwd: runtime.cwd,
        autonomy: 'read-only',
        signal: signal ?? new AbortController().signal,
      })
    }
    if (call.name === 'task_status') {
      z.strictObject({}).parse(call.arguments)
      return runtime.taskStatus()
    }
    if (call.name === 'request_approval') {
      const input = requestApprovalInput.parse(call.arguments)
      if (!runtime.requestApproval) throw new Error('Approval requests are not available in this runtime')
      const action: ProposedAction = {
        kind: input.kind as ActionKind,
        summary: input.summary,
        detail: input.detail,
        provenance: 'agent',
      }
      return runtime.requestApproval(action)
    }
    if (call.name === 'approve') {
      const input = approveInput.parse(call.arguments)
      if (!runtime.approve) {
        return { behavior: 'deny', message: 'Joy policy approval is not available in this runtime.' }
      }
      return runtime.approve(input)
    }
    const unreachable: never = call.name
    throw new Error(`Unknown Tool Hub tool: ${String(unreachable)}`)
  }
}

export const toolHubInputSchemas = {
  ask_peer: askPeerInput,
  task_status: z.strictObject({}),
  request_approval: requestApprovalInput,
  approve: approveInput,
}

export type ToolApprovalDecision = ApprovalDecision
