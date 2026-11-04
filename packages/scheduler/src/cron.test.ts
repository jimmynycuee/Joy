import { describe, expect, it } from 'vitest'
import { nextCronOccurrence, validateCron } from './cron.js'

describe('UTC cron expressions', () => {
  it('supports five fields, lists, ranges, and steps', () => {
    expect(validateCron('  */5   8-10  *  *  1-5 ')).toBe('*/5 8-10 * * 1-5')
    expect(nextCronOccurrence('*/5 * * * *', new Date('2026-11-04T10:02:00.000Z'))).toBe(
      '2026-11-04T10:05:00.000Z',
    )
    expect(nextCronOccurrence('0 9 * * 1-5', new Date('2026-11-06T09:00:00.000Z'))).toBe(
      '2026-11-09T09:00:00.000Z',
    )
  })

  it('rejects unsupported or malformed expressions', () => {
    for (const expression of ['', '* * * *', '60 * * * *', '0 9 ? * *', '*/0 * * * *']) {
      expect(() => validateCron(expression)).toThrow()
    }
  })
})
