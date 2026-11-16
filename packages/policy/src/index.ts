import type { ActionKind, AutonomyMode, ProposedAction, Tier } from '@joy/core'
import { ACTION_KINDS } from '@joy/core'
import type { ClassifiedAction } from './classify.js'

export {
  classifyCheckCommand,
  classifyClaudeToolAction,
  classifyCodexApproval,
  isInside,
  isSafeShellCommand,
  isSafeWorktreeCommand,
} from './classify.js'
export type { ClassifiedAction, CodexApprovalInput } from './classify.js'
export { analyzeShellCommand, analyzeShellConcerns, defaultClassifyEnvironment } from './shell.js'
export type { ClassifyEnvironment, ShellAnalysis, ShellConcern, ShellVerdict } from './shell.js'
export {
  normalizeCommand,
  TASK_ALLOW_KINDS,
  taskAllowForClaudeTool,
  taskAllowForCodexApproval,
} from './task-allow.js'
export type { TaskAllowJudgement, TaskAllowKind } from './task-allow.js'

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

/**
 * Applies the global mode without ever lowering an approval-tier or externally sourced action. The one exception
 * is an action the classifier granted under a task's `full` permission mode (`grant: 'full'`): it starts from the
 * auto tier, so the global mode still applies to it (`careful` makes it notify), and external content still asks.
 */
export function evaluateAction(
  action: ProposedAction | ClassifiedAction,
  mode: AutonomyMode,
): ActionPolicyDecision {
  const baseline = 'grant' in action && action.grant === 'full' ? 'auto' : ACTION_TIERS[action.kind]
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
