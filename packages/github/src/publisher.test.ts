import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { AttemptId, RepoId, RepoRef, TaskId, Workspace } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubPublisher } from './publisher.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const configuredRemote = 'https://github.com/example/joy.git'

interface GhCall {
  args: string[]
  cwd: string
  body?: string
  bodyMode?: number
  bodyPath?: string
  stdinIsTTY: boolean
  stdinBytes: number
  terminalPrompt: string | undefined
  ghPromptDisabled: string | undefined
  gitCredentialManagerInteractive: string | undefined
  sshCommand: string | undefined
  sshAskpassRequire: string | undefined
}

interface Fixture {
  root: string
  bareRepo: string
  workspace: Workspace
  fakeGh: string
  ghCapture: string
  ghState: string
  ghMode: string
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GitHubPublisher', () => {
  it('commits changes, binds gh to the configured repo, writes a bounded body file, and opens a draft PR', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    const result = await createPublisher(fixture).publish(fixture.workspace, {
      title: 'Publish task branch',
      baseBranch: 'main',
      summary: 'Adds the task changes.',
      reviewSummary: '- [major] src/index.ts: Handle the empty input',
      commitMessage: '  \n',
    })

    const pushedSha = await git(fixture.bareRepo, ['rev-parse', `refs/heads/${fixture.workspace.branch}`])
    expect(result.commitSha).toBe(pushedSha)
    expect(result.pullRequestUrl).toBe('https://github.com/example/joy/pull/42')
    expect(result.body).toContain('## Summary\n\nAdds the task changes.')
    expect(await git(fixture.workspace.path, ['log', '-1', '--format=%s'])).toBe('Publish task branch')

    const calls = await readCalls(fixture)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toEqual([
      'pr',
      'list',
      '--repo',
      'github.com/example/joy',
      '--head',
      `example:${fixture.workspace.branch}`,
      '--limit',
      '100',
      '--state',
      'all',
      '--json',
      'url,state,isDraft,headRefName,baseRefName',
    ])
    expect(calls[1]?.args).toEqual([
      'pr',
      'create',
      '--draft',
      '--repo',
      'github.com/example/joy',
      '--base',
      'main',
      '--head',
      `example:${fixture.workspace.branch}`,
      '--title',
      'Publish task branch',
      '--body-file',
      calls[1]?.bodyPath,
    ])
    expect(calls[1]?.args).not.toContain(result.body)
    expect(calls[1]?.body).toBe(result.body)
    if (process.platform !== 'win32') expect(calls[1]?.bodyMode).toBe(0o600)
    else expect(calls[1]?.bodyMode).toBeDefined()
    expect(calls[1]?.bodyPath).toBeDefined()
    await expect(readFile(calls[1]?.bodyPath ?? '', 'utf8')).rejects.toBeDefined()
    expect(calls[0]?.terminalPrompt).toBe('0')
    expect(calls[0]?.ghPromptDisabled).toBe('1')
    expect(calls[0]?.stdinIsTTY).toBe(false)
    expect(calls[0]?.stdinBytes).toBe(0)
    expect(calls[0]?.gitCredentialManagerInteractive).toBe('never')
    expect(calls[0]?.sshCommand).toContain('BatchMode=yes')
    expect(calls[0]?.sshAskpassRequire).toBe('never')
    expect(
      await git(fixture.workspace.path, ['for-each-ref', '--format=%(refname)', 'refs/joy/github-publisher']),
    ).toBe('')
  })

  it('publishes a realistic precommitted clean worktree when the committer returns null', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.workspace.path, 'agent-commit.txt'), 'already committed\n')
    await git(fixture.workspace.path, ['add', '--all'])
    await git(fixture.workspace.path, ['commit', '-q', '-m', 'Agent precommit'])
    const expectedSha = await git(fixture.workspace.path, ['rev-parse', 'HEAD'])

    const result = await createPublisher(fixture, { committer: { commit: async () => null } }).publish(
      fixture.workspace,
      input(),
    )

    expect(result.commitSha).toBe(expectedSha)
    expect(await git(fixture.bareRepo, ['rev-parse', `refs/heads/${fixture.workspace.branch}`])).toBe(
      expectedSha,
    )
  })

  it('recovers idempotently when gh creates the PR but exits with a partial-failure error', async () => {
    const fixture = await createFixture({ ghMode: 'partial' })
    await writeFile(join(fixture.workspace.path, 'agent-commit.txt'), 'already committed\n')
    await git(fixture.workspace.path, ['add', '--all'])
    await git(fixture.workspace.path, ['commit', '-q', '-m', 'Agent precommit'])
    const committer = { commit: async () => null }
    const publisher = createPublisher(fixture, { committer })

    let firstFailure: Error | undefined
    try {
      await publisher.publish(fixture.workspace, input())
    } catch (error) {
      firstFailure = error as Error
    }
    expect(firstFailure?.message).toMatch(/feature branch was pushed; retrying is safe/)
    expect(firstFailure?.message).toContain('GraphQL accepted the request')
    expect(firstFailure?.message).not.toContain('test-secret-value')
    const retry = await publisher.publish(fixture.workspace, input())

    expect(retry.pullRequestUrl).toBe('https://github.com/example/joy/pull/42')
    const calls = await readCalls(fixture)
    expect(calls.filter((call) => call.args[1] === 'create')).toHaveLength(1)
    expect(calls.filter((call) => call.args[1] === 'list')).toHaveLength(2)
  })

  it('does not push or query gh when neither commits nor worktree changes exist', async () => {
    const fixture = await createFixture()

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      'There are no changes to publish.',
    )

    await expect(
      git(fixture.bareRepo, ['show-ref', '--verify', `refs/heads/${fixture.workspace.branch}`]),
    ).rejects.toBeDefined()
    expect(await readCalls(fixture)).toHaveLength(0)
  })

  it('preserves useful CLI stderr while redacting secrets and bounding diagnostics', async () => {
    const fixture = await createFixture({ ghMode: 'error' })
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    let failure: Error | undefined
    try {
      await createPublisher(fixture).publish(fixture.workspace, input())
    } catch (error) {
      failure = error as Error
    }
    expect(failure?.message).toMatch(/GraphQL rejected the request.*\[REDACTED\]/)
    expect(failure?.message).not.toContain('test-secret-value')
  })

  it('preserves useful and bounded push stderr when a remote branch has advanced incompatibly', async () => {
    const fixture = await createFixture()
    await makeCompetingRemoteCommit(fixture)
    await writeFile(join(fixture.workspace.path, 'local-change.txt'), 'local change\n')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /Git push failed[\s\S]*(rejected|non-fast-forward|fetch first)/i,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
  })

  it('preserves bounded diagnostics from large CLI stderr output', async () => {
    const fixture = await createFixture({ ghMode: 'long-error' })
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\\n')

    let failure: Error | undefined
    try {
      await createPublisher(fixture).publish(fixture.workspace, input())
    } catch (error) {
      failure = error as Error
    }
    expect(failure?.message).toContain('GraphQL diagnostic')
    expect(failure?.message.length).toBeLessThan(1_800)
  })

  it('times out a noninteractive gh process', async () => {
    const fixture = await createFixture({ ghMode: 'hang' })
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    await expect(
      createPublisher(fixture, { commandTimeoutMs: 40 }).publish(fixture.workspace, input()),
    ).rejects.toThrow(/GitHub CLI PR lookup timed out after 40 ms/)
  })

  it('rejects bodies over GitHub’s limit before committing or pushing', async () => {
    const fixture = await createFixture()
    const committer = {
      commit: async () => {
        throw new Error('must not commit an oversized body')
      },
    }
    const summary = 'x'.repeat(65_536)

    await expect(
      createPublisher(fixture, { committer }).publish(fixture.workspace, {
        ...input(),
        summary,
      }),
    ).rejects.toThrow(/exceeds GitHub's 65536-byte limit/)
    expect(await readCalls(fixture)).toHaveLength(0)
    await expect(
      git(fixture.bareRepo, ['show-ref', '--verify', `refs/heads/${fixture.workspace.branch}`]),
    ).rejects.toBeDefined()
  })

  it('allows a body exactly at the byte limit and redacts caller-provided public summaries', async () => {
    const fixture = await createFixture()
    const headerBytes = Buffer.byteLength('## Summary\n\n')
    const redactedReview = '[REDACTED] reviewer note'
    const footerBytes = Buffer.byteLength(`\n\n## Review summary\n\n${redactedReview}`)
    const summary = `${'x'.repeat(65_536 - headerBytes - footerBytes - Buffer.byteLength('[REDACTED]'))}test-secret-value`
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    const result = await createPublisher(fixture).publish(fixture.workspace, {
      ...input(),
      summary,
      reviewSummary: 'test-secret-value reviewer note',
    })

    expect(Buffer.byteLength(result.body, 'utf8')).toBe(65_536)
    expect(result.body).not.toContain('test-secret-value')
    expect((await readCalls(fixture))[1]?.body).toBe(result.body)
  })

  it('targets an explicitly selected fork remote while keeping the configured repository as the PR base', async () => {
    const fixture = await createFixture()
    await git(fixture.workspace.path, ['remote', 'add', 'fork', 'https://github.com/contributor/joy.git'])
    await git(fixture.workspace.path, [
      'config',
      '--add',
      `url.${pathToFileURL(fixture.bareRepo).href}.insteadOf`,
      'https://github.com/contributor/joy.git',
    ])
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    await createPublisher(fixture, { remote: 'fork' }).publish(fixture.workspace, input())

    const calls = await readCalls(fixture)
    expect(calls[0]?.args).toContain('github.com/example/joy')
    expect(calls[0]?.args).toContain(`contributor:${fixture.workspace.branch}`)
    expect(calls[1]?.args).toContain('github.com/example/joy')
    expect(calls[1]?.args).toContain(`contributor:${fixture.workspace.branch}`)
  })

  it('rejects an unrelated local base commit not contained by the remote base branch', async () => {
    const fixture = await createFixture()
    await git(fixture.workspace.path, ['switch', 'main'])
    await writeFile(join(fixture.workspace.path, 'local-base.txt'), 'unpublished local base\n')
    await git(fixture.workspace.path, ['add', '--all'])
    await git(fixture.workspace.path, ['commit', '-q', '-m', 'Unpushed base change'])
    await git(fixture.workspace.path, ['switch', '-C', fixture.workspace.branch])
    fixture.workspace.baseCommit = await git(fixture.workspace.path, ['rev-parse', 'HEAD'])
    await writeFile(join(fixture.workspace.path, 'task-change.txt'), 'task change\n')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /not an ancestor of example\/joy:main/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
    await expect(
      git(fixture.bareRepo, ['show-ref', '--verify', `refs/heads/${fixture.workspace.branch}`]),
    ).rejects.toBeDefined()
  })

  it('blocks credential files and secret-like committed diffs before push', async () => {
    const credentialFixture = await createFixture()
    await writeFile(join(credentialFixture.workspace.path, '.env'), 'API_TOKEN=unsafe\n')
    await expect(
      createPublisher(credentialFixture).publish(credentialFixture.workspace, input()),
    ).rejects.toThrow(/likely secret or credential files/)
    expect(await readCalls(credentialFixture)).toHaveLength(0)

    const diffFixture = await createFixture()
    await writeFile(join(diffFixture.workspace.path, 'config.txt'), 'test-secret-value\n')
    await expect(createPublisher(diffFixture).publish(diffFixture.workspace, input())).rejects.toThrow(
      /diff containing secret-like content/,
    )
    expect(await readCalls(diffFixture)).toHaveLength(0)
  })

  it('rejects unconfigured or mismatched targets and never falls back to gh context', async () => {
    const fixture = await createFixture()
    const workspace: Workspace = {
      ...fixture.workspace,
      repo: {
        id: fixture.workspace.repo.id,
        path: fixture.workspace.repo.path,
        defaultBranch: fixture.workspace.repo.defaultBranch,
      },
    }

    await expect(createPublisher(fixture).publish(workspace, input())).rejects.toThrow(/RepoRef.githubRemote/)
    await expect(
      createPublisher(fixture).publish(
        {
          ...fixture.workspace,
          repo: { ...fixture.workspace.repo, githubRemote: 'https://github.com/example/other.git' },
        },
        input(),
      ),
    ).rejects.toThrow(/not the configured repository or an explicitly configured fork/)
    expect(await readCalls(fixture)).toHaveLength(0)
  })

  it('rejects ambiguous multiple push URLs instead of selecting a remote implicitly', async () => {
    const fixture = await createFixture()
    await git(fixture.workspace.path, ['config', '--add', 'remote.origin.pushurl', configuredRemote])
    await git(fixture.workspace.path, [
      'config',
      '--add',
      'remote.origin.pushurl',
      'https://github.com/example/joy-copy.git',
    ])

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /must have exactly one configured push URL/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
  })

  it('rejects a PR URL that does not belong to the configured GitHub repository', async () => {
    const fixture = await createFixture({ ghMode: 'bad-url' })
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /outside the configured repository/,
    )
  })

  it('refuses to publish the repository default branch', async () => {
    const fixture = await createFixture()
    const publisher = createPublisher(fixture)

    await expect(publisher.publish({ ...fixture.workspace, branch: 'main' }, input())).rejects.toThrow(
      'Refusing to publish the repository default branch.',
    )
  })
})

