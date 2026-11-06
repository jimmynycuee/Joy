import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runJsonlProcess } from './process.js'
import { resolveCommand, shimScript, toWslPath, wslCommand } from './windows.js'

const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`
const PNPM_SHIM = `@SETLOCAL
@IF NOT DEFINED NODE_PATH (@SET "NODE_PATH=C:\\pnpm\\node_modules") ELSE (@SET "NODE_PATH=%NODE_PATH%;C:\\pnpm\\node_modules")
@IF EXIST "%~dp0\\node.exe" ("%~dp0\\node.exe" "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*) ELSE (@SET PATHEXT=%PATHEXT:;.JS;=;% & node "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*)
`

describe('Windows command resolution', () => {
  it('reads the script out of npm and pnpm shims', () => {
    expect(shimScript('C:\\npm\\claude.cmd', NPM_SHIM)).toBe(
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    )
    expect(shimScript('C:\\pnpm\\bin\\codex.cmd', PNPM_SHIM)).toBe('C:\\pnpm\\@openai\\codex\\bin\\codex.js')
    expect(shimScript('C:\\x\\tool.cmd', '@echo off\r\ntool.exe %*')).toBeUndefined()
  })

  it('finds .exe first, then a shim on PATH, and runs the shim script with node', () => {
    const files = new Map([
      ['C:\\npm\\claude.cmd', NPM_SHIM],
      ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', ''],
      ['C:\\tools\\git.exe', ''],
    ])
    const options = {
      platform: 'win32' as const,
      path: 'C:\\tools;C:\\npm',
      node: 'C:\\node\\node.exe',
      isFile: (path: string) => files.has(path),
      readFile: (path: string) => files.get(path) ?? '',
    }
    expect(resolveCommand('claude', options)).toEqual({
      command: 'C:\\node\\node.exe',
      prefix: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
    })
    expect(resolveCommand('git', options)).toEqual({ command: 'C:\\tools\\git.exe', prefix: [] })
    expect(resolveCommand('missing', options)).toEqual({ command: 'missing', prefix: [] })
    expect(resolveCommand('claude', { ...options, platform: 'darwin' })).toEqual({
      command: 'claude',
      prefix: [],
    })
    files.set('C:\\odd\\tool.cmd', '@echo off\r\ntool.exe %*')
    expect(() => resolveCommand('C:\\odd\\tool.cmd', options)).toThrow(/cannot run without a shell/)
  })

  it('maps Windows paths for WSL', () => {
    expect(toWslPath('C:\\Users\\me\\.joy\\worktrees\\r')).toBe('/mnt/c/Users/me/.joy/worktrees/r')
    expect(toWslPath('D:/work/')).toBe('/mnt/d/work')
    expect(toWslPath('\\\\server\\share')).toBeUndefined()
    expect(
      wslCommand({
        cli: 'codex',
        cwd: 'C:\\Users\\me\\wt',
        args: ['exec', '--json', '--output-schema', 'C:\\Temp\\joy-codex\\schema.json', 'fix C:\\x in prose'],
      }),
    ).toEqual({
      command: 'wsl.exe',
      args: [
        '--cd',
        '/mnt/c/Users/me/wt',
        '-e',
        'codex',
        'exec',
        '--json',
        '--output-schema',
        '/mnt/c/Temp/joy-codex/schema.json',
        'fix C:\\x in prose',
      ],
    })
    expect(() => wslCommand({ cli: 'codex', cwd: '\\\\nas\\wt', args: [] })).toThrow(/drive letter/)
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Runs only on Windows (CI has a Windows runner): a real npm-style shim, started without a shell.
describe.runIf(process.platform === 'win32')('Windows shim spawn', () => {
  it('starts a CLI installed as a .cmd shim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-shim-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'node_modules', 'fake'), { recursive: true })
    writeFileSync(
      join(dir, 'node_modules', 'fake', 'cli.js'),
      'console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }))\n',
    )
    writeFileSync(
      join(dir, 'fake.cmd'),
      NPM_SHIM.replace('@anthropic-ai\\claude-code\\cli.js', 'fake\\cli.js'),
    )
    const proc = runJsonlProcess({
      command: join(dir, 'fake.cmd'),
      args: ['--version', 'a b'],
      cwd: dir,
      signal: new AbortController().signal,
      timeoutMs: 30_000,
    })
    const lines = []
    for await (const line of proc.lines) lines.push(line)
    expect((await proc.exit).spawnError).toBeUndefined()
    expect(lines).toEqual([{ ok: true, value: { ok: true, args: ['--version', 'a b'] } }])
  })
})
