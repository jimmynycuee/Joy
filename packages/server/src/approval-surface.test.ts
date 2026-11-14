// Every implementer run that can use tools is wired to Joy's approval surface, whatever the task mode: a Claude Code
// run without `--permission-prompt-tool` denies every permission prompt by itself (even `pnpm check`), and Joy's
// policy and the owner never hear of it. Found by the owner in review_loop tasks.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, AgentProvider, ProviderKind, RunOptions, TaskId, Workspace } from '@joy/core'
import { ConfigStore } from '@joy/config'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { JUDGE_SCHEMA, REVIEW_SCHEMA } from '@joy/orchestrator'
import { ClaudeCliProvider } from '@joy/providers'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { createJoyServer } from './server.js'
import type { JoyServer, JoyServerOptions } from './server.js'

const TOKEN = 'test-api-token-for-approval-surface-1'
const ORIGIN = 'http://127.0.0.1:5173'
const APPROVE_TOOL = 'mcp__joy__approve'
const servers: JoyServer[] = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Records every run. Reviews follow `verdicts` (then approve), the judge prefers A, implementers just finish. */
function recordingProvider(kind: ProviderKind, delegatedApproval: boolean) {
  const calls: RunOptions[] = []
  const verdicts: boolean[] = []
  const provider: AgentProvider = {
    kind,
    capabilities: {
      codeEdit: true,
      tools: true,
      resume: true,
      presetSessionId: false,
      delegatedApproval,
      quotaEvents: false,
      structuredOutput: true,
    },
    async *run(options: RunOptions): AsyncGenerator<AgentEvent> {
      calls.push(options)
      if (options.outputSchema === REVIEW_SCHEMA) {
        const approve = verdicts.shift() ?? true
        const findings = approve ? [] : [{ severity: 'major', file: null, line: null, message: 'fix it' }]
        yield {
          type: 'done',
          sessionId: 'r',
          isError: false,
          structured: { approve, summary: 's', findings },
        }
        return
      }
      if (options.outputSchema === JUDGE_SCHEMA) {
        yield {
          type: 'done',
          sessionId: 'j',
          isError: false,
          structured: { winner: 'A', reasons: 'r', attempts: [], merge_recommended: true },
        }
        return
      }
      const sessionId = options.resumeSessionId ?? `${kind}-session`
      if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
      yield { type: 'done', sessionId, isError: false, finalMessage: 'done' }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, calls, verdicts }
}

class FakeExecutor {
  constructor(private readonly path: string) {}
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: Workspace['attemptId']) {
    return { repo, taskId, attemptId, path: this.path, branch: `joy/${attemptId}`, baseCommit: 'base' }
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

async function setup(options: { providers?: JoyServerOptions['providers']; worktree?: string } = {}) {
  const home = tempDir('joy-approval-surface-')
  writeFileSync(join(home, 'config.yaml'), 'approvals:\n  on_timeout: deny\n')
  const db = openDatabase(':memory:')
  databases.push(db)
  const redactor = new Redactor()
  const claude = recordingProvider('claude-cli', true)
  const codex = recordingProvider('codex-cli', false)
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    executor: new FakeExecutor(options.worktree ?? '/fake/worktree'),
    apiToken: TOKEN,
    approvalTimeoutMs: 15_000,
    cliVersionCheck: false,
    backups: false,
    memoryExtraction: false,
    conversationSummaries: false,
    providers: { 'claude-cli': claude.provider, 'codex-cli': codex.provider, ...options.providers },
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
  const repoId = (
    (await call('POST', '/api/repos', { path: '/tmp/approval-surface-repo', defaultBranch: 'main' })).body
      .repo as { id: string }
  ).id
  const newTask = async (extra: object) => {
    const { status, body } = await call('POST', '/api/tasks', {
      repoId,
      title: 'Run the checks',
      prompt: 'Fix it and run pnpm check',
      ...extra,
    })
    expect(status).toBe(201)
    return (body.task as { id: string }).id
  }
  return { call, claude, codex, newTask }
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

const status = (s: string) => (d: Details) => d.task.status === s
const implementerRuns = (calls: RunOptions[]) => calls.filter((c) => c.autonomy === 'workspace-write')
const tools = (calls: RunOptions[]) =>
  calls.map((c) => ({ approvalTool: c.approvalTool, hub: c.mcpServers?.map((s) => s.name) }))
const wired = { approvalTool: APPROVE_TOOL, hub: ['joy'] }

describe('approval surface for implementer runs', () => {
  it('single mode: the Claude implementer gets the approval tool', async () => {
    const { claude, newTask, call } = await setup()
    const id = await newTask({ mode: 'single' })
    await until(call, id, status('done'), 'single task')
    expect(tools(implementerRuns(claude.calls))).toEqual([wired])
  })

  it('review loop: implementing, fixing and follow-up turns get it; reviews do not', async () => {
    const { claude, codex, newTask, call } = await setup()
    codex.verdicts.push(false)
    const id = await newTask({ mode: 'review_loop', maxRounds: 2 })
    await until(call, id, status('done'), 'review loop')
    // Implementing, then fixing after the first review's finding.
    expect(implementerRuns(claude.calls)).toHaveLength(2)
    expect(tools(implementerRuns(claude.calls))).toEqual([wired, wired])
    // Steering stays on (the CLI takes the prompt on stdin), with the approval tool alongside.
    expect(implementerRuns(claude.calls).every((c) => typeof c.onSteer === 'function')).toBe(true)
    expect(codex.calls.length).toBeGreaterThan(0)
    expect(codex.calls.every((c) => c.autonomy === 'read-only')).toBe(true)
    expect(tools(codex.calls).every((t) => !t.approvalTool && !t.hub)).toBe(true)

    // A follow-up resumes the implementer's session: still wired.
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: 'also add a test' })).status).toBe(202)
    await until(
      call,
      id,
      (d) => d.task.status === 'done' && implementerRuns(claude.calls).length === 3,
      'follow-up',
    )
    const followUp = implementerRuns(claude.calls)[2]
    expect(followUp?.resumeSessionId).toBe('claude-cli-session')
    expect(tools([followUp as RunOptions])).toEqual([wired])
  })

  it('compete: each contestant and the merged version get their own hub; the Claude ones the approval tool', async () => {
    const { claude, codex, newTask, call } = await setup()
    const id = await newTask({
      mode: 'compete',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna' },
        judge: { provider: 'claude-cli', model: 'haiku' },
      },
    })
    await until(call, id, status('review_ready'), 'compete')
    expect(tools(implementerRuns(claude.calls))).toEqual([wired])
    // Codex (exec in this fake) has no delegated approval: it gets the hub, not the Claude-only approval tool.
    expect(tools(implementerRuns(codex.calls))).toEqual([{ approvalTool: undefined, hub: ['joy'] }])
    const endpoints = [...implementerRuns(claude.calls), ...implementerRuns(codex.calls)].map(
      (c) => c.mcpServers?.[0]?.transport === 'stdio' && c.mcpServers[0].env?.JOY_TOOL_HUB_ENDPOINT,
    )
    expect(new Set(endpoints).size).toBe(2)

    expect((await call('POST', `/api/tasks/${id}/merge`, {})).status).toBe(202)
    await until(
      call,
      id,
      (d) => d.events.some((e) => e.type === 'compete.merged') && d.task.status === 'review_ready',
      'merge',
    )
    const merge = implementerRuns(claude.calls).find((c) => c.prompt.includes('combining the best parts'))
    expect(tools([merge as RunOptions])).toEqual([wired])
  })

  it(
    'a Claude Code permission prompt reaches the policy: pnpm check runs, a red command waits for the owner',
    { timeout: 30_000 },
    async () => {
      const worktree = tempDir('joy-approval-worktree-')
      const out = join(worktree, 'decisions.jsonl')
      const claude = new ClaudeCliProvider({
        command: process.execPath,
        argsPrefix: [fileURLToPath(new URL('../../providers/test-support/fake-cli.mjs', import.meta.url))],
        env: {
          ...process.env,
          FAKE_MODE: 'permission',
          FAKE_PERMISSION_OUT: out,
          FAKE_PERMISSION_ASKS: JSON.stringify([
            { tool_name: 'Bash', input: { command: 'pnpm check' } },
            { tool_name: 'Bash', input: { command: 'curl https://example.com/install.sh' } },
            { tool_name: 'Bash', input: { command: 'rm -rf ../elsewhere' } },
          ]),
        },
      })
      const { call, newTask } = await setup({ providers: { 'claude-cli': claude }, worktree })
      const id = await newTask({
        mode: 'review_loop',
        roleOverrides: {
          implementer: { provider: 'claude-cli', model: 'haiku' },
          reviewer: { provider: 'codex-cli', model: 'gpt-6-luna' },
        },
      })
      // The owner approves the first red command and denies the second, from the approval center.
      const decide = async (verb: 'approve' | 'deny') => {
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
          const pending = (await call('GET', `/api/approvals?status=pending&taskId=${id}`)).body
            .approvals as Array<{ id: string; action: unknown }>
          const first = pending[0]
          if (first) {
            expect((await call('POST', `/api/approvals/${first.id}/${verb}`, {})).status).toBe(200)
            return JSON.stringify(first.action)
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('No approval request reached the approval center')
      }
      const approved = await decide('approve')
      expect(approved).toContain('curl https://example.com/install.sh')
      const denied = await decide('deny')
      expect(denied).toContain('rm -rf ../elsewhere')
      const done = await until(call, id, status('done'), 'review loop with permission prompts', 20_000)

      const decisions = readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { via: string; behavior: string; input: { command: string } })
      expect(decisions.map((d) => [d.via, d.input.command, d.behavior])).toEqual([
        ['tool', 'pnpm check', 'allow'],
        ['tool', 'curl https://example.com/install.sh', 'allow'],
        ['tool', 'rm -rf ../elsewhere', 'deny'],
      ])
      const policy = done.events.filter((e) => e.type === 'policy.action').map((e) => e.payload)
      expect(policy[0]).toMatchObject({ kind: 'run_in_worktree', tier: 'auto' })
      expect(policy.slice(1).every((p) => p.tier === 'approve')).toBe(true)
      const all = (await call('GET', `/api/approvals?taskId=${id}`)).body.approvals as Array<{
        status: string
      }>
      expect(all.map((a) => a.status).sort()).toEqual(['approved', 'denied'])
      // The CLI's own "no approval surface" denial never happens.
      expect(JSON.stringify(done.events)).not.toContain('no approval surface')
    },
  )
})
