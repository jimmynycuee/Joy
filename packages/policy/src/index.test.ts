import { describe, expect, it } from 'vitest'
import type { ActionKind, ProposedAction } from '@joy/core'
import { ACTION_KINDS } from '@joy/core'
import { ACTION_TIERS, classifyClaudeToolAction, evaluateAction } from './index.js'

const modes = ['careful', 'normal', 'hands-off'] as const

function proposed(kind: ActionKind, provenance: ProposedAction['provenance'] = 'agent'): ProposedAction {
  return { kind, summary: `Test ${kind}`, detail: {}, provenance }
}

describe('action classification and autonomy modes', () => {
  it.each(ACTION_KINDS)('classifies %s in every global mode', (kind) => {
    const baseline = ACTION_TIERS[kind]
    expect(baseline).toMatch(/^(auto|notify|approve)$/)
    expect(evaluateAction(proposed(kind), 'normal').tier).toBe(baseline)
    expect(evaluateAction(proposed(kind), 'careful').tier).toBe(baseline === 'auto' ? 'notify' : 'approve')
    expect(evaluateAction(proposed(kind), 'hands-off').tier).toBe(baseline === 'notify' ? 'auto' : baseline)
  })

  it('has a tier for every public action kind', () => {
    expect(Object.keys(ACTION_TIERS).sort()).toEqual([...ACTION_KINDS].sort())
  })

  it('requires a cross-model pre-review and owner approval for every red decision', () => {
    for (const kind of ACTION_KINDS) {
      for (const mode of modes) {
        const result = evaluateAction(proposed(kind), mode)
        expect(result.requiresPreReview).toBe(result.tier === 'approve')
        expect(result.outcome).toBe(
          result.tier === 'approve' ? 'require_approval' : result.tier === 'notify' ? 'notify' : 'allow',
        )
      }
    }
  })

  it('keeps external notify-tier actions approval-required in hands-off mode', () => {
    const result = evaluateAction(proposed('read_calendar', 'external_content'), 'hands-off')
    expect(result.tier).toBe('approve')
    expect(result.outcome).toBe('require_approval')
    expect(result.requiresPreReview).toBe(true)
  })

  it('never auto-executes actions marked as external_content in any global mode', () => {
    for (const kind of ACTION_KINDS) {
      for (const mode of modes) {
        const result = evaluateAction(proposed(kind, 'external_content'), mode)
        expect(result.tier).toBe('approve')
        expect(result.outcome).toBe('require_approval')
        expect(result.requiresPreReview).toBe(true)
      }
    }
  })
})

describe('Claude permission action classification', () => {
  it.each([
    ['Read', 'read_file', {}],
    ['Glob', 'read_file', {}],
    ['Grep', 'read_file', {}],
    ['Edit', 'edit_worktree', { file_path: 'src/file.ts' }],
    ['Write', 'edit_worktree', { file_path: 'src/file.ts' }],
    ['Bash', 'run_outside_worktree', { command: 'git status' }],
    ['unknown-tool', 'run_outside_worktree', {}],
  ] as const)('maps %s to %s', (toolName, kind, input) => {
    expect(classifyClaudeToolAction(toolName, input, '/work/project').kind).toBe(kind)
  })

  it('classifies writes with missing or outside paths as high risk', () => {
    expect(classifyClaudeToolAction('Write', {}, '/work/project').kind).toBe('run_outside_worktree')
    expect(classifyClaudeToolAction('Write', { file_path: '../outside.txt' }, '/work/project').kind).toBe(
      'run_outside_worktree',
    )
    expect(classifyClaudeToolAction('Edit', { file_path: '/etc/hosts' }, '/work/project').kind).toBe(
      'run_outside_worktree',
    )
    expect(classifyClaudeToolAction('Write', { file_path: 'src/change.ts' }, '/work/project').kind).toBe(
      'edit_worktree',
    )
  })
})
