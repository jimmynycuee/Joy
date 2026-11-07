export type DayGroup = 'today' | 'yesterday' | 'earlier'

export const DAY_GROUP_LABELS: Record<DayGroup, string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
}

/** Milliseconds since the epoch, or undefined for empty or unparseable timestamps (test fixtures use ''). */
export function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : time
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Calendar-day bucket in the viewer's time zone. Unknown or future timestamps count as today. */
export function dayGroup(value: string | undefined, now: Date = new Date()): DayGroup {
  const time = parseTimestamp(value)
  if (time === undefined) return 'today'
  const today = startOfDay(now.getTime())
  if (time >= today) return 'today'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  return time >= yesterday.getTime() ? 'yesterday' : 'earlier'
}

export interface DayBucket<T> {
  group: DayGroup
  label: string
  items: T[]
}

/** Buckets items into 今天 / 昨天 / 更早, newest first, leaving out empty buckets. */
export function groupByDay<T>(
  items: readonly T[],
  getTime: (item: T) => string | undefined,
  now: Date = new Date(),
): DayBucket<T>[] {
  const sorted = [...items].sort(
    (a, b) => (parseTimestamp(getTime(b)) ?? Infinity) - (parseTimestamp(getTime(a)) ?? Infinity),
  )
  const buckets: DayBucket<T>[] = (['today', 'yesterday', 'earlier'] as const).map((group) => ({
    group,
    label: DAY_GROUP_LABELS[group],
    items: [],
  }))
  for (const item of sorted)
    buckets.find((bucket) => bucket.group === dayGroup(getTime(item), now))?.items.push(item)
  return buckets.filter((bucket) => bucket.items.length > 0)
}

/** "剛剛", "5 分鐘前", "3 小時前", "2 天前", then the date. */
export function relativeTime(value: string | undefined, now: Date = new Date()): string {
  const time = parseTimestamp(value)
  if (time === undefined) return ''
  const seconds = Math.max(0, Math.round((now.getTime() - time) / 1000))
  if (seconds < 45) return '剛剛'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小時前`
  const days = Math.floor((startOfDay(now.getTime()) - startOfDay(time)) / 86_400_000)
  if (days <= 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const date = new Date(time)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}
