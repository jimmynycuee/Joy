import { PROVIDER_KINDS } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { MODEL_SUGGESTIONS } from './labels.js'
import {
  IMPLEMENTER_MODELS,
  MODEL_CATALOG,
  findCatalogModel,
  modelLabel,
  modelShort,
  sameModelName,
} from './models.js'

describe('model catalog', () => {
  it('has one entry per provider and model, with texts for every menu', () => {
    const keys = MODEL_CATALOG.map((entry) => `${entry.provider}:${entry.model}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of MODEL_CATALOG) {
      expect(PROVIDER_KINDS).toContain(entry.provider)
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.short.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  it('offers only models that can edit code to the implementer, never the OpenAI API', () => {
    expect(IMPLEMENTER_MODELS.map((entry) => entry.model)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ])
    expect(IMPLEMENTER_MODELS.every((entry) => entry.provider !== 'openai-api')).toBe(true)
  })

  it('names models, falling back to the raw name for one that is set by hand', () => {
    expect(modelLabel({ provider: 'claude-cli', model: 'opus' })).toBe('Opus 5.5')
    expect(modelShort({ provider: 'codex-cli', model: 'gpt-6.1-sol' })).toBe('Sol')
    expect(modelLabel({ provider: 'claude-cli', model: 'claude-opus-4-6' })).toBe('claude-opus-4-6')
    expect(modelShort({ provider: 'claude-cli', model: 'my-model' })).toBe('my-model')
    // The same model name under another provider is another model.
    expect(findCatalogModel({ provider: 'codex-cli', model: 'opus' })).toBeUndefined()
    expect(findCatalogModel(undefined)).toBeUndefined()
  })

  it('compares by provider and model', () => {
    expect(
      sameModelName({ provider: 'claude-cli', model: 'opus' }, { provider: 'claude-cli', model: 'opus' }),
    ).toBe(true)
    expect(
      sameModelName({ provider: 'claude-cli', model: 'opus' }, { provider: 'codex-cli', model: 'opus' }),
    ).toBe(false)
    expect(sameModelName(undefined, undefined)).toBe(false)
  })

  it('feeds the model suggestions in Settings, in catalog order', () => {
    expect(MODEL_SUGGESTIONS['claude-cli']).toEqual(['opus', 'sonnet', 'haiku'])
    expect(MODEL_SUGGESTIONS['codex-cli']).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
    expect(MODEL_SUGGESTIONS['openai-api'][0]).toBe('gpt-6-luna')
  })
})
