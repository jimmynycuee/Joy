import { describe, expect, it } from 'vitest'
import { failureMessage, runProgress, taskBranchInfo, tasksNeedingAttention } from './task-info.js'
import { buildTimeline } from './timeline.js'
import type { Task, TaskEvent } from './types.js'

let seq = 0
const event = (type: string, payload: unknown, ts = '2026-11-08T10:00:00.000Z'): TaskEvent => ({
  taskId: 't1',
  seq: ++seq,
  type,
  payload,
  ts,
})
const agent = (role: string, inner: unknown) => event('agent', { role, event: inner })

describe('buildTimeline', () => {
  it('shows a tool call as its command and folds the matching result into it', () => {
    const entries = buildTimeline([
      agent('implementer', { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'pnpm test' } }),
      agent('implementer', { type: 'tool_result', id: 'c1', output: 'all green', isError: false }),
    ])
    expect(entries).toHaveLength(1)
    const [tool] = entries
    expect(tool).toMatchObject({ kind: 'tool', label: '$ pnpm test', isError: false })
    expect(tool?.kind === 'tool' && tool.output?.text).toBe('all green')
  })

  it('marks failed tool results and keeps unmatched results as noise', () => {
    const entries = buildTimeline([
      agent('implementer', { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'false' } }),
      agent('implementer', { type: 'tool_result', id: 'c1', output: 'boom', isError: true }),
      agent('implementer', { type: 'tool_result', id: 'orphan', output: 'x', isError: false }),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['tool', 'noise'])
    expect(entries[0]?.kind === 'tool' && entries[0].isError).toBe(true)
  })

  it('shows edits by path, relative to the worktree', () => {
    const [entry] = buildTimeline(
      [
        agent('implementer', {
          type: 'tool_call',
          id: 'c2',
          name: 'Edit',
          input: { file_path: '/wt/src/a.ts' },
        }),
      ],
      '/wt',
    )
    expect(entry).toMatchObject({ kind: 'tool', label: '編輯 src/a.ts' })
  })

  it('keeps messages as messages with their speaker, and thinking as noise', () => {
    const entries = buildTimeline([
      agent('reviewer', { type: 'message', text: '**LGTM**' }),
      agent('implementer', { type: 'thinking', text: 'hmm' }),
      agent('implementer', { type: 'done', sessionId: 's' }),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'noise', 'noise'])
    expect(entries[0]).toMatchObject({ text: '**LGTM**', role: '審查' })
  })

  it('structures a review with its findings', () => {
    const [entry] = buildTimeline([
      event('review', {
        type: 'review',
        round: 2,
        target: 'change',
        verdict: {
          approve: false,
          summary: 'Missing a test',
          findings: [
            { severity: 'major', file: 'src/a.ts', line: 7, message: 'No test' },
            { severity: 'weird', message: 'Odd severity' },
            { nope: true },
          ],
        },
      }),
    ])
    expect(entry).toMatchObject({
      kind: 'review',
      approve: false,
      round: 2,
      target: 'change',
      summary: 'Missing a test',
    })
    expect(entry?.kind === 'review' && entry.findings).toEqual([
      { severity: 'major', message: 'No test', file: 'src/a.ts', line: 7 },
      { severity: 'minor', message: 'Odd severity' },
    ])
  })

  it('hides auto-allowed policy actions but keeps notices, approvals and phases', () => {
    const entries = buildTimeline([
      event('policy.action', { kind: 'read_file', tier: 'auto' }),
      event('policy.action', { kind: 'local_commit', tier: 'notify' }),
      event('policy.action', { kind: 'send_mail', tier: 'approve' }),
      event('phase', { phase: 'implementing', round: 1 }),
      event('started', {}),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['noise', 'step', 'step', 'phase', 'step'])
    expect(entries[2]).toMatchObject({ tone: 'policy-approve' })
  })

  it('keeps one entry per unpaired event and the sequence numbers the page exposes', () => {
    const events = [event('started', {}), event('phase', { phase: 'x' }), event('error', { message: 'bad' })]
    const entries = buildTimeline(events)
    expect(entries.map((entry) => entry.seq)).toEqual(events.map((e) => e.seq))
    expect(entries[2]).toMatchObject({ kind: 'error', text: 'bad' })
  })
})

describe('runProgress', () => {
  it('counts implementing and fixing phases as rounds and reports the current role', () => {
    const progress = runProgress([
      event('started', {}, '2026-11-08T10:00:00.000Z'),
      event('phase', { phase: 'implementing', round: 1, role: 'implementer' }, '2026-11-08T10:00:05.000Z'),
      event('phase', { phase: 'reviewing', round: 1, role: 'reviewer' }, '2026-11-08T10:03:00.000Z'),
      event('phase', { phase: 'fixing', round: 2, role: 'implementer' }, '2026-11-08T10:04:00.000Z'),
      event('phase', { phase: 'reviewing', round: 2, role: 'reviewer' }, '2026-11-08T10:06:00.000Z'),
    ])
    expect(progress).toMatchObject({ phase: 'reviewing', role: '審查', round: 2 })
    expect(progress.startedAt).toBe(Date.parse('2026-11-08T10:00:00.000Z'))
  })

  it('copes with no events and with empty timestamps', () => {
    expect(runProgress([])).toEqual({ round: 0 })
    expect(runProgress([event('started', {}, '')]).startedAt).toBeUndefined()
  })
})

describe('taskBranchInfo', () => {
  it('uses the latest attempt that recorded a branch, not the default branch', () => {
    expect(
      taskBranchInfo([
        { id: 'a1', branch: 'joy/old', worktreePath: '/wt/old' },
        { id: 'a2', branch: 'joy/new', worktreePath: '/wt/new' },
        { id: 'a3' },
      ]),
    ).toEqual({ branch: 'joy/new', worktreePath: '/wt/new' })
    expect(taskBranchInfo([])).toEqual({})
    expect(taskBranchInfo([{ id: 'a1', branch: '' }])).toEqual({})
  })
})

describe('failureMessage', () => {
  it('prefers the latest error, then a failed result reason', () => {
    expect(
      failureMessage([
        event('error', { message: 'first' }),
        event('result', { status: 'failed', reason: 'Reviewer crashed' }),
      ]),
    ).toBe('Reviewer crashed')
    expect(failureMessage([event('result', { status: 'succeeded', reason: 'ignored' })])).toBeUndefined()
    expect(
      failureMessage([agent('implementer', { type: 'error', message: 'CLI exited', recoverable: false })]),
    ).toBe('CLI exited')
  })
})

describe('tasksNeedingAttention', () => {
  it('lists approvals first, then review comments, then running tasks', () => {
    const task = (id: string, status: string): Task => ({
      id,
      repoId: 'r',
      title: id,
      prompt: '',
      mode: 'single',
      status,
      createdAt: '',
    })
    expect(
      tasksNeedingAttention([
        task('a', 'done'),
        task('b', 'running'),
        task('c', 'review_ready'),
        task('d', 'awaiting_approval'),
        task('e', 'failed'),
      ]).map((t) => t.id),
    ).toEqual(['d', 'c', 'b'])
  })
})
