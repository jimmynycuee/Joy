import { describe, expect, it } from 'vitest'
import { ApiError } from './api.js'
import { currentMerge, editorErrorText, mergeErrorText } from './task-actions.js'
import type { TaskEvent } from './types.js'

const ev = (type: string, seq: number, payload: unknown = {}): TaskEvent => ({
  taskId: 't1',
  seq,
  type,
  payload,
  ts: '2026-11-19T00:00:00Z',
})

describe('currentMerge', () => {
  it('is the last merge until the agent works again', () => {
    expect(currentMerge([ev('result', 1)])).toBeUndefined()
    expect(currentMerge([ev('result', 1), ev('task.merged', 2, { branch: 'main' })])).toEqual({
      branch: 'main',
    })
    expect(
      currentMerge([ev('result', 1), ev('task.merged', 2, { branch: 'main' }), ev('user.message', 3)]),
    ).toEqual({ branch: 'main' })
    expect(currentMerge([ev('task.merged', 1, { branch: 'main' }), ev('result', 2)])).toBeUndefined()
    expect(currentMerge([ev('task.merged', 1, { branch: 'main' }), ev('task.rewound', 2)])).toBeUndefined()
  })
})

describe('mergeErrorText', () => {
  const refused = (body: Record<string, unknown>) => new ApiError('refused', 409, body)
  it('names the conflicting files', () => {
    expect(mergeErrorText(refused({ reason: 'conflict', conflicts: ['a.ts', 'b.ts'] }), 'main')).toBe(
      '和 main 有衝突，已取消合併：a.ts、b.ts',
    )
  })
  it('explains each refusal', () => {
    expect(mergeErrorText(refused({ reason: 'dirty_checkout' }), 'main')).toMatch(/main 有還沒提交的變更/)
    expect(mergeErrorText(refused({ reason: 'not_fast_forward' }), 'dev')).toMatch(/切到 dev/)
    expect(mergeErrorText(refused({ reason: 'nothing_to_merge' }), 'main')).toBe('main 已經有這些變更了')
    expect(mergeErrorText(new ApiError('Only finished tasks can be merged', 409), 'main')).toMatch(/進行中/)
    expect(mergeErrorText(new Error('boom'), 'main')).toBe('boom')
  })
})

describe('editorErrorText', () => {
  it('says which command is missing', () => {
    expect(editorErrorText(new ApiError('x', 422, { reason: 'editor_not_found', command: 'code' }))).toBe(
      '找不到 code 指令，請在設定指定編輯器',
    )
    expect(editorErrorText(new ApiError('x', 404))).toBe('這個任務沒有工作副本')
  })
})
