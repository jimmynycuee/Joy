// Plugins: the owner's MCP servers (Settings), which runs get them and how the policy treats their tools; skills for
// the `/` menu and how an invocation reaches each CLI; project files for the `@` menu.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const TOKEN = 'test-api-token-for-plugins'
const ORIGIN = 'http://127.0.0.1:5173'
const WORKTREE = '/fake/joy-plugins-worktree'
const SECRET = 'mcp-secret-value-123456'
const servers: Array<{ close(): Promise<void> }> = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
function write(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

type Hook = (options: RunOptions) => Promise<void>

function fakeProvider(kind: ProviderKind) {
  const calls: RunOptions[] = []
  const hooks: { implement?: Hook } = {}
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
      if (options.outputSchema) {
        yield {
          type: 'done',
          sessionId: 'p',
          isError: false,
          structured: { approve: false, summary: 'no', findings: [] },
        }
        return
      }
      const sessionId = options.resumeSessionId ?? `${kind}-session`
      if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
      if (options.autonomy === 'workspace-write') await hooks.implement?.(options)
      yield { type: 'done', sessionId, isError: false, finalMessage: 'done' }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, calls, hooks }
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

async function setup() {
  const home = temp('joy-plugins-home-')
  const userHome = temp('joy-plugins-user-')
  writeFileSync(join(home, 'config.yaml'), 'approvals:\n  on_timeout: deny\n')
  const db = openDatabase(':memory:')
  databases.push(db)
  const redactor = new Redactor()
  const backend = new MemoryBackend()
  const claude = fakeProvider('claude-cli')
  const codex = fakeProvider('codex-cli')
  const server = await createJoyServer({
    home,
    userHome,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend, env: {}, onSecret: (s) => redactor.add(s) }),
    redactor,
    executor: new FakeExecutor(),
    dependencyInstall: false,
    apiToken: TOKEN,
    approvalTimeoutMs: 10_000,
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
  const addRepo = async (path: string, extra: object = {}) =>
    (
      (await call('POST', '/api/repos', { path, defaultBranch: 'main', ...extra })).body.repo as {
        id: string
      }
    ).id
  const newTask = async (repoId: string, extra: object = {}) => {
    const { status, body } = await call('POST', '/api/tasks', {
      repoId,
      title: 'Do it',
      prompt: 'Do the thing',
      mode: 'single',
      roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku' } },
      ...extra,
    })
    expect(status).toBe(201)
    return (body.task as { id: string }).id
  }
  return { call, claude, codex, addRepo, newTask, db, home, userHome, backend, redactor }
}

type Call = Awaited<ReturnType<typeof setup>>['call']
type Details = { task: { status: string } }
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
type Approval = { id: string; taskId: string; status: string }
async function nextApproval(call: Call): Promise<Approval> {
  const list = await until(
    async () => (await call('GET', '/api/approvals?status=pending')).body.approvals as Approval[],
    (approvals) => approvals.length > 0,
    'an approval',
  )
  return list[0] as Approval
}
async function ask(options: RunOptions, tool: string): Promise<string> {
  const mcp = options.mcpServers?.find((server) => server.name === 'joy')
  if (!mcp || mcp.transport !== 'stdio') throw new Error('The implementer did not get the Tool Hub')
  const response = await fetch(mcp.env?.JOY_TOOL_HUB_ENDPOINT as string, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcp.env?.JOY_TOOL_HUB_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'approve', arguments: { tool_name: tool, input: {}, tool_use_id: 'x' } }),
  })
  return ((await response.json()) as { value: { behavior: string } }).value.behavior
}

