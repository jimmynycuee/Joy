import { describe, expect, it } from 'vitest'
import {
  diffFrom,
  failureMessage,
  runProgress,
  taskBranchInfo,
  tasksNeedingAttention,
  worktreeRemoved,
} from './task-info.js'
import { buildTimeline, planReviewView } from './timeline.js'
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
  it('joins a streamed reply into one message and one line of thinking', () => {
    const entries = buildTimeline([
      agent('implementer', { type: 'thinking', text: '先看' }),
      agent('implementer', { type: 'thinking', text: '專案' }),
      agent('implementer', { type: 'message', text: '我會' }),
      agent('implementer', { type: 'message', text: '先查看' }),
      agent('implementer', { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'ls' } }),
      agent('implementer', { type: 'message', text: '好了。' }),
      agent('reviewer', { type: 'message', text: '看起來沒問題' }),
    ])
    expect(entries.map((entry) => [entry.kind, 'text' in entry ? entry.text : undefined])).toEqual([
      ['noise', '先看專案'],
      ['message', '我會先查看'],
      ['tool', undefined],
      ['message', '好了。'],
      ['message', '看起來沒問題'],
    ])
  })

  it('says the same-model warning in Chinese', () => {
    const [entry] = buildTimeline([
      event('warning', {
        message: 'Implementer and reviewer use the same model: this is not a cross-model review.',
      }),
    ])
    expect(entry && 'text' in entry ? entry.text : undefined).toBe(
      '實作和審查用同一個模型，這次不是跨模型審查。',
    )
  })

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

