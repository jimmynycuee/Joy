import type { RepoId } from '@joy/core'
import type { Database } from './database.js'

/**
 * Names Joy itself uses for MCP servers it hands to agents, and Codex's built-in connectors; an owner's server may not
 * take them, in any letter case.
 */
export const RESERVED_MCP_SERVER_NAMES = ['joy', 'joy_assistant', 'codex_apps'] as const
const NAME = /^[A-Za-z0-9_-]{1,64}$/
/** Environment variable or HTTP header name. */
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/

/**
 * An environment variable (stdio) or HTTP header (http). Without `value` it is a secret: its value is only in the OS
 * keychain, never in this table.
 */
export interface McpVar {
  name: string
  value?: string
}

export interface McpServerRecord {
  id: string
  name: string
  transport: 'stdio' | 'http'
  /** stdio only. */
  command?: string
  args: string[]
  /** http only. */
  url?: string
  vars: McpVar[]
  enabled: boolean
  /** The owner marked every tool of this server as read-only (auto permission mode may use them without asking). */
  readOnly: boolean
  /** Projects it applies to; absent means every project. */
  repoIds?: RepoId[]
  createdAt: string
}

export interface NewMcpServer {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  vars?: McpVar[]
  enabled?: boolean
  readOnly?: boolean
  repoIds?: RepoId[] | null
}

export interface McpServerUpdate {
  enabled?: boolean
  readOnly?: boolean
  repoIds?: RepoId[] | null
}

interface Row {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string | null
  args: string
  url: string | null
  vars: string
  enabled: number
  read_only: number
  repo_ids: string | null
  created_at: string
}

function toRecord(row: Row): McpServerRecord {
  const repoIds = row.repo_ids === null ? undefined : (JSON.parse(row.repo_ids) as RepoId[])
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    ...(row.command !== null ? { command: row.command } : {}),
    args: JSON.parse(row.args) as string[],
    ...(row.url !== null ? { url: row.url } : {}),
    vars: JSON.parse(row.vars) as McpVar[],
    enabled: row.enabled === 1,
    readOnly: row.read_only === 1,
    ...(repoIds ? { repoIds } : {}),
    createdAt: row.created_at,
  }
}

/** Throws an actionable error for a server Joy could not hand to a CLI. */
export function assertMcpServerShape(input: NewMcpServer): void {
  if (!NAME.test(input.name))
    throw new Error('MCP server names use letters, digits, "-" and "_" (at most 64)')
  // Tool names are `mcp__<server>__<tool>`: a server name with `__` would make another server's tools look like its own.
  if (input.name.includes('__')) throw new Error('MCP server names cannot contain "__"')
  if ((RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(input.name.toLowerCase()))
    throw new Error(`"${input.name}" is used by Joy itself; pick another MCP server name`)
  if (input.transport === 'stdio' && (!input.command || input.url !== undefined))
    throw new Error('A stdio MCP server needs a command and no URL')
  if (input.transport === 'http') {
    if (!input.url || input.command !== undefined || input.args?.length)
      throw new Error('An HTTP MCP server needs a URL and no command')
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      throw new Error(`"${input.url}" is not a URL`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('MCP URLs start with http(s)://')
    if (url.username || url.password)
      throw new Error('Put credentials in a secret header, not in the MCP server URL')
  }
  const names = new Set<string>()
  for (const v of input.vars ?? []) {
    if (!VAR_NAME.test(v.name)) throw new Error(`"${v.name}" is not a valid variable or header name`)
    if (names.has(v.name)) throw new Error(`"${v.name}" is listed twice`)
    names.add(v.name)
  }
}

export function createMcpServer(db: Database, input: NewMcpServer): McpServerRecord {
  assertMcpServerShape(input)
  try {
    db.prepare(
      `INSERT INTO mcp_servers (id, name, transport, command, args, url, vars, enabled, read_only, repo_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.transport,
      input.command ?? null,
      JSON.stringify(input.args ?? []),
      input.url ?? null,
      JSON.stringify(input.vars ?? []),
      input.enabled === false ? 0 : 1,
      input.readOnly ? 1 : 0,
      input.repoIds ? JSON.stringify(input.repoIds) : null,
    )
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: mcp_servers\.name/.test(error.message))
      throw new Error(`An MCP server named "${input.name}" already exists`, { cause: error })
    throw error
  }
  const record = getMcpServer(db, input.id)
  if (!record) throw new Error(`MCP server ${input.id} was not found after insert`)
  return record
}

export function getMcpServer(db: Database, id: string): McpServerRecord | undefined {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined
  return row ? toRecord(row) : undefined
}

export function listMcpServers(db: Database): McpServerRecord[] {
  return (db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as unknown as Row[]).map(toRecord)
}

/** Enabled servers that apply to this project. */
export function mcpServersForRepo(db: Database, repoId: RepoId): McpServerRecord[] {
  return listMcpServers(db).filter(
    (server) => server.enabled && (!server.repoIds || server.repoIds.includes(repoId)),
  )
}

export function updateMcpServer(
  db: Database,
  id: string,
  update: McpServerUpdate,
): McpServerRecord | undefined {
  if (update.enabled !== undefined)
    db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(update.enabled ? 1 : 0, id)
  if (update.readOnly !== undefined)
    db.prepare('UPDATE mcp_servers SET read_only = ? WHERE id = ?').run(update.readOnly ? 1 : 0, id)
  if (update.repoIds !== undefined)
    db.prepare('UPDATE mcp_servers SET repo_ids = ? WHERE id = ?').run(
      update.repoIds === null ? null : JSON.stringify(update.repoIds),
      id,
    )
  return getMcpServer(db, id)
}

export function deleteMcpServer(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes) > 0
}
