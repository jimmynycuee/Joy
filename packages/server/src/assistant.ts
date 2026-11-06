// The assistant (T3.1): one conversation loop for any brain. Tools are defined once here and reach an OpenAI API
// brain as function calls and a CLI brain (Claude Code, Codex) through the assistant MCP bridge.
import type { AgentEvent, AgentProvider, ModelRef, RunOptions } from '@joy/core'
import type { ApiTool } from '@joy/providers'
import type { AssistantToolSpec } from '@joy/tools'

export interface AssistantTool extends AssistantToolSpec {
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

export interface AssistantTurnInput {
  brain: ModelRef
  /** The provider for a CLI brain; the API brain is built per turn with the tools (see `apiProviderFor`). */
  provider: AgentProvider
  userText: string
  /** Earlier messages, used only when the stored session cannot be resumed (first turn or a different brain). */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  resumeSessionId?: string
  /** Working directory for CLI brains: a private, empty folder (the assistant does not edit code itself). */
  cwd: string
  /** MCP config for CLI brains (the assistant bridge for this turn). */
  mcpServer?: NonNullable<RunOptions['mcpServers']>[number]
  signal: AbortSignal
}

export interface AssistantTurnResult {
  reply: string
  sessionId?: string
  events: AgentEvent[]
}

export const ASSISTANT_INSTRUCTIONS = [
  "You are Joy, the owner's personal assistant for their software projects.",
  'Joy runs coding tasks with Claude Code and Codex in isolated git worktrees and reviews them across models.',
  'Use the joy_assistant tools to look up repositories and tasks. Never guess ids or statuses: look them up.',
  'Answer briefly and concretely. Reply in the language the owner writes in.',
].join('\n')

/** Builds the text sent to the brain for this turn. */
export function assistantPrompt(
  input: Pick<AssistantTurnInput, 'userText' | 'history' | 'resumeSessionId'>,
): string {
  if (input.resumeSessionId) return input.userText
  const transcript = input.history
    .slice(-20)
    .map((message) => `${message.role === 'user' ? 'Owner' : 'Joy'}: ${message.content}`)
    .join('\n\n')
  return [
    ASSISTANT_INSTRUCTIONS,
    ...(transcript ? ['', 'Conversation so far:', transcript] : []),
    '',
    `Owner: ${input.userText}`,
  ].join('\n')
}

/** Runs one turn and returns the brain's final message. Throws with the brain's error when the run fails. */
export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  const events: AgentEvent[] = []
  let done: Extract<AgentEvent, { type: 'done' }> | undefined
  let failure: string | undefined
  const options: RunOptions = {
    cwd: input.cwd,
    prompt: assistantPrompt(input),
    autonomy: 'read-only',
    signal: input.signal,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    ...(input.mcpServer ? { mcpServers: [input.mcpServer] } : {}),
  }
  for await (const event of input.provider.run(options, input.brain)) {
    events.push(event)
    if (event.type === 'error' && !event.recoverable) failure = event.message
    if (event.type === 'done') done = event
  }
  if (!done || done.isError) throw new Error(failure ?? 'The assistant did not answer')
  const reply =
    done.finalMessage ??
    events
      .filter((event): event is Extract<AgentEvent, { type: 'message' }> => event.type === 'message')
      .map((event) => event.text)
      .join('\n')
  return {
    reply: reply.trim() || '(no reply)',
    ...(done.sessionId ? { sessionId: done.sessionId } : {}),
    events,
  }
}

/** The same tools as OpenAI function calls. */
export function toApiTools(tools: AssistantTool[]): ApiTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    run: (args, signal) => tool.run(isRecord(args) ? args : {}, signal),
  }))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
