import { describe, expect, it } from 'vitest'
import { policyEventKind, policyEventTitle } from './policy-events.js'

describe('policy event labels', () => {
  it('describes policy decisions in plain words', () => {
    expect(policyEventTitle('policy.action', { kind: 'run_in_worktree', tier: 'auto' })).toBe(
      'Policy: run a command in the worktree — allowed',
    )
    expect(
      policyEventTitle('policy.action', {
        kind: 'send_mail',
        tier: 'approve',
        provenance: 'external_content',
      }),
    ).toBe('Policy: send mail (from external content) — needs owner approval')
  })

  it('describes pre-review outcomes, including the skipped case', () => {
    expect(policyEventTitle('policy.pre_review', { status: 'skipped' })).toMatch(/no owner approval channel/)
    expect(
      policyEventTitle('policy.pre_review', {
        approve: false,
        reviewerProvider: 'codex-cli',
        summary: 'Risky',
      }),
    ).toBe('Policy pre-review (codex-cli) recommends denying: Risky')
  })

  it('gives red decisions their own CSS kind and ignores other events', () => {
    expect(policyEventKind('policy.action', { tier: 'approve' })).toBe('policy-approve')
    expect(policyEventKind('policy.action', { tier: 'auto' })).toBe('policy-auto')
    expect(policyEventTitle('result', {})).toBeUndefined()
    expect(policyEventKind('agent', {})).toBeUndefined()
  })
})
