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
  it('normalizes WSL file-change paths relative to the Linux worktree', () => {
    const parser = new CodexStreamParser({ cwd: '/mnt/c/project', cwdStyle: 'posix' })
    expect(
      parser.push({
        type: 'item.completed',
        item: {
          id: 'file',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: '/mnt/c/project/src/index.ts', kind: 'update' }],
        },
      }),
    ).toEqual([{ type: 'file_change', path: 'src/index.ts', kind: 'modify' }])
  })

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
