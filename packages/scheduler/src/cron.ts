// Five-field cron expressions (minute hour day-of-month month day-of-week) in the computer's local time.
// Supports `*`, numbers, lists (`1,15`), ranges (`1-5`) and steps (`*/15`, `9-17/2`). Day-of-week 0 and 7 are Sunday.

export interface Cron {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  weekdays: ReadonlySet<number>
  /** Standard cron: when both day fields are restricted, either one matching is enough. */
  dayOr: boolean
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
]

/** Parses a cron expression; throws with a message the owner can act on. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5)
    throw new Error(
      `"${expression}" is not a cron expression: use five fields, e.g. "0 9 * * 1-5" (09:00 on weekdays)`,
    )
  const sets = parts.map((part, index) => parseField(part, FIELDS[index] ?? { name: '', min: 0, max: 0 }))
  const [minutes, hours, days, months, rawWeekdays] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ]
  const weekdays = new Set([...rawWeekdays].map((day) => day % 7))
  return { minutes, hours, days, months, weekdays, dayOr: parts[2] !== '*' && parts[4] !== '*' }
}

function parseField(field: string, spec: { name: string; min: number; max: number }): Set<number> {
  const values = new Set<number>()
  for (const item of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item)
    if (!match) throw new Error(`Cron ${spec.name} "${field}" is not valid`)
    const [, range = '', stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    let from = spec.min
    let to = spec.max
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number)
      from = a ?? spec.min
      to = b ?? (stepText === undefined ? from : spec.max)
    }
    if (step < 1 || from < spec.min || to > spec.max || from > to)
      throw new Error(`Cron ${spec.name} "${field}" must be within ${spec.min}-${spec.max}`)
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values
}

function dayMatches(cron: Cron, date: Date): boolean {
  const day = cron.days.has(date.getDate())
  const weekday = cron.weekdays.has(date.getDay())
  return cron.dayOr ? day || weekday : day && weekday
}

/** The first time strictly after `after` that the expression matches (whole minutes, local time). */
export function nextOccurrence(cron: Cron, after: Date): Date {
  const date = new Date(after.getTime())
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)
  // Five years is enough for any satisfiable expression (e.g. 29 February); otherwise it never matches.
  const limit = after.getTime() + 5 * 366 * 86_400_000
  while (date.getTime() <= limit) {
    if (!cron.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1)
      date.setHours(0, 0, 0, 0)
    } else if (!dayMatches(cron, date)) {
      date.setDate(date.getDate() + 1)
      date.setHours(0, 0, 0, 0)
    } else if (!cron.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0)
    } else if (!cron.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0)
    } else {
      return date
    }
  }
  throw new Error('This cron expression never matches a real date')
}

/** The latest time at or before `now` that matches, searching forward from `from` (exclusive). */
export function lastOccurrenceBetween(
  cron: Cron,
  from: Date,
  now: Date,
): { at: Date; count: number } | undefined {
  let at: Date | undefined
  let count = 0
  let cursor = new Date(from.getTime() - 60_000)
  for (;;) {
    const next = nextOccurrence(cron, cursor)
    if (next.getTime() > now.getTime()) break
    at = next
    count++
    cursor = next
  }
  return at ? { at, count } : undefined
}
