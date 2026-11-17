// What a task cost: wall-clock time, tokens and cost, read from its stored events. Nothing is stored beside the events
// (they already carry the agents' `usage` events with their role and attempt), so an older task shows what it recorded
// and a task with nothing recorded shows no tokens or cost. Pure functions; the server owns the I/O.

import type { ModelRef, ProviderKind } from '@joy/core'

/** The parts of a stored task event the summary reads. */
export interface UsageEvent {
  attemptId?: string
  seq: number
  type: string
  payload: unknown
  ts: string
}

export interface UsageAttempt {
  id: string
  provider: ProviderKind
  model: string
}

export interface UsageTotals {
  /** Every input token, the cached ones included. */
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  costUsd?: number
}

export type CostSource = 'cli' | 'price_table' | 'mixed'

export interface ModelUsage extends UsageTotals {
  provider: ProviderKind
  model: string
}

/** One role (implementer, reviewer, judge) on one model. `durationMs` is the time its phases ran, approval waits out. */
export interface RoleUsage extends UsageTotals {
  role: string
  provider?: ProviderKind
  model?: string
  durationMs?: number
}

/** One run of the task, from its start to the event that ended it. */
export interface RunUsage extends UsageTotals {
  /** The event that ended the run: the timeline puts the run's line after it. */
  endSeq: number
  durationMs: number
  approvalWaitMs?: number
}

export interface TaskUsageSummary extends UsageTotals {
  /** Wall-clock time the task ran, the time it waited for an approval left out. */
  durationMs: number
  approvalWaitMs?: number
  costSource?: CostSource
  byProvider: ModelUsage[]
  byRole: RoleUsage[]
  runs: RunUsage[]
}

/** Events that end one run of a task. */
const RUN_END_EVENTS = new Set([
  'result',
  'error',
  'task.paused',
  'interrupted',
  'quota.queued',
  'run.interrupted',
])
/** The event types the summary reads, for loading a task's events without the rest. */
export const USAGE_EVENT_TYPES: readonly string[] = [
  'started',
  ...RUN_END_EVENTS,
  'phase',
  'approval.requested',
  'approval.decided',
  'agent',
  'compete.usage',
]
const ROLE_ORDER = ['implementer', 'reviewer', 'judge']
const FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'costUsd'] as const

type Fields = (typeof FIELDS)[number]
type Mutable = { -readonly [K in Fields]?: number }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function add(target: Mutable, key: Fields, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = (target[key] ?? 0) + value
}

function addAll(target: Mutable, usage: Record<string, unknown>): void {
  for (const key of FIELDS) add(target, key, usage[key])
}

function modelRef(value: unknown): ModelRef | undefined {
  const fields = record(value)
  return typeof fields?.provider === 'string' && typeof fields.model === 'string'
    ? { provider: fields.provider as ProviderKind, model: fields.model }
    : undefined
}

interface OpenRun {
  lastAt: number
  active: number
  wait: number
  totals: Mutable
}

interface RoleState {
  role: string
  model: ModelRef | undefined
}

/**
 * Reads the usage of a task from its events, oldest first.
 *
 * - A run starts at a `started` event and ends at the first event of `RUN_END_EVENTS`. Between them the clock counts
 *   as work, except while an approval is pending (`approval.requested` until its `approval.decided`), which counts as
 *   waiting. With attempts running side by side (compete) any pending approval counts the whole task as waiting, but
 *   only the waiting attempt's own role loses the time.
 * - Tokens and cost come from the `usage` events of agents. Each goes to the role and model of its phase (a `phase`
 *   event names them), to the run it came in, and to the task.
 * - `now` closes the run still going, so the running time shows while it works.
 */
