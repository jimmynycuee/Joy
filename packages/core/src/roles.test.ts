import { describe, expect, it } from 'vitest'
import type { RoleConfig } from './roles.js'
import { resolveRole, sameBackend } from './roles.js'

const config: RoleConfig = {
  assistant_brain: { provider: 'openai-api', model: 'small' },
  background: { provider: 'openai-api', model: 'small' },
  orchestrator: { provider: 'claude-cli', model: 'opus' },
  implementer: { provider: 'claude-cli', model: 'opus' },
  reviewer: { provider: 'codex-cli', model: 'codex' },
  judge: { provider: 'codex-cli', model: 'codex' },
}

describe('resolveRole', () => {
  it('uses the global config by default', () => {
    expect(resolveRole('reviewer', config)).toEqual({ provider: 'codex-cli', model: 'codex' })
  })

  it('lets a task override one role', () => {
    const overrides = { implementer: { provider: 'codex-cli', model: 'codex' } } as const
    expect(resolveRole('implementer', config, overrides)).toEqual({ provider: 'codex-cli', model: 'codex' })
    expect(resolveRole('reviewer', config, overrides)).toEqual({ provider: 'codex-cli', model: 'codex' })
  })
})

describe('sameBackend', () => {
  it('detects a review that is not cross-model', () => {
    expect(sameBackend(config.implementer, config.orchestrator)).toBe(true)
    expect(sameBackend(config.implementer, config.reviewer)).toBe(false)
  })
})
