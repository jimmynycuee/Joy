import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalMcpServers, classifyExternalTool } from './external-mcp.js'

const FAKE = join(import.meta.dirname, '..', 'test-support', 'fake-google-mcp.mjs')
const dirs: string[] = []
const servers: ExternalMcpServers[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('classifying outside tools', () => {
  it('maps Gmail and Calendar tools onto the policy action kinds', () => {
    expect(classifyExternalTool('search_gmail_messages', {})).toBe('read_mail')
    expect(classifyExternalTool('get_gmail_message_content', {})).toBe('read_mail')
    expect(classifyExternalTool('send_gmail_message', {})).toBe('send_mail')
    expect(classifyExternalTool('draft_gmail_message', {})).toBe('send_mail')
    expect(classifyExternalTool('get_events', {})).toBe('read_calendar')
    expect(classifyExternalTool('list_calendars', {})).toBe('read_calendar')
    expect(classifyExternalTool('create_event', { summary: 'Focus' })).toBe('create_own_event')
    expect(classifyExternalTool('create_event', { attendees: ['a@example.com'] })).toBe('invite_others')
    expect(classifyExternalTool('modify_event', { send_updates: 'all' })).toBe('invite_others')
    // Unknown tools wait for the owner.
    expect(classifyExternalTool('transfer_ownership', {})).toBe('invite_others')
    expect(classifyExternalTool('transfer_ownership', {}, { transfer_ownership: 'read_calendar' })).toBe(
      'read_calendar',
    )
    expect(classifyExternalTool('x', {}, { x: 'not-a-kind' })).toBe('invite_others')
  })
})

describe('outside MCP servers', () => {
  it('lists and calls the tools of a configured stdio server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-mcp-'))
    dirs.push(dir)
    const log = join(dir, 'calls.jsonl')
    const warnings: string[] = []
    const external = new ExternalMcpServers(
      async () => ({
        google: { command: process.execPath, args: [FAKE, log] },
        broken: { command: join(dir, 'missing-binary'), args: [] },
      }),
      (text) => warnings.push(text),
    )
    servers.push(external)
    const tools = await external.listTools()
    expect(tools.map((t) => `${t.server}:${t.name}`)).toEqual([
      'google:search_gmail_messages',
      'google:send_gmail_message',
      'google:get_events',
      'google:create_event',
    ])
    expect(warnings).toEqual([expect.stringContaining('MCP server "broken" is unavailable')])
    expect(await external.call('google', 'get_events', { day: 'tomorrow' })).toEqual([
      { type: 'text', text: 'Tomorrow 14:00–15:00 Dentist' },
    ])
    expect(readFileSync(log, 'utf8')).toContain('"tool":"get_events"')
  })
})
