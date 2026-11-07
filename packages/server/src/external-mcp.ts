// Outside MCP servers for the assistant (T3.8): Joy starts the owner's chosen server (Google Workspace by default
// choice, see docs/STATUS.md), lists its tools and hands them to the assistant. Every call is classified as one of the
// policy's action kinds and goes through packages/policy, so reading runs, adding to the owner's own calendar runs and
// is announced, and sending mail or inviting people waits for the owner. Results are external content. The server keeps
// its own Google login; Joy never sees it.
import type { ActionKind } from '@joy/core'
import { isActionKind } from '@joy/policy'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface ExternalServerConfig {
  command: string
  args: string[]
  /** Overrides for tools the name-based rules get wrong: tool name → action kind. */
  tools?: Record<string, string> | undefined
}

export interface ExternalTool {
  server: string
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}

const READ =
  /^(list|get|search|read|find|query|check|fetch|show)_|_(freebusy|free_busy)$|^(freebusy|query_freebusy)$/i
const MAIL = /gmail|mail|message|thread|draft|label|inbox/i
const EVENT_WRITE = /(^|_)(create|add|insert|update|modify|patch|delete|remove|move|respond)(_|$)/i
const CALENDAR = /calendar|event|freebusy/i

function hasOtherPeople(args: Record<string, unknown>): boolean {
  const attendees = args.attendees ?? args.attendee_emails ?? args.guests
  if (Array.isArray(attendees) && attendees.length > 0) return true
  if (typeof attendees === 'string' && attendees.trim()) return true
  return args.send_updates === 'all' || args.sendUpdates === 'all'
}

/**
 * The policy action a tool call is. Unknown writes are treated as the riskiest kind that fits (sending mail or inviting
 * others), so a tool Joy does not recognise always waits for the owner.
 */
export function classifyExternalTool(
  name: string,
  args: Record<string, unknown>,
  overrides: Record<string, string> = {},
): ActionKind {
  const override = overrides[name]
  if (override !== undefined && isActionKind(override)) return override
  const mail = MAIL.test(name)
  if (READ.test(name)) return mail ? 'read_mail' : 'read_calendar'
  // Any mail change (send, reply, draft, labels) counts as sending: it acts on the owner's mailbox.
  if (mail) return 'send_mail'
  if (CALENDAR.test(name) && EVENT_WRITE.test(name))
    return hasOtherPeople(args) ? 'invite_others' : 'create_own_event'
  return 'invite_others'
}

/** The server's input schema (untrusted) reduced to the object form function calling needs. */
function objectSchema(value: unknown): ExternalTool['inputSchema'] {
  const schema = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const properties =
    typeof schema.properties === 'object' && schema.properties !== null && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** One connection per configured server, started on first use and reused. */
export class ExternalMcpServers {
  private readonly clients = new Map<string, Promise<Client>>()

  constructor(
    private readonly configs: () => Promise<Record<string, ExternalServerConfig>>,
    private readonly warn: (text: string) => void,
  ) {}

  private connect(name: string, config: ExternalServerConfig): Promise<Client> {
    let client = this.clients.get(name)
    if (!client) {
      client = (async () => {
        const created = new Client({ name: 'joy', version: '1.0.0' })
        // The SDK passes only a minimal environment (HOME, PATH, …): enough for the server to find its own login
        // files under the owner's home, and nothing of Joy's.
        await created.connect(
          new StdioClientTransport({ command: config.command, args: config.args, stderr: 'ignore' }),
        )
        return created
      })()
      client.catch(() => this.clients.delete(name))
      this.clients.set(name, client)
    }
    return client
  }

  /** Every tool of every configured server; a server that fails to start is skipped with a warning. */
  async listTools(): Promise<ExternalTool[]> {
    const tools: ExternalTool[] = []
    for (const [server, config] of Object.entries(await this.configs())) {
      try {
        const client = await this.connect(server, config)
        for (const tool of (await client.listTools()).tools)
          tools.push({
            server,
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: objectSchema(tool.inputSchema),
          })
      } catch (error) {
        this.warn(
          `MCP server "${server}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return tools
  }

  async overrides(server: string): Promise<Record<string, string>> {
    return (await this.configs())[server]?.tools ?? {}
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const config = (await this.configs())[server]
    if (!config) throw new Error(`MCP server "${server}" is not configured`)
    const client = await this.connect(server, config)
    const result = await client.callTool({ name: tool, arguments: args })
    return result.structuredContent ?? result.content
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    for (const client of clients) await client.then((c) => c.close()).catch(() => undefined)
  }
}
