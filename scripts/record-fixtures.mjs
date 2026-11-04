#!/usr/bin/env node
// Records real CLI event streams into tests/fixtures/cli-events/<cli>/ for adapter contract tests.
//
//   node scripts/record-fixtures.mjs claude [--model haiku]
//   node scripts/record-fixtures.mjs codex  [--model <name>]
//
// Uses whatever account the CLI is logged into, and spends a little of its quota.
// Runs on macOS and Linux (and WSL). On native Windows the npm shims are .cmd files, which need a shell; not supported.
// Output sanitizes temp/repo/home paths, usernames, Node paths, local config keys and CLI session IDs.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stub = join(root, 'scripts', 'fixtures', 'mcp-stub.mjs')

const [cli, ...rest] = process.argv.slice(2)
const modelIdx = rest.indexOf('--model')
const model = modelIdx >= 0 ? rest[modelIdx + 1] : cli === 'claude' ? 'haiku' : undefined
if (cli !== 'claude' && cli !== 'codex') {
  console.error('usage: node scripts/record-fixtures.mjs <claude|codex> [--model <name>]')
  process.exit(2)
}

const outDir = join(root, 'tests', 'fixtures', 'cli-events', cli)
mkdirSync(outDir, { recursive: true })

function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'joy-fixture-')))
  writeFileSync(join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b\n}\n')
  const git = (...args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=joy', '-c', 'user.email=joy@example.com', 'commit', '-qm', 'init')
  return dir
}

function sanitize(text, workdir) {
  const pairs = [
    [workdir, '<WORKDIR>'],
    [root, '<REPO>'],
    [realpathSync(tmpdir()), '<TMP>'],
    [tmpdir(), '<TMP>'],
    [homedir(), '<HOME>'],
    [process.execPath, '<NODE>'],
  ]
  for (const [from, to] of pairs) text = text.split(from).join(to)

  const username = userInfo().username
  if (username) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`, 'g'), '<USER>')
  }

  text = text.replace(/`[^`]+` is ignored/g, '`<SETTING>` is ignored')
  text = text.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '<SESSION_ID>')
  return text
}

function version() {
  const r = spawnSync(cli, ['--version'], { encoding: 'utf8' })
  return (r.stdout || r.stderr).trim()
}

/** Runs the CLI once and writes <name>.jsonl plus <name>.meta.json. Returns the parsed events. */
function record(name, args, workdir) {
  console.log(`recording ${cli}/${name} …`)
  const r = spawnSync(cli, args, {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = r.stdout ?? ''
  writeFileSync(join(outDir, `${name}.jsonl`), sanitize(stdout, workdir))
  const meta = {
    cli,
    version: version(),
    args: args.map((a) => sanitize(a, workdir)),
    exitCode: r.status,
    signal: r.signal,
    recordedAt: new Date().toISOString(),
    stderrTail: sanitize((r.stderr ?? '').slice(-2000), workdir),
  }
  writeFileSync(join(outDir, `${name}.meta.json`), JSON.stringify(meta, null, 2) + '\n')
  if (r.status !== 0) console.warn(`  exit ${r.status}; see ${name}.meta.json`)
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const FIX = 'math.js has a bug in add(). Fix it. Do not create other files.'
const MCP_PROMPT =
  "First call the ask_peer tool with question 'what is 2+2'. Then run exactly this shell command: git status --short. " +
  'Then run exactly this shell command: rm math.js. Report what happened.'
const m = model ? ['--model', model] : []

function withRepo(fn) {
  const dir = makeRepo()
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (cli === 'claude') {
  const base = ['-p', '--output-format', 'stream-json', '--verbose', ...m]
  withRepo((dir) => record('edit', [...base, '--permission-mode', 'acceptEdits', FIX], dir))
  withRepo((dir) => {
    const mcpConfig = join(dir, '..', `joy-mcp-${randomUUID()}.json`)
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { joy: { command: process.execPath, args: [stub], env: { LOG: '' } } } }),
    )
    try {
      record(
        'mcp-approval',
        [
          ...base,
          '--permission-mode',
          'manual',
          '--mcp-config',
          mcpConfig,
          '--strict-mcp-config',
          '--permission-prompt-tool',
          'mcp__joy__approve',
          '--permission-prompts',
          'host',
          MCP_PROMPT,
        ],
        dir,
      )
    } finally {
      rmSync(mcpConfig, { force: true })
    }
  })
  withRepo((dir) => {
    const id = randomUUID()
    record('resume-1', [...base, '--session-id', id, 'Remember the code word PELICAN. Reply only OK.'], dir)
    record('resume-2', [...base, '--resume', id, 'What was the code word?'], dir)
  })
} else {
  const base = ['exec', '--json', ...m]
  withRepo((dir) => record('edit', [...base, '--sandbox', 'workspace-write', FIX], dir))
  withRepo((dir) =>
    record(
      'mcp',
      [
        ...base,
        '--sandbox',
        'workspace-write',
        '-c',
        `mcp_servers.joy.command=${JSON.stringify(process.execPath)}`,
        '-c',
        `mcp_servers.joy.args=[${JSON.stringify(stub)}]`,
        MCP_PROMPT,
      ],
      dir,
    ),
  )
  withRepo((dir) => {
    const first = record('resume-1', [...base, 'Remember the code word PELICAN. Reply only OK.'], dir)
    const id = first.find((e) => e.type === 'thread.started')?.thread_id
    if (!id) throw new Error('codex did not report thread.started; cannot record resume-2')
    record('resume-2', ['exec', 'resume', '--json', ...m, id, 'What was the code word?'], dir)
  })
}

console.log(`done: ${outDir}`)
