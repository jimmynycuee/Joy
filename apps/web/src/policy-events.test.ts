import { describe, expect, it } from 'vitest'
import { policyEventKind, policyEventTitle } from './policy-events.js'

describe('policy event labels', () => {
  it('describes policy decisions in plain words', () => {
    expect(policyEventTitle('policy.action', { kind: 'run_in_worktree', tier: 'auto' })).toBe(
      '權限：在工作副本裡執行指令 — 允許',
    )
    expect(
      policyEventTitle('policy.action', {
        kind: 'send_mail',
        tier: 'approve',
        provenance: 'external_content',
      }),
    ).toBe('權限：寄出郵件（來自外部內容） — 需要你同意')
  })

  it('describes pre-review outcomes, including the skipped case', () => {
    expect(policyEventTitle('policy.pre_review', { status: 'skipped' })).toMatch(/還沒設定讓你同意的管道/)
    expect(
      policyEventTitle('policy.pre_review', {
        approve: false,
        reviewerProvider: 'codex-cli',
        summary: 'Risky',
      }),
    ).toBe('權限預審（codex-cli）建議拒絕：Risky')
  })

  it('gives red decisions their own CSS kind and ignores other events', () => {
    expect(policyEventKind('policy.action', { tier: 'approve' })).toBe('policy-approve')
    expect(policyEventKind('policy.action', { tier: 'auto' })).toBe('policy-auto')
    expect(policyEventTitle('result', {})).toBeUndefined()
    expect(policyEventKind('agent', {})).toBeUndefined()
  })

  it('describes approval requests and decisions', () => {
    expect(policyEventTitle('approval.requested', { summary: 'Claude requested the Bash tool.' })).toBe(
      '等你同意：Claude requested the Bash tool.',
    )
    expect(policyEventTitle('approval.decided', { status: 'approved', via: 'telegram' })).toBe(
      '已同意（透過 telegram）',
    )
    expect(policyEventTitle('approval.decided', { status: 'expired', via: 'timeout' })).toBe('逾時未回覆')
    expect(policyEventKind('approval.decided', { status: 'approved' })).toBe('policy-auto')
  })

  it('describes quota handoffs and queueing', () => {
    expect(
      policyEventTitle('quota.handoff', { from: { provider: 'claude-cli' }, to: { provider: 'codex-cli' } }),
    ).toBe('額度用完：claude-cli 把任務交給 codex-cli，在同一個工作副本繼續')
    expect(policyEventTitle('quota.queued', {})).toBe('額度用完：等待，之後自動繼續')
    expect(policyEventKind('quota.handoff', {})).toBe('policy-notify')
  })
})
