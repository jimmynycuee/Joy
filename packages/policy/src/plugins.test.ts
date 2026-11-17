import type { PermissionMode } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { classifyClaudeToolAction, classifyCodexApproval } from './classify.js'
import { evaluateAction } from './index.js'
import type { ClassifyEnvironment } from './shell.js'
import { taskAllowForClaudeTool, taskAllowForCodexApproval } from './task-allow.js'

const worktree = '/work/project'
const env: ClassifyEnvironment = {
  home: '/home/me',
  tempDirs: ['/tmp'],
  joyHome: '/home/me/.joy',
  platform: 'linux',
  readOnlyMcpServers: ['docs', 'joy'],
}
const claude = (tool: string, mode: PermissionMode, environment = env) =>
  evaluateAction(classifyClaudeToolAction(tool, { q: 1 }, worktree, mode, environment), 'normal').outcome
const codex = (server: string, mode: PermissionMode, environment = env, toolCall = true) =>
  evaluateAction(
    classifyCodexApproval(
      { method: 'mcpServer/elicitation/request', server, toolCall },
      worktree,
      mode,
      environment,
    ),
    'normal',
  ).outcome

describe('owner-added MCP servers', () => {
  it('asks for every tool by default, in every mode', () => {
    for (const mode of ['ask', 'auto', 'full'] as const) {
      expect(claude('mcp__files__write', mode)).toBe('require_approval')
      expect(codex('files', mode)).toBe('require_approval')
    }
    expect(classifyClaudeToolAction('mcp__files__write', {}, worktree, 'full', env)).not.toHaveProperty(
      'grant',
    )
    expect(
      classifyCodexApproval(
        { method: 'mcpServer/elicitation/request', server: 'files' },
        worktree,
        'full',
        env,
      ),
    ).not.toHaveProperty('grant')
  })

  it('runs a server marked read-only on its own in auto only; ask and full still ask', () => {
    expect(claude('mcp__docs__search', 'auto')).toBe('allow')
    expect(codex('docs', 'auto')).toBe('allow')
    for (const mode of ['ask', 'full'] as const) {
      expect(claude('mcp__docs__search', mode)).toBe('require_approval')
      expect(codex('docs', mode)).toBe('require_approval')
    }
    // Without the mark, the same server asks again.
    expect(claude('mcp__docs__search', 'auto', { ...env, readOnlyMcpServers: [] })).toBe('require_approval')
    // Only the server part counts: a server whose name merely starts the same is not covered.
    expect(claude('mcp__docs2__search', 'auto')).toBe('require_approval')
    expect(claude('mcp__docs', 'auto')).toBe('require_approval')
    // Codex: only a tool call; anything else the server asks goes to the owner.
    expect(codex('docs', 'auto', env, false)).toBe('require_approval')
  })

  it("shows what the server says about the call, as the server's words", () => {
    const action = classifyCodexApproval(
      {
        method: 'mcpServer/elicitation/request',
        server: 'docs',
        toolCall: true,
        tool: 'search',
        message: 'Run\nit?',
      },
      worktree,
      'ask',
      env,
    )
    expect(action.summary).toBe(
      'Codex requested a tool of the docs MCP server (the server says: search — Run it?).',
    )
  })

  it("never lets the mark cover Joy's own server name", () => {
    expect(claude('mcp__joy__something_new', 'auto')).toBe('require_approval')
    expect(codex('joy', 'auto')).toBe('require_approval')
  })

  it('external content asks even for a read-only server in auto', () => {
    const action = classifyClaudeToolAction('mcp__docs__search', {}, worktree, 'auto', env)
    expect(evaluateAction({ ...action, provenance: 'external_content' }, 'normal').outcome).toBe(
      'require_approval',
    )
    const fromCodex = classifyCodexApproval(
      { method: 'mcpServer/elicitation/request', server: 'docs' },
      worktree,
      'auto',
      env,
    )
    expect(evaluateAction({ ...fromCodex, provenance: 'external_content' }, 'normal').outcome).toBe(
      'require_approval',
    )
  })

  it('is never offered as "allow for the rest of this task"', () => {
    expect(taskAllowForClaudeTool('mcp__docs__search', {}, worktree, env)).toMatchObject({ offer: false })
    expect(
      taskAllowForCodexApproval({ method: 'mcpServer/elicitation/request', server: 'docs' }, worktree, env),
    ).toMatchObject({ offer: false })
  })
})

describe('skills', () => {
  const skill = (tool: string, input: unknown, mode: PermissionMode, environment: ClassifyEnvironment) =>
    evaluateAction(classifyClaudeToolAction(tool, input, worktree, mode, environment), 'normal').outcome
  const invoked: ClassifyEnvironment = { ...env, ownerSkills: ['review', 'tidy'] }

  it('loading a skill the owner invoked with /name in this run does not ask, in every mode', () => {
    for (const mode of ['ask', 'auto', 'full'] as const) {
      expect(skill('Skill', { skill: 'review' }, mode, invoked)).toBe('allow')
      expect(skill('SlashCommand', { command: '/tidy src' }, mode, invoked)).toBe('allow')
    }
  })

  it('any other skill or command asks in every mode: its allowed-tools would skip Joy', () => {
    for (const mode of ['ask', 'auto', 'full'] as const) {
      expect(skill('Skill', { skill: 'deploy' }, mode, invoked)).toBe('require_approval')
      expect(skill('SlashCommand', { command: '/deploy' }, mode, invoked)).toBe('require_approval')
      expect(skill('Skill', { skill: 'review' }, mode, env)).toBe('require_approval')
      expect(skill('Skill', {}, mode, invoked)).toBe('require_approval')
      expect(skill('Skill', { skill: '' }, mode, { ...env, ownerSkills: [''] })).toBe('require_approval')
    }
    expect(
      classifyClaudeToolAction('Skill', { skill: 'deploy' }, worktree, 'full', invoked),
    ).not.toHaveProperty('grant')
  })
})

describe("a run's MCP config", () => {
  it('lives under JOY_HOME, so reading it asks in every mode', () => {
    const path = '/home/me/.joy/run/joy-claude-AbC123/mcp.json'
    for (const mode of ['ask', 'auto', 'full'] as const) {
      expect(readOf('Read', { file_path: path }, mode)).toBe('require_approval')
      expect(readOf('Bash', { command: 'cat /home/me/.joy/run/joy-claude-*/mcp.json' }, mode)).toBe(
        'require_approval',
      )
      expect(readOf('Grep', { pattern: 'Bearer', path: '/home/me/.joy/run' }, mode)).toBe('require_approval')
    }
  })
})

const readOf = (tool: string, input: unknown, mode: PermissionMode) =>
  evaluateAction(classifyClaudeToolAction(tool, input, worktree, mode, env), 'normal').outcome
