// Owner attachments end to end: upload checks, linking to tasks and messages, what agents get, and what never leaks.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentProvider,
  ImageInput,
  ProviderKind,
  RunOptions,
  TaskId,
  Workspace,
} from '@joy/core'
import { ConfigStore } from '@joy/config'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { WorktreeExecutor } from '@joy/executor'
import { REVIEW_SCHEMA } from '@joy/orchestrator'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { createJoyServer } from './server.js'
import type { JoyServer, JoyServerOptions } from './server.js'

const TOKEN = 'test-api-token-for-attachment-tests-7'
const ORIGIN = 'http://127.0.0.1:5173'
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const SECRET_TEXT = 'const answer = 42 // only in the file'

type Gate = { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open = () => {}
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

/** Records every run; reviews approve. With `state.steer`, runs offer a steer that records text and images. */
function fakeProvider(kind: ProviderKind) {
  const calls: RunOptions[] = []
  const steered: Array<{ text: string; images: readonly ImageInput[] }> = []
  const state: { work?: (options: RunOptions) => Promise<void> | void; steer?: boolean } = {}
  const provider: AgentProvider = {
    kind,
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
      calls.push(options)
      if (options.outputSchema === REVIEW_SCHEMA) {
        yield {
          type: 'done',
          sessionId: 'review',
          isError: false,
          structured: { approve: true, summary: 'ok', findings: [] },
        }
        return
      }
      const sessionId = options.resumeSessionId ?? `${kind}-session`
      if (!options.resumeSessionId) yield { type: 'session_started', sessionId }
      if (state.steer)
        options.onSteer?.(async (text, images) => {
          steered.push({ text, images: images ?? [] })
          return true
        })
      try {
        await state.work?.(options)
      } finally {
        if (state.steer) options.onSteer?.(undefined)
      }
      yield { type: 'done', sessionId, isError: false, finalMessage: 'done' }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, calls, steered, state }
}

class FakeExecutor {
  async prepare(repo: Workspace['repo'], taskId: TaskId, attemptId: Workspace['attemptId']) {
    return { repo, taskId, attemptId, path: '/fake/worktree', branch: 'joy/t/a', baseCommit: 'base' }
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

async function setup(options: { executor?: JoyServerOptions['executor'] } = {}) {
  const home = tempDir('joy-attach-')
  writeFileSync(join(home, 'config.yaml'), 'approvals:\n  on_timeout: deny\n')
  const db = openDatabase(':memory:')
  databases.push(db)
  const redactor = new Redactor()
  const claude = fakeProvider('claude-cli')
  const codex = fakeProvider('codex-cli')
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    executor: options.executor ?? new FakeExecutor(),
    apiToken: TOKEN,
    approvalTimeoutMs: 2_000,
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
  const upload = async (bytes: Buffer, name?: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/api/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: ORIGIN,
        'content-type': 'application/octet-stream',
        ...(name !== undefined ? { 'x-joy-filename': encodeURIComponent(name) } : {}),
        ...headers,
      },
      body: bytes,
    })
    const body = (await response.json()) as {
      attachment?: { id: string; name: string; mediaType: string; size: number }
      error?: string
    }
    return { status: response.status, body }
  }
  const uploaded = async (bytes: Buffer, name?: string) => {
    const result = await upload(bytes, name)
    expect(result.status).toBe(201)
    return result.body.attachment as { id: string; name: string; mediaType: string; size: number }
  }
  return { origin, home, call, upload, uploaded, claude, codex, db }
}

type Call = Awaited<ReturnType<typeof setup>>['call']
type Details = {
  task: { status: string }
  attempts: Array<{ worktreePath?: string }>
  events: Array<{ type: string; payload: Record<string, unknown> }>
  attachments: Array<{ id: string; name: string; mediaType: string; size: number; messageId?: string }>
}

async function details(call: Call, id: string): Promise<Details> {
  return (await call('GET', `/api/tasks/${id}`)).body as unknown as Details
}

