import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { lstat, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { gitEnvironment } from '@joy/executor'
import { parseGitHubRepository } from '@joy/github'

/*
 * The folder picker behind 加入專案. It only ever lists folder names (never file names or contents) and refuses the
 * places that hold secrets: Joy's own data, the home folder's hidden folders (~/.ssh, ~/.aws, ...), ~/Library
 * (Keychains, Mail, ...) and AppData. Every path is resolved through symbolic links before it is judged, so a link
 * or a `..` cannot lead around the list.
 */

/** A problem the caller can show: `status` is the HTTP status it maps to. */
export class FolderError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    message: string,
  ) {
    super(message)
  }
}

export interface FolderBrowserOptions {
  /** Where browsing starts, and what `~` means. Default: the user's home folder. */
  home?: string
  /** Joy's own data folder (~/.joy): never listed, wherever it is. */
  joyHome: string
}

export interface FolderEntry {
  name: string
  path: string
  /** Has a `.git` inside (a folder, or the file a linked worktree has). */
  isGit: boolean
}

export interface FolderListing {
  /** The folder listed, with links resolved. */
  path: string
  /** The folder above it, or null at the top or when that one is off limits. */
  parent: string | null
  home: string
  isGit: boolean
  /** The path from the top down to `path`, for a breadcrumb. */
  crumbs: Array<{ name: string; path: string }>
  folders: FolderEntry[]
  /** More folders than `MAX_FOLDERS`; the rest are not listed. */
  truncated: boolean
}

export const MAX_FOLDERS = 500

/** Top-level names under the home folder that are never listed (compared in lower case). */
const BLOCKED_UNDER_HOME = new Set(['library', 'appdata'])
/** Folder names that are off limits wherever they are. */
const BLOCKED_ANYWHERE = new Set(['.ssh', '.gnupg', '.aws', 'keychains'])

async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

interface Roots {
  home: string
  joyHome: string
}

async function roots(options: FolderBrowserOptions): Promise<Roots> {
  return {
    home: await realOrResolved(options.home ?? homedir()),
    joyHome: await realOrResolved(options.joyHome),
  }
}

function lower(path: string): string {
  return path.toLowerCase()
}

/** Whether `path` (already resolved) is `parent` or inside it. Case-insensitive, like the file systems of macOS and Windows. */
function isInside(path: string, parent: string): boolean {
  const a = lower(path)
  const b = lower(parent)
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`)
}

/** The places the picker refuses to show. `path` must already be resolved through links. */
export function isOffLimits(path: string, roots: Roots): boolean {
  if (isInside(path, roots.joyHome)) return true
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.some((part) => BLOCKED_ANYWHERE.has(lower(part)))) return true
  if (isInside(path, roots.home) && lower(path) !== lower(roots.home)) {
    const first = path.slice(roots.home.length).split(/[\\/]/).find(Boolean)
    if (first && (first.startsWith('.') || BLOCKED_UNDER_HOME.has(lower(first)))) return true
  }
  return false
}

/** A Windows network path (`\\host\share`, `//host/share`, `\\?\...`): not browsable, and nothing to put a project on. */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

/** An absolute path from what the owner typed; `~` means the home folder. Throws a 400 for anything else. */
function absolutePath(input: string | undefined, home: string): string {
  const text = (input ?? '').trim()
  if (text === '') return home
  if (text.includes('\0')) throw new FolderError(400, 'The path must not contain NUL')
  if (text.length > 4096) throw new FolderError(400, 'The path is too long')
  if (isNetworkPath(text)) throw new FolderError(400, 'Network paths are not supported')
  const expanded = text === '~' ? home : /^~[\\/]/.test(text) ? join(home, text.slice(2)) : text
  if (!isAbsolute(expanded)) throw new FolderError(400, 'The path must be absolute')
  // resolve() folds `..` away; the links are followed afterwards, by realpath.
  return resolve(expanded)
}

/** Resolves `input` to a real folder that is allowed to be shown, or throws the error that says why not. */
async function openFolder(input: string | undefined, found: Roots): Promise<string> {
  const wanted = absolutePath(input, found.home)
  let real: string
  try {
    real = await realpath(wanted)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new FolderError(404, 'That folder does not exist')
    if (code === 'ENOTDIR') throw new FolderError(400, 'That path is not a folder')
    if (code === 'EACCES' || code === 'EPERM') throw new FolderError(403, 'That folder cannot be read')
    throw cause
  }
  if (isNetworkPath(real)) throw new FolderError(400, 'Network paths are not supported')
  // Judge the path as typed too: a link into a forbidden place must not become allowed by where it points.
  if (isOffLimits(real, found) || isOffLimits(wanted, found))
    throw new FolderError(403, 'That folder is not available')
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(real)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    throw code === 'EACCES' || code === 'EPERM'
      ? new FolderError(403, 'That folder cannot be read')
      : new FolderError(404, 'That folder does not exist')
  }
  if (!info.isDirectory()) throw new FolderError(400, 'That path is not a folder')
  return real
}

