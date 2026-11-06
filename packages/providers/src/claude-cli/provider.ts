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
import type { CommandWrapper } from '../cli-run.js'
import { probeVersion, runCli } from '../cli-run.js'
import { buildClaudeArgs, mcpConfigJson } from './args.js'
import { ClaudeStreamParser } from './parse.js'

export interface ClaudeCliOptions {
  /** Executable to run. Default `claude` (from PATH). */
  command?: string
  /** Inserted before Joy's arguments; tests use it to run a fake CLI through `node`. */
  argsPrefix?: string[]
  /** Per-run limit. Default 60 minutes. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Runs the CLI another way, e.g. in a container for untrusted repositories (T4.5). */
  wrap?: CommandWrapper
}

export class ClaudeCliProvider implements AgentProvider {
  readonly kind = 'claude-cli' as const
  readonly capabilities: ProviderCapabilities = {
    codeEdit: true,
    tools: true,
    resume: true,
    presetSessionId: true,
    delegatedApproval: true,
    quotaEvents: true,
    structuredOutput: true,
  }

  private readonly command: string
  private readonly argsPrefix: string[]
  private readonly timeoutMs: number
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly wrap: CommandWrapper | undefined

  constructor(options: ClaudeCliOptions = {}) {
    this.command = options.command ?? 'claude'
    this.argsPrefix = options.argsPrefix ?? []
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
    this.env = options.env
    this.wrap = options.wrap
  }

  async *run(opts: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    let tmp: string | undefined
    try {
      let mcpConfigPath: string | undefined
      if (opts.mcpServers?.length) {
        tmp = await mkdtemp(join(tmpdir(), 'joy-claude-'))
        mcpConfigPath = join(tmp, 'mcp.json')
        await writeFile(mcpConfigPath, mcpConfigJson(opts.mcpServers), { mode: 0o600 })
      }

      yield* runCli({
        source: 'claude-cli',
        label: 'Claude Code',
        ...(await this.commandLine(
          [...this.argsPrefix, ...buildClaudeArgs(opts, model, mcpConfigPath)],
          opts.cwd,
        )),
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: this.timeoutMs,
        parser: new ClaudeStreamParser({ cwd: opts.cwd }),
        ...(this.env ? { env: this.env } : {}),
      })
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true })
    }
  }

  private async commandLine(args: string[], cwd: string): Promise<{ command: string; args: string[] }> {
    return this.wrap
      ? this.wrap({ cli: 'claude', command: this.command, args, cwd })
      : { command: this.command, args }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const probe = await probeVersion(this.command, this.argsPrefix, this.env)
    // Login is only known after a real run (an auth error shows up as a failing result).
    return {
      ok: probe.ok,
      installed: probe.installed,
      loggedIn: probe.installed ? 'unknown' : false,
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.detail ? { detail: probe.detail } : {}),
    }
  }
}
