import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Executor, Workspace } from '@joy/core'

type Committer = Pick<Executor, 'commit'>
type Redactor = (text: string) => string

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024
const MAX_GIT_LFS_POINTER_BYTES = 1024
const MAX_PULL_REQUEST_BODY_BYTES = 65_536
const DIAGNOSTIC_LIMIT = 1_500

export interface GitHubPublisherOptions {
  /** Executor responsible for staging and committing changes in the task worktree. */
  committer: Committer
  /** Git remote used for the feature-branch push. Defaults to `origin`; may name a fork remote. */
  remote?: string
  /** Executable used for git commands. Defaults to `git`. */
  gitExecutable?: string
  /** Arguments prepended to git commands; useful for wrappers and tests. */
  gitPrefixArgs?: string[]
  /** Executable used for GitHub CLI commands. Defaults to `gh`. */
  ghExecutable?: string
  /** Arguments prepended to the GitHub CLI command; useful for wrappers and tests. */
  ghPrefixArgs?: string[]
  /**
   * Required secret-aware redactor, shared with the caller's secret store. Summaries, diffs,
   * commit messages, and diagnostics pass through it; an identity/no-op function is unsafe.
   */
  redact: Redactor
  /** Bounds every git/gh subprocess, including fetch, push, and PR lookup. */
  commandTimeoutMs?: number
}

export interface DraftPullRequestInput {
  title: string
  baseBranch: string
  summary: string
  /** Formatted with `formatFindings` by the caller; redacted before publication. */
  reviewSummary: string
  commitMessage?: string
}

export interface PublishedPullRequest {
  commitSha: string
  pullRequestUrl: string
  body: string
}

export interface GitHubRepository {
  host: string
  owner: string
  name: string
}

interface ExistingPullRequest {
  url: string
  state: string
  isDraft: boolean
  headRefName: string
  headRepositoryOwner: { login: string } | null
  headRepository: { name: string } | null
  baseRefName: string
  body: string
}

/** Commits a task worktree, pushes its feature branch and opens or reuses a draft PR. */
export class GitHubPublisher {
  private readonly committer: Committer
  private readonly remote: string
  private readonly gitExecutable: string
  private readonly gitPrefixArgs: string[]
  private readonly ghExecutable: string
  private readonly ghPrefixArgs: string[]
  private readonly redact: Redactor
  private readonly commandTimeoutMs: number

