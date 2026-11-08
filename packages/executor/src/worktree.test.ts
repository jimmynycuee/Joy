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
  symlinkSync,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttemptId, RepoId, RepoRef, TaskId } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { git } from './git.js'
import {
  WorktreeExecutor,
  assertSafeId,
  parseNameStatus,
  parseNumstat,
  parseWorktreeList,
} from './worktree.js'

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
  // Windows runners default to autocrlf=true, which would rewrite the files these tests compare.
  await git(repoPath, ['config', 'core.autocrlf', 'false'])
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

  it('requires confirmation before deleting a worktree with unpushed commits', async () => {
    const { repo, executor } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    writeFileSync(join(ws.path, 'b.txt'), 'first\n')
    await executor.commit(ws, 'Add b')
    writeFileSync(join(ws.path, 'c.txt'), 'second\n')
    await executor.commit(ws, 'Add c')

    await expect(executor.cleanup(ws)).rejects.toThrow(/2 unpushed commits/)
    expect(existsSync(ws.path)).toBe(true)
    expect((await git(repo.path, ['branch', '--list', ws.branch])).trim()).not.toBe('')

    await executor.cleanup(ws, { confirmedUnpushedCommits: true })
    expect(existsSync(ws.path)).toBe(false)
  })

  it('allows cleanup once the worktree commits are pushed to a remote', async () => {
    const { repo, executor, root } = await setup()
    const remotePath = join(root, 'remote.git')
    await git(root, ['init', '--bare', '-q', remotePath])
    await git(repo.path, ['remote', 'add', 'origin', remotePath])
    await git(repo.path, ['push', '-q', 'origin', 'main'])
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    writeFileSync(join(ws.path, 'b.txt'), 'pushed\n')
    await executor.commit(ws, 'Add b')
    await git(ws.path, ['push', '-q', '-u', 'origin', ws.branch])

    await expect(executor.cleanup(ws)).resolves.toBeUndefined()
    expect(existsSync(ws.path)).toBe(false)
  }, 30_000)

  it('reports managed worktree activity, disk usage, and configurable staleness', async () => {
    const { repo, root } = await setup()
    const executor = new WorktreeExecutor({ worktreesDir: join(root, 'worktrees'), staleAfterDays: 0 })
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    writeFileSync(join(ws.path, 'payload.bin'), Buffer.alloc(1024))

    const worktrees = await executor.listWorktrees(repo)
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0]).toMatchObject({ path: await realpath(ws.path), branch: ws.branch, stale: true })
    expect(worktrees[0]?.headCommit).toBe(ws.baseCommit)
    expect(worktrees[0]?.lastActivityAt).toBeInstanceOf(Date)
    expect(worktrees[0]?.diskUsageBytes).toBeGreaterThanOrEqual(1024)
  })

  it('lists worktrees when the managed worktree directory resolves through a junction', async () => {
    const { repo, root } = await setup()
    const actualDir = join(root, 'actual-worktrees')
    const linkedDir = join(root, 'worktrees')
    mkdirSync(actualDir)
    symlinkSync(actualDir, linkedDir, 'junction')
    const executor = new WorktreeExecutor({ worktreesDir: linkedDir })
    await executor.prepare(repo, tid('t1'), aid('a1'))

    await expect(executor.listWorktrees(repo)).resolves.toHaveLength(1)
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
  it.each(['\0', '\0\0', '\0\n'])('parses worktree records separated by %j', (separator) => {
    const main = ['worktree C:\\repo', 'HEAD abc123', 'branch refs/heads/main'].join('\0')
    const managed = [
      'worktree C:\\repo\\worktrees\\r1\\t1-a1',
      'HEAD def456',
      'branch refs/heads/joy/t1/a1',
    ].join('\0')

    expect(parseWorktreeList(`${main}${separator}${managed}`)).toEqual([
      { path: 'C:\\repo', branch: 'main', headCommit: 'abc123' },
      { path: 'C:\\repo\\worktrees\\r1\\t1-a1', branch: 'joy/t1/a1', headCommit: 'def456' },
    ])
  })

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

describe('WorktreeExecutor checks and checkpoints', () => {
  it('runs a command in the worktree without a shell and keeps the output tail', async () => {
    const { repo, executor } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    const ok = await executor.run(ws, {
      command: process.execPath,
      args: ['-e', 'console.log("x".repeat(10)); console.error(process.cwd()); process.exit(3)'],
    })
    expect(ok.exitCode).toBe(3)
    expect(ok.output).toContain('xxxxxxxxxx')
    expect(ok.output).toContain(realpathSync(ws.path))
    const literal = await executor.run(ws, {
      command: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', '$(echo hi) && rm -rf x'],
    })
    expect(literal.output.trim()).toBe('$(echo hi) && rm -rf x')
    const slow = await executor.run(ws, {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 50,
    })
    expect(slow).toMatchObject({ timedOut: true })
    const missing = await executor.run(ws, { command: 'joy-no-such-program', args: [] })
    expect(missing.exitCode).toBeNull()
    expect(missing.spawnError).toBe('ENOENT')
  })

  it('stops the whole process tree on timeout, even a SIGTERM-ignoring child with a grandchild holding the pipes', async () => {
    const { repo, executor } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    // The grandchild inherits stdout/stderr and prints its pid; the child ignores SIGTERM.
    const script = [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGTERM', () => {})",
      "spawn(process.execPath, ['-e', 'console.log(\"grandchild \" + process.pid); setTimeout(() => {}, 20000)'], { stdio: 'inherit' })",
      'setTimeout(() => {}, 20000)',
    ].join(';')
    let stopped = 0
    const started = Date.now()
    const result = await executor.run(ws, {
      command: process.execPath,
      args: ['-e', script],
      timeoutMs: 500,
      onStop: () => stopped++,
    })
    const elapsed = Date.now() - started
    expect(result.timedOut).toBe(true)
    expect(stopped).toBe(1)
    // 500 ms timeout + 2 s grace, with room for a slow runner; the scripts would run for 20 s.
    expect(elapsed).toBeLessThan(6_000)
    const pid = Number(/grandchild (\d+)/.exec(result.output)?.[1])
    expect(pid).toBeGreaterThan(0)
    if (process.platform !== 'win32') {
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(() => process.kill(pid, 0)).toThrow()
    }
  }, 15_000)

  it('stops a running command when the signal aborts', async () => {
    const { repo, executor } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const started = Date.now()
    const result = await executor.run(ws, {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 20000)'],
      signal: controller.signal,
    })
    expect(result.timedOut).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('reports, instead of swallowing, a failure to delete checkpoint refs on cleanup', async () => {
    const { repo, root } = await setup()
    const warnings: string[] = []
    const executor = new WorktreeExecutor({
      worktreesDir: join(root, 'worktrees'),
      onWarning: (message) => warnings.push(message),
    })
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    await executor.cleanup({ ...ws, taskId: tid('bad..id') })
    expect(warnings).toEqual([expect.stringContaining('checkpoint refs of task bad..id')])
  })

  it('checkpoints without moving the branch and restores files, refusing to drop later commits unconfirmed', async () => {
    const { repo, executor } = await setup()
    const ws = await executor.prepare(repo, tid('t1'), aid('a1'))
    const branchHead = async () => (await git(ws.path, ['rev-parse', 'HEAD'])).trim()
    const start = await branchHead()
    writeFileSync(join(ws.path, 'a.txt'), 'checkpoint one\n')
    writeFileSync(join(ws.path, 'new.txt'), 'untracked at checkpoint\n')
    unlinkSync(join(ws.path, 'gone.txt'))
    const first = await executor.checkpoint(ws, 'refs/joy/checkpoints/t1/1', 'Joy checkpoint 1')
    expect(first.head).toBe(start)
    expect(await branchHead()).toBe(start)
    expect((await git(repo.path, ['status', '--porcelain'])).trim()).toBe('')

    writeFileSync(join(ws.path, 'a.txt'), 'later\n')
    writeFileSync(join(ws.path, 'later.txt'), 'created later\n')
    writeFileSync(join(ws.path, 'gone.txt'), 'back again\n')
    await git(ws.path, ['add', '--all'])
    await git(ws.path, ['commit', '-qm', 'agent commit'])

    await expect(executor.restoreCheckpoint(ws, 'refs/joy/checkpoints/t1/1')).rejects.toThrow(
      'discard 1 commit',
    )
    const restored = await executor.restoreCheckpoint(ws, 'refs/joy/checkpoints/t1/1', {
      confirmDiscardCommits: true,
    })
    expect(restored).toEqual({ commit: first.commit, discardedCommits: 1 })
    expect(await branchHead()).toBe(start)
    expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('checkpoint one\n')
    expect(readFileSync(join(ws.path, 'new.txt'), 'utf8')).toBe('untracked at checkpoint\n')
    expect(existsSync(join(ws.path, 'later.txt'))).toBe(false)
    expect(existsSync(join(ws.path, 'gone.txt'))).toBe(false)
    // The main checkout is untouched.
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('one\ntwo\n')

    await expect(executor.checkpoint(ws, 'refs/heads/main', 'nope')).rejects.toThrow(
      'Not a Joy checkpoint ref',
    )
    await expect(
      executor.restoreCheckpoint({ ...ws, path: repo.path }, 'refs/joy/checkpoints/t1/1'),
    ).rejects.toThrow('main checkout')

    await executor.cleanup(ws, { confirmedUnpushedCommits: true })
    expect((await git(repo.path, ['for-each-ref', 'refs/joy/'])).trim()).toBe('')
  })
})
