import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttemptId, RepoId, RepoRef, TaskId } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { git } from './git.js'
import { MergeConflictError, MergeRefusedError } from './merge.js'
import { WorktreeExecutor } from './worktree.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const messages = { commit: 'Fix add()', merge: 'Merge Joy task: Fix add()' }

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'joy-merge-')))
  dirs.push(root)
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath)
  await git(repoPath, ['init', '-q', '-b', 'main'])
  await git(repoPath, ['config', 'user.name', 'Test'])
  await git(repoPath, ['config', 'user.email', 'test@example.com'])
  await git(repoPath, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repoPath, 'a.txt'), 'one\n')
  writeFileSync(join(repoPath, 'b.txt'), 'bee\n')
  await git(repoPath, ['add', '.'])
  await git(repoPath, ['commit', '-qm', 'init'])
  const repo: RepoRef = { id: 'r1' as RepoId, path: repoPath, defaultBranch: 'main' }
  const executor = new WorktreeExecutor({ worktreesDir: join(root, 'worktrees') })
  const ws = await executor.prepare(repo, 't1' as TaskId, 'a1' as AttemptId)
  return { root, repo, executor, ws }
}

const head = async (cwd: string, ref = 'HEAD') => (await git(cwd, ['rev-parse', ref])).trim()
const status = async (cwd: string) => git(cwd, ['status', '--porcelain'])

async function commitOnMain(repoPath: string, file: string, text: string) {
  writeFileSync(join(repoPath, file), text)
  await git(repoPath, ['add', '.'])
  await git(repoPath, ['commit', '-qm', `owner edits ${file}`])
}

