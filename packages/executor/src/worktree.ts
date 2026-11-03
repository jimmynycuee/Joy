import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AttemptId, DiffFile, Executor, RepoRef, TaskId, Workspace, WorkspaceDiff } from '@joy/core'
import { KeyedMutex, git } from './git.js'

export interface WorktreeExecutorOptions {
  /** Where worktrees are created: `<worktreesDir>/<repoId>/<taskId>-<attemptId>`. Usually `~/.joy/worktrees`. */
  worktreesDir: string
  /** Branch prefix. Default `joy`. */
  branchPrefix?: string
  /** Used for commits when the repo has no user.name / user.email configured. */
  fallbackIdentity?: { name: string; email: string }
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Ids end up in paths and branch names, so only a conservative character set is accepted. */
export function assertSafeId(kind: string, id: string): void {
  if (!SAFE.test(id) || id.includes('..')) {
    throw new Error(
      `Unsafe ${kind} "${id}": use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
    )
  }
}

export class WorktreeExecutor implements Executor {
  private readonly dir: string
  private readonly prefix: string
  private readonly identity: { name: string; email: string }
  private readonly locks = new KeyedMutex()

  constructor(options: WorktreeExecutorOptions) {
    this.dir = resolve(options.worktreesDir)
    this.prefix = options.branchPrefix ?? 'joy'
    this.identity = options.fallbackIdentity ?? { name: 'Joy', email: 'joy@localhost' }
  }

  async prepare(repo: RepoRef, taskId: TaskId, attemptId: AttemptId): Promise<Workspace> {
    assertSafeId('repo id', repo.id)
    assertSafeId('task id', taskId)
    assertSafeId('attempt id', attemptId)
    const path = join(this.dir, repo.id, `${taskId}-${attemptId}`)
    const branch = `${this.prefix}/${taskId}/${attemptId}`

    return this.locks.run(repo.path, async () => {
      const baseCommit = (
        await git(repo.path, ['rev-parse', '--verify', `${repo.defaultBranch}^{commit}`])
      ).trim()
      await mkdir(join(this.dir, repo.id), { recursive: true })
      await git(repo.path, ['worktree', 'add', '-b', branch, path, baseCommit])
      return { repo, taskId, attemptId, path, branch, baseCommit }
    })
  }

  /** Everything that differs from `baseCommit`: committed, staged, unstaged and untracked. */
  async diff(ws: Workspace): Promise<WorkspaceDiff> {
    await git(ws.path, ['add', '--all'])
    const [nameStatus, numstat, patch] = await Promise.all([
      git(ws.path, ['diff', '--cached', '-M', '--name-status', '-z', ws.baseCommit]),
      git(ws.path, ['diff', '--cached', '-M', '--numstat', '-z', ws.baseCommit]),
      git(ws.path, ['diff', '--cached', '-M', '--no-color', ws.baseCommit]),
    ])
    return { files: mergeStats(parseNameStatus(nameStatus), parseNumstat(numstat)), patch }
  }

  async commit(ws: Workspace, message: string): Promise<string | null> {
    await git(ws.path, ['add', '--all'])
    const staged = await git(ws.path, ['diff', '--cached', '--name-only'])
    if (staged.trim() === '') return null
    const identity: string[] = []
    if (!(await configured(ws.path, 'user.name'))) identity.push('-c', `user.name=${this.identity.name}`)
    if (!(await configured(ws.path, 'user.email'))) identity.push('-c', `user.email=${this.identity.email}`)
    await git(ws.path, [...identity, 'commit', '--no-verify', '-q', '-m', message])
    return (await git(ws.path, ['rev-parse', 'HEAD'])).trim()
  }

  /** Removes the worktree and its branch. Safe to call twice. */
  async cleanup(ws: Workspace): Promise<void> {
    await this.locks.run(ws.repo.path, async () => {
      try {
        await git(ws.repo.path, ['worktree', 'remove', '--force', ws.path])
      } catch {
        // Already removed, or git lost track of it: fall through to manual cleanup.
      }
      await rm(ws.path, { recursive: true, force: true })
      await git(ws.repo.path, ['worktree', 'prune'])
      try {
        await git(ws.repo.path, ['branch', '-D', ws.branch])
      } catch {
        // Branch already gone.
      }
    })
  }
}

async function configured(cwd: string, key: string): Promise<boolean> {
  try {
    return (await git(cwd, ['config', '--get', key])).trim() !== ''
  } catch {
    return false
  }
}

/** Parses `git diff --name-status -z`: `M\0path\0`, `R100\0old\0new\0`. */
export function parseNameStatus(out: string): Omit<DiffFile, 'additions' | 'deletions'>[] {
  const parts = out.split('\0').filter((p) => p !== '')
  const files: Omit<DiffFile, 'additions' | 'deletions'>[] = []
  for (let i = 0; i < parts.length;) {
    const code = parts[i++] ?? ''
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = parts[i++] ?? ''
      const path = parts[i++] ?? ''
      files.push(code.startsWith('R') ? { path, oldPath, status: 'renamed' } : { path, status: 'added' })
    } else {
      const path = parts[i++] ?? ''
      files.push({ path, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' })
    }
  }
  return files
}

/** Parses `git diff --numstat -z`. Binary files report `-`; they count as 0. Renames use `\0old\0new\0`. */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length;) {
    const head = parts[i++] ?? ''
    if (head === '') continue
    const [add = '0', del = '0', inlinePath = ''] = head.split('\t')
    let path = inlinePath
    if (path === '') {
      i++ // old path
      path = parts[i++] ?? ''
    }
    stats.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 })
  }
  return stats
}

function mergeStats(
  files: Omit<DiffFile, 'additions' | 'deletions'>[],
  stats: Map<string, { additions: number; deletions: number }>,
): DiffFile[] {
  return files.map((f) => ({ ...f, ...(stats.get(f.path) ?? { additions: 0, deletions: 0 }) }))
}
