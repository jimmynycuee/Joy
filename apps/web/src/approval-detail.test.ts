import { describe, expect, it } from 'vitest'
import { approvalTarget } from './approval-detail.js'

describe('approvalTarget', () => {
  it('shows the command of a Claude Bash request', () => {
    expect(approvalTarget({ command: 'rm -rf ../elsewhere', description: 'clean' })).toEqual({
      label: '指令',
      text: 'rm -rf ../elsewhere',
    })
  })

  it('shows a Codex command with where it runs', () => {
    expect(
      approvalTarget({
        method: 'item/commandExecution/requestApproval',
        command: "bash -lc 'curl x'",
        cwd: '/w',
      }),
    ).toEqual({ label: '指令', text: "bash -lc 'curl x'", cwd: '/w' })
  })

  it('joins a project check argv', () => {
    expect(approvalTarget({ command: ['bash', '-c', 'pnpm check'], cwd: '/w' })?.text).toBe(
      'bash -c pnpm check',
    )
  })

  it('shows files, directories, URLs and searches', () => {
    expect(approvalTarget({ file_path: '/etc/hosts', content: 'x' })).toEqual({
      label: '檔案',
      text: '/etc/hosts',
    })
    expect(approvalTarget({ notebook_path: 'a.ipynb' })?.label).toBe('檔案')
    expect(approvalTarget({ method: 'item/fileChange/requestApproval', grantRoot: '/home/me' })).toEqual({
      label: '目錄',
      text: '/home/me',
    })
    expect(approvalTarget({ url: 'https://example.com', prompt: 'p' })).toEqual({
      label: '網址',
      text: 'https://example.com',
    })
    expect(approvalTarget({ query: 'vitest' })).toEqual({ label: '搜尋', text: 'vitest' })
  })

  it('shows nothing for details it does not know, and clips very long commands', () => {
    expect(approvalTarget(undefined)).toBeUndefined()
    expect(approvalTarget('text')).toBeUndefined()
    expect(approvalTarget({ question: 'q' })).toBeUndefined()
    expect(approvalTarget({ command: '' })).toBeUndefined()
    expect(approvalTarget({ command: 'x'.repeat(5000) })?.text).toHaveLength(4001)
  })
})
