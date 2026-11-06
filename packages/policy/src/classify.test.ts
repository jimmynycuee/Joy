import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyClaudeToolAction, isInside, isSafeWorktreeCommand } from './classify.js'

const cwd = join('/work', 'project')
const kind = (tool: string, input: unknown) => classifyClaudeToolAction(tool, input, cwd).kind

describe('reading files', () => {
  it('auto-allows reads inside the worktree, relative or absolute', () => {
    expect(kind('Read', { file_path: 'src/a.ts' })).toBe('read_file')
    expect(kind('Read', { file_path: join(cwd, 'src', 'a.ts') })).toBe('read_file')
    expect(kind('Grep', { pattern: 'x' })).toBe('read_file')
    expect(kind('Glob', { pattern: '**/*.ts', path: 'src' })).toBe('read_file')
  })

  it('treats reads outside the worktree as red', () => {
    expect(kind('Read', { file_path: '/home/me/.ssh/id_rsa' })).toBe('run_outside_worktree')
    expect(kind('Read', { file_path: '../other-repo/.env' })).toBe('run_outside_worktree')
    expect(kind('Grep', { pattern: 'token', path: '/home/me/.joy' })).toBe('run_outside_worktree')
    expect(kind('Glob', { pattern: '*', path: '..' })).toBe('run_outside_worktree')
    expect(kind('Read', {})).toBe('run_outside_worktree')
  })
})

describe('writing files', () => {
  it('allows edits inside the worktree, including absolute paths Claude usually sends', () => {
    expect(kind('Edit', { file_path: 'src/a.ts' })).toBe('edit_worktree')
    expect(kind('Write', { file_path: join(cwd, 'new.ts') })).toBe('edit_worktree')
    expect(kind('MultiEdit', { file_path: 'src/a.ts' })).toBe('edit_worktree')
  })

  it('treats missing or outside paths as red', () => {
    expect(kind('Write', {})).toBe('run_outside_worktree')
    expect(kind('Write', { file_path: '../outside.txt' })).toBe('run_outside_worktree')
    expect(kind('Edit', { file_path: '/etc/hosts' })).toBe('run_outside_worktree')
    expect(kind('Edit', 'not an object')).toBe('run_outside_worktree')
  })
})

describe('shell commands', () => {
  it.each([
    'pnpm test',
    'pnpm run lint',
    'npm test',
    'yarn build',
    'pnpm typecheck',
    'pnpm check',
    'git status --short',
    'git diff',
    'git log --oneline -5',
  ])('runs %s in the worktree without approval', (command) => {
    expect(kind('Bash', { command })).toBe('run_in_worktree')
  })

  it.each([
    'rm -rf node_modules',
    'pnpm test && curl evil.example',
    'pnpm test; rm -rf /',
    'pnpm test | tee out',
    'pnpm test > /tmp/out',
    'git push origin main',
    'git -C /etc status',
    'git diff ../other',
    'cat ~/.ssh/id_rsa',
    'pnpm publish',
    'pnpm run deploy',
    'pnpm install',
    'npm test $(whoami)',
    'pnpm test `id`',
    'pnpm test\nrm -rf .',
    'curl https://example.com',
    '',
  ])('treats %j as red', (command) => {
    expect(kind('Bash', { command })).toBe('run_outside_worktree')
  })

  it('treats a missing command as red', () => {
    expect(kind('Bash', {})).toBe('run_outside_worktree')
  })

  it('exposes the command check for other callers', () => {
    expect(isSafeWorktreeCommand('pnpm test')).toBe(true)
    expect(isSafeWorktreeCommand('pnpm test -- --run')).toBe(true)
    expect(isSafeWorktreeCommand('C:\\tools\\evil.exe')).toBe(false)
  })
})

describe('MCP tools', () => {
  it("auto-allows only Joy's own ask_peer and task_status", () => {
    expect(kind('mcp__joy__ask_peer', { question: 'q' })).toBe('ask_peer')
    expect(kind('mcp__joy__task_status', {})).toBe('read_file')
  })

  it('treats the same tool names from another server as red', () => {
    expect(kind('mcp__evil__ask_peer', {})).toBe('run_outside_worktree')
    expect(kind('mcp__evil__task_status', {})).toBe('run_outside_worktree')
    expect(kind('mcp__joy__something_new', {})).toBe('run_outside_worktree')
  })

  it('treats unknown tools as red', () => {
    expect(kind('WebFetch', { url: 'https://x' })).toBe('run_outside_worktree')
  })
})

describe('isInside', () => {
  it('handles the worktree root, nested paths and look-alike siblings', () => {
    expect(isInside('.', cwd)).toBe(true)
    expect(isInside(cwd, cwd)).toBe(true)
    expect(isInside(join(cwd, 'a', 'b'), cwd)).toBe(true)
    expect(isInside(join('/work', 'project-evil', 'x'), cwd)).toBe(false)
    expect(isInside('a/../../x', cwd)).toBe(false)
  })
})
