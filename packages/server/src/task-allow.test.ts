// "Allow for the rest of this task" on the approval card: which approvals may be remembered, that the same action is
// not asked again in that task (and only that task), and that revoking, finishing and restarting behave.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentProvider, ProviderKind, RunOptions, TaskId, Workspace } from '@joy/core'
import { ConfigStore } from '@joy/config'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { REVIEW_SCHEMA } from '@joy/orchestrator'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { createJoyServer } from './server.js'

const TOKEN = 'test-api-token-for-task-allows'
const ORIGIN = 'http://127.0.0.1:5173'
const WORKTREE = '/fake/joy-task-allow-worktree'
const servers: Array<{ close(): Promise<void> }> = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

type Hook = (options: RunOptions) => Promise<void>

function fakeClaude() {
  const hooks: { implement?: Hook } = {}
  const provider: AgentProvider = {
    kind: 'claude-cli' as ProviderKind,
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
      if (options.outputSchema === REVIEW_SCHEMA) {
        yield {
          type: 'done',
          sessionId: 'r',
          isError: false,
          structured: { approve: true, summary: 's', findings: [] },
        }
        return
      }
      if (options.outputSchema) {
        // The cross-model pre-review of a red action.
        yield {
          type: 'done',
          sessionId: 'p',
          isError: false,
          structured: { approve: false, summary: 'no', findings: [] },
        }
        return
      }
      const sessionId = options.resumeSessionId ?? 'claude-session'
      if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
      if (options.autonomy === 'workspace-write') await hooks.implement?.(options)
      yield { type: 'done', sessionId, isError: false, finalMessage: 'done' }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, hooks }
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
}

async function setup(shared?: { db: Database; home: string }) {
  const home = shared?.home ?? mkdtempSync(join(tmpdir(), 'joy-task-allows-'))
  if (!shared) {
    dirs.push(home)
    writeFileSync(join(home, 'config.yaml'), 'approvals:\n  on_timeout: deny\n')
  }
  const db = shared?.db ?? openDatabase(':memory:')
  if (!shared) databases.push(db)
  const redactor = new Redactor()
  const claude = fakeClaude()
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    executor: new FakeExecutor(),
    dependencyInstall: false,
    apiToken: TOKEN,
    approvalTimeoutMs: 10_000,
    cliVersionCheck: false,
    backups: false,
    memoryExtraction: false,
    conversationSummaries: false,
    providers: { 'claude-cli': claude.provider },
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
  const repoId = shared
    ? ''
    : (
        (await call('POST', '/api/repos', { path: '/tmp/task-allow-repo', defaultBranch: 'main' })).body
          .repo as {
          id: string
        }
      ).id
  const newTask = async (extra: object = {}) => {
    const { status, body } = await call('POST', '/api/tasks', {
      repoId,
      title: 'Clean up',
      prompt: 'Clean up the build output',
      mode: 'single',
      permissionMode: 'auto',
      ...extra,
    })
    expect(status).toBe(201)
    return (body.task as { id: string }).id
  }
  return { call, claude, newTask, db, home, server }
}

type Call = Awaited<ReturnType<typeof setup>>['call']
type Details = {
  task: { status: string }
  events: Array<{ type: string; payload: Record<string, unknown> }>
  taskAllows: Array<{ id: string; kind: string; target: string; approvalId: string }>
}
type Approval = { id: string; taskId: string; allowInTask?: boolean; status: string }

async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await read()
    if (check(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const details = async (call: Call, id: string) =>
  (await call('GET', `/api/tasks/${id}`)).body as unknown as Details
const settled = (d: Details) => ['done', 'review_ready', 'failed', 'cancelled'].includes(d.task.status)

/** The pending approval of a task, once Joy asks. */
async function nextApproval(call: Call, taskId?: string): Promise<Approval> {
  const list = await until(
    async () => (await call('GET', '/api/approvals?status=pending')).body.approvals as Approval[],
    (approvals) => approvals.some((a) => !taskId || a.taskId === taskId),
    'an approval',
  )
  return list.find((a) => !taskId || a.taskId === taskId) as Approval
}

/** Asks Joy's approve tool the way Claude Code's permission prompt does. */
async function ask(options: RunOptions, tool: string, input: unknown): Promise<string> {
  const mcp = options.mcpServers?.[0]
  if (!mcp || mcp.transport !== 'stdio') throw new Error('The implementer did not get the Tool Hub')
  const response = await fetch(mcp.env?.JOY_TOOL_HUB_ENDPOINT as string, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcp.env?.JOY_TOOL_HUB_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'approve', arguments: { tool_name: tool, input, tool_use_id: 'x' } }),
  })
  return ((await response.json()) as { value: { behavior: string } }).value.behavior
}
const bash = (options: RunOptions, command: string) => ask(options, 'Bash', { command })

