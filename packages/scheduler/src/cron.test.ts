import { describe, expect, it } from 'vitest'
import { lastOccurrenceBetween, nextOccurrence, parseCron } from './cron.js'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

describe('cron', () => {
  it('finds the next matching minute in local time', () => {
    const weekdays9 = parseCron('0 9 * * 1-5')
    // Friday 2026-11-06 10:00 → Monday 09:00.
    expect(nextOccurrence(weekdays9, at(2026, 11, 6, 10))).toEqual(at(2026, 11, 9, 9))
    expect(nextOccurrence(weekdays9, at(2026, 11, 6, 8, 59))).toEqual(at(2026, 11, 6, 9))
    expect(nextOccurrence(parseCron('*/15 * * * *'), at(2026, 11, 6, 10, 7))).toEqual(at(2026, 11, 6, 10, 15))
    expect(nextOccurrence(parseCron('30 8 1 * *'), at(2026, 12, 15))).toEqual(at(2027, 1, 1, 8, 30))
    expect(nextOccurrence(parseCron('0 0 29 2 *'), at(2026, 3, 1))).toEqual(at(2028, 2, 29))
    // Sunday as 7.
    expect(nextOccurrence(parseCron('0 12 * * 7'), at(2026, 11, 6))).toEqual(at(2026, 11, 8, 12))
  })

  it('matches either day field when both are restricted', () => {
    // The 10th, or any Monday.
    expect(nextOccurrence(parseCron('0 9 10 * 1'), at(2026, 11, 6, 10))).toEqual(at(2026, 11, 9, 9))
    expect(nextOccurrence(parseCron('0 9 10 * 1'), at(2026, 11, 9, 10))).toEqual(at(2026, 11, 10, 9))
  })

  it('rejects malformed expressions with an actionable message', () => {
    expect(() => parseCron('every day')).toThrow(/five fields/)
    expect(() => parseCron('61 * * * *')).toThrow(/minute "61" must be within 0-59/)
    expect(() => parseCron('* * * * mon')).toThrow(/day of week "mon" is not valid/)
    expect(() => parseCron('*/0 * * * *')).toThrow()
    expect(() => nextOccurrence(parseCron('0 0 31 2 *'), at(2026, 1, 1))).toThrow(/never matches/)
  })

  it('finds only the most recent occurrence missed while asleep', () => {
    const hourly = parseCron('0 * * * *')
    // Due at 10:00; the computer slept until 13:20: 10:00, 11:00, 12:00 and 13:00 were missed.
    expect(lastOccurrenceBetween(hourly, at(2026, 11, 6, 10), at(2026, 11, 6, 13, 20))).toEqual({
      at: at(2026, 11, 6, 13),
      count: 4,
    })
    expect(lastOccurrenceBetween(hourly, at(2026, 11, 6, 14), at(2026, 11, 6, 13, 20))).toBeUndefined()
  })
})
