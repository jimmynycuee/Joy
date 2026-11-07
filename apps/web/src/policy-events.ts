// Readable (Traditional Chinese) labels for policy events (T2.3 / T2.7b), shared by the task timeline.

const KIND_LABELS: Record<string, string> = {
  read_file: '讀取檔案',
  edit_worktree: '修改工作副本裡的檔案',
  run_in_worktree: '在工作副本裡執行指令',
  run_outside_worktree: '在工作副本以外動作',
  local_commit: '在本機 commit',
  push_feature_branch: '推送功能分支',
  push_default_branch: '推送到預設分支',
  open_draft_pr: '開 draft PR',
  merge_pr: '合併 PR',
  delete_file: '刪除檔案',
  delete_branch: '刪除分支',
  ask_peer: '詢問另一個模型',
  read_mail: '讀取郵件',
  send_mail: '寄出郵件',
  read_calendar: '讀取行事曆',
  create_own_event: '建立行事曆活動',
  invite_others: '邀請其他人',
  spend_money: '花錢',
}

const TIER_LABELS: Record<string, string> = {
  auto: '允許',
  notify: '允許並通知你',
  approve: '需要你同意',
}

type Payload = Record<string, unknown> | null

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** Title for a policy event, or undefined when the event is not a policy event. */
export function policyEventTitle(type: string, payload: Payload): string | undefined {
  if (type === 'policy.action') {
    const kind = text(payload?.kind) ?? 'unknown'
    const tier = text(payload?.tier) ?? 'approve'
    const external = payload?.provenance === 'external_content' ? '（來自外部內容）' : ''
    return `權限：${KIND_LABELS[kind] ?? kind}${external} — ${TIER_LABELS[tier] ?? tier}`
  }
  if (type === 'policy.pre_review') {
    if (payload?.status === 'skipped') return '權限：沒有預審就拒絕（還沒設定讓你同意的管道）'
    if (payload?.status === 'unavailable') return `權限預審無法進行：${text(payload?.message) ?? ''}`.trim()
    const verdict = payload?.approve === true ? '建議允許' : '建議拒絕'
    const reviewer = text(payload?.reviewerProvider) ?? '審查者'
    return `權限預審（${reviewer}）${verdict}：${text(payload?.summary) ?? ''}`.trim()
  }
  if (type === 'approval.requested') {
    return `等你同意：${text(payload?.summary) ?? KIND_LABELS[text(payload?.kind) ?? ''] ?? '一個動作'}`
  }
  if (type === 'quota.handoff') {
    const from = (payload?.from as { provider?: string } | undefined)?.provider ?? '第一個模型'
    const to = (payload?.to as { provider?: string } | undefined)?.provider ?? '另一個模型'
    return `額度用完：${from} 把任務交給 ${to}，在同一個工作副本繼續`
  }
  if (type === 'quota.queued') {
    const at = text(payload?.resumeAt)
    return `額度用完：等待${at ? `到 ${new Date(at).toLocaleString()}` : ''}，之後自動繼續`
  }
  if (type === 'task.paused') return '已暫停：時間內沒有回覆。你同意後會接著原本的進度繼續。'
  if (type === 'approval.granted') return `你稍後同意了，允許這一次：${text(payload?.summary) ?? ''}`.trim()
  if (type === 'approval.decided') {
    const status = text(payload?.status) ?? 'decided'
    const via = text(payload?.via)
    const label = status === 'approved' ? '已同意' : status === 'denied' ? '已拒絕' : '逾時未回覆'
    return `${label}${via && status !== 'expired' ? `（透過 ${via}）` : ''}`
  }
  return undefined
}

/** CSS kind for a policy event, so red decisions stand out in the timeline. */
export function policyEventKind(type: string, payload: Payload): string | undefined {
  if (type === 'policy.action') return `policy-${text(payload?.tier) ?? 'approve'}`
  if (type === 'policy.pre_review') return 'policy-review'
  if (type === 'approval.requested' || type === 'task.paused') return 'policy-approve'
  if (type === 'approval.granted') return 'policy-auto'
  if (type === 'quota.handoff' || type === 'quota.queued') return 'policy-notify'
  if (type === 'approval.decided') return payload?.status === 'approved' ? 'policy-auto' : 'policy-approve'
  return undefined
}
