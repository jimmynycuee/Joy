import { describe, expect, it } from 'vitest'
import { maxEventSequence } from './event-sequence.js'

describe('maxEventSequence', () => {
  it('finds the highest sequence in a replay larger than the argument limit', () => {
    const events = Array.from({ length: 150_000 }, (_, index) => ({ seq: index + 1 }))
    expect(maxEventSequence(events)).toBe(150_000)
  })
})
