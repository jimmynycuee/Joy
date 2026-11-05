import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AttemptId, DiffFile, Executor, RepoRef, TaskId, Workspace, WorkspaceDiff } from '@joy/core'
import { KeyedMutex, git } from './git.js'

export interface WorktreeExecutorOptions {
  /** Where worktrees are created: `<worktreesDir>/<repoId>/<taskId>-<attemptId>`. Usually `~/.joy/worktrees`. */
  worktreesDir: string
  /** Branch prefix. Default `joy`. */
  branchPrefix?: string
  /** Number of idle days before a worktree is reported as stale. Default 14. */
  staleAfterDays?: number
  /** Used for commits when the repo has no user.name / user.email configured. */
  fallbackIdentity?: { name: string; email: string }
}

export interface WorktreeCleanupOptions {
  /** Set only after the user confirms deletion of commits not present on any remote branch. */
  confirmedUnpushedCommits?: boolean
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  headCommit: string
  /** Latest file or worktree-specific Git metadata modification time, not read/access time. */
  lastActivityAt: Date
  /** Sum of worktree file sizes; the repository's shared .git object store is excluded. */
  diskUsageBytes: number
  unpushedCommitCount: number
  ageDays: number
  stale: boolean
}

export class UnpushedCommitsError extends Error {
  constructor(readonly unpushedCommitCount: number) {
    super(
      `Refusing to remove a worktree with ${unpushedCommitCount} unpushed commit${unpushedCommitCount === 1 ? '' : 's'}; confirm deletion explicitly to continue`,
    )
    this.name = 'UnpushedCommitsError'
  }
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
  private readonly staleAfterDays: number
  private readonly identity: { name: string; email: string }
  private readonly locks = new KeyedMutex()

