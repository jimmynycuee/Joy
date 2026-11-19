import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskDetails, TaskEvent } from '../types.js'
import { DiscardButton, PublishPanel } from './task-panels.js'

const result = (files: unknown[]): TaskEvent => ({
  taskId: 't1',
  seq: 1,
  type: 'result',
  payload: { type: 'result', status: 'succeeded', diff: { files, patch: '' } },
  ts: '2026-11-19T08:00:00.000Z',
})
const details = (events: TaskEvent[]) =>
  ({
    task: { id: 't1', status: 'done' },
    repo: { id: 'r1', defaultBranch: 'main' },
    events,
  }) as unknown as TaskDetails
const html = (element: React.ReactElement) => renderToStaticMarkup(element)
const noop = () => {}

describe('a finished task that changed no files', () => {
  it('offers to clear the work copy instead of discarding changes', () => {
    expect(html(<DiscardButton details={details([result([])])} onChanged={noop} />)).toContain('清除工作副本')
    const changed = details([result([{ path: 'math.js', status: 'modified', additions: 1, deletions: 1 }])])
    expect(html(<DiscardButton details={changed} onChanged={noop} />)).toContain('丟掉這些變更')
  })

  it('does not ask for a GitHub repository to publish nothing', () => {
    expect(html(<PublishPanel details={details([result([])])} onChanged={noop} />)).toBe('')
    const changed = details([result([{ path: 'math.js', status: 'modified', additions: 1, deletions: 1 }])])
    expect(html(<PublishPanel details={changed} onChanged={noop} />)).toContain('GitHub repo 網址')
  })
})
