import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EFFORTS } from '@joy/core'
import { DEFAULT_ROLES, defaultConfig } from './schema.js'
import { ConfigError, ConfigStore, joyHome, parseConfig, resolvePaths } from './store.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'joy-config-'))
  dirs.push(d)
  return d
}

describe('parseConfig', () => {
  it('fills every missing key with defaults', () => {
    const config = parseConfig('')
    expect(config).toEqual(defaultConfig())
    expect(config.roles).toEqual(DEFAULT_ROLES)
    expect(config.autonomy_mode).toBe('normal')
    expect(config.budget.per_task.max_rounds).toBe(3)
  })

  it('lets one role be overridden and keeps the others', () => {
    const config = parseConfig(`
roles:
  reviewer: { provider: claude-cli, model: sonnet, effort: low }
`)
    expect(config.roles.reviewer).toEqual({ provider: 'claude-cli', model: 'sonnet', effort: 'low' })
    expect(config.roles.implementer).toEqual(DEFAULT_ROLES.implementer)
  })

  it('accepts every supported effort for documented Claude and API models', () => {
    for (const [provider, model, efforts] of [
      ['claude-cli', 'haiku', EFFORTS],
      ['openai-api', 'gpt-6-luna', EFFORTS],
      ['codex-cli', 'gpt-6.1-sol', EFFORTS.filter((effort) => effort !== 'max')],
    ] as const) {
      for (const effort of efforts) {
        const config = parseConfig(
          `roles: { reviewer: { provider: ${provider}, model: ${model}, effort: ${effort} } }`,
        )
        expect(config.roles.reviewer.effort).toBe(effort)
      }
    }
  })

  it('rejects effort values unsupported by the selected provider/model with an actionable path', () => {
    expect(() =>
      parseConfig('roles: { reviewer: { provider: codex-cli, model: gpt-6.1-sol, effort: max } }'),
    ).toThrow(
      /roles\.reviewer\.effort: effort 'max' is not supported for codex-cli model 'gpt-6\.1-sol'.*low, medium, high, xhigh/,
    )

    expect(() =>
      parseConfig('roles: { reviewer: { provider: claude-cli, model: claude-opus-4-6, effort: xhigh } }'),
    ).toThrow(
      /roles\.reviewer\.effort: effort 'xhigh' is not supported for claude-cli model 'claude-opus-4-6'.*low, medium, high, max/,
    )

    expect(() =>
      parseConfig('roles: { reviewer: { provider: openai-api, model: gpt-5-mini, effort: max } }'),
    ).toThrow(
      /roles\.reviewer\.effort: effort 'max' is not validated for openai-api model 'gpt-5-mini'.*omit effort/,
    )
  })

  it('reports every problem with its path', () => {
    try {
      parseConfig(
        `
roles:
  reviewer: { provider: gemini, model: x }
budget:
  per_task: { max_rounds: 0 }
autonomy_mode: yolo
`,
        '/x/config.yaml',
      )
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      const e = err as ConfigError
      expect(e.message).toContain('/x/config.yaml')
      expect(e.issues.join('\n')).toMatch(/roles\.reviewer\.provider/)
      expect(e.issues.join('\n')).toMatch(/budget\.per_task\.max_rounds/)
      expect(e.issues.join('\n')).toMatch(/autonomy_mode/)
    }
  })

  it('rejects unknown keys, which are usually typos', () => {
    expect(() => parseConfig('autonomy: careful')).toThrow(/Unrecognized key.*autonomy/s)
    expect(() => parseConfig('roles: { reveiwer: { provider: claude-cli, model: x } }')).toThrow(/reveiwer/)
  })

  it('rejects broken YAML with a clear message', () => {
    expect(() => parseConfig('roles: [unclosed')).toThrow(/not valid YAML/)
  })
})

describe('ConfigStore', () => {
  it('returns defaults when the file does not exist, without creating it', async () => {
    const path = join(tmp(), 'config.yaml')
    expect(await new ConfigStore(path).get()).toEqual(defaultConfig())
    expect(() => statSync(path)).toThrow()
  })

  it('saves atomically and reads back the same config', async () => {
    const path = join(tmp(), 'nested', 'config.yaml')
    const store = new ConfigStore(path)
    const saved = await store.update((c) => ({ ...c, autonomy_mode: 'careful' }))
    expect(saved.autonomy_mode).toBe('careful')
    expect(readFileSync(path, 'utf8')).toMatch(/^# Joy settings/)
    expect(await new ConfigStore(path).get()).toEqual(saved)
  })

  it('applies a hand edit to the very next get(), with no restart', async () => {
    const path = join(tmp(), 'config.yaml')
    const store = new ConfigStore(path)
    await store.save(defaultConfig())
    expect((await store.get()).roles.implementer.provider).toBe('claude-cli')

    writeFileSync(path, 'roles:\n  implementer: { provider: codex-cli, model: gpt-6-luna }\n')
    // Same-second edits can keep the mtime; size still changes, and we also bump mtime to be sure.
    const later = new Date(Date.now() + 5000)
    utimesSync(path, later, later)
    expect((await store.get()).roles.implementer).toEqual({ provider: 'codex-cli', model: 'gpt-6-luna' })
  })

  it('refuses to save an invalid config', async () => {
    const store = new ConfigStore(join(tmp(), 'config.yaml'))
    await expect(store.save({ ...defaultConfig(), autonomy_mode: 'yolo' as 'normal' })).rejects.toThrow()
  })
})

describe('paths', () => {
  it('uses JOY_HOME when set and derives default paths from it', () => {
    const home = joyHome({ JOY_HOME: '/data/joy' })
    expect(home).toBe('/data/joy')
    expect(resolvePaths(defaultConfig(), home)).toEqual({
      config: join('/data/joy', 'config.yaml'),
      worktrees: join('/data/joy', 'worktrees'),
      database: join('/data/joy', 'joy.sqlite'),
    })
  })

  it('honors explicit paths in the config', () => {
    const config = parseConfig('paths: { worktrees: /fast/wt }')
    expect(resolvePaths(config, '/h').worktrees).toBe('/fast/wt')
  })
})