async function until(call: Call, id: string, check: (d: Details) => boolean, what: string): Promise<Details> {
  const deadline = Date.now() + 10_000
  let last: Details | undefined
  while (Date.now() < deadline) {
    last = await details(call, id)
    if (check(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${what} (status ${last?.task.status})`)
}

const settled = (status: string) => (d: Details) => d.task.status === status

async function newRepo(call: Call, path = '/tmp/attach-repo') {
  const { body } = await call('POST', '/api/repos', { path, defaultBranch: 'main' })
  return (body.repo as { id: string }).id
}

async function newTask(call: Call, repoId: string, extra: object = {}) {
  const { status, body } = await call('POST', '/api/tasks', {
    repoId,
    title: 'Look at this',
    prompt: 'Fix the layout in the screenshot',
    mode: 'single',
    ...extra,
  })
  expect(status, JSON.stringify(body)).toBe(201)
  return (body.task as { id: string }).id
}

describe('POST /api/attachments', () => {
  it('decides the type from the content and stores the bytes under JOY_HOME by id', async () => {
    const { upload, uploaded, home } = await setup()
    // The name says text, the bytes say PNG: the bytes win.
    const png = await uploaded(PNG, 'notes.txt')
    expect(png).toMatchObject({ name: 'notes.txt', mediaType: 'image/png', size: PNG.byteLength })
    expect((await uploaded(JPEG, 'a.jpg')).mediaType).toBe('image/jpeg')
    expect((await uploaded(GIF, 'a.gif')).mediaType).toBe('image/gif')
    expect((await uploaded(WEBP, 'a.webp')).mediaType).toBe('image/webp')
    expect((await uploaded(Buffer.from(SECRET_TEXT), 'main.ts')).mediaType).toBe('text/plain')
    const stored = join(home, 'attachments', png.id)
    expect(existsSync(stored)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(stored).mode & 0o777).toBe(0o600)
    // A Content-Type that claims an image does not make a binary file one.
    const binary = await upload(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]), 'x.png', {
      'content-type': 'image/png',
    })
    expect(binary.status).toBe(415)
  })

  it('refuses empty, oversized and binary files', async () => {
    const { upload } = await setup()
    expect((await upload(Buffer.alloc(0), 'empty.txt')).status).toBe(400)
    expect((await upload(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), 'big.png')).status).toBe(413)
    expect((await upload(Buffer.alloc(256 * 1024 + 1, 'a'), 'big.txt')).status).toBe(413)
    expect((await upload(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00]), 'tool')).status).toBe(415)
  })

  it('keeps only a clean last path segment of the name', async () => {
    const { uploaded } = await setup()
    expect((await uploaded(PNG, '../../etc/passwd')).name).toBe('passwd')
    expect((await uploaded(PNG, 'C:\\Users\\me\\shot\u0000\u202e.png')).name).toBe('shot.png')
    expect((await uploaded(PNG, '...')).name).toBe('image.png')
    expect((await uploaded(PNG)).name).toBe('image.png')
    expect((await uploaded(Buffer.from('x'), 'a<b>"c|d"?.md')).name).toBe('abcd.md')
  })

  it('needs the access token and the local origin', async () => {
    const { origin } = await setup()
    const noToken = await fetch(`${origin}/api/attachments`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/octet-stream' },
      body: PNG,
    })
    expect(noToken.status).toBe(401)
    const otherSite = await fetch(`${origin}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' },
      body: PNG,
    })
    expect(otherSite.status).toBe(403)
  })

  it('serves an attachment inertly, and an id can never reach other files', async () => {
    const { origin, uploaded, call } = await setup()
    const png = await uploaded(PNG, 'shot.png')
    const get = (path: string) => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const response = await get(`/api/attachments/${png.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
    for (const id of ['..%2Fconfig.yaml', '..%2F..%2Fetc%2Fpasswd', 'config.yaml', `${png.id}.part`])
      expect((await get(`/api/attachments/${id}`)).status).toBe(404)
    // The owner took it out of the box before sending: it is gone.
    expect((await call('DELETE', `/api/attachments/${png.id}`)).status).toBe(200)
    expect((await get(`/api/attachments/${png.id}`)).status).toBe(404)
  })
})

describe('attachments on tasks and messages', () => {
  it('hands images and text files of the first prompt to the agent, recording only names', async () => {
    const { call, uploaded, claude, home } = await setup()
    const png = await uploaded(PNG, 'shot.png')
    const text = await uploaded(Buffer.from(SECRET_TEXT), 'main.ts')
    const id = await newTask(call, await newRepo(call), { attachments: [png.id, text.id] })
    const done = await until(call, id, settled('done'), 'done')
    expect(done.attachments).toEqual([
      { id: png.id, name: 'shot.png', mediaType: 'image/png', size: PNG.byteLength },
      { id: text.id, name: 'main.ts', mediaType: 'text/plain', size: SECRET_TEXT.length },
    ])
    const run = claude.calls[0]
    expect(run?.images).toEqual([{ path: join(home, 'attachments', png.id), mediaType: 'image/png' }])
    expect(run?.prompt).toContain('Fix the layout in the screenshot')
    expect(run?.prompt).toContain('[Image attached by the owner: "shot.png"]')
    expect(run?.prompt).toContain(`File attached by the owner: "main.ts"\n\`\`\`\n${SECRET_TEXT}\n\`\`\``)
    expect(run?.prompt).not.toContain('joy-attachment')
    // The file's content never lands in the task's record.
    expect(JSON.stringify(done)).not.toContain(SECRET_TEXT)
  })

  it('refuses unknown, reused and too many attachments without creating a task', async () => {
    const { call, uploaded } = await setup()
    const repoId = await newRepo(call)
    const png = await uploaded(PNG, 'a.png')
    const unknown = '00000000-0000-4000-8000-000000000000'
    const base = { repoId, title: 't', prompt: 'p', mode: 'single' }
    expect((await call('POST', '/api/tasks', { ...base, attachments: [unknown] })).status).toBe(400)
    expect((await call('POST', '/api/tasks', { ...base, attachments: [png.id, png.id] })).status).toBe(400)
    expect((await call('POST', '/api/tasks', { ...base, attachments: Array(11).fill(png.id) })).status).toBe(
      400,
    )
    expect(((await call('GET', '/api/tasks')).body.tasks as unknown[]).length).toBe(0)
    await newTask(call, repoId, { attachments: [png.id] })
    expect((await call('POST', '/api/tasks', { ...base, attachments: [png.id] })).status).toBe(409)
    // Sent files cannot be removed any more.
    expect((await call('DELETE', `/api/attachments/${png.id}`)).status).toBe(409)
  })

  it('continues a finished task with a message that is only an image', async () => {
    const { call, uploaded, claude, home } = await setup()
    const id = await newTask(call, await newRepo(call))
    await until(call, id, settled('done'), 'done')
    expect((await call('POST', `/api/tasks/${id}/messages`, { text: '' })).status).toBe(400)
    const png = await uploaded(PNG, 'after.png')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: '', attachments: [png.id] })
    expect(sent.status).toBe(202)
    const done = await until(
      call,
      id,
      (d) => d.task.status === 'done' && claude.calls.length === 2,
      'follow-up',
    )
    const message = done.events.find((event) => event.type === 'user.message')
    expect(message?.payload).toMatchObject({
      text: '',
      attachments: [{ id: png.id, name: 'after.png', mediaType: 'image/png', size: PNG.byteLength }],
    })
    expect(done.attachments).toEqual([
      expect.objectContaining({ id: png.id, messageId: message?.payload.id }),
    ])
    const followUp = claude.calls[1]
    expect(followUp?.resumeSessionId).toBe('claude-cli-session')
    expect(followUp?.images).toEqual([{ path: join(home, 'attachments', png.id), mediaType: 'image/png' }])
    expect(followUp?.prompt).toContain('[Image attached by the owner: "after.png"]')
  })

  it('keeps the assistant chat to words only', async () => {
    const { call, uploaded } = await setup()
    const png = await uploaded(PNG, 'a.png')
    const conversation = (await call('POST', '/api/conversations', {})).body.conversation as { id: string }
    const path = `/api/conversations/${conversation.id}/messages`
    expect((await call('POST', path, { text: 'hi', attachments: [png.id] })).status).toBe(400)
    expect((await call('POST', path, { text: '' })).status).toBe(400)
  })

  it('steers a running agent with the image', async () => {
    const { call, uploaded, claude, home } = await setup()
    const wait = gate()
    claude.state.steer = true
    claude.state.work = () => wait.promise
    const id = await newTask(call, await newRepo(call))
    await until(call, id, (d) => d.task.status === 'running' && claude.calls.length === 1, 'running')
    // The run offers its steer once it started; wait until the server says a message would reach it.
    const deadline = Date.now() + 5_000
    while (!(await call('GET', `/api/tasks/${id}`)).body.steerable && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    const png = await uploaded(PNG, 'now.png')
    const sent = await call('POST', `/api/tasks/${id}/messages`, { text: 'this one', attachments: [png.id] })
    expect(sent.body.message).toMatchObject({ delivery: 'steer' })
    const deadline2 = Date.now() + 5_000
    while (!claude.steered.length && Date.now() < deadline2)
      await new Promise((resolve) => setTimeout(resolve, 10))
    wait.open()
    await until(call, id, settled('done'), 'done')
    expect(claude.steered[0]?.text).toContain('this one')
    expect(claude.steered[0]?.text).toContain('[Image attached by the owner: "now.png"]')
    expect(claude.steered[0]?.images).toEqual([
      { path: join(home, 'attachments', png.id), mediaType: 'image/png' },
    ])
  })

  it('shows the reviewer the images too', async () => {
    const { call, uploaded, codex, home } = await setup()
    const png = await uploaded(PNG, 'shot.png')
    const id = await newTask(call, await newRepo(call), {
      mode: 'review_loop',
      roleOverrides: {
        implementer: { provider: 'claude-cli', model: 'haiku' },
        reviewer: { provider: 'codex-cli', model: 'gpt-6-luna' },
      },
      attachments: [png.id],
    })
    await until(call, id, settled('done'), 'done')
    const review = codex.calls.find((options) => options.outputSchema === REVIEW_SCHEMA)
    expect(review?.images).toEqual([{ path: join(home, 'attachments', png.id), mediaType: 'image/png' }])
    expect(review?.prompt).toContain('[Image attached by the owner: "shot.png"]')
  })

  it("does not let a task use another task's files through a copied marker", async () => {
    const { call, uploaded, claude } = await setup()
    const repoId = await newRepo(call)
    const png = await uploaded(PNG, 'private.png')
    await until(call, await newTask(call, repoId, { attachments: [png.id] }), settled('done'), 'first')
    const other = await newTask(call, repoId, { prompt: `see [[joy-attachment:${png.id}]]` })
    await until(call, other, settled('done'), 'second')
    expect(claude.calls[1]?.images).toBeUndefined()
    expect(claude.calls[1]?.prompt).toContain('[attachment not available]')
    expect(claude.calls[1]?.prompt).not.toContain('private.png')
  })

  it('fails with an actionable error when a sent file is gone from disk', async () => {
    const { call, uploaded, home } = await setup()
    const png = await uploaded(PNG, 'gone.png')
    rmSync(join(home, 'attachments', png.id))
    const id = await newTask(call, await newRepo(call), { attachments: [png.id] })
    const failed = await until(call, id, settled('failed'), 'failed')
    expect(JSON.stringify(failed.events)).toContain('gone.png')
    expect(JSON.stringify(failed.events)).toContain('attach it again')
  })

  it('never puts attachments in the worktree, so a commit or pull request cannot include them', async () => {
    const root = tempDir('joy-attach-repo-')
    const repoPath = join(root, 'repo')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' }).toString()
    mkdirSync(repoPath)
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repoPath, 'add.js'), 'start\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
    const { call, uploaded, claude, home } = await setup({
      executor: new WorktreeExecutor({ worktreesDir: join(root, 'worktrees') }),
    })
    claude.state.work = (options) => writeFileSync(join(options.cwd, 'add.js'), 'fixed\n')
    const png = await uploaded(PNG, 'shot.png')
    const text = await uploaded(Buffer.from(SECRET_TEXT), 'notes.md')
    const id = await newTask(call, await newRepo(call, repoPath), { attachments: [png.id, text.id] })
    const done = await until(call, id, settled('done'), 'done')
    const worktree = done.attempts[0]?.worktreePath as string
    const image = claude.calls[0]?.images?.[0]?.path as string
    expect(image.startsWith(join(home, 'attachments'))).toBe(true)
    expect(image.startsWith(worktree)).toBe(false)
    const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree })
      .toString()
      .trim()
    expect(changed.split('\n').map((line) => line.slice(3))).toEqual(['add.js'])
    // Whatever Joy commits from this worktree, no history carries the files.
    execFileSync('git', ['add', '-A'], { cwd: worktree })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'work'], {
      cwd: worktree,
    })
    const history = execFileSync('git', ['log', '--all', '-p', '--name-only'], { cwd: worktree }).toString()
    expect(history).not.toContain(SECRET_TEXT)
    expect(history).not.toContain(png.id)
    expect(history).not.toContain('notes.md')
  })
})
