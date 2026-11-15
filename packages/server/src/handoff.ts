import type { ModelRef } from '@joy/core'

/** The parts of a stored task event the summary reads. */
export interface HandoffEvent {
  type: string
  payload: unknown
}

export interface ConversationTurn {
  speaker: 'owner' | 'implementer' | 'reviewer' | 'joy'
  text: string
}

const MAX_TURN_CHARS = 2_000
const MAX_TURNS_CHARS = 24_000
const MAX_PATCH_CHARS = 20_000

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}… (cut)` : trimmed
}

/**
 * What was said in a task so far, oldest first, from its stored events: the owner's messages, each agent turn's final
 * answer (or its last message when it ended without one), review verdicts, plans and failures. Tool calls, thinking and
 * bookkeeping are left out. `skipMessageIds` leaves out owner messages the next prompt carries anyway.
 */
export function conversationTurns(
  events: readonly HandoffEvent[],
  skipMessageIds: ReadonlySet<string> = new Set(),
): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  // The text an agent turn streamed so far; streamed replies arrive as several `message` events.
  const streaming = new Map<string, string>()
  const push = (speaker: ConversationTurn['speaker'], text: string) => {
    const clipped = clip(text, MAX_TURN_CHARS)
    if (clipped) turns.push({ speaker, text: clipped })
  }
  for (const event of events) {
    const payload = record(event.payload)
    if (!payload) continue
    if (event.type === 'user.message') {
      if (
        typeof payload.text === 'string' &&
        !(typeof payload.id === 'string' && skipMessageIds.has(payload.id))
      )
        push('owner', payload.text)
      continue
    }
    if (event.type === 'agent') {
      const role =
        payload.role === 'reviewer' ? 'reviewer' : payload.role === 'implementer' ? 'implementer' : undefined
      const inner = record(payload.event)
      if (!role || !inner) continue
      const key = `${role}:${String(payload.round ?? '')}`
      if (inner.type === 'message' && typeof inner.text === 'string') {
        streaming.set(key, `${streaming.get(key) ?? ''}${inner.text}`)
      } else if (inner.type === 'done') {
        const text = typeof inner.finalMessage === 'string' ? inner.finalMessage : (streaming.get(key) ?? '')
        streaming.delete(key)
        // A reviewer's answer is its verdict, which the `review` event states plainly.
        if (role === 'implementer') push('implementer', text)
      }
      continue
    }
    if (event.type === 'review') {
      const verdict = record(payload.verdict)
      if (!verdict) continue
      const findings = Array.isArray(verdict.findings) ? verdict.findings.map(record).filter((f) => f) : []
      const lines = [
        `${verdict.approve === true ? 'Approved' : 'Changes requested'}${payload.target === 'plan' ? ' (plan)' : ''}: ${typeof verdict.summary === 'string' ? verdict.summary : ''}`,
        ...findings
          .slice(0, 5)
          .map(
            (finding) =>
              `- [${String(finding?.severity ?? 'note')}]${typeof finding?.file === 'string' ? ` ${finding.file}` : ''} ${String(finding?.message ?? '')}`,
          ),
      ]
      push('reviewer', lines.join('\n'))
      continue
    }
    if (event.type === 'plan.awaiting_approval' && typeof payload.plan === 'string') {
      push('implementer', `Plan written for the owner's approval:\n${payload.plan}`)
      continue
    }
    if (event.type === 'plan.approved') {
      push(
        'joy',
        `The owner approved the plan${typeof payload.note === 'string' ? `: ${payload.note}` : '.'}`,
      )
      continue
    }
    if (event.type === 'result' && payload.status !== 'succeeded' && typeof payload.reason === 'string') {
      push('joy', `The run ended (${String(payload.status)}): ${payload.reason}`)
    }
  }
  return turns
}

const SPEAKERS: Record<ConversationTurn['speaker'], string> = {
  owner: 'Owner',
  implementer: 'Previous agent',
  reviewer: 'Reviewer',
  joy: 'Joy',
}

/** The newest turns that fit in the budget, oldest first; a note says when older ones were left out. */
export function formatTurns(turns: readonly ConversationTurn[], budget = MAX_TURNS_CHARS): string {
  const kept: string[] = []
  let used = 0
  for (const turn of [...turns].reverse()) {
    const line = `${SPEAKERS[turn.speaker]}: ${turn.text}`
    if (used + line.length > budget && kept.length) break
    kept.unshift(line)
    used += line.length
  }
  const omitted = turns.length - kept.length
  return [...(omitted ? [`(${omitted} earlier entries left out)`] : []), ...kept].join('\n\n')
}

export interface SwitchHandoffInput {
  from: Pick<ModelRef, 'provider' | 'model'>
  to: Pick<ModelRef, 'provider' | 'model'>
  /** The task as the agent first got it. */
  task: string
  events: readonly HandoffEvent[]
  diff: { files: ReadonlyArray<{ path: string }>; patch: string }
  /** What the owner wants now (the follow-up or plan-revision prompt with their new messages). */
  next: string
  skipMessageIds?: ReadonlySet<string>
}

/**
 * The first prompt of a new session when the owner moves a task to another provider: there is no shared session, so
 * the new agent gets the task, the conversation so far, the worktree's changes and then the owner's new instructions.
 * Built only from what Joy recorded; no model writes the summary.
 */
export function switchHandoffPrompt(input: SwitchHandoffInput): string {
  const turns = conversationTurns(input.events, input.skipMessageIds)
  const patch =
    input.diff.patch.length > MAX_PATCH_CHARS
      ? `${input.diff.patch.slice(0, MAX_PATCH_CHARS)}\n… (diff truncated)`
      : input.diff.patch
  return [
    `The owner moved this task from ${input.from.provider} (${input.from.model}) to you (${input.to.provider}, ${input.to.model}). You do not share its session, so this is what happened so far. Continue in this same worktree; do not start over.`,
    '',
    `Task:\n${input.task}`,
    '',
    turns.length ? `Conversation so far (oldest first):\n${formatTurns(turns)}` : 'No earlier conversation.',
    '',
    input.diff.files.length
      ? `Changes in the worktree so far (unified diff against the starting commit; files: ${input.diff.files.map((file) => file.path).join(', ')}):\n${patch}`
      : 'No files have been changed yet.',
    '',
    '---',
    '',
    input.next,
  ].join('\n')
}