  constructor(options: GitHubPublisherOptions) {
    this.committer = options.committer
    this.remote = options.remote ?? 'origin'
    this.gitExecutable = options.gitExecutable ?? 'git'
    this.gitPrefixArgs = options.gitPrefixArgs ?? []
    this.ghExecutable = options.ghExecutable ?? 'gh'
    this.ghPrefixArgs = options.ghPrefixArgs ?? []
    this.redact = options.redact
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    if (!this.remote.trim()) throw new Error('A git remote name is required.')
    if (typeof this.redact !== 'function')
      throw new Error('A secret-aware redactor is required for GitHub publishing.')
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
      throw new Error('The GitHub publisher command timeout must be a positive integer.')
    }
  }

  async publish(workspace: Workspace, input: DraftPullRequestInput): Promise<PublishedPullRequest> {
    const title = this.redact(input.title.trim()).trim()
    const baseBranch = input.baseBranch.trim()
    if (!title) throw new Error('A pull request title is required.')
    if (title.length > 256) throw new Error('A pull request title cannot exceed 256 characters.')
    if (!baseBranch) throw new Error('A pull request base branch is required.')
    if (!input.summary.trim()) throw new Error('A pull request summary is required.')
    if (workspace.branch === workspace.repo.defaultBranch) {
      throw new Error('Refusing to publish the repository default branch.')
    }
    if (workspace.branch === baseBranch) {
      throw new Error('The pull request branch and base branch must differ.')
    }

    const summary = this.redact(input.summary).trim()
    if (!summary) throw new Error('A pull request summary is required after redaction.')
    const reviewSummary = this.redact(input.reviewSummary).trim()
    const body = formatPullRequestBody(summary, reviewSummary)
    if (Buffer.byteLength(body, 'utf8') > MAX_PULL_REQUEST_BODY_BYTES) {
      throw new Error(`Pull request body exceeds GitHub's ${MAX_PULL_REQUEST_BODY_BYTES}-byte limit.`)
    }

    const target = parseGitHubRepository(workspace.repo.githubRemote)
    const pushTarget = await this.getPushTarget(workspace.path)
    if (pushTarget.host !== target.host) {
      throw new Error('The selected push remote and configured GitHub repository must use the same host.')
    }
    if (
      !sameRepository(pushTarget, target) &&
      (pushTarget.owner.toLowerCase() === target.owner.toLowerCase() ||
        pushTarget.name.toLowerCase() !== target.name.toLowerCase())
    ) {
      throw new Error(
        'The selected remote is not the configured repository or an explicitly configured fork of it.',
      )
    }
    const head = `${pushTarget.owner}:${workspace.branch}`

    await this.validateBranch(workspace, baseBranch)

    const commitMessage = this.redact(input.commitMessage?.trim() || title).trim() || title
    if (Buffer.byteLength(commitMessage, 'utf8') > 8_192) {
      throw new Error('A Git commit message cannot exceed 8192 bytes.')
    }
    const committedSha = await this.committer.commit(workspace, commitMessage)
    const currentHead = (
      await this.runGit(['rev-parse', '--verify', 'HEAD^{commit}'], workspace.path, 'Git')
    ).trim()
    if (committedSha && committedSha !== currentHead) {
      throw new Error(
        'The executor returned a commit that is not the worktree HEAD; refusing to publish an unexpected commit.',
      )
    }
    if (!(await isAncestor(this.runGit.bind(this), workspace.baseCommit, currentHead, workspace.path))) {
      throw new Error(
        'The worktree HEAD is not based on workspace.baseCommit; refusing to publish unrelated commits.',
      )
    }

    const worktreeStatus = await this.runGit(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      workspace.path,
      'Git status',
    )
    if (worktreeStatus.trim()) {
      throw new Error(
        'The executor left staged, unstaged, or untracked changes after committing; refusing to publish a partial worktree.',
      )
    }

    const changedPaths = (
      await this.runGit(
        ['diff', '--name-only', '-z', workspace.baseCommit, currentHead, '--'],
        workspace.path,
        'Git diff',
      )
    )
      .split('\0')
      .filter(Boolean)
    if (changedPaths.length === 0) throw new Error('There are no changes to publish.')
    await this.scanPushedCommits(workspace, currentHead)

    await this.fetchAndVerifyBase(workspace, baseBranch, target)
    try {
      await this.runGit(
        [
          'push',
          '--set-upstream',
          '--',
          this.remote,
          `refs/heads/${workspace.branch}:refs/heads/${workspace.branch}`,
        ],
        workspace.path,
        'Git push',
      )
    } catch (error) {
      throw new Error(
        `${errorMessage(error)} The remote may have accepted the branch update; retrying the same explicit ref is safe.`,
        { cause: error },
      )
    }

    let existing: ExistingPullRequest | undefined
    try {
      existing = await this.findExistingPullRequest(
        target,
        head,
        pushTarget.owner,
        workspace.branch,
        baseBranch,
        workspace.path,
      )
    } catch (error) {
      throw new Error(
        `${errorMessage(error)} The feature branch was pushed; retrying is safe and checks for a PR created by a partial attempt.`,
        { cause: error },
      )
    }
    if (existing !== undefined) {
      this.assertDraft(existing)
      return {
        commitSha: currentHead,
        pullRequestUrl: validatePullRequestUrl(existing.url, target),
        body: this.redact(existing.body),
      }
    }

    const pullRequestUrl = await this.createPullRequest(target, head, title, baseBranch, body, workspace.path)
    return { commitSha: currentHead, pullRequestUrl, body }
  }

  private async validateBranch(workspace: Workspace, baseBranch: string): Promise<void> {
    await this.runGit(['check-ref-format', '--branch', workspace.branch], workspace.path, 'Git branch')
    await this.runGit(['check-ref-format', '--branch', baseBranch], workspace.path, 'Git base branch')
    const currentBranch = (
      await this.runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspace.path, 'Git')
    ).trim()
    if (currentBranch !== workspace.branch) {
      throw new Error(`Worktree branch mismatch: expected "${workspace.branch}", found "${currentBranch}".`)
    }

    const baseCommit = (
      await this.runGit(
        ['rev-parse', '--verify', '--end-of-options', `${workspace.baseCommit}^{commit}`],
        workspace.path,
        'Git base commit',
      )
    ).trim()
    if (!(await isAncestor(this.runGit.bind(this), baseCommit, 'HEAD', workspace.path))) {
      throw new Error(
        'The feature branch does not contain workspace.baseCommit; refusing to publish unrelated commits.',
      )
    }
  }

  private async getPushTarget(cwd: string): Promise<GitHubRepository> {
    const remotes = (await this.runGit(['remote'], cwd, 'Git remotes')).split(/\r?\n/).filter(Boolean)
    if (!remotes.includes(this.remote))
      throw new Error(`Configured push remote "${this.remote}" does not exist.`)

    const urls = (
      await this.runGit(['remote', 'get-url', '--push', '--all', this.remote], cwd, 'Git effective push URL')
    )
      .split(/\r?\n/)
      .filter(Boolean)
    if (urls.length !== 1) {
      throw new Error(`Push remote "${this.remote}" must have exactly one effective push URL.`)
    }
    return parseGitHubRepository(urls[0])
  }

  private async scanPushedCommits(workspace: Workspace, currentHead: string): Promise<void> {
    const commits = (
      await this.runGit(
        ['rev-list', '--reverse', `${workspace.baseCommit}..${currentHead}`],
        workspace.path,
        'Git pushed-commit list',
      )
    )
      .split(/\r?\n/)
      .filter(Boolean)

    for (const commit of commits) {
      const parent = (
        await this.runGit(
          ['rev-parse', '--verify', '--end-of-options', `${commit}^1`],
          workspace.path,
          'Git commit parent',
        )
      ).trim()
      const changedFiles = parseNameStatus(
        await this.runGit(
          ['diff-tree', '--no-commit-id', '--no-renames', '-r', '--name-status', '-z', parent, commit, '--'],
          workspace.path,
          'Git commit path scan',
        ),
      )
      const sensitivePaths = changedFiles
        .filter(({ status, path }) => status !== 'D' && isSensitivePath(path))
        .map(({ path }) => path)
      if (sensitivePaths.length) {
        const safePaths = sensitivePaths.map((path) => JSON.stringify(this.redact(path))).join(', ')
        throw new Error(
          `Refusing to publish likely secret or credential files: ${safePaths}. Remove them from the branch before publishing.`,
        )
      }

      const numstat = await this.runGit(
        ['diff-tree', '--no-commit-id', '--no-renames', '-r', '--numstat', '-z', parent, commit, '--'],
        workspace.path,
        'Git commit binary scan',
      )
      const binaryPaths = parseBinaryPaths(numstat).filter(
        (path) => !changedFiles.some((file) => file.path === path && file.status === 'D'),
      )
      if (binaryPaths.length) {
        const safePaths = binaryPaths.map((path) => JSON.stringify(this.redact(path))).join(', ')
        throw new Error(
          `Refusing to publish binary changes that cannot be safely scanned: ${safePaths}. Remove or replace them with text files before publishing.`,
        )
      }

      const commitMessage = await this.runGit(
        ['show', '-s', '--format=%B', commit],
        workspace.path,
        'Git commit message scan',
      )
      if (this.redact(commitMessage) !== commitMessage) {
        throw new Error(
          'Refusing to publish a pushed commit with secret-like text in its message; amend or redact it before publishing.',
        )
      }

      const changedBlobIds = parseChangedBlobIds(
        await this.runGit(
          ['diff-tree', '--no-commit-id', '--no-renames', '-r', '--raw', '-z', parent, commit, '--'],
          workspace.path,
          'Git changed blob list',
        ),
      )
      if (changedBlobIds.length) {
        const blobSizes = parseChangedBlobSizes(
          await this.runGit(
            ['cat-file', '--batch-check=%(objectname) %(objectsize)'],
            workspace.path,
            'Git changed blob size list',
            MAX_COMMAND_OUTPUT_BYTES,
            false,
            `${changedBlobIds.join('\n')}\n`,
          ),
          changedBlobIds,
        )
        for (const { objectId, size } of blobSizes) {
          if (size > MAX_GIT_LFS_POINTER_BYTES) continue
          const content = await this.runGit(
            ['cat-file', 'blob', objectId],
            workspace.path,
            'Git LFS pointer blob scan',
            MAX_GIT_LFS_POINTER_BYTES + 1,
          )
          if (containsGitLfsPointer(content)) {
            throw new Error(
              'Refusing to publish Git LFS pointer changes because their external payload cannot be safely scanned.',
            )
          }
        }
      }

      const patch = await this.runGit(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-renames',
          '--unified=0',
          parent,
          commit,
          '--',
        ],
        workspace.path,
        'Git commit patch scan',
        MAX_COMMAND_OUTPUT_BYTES,
      )
      const additions = addedPatchContent(patch)
      if (this.redact(additions) !== additions) {
        throw new Error(
          'Refusing to publish a pushed commit containing secret-like added content; remove or redact it before publishing.',
        )
      }
    }
  }

  private async fetchAndVerifyBase(
    workspace: Workspace,
    baseBranch: string,
    target: GitHubRepository,
  ): Promise<void> {
    const fetchUrl = await this.resolveEffectiveFetchUrl(workspace, target)
    const ref = `refs/joy/github-publisher/base-check/${randomUUID()}`
    await this.runGit(
      ['fetch', '--no-tags', '--quiet', '--', fetchUrl, `+refs/heads/${baseBranch}:${ref}`],
      workspace.path,
      'Git fetch of the configured base branch',
    )
    try {
      const remoteBase = (
        await this.runGit(
          ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
          workspace.path,
          'Git base branch',
        )
      ).trim()
      const baseCommit = (
        await this.runGit(
          ['rev-parse', '--verify', '--end-of-options', `${workspace.baseCommit}^{commit}`],
          workspace.path,
          'Git base commit',
        )
      ).trim()
      if (!(await isAncestor(this.runGit.bind(this), baseCommit, remoteBase, workspace.path))) {
        throw new Error(
          `workspace.baseCommit (${baseCommit}) is not an ancestor of ${target.owner}/${target.name}:${baseBranch}; refusing to publish unrelated local base commits.`,
        )
      }
    } finally {
      await this.runGit(['update-ref', '-d', ref], workspace.path, 'Git temporary base ref cleanup')
    }
  }

  private async resolveEffectiveFetchUrl(workspace: Workspace, target: GitHubRepository): Promise<string> {
    let candidate = workspace.repo.githubRemote
    if (!candidate) throw new Error('RepoRef.githubRemote must identify the configured base repository.')
    const seen = new Set<string>()

    for (let rewrite = 0; rewrite < 8; rewrite++) {
      if (seen.has(candidate)) {
        throw new Error('The effective base fetch URL contains a rewrite cycle; refusing to publish.')
      }
      seen.add(candidate)
      const effective = (
        await this.runGit(
          ['ls-remote', '--get-url', candidate],
          workspace.path,
          'Git effective base fetch URL',
        )
      ).trim()
      let effectiveRepository: GitHubRepository
      try {
        effectiveRepository = parseGitHubRepository(effective)
      } catch {
        throw new Error(
          'The effective base fetch URL is not a supported GitHub repository; refusing to publish.',
        )
      }
      if (!sameRepository(effectiveRepository, target)) {
        throw new Error(
          'The effective base fetch URL does not match the configured GitHub repository; refusing to publish.',
        )
      }
      if (effective === candidate) return effective
      candidate = effective
    }

    throw new Error('The effective base fetch URL was rewritten too many times; refusing to publish.')
  }

  private async findExistingPullRequest(
    target: GitHubRepository,
    head: string,
    headOwner: string,
    branch: string,
    baseBranch: string,
    cwd: string,
  ): Promise<ExistingPullRequest | undefined> {
    const output = await this.runGh(
      [
        'pr',
        'list',
        '--repo',
        `${target.host}/${target.owner}/${target.name}`,
        '--head',
        branch,
        '--limit',
        '100',
        '--state',
        'all',
        '--json',
        'url,state,isDraft,headRefName,headRepositoryOwner,headRepository,baseRefName,body',
      ],
      cwd,
      'GitHub CLI PR lookup',
    )
    let found: unknown
    try {
      found = JSON.parse(output)
    } catch {
      throw new Error('GitHub CLI returned invalid JSON while looking for an existing pull request.')
    }
    if (!Array.isArray(found) || !found.every(isExistingPullRequest)) {
      throw new Error('GitHub CLI returned an invalid pull request list.')
    }
    const expectedHeadOwner = headOwner.toLowerCase()
    const expectedHeadRepository = target.name.toLowerCase()
    const branchPullRequests = (found as ExistingPullRequest[]).filter(
      (pr) =>
        pr.headRefName === branch &&
        pr.headRepositoryOwner?.login.toLowerCase() === expectedHeadOwner &&
        pr.headRepository?.name.toLowerCase() === expectedHeadRepository,
    )
    if (!branchPullRequests.length) return undefined
    const matchingBase = branchPullRequests.filter((pr) => pr.baseRefName === baseBranch)
    if (!matchingBase.length) {
      throw new Error(
        `A pull request already exists for ${head} with base "${branchPullRequests[0]?.baseRefName}", not requested base "${baseBranch}"; refusing to create a duplicate.`,
      )
    }
    const open = matchingBase.filter((pr) => pr.state.toUpperCase() === 'OPEN')
    if (open.length > 1 || (!open.length && matchingBase.length > 1)) {
      throw new Error(
        `Found multiple pull requests for ${head} with base ${baseBranch}; refusing to select one implicitly.`,
      )
    }
    return open[0] ?? matchingBase[0]
  }

  private assertDraft(existing: ExistingPullRequest): void {
    if (existing.state.toUpperCase() !== 'OPEN') {
      throw new Error(
        `A matching pull request already exists at ${existing.url} in ${existing.state.toLowerCase()} state; refusing to create a duplicate.`,
      )
    }
    if (!existing.isDraft) {
      throw new Error(
        'A pull request already exists for this branch but is not a draft; refusing to change its review state.',
      )
    }
  }

  private async createPullRequest(
    target: GitHubRepository,
    head: string,
    title: string,
    baseBranch: string,
    body: string,
    cwd: string,
  ): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'joy-github-pr-'))
    const bodyPath = join(directory, 'body.md')
    try {
      await writeFile(bodyPath, body, { encoding: 'utf8', mode: 0o600 })
      const output = await this.runGh(
        [
          'pr',
          'create',
          '--draft',
          '--repo',
          `${target.host}/${target.owner}/${target.name}`,
          '--base',
          baseBranch,
          '--head',
          head,
          '--title',
          title,
          '--body-file',
          bodyPath,
        ],
        cwd,
        'GitHub CLI PR creation',
      )
      return validatePullRequestUrl(output.trim(), target)
    } catch (error) {
      throw new Error(
        `${errorMessage(error)} The feature branch was pushed; retrying is safe and checks for a PR created by a partial attempt.`,
        { cause: error },
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private runGit(
    args: string[],
    cwd: string,
    description: string,
    maxBuffer = MAX_COMMAND_OUTPUT_BYTES,
    allowMissing = false,
    input?: string,
  ): Promise<string> {
    return runCommand(
      this.gitExecutable,
      [...this.gitPrefixArgs, ...args],
      cwd,
      description,
      this.commandTimeoutMs,
      this.redact,
      maxBuffer,
      allowMissing,
      input,
    )
  }

  private runGh(args: string[], cwd: string, description: string): Promise<string> {
    return runCommand(
      this.ghExecutable,
      [...this.ghPrefixArgs, ...args],
      cwd,
      description,
      this.commandTimeoutMs,
      this.redact,
      MAX_COMMAND_OUTPUT_BYTES,
      false,
    )
  }
}

export function formatPullRequestBody(summary: string, reviewSummary: string): string {
  return ['## Summary', summary.trim(), '## Review summary', reviewSummary.trim()].join('\n\n')
}

export function parseGitHubRepository(value: string | undefined): GitHubRepository {
  if (!value?.trim()) throw new Error('RepoRef.githubRemote must identify the configured GitHub repository.')
  const remote = value.trim()
  let host: string
  let path: string
  if (/^git@[^/:]+:.+/.test(remote)) {
    const match = /^git@([^/:]+):(.+)$/.exec(remote)
    if (!match?.[1] || !match[2])
      throw new Error('The configured GitHub remote must be a GitHub repository URL.')
    host = match[1]
    path = match[2]
  } else {
    let parsed: URL
    try {
      parsed = new URL(remote)
    } catch {
      throw new Error('The configured GitHub remote must be an HTTPS or SSH repository URL.')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
      throw new Error('The configured GitHub remote must use HTTPS or SSH.')
    }
    const hasUnsupportedCredentials = parsed.password || (parsed.username && parsed.username !== 'git')
    if (
      hasUnsupportedCredentials ||
      (parsed.username && parsed.protocol !== 'ssh:') ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('The configured GitHub remote must not embed credentials or URL parameters.')
    }
    host = parsed.host
    path = parsed.pathname
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  const parts = path.split('/')
  const [owner, name] = parts
  if (
    !host ||
    !owner ||
    !name ||
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error('The configured GitHub remote must identify exactly one owner and repository.')
  }
  return { host: host.toLowerCase(), owner, name }
}

function sameRepository(left: GitHubRepository, right: GitHubRepository): boolean {
  return (
    left.host === right.host &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  )
}

function isExistingPullRequest(value: unknown): value is ExistingPullRequest {
  if (!value || typeof value !== 'object') return false
  const pr = value as Record<string, unknown>
  const owner = pr.headRepositoryOwner
  const repository = pr.headRepository
  const validOwner =
    owner === null || (typeof owner === 'object' && 'login' in owner && typeof owner.login === 'string')
  const validRepository =
    repository === null ||
    (typeof repository === 'object' && 'name' in repository && typeof repository.name === 'string')
  return (
    typeof pr.url === 'string' &&
    typeof pr.state === 'string' &&
    typeof pr.isDraft === 'boolean' &&
    typeof pr.headRefName === 'string' &&
    validOwner &&
    validRepository &&
    typeof pr.baseRefName === 'string' &&
    typeof pr.body === 'string'
  )
}

function validatePullRequestUrl(value: string, target: GitHubRepository): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('GitHub CLI did not return a valid pull request URL.')
  }
  const expectedPath = new RegExp(
    `^/${escapeRegExp(target.owner)}/${escapeRegExp(target.name)}/pull/[1-9][0-9]*/?$`,
    'i',
  )
  if (
    parsed.protocol !== 'https:' ||
    parsed.host.toLowerCase() !== target.host ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !expectedPath.test(parsed.pathname)
  ) {
    throw new Error('GitHub CLI returned a pull request URL outside the configured repository.')
  }
  return parsed.toString().replace(/\/$/, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSensitivePath(path: string): boolean {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  if (/^\.env(?:\..*)?$/.test(name) && !/\.(?:example|sample|template)$/.test(name)) return true
  if (
    [
      '.git-credentials',
      '.netrc',
      '.npmrc',
      '.pypirc',
      'credentials.json',
      'id_dsa',
      'id_ecdsa',
      'id_ed25519',
      'id_rsa',
    ].includes(name)
  ) {
    return true
  }
  return /\.(?:kdbx|pem|key|p12|pfx|p7b|p7c|jks|keystore)$/.test(name)
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  const fields = output.split('\0').filter(Boolean)
  if (fields.length % 2 !== 0) throw new Error('Git returned an invalid commit path listing.')
  const changedFiles: Array<{ status: string; path: string }> = []
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]
    const path = fields[index + 1]
    if (!status || path === undefined) throw new Error('Git returned an invalid commit path listing.')
    changedFiles.push({ status, path })
  }
  return changedFiles
}

