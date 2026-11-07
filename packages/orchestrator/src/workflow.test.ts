import type { TaskMode } from '@joy/core'
import { describe, expect, it } from 'vitest'
import type { Workflow } from './workflow.js'
import { BUILT_IN_WORKFLOWS, findWorkflow, workflowProblems, workflowTask } from './workflow.js'

describe('workflows', () => {
  it.each(['single', 'review_loop', 'compete'] as TaskMode[])(
    'expresses the existing %s mode exactly',
    (mode) => {
      const workflow = findWorkflow(mode)
      expect(workflow).toBeDefined()
      expect(workflowProblems(workflow as Workflow)).toEqual([])
      // Same mode, no role changes, no option changes: a task from the workflow runs as the old mode did.
      expect(workflowTask(workflow as Workflow)).toEqual({ mode, roleOverrides: {} })
    },
  )

  it('carries a custom workflow’s models and options into the task', () => {
    const careful: Workflow = {
      name: 'careful',
      pattern: 'review_loop',
      roles: {
        implementer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high' },
        reviewer: { provider: 'claude-cli', model: 'opus', effort: 'high' },
      },
      maxRounds: 5,
      planFirst: true,
    }
    expect(workflowProblems(careful)).toEqual([])
    expect(workflowTask(careful)).toEqual({
      mode: 'review_loop',
      roleOverrides: careful.roles,
      maxRounds: 5,
      planFirst: true,
    })
    expect(findWorkflow('careful', [careful])).toBe(careful)
    // A custom workflow cannot replace a built-in one.
    expect(findWorkflow('single', [{ ...careful, name: 'single' }])).toBe(BUILT_IN_WORKFLOWS[0])
  })

  it('explains workflows that cannot work', () => {
    const model = { provider: 'claude-cli' as const, model: 'haiku' }
    expect(workflowProblems({ name: 'Bad Name', pattern: 'single' })).toEqual([
      expect.stringContaining('lowercase letters'),
    ])
    expect(workflowProblems({ name: 'solo', pattern: 'single', roles: { judge: model } })).toEqual([
      expect.stringContaining('does not use the judge role'),
    ])
    expect(workflowProblems({ name: 'race', pattern: 'compete', maxRounds: 2 })).toEqual([
      expect.stringContaining('only apply to the review_loop'),
    ])
    expect(
      workflowProblems({ name: 'race', pattern: 'compete', roles: { implementer: model, reviewer: model } }),
    ).toEqual([expect.stringContaining('two different models')])
  })
})
