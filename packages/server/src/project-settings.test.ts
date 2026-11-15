// Project settings the owner writes once per project: instructions every new agent session starts with, an install
// command that replaces the lockfile guess, and the defaults the home page's message box starts from.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentProvider, ProviderKind, RunOptions, TaskId, Workspace } from '@joy/core'
import { ConfigStore } from '@joy/config'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { REVIEW_SCHEMA } from '@joy/orchestrator'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { WorktreeExecutor } from '@joy/executor'
import { createJoyServer } from './server.js'
import type { JoyServerOptions } from './server.js'

const TOKEN = 'test-api-token-for-project-settings'
const ORIGIN = 'http://127.0.0.1:5173'
const WORKTREE = '/fake/joy-worktree'
const servers: Array<{ close(): Promise<void> }> = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** Reviews approve; implementers change nothing and finish. Every run's options are recorded. */
function recordingProvider(kind: ProviderKind) {
  const calls: RunOptions[] = []
  const provider: AgentProvider = {
    kind,
    capabilities: {
      codeEdit: true,
      tools: true,
      resume: true,
      presetSessionId: false,
      delegatedApproval: true,
      quotaEvents: false,
      structuredOutput: true,
    },
    async *run(options: RunOptions): AsyncGenerator<AgentEvent> {
      calls.push(options)
      if (options.outputSchema === REVIEW_SCHEMA) {
        yield {
          type: 'done',
          sessionId: 'r',
          isError: false,
          structured: { approve: true, summary: 's', findings: [] },
        }
        return
      }
      const sessionId = options.resumeSessionId ?? `${kind}-session`
      if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
      yield { type: 'done', sessionId, isError: false, finalMessage: 'done' }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, calls }
}

class FakeExecutor {
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: Workspace['attemptId']) {
    return { repo, taskId, attemptId, path: WORKTREE, branch: `joy/${attemptId}`, baseCommit: 'base' }
  }
  async diff() {
    return {
      files: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0 }],
      patch: '+a\n',
    }
  }
  async commit() {
    return null
  }
  async cleanup() {}
  async run() {
    return { exitCode: 0, output: 'ok', timedOut: false }
  }
}

async function setup(options: Pick<JoyServerOptions, 'executor' | 'dependencyInstall'> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'joy-project-settings-'))
  dirs.push(home)
  writeFileSync(join(home, 'config.yaml'), 'approvals:\n  on_timeout: deny\n')
  const db = openDatabase(':memory:')
  databases.push(db)
  const redactor = new Redactor()
  const claude = recordingProvider('claude-cli')
  const codex = recordingProvider('codex-cli')
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    executor: options.executor ?? new FakeExecutor(),
    ...(options.dependencyInstall !== undefined ? { dependencyInstall: options.dependencyInstall } : {}),
    apiToken: TOKEN,
    approvalTimeoutMs: 300,
    cliVersionCheck: false,
    backups: false,
    memoryExtraction: false,
    conversationSummaries: false,
    providers: { 'claude-cli': claude.provider, 'codex-cli': codex.provider },
  })
  servers.push(server)
  const address = await server.listen()
  const origin = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: ORIGIN,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const addRepo = async (path: string) =>
    ((await call('POST', '/api/repos', { path, defaultBranch: 'main' })).body.repo as { id: string }).id
  const newTask = async (repoId: string, extra: object = {}) => {
    const { status, body } = await call('POST', '/api/tasks', {
      repoId,
      title: 'Do the thing',
      prompt: 'Add a greeting',
      mode: 'single',
      ...extra,
    })
    expect(status).toBe(201)
    return body.task as { id: string }
  }
  return { call, claude, codex, addRepo, newTask }
}