function parseBinaryPaths(output: string): string[] {
  const paths: string[] = []
  for (const record of output.split('\0').filter(Boolean)) {
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) throw new Error('Git returned an invalid commit size listing.')
    if (record.slice(0, firstTab) === '-' && record.slice(firstTab + 1, secondTab) === '-') {
      paths.push(record.slice(secondTab + 1))
    }
  }
  return paths
}

function containsGitLfsPointer(content: string): boolean {
  const trimGitLfsWhitespace = (value: string): string => value.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '')
  const pointerFields = content
    .replace(/^[\s\u0085]+|[\s\u0085]+$/g, '')
    .split(/\r?\n/)
    .map(trimGitLfsWhitespace)
    .filter(Boolean)
    .filter((line) => !/^ext-\d+-\w+/.test(line))
  const [version, ...fields] = pointerFields
  if (
    ![
      'version https://git-lfs.github.com/spec/v1',
      'version https://hawser.github.com/spec/v1',
      'version http://git-media.io/v/2',
    ].includes(version ?? '')
  ) {
    return false
  }
  const oidIndex = fields.findIndex((line) => /^oid sha256:[a-z0-9]{64}/i.test(line))
  const sizeIndex = fields.findIndex((line, index) => index > oidIndex && /^size [+-]?\d+$/.test(line))
  return oidIndex >= 0 && sizeIndex > oidIndex
}

