import type { TaskMode } from '@joy/core'
import { createSchedule, listSchedules, markScheduleEnqueued } from '@joy/db'
import type { Database, NewSchedule, ScheduleRecord } from '@joy/db'
import { nextCronOccurrence, validateCron } from './cron.js'

export type ScheduledPayload =
  | { kind: 'reminder'; title: string; message: string }
  | { kind: 'task'; repoId: string; title: string; prompt: string; mode?: TaskMode }

export type NewScheduledWork =
  | { id: string; cron: string; payload: ScheduledPayload }
  | { id: string; runAt: string; payload: ScheduledPayload }

export interface EnqueueScheduledWork {
  scheduleId: string
  occurrenceId: string
  scheduledFor: string
  payload: ScheduledPayload
}

export type EnqueueScheduledWorkCallback = (work: EnqueueScheduledWork) => void | Promise<void>

export type DueScheduleResult =
  | { state: 'queued'; scheduleId: string; occurrenceId: string; scheduledFor: string }
  | { state: 'enqueue_failed'; scheduleId: string; occurrenceId: string; scheduledFor: string }

export interface Scheduler {
  create(input: NewScheduledWork): ScheduleRecord
  list(): ScheduleRecord[]
  runDue(): Promise<DueScheduleResult[]>
}

export interface SchedulerOptions {
  db: Database
  clock: () => Date
  enqueue: EnqueueScheduledWorkCallback
}

/**
 * Creates a persistent scheduler. It has no timer or execution engine: the host calls runDue,
 * and the only due-work action is the injected queue callback.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  let inFlight: Promise<DueScheduleResult[]> | undefined

  return {
    create(input) {
      const now = readClock(options.clock)
      const payload = validatePayload(input.payload)
      const common: Omit<NewSchedule, 'cron' | 'runAt'> = {
        id: validateId(input.id),
        payload,
        createdAt: now.toISOString(),
      }
      if ('cron' in input) {
        return createSchedule(options.db, { ...common, cron: validateCron(input.cron) })
      }
      return createSchedule(options.db, { ...common, runAt: normalizeDate(input.runAt, 'runAt') })
    },
    list() {
      return listSchedules(options.db)
    },
    runDue() {
      if (inFlight) return inFlight
      const run = processDue(options)
      inFlight = run
      return run.finally(() => {
        if (inFlight === run) inFlight = undefined
      })
    },
  }
}

async function processDue(options: SchedulerOptions): Promise<DueScheduleResult[]> {
  const now = readClock(options.clock)
  const due: DueScheduleResult[] = []

  for (const schedule of listSchedules(options.db)) {
    if (!schedule.enabled) continue
    const scheduledFor = getDueOccurrence(schedule, now)
    if (!scheduledFor) continue
    const payload = validatePayload(schedule.payload)
    const occurrenceId = `${schedule.id}:${scheduledFor}`

    try {
      await options.enqueue({ scheduleId: schedule.id, occurrenceId, scheduledFor, payload })
    } catch {
      // Keep the occurrence due so the host can decide when to try the same idempotency key again.
      due.push({ state: 'enqueue_failed', scheduleId: schedule.id, occurrenceId, scheduledFor })
      continue
    }

    if (!markScheduleEnqueued(options.db, schedule.id, scheduledFor)) {
      throw new Error(`Schedule ${schedule.id} changed while its queue handoff was in progress`)
    }
    due.push({ state: 'queued', scheduleId: schedule.id, occurrenceId, scheduledFor })
  }

  return due
}

function getDueOccurrence(schedule: ScheduleRecord, now: Date): string | undefined {
  if (schedule.runAt) {
    return Date.parse(schedule.runAt) <= now.getTime() ? schedule.runAt : undefined
  }
  if (!schedule.cron) throw new Error(`Schedule ${schedule.id} has neither cron nor runAt`)
  const cursor = schedule.lastRunAt ?? schedule.createdAt
  const occurrence = nextCronOccurrence(schedule.cron, new Date(cursor))
  return Date.parse(occurrence) <= now.getTime() ? occurrence : undefined
}

function validateId(id: string): string {
  const trimmed = id.trim()
  if (
    !trimmed ||
    trimmed.length > 128 ||
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    throw new Error('Schedule id must be 1–128 printable characters')
  }
  return trimmed
}

function validatePayload(value: unknown): ScheduledPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Scheduled payload must be an object')
  }
  const payload = value as Record<string, unknown>
  if (payload.kind === 'reminder') {
    assertKeys(payload, ['kind', 'title', 'message'])
    return {
      kind: 'reminder',
      title: validateText(payload.title, 'reminder title', 500),
      message: validateText(payload.message, 'reminder message', 20_000),
    }
  }
  if (payload.kind === 'task') {
    assertKeys(payload, ['kind', 'repoId', 'title', 'prompt', 'mode'])
    const mode = payload.mode
    if (mode !== undefined && mode !== 'single' && mode !== 'review_loop' && mode !== 'compete') {
      throw new Error('Scheduled task mode is invalid')
    }
    return {
      kind: 'task',
      repoId: validateText(payload.repoId, 'repository id', 128),
      title: validateText(payload.title, 'task title', 500),
      prompt: validateText(payload.prompt, 'task prompt', 20_000),
      ...(mode ? { mode } : {}),
    }
  }
  throw new Error('Scheduled payload kind must be reminder or task')
}

function assertKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(payload).some((key) => !allowedSet.has(key))) {
    throw new Error('Scheduled payload contains unsupported fields')
  }
}

function validateText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`Scheduled ${label} must be a non-empty string of at most ${maxLength} characters`)
  }
  return value.trim()
}

function normalizeDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} must be an ISO date-time with a timezone`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid date-time`)
  return parsed.toISOString()
}

function readClock(clock: () => Date): Date {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Scheduler clock must return a valid Date')
  }
  return new Date(value.getTime())
}
