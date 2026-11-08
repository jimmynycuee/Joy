// Pull request state and CI checks for a task's draft PR, read through the GitHub CLI the owner is logged into.
import { execFile } from 'node:child_process'

/** Runs `gh` with these arguments (no shell) and resolves with its stdout. */
export type GhRunner = (args: string[]) => Promise<string>

export interface PullRequestChecks {
  passing: number
  failing: number
  pending: number
  /** Names of the failing checks, for the UI to show. */
  failingNames: string[]
}

export interface PullRequestStatus {
  url: string
  /** OPEN, CLOSED or MERGED as GitHub reports it. */
  state: string
  isDraft: boolean
  checks: PullRequestChecks
  /** When this status was read from GitHub (ISO time); cached answers keep the original time. */
  fetchedAt: string
}

export interface PullRequestStatusReaderOptions {
  run?: GhRunner
  now?: () => number
  /** How long an answer is reused. Default 60 s. */
  ttlMs?: number
}

const PR_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/

const FAILING_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
])
const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/** Reads PR status with `gh pr view`, caching each URL for `ttlMs` so the UI can poll freely. */
export class PullRequestStatusReader {
  private readonly run: GhRunner
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly cache = new Map<string, { at: number; value: Promise<PullRequestStatus> }>()

  constructor(options: PullRequestStatusReaderOptions = {}) {
    this.run = options.run ?? defaultGhRunner
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? 60_000
  }

  get(url: string): Promise<PullRequestStatus> {
    if (!PR_URL.test(url)) return Promise.reject(new Error(`Not a pull request URL: ${url}`))
    const cached = this.cache.get(url)
    if (cached && this.now() - cached.at < this.ttlMs) return cached.value
    const at = this.now()
    const value = this.run(['pr', 'view', url, '--json', 'url,state,isDraft,statusCheckRollup']).then(
      (stdout) => parsePullRequestStatus(parseJson(stdout), new Date(at).toISOString()),
    )
    this.cache.set(url, { at, value })
    // A failed read is not cached: the next request tries again.
    value.catch(() => {
      if (this.cache.get(url)?.value === value) this.cache.delete(url)
    })
    return value
  }
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    throw new Error('GitHub CLI returned invalid JSON for the pull request')
  }
}

/** Validates `gh pr view --json url,state,isDraft,statusCheckRollup` output (untrusted) into a summary. */
export function parsePullRequestStatus(value: unknown, fetchedAt: string): PullRequestStatus {
  if (typeof value !== 'object' || value === null) throw new Error('GitHub returned no pull request data')
  const pr = value as Record<string, unknown>
  if (typeof pr.url !== 'string' || typeof pr.state !== 'string')
    throw new Error('GitHub returned pull request data without a url or state')
  const checks: PullRequestChecks = { passing: 0, failing: 0, pending: 0, failingNames: [] }
  for (const item of Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []) {
    if (typeof item !== 'object' || item === null) continue
    const check = item as Record<string, unknown>
    const name = String(check.name ?? check.context ?? 'check')
    const outcome = checkOutcome(check)
    if (outcome === 'failing') {
      checks.failing++
      checks.failingNames.push(name)
    } else if (outcome === 'passing') checks.passing++
    else checks.pending++
  }
  return { url: pr.url, state: pr.state, isDraft: pr.isDraft === true, checks, fetchedAt }
}

function checkOutcome(check: Record<string, unknown>): 'passing' | 'failing' | 'pending' {
  // Check runs (GitHub Actions) report status + conclusion; commit statuses report a single state.
  if (check.__typename === 'StatusContext' || (check.state !== undefined && check.status === undefined)) {
    const state = String(check.state ?? '').toUpperCase()
    if (state === 'SUCCESS') return 'passing'
    if (state === 'FAILURE' || state === 'ERROR') return 'failing'
    return 'pending'
  }
  if (String(check.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending'
  const conclusion = String(check.conclusion ?? '').toUpperCase()
  if (FAILING_CONCLUSIONS.has(conclusion)) return 'failing'
  if (PASSING_CONCLUSIONS.has(conclusion)) return 'passing'
  return 'pending'
}

const defaultGhRunner: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { shell: false, timeout: 30_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim().split('\n').at(-1) ?? ''
          reject(
            new Error(
              `GitHub CLI could not read the pull request${detail ? `: ${detail}` : ''}. Is \`gh auth status\` logged in?`,
            ),
          )
          return
        }
        resolve(String(stdout))
      },
    )
  })
