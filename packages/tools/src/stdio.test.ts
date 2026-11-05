import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'
import { createToolHubMcpConfig } from './mcp.js'

describe('stdio Tool Hub bridge', () => {
  it('starts the MCP stdio child and forwards authenticated calls to its task endpoint', async () => {
    const token = 'x'.repeat(43)
    const sessionId = 's'.repeat(43)
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
      `http://127.0.0.1:${address.port}/internal/tool-hub/${sessionId}`,
      token,
    )
    if (config.transport !== 'stdio') throw new Error('Tool Hub transport must use stdio')
    expect(config.env?.JOY_TOOL_HUB_ENDPOINT).not.toContain(token)
    const client = new Client({ name: 'joy-stdio-test', version: '1.0.0' })
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ?? {},
      stderr: 'pipe',
    })
    const stderr: Buffer[] = []
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)))
    try {
      await client.connect(transport)
      const result = await client.callTool({ name: 'task_status', arguments: {} })
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ id: 'task-stdio', status: 'running' }) },
      ])
      expect(calls).toEqual([{ name: 'task_status', arguments: {} }])
    } catch (error) {
      const details = Buffer.concat(stderr).toString('utf8').trim()
      if (details) throw new Error(`MCP stdio child failed: ${details}`, { cause: error })
      throw error
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }, 15_000)

  it('aborts the local endpoint request when the MCP caller cancels ask_peer', async () => {
    const token = 'x'.repeat(43)
    const sessionId = 's'.repeat(43)
    let requestReceived!: () => void
    let responseClosed!: () => void
    let activeResponse: ServerResponse | undefined
    const requestStarted = new Promise<void>((resolve) => {
      requestReceived = resolve
    })
    const connectionClosed = new Promise<void>((resolve) => {
      responseClosed = resolve
    })
    const httpServer = createServer((_req, res) => {
      activeResponse = res
      res.once('close', () => {
        if (!res.writableEnded) responseClosed()
      })
      _req.on('data', () => undefined)
      _req.once('end', () => requestReceived())
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address() as AddressInfo
    const config = createToolHubMcpConfig(
      `http://127.0.0.1:${address.port}/internal/tool-hub/${sessionId}`,
      token,
    )
    if (config.transport !== 'stdio') throw new Error('Tool Hub transport must use stdio')
    const client = new Client({ name: 'joy-stdio-cancel-test', version: '1.0.0' })
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ?? {},
      stderr: 'pipe',
    })
    try {
      await client.connect(transport)
      const controller = new AbortController()
      const pending = client.callTool(
        { name: 'ask_peer', arguments: { provider: 'codex-cli', question: 'Review this change' } },
        undefined,
        { signal: controller.signal },
      )
      await requestStarted
      controller.abort()
      await expect(pending).rejects.toThrow()
      const didClose = await Promise.race([
        connectionClosed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ])
      expect(didClose).toBe(true)
    } finally {
      activeResponse?.end()
      await client.close()
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }, 15_000)
})
