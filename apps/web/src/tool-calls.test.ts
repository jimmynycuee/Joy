import { describe, expect, it } from 'vitest'
import { relativePath, summarizeToolCall, toolCallLabel, toolOutputText } from './tool-calls.js'

describe('summarizeToolCall', () => {
  it('shows the command for Claude Bash and Codex shell calls', () => {
    const bash = summarizeToolCall('Bash', { command: 'pnpm test', description: 'run tests' })
    expect(bash).toEqual({ kind: 'command', verb: '執行', detail: 'pnpm test' })
    expect(toolCallLabel(bash)).toBe('$ pnpm test')
    expect(toolCallLabel(summarizeToolCall('shell', { command: 'git status' }))).toBe('$ git status')
    expect(toolCallLabel(summarizeToolCall('shell', { command: ['git', 'diff', '--stat'] }))).toBe(
      '$ git diff --stat',
    )
  })

  it('shows the file path for Edit, Write and Read, relative to the worktree', () => {
    const root = '/Users/me/.joy/worktrees/task-1'
    expect(summarizeToolCall('Edit', { file_path: `${root}/src/a.ts`, old_string: 'x' }, root)).toEqual({
      kind: 'file',
      verb: '編輯',
      detail: 'src/a.ts',
    })
    expect(toolCallLabel(summarizeToolCall('Write', { file_path: '/elsewhere/b.ts' }, root))).toBe(
      '寫入 /elsewhere/b.ts',
    )
    expect(toolCallLabel(summarizeToolCall('Read', { file_path: `${root}/README.md` }, root))).toBe(
      '讀取 README.md',
    )
  })

  it('summarises search tools', () => {
    expect(toolCallLabel(summarizeToolCall('Grep', { pattern: 'TODO', path: '/w/src' }, '/w'))).toBe(
      '搜尋 TODO  src',
    )
    expect(toolCallLabel(summarizeToolCall('Glob', { pattern: '**/*.ts' }))).toBe('找檔案 **/*.ts')
    expect(toolCallLabel(summarizeToolCall('web_search', { query: 'vitest projects' }))).toBe(
      '搜尋網路 vitest projects',
    )
  })

  it('falls back to the tool name and first string argument', () => {
    expect(summarizeToolCall('mcp__joy__ask_peer', { question: 'Is this safe?' })).toEqual({
      kind: 'other',
      verb: 'ask_peer',
      detail: 'Is this safe?',
    })
    expect(summarizeToolCall('SomethingNew', { count: 3 })).toEqual({
      kind: 'other',
      verb: 'SomethingNew',
      detail: '',
    })
  })

  it('never throws on missing or odd input', () => {
    expect(summarizeToolCall('Bash', undefined).detail).toBe('')
    expect(summarizeToolCall('Edit', 'not an object').detail).toBe('')
    expect(summarizeToolCall('Bash', { command: 42 }).detail).toBe('')
    expect(toolCallLabel(summarizeToolCall('Bash', {}))).toBe('$')
  })

  it('shows only the first line of a multi-line command in the label', () => {
    const summary = summarizeToolCall('Bash', { command: 'cat <<EOF\nhello\nEOF' })
    expect(toolCallLabel(summary)).toBe('$ cat <<EOF')
    expect(summary.detail).toContain('hello')
  })
})

describe('relativePath', () => {
  it('only strips a real directory prefix', () => {
    expect(relativePath('/w/src/a.ts', '/w')).toBe('src/a.ts')
    expect(relativePath('/work/a.ts', '/w')).toBe('/work/a.ts')
    expect(relativePath('/w/src/a.ts')).toBe('/w/src/a.ts')
  })
})

describe('toolOutputText', () => {
  it('reads strings, content parts and Codex command output', () => {
    expect(toolOutputText('ok\n\n').text).toBe('ok')
    expect(
      toolOutputText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]).text,
    ).toBe('a\nb')
    expect(toolOutputText({ output: 'built', exitCode: 0 }).text).toBe('built')
    expect(toolOutputText(null).text).toBe('')
  })

  it('truncates long output and says so', () => {
    const result = toolOutputText('x'.repeat(5000), 100)
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith('x'.repeat(100))).toBe(true)
    expect(result.text).toContain('已省略 4900')
  })
})
