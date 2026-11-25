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
      '--ignore-user-config',
      '--ignore-rules',
      '--disable',
      'plugins',
      '--disable',
      'apps',
      '--disable',
      'remote_plugin',
      '--model',
      'gpt-6-luna',
      '--sandbox',
      'workspace-write',
      '-c',
      'approvals_reviewer="user"',
      '--',
      '-do it',
    ])
  })

  it('a prompt-only run skips AGENTS.md, web search and the heaviest built-in tools; others keep them', () => {
    const args = buildCodexArgs({ ...base, promptOnly: true }, model)
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'view_image',
      'image_generation',
      'memories',
      'goals',
    ])
      expect(args.join(' ')).toContain(`--disable ${feature}`)
    expect(args.join(' ')).toContain('-c project_doc_max_bytes=0')
    expect(args.join(' ')).toContain('-c web_search="disabled"')
    expect(args.indexOf('project_doc_max_bytes=0')).toBeLessThan(args.indexOf('--'))
    const normal = buildCodexArgs(base, model).join(' ')
    expect(normal).not.toContain('shell_tool')
    expect(normal).not.toContain('project_doc_max_bytes')
  })

  it('an ephemeral run saves no session under CODEX_HOME, unless it resumes one', () => {
    const args = buildCodexArgs({ ...base, ephemeral: true }, model)
    expect(args).toContain('--ephemeral')
    expect(args.indexOf('--ephemeral')).toBeLessThan(args.indexOf('--'))
    expect(buildCodexArgs(base, model)).not.toContain('--ephemeral')
    expect(buildCodexArgs({ ...base, ephemeral: true, resumeSessionId: 's1' }, model)).not.toContain(
      '--ephemeral',
    )
  })

  it("routes escalations to Joy's rules instead of Codex's own auto reviewer", () => {
    // `approvals_reviewer = "guardian_subagent"` in ~/.codex/config.toml lets a Codex subagent approve network access
    // and sandbox escapes; `exec` has nobody to ask, so with `user` those requests are refused instead.
    for (const autonomy of ['read-only', 'workspace-write'] as const) {
      const args = buildCodexArgs({ ...base, autonomy }, model)
      expect(args.slice(0, args.indexOf('--'))).toContain('approvals_reviewer="user"')
    }
  })

  it("leaves out the owner's config.toml (its MCP servers), plugins and connectors", () => {
    const args = buildCodexArgs(base, model)
    const flags = args.slice(0, args.indexOf('--'))
    expect(flags).toContain('--ignore-user-config')
    expect(flags).toContain('--ignore-rules')
    for (const feature of ['plugins', 'apps', 'remote_plugin'])
      expect(flags.join(' ')).toContain(`--disable ${feature}`)
  })

  it('sets the sandbox of a resumed run through config: `exec resume` has no --sandbox (codex-cli 0.166.0)', () => {
    for (const autonomy of ['read-only', 'workspace-write'] as const) {
      const args = buildCodexArgs({ ...base, autonomy, resumeSessionId: 'th1' }, model)
      expect(args).not.toContain('--sandbox')
      expect(args).toContain(`sandbox_mode="${autonomy}"`)
    }
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

  it('leaves out a server whose every call needs approval: exec cannot ask, and its secrets stay off argv', () => {
    expect(
      mcpOverrides([
        {
          name: 'owner',
          transport: 'stdio',
          command: 'node',
          args: [],
          env: { TOKEN: 'secret-value' },
          approval: 'every-call',
        },
        { name: 'web', transport: 'http', url: 'http://localhost:1/mcp' },
      ]),
    ).toEqual(['-c', 'mcp_servers.web.url="http://localhost:1/mcp"'])
  })

  it('rejects server names that would break the config key', () => {
    expect(() => mcpOverrides([{ name: 'a.b', transport: 'http', url: 'x' }])).toThrow(
      /Invalid MCP server name/,
    )
  })
})
