import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../timeline.js'
import type { TaskEvent } from '../types.js'
import { ReviewCard, TimelineView } from './Thread.js'

let seq = 0
const event = (type: string, payload: unknown): TaskEvent => ({
  taskId: 't1',
  seq: ++seq,
  type,
  payload,
  ts: new Date(Date.UTC(2026, 10, 8, 10, 0, seq)).toISOString(),
})
const agent = (role: string, inner: unknown) => event('agent', { role, event: inner })
const html = (element: React.ReactElement) => renderToStaticMarkup(element)

describe('TimelineView', () => {
  it('does not draw an output block for a tool call that printed nothing', () => {
    const entries = buildTimeline([
      agent('implementer', { type: 'tool_call', id: 'a', name: 'Bash', input: { command: 'true' } }),
      agent('implementer', { type: 'tool_result', id: 'a', output: '  \n ', isError: false }),
      agent('implementer', { type: 'tool_call', id: 'b', name: 'Bash', input: { command: 'echo hi' } }),
      agent('implementer', { type: 'tool_result', id: 'b', output: 'hi', isError: false }),
    ])
    const markup = html(<TimelineView entries={entries} />)
    expect(markup.match(/class="tool-output"/g)).toHaveLength(1)
    expect(markup).toContain('$ true')
  })

  it('shows a phase as a divider, not a pill', () => {
    const entries = buildTimeline([event('phase', { phase: 'reviewing', role: 'reviewer' })])
    const markup = html(<TimelineView entries={entries} />)
    expect(markup).toContain('<span class="phase-divider">審查中</span>')
    expect(markup).not.toContain('phase-label')
  })

  it('folds a finished task into one closed 過程 line with the last message and review beside it', () => {
    const entries = buildTimeline([
      event('started', {}),
      agent('implementer', { type: 'tool_call', id: 'a', name: 'Bash', input: { command: 'pnpm test' } }),
      agent('implementer', { type: 'message', text: 'It is done.' }),
      event('review', {
        round: 1,
        target: 'change',
        verdict: { approve: true, summary: 'Fine', findings: [] },
      }),
    ])
    const markup = html(<TimelineView entries={entries} collapse="done" />)
    expect(markup).toContain('過程（1 輪審查 · 2 個步驟 · 3 秒）')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('pnpm test')
    expect(markup).toContain('It is done.')
    expect(markup).toContain('審查結果')
    // Running keeps everything open.
    const open = html(<TimelineView entries={entries} />)
    expect(open).toContain('pnpm test')
    expect(open).not.toContain('process-fold')
  })
})

describe('ReviewCard', () => {
  it('says the result with a small mark and word, and has no coloured modifier class', () => {
    const base = { target: 'change' as const, round: 2, summary: 'Needs a test', findings: [] }
    const changes = html(<ReviewCard entry={{ ...base, approve: false }} />)
    expect(changes).toContain('要求修改')
    expect(changes).toContain('程式變更審查 · 第 2 輪')
    expect(changes).not.toMatch(/review-(ok|changes)/)
    const passed = html(<ReviewCard entry={{ ...base, approve: true }} />)
    expect(passed).toContain('通過')
    expect(passed).not.toContain('要求修改')
  })
})
