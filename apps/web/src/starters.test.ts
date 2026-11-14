import { describe, expect, it } from 'vitest'
import { visibleStarters } from './starters.js'

describe('visibleStarters', () => {
  it('shows nothing once any task exists, archived or not', () => {
    expect(visibleStarters(true, 'https://github.com/o/r.git')).toEqual([])
    expect(visibleStarters(true, undefined)).toEqual([])
  })

  it('offers the three plain starters when there are no tasks and the project has no GitHub address', () => {
    expect(visibleStarters(false, undefined).map((starter) => starter.label)).toEqual([
      '修一個 bug',
      '補測試',
      '解釋這段程式',
    ])
    expect(visibleStarters(false, '  ')).toHaveLength(3)
  })

  it('adds the GitHub issue starter only with a GitHub address', () => {
    const labels = visibleStarters(false, 'https://github.com/o/r.git').map((starter) => starter.label)
    expect(labels).toHaveLength(4)
    expect(labels.at(-1)).toBe('從 GitHub issue 開始')
  })
})
