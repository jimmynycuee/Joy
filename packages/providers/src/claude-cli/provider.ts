import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentProvider,
  ImageInput,
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
import type { ClaudeImage } from './args.js'
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
  /**
   * Whether `wrap` still hands the CLI its stdin for a run in `cwd` (owner steering needs it). `docker run` without
   * `-i` does not, so the server answers false for container repositories and true where `wrap` changes nothing.
   * Without it, a provider that has `wrap` does not steer.
   */
  forwardsStdin?: (cwd: string) => boolean
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
  private readonly forwardsStdin: ((cwd: string) => boolean) | undefined

  constructor(options: ClaudeCliOptions = {}) {
    this.command = options.command ?? 'claude'
    this.argsPrefix = options.argsPrefix ?? []
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
    this.env = options.env
    this.wrap = options.wrap
    this.forwardsStdin = options.forwardsStdin
  }

  async *run(opts: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    // Streaming input only when the caller can steer: the one-shot `-p <prompt>` path stays as recorded in the
    // fixtures. A run whose wrapper does not forward stdin (a container) keeps it too.
    const stdinReaches = !this.wrap || (this.forwardsStdin?.(opts.cwd) ?? false)
    // Images only travel as content blocks on stdin; `-p <prompt>` has no way to carry them.
    if (opts.images?.length && !stdinReaches)
      throw new Error(
        'Claude Code cannot see attached images in container mode (the container gets no input stream). Remove the images, or run this project without container mode.',
      )
    const images = opts.images?.length ? await readImages(opts.images) : []
    const steering =
      (opts.onSteer || images.length) && stdinReaches ? new ClaudeSteering(opts, images) : undefined
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

  constructor(
    private readonly opts: RunOptions,
    private readonly images: readonly ClaudeImage[] = [],
  ) {}

  readonly steer: Steer = async (text, images) => {
    if (this.closed || !this.input || this.opts.signal.aborted) return false
    const blocks = images?.length ? await readImages(images) : []
    // Reading the files took a moment: the run may have ended meanwhile.
    if (this.closed || this.opts.signal.aborted) return false
    return this.input.writeLine(claudeUserMessage(text, blocks))
  }

  start(input: ProcessInput): void {
    this.input = input
    input.writeLine(claudeUserMessage(this.opts.prompt, this.images))
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

/** Reads attached images for content blocks. A missing file is the caller's problem to report, not to skip. */
async function readImages(images: readonly ImageInput[]): Promise<ClaudeImage[]> {
  return Promise.all(
    images.map(async (image) => {
      try {
        return { mediaType: image.mediaType, base64: (await readFile(image.path)).toString('base64') }
      } catch (error) {
        throw new Error(
          `An attached image could not be read (${error instanceof Error ? error.message : String(error)}).`,
          { cause: error },
        )
      }
    }),
  )
}
