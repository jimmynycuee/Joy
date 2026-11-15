import { describe, expect, it } from 'vitest'
import { composerHeight, composerMaxHeight } from './composer-height.js'

describe('composerMaxHeight', () => {
  it('is 12 lines on a tall window', () => {
    expect(composerMaxHeight(24, 4, 2000)).toBe(24 * 12 + 4)
  })

  it('is 40% of a short window', () => {
    expect(composerMaxHeight(24, 4, 500)).toBe(200)
  })

  it('still fits one line on a tiny window', () => {
    expect(composerMaxHeight(24, 4, 20)).toBe(28)
  })
})

describe('composerHeight', () => {
  it('fits the text without a scrollbar below the limit', () => {
    expect(composerHeight(28, 292)).toEqual({ height: 28, overflowY: 'hidden' })
    expect(composerHeight(292, 292)).toEqual({ height: 292, overflowY: 'hidden' })
  })

  it('stops at the limit and scrolls', () => {
    expect(composerHeight(900, 292)).toEqual({ height: 292, overflowY: 'auto' })
  })
})
