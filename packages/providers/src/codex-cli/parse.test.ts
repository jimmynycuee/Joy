import type { AgentEvent } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { FIXTURE_WORKDIR, readFixture } from '../../test-support/fixtures.js'
import { CodexStreamParser } from './parse.js'

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

function parse(name: string, structured = false): AgentEvent[] {
  const parser = new CodexStreamParser({ cwd: FIXTURE_WORKDIR, structured })
  return readFixture('codex', name).flatMap((l) => parser.push(l))
}

describe('contract: codex/synthetic-edit (from SDK types, not recorded)', () => {
  const events = parse('synthetic-edit')

  it('starts with session_started and ends with exactly one successful done', () => {
    expect(events[0]).toEqual({ type: 'session_started', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' })
    expect(of(events, 'done')).toEqual([
      {
        type: 'done',
        sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
        isError: false,
        finalMessage: 'Fixed add() in math.js: it now returns a + b.',
      },
    ])
    expect(events.at(-1)?.type).toBe('done')
  })

  it('announces each tool call once, before its result, even without item.started', () => {
    const calls = of(events, 'tool_call')
    expect(calls.map((c) => c.name)).toEqual(['shell', 'mcp__joy__ask_peer', 'shell'])
    for (const r of of(events, 'tool_result')) {
      expect(events.findIndex((e) => e.type === 'tool_call' && e.id === r.id)).toBeLessThan(events.indexOf(r))
    }
  })

  it('marks a failed command as an error result', () => {
    const rm = of(events, 'tool_result').find((r) => r.id === 'item_5')
    expect(rm).toMatchObject({ isError: true, output: { exitCode: 1 } })
  })

  it('reports file changes relative to the worktree and plan progress as status', () => {
    expect(of(events, 'file_change')).toEqual([{ type: 'file_change', path: 'math.js', kind: 'modify' }])
    expect(of(events, 'status').map((s) => s.text)).toEqual(['Plan 1/2: Fix add()', 'Plan 2/2'])
  })

  it('reports token usage', () => {
    expect(of(events, 'usage')[0]).toEqual({
      type: 'usage',
      inputTokens: 24763,
      outputTokens: 122,
      cachedInputTokens: 24448,
    })
  })
})

// Recorded with codex-cli 0.166.0 (gpt-6-luna, low effort) on a logged-in Mac. The owner's config.toml had an obsolete
// key, so every run starts with the same config warning twice; it must surface once, as a status.
describe('contract: codex/edit (recorded)', () => {
  const events = parse('edit')

  it('starts with session_started, reports the config warning once, and ends with one successful done', () => {
    expect(events[0]).toEqual({ type: 'session_started', sessionId: '01a1f328-1dc2-7ad2-a144-624b85d63e1a' })
    const warnings = of(events, 'status').filter((s) => s.text.includes('unrecognized configuration setting'))
    expect(warnings).toHaveLength(1)
    expect(of(events, 'error')).toEqual([])
    const done = of(events, 'done')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ isError: false, sessionId: '01a1f328-1dc2-7ad2-a144-624b85d63e1a' })
    expect(done[0]?.finalMessage).toContain('a + b')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('pairs every shell command with its result; this edit went through the shell, not a file_change item', () => {
    const calls = of(events, 'tool_call')
    expect(calls.map((c) => c.name)).toEqual(['shell', 'shell', 'shell'])
    const results = of(events, 'tool_result')
    expect(results.map((r) => r.id)).toEqual(calls.map((c) => c.id))
    for (const r of results) {
      expect(r.isError).toBe(false)
      expect(events.findIndex((e) => e.type === 'tool_call' && e.id === r.id)).toBeLessThan(events.indexOf(r))
    }
    // Joy reads the worktree diff, so an edit made with `sed` still counts; there is no event to rely on.
    expect(of(events, 'file_change')).toEqual([])
  })

  it('reports token usage', () => {
    expect(of(events, 'usage')).toEqual([
      { type: 'usage', inputTokens: 151633, outputTokens: 279, cachedInputTokens: 117632 },
    ])
  })
})

describe('contract: codex/mcp (recorded)', () => {
  const events = parse('mcp')

  it('calls the injected MCP server and gets its answer back', () => {
    const calls = of(events, 'tool_call')
    expect(calls.map((c) => c.name)).toEqual(['mcp__joy__ask_peer', 'shell', 'shell'])
    const peer = calls[0]
    expect(peer?.input).toEqual({ question: 'what is 2+2' })
    const answer = of(events, 'tool_result').find((r) => r.id === peer?.id)
    expect(answer?.isError).toBe(false)
    expect(JSON.stringify(answer?.output)).toContain('PEER SAYS: 4')
  })

  it('runs to one successful done (exec has no interactive approval: the sandbox allowed `rm` in the worktree)', () => {
    expect(of(events, 'done')).toEqual([expect.objectContaining({ isError: false })])
    expect(of(events, 'tool_result').every((r) => !r.isError)).toBe(true)
  })
})

describe('contract: codex/resume (recorded)', () => {
  it('keeps the same thread id across `codex exec resume` and remembers the earlier turn', () => {
    const first = parse('resume-1')
    const second = parse('resume-2')
    const id = '01a1f329-075e-7630-a0e1-52789a5ef68b'
    expect(first[0]).toEqual({ type: 'session_started', sessionId: id })
    expect(second[0]).toEqual({ type: 'session_started', sessionId: id })
    expect(of(first, 'done')[0]).toMatchObject({ isError: false, finalMessage: 'OK' })
    expect(of(second, 'done')[0]).toMatchObject({ isError: false, sessionId: id, finalMessage: 'PELICAN' })
  })
})

describe('contract: codex/network-error (recorded)', () => {
  const events = parse('network-error')

  it('treats reconnect notices as recoverable and has not finished', () => {
    expect(events[0]?.type).toBe('session_started')
    const errors = of(events, 'error')
    expect(errors.length).toBeGreaterThan(3)
    expect(errors.every((e) => e.recoverable)).toBe(true)
    expect(of(events, 'done')).toHaveLength(0)
  })
})

describe('CodexStreamParser', () => {
  it('turns turn.failed into a failing done', () => {
    const p = new CodexStreamParser()
    p.push({ type: 'thread.started', thread_id: 't' })
    expect(p.push({ type: 'turn.failed', error: { message: 'usage limit reached' } })).toEqual([
      { type: 'error', message: 'usage limit reached', recoverable: false },
      { type: 'done', sessionId: 't', isError: true },
    ])
    expect(p.finish('late')).toEqual([])
  })

  it('parses the final message as structured output when asked', () => {
    const p = new CodexStreamParser({ structured: true })
    p.push({ type: 'thread.started', thread_id: 't' })
    p.push({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '{"approve":false}' } })
    expect(p.push({ type: 'turn.completed', usage: {} }).at(-1)).toMatchObject({
      structured: { approve: false },
    })
  })

  it('keeps unknown events and items as raw', () => {
    const p = new CodexStreamParser()
    expect(p.push({ type: 'new.event' })).toEqual([
      { type: 'raw', source: 'codex-cli', payload: { type: 'new.event' } },
    ])
    expect(p.push({ type: 'item.completed', item: { id: 'x', type: 'hologram' } })).toEqual([
      { type: 'raw', source: 'codex-cli', payload: { id: 'x', type: 'hologram' } },
    ])
  })
})
