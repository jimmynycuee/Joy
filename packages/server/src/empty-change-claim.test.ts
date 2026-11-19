import { describe, expect, it } from 'vitest'
import { claimsChangesWithoutAny } from './empty-change-claim.js'

const base = { fileChangeEvents: 0, diffFiles: 0 }

describe('claimsChangesWithoutAny', () => {
  it('flags a claim of edits when nothing changed', () => {
    expect(claimsChangesWithoutAny({ ...base, finalMessage: '已修正 math.js' })).toBe(true)
    expect(claimsChangesWithoutAny({ ...base, finalMessage: 'I fixed the add function.' })).toBe(true)
    expect(claimsChangesWithoutAny({ ...base, finalMessage: 'See src/math.ts for details' })).toBe(true)
  })

  it('stays quiet when something changed or a file_change was reported', () => {
    expect(claimsChangesWithoutAny({ ...base, diffFiles: 1, finalMessage: '已修正 math.js' })).toBe(false)
    expect(claimsChangesWithoutAny({ ...base, fileChangeEvents: 2, finalMessage: '已修正 math.js' })).toBe(
      false,
    )
  })

  it('stays quiet for answers that do not claim edits', () => {
    expect(claimsChangesWithoutAny({ ...base, finalMessage: '這個專案用 pnpm。' })).toBe(false)
    expect(claimsChangesWithoutAny({ ...base, finalMessage: undefined })).toBe(false)
  })
})
