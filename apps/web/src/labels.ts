import { PROVIDER_KINDS } from '@joy/core'
import type { ModelRef, ProviderKind, Role } from '@joy/core'
import type { JoyConfig } from '@joy/config'
import { MODEL_CATALOG } from './models.js'
import type { DoctorStatus } from './types.js'

export const ROLE_LABELS: Record<Role, string> = {
  assistant_brain: '助理大腦',
  background: '背景工作',
  orchestrator: '調度者',
  implementer: '實作者',
  reviewer: '審查者',
  judge: '裁判',
}
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  'openai-api': 'OpenAI API',
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
}
/** Model names to suggest per provider, in catalog order (`models.ts` is the one table of model names). */
export const MODEL_SUGGESTIONS: Record<ProviderKind, string[]> = Object.fromEntries(
  PROVIDER_KINDS.map((provider) => [
    provider,
    MODEL_CATALOG.filter((entry) => entry.provider === provider).map((entry) => entry.model),
  ]),
) as Record<ProviderKind, string[]>
export const EFFORT_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
}

export const STATUS_LABELS: Record<string, string> = {
  queued: '排隊中',
  running: '進行中',
  awaiting_approval: '等你同意',
  review_ready: '審查有意見',
  done: '完成',
  failed: '失敗',
  cancelled: '已取消',
}

export const MODE_LABELS: Record<string, string> = {
  single: '單人',
  review_loop: '實作＋審查',
  compete: '兩家比賽',
}

export const MODE_HINTS: Record<string, string> = {
  review_loop: '一個 AI 做，另一個檢查',
  single: '一個 AI 完成，最快',
  compete: '兩個 AI 各做一份，由你挑一個',
}

export const PHASE_LABELS: Record<string, string> = {
  preparing: '準備工作環境',
  planning: '規劃中',
  plan_review: '審查計畫',
  implementing: '實作中',
  reviewing: '審查中',
  fixing: '依審查意見修正',
}

/** Who is speaking, by the role an agent event carries. */
export const ROLE_SPEAKERS: Record<string, string> = {
  implementer: '實作',
  reviewer: '審查',
  judge: '裁判',
  orchestrator: '調度',
}

/** The `repair` text of a doctor check that needs nothing (the server's NO_ACTION_NEEDED), so it can be left out. */
export const NO_ACTION_REPAIR = '不需要處理。'

export function doctorStatusLabel(status: DoctorStatus): string {
  return status === 'ok' ? '正常' : status === 'missing' ? '缺少' : '未驗證'
}

/** The title the owner typed, else the prompt's first line, so a task needs only one box. */
export function taskTitle(title: string, prompt: string): string {
  const typed = title.trim()
  if (typed) return typed
  const firstLine = prompt.trim().split('\n')[0]?.trim() ?? ''
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

/**
 * A compete task in review_ready is waiting for the owner to pick one, not for a fix; a task with a plan waiting is
 * waiting for approval of that plan.
 */
export function statusLabel(status: string, mode?: string, pendingPlan = false): string {
  if (status === 'review_ready' && pendingPlan) return '等你核准計畫'
  if (status === 'review_ready' && mode === 'compete') return '待你挑選'
  return STATUS_LABELS[status] ?? status.replaceAll('_', ' ')
}

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode.replaceAll('_', ' ')
}

export function repoName(path: string | undefined): string {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? '專案'
}

export function providersForRole(role: Role): ProviderKind[] {
  return role === 'implementer'
    ? PROVIDER_KINDS.filter((provider) => provider !== 'openai-api')
    : [...PROVIDER_KINDS]
}

export function roleModel(config: JoyConfig | null, role: Role): ModelRef {
  const model = config?.roles[role] ?? {
    provider: 'claude-cli' as const,
    model: 'opus',
    effort: 'medium' as const,
  }
  const provider = role === 'implementer' && model.provider === 'openai-api' ? 'claude-cli' : model.provider
  return {
    provider,
    model: provider === model.provider ? model.model : (MODEL_SUGGESTIONS[provider][0] ?? 'opus'),
    ...(model.effort ? { effort: model.effort } : {}),
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = ms / 60_000
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)} 小時` : `${Math.max(1, Math.round(minutes))} 分鐘`
}
