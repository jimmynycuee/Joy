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
import { probeCodexRuntime, probeWslCodex, toWslPath } from './runtime.js'

export interface CodexCliOptions {
  command?: string
  argsPrefix?: string[]
  /** Default 60 minutes. Codex retries forever without a network, so this always matters. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Runtime platform override for deterministic platform-routing tests. */
  platform?: NodeJS.Platform
  /** WSL launcher and optional arguments, primarily for Windows installations and tests. */
  wslCommand?: string
  wslArgsPrefix?: string[]
  /** Codex executable name inside the default WSL distribution. */
  wslCodexCommand?: string
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
  private readonly platform: NodeJS.Platform
  private readonly wslCommand: string
  private readonly wslArgsPrefix: string[]
  private readonly wslCodexCommand: string

  constructor(options: CodexCliOptions = {}) {
    this.command = options.command ?? 'codex'
    this.argsPrefix = options.argsPrefix ?? []
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
    this.env = options.env
    this.platform = options.platform ?? process.platform
    this.wslCommand = options.wslCommand ?? 'wsl.exe'
    this.wslArgsPrefix = options.wslArgsPrefix ?? []
    this.wslCodexCommand = options.wslCodexCommand ?? 'codex'
  }

  async *run(opts: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    const runtime = await this.resolveRuntime(false)
    if (runtime.kind === 'unavailable') {
      throw new Error(
        `Codex is not usable on Windows. Native Codex: ${runtime.native.detail ?? 'exec probe failed'}. ` +
          `WSL Codex: ${runtime.wsl.detail ?? 'exec probe failed'}. Install Codex CLI natively or in the default WSL distribution.`,
      )
    }

    let tmp: string | undefined
    try {
      let schemaPath: string | undefined
      if (opts.outputSchema) {
        tmp = await mkdtemp(join(tmpdir(), 'joy-codex-'))
        schemaPath = join(tmp, 'schema.json')
        await writeFile(schemaPath, JSON.stringify(opts.outputSchema), { mode: 0o600 })
      }

      let command = this.command
      let argsPrefix = this.argsPrefix
      let parserCwd = opts.cwd
      let parserCwdStyle: 'native' | 'posix' = 'native'
      if (runtime.kind === 'wsl') {
        const wslCwd = await toWslPath(this.wslCommand, this.wslArgsPrefix, opts.cwd, this.env)
        parserCwd = wslCwd
        parserCwdStyle = 'posix'
        if (schemaPath)
          schemaPath = await toWslPath(this.wslCommand, this.wslArgsPrefix, schemaPath, this.env)
        command = this.wslCommand
        argsPrefix = [...this.wslArgsPrefix, '--cd', wslCwd, '--exec', this.wslCodexCommand]
      }

      yield* runCli({
        source: 'codex-cli',
        label: runtime.kind === 'wsl' ? 'Codex (WSL)' : 'Codex',
        command,
        args: [...argsPrefix, ...buildCodexArgs(opts, model, schemaPath)],
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: this.timeoutMs,
        parser: new CodexStreamParser({
          cwd: parserCwd,
          cwdStyle: parserCwdStyle,
          structured: Boolean(opts.outputSchema),
        }),
        ...(this.env ? { env: this.env } : {}),
      })
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true })
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const runtime = await this.resolveRuntime()
    if (runtime.kind === 'native') {
      return {
        ok: runtime.probe.ok,
        installed: runtime.probe.installed,
        loggedIn: runtime.probe.installed ? 'unknown' : false,
        ...(runtime.probe.version ? { version: runtime.probe.version } : {}),
        ...(runtime.probe.detail ? { detail: runtime.probe.detail } : {}),
      }
    }
    if (runtime.kind === 'wsl') {
      return {
        ok: true,
        installed: true,
        loggedIn: 'unknown',
        ...(runtime.probe.version ? { version: runtime.probe.version } : {}),
        detail: `Codex is available through WSL; native Windows Codex was not usable (${runtime.native.detail ?? 'exec probe failed'}).`,
      }
    }
    const installed = runtime.native.installed || runtime.wsl.installed
    return {
      ok: false,
      installed,
      loggedIn: installed ? 'unknown' : false,
      detail: `Native Windows Codex: ${runtime.native.detail ?? 'exec probe failed'}. WSL Codex: ${runtime.wsl.detail ?? 'exec probe failed'}.`,
    }
  }

  private async resolveRuntime(checkNative = true): Promise<
    | { kind: 'native'; probe: { installed: boolean; ok: boolean; version?: string; detail?: string } }
    | {
        kind: 'wsl'
        probe: { installed: boolean; ok: boolean; version?: string; detail?: string }
        native: { installed: boolean; ok: boolean; version?: string; detail?: string }
      }
    | {
        kind: 'unavailable'
        native: { installed: boolean; ok: boolean; version?: string; detail?: string }
        wsl: { installed: boolean; ok: boolean; version?: string; detail?: string }
      }
  > {
    if (this.platform !== 'win32') {
      const probe = checkNative
        ? await probeVersion(this.command, this.argsPrefix, this.env)
        : { installed: true, ok: true }
      return { kind: 'native', probe }
    }

    const native = await probeCodexRuntime(this.command, this.argsPrefix, this.env)
    if (native.ok) return { kind: 'native', probe: native }

    const wsl = await probeWslCodex(this.wslCommand, this.wslArgsPrefix, this.wslCodexCommand, this.env)
    return wsl.ok ? { kind: 'wsl', probe: wsl, native } : { kind: 'unavailable', native, wsl }
  }
}
