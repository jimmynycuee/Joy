import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskDetails } from '../types.js'
import { Composer } from './Composer.js'
import { ThreadComposer } from './ThreadComposer.js'

function details(task: Partial<TaskDetails['task']> = {}, extra: Partial<TaskDetails> = {}): TaskDetails {
  return {
    task: {
      id: 't1',
      repoId: 'r1',
      title: 'Fix add()',
      prompt: 'Fix add()',
      mode: 'single',
      status: 'done',
      permissionMode: 'auto',
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'sonnet', effort: 'high' } },
      createdAt: '2026-11-15T00:00:00.000Z',
      ...task,
    },
    repo: null,
    attempts: [],
    reviews: [],
    events: [],
    ...extra,
  }
}

const html = (d: TaskDetails) =>
  renderToStaticMarkup(<ThreadComposer details={d} config={null} onChanged={() => {}} onError={() => {}} />)

describe('ThreadComposer', () => {
  it("shows the home page's menus, starting at the task's model, mode and permission mode", () => {
    const markup = html(details())
    expect(markup).toContain('aria-label="做法：單人"')
    expect(markup).toContain('aria-label="權限：自動"')
    expect(markup).toContain('aria-label="模型：Sonnet 5.5 · 高"')
  })

  it('starts at a change that waits for the run to end', () => {
    const markup = html(
      details({ status: 'running' }, { pendingSettings: { mode: 'review_loop', permissionMode: 'full' } }),
    )
    expect(markup).toContain('aria-label="做法：實作＋審查"')
    expect(markup).toContain('aria-label="權限：完整存取"')
  })

  it('locks the permission mode of a task from external content at 要求核准', () => {
    const markup = html(details({ provenance: 'external_content', permissionMode: 'full' }))
    expect(markup).toMatch(
      /aria-label="權限：要求核准"[^>]*disabled=""|disabled=""[^>]*aria-label="權限：要求核准"/,
    )
    expect(markup).toContain('外部內容的任務一律要求核准')
  })

  it('has no menus for a compete task', () => {
    const markup = html(details({ mode: 'compete' }))
    expect(markup).not.toContain('做法：')
    expect(markup).not.toContain('模型：')
  })
})

describe('Composer', () => {
  it('starts one line high', () => {
    const markup = renderToStaticMarkup(
      <Composer value="" onChange={() => {}} onSubmit={() => {}} textareaLabel="x" sendLabel="送出" />,
    )
    expect(markup).toContain('rows="1"')
  })
})
