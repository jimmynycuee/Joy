import { defaultConfig } from '@joy/config'
import type { ModelRef } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { smallChangeReviewer } from './review-strength.js'

const review = defaultConfig().review
const codex: ModelRef = { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' }

describe('smallChangeReviewer', () => {
  it('uses the same model at low effort for changes up to 20 lines by default', () => {
    expect(smallChangeReviewer(codex, review)).toEqual({
      model: { ...codex, effort: 'low' },
      maxChangedLines: 20,
    })
    expect(smallChangeReviewer({ provider: 'codex-cli', model: 'gpt-6.1-sol' }, review)?.model.effort).toBe(
      'low',
    )
  })

  it('stays off when turned off, when it would not be lighter, or when the model does not take that effort', () => {
    expect(smallChangeReviewer(codex, { ...review, small_change_max_lines: 0 })).toBeUndefined()
    expect(smallChangeReviewer({ ...codex, effort: 'low' }, review)).toBeUndefined()
    expect(smallChangeReviewer(codex, { ...review, small_change_effort: 'high' })).toBeUndefined()
    expect(
      smallChangeReviewer({ provider: 'codex-cli', model: 'unknown-model', effort: 'high' }, review),
    ).toBeUndefined()
  })
})
