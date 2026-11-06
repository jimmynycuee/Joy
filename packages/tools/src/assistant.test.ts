import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { AssistantBridge } from './assistant.js'
import { createAssistantMcpConfig, createAssistantMcpServer, createHttpAssistantBridge } from './assistant.js'

const bridge: AssistantBridge = {
  async listTools() {
    return [
      {
        name: 'list_repos',
        description: 'List repositories',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
  },
  async callTool(name) {
    if (name === 'list_repos') return { repos: [{ id: 'r1' }] }
    throw new Error(`Unknown tool ${name}`)
  },
}

describe('assistant MCP bridge', () => {
  it('lists the server tools and forwards calls', async () => {
    const server = createAssistantMcpServer(bridge)
    const client = new Client({ name: 'joy-assistant-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(['list_repos'])
      const ok = await client.callTool({ name: 'list_repos', arguments: {} })
      expect(ok.content).toEqual([{ type: 'text', text: JSON.stringify({ repos: [{ id: 'r1' }] }) }])
      const failed = await client.callTool({ name: 'nope', arguments: {} })
      expect(failed).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Unknown tool nope' }] })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('accepts only an authenticated loopback endpoint', () => {
    const session = 's'.repeat(43)
    expect(() =>
      createHttpAssistantBridge(`http://127.0.0.1:1/internal/assistant/${session}`, 't'),
    ).not.toThrow()
    expect(() => createHttpAssistantBridge(`http://example.com/internal/assistant/${session}`, 't')).toThrow()
    expect(() => createHttpAssistantBridge(`http://127.0.0.1:1/internal/tool-hub/${session}`, 't')).toThrow()
  })

  it('keeps the token out of the endpoint', () => {
    const token = 'x'.repeat(43)
    expect(() => createAssistantMcpConfig(`http://127.0.0.1:1/internal/assistant/${token}`, token)).toThrow()
    const config = createAssistantMcpConfig(`http://127.0.0.1:1/internal/assistant/${'s'.repeat(43)}`, token)
    expect(config).toMatchObject({ name: 'joy_assistant', env: { JOY_ASSISTANT_TOKEN: token } })
  })
})
