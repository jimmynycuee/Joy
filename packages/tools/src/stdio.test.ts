import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'
import { createToolHubMcpConfig } from './mcp.js'

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

describe('stdio Tool Hub bridge', () => {
  it('starts the MCP stdio child and forwards authenticated calls to its task endpoint', async () => {
    const token = 'x'.repeat(43)
    const calls: unknown[] = []
    const httpServer = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401).end()
          return
        }
        calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ value: { id: 'task-stdio', status: 'running' } }))
      })
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address() as AddressInfo
    const config = createToolHubMcpConfig(
      `http://127.0.0.1:${address.port}/internal/tool-hub/${token}`,
      token,
    )
    if (config.transport !== 'stdio') throw new Error('Tool Hub transport must use stdio')
    const client = new Client({ name: 'joy-stdio-test', version: '1.0.0' })
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...environment(), ...(config.env ?? {}) },
      stderr: 'pipe',
    })
    try {
      await client.connect(transport)
      const result = await client.callTool({ name: 'task_status', arguments: {} })
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ id: 'task-stdio', status: 'running' }) },
      ])
      expect(calls).toEqual([{ name: 'task_status', arguments: {} }])
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }, 15_000)
})
