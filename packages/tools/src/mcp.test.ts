import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { createToolHubDispatcher } from './hub.js'
import type { ToolHubRuntime } from './hub.js'
import { createToolHubMcpServer } from './mcp.js'

function runtime(): ToolHubRuntime {
  return {
    taskId: 'task-1' as ToolHubRuntime['taskId'],
    currentProvider: 'claude-cli',
    allowedProviders: ['claude-cli', 'codex-cli'],
    cwd: '/tmp/shared-worktree',
    maxAskPeerCalls: 5,
    budget: { askPeerCalls: 0 },
    askPeer: vi.fn(async () => ({ answer: 'read-only peer answer' })),
    taskStatus: vi.fn(async () => ({ id: 'task-1', status: 'running' })),
  }
}

describe('Tool Hub MCP server', () => {
  it('publishes the four tools over MCP and dispatches tool calls', async () => {
    const deps = runtime()
    const server = createToolHubMcpServer(createToolHubDispatcher(deps))
    const client = new Client({ name: 'joy-tools-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'approve',
        'ask_peer',
        'request_approval',
        'task_status',
      ])
      const result = await client.callTool({
        name: 'ask_peer',
        arguments: { provider: 'codex-cli', question: 'Review this change' },
      })
      expect(result.isError).not.toBe(true)
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ answer: 'read-only peer answer' }) },
      ])
      expect(deps.askPeer).toHaveBeenCalledOnce()
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('returns policy and validation errors as MCP tool errors', async () => {
    const server = createToolHubMcpServer(createToolHubDispatcher(runtime()))
    const client = new Client({ name: 'joy-tools-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const result = await client.callTool({
        name: 'ask_peer',
        arguments: { provider: 'claude-cli', question: 'Ask self' },
      })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        { type: 'text', text: 'ask_peer must target a different provider than the current agent' },
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })
})