function parseChangedBlobSizes(
  output: string,
  expectedObjectIds: string[],
): Array<{ objectId: string; size: number }> {
  const records = output.split(/\r?\n/).filter(Boolean)
  if (records.length !== expectedObjectIds.length) {
    throw new Error('Git returned an invalid changed blob size listing.')
  }
  return records.map((record, index) => {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (\d+)$/i.exec(record)
    const objectId = match?.[1]
    const size = Number(match?.[2])
    if (!objectId || objectId !== expectedObjectIds[index] || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Git returned an invalid changed blob size listing.')
    }
    return { objectId, size }
  })
}

function parseChangedBlobIds(output: string): string[] {
  const records = output.split('\0')
  const blobIds: string[] = []
  for (let index = 0; index < records.length;) {
    const header = records[index]
    if (!header) {
      index++
      continue
    }
    if (records[index + 1] === undefined) {
      throw new Error('Git returned an invalid changed blob listing.')
    }
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([A-Z])$/i.exec(
      header,
    )
    if (!match) throw new Error('Git returned an invalid changed blob listing.')
    const [, , mode, , objectId, status] = match
    if (status !== 'D' && mode !== '000000' && mode !== '160000' && objectId) blobIds.push(objectId)
    index += 2
  }
  return blobIds
}

