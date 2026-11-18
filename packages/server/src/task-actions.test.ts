// What the owner does with a finished task: merge it into the default branch, open its worktree in an editor.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentProvider, RunOptions, TaskId, Workspace } from '@joy/core'
import { ConfigStore } from '@joy/config'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { WorktreeExecutor } from '@joy/executor'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { EditorNotFoundError } from './editor.js'
import type { EditorRunner } from './editor.js'
import { createJoyServer } from './server.js'
import type { JoyServer, JoyServerOptions } from './server.js'

const TOKEN = 'test-api-token-for-task-actions-0042'
const servers: JoyServer[] = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

/** Writes `work` into add.js in its worktree; `hold` keeps the run going until opened. */
function fakeClaude() {
  const state: { text: string; hold?: Promise<void> } = { text: 'task\n' }
  const provider: AgentProvider = {
    kind: 'claude-cli',
    capabilities: {
      codeEdit: true,
      tools: true,
      resume: true,
      presetSessionId: false,
      delegatedApproval: false,
      quotaEvents: false,
      structuredOutput: true,
    },
    async *run(options: RunOptions): AsyncGenerator<AgentEvent> {
      yield { type: 'session_started', sessionId: 's1' }
      // The fake executor's worktree does not exist.
      if (existsSync(options.cwd)) writeFileSync(join(options.cwd, 'add.js'), state.text)
      await state.hold
      yield { type: 'done', sessionId: 's1', isError: false, finalMessage: 'done' }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, state }
}

class FakeExecutor {
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: Workspace['attemptId']) {
    return { repo, taskId, attemptId, path: '/fake/worktree', branch: 'joy/t/a', baseCommit: 'base' }
  }
  async diff() {
    return { files: [], patch: '' }
  }
  async commit() {
    return null
  }
  async cleanup() {}
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
}

async function setup(options: { config?: string; fakeExecutor?: boolean; editorRunner?: EditorRunner } = {}) {
  const home = tempDir('joy-actions-')
  writeFileSync(join(home, 'config.yaml'), `approvals:\n  on_timeout: deny\n${options.config ?? ''}`)
  const repoPath = join(home, 'repo')
  mkdirSync(repoPath)
  git(repoPath, 'init', '-q', '-b', 'main')
  git(repoPath, 'config', 'core.autocrlf', 'false')
  git(repoPath, 'config', 'user.name', 't')
  git(repoPath, 'config', 'user.email', 't@t')
  writeFileSync(join(repoPath, 'add.js'), 'start\n')
  writeFileSync(join(repoPath, 'other.js'), 'other\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-q', '-m', 'init')
  const db = openDatabase(':memory:')
  databases.push(db)
  const redactor = new Redactor()
  const claude = fakeClaude()
  const executor: JoyServerOptions['executor'] = options.fakeExecutor
    ? new FakeExecutor()
    : new WorktreeExecutor({ worktreesDir: join(home, 'worktrees') })
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    executor,
    apiToken: TOKEN,
    cliVersionCheck: false,
    backups: false,
    memoryExtraction: false,
    conversationSummaries: false,
    dependencyInstall: false,
    providers: { 'claude-cli': claude.provider },
    ...(options.editorRunner ? { editorRunner: options.editorRunner } : {}),
  })
  servers.push(server)
  const address = await server.listen()
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: 'http://127.0.0.1:5173',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const repoId = (
    (await call('POST', '/api/repos', { path: repoPath, defaultBranch: 'main' })).body.repo as {
      id: string
    }
  ).id
  return { call, claude, home, repoPath, repoId }
}

type Call = Awaited<ReturnType<typeof setup>>['call']
type Details = {
  task: { status: string }
  attempts: Array<{ worktreePath?: string }>
  events: Array<{ type: string; payload: Record<string, unknown> }>
}

async function until(call: Call, id: string, check: (d: Details) => boolean): Promise<Details> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const details = (await call('GET', `/api/tasks/${id}`)).body as unknown as Details
    if (check(details)) return details
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the task')
}

async function finishedTask(env: Awaited<ReturnType<typeof setup>>) {
  const { body } = await env.call('POST', '/api/tasks', {
    repoId: env.repoId,
    title: 'Fix add()',
    prompt: 'Fix add()',
    mode: 'single',
  })
  const id = (body.task as { id: string }).id
  const done = await until(env.call, id, (d) => d.task.status === 'done')
  return { id, worktree: done.attempts[0]?.worktreePath as string }
}

const merge = (call: Call, id: string, body: unknown = { confirm: true }) =>
  call('POST', `/api/tasks/${id}/merge-into-default`, body)

