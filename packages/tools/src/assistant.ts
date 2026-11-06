// A generic MCP bridge for the assistant: the tool list and every call live in the Joy server, so a CLI brain
// (Claude Code, Codex) and the OpenAI API brain use exactly the same tools.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { McpServerConfig } from '@joy/core'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const ASSISTANT_SERVER_NAME = 'joy_assistant'

/** What the server advertises for each assistant tool. `inputSchema` is plain JSON Schema. */
export interface AssistantToolSpec {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}

/** Talks to the server: list the tools, call one. */
export interface AssistantBridge {
  listTools(signal?: AbortSignal): Promise<AssistantToolSpec[]>
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>
}

export function createAssistantMcpServer(bridge: AssistantBridge): Server {
  const server = new Server(
    { name: ASSISTANT_SERVER_NAME, version: '0.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    tools: await bridge.listTools(extra.signal),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const value = await bridge.callTool(request.params.name, request.params.arguments ?? {}, extra.signal)
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Assistant tool failed'
      return { content: [{ type: 'text' as const, text: message }], isError: true }
    }
  })
  return server
}

/** HTTP bridge to the server's per-turn assistant endpoint (loopback only, bearer token, never in the URL). */
export function createHttpAssistantBridge(endpoint: string, token: string): AssistantBridge {
  const url = new URL(endpoint)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^\/internal\/assistant\/[A-Za-z0-9_-]{32,}$/.test(url.pathname) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('The Joy assistant bridge only accepts an authenticated loopback endpoint')
  }
  const post = async (body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const timeout = AbortSignal.timeout(120_000)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch {
      throw new Error('The Joy assistant could not reach the local service')
    }
    const payload: unknown = await response.json().catch(() => undefined)
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
    if (!response.ok) {
      throw new Error(
        typeof record.error === 'string' ? record.error : `Assistant request failed (${response.status})`,
      )
    }
    return record.value
  }
  return {
    async listTools(signal) {
      const value = await post({ op: 'list' }, signal)
      if (!Array.isArray(value)) throw new Error('The Joy assistant returned an invalid tool list')
      return value as AssistantToolSpec[]
    },
    callTool: (name, args, signal) => post({ op: 'call', name, arguments: args }, signal),
  }
}

/** MCP config that starts this bridge from the checkout, like the Tool Hub's. */
export function createAssistantMcpConfig(endpoint: string, token: string): McpServerConfig {
  if (endpoint.includes(token)) throw new Error('Assistant bearer tokens must not appear in the endpoint URL')
  const require = createRequire(import.meta.url)
  const tsxLoader = require.resolve('tsx')
  const entrypoint = fileURLToPath(new URL('./assistant-stdio.ts', import.meta.url))
  return {
    name: ASSISTANT_SERVER_NAME,
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', pathToFileURL(tsxLoader).href, entrypoint],
    env: { JOY_ASSISTANT_ENDPOINT: endpoint, JOY_ASSISTANT_TOKEN: token },
  }
}

export async function startAssistantStdio(bridge: AssistantBridge): Promise<Server> {
  const server = createAssistantMcpServer(bridge)
  await server.connect(new StdioServerTransport())
  return server
}
