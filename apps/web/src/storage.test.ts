import { describe, expect, it } from 'vitest'
import { parseLegacyArchivedIds } from './storage.js'

describe('parseLegacyArchivedIds', () => {
  it('reads the ids the old client-side archive saved', () => {
    expect(parseLegacyArchivedIds('["a","b"]')).toEqual(['a', 'b'])
  })

  it('treats missing or damaged values as empty', () => {
    expect(parseLegacyArchivedIds(null)).toEqual([])
    expect(parseLegacyArchivedIds('not json')).toEqual([])
    expect(parseLegacyArchivedIds('{"a":1}')).toEqual([])
    expect(parseLegacyArchivedIds('["a",3,null]')).toEqual(['a'])
  })
})
