// Reads issues for T2.6 through the GitHub CLI the owner is already logged into (Joy never handles a token).
import { execFile } from 'node:child_process'
import type { GitHubRepository } from './publisher.js'
import { parseGitHubRepository } from './publisher.js'

export interface GitHubIssueSource {
  /** Open issues (not pull requests) carrying the label, newest first. */
  listLabeledIssues(remote: string, label: string): Promise<unknown[]>
  getIssue(remote: string, issueNumber: number): Promise<unknown>
}

export interface GhIssueSourceOptions {
  ghExecutable?: string
  /** Arguments placed before the gh arguments (tests run a Node script as `gh`). */
  ghPrefixArgs?: string[]
  timeoutMs?: number
}

/** `owner/name` for a configured remote, as the issue adapter expects. */
export function repositoryName(remote: string): string {
  const repo = parseGitHubRepository(remote)
  return `${repo.owner}/${repo.name}`
}

export class GhIssueSource implements GitHubIssueSource {
  private readonly gh: string
  private readonly prefix: string[]
  private readonly timeoutMs: number

  constructor(options: GhIssueSourceOptions = {}) {
    this.gh = options.ghExecutable ?? 'gh'
    this.prefix = options.ghPrefixArgs ?? []
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async listLabeledIssues(remote: string, label: string): Promise<unknown[]> {
    const repo = parseGitHubRepository(remote)
    const query = new URLSearchParams({ labels: label, state: 'open', per_page: '50', sort: 'created' })
    const result = await this.api(repo, `repos/${repo.owner}/${repo.name}/issues?${query}`)
    if (!Array.isArray(result)) throw new Error('GitHub returned an unexpected issue list')
    // The issues endpoint also returns pull requests; those are not tasks.
    return result.filter((item) => !(typeof item === 'object' && item !== null && 'pull_request' in item))
  }

  async getIssue(remote: string, issueNumber: number): Promise<unknown> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
      throw new Error('Issue numbers are positive integers')
    const repo = parseGitHubRepository(remote)
    const issue = await this.api(repo, `repos/${repo.owner}/${repo.name}/issues/${issueNumber}`)
    if (typeof issue === 'object' && issue !== null && 'pull_request' in issue)
      throw new Error(`#${issueNumber} is a pull request, not an issue`)
    return issue
  }

  private api(repo: GitHubRepository, path: string): Promise<unknown> {
    const args = [
      ...this.prefix,
      'api',
      ...(repo.host === 'github.com' ? [] : ['--hostname', repo.host]),
      path,
    ]
    return new Promise((resolve, reject) => {
      execFile(
        this.gh,
        args,
        { shell: false, timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr).trim().split('\n').at(-1) ?? ''
            reject(
              new Error(
                `GitHub CLI could not read issues${detail ? `: ${detail}` : ''}. Is \`gh auth status\` logged in?`,
              ),
            )
            return
          }
          try {
            resolve(JSON.parse(stdout) as unknown)
          } catch {
            reject(new Error('GitHub CLI returned invalid JSON for issues'))
          }
        },
      )
    })
  }
}
