import { describe, expect, it } from 'vitest'
import { TASK_STATUSES, clampPermissionMode, isPermissionMode, isTerminalTaskStatus } from './task.js'

describe('isTerminalTaskStatus', () => {
  it('marks only done, failed and cancelled as terminal', () => {
    const terminal = TASK_STATUSES.filter(isTerminalTaskStatus)
    expect(terminal).toEqual(['done', 'failed', 'cancelled'])
  })
})

describe('permission modes', () => {
  it('knows the three modes', () => {
    expect(['ask', 'auto', 'full'].every(isPermissionMode)).toBe(true)
    expect(isPermissionMode('bypass')).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)
  })

  it('clamps a mode to a maximum', () => {
    expect(clampPermissionMode('full', 'auto')).toBe('auto')
    expect(clampPermissionMode('auto', 'ask')).toBe('ask')
    expect(clampPermissionMode('ask', 'full')).toBe('ask')
    expect(clampPermissionMode('auto', 'full')).toBe('auto')
  })
})
