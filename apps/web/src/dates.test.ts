import { describe, expect, it } from 'vitest'
import { dayGroup, formatElapsed, groupByDay, parseTimestamp, relativeTime } from './dates.js'

// Local-time constructor on purpose: the groups are calendar days in the viewer's time zone.
const now = new Date(2026, 10, 8, 15, 30, 0)
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString()

describe('dayGroup', () => {
  it('buckets by calendar day, not by 24-hour distance', () => {
    expect(dayGroup(at(8, 0, 5), now)).toBe('today')
    expect(dayGroup(at(7, 23, 59), now)).toBe('yesterday')
    expect(dayGroup(at(7, 0, 0), now)).toBe('yesterday')
    expect(dayGroup(at(6, 23, 59), now)).toBe('earlier')
  })

  it('treats empty, invalid and future timestamps as today', () => {
    expect(dayGroup('', now)).toBe('today')
    expect(dayGroup('not a date', now)).toBe('today')
    expect(dayGroup(at(9, 12), now)).toBe('today')
    expect(dayGroup(undefined, now)).toBe('today')
  })
})

describe('groupByDay', () => {
  it('returns non-empty buckets in order, newest first', () => {
    const tasks = [
      { id: 'old', at: at(1, 9) },
      { id: 'morning', at: at(8, 9) },
      { id: 'yesterday', at: at(7, 20) },
      { id: 'noon', at: at(8, 12) },
    ]
    const groups = groupByDay(tasks, (task) => task.at, now)
    expect(groups.map((group) => group.label)).toEqual(['今天', '昨天', '更早'])
    expect(groups[0]?.items.map((task) => task.id)).toEqual(['noon', 'morning'])
    expect(groups[1]?.items.map((task) => task.id)).toEqual(['yesterday'])
    expect(groups[2]?.items.map((task) => task.id)).toEqual(['old'])
  })

  it('omits empty buckets and handles an empty list', () => {
    expect(groupByDay([{ at: at(8, 9) }], (task) => task.at, now).map((group) => group.group)).toEqual([
      'today',
    ])
    expect(groupByDay([], () => '', now)).toEqual([])
  })
})

describe('relativeTime', () => {
  it('uses coarse, friendly units', () => {
    expect(relativeTime(new Date(now.getTime() - 20_000).toISOString(), now)).toBe('剛剛')
    expect(relativeTime(at(8, 15, 29), now)).toBe('1 分鐘前')
    expect(relativeTime(at(8, 15, 0), now)).toBe('30 分鐘前')
    expect(relativeTime(at(8, 10), now)).toBe('5 小時前')
    expect(relativeTime(at(7, 10), now)).toBe('昨天')
    expect(relativeTime(at(3, 9), now)).toBe('5 天前')
    expect(relativeTime(new Date(2026, 8, 3, 9).toISOString(), now)).toBe('9/3')
  })

  it('is empty for missing timestamps', () => {
    expect(relativeTime('', now)).toBe('')
    expect(relativeTime(undefined, now)).toBe('')
  })
})

describe('formatElapsed', () => {
  it('formats minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(3_725_000)).toBe('1:02:05')
    expect(formatElapsed(-5)).toBe('0:00')
  })
})

describe('parseTimestamp', () => {
  it('ignores unparseable values', () => {
    expect(parseTimestamp('')).toBeUndefined()
    expect(parseTimestamp('nope')).toBeUndefined()
    expect(parseTimestamp('2026-11-08T00:00:00.000Z')).toBe(Date.parse('2026-11-08T00:00:00.000Z'))
  })
})
