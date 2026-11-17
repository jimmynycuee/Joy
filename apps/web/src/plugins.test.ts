import { describe, expect, it } from 'vitest'
import { commandLineOf, readOnlyRisk, scopeLabel, splitCommandLine } from './plugins.js'

describe('splitCommandLine', () => {
  it('splits on spaces and keeps quoted words together', () => {
    expect(splitCommandLine('npx -y @scope/server --root "/My Files" \'a b\'')).toEqual([
      'npx',
      '-y',
      '@scope/server',
      '--root',
      '/My Files',
      'a b',
    ])
    expect(splitCommandLine('  node   a\\ b.js  ')).toEqual(['node', 'a b.js'])
    expect(splitCommandLine('echo "" x')).toEqual(['echo', '', 'x'])
    expect(splitCommandLine('C:\\tools\\mcp.exe')).toEqual(['C:\\tools\\mcp.exe'])
    expect(splitCommandLine('C:\\\\x')).toEqual(['C:\\x'])
    expect(splitCommandLine('')).toEqual([])
    expect(() => splitCommandLine('node "open')).toThrow()
  })

  it('round-trips with commandLineOf', () => {
    const argv = ['npx', '-y', 'srv', '--root', "/My 'Files'", '']
    const line = commandLineOf({ transport: 'stdio', command: 'npx', args: argv.slice(1) })
    expect(splitCommandLine(line)).toEqual(argv)
    expect(commandLineOf({ transport: 'http', args: [], url: 'https://x.test/mcp' })).toBe(
      'https://x.test/mcp',
    )
  })
})

describe('scopeLabel', () => {
  it('names the projects', () => {
    const names = new Map([['r1', 'joy']])
    expect(scopeLabel({}, names)).toBe('所有專案')
    expect(scopeLabel({ repoIds: ['r1', 'r9'] }, names)).toBe('joy、r9')
    expect(scopeLabel({ repoIds: [] }, names)).toBe('沒有專案')
  })
})

describe('readOnlyRisk', () => {
  it('asks only for http servers, naming the host', () => {
    expect(readOnlyRisk({ transport: 'stdio' })).toBeUndefined()
    expect(readOnlyRisk({ transport: 'http', url: 'https://mcp.example.test:8443/mcp?x=1' })).toContain(
      'mcp.example.test:8443 ',
    )
    expect(readOnlyRisk({ transport: 'http', url: 'not a url' })).toContain('not a url')
  })
})