async function hasGit(folder: string): Promise<boolean> {
  try {
    await lstat(join(folder, '.git'))
    return true
  } catch {
    return false
  }
}

function crumbsOf(path: string): FolderListing['crumbs'] {
  const root = parse(path).root
  const crumbs = [{ name: root, path: root }]
  let current = root
  for (const part of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

/** The sub-folders of `input` (default the home folder). Names only: no files, no hidden folders, nothing off limits. */
export async function listFolders(
  input: string | undefined,
  options: FolderBrowserOptions,
): Promise<FolderListing> {
  const found = await roots(options)
  const path = await openFolder(input, found)
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') throw new FolderError(403, 'That folder cannot be read')
    throw cause
  }

  const folders: FolderEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const child = join(path, entry.name)
    let target = child
    if (entry.isSymbolicLink()) {
      // A link counts as a folder only when what it points at is one, and is not off limits.
      try {
        target = await realpath(child)
        if (!(await stat(target)).isDirectory()) continue
      } catch {
        continue
      }
    } else if (!entry.isDirectory()) continue
    if (isNetworkPath(target) || isOffLimits(target, found) || isOffLimits(child, found)) continue
    folders.push({ name: entry.name, path: child, isGit: false })
  }
  folders.sort((a, b) => a.name.localeCompare(b.name))
  const truncated = folders.length > MAX_FOLDERS
  const shown = folders.slice(0, MAX_FOLDERS)
  await Promise.all(
    shown.map(async (folder) => {
      folder.isGit = await hasGit(folder.path)
    }),
  )

  const above = dirname(path)
  const parent = above === path || isOffLimits(above, found) ? null : above
  return {
    path,
    parent,
    home: found.home,
    isGit: await hasGit(path),
    crumbs: crumbsOf(path),
    folders: shown,
    truncated,
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: 30_000,
        windowsHide: true,
        // Not the repository or configuration the process was started with: only the folder it is run in.
        env: gitEnvironment(process.env, { GIT_TERMINAL_PROMPT: '0' }),
      },
      (error, stdout, stderr) => {
        if (error) fail(new Error(`git ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`))
        else done(stdout)
      },
    )
  })
}

/** Whether git has a name and an email to sign a commit with. */
async function hasIdentity(cwd: string): Promise<boolean> {
  try {
    const [name, email] = await Promise.all([
      git(cwd, ['config', 'user.name']),
      git(cwd, ['config', 'user.email']),
    ])
    return name.trim() !== '' && email.trim() !== ''
  } catch {
    return false
  }
}

/**
 * `git init` for a folder that is not a repository yet, on a branch called `main` with one empty commit (Joy starts
 * every task from a commit of the default branch, so a repository without one cannot be used). Refuses the home
 * folder and the top of a drive: a repository there would swallow everything under it. Returns the folder's real path.
 */
