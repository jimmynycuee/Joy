import { ApiError } from './api.js'
import { record } from './types.js'
import type { TaskEvent } from './types.js'

/** Events after which the worktree may hold something the default branch does not have yet. */
const NEW_WORK = new Set(['result', 'checkpoint.restored', 'task.rewound'])

/** The branch the task was last merged into, unless the agent worked again after that merge. */
export function currentMerge(events: readonly TaskEvent[]): { branch: string } | undefined {
  const last = events.findLastIndex((event) => event.type === 'task.merged')
  if (last < 0 || events.slice(last + 1).some((event) => NEW_WORK.has(event.type))) return undefined
  const branch = record(events[last]?.payload)?.branch
  return { branch: typeof branch === 'string' ? branch : '' }
}

/** What a refused merge means for the owner; nothing changed in any of these cases. */
export function mergeErrorText(error: unknown, branch: string): string {
  const body = error instanceof ApiError ? error.body : {}
  switch (body.reason) {
    case 'conflict': {
      const files = Array.isArray(body.conflicts)
        ? body.conflicts.filter((file): file is string => typeof file === 'string')
        : []
      return `和 ${branch} 有衝突，已取消合併${files.length ? `：${files.join('、')}` : ''}`
    }
    case 'dirty_checkout':
      return `${branch} 有還沒提交的變更，先提交或暫存再合併`
    case 'operation_in_progress':
      return '專案資料夾有進行到一半的合併或 rebase，先完成或取消'
    case 'not_fast_forward':
      return `${branch} 有新的 commit，請先在專案資料夾切到 ${branch} 再合併`
    case 'checked_out_elsewhere':
      return `${branch} 在另一個工作副本開著，請在那裡合併`
    case 'nothing_to_merge':
      return `${branch} 已經有這些變更了`
    case 'missing_default_branch':
      return `找不到 ${branch} 分支`
  }
  if (error instanceof ApiError && error.status === 409 && /Only finished tasks/.test(error.message))
    return '任務還在進行中，等它結束再合併'
  return error instanceof Error && error.message ? error.message : '合併失敗'
}

export function editorErrorText(error: unknown): string {
  const body = error instanceof ApiError ? error.body : {}
  if (body.reason === 'editor_not_found')
    return `找不到 ${typeof body.command === 'string' ? body.command : '編輯器'} 指令，請在設定指定編輯器`
  if (error instanceof ApiError && error.status === 404) return '這個任務沒有工作副本'
  return error instanceof Error && error.message ? error.message : '無法開啟編輯器'
}