describe('buildTimeline: thread messages, plans, checks and checkpoints', () => {
  const stamp = '2026-11-08T10:00:00.000Z'
  const e = (type: string, payload: unknown) => event(type, payload, stamp)

  it('renders owner messages as user entries with their delivery state', () => {
    const entries = buildTimeline([
      e('user.message', { id: 'm1', text: 'also add a test', provenance: 'user', delivery: 'queued' }),
      e('user.message', { id: 'm2', text: 'and docs', provenance: 'user', delivery: 'queued' }),
      e('user.message.delivered', { ids: ['m1'], via: 'next_turn' }),
      e('user.message', { id: 'm3', text: 'next', provenance: 'user', delivery: 'follow_up' }),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'user', 'noise', 'user'])
    expect(
      entries.filter((entry) => entry.kind === 'user').map((entry) => entry.kind === 'user' && entry.state),
    ).toEqual(['delivered', 'queued', 'sent'])
  })

  it('keeps the files of an owner message, dropping malformed ones', () => {
    const entries = buildTimeline([
      e('user.message', {
        id: 'm1',
        text: '',
        delivery: 'follow_up',
        attachments: [{ id: 'a1', name: 'shot.png', mediaType: 'image/png', size: 10 }, { name: 'no id' }, 3],
      }),
      e('user.message', { id: 'm2', text: 'plain', delivery: 'follow_up' }),
    ])
    expect(entries[0]).toMatchObject({
      kind: 'user',
      text: '',
      attachments: [{ id: 'a1', name: 'shot.png', mediaType: 'image/png', size: 10 }],
    })
    expect(entries[1]).toMatchObject({ kind: 'user', attachments: [] })
  })

  it('shows an interrupted step and the message it carried', () => {
    const entries = buildTimeline([
      e('user.message', { id: 'm1', text: 'use BigInt', provenance: 'user', delivery: 'interrupt' }),
      e('run.interrupted', { reason: 'owner_message' }),
      e('user.message.delivered', { ids: ['m1'], via: 'interrupt' }),
    ])
    expect(entries[0]).toMatchObject({ kind: 'user', state: 'delivered' })
    expect(entries[1]).toMatchObject({
      kind: 'step',
      text: '已中斷目前這一步，帶著你的訊息繼續',
      tone: 'muted',
    })
    expect(entries[2]).toMatchObject({ kind: 'noise', text: '已打斷 agent，訊息已交給它' })
    const pending = buildTimeline([
      e('user.message', { id: 'm1', text: 'use BigInt', provenance: 'user', delivery: 'interrupt' }),
    ])
    expect(pending[0]).toMatchObject({ kind: 'user', state: 'interrupting' })
  })

  it('shows a steered message as sent to the working agent, and a steer that fell back to the queue', () => {
    const entries = buildTimeline([
      e('steer.available', { available: true }),
      e('user.message', { id: 'm1', text: 'use BigInt', provenance: 'user', delivery: 'steer' }),
      e('user.message.delivered', { ids: ['m1'], via: 'steer' }),
      e('user.message', { id: 'm2', text: 'and docs', provenance: 'user', delivery: 'steer' }),
      e('user.message.requeued', { ids: ['m2'], reason: 'steer_failed' }),
      e('steer.available', { available: false }),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['noise', 'user', 'noise', 'user', 'noise', 'noise'])
    expect(entries[1]).toMatchObject({ kind: 'user', state: 'delivered' })
    expect(entries[2]).toMatchObject({ text: '訊息已交給 agent，它會邊做邊參考' })
    expect(entries[3]).toMatchObject({ kind: 'user', state: 'queued' })
    expect(entries[4]).toMatchObject({ text: '沒能即時交給 agent，訊息改為等它下一次動手' })
    expect(entries[0]).toMatchObject({ text: 'agent 可以邊做邊收你的訊息' })
    const late = buildTimeline([
      e('user.message', { id: 'm3', text: 'slow', provenance: 'user', delivery: 'steer' }),
      e('user.message.requeued', { ids: ['m3'], reason: 'steer_failed' }),
      e('user.message.delivered', { ids: ['m3'], via: 'steer', late: true }),
    ])
    expect(late[0]).toMatchObject({ kind: 'user', state: 'delivered' })
    expect(late[2]).toMatchObject({ text: 'agent 稍晚才收到訊息，已從排隊中移除，不會再送一次' })
  })

  it('explains a message held by a limit and keeps it pending in the thread', () => {
    const entries = buildTimeline([
      e('user.message', { id: 'm1', text: 'also docs', provenance: 'user', delivery: 'queued' }),
      e('user.message.held', { ids: ['m1'], reason: 'Stopped: the task ran longer than 30 minutes' }),
    ])
    expect(entries[0]).toMatchObject({ kind: 'user', state: 'held' })
    expect(entries[1]).toMatchObject({
      text: '任務因上限停下，訊息先排著；按「繼續」或再送訊息才會帶給 agent',
    })
  })

  it('shows plan events, folding past plans but not the one with its own card', () => {
    const events = [
      e('plan.awaiting_approval', { plan: '# v1' }),
      e('user.message', { id: 'm1', text: 'smaller', provenance: 'user', delivery: 'replan' }),
      e('plan.awaiting_approval', { plan: '# v2' }),
    ]
    const withCard = buildTimeline(events, undefined, { pendingPlan: true })
    expect(withCard[0]).toMatchObject({ kind: 'step', text: '計畫寫好了，等你核准', detail: '# v1' })
    expect(withCard[2]?.kind === 'step' && withCard[2].detail).toBeUndefined()
    const withoutCard = buildTimeline(events)
    expect(withoutCard[2]?.kind === 'step' && withoutCard[2].detail).toBe('# v2')

    const decided = buildTimeline([e('plan.approved', {}), e('plan.rejected', { note: 'too big' })])
    expect(decided[0]).toMatchObject({ kind: 'step', tone: 'ok', text: '你核准了計畫，開始實作' })
    expect(decided[1]).toMatchObject({ kind: 'step', tone: 'bad', text: '你取消了計畫：too big' })
  })

  it('turns checks into a card and skipped checks into a muted step', () => {
    const entries = buildTimeline([
      e('checks', {
        type: 'checks',
        round: 2,
        ok: false,
        exitCode: 1,
        outputTail: 'FAIL x',
        durationMs: 4200,
      }),
      e('checks.skipped', { round: 1, reason: 'The owner did not approve running the checks (denied)' }),
    ])
    expect(entries[0]).toMatchObject({
      kind: 'checks',
      round: 2,
      ok: false,
      exitCode: 1,
      outputTail: 'FAIL x',
      durationMs: 4200,
      timedOut: false,
    })
    expect(entries[1]).toMatchObject({ kind: 'step', tone: 'muted' })
  })

  it('keeps checkpoint creation quiet and shows a restore as a step', () => {
    const entries = buildTimeline([
      e('checkpoint.created', { n: 2, label: 'implementer turn' }),
      e('checkpoint.restored', { n: 1, savedAs: 2, discardedCommits: 2, diff: { files: [], patch: '' } }),
      e('task.updated', { archived: true }),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['noise', 'step', 'noise'])
    expect(entries[1]).toMatchObject({ text: '已還原到檢查點 1，丟掉 2 個 commit', tone: 'ok' })
  })
})

describe('diffFrom with restored checkpoints', () => {
  const diff = (path: string) => ({
    files: [{ path, status: 'modified', additions: 1, deletions: 0 }],
    patch: '',
  })
  it('prefers the diff a restore left behind over the older result', () => {
    const events = [
      event('result', { status: 'succeeded', diff: diff('old.ts') }),
      event('checkpoint.restored', { n: 1, diff: diff('restored.ts') }),
    ]
    expect(diffFrom(events)?.files[0]?.path).toBe('restored.ts')
    expect(worktreeRemoved(events)).toBe(false)
    expect(worktreeRemoved([...events, event('worktree.removed', { attemptIds: ['a'] })])).toBe(true)
  })
})

describe('planReviewView', () => {
  it('turns a plan review verdict into a card model', () => {
    expect(
      planReviewView({
        approve: true,
        summary: 'Looks fine',
        findings: [{ severity: 'nit', message: 'typo' }],
      }),
    ).toMatchObject({ target: 'plan', approve: true, summary: 'Looks fine', findings: [{ severity: 'nit' }] })
    expect(planReviewView(undefined)).toBeNull()
  })
})
