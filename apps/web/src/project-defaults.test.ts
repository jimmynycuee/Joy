import { describe, expect, it } from 'vitest'
import { EMPTY_CHOICE } from './composer-choice.js'
import type { ComposerChoice, RoleDefaults } from './composer-choice.js'
import {
  applyProjectDefaults,
  buildDefaults,
  defaultsForm,
  refKey,
  sameDefaults,
} from './project-defaults.js'
import type { ProjectDefaults } from './types.js'

const roleDefaults: RoleDefaults = {
  implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' },
  reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
}
const lastChoice: ComposerChoice = {
  models: { implementer: { provider: 'claude-cli', model: 'sonnet', effort: 'low' } },
  mode: 'single',
  planFirst: true,
  permissionMode: 'full',
}

describe('applyProjectDefaults', () => {
  it('keeps the owner’s last choice when the project has no defaults', () => {
    expect(applyProjectDefaults(lastChoice, undefined, roleDefaults, undefined)).toBe(lastChoice)
    expect(applyProjectDefaults(lastChoice, {}, roleDefaults, undefined)).toEqual(lastChoice)
  })

  it('replaces only what the project has a default for', () => {
    const next = applyProjectDefaults(
      lastChoice,
      { reviewer: { provider: 'claude-cli', model: 'haiku', effort: 'low' }, mode: 'review_loop' },
      roleDefaults,
      undefined,
    )
    expect(next.models).toEqual({
      implementer: { provider: 'claude-cli', model: 'sonnet', effort: 'low' },
      reviewer: { provider: 'claude-cli', model: 'haiku', effort: 'low' },
    })
    expect(next.mode).toBe('review_loop')
    expect(next.planFirst).toBe(true)
    expect(next.permissionMode).toBe('full')
  })

  it('a default equal to what Settings uses means "follows Settings", replacing an earlier pick', () => {
    const next = applyProjectDefaults(
      lastChoice,
      { implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' } },
      roleDefaults,
      undefined,
    )
    expect(next.models.implementer).toBeUndefined()
  })

  it('gives a model without an effort the one it starts from anyway', () => {
    const sameAsSettings = applyProjectDefaults(
      EMPTY_CHOICE,
      { implementer: { provider: 'claude-cli', model: 'opus' } },
      roleDefaults,
      undefined,
    )
    // Settings' own effort for the same model: nothing to pick, it follows Settings.
    expect(sameAsSettings.models.implementer).toBeUndefined()
    const other = applyProjectDefaults(
      EMPTY_CHOICE,
      { implementer: { provider: 'codex-cli', model: 'gpt-6-luna' } },
      roleDefaults,
      undefined,
    )
    expect(other.models.implementer).toEqual({ provider: 'codex-cli', model: 'gpt-6-luna', effort: 'medium' })
  })

  it('lowers a permission mode above the project maximum', () => {
    expect(
      applyProjectDefaults(EMPTY_CHOICE, { permissionMode: 'full' }, roleDefaults, 'auto').permissionMode,
    ).toBe('auto')
    expect(
      applyProjectDefaults(EMPTY_CHOICE, { permissionMode: 'ask' }, roleDefaults, 'auto').permissionMode,
    ).toBe('ask')
    expect(
      applyProjectDefaults(EMPTY_CHOICE, { permissionMode: 'full' }, roleDefaults, undefined).permissionMode,
    ).toBe('full')
  })

  it('does not change its input', () => {
    const before = JSON.stringify(lastChoice)
    applyProjectDefaults(lastChoice, { mode: 'compete', permissionMode: 'ask' }, roleDefaults, undefined)
    expect(JSON.stringify(lastChoice)).toBe(before)
  })
})

describe('the settings form', () => {
  const stored: ProjectDefaults = {
    implementer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
    mode: 'single',
  }

  it('round-trips, keeping the effort of a model that was not changed', () => {
    expect(buildDefaults(defaultsForm(stored), stored)).toEqual(stored)
    expect(sameDefaults(buildDefaults(defaultsForm(stored), stored), stored)).toBe(true)
  })

  it('a changed model loses its old effort; an empty field leaves the default out', () => {
    const form = { ...defaultsForm(stored), implementer: refKey({ provider: 'claude-cli', model: 'haiku' }) }
    expect(buildDefaults(form, stored)).toEqual({
      implementer: { provider: 'claude-cli', model: 'haiku' },
      mode: 'single',
    })
    expect(buildDefaults({ ...defaultsForm(stored), implementer: '', mode: '' }, stored)).toEqual({})
  })

  it('an empty form is no defaults at all', () => {
    expect(buildDefaults(defaultsForm(undefined), undefined)).toEqual({})
    expect(sameDefaults({}, undefined)).toBe(true)
  })

  it('sees an effort or permission difference', () => {
    const higher: ProjectDefaults = {
      ...stored,
      implementer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'high' },
    }
    expect(sameDefaults(stored, higher)).toBe(false)
    expect(sameDefaults(stored, { ...stored, permissionMode: 'auto' })).toBe(false)
  })
})