describe('mergeIntoDefaultBranch', () => {
  it('commits the worktree and merges it into the checked-out default branch with a merge commit', async () => {
    const { repo, executor, ws } = await setup()
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')
    writeFileSync(join(ws.path, 'new.txt'), 'new\n')
    const before = await head(repo.path)

    const result = await executor.mergeIntoDefaultBranch(ws, messages)

    expect(result).toMatchObject({ branch: 'main', previousCommit: before, files: 2, updatedCheckout: true })
    expect(await head(repo.path)).toBe(result.commit)
    expect(await head(repo.path, 'main')).toBe(result.commit)
    // The task branch got the same commit the publisher would make, and it is the merge's second parent.
    expect(await head(ws.path)).toBe(result.sourceCommit)
    expect(await head(repo.path, `${result.commit}^2`)).toBe(result.sourceCommit)
    expect((await git(ws.path, ['log', '-1', '--format=%s'])).trim()).toBe('Fix add()')
    expect((await git(repo.path, ['log', '-1', '--format=%s'])).trim()).toBe('Merge Joy task: Fix add()')
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('two\n')
    expect(readFileSync(join(repo.path, 'new.txt'), 'utf8')).toBe('new\n')
    expect(await status(repo.path)).toBe('')
  })

  it('merges even when the owner committed something else on the default branch meanwhile', async () => {
    const { repo, executor, ws } = await setup()
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')
    await commitOnMain(repo.path, 'b.txt', 'owner\n')
    const result = await executor.mergeIntoDefaultBranch(ws, messages)
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('two\n')
    expect(readFileSync(join(repo.path, 'b.txt'), 'utf8')).toBe('owner\n')
    expect(result.files).toBe(1)
  })

  it('refuses when the checked-out default branch has uncommitted changes, and changes nothing', async () => {
    const { repo, executor, ws } = await setup()
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')
    writeFileSync(join(repo.path, 'b.txt'), 'owner is still typing\n')
    const before = await head(repo.path)
    const wsBefore = await head(ws.path)

    const error = await executor.mergeIntoDefaultBranch(ws, messages).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MergeRefusedError)
    expect((error as MergeRefusedError).reason).toBe('dirty_checkout')
    expect(await head(repo.path)).toBe(before)
    expect(readFileSync(join(repo.path, 'b.txt'), 'utf8')).toBe('owner is still typing\n')
    // Not even the task commit was made.
    expect(await head(ws.path)).toBe(wsBefore)
    expect(await status(ws.path)).toContain('a.txt')
  })

  it('refuses while a merge or rebase is in progress in the main checkout', async () => {
    const { repo, executor, ws } = await setup()
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')
    const gitDir = (await git(repo.path, ['rev-parse', '--absolute-git-dir'])).trim()
    writeFileSync(join(gitDir, 'MERGE_HEAD'), `${await head(repo.path)}\n`)
    await expect(executor.mergeIntoDefaultBranch(ws, messages)).rejects.toMatchObject({
      reason: 'operation_in_progress',
    })
  })

  it('aborts a conflicting merge, leaves the checkout as it was and names the conflicting files', async () => {
    const { repo, executor, ws } = await setup()
    writeFileSync(join(ws.path, 'a.txt'), 'task\n')
    await commitOnMain(repo.path, 'a.txt', 'owner\n')
    const before = await head(repo.path)

    const error = await executor.mergeIntoDefaultBranch(ws, messages).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MergeConflictError)
    expect((error as MergeConflictError).files).toEqual(['a.txt'])
    expect(await head(repo.path)).toBe(before)
    expect(await status(repo.path)).toBe('')
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('owner\n')
    const gitDir = (await git(repo.path, ['rev-parse', '--absolute-git-dir'])).trim()
    expect(() => readFileSync(join(gitDir, 'MERGE_HEAD'))).toThrow()
  })

  it('moves a default branch that is not checked out without touching the owner checkout, when it is a fast-forward', async () => {
    const { repo, executor, ws } = await setup()
    await git(repo.path, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo.path, 'b.txt'), 'owner work in progress\n')
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')

    const result = await executor.mergeIntoDefaultBranch(ws, messages)

    expect(result.updatedCheckout).toBe(false)
    expect(await head(repo.path, 'main')).toBe(result.commit)
    expect((await git(repo.path, ['show', 'main:a.txt'])).trim()).toBe('two')
    expect(await head(repo.path, `${result.commit}^2`)).toBe(result.sourceCommit)
    // The owner's branch and files are as they were.
    expect((await git(repo.path, ['branch', '--show-current'])).trim()).toBe('feature')
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(repo.path, 'b.txt'), 'utf8')).toBe('owner work in progress\n')
  })

  it('refuses a default branch that is not checked out and has moved on', async () => {
    const { repo, executor, ws } = await setup()
    await commitOnMain(repo.path, 'b.txt', 'owner\n')
    await git(repo.path, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')
    const main = await head(repo.path, 'main')
    const wsBefore = await head(ws.path)

    await expect(executor.mergeIntoDefaultBranch(ws, messages)).rejects.toMatchObject({
      reason: 'not_fast_forward',
    })
    expect(await head(repo.path, 'main')).toBe(main)
    expect(await head(ws.path)).toBe(wsBefore)
  })

  it('refuses when the default branch is checked out in another worktree', async () => {
    const { root, repo, executor, ws } = await setup()
    await git(repo.path, ['checkout', '-q', '-b', 'feature'])
    await git(repo.path, ['worktree', 'add', '-q', join(root, 'other'), 'main'])
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')
    await expect(executor.mergeIntoDefaultBranch(ws, messages)).rejects.toMatchObject({
      reason: 'checked_out_elsewhere',
    })
  })

  it('refuses a second merge with nothing new', async () => {
    const { repo, executor, ws } = await setup()
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')
    await executor.mergeIntoDefaultBranch(ws, messages)
    const after = await head(repo.path)
    await expect(executor.mergeIntoDefaultBranch(ws, messages)).rejects.toMatchObject({
      reason: 'nothing_to_merge',
    })
    expect(await head(repo.path)).toBe(after)
  })

  it('refuses a task without changes', async () => {
    const { executor, ws } = await setup()
    await expect(executor.mergeIntoDefaultBranch(ws, messages)).rejects.toMatchObject({
      reason: 'nothing_to_merge',
    })
  })

  it('runs no hook of the repository', async () => {
    const { root, repo, executor, ws } = await setup()
    if (process.platform === 'win32') return
    const marker = join(root, 'hook-ran')
    const hooks = join(root, 'hooks')
    mkdirSync(hooks)
    for (const name of ['pre-merge-commit', 'post-merge', 'commit-msg', 'prepare-commit-msg']) {
      writeFileSync(join(hooks, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`)
      chmodSync(join(hooks, name), 0o755)
    }
    await git(repo.path, ['config', 'core.hooksPath', hooks])
    writeFileSync(join(ws.path, 'a.txt'), 'two\n')
    await executor.mergeIntoDefaultBranch(ws, messages)
    // The task commit is the publisher's commit (`--no-verify`); the merge itself runs with an empty hooks folder.
    const ran = (() => {
      try {
        return readFileSync(marker, 'utf8')
      } catch {
        return ''
      }
    })()
    expect(ran).not.toMatch(/pre-merge-commit|post-merge/)
  })
})
