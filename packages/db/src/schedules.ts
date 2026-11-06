import type { Database } from './database.js'

export type ReminderStatus = 'pending' | 'sent' | 'cancelled'

export interface ReminderRecord {
  id: string
  text: string
  /** ISO time the reminder is due. */
  dueAt: string
  conversationId?: string
  status: ReminderStatus
  sentAt?: string
  createdAt: string
}

export type ScheduleAction = 'reminder' | 'task'

export interface ScheduleRecord {
  id: string
  cron: string
  action: ScheduleAction
  payload: Record<string, unknown>
  conversationId?: string
  enabled: boolean
  nextRunAt: string
  lastRunAt?: string
  createdAt: string
}

interface ReminderRow {
  id: string
  text: string
  due_at: string
  conversation_id: string | null
  status: ReminderStatus
  sent_at: string | null
  created_at: string
}

interface ScheduleRow {
  id: string
  cron: string
  action: ScheduleAction
  payload: string
  conversation_id: string | null
  enabled: number
  next_run_at: string
  last_run_at: string | null
  created_at: string
}

export function createReminder(
  db: Database,
  input: { id: string; text: string; dueAt: string; conversationId?: string },
): ReminderRecord {
  db.prepare('INSERT INTO reminders (id, text, due_at, conversation_id) VALUES (?, ?, ?, ?)').run(
    input.id,
    input.text,
    input.dueAt,
    input.conversationId ?? null,
  )
  const created = getReminder(db, input.id)
  if (!created) throw new Error(`Reminder ${input.id} was not found after insert`)
  return created
}

export function getReminder(db: Database, id: string): ReminderRecord | undefined {
  const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as unknown as ReminderRow | undefined
  return row ? mapReminder(row) : undefined
}

export function listReminders(db: Database, status?: ReminderStatus): ReminderRecord[] {
  const rows = status
    ? db.prepare('SELECT * FROM reminders WHERE status = ? ORDER BY due_at, id').all(status)
    : db.prepare('SELECT * FROM reminders ORDER BY due_at DESC, id').all()
  return (rows as unknown as ReminderRow[]).map(mapReminder)
}

/** Pending reminders due at or before `now` (ISO), oldest first. */
export function dueReminders(db: Database, now: string): ReminderRecord[] {
  return (
    db
      .prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id")
      .all(now) as unknown as ReminderRow[]
  ).map(mapReminder)
}

/** Moves a pending reminder to sent or cancelled; false when it was no longer pending. */
export function finishReminder(db: Database, id: string, status: 'sent' | 'cancelled', at: string): boolean {
  return (
    Number(
      db
        .prepare("UPDATE reminders SET status = ?, sent_at = ? WHERE id = ? AND status = 'pending'")
        .run(status, status === 'sent' ? at : null, id).changes,
    ) === 1
  )
}

export function createSchedule(
  db: Database,
  input: {
    id: string
    cron: string
    action: ScheduleAction
    payload: Record<string, unknown>
    nextRunAt: string
    conversationId?: string
  },
): ScheduleRecord {
  db.prepare(
    'INSERT INTO schedules (id, cron, action, payload, conversation_id, next_run_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    input.id,
    input.cron,
    input.action,
    JSON.stringify(input.payload),
    input.conversationId ?? null,
    input.nextRunAt,
  )
  const created = getSchedule(db, input.id)
  if (!created) throw new Error(`Schedule ${input.id} was not found after insert`)
  return created
}

export function getSchedule(db: Database, id: string): ScheduleRecord | undefined {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as unknown as ScheduleRow | undefined
  return row ? mapSchedule(row) : undefined
}

export function listSchedules(db: Database): ScheduleRecord[] {
  return (
    db.prepare('SELECT * FROM schedules ORDER BY created_at, id').all() as unknown as ScheduleRow[]
  ).map(mapSchedule)
}

export function dueSchedules(db: Database, now: string): ScheduleRecord[] {
  return (
    db
      .prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, id')
      .all(now) as unknown as ScheduleRow[]
  ).map(mapSchedule)
}

/**
 * Records a run and the next due time, only if the schedule is still due as read (`expectedNextRunAt`), so two
 * ticks never run the same occurrence.
 */
export function advanceSchedule(
  db: Database,
  id: string,
  expectedNextRunAt: string,
  runAt: string,
  nextRunAt: string,
): boolean {
  return (
    Number(
      db
        .prepare(
          'UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ? AND next_run_at = ? AND enabled = 1',
        )
        .run(runAt, nextRunAt, id, expectedNextRunAt).changes,
    ) === 1
  )
}

export function setScheduleEnabled(db: Database, id: string, enabled: boolean, nextRunAt?: string): boolean {
  return (
    Number(
      db
        .prepare('UPDATE schedules SET enabled = ?, next_run_at = COALESCE(?, next_run_at) WHERE id = ?')
        .run(enabled ? 1 : 0, nextRunAt ?? null, id).changes,
    ) === 1
  )
}

export function deleteSchedule(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes) === 1
}

function mapReminder(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    text: row.text,
    dueAt: row.due_at,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    status: row.status,
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
    createdAt: row.created_at,
  }
}

function mapSchedule(row: ScheduleRow): ScheduleRecord {
  const payload: unknown = JSON.parse(row.payload)
  return {
    id: row.id,
    cron: row.cron,
    action: row.action,
    payload:
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    createdAt: row.created_at,
  }
}