describe('allow for the rest of this task', () => {
  it('does not ask again for the same action, still asks for a different one, lasts into a follow-up and ends when archived', async () => {
    const { call, claude, newTask } = await setup()
    const answers: string[] = []
    const asked: Approval[] = []
    let snapshot: Details | undefined
    let taskId = ''
    claude.hooks.implement = async (options) => {
      const first = bash(options, 'rm -rf ../shared-cache')
      const approval = await nextApproval(call)
      asked.push(approval)
      const approved = await call('POST', `/api/approvals/${approval.id}/approve`, { scope: 'task' })
      expect(approved.status).toBe(200)
      expect(approved.body.taskAllow).toMatchObject({ kind: 'shell', target: 'rm -rf ../shared-cache' })
      answers.push(await first)
      // Same command: runs without a new approval.
      answers.push(await bash(options, 'rm -rf ../shared-cache'))
      answers.push(await bash(options, '  rm -rf ../shared-cache\n'))
      // Different arguments: asks again.
      const other = bash(options, 'rm -rf ../other-cache')
      const second = await nextApproval(call)
      asked.push(second)
      await call('POST', `/api/approvals/${second.id}/deny`, {})
      answers.push(await other)
      snapshot = await details(call, taskId)
    }
    taskId = await newTask()
    const done = await until(() => details(call, taskId), settled, 'the task')
    expect(done.task.status).toBe('done')
    expect(answers).toEqual(['allow', 'allow', 'allow', 'deny'])
    expect(asked.map((a) => a.allowInTask)).toEqual([true, true])
    expect(asked[1]?.id).not.toBe(asked[0]?.id)
    expect((await call('GET', `/api/approvals?taskId=${taskId}`)).body.approvals).toHaveLength(2)

    // While the task ran, its info lists the allow.
    expect(snapshot?.taskAllows).toEqual([
      expect.objectContaining({ kind: 'shell', target: 'rm -rf ../shared-cache', approvalId: asked[0]?.id }),
    ])
    expect(snapshot?.taskAllows[0]).not.toHaveProperty('fingerprint')
    const byTask = done.events.filter((e) => e.type === 'policy.action' && e.payload.grant === 'task')
    expect(byTask).toHaveLength(2)
    expect(byTask[0]?.payload).toMatchObject({
      kind: 'run_outside_worktree',
      tier: 'auto',
      outcome: 'allow',
      allowId: snapshot?.taskAllows[0]?.id,
    })
    expect(done.events.some((e) => e.type === 'task_allow.created')).toBe(true)
    // Finished, the allow stays: a follow-up runs the same command without asking.
    expect(done.taskAllows).toHaveLength(1)
    const followUp: string[] = []
    claude.hooks.implement = async (options) => {
      followUp.push(await bash(options, 'rm -rf ../shared-cache'))
    }
    expect((await call('POST', `/api/tasks/${taskId}/messages`, { text: 'once more' })).status).toBe(202)
    const again = await until(
      () => details(call, taskId),
      (d) => settled(d) && followUp.length === 1,
      'the follow-up',
    )
    expect(followUp).toEqual(['allow'])
    expect((await call('GET', `/api/approvals?taskId=${taskId}`)).body.approvals).toHaveLength(2)
    expect(again.events.filter((e) => e.type === 'policy.action' && e.payload.grant === 'task')).toHaveLength(
      3,
    )
    // Archived: the allow is gone.
    expect((await call('PATCH', `/api/tasks/${taskId}`, { archived: true })).status).toBe(200)
    expect((await details(call, taskId)).taskAllows).toEqual([])
  })

  it('is not offered for secrets or for actions that reach other people, and the API refuses it', async () => {
    const { call, claude, newTask } = await setup()
    const offered: Array<boolean | undefined> = []
    const refused: number[] = []
    claude.hooks.implement = async (options) => {
      for (const command of ['cat ~/.ssh/id_rsa', 'git push origin HEAD', 'gh pr create --fill']) {
        const answer = bash(options, command)
        const approval = await nextApproval(call)
        offered.push(approval.allowInTask)
        refused.push((await call('POST', `/api/approvals/${approval.id}/approve`, { scope: 'task' })).status)
        await call('POST', `/api/approvals/${approval.id}/deny`, {})
        expect(await answer).toBe('deny')
      }
    }
    const taskId = await newTask({ permissionMode: 'ask' })
    const done = await until(() => details(call, taskId), settled, 'the task')
    expect(offered).toEqual([undefined, undefined, undefined])
    expect(refused).toEqual([422, 422, 422])
    expect(done.events.some((e) => e.type === 'task_allow.created')).toBe(false)
  })

  it('is not offered for a task from external content', async () => {
    const { call, claude, newTask } = await setup()
    let offered: boolean | undefined = true
    let status = 0
    claude.hooks.implement = async (options) => {
      const answer = bash(options, 'pnpm install')
      const approval = await nextApproval(call)
      offered = approval.allowInTask
      status = (await call('POST', `/api/approvals/${approval.id}/approve`, { scope: 'task' })).status
      await call('POST', `/api/approvals/${approval.id}/approve`, {})
      expect(await answer).toBe('allow')
      // Approved once, so the same command asks again.
      const again = bash(options, 'pnpm install')
      const next = await nextApproval(call)
      await call('POST', `/api/approvals/${next.id}/deny`, {})
      expect(await again).toBe('deny')
    }
    const taskId = await newTask({ provenance: 'external_content' })
    await until(() => details(call, taskId), settled, 'the task')
    expect(offered).toBeUndefined()
    expect(status).toBe(422)
  })

  it('asks again after the owner revokes the allow', async () => {
    const { call, claude, newTask } = await setup()
    const answers: string[] = []
    let taskId = ''
    claude.hooks.implement = async (options) => {
      const first = ask(options, 'Write', { file_path: '/fake/shared/notes.md', content: 'x' })
      await call('POST', `/api/approvals/${(await nextApproval(call)).id}/approve`, { scope: 'task' })
      answers.push(await first)
      answers.push(await ask(options, 'Write', { file_path: '/fake/shared/notes.md', content: 'y' }))
      const allows = (await details(call, taskId)).taskAllows
      expect(allows).toEqual([
        expect.objectContaining({ kind: 'file_write', target: '/fake/shared/notes.md' }),
      ])
      expect((await call('DELETE', `/api/tasks/${taskId}/allows/${allows[0]?.id}`)).status).toBe(200)
      expect((await call('DELETE', `/api/tasks/${taskId}/allows/${allows[0]?.id}`)).status).toBe(404)
      const again = ask(options, 'Write', { file_path: '/fake/shared/notes.md', content: 'z' })
      await call('POST', `/api/approvals/${(await nextApproval(call)).id}/deny`, {})
      answers.push(await again)
    }
    taskId = await newTask()
    const done = await until(() => details(call, taskId), settled, 'the task')
    expect(answers).toEqual(['allow', 'allow', 'deny'])
    expect(done.events.some((e) => e.type === 'task_allow.revoked')).toBe(true)
  })

  it('is not shared with another task, and survives a failed run and a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'joy-task-allows-restart-'))
    dirs.push(home)
    writeFileSync(join(home, 'config.yaml'), 'approvals:\n  on_timeout: deny\n')
    const db = openDatabase(join(home, 'joy.sqlite'))
    databases.push(db)
    const first = await setup({ db, home })
    const repoId = (
      (await first.call('POST', '/api/repos', { path: '/tmp/task-allow-restart', defaultBranch: 'main' }))
        .body.repo as { id: string }
    ).id
    const create = async (call: Call) => {
      const { body } = await call('POST', '/api/tasks', {
        repoId,
        title: 'Clean up',
        prompt: 'p',
        mode: 'single',
        permissionMode: 'auto',
      })
      return (body.task as { id: string }).id
    }
    // Task A: the owner allows the command for the task, then the run fails.
    first.claude.hooks.implement = async (options) => {
      const answer = bash(options, 'rm -rf ../shared-cache')
      await first.call('POST', `/api/approvals/${(await nextApproval(first.call)).id}/approve`, {
        scope: 'task',
      })
      expect(await answer).toBe('allow')
      throw new Error('the agent crashed')
    }
    const taskA = await create(first.call)
    const failed = await until(() => details(first.call, taskA), settled, 'task A')
    expect(failed.task.status).toBe('failed')
    expect(failed.taskAllows).toHaveLength(1)

    // Task B asks for the same command.
    let askedB = false
    first.claude.hooks.implement = async (options) => {
      const answer = bash(options, 'rm -rf ../shared-cache')
      const approval = await nextApproval(first.call)
      askedB = approval.taskId !== taskA
      await first.call('POST', `/api/approvals/${approval.id}/deny`, {})
      expect(await answer).toBe('deny')
    }
    const taskB = await create(first.call)
    await until(() => details(first.call, taskB), settled, 'task B')
    expect(askedB).toBe(true)

    // Restart: a new server on the same database and home.
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)
    const second = await setup({ db, home })
    const answers: string[] = []
    second.claude.hooks.implement = async (options) => {
      answers.push(await bash(options, 'rm -rf ../shared-cache'))
    }
    expect((await second.call('POST', `/api/tasks/${taskA}/resume`, {})).status).toBeLessThan(300)
    const resumed = await until(
      () => details(second.call, taskA),
      (d) => d.task.status === 'done',
      'task A resumed',
    )
    expect(answers).toEqual(['allow'])
    expect(
      resumed.events.filter((e) => e.type === 'policy.action' && e.payload.grant === 'task'),
    ).toHaveLength(1)
    expect((await second.call('GET', '/api/approvals?status=pending')).body.approvals).toEqual([])
  })
})