  constructor(options: WorktreeExecutorOptions) {
    this.dir = resolve(options.worktreesDir)
    this.prefix = options.branchPrefix ?? 'joy'
    this.staleAfterDays = options.staleAfterDays ?? 14
    if (!Number.isFinite(this.staleAfterDays) || this.staleAfterDays < 0) {
      throw new Error('staleAfterDays must be a finite, non-negative number')
    }
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

  /** Lists only worktrees managed under this executor's repository-specific directory. */
  async listWorktrees(repo: RepoRef): Promise<WorktreeInfo[]> {
    assertSafeId('repo id', repo.id)
    const managedDir = join(this.dir, repo.id)
    return this.locks.run(repo.path, async () => {
      const records = parseWorktreeList(await git(repo.path, ['worktree', 'list', '--porcelain', '-z']))
      const now = Date.now()
      const worktrees: WorktreeInfo[] = []
      for (const record of records) {
        const path = resolve(record.path)
        if (!isWithin(managedDir, path) || !existsSync(path)) continue
        const metrics = await measureWorktree(path)
        const defaultCommit = (
          await git(repo.path, [
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${repo.defaultBranch}^{commit}`,
          ])
        ).trim()
        const mergeBase = (await git(repo.path, ['merge-base', record.headCommit, defaultCommit])).trim()
        const unpushedCommitCount = await countUnpushedCommits(repo.path, mergeBase, record.headCommit)
        const lastActivityAt = new Date(metrics.lastModifiedMs)
        const ageDays = Math.max(0, (now - lastActivityAt.getTime()) / DAY_MS)
        worktrees.push({
          path,
          branch: record.branch,
          headCommit: record.headCommit,
          lastActivityAt,
          diskUsageBytes: metrics.diskUsageBytes,
          unpushedCommitCount,
          ageDays,
          stale: ageDays >= this.staleAfterDays,
        })
      }
      return worktrees
    })
  }

  /** Removes the worktree and its branch. Unpushed commits require explicit confirmation. */
  async cleanup(ws: Workspace, options: WorktreeCleanupOptions = {}): Promise<void> {
    await this.locks.run(ws.repo.path, async () => {
      const unpushedCommitCount = await this.getUnpushedCommitCount(ws)
      if (unpushedCommitCount > 0 && !options.confirmedUnpushedCommits) {
        throw new UnpushedCommitsError(unpushedCommitCount)
      }
      try {
        await git(ws.repo.path, ['worktree', 'remove', '--force', ws.path])
      } catch {
        // Already removed, or git lost track of it: fall through to manual cleanup.
      }
      await rm(ws.path, { recursive: true, force: true })
      await git(ws.repo.path, ['worktree', 'prune'])
      try {
        await git(ws.repo.path, ['branch', '-D', '--', ws.branch])
      } catch {
        // Branch already gone.
      }
    })
  }

  private async getUnpushedCommitCount(ws: Workspace): Promise<number> {
    let headCommit: string
    if (existsSync(ws.path)) {
      headCommit = (await git(ws.path, ['rev-parse', '--verify', 'HEAD'])).trim()
    } else {
      try {
        headCommit = (await git(ws.repo.path, ['rev-parse', '--verify', `refs/heads/${ws.branch}`])).trim()
      } catch {
        return 0
      }
    }
    const baseCommit = (
      await git(ws.repo.path, ['rev-parse', '--verify', '--end-of-options', `${ws.baseCommit}^{commit}`])
    ).trim()
    return countUnpushedCommits(ws.repo.path, baseCommit, headCommit)
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

function parseWorktreeList(out: string): { path: string; branch: string | null; headCommit: string }[] {
  const records: { path: string; branch: string | null; headCommit: string }[] = []
  for (const block of out.split('\0\0')) {
    const fields = block.split('\0').filter(Boolean)
    const worktree = fields.find((field) => field.startsWith('worktree '))
    const head = fields.find((field) => field.startsWith('HEAD '))
    if (!worktree || !head) continue
    const branchField = fields.find((field) => field.startsWith('branch refs/heads/'))
    records.push({
      path: worktree.slice('worktree '.length),
      branch: branchField ? branchField.slice('branch refs/heads/'.length) : null,
      headCommit: head.slice('HEAD '.length),
    })
  }
  return records
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return (
    pathFromParent !== '' &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  )
}

async function countUnpushedCommits(
  repoPath: string,
  baseCommit: string,
  headCommit: string,
): Promise<number> {
  const count = Number(
    (
      await git(repoPath, ['rev-list', '--count', `${baseCommit}..${headCommit}`, '--not', '--remotes'])
    ).trim(),
  )
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Git returned an invalid unpushed commit count')
  return count
}

async function measureWorktree(path: string): Promise<{ diskUsageBytes: number; lastModifiedMs: number }> {
  const metrics = await measureDirectory(path)
  const gitDirValue = (await git(path, ['rev-parse', '--git-dir'])).trim()
  const gitDir = isAbsolute(gitDirValue) ? gitDirValue : resolve(path, gitDirValue)
  let lastModifiedMs = metrics.lastModifiedMs
  for (const file of ['HEAD', 'index', 'logs/HEAD']) {
    try {
      const metadata = await lstat(join(gitDir, file))
      lastModifiedMs = Math.max(lastModifiedMs, metadata.mtimeMs)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return { ...metrics, lastModifiedMs }
}

async function measureDirectory(path: string): Promise<{ diskUsageBytes: number; lastModifiedMs: number }> {
  const root = await lstat(path)
  let diskUsageBytes = root.isDirectory() ? 0 : root.size
  let lastModifiedMs = root.mtimeMs
  if (!root.isDirectory()) return { diskUsageBytes, lastModifiedMs }

  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childPath = join(path, entry.name)
    let child: Awaited<ReturnType<typeof lstat>>
    try {
      child = await lstat(childPath)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    lastModifiedMs = Math.max(lastModifiedMs, child.mtimeMs)
    if (child.isDirectory() && !child.isSymbolicLink()) {
      const nested = await measureDirectory(childPath)
      diskUsageBytes += nested.diskUsageBytes
      lastModifiedMs = Math.max(lastModifiedMs, nested.lastModifiedMs)
    } else {
      diskUsageBytes += child.size
    }
  }
  return { diskUsageBytes, lastModifiedMs }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
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
