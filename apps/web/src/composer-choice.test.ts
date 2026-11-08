import type { ModelRef } from '@joy/core'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_CHOICE,
  applyAllowlist,
  applyPreset,
  buildRoleOverrides,
  comboSummary,
  defaultEffortFor,
  fitEffort,
  followSettings,
  modeSummary,
  modelButtonText,
  normalizeModels,
  parseStoredChoice,
  pickEffort,
  pickModel,
  planFirstDisabledReason,
  providerBlockedReason,
  resetEffort,
  resolveModels,
  serializeChoice,
  setRoleModel,
  validMode,
} from './composer-choice.js'
import type { ComposerChoice, RoleDefaults } from './composer-choice.js'
import { findPreset } from './presets.js'

const defaults: RoleDefaults = {
  implementer: { provider: 'claude-cli', model: 'opus', effort: 'medium' },
  reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
}
const sol = { provider: 'codex-cli', model: 'gpt-6.1-sol' } as const
const opus = { provider: 'claude-cli', model: 'opus' } as const
const haiku = { provider: 'claude-cli', model: 'haiku' } as const

describe('resolving what a task will use', () => {
  it('follows Settings until something is picked', () => {
    const resolved = resolveModels({}, defaults)
    expect(resolved.implementer).toEqual({ ref: defaults.implementer, isDefault: true })
    expect(resolved.reviewer).toEqual({ ref: defaults.reviewer, isDefault: true })
  })

  it('shows a pick, and treats a pick equal to Settings as following Settings', () => {
    const picked: ModelRef = { provider: 'claude-cli', model: 'haiku', effort: 'low' }
    expect(resolveModels({ implementer: picked }, defaults).implementer).toEqual({
      ref: picked,
      isDefault: false,
    })
    expect(resolveModels({ implementer: picked }, defaults).reviewer.isDefault).toBe(true)
    expect(resolveModels({ implementer: defaults.implementer }, defaults).implementer.isDefault).toBe(true)
    expect(normalizeModels({ implementer: defaults.implementer }, defaults)).toEqual({})
  })
})

describe('picking a model', () => {
  it('keeps the effort in use when the new model takes it', () => {
    const next = pickModel(EMPTY_CHOICE, 'implementer', haiku, defaults)
    expect(next.models).toEqual({ implementer: { provider: 'claude-cli', model: 'haiku', effort: 'medium' } })
  })

  it('moves an effort the new model does not take to the nearest one it does', () => {
    const maxed: ComposerChoice = {
      ...EMPTY_CHOICE,
      models: { implementer: { provider: 'claude-cli', model: 'opus', effort: 'max' } },
    }
    expect(
      pickModel(maxed, 'implementer', { provider: 'codex-cli', model: 'gpt-6-luna' }, defaults).models
        .implementer,
    ).toEqual({ provider: 'codex-cli', model: 'gpt-6-luna', effort: 'xhigh' })
  })

  it('does nothing when the model is already the one in use', () => {
    expect(pickModel(EMPTY_CHOICE, 'implementer', opus, defaults)).toBe(EMPTY_CHOICE)
  })

  it('goes back to following Settings when the pick lands on Settings exactly', () => {
    const picked = pickModel(EMPTY_CHOICE, 'implementer', haiku, defaults)
    expect(pickModel(picked, 'implementer', opus, defaults).models).toEqual({})
  })

  it('changes only the role it was asked about', () => {
    const next = pickModel(EMPTY_CHOICE, 'reviewer', { provider: 'claude-cli', model: 'sonnet' }, defaults)
    expect(Object.keys(next.models)).toEqual(['reviewer'])
    const both = pickModel(next, 'implementer', haiku, defaults)
    expect(both.models.reviewer).toEqual(next.models.reviewer)
  })
})

