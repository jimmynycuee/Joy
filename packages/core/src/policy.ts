export const TIERS = ['auto', 'notify', 'approve'] as const
/** 🟢 auto: just do it · 🟡 notify: tell, then do unless vetoed · 🔴 approve: wait for the user. */
export type Tier = (typeof TIERS)[number]

export type AutonomyMode = 'careful' | 'normal' | 'hands-off'

export const ACTION_KINDS = [
  'read_file',
  'edit_worktree',
  'run_in_worktree',
  'run_outside_worktree',
  'local_commit',
  'push_feature_branch',
  'push_default_branch',
  'open_draft_pr',
  'merge_pr',
  'delete_file',
  'delete_branch',
  'ask_peer',
  'read_mail',
  'send_mail',
  'read_calendar',
  'create_own_event',
  'invite_others',
  'spend_money',
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

/** Where the request came from. Only `user` may trigger approval-tier actions without extra scrutiny. */
export type Provenance = 'user' | 'agent' | 'external_content'

export interface ProposedAction {
  kind: ActionKind
  summary: string
  detail: unknown
  provenance: Provenance
}

export type ApprovalDecision = { decision: 'approved'; note?: string } | { decision: 'denied'; note?: string }
