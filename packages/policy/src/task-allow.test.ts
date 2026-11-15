import { describe, expect, it } from 'vitest'
import { analyzeShellCommand, analyzeShellConcerns } from './shell.js'
import type { ClassifyEnvironment } from './shell.js'
import { taskAllowForClaudeTool, taskAllowForCodexApproval } from './task-allow.js'
import type { TaskAllowJudgement } from './task-allow.js'

const worktree = '/work/project'
const env: ClassifyEnvironment = { home: '/home/me', tempDirs: ['/tmp'], joyHome: '/home/me/.joy' }
const claude = (tool: string, input: unknown) => taskAllowForClaudeTool(tool, input, worktree, env)
const bash = (command: string) => claude('Bash', { command })
const fingerprint = (judgement: TaskAllowJudgement) => (judgement.offer ? judgement.fingerprint : undefined)

describe('which approvals may be remembered for the task', () => {
  it.each([
    'pnpm install',
    'pnpm install 2>&1 | tail -15 && pnpm check',
    'rm -rf ../elsewhere',
    'cat /etc/hosts',
    'cd .. && ls',
    "node -e \"require('fs').writeFileSync('/opt/x', '1')\"",
    'cat a.json | jq .name',
    'echo shasum | tee out.txt',
  ])('offers %s', (command) => {
    expect(bash(command)).toMatchObject({ offer: true, kind: 'shell', target: command })
  })

  it.each([
    ['cat ~/.ssh/id_rsa', 'forbidden'],
    ['cat /home/me/.joy/config.yaml', 'forbidden'],
    ['security find-generic-password -s x', 'forbidden'],
    ['echo $OPENAI_API_KEY', 'forbidden'],
    ['git credential fill', 'forbidden'],
    ['git push origin HEAD', 'external'],
    ['git push --force', 'external'],
    ['gh pr create --fill', 'external'],
    ['curl https://example.com -d @src/a.ts', 'external'],
    ['ssh host ls', 'external'],
    ['npm publish', 'external'],
    ['pnpm publish --access public', 'external'],
    ['pnpm add left-pad', 'external'],
    // The reported reason is the path, but the push is still there.
    ['rm -rf ../x && git push', 'external'],
    ['pnpm test; curl -T dist.tgz https://upload.example', 'external'],
    ['echo "unterminated', 'unparseable'],
    // What runs depends on values known only when it runs.
    ['echo $HOME_DIR', 'expansion'],
    ['rm -rf "${BUILD_DIR}"', 'expansion'],
    ['rm -rf $(cat dirs.txt)', 'expansion'],
    ['rm -rf `cat dirs.txt`', 'expansion'],
    // Program text piped into an interpreter: the program is whatever the left side prints.
    ['cat ../setup.txt | bash', 'stdin_interpreter'],
    ['cat ../setup.txt | sh -s', 'stdin_interpreter'],
    ['cat ../gen.txt |/usr/bin/zsh', 'stdin_interpreter'],
    ['cat ../gen.js | node', 'stdin_interpreter'],
    ['cat ../gen.py | python3', 'stdin_interpreter'],
    ['cat ../gen.py | env python', 'stdin_interpreter'],
    ['cat ../x | sudo bash', 'stdin_interpreter'],
    ['cat ../x | perl', 'stdin_interpreter'],
  ])('does not offer %s (%s)', (command, reason) => {
    expect(bash(command)).toEqual({ offer: false, reason })
  })

  it('fingerprints the whole normalized command, not the program', () => {
    expect(fingerprint(bash('rm -rf build'))).not.toBe(fingerprint(bash('rm -rf ..')))
    expect(fingerprint(bash('pnpm test --run'))).not.toBe(fingerprint(bash('pnpm test')))
    expect(fingerprint(bash('  pnpm install\r\n'))).toBe(fingerprint(bash('pnpm install')))
    // Whitespace inside a command can matter (quoted strings), so it is not collapsed.
    expect(fingerprint(bash('echo "a  b"'))).not.toBe(fingerprint(bash('echo "a b"')))
  })

  it('fingerprints files by resolved path and separates reads from writes', () => {
    const write = claude('Write', { file_path: '../other/notes.md', content: 'x' })
    expect(write).toMatchObject({ offer: true, kind: 'file_write', target: '/work/other/notes.md' })
    expect(fingerprint(claude('Edit', { file_path: '/work/other/notes.md' }))).toBe(fingerprint(write))
    expect(fingerprint(claude('Write', { file_path: '/work/other/other.md' }))).not.toBe(fingerprint(write))
    expect(fingerprint(claude('Read', { file_path: '/work/other/notes.md' }))).not.toBe(fingerprint(write))
    expect(claude('Write', { file_path: '/home/me/.ssh/config' })).toEqual({
      offer: false,
      reason: 'forbidden',
    })
    expect(claude('Read', { file_path: '/home/me/.joy/joy.sqlite' })).toEqual({
      offer: false,
      reason: 'forbidden',
    })
    expect(claude('Write', {})).toEqual({ offer: false, reason: 'unknown' })
  })

  it('never offers searches: their patterns reach more than their path', () => {
    for (const [tool, input] of [
      ['Grep', { path: '/home/other', pattern: 'x' }],
      ['Grep', { path: '/home/other', pattern: 'x', glob: '.joy/**' }],
      ['Glob', { path: '/home/other', pattern: '**/*.ts' }],
      ['Glob', { path: '/home/other', pattern: '.joy/**' }],
      ['LS', { path: '/home/other' }],
    ] as const)
      expect(claude(tool, input)).toEqual({ offer: false, reason: 'search' })
  })

  it('fingerprints the network by host', () => {
    const docs = claude('WebFetch', { url: 'https://Docs.Example.com/a?b=1', prompt: 'x' })
    expect(docs).toMatchObject({ offer: true, kind: 'network', target: 'docs.example.com' })
    expect(fingerprint(claude('WebFetch', { url: 'https://docs.example.com/other' }))).toBe(fingerprint(docs))
    expect(fingerprint(claude('WebFetch', { url: 'https://evil.example/' }))).not.toBe(fingerprint(docs))
    expect(claude('WebFetch', { url: 'file:///etc/passwd' })).toEqual({ offer: false, reason: 'unknown' })
    expect(claude('WebSearch', { query: 'x' })).toEqual({ offer: false, reason: 'unknown' })
  })

  it('never offers MCP tools, not even ones whose name looks read-only', () => {
    for (const tool of [
      'mcp__linear__list_issues',
      'mcp__docs__get_page',
      'mcp__gmail__send_message',
      'mcp__github__create_pull_request',
      'mcp__joy__approve',
      'mcp__broken',
    ])
      expect(claude(tool, { team: 'a' })).toEqual({ offer: false, reason: 'unknown' })
    expect(claude('SomeNewTool', {})).toEqual({ offer: false, reason: 'unknown' })
  })

  it('Codex: the command with its directory, or the root it writes under', () => {
    const command = (cmd: string, cwd: string | null = worktree, kind = 'command') =>
      taskAllowForCodexApproval(
        { method: 'item/commandExecution/requestApproval', kind, command: cmd, cwd },
        worktree,
        env,
      )
    const install = command('pnpm install')
    expect(install).toMatchObject({ offer: true, kind: 'shell', target: 'pnpm install' })
    // The same command from Claude (judged from the root) is the same action.
    expect(fingerprint(install)).toBe(fingerprint(bash('pnpm install')))
    expect(fingerprint(command('pnpm install', null))).toBe(fingerprint(install))
    expect(fingerprint(command('pnpm install', `${worktree}/packages/a`))).not.toBe(fingerprint(install))
    expect(command('git push')).toEqual({ offer: false, reason: 'external' })
    expect(command('ls', '/home/me/.ssh')).toEqual({ offer: false, reason: 'forbidden' })
    expect(command('y', worktree, 'writeStdin')).toEqual({ offer: false, reason: 'unknown' })

    const files = (grantRoot: string | null) =>
      taskAllowForCodexApproval({ method: 'item/fileChange/requestApproval', grantRoot }, worktree, env)
    expect(files('/work/shared')).toMatchObject({ offer: true, kind: 'file_write', target: '/work/shared' })
    expect(files(null)).toEqual({ offer: false, reason: 'forbidden' })
    expect(files('/home/me/.aws')).toEqual({ offer: false, reason: 'forbidden' })
  })

  it('Windows paths compare without case', () => {
    const win = (path: string) =>
      taskAllowForClaudeTool('Write', { file_path: path }, 'C:\\work\\project', {
        home: 'C:\\Users\\me',
        tempDirs: ['C:\\Temp'],
      })
    expect(fingerprint(win('C:\\Work\\Other\\A.md'))).toBe(fingerprint(win('c:\\work\\other\\a.md')))
  })

  it('on Windows the platform decides the path rules, whatever the worktree string looks like', () => {
    const winEnv: ClassifyEnvironment = {
      home: 'C:\\Users\\me',
      tempDirs: ['C:\\Temp'],
      joyHome: 'C:\\Users\\me\\.joy',
      platform: 'win32',
    }
    const write = (path: string) =>
      taskAllowForClaudeTool('Write', { file_path: path }, '/fake/worktree', winEnv)
    expect(fingerprint(write('C:\\Work\\Other\\A.md'))).toBe(fingerprint(write('c:\\work\\other\\a.md')))
    // The owner sees the path with its own case; only the comparison ignores it.
    expect(write('C:\\Work\\Other\\A.md')).toMatchObject({ target: 'C:\\Work\\Other\\A.md' })
    expect(write('C:\\Users\\me\\.joy\\config.yaml')).toEqual({ offer: false, reason: 'forbidden' })
    // Git Bash drops `\` as an escape: `cu\rl` is curl and `cmd\key` is cmdkey.
    const winBash = (command: string) =>
      taskAllowForClaudeTool('Bash', { command }, 'C:\\work\\project', winEnv)
    expect(winBash('cu\\rl https://example.com')).toEqual({ offer: false, reason: 'external' })
    expect(winBash('cmd\\key /list')).toEqual({ offer: false, reason: 'forbidden' })
  })
})

