import { describe, expect, it } from 'vitest'
import { conversationTurns, formatTurns, switchHandoffPrompt } from './handoff.js'
import type { HandoffEvent } from './handoff.js'

const agent = (role: string, round: number, event: unknown): HandoffEvent => ({
  type: 'agent',
  payload: { role, round, event },
})

const events: HandoffEvent[] = [
  { type: 'started', payload: {} },
  agent('implementer', 1, { type: 'thinking', text: 'hmm' }),
  agent('implementer', 1, { type: 'tool_call', id: 'a', name: 'Bash', input: { command: 'ls' } }),
  agent('implementer', 1, { type: 'message', text: 'Added ' }),
  agent('implementer', 1, { type: 'message', text: 'the parser.' }),
  agent('implementer', 1, { type: 'done', sessionId: 's', isError: false }),
  agent('reviewer', 1, { type: 'done', sessionId: 'r', finalMessage: '{"approve":false}', isError: false }),
  {
    type: 'review',
    payload: {
      round: 1,
      target: 'change',
      verdict: {
        approve: false,
        summary: 'Missing tests',
        findings: [{ severity: 'major', file: 'src/parse.ts', message: 'No test for empty input' }],
      },
    },
  },
  agent('implementer', 2, { type: 'done', sessionId: 's', finalMessage: 'Added the test.', isError: false }),
  { type: 'result', payload: { status: 'succeeded', approved: true } },
  { type: 'user.message', payload: { id: 'm1', text: 'Also handle tabs', delivery: 'follow_up' } },
  agent('implementer', 1, { type: 'done', sessionId: 's', finalMessage: 'Tabs work now.', isError: false }),
  { type: 'result', payload: { status: 'failed', reason: 'The implementer made no changes' } },
  { type: 'user.message', payload: { id: 'm2', text: 'Switch to Codex and finish', delivery: 'follow_up' } },
]

describe('conversationTurns', () => {
  it('keeps what was said, in order, and leaves out tools, thinking and the reviewer JSON', () => {
    expect(conversationTurns(events, new Set(['m2']))).toEqual([
      { speaker: 'implementer', text: 'Added the parser.' },
      {
        speaker: 'reviewer',
        text: 'Changes requested: Missing tests\n- [major] src/parse.ts No test for empty input',
      },
      { speaker: 'implementer', text: 'Added the test.' },
      { speaker: 'owner', text: 'Also handle tabs' },
      { speaker: 'implementer', text: 'Tabs work now.' },
      { speaker: 'joy', text: 'The run ended (failed): The implementer made no changes' },
    ])
  })

  it('includes plans and the owner approving them, and ignores malformed events', () => {
    const turns = conversationTurns([
      { type: 'plan.awaiting_approval', payload: { plan: '1. Do it' } },
      { type: 'plan.approved', payload: { note: 'go' } },
      { type: 'agent', payload: null },
      { type: 'user.message', payload: { text: 42 } },
      agent('judge', 1, { type: 'done', finalMessage: 'x' }),
    ])
    expect(turns).toEqual([
      { speaker: 'implementer', text: "Plan written for the owner's approval:\n1. Do it" },
      { speaker: 'joy', text: 'The owner approved the plan: go' },
    ])
  })

  it('cuts a very long turn', () => {
    const [turn] = conversationTurns([{ type: 'user.message', payload: { text: 'x'.repeat(5_000) } }])
    expect(turn?.text.length).toBeLessThan(2_100)
    expect(turn?.text.endsWith('… (cut)')).toBe(true)
  })
})

describe('formatTurns', () => {
  it('keeps the newest turns that fit and says how many were left out', () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ speaker: 'owner' as const, text: `message ${i}` }))
    const text = formatTurns(turns, 60)
    expect(text.startsWith('(7 earlier entries left out)')).toBe(true)
    expect(text).toContain('Owner: message 9')
    expect(text).not.toContain('message 6')
  })
})

describe('switchHandoffPrompt', () => {
  it('gives the new agent the task, the conversation, the changes and then the new instructions', () => {
    const prompt = switchHandoffPrompt({
      from: { provider: 'claude-cli', model: 'opus' },
      to: { provider: 'codex-cli', model: 'gpt-6' },
      task: 'Write a parser',
      events,
      diff: { files: [{ path: 'src/parse.ts' }], patch: '+export function parse() {}' },
      next: 'The owner has follow-up instructions…\nSwitch to Codex and finish',
      skipMessageIds: new Set(['m2']),
    })
    expect(prompt).toContain('from claude-cli (opus) to you (codex-cli, gpt-6)')
    expect(prompt).toContain('Task:\nWrite a parser')
    expect(prompt).toContain('Owner: Also handle tabs')
    expect(prompt).toContain('Previous agent: Tabs work now.')
    expect(prompt).toContain('files: src/parse.ts')
    expect(prompt).toContain('+export function parse() {}')
    expect(prompt.trimEnd().endsWith('Switch to Codex and finish')).toBe(true)
    // The new message is in the instructions only, not twice.
    expect(prompt.match(/Switch to Codex and finish/g)).toHaveLength(1)
  })

  it('says so when nothing happened yet and truncates a long diff', () => {
    const empty = switchHandoffPrompt({
      from: { provider: 'codex-cli', model: 'gpt-6' },
      to: { provider: 'claude-cli', model: 'opus' },
      task: 't',
      events: [],
      diff: { files: [], patch: '' },
      next: 'go',
    })
    expect(empty).toContain('No earlier conversation.')
    expect(empty).toContain('No files have been changed yet.')
    const long = switchHandoffPrompt({
      from: { provider: 'codex-cli', model: 'gpt-6' },
      to: { provider: 'claude-cli', model: 'opus' },
      task: 't',
      events: [],
      diff: { files: [{ path: 'a' }], patch: 'x'.repeat(50_000) },
      next: 'go',
    })
    expect(long).toContain('… (diff truncated)')
    expect(long.length).toBeLessThan(21_000)
  })
})
