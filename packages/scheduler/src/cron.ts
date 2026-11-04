interface CronField {
  values: ReadonlySet<number>
  wildcard: boolean
}

interface ParsedCron {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

const MINUTE_MS = 60_000
const SEARCH_LIMIT_MINUTES = 8 * 366 * 24 * 60
const FIELD_RANGES = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day of month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 7, name: 'day of week' },
] as const

export function validateCron(expression: string): string {
  parseCron(expression)
  return expression.trim().replace(/\s+/g, ' ')
}

/** Returns the first UTC minute matching a five-field cron expression strictly after `after`. */
export function nextCronOccurrence(expression: string, after: Date): string {
  const parsed = parseCron(expression)
  const afterMs = after.getTime()
  if (!Number.isFinite(afterMs)) throw new Error('Cron cursor must be a valid date')
  const firstMinute = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS

  for (let offset = 0; offset < SEARCH_LIMIT_MINUTES; offset += 1) {
    const candidate = new Date(firstMinute + offset * MINUTE_MS)
    if (matches(parsed, candidate)) return candidate.toISOString()
  }
  throw new Error('Cron expression has no occurrence within the supported search window')
}

function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5)
    throw new Error('Cron must have exactly five fields (minute hour day month weekday)')
  const parsed = FIELD_RANGES.map((range, index) =>
    parseField(fields[index] ?? '', range.min, range.max, range.name),
  )
  return {
    minute: parsed[0] as CronField,
    hour: parsed[1] as CronField,
    dayOfMonth: parsed[2] as CronField,
    month: parsed[3] as CronField,
    dayOfWeek: parsed[4] as CronField,
  }
}

function parseField(source: string, min: number, max: number, name: string): CronField {
  if (!source) throw new Error(`Cron ${name} field is empty`)
  const values = new Set<number>()
  const wildcard = source === '*' || source.startsWith('*/')

  for (const segment of source.split(',')) {
    if (!segment) throw new Error(`Cron ${name} field contains an empty list item`)
    const parts = segment.split('/')
    if (parts.length > 2) throw new Error(`Cron ${name} field has an invalid step`)
    const [base, stepText] = parts
    const step = stepText === undefined ? 1 : parsePositiveInteger(stepText, name)
    let start: number
    let end: number

    if (base === '*') {
      start = min
      end = max
    } else if (base?.includes('-')) {
      const range = base.split('-')
      if (range.length !== 2) throw new Error(`Cron ${name} field has an invalid range`)
      start = parseInteger(range[0] ?? '', name)
      end = parseInteger(range[1] ?? '', name)
      if (start > end) throw new Error(`Cron ${name} range start must not exceed its end`)
    } else {
      start = parseInteger(base ?? '', name)
      end = stepText === undefined ? start : max
    }

    if (start < min || end > max) throw new Error(`Cron ${name} value must be between ${min} and ${max}`)
    for (let value = start; value <= end; value += step) {
      values.add(name === 'day of week' && value === 7 ? 0 : value)
    }
  }

  if (values.size === 0) throw new Error(`Cron ${name} field has no values`)
  return { values, wildcard }
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Cron ${name} field accepts numeric values only`)
  return Number(value)
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = parseInteger(value, name)
  if (parsed < 1) throw new Error(`Cron ${name} step must be a positive integer`)
  return parsed
}

function matches(cron: ParsedCron, date: Date): boolean {
  if (!cron.minute.values.has(date.getUTCMinutes())) return false
  if (!cron.hour.values.has(date.getUTCHours())) return false
  if (!cron.month.values.has(date.getUTCMonth() + 1)) return false

  const dayMatches = cron.dayOfMonth.values.has(date.getUTCDate())
  const weekdayMatches = cron.dayOfWeek.values.has(date.getUTCDay())
  const calendarMatches =
    cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard
      ? true
      : cron.dayOfMonth.wildcard
        ? weekdayMatches
        : cron.dayOfWeek.wildcard
          ? dayMatches
          : dayMatches || weekdayMatches
  return calendarMatches
}
