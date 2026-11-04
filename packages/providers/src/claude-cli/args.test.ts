import { EFFORTS } from '@joy/core'
import type { RunOptions } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, mcpConfigJson } from './args.js'

const model = { provider: 'claude-cli', model: 'opus' } as const
const base: RunOptions = {
  cwd: '/w',
  prompt: 'do it',
  autonomy: 'workspace-write',
  signal: new AbortController().signal,
}

describe('buildClaudeArgs', () => {
  it('streams JSON, sets the model and ends with -- prompt', () => {
    const args = buildClaudeArgs(base, model)
    expect(args.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus'])
    expect(args.slice(-2)).toEqual(['--', 'do it'])
  })

  it('passes every documented effort level for Claude Haiku', () => {
    for (const effort of EFFORTS) {
      expect(buildClaudeArgs(base, { ...model, model: 'haiku', effort })).toEqual(
        expect.arrayContaining(['--effort', effort]),
      )
    }
    expect(buildClaudeArgs(base, model)).not.toContain('--effort')
  })

  it('rejects a Claude effort unsupported by the selected model before building CLI args', () => {
    expect(() => buildClaudeArgs(base, { ...model, model: 'claude-opus-4-6', effort: 'xhigh' })).toThrow(
      /effort 'xhigh' is not supported for claude-cli model 'claude-opus-4-6'/,
    )
  })

  it('keeps a prompt that starts with a dash after --', () => {
    expect(buildClaudeArgs({ ...base, prompt: '--help' }, model).slice(-2)).toEqual(['--', '--help'])
  })

  it('prefers resume over a preset session id', () => {
    expect(buildClaudeArgs({ ...base, sessionId: 'a' }, model)).toEqual(
      expect.arrayContaining(['--session-id', 'a']),
    )
    const resumed = buildClaudeArgs({ ...base, sessionId: 'a', resumeSessionId: 'b' }, model)
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 'b']))
    expect(resumed).not.toContain('--session-id')
  })

  it('maps autonomy to permission modes and never leaves a prompt unanswered', () => {
    const ro = buildClaudeArgs({ ...base, autonomy: 'read-only' }, model)
    expect(ro).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--permission-prompts', 'none']))
    const ws = buildClaudeArgs(base, model)
    expect(ws).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits', '--permission-prompts', 'none']),
    )
    const full = buildClaudeArgs({ ...base, autonomy: 'full' }, model)
    expect(full).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']))
  })

  it('delegates approvals to the approval tool', () => {
    const args = buildClaudeArgs({ ...base, approvalTool: 'mcp__joy__approve' }, model)
    expect(args).toEqual(
      expect.arrayContaining([
        '--permission-prompt-tool',
        'mcp__joy__approve',
        '--permission-prompts',
        'host',
      ]),
    )
    expect(args).not.toContain('none')
  })

  it('passes MCP config strictly and the output schema as JSON', () => {
    const args = buildClaudeArgs({ ...base, outputSchema: { type: 'object' } }, model, '/tmp/mcp.json')
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', '/tmp/mcp.json', '--strict-mcp-config']))
    expect(args).toEqual(expect.arrayContaining(['--json-schema', '{"type":"object"}']))
  })
})

describe('mcpConfigJson', () => {
  it('writes stdio and http servers in Claude format', () => {
    const json = JSON.parse(
      mcpConfigJson([
        { name: 'joy', transport: 'stdio', command: 'node', args: ['hub.js'], env: { A: '1' } },
        { name: 'remote', transport: 'http', url: 'http://localhost:1/mcp' },
      ]),
    ) as unknown
    expect(json).toEqual({
      mcpServers: {
        joy: { command: 'node', args: ['hub.js'], env: { A: '1' } },
        remote: { type: 'http', url: 'http://localhost:1/mcp' },
      },
    })
  })
})