export async function initGitRepository(
  input: string,
  options: FolderBrowserOptions,
): Promise<{ path: string; defaultBranch: string }> {
  const found = await roots(options)
  const path = await openFolder(input, found)
  // A repository there would swallow the home folder or Joy's data: the folders themselves and everything above them.
  // The top of any drive too: on Windows `/` means the current drive, which need not hold the home folder.
  if (dirname(path) === path || isInside(found.home, path) || isInside(found.joyHome, path))
    throw new FolderError(
      400,
      'Choose a project folder, not the home folder, Joy data or a folder that holds them',
    )
  if (await hasGit(path)) throw new FolderError(409, 'That folder is already a git repository')
  // No hook may run during the commit, wherever it comes from (git's template folder, the owner's global
  // core.hooksPath, a prepare-commit-msg or post-commit in the new repository): point git at an empty folder.
  // Not /dev/null, which does not exist on Windows.
  const noHooks = await mkdtemp(join(tmpdir(), 'joy-no-hooks-'))
  try {
    await git(path, ['init'])
    await git(path, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    // The commit must not depend on the owner's git settings: no signing, and an author when none is configured.
    const author = (await hasIdentity(path)) ? [] : ['-c', 'user.name=Joy', '-c', 'user.email=joy@localhost']
    await git(path, [
      ...author,
      '-c',
      `core.hooksPath=${noHooks}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--no-verify',
      '-m',
      'Initial commit',
    ])
  } catch (cause) {
    // The .git folder is the one just made above (there was none a moment ago); leave the folder as it was.
    await rm(join(path, '.git'), { recursive: true, force: true }).catch(() => undefined)
    throw new FolderError(500, cause instanceof Error ? cause.message : 'git init failed')
  } finally {
    await rm(noHooks, { recursive: true, force: true }).catch(() => undefined)
  }
  return { path, defaultBranch: 'main' }
}

export interface RepositoryInfo {
  path: string
  /** The branch new tasks start from: what the remote calls its default, else the checked-out branch. */
  defaultBranch: string | null
  /** `origin` when it is a GitHub repository, as an HTTPS URL without credentials. */
  githubRemote: string | null
}

/** What 加入專案 fills in for a repository, so the owner does not have to know or type it. */
export async function describeRepository(
  input: string,
  options: FolderBrowserOptions,
): Promise<RepositoryInfo> {
  const found = await roots(options)
  const path = await openFolder(input, found)
  if (!(await hasGit(path))) throw new FolderError(409, 'That folder is not a git repository')
  return {
    path,
    defaultBranch: await detectDefaultBranch(path),
    githubRemote: await detectGithubRemote(path),
  }
}

async function quietGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const out = (await git(cwd, args)).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

async function detectDefaultBranch(path: string): Promise<string | null> {
  const remoteHead = await quietGit(path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const fromRemote = remoteHead?.startsWith('origin/') ? remoteHead.slice('origin/'.length) : null
  // Tasks start from the local branch, so the remote's default only counts when it exists here.
  if (fromRemote && (await branchExists(path, fromRemote))) return fromRemote
  const head = await quietGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return head && (await branchExists(path, head)) ? head : null
}

export async function detectGithubRemote(path: string): Promise<string | null> {
  const url = await quietGit(path, ['remote', 'get-url', 'origin'])
  if (!url) return null
  try {
    const repo = parseGitHubRepository(url)
    if (repo.host !== 'github.com') return null
    return `https://github.com/${repo.owner}/${repo.name}`
  } catch {
    // Not GitHub, or a URL with credentials in it: the owner can still type one.
    return null
  }
}

/** Whether `branch` is a local branch with a commit, the way a task's worktree is made from it. */
export async function branchExists(path: string, branch: string): Promise<boolean> {
  if (branch.startsWith('-')) return false
  return (
    (await quietGit(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])) !== null
  )
}

/** Whether `path` holds a repository (a `.git` folder, or the file a linked worktree has). */
export async function isGitRepository(path: string): Promise<boolean> {
  return hasGit(path)
}
