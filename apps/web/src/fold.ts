import { parseTimestamp } from './dates.js'
import { ROLE_SPEAKERS } from './labels.js'
import type { TimelineEntry } from './timeline.js'
import { formatSpent } from './usage.js'

// A finished task read from the top: what was asked, what the agent concluded, the last review. The process in
// between folds into one 過程 that opens on a click.

/** What the folded 過程 says about itself. */
export interface FoldStats {
  /** Review entries in the whole timeline, the final one included. */
  reviewRounds: number
  /** Tool calls, steps and project checks that went into the fold. */
  steps: number
  /** First to last event, when there are two with a time. */
  durationMs: number | undefined
}

export type FoldedItem =
  { kind: 'entry'; entry: TimelineEntry } | { kind: 'fold'; entries: TimelineEntry[]; stats: FoldStats }

const STEP_KINDS = new Set<TimelineEntry['kind']>(['tool', 'step', 'checks'])

/**
 * `done` keeps the owner's messages, the agent's last message and the last review. `failed` also keeps the errors and
 * the last three steps, so the reason is in view. Everything else becomes one fold, placed where its first entry was.
 */
export function foldTimeline(entries: readonly TimelineEntry[], outcome: 'done' | 'failed'): FoldedItem[] {
  const lastMessage = entries.findLast(
    (entry) => entry.kind === 'message' && entry.role !== ROLE_SPEAKERS.reviewer,
  )
  const lastReview = entries.findLast((entry) => entry.kind === 'review')
  const kept = new Set<TimelineEntry>(entries.filter((entry) => entry.kind === 'user'))
  if (lastMessage) kept.add(lastMessage)
  if (lastReview) kept.add(lastReview)
  if (outcome === 'failed') {
    for (const entry of entries) if (entry.kind === 'error') kept.add(entry)
    for (const entry of entries.filter((candidate) => STEP_KINDS.has(candidate.kind)).slice(-3))
      kept.add(entry)
  }

  const folded = entries.filter((entry) => !kept.has(entry))
  if (folded.length === 0) return entries.map((entry) => ({ kind: 'entry', entry }))

  const times = entries
    .map((entry) => parseTimestamp(entry.ts))
    .filter((time): time is number => time !== undefined)
  const stats: FoldStats = {
    reviewRounds: entries.filter((entry) => entry.kind === 'review').length,
    steps: folded.filter((entry) => STEP_KINDS.has(entry.kind)).length,
    durationMs: times.length >= 2 ? Math.max(...times) - Math.min(...times) : undefined,
  }
  const items: FoldedItem[] = []
  let placed = false
  for (const entry of entries) {
    if (kept.has(entry)) items.push({ kind: 'entry', entry })
    else if (!placed) {
      placed = true
      items.push({ kind: 'fold', entries: folded, stats })
    }
  }
  return items
}

/** 「2 輪審查 · 14 個步驟 · 3 分 20 秒」: only the parts that exist. */
export function foldSummary(stats: FoldStats): string {
  return [
    stats.reviewRounds > 0 ? `${stats.reviewRounds} 輪審查` : '',
    stats.steps > 0 ? `${stats.steps} 個步驟` : '',
    stats.durationMs !== undefined && stats.durationMs >= 1000 ? formatSpent(stats.durationMs) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