describe('merging a finished task into the default branch', () => {
  it('needs confirm: true, then merges, records task.merged and refuses a second merge', async () => {
    const env = await setup()
    const { id, worktree } = await finishedTask(env)
    expect((await merge(env.call, id, {})).status).toBe(400)
    expect((await merge(env.call, id, { confirm: false })).status).toBe(400)
    expect(git(env.repoPath, 'rev-list', '--count', 'main')).toBe('1')

    const merged = await merge(env.call, id)
    expect(merged.status).toBe(200)
    expect(merged.body.merged).toMatchObject({ branch: 'main', files: 1, updatedCheckout: true })
    expect(readFileSync(join(env.repoPath, 'add.js'), 'utf8')).toBe('task\n')
    expect(git(env.repoPath, 'show', 'main:add.js')).toBe('task')
    expect(git(env.repoPath, 'log', '-1', '--format=%s', 'main')).toMatch(/^Merge joy\/.+: Fix add\(\)$/)
    // The worktree's change was committed on the task branch first.
    expect(git(worktree, 'status', '--porcelain')).toBe('')
    const details = await until(env.call, id, (d) => d.events.some((e) => e.type === 'task.merged'))
    expect(details.events.find((e) => e.type === 'task.merged')?.payload).toMatchObject({
      branch: 'main',
      commit: git(env.repoPath, 'rev-parse', 'main'),
    })

    const again = await merge(env.call, id)
    expect(again).toMatchObject({ status: 409, body: { reason: 'nothing_to_merge' } })
  })

  it('refuses when the main checkout has uncommitted changes and changes nothing', async () => {
    const env = await setup()
    const { id, worktree } = await finishedTask(env)
    writeFileSync(join(env.repoPath, 'other.js'), 'owner is editing\n')
    const before = git(env.repoPath, 'rev-parse', 'main')

    const refused = await merge(env.call, id)
    expect(refused).toMatchObject({ status: 409, body: { reason: 'dirty_checkout', branch: 'main' } })
    expect(refused.body.error).toMatch(/uncommitted changes/)
    expect(git(env.repoPath, 'rev-parse', 'main')).toBe(before)
    expect(readFileSync(join(env.repoPath, 'other.js'), 'utf8')).toBe('owner is editing\n')
    expect(git(worktree, 'status', '--porcelain')).toContain('add.js')
  })

  it('aborts a conflicting merge and lists the conflicting files', async () => {
    const env = await setup()
    const { id } = await finishedTask(env)
    writeFileSync(join(env.repoPath, 'add.js'), 'owner\n')
    git(env.repoPath, 'commit', '-q', '-am', 'owner change')
    const before = git(env.repoPath, 'rev-parse', 'main')

    const refused = await merge(env.call, id)
    expect(refused).toMatchObject({ status: 409, body: { reason: 'conflict', conflicts: ['add.js'] } })
    expect(git(env.repoPath, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(env.repoPath, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(env.repoPath, 'add.js'), 'utf8')).toBe('owner\n')
  })

  it('refuses a default branch that is not checked out and has moved on', async () => {
    const env = await setup()
    const { id } = await finishedTask(env)
    writeFileSync(join(env.repoPath, 'other.js'), 'owner\n')
    git(env.repoPath, 'commit', '-q', '-am', 'owner change')
    git(env.repoPath, 'checkout', '-q', '-b', 'feature')
    const before = git(env.repoPath, 'rev-parse', 'main')

    expect(await merge(env.call, id)).toMatchObject({ status: 409, body: { reason: 'not_fast_forward' } })
    expect(git(env.repoPath, 'rev-parse', 'main')).toBe(before)
  })

  it('refuses a running task', async () => {
    const env = await setup()
    let open = () => {}
    env.claude.state.hold = new Promise<void>((resolve) => (open = resolve))
    const { body } = await env.call('POST', '/api/tasks', {
      repoId: env.repoId,
      title: 'Fix add()',
      prompt: 'Fix add()',
      mode: 'single',
    })
    const id = (body.task as { id: string }).id
    await until(env.call, id, (d) => d.task.status === 'running')
    const refused = await merge(env.call, id)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/Only finished tasks/)
    open()
    await until(env.call, id, (d) => d.task.status === 'done')
  })
})

describe('opening a task in the editor', () => {
  it('runs the configured command with the worktree path last', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const env = await setup({
      config: 'editor:\n  command: my-editor\n  args: [--new-window]\n',
      editorRunner: async (command, args) => {
        calls.push({ command, args })
      },
    })
    const { id, worktree } = await finishedTask(env)
    expect(await env.call('POST', `/api/tasks/${id}/open-editor`, {})).toMatchObject({ status: 200 })
    expect(calls).toEqual([{ command: 'my-editor', args: ['--new-window', realpathSync.native(worktree)] }])
  })

  it('defaults to code and reports a missing command', async () => {
    const calls: string[] = []
    const env = await setup({
      editorRunner: async (command) => {
        calls.push(command)
        throw new EditorNotFoundError(command)
      },
    })
    const { id } = await finishedTask(env)
    const failed = await env.call('POST', `/api/tasks/${id}/open-editor`, {})
    expect(failed).toMatchObject({ status: 422, body: { reason: 'editor_not_found', command: 'code' } })
    expect(calls).toEqual(['code'])
  })

  it('answers 404 for an unknown task, a task without a worktree and a removed worktree', async () => {
    const calls: string[] = []
    const runner: EditorRunner = async (command) => {
      calls.push(command)
    }
    const env = await setup({ editorRunner: runner })
    expect((await env.call('POST', '/api/tasks/nope/open-editor', {})).status).toBe(404)
    const { id } = await finishedTask(env)
    expect(
      (await env.call('POST', `/api/tasks/${id}/discard`, { confirmUnpushedCommits: true })).status,
    ).toBe(200)
    expect((await env.call('POST', `/api/tasks/${id}/open-editor`, {})).status).toBe(404)

    const fake = await setup({ fakeExecutor: true, editorRunner: runner })
    const other = await finishedTask(fake)
    // Its recorded path is outside Joy's worktrees folder (and does not exist).
    expect((await fake.call('POST', `/api/tasks/${other.id}/open-editor`, {})).status).toBe(404)
    expect(calls).toEqual([])
  })
})
