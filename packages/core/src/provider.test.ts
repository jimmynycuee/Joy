import { describe, expect, it } from 'vitest'
import { formatModelRef, isProviderKind, parseModelRef } from './provider.js'

describe('isProviderKind', () => {
  it('accepts known providers', () => {
    expect(isProviderKind('claude-cli')).toBe(true)
    expect(isProviderKind('codex-cli')).toBe(true)
    expect(isProviderKind('openai-api')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isProviderKind('gemini')).toBe(false)
    expect(isProviderKind(42)).toBe(false)
  })
})

describe('parseModelRef', () => {
  it('parses provider:model', () => {
    expect(parseModelRef('claude-cli:opus')).toEqual({ provider: 'claude-cli', model: 'opus' })
  })

  it('keeps colons inside the model name', () => {
    expect(parseModelRef('openai-api:ft:gpt:abc')).toEqual({ provider: 'openai-api', model: 'ft:gpt:abc' })
  })

  it('returns null for malformed input', () => {
    expect(parseModelRef('opus')).toBeNull()
    expect(parseModelRef(':opus')).toBeNull()
    expect(parseModelRef('claude-cli:')).toBeNull()
    expect(parseModelRef('unknown:model')).toBeNull()
  })

  it('round-trips with formatModelRef', () => {
    const ref = parseModelRef('codex-cli:gpt-5-codex')
    expect(ref && formatModelRef(ref)).toBe('codex-cli:gpt-5-codex')
  })
})
