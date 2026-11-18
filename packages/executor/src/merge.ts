import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RepoRef } from '@joy/core'
import { git } from './git.js'

/** Why a merge into the default branch was refused before anything changed. */
export type MergeRefusal =
  | 'missing_default_branch'
  | 'dirty_checkout'
  | 'operation_in_progress'
  | 'checked_out_elsewhere'
  | 'not_fast_forward'
  | 'nothing_to_merge'

export class MergeRefusedError extends Error {
  constructor(
    readonly reason: MergeRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'MergeRefusedError'
  }
}

/** The merge conflicted; it was aborted and the checkout is as it was. */
export class MergeConflictError extends Error {
  constructor(
    readonly branch: string,
    readonly files: string[],
  ) {
    super(
      `Merging into ${branch} conflicts in ${files.length} file${files.length === 1 ? '' : 's'} (${files.join(', ')}); the merge was undone and nothing changed`,
    )
    this.name = 'MergeConflictError'
  }
}

export interface MergeResult {
  /** The default branch that now contains the task's work. */
  branch: string
  /** The merge commit the default branch points at. */
  commit: string
  /** The task branch commit that was merged. */
  sourceCommit: string
  /** Where the default branch was before. */
  previousCommit: string
  /** Files that differ between `previousCommit` and `commit`. */
  files: number
  /** Whether the owner's checkout was updated (the default branch was checked out there). */
  updatedCheckout: boolean
}

/**
 * Where the default branch lives: checked out in the owner's main checkout (`main`), in no checkout at all (`none`),
 * or refused (checked out in some other worktree, which Joy does not touch).
 */
export interface MergeTarget {
  branch: string
  head: string
  checkout: 'main' | 'none'
}

/** Git operations that leave a checkout half way; merging on top of one would mix the owner's work with Joy's. */
const IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'BISECT_LOG',
]

/**
 * Checks that the default branch can take a merge without touching anything the owner is working on. Throws
 * MergeRefusedError otherwise. Reads only.
 */
