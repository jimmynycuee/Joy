import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '@joy/db'
import { createReminder, createSchedule, getReminder, getSchedule, openDatabase } from '@joy/db'
import type { Clock, Delivery } from './scheduler.js'
import { createScheduler, firstRun } from './scheduler.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

/** A clock the test moves by hand; timers fire only when the test advances time past them. */
function fakeClock(start: Date) {
  let now = start.getTime()
  const timers = new Map<number, { at: number; callback: () => void }>()
  let nextId = 1
  const clock: Clock = {
    now: () => new Date(now),
    setTimeout: (callback, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  }
  return {
    clock,
    pendingTimers: () => timers.size,
    /** Jumps forward without firing timers in between, like a computer waking from sleep. */
    sleep(ms: number) {
      now += ms
    },
    async fireDueTimers() {
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
      for (let i = 0; i < 20; i++) await Promise.resolve()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

const at = (h: number, m = 0) => new Date(2026, 10, 6, h, m)

function setup(start: Date) {
  const db = openDatabase(':memory:')
  databases.push(db)
  const time = fakeClock(start)
  const delivered: Delivery[] = []
  const scheduler = createScheduler({ db, clock: time.clock, deliver: async (d) => void delivered.push(d) })
  return { db, time, delivered, scheduler }
}

describe('scheduler', () => {
  it('delivers a reminder on time, once', async () => {
    const { db, time, delivered, scheduler } = setup(at(9))
    createReminder(db, { id: 'r1', text: 'Stand-up', dueAt: at(9, 30).toISOString() })
    await scheduler.tick()
    expect(delivered).toEqual([])
    time.sleep(30 * 60_000)
    await scheduler.tick()
    await scheduler.tick()
    expect(delivered).toEqual([expect.objectContaining({ kind: 'reminder', lateMs: 0 })])
    expect(getReminder(db, 'r1')?.status).toBe('sent')
  })

  it('after 3 hours asleep: sends missed reminders marked late and runs an hourly job only once', async () => {
    const { db, time, delivered, scheduler } = setup(at(9, 30))
    createReminder(db, { id: 'r1', text: 'Call the bank', dueAt: at(10).toISOString() })
    createSchedule(db, {
      id: 's1',
      cron: '0 * * * *',
      action: 'reminder',
      payload: { text: 'Drink water' },
      nextRunAt: firstRun('0 * * * *', at(9, 30)),
    })
    scheduler.start()
    await time.fireDueTimers()
    expect(delivered).toEqual([])

    // Asleep from 09:30 to 12:40: 10:00, 11:00 and 12:00 were missed.
    time.sleep(3 * 60 * 60_000 + 10 * 60_000)
    await time.fireDueTimers()
    scheduler.stop()
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toMatchObject({ kind: 'reminder', lateMs: 160 * 60_000 })
    expect(delivered[1]).toMatchObject({
      kind: 'schedule',
      scheduledFor: at(12),
      skipped: 2,
      lateMs: 40 * 60_000,
    })
    expect(getSchedule(db, 's1')?.nextRunAt).toBe(at(13).toISOString())
    expect(time.pendingTimers()).toBe(0)
  })

  it('keeps schedules across a restart', async () => {
    const { db, time, delivered } = setup(at(8))
    createSchedule(db, {
      id: 's1',
      cron: '0 9 * * *',
      action: 'task',
      payload: { title: 'Daily check' },
      nextRunAt: firstRun('0 9 * * *', at(8)),
    })
    // A new scheduler on the same database (Joy restarted) still runs it.
    const restarted = createScheduler({ db, clock: time.clock, deliver: async (d) => void delivered.push(d) })
    time.sleep(60 * 60_000)
    await restarted.tick()
    expect(delivered).toEqual([expect.objectContaining({ kind: 'schedule', skipped: 0, lateMs: 0 })])
    expect(getSchedule(db, 's1')?.nextRunAt).toBe(new Date(2026, 10, 7, 9).toISOString())
  })

  it('never runs the same occurrence twice when ticks overlap', async () => {
    const { db, time, delivered, scheduler } = setup(at(8))
    createSchedule(db, {
      id: 's1',
      cron: '0 9 * * *',
      action: 'reminder',
      payload: { text: 'x' },
      nextRunAt: firstRun('0 9 * * *', at(8)),
    })
    time.sleep(60 * 60_000)
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()])
    expect(delivered).toHaveLength(1)
  })

  it('reports a failed delivery and carries on', async () => {
    const db = openDatabase(':memory:')
    databases.push(db)
    const time = fakeClock(at(10))
    const errors: string[] = []
    const delivered: string[] = []
    const scheduler = createScheduler({
      db,
      clock: time.clock,
      deliver: async (d) => {
        if (d.kind === 'reminder' && d.reminder.id === 'bad') throw new Error('channel down')
        if (d.kind === 'reminder') delivered.push(d.reminder.id)
      },
      onError: (error) => errors.push((error as Error).message),
    })
    createReminder(db, { id: 'bad', text: 'a', dueAt: at(9).toISOString() })
    createReminder(db, { id: 'good', text: 'b', dueAt: at(9, 1).toISOString() })
    await scheduler.tick()
    expect(errors).toEqual(['channel down'])
    expect(delivered).toEqual(['good'])
  })
})
