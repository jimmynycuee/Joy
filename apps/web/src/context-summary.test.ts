import { describe, expect, it } from 'vitest'
import { contextDividerIndex, parseConversationContext } from './context-summary.js'

describe('parseConversationContext', () => {
  it('needs both the summary and the message it covers up to', () => {
    expect(parseConversationContext({ contextSummary: 'Chose SQLite.', contextThrough: 6 })).toEqual({
      summary: 'Chose SQLite.',
      through: 6,
    })
    expect(parseConversationContext({ contextSummary: 'Chose SQLite.' })).toBeUndefined()
    expect(parseConversationContext({ contextSummary: '', contextThrough: 6 })).toBeUndefined()
    expect(parseConversationContext({ contextSummary: 1, contextThrough: 6 })).toBeUndefined()
    expect(parseConversationContext(undefined)).toBeUndefined()
  })
})

describe('contextDividerIndex', () => {
  it('goes after the last covered message, even when that one is not shown', () => {
    const messages = [{ id: 1 }, { id: 2 }, { id: 4 }, { id: 5 }]
    expect(contextDividerIndex(messages, 2)).toBe(1)
    expect(contextDividerIndex(messages, 3)).toBe(1)
    expect(contextDividerIndex(messages, 5)).toBe(3)
    expect(contextDividerIndex(messages, 0)).toBe(-1)
  })

  it('never counts a message that is still on its way to the server', () => {
    expect(contextDividerIndex([{ id: 1 }, { id: -1_700_000_000_000 }], 3)).toBe(0)
  })
})
