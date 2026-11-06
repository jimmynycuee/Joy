// Debug log (T4.8): one JSON line per entry in <home>/logs/joy-YYYY-MM-DD.log (UTC day), 14 days kept. Every entry
// passes through the Redactor before it is written or printed, so a known secret never reaches a log file.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Redactor } from '@joy/secrets'

export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface LogFile {
  day: string
  name: string
  bytes: number
}

export const LOG_DAYS_KEPT = 14
const LOG_FILE = /^joy-(\d{4}-\d{2}-\d{2})\.log$/

export function listLogFiles(dir: string): LogFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .flatMap((name) => {
      const day = LOG_FILE.exec(name)?.[1]
      return day ? [{ day, name, bytes: statSync(join(dir, name)).size }] : []
    })
    .sort((a, b) => b.day.localeCompare(a.day))
}

export function createFileLogger(options: {
  dir: string
  redactor: Redactor
  now?: () => Date
  keepDays?: number
  /** Also print warnings and errors to the console (default true). */
  console?: boolean
}): Logger {
  const now = options.now ?? (() => new Date())
  const keepDays = options.keepDays ?? LOG_DAYS_KEPT
  let currentDay = ''
  let writeFailed = false

  function rotate(day: string) {
    currentDay = day
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    const oldest = new Date(Date.parse(`${day}T00:00:00.000Z`) - (keepDays - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    for (const file of listLogFiles(options.dir))
      if (file.day < oldest) rmSync(join(options.dir, file.name), { force: true })
  }

  function write(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
    const at = now()
    // Callers used to print '[joy] …' themselves; the prefix is added once, on the console only.
    const msg = message.replace(/^\[joy\] /, '')
    const entry = options.redactor.redactValue({ ts: at.toISOString(), level, msg, ...fields })
    if (level !== 'info' && (options.console ?? true)) console.warn(`[joy] ${entry.msg}`)
    try {
      const day = at.toISOString().slice(0, 10)
      if (day !== currentDay) rotate(day)
      appendFileSync(join(options.dir, `joy-${day}.log`), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch (error) {
      // A full disk or a read-only folder must not take Joy down; say so once on the console.
      if (!writeFailed && (options.console ?? true))
        console.warn(`[joy] could not write the debug log: ${String(error)}`)
      writeFailed = true
    }
  }

  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}
