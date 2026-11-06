import { describe, expect, it } from 'vitest'
import { containerRunCommand } from './docker.js'

const base = {
  image: 'joy-agent:latest',
  network: 'host' as const,
  containerHome: '/home/o/.joy/container-home/claude',
  cwd: '/home/o/.joy/worktrees/r/t-a',
  mounts: [{ host: '/home/o/code/r/.git', readOnly: false }, { host: '/tmp/joy-claude-x/mcp.json' }],
  command: ['claude'],
  args: ['-p', 'hello', '--output-format', 'stream-json'],
  user: '501:20',
}

describe('containerRunCommand', () => {
  it('mounts only the worktree, git data, login folder and listed files, at the same paths', () => {
    const { command, args } = containerRunCommand(base)
    expect(command).toBe('docker')
    expect(args.slice(0, 2)).toEqual(['run', '--rm'])
    const mounts = args.flatMap((arg, i) => (args[i - 1] === '--mount' ? [arg] : []))
    expect(mounts).toEqual([
      'type=bind,source=/home/o/.joy/container-home/claude,target=/joy-home',
      'type=bind,source=/home/o/.joy/worktrees/r/t-a,target=/home/o/.joy/worktrees/r/t-a',
      'type=bind,source=/home/o/code/r/.git,target=/home/o/code/r/.git',
      'type=bind,source=/tmp/joy-claude-x/mcp.json,target=/tmp/joy-claude-x/mcp.json,readonly',
    ])
    expect(args).toEqual(
      expect.arrayContaining(['--network', 'host', '--cap-drop', 'ALL', '--user', '501:20']),
    )
    expect(args).toContain('HOME=/joy-home')
    // The CLI and its arguments come last, unchanged.
    expect(args.slice(-5)).toEqual(['claude', '-p', 'hello', '--output-format', 'stream-json'])
  })

  it('refuses paths and images that could inject Docker options', () => {
    expect(() => containerRunCommand({ ...base, cwd: 'relative/path' })).toThrow(/absolute/)
    expect(() => containerRunCommand({ ...base, mounts: [{ host: '/x,target=/etc' }] })).toThrow(
      /cannot take/,
    )
    expect(() => containerRunCommand({ ...base, image: 'img --privileged' })).toThrow(/image/)
  })
})
