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
})
