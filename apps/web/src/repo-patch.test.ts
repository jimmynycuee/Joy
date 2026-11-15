import { describe, expect, it } from 'vitest'
import { repoPatch } from './repo-patch.js'
import type { Repo } from './types.js'

const repo: Repo = {
  id: 'r1',
  path: '/work/app',
  defaultBranch: 'main',
  githubRemote: 'https://github.com/o/app.git',
  allowedProviders: ['claude-cli', 'codex-cli'],
  checkCommand: ['pnpm', 'check'],
}
const same = {
  githubRemote: 'https://github.com/o/app.git',
  providers: ['codex-cli', 'claude-cli'] as const,
  checkCommand: 'pnpm check',
  color: null,
}

describe('repoPatch', () => {
  it('is empty when nothing changed, whatever the order or spacing', () => {
    expect(
      repoPatch(repo, { ...same, providers: ['codex-cli', 'claude-cli'], checkCommand: ' pnpm   check ' }),
    ).toEqual({})
  })

  it('sends only the changed fields', () => {
    expect(repoPatch(repo, { ...same, providers: [...same.providers], checkCommand: 'npm test' })).toEqual({
      checkCommand: ['npm', 'test'],
    })
    expect(
      repoPatch(repo, {
        ...same,
        providers: ['claude-cli', 'codex-cli', 'openai-api'],
        checkCommand: 'pnpm check',
      }),
    ).toEqual({ allowedProviders: ['openai-api', 'claude-cli', 'codex-cli'] })
  })

  it('clears a field with null when the text is emptied', () => {
    expect(
      repoPatch(repo, {
        ...same,
        githubRemote: ' ',
        providers: ['claude-cli', 'codex-cli'],
        checkCommand: '',
      }),
    ).toEqual({
      githubRemote: null,
      checkCommand: null,
    })
  })

  it('treats a repo without the new fields as allowing every provider and having no check', () => {
    const bare: Repo = { id: 'r2', path: '/x', defaultBranch: 'main' }
    expect(
      repoPatch(bare, {
        githubRemote: '',
        providers: ['openai-api', 'claude-cli', 'codex-cli'],
        checkCommand: '',
        color: null,
      }),
    ).toEqual({})
  })

  it('sends the colour only when it changes, and null to go back to automatic', () => {
    const picked: Repo = { ...repo, color: 'purple' }
    expect(repoPatch(picked, { ...same, color: 'purple' })).toEqual({})
    expect(repoPatch(picked, { ...same, color: 'teal' })).toEqual({ color: 'teal' })
    expect(repoPatch(picked, { ...same, color: null })).toEqual({ color: null })
    expect(repoPatch(repo, { ...same, color: 'blue' })).toEqual({ color: 'blue' })
    expect(repoPatch(repo, { ...same, color: null })).toEqual({})
  })

  it('sends the maximum permission mode only when it changes, and null to remove the limit', () => {
    expect(repoPatch(repo, { ...same, maxPermissionMode: null })).toEqual({})
    expect(repoPatch(repo, { ...same, maxPermissionMode: 'auto' })).toEqual({ maxPermissionMode: 'auto' })
    const limited: Repo = { ...repo, maxPermissionMode: 'auto' }
    expect(repoPatch(limited, { ...same, maxPermissionMode: 'auto' })).toEqual({})
    expect(repoPatch(limited, { ...same, maxPermissionMode: null })).toEqual({ maxPermissionMode: null })
    expect(repoPatch(limited, { ...same })).toEqual({})
  })

  it('sends the instructions trimmed, only when they change, and null once they are emptied', () => {
    const written: Repo = { ...repo, instructions: 'Use pnpm.' }
    expect(repoPatch(repo, { ...same, instructions: '' })).toEqual({})
    expect(repoPatch(repo, { ...same, instructions: '  \n ' })).toEqual({})
    expect(repoPatch(written, { ...same, instructions: ' Use pnpm.\n' })).toEqual({})
    expect(repoPatch(written, { ...same, instructions: 'Use npm.' })).toEqual({ instructions: 'Use npm.' })
    expect(repoPatch(written, { ...same, instructions: '' })).toEqual({ instructions: null })
    expect(repoPatch(repo, { ...same, instructions: 'a\n\nb' })).toEqual({ instructions: 'a\n\nb' })
    expect(repoPatch(written, { ...same })).toEqual({})
  })

  it('sends the install command as argv, and null to go back to the lockfile install', () => {
    const custom: Repo = { ...repo, installCommand: ['make', 'deps'] }
    expect(repoPatch(repo, { ...same, installCommand: '' })).toEqual({})
    expect(repoPatch(repo, { ...same, installCommand: ' pnpm  install --offline ' })).toEqual({
      installCommand: ['pnpm', 'install', '--offline'],
    })
    expect(repoPatch(custom, { ...same, installCommand: 'make   deps' })).toEqual({})
    expect(repoPatch(custom, { ...same, installCommand: '' })).toEqual({ installCommand: null })
    expect(repoPatch(custom, { ...same })).toEqual({})
  })

  it('sends the defaults as a whole when they change, and null once none is left', () => {
    const withDefaults: Repo = { ...repo, defaults: { mode: 'single', permissionMode: 'auto' } }
    expect(repoPatch(repo, { ...same, defaults: {} })).toEqual({})
    expect(
      repoPatch(withDefaults, { ...same, defaults: { mode: 'single', permissionMode: 'auto' } }),
    ).toEqual({})
    expect(repoPatch(withDefaults, { ...same, defaults: { mode: 'single' } })).toEqual({
      defaults: { mode: 'single' },
    })
    expect(repoPatch(withDefaults, { ...same, defaults: {} })).toEqual({ defaults: null })
    expect(
      repoPatch(repo, {
        ...same,
        defaults: { implementer: { provider: 'claude-cli', model: 'haiku' } },
      }),
    ).toEqual({ defaults: { implementer: { provider: 'claude-cli', model: 'haiku' } } })
    expect(repoPatch(withDefaults, { ...same })).toEqual({})
  })
})
