import type { RepoId } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { NewMcpServer } from './mcp-servers.js'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  mcpServersForRepo,
  updateMcpServer,
} from './mcp-servers.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function open(): Database {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}

describe('managed MCP servers', () => {
  it('stores a stdio server with plain and secret variables, but never a secret value', () => {
    const db = open()
    const record = createMcpServer(db, {
      id: uuid(1),
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp'],
      vars: [{ name: 'LOG_LEVEL', value: 'info' }, { name: 'API_TOKEN' }],
    })
    expect(record).toMatchObject({
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp'],
      vars: [{ name: 'LOG_LEVEL', value: 'info' }, { name: 'API_TOKEN' }],
      enabled: true,
      readOnly: false,
    })
    expect(record.repoIds).toBeUndefined()
    const raw = db.prepare('SELECT vars FROM mcp_servers').get() as { vars: string }
    expect(JSON.parse(raw.vars)).toEqual([{ name: 'LOG_LEVEL', value: 'info' }, { name: 'API_TOKEN' }])
  })

  it('stores an http server and rejects shapes a CLI could not use', () => {
    const db = open()
    expect(
      createMcpServer(db, {
        id: uuid(1),
        name: 'web',
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
      }).url,
    ).toBe('https://mcp.example.test/mcp')
    const bad: Omit<NewMcpServer, 'id'>[] = [
      { name: 'joy', transport: 'stdio', command: 'x' },
      { name: 'joy_assistant', transport: 'stdio', command: 'x' },
      { name: 'JOY', transport: 'stdio', command: 'x' },
      { name: 'codex_apps', transport: 'stdio', command: 'x' },
      // `mcp__docs__write__x` would read as a tool of `docs`.
      { name: 'docs__write', transport: 'stdio', command: 'x' },
      { name: 'has space', transport: 'stdio', command: 'x' },
      { name: 'a', transport: 'stdio' },
      { name: 'a', transport: 'http', url: 'ftp://x' },
      { name: 'a', transport: 'http', url: 'https://user:pw@x.test' },
      { name: 'a', transport: 'http', url: 'https://x.test', command: 'node' },
      { name: 'a', transport: 'stdio', command: 'x', vars: [{ name: '1BAD' }] },
      { name: 'a', transport: 'stdio', command: 'x', vars: [{ name: 'A' }, { name: 'A' }] },
    ]
    for (const [index, input] of bad.entries())
      expect(() => createMcpServer(db, { id: uuid(10 + index), ...input })).toThrow()
    expect(() => createMcpServer(db, { id: uuid(2), name: 'web', transport: 'stdio', command: 'x' })).toThrow(
      /already exists/,
    )
    expect(() =>
      createMcpServer(db, { id: uuid(3), name: 'WEB', transport: 'stdio', command: 'x' }),
    ).toThrow()
  })

  it('keeps its CHECKs even when the module is bypassed', () => {
    const db = open()
    expect(() =>
      db
        .prepare(
          "INSERT INTO mcp_servers (id, name, transport, url, command) VALUES (?, 'x', 'http', 'u', 'c')",
        )
        .run(uuid(1)),
    ).toThrow()
    expect(() =>
      db
        .prepare(
          "INSERT INTO mcp_servers (id, name, transport, command, vars) VALUES (?, 'x', 'stdio', 'c', '{}')",
        )
        .run(uuid(2)),
    ).toThrow()
    expect(() =>
      db
        .prepare("INSERT INTO mcp_servers (id, name, transport, command) VALUES (?, 'a.b', 'stdio', 'c')")
        .run(uuid(3)),
    ).toThrow()
    expect(() =>
      db
        .prepare("INSERT INTO mcp_servers (id, name, transport, command) VALUES (?, 'a__b', 'stdio', 'c')")
        .run(uuid(4)),
    ).toThrow()
  })

  it('updates, filters by project and deletes', () => {
    const db = open()
    createMcpServer(db, { id: uuid(1), name: 'all', transport: 'stdio', command: 'a' })
    createMcpServer(db, {
      id: uuid(2),
      name: 'one',
      transport: 'stdio',
      command: 'b',
      repoIds: ['r1' as RepoId],
    })
    createMcpServer(db, { id: uuid(3), name: 'off', transport: 'stdio', command: 'c', enabled: false })
    expect(mcpServersForRepo(db, 'r1' as RepoId).map((s) => s.name)).toEqual(['all', 'one'])
    expect(mcpServersForRepo(db, 'r2' as RepoId).map((s) => s.name)).toEqual(['all'])
    updateMcpServer(db, uuid(2), { repoIds: null, readOnly: true })
    updateMcpServer(db, uuid(1), { enabled: false })
    expect(mcpServersForRepo(db, 'r2' as RepoId).map((s) => [s.name, s.readOnly])).toEqual([['one', true]])
    expect(deleteMcpServer(db, uuid(3))).toBe(true)
    expect(deleteMcpServer(db, uuid(3))).toBe(false)
    expect(getMcpServer(db, uuid(3))).toBeUndefined()
    expect(listMcpServers(db)).toHaveLength(2)
  })
})
