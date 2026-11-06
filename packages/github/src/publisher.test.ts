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
  gitSsh: string | undefined
  sshCommand: string | undefined
  sshAskpassRequire: string | undefined
}

interface Fixture {
  root: string
  bareRepo: string
  workspace: Workspace
  fakeGh: string
  fakeGit: string
  ghCapture: string
  ghState: string
  ghMode: string
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )
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
      fixture.workspace.branch,
      '--limit',
      '100',
      '--state',
      'all',
      '--json',
      'url,state,isDraft,headRefName,headRepositoryOwner,headRepository,baseRefName,body',
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
    expect(calls[0]?.gitSsh).toBe(process.env.GIT_SSH)
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
    expect(retry.body).toContain('## Summary\n\nAdds the task changes.')
    const calls = await readCalls(fixture)
    expect(calls.filter((call) => call.args[1] === 'create')).toHaveLength(1)
    expect(calls.filter((call) => call.args[1] === 'list')).toHaveLength(2)
  }, 20_000)

  it('does not reuse an existing PR from a different repository under the same owner', async () => {
    const fixture = await createFixture()
    await writeFile(
      fixture.ghState,
      JSON.stringify([
        {
          url: 'https://github.com/example/joy/pull/41',
          state: 'OPEN',
          isDraft: true,
          headRefName: fixture.workspace.branch,
          headRepositoryOwner: { login: 'example' },
          headRepository: { name: 'other-joy' },
          baseRefName: 'main',
          body: 'another fork body',
        },
      ]),
    )
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    await createPublisher(fixture).publish(fixture.workspace, input())

    const calls = await readCalls(fixture)
    expect(calls[0]?.args).toContain(fixture.workspace.branch)
    expect(calls.some((call) => call.args[1] === 'create')).toBe(true)
  })

  it('reuses a matching PR using fields returned by older gh versions', async () => {
    const fixture = await createFixture()
    await writeFile(
      fixture.ghState,
      JSON.stringify([
        {
          url: 'https://github.com/example/joy/pull/41',
          state: 'OPEN',
          isDraft: true,
          headRefName: fixture.workspace.branch,
          headRepositoryOwner: { login: 'example' },
          headRepository: { name: 'joy' },
          baseRefName: 'main',
          body: 'Existing draft.',
        },
      ]),
    )
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    const result = await createPublisher(fixture).publish(fixture.workspace, input())

    expect(result.pullRequestUrl).toBe('https://github.com/example/joy/pull/41')
    expect((await readCalls(fixture)).some((call) => call.args[1] === 'create')).toBe(false)
  })

  it('returns the saved body when reusing the matching open draft', async () => {
    const fixture = await createFixture()
    const existingBody = 'Original PR body includes test-secret-value.'
    await writeFile(
      fixture.ghState,
      JSON.stringify([
        {
          url: 'https://github.com/example/joy/pull/41',
          state: 'OPEN',
          isDraft: true,
          headRefName: fixture.workspace.branch,
          headRepositoryOwner: { login: 'example' },
          headRepository: { name: 'joy' },
          baseRefName: 'main',
          body: existingBody,
        },
      ]),
    )
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    const result = await createPublisher(fixture).publish(fixture.workspace, input())

    expect(result.pullRequestUrl).toBe('https://github.com/example/joy/pull/41')
    expect(result.body).toBe('Original PR body includes [REDACTED].')
    expect(result.body).not.toContain('test-secret-value')
    expect((await readCalls(fixture)).some((call) => call.args[1] === 'create')).toBe(false)
  })

  it.each(['CLOSED', 'MERGED'])('does not create a duplicate for a matching %s PR', async (state) => {
    const fixture = await createFixture()
    await writeFile(
      fixture.ghState,
      JSON.stringify([
        {
          url: 'https://github.com/example/joy/pull/41',
          state,
          isDraft: true,
          headRefName: fixture.workspace.branch,
          headRepositoryOwner: { login: 'example' },
          headRepository: { name: 'joy' },
          baseRefName: 'main',
          body: 'Existing closed PR.',
        },
      ]),
    )
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      new RegExp(`pull/41 in ${state.toLowerCase()} state; refusing to create a duplicate`),
    )
    expect((await readCalls(fixture)).some((call) => call.args[1] === 'create')).toBe(false)
  })

  it('preserves configured SSH commands and accepts the common ssh://git@github.com URL form', async () => {
    const fixture = await createFixture()
    const previousGitSsh = process.env.GIT_SSH
    const previousGitSshCommand = process.env.GIT_SSH_COMMAND
    const configuredCommand = 'ssh -F /tmp/joy-test-ssh-config -o ControlMaster=no'
    process.env.GIT_SSH = 'joy-test-ssh-wrapper'
    process.env.GIT_SSH_COMMAND = configuredCommand
    const sshRemote = 'ssh://git@github.com/example/joy.git'
    await git(fixture.workspace.path, [
      'config',
      '--add',
      `url.${pathToFileURL(fixture.bareRepo).href}.insteadOf`,
      sshRemote,
    ])
    await git(fixture.workspace.path, ['config', 'core.sshCommand', 'ssh -F /tmp/joy-core-ssh-config'])
    fixture.workspace.repo.githubRemote = sshRemote
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    try {
      await createPublisher(fixture).publish(fixture.workspace, input())
    } finally {
      if (previousGitSsh === undefined) delete process.env.GIT_SSH
      else process.env.GIT_SSH = previousGitSsh
      if (previousGitSshCommand === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previousGitSshCommand
    }

    const call = (await readCalls(fixture))[0]
    expect(call?.gitSsh).toBe('joy-test-ssh-wrapper')
    expect(call?.sshCommand).toBe(configuredCommand)
    expect(await git(fixture.workspace.path, ['config', '--get', 'core.sshCommand'])).toBe(
      'ssh -F /tmp/joy-core-ssh-config',
    )
  })

  it('rejects SSH remotes that embed credentials', async () => {
    const fixture = await createFixture()
    fixture.workspace.repo.githubRemote = 'ssh://git:password@github.com/example/joy.git'

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /must not embed credentials/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
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
    const timeoutMs = 5_000

    await expect(
      createPublisher(fixture, { commandTimeoutMs: timeoutMs }).publish(fixture.workspace, input()),
    ).rejects.toThrow(new RegExp(`GitHub CLI PR lookup timed out after ${timeoutMs} ms`))
    expect((await readCalls(fixture))[0]?.args[1]).toBe('list')
  }, 15_000)

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

  it.each(['insteadOf', 'pushInsteadOf'])(
    'rejects a rewritten effective push URL from %s instead of trusting raw remote config',
    async (rewrite) => {
      const fixture = await createFixture()
      if (rewrite === 'insteadOf') {
        await git(fixture.workspace.path, [
          'config',
          '--unset-all',
          `url.${pathToFileURL(fixture.bareRepo).href}.insteadOf`,
        ])
      }
      await git(fixture.workspace.path, [
        'config',
        '--add',
        `url.https://github.com/example/redirected.git.${rewrite}`,
        configuredRemote,
      ])
      await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

      await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
        /not the configured repository or an explicitly configured fork/,
      )
      expect(await readCalls(fixture)).toHaveLength(0)
    },
  )

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
    expect(calls[0]?.args).toContain(fixture.workspace.branch)
    expect(calls[1]?.args).toContain('github.com/example/joy')
    expect(calls[1]?.args).toContain(`contributor:${fixture.workspace.branch}`)
  }, 20_000)

  it('rejects a rewritten base fetch target even when the push URL points to the validated repository', async () => {
    const fixture = await createFixture()
    const attackerBare = join(fixture.root, 'attacker.git')
    const pushUrl = 'ssh://git@github.com/example/joy.git'
    await git(fixture.root, ['clone', '--bare', fixture.bareRepo, attackerBare])
    await git(fixture.workspace.path, [
      'config',
      '--unset-all',
      `url.${pathToFileURL(fixture.bareRepo).href}.insteadOf`,
    ])
    await git(fixture.workspace.path, [
      'config',
      '--add',
      `url.${pathToFileURL(attackerBare).href}.insteadOf`,
      configuredRemote,
    ])
    await git(fixture.workspace.path, ['remote', 'set-url', 'origin', pushUrl])
    await git(fixture.workspace.path, [
      'config',
      '--add',
      `url.${pathToFileURL(fixture.bareRepo).href}.pushInsteadOf`,
      pushUrl,
    ])
    await writeFile(join(fixture.workspace.path, 'change.txt'), 'published change\n')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /effective base fetch URL/i,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
    await expect(
      git(fixture.bareRepo, ['show-ref', '--verify', `refs/heads/${fixture.workspace.branch}`]),
    ).rejects.toBeDefined()
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
      /secret-like added content/,
    )
    expect(await readCalls(diffFixture)).toHaveLength(0)
    const prefixedFixture = await createFixture()
    await writeFile(join(prefixedFixture.workspace.path, 'config.txt'), '++test-secret-value\n')
    await expect(
      createPublisher(prefixedFixture).publish(prefixedFixture.workspace, input()),
    ).rejects.toThrow(/secret-like added content/)
    expect(await readCalls(prefixedFixture)).toHaveLength(0)
  }, 30_000)

  it('scans earlier pushed commits even when their sensitive path and secret content were later deleted', async () => {
    const pathFixture = await createFixture()
    await writeFile(join(pathFixture.workspace.path, '.netrc'), 'machine github.com login user\n')
    await commitAll(pathFixture.workspace.path, 'Add credential file')
    await rm(join(pathFixture.workspace.path, '.netrc'))
    await commitAll(pathFixture.workspace.path, 'Delete credential file')
    await writeFile(join(pathFixture.workspace.path, 'safe-change.txt'), 'safe change\n')

    await expect(createPublisher(pathFixture).publish(pathFixture.workspace, input())).rejects.toThrow(
      /likely secret or credential files/,
    )
    expect(await readCalls(pathFixture)).toHaveLength(0)

    const contentFixture = await createFixture()
    await writeFile(join(contentFixture.workspace.path, 'config.txt'), 'test-secret-value\n')
    await commitAll(contentFixture.workspace.path, 'Add unsafe content')
    await rm(join(contentFixture.workspace.path, 'config.txt'))
    await commitAll(contentFixture.workspace.path, 'Delete unsafe content')
    await writeFile(join(contentFixture.workspace.path, 'safe-change.txt'), 'safe change\n')

    await expect(createPublisher(contentFixture).publish(contentFixture.workspace, input())).rejects.toThrow(
      /secret-like added content/,
    )
    expect(await readCalls(contentFixture)).toHaveLength(0)
  }, 20_000)

  it('blocks secret-like text in a prior pushed commit message', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.workspace.path, 'message-content.txt'), 'safe content\n')
    await commitAll(fixture.workspace.path, 'test-secret-value')
    await writeFile(join(fixture.workspace.path, 'final-change.txt'), 'another safe change\n')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /secret-like text in its message/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
  })

  it.each(['.netrc', '.git-credentials', 'id_ecdsa', 'id_dsa', 'wallet.kdbx'])(
    'blocks sensitive credential path %s',
    async (path) => {
      const fixture = await createFixture()
      await writeFile(join(fixture.workspace.path, path), 'credential material\n')

      await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
        /likely secret or credential files/,
      )
      expect(await readCalls(fixture)).toHaveLength(0)
    },
  )

  it('allows deleting a credential file that was already present at the base', async () => {
    const fixture = await createFixture()
    await addBaseFile(fixture, '.netrc', 'machine github.com login user\n')
    await rm(join(fixture.workspace.path, '.netrc'))
    await writeFile(join(fixture.workspace.path, 'safe-change.txt'), 'safe change\n')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).resolves.toBeDefined()
  })

  it('rejects binary additions in pushed history but allows deleting a binary already in the base', async () => {
    const addedFixture = await createFixture()
    await writeFile(join(addedFixture.workspace.path, 'image.bin'), Buffer.from([0, 255, 1, 2]))
    await commitAll(addedFixture.workspace.path, 'Add binary')
    await rm(join(addedFixture.workspace.path, 'image.bin'))
    await commitAll(addedFixture.workspace.path, 'Delete binary')
    await writeFile(join(addedFixture.workspace.path, 'safe-change.txt'), 'safe change\n')

    await expect(createPublisher(addedFixture).publish(addedFixture.workspace, input())).rejects.toThrow(
      /binary changes that cannot be safely scanned/,
    )
    expect(await readCalls(addedFixture)).toHaveLength(0)

    const deletedFixture = await createFixture()
    await addBaseFile(deletedFixture, 'image.bin', Buffer.from([0, 255, 1, 2]))
    await rm(join(deletedFixture.workspace.path, 'image.bin'))
    await writeFile(join(deletedFixture.workspace.path, 'safe-change.txt'), 'safe change\n')

    await expect(
      createPublisher(deletedFixture).publish(deletedFixture.workspace, input()),
    ).resolves.toBeDefined()
  }, 20_000)

  it('blocks Git LFS pointers because their external payload is not scanned', async () => {
    const fixture = await createFixture()
    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${'a'.repeat(64)}`,
      'size 12345',
      '',
    ].join('\n')
    await writeFile(join(fixture.workspace.path, 'model.bin'), pointer)

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /Git LFS pointer changes because their external payload cannot be safely scanned/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
    await expect(
      git(fixture.bareRepo, ['show-ref', '--verify', `refs/heads/${fixture.workspace.branch}`]),
    ).rejects.toBeDefined()
  })

  it('blocks edited Git LFS pointers when only the oid and size lines change', async () => {
    const fixture = await createFixture()
    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${'a'.repeat(64)}`,
      'size 12345',
      '',
    ].join('\n')
    await addBaseFile(fixture, 'model.bin', pointer)
    await writeFile(
      join(fixture.workspace.path, 'model.bin'),
      pointer.replace('a'.repeat(64), 'b'.repeat(64)).replace('size 12345', 'size 54321'),
    )
    await commitAll(fixture.workspace.path, 'Update LFS object')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /Git LFS pointer changes because their external payload cannot be safely scanned/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
  })

  it.each(['https://hawser.github.com/spec/v1', 'http://git-media.io/v/2'])(
    'blocks accepted Git LFS pointer version %s with surrounding whitespace',
    async (version) => {
      const fixture = await createFixture()
      const pointer = [`  version ${version}`, `oid sha256:${'c'.repeat(64)}`, 'size 23456', ''].join('\n')
      await writeFile(join(fixture.workspace.path, 'model.bin'), pointer)

      await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
        /Git LFS pointer changes because their external payload cannot be safely scanned/,
      )
      expect(await readCalls(fixture)).toHaveLength(0)
    },
  )

  it.each([
    [
      'a signed size',
      [`version https://git-lfs.github.com/spec/v1`, `oid sha256:${'d'.repeat(64)}`, 'size +12345', ''].join(
        '\n',
      ),
    ],
    [
      'a negative zero size',
      [`version https://git-lfs.github.com/spec/v1`, `oid sha256:${'d'.repeat(64)}`, 'size -0', ''].join(
        '\n',
      ),
    ],
    [
      'leading U+0085 whitespace',
      `\u0085${[
        'version https://git-lfs.github.com/spec/v1',
        `oid sha256:${'d'.repeat(64)}`,
        'size 12345',
        '',
      ].join('\n')}`,
    ],
    [
      'trailing U+0085 whitespace',
      `${['version https://git-lfs.github.com/spec/v1', `oid sha256:${'d'.repeat(64)}`, 'size 12345'].join(
        '\n',
      )}\u0085`,
    ],
    [
      'an extension before the version',
      [
        `ext-0-foo sha256:${'e'.repeat(64)}`,
        'version https://git-lfs.github.com/spec/v1',
        `oid sha256:${'f'.repeat(64)}`,
        'size 12345',
        '',
      ].join('\n'),
    ],
  ])('blocks Git LFS pointers with %s', async (_description, pointer) => {
    const fixture = await createFixture()
    await writeFile(join(fixture.workspace.path, 'model.bin'), pointer)

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /Git LFS pointer changes because their external payload cannot be safely scanned/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
  })

  it.each([
    ['an alphanumeric oid accepted by older git-lfs', `oid sha256:${'g'.repeat(64)}`],
    ['an oid followed by trailing text accepted by older git-lfs', `oid sha256:${'a'.repeat(64)}suffix`],
  ])('blocks Git LFS pointers with %s', async (_description, oidLine) => {
    const fixture = await createFixture()
    const pointer = ['version https://git-lfs.github.com/spec/v1', oidLine, 'size 12345', ''].join('\n')
    await writeFile(join(fixture.workspace.path, 'model.bin'), pointer)

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /Git LFS pointer changes because their external payload cannot be safely scanned/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
  })

  it('publishes a small edit to an existing text blob larger than the LFS pointer limit', async () => {
    const fixture = await createFixture()
    const baseText = 'a\n'.repeat(5_600_000)
    await addBaseFile(fixture, 'large.txt', baseText)
    await writeFile(join(fixture.workspace.path, 'large.txt'), baseText.replace('a\n', 'b\n'))
    await commitAll(fixture.workspace.path, 'Edit one line in a large text file')

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).resolves.toBeDefined()
  }, 30_000)

  // 2,000 files make the batch input larger than a pipe buffer, which is what reproduces the early stdin close.
  // Creating, committing and cleaning them up through the fake-git wrapper takes ~40 s on Windows runners.
  it(
    'reports a failed batch-size query without crashing when git closes stdin early',
    { timeout: 120_000 },
    async () => {
      const fixture = await createFixture({ fakeGitMode: 'exit-batch-check' })
      await Promise.all(
        Array.from({ length: 2_000 }, (_, index) =>
          writeFile(join(fixture.workspace.path, `changed-${index}.txt`), `change ${index}\n`),
        ),
      )
      await commitAll(fixture.workspace.path, 'Add many small files')

      await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
        /Git changed blob size list failed/,
      )
    },
  )

  it('reports an actionable error when a pushed commit patch exceeds the scan limit', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.workspace.path, 'large.txt'), Buffer.alloc(10 * 1024 * 1024 + 1024, 97))

    await expect(createPublisher(fixture).publish(fixture.workspace, input())).rejects.toThrow(
      /exceeded the 10 MiB output limit; split the change into smaller commits/,
    )
    expect(await readCalls(fixture)).toHaveLength(0)
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
      /must have exactly one effective push URL/,
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
    gitExecutable: process.execPath,
    gitPrefixArgs: [fixture.fakeGit],
    ghExecutable: process.execPath,
    ghPrefixArgs: [fixture.fakeGh, fixture.ghCapture, fixture.ghState, fixture.ghMode],
  })
}

