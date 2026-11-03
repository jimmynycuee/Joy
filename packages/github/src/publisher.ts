import { execFile } from 'node:child_process'
import type { Executor, Workspace } from '@joy/core'

type Committer = Pick<Executor, 'commit'>

export interface GitHubPublisherOptions {
  /** Executor responsible for staging and committing changes in the task worktree. */
  committer: Committer
  /** Git remote name that receives the task branch. Defaults to `origin`. */
  remote?: string
  /** Executable used for git commands. Defaults to `git`. */
  gitExecutable?: string
  /** Executable used for GitHub CLI commands. Defaults to `gh`. */
  ghExecutable?: string
  /** Arguments prepended to the GitHub CLI command; useful for wrappers and tests. */
  ghPrefixArgs?: string[]
}

export interface DraftPullRequestInput {
  title: string
  baseBranch: string
  summary: string
  /** Formatted with `formatFindings` by the caller. */
  reviewSummary: string
  commitMessage?: string
}

export interface PublishedPullRequest {
  commitSha: string
  pullRequestUrl: string
  body: string
}

/** Commits a task worktree, pushes its feature branch and opens a draft pull request. */
export class GitHubPublisher {
  private readonly committer: Committer
  private readonly remote: string
  private readonly gitExecutable: string
  private readonly ghExecutable: string
  private readonly ghPrefixArgs: string[]

  constructor(options: GitHubPublisherOptions) {
    this.committer = options.committer
    this.remote = options.remote ?? 'origin'
    this.gitExecutable = options.gitExecutable ?? 'git'
    this.ghExecutable = options.ghExecutable ?? 'gh'
    this.ghPrefixArgs = options.ghPrefixArgs ?? []
    if (!this.remote.trim()) throw new Error('A git remote name is required.')
  }

  async publish(workspace: Workspace, input: DraftPullRequestInput): Promise<PublishedPullRequest> {
    const title = input.title.trim()
    const baseBranch = input.baseBranch.trim()
    if (!title) throw new Error('A pull request title is required.')
    if (!baseBranch) throw new Error('A pull request base branch is required.')
    if (!input.summary.trim()) throw new Error('A pull request summary is required.')
    if (workspace.branch === workspace.repo.defaultBranch) {
      throw new Error('Refusing to publish the repository default branch.')
    }
    if (workspace.branch === baseBranch) {
      throw new Error('The pull request branch and base branch must differ.')
    }

    const currentBranch = (
      await runCommand(this.gitExecutable, ['rev-parse', '--abbrev-ref', 'HEAD'], workspace.path, 'Git')
    ).trim()
    if (currentBranch !== workspace.branch) {
      throw new Error(`Worktree branch mismatch: expected "${workspace.branch}", found "${currentBranch}".`)
    }

    const commitSha = await this.committer.commit(workspace, input.commitMessage ?? title)
    if (!commitSha) throw new Error('There are no changes to publish.')

    await runCommand(
      this.gitExecutable,
      ['push', '--set-upstream', this.remote, workspace.branch],
      workspace.path,
      'Git push',
    )

    const body = formatPullRequestBody(input.summary, input.reviewSummary)
    const output = await runCommand(
      this.ghExecutable,
      [
        ...this.ghPrefixArgs,
        'pr',
        'create',
        '--draft',
        '--base',
        baseBranch,
        '--head',
        workspace.branch,
        '--title',
        title,
        '--body',
        body,
      ],
      workspace.path,
      'GitHub CLI',
    )
    const pullRequestUrl = output.trim()
    if (!pullRequestUrl) throw new Error('GitHub CLI did not return a pull request URL.')

    return { commitSha, pullRequestUrl, body }
  }
}

export function formatPullRequestBody(summary: string, reviewSummary: string): string {
  return [`## Summary`, summary.trim(), `## Review summary`, reviewSummary.trim()].join('\n\n')
}

function runCommand(command: string, args: string[], cwd: string, description: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          const reason =
            code === 'ENOENT' ? 'not found on PATH' : `failed (${String(code ?? 'unknown error')})`
          reject(new Error(`${description} ${reason}.`))
        } else {
          resolve(stdout)
        }
      },
    )
  })
}
