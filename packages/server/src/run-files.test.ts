// A run's MCP config lives under JOY_HOME (an agent cannot read it without asking); a container still needs it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeStaleRunConfigs, runFileMounts } from './server.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'joy-run-files-'))
  dirs.push(dir)
  return dir
}

describe('runFileMounts', () => {
  it('mounts, read-only, the files Joy wrote in the temp folder or the MCP config folder, and nothing else', () => {
    const root = temp()
    const configDir = join(root, 'joy-home', 'mcp-run')
    const scratch = join(root, 'tmp')
    mkdirSync(join(configDir, 'joy-claude-a'), { recursive: true })
    mkdirSync(scratch)
    const config = join(configDir, 'joy-claude-a', 'mcp.json')
    const schema = join(scratch, 'schema.json')
    const elsewhere = join(root, 'elsewhere.json')
    for (const file of [config, schema, elsewhere]) writeFileSync(file, '{}')
    expect(
      runFileMounts(
        [
          '-p',
          '--mcp-config',
          config,
          '--output-schema',
          schema,
          elsewhere,
          join(configDir, 'missing.json'),
          configDir,
        ],
        [scratch, configDir],
      ),
    ).toEqual([
      { host: config, readOnly: true },
      { host: schema, readOnly: true },
    ])
  })
})

describe('removeStaleRunConfigs', () => {
  it("removes only Joy's own run folders, and a missing folder is fine", async () => {
    const dir = temp()
    mkdirSync(join(dir, 'joy-claude-old'))
    writeFileSync(join(dir, 'joy-claude-old', 'mcp.json'), '{}')
    mkdirSync(join(dir, 'keep-me'))
    const warnings: string[] = []
    await removeStaleRunConfigs(dir, (message) => warnings.push(message))
    expect(existsSync(join(dir, 'joy-claude-old'))).toBe(false)
    expect(existsSync(join(dir, 'keep-me'))).toBe(true)
    await removeStaleRunConfigs(join(dir, 'missing'), (message) => warnings.push(message))
    expect(warnings).toEqual([])
  })
})