export async function mergeTarget(repo: RepoRef): Promise<MergeTarget> {
  const branch = repo.defaultBranch
  let head: string
  try {
    head = (
      await git(repo.path, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`])
    ).trim()
  } catch {
    throw new MergeRefusedError(
      'missing_default_branch',
      `The default branch ${branch} does not exist in ${repo.path}`,
    )
  }
  const top = await realpath((await git(repo.path, ['rev-parse', '--show-toplevel'])).trim())
  const holder = await checkedOutIn(repo.path, branch)
  if (holder === undefined) return { branch, head, checkout: 'none' }
  if (holder !== top)
    throw new MergeRefusedError(
      'checked_out_elsewhere',
      `${branch} is checked out in another worktree (${holder}); merge there yourself, or check ${branch} out in ${repo.path}`,
    )
  for (const name of IN_PROGRESS) {
    const path = (await git(repo.path, ['rev-parse', '--git-path', name])).trim()
    if (existsSync(resolve(repo.path, path)))
      throw new MergeRefusedError(
        'operation_in_progress',
        `A merge, rebase, cherry-pick or bisect is in progress in ${repo.path}; finish or abort it, then merge again`,
      )
  }
  // Tracked changes only: git itself refuses to overwrite an untracked file, and stops before changing anything.
  const status = await git(repo.path, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])
  if (status.replaceAll('\0', '').trim() !== '')
    throw new MergeRefusedError(
      'dirty_checkout',
      `${branch} has uncommitted changes in ${repo.path}; commit or stash them, then merge again`,
    )
  return { branch, head, checkout: 'main' }
}

/**
 * Merges `sourceCommit` into the default branch with a merge commit (`--no-ff`): the task's work stays one unit that
 * names the task and can be undone with a single `git revert -m 1`.
 *
 * - Checked out in the main checkout: a real `git merge` there. A conflict (or any other failure) is aborted, so the
 *   checkout is never left half merged, and the conflicting files are reported.
 * - Not checked out anywhere: only when the branch has not moved past the task's base (the merge commit's tree is the
 *   task's tree, so there is nothing to resolve); the branch ref moves with a compare-and-swap. The owner's working
 *   tree, whatever is checked out, is not touched.
 *
 * Hooks never run and nothing is signed: the owner's hooks would run with Joy's (agent-written) code checked out.
 */
export async function mergeIntoTarget(
  repo: RepoRef,
  target: MergeTarget,
  sourceCommit: string,
  message: string,
  identity: string[],
): Promise<MergeResult> {
  if (await isAncestor(repo.path, sourceCommit, target.head))
    throw new MergeRefusedError(
      'nothing_to_merge',
      `Nothing to merge: ${target.branch} already has these changes`,
    )
  const noHooks = await mkdtemp(join(tmpdir(), 'joy-no-hooks-'))
  const safety = ['-c', `core.hooksPath=${noHooks}`, '-c', 'commit.gpgsign=false', ...identity]
  try {
    let commit: string
    if (target.checkout === 'none') {
      if (!(await isAncestor(repo.path, target.head, sourceCommit))) throw notFastForward(repo, target.branch)
      const tree = (await git(repo.path, ['rev-parse', '--verify', `${sourceCommit}^{tree}`])).trim()
      commit = (
        await git(repo.path, [
          ...safety,
          'commit-tree',
          '--no-gpg-sign',
          tree,
          '-p',
          target.head,
          '-p',
          sourceCommit,
          '-m',
          message,
        ])
      ).trim()
      // The old value makes this fail if the branch moved since it was read.
      await git(repo.path, [
        'update-ref',
        '-m',
        `joy: ${message.split('\n')[0] ?? ''}`,
        `refs/heads/${target.branch}`,
        commit,
        target.head,
      ])
    } else {
      // Re-checked under the same call: the owner may have switched branches since mergeTarget looked.
      const current = (await git(repo.path, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim()
      if (current !== `refs/heads/${target.branch}`)
        throw new MergeRefusedError(
          'checked_out_elsewhere',
          `${repo.path} no longer has ${target.branch} checked out; try again`,
        )
      try {
        // Explicit flags beat whatever branch.<name>.mergeOptions or merge.* settings the owner has.
        await git(repo.path, [
          ...safety,
          'merge',
          '--no-ff',
          '--commit',
          '--no-squash',
          '--no-edit',
          '--no-verify',
          '--no-gpg-sign',
          '--no-autostash',
          '-q',
          '-m',
          message,
          sourceCommit,
        ])
      } catch (error) {
        const conflicts = (await git(repo.path, ['diff', '--name-only', '--diff-filter=U', '-z']))
          .split('\0')
          .filter(Boolean)
        await abortMerge(repo.path, target.head)
        if (conflicts.length) throw new MergeConflictError(target.branch, conflicts)
        throw error
      }
      commit = (await git(repo.path, ['rev-parse', '--verify', 'HEAD'])).trim()
    }
    const files = (await git(repo.path, ['diff', '--name-only', '-z', target.head, commit]))
      .split('\0')
      .filter(Boolean).length
    return {
      branch: target.branch,
      commit,
      sourceCommit,
      previousCommit: target.head,
      files,
      updatedCheckout: target.checkout === 'main',
    }
  } finally {
    await rm(noHooks, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function notFastForward(repo: RepoRef, branch: string): MergeRefusedError {
  return new MergeRefusedError(
    'not_fast_forward',
    `${branch} has new commits and is not checked out in ${repo.path}; check out ${branch} there, then merge again`,
  )
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

/** Puts the checkout back exactly where it was before the merge started. */
async function abortMerge(cwd: string, head: string): Promise<void> {
  const mergeHead = (await git(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD'])).trim()
  if (existsSync(resolve(cwd, mergeHead))) {
    try {
      await git(cwd, ['merge', '--abort'])
      return
    } catch {
      // Fall through: the checkout was clean before the merge, so a reset loses nothing of the owner's.
    }
  }
  const now = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim()
  if (now !== head) await git(cwd, ['reset', '--merge', head])
}

/** The worktree path (real path) where `branch` is checked out, if any. */
async function checkedOutIn(cwd: string, branch: string): Promise<string | undefined> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain', '-z'])
  let path: string | undefined
  for (const rawField of out.split('\0')) {
    const field = rawField.replace(/^(?:\r?\n)+/, '')
    if (field.startsWith('worktree ')) path = field.slice('worktree '.length)
    else if (field === `branch refs/heads/${branch}` && path) {
      try {
        return await realpath(path)
      } catch {
        return path
      }
    }
  }
  return undefined
}