function addedPatchContent(patch: string): string {
  const additions: string[] = []
  let inHunk = false
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) inHunk = false
    else if (line.startsWith('@@ ')) inHunk = true
    else if (inHunk && line.startsWith('+')) additions.push(line.slice(1))
  }
  return additions.join('\n')
}

async function isAncestor(
  runGit: (args: string[], cwd: string, description: string) => Promise<string>,
  ancestor: string,
  descendant: string,
  cwd: string,
): Promise<boolean> {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd, 'Git ancestry check')
    return true
  } catch (error) {
    if (error instanceof CommandFailure && error.exitCode === 1) return false
    throw error
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  description: string,
  timeoutMs: number,
  redact: Redactor,
  maxBuffer: number,
  allowMissing: boolean,
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdinError: NodeJS.ErrnoException | undefined
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GH_PROMPT_DISABLED: '1',
      SSH_ASKPASS_REQUIRE: 'never',
      LC_ALL: 'C',
      LANG: 'C',
    }
    const child = execFile(
      command,
      args,
      {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error as { code?: number | string; killed?: boolean; signal?: string }
          const code = commandError.code
          const timedOut =
            code === 'ETIMEDOUT' ||
            commandError.signal === 'SIGTERM' ||
            (commandError.killed === true && !code)
          const reason =
            code === 'ENOENT'
              ? 'not found on PATH'
              : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? `exceeded the ${Math.floor(maxBuffer / (1024 * 1024))} MiB output limit; split the change into smaller commits`
                : timedOut
                  ? `timed out after ${timeoutMs} ms`
                  : `failed (${String(code ?? 'unknown error')})`
          const detail = sanitizeDiagnostic(stderr, redact)
          if (allowMissing && code === 1 && !detail) {
            resolve('')
            return
          }
          reject(new CommandFailure(`${description} ${reason}.${detail ? ` ${detail}` : ''}`, code))
        } else if (stdinError) {
          const code = stdinError.code
          reject(
            new CommandFailure(`${description} input failed (${String(code ?? 'unknown error')}).`, code),
          )
        } else {
          resolve(stdout)
        }
      },
    )
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      // Prefer the child's exit status; if it succeeded, report the failed input write explicitly.
      stdinError = error
    })
    child.stdin?.end(input)
  })
}

class CommandFailure extends Error {
  readonly exitCode: string | number | undefined

  constructor(message: string, exitCode: string | number | undefined) {
    super(message)
    this.name = 'CommandFailure'
    this.exitCode = exitCode
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'GitHub publication failed with an unknown error.'
}

function sanitizeDiagnostic(stderr: string, redact: Redactor): string {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
  const cleaned = stderr
    .replace(ansiEscape, '')
    .replace(/\r/g, '')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || (code >= 0x20 && (code < 0x7f || code > 0x9f))
    })
    .join('')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .trim()
  if (!cleaned) return ''
  let safe: string
  try {
    safe = redact(cleaned)
  } catch {
    return '[diagnostic omitted because redaction failed]'
  }
  return safe.length > DIAGNOSTIC_LIMIT ? `${safe.slice(0, DIAGNOSTIC_LIMIT)}…` : safe
}
