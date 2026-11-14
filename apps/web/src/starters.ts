export interface Starter {
  label: string
  prompt: string
}

const STARTERS: readonly Starter[] = [
  { label: '修一個 bug', prompt: '修一個 bug：' },
  { label: '補測試', prompt: '幫這段程式補上測試：' },
  { label: '解釋這段程式', prompt: '請解釋這段程式在做什麼：' },
]

const GITHUB_ISSUE_STARTER: Starter = { label: '從 GitHub issue 開始', prompt: '處理 GitHub issue #' }

/**
 * The quick-start chips on the new-task page. They are for the very first task only (once there is any task, the owner
 * knows how to begin), and the GitHub issue one only when the current project has a GitHub address.
 */
export function visibleStarters(hasAnyTask: boolean, githubRemote: string | undefined): readonly Starter[] {
  if (hasAnyTask) return []
  return githubRemote?.trim() ? [...STARTERS, GITHUB_ISSUE_STARTER] : STARTERS
}
