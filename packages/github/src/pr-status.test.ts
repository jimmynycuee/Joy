import { describe, expect, it } from 'vitest'
import { PullRequestStatusReader, parsePullRequestStatus } from './pr-status.js'

const URL = 'https://github.com/owner/repo/pull/7'
const ROLLUP = {
  url: URL,
  state: 'OPEN',
  isDraft: true,
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'ubuntu', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'windows', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'macos', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
    { __typename: 'StatusContext', context: 'ci/pending', state: 'PENDING' },
  ],
}

describe('PullRequestStatusReader', () => {
  it('summarizes check runs and commit statuses', () => {
    expect(parsePullRequestStatus(ROLLUP, '2026-11-08T00:00:00.000Z')).toEqual({
      url: URL,
      state: 'OPEN',
      isDraft: true,
      checks: { passing: 2, failing: 2, pending: 2, failingNames: ['windows', 'ci/legacy'] },
      fetchedAt: '2026-11-08T00:00:00.000Z',
    })
  })

  it('runs gh without a shell, caches for the ttl and retries after a failure', async () => {
    const calls: string[][] = []
    let now = 1_000
    let fail = true
    const reader = new PullRequestStatusReader({
      now: () => now,
      run: async (args) => {
        calls.push(args)
        if (fail) {
          fail = false
          throw new Error('network down')
        }
        return JSON.stringify(ROLLUP)
      },
    })
    await expect(reader.get(URL)).rejects.toThrow('network down')
    expect((await reader.get(URL)).checks.failing).toBe(2)
    now += 59_000
    await reader.get(URL)
    expect(calls).toHaveLength(2)
    now += 2_000
    await reader.get(URL)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual(['pr', 'view', URL, '--json', 'url,state,isDraft,statusCheckRollup'])
  })

  it('refuses anything that is not a pull request URL and rejects malformed output', async () => {
    const reader = new PullRequestStatusReader({ run: async () => 'not json' })
    await expect(reader.get('--repo=evil')).rejects.toThrow('Not a pull request URL')
    await expect(reader.get(URL)).rejects.toThrow('invalid JSON')
    expect(() => parsePullRequestStatus({ state: 'OPEN' }, 'now')).toThrow('without a url')
  })
})
