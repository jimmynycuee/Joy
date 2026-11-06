// Readable labels for policy events (T2.3 / T2.7b), shared by the task timeline.

const KIND_LABELS: Record<string, string> = {
  read_file: 'read a file',
  edit_worktree: 'edit files in the worktree',
  run_in_worktree: 'run a command in the worktree',
  run_outside_worktree: 'act outside the worktree',
  local_commit: 'commit locally',
  push_feature_branch: 'push the feature branch',
  push_default_branch: 'push to the default branch',
  open_draft_pr: 'open a draft PR',
  merge_pr: 'merge a PR',
  delete_file: 'delete a file',
  delete_branch: 'delete a branch',
  ask_peer: 'ask the other model',
  read_mail: 'read mail',
  send_mail: 'send mail',
  read_calendar: 'read the calendar',
  create_own_event: 'create a calendar event',
  invite_others: 'invite other people',
  spend_money: 'spend money',
}

const TIER_LABELS: Record<string, string> = {
  auto: 'allowed',
  notify: 'allowed with a notice',
  approve: 'needs owner approval',
}

type Payload = Record<string, unknown> | null

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** Title for a policy event, or undefined when the event is not a policy event. */
export function policyEventTitle(type: string, payload: Payload): string | undefined {
  if (type === 'policy.action') {
    const kind = text(payload?.kind) ?? 'unknown'
    const tier = text(payload?.tier) ?? 'approve'
    const external = payload?.provenance === 'external_content' ? ' (from external content)' : ''
    return `Policy: ${KIND_LABELS[kind] ?? kind}${external} — ${TIER_LABELS[tier] ?? tier}`
  }
  if (type === 'policy.pre_review') {
    if (payload?.status === 'skipped')
      return 'Policy: denied without pre-review (no owner approval channel yet)'
    if (payload?.status === 'unavailable')
      return `Policy pre-review unavailable: ${text(payload?.message) ?? ''}`.trim()
    const verdict = payload?.approve === true ? 'recommends allowing' : 'recommends denying'
    const reviewer = text(payload?.reviewerProvider) ?? 'reviewer'
    return `Policy pre-review (${reviewer}) ${verdict}: ${text(payload?.summary) ?? ''}`.trim()
  }
  if (type === 'approval.requested') {
    return `Waiting for your approval: ${text(payload?.summary) ?? KIND_LABELS[text(payload?.kind) ?? ''] ?? 'an action'}`
  }
  if (type === 'approval.decided') {
    const status = text(payload?.status) ?? 'decided'
    const via = text(payload?.via)
    const label =
      status === 'approved' ? 'Approved' : status === 'denied' ? 'Denied' : 'Expired without an answer'
    return `${label}${via && status !== 'expired' ? ` (via ${via})` : ''}`
  }
  return undefined
}

/** CSS kind for a policy event, so red decisions stand out in the timeline. */
export function policyEventKind(type: string, payload: Payload): string | undefined {
  if (type === 'policy.action') return `policy-${text(payload?.tier) ?? 'approve'}`
  if (type === 'policy.pre_review') return 'policy-review'
  if (type === 'approval.requested') return 'policy-approve'
  if (type === 'approval.decided') return payload?.status === 'approved' ? 'policy-auto' : 'policy-approve'
  return undefined
}
