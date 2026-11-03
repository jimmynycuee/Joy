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
import { runJsonlProcess } from '../process.js'
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

  constructor(options: ClaudeCliOptions = {}) {
    this.command = options.command ?? 'claude'
    this.argsPrefix = options.argsPrefix ?? []
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
    this.env = options.env
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

      const proc = runJsonlProcess({
        command: this.command,
        args: [...this.argsPrefix, ...buildClaudeArgs(opts, model, mcpConfigPath)],
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: this.timeoutMs,
        ...(this.env ? { env: this.env } : {}),
      })
      const parser = new ClaudeStreamParser({ cwd: opts.cwd })

      for await (const line of proc.lines) {
        if (!line.ok) {
          yield { type: 'raw', source: 'claude-cli', payload: line.line }
          continue
        }
        yield* parser.push(line.value)
      }

      const exit = await proc.exit
      if (exit.spawnError) {
        const code = (exit.spawnError as NodeJS.ErrnoException).code
        throw new Error(
          code === 'ENOENT'
            ? `Claude Code CLI not found ("${this.command}"). Install Claude Code and log in, or set its path in Joy's settings.`
            : `Could not start Claude Code: ${exit.spawnError.message}`,
          { cause: exit.spawnError },
        )
      }
      if (!parser.finished) {
        const reason = exit.aborted
          ? 'Cancelled'
          : exit.timedOut
            ? `Claude Code did not finish within ${Math.round(this.timeoutMs / 1000)} s and was stopped`
            : `Claude Code exited (code ${exit.exitCode ?? exit.signal}) without a result. ${exit.stderrTail.trim()}`.trim()
        yield* parser.finish(reason)
      }
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true })
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const controller = new AbortController()
    const proc = runJsonlProcess({
      command: this.command,
      args: [...this.argsPrefix, '--version'],
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 15_000,
      ...(this.env ? { env: this.env } : {}),
    })
    const out: string[] = []
    for await (const line of proc.lines) out.push(line.ok ? String(line.value) : line.line)
    const exit = await proc.exit
    if (exit.spawnError) {
      return { ok: false, installed: false, loggedIn: false, detail: exit.spawnError.message }
    }
    const version = out.join(' ').trim()
    // Login is only known after a real run (an auth error shows up as a failing result).
    return exit.exitCode === 0
      ? { ok: true, installed: true, loggedIn: 'unknown', version }
      : { ok: false, installed: true, loggedIn: 'unknown', detail: exit.stderrTail.trim() }
  }
}
