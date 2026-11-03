import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttemptId, RepoId, RepoRef, TaskId } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { git } from './git.js'
import { WorktreeExecutor, assertSafeId, parseNameStatus, parseNumstat } from './worktree.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tid = (s: string) => s as TaskId
const aid = (s: string) => s as AttemptId

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'joy-exec-')))
  dirs.push(root)
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath)
  await git(repoPath, ['init', '-q', '-b', 'main'])
  await git(repoPath, ['config', 'user.name', 'Test'])
  await git(repoPath, ['config', 'user.email', 'test@example.com'])
  writeFileSync(join(repoPath, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(repoPath, 'gone.txt'), 'bye\n')
  writeFileSync(join(repoPath, 'old-name.txt'), 'same content for rename detection\n'.repeat(5))
  await git(repoPath, ['add', '.'])
  await git(repoPath, ['commit', '-qm', 'init'])
  const repo: RepoRef = { id: 'r1' as RepoId, path: repoPath, defaultBranch: 'main' }
  const executor = new WorktreeExecutor({ worktreesDir: join(root, 'worktrees') })
  return { root, repo, executor }
}

describe('WorktreeExecutor', () => {
  it('creates a worktree on a new branch from the default branch', async () => {
    const { repo, executor, root } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    expect(ws.path).toBe(join(root, 'worktrees', 'r1', 't1-a1'))
    expect(ws.branch).toBe('joy/t1/a1')
    expect(ws.baseCommit).toBe((await git(repo.path, ['rev-parse', 'main'])).trim())
    expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect((await git(ws.path, ['branch', '--show-current'])).trim()).toBe('joy/t1/a1')
  })

  it('keeps three parallel attempts on the same repo independent', async () => {
    const { repo, executor } = await setup()
    const wss = await Promise.all(['a1', 'a2', 'a3'].map((a) => executor.prepare(repo, tid('t1'), aid(a))))
    wss.forEach((ws, i) => writeFileSync(join(ws.path, 'a.txt'), `attempt ${i}\n`))
    for (const [i, ws] of wss.entries()) {
      expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe(`attempt ${i}\n`)
      const diff = await executor.diff(ws)
      expect(diff.files).toEqual([{ path: 'a.txt', status: 'modified', additions: 1, deletions: 2 }])
    }
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect((await git(repo.path, ['status', '--porcelain'])).trim()).toBe('')
  })

  it('diffs added, modified, deleted, renamed and untracked files, including commits', async () => {
    const { repo, executor } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    writeFileSync(join(ws.path, 'a.txt'), 'one\nTWO\nthree\n')
    unlinkSync(join(ws.path, 'gone.txt'))
    renameSync(join(ws.path, 'old-name.txt'), join(ws.path, 'new-name.txt'))
    mkdirSync(join(ws.path, 'src'))
    writeFileSync(join(ws.path, 'src', 'new file.ts'), 'export {}\n')
    await git(ws.path, ['add', 'a.txt'])
    await git(ws.path, ['commit', '-qm', 'agent committed part of it'])

    const diff = await executor.diff(ws)
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]))
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', status: 'modified', additions: 2, deletions: 1 })
    expect(byPath['gone.txt']).toEqual({ path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 })
    expect(byPath['new-name.txt']).toEqual({
      path: 'new-name.txt',
      oldPath: 'old-name.txt',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    })
    expect(byPath['src/new file.ts']).toEqual({
      path: 'src/new file.ts',
      status: 'added',
      additions: 1,
      deletions: 0,
    })
    expect(diff.patch).toContain('+TWO')
    expect(diff.patch).toContain('rename from old-name.txt')
  })

  it('commits everything and returns the sha, or null when there is nothing to commit', async () => {
    const { repo, executor } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    expect(await executor.commit(ws, 'nothing')).toBeNull()
    writeFileSync(join(ws.path, 'b.txt'), 'new\n')
    const sha = await executor.commit(ws, 'Add b')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect((await git(ws.path, ['log', '-1', '--format=%s'])).trim()).toBe('Add b')
    expect((await git(ws.path, ['status', '--porcelain'])).trim()).toBe('')
  })

  it('commits with a fallback identity when the repo has none', async () => {
    const { repo, executor } = await setup()
    await git(repo.path, ['config', '--unset', 'user.name'])
    await git(repo.path, ['config', '--unset', 'user.email'])
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    writeFileSync(join(ws.path, 'b.txt'), 'new\n')
    const env = {
      ...process.env,
      HOME: ws.path,
      XDG_CONFIG_HOME: ws.path,
      GIT_CONFIG_GLOBAL: join(ws.path, 'none'),
    }
    const prev = { ...process.env }
    Object.assign(process.env, env)
    try {
      expect(await executor.commit(ws, 'Add b')).toMatch(/^[0-9a-f]{40}$/)
      expect((await git(ws.path, ['log', '-1', '--format=%an <%ae>'])).trim()).toBe('Joy <joy@localhost>')
    } finally {
      process.env = prev
    }
  })

  it('cleans up the worktree and branch, and tolerates a second cleanup', async () => {
    const { repo, executor } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    await executor.cleanup(ws)
    expect(existsSync(ws.path)).toBe(false)
    expect((await git(repo.path, ['branch', '--list', ws.branch])).trim()).toBe('')
    expect(await git(repo.path, ['worktree', 'list'])).not.toContain('t1-a1')
    await expect(executor.cleanup(ws)).resolves.toBeUndefined()
  })

  it('rejects ids that could escape the worktrees directory', async () => {
    const { repo, executor } = await setup()
    await expect(executor.prepare(repo, tid('../evil'), aid('a1'))).rejects.toThrow(/Unsafe task id/)
    await expect(executor.prepare(repo, tid('t1'), aid('a/b'))).rejects.toThrow(/Unsafe attempt id/)
  })

  it('fails clearly when the default branch does not exist', async () => {
    const { repo, executor } = await setup()
    await expect(executor.prepare({ ...repo, defaultBranch: 'nope' }, tid('t1'), aid('a1'))).rejects.toThrow(
      /git rev-parse --verify nope/,
    )
  })
})

describe('assertSafeId', () => {
  it('accepts uuids and short ids', () => {
    expect(() => assertSafeId('x', '3b4e2d38-6e3b-4a6a-acd8-03d6bc29fd7f')).not.toThrow()
    expect(() => assertSafeId('x', 'task_1.2')).not.toThrow()
  })
  it('rejects empty, dot-dot and separators', () => {
    for (const bad of ['', '..', 'a..b', '.hidden', 'a/b', 'a\\b', 'x'.repeat(65)]) {
      expect(() => assertSafeId('x', bad)).toThrow()
    }
  })
})

describe('git output parsers', () => {
  it('parses -z name-status including renames', () => {
    expect(parseNameStatus('M\0a.txt\0R087\0old.txt\0new.txt\0A\0b c.txt\0')).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'new.txt', oldPath: 'old.txt', status: 'renamed' },
      { path: 'b c.txt', status: 'added' },
    ])
  })
  it('parses -z numstat including renames and binary files', () => {
    const stats = parseNumstat('3\t1\ta.txt\0' + '0\t0\t\0old.txt\0new.txt\0' + '-\t-\timg.png\0')
    expect(Object.fromEntries(stats)).toEqual({
      'a.txt': { additions: 3, deletions: 1 },
      'new.txt': { additions: 0, deletions: 0 },
      'img.png': { additions: 0, deletions: 0 },
    })
  })
})
