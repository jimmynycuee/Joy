// Grep and Glob read whatever their patterns reach: the path alone does not show whether they touch secrets.
import type { PermissionMode } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { classifyClaudeToolAction } from './classify.js'
import { evaluateAction } from './index.js'
import { analyzeSearch } from './shell.js'
import type { ClassifyEnvironment } from './shell.js'

const worktree = '/work/project'
const env: ClassifyEnvironment = {
  home: '/home/me',
  tempDirs: ['/tmp'],
  joyHome: '/data/joy-home',
  platform: 'linux',
}
const outcome = (tool: string, input: unknown, mode: PermissionMode) =>
  evaluateAction(classifyClaudeToolAction(tool, input, worktree, mode, env), 'normal').outcome
const verdict = (root: string, patterns: string[], recursive: boolean) =>
  analyzeSearch(root, patterns, { worktree, mode: 'auto', recursive, env }).verdict

describe('searches stay out of secrets', () => {
  it.each([
    ['Grep', { pattern: 'TODO' }],
    ['Grep', { pattern: 'TODO', path: 'src', glob: '*.ts' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Glob', { pattern: 'src/**/*.test.ts', path: '/work/project' }],
    // A grep for the text ".joy" is content, not a path.
    ['Grep', { pattern: '\\.joy/config' }],
  ])('%s %j runs in every mode', (tool, input) => {
    for (const mode of ['ask', 'auto', 'full'] as const) expect(outcome(tool, input, mode)).toBe('allow')
  })

  it.each([
    ['Glob', { path: '/home/me', pattern: '.joy/**' }],
    ['Glob', { path: '/home/me', pattern: '**/.ssh/*' }],
    ['Glob', { path: '/home/me', pattern: '*/config.yaml' }],
    ['Glob', { path: '/home/me', pattern: '**/*.yaml' }],
    ['Glob', { path: '/home', pattern: '*/.claude/**' }],
    ['Glob', { path: '/data', pattern: '**/*.sqlite' }],
    ['Glob', { pattern: '../../home/me/.codex/*' }],
    ['Glob', { pattern: '**/.config/gh/hosts.yml' }],
    ['Glob', { pattern: '**/Library/Keychains/*' }],
    ['Grep', { path: '/home/me', pattern: 'token' }],
    ['Grep', { path: '/home/me', pattern: 'token', glob: '.aws/*' }],
    ['Grep', { path: '/data', pattern: 'x' }],
    ['Grep', { path: '/', pattern: 'x' }],
    ['Grep', { pattern: 'x', glob: '**/.git-credentials' }],
  ])('%s %j asks in every mode, full included', (tool, input) => {
    for (const mode of ['ask', 'auto', 'full'] as const)
      expect(outcome(tool, input, mode)).toBe('require_approval')
  })

  it('a search outside the worktree that cannot reach a secret is only outside', () => {
    expect(verdict('/opt/lib', [], true)).toBe('outside')
    expect(verdict('/home/me/code/other', ['**/*.ts'], false)).toBe('outside')
    expect(outcome('Grep', { path: '/opt/lib', pattern: 'x' }, 'full')).toBe('allow')
    expect(outcome('Grep', { path: '/opt/lib', pattern: 'x' }, 'auto')).toBe('require_approval')
    // A single level under the home directory lists names only; the glob's last part does not descend.
    expect(verdict('/home/me', ['*.md'], false)).toBe('outside')
  })

  it('works with Windows rules', () => {
    const winEnv: ClassifyEnvironment = {
      home: 'C:\\Users\\me',
      tempDirs: ['C:\\Temp'],
      joyHome: 'C:\\Users\\me\\.joy',
      platform: 'win32',
    }
    const win = (root: string, patterns: string[], recursive: boolean) =>
      analyzeSearch(root, patterns, { worktree: 'C:\\work\\project', mode: 'auto', recursive, env: winEnv })
        .verdict
    expect(win('C:\\work\\project', ['**\\*.ts'], true)).toBe('inside')
    expect(win('C:\\Users\\me', ['**\\*.yaml'], false)).toBe('forbidden')
    expect(win('C:\\work\\project', ['**\\.SSH\\*'], false)).toBe('forbidden')
    expect(win('c:\\users', ['*'], true)).toBe('forbidden')
  })
})
