import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AttemptId, RepoId, RepoRef, TaskId, Workspace } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubPublisher } from './publisher.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

interface Fixture {
  root: string
  bareRepo: string
  workspace: Workspace
  fakeGh: string
  ghCapture: string
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GitHubPublisher', () => {
  it('commits changes, pushes the feature branch and opens a draft PR with review findings', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')
    await writeFile(
      fixture.fakeGh,
      [
        "import { writeFile } from 'node:fs/promises'",
        'const [capturePath, ...args] = process.argv.slice(2)',
        'await writeFile(capturePath, JSON.stringify({ args, cwd: process.cwd() }))',
        "process.stdout.write('https://github.com/example/joy/pull/42\\n')",
        '',
      ].join('\n'),
    )

    const publisher = createPublisher(fixture)
    const result = await publisher.publish(fixture.workspace, {
      title: 'Publish task branch',
      baseBranch: 'main',
      summary: 'Adds the task changes.',
      reviewSummary: '- [major] src/index.ts: Handle the empty input',
    })

    const pushedSha = await git(fixture.bareRepo, ['rev-parse', `refs/heads/${fixture.workspace.branch}`])
    expect(result.commitSha).toBe(pushedSha)
    expect(result.pullRequestUrl).toBe('https://github.com/example/joy/pull/42')
    expect(result.body).toContain('## Summary\n\nAdds the task changes.')
    expect(result.body).toContain('## Review summary\n\n- [major] src/index.ts: Handle the empty input')

    const captured = JSON.parse(await readFile(fixture.ghCapture, 'utf8')) as {
      args: string[]
      cwd: string
    }
    expect(await realpath(captured.cwd)).toBe(await realpath(fixture.workspace.path))
    expect(captured.args).toEqual([
      'pr',
      'create',
      '--draft',
      '--base',
      'main',
      '--head',
      fixture.workspace.branch,
      '--title',
      'Publish task branch',
      '--body',
      result.body,
    ])
  })

  it('does not push or create a PR when there are no changes', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.fakeGh, "process.stdout.write('should not be called')\n")

    await expect(
      createPublisher(fixture).publish(fixture.workspace, {
        title: 'Empty task',
        baseBranch: 'main',
        summary: 'Nothing changed.',
        reviewSummary: '(no specific findings)',
      }),
    ).rejects.toThrow('There are no changes to publish.')

    await expect(
      git(fixture.bareRepo, ['show-ref', '--verify', `refs/heads/${fixture.workspace.branch}`]),
    ).rejects.toBeDefined()
    await expect(readFile(fixture.ghCapture, 'utf8')).rejects.toBeDefined()
  })

  it('refuses to publish the repository default branch', async () => {
    const fixture = await createFixture()
    const commit = { commit: async () => 'should-not-commit' }
    const publisher = new GitHubPublisher({
      committer: commit,
      ghExecutable: process.execPath,
      ghPrefixArgs: [fixture.fakeGh, fixture.ghCapture],
    })

    await expect(
      publisher.publish(
        { ...fixture.workspace, branch: 'main' },
        {
          title: 'Unsafe publish',
          baseBranch: 'main',
          summary: 'Do not publish this.',
          reviewSummary: '(no specific findings)',
        },
      ),
    ).rejects.toThrow('Refusing to publish the repository default branch.')
  })
})

function createPublisher(fixture: Fixture): GitHubPublisher {
  return new GitHubPublisher({
    committer: {
      async commit(workspace, message) {
        await git(workspace.path, ['add', '--all'])
        const staged = await git(workspace.path, ['diff', '--cached', '--name-only'])
        if (!staged.trim()) return null
        await git(workspace.path, [
          '-c',
          'user.name=Joy Test',
          '-c',
          'user.email=joy@example.test',
          'commit',
          '-q',
          '-m',
          message,
        ])
        return git(workspace.path, ['rev-parse', 'HEAD'])
      },
    },
    ghExecutable: process.execPath,
    ghPrefixArgs: [fixture.fakeGh, fixture.ghCapture],
  })
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'joy-github-publisher-'))
  roots.push(root)
  const bareRepo = join(root, 'origin.git')
  const repoPath = join(root, 'repo')
  const fakeGh = join(root, 'fake-gh.mjs')
  const ghCapture = join(root, 'gh-args.json')
  await mkdir(repoPath)
  await git(root, ['init', '--bare', bareRepo])
  await git(repoPath, ['init', '-b', 'main'])
  await git(repoPath, ['config', 'user.name', 'Joy Test'])
  await git(repoPath, ['config', 'user.email', 'joy@example.test'])
  await writeFile(join(repoPath, 'README.md'), 'test repository\n')
  await git(repoPath, ['add', '--all'])
  await git(repoPath, ['commit', '-q', '-m', 'Initial commit'])
  await git(repoPath, ['remote', 'add', 'origin', bareRepo])
  await git(repoPath, ['push', '--set-upstream', 'origin', 'main'])

  const branch = 'joy/task-1/attempt-1'
  await git(repoPath, ['switch', '-c', branch])
  const repo: RepoRef = {
    id: 'publisher-test' as RepoId,
    path: repoPath,
    defaultBranch: 'main',
    githubRemote: bareRepo,
  }
  const workspace: Workspace = {
    repo,
    taskId: 'task-1' as TaskId,
    attemptId: 'attempt-1' as AttemptId,
    path: repoPath,
    branch,
    baseCommit: await git(repoPath, ['rev-parse', 'main']),
  }
  return { root, bareRepo, workspace, fakeGh, ghCapture }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Joy Test',
    GIT_AUTHOR_EMAIL: 'joy@example.test',
    GIT_COMMITTER_NAME: 'Joy Test',
    GIT_COMMITTER_EMAIL: 'joy@example.test',
    GIT_TERMINAL_PROMPT: '0',
  }
  const { stdout } = await execFileAsync('git', args, { cwd, env, windowsHide: true })
  return stdout.trim()
}