describe('MCP servers in Settings', () => {
  it('adds, lists, changes and deletes a server; a secret lives only in the keychain', async () => {
    const { call, db, home, backend, addRepo } = await setup()
    const repo = await addRepo('/tmp/plugins-a')
    expect((await call('GET', '/api/mcp-servers')).body.servers).toEqual([])
    const created = await call('POST', '/api/mcp-servers', {
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'files-mcp'],
      vars: [
        { name: 'LOG_LEVEL', value: 'info' },
        { name: 'API_TOKEN', value: SECRET, secret: true },
      ],
    })
    expect(created.status).toBe(201)
    const server = created.body.server as { id: string }
    expect(created.body.server).toMatchObject({
      name: 'files',
      command: 'npx',
      args: ['-y', 'files-mcp'],
      vars: [
        { name: 'LOG_LEVEL', value: 'info', secret: false },
        { name: 'API_TOKEN', secret: true },
      ],
      enabled: true,
      readOnly: false,
    })
    expect(JSON.stringify((await call('GET', '/api/mcp-servers')).body)).not.toContain(SECRET)
    expect(backend.values.get(`mcp:${server.id}:API_TOKEN`)).toBe(SECRET)
    const rows = JSON.stringify(db.prepare('SELECT * FROM mcp_servers').all())
    expect(rows).not.toContain(SECRET)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain(SECRET)

    const patched = await call('PATCH', `/api/mcp-servers/${server.id}`, {
      enabled: false,
      readOnly: true,
      repoIds: [repo],
    })
    expect(patched.body.server).toMatchObject({ enabled: false, readOnly: true, repoIds: [repo] })
    expect((await call('PATCH', `/api/mcp-servers/${server.id}`, { repoIds: ['nope'] })).status).toBe(422)
    expect(
      (await call('PATCH', `/api/mcp-servers/${server.id}`, { repoIds: null })).body.server,
    ).not.toHaveProperty('repoIds')

    expect((await call('DELETE', `/api/mcp-servers/${server.id}`)).status).toBe(200)
    expect(backend.values.has(`mcp:${server.id}:API_TOKEN`)).toBe(false)
    expect((await call('DELETE', `/api/mcp-servers/${server.id}`)).status).toBe(404)
    expect((await call('PATCH', `/api/mcp-servers/${server.id}`, { enabled: true })).status).toBe(404)
  })

  it('refuses names Joy uses, duplicates, bad shapes and an empty secret, and keeps no secret behind', async () => {
    const { call, backend } = await setup()
    const post = (body: object) => call('POST', '/api/mcp-servers', body)
    expect((await post({ name: 'joy', transport: 'stdio', command: 'x' })).status).toBe(422)
    expect((await post({ name: 'web', transport: 'http', url: 'https://u:p@x.test' })).status).toBe(422)
    expect((await post({ name: 'web', transport: 'stdio' })).status).toBe(422)
    expect(
      (
        await post({
          name: 'web',
          transport: 'stdio',
          command: 'x',
          vars: [{ name: 'T', value: ' ', secret: true }],
        })
      ).status,
    ).toBe(422)
    expect((await post({ name: 'web', transport: 'stdio', command: 'x', extra: 1 })).status).toBe(400)
    expect((await post({ name: 'web', transport: 'stdio', command: 'x', repoIds: ['missing'] })).status).toBe(
      422,
    )
    expect((await post({ name: 'web', transport: 'stdio', command: 'x' })).status).toBe(201)
    const duplicate = await post({
      name: 'web',
      transport: 'stdio',
      command: 'x',
      vars: [{ name: 'T', value: SECRET, secret: true }],
    })
    expect(duplicate.status).toBe(422)
    expect(duplicate.body.error).toMatch(/already exists/)
    expect([...backend.values.values()]).not.toContain(SECRET)
  })

  it('hands enabled servers of the project to the implementer only, with secrets, asking for every call', async () => {
    const { call, claude, codex, addRepo, newTask, redactor } = await setup()
    const repo = await addRepo('/tmp/plugins-b')
    const other = await addRepo('/tmp/plugins-other')
    const container = await addRepo('/tmp/plugins-container', { container: true })
    await call('POST', '/api/mcp-servers', {
      name: 'files',
      transport: 'stdio',
      command: 'files-mcp',
      vars: [{ name: 'API_TOKEN', value: SECRET, secret: true }],
    })
    await call('POST', '/api/mcp-servers', {
      name: 'web',
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
      vars: [{ name: 'X-Team', value: 'joy' }],
      repoIds: [repo],
    })
    await call('POST', '/api/mcp-servers', { name: 'off', transport: 'stdio', command: 'x', enabled: false })
    await call('POST', '/api/mcp-servers', {
      name: 'elsewhere',
      transport: 'stdio',
      command: 'x',
      repoIds: [other],
    })

    const task = await newTask(repo, {
      mode: 'review_loop',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna' },
      },
    })
    await until(() => details(call, task), settled, 'the task')
    const implement = claude.calls.find((c) => c.autonomy === 'workspace-write')
    expect(implement?.mcpServers?.map((s) => s.name)).toEqual(['joy', 'files', 'web'])
    expect(implement?.mcpServers?.[1]).toEqual({
      name: 'files',
      transport: 'stdio',
      command: 'files-mcp',
      args: [],
      env: { API_TOKEN: SECRET },
      approval: 'every-call',
    })
    expect(implement?.mcpServers?.[2]).toEqual({
      name: 'web',
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Team': 'joy' },
      approval: 'every-call',
    })
    expect(implement?.mcpServers?.[0]).not.toHaveProperty('approval')
    // The reviewer cannot ask anyone: no MCP servers at all.
    const review = codex.calls.find((c) => c.outputSchema === REVIEW_SCHEMA)
    expect(review).toBeDefined()
    expect(review?.mcpServers ?? []).toEqual([])
    // The secret read for the run is scrubbed from anything Joy logs or shows.
    expect(redactor.redact(`token ${SECRET}`)).not.toContain(SECRET)

    // A container project gets none of them (they cannot run inside the agent's container).
    claude.calls.length = 0
    const boxed = await newTask(container)
    await until(() => details(call, boxed), settled, 'the container task')
    const boxedRun = claude.calls.find((c) => c.autonomy === 'workspace-write')
    expect(boxedRun?.mcpServers?.map((s) => s.name)).toEqual(['joy'])
  })

  it('asks for every tool of an owner server; a read-only one runs on its own in auto only', async () => {
    const { call, claude, addRepo, newTask } = await setup()
    const repo = await addRepo('/tmp/plugins-c')
    await call('POST', '/api/mcp-servers', { name: 'docs', transport: 'stdio', command: 'x', readOnly: true })
    await call('POST', '/api/mcp-servers', { name: 'files', transport: 'stdio', command: 'x' })
    const answers: string[] = []
    claude.hooks.implement = async (options) => {
      answers.push(await ask(options, 'mcp__docs__search'))
      const pending = ask(options, 'mcp__files__write')
      const approval = await nextApproval(call)
      await call('POST', `/api/approvals/${approval.id}/deny`, {})
      answers.push(await pending)
    }
    const auto = await newTask(repo, { permissionMode: 'auto' })
    await until(() => details(call, auto), settled, 'the auto task')
    expect(answers).toEqual(['allow', 'deny'])

    // `ask` (and `full`) still ask for the read-only server.
    for (const permissionMode of ['ask', 'full']) {
      answers.length = 0
      claude.hooks.implement = async (options) => {
        const pending = ask(options, 'mcp__docs__search')
        const approval = await nextApproval(call)
        await call('POST', `/api/approvals/${approval.id}/approve`, {})
        answers.push(await pending)
      }
      const id = await newTask(repo, { permissionMode })
      await until(() => details(call, id), settled, `the ${permissionMode} task`)
      expect(answers).toEqual(['allow'])
    }

    // Once the mark is removed, auto asks too.
    const docs = (
      (await call('GET', '/api/mcp-servers')).body.servers as Array<{ id: string; name: string }>
    ).find((s) => s.name === 'docs')
    await call('PATCH', `/api/mcp-servers/${docs?.id}`, { readOnly: false })
    answers.length = 0
    claude.hooks.implement = async (options) => {
      const pending = ask(options, 'mcp__docs__search')
      const approval = await nextApproval(call)
      await call('POST', `/api/approvals/${approval.id}/deny`, {})
      answers.push(await pending)
    }
    const after = await newTask(repo, { permissionMode: 'auto' })
    await until(() => details(call, after), settled, 'the task after the change')
    expect(answers).toEqual(['deny'])
  })

  it('shows nothing when there are no servers and old data has none', async () => {
    const { call, claude, addRepo, newTask } = await setup()
    const repo = await addRepo('/tmp/plugins-d')
    expect((await call('GET', '/api/mcp-servers')).body).toEqual({ servers: [] })
    const task = await newTask(repo)
    await until(() => details(call, task), settled, 'the task')
    expect(
      claude.calls.find((c) => c.autonomy === 'workspace-write')?.mcpServers?.map((s) => s.name),
    ).toEqual(['joy'])
  })
})

