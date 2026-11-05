import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { McpServerConfig } from '@joy/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { ToolHubCall, ToolHubDispatcher, ToolHubToolName, ToolHubValue } from './hub.js'
import { TOOL_HUB_SERVER_NAME, toolHubInputSchemas } from './hub.js'

const descriptions = {
  ask_peer:
    'Ask a different, repository-allowed provider for a read-only second opinion about this task and its shared worktree.',
  task_status: 'Read a concise, redacted status summary for this task.',
  request_approval: 'Submit a proposed action to Joy policy for owner approval.',
  approve: 'Answer a delegated tool permission prompt using Joy policy.',
} satisfies Record<ToolHubToolName, string>

export function createToolHubMcpServer(dispatch: ToolHubDispatcher): McpServer {
  const server = new McpServer({ name: TOOL_HUB_SERVER_NAME, version: '0.0.0' })
  server.registerTool(
    'ask_peer',
    { description: descriptions.ask_peer, inputSchema: toolHubInputSchemas.ask_peer },
    async (args) => executeTool(dispatch, { name: 'ask_peer', arguments: args }),
  )
  server.registerTool(
    'task_status',
    { description: descriptions.task_status, inputSchema: toolHubInputSchemas.task_status },
    async (args) => executeTool(dispatch, { name: 'task_status', arguments: args }),
  )
  server.registerTool(
    'request_approval',
    { description: descriptions.request_approval, inputSchema: toolHubInputSchemas.request_approval },
    async (args) => executeTool(dispatch, { name: 'request_approval', arguments: args }),
  )
  server.registerTool(
    'approve',
    { description: descriptions.approve, inputSchema: toolHubInputSchemas.approve },
    async (args) => executeTool(dispatch, { name: 'approve', arguments: args }),
  )
  return server
}

/** Creates a stdio MCP config that runs the source entrypoint from this checkout. */
export function createToolHubMcpConfig(endpoint: string, token: string): McpServerConfig {
  if (endpoint.includes(token)) throw new Error('Tool Hub bearer tokens must not appear in the endpoint URL')
  const require = createRequire(import.meta.url)
  const tsxLoader = require.resolve('tsx')
  const entrypoint = fileURLToPath(new URL('./stdio.ts', import.meta.url))
  return {
    name: TOOL_HUB_SERVER_NAME,
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', tsxLoader, entrypoint],
    env: { JOY_TOOL_HUB_ENDPOINT: endpoint, JOY_TOOL_HUB_TOKEN: token },
  }
}

export async function startToolHubStdio(dispatch: ToolHubDispatcher): Promise<McpServer> {
  const server = createToolHubMcpServer(dispatch)
  await server.connect(new StdioServerTransport())
  return server
}

async function executeTool(dispatch: ToolHubDispatcher, call: ToolHubCall) {
  try {
    const value = await dispatch(call)
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool Hub request failed'
    return { content: [{ type: 'text' as const, text: message }], isError: true }
  }
}

export function isToolHubValue(value: unknown): value is ToolHubValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isToolHubValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isToolHubValue)
}
