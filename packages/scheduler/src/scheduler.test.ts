import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { createScheduler } from './scheduler.js'
import type { EnqueueScheduledWork } from './scheduler.js'

const databases: Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function memoryDatabase(): Database {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}

function fakeClock(initial: string) {
  let time = Date.parse(initial)
  return {
    now: () => new Date(time),
    set: (value: string) => {
      time = Date.parse(value)
    },
  }
}

const reminder = { kind: 'reminder', title: 'Review draft', message: 'Check the queue' } as const

describe('persistent queue-only scheduler', () => {
  it('reads one-off reminders and cron definitions after reopening the SQLite database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-scheduler-'))
    directories.push(directory)
    const databasePath = join(directory, 'scheduler.sqlite')
    const clock = fakeClock('2026-11-04T12:34:00.000Z')
    const firstDb = openDatabase(databasePath)
    databases.push(firstDb)
    const first = createScheduler({ db: firstDb, clock: clock.now, enqueue: () => undefined })
    first.create({ id: 'reminder-1', runAt: '2026-11-04T13:00:00-05:00', payload: reminder })
    first.create({
      id: 'weekday-cron',
      cron: '0 9 * * 1-5',
      payload: { kind: 'task', repoId: 'repo-1', title: 'Check tests', prompt: 'Run tests after approval' },
    })
    firstDb.close()

    const reopenedDb = openDatabase(databasePath)
    databases.push(reopenedDb)
    const reopened = createScheduler({ db: reopenedDb, clock: clock.now, enqueue: () => undefined })
    expect(reopened.list()).toMatchObject([
      {
        id: 'reminder-1',
        runAt: '2026-11-04T18:00:00.000Z',
        payload: reminder,
        enabled: true,
      },
      {
        id: 'weekday-cron',
        cron: '0 9 * * 1-5',
        payload: { kind: 'task', repoId: 'repo-1', title: 'Check tests', prompt: 'Run tests after approval' },
        enabled: true,
        lastRunAt: '2026-11-04T12:34:00.000Z',
      },
    ])
  })

  it('calls only the injected queue callback when a one-off schedule is due', async () => {
    const db = memoryDatabase()
    const clock = fakeClock('2026-11-04T09:00:00.000Z')
    const queued: EnqueueScheduledWork[] = []
    const scheduler = createScheduler({
      db,
      clock: clock.now,
      enqueue: (work) => {
        queued.push(work)
      },
    })
    scheduler.create({ id: 'reminder-2', runAt: '2026-11-04T09:01:00Z', payload: reminder })

    expect(await scheduler.runDue()).toEqual([])
    expect(queued).toEqual([])
    clock.set('2026-11-04T09:02:00.000Z')
    expect(await scheduler.runDue()).toEqual([
      {
        state: 'queued',
        scheduleId: 'reminder-2',
        occurrenceId: 'reminder-2:2026-11-04T09:01:00.000Z',
        scheduledFor: '2026-11-04T09:01:00.000Z',
      },
    ])
    expect(queued).toEqual([
      {
        scheduleId: 'reminder-2',
        occurrenceId: 'reminder-2:2026-11-04T09:01:00.000Z',
        scheduledFor: '2026-11-04T09:01:00.000Z',
        payload: reminder,
      },
    ])
    expect(scheduler.list()[0]?.enabled).toBe(false)
    expect(await scheduler.runDue()).toEqual([])
    expect(queued).toHaveLength(1)
  })

  it('queues cron occurrences through the callback and advances the durable cursor', async () => {
    const db = memoryDatabase()
    const clock = fakeClock('2026-11-04T10:00:00.000Z')
    const queued: EnqueueScheduledWork[] = []
    const scheduler = createScheduler({
      db,
      clock: clock.now,
      enqueue: (work) => {
        queued.push(work)
      },
    })
    scheduler.create({ id: 'cron-1', cron: '*/5 * * * *', payload: reminder })

    clock.set('2026-11-04T10:06:00.000Z')
    expect((await scheduler.runDue()).map(({ scheduledFor }) => scheduledFor)).toEqual([
      '2026-11-04T10:05:00.000Z',
    ])
    expect(scheduler.list()[0]?.lastRunAt).toBe('2026-11-04T10:05:00.000Z')
    clock.set('2026-11-04T10:11:00.000Z')
    expect((await scheduler.runDue()).map(({ scheduledFor }) => scheduledFor)).toEqual([
      '2026-11-04T10:10:00.000Z',
    ])
    expect(queued).toHaveLength(2)
  })

  it('leaves failed queue handoffs due and retries with the same occurrence id', async () => {
    const db = memoryDatabase()
    const clock = fakeClock('2026-11-04T09:59:00.000Z')
    const attempts: EnqueueScheduledWork[] = []
    const scheduler = createScheduler({
      db,
      clock: clock.now,
      enqueue: (work) => {
        attempts.push(work)
        if (attempts.length === 1) throw new Error('private callback detail')
      },
    })
    scheduler.create({ id: 'retry-1', runAt: '2026-11-04T10:00:00Z', payload: reminder })
    clock.set('2026-11-04T10:00:00.000Z')

    expect(await scheduler.runDue()).toMatchObject([{ state: 'enqueue_failed' }])
    expect(scheduler.list()[0]?.enabled).toBe(true)
    expect(await scheduler.runDue()).toMatchObject([{ state: 'queued' }])
    expect(attempts[0]?.occurrenceId).toBe(attempts[1]?.occurrenceId)
    expect(scheduler.list()[0]?.enabled).toBe(false)
  })

  it('coalesces concurrent ticks for one scheduler instance', async () => {
    const db = memoryDatabase()
    const clock = fakeClock('2026-11-04T09:59:00.000Z')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    let calls = 0
    const scheduler = createScheduler({
      db,
      clock: clock.now,
      enqueue: async () => {
        calls += 1
        await gate
      },
    })
    scheduler.create({ id: 'concurrent-1', runAt: '2026-11-04T10:00:00Z', payload: reminder })
    clock.set('2026-11-04T10:00:00.000Z')

    const first = scheduler.runDue()
    const second = scheduler.runDue()
    await Promise.resolve()
    expect(calls).toBe(1)
    release()
    expect(await first).toMatchObject([{ state: 'queued' }])
    expect(await second).toMatchObject([{ state: 'queued' }])
    expect(calls).toBe(1)
  })

  it('rejects unsafe payload shapes, invalid dates, and invalid cron definitions', () => {
    const scheduler = createScheduler({
      db: memoryDatabase(),
      clock: () => new Date('2026-11-04T00:00:00Z'),
      enqueue: () => undefined,
    })
    expect(() =>
      scheduler.create({
        id: 'unexpected',
        runAt: '2026-11-04',
        payload: reminder,
      }),
    ).toThrow()
    expect(() =>
      scheduler.create({
        id: 'extra-field',
        runAt: '2026-11-04T00:01:00Z',
        payload: { ...reminder, executeNow: true },
      } as never),
    ).toThrow('unsupported fields')
    expect(() => scheduler.create({ id: 'bad-cron', cron: '60 * * * *', payload: reminder })).toThrow()
    expect(scheduler.list()).toEqual([])
  })
})
