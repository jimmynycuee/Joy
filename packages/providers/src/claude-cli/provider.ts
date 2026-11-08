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
  Steer,
} from '@joy/core'
import type { CommandWrapper, StreamParser } from '../cli-run.js'
import { probeVersion, runCli } from '../cli-run.js'
import { isRecord } from '../guards.js'
import type { ProcessInput } from '../process.js'
import { buildClaudeArgs, claudeUserMessage, mcpConfigJson } from './args.js'
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
    // Streaming input only when the caller can steer: the one-shot `-p <prompt>` path stays as recorded in the
    // fixtures. A wrapped (container) run keeps it too, since `docker run` without `-i` does not forward stdin.
    const steering = opts.onSteer && !this.wrap ? new ClaudeSteering(opts) : undefined
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
          [...this.argsPrefix, ...buildClaudeArgs(opts, model, mcpConfigPath, Boolean(steering))],
          opts.cwd,
        )),
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: this.timeoutMs,
        parser: steering
          ? steering.watch(new ClaudeStreamParser({ cwd: opts.cwd, multiTurn: true }))
          : new ClaudeStreamParser({ cwd: opts.cwd }),
        ...(steering ? { onInput: (input: ProcessInput) => steering.start(input) } : {}),
        ...(this.env ? { env: this.env } : {}),
      })
    } finally {
      steering?.close()
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

/**
 * Streaming input for one run: the prompt is the first stdin message, owner messages follow while the agent works.
 * Claude Code queues a message that arrives mid-turn and handles it in the same process (between tool calls, or as the
 * next turn), so stdin is closed at the first `result`: the CLI still answers what it already received, then exits.
 * A message that comes after that is refused, and the caller delivers it another way.
 */
class ClaudeSteering {
  private input: ProcessInput | undefined
  private closed = false

  constructor(private readonly opts: RunOptions) {}

  readonly steer: Steer = (text) => {
    if (this.closed || !this.input || this.opts.signal.aborted) return Promise.resolve(false)
    return Promise.resolve(this.input.writeLine(claudeUserMessage(text)))
  }

  start(input: ProcessInput): void {
    this.input = input
    input.writeLine(claudeUserMessage(this.opts.prompt))
    if (!this.closed) this.opts.onSteer?.(this.steer)
  }

  /** Closes stdin once the CLI reports a result. */
  watch(parser: ClaudeStreamParser): StreamParser {
    return {
      get finished() {
        return parser.finished
      },
      push: (line) => {
        const events = parser.push(line)
        if (isRecord(line) && line.type === 'result') this.close()
        return events
      },
      finish: (reason, exit) => parser.finish(reason, exit),
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.input?.end()
    this.opts.onSteer?.(undefined)
  }
}