function input() {
  return {
    title: 'Publish task branch',
    baseBranch: 'main',
    summary: 'Adds the task changes.',
    reviewSummary: '- [major] src/index.ts: Handle the empty input',
  }
}

function createPublisher(
  fixture: Fixture,
  overrides: {
    committer?: { commit: (workspace: Workspace, message: string) => Promise<string | null> }
    commandTimeoutMs?: number
    remote?: string
  } = {},
): GitHubPublisher {
  return new GitHubPublisher({
    committer: overrides.committer ?? {
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
    ...(overrides.remote === undefined ? {} : { remote: overrides.remote }),
    ...(overrides.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: overrides.commandTimeoutMs }),
    redact: (value) => value.replaceAll('test-secret-value', '[REDACTED]'),
    ghExecutable: process.execPath,
    ghPrefixArgs: [fixture.fakeGh, fixture.ghCapture, fixture.ghState, fixture.ghMode],
  })
}

async function createFixture(options: { ghMode?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'joy-github-publisher-'))
  roots.push(root)
  const bareRepo = join(root, 'origin.git')
  const repoPath = join(root, 'repo')
  const fakeGh = join(root, 'fake-gh.mjs')
  const ghCapture = join(root, 'gh-calls.json')
  const ghState = join(root, 'gh-state.json')
  const ghMode = options.ghMode ?? 'ok'
  await mkdir(repoPath)
  await git(root, ['init', '--bare', bareRepo])
  await git(repoPath, ['init', '-b', 'main'])
  await git(repoPath, ['config', 'user.name', 'Joy Test'])
  await git(repoPath, ['config', 'user.email', 'joy@example.test'])
  await writeFile(join(repoPath, 'README.md'), 'test repository\n')
  await git(repoPath, ['add', '--all'])
  await git(repoPath, ['commit', '-q', '-m', 'Initial commit'])
  await git(repoPath, ['remote', 'add', 'origin', configuredRemote])
  await git(repoPath, ['config', `url.${pathToFileURL(bareRepo).href}.insteadOf`, configuredRemote])
  await git(repoPath, ['push', '--set-upstream', 'origin', 'main'])

  const branch = 'joy/task-1/attempt-1'
  await git(repoPath, ['switch', '-c', branch])
  const repo: RepoRef = {
    id: 'publisher-test' as RepoId,
    path: repoPath,
    defaultBranch: 'main',
    githubRemote: configuredRemote,
  }
  const workspace: Workspace = {
    repo,
    taskId: 'task-1' as TaskId,
    attemptId: 'attempt-1' as AttemptId,
    path: repoPath,
    branch,
    baseCommit: await git(repoPath, ['rev-parse', 'main']),
  }
  await writeFakeGh(fakeGh)
  return { root, bareRepo, workspace, fakeGh, ghCapture, ghState, ghMode }
}