type Call = Awaited<ReturnType<typeof setup>>['call']
type Details = {
  task: { status: string }
  events: Array<{ type: string; payload: Record<string, unknown> }>
}
async function until(call: Call, id: string, check: (d: Details) => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  let last: Details | undefined
  while (Date.now() < deadline) {
    last = (await call('GET', `/api/tasks/${id}`)).body as unknown as Details
    if (check(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${what} (status ${last?.task.status})`)
}
const finished = (d: Details) => d.task.status === 'done' || d.task.status === 'review_ready'
const repoOf = async (call: Call, id: string) =>
  ((await call('GET', '/api/repos')).body.repos as Array<Record<string, unknown> & { id: string }>).find(
    (repo) => repo.id === id,
  )

describe('project instructions', () => {
  it('are stored trimmed, cleared with null or blank text, and limited to 20,000 characters', async () => {
    const { call, addRepo } = await setup()
    const id = await addRepo('/tmp/project-settings-a')
    expect((await repoOf(call, id))?.instructions).toBeUndefined()
    expect((await call('PATCH', `/api/repos/${id}`, { instructions: '  Use pnpm.\n  ' })).status).toBe(200)
    expect((await repoOf(call, id))?.instructions).toBe('Use pnpm.')
    await call('PATCH', `/api/repos/${id}`, { instructions: '   ' })
    expect((await repoOf(call, id))?.instructions).toBeUndefined()
    await call('PATCH', `/api/repos/${id}`, { instructions: 'x'.repeat(20_000) })
    expect(((await repoOf(call, id))?.instructions as string).length).toBe(20_000)
    await call('PATCH', `/api/repos/${id}`, { instructions: null })
    expect((await repoOf(call, id))?.instructions).toBeUndefined()
    expect((await call('PATCH', `/api/repos/${id}`, { instructions: 'x'.repeat(20_001) })).status).toBe(400)
  })

  it('open the prompt of every new session: implementer and reviewer, but not a resumed one', async () => {
    const { call, claude, codex, addRepo, newTask } = await setup()
    const id = await addRepo('/tmp/project-settings-b')
    const other = await addRepo('/tmp/project-settings-other')
    await call('PATCH', `/api/repos/${id}`, { instructions: 'Always write tests first.\nUse tabs.' })
    const task = await newTask(id, {
      mode: 'review_loop',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna' },
      },
    })
    await until(call, task.id, finished, 'review loop')

    const implement = claude.calls.find((c) => c.autonomy === 'workspace-write')
    expect(implement?.prompt.startsWith('Project instructions from the owner.')).toBe(true)
    expect(implement?.prompt).toContain(
      '<project-instructions>\nAlways write tests first.\nUse tabs.\n</project-instructions>',
    )
    // The task's own prompt follows, unchanged.
    expect(implement?.prompt).toContain('Add a greeting')
    const text = implement?.prompt ?? ''
    expect(text.indexOf('Always write tests first.')).toBeLessThan(text.indexOf('Add a greeting'))
    const review = codex.calls.find((c) => c.outputSchema === REVIEW_SCHEMA)
    expect(review?.prompt.startsWith('Project instructions from the owner.')).toBe(true)
    expect(review?.prompt).toContain('Always write tests first.')

    // A follow-up resumes the implementer's session, which already has the instructions.
    const followUp = await call('POST', `/api/tasks/${task.id}/messages`, { text: 'Also add a farewell' })
    expect(followUp.status).toBeLessThan(300)
    await until(call, task.id, (d) => claude.calls.some((c) => c.resumeSessionId) && finished(d), 'follow-up')
    const resumed = claude.calls.filter((c) => c.resumeSessionId)
    expect(resumed.length).toBeGreaterThan(0)
    for (const run of resumed) expect(run.prompt).not.toContain('Project instructions from the owner')

    // Another project's task is untouched.
    const unrelated = await newTask(other, {
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku' } },
    })
    await until(call, unrelated.id, finished, 'other project')
    const last = claude.calls.filter((c) => c.autonomy === 'workspace-write').at(-1)
    expect(last?.prompt).not.toContain('Project instructions from the owner')
    expect(last?.prompt).toContain('Add a greeting')
  })

  it('reach a plan-first run and the reviewer of the plan too', async () => {
    const { call, claude, addRepo, newTask } = await setup()
    const id = await addRepo('/tmp/project-settings-plan')
    await call('PATCH', `/api/repos/${id}`, { instructions: 'Keep changes small.' })
    const task = await newTask(id, {
      mode: 'review_loop',
      planFirst: true,
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku' } },
    })
    await until(call, task.id, (d) => d.events.some((e) => e.type === 'plan.awaiting_approval'), 'plan')
    const plan = claude.calls.find((c) => c.autonomy === 'read-only' && !c.outputSchema)
    expect(plan?.prompt).toContain('Keep changes small.')
    expect(plan?.prompt).toContain('Write a short implementation plan')
  })
})

describe('project defaults', () => {
  const defaults = {
    implementer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
    reviewer: { provider: 'claude-cli', model: 'haiku' },
    mode: 'single',
    permissionMode: 'auto',
  }

  it('are stored, replaced as a whole and cleared with null or an empty object', async () => {
    const { call, addRepo } = await setup()
    const id = await addRepo('/tmp/project-settings-defaults')
    expect((await call('PATCH', `/api/repos/${id}`, { defaults })).status).toBe(200)
    expect((await repoOf(call, id))?.defaults).toEqual(defaults)
    await call('PATCH', `/api/repos/${id}`, { defaults: { mode: 'compete' } })
    expect((await repoOf(call, id))?.defaults).toEqual({ mode: 'compete' })
    await call('PATCH', `/api/repos/${id}`, { defaults: {} })
    expect((await repoOf(call, id))?.defaults).toBeUndefined()
    await call('PATCH', `/api/repos/${id}`, { defaults })
    await call('PATCH', `/api/repos/${id}`, { defaults: null })
    expect((await repoOf(call, id))?.defaults).toBeUndefined()
  })

  it.each([
    [{ mode: 'party' }],
    [{ permissionMode: 'root' }],
    [{ planFirst: true }],
    [{ implementer: { provider: 'openai-api', model: 'gpt' } }],
    [{ reviewer: { provider: 'nobody', model: 'm' } }],
    [{ implementer: { provider: 'claude-cli', model: '' } }],
  ])('refuses %j', async (bad) => {
    const { call, addRepo } = await setup()
    const id = await addRepo('/tmp/project-settings-bad')
    expect((await call('PATCH', `/api/repos/${id}`, { defaults: bad })).status).toBe(400)
    expect((await repoOf(call, id))?.defaults).toBeUndefined()
  })

  it('must fit the project’s own limits, counting the ones sent in the same request', async () => {
    const { call, addRepo } = await setup()
    const id = await addRepo('/tmp/project-settings-limits')
    await call('PATCH', `/api/repos/${id}`, { allowedProviders: ['claude-cli'], maxPermissionMode: 'ask' })
    const notAllowed = await call('PATCH', `/api/repos/${id}`, { defaults })
    expect(notAllowed.status).toBe(422)
    expect(String(notAllowed.body.error)).toContain('does not allow')
    const tooHigh = await call('PATCH', `/api/repos/${id}`, {
      defaults: { permissionMode: 'auto' },
    })
    expect(tooHigh.status).toBe(422)
    expect(String(tooHigh.body.error)).toContain('above')
    expect((await repoOf(call, id))?.defaults).toBeUndefined()
    // Raising the limit in the same request makes it fit.
    expect(
      (
        await call('PATCH', `/api/repos/${id}`, {
          allowedProviders: ['claude-cli', 'codex-cli'],
          maxPermissionMode: 'full',
          defaults,
        })
      ).status,
    ).toBe(200)
    expect((await repoOf(call, id))?.defaults).toEqual(defaults)
  })
})

describe('install command', () => {
  /** A git repository (a lockfile is optional) and a package manager that only records how it was started. */
  function repoWith(options: { lockfile: boolean }) {
    const root = mkdtempSync(join(tmpdir(), 'joy-install-repo-'))
    dirs.push(root)
    const repoPath = join(root, 'repo')
    mkdirSync(repoPath)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repoPath, 'package.json'), '{"name":"x"}\n')
    if (options.lockfile) writeFileSync(join(repoPath, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
    const fakeTool = join(root, 'fake-tool.mjs')
    writeFileSync(
      fakeTool,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs'",
        "mkdirSync('node_modules', { recursive: true })",
        "writeFileSync('node_modules/.installed', JSON.stringify(process.argv.slice(2)))",
      ].join('\n'),
    )
    const asked: string[] = []
    return {
      root,
      repoPath,
      asked,
      dependencyInstall: {
        resolve: (command: string) => {
          asked.push(command)
          return { command: process.execPath, prefix: [fakeTool] }
        },
      },
    }
  }

  const worktreeOf = (d: Details) => d.events.find((e) => e.type === 'workspace')?.payload.path as string
  const installEvent = (d: Details) => d.events.find((e) => e.type === 'workspace.dependencies')

  it('replaces the lockfile install, as argv without a shell, in auto mode', async () => {
    const { root, repoPath, asked, dependencyInstall } = repoWith({ lockfile: true })
    const { call, addRepo, newTask } = await setup({
      executor: new WorktreeExecutor({ worktreesDir: join(root, 'worktrees') }),
      dependencyInstall,
    })
    const id = await addRepo(repoPath)
    expect(
      (
        await call('PATCH', `/api/repos/${id}`, {
          installCommand: ['pnpm', 'install', '--offline', '$HOME; rm -rf /'],
        })
      ).status,
    ).toBe(200)
    const task = await newTask(id, { permissionMode: 'auto' })
    const done = await until(call, task.id, finished, 'task')
    expect(installEvent(done)?.payload).toMatchObject({
      status: 'installed',
      manager: 'custom',
      command: 'pnpm install --offline $HOME; rm -rf /',
      exitCode: 0,
    })
    expect(asked).toEqual(['pnpm'])
    const recorded = readFileSync(join(worktreeOf(done), 'node_modules', '.installed'), 'utf8')
    expect(JSON.parse(recorded)).toEqual(['install', '--offline', '$HOME; rm -rf /'])
  })

  it('works in a project without any lockfile, and clearing it goes back to the lockfile install', async () => {
    const { root, repoPath, dependencyInstall } = repoWith({ lockfile: false })
    const { call, addRepo, newTask } = await setup({
      executor: new WorktreeExecutor({ worktreesDir: join(root, 'worktrees') }),
      dependencyInstall,
    })
    const id = await addRepo(repoPath)
    await call('PATCH', `/api/repos/${id}`, { installCommand: ['make', 'deps'] })
    const first = await until(
      call,
      (await newTask(id, { permissionMode: 'full' })).id,
      finished,
      'first task',
    )
    expect(installEvent(first)?.payload).toMatchObject({ status: 'installed', command: 'make deps' })
    await call('PATCH', `/api/repos/${id}`, { installCommand: null })
    expect((await repoOf(call, id))?.installCommand).toBeUndefined()
    const second = await until(
      call,
      (await newTask(id, { permissionMode: 'full' })).id,
      finished,
      'second task',
    )
    // No lockfile and no command: nothing to install, and nothing reported.
    expect(installEvent(second)).toBeUndefined()
  })

  it.each([
    [{ permissionMode: 'ask' }, 'ask mode'],
    [{}, 'ask mode'],
    [{ permissionMode: 'full', provenance: 'external_content' }, 'external content'],
  ])('is not run for %j', async (extra, reason) => {
    const { root, repoPath, asked, dependencyInstall } = repoWith({ lockfile: false })
    const { call, addRepo, newTask } = await setup({
      executor: new WorktreeExecutor({ worktreesDir: join(root, 'worktrees') }),
      dependencyInstall,
    })
    const id = await addRepo(repoPath)
    await call('PATCH', `/api/repos/${id}`, { installCommand: ['make', 'deps'] })
    const done = await until(
      call,
      (await newTask(id, extra)).id,
      (d) => d.events.some((e) => e.type === 'workspace.dependencies'),
      'skip event',
    )
    expect(installEvent(done)?.payload).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining(reason),
    })
    expect(asked).toEqual([])
    expect(existsSync(join(worktreeOf(done), 'node_modules'))).toBe(false)
  })

  it('is never run on this computer for a container (untrusted) project', async () => {
    const { root, repoPath, asked, dependencyInstall } = repoWith({ lockfile: true })
    const { call, addRepo, newTask } = await setup({
      executor: new WorktreeExecutor({ worktreesDir: join(root, 'worktrees') }),
      dependencyInstall,
    })
    const id = await addRepo(repoPath)
    await call('PATCH', `/api/repos/${id}`, { container: true, installCommand: ['make', 'deps'] })
    const done = await until(
      call,
      (await newTask(id, { permissionMode: 'auto' })).id,
      (d) => d.events.some((e) => e.type === 'workspace.dependencies'),
      'skip event',
    )
    expect(installEvent(done)?.payload).toMatchObject({ status: 'skipped' })
    expect(asked).toEqual([])
  })

  it('a failing custom install is a visible event and the task still runs', async () => {
    const { root, repoPath } = repoWith({ lockfile: false })
    const { call, addRepo, newTask, claude } = await setup({
      executor: new WorktreeExecutor({ worktreesDir: join(root, 'worktrees') }),
      dependencyInstall: { resolve: () => ({ command: join(root, 'no-such-tool'), prefix: [] }) },
    })
    const id = await addRepo(repoPath)
    await call('PATCH', `/api/repos/${id}`, { installCommand: ['make', 'deps'] })
    const done = await until(
      call,
      (await newTask(id, { permissionMode: 'auto' })).id,
      finished,
      'task after a failed install',
    )
    expect(installEvent(done)?.payload).toMatchObject({ status: 'failed', manager: 'custom' })
    expect(claude.calls.length).toBeGreaterThan(0)
  })

  it.each([[[]], [['']], ['pnpm install']])('refuses %j', async (bad) => {
    const { call, addRepo } = await setup()
    const id = await addRepo('/tmp/project-settings-install-bad')
    expect((await call('PATCH', `/api/repos/${id}`, { installCommand: bad })).status).toBe(400)
  })
})