async function createFixture(options: { ghMode?: string; fakeGitMode?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'joy-github-publisher-'))
  roots.push(root)
  const bareRepo = join(root, 'origin.git')
  const repoPath = join(root, 'repo')
  const fakeGh = join(root, 'fake-gh.mjs')
  const fakeGit = join(root, 'fake-git.mjs')
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
  await writeFakeGit(fakeGit, bareRepo, options.fakeGitMode)
  return { root, bareRepo, workspace, fakeGh, fakeGit, ghCapture, ghState, ghMode }
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
      'calls.push({ args, cwd: process.cwd(), body, bodyMode, bodyPath, stdinIsTTY: process.stdin.isTTY === true, stdinBytes, terminalPrompt: process.env.GIT_TERMINAL_PROMPT, ghPromptDisabled: process.env.GH_PROMPT_DISABLED, gitCredentialManagerInteractive: process.env.GCM_INTERACTIVE, gitSsh: process.env.GIT_SSH, sshCommand: process.env.GIT_SSH_COMMAND, sshAskpassRequire: process.env.SSH_ASKPASS_REQUIRE })',
      'await writeFile(capturePath, JSON.stringify(calls))',
      'const operation = args[1]',
      "if (operation === 'list') {",
      "  if (mode === 'hang') setInterval(() => {}, 1000)",
      "  const headIndex = args.indexOf('--head')",
      "  if (headIndex >= 0 && args[headIndex + 1]?.includes(':')) { process.stderr.write('--head accepts a branch name, not owner:branch\\n'); process.exitCode = 2 } else {",
      '  let prs = []',
      "  try { prs = JSON.parse(await readFile(statePath, 'utf8')) } catch {}",
      '  process.stdout.write(JSON.stringify(prs))',
      '  }',
      "} else if (operation === 'create') {",
      '  const option = (name) => args[args.indexOf(name) + 1]',
      "  const target = option('--repo').split('/').slice(-2).join('/')",
      "  const branch = option('--head').split(':').at(-1)",
      "  const head = option('--head')",
      "  const headRepositoryOwner = { login: head.split(':')[0] }",
      "  const headRepository = { name: target.split('/').at(-1) }",
      "  const pr = { url: `https://github.com/${target}/pull/42`, state: 'OPEN', isDraft: true, headRefName: branch, headRepositoryOwner, headRepository, baseRefName: option('--base'), body: await readFile(option('--body-file'), 'utf8') }",
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

