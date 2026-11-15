// What the redesigned sidebar needs from the server: the folder picker behind 加入專案, and pinning.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoId, TaskId } from '@joy/core'
import { ConfigStore } from '@joy/config'
import { createConversation, createRepo, createTask, openDatabase, updateTask } from '@joy/db'
import type { Database } from '@joy/db'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { afterEach, describe, expect, it } from 'vitest'
import { createJoyServer } from './server.js'

const TOKEN = 'test-api-token-for-sidebar-api'
const ORIGIN = 'http://127.0.0.1:5173'
const servers: Array<{ close(): Promise<void> }> = []
const databases: Database[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

type Pin = { pinnedAt?: string }
/** The parts of an answer these tests look at; each route only fills its own. */
interface Body {
  error?: string
  path?: string
  isGit?: boolean
  defaultBranch?: string
  folders?: unknown
  task: Pin
  tasks: Array<Pin & { id: string; updatedAt: string }>
  conversation: Pin
  conversations: Pin[]
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'joy-sidebar-api-')))
  dirs.push(root)
  const home = join(root, 'joy-data')
  const browseHome = join(root, 'home')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(browseHome, '.ssh'), { recursive: true })
  const db = openDatabase(':memory:')
  databases.push(db)
  const redactor = new Redactor()
  const server = await createJoyServer({
    home,
    database: db,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore: new SecretStore({ backend: new MemoryBackend(), onSecret: (s) => redactor.add(s) }),
    redactor,
    apiToken: TOKEN,
    cliVersionCheck: false,
    backups: false,
    memoryExtraction: false,
    conversationSummaries: false,
    folderBrowserHome: browseHome,
  })
  servers.push(server)
  const address = await server.listen()
  const origin = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        origin: ORIGIN,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: (await response.json()) as Body }
  }
  return { call, db, home, browseHome }
}

const folders = (path?: string) =>
  `/api/fs/folders${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`

describe('GET /api/fs/folders', () => {
  it('needs the access token like every other API route', async () => {
    const { call } = await setup()
    expect((await call('GET', folders(), undefined, null)).status).toBe(401)
    expect((await call('GET', folders(), undefined, 'wrong-token-wrong-token')).status).toBe(401)
  })

  it('starts at the home folder, lists folders only and leaves out the private ones', async () => {
    const { call, browseHome } = await setup()
    mkdirSync(join(browseHome, 'app', '.git'), { recursive: true })
    mkdirSync(join(browseHome, 'plain'))
    writeFileSync(join(browseHome, 'readme.md'), 'hello')

    const { status, body } = await call('GET', folders())
    expect(status).toBe(200)
    expect(body.path).toBe(browseHome)
    expect(body.folders).toEqual([
      { name: 'app', path: join(browseHome, 'app'), isGit: true },
      { name: 'plain', path: join(browseHome, 'plain'), isGit: false },
    ])
    expect(JSON.stringify(body)).not.toContain('readme.md')
    expect(JSON.stringify(body)).not.toContain('.ssh')
  })

  it('answers 403, 404 and 400 with a message, and never a stack or a file name', async () => {
    const { call, browseHome, home } = await setup()
    writeFileSync(join(browseHome, 'a-file'), 'x')
    expect((await call('GET', folders(join(browseHome, '.ssh')))).status).toBe(403)
    expect((await call('GET', folders(home))).status).toBe(403)
    expect((await call('GET', folders(`${browseHome}/x/../.ssh`))).status).toBe(403)
    const missing = await call('GET', folders(join(browseHome, 'nope')))
    expect(missing.status).toBe(404)
    expect(typeof missing.body.error).toBe('string')
    expect((await call('GET', folders(join(browseHome, 'a-file')))).status).toBe(400)
    expect((await call('GET', folders('not/absolute'))).status).toBe(400)
    expect((await call('GET', '/api/fs/folders?path=%00')).status).toBe(400)
  })
})

