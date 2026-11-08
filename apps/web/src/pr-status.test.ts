import { describe, expect, it } from 'vitest'
import { checksSummary, ciFixMessage, parsePrStatus, prStateLabel, shouldPollPr } from './pr-status.js'

const raw = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: true,
  checks: { passing: 3, failing: 1, pending: 2, failingNames: ['windows', 'lint'] },
  fetchedAt: '2026-11-08T10:00:00.000Z',
  ...overrides,
})

describe('parsePrStatus', () => {
  it('reads a status and normalises the state', () => {
    expect(parsePrStatus(raw({ state: 'merged' }))).toMatchObject({
      state: 'MERGED',
      isDraft: true,
      checks: { passing: 3, failing: 1, pending: 2, failingNames: ['windows', 'lint'] },
    })
  })

  it('returns null for anything else, and tolerates missing checks', () => {
    expect(parsePrStatus({})).toBeNull()
    expect(parsePrStatus(null)).toBeNull()
    expect(parsePrStatus(raw({ checks: undefined }))?.checks).toEqual({
      passing: 0,
      failing: 0,
      pending: 0,
      failingNames: [],
    })
  })
})

describe('prStateLabel', () => {
  it('names draft, open, merged and closed', () => {
    expect(prStateLabel({ state: 'OPEN', isDraft: true })).toBe('Draft')
    expect(prStateLabel({ state: 'OPEN', isDraft: false })).toBe('已開啟')
    expect(prStateLabel({ state: 'MERGED', isDraft: false })).toBe('已合併')
    expect(prStateLabel({ state: 'CLOSED', isDraft: true })).toBe('已關閉')
  })
})

describe('checksSummary', () => {
  it('counts passing, failing and pending, leaving out zeros', () => {
    expect(checksSummary({ passing: 3, failing: 1, pending: 2, failingNames: [] })).toBe(
      '通過 3 / 失敗 1 / 進行中 2',
    )
    expect(checksSummary({ passing: 4, failing: 0, pending: 0, failingNames: [] })).toBe('通過 4')
    expect(checksSummary({ passing: 0, failing: 0, pending: 0, failingNames: [] })).toBe('')
  })
})

describe('shouldPollPr', () => {
  const status = (overrides: Record<string, unknown>) => parsePrStatus(raw(overrides))
  it('keeps polling until the PR is settled', () => {
    expect(shouldPollPr(null)).toBe(true)
    expect(shouldPollPr(status({}))).toBe(true)
    expect(shouldPollPr(status({ checks: { passing: 0, failing: 0, pending: 0, failingNames: [] } }))).toBe(
      true,
    )
  })

  it('stops when merged, closed or every check finished', () => {
    expect(shouldPollPr(status({ state: 'MERGED' }))).toBe(false)
    expect(shouldPollPr(status({ state: 'CLOSED' }))).toBe(false)
    expect(
      shouldPollPr(status({ checks: { passing: 2, failing: 1, pending: 0, failingNames: ['x'] } })),
    ).toBe(false)
  })
})

describe('ciFixMessage', () => {
  it('lists the failing check names', () => {
    expect(ciFixMessage(['windows', 'lint'])).toContain('windows、lint')
    expect(ciFixMessage([])).toContain('CI 有檢查失敗')
  })
})
