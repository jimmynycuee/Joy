import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const scenarios = ['edit', 'mcp', 'resume-1', 'resume-2']

function readEvents(name) {
  const source = readFileSync(new URL(`${name}.jsonl`, import.meta.url), 'utf8').trim()
  assert.notEqual(source, '', `${name} fixture must not be empty`)
  return source.split(/\r?\n/).map((line) => {
    const event = JSON.parse(line)
    assert.equal(typeof event.type, 'string', `${name} events must have a type`)
    return event
  })
}

function readMeta(name) {
  return JSON.parse(readFileSync(new URL(`${name}.meta.json`, import.meta.url), 'utf8'))
}

function completedItems(events) {
  return events.filter((event) => event.type === 'item.completed').map((event) => event.item)
}

test('recorded Codex streams and metadata are valid, successful, and sanitized', () => {
  for (const name of scenarios) {
    const events = readEvents(name)
    const meta = readMeta(name)
    const serialized = `${JSON.stringify(events)}\n${JSON.stringify(meta)}`

    assert.equal(meta.cli, 'codex')
    assert.match(meta.version, /^codex-cli \d/)
    assert.equal(meta.exitCode, 0)
    assert.equal(meta.signal, null)
    assert.ok(Number.isFinite(Date.parse(meta.recordedAt)))
    assert.ok(
      events.some((event) => event.type === 'turn.completed'),
      `${name} must complete a turn`,
    )
    assert.doesNotMatch(serialized, /\bsk-[A-Za-z0-9_-]{20,}/)
    assert.doesNotMatch(serialized, /\bBearer\s+\S+/i)
    assert.doesNotMatch(serialized, /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    assert.doesNotMatch(serialized, /\/(?:Users|home)\/[^/\s]+/)
    assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i)
  }
})

test('all Codex fixtures keep local paths, credentials, and session ids redacted', () => {
  for (const name of [...scenarios, 'network-error']) {
    const stream = readFileSync(new URL(`${name}.jsonl`, import.meta.url), 'utf8')
    const serialized = `${stream}\n${JSON.stringify(readMeta(name))}`
    assert.doesNotMatch(serialized, /\bsk-[A-Za-z0-9_-]{20,}/)
    assert.doesNotMatch(serialized, /\bBearer\s+\S+/i)
    assert.doesNotMatch(serialized, /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    assert.doesNotMatch(serialized, /\/(?:Users|home)\/[^/\s]+/)
    assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i)
  }
})

test('edit fixture records a successful code change', () => {
  const items = completedItems(readEvents('edit'))
  assert.ok(
    items.some(
      (item) =>
        item.type === 'file_change' &&
        item.changes.some((change) => change.path === '<WORKDIR>/math.js' && change.kind === 'update'),
    ),
  )
  assert.ok(items.some((item) => item.type === 'command_execution' && item.exit_code === 0))
})

test('MCP fixture records the injected tool and requested shell commands', () => {
  const items = completedItems(readEvents('mcp'))
  const mcpCall = items.find(
    (item) => item.type === 'mcp_tool_call' && item.server === 'joy' && item.tool === 'ask_peer',
  )
  assert.ok(mcpCall)
  assert.ok(mcpCall.result.content.some((entry) => entry.text === 'PEER SAYS: 4'))
  const commands = items
    .filter((item) => item.type === 'command_execution' && item.exit_code === 0)
    .map((item) => item.command)
  assert.ok(commands.some((command) => command.includes('git status --short')))
  assert.ok(commands.some((command) => command.includes('rm math.js')))
})

test('resume fixtures record a sanitized session id and resumed context', () => {
  const first = readEvents('resume-1')
  const resumedMeta = readMeta('resume-2')
  const second = readEvents('resume-2')
  const firstThread = first.find((event) => event.type === 'thread.started')
  const resumedMessage = completedItems(second).find((item) => item.type === 'agent_message')

  assert.equal(firstThread?.thread_id, '<SESSION_ID>')
  assert.ok(resumedMeta.args.includes('<SESSION_ID>'))
  assert.match(resumedMessage?.text ?? '', /PELICAN/)
})
