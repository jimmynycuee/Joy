import type { RunOptions } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { buildCodexArgs, mcpOverrides } from './args.js'

const model = { provider: 'codex-cli', model: 'gpt-6-luna' } as const
const base: RunOptions = {
  cwd: '/w',
  prompt: '-do it',
  autonomy: 'workspace-write',
  signal: new AbortController().signal,
}

describe('buildCodexArgs', () => {
  it('runs exec with JSON, model, sandbox and the prompt after --', () => {
    expect(buildCodexArgs(base, model)).toEqual([
      'exec',
      '--json',
      '--model',
      'gpt-6-luna',
      '--sandbox',
      'workspace-write',
      '--',
      '-do it',
    ])
  })

  it('attaches each image with its own --image before the prompt', () => {
    const images = [
      { path: '/joy/attachments/a', mediaType: 'image/png' as const },
      { path: '/joy/attachments/b', mediaType: 'image/jpeg' as const },
    ]
    expect(buildCodexArgs({ ...base, images }, model).slice(-6)).toEqual([
      '--image',
      '/joy/attachments/a',
      '--image',
      '/joy/attachments/b',
      '--',
      '-do it',
    ])
    const resumed = buildCodexArgs({ ...base, images, resumeSessionId: 'th1' }, model)
    expect(resumed.slice(-5)).toEqual(['--image', '/joy/attachments/b', '--', 'th1', '-do it'])
  })

  it('resumes with the thread id before the prompt', () => {
    const args = buildCodexArgs({ ...base, resumeSessionId: 'th1' }, model)
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json'])
    expect(args.slice(-3)).toEqual(['--', 'th1', '-do it'])
  })

  it('maps effort, autonomy and output schema', () => {
    expect(buildCodexArgs(base, { ...model, effort: 'low' })).toEqual(
      expect.arrayContaining(['-c', 'model_reasoning_effort="low"']),
    )
    expect(buildCodexArgs({ ...base, autonomy: 'read-only' }, model)).toEqual(
      expect.arrayContaining(['--sandbox', 'read-only']),
    )
    expect(buildCodexArgs({ ...base, autonomy: 'full' }, model)).toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    )
    expect(buildCodexArgs(base, model, '/tmp/s.json')).toEqual(
      expect.arrayContaining(['--output-schema', '/tmp/s.json']),
    )
  })
})

describe('mcpOverrides', () => {
  it('quotes values as TOML', () => {
    expect(
      mcpOverrides([
        { name: 'joy', transport: 'stdio', command: 'C:\\node.exe', args: ['hub "x".js'], env: { A: '1' } },
        { name: 'web', transport: 'http', url: 'http://localhost:1/mcp' },
      ]),
    ).toEqual([
      '-c',
      'mcp_servers.joy.command="C:\\\\node.exe"',
      '-c',
      'mcp_servers.joy.args=["hub \\"x\\".js"]',
      '-c',
      'mcp_servers.joy.env={"A"="1"}',
      '-c',
      'mcp_servers.web.url="http://localhost:1/mcp"',
    ])
  })

  it('rejects server names that would break the config key', () => {
    expect(() => mcpOverrides([{ name: 'a.b', transport: 'http', url: 'x' }])).toThrow(
      /Invalid MCP server name/,
    )
  })
})
