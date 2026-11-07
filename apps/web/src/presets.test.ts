import { EFFORTS, PROVIDER_KINDS, ROLES } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { MODEL_PRESETS, findPreset, matchingPreset, matchingTaskPreset } from './presets.js'

describe('model presets', () => {
  it('fill all six roles with valid providers and efforts', () => {
    for (const preset of MODEL_PRESETS) {
      for (const role of ROLES) {
        const model = preset.roles[role]
        expect(PROVIDER_KINDS).toContain(model.provider)
        expect(model.model.length).toBeGreaterThan(0)
        expect(EFFORTS).toContain(model.effort)
      }
      // The implementer edits code, which the OpenAI API cannot do.
      expect(preset.roles.implementer.provider).not.toBe('openai-api')
    }
  })

  it('are told apart and found by id', () => {
    expect(new Set(MODEL_PRESETS.map((preset) => preset.id)).size).toBe(MODEL_PRESETS.length)
    expect(findPreset('saver')?.label).toBe('省額度')
    expect(findPreset('nope')).toBeUndefined()
  })

  it('are recognised when a config matches one exactly', () => {
    const saver = findPreset('saver')
    expect(matchingPreset(saver?.roles)?.id).toBe('saver')
    expect(
      matchingPreset({ ...saver?.roles, judge: { provider: 'claude-cli', model: 'opus' } }),
    ).toBeUndefined()
    expect(matchingPreset(undefined)).toBeUndefined()
  })

  it('are recognised from a task-level implementer and reviewer pair', () => {
    const max = findPreset('max')
    expect(max && matchingTaskPreset(max.roles.implementer, max.roles.reviewer)?.id).toBe('max')
    expect(
      matchingTaskPreset(
        { provider: 'claude-cli', model: 'opus', effort: 'low' },
        max?.roles.reviewer ?? { provider: 'codex-cli', model: 'x' },
      ),
    ).toBeUndefined()
  })
})
