// Minimal stdio MCP server used when recording CLI fixtures (scripts/record-fixtures.mjs).
// Tools: ask_peer (always answers "PEER SAYS: 4") and approve (a permission prompt tool that
// denies Bash commands containing "rm " and allows everything else).
// Every JSON-RPC request is appended to the file named by $LOG.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = (o) => process.env.LOG && appendFileSync(process.env.LOG, JSON.stringify(o) + '\n')
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')

const tools = [
  {
    name: 'ask_peer',
    description: 'Ask the peer model a question and get its answer.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'approve',
    description: 'Permission prompt handler.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
    },
  },
]

function call(name, args) {
  if (name === 'ask_peer') return 'PEER SAYS: 4'
  const deny = args.tool_name === 'Bash' && String(args.input?.command ?? '').includes('rm ')
  return JSON.stringify(
    deny
      ? { behavior: 'deny', message: 'Denied by Joy policy (stub)' }
      : { behavior: 'allow', updatedInput: args.input },
  )
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  log({ in: msg })
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'joy-stub', version: '0' },
      },
    })
  }
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools } })
  if (msg.method === 'tools/call') {
    const text = call(msg.params.name, msg.params.arguments ?? {})
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })
  }
  if (msg.id !== undefined)
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
})
