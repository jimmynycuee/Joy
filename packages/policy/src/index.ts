import type { ActionKind, AutonomyMode, ProposedAction, Tier } from '@joy/core'
import { ACTION_KINDS } from '@joy/core'
import { isAbsolute, relative, resolve } from 'node:path'

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

/** Map Claude Code permission prompts to policy actions; unknown tools and shell commands fail closed. */
export function classifyClaudeToolAction(toolName: string, input: unknown, cwd: string): ProposedAction {
  const bareName = toolName.startsWith('mcp__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName
  const normalizedName = bareName.toLowerCase()
  const kind: ActionKind =
    normalizedName === 'read' ||
    normalizedName === 'glob' ||
    normalizedName === 'grep' ||
    normalizedName === 'listdirectory' ||
    normalizedName === 'task_status'
      ? 'read_file'
      : normalizedName === 'edit' || normalizedName === 'write' || normalizedName === 'notebookedit'
        ? hasOutsidePath(input, cwd)
          ? 'run_outside_worktree'
          : 'edit_worktree'
        : normalizedName === 'bash'
          ? 'run_outside_worktree'
          : normalizedName === 'ask_peer'
            ? 'ask_peer'
            : 'run_outside_worktree'
  return {
    kind,
    summary: `Claude requested the ${toolName} tool.`,
    detail: input,
    provenance: 'agent',
  }
}

function applyMode(tier: Tier, mode: AutonomyMode): Tier {
  if (mode === 'careful') return tier === 'auto' ? 'notify' : tier === 'notify' ? 'approve' : 'approve'
  if (mode === 'hands-off') return tier === 'notify' ? 'auto' : tier
  return tier
}

function hasOutsidePath(input: unknown, cwd: string): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return true
  const record = input as Record<string, unknown>
  const candidate = record.file_path ?? record.filePath ?? record.path
  if (typeof candidate !== 'string' || candidate.trim() === '') return true
  if (isAbsolute(candidate)) return true
  const resolvedCwd = resolve(cwd)
  const resolvedPath = resolve(resolvedCwd, candidate)
  const pathFromCwd = relative(resolvedCwd, resolvedPath)
  return (
    pathFromCwd === '..' ||
    pathFromCwd.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathFromCwd)
  )
}

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}
