// Stands in for `claude` / `codex` in tests. Behaviour comes from env vars:
//   FAKE_ARGS_OUT  write the received argv (JSON) and pid to this file
//   FAKE_REPLAY    JSONL file to print to stdout, line by line
//   FAKE_MODE      'hang' (print nothing, never exit) | 'exit3' (stderr + exit 3) | 'garbage'
//   FAKE_CAT_MCP   print the contents of the file after --mcp-config to stdout as one JSON line
//   FAKE_MODE=stream  Claude `--input-format stream-json` stand-in (synthetic, not recorded): reads user messages from
//                     stdin (each appended to FAKE_STDIN_OUT), answers each turn after FAKE_STREAM_HOLD_MS (default 150)
//                     with a `result`. A message that arrives mid-turn joins that turn, or with FAKE_STREAM_QUEUE=1
//                     becomes the next turn. Exits once stdin is closed and every message is answered.
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
      send({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: session,
        result: `turn ${turns} done`,
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
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

switch (process.env.FAKE_MODE) {
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
    if (process.env.FAKE_REPLAY) process.stdout.write(readFileSync(process.env.FAKE_REPLAY, 'utf8'))
}
