import { describe, expect, it } from 'vitest'
import type { ActionKind, ProposedAction } from '@joy/core'
import { ACTION_KINDS } from '@joy/core'
import { ACTION_TIERS, evaluateAction } from './index.js'

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
