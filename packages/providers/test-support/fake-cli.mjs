// Stands in for `claude` / `codex` in tests. Behaviour comes from env vars:
//   FAKE_ARGS_OUT  write the received argv (JSON) and pid to this file
//   FAKE_REPLAY    JSONL file to print to stdout, line by line
//   FAKE_MODE      'hang' (print nothing, never exit) | 'exit3' (stderr + exit 3) | 'garbage'
//   FAKE_CAT_MCP   print the contents of the file after --mcp-config to stdout as one JSON line
//   FAKE_READ_STDIN  (default mode) read stdin to its end into FAKE_STDIN_OUT before replaying (`codex exec -`)
//   FAKE_MODE=stream  Claude `--input-format stream-json` stand-in (synthetic, not recorded): reads user messages from
//                     stdin (each appended to FAKE_STDIN_OUT), answers each turn after FAKE_STREAM_HOLD_MS (default 150)
//                     with a `result`. A message that arrives mid-turn joins that turn, or with FAKE_STREAM_QUEUE=1
//                     becomes the next turn. Exits once stdin is closed and every message is answered.
//                     FAKE_STREAM_FAIL_TURNS: comma-separated turn numbers that end with an error result.
//                     `total_cost_usd` is cumulative (0.01 per turn) and `usage` grows with each turn.
//   FAKE_MODE=permission  Claude permission-prompt stand-in (synthetic, not recorded): asks about each tool call in
//                     FAKE_PERMISSION_ASKS (JSON array of {tool_name, input}). With `--permission-prompt-tool
//                     mcp__<server>__<tool>` it starts that MCP server from the `--mcp-config` file and calls the tool
//                     with {tool_name, input, tool_use_id}, the way the CLI does; without it every ask is denied with
//                     the CLI's own `system/permission_denied` (no approval surface). Each decision is appended as a
//                     JSON line to FAKE_PERMISSION_OUT. With `--input-format stream-json` it reads the prompt from
//                     stdin first and exits once stdin is closed.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (process.env.FAKE_ARGS_OUT)
  writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify({ args, pid: process.pid }))

if (process.env.FAKE_CAT_MCP) {
  const i = args.indexOf('--mcp-config')
  process.stdout.write(
    JSON.stringify({ type: 'fake_mcp', config: JSON.parse(readFileSync(args[i + 1], 'utf8')) }) + '\n',
  )
}

function streamInput() {
  const hold = Number(process.env.FAKE_STREAM_HOLD_MS ?? 150)
  const queueMode = process.env.FAKE_STREAM_QUEUE === '1'
  const failTurns = new Set((process.env.FAKE_STREAM_FAIL_TURNS ?? '').split(',').filter(Boolean).map(Number))
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  const session = 'fake-stream-session'
  const pending = []
  let inTurn = false
  let started = false
  let ended = false
  let turns = 0
  const say = (text) =>
    send({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text }] } })
  const startTurn = (text) => {
    inTurn = true
    turns++
    say(`got: ${text}`)
    setTimeout(() => {
      inTurn = false
      const failed = failTurns.has(turns)
      send({
        type: 'result',
        subtype: failed ? 'error_during_execution' : 'success',
        is_error: failed,
        session_id: session,
        result: failed ? `turn ${turns} failed` : `turn ${turns} done`,
        total_cost_usd: Number((0.01 * turns).toFixed(2)),
        usage: { input_tokens: 10 * turns, output_tokens: 5 * turns },
      })
      const next = pending.shift()
      if (next !== undefined) startTurn(next)
      else if (ended) process.exit(0)
    }, hold)
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (process.env.FAKE_STDIN_OUT) appendFileSync(process.env.FAKE_STDIN_OUT, `${line}\n`)
    const text = JSON.parse(line).message.content
    if (!started) {
      started = true
      send({ type: 'system', subtype: 'init', session_id: session, model: 'haiku', cwd: process.cwd() })
    }
    if (!inTurn) startTurn(text)
    else if (queueMode) pending.push(text)
    else say(`steered: ${text}`)
  })
  lines.on('close', () => {
    ended = true
    if (!inTurn && pending.length === 0) process.exit(0)
  })
}

