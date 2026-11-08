import { record } from './types.js'

// The pull request of a published task, as `GET /api/tasks/:id/pr` reports it.

export interface PrChecks {
  passing: number
  failing: number
  pending: number
  failingNames: string[]
}

export interface PrStatus {
  url: string
  /** OPEN, CLOSED or MERGED as GitHub reports it. */
  state: string
  isDraft: boolean
  checks: PrChecks
  fetchedAt: string
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** Reads the response defensively: anything that is not a PR status becomes null instead of breaking the page. */
export function parsePrStatus(value: unknown): PrStatus | null {
  const fields = record(value)
  if (typeof fields?.url !== 'string' || typeof fields.state !== 'string') return null
  const checks = record(fields.checks)
  return {
    url: fields.url,
    state: fields.state.toUpperCase(),
    isDraft: fields.isDraft === true,
    checks: {
      passing: count(checks?.passing),
      failing: count(checks?.failing),
      pending: count(checks?.pending),
      failingNames: Array.isArray(checks?.failingNames)
        ? checks.failingNames.filter((name): name is string => typeof name === 'string')
        : [],
    },
    fetchedAt: typeof fields.fetchedAt === 'string' ? fields.fetchedAt : '',
  }
}

export type PrTone = 'draft' | 'open' | 'merged' | 'closed'

export function prTone(status: Pick<PrStatus, 'state' | 'isDraft'>): PrTone {
  if (status.state === 'MERGED') return 'merged'
  if (status.state === 'CLOSED') return 'closed'
  return status.isDraft ? 'draft' : 'open'
}

const TONE_LABELS: Record<PrTone, string> = {
  draft: 'Draft',
  open: '已開啟',
  merged: '已合併',
  closed: '已關閉',
}

export function prStateLabel(status: Pick<PrStatus, 'state' | 'isDraft'>): string {
  return TONE_LABELS[prTone(status)]
}

/** 通過 n / 失敗 n / 進行中 n, leaving out the zero counts; empty when the PR has no checks. */
export function checksSummary(checks: PrChecks): string {
  const parts: string[] = []
  if (checks.passing > 0) parts.push(`通過 ${checks.passing}`)
  if (checks.failing > 0) parts.push(`失敗 ${checks.failing}`)
  if (checks.pending > 0) parts.push(`進行中 ${checks.pending}`)
  return parts.join(' / ')
}

/**
 * Whether to keep asking. A merged or closed PR cannot change; a PR whose checks all finished is settled too. An open
 * PR with no checks yet keeps being polled, since CI usually appears a moment after the PR opens.
 */
export function shouldPollPr(status: PrStatus | null): boolean {
  if (!status) return true
  if (status.state === 'MERGED' || status.state === 'CLOSED') return false
  const { passing, failing, pending } = status.checks
  return !(passing + failing + pending > 0 && pending === 0)
}

/** The follow-up message that asks the agent to fix CI. */
export function ciFixMessage(failingNames: readonly string[]): string {
  return failingNames.length > 0
    ? `PR 的 CI 有檢查失敗：${failingNames.join('、')}。請查看失敗原因並修正。`
    : 'PR 的 CI 有檢查失敗。請查看失敗原因並修正。'
}
