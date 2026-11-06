// The scheduler (T3.7): reminders and recurring jobs kept in SQLite, so they survive restarts. It wakes at least once a
// minute; after the computer slept or was off, missed reminders go out at once marked late, and a recurring job that
// missed several runs runs only once, for the most recent one.
import type { Database, ReminderRecord, ScheduleRecord } from '@joy/db'
import { advanceSchedule, dueReminders, dueSchedules, finishReminder } from '@joy/db'
import { lastOccurrenceBetween, nextOccurrence, parseCron } from './cron.js'

/** Anything delivered more than this long after it was due is reported as late. */
export const LATE_AFTER_MS = 2 * 60_000
/** The longest the scheduler sleeps, so it notices soon after the computer wakes up. */
export const MAX_SLEEP_MS = 60_000

export interface Clock {
  now(): Date
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type Delivery =
  | { kind: 'reminder'; reminder: ReminderRecord; lateMs: number }
  | {
      kind: 'schedule'
      schedule: ScheduleRecord
      /** The occurrence being run (the most recent one when several were missed). */
      scheduledFor: Date
      lateMs: number
      /** Earlier occurrences that were missed and are not run. */
      skipped: number
    }

export interface SchedulerOptions {
  db: Database
  deliver(delivery: Delivery): Promise<void>
  clock?: Clock
  onError?(error: unknown, delivery: Delivery): void
}

export interface Scheduler {
  start(): void
  /** Stops waking up and resolves once a pass that is under way has finished. */
  stop(): Promise<void>
  /** Runs everything due now. Exposed for tests and for waking up early after a new item is added. */
  tick(): Promise<void>
}

/** The first due time of a cron expression after `after`, as stored ISO text. Throws for invalid expressions. */
export function firstRun(cron: string, after: Date): string {
  return nextOccurrence(parseCron(cron), after).toISOString()
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const clock = options.clock ?? systemClock
  let timer: unknown
  let running = false
  let ticking: Promise<void> | undefined

  async function deliver(delivery: Delivery) {
    try {
      await options.deliver(delivery)
    } catch (error) {
      if (options.onError) options.onError(error, delivery)
      else throw error
    }
  }

  async function runDue(): Promise<void> {
    const now = clock.now()
    const nowIso = now.toISOString()
    for (const reminder of dueReminders(options.db, nowIso)) {
      // Marked first: a crash mid-delivery loses one reminder rather than repeating it on every start.
      if (!finishReminder(options.db, reminder.id, 'sent', nowIso)) continue
      await deliver({ kind: 'reminder', reminder, lateMs: lateness(now, new Date(reminder.dueAt)) })
    }
    for (const schedule of dueSchedules(options.db, nowIso)) {
      let cron
      try {
        cron = parseCron(schedule.cron)
      } catch {
        continue
      }
      const missed = lastOccurrenceBetween(cron, new Date(schedule.nextRunAt), now)
      const scheduledFor = missed?.at ?? new Date(schedule.nextRunAt)
      const next = nextOccurrence(cron, now).toISOString()
      if (!advanceSchedule(options.db, schedule.id, schedule.nextRunAt, nowIso, next)) continue
      await deliver({
        kind: 'schedule',
        schedule,
        scheduledFor,
        lateMs: lateness(now, scheduledFor),
        skipped: Math.max(0, (missed?.count ?? 1) - 1),
      })
    }
  }

  function tick(): Promise<void> {
    // One pass at a time; a tick requested during a pass waits for it and then runs again.
    const next = (ticking ?? Promise.resolve()).then(runDue)
    // The chain itself never rejects (callers get the error from `next`), so no rejection goes unhandled.
    const settled: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    )
    ticking = settled
    void settled.then(() => {
      if (ticking === settled) ticking = undefined
    })
    return next
  }

  function schedule() {
    if (!running) return
    timer = clock.setTimeout(() => {
      void tick()
        .catch(() => undefined)
        .finally(schedule)
    }, MAX_SLEEP_MS)
  }

  return {
    start() {
      if (running) return
      running = true
      void tick()
        .catch(() => undefined)
        .finally(schedule)
    },
    async stop() {
      running = false
      if (timer !== undefined) clock.clearTimeout(timer)
      timer = undefined
      await ticking
    },
    tick,
  }
}

function lateness(now: Date, due: Date): number {
  const late = now.getTime() - due.getTime()
  return late > LATE_AFTER_MS ? late : 0
}