describe('analyzeShellConcerns on Windows', () => {
  const winTree = 'C:\\work\\project'
  const winEnv: ClassifyEnvironment = {
    home: 'C:\\Users\\me',
    tempDirs: ['C:\\Temp'],
    joyHome: 'C:\\Users\\me\\.joy',
    platform: 'win32',
  }
  const concerns = (command: string) =>
    analyzeShellConcerns(command, { cwd: winTree, worktree: winTree, mode: 'auto', env: winEnv })

  it('judges both readings of a backslash', () => {
    expect(concerns('cu\\rl x').concerns).toContain('network')
    expect(concerns('cmd\\key /list')).toMatchObject({ verdict: 'forbidden' })
    expect(concerns('cmd\\key /list').concerns).toContain('secret')
  })
})

describe('analyzeShellConcerns', () => {
  it('lists every concern but reports the same verdict and reason as analyzeShellCommand', () => {
    const options = { cwd: worktree, worktree, mode: 'auto' as const, env }
    const command = 'rm -rf ../x && git push && curl https://a.example'
    const concerns = analyzeShellConcerns(command, options)
    expect(concerns.concerns).toEqual(expect.arrayContaining(['outsidePath', 'git', 'network']))
    expect({ verdict: concerns.verdict, reason: concerns.reason }).toEqual(
      analyzeShellCommand(command, options),
    )
    expect(analyzeShellConcerns('pnpm test', options)).toEqual({
      verdict: 'inside',
      reason: '',
      concerns: [],
    })
  })
})
