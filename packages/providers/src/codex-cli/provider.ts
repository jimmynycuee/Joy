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
import { CodexAppServerProvider, type CodexAppServerOptions } from './app-server.js'
import { CodexStreamParser } from './parse.js'

export interface CodexCliOptions extends CodexAppServerOptions {
  /** Defaults to the persistent app-server; select `exec` to use the compatibility provider. */
  mode?: 'app-server' | 'exec'
  /** On an app-server startup incompatibility, fall back to `codex exec --json` once. Defaults true. */
  fallbackToExec?: boolean
}

/** Compatibility provider for the legacy one-turn `codex exec --json` protocol. */
export class CodexExecProvider implements AgentProvider {
  readonly kind = 'codex-cli' as const
  readonly capabilities: ProviderCapabilities = {
    codeEdit: true,
    tools: true,
    resume: true,
    presetSessionId: false,
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

/** Defaults to app-server and keeps `exec --json` available as a startup fallback. */
export class CodexCliProvider implements AgentProvider {
  readonly kind = 'codex-cli' as const
  readonly capabilities: ProviderCapabilities
  private readonly appServer: CodexAppServerProvider
  private readonly exec: CodexExecProvider
  private readonly mode: 'app-server' | 'exec'
  private readonly fallbackToExec: boolean

  constructor(options: CodexCliOptions = {}) {
    this.mode = options.mode ?? 'app-server'
    this.fallbackToExec = options.fallbackToExec ?? true
    this.appServer = new CodexAppServerProvider(options)
    this.exec = new CodexExecProvider(options)
    this.capabilities = this.mode === 'app-server' ? this.appServer.capabilities : this.exec.capabilities
  }

  async *run(opts: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    if (this.mode === 'exec') {
      yield* this.exec.run(opts, model)
      return
    }

    let sessionStarted = false
    try {
      for await (const event of this.appServer.run(opts, model)) {
        if (event.type === 'session_started') sessionStarted = true
        yield event
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex app-server failed to start'
      if (
        !sessionStarted &&
        this.fallbackToExec &&
        !opts.signal.aborted &&
        !/did not finish within/.test(message)
      ) {
        yield { type: 'status', text: 'Codex app-server unavailable; falling back to codex exec --json.' }
        yield* this.exec.run(opts, model)
        return
      }
      if (!sessionStarted && opts.signal.aborted) {
        yield { type: 'error', message: 'Cancelled', recoverable: false }
        yield { type: 'done', sessionId: '', isError: true }
        return
      }
      throw error
    }
  }

  healthCheck(): Promise<ProviderHealth> {
    return this.appServer.healthCheck()
  }
}
