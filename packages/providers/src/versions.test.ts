import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CliName } from './versions.js'
import { TESTED_CLI_VERSIONS, checkCliVersion, compareVersions, parseCliVersion } from './versions.js'

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'cli-events')

describe('tested CLI versions', () => {
  it.each(['claude', 'codex'] as CliName[])(
    'match the versions the %s fixtures were recorded with',
    (cli) => {
      const versions = readdirSync(join(FIXTURES, cli))
        .filter((name) => name.endsWith('.meta.json'))
        .map((name) => JSON.parse(readFileSync(join(FIXTURES, cli, name), 'utf8')) as { version?: string })
        .flatMap((meta) => (meta.version ? [parseCliVersion(meta.version)] : []))
        .filter((v): v is string => Boolean(v))
        .sort(compareVersions)
      // Re-recording fixtures with a new CLI must update TESTED_CLI_VERSIONS too.
      expect(TESTED_CLI_VERSIONS[cli]).toEqual({ from: versions[0], through: versions.at(-1) })
    },
  )

  it('reads versions from --version output', () => {
    expect(parseCliVersion('2.1.317 (Claude Code)')).toBe('2.1.317')
    expect(parseCliVersion('codex-cli 0.166.0')).toBe('0.166.0')
    expect(parseCliVersion('v1.2.3-beta.1\n')).toBe('1.2.3')
    expect(parseCliVersion('nothing here')).toBeUndefined()
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
  })

  it('warns about untested versions with the re-record command', () => {
    expect(checkCliVersion('claude', '2.1.317 (Claude Code)').status).toBe('tested')
    const newer = checkCliVersion('claude', '2.2.0 (Claude Code)')
    expect(newer).toMatchObject({ status: 'untested', version: '2.2.0' })
    expect(newer.status === 'untested' && newer.repair).toContain('node scripts/record-fixtures.mjs claude')
    expect(checkCliVersion('codex', 'garbage').status).toBe('unknown')
  })
})
