import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentProvider,
  ModelRef,
  ProviderCapabilities,
  ProviderHealth,
  RunOptions,
} from '@joy/core'
import { probeVersion, runCli } from '../cli-run.js'
import { buildCodexArgs } from './args.js'
import { CodexStreamParser } from './parse.js'

export interface CodexCliOptions {
  command?: string
  argsPrefix?: string[]
  /** Default 60 minutes. Codex retries forever without a network, so this always matters. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export class CodexCliProvider implements AgentProvider {
  readonly kind = 'codex-cli' as const
  readonly capabilities: ProviderCapabilities = {
    codeEdit: true,
    tools: true,
    resume: true,
    presetSessionId: false,
    // `codex exec` cannot ask a host; app-server can (P2, docs/spikes/codex.md).
    delegatedApproval: false,
    quotaEvents: false,
    structuredOutput: true,
  }

  private readonly command: string
  private readonly argsPrefix: string[]
  private readonly timeoutMs: number
  private readonly env: NodeJS.ProcessEnv | undefined

  constructor(options: CodexCliOptions = {}) {
    this.command = options.command ?? 'codex'
    this.argsPrefix = options.argsPrefix ?? []
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
    this.env = options.env
  }

  async *run(opts: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    let tmp: string | undefined
    try {
      let schemaPath: string | undefined
      if (opts.outputSchema) {
        tmp = await mkdtemp(join(tmpdir(), 'joy-codex-'))
        schemaPath = join(tmp, 'schema.json')
        await writeFile(schemaPath, JSON.stringify(opts.outputSchema), { mode: 0o600 })
      }
      yield* runCli({
        source: 'codex-cli',
        label: 'Codex',
        command: this.command,
        args: [...this.argsPrefix, ...buildCodexArgs(opts, model, schemaPath)],
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: this.timeoutMs,
        parser: new CodexStreamParser({ cwd: opts.cwd, structured: Boolean(opts.outputSchema) }),
        ...(this.env ? { env: this.env } : {}),
      })
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true })
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const probe = await probeVersion(this.command, this.argsPrefix, this.env)
    return {
      ok: probe.ok,
      installed: probe.installed,
      loggedIn: probe.installed ? 'unknown' : false,
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.detail ? { detail: probe.detail } : {}),
    }
  }
}
