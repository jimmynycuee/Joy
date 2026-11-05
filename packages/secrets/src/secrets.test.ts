import { describe, expect, it } from 'vitest'
import { REDACTED, Redactor } from './redact.js'
import { KeychainBackend, MemoryBackend, SecretStore } from './store.js'
import type { SecretName } from './store.js'

describe('SecretStore', () => {
  it('stores, reads and deletes through the backend', async () => {
    const backend = new MemoryBackend()
    const store = new SecretStore({ backend, env: {} })
    expect(await store.get('openai_api_key')).toBeNull()
    await store.set('openai_api_key', '  sk-test-1234567890  ')
    expect(backend.values.get('openai_api_key')).toBe('sk-test-1234567890')
    expect(await store.get('openai_api_key')).toBe('sk-test-1234567890')
    expect(await store.status('openai_api_key')).toEqual({ set: true, source: 'keychain' })
    expect(await store.delete('openai_api_key')).toBe(true)
    expect(await store.status('openai_api_key')).toEqual({ set: false })
  })

  it('prefers the environment variable over the keychain', async () => {
    const backend = new MemoryBackend()
    await backend.set('openai_api_key', 'from-keychain-123')
    const seen: string[] = []
    const store = new SecretStore({
      backend,
      env: { OPENAI_API_KEY: 'from-env-12345' },
      onSecret: (value) => seen.push(value),
    })
    expect(await store.get('openai_api_key')).toBe('from-env-12345')
    expect(await store.status('openai_api_key')).toEqual({ set: true, source: 'env' })
    expect(seen).toEqual(['from-env-12345', 'from-env-12345'])
  })

  it('registers every value it touches for redaction', async () => {
    const seen: string[] = []
    const store = new SecretStore({ backend: new MemoryBackend(), env: {}, onSecret: (v) => seen.push(v) })
    await store.set('telegram_bot_token', 'token-value-1')
    await store.get('telegram_bot_token')
    await store.status('telegram_bot_token')
    expect(seen).toEqual(['token-value-1', 'token-value-1', 'token-value-1'])
  })

  it('rejects secrets too short for the redactor, including legacy and environment values', async () => {
    const backend = new MemoryBackend()
    const seen: string[] = []
    const store = new SecretStore({ backend, env: {}, onSecret: (value) => seen.push(value) })
    await expect(store.set('openai_api_key', 'short')).rejects.toThrow(/at least 8 characters/)
    expect(backend.values.has('openai_api_key')).toBe(false)

    await backend.set('openai_api_key', 'short')
    await expect(store.get('openai_api_key')).rejects.toThrow(/at least 8 characters/)
    await expect(store.status('openai_api_key')).rejects.toThrow(/at least 8 characters/)

    const envStore = new SecretStore({ backend, env: { OPENAI_API_KEY: 'short' } })
    await expect(envStore.get('openai_api_key')).rejects.toThrow(/at least 8 characters/)
    await expect(envStore.status('openai_api_key')).rejects.toThrow(/at least 8 characters/)
    expect(seen).toEqual([])
  })

  it('rejects empty values and unknown names', async () => {
    const store = new SecretStore({ backend: new MemoryBackend(), env: {} })
    await expect(store.set('openai_api_key', '   ')).rejects.toThrow(/empty/)
    await expect(store.get('github_token' as SecretName)).rejects.toThrow(/Unknown secret/)
  })

  it('explains how to fix an unavailable keychain', async () => {
    const broken = new KeychainBackend('joy', () => ({
      getPassword: () => Promise.reject(new Error('AccessDenied')),
      setPassword: () => Promise.reject(new Error('AccessDenied')),
      deletePassword: () => Promise.reject(new Error('AccessDenied')),
    }))
    const store = new SecretStore({ backend: broken, env: {} })
    await expect(store.get('openai_api_key')).rejects.toThrow(/OS keychain.*AccessDenied.*OPENAI_API_KEY/s)
    // The env override still works without a keychain.
    expect(
      await new SecretStore({ backend: broken, env: { OPENAI_API_KEY: 'k-123456789' } }).get(
        'openai_api_key',
      ),
    ).toBe('k-123456789')
  })

  it('defaults to the OS keychain backend', () => {
    expect(new SecretStore()['backend']).toBeInstanceOf(KeychainBackend)
  })
})

describe('Redactor', () => {
  it('removes registered secrets from text and nested values', () => {
    const r = new Redactor()
    r.add('my-very-secret-value')
    expect(r.redact('key=my-very-secret-value;')).toBe(`key=${REDACTED};`)
    expect(r.redactValue({ a: ['x my-very-secret-value'], n: 1, b: { c: 'my-very-secret-value' } })).toEqual({
      a: [`x ${REDACTED}`],
      n: 1,
      b: { c: REDACTED },
    })
  })

  it('ignores very short values that would wreck normal text', () => {
    const r = new Redactor()
    r.add('abc')
    expect(r.redact('abcdef')).toBe('abcdef')
  })

  it('scrubs well-known token shapes it was never told about', () => {
    const r = new Redactor()
    const text = ['sk-proj-' + 'a'.repeat(40), 'ghp_' + 'b'.repeat(36), '123456789:' + 'C'.repeat(35)].join(
      ' ',
    )
    expect(r.redact(text)).toBe([REDACTED, REDACTED, REDACTED].join(' '))
  })
})

// Touches the real OS keychain. Opt-in: JOY_E2E_KEYCHAIN=1
describe.runIf(process.env.JOY_E2E_KEYCHAIN === '1')('KeychainBackend (real keychain)', () => {
  it('round-trips a value', async () => {
    const backend = new KeychainBackend('joy-test')
    await backend.set('probe', 'value-123')
    expect(await backend.get('probe')).toBe('value-123')
    expect(await backend.delete('probe')).toBe(true)
    expect(await backend.get('probe')).toBeNull()
  })
})
