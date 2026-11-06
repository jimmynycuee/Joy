import type { ActionKind, AutonomyMode, ProposedAction, Tier } from '@joy/core'
import { ACTION_KINDS } from '@joy/core'

export {
  classifyClaudeToolAction,
  classifyCodexApproval,
  isInside,
  isSafeWorktreeCommand,
} from './classify.js'
export type { CodexApprovalInput } from './classify.js'

/** The baseline tier for each operation. High-impact operations require a person regardless of mode. */
export const ACTION_TIERS = {
  read_file: 'auto',
  edit_worktree: 'auto',
  run_in_worktree: 'auto',
  run_outside_worktree: 'approve',
  local_commit: 'auto',
  push_feature_branch: 'notify',
  push_default_branch: 'approve',
  open_draft_pr: 'notify',
  merge_pr: 'approve',
  delete_file: 'approve',
  delete_branch: 'approve',
  ask_peer: 'auto',
  read_mail: 'notify',
  send_mail: 'approve',
  read_calendar: 'notify',
  create_own_event: 'notify',
  invite_others: 'approve',
  spend_money: 'approve',
} as const satisfies Record<ActionKind, Tier>

export interface ActionPolicyDecision {
  action: ProposedAction
  tier: Tier
  outcome: 'allow' | 'notify' | 'require_approval'
  requiresPreReview: boolean
}

/** Applies the global mode without ever lowering an approval-tier or externally sourced action. */
export function evaluateAction(action: ProposedAction, mode: AutonomyMode): ActionPolicyDecision {
  const baseline = ACTION_TIERS[action.kind]
  const tier = action.provenance === 'external_content' ? 'approve' : applyMode(baseline, mode)
  return {
    action,
    tier,
    outcome: tier === 'auto' ? 'allow' : tier === 'notify' ? 'notify' : 'require_approval',
    requiresPreReview: tier === 'approve',
  }
}

function applyMode(tier: Tier, mode: AutonomyMode): Tier {
  if (mode === 'careful') return tier === 'auto' ? 'notify' : tier === 'notify' ? 'approve' : 'approve'
  if (mode === 'hands-off') return tier === 'notify' ? 'auto' : tier
  return tier
}

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}