describe('skills', () => {
  const skill = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`

  it('lists each CLI’s user and project skills, frontmatter only; empty when there are none', async () => {
    const { call, userHome, addRepo } = await setup()
    const project = temp('joy-plugins-project-')
    const repo = await addRepo(project)
    expect((await call('GET', '/api/skills')).body).toEqual({ skills: [] })
    write(join(userHome, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'Review the diff'))
    write(join(userHome, '.agents', 'skills', 'deploy', 'SKILL.md'), skill('deploy', 'Ship it'))
    write(join(project, '.claude', 'commands', 'lint.md'), '---\ndescription: Lint\n---\n')
    expect((await call('GET', '/api/skills')).body.skills).toEqual([
      { name: 'review', description: 'Review the diff', cli: 'claude-cli', scope: 'user', kind: 'skill' },
      { name: 'deploy', description: 'Ship it', cli: 'codex-cli', scope: 'user', kind: 'skill' },
    ])
    expect(
      (
        (await call('GET', `/api/skills?repoId=${repo}`)).body.skills as Array<{
          name: string
          scope: string
        }>
      ).map((s) => `${s.name}:${s.scope}`),
    ).toEqual(['review:user', 'lint:project', 'deploy:user'])
    expect((await call('GET', '/api/skills?repoId=missing')).status).toBe(404)
  })

  it('turns a leading /skill into what each CLI understands, in the task prompt and in a follow-up', async () => {
    const { call, claude, codex, userHome, addRepo, newTask } = await setup()
    write(join(userHome, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'r'))
    const codexSkill = join(userHome, '.agents', 'skills', 'review', 'SKILL.md')
    write(codexSkill, skill('review', 'r'))
    const repo = await addRepo('/tmp/plugins-e')
    const task = await newTask(repo, {
      prompt: '/review check the auth flow',
      mode: 'review_loop',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna' },
      },
    })
    await until(() => details(call, task), settled, 'the task')
    const implement = claude.calls.find((c) => c.autonomy === 'workspace-write')?.prompt ?? ''
    expect(implement).toContain(
      'The owner invoked the "review" skill for this message: load it with the Skill tool',
    )
    expect(implement).toContain('check the auth flow')
    expect(implement).not.toContain('joy-skill')
    const review = codex.calls.find((c) => c.outputSchema === REVIEW_SCHEMA)?.prompt ?? ''
    expect(review).toContain(
      `The owner invoked the $review skill for this message: follow its instructions in ${codexSkill}.`,
    )
    expect(review).not.toContain('joy-skill')
    // The thread shows what the owner typed.
    const created = (await call('GET', `/api/tasks/${task}`)).body.task as { prompt: string }
    expect(created.prompt).toBe('/review check the auth flow')

    // A name no CLI has, and a path, stay as typed.
    claude.calls.length = 0
    await call('POST', `/api/tasks/${task}/messages`, { text: '/nothing here' })
    await until(
      () => details(call, task),
      (d) => settled(d) && claude.calls.length > 0,
      'the follow-up',
    )
    const followUp = claude.calls.find((c) => c.resumeSessionId)?.prompt ?? ''
    expect(followUp).toContain('/nothing here')
    expect(followUp).not.toContain('joy-skill')
  })

  it('leaves an imported issue alone even if it starts with /name', async () => {
    const { call, claude, userHome, addRepo, newTask } = await setup()
    write(join(userHome, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'r'))
    const repo = await addRepo('/tmp/plugins-f')
    const id = await newTask(repo, { prompt: '/review please', provenance: 'external_content' })
    await until(() => details(call, id), settled, 'the task')
    const prompt = claude.calls.find((c) => c.autonomy === 'workspace-write')?.prompt ?? ''
    expect(prompt).toContain('/review please')
    expect(prompt).not.toContain('Skill tool')
  })
})

describe('project files for @', () => {
  it('lists the project’s files git knows about, fuzzy-matched, without ignored ones', async () => {
    const { call, addRepo, newTask } = await setup()
    const project = temp('joy-plugins-files-')
    execFileSync('git', ['init', '-q'], { cwd: project })
    write(join(project, '.gitignore'), 'dist/\n')
    write(join(project, 'src', 'auth', 'login.ts'), 'x')
    write(join(project, 'src', 'logout.ts'), 'x')
    write(join(project, 'README.md'), 'x')
    write(join(project, 'dist', 'login.js'), 'x')
    const repo = await addRepo(project)
    const files = async (query: string, by = `repoId=${repo}`) =>
      (await call('GET', `/api/files?${by}&q=${encodeURIComponent(query)}`)).body.files as string[]
    expect((await files('')).sort()).toEqual([
      '.gitignore',
      'README.md',
      'src/auth/login.ts',
      'src/logout.ts',
    ])
    expect(await files('login')).toEqual(['src/auth/login.ts'])
    expect(await files('lgn')).toEqual(['src/auth/login.ts'])
    expect(await files('nothing-matches')).toEqual([])
    // A task whose copy is gone falls back to the project's checkout.
    const task = await newTask(repo)
    await until(() => details(call, task), settled, 'the task')
    expect(await files('logout', `taskId=${task}`)).toEqual(['src/logout.ts'])
    expect((await call('GET', '/api/files?q=x')).status).toBe(400)
    expect((await call('GET', '/api/files?repoId=missing')).status).toBe(404)
  })
})
