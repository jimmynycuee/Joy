import { describe, expect, it } from 'vitest'
import { followSettings, pickEffort, pickModel } from './composer-choice.js'
import type { RoleDefaults } from './composer-choice.js'
import { parsePendingSettings, settingsLine, settingsRequest, taskChoice } from './task-settings.js'

const defaults: RoleDefaults = {
  implementer: { provider: 'claude-cli', model: 'opus', effort: 'medium' },
  reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
}
const SONNET = { provider: 'claude-cli' as const, model: 'sonnet' }

describe('taskChoice', () => {
  it("starts from the task's models, mode and permission mode", () => {
    const choice = taskChoice(
      { mode: 'review_loop', roleOverrides: { implementer: { ...SONNET, effort: 'high' } } },
      defaults,
      'auto',
    )
    expect(choice).toEqual({
      models: { implementer: { ...SONNET, effort: 'high' } },
      mode: 'review_loop',
      planFirst: false,
      permissionMode: 'auto',
    })
  })

  it('shows a change that still waits for the run to end', () => {
    const choice = taskChoice({ mode: 'single', roleOverrides: {} }, defaults, 'ask', {
      mode: 'review_loop',
      permissionMode: 'full',
      roleOverrides: { reviewer: { provider: 'claude-cli', model: 'opus', effort: 'high' } },
    })
    expect(choice).toMatchObject({
      mode: 'review_loop',
      permissionMode: 'full',
      models: { reviewer: { provider: 'claude-cli', model: 'opus', effort: 'high' } },
    })
  })

  it('treats overrides equal to Settings as following Settings', () => {
    expect(
      taskChoice({ mode: 'single', roleOverrides: { implementer: defaults.implementer } }, defaults, 'ask')
        .models,
    ).toEqual({})
  })
})

describe('settingsRequest', () => {
  const initial = taskChoice({ mode: 'single', roleOverrides: {} }, defaults, 'auto')

  it('is empty when nothing changed', () => {
    expect(settingsRequest(initial, initial, defaults)).toEqual({})
  })

  it('sends only what changed, models resolved with their effort', () => {
    const picked = pickModel(initial, 'implementer', SONNET, defaults)
    expect(settingsRequest(initial, picked, defaults)).toEqual({
      roleOverrides: { implementer: { ...SONNET, effort: 'medium' } },
    })
    const effort = pickEffort(initial, 'implementer', 'high', defaults)
    expect(settingsRequest(initial, effort, defaults)).toEqual({
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' } },
    })
    expect(
      settingsRequest(initial, { ...initial, mode: 'review_loop', permissionMode: 'full' }, defaults),
    ).toEqual({
      mode: 'review_loop',
      permissionMode: 'full',
    })
  })

  it('never asks for compete', () => {
    expect(settingsRequest(initial, { ...initial, mode: 'compete' }, defaults)).toEqual({})
  })

  it('sends the Settings models when the owner goes back to 照設定', () => {
    const custom = taskChoice({ mode: 'single', roleOverrides: { implementer: SONNET } }, defaults, 'auto')
    expect(settingsRequest(custom, followSettings(custom), defaults)).toEqual({
      roleOverrides: { implementer: defaults.implementer },
    })
  })
})

describe('parsePendingSettings', () => {
  it('reads what the server sends and drops anything else', () => {
    expect(parsePendingSettings(null)).toBeNull()
    expect(parsePendingSettings(undefined)).toBeNull()
    expect(parsePendingSettings({ mode: 'compete', permissionMode: 'root' })).toBeNull()
    expect(
      parsePendingSettings({
        mode: 'single',
        permissionMode: 'ask',
        roleOverrides: { implementer: SONNET, judge: 1 },
      }),
    ).toEqual({ mode: 'single', permissionMode: 'ask', roleOverrides: { implementer: SONNET } })
  })
})

describe('settingsLine', () => {
  it('names the new model and mode briefly', () => {
    expect(
      settingsLine({
        implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' },
        mode: 'review_loop',
      }),
    ).toBe('改用 Opus · 實作＋審查')
    expect(settingsLine({ reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol' } })).toBe('改用 Sol 審查')
    expect(settingsLine({ mode: 'single' })).toBe('改成單人')
    expect(settingsLine({ permissionMode: 'full' })).toBe('改成完整存取')
    expect(settingsLine({})).toBe('設定已更新')
  })
})