export function summarizeTaskUsage(
  events: readonly UsageEvent[],
  attempts: readonly UsageAttempt[],
  options: { running: boolean; now?: number },
): TaskUsageSummary {
  const byAttempt = new Map(attempts.map((attempt) => [attempt.id, attempt]))
  const totals: Mutable = {}
  const models = new Map<string, ModelUsage>()
  const roles = new Map<string, RoleUsage & { time: number }>()
  const sources = new Set<'cli' | 'price_table'>()
  const runs: Array<RunUsage & { totals: Mutable }> = []
  let durationMs = 0
  let waitMs = 0
  let open: OpenRun | undefined
  // The role an attempt is in, from its last `phase` event with one.
  const phases = new Map<string, RoleState>()
  const pending = new Map<string, string>()
  // The model each role last ran on, per attempt: an agent's events name the role, only its phase names the model.
  const roleModels = new Map<string, ModelRef>()

  const roleEntry = (role: string, model: ModelRef | undefined) => {
    const id = `${role}:${model?.provider ?? ''}:${model?.model ?? ''}`
    let entry = roles.get(id)
    if (!entry) {
      entry = { role, ...(model ? { provider: model.provider, model: model.model } : {}), time: 0 }
      roles.set(id, entry)
    }
    return entry
  }

  const advance = (at: number) => {
    if (!open || !Number.isFinite(at)) return
    const delta = Math.max(0, at - open.lastAt)
    open.lastAt = Math.max(open.lastAt, at)
    if (pending.size > 0) open.wait += delta
    else open.active += delta
    const waiting = new Set(pending.values())
    for (const [attemptKey, phase] of phases)
      if (!waiting.has(attemptKey)) roleEntry(phase.role, phase.model).time += delta
  }

  const close = (endSeq: number) => {
    if (!open) return
    durationMs += open.active
    waitMs += open.wait
    runs.push({
      endSeq,
      durationMs: Math.round(open.active),
      ...(open.wait > 0 ? { approvalWaitMs: Math.round(open.wait) } : {}),
      totals: open.totals,
    })
    open = undefined
    pending.clear()
    phases.clear()
  }

  for (const event of events) {
    const at = Date.parse(event.ts)
    advance(at)
    const payload = record(event.payload)
    const attemptKey = event.attemptId ?? ''

    if (event.type === 'started') {
      if (!open && Number.isFinite(at)) open = { lastAt: at, active: 0, wait: 0, totals: {} }
      continue
    }
    if (RUN_END_EVENTS.has(event.type)) {
      close(event.seq)
      continue
    }
    if (event.type === 'phase') {
      const role = typeof payload?.role === 'string' ? payload.role : undefined
      const model = modelRef(payload?.model)
      if (role) {
        phases.set(attemptKey, { role, model })
        if (model) roleModels.set(`${attemptKey}:${role}`, model)
      } else phases.delete(attemptKey)
      continue
    }
    if (event.type === 'approval.requested' && open && typeof payload?.approvalId === 'string') {
      pending.set(payload.approvalId, attemptKey)
      continue
    }
    if (event.type === 'approval.decided' && typeof payload?.approvalId === 'string') {
      pending.delete(payload.approvalId)
      continue
    }

    // An agent's usage, or a judge's (a compete task's judge runs outside any attempt).
    const usage =
      event.type === 'agent' || event.type === 'compete.usage' ? record(record(payload)?.event) : undefined
    if (usage?.type !== 'usage') continue
    const roleName =
      typeof payload?.role === 'string' ? payload.role : event.type === 'compete.usage' ? 'judge' : undefined
    const attempt = event.attemptId ? byAttempt.get(event.attemptId) : undefined
    const model =
      modelRef(payload?.model) ??
      roleModels.get(`${attemptKey}:${roleName ?? ''}`) ??
      (roleName === 'implementer' && attempt
        ? { provider: attempt.provider, model: attempt.model }
        : undefined)

    addAll(totals, usage)
    // A usage that comes after its run ended (a judge's, say) is counted with the last run.
    addAll(open ? open.totals : (runs.at(-1)?.totals ?? {}), usage)
    if (
      typeof usage.costUsd === 'number' &&
      (usage.costSource === 'cli' || usage.costSource === 'price_table')
    )
      sources.add(usage.costSource)
    if (model) {
      const id = `${model.provider}:${model.model}`
      const entry = models.get(id) ?? { provider: model.provider, model: model.model }
      addAll(entry, usage)
      models.set(id, entry)
    }
    if (roleName) addAll(roleEntry(roleName, model), usage)
  }

  if (open && options.running) {
    advance(options.now ?? Date.now())
    durationMs += open.active
    waitMs += open.wait
  }

  const byRole = [...roles.values()]
    .map(({ time, ...entry }) => ({ ...entry, ...(time > 0 ? { durationMs: Math.round(time) } : {}) }))
    .sort((a, b) => rank(a.role) - rank(b.role))
  return {
    durationMs: Math.round(durationMs),
    ...(waitMs > 0 ? { approvalWaitMs: Math.round(waitMs) } : {}),
    ...totals,
    ...(sources.size > 0 ? { costSource: costSource(sources) } : {}),
    byProvider: [...models.values()],
    byRole,
    runs: runs.map(({ totals: runTotals, ...run }) => ({ ...run, ...runTotals })),
  }
}

function costSource(sources: ReadonlySet<'cli' | 'price_table'>): CostSource {
  const [only] = sources
  return sources.size === 1 && only ? only : 'mixed'
}

function rank(role: string): number {
  const index = ROLE_ORDER.indexOf(role)
  return index === -1 ? ROLE_ORDER.length : index
}