describe('POST /api/fs/git-init', () => {
  it('makes a repository only when asked to confirm, then the folder shows as one', async () => {
    const { call, browseHome } = await setup()
    const folder = join(browseHome, 'new-project')
    mkdirSync(folder)

    expect((await call('POST', '/api/fs/git-init', { path: folder })).status).toBe(400)
    expect((await call('POST', '/api/fs/git-init', { path: folder, confirm: false })).status).toBe(400)
    expect((await call('POST', '/api/fs/git-init', { path: folder, confirm: true }, null)).status).toBe(401)
    expect(existsSync(join(folder, '.git'))).toBe(false)

    const made = await call('POST', '/api/fs/git-init', { path: folder, confirm: true })
    expect(made.status).toBe(201)
    expect(made.body).toEqual({ path: folder, defaultBranch: 'main' })
    expect(
      execFileSync('git', ['rev-parse', '--verify', 'main^{commit}'], { cwd: folder, encoding: 'utf8' }),
    ).toMatch(/^[0-9a-f]{40}/)
    expect((await call('GET', folders(folder))).body.isGit).toBe(true)
    // Again: it is a repository now.
    expect((await call('POST', '/api/fs/git-init', { path: folder, confirm: true })).status).toBe(409)
  })

  it('refuses the home folder and the private places', async () => {
    const { call, browseHome } = await setup()
    expect((await call('POST', '/api/fs/git-init', { path: browseHome, confirm: true })).status).toBe(400)
    expect(
      (await call('POST', '/api/fs/git-init', { path: join(browseHome, '.ssh'), confirm: true })).status,
    ).toBe(403)
    expect(existsSync(join(browseHome, '.git'))).toBe(false)
    expect(existsSync(join(browseHome, '.ssh', '.git'))).toBe(false)
  })
})

function seed(db: Database) {
  createRepo(db, { id: 'r1' as RepoId, path: '/repo', defaultBranch: 'main' })
  for (const id of ['t1', 't2']) {
    createTask(db, {
      id: id as TaskId,
      repoId: 'r1' as RepoId,
      title: `Task ${id}`,
      prompt: 'p',
      mode: 'single',
      roleOverrides: {},
      planFirst: false,
      maxRounds: 4,
    })
  }
  createConversation(db, { id: 'c1', channel: 'web' })
}

describe('pinning', () => {
  it('pins and unpins a task, which then shows (or not) in the task list, without moving it', async () => {
    const { call, db } = await setup()
    seed(db)
    const before = (await call('GET', '/api/tasks')).body.tasks

    const pinned = await call('PATCH', '/api/tasks/t2', { pinned: true })
    expect(pinned.status).toBe(200)
    expect(pinned.body.task.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const after = (await call('GET', '/api/tasks')).body.tasks
    expect(after.map((task) => [task.id, task.updatedAt])).toEqual(
      before.map((task) => [task.id, task.updatedAt]),
    )
    expect(after.find((task) => task.id === 't2')?.pinnedAt).toBeDefined()
    expect(after.find((task) => task.id === 't1')?.pinnedAt).toBeUndefined()
    expect((await call('GET', '/api/tasks/t2')).body.task.pinnedAt).toBeDefined()

    const unpinned = await call('PATCH', '/api/tasks/t2', { pinned: false })
    expect(unpinned.status).toBe(200)
    expect(unpinned.body.task.pinnedAt).toBeUndefined()
  })

  it('archiving a pinned task unpins it, and an archived task cannot be pinned', async () => {
    const { call, db } = await setup()
    seed(db)
    await call('PATCH', '/api/tasks/t1', { pinned: true })
    updateTask(db, 't1' as TaskId, { archived: true })
    expect((await call('GET', '/api/tasks/t1')).body.task.pinnedAt).toBeUndefined()
    expect((await call('PATCH', '/api/tasks/t1', { pinned: true })).status).toBe(409)
    expect((await call('PATCH', '/api/tasks/t1', { archived: false, pinned: true })).status).toBe(409)
  })

  it('rejects a bad body and an unknown task', async () => {
    const { call, db } = await setup()
    seed(db)
    expect((await call('PATCH', '/api/tasks/t1', { pinned: 'yes' })).status).toBe(400)
    expect((await call('PATCH', '/api/tasks/t1', {})).status).toBe(400)
    expect((await call('PATCH', '/api/tasks/missing', { pinned: true })).status).toBe(404)
  })

  it('pins and unpins a conversation', async () => {
    const { call, db } = await setup()
    seed(db)
    const pinned = await call('PATCH', '/api/conversations/c1', { pinned: true })
    expect(pinned.status).toBe(200)
    expect(pinned.body.conversation.pinnedAt).toBeDefined()
    const listed = (await call('GET', '/api/conversations')).body.conversations
    expect(listed[0]?.pinnedAt).toBeDefined()
    expect(
      (await call('PATCH', '/api/conversations/c1', { pinned: false })).body.conversation.pinnedAt,
    ).toBeUndefined()

    expect((await call('PATCH', '/api/conversations/missing', { pinned: true })).status).toBe(404)
    expect((await call('PATCH', '/api/conversations/c1', { pinned: 1 })).status).toBe(400)
    expect((await call('PATCH', '/api/conversations/c1', { title: 'x' })).status).toBe(400)
    expect((await call('PATCH', '/api/conversations/c1', { pinned: true }, null)).status).toBe(401)
  })
})