describe('picking an effort', () => {
  it('records the whole model with the new effort, so the server needs nothing else', () => {
    expect(pickEffort(EMPTY_CHOICE, 'implementer', 'high', defaults).models).toEqual({
      implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' },
    })
  })

  it('ignores an effort the model does not take', () => {
    const luna: ComposerChoice = {
      ...EMPTY_CHOICE,
      models: { implementer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' } },
    }
    expect(pickEffort(luna, 'implementer', 'max', defaults)).toBe(luna)
  })

  it('follows Settings again when the effort lands on the default', () => {
    const high = pickEffort(EMPTY_CHOICE, 'implementer', 'high', defaults)
    expect(pickEffort(high, 'implementer', 'medium', defaults).models).toEqual({})
  })

  it('resets to Settings own effort for the same model, else to medium', () => {
    const high = pickEffort(EMPTY_CHOICE, 'implementer', 'high', defaults)
    expect(resetEffort(high, 'implementer', defaults).models).toEqual({})
    const sonnetMax = setRoleModel(
      EMPTY_CHOICE,
      'implementer',
      { provider: 'claude-cli', model: 'sonnet', effort: 'max' },
      defaults,
    )
    expect(resetEffort(sonnetMax, 'implementer', defaults).models.implementer).toEqual({
      provider: 'claude-cli',
      model: 'sonnet',
      effort: 'medium',
    })
    // Settings with no effort at all: resetting means no effort again.
    const noEffort: RoleDefaults = { ...defaults, implementer: { provider: 'claude-cli', model: 'opus' } }
    expect(
      defaultEffortFor({ provider: 'claude-cli', model: 'opus', effort: 'high' }, noEffort, 'implementer'),
    ).toBeUndefined()
  })

  it('leaves out effort for a model nobody has validated', () => {
    expect(fitEffort('claude-cli', 'made-up', 'high')).toEqual({ provider: 'claude-cli', model: 'made-up' })
    expect(fitEffort('claude-cli', 'opus', undefined)).toEqual({ provider: 'claude-cli', model: 'opus' })
  })
})

describe('quick apply', () => {
  it('sets the implementer and the reviewer from a preset and nothing else', () => {
    const saver = findPreset('saver')
    expect(saver).toBeDefined()
    if (!saver) return
    const next = applyPreset({ ...EMPTY_CHOICE, mode: 'compete', planFirst: true }, saver, defaults)
    expect(next.models).toEqual({
      implementer: saver.roles.implementer,
      reviewer: saver.roles.reviewer,
    })
    expect(next.mode).toBe('compete')
    expect(next.planFirst).toBe(true)
  })

  it('goes back to following Settings', () => {
    const balanced = findPreset('max')
    if (!balanced) throw new Error('missing preset')
    expect(followSettings(applyPreset(EMPTY_CHOICE, balanced, defaults)).models).toEqual({})
  })
})

describe('what a repository allows', () => {
  it('words the reason in Chinese, naming the provider', () => {
    expect(providerBlockedReason('codex-cli', ['claude-cli'])).toContain('Codex')
    expect(providerBlockedReason('claude-cli', ['claude-cli'])).toBeUndefined()
    expect(providerBlockedReason('codex-cli', undefined)).toBeUndefined()
  })

  it('leaves out picks from a provider the repository does not allow', () => {
    const choice: ComposerChoice = {
      ...EMPTY_CHOICE,
      models: { implementer: { ...haiku, effort: 'low' }, reviewer: { ...sol, effort: 'low' } },
    }
    expect(applyAllowlist(choice, ['claude-cli']).models).toEqual({
      implementer: { ...haiku, effort: 'low' },
    })
    expect(applyAllowlist(choice, undefined).models).toEqual(choice.models)
  })
})

describe('what is sent to the server', () => {
  it('sends nothing when every role follows Settings', () => {
    expect(buildRoleOverrides(EMPTY_CHOICE, 'review_loop')).toBeUndefined()
  })

  it('sends only the roles that were picked: never the orchestrator, never a role that was not touched', () => {
    const effortOnly = pickEffort(EMPTY_CHOICE, 'implementer', 'high', defaults)
    expect(buildRoleOverrides(effortOnly, 'review_loop')).toEqual({
      implementer: { provider: 'claude-cli', model: 'opus', effort: 'high' },
    })
    const reviewerOnly = pickModel(EMPTY_CHOICE, 'reviewer', haiku, defaults)
    expect(buildRoleOverrides(reviewerOnly, 'review_loop')).toEqual({
      reviewer: { provider: 'claude-cli', model: 'haiku', effort: 'medium' },
    })
  })

  it('leaves the reviewer out when the mode has none, and everything out for a custom workflow', () => {
    const both = pickModel(
      pickModel(EMPTY_CHOICE, 'reviewer', haiku, defaults),
      'implementer',
      {
        provider: 'claude-cli',
        model: 'sonnet',
      },
      defaults,
    )
    expect(Object.keys(buildRoleOverrides(both, 'single') ?? {})).toEqual(['implementer'])
    expect(Object.keys(buildRoleOverrides(both, 'compete') ?? {}).sort()).toEqual(['implementer', 'reviewer'])
    expect(buildRoleOverrides(both, 'workflow:nightly')).toBeUndefined()
    expect(buildRoleOverrides(pickModel(EMPTY_CHOICE, 'reviewer', haiku, defaults), 'single')).toBeUndefined()
  })
})

describe('the way to work', () => {
  it('falls back to the default mode for a custom workflow that no longer exists', () => {
    expect(validMode('single', [])).toBe('single')
    expect(validMode('workflow:nightly', ['nightly'])).toBe('workflow:nightly')
    expect(validMode('workflow:gone', ['nightly'])).toBe('review_loop')
    expect(validMode('whatever', [])).toBe('review_loop')
  })

  it('turns plan-first off, with a reason, for compete and custom workflows', () => {
    expect(planFirstDisabledReason('review_loop')).toBeUndefined()
    expect(planFirstDisabledReason('single')).toBeUndefined()
    expect(planFirstDisabledReason('compete')).toContain('比賽')
    expect(planFirstDisabledReason('workflow:x')).toContain('plan_first')
  })

  it('summarises mode and plan-first on one line', () => {
    const label = (mode: string) => (mode === 'review_loop' ? '實作＋審查' : mode)
    expect(modeSummary('review_loop', true, label)).toBe('實作＋審查 · 先規劃')
    expect(modeSummary('review_loop', false, label)).toBe('實作＋審查')
    expect(modeSummary('compete', true, (mode) => mode)).toBe('compete')
  })
})

describe('texts', () => {
  it('shows the model with its effort, or just the name', () => {
    expect(modelButtonText(defaults.implementer)).toBe('Opus 5.5 · 中')
    expect(modelButtonText({ provider: 'claude-cli', model: 'claude-opus-4-6' })).toBe('claude-opus-4-6')
  })

  it('summarises a combination on one small line', () => {
    expect(comboSummary(defaults.implementer, defaults.reviewer)).toBe('Opus 中 實作 · Sol 審查')
    expect(comboSummary(opus, sol)).toBe('Opus 實作 · Sol 審查')
  })
})

describe('remembering the last choice', () => {
  it('round-trips a choice', () => {
    const choice: ComposerChoice = {
      models: { implementer: { ...haiku, effort: 'low' }, reviewer: { ...sol, effort: 'high' } },
      mode: 'compete',
      planFirst: true,
    }
    expect(parseStoredChoice(serializeChoice(choice))).toEqual(choice)
  })

  it('starts from the defaults when nothing usable was stored', () => {
    expect(parseStoredChoice(null)).toEqual(EMPTY_CHOICE)
    expect(parseStoredChoice('not json')).toEqual(EMPTY_CHOICE)
    expect(parseStoredChoice('[]')).toEqual({ ...EMPTY_CHOICE })
    expect(parseStoredChoice('42')).toEqual(EMPTY_CHOICE)
  })

  it('drops pieces that are no longer valid and keeps the rest', () => {
    const stored = JSON.stringify({
      models: {
        implementer: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'max' },
      },
      mode: 7,
      planFirst: 'yes',
    })
    expect(parseStoredChoice(stored)).toEqual({
      // The OpenAI API cannot edit code; Codex has no top effort, so it moves down one step.
      models: { reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'xhigh' } },
      mode: 'review_loop',
      planFirst: false,
    })
    expect(
      parseStoredChoice(
        JSON.stringify({
          models: {
            implementer: { provider: 'nope', model: 'x' },
            reviewer: { provider: 'claude-cli', model: '' },
          },
        }),
      ).models,
    ).toEqual({})
  })

  it('drops an effort for a model nobody has validated', () => {
    const stored = JSON.stringify({
      models: { implementer: { provider: 'claude-cli', model: 'made-up', effort: 'high' } },
    })
    expect(parseStoredChoice(stored).models.implementer).toEqual({ provider: 'claude-cli', model: 'made-up' })
  })
})