async function writeFakeGh(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "import { access, readFile, stat, writeFile } from 'node:fs/promises'",
      'const [capturePath, statePath, mode, ...args] = process.argv.slice(2)',
      'let calls = []',
      "try { calls = JSON.parse(await readFile(capturePath, 'utf8')) } catch {}",
      'let stdinBytes = 0',
      'for await (const chunk of process.stdin) stdinBytes += Buffer.byteLength(chunk)',
      "const bodyIndex = args.indexOf('--body-file')",
      'const bodyPath = bodyIndex >= 0 ? args[bodyIndex + 1] : undefined',
      "const body = bodyPath ? await readFile(bodyPath, 'utf8') : undefined",
      'const bodyMode = bodyPath ? (await stat(bodyPath)).mode & 0o777 : undefined',
      'calls.push({ args, cwd: process.cwd(), body, bodyMode, bodyPath, stdinIsTTY: process.stdin.isTTY === true, stdinBytes, terminalPrompt: process.env.GIT_TERMINAL_PROMPT, ghPromptDisabled: process.env.GH_PROMPT_DISABLED, gitCredentialManagerInteractive: process.env.GCM_INTERACTIVE, sshCommand: process.env.GIT_SSH_COMMAND, sshAskpassRequire: process.env.SSH_ASKPASS_REQUIRE })',
      'await writeFile(capturePath, JSON.stringify(calls))',
      'const operation = args[1]',
      "if (operation === 'list') {",
      "  if (mode === 'hang') setInterval(() => {}, 1000)",
      '  let prs = []',
      "  try { prs = JSON.parse(await readFile(statePath, 'utf8')) } catch {}",
      '  process.stdout.write(JSON.stringify(prs))',
      "} else if (operation === 'create') {",
      '  const option = (name) => args[args.indexOf(name) + 1]',
      "  const target = option('--repo').split('/').slice(-2).join('/')",
      "  const branch = option('--head').split(':').at(-1)",
      "  const pr = { url: `https://github.com/${target}/pull/42`, state: 'OPEN', isDraft: true, headRefName: branch, baseRefName: option('--base') }",
      "  if (mode === 'partial') {",
      '    let previous = false',
      '    try { await access(statePath); previous = true } catch {}',
      '    await writeFile(statePath, JSON.stringify([pr]))',
      "    if (!previous) { process.stderr.write('GraphQL accepted the request; test-secret-value was redacted'); process.exitCode = 1 }",
      "    else process.stdout.write(pr.url + '\\n')",
      "  } else if (mode === 'error') {",
      "    process.stderr.write('GraphQL rejected the request: test-secret-value\\n')",
      '    process.exitCode = 1',
      "  } else if (mode === 'long-error') {",
      "    process.stderr.write('GraphQL diagnostic: ' + 'x'.repeat(5000))",
      '    process.exitCode = 1',
      "  } else if (mode === 'bad-url') {",
      "    process.stdout.write('https://attacker.example/evil/pull/5\\n')",
      '  } else {',
      '    await writeFile(statePath, JSON.stringify([pr]))',
      "    process.stdout.write(pr.url + '\\n')",
      '  }',
      '} else { process.exitCode = 2 }',
      '',
    ].join('\n'),
  )
}

async function readCalls(fixture: Fixture): Promise<GhCall[]> {
  try {
    return JSON.parse(await readFile(fixture.ghCapture, 'utf8')) as GhCall[]
  } catch {
    return []
  }
}

async function makeCompetingRemoteCommit(fixture: Fixture): Promise<void> {
  const clonePath = join(fixture.root, 'competitor')
  await git(fixture.root, ['clone', fixture.bareRepo, clonePath])
  await git(clonePath, ['config', 'user.name', 'Competitor'])
  await git(clonePath, ['config', 'user.email', 'competitor@example.test'])
  await git(clonePath, ['switch', '-c', fixture.workspace.branch])
  await writeFile(join(clonePath, 'remote-change.txt'), 'remote change\n')
  await git(clonePath, ['add', '--all'])
  await git(clonePath, ['commit', '-q', '-m', 'Remote commit'])
  await git(clonePath, [
    'push',
    'origin',
    `refs/heads/${fixture.workspace.branch}:refs/heads/${fixture.workspace.branch}`,
  ])
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