async function writeFakeGit(path: string, bareRepo: string, mode = ''): Promise<void> {
  await writeFile(
    path,
    [
      "import { spawnSync } from 'node:child_process'",
      "import { readFileSync } from 'node:fs'",
      'const args = process.argv.slice(2)',
      `const mode = ${JSON.stringify(mode)}`,
      "if (mode === 'exit-batch-check' && args[0] === 'cat-file' && args[1]?.startsWith('--batch-check=')) process.exit(1)",
      "const run = (items, input = undefined) => spawnSync('git', items, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, input })",
      `const expectedMirrorUrl = ${JSON.stringify(pathToFileURL(bareRepo).href)}`,
      `const canonicalRemote = ${JSON.stringify(configuredRemote)}`,
      "const batchInput = args[0] === 'cat-file' && args[1]?.startsWith('--batch-check=') ? readFileSync(0, 'utf8') : undefined",
      'const result = run(args, batchInput)',
      "if (args[0] === 'ls-remote' && args[1] === '--get-url') {",
      "  const url = (result.stdout ?? '').trim()",
      "  process.stdout.write((url === expectedMirrorUrl ? canonicalRemote : url) + '\\n')",
      '  if (result.stderr) process.stderr.write(result.stderr)',
      '  process.exitCode = result.status ?? 1',
      "} else if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === '--push' && args[3] === '--all') {",
      '  const remote = args[4]',
      "  const effectiveUrls = (result.stdout ?? '').trim().split(/\\r?\\n/).filter(Boolean)",
      "  const pushUrls = run(['config', '--get-all', `remote.${remote}.pushurl`])",
      "  const sourceUrls = pushUrls.status === 0 ? pushUrls.stdout : run(['config', '--get-all', `remote.${remote}.url`]).stdout",
      "  const sources = (sourceUrls ?? '').trim().split(/\\r?\\n/).filter(Boolean)",
      "  process.stdout.write(effectiveUrls.map((url, index) => url.startsWith('file:') ? (sources[index] ?? url) : url).join('\\n') + '\\n')",
      '  if (result.stderr) process.stderr.write(result.stderr)',
      '  process.exitCode = result.status ?? 1',
      '} else {',
      '  if (result.stdout) process.stdout.write(result.stdout)',
      '  if (result.stderr) process.stderr.write(result.stderr)',
      '  if (result.error) process.stderr.write(result.error.message)',
      '  process.exitCode = result.status ?? 1',
      '}',
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

async function addBaseFile(fixture: Fixture, path: string, contents: string | Uint8Array): Promise<void> {
  const cwd = fixture.workspace.path
  await git(cwd, ['switch', 'main'])
  await writeFile(join(cwd, path), contents)
  await commitAll(cwd, 'Add file to the base branch')
  await git(cwd, ['push', 'origin', 'main'])
  await git(cwd, ['switch', '-C', fixture.workspace.branch])
  fixture.workspace.baseCommit = await git(cwd, ['rev-parse', 'main'])
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '--all'])
  await git(cwd, ['commit', '-q', '-m', message])
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
