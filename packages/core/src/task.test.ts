import { describe, expect, it } from 'vitest'
import { TASK_STATUSES, isTerminalTaskStatus } from './task.js'

describe('isTerminalTaskStatus', () => {
  it('marks only done, failed and cancelled as terminal', () => {
    const terminal = TASK_STATUSES.filter(isTerminalTaskStatus)
    expect(terminal).toEqual(['done', 'failed', 'cancelled'])
  })
})
