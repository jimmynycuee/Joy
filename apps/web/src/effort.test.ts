import { EFFORTS } from '@joy/core'
import type { ProviderKind } from '@joy/core'
import { describe, expect, it } from 'vitest'
// The package is a pure function with no I/O. The web app copies its rules instead of depending on it (a new
// workspace dependency would change the lockfile), and this test is what keeps the copy honest.
import { effortCompatibilityError } from '../../../packages/model-effort/src/index.js'
import {
  SUPPORTED_EFFORTS,
  effortAtPosition,
  effortLabel,
  nearestSupported,
  segmentAt,
  stepEffort,
  supportedEfforts,
} from './effort.js'
import { MODEL_CATALOG } from './models.js'

describe('effort rules copied from @joy/model-effort', () => {
  it('agree with the package for every listed model and every effort', () => {
    for (const [provider, models] of Object.entries(SUPPORTED_EFFORTS)) {
      const kind = provider as ProviderKind
      for (const model of Object.keys(models)) {
        for (const effort of EFFORTS) {
          const accepted = effortCompatibilityError(kind, model, effort) === undefined
          expect(supportedEfforts(kind, model).includes(effort)).toBe(accepted)
        }
      }
    }
  })

  it('know every model the catalog offers', () => {
    for (const entry of MODEL_CATALOG) {
      expect(supportedEfforts(entry.provider, entry.model).length).toBeGreaterThan(0)
    }
  })

  it('know no effort for a model nobody has validated', () => {
    expect(supportedEfforts('claude-cli', 'made-up')).toEqual([])
    expect(effortCompatibilityError('claude-cli', 'made-up', 'low')).toBeDefined()
  })

  it('leave the top step off for Codex models', () => {
    expect(supportedEfforts('codex-cli', 'gpt-6.1-sol')).not.toContain('max')
    expect(supportedEfforts('claude-cli', 'opus')).toContain('max')
    expect(supportedEfforts('claude-cli', 'OPUS ')).toContain('max')
  })
})

describe('effort helpers', () => {
  const codex = supportedEfforts('codex-cli', 'gpt-6-luna')
  const claude = supportedEfforts('claude-cli', 'opus')

  it('labels every effort in Chinese', () => {
    expect(EFFORTS.map(effortLabel)).toEqual(['低', '中', '高', '很高', '最高'])
  })

  it('finds the nearest supported effort, a tie going to the lower one', () => {
    expect(nearestSupported('max', codex)).toBe('xhigh')
    expect(nearestSupported('medium', codex)).toBe('medium')
    expect(nearestSupported('high', ['low', 'max'])).toBe('low')
    expect(nearestSupported('low', [])).toBeUndefined()
  })

  it('steps along the supported efforts and stops at the ends', () => {
    expect(stepEffort('medium', claude, 1)).toBe('high')
    expect(stepEffort('medium', claude, -1)).toBe('low')
    expect(stepEffort('low', claude, -1)).toBe('low')
    expect(stepEffort('max', claude, 1)).toBe('max')
    // Skips an effort the model does not take.
    expect(stepEffort('high', ['low', 'medium', 'high', 'max'], 1)).toBe('max')
    // An unset effort starts from the matching end.
    expect(stepEffort(undefined, claude, 1)).toBe('low')
    expect(stepEffort(undefined, claude, -1)).toBe('max')
    expect(stepEffort('low', [], 1)).toBeUndefined()
  })

  it('maps a pointer position to one of five segments', () => {
    expect(segmentAt(0)).toBe(0)
    expect(segmentAt(0.19)).toBe(0)
    expect(segmentAt(0.2)).toBe(1)
    expect(segmentAt(0.99)).toBe(4)
    expect(segmentAt(1)).toBe(4)
    expect(segmentAt(-3)).toBe(0)
    expect(segmentAt(7)).toBe(4)
    expect(segmentAt(Number.NaN)).toBe(0)
  })

  it('snaps a position over an unsupported segment to the nearest supported one', () => {
    expect(effortAtPosition(0.5, claude)).toBe('high')
    expect(effortAtPosition(0.95, claude)).toBe('max')
    expect(effortAtPosition(0.95, codex)).toBe('xhigh')
    expect(effortAtPosition(0.5, [])).toBeUndefined()
  })
})
