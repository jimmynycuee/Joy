import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { ZodError } from 'zod'
import type { JoyConfig } from './schema.js'
import { configSchema, defaultConfig } from './schema.js'

/** Joy's data directory. `JOY_HOME` overrides `~/.joy` (tests, portable installs). */
export function joyHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.JOY_HOME ?? join(homedir(), '.joy')
}

export function resolvePaths(config: JoyConfig, home: string = joyHome()) {
  return {
    config: join(home, 'config.yaml'),
    worktrees: config.paths.worktrees ?? join(home, 'worktrees'),
    database: config.paths.database ?? join(home, 'joy.sqlite'),
  }
}

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly issues: string[],
  ) {
    super(`Invalid Joy config at ${path}:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

/** Parses and validates YAML text. Missing keys take defaults; unknown keys are errors (they are usually typos). */
export function parseConfig(text: string, path = 'config.yaml'): JoyConfig {
  let raw: unknown
  try {
    raw = parse(text) ?? {}
  } catch (err) {
    throw new ConfigError(path, [`not valid YAML: ${(err as Error).message}`])
  }
  try {
    return configSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ConfigError(
        path,
        err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      )
    }
    throw err
  }
}

const HEADER = `# Joy settings. Edited by the Joy settings page too; comments here are not kept.
# Every key is optional. Docs: docs/PLAN.md section 3.3.
`

export function serializeConfig(config: JoyConfig): string {
  return HEADER + stringify(config)
}

/**
 * Reads the config file, re-reading only when it changed on disk, so edits (by hand or by the
 * settings page) apply to the next task without a restart.
 */
export class ConfigStore {
  private cached: { config: JoyConfig; mtimeMs: number; size: number } | undefined

  constructor(readonly path: string) {}

  /** Current config. A missing file means defaults. An invalid file throws ConfigError. */
  async get(): Promise<JoyConfig> {
    let info
    try {
      info = await stat(this.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cached = undefined
        return defaultConfig()
      }
      throw err
    }
    if (this.cached && this.cached.mtimeMs === info.mtimeMs && this.cached.size === info.size) {
      return this.cached.config
    }
    const config = parseConfig(await readFile(this.path, 'utf8'), this.path)
    this.cached = { config, mtimeMs: info.mtimeMs, size: info.size }
    return config
  }

  /** Validates and writes atomically (temp file + rename), so a crash never leaves half a file. */
  async save(config: JoyConfig): Promise<JoyConfig> {
    const valid = configSchema.parse(config)
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, serializeConfig(valid), { mode: 0o600 })
    await rename(tmp, this.path)
    this.cached = undefined
    return valid
  }

  /** Read-modify-write helper for the settings page. */
  async update(change: (current: JoyConfig) => JoyConfig): Promise<JoyConfig> {
    return this.save(change(structuredClone(await this.get())))
  }
}
