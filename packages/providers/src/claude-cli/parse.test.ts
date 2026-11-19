import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { FIXTURE_WORKDIR, readFixture } from '../../test-support/fixtures.js'
import { ClaudeStreamParser } from './parse.js'

function parseFixture(name: string): AgentEvent[] {
  const parser = new ClaudeStreamParser({ cwd: FIXTURE_WORKDIR })
  return readFixture('claude', name).flatMap((line) => parser.push(line))
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

describe.each(['edit', 'mcp-approval', 'resume-1', 'resume-2'])('contract: claude/%s', (name) => {
  const events = parseFixture(name)

  it('starts with session_started and ends with exactly one done', () => {
    expect(events[0]?.type).toBe('session_started')
    expect(of(events, 'done')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('reports the same session id at start and end', () => {
    const start = of(events, 'session_started')[0]
    const done = of(events, 'done')[0]
    expect(start?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(done?.sessionId).toBe(start?.sessionId)
  })

  it('pairs every tool_result with an earlier tool_call', () => {
    const calls = new Set(of(events, 'tool_call').map((e) => e.id))
    for (const r of of(events, 'tool_result')) expect(calls.has(r.id)).toBe(true)
  })

  it('reports usage and quota', () => {
    expect(of(events, 'usage')[0]?.costUsd).toBeGreaterThan(0)
    expect(of(events, 'usage')[0]?.costSource).toBe('cli')
    const quota = of(events, 'quota')[0]
    expect(quota?.status).toBe('allowed')
    expect(quota?.windows.map((w) => w.name)).toEqual(expect.arrayContaining(['five_hour', 'seven_day']))
  })

  it('drops token-level stream events', () => {
    expect(
      events.some((e) => e.type === 'raw' && (e.payload as { type?: string }).type === 'stream_event'),
    ).toBe(false)
  })
})

describe('contract: claude/edit', () => {
  const events = parseFixture('edit')

  it('reports the edited file relative to the worktree', () => {
    expect(of(events, 'file_change')).toEqual([{ type: 'file_change', path: 'math.js', kind: 'modify' }])
  })

  it('succeeds with a final message', () => {
    const done = of(events, 'done')[0]
    expect(done?.isError).toBe(false)
    expect(done?.finalMessage).toMatch(/math\.js/)
  })
})

describe('contract: claude/mcp-approval', () => {
  const events = parseFixture('mcp-approval')

  it('calls the injected MCP tool and receives its answer', () => {
    const call = of(events, 'tool_call').find((e) => e.name === 'mcp__joy__ask_peer')
    expect(call).toBeDefined()
    const result = of(events, 'tool_result').find((e) => e.id === call?.id)
    expect(JSON.stringify(result?.output)).toContain('PEER SAYS: 4')
  })

  it('surfaces the denied rm as an error result', () => {
    const rm = of(events, 'tool_call').find((e) => JSON.stringify(e.input).includes('rm math.js'))
    const result = of(events, 'tool_result').find((e) => e.id === rm?.id)
    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.output)).toContain('Joy policy')
  })
})

describe('contract: claude/resume', () => {
  it('keeps the session id across resume', () => {
    const first = of(parseFixture('resume-1'), 'done')[0]
    const second = of(parseFixture('resume-2'), 'done')[0]
    expect(second?.sessionId).toBe(first?.sessionId)
    expect(second?.finalMessage).toContain('PELICAN')
  })
})

/** A parser that has already seen `system/init`. */
function started(cwd?: string): ClaudeStreamParser {
  const parser = new ClaudeStreamParser(cwd ? { cwd } : {})
  parser.push({ type: 'system', subtype: 'init', session_id: 's' })
  return parser
}

describe('ClaudeStreamParser edge cases', () => {
  it('holds events that arrive before init until session_started', () => {
    const parser = new ClaudeStreamParser()
    expect(parser.push({ type: 'active_goal', value: null })).toEqual([])
    const events = parser.push({ type: 'system', subtype: 'init', session_id: 's' })
    expect(events.map((e) => e.type)).toEqual(['session_started', 'raw'])
  })

  it('turns unknown event types into raw events instead of throwing', () => {
    const parser = new ClaudeStreamParser()
    parser.push({ type: 'system', subtype: 'init', session_id: 's' })
    expect(parser.push({ type: 'brand_new_event', x: 1 })).toEqual([
      { type: 'raw', source: 'claude-cli', payload: { type: 'brand_new_event', x: 1 } },
    ])
    expect(parser.push('not an object')).toEqual([
      { type: 'raw', source: 'claude-cli', payload: 'not an object' },
    ])
  })

  it('maps permission_denied', () => {
    const parser = started()
    expect(
      parser.push({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        decision_reason: 'nope',
      }),
    ).toEqual([{ type: 'permission_denied', toolName: 'Bash', reason: 'nope' }])
  })

  it('does not report a file change when the edit failed', () => {
    const parser = started('/w')
    parser.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.ts' } }] },
    })
    const events = parser.push({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'old_string not found' },
        ],
      },
    })
    expect(events.map((e) => e.type)).toEqual(['tool_result'])
  })

  it('reports a failing result as error + done(isError) and passes structured output through', () => {
    const parser = new ClaudeStreamParser()
    const failed = parser.push({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      session_id: 's',
    })
    expect(failed.map((e) => e.type)).toEqual(['usage', 'error', 'done'])
    expect(failed.at(-1)).toMatchObject({ type: 'done', isError: true, sessionId: 's' })

    const ok = new ClaudeStreamParser().push({
      type: 'result',
      is_error: false,
      session_id: 's',
      result: '{"approve":true}',
      structured_output: { approve: true },
    })
    expect(ok.at(-1)).toEqual({
      type: 'done',
      sessionId: 's',
      isError: false,
      finalMessage: '{"approve":true}',
      structured: { approve: true },
    })
  })

  it('maps a limited quota', () => {
    const [q] = started().push({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 100,
        unifiedWindows: { five_hour: { utilization: 1, resetsAt: 50 } },
      },
    })
    expect(q).toEqual({
      type: 'quota',
      status: 'limited',
      resetsAt: 100,
      windows: [{ name: 'five_hour', utilization: 1, resetsAt: 50 }],
    })
  })

  it('finish() emits error + failing done only when no result arrived, and ignores later lines', () => {
    const parser = new ClaudeStreamParser()
    parser.push({ type: 'system', subtype: 'init', session_id: 's1' })
    expect(parser.finish('crashed')).toEqual([
      { type: 'error', message: 'crashed', recoverable: false },
      { type: 'done', sessionId: 's1', isError: true },
    ])
    expect(parser.finish('again')).toEqual([])
    expect(
      parser.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } }),
    ).toEqual([])
  })

  it('counts cached tokens in the input tokens, as the other backends do', () => {
    const parser = new ClaudeStreamParser({ cwd: FIXTURE_WORKDIR })
    const events = parser.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      session_id: 's',
      total_cost_usd: 0.005,
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 11897,
        cache_read_input_tokens: 228382,
        output_tokens: 693,
      },
    })
    expect(of(events, 'usage')).toEqual([
      {
        type: 'usage',
        inputTokens: 12 + 11897 + 228382,
        outputTokens: 693,
        cachedInputTokens: 228382,
        costUsd: 0.005,
        costSource: 'cli',
      },
    ])
  })

  // claude-cli 2.1.319 (measured with haiku): each `result` in one stream-json process carries only its own turn's
  // `usage`, while `total_cost_usd` is the process total so far.
  it('adds up every turn of a multi-turn run but takes the last cost as the total', () => {
    const parser = new ClaudeStreamParser({ cwd: FIXTURE_WORKDIR, multiTurn: true })
    const turn = (usage: Record<string, number>, cost: number) =>
      parser.push({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        session_id: 's',
        total_cost_usd: cost,
        usage,
      })
    turn(
      { input_tokens: 2, cache_creation_input_tokens: 71605, cache_read_input_tokens: 0, output_tokens: 305 },
      0.0145,
    )
    turn(
      {
        input_tokens: 2,
        cache_creation_input_tokens: 2193,
        cache_read_input_tokens: 69760,
        output_tokens: 288,
      },
      0.0158,
    )
    expect(of(parser.finish('exited', { stopped: false }), 'usage')).toEqual([
      {
        type: 'usage',
        inputTokens: 2 + 71605 + 2 + 2193 + 69760,
        outputTokens: 305 + 288,
        cachedInputTokens: 69760,
        costUsd: 0.0158,
        costSource: 'cli',
      },
    ])
  })

  it('reports no cost source when the CLI gave no cost', () => {
    const parser = new ClaudeStreamParser({ cwd: FIXTURE_WORKDIR })
    const events = parser.push({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: { output_tokens: 3 },
    })
    expect(of(events, 'usage')).toEqual([{ type: 'usage', outputTokens: 3 }])
  })
})

describe('file paths', () => {
  it('reports a path relative to the workspace when the CLI names it through the real path of a linked folder', () => {
    // On macOS the temp folder /var/... is a link to /private/var/...; Claude Code 2.1.319 reports the real path.
    const real = realpathSync.native(mkdtempSync(join(tmpdir(), 'joy-parse-real-')))
    const link = `${real}-link`
    // A junction needs no special rights on Windows.
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const parser = new ClaudeStreamParser({ cwd: link })
      parser.push({ type: 'system', subtype: 'init', session_id: '00000000-0000-0000-0000-000000000001' })
      parser.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: join(real, 'src', 'a.js') } },
          ],
        },
      })
      const events = parser.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      })
      expect(of(events, 'file_change')).toEqual([
        { type: 'file_change', path: join('src', 'a.js'), kind: 'modify' },
      ])
    } finally {
      rmSync(link, { force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })
})
