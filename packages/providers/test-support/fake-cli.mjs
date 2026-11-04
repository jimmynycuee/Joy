// Stands in for `claude` / `codex` in tests. Behaviour comes from env vars:
//   FAKE_ARGS_OUT  write the received argv (JSON) and pid to this file
//   FAKE_REPLAY    JSONL file to print to stdout, line by line
//   FAKE_MODE      'hang' (print nothing, never exit) | 'exit3' (stderr + exit 3) | 'garbage'
//   FAKE_CAT_MCP   print the contents of the file after --mcp-config to stdout as one JSON line
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.FAKE_EXEC_HELP_FAIL === '1' && args[0] === 'exec' && args[1] === '--help') {
  process.stderr.write('exec is unsupported on this fake native platform\n')
  process.exit(1)
}
if (process.env.FAKE_ARGS_OUT)
  writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify({ args, pid: process.pid }))

if (process.env.FAKE_CAT_MCP) {
  const i = args.indexOf('--mcp-config')
  process.stdout.write(
    JSON.stringify({ type: 'fake_mcp', config: JSON.parse(readFileSync(args[i + 1], 'utf8')) }) + '\n',
  )
}

switch (process.env.FAKE_MODE) {
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