/** A minimal MCP client over stdio: newline-delimited JSON-RPC, as the MCP stdio transport sends it. */
function mcpClient(server) {
  const child = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const pending = new Map()
  let nextId = 1
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const message = JSON.parse(line)
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error.message))
    else waiting.resolve(message.result)
  })
  const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        write({ id, method, params })
      }),
    notify: (method, params) => write({ method, params }),
    close: () => {
      child.stdin.end()
      child.kill()
    },
  }
}

async function permissionPrompts() {
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  const session = 'fake-permission-session'
  const record = (entry) => {
    if (process.env.FAKE_PERMISSION_OUT)
      appendFileSync(process.env.FAKE_PERMISSION_OUT, `${JSON.stringify(entry)}\n`)
  }
  const streaming = args.includes('--input-format')
  let stdinClosed = Promise.resolve()
  if (streaming) {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
    stdinClosed = new Promise((resolve) => lines.on('close', resolve))
    await new Promise((resolve) => lines.once('line', resolve))
  }
  send({ type: 'system', subtype: 'init', session_id: session, model: 'haiku', cwd: process.cwd() })
  const asks = JSON.parse(process.env.FAKE_PERMISSION_ASKS ?? '[]')
  const toolAt = args.indexOf('--permission-prompt-tool')
  const denied = (toolName, reason) =>
    send({
      type: 'system',
      subtype: 'permission_denied',
      session_id: session,
      tool_name: toolName,
      decision_reason: reason,
    })
  if (toolAt < 0) {
    for (const ask of asks) {
      const reason = 'no approval surface in this session; permission request denied automatically'
      denied(ask.tool_name, reason)
      record({ tool_name: ask.tool_name, input: ask.input, via: 'cli', behavior: 'deny', message: reason })
    }
  } else {
    const [, serverName, toolName] = /^mcp__(.+?)__(.+)$/.exec(args[toolAt + 1]) ?? []
    const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'))
    const client = mcpClient(config.mcpServers[serverName])
    try {
      await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-claude', version: '0' },
      })
      client.notify('notifications/initialized')
      for (const [index, ask] of asks.entries()) {
        const result = await client.request('tools/call', {
          name: toolName,
          arguments: { tool_name: ask.tool_name, input: ask.input, tool_use_id: `toolu_fake_${index}` },
        })
        const decision = result.isError
          ? { behavior: 'deny', message: result.content?.[0]?.text ?? 'tool error' }
          : JSON.parse(result.content[0].text)
        record({ tool_name: ask.tool_name, input: ask.input, via: 'tool', ...decision })
        if (decision.behavior === 'allow')
          send({
            type: 'assistant',
            session_id: session,
            message: { content: [{ type: 'text', text: `ran ${ask.tool_name}` }] },
          })
        else denied(ask.tool_name, decision.message)
      }
    } finally {
      client.close()
    }
  }
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: session,
    result: 'permission prompts done',
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
  await stdinClosed
  process.exit(0)
}

switch (process.env.FAKE_MODE) {
  case 'permission':
    void permissionPrompts()
    break
  case 'stream':
    streamInput()
    break
  case 'hang':
    setInterval(() => {}, 1000)
    break
  case 'exit3':
    process.stderr.write('boom: not logged in\n')
    process.exit(3)
    break
  case 'garbage':
    process.stdout.write('not json\n')
    break
  default:
    if (process.env.FAKE_READ_STDIN && process.env.FAKE_STDIN_OUT)
      writeFileSync(process.env.FAKE_STDIN_OUT, readFileSync(0, 'utf8'))
    if (process.env.FAKE_REPLAY) process.stdout.write(readFileSync(process.env.FAKE_REPLAY, 'utf8'))
}
